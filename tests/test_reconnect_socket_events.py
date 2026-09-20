"""W2: the ``ssh_reconnect`` Socket.IO handler, driven through a real client.

These pin the routing decisions the handler owns, because getting any of them
wrong reproduces one of the defects W2 exists to fix:

  * a swap must be attempted with the session's OWN persisted identity -- the
    client never re-sends key material, and the tmux name must be reattached
    (not replaced by a fresh one, which is how the old path lost the user's
    remote state);
  * success replies with a SessionSnapshot for the SAME session_id and leaves
    the DB row in place -- the old path deleted the row and created another;
  * a build failure must NOT touch the live session, and must report as a
    failure rather than as a disconnect;
  * a password (or jump-host) session cannot swap silently, because the server
    holds no secret for it -- it must say ``password_required`` so the client
    opens the form instead of showing a bare error;
  * ownership is enforced, and a second concurrent request is rejected.

Only ``_build_transport`` is faked (no SSH server exists in a unit test);
everything else is the production handler.
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
    """Module-scoped app so the global Socket.IO handlers register once.

    Same rationale as tests/test_tmux_socket_events.py: the function-scoped
    conftest fixture re-initializes the shared socketio instance per test and
    breaks event routing for later clients.
    """
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        config.RATELIMIT_ENABLED = False

        from app import create_app
        from app.models import db

        test_app = create_app()
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
def clean_state():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    with ssh_manager._reader_handoff_lock:
        ssh_manager._reader_handoff.clear()
    with ssh_manager._reconnect_in_flight_lock:
        ssh_manager._reconnect_in_flight.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    with ssh_manager._reader_handoff_lock:
        ssh_manager._reader_handoff.clear()
    with ssh_manager._reconnect_in_flight_lock:
        ssh_manager._reconnect_in_flight.clear()


def _authenticated_socket(app, username):
    with app.app_context():
        user, error = register_user(username, 'reconnect-pass-123')
        assert error is None
        user_id = user.id

    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username,
        'password': 'reconnect-pass-123',
    })
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client, user_id


def _collect_until(socket_client, *event_names, timeout=5):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if any(event['name'] in event_names for event in events):
            break
        # The handler does its work in socketio.start_background_task (an
        # eventlet greenlet here); a stdlib sleep would block this OS thread
        # without yielding to the hub, so the greenlet's emit would never fire.
        socketio.sleep(0.02)
    return events


def _install_live_session(session_id, user_id, **overrides):
    session = {
        'client': object(),
        'channel': object(),
        'host': 'swap.example.com',
        'port': 22,
        'username': 'deploy',
        'user_id': str(user_id),
        'connected': True,
        'last_activity': time.time(),
        'bastion_client': None,
        'proxy_jump_host': None,
        'auth_type': 'key',
        'use_tmux': True,
        'tmux_session_name': 'sshdeck_live',
        'display_name': 'Prod box',
        'transport_generation': 0,
        'output_buffer': [],
        'output_buffer_size': 0,
        'output_buffer_max': 512000,
    }
    session.update(overrides)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = session
    return session


def _seed_row(app, user_id, session_id, **kwargs):
    from app.models import SSHSession, db
    fields = {
        'host': 'swap.example.com',
        'port': 22,
        'username': 'deploy',
        'connected': True,
        'is_persistent': True,
        'auth_type': 'key',
        'key_id': 'key-live-1',
        'tmux_session_name': 'sshdeck_live',
        'display_name': 'Prod box',
    }
    fields.update(kwargs)
    with app.app_context():
        row = SSHSession(session_id=session_id, user_id=user_id, **fields)
        db.session.add(row)
        db.session.commit()


def _row(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        return SSHSession.query.filter_by(session_id=session_id).first()


def _fake_transport():
    return {
        'client': object(),
        'channel': object(),
        'bastion_client': None,
        'use_tmux': True,
        'tmux_session_name': 'sshdeck_live',
    }


# ---- successful swap --------------------------------------------------------

def test_reconnect_reattaches_the_same_tmux_name_with_server_held_key(
        app, monkeypatch):
    """The build call is the contract: same tmux session, key from the server.

    The old path emitted a fresh ssh_connect from the browser and could create a
    NEW tmux session, discarding the remote state the user asked to get back.
    """
    from app import key_manager, socket_events
    socket_client, user_id = _authenticated_socket(app, 'reconnect_ok_user')
    sid = 'reconnect-ok-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    build_calls = []

    def fake_build(host, port, username, **kwargs):
        build_calls.append((host, port, username, kwargs))
        return _fake_transport(), None

    swap_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport', fake_build)
    monkeypatch.setattr(
        ssh_manager, 'swap_session_transport',
        lambda session_id, result, **kwargs:
            swap_calls.append((session_id, result)) or (True, None))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnected',
                                'ssh_reconnect_failed')

        assert [e['name'] for e in events if e['name'] == 'ssh_reconnect_failed'] == []
        assert len(build_calls) == 1, build_calls
        host, port, username, kwargs = build_calls[0]
        assert (host, port, username) == ('swap.example.com', 22, 'deploy')
        # Reattach, not a new session.
        assert kwargs['reconnect_tmux_name'] == 'sshdeck_live'
        assert kwargs['use_tmux'] is True
        assert kwargs['auth_type'] == 'key'
        # The server resolved the credential itself from the persisted key_id.
        assert kwargs['key_content'] == '-----FAKE KEY-----'
        # And the swap targeted the SAME logical session.
        assert [c[0] for c in swap_calls] == [sid]
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_successful_reconnect_replies_with_snapshot_for_the_same_session(
        app, monkeypatch):
    """One session_id in, the same one out -- and a full SessionSnapshot v1."""
    from app import key_manager, socket_events
    socket_client, user_id = _authenticated_socket(app, 'reconnect_snap_user')
    sid = 'reconnect-snap-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (_fake_transport(), None))
    monkeypatch.setattr(ssh_manager, 'swap_session_transport',
                        lambda *_a, **_k: (True, None))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnected',
                                'ssh_reconnect_failed')
        ok = [e for e in events if e['name'] == 'ssh_reconnected']
        assert ok, [e['name'] for e in events]
        payload = ok[0]['args'][0]
        assert payload['session_id'] == sid
        assert payload['snapshot_version'] == 1
        assert payload['host'] == 'swap.example.com'
        assert payload['username'] == 'deploy'
        assert payload['key_id'] == 'key-live-1'
        assert payload['tmux_session_name'] == 'sshdeck_live'
        assert payload['display_name'] == 'Prod box'
        # Never key material, only the opaque reference.
        assert 'key_content' not in payload
        assert 'password' not in payload
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_successful_reconnect_updates_the_same_row_instead_of_replacing_it(
        app, monkeypatch):
    """Safe DB-row ordering: one row, updated in place, after the swap.

    The old path deleted the persistent row and inserted another under a new
    session_id; a failure between the two orphaned the session.
    """
    from app.models import SSHSession
    from app import key_manager, socket_events
    socket_client, user_id = _authenticated_socket(app, 'reconnect_row_user')
    sid = 'reconnect-row-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid, connected=False)

    with app.app_context():
        original_id = SSHSession.query.filter_by(session_id=sid).first().id
        before_count = SSHSession.query.filter_by(user_id=user_id).count()

    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (_fake_transport(), None))
    monkeypatch.setattr(ssh_manager, 'swap_session_transport',
                        lambda *_a, **_k: (True, None))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        _collect_until(socket_client, 'ssh_reconnected', 'ssh_reconnect_failed')

        with app.app_context():
            rows = SSHSession.query.filter_by(user_id=user_id).all()
            assert len(rows) == before_count == 1
            assert rows[0].id == original_id, 'row was replaced, not updated'
            assert rows[0].session_id == sid
            assert rows[0].connected is True
            assert rows[0].snapshot_version == 1
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ---- failure leaves everything intact --------------------------------------

def test_build_failure_reports_failure_and_never_swaps(app, monkeypatch):
    """Prepare-and-swap's promise: a failed reconnect changes nothing.

    Crucially it must also NOT arrive as a disconnect -- the session is still
    live on its old transport, so telling the client it died would be a lie that
    tears down a working terminal.
    """
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_fail_user')
    sid = 'reconnect-fail-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    swap_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (None, 'Authentication failed - invalid credentials'))
    monkeypatch.setattr(ssh_manager, 'swap_session_transport',
                        lambda *_a, **_k: swap_calls.append(1) or (True, None))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['session_id'] == sid
        assert swap_calls == [], 'a failed build must never reach the swap'
        # Not a disconnect: the live session is untouched.
        assert not [e for e in events if e['name'] == 'ssh_disconnected']
        with ssh_manager.sessions_lock:
            assert ssh_manager.sessions[sid]['connected'] is True
        assert _row(app, sid) is not None
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_swap_failure_closes_the_orphan_transport(app, monkeypatch):
    """A session that died mid-build must not leak the replacement transport."""
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_orphan_user')
    sid = 'reconnect-orphan-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    built = _fake_transport()
    closed = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (built, None))
    monkeypatch.setattr(ssh_manager, 'swap_session_transport',
                        lambda *_a, **_k: (False, 'Session no longer exists'))
    monkeypatch.setattr(ssh_manager, '_close_transport_parts',
                        lambda c, ch, b: closed.append((c, ch, b)))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        assert [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert closed == [(built['client'], built['channel'], None)], closed
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ---- credential routing ----------------------------------------------------

def test_password_session_is_routed_to_the_form_not_silently_swapped(
        app, monkeypatch):
    """The server holds no password, so it must say so explicitly.

    A bare error would leave the user stuck; ``password_required`` is what lets
    the client open the pre-filled modal.
    """
    socket_client, user_id = _authenticated_socket(app, 'reconnect_pw_user')
    sid = 'reconnect-pw-1'
    _install_live_session(sid, user_id, auth_type='password')
    _seed_row(app, user_id, sid, auth_type='password', key_id=None)

    build_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['code'] == 'password_required'
        # No transport was even attempted with a credential the server lacks.
        assert build_calls == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_jump_host_session_is_routed_to_the_form(app, monkeypatch):
    """The bastion secret is never persisted.

    Silently reconnecting would either fail, or -- worse -- reach the target
    DIRECTLY, bypassing the bastion the connection was authorized through.
    """
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_jump_user')
    sid = 'reconnect-jump-1'
    _install_live_session(sid, user_id, proxy_jump_host='bastion.example.com')
    _seed_row(app, user_id, sid)

    build_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['code'] == 'password_required'
        assert build_calls == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_disconnected_session_is_not_a_swap(app, monkeypatch):
    """An offline candidate is a fresh connect, not a transport swap."""
    socket_client, user_id = _authenticated_socket(app, 'reconnect_offline_user')
    sid = 'reconnect-offline-1'
    _seed_row(app, user_id, sid, connected=False)  # no RAM record at all

    build_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['code'] == 'not_live'
        assert build_calls == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ---- authorization and single ownership ------------------------------------

def test_reconnect_of_another_users_session_is_rejected(app, monkeypatch):
    """Ownership is enforced before any credential is read."""
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_owner_user')
    sid = 'reconnect-foreign-1'
    # Session belongs to a DIFFERENT user id.
    _install_live_session(sid, user_id + 999)
    _seed_row(app, user_id + 999, sid)

    build_calls = []
    key_reads = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: key_reads.append(1) or ('k', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_error', 'ssh_reconnected',
                                'ssh_reconnect_failed', timeout=2)
        assert [e for e in events if e['name'] == 'ssh_error']
        assert not [e for e in events if e['name'] == 'ssh_reconnected']
        assert build_calls == []
        assert key_reads == [], 'key material must not be read for a foreign session'
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_second_reconnect_while_one_is_in_flight_is_rejected(app, monkeypatch):
    """One lifecycle owner, enforced at the handler boundary."""
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_race_user')
    sid = 'reconnect-race-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))
    # Claim the slot as if a first reconnect were mid-build.
    assert ssh_manager.begin_reconnect(sid) is True

    build_calls = []
    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect_until(socket_client, 'ssh_reconnect_failed',
                                'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['code'] == 'in_flight'
        assert build_calls == []
    finally:
        ssh_manager.end_reconnect(sid)
        if socket_client.is_connected():
            socket_client.disconnect()


def test_reconnect_releases_its_ownership_claim_after_success(app, monkeypatch):
    """A leaked claim would make the session permanently unreconnectable."""
    from app import key_manager, socket_events
    socket_client, user_id = _authenticated_socket(app, 'reconnect_release_user')
    sid = 'reconnect-release-1'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (_fake_transport(), None))
    monkeypatch.setattr(ssh_manager, 'swap_session_transport',
                        lambda *_a, **_k: (True, None))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        _collect_until(socket_client, 'ssh_reconnected', 'ssh_reconnect_failed')
        with ssh_manager._reconnect_in_flight_lock:
            assert sid not in ssh_manager._reconnect_in_flight
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_reconnect_releases_its_ownership_claim_after_failure(app, monkeypatch):
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'reconnect_release2_user')
    sid = 'reconnect-release-2'
    _install_live_session(sid, user_id)
    _seed_row(app, user_id, sid)

    monkeypatch.setattr(ssh_manager, '_build_transport',
                        lambda *_a, **_k: (None, 'SSH connection failed'))
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        _collect_until(socket_client, 'ssh_reconnect_failed', 'ssh_reconnected')
        with ssh_manager._reconnect_in_flight_lock:
            assert sid not in ssh_manager._reconnect_in_flight
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()
