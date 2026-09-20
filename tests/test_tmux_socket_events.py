"""Socket.IO handlers that drive tmux: copy-mode exit and ssh_input.

With the redesigned interaction model tmux owns the pointer, so the browser
never drives scrolling from the server side: there are no `tmux_mouse_mode` /
`tmux_scroll` events. What is left at this layer is the `tmux_exit_copy_mode`
handler (ownership, background task, reply routed to the requesting SID) and
`ssh_input`'s `leave_scroll` advisory, which must leave copy mode BEFORE it
writes or the bytes are discarded by tmux.

: the tmux option initialization that used to live here as
`socket_events._initialize_tmux_mouse_mode` moved into
`ssh_manager.ensure_tmux_window_options`, which every view attach runs (it now
also carries the `window-size smallest` multi-device policy). Its contracts --
mouse on, mode-keys emacs, a plain shell untouched, and a tmux failure that
never tears the session down -- are pinned in tests/test_tmux_options.py.

A fake session is placed directly in `ssh_manager.sessions` and the underlying
`ssh_manager` helpers are monkeypatched to record how they were called.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio, ssh_manager
from app.auth import register_user


@pytest.fixture(scope='module')
def app():
    """Module-scoped app so the global Socket.IO handlers are registered once.

    The conftest `app` fixture is function-scoped and calls `create_app()` per
    test, which re-initializes the shared `socketio` instance and breaks event
    routing for every client created after the first. The integration suite
    sidesteps this the same way — one app for the whole module.
    """
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        # Logging in repeatedly from 127.0.0.1 would otherwise trip the login
        # rate limiter partway through the module.
        config.RATELIMIT_ENABLED = False

        from app import create_app
        from app.models import db

        test_app = create_app()
        # Other test modules call create_app() repeatedly. Flask-SocketIO
        # replaces the singleton's underlying server on each init_app(), but an
        # already-imported socket_events module does not re-run its decorators.
        # Reload once so this fresh server has the production event handlers.
        from app import socket_events
        importlib.reload(socket_events)
        test_app.config['TESTING'] = True
        test_app.config['WTF_CSRF_ENABLED'] = False
        with test_app.app_context():
            db.create_all()
        yield test_app
        with test_app.app_context():
            db.session.remove()
            db.engine.dispose()


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


# ---- tmux_exit_copy_mode Socket.IO handler --------------------------------
# The touch-scroll "exit copy mode" button emits `tmux_exit_copy_mode`. The
# handler must (1) require an authenticated, verified owner, (2) run the real
# work off the event loop in a background task, and (3) emit the result back to
# exactly the requesting client's SID as `tmux_copy_mode_exited`. These drive it
# through a real Socket.IO test client so the login/ownership/routing wiring is
# exercised end to end, not just the helper.

def _authenticated_socket(app, username):
    from app.auth import register_user
    with app.app_context():
        user, error = register_user(username, 'socket-password-123')
        assert error is None
        user_id = user.id

    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username,
        'password': 'socket-password-123',
    })
    assert response.status_code == 302

    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client, user_id


def _collect_until(socket_client, event_name, timeout=5):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if any(event['name'] == event_name for event in events):
            break
        # The handler runs its work in socketio.start_background_task, which is an
        # eventlet greenlet here. A stdlib time.sleep would block this OS thread
        # without ever yielding to the eventlet hub, so the greenlet's emit would
        # never fire; socketio.sleep yields cooperatively and lets it run.
        socketio.sleep(0.02)
    return events


def _install_owned_session(session_id, user_id):
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'user_id': str(user_id),
            'connected': True,
            'use_tmux': True,
            'tmux_session_name': 'sshdeck_alice_host_22_abcd1234',
        }


def test_exit_copy_mode_event_emits_success_to_requesting_client(app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'tmux_exit_ok_user')
    session_id = 'sess-exit-ok'
    _install_owned_session(session_id, user_id)

    calls = []
    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode',
                        lambda sid: calls.append(sid) or (True, None, True))
    try:
        socket_client.emit('tmux_exit_copy_mode', {'session_id': session_id})
        events = _collect_until(socket_client, 'tmux_copy_mode_exited')

        results = [e for e in events if e['name'] == 'tmux_copy_mode_exited']
        assert results, 'expected a tmux_copy_mode_exited reply'
        payload = results[0]['args'][0]
        # was_in_mode is relayed so the UI can say "left scroll mode" instead of
        # claiming success for a pane that was never in one.
        assert payload == {'session_id': session_id, 'ok': True,
                           'was_in_mode': True, 'error': None}
        # The helper ran exactly once, for this session, in the background task.
        assert calls == [session_id]
        # A success must not surface an ssh_error to the client.
        assert not any(e['name'] == 'ssh_error' for e in events)
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_exit_copy_mode_event_relays_not_in_mode_as_success(app, monkeypatch):
    # The pane was not in a mode: still a success (nothing failed), but the reply
    # must say so via was_in_mode=False. Reporting this as a plain success made
    # the button look broken — it claimed to have exited a mode while nothing on
    # screen changed.
    socket_client, user_id = _authenticated_socket(app, 'tmux_exit_noop_user')
    session_id = 'sess-exit-noop'
    _install_owned_session(session_id, user_id)

    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode',
                        lambda sid: (True, None, False))
    try:
        socket_client.emit('tmux_exit_copy_mode', {'session_id': session_id})
        events = _collect_until(socket_client, 'tmux_copy_mode_exited')

        results = [e for e in events if e['name'] == 'tmux_copy_mode_exited']
        assert results
        payload = results[0]['args'][0]
        assert payload == {'session_id': session_id, 'ok': True,
                           'was_in_mode': False, 'error': None}
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()

def test_exit_copy_mode_event_reports_generic_failure(app, monkeypatch):
    # On a real helper failure the client is told it failed, but never the
    # transport/tmux internals — the reason is logged server-side only.
    socket_client, user_id = _authenticated_socket(app, 'tmux_exit_fail_user')
    session_id = 'sess-exit-fail'
    _install_owned_session(session_id, user_id)

    monkeypatch.setattr(
        ssh_manager, 'exit_tmux_copy_mode',
        lambda sid: (False, 'tmux command exited with status 1 at 10.0.0.5', False))
    try:
        socket_client.emit('tmux_exit_copy_mode', {'session_id': session_id})
        events = _collect_until(socket_client, 'tmux_copy_mode_exited')

        results = [e for e in events if e['name'] == 'tmux_copy_mode_exited']
        assert results
        payload = results[0]['args'][0]
        assert payload['session_id'] == session_id
        assert payload['ok'] is False
        assert payload['error'] == 'Failed to exit tmux copy mode'
        # The internal reason (host/status) must not leak to the UI.
        assert '10.0.0.5' not in payload['error']
        assert 'status 1' not in payload['error']
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_exit_copy_mode_event_rejects_unowned_session(app, monkeypatch):
    # A session the user does not own must be refused before any tmux work: the
    # client gets ssh_error and the helper is never called.
    socket_client, _user_id = _authenticated_socket(app, 'tmux_exit_intruder')
    other_session = 'sess-belongs-to-someone-else'
    _install_owned_session(other_session, user_id=999999)  # different owner

    called = []
    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode',
                        lambda sid: called.append(sid) or (True, None, True))
    try:
        socket_client.emit('tmux_exit_copy_mode', {'session_id': other_session})
        events = _collect_until(socket_client, 'ssh_error')

        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors
        assert errors[0]['args'][0]['error'] == 'Unauthorized access to session'
        # No copy-mode reply, and the backend helper never ran.
        assert not any(e['name'] == 'tmux_copy_mode_exited' for e in events)
        assert called == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_exit_copy_mode_event_ignores_malformed_payload(app, monkeypatch):
    # Non-dict payload and a missing/blank session_id are dropped silently (no
    # reply, no helper call), so a malformed client cannot trigger tmux work.
    socket_client, _user_id = _authenticated_socket(app, 'tmux_exit_malformed')

    called = []
    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode',
                        lambda sid: called.append(sid) or (True, None, True))
    try:
        socket_client.emit('tmux_exit_copy_mode', 'not-a-dict')
        socket_client.emit('tmux_exit_copy_mode', {'session_id': ''})
        socket_client.emit('tmux_exit_copy_mode', {'session_id': 12345})
        # Give any (erroneous) background task a chance to emit before asserting.
        events = _collect_until(socket_client, 'tmux_copy_mode_exited', timeout=1)

        assert not any(e['name'] == 'tmux_copy_mode_exited' for e in events)
        assert called == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ---- S17 FIX 4d: ssh_input's `leave_scroll` advisory ----------------------
# tmux DISCARDS every byte written to the attached client's channel while the
# pane is in copy mode (measured on a scratch tmux 3.4 server: 'echo SENDTEST'
# + CR, \x7f and \x15 all vanished, and a printable byte did not even move
# copy_cursor_y). With tmux `mouse on` as the product default one upward swipe
# puts the pane there, so after a scroll the composer's ENTIRE write path was
# silently dead. A byte the user deliberately sends is not a read, so the write
# path leaves copy mode first -- but ONLY when the client says this session's
# scroll is tmux copy mode, never unconditionally.

def _capture_input_calls(monkeypatch):
    """Record exit_tmux_copy_mode and send_ssh_input in ONE ordered list.

    Order is the property under test: a write that lands before the ESC is
    swallowed again, which is why the exit must be inline and synchronous rather
    than a background task.

    Returns ``(calls, write_kwargs)``. The keyword arguments are captured
    separately because the write now carries the WRITER's socket id -- the
    session's bytes go to that socket's own tmux client (its view) -- and a
    handler that stopped passing it would otherwise look unchanged here.
    """
    calls = []
    write_kwargs = []

    def fake_write(sid, data, **kwargs):
        calls.append(('write', sid, data))
        write_kwargs.append(kwargs)
        return True, None

    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode',
                        lambda sid: calls.append(('exit', sid)) or (True, None, True))
    monkeypatch.setattr(ssh_manager, 'send_ssh_input', fake_write)
    return calls, write_kwargs


def test_ssh_input_with_leave_scroll_exits_copy_mode_before_writing(app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'input_leave_scroll_user')
    session_id = 'sess-leave-scroll'
    _install_owned_session(session_id, user_id)
    calls, write_kwargs = _capture_input_calls(monkeypatch)
    try:
        socket_client.emit('ssh_input', {'session_id': session_id,
                                        'data': 'echo hi\r',
                                        'leave_scroll': True})
        _collect_until(socket_client, 'ssh_error', timeout=1)

        assert calls == [('exit', session_id),
                         ('write', session_id, 'echo hi\r')], calls
        # The write is routed to THIS socket's own tmux client.
        assert write_kwargs and write_kwargs[0].get('socket_sid'), write_kwargs
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_ssh_input_without_leave_scroll_never_exits_copy_mode(app, monkeypatch):
    # THE CONSTRAINT: this must not become an unconditional exit on every
    # ssh_input. At a normal prompt the flag is absent and no control command is
    # issued, so ordinary typing costs exactly one write as before.
    socket_client, user_id = _authenticated_socket(app, 'input_no_flag_user')
    session_id = 'sess-no-flag'
    _install_owned_session(session_id, user_id)
    calls, _write_kwargs = _capture_input_calls(monkeypatch)
    try:
        socket_client.emit('ssh_input', {'session_id': session_id, 'data': 'ls\r'})
        _collect_until(socket_client, 'ssh_error', timeout=1)

        assert calls == [('write', session_id, 'ls\r')], calls
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_ssh_input_leave_scroll_must_be_exactly_true(app, monkeypatch):
    # Advisory field, fail-closed on anything that is not the boolean True: a
    # truthy string or 1 from a stale/foreign client must not move the pane.
    socket_client, user_id = _authenticated_socket(app, 'input_flag_types_user')
    session_id = 'sess-flag-types'
    _install_owned_session(session_id, user_id)
    calls, _write_kwargs = _capture_input_calls(monkeypatch)
    try:
        for value in ('yes', 1, [], None, False):
            socket_client.emit('ssh_input', {'session_id': session_id,
                                            'data': 'x', 'leave_scroll': value})
        _collect_until(socket_client, 'ssh_error', timeout=1)

        assert [c[0] for c in calls] == ['write'] * 5, calls
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_ssh_input_still_writes_when_the_copy_mode_exit_fails(app, monkeypatch):
    # The exit is ADVISORY. Its result is ignored and an exception in it must not
    # cost the user the keystroke they deliberately sent.
    socket_client, user_id = _authenticated_socket(app, 'input_exit_raises_user')
    session_id = 'sess-exit-raises'
    _install_owned_session(session_id, user_id)

    writes = []

    def boom(_sid):
        raise RuntimeError('control channel died')

    monkeypatch.setattr(ssh_manager, 'exit_tmux_copy_mode', boom)
    monkeypatch.setattr(
        ssh_manager, 'send_ssh_input',
        lambda sid, data, **_kwargs: writes.append((sid, data)) or (True, None))
    try:
        socket_client.emit('ssh_input', {'session_id': session_id,
                                        'data': 'q', 'leave_scroll': True})
        _collect_until(socket_client, 'ssh_error', timeout=1)

        assert writes == [(session_id, 'q')]
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ----: ssh_input takes its socket's turn before any I/O -----------

def _capture_turns(monkeypatch):
    """Record begin/end of the input turn and the write in ONE ordered list.

    The primitives themselves are pinned in tests/test_input_order.py with real
    threads; here the property is the WIRING: the ticket is taken with the
    writer's own socket id before the write, and released even when the
    handler refuses the payload.
    """
    calls = []
    monkeypatch.setattr(ssh_manager, 'begin_input_turn',
                        lambda sid: calls.append(('begin', sid)) or 7)
    monkeypatch.setattr(ssh_manager, 'end_input_turn',
                        lambda sid, ticket: calls.append(('end', sid, ticket)))
    monkeypatch.setattr(ssh_manager, 'send_ssh_input',
                        lambda sid, data, **kwargs: calls.append(
                            ('write', data, kwargs.get('socket_sid'))) or (True, None))
    return calls


def test_ssh_input_takes_its_turn_before_writing_and_ends_it_after(app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'input_turn_user')
    session_id = 'sess-input-turn'
    _install_owned_session(session_id, user_id)
    calls = _capture_turns(monkeypatch)
    try:
        socket_client.emit('ssh_input', {'session_id': session_id, 'data': 'a'})
        _collect_until(socket_client, 'ssh_error', timeout=1)
        # The test client does not expose the namespace sid, so the writer's
        # own socket id is read back from the write and must be the ticket's.
        assert [c[0] for c in calls] == ['begin', 'write', 'end'], calls
        sid = calls[1][2]
        assert sid
        assert calls == [('begin', sid), ('write', 'a', sid), ('end', sid, 7)], calls
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_ssh_input_ends_its_turn_when_the_session_is_not_owned(app, monkeypatch):
    socket_client, _user_id = _authenticated_socket(app, 'input_turn_refused_user')
    calls = _capture_turns(monkeypatch)
    try:
        socket_client.emit('ssh_input', {'session_id': 'sess-not-mine', 'data': 'a'})
        events = _collect_until(socket_client, 'ssh_error', timeout=2)
        assert any(e['name'] == 'ssh_error' for e in events), events
        assert [c[0] for c in calls] == ['begin', 'end'], calls
        sid = calls[0][1]
        assert sid
        assert calls == [('begin', sid), ('end', sid, 7)], calls
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()
