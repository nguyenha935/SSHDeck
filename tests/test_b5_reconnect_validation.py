"""W13-B5: the ``ssh_connect`` reconnect-name validation, fail-closed.

The frontend ``requestReconnect`` already routes correctly; these tests are the
BACKEND/RUNTIME half of the gate, because the source alone cannot prove what
happens on the wire against a real DB. The validation block in
``handle_ssh_connect`` (app/socket_events.py) is what stops a reconnect whose
tmux name is absent, invalid, not owned by the exact source session, endpoint-
tampered, or disabled by ``TMUX_ENABLED`` from falling through to a fresh
connection. Each of those is one of the defects B5 exists to fix, stated as a
database + wire fact rather than a UI one.

Driven through ``socketio.test_client`` so this is the production handler; only
``_build_transport`` is faked, and it raises if reached, because every case
here must be refused BEFORE any transport is built.
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
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        config.RATELIMIT_ENABLED = False
        config.TMUX_ENABLED = True

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
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


# Usernames must be unique across the module-scoped app, and several tests run
# their fixture once per case, so a plain constant would collide on the second
# case. A counter keeps each call its own account.
_user_counter = [0]


def _authenticated_socket(app, username_stem):
    _user_counter[0] += 1
    username = f'{username_stem}_{_user_counter[0]}'
    with app.app_context():
        user, error = register_user(username, 'b5-validation-pass-123')
        assert error is None
        user_id = user.id

    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username,
        'password': 'b5-validation-pass-123',
    })
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client, user_id


def _seed_session(app, user_id, session_id, tmux_name, **overrides):
    from app.models import SSHSession, db
    fields = {
        'host': 'target.example',
        'port': 22,
        'username': 'alice',
        'connected': True,
        'is_persistent': True,
        'auth_type': 'password',
        'tmux_session_name': tmux_name,
    }
    fields.update(overrides)
    with app.app_context():
        db.session.add(SSHSession(
            session_id=session_id, user_id=user_id, **fields))
        db.session.commit()


def _collect(socket_client, *event_names, timeout=5):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if event_names and any(
                event['name'] in event_names for event in events):
            break
        # The handler does its work in socketio.start_background_task (an
        # eventlet greenlet here); a stdlib sleep would block this OS thread
        # without yielding to the hub, so the greenlet's emit would never fire.
        socketio.sleep(0.02)
    return events


def _install_never_reached_build(monkeypatch):
    """The validation must refuse BEFORE _build_transport runs."""
    def _never(*_a, **_k):
        raise AssertionError(
            'the validation must refuse the reconnect name before any '
            'transport is built')
    monkeypatch.setattr(ssh_manager, '_build_transport', _never)
    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', _never)


def _emit_reconnect(socket_client, *, host='target.example', port=22,
                    username='alice', tmux_name='sshdeck_b5_live',
                    session_id='b5-source-1', auth_type='password',
                    password='secret', use_tmux=True):
    payload = {
        'host': host, 'port': port, 'username': username,
        'auth_type': auth_type, 'password': password,
        'use_tmux': use_tmux, 'reconnect_tmux_name': tmux_name,
        'session_id': session_id,
    }
    socket_client.emit('ssh_connect', payload)


# ── gate 2: fail closed on each invalid claim shape ─────────────────────────

def test_tmux_disabled_refuses_a_reconnect_name_instead_of_dropping_it(
        app, monkeypatch):
    """TMUX_ENABLED=false: a reattach claim is impossible, so it fails closed.

    The old code dropped the name and connected fresh, which is how a control
    labelled Reconnect performed Reset's outcome when tmux was turned off.
    """
    import config
    socket_client, user_id = _authenticated_socket(app, 'b5_disabled_user')
    _install_never_reached_build(monkeypatch)
    monkeypatch.setattr(config, 'TMUX_ENABLED', False)

    try:
        _emit_reconnect(socket_client)
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert 'tmux is disabled' in errors[0]['args'][0]['error']
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


@pytest.mark.parametrize('bad_name', [
    'has-hyphen', 'has space', 'has.dot', 'a;reboot', '../../etc',
    'name' * 50,  # 200 chars, over the 190 cap
])
def test_an_invalid_reconnect_name_is_refused(app, monkeypatch, bad_name):
    socket_client, user_id = _authenticated_socket(app, 'b5_invalid_user')
    _install_never_reached_build(monkeypatch)

    try:
        _emit_reconnect(socket_client, tmux_name=bad_name)
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert errors[0]['args'][0]['error'] == 'Invalid tmux session name'
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_reconnect_name_without_a_source_session_id_is_refused(
        app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'b5_no_source_user')
    _install_never_reached_build(monkeypatch)
    _seed_session(app, user_id, 'b5-source-2', 'sshdeck_b5_nosrc')

    try:
        socket_client.emit('ssh_connect', {
            'host': 'target.example', 'port': 22, 'username': 'alice',
            'auth_type': 'password', 'password': 'secret',
            'use_tmux': True,
            'reconnect_tmux_name': 'sshdeck_b5_nosrc',
            # session_id deliberately omitted
        })
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert errors[0]['args'][0]['error'] == (
            'Reconnect requires the source session id')
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_reconnect_name_not_owned_by_the_source_session_is_refused(
        app, monkeypatch):
    """A name that belongs to a DIFFERENT session id is tampering."""
    socket_client, user_id = _authenticated_socket(app, 'b5_unowned_user')
    _install_never_reached_build(monkeypatch)
    _seed_session(app, user_id, 'real-owner', 'sshdeck_b5_owned')
    _seed_session(app, user_id, 'imposter', 'sshdeck_b5_other')

    try:
        # The claim says the source is 'imposter' but the name belongs to
        # 'real-owner'. The old code dropped the name and connected fresh.
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_owned',
            session_id='imposter')
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert 'not found for this connection' in errors[0]['args'][0]['error']
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_reconnect_name_owned_by_another_user_is_refused(app, monkeypatch):
    """The user_id filter is what stops one account reattaching another's pane."""
    socket_client, user_id = _authenticated_socket(app, 'b5_foreign_user')
    foreign_client, foreign_id = _authenticated_socket(
        app, 'b5_foreign_owner')
    _install_never_reached_build(monkeypatch)
    _seed_session(app, foreign_id, 'foreign-row', 'sshdeck_b5_foreign')

    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_foreign',
            session_id='foreign-row')
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert 'not found for this connection' in errors[0]['args'][0]['error']
    finally:
        for client in (socket_client, foreign_client):
            if client.is_connected():
                client.disconnect()


def test_endpoint_tampering_is_refused(app, monkeypatch):
    """A name owned by the source session but a DIFFERENT endpoint is refused.

    The name can be valid and owned, but if host/port/username do not match the
    saved row, the claim is a reattach to a host the session never belonged to.
    """
    socket_client, user_id = _authenticated_socket(app, 'b5_tamper_user')
    _install_never_reached_build(monkeypatch)
    _seed_session(app, user_id, 'b5-tamper', 'sshdeck_b5_tamper',
                  host='target.example', port=22, username='alice')

    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_tamper',
            session_id='b5-tamper',
            host='other-host.example', username='mallory')
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert 'connection details do not match' in (
            errors[0]['args'][0]['error'])
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_non_persistent_source_session_is_refused(app, monkeypatch):
    """Only a persistent row is a real reattach source.

    A non-persistent row with a tmux name is stale data; honouring it would
    reattach a name the system no longer considers retained.
    """
    socket_client, user_id = _authenticated_socket(app, 'b5_nonpersist_user')
    _install_never_reached_build(monkeypatch)
    _seed_session(app, user_id, 'b5-nonpersist', 'sshdeck_b5_nonpersist',
                  is_persistent=False)

    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_nonpersist',
            session_id='b5-nonpersist')
        events = _collect(socket_client)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert 'not found for this connection' in errors[0]['args'][0]['error']
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_valid_reattach_claim_reaches_build_with_the_exact_name(
        app, monkeypatch):
    """The success shape: a valid, owned, endpoint-matching claim proceeds.

    The build call is the contract -- it receives the exact retained name and
    the caller-supplied login_shell is left to the swap path (not sent here).
    """
    socket_client, user_id = _authenticated_socket(app, 'b5_valid_user')
    _seed_session(app, user_id, 'b5-valid', 'sshdeck_b5_valid')
    build_calls = []
    monkeypatch.setattr(
        ssh_manager, 'create_ssh_connection',
        lambda **kw: build_calls.append(kw) or ('new-b5-session', None))
    monkeypatch.setattr(
        ssh_manager, 'get_session',
        lambda _sid: {'tmux_session_name': 'sshdeck_b5_valid',
                      'legacy_tmux_locale': None,
                      'auth_type': 'password'})
    from app import socket_events

    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_valid',
            session_id='b5-valid')
        events = _collect(socket_client)
        assert [e for e in events if e['name'] == 'ssh_connected']
        assert len(build_calls) == 1
        assert build_calls[0]['reconnect_tmux_name'] == 'sshdeck_b5_valid'
        assert build_calls[0]['use_tmux'] is True
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ── gate 4: prepare-then-swap preserves the source on build failure ─────────

def test_a_build_failure_preserves_the_source_db_row_and_emits_no_disconnect(
        app, monkeypatch):
    """The live ``ssh_reconnect`` path: a build failure retires NOTHING.

    The source session's DB row, in-RAM record, transport and terminal must all
    survive a failed replacement build -- the old transport is still serving.
    This is the prepare-then-swap contract: swap only after correlated success.
    """
    from app import key_manager, socket_events
    socket_client, user_id = _authenticated_socket(app, 'b5_preserve_user')
    sid = 'b5-preserve-1'
    _seed_session(app, user_id, sid, 'sshdeck_b5_preserve', auth_type='key',
                  key_id='key-preserve-1')
    ssh_manager.sessions[sid] = {
        'client': object(), 'channel': object(),
        'host': 'target.example', 'port': 22, 'username': 'alice',
        'user_id': str(user_id), 'connected': True,
        'auth_type': 'key', 'use_tmux': True,
        'tmux_session_name': 'sshdeck_b5_preserve',
        'bastion_client': None, 'proxy_jump_host': None,
        'transport_generation': 0, 'display_name': 'Preserved',
        'output_buffer': [], 'output_buffer_size': 0,
        'output_buffer_max': 512000, 'last_activity': time.time(),
    }

    monkeypatch.setattr(
        ssh_manager, '_build_transport',
        lambda *_a, **_k: (None, 'SSH connection failed'))
    monkeypatch.setattr(
        key_manager, 'read_key_content',
        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect(socket_client, 'ssh_reconnect_failed',
                          'ssh_reconnected', 'ssh_disconnected')
        failures = [e for e in events
                    if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        # No disconnect: the source is preserved, not retired.
        assert not [e for e in events if e['name'] == 'ssh_disconnected']
        # The source is still in-RAM and still connected.
        assert ssh_manager.sessions.get(sid, {}).get('connected') is True
        # The DB row is untouched.
        from app.models import SSHSession
        with app.app_context():
            row = SSHSession.query.filter_by(session_id=sid).first()
            assert row is not None
            assert row.connected is True
            assert row.tmux_session_name == 'sshdeck_b5_preserve'
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ── gate 1: the RUNTIME race, end to end through the real connect path ──────
#
# The validation above refuses a bad claim before any transport is built. This
# section covers the case where the claim is perfectly VALID and the retained
# tmux session dies anyway, between that validation and the moment the attach
# would run. `_build_transport` is the REAL one here -- only paramiko's client
# is faked -- so the assertion is about what the product actually does on the
# wire and in the database, not about a mocked build.

class _RuntimeChannel:
    """One exec channel on a fake host. Answers the probe and has-session."""

    def __init__(self, host):
        self.host = host
        self.command = None
        self.calls = []

    def settimeout(self, _timeout):
        pass

    def get_pty(self, *_args):
        self.calls.append('get_pty')

    def exec_command(self, command):
        self.command = command
        self.calls.append('exec_command')
        self.host.commands.append(command)

    def invoke_shell(self):
        self.calls.append('invoke_shell')

    def update_environment(self, _env):
        self.calls.append('update_environment')

    def recv(self, _size):
        if self.command and 'show-environment' in self.command:
            return b'LC_CTYPE=C.utf8\n'
        if self.command == ssh_manager.TMUX_PROBE_COMMAND:
            return (b'C.utf8\n'
                    + ssh_manager.TMUX_PROBE_SENTINEL.encode() + b'\n'
                    + b'alice:x:1000:1000:A:/home/alice:/bin/bash\n'
                    + ssh_manager.TMUX_PROBE_SHELL_SENTINEL.encode() + b'\n'
                    + b'tmux 3.4\n')
        return b''

    def recv_exit_status(self):
        if self.command and 'has-session' in self.command:
            return self.host.has_session_status
        return 0

    def close(self):
        pass


class _RuntimeTransport:
    def __init__(self, host):
        self.host = host

    def set_keepalive(self, _seconds):
        pass

    def open_session(self):
        channel = _RuntimeChannel(self.host)
        self.host.channels.append(channel)
        return channel

    def is_active(self):
        return True


class _RuntimeHost:
    """A fake paramiko SSHClient whose tmux session may be gone."""

    def __init__(self, has_session_status):
        self.has_session_status = has_session_status
        self.commands = []
        self.channels = []
        self.closed = False
        self._transport = _RuntimeTransport(self)

    def load_host_keys(self, _path):
        pass

    def set_missing_host_key_policy(self, _policy):
        pass

    def connect(self, **_kwargs):
        pass

    def get_transport(self):
        return self._transport

    def invoke_shell(self, **_kwargs):
        return _RuntimeChannel(self)

    def close(self):
        self.closed = True


def _install_runtime_host(monkeypatch, has_session_status):
    hosts = []

    def factory():
        host = _RuntimeHost(has_session_status)
        hosts.append(host)
        return host

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', factory)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)
    return hosts


def test_the_retained_session_dying_before_execution_fails_closed_end_to_end(
        app, monkeypatch):
    """Gate 1, as a wire + database fact.

    The claim is valid: the name is whitelisted, owned by the exact source
    session and endpoint-matched, so it passes validation and a transport IS
    built. The host then answers has-session GONE. The user must get the
    correlated error, the saved source row must still be there (so the offer
    survives), no NEW row may be created, and no session may be registered.
    """
    socket_client, user_id = _authenticated_socket(app, 'b5_runtime_gone')
    _seed_session(app, user_id, 'b5-runtime-gone', 'sshdeck_b5_runtime_gone',
                  connected=False)
    hosts = _install_runtime_host(monkeypatch, has_session_status=1)

    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_runtime_gone',
            session_id='b5-runtime-gone')
        events = _collect(socket_client, 'ssh_error', 'ssh_connected')
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors, [e['name'] for e in events]
        assert errors[0]['args'][0]['error'] == (
            ssh_manager.TMUX_REATTACH_GONE_ERROR)
        assert not [e for e in events if e['name'] == 'ssh_connected']

        # Nothing that could create the identity ever ran on the host.
        assert hosts, 'the real _build_transport never reached the host'
        for command in hosts[0].commands:
            assert 'new-session' not in command
            assert 'attach-session' not in command
        assert any('has-session' in c for c in hosts[0].commands)

        # No session registered, no orphan client left open.
        assert len(ssh_manager.sessions) == 0
        assert hosts[0].closed is True

        # The SOURCE row survives untouched, and no second row was created.
        from app.models import SSHSession
        with app.app_context():
            rows = SSHSession.query.filter_by(user_id=user_id).all()
            assert [r.session_id for r in rows] == ['b5-runtime-gone']
            assert rows[0].tmux_session_name == 'sshdeck_b5_runtime_gone'
            assert rows[0].is_persistent is True
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_the_same_claim_succeeds_and_attaches_when_the_session_is_alive(
        app, monkeypatch):
    """The companion that stops the failure test passing vacuously.

    The ONLY difference from the test above is the host's has-session answer.
    With the session alive the same claim connects, and no launch command ran
    at all -- so the refusal above is attributable to the race and nothing
    else.

: a reattach runs NO tmux launch on the transport. The session is
    proven by the read-only has-session and each browser socket then attaches
    its own client, so the commands this host sees are questions only.
    """
    from app import socket_events
    socket_client, user_id = _authenticated_socket(app, 'b5_runtime_alive')
    _seed_session(app, user_id, 'b5-runtime-alive', 'sshdeck_b5_runtime_alive',
                  connected=False)
    hosts = _install_runtime_host(monkeypatch, has_session_status=0)

    session_ids = []
    try:
        _emit_reconnect(
            socket_client, tmux_name='sshdeck_b5_runtime_alive',
            session_id='b5-runtime-alive')
        events = _collect(socket_client, 'ssh_connected', 'ssh_error')
        connected = [e for e in events if e['name'] == 'ssh_connected']
        assert connected, [e for e in events]
        payload = connected[0]['args'][0]
        session_ids.append(payload['session_id'])
        assert payload['tmux_session_name'] == 'sshdeck_b5_runtime_alive'
        # The existence check ran, against the exact name, and nothing else:
        # no create verb (which would manufacture a replacement identity) and
        # no session-level attach either.
        assert 'tmux has-session -t =sshdeck_b5_runtime_alive 2>/dev/null' in (
            hosts[0].commands)
        assert not any('new-session' in c or 'attach-session' in c
                       for c in hosts[0].commands), hosts[0].commands
    finally:
        for session_id in session_ids:
            ssh_manager.close_session(session_id)
        if socket_client.is_connected():
            socket_client.disconnect()


def test_the_live_swap_route_refuses_rather_than_downgrading_to_a_shell(
        app, monkeypatch):
    """Gate 2 on the LIVE ``ssh_reconnect`` path, through the real build.

    A live tmux session whose host has lost tmux must not come back as a plain
    shell wearing the session's label: `_build_transport` refuses, so the route
    reports failure and the OLD transport is still serving. Nothing was swapped,
    nothing was retired, and the DB row still names the retained session.
    """
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'b5_live_no_tmux')
    sid = 'b5-live-no-tmux'
    _seed_session(app, user_id, sid, 'sshdeck_b5_live_no_tmux',
                  auth_type='key', key_id='key-no-tmux-1')
    original_client = object()
    original_channel = object()
    ssh_manager.sessions[sid] = {
        'client': original_client, 'channel': original_channel,
        'host': 'target.example', 'port': 22, 'username': 'alice',
        'user_id': str(user_id), 'connected': True,
        'auth_type': 'key', 'use_tmux': True,
        'tmux_session_name': 'sshdeck_b5_live_no_tmux',
        'bastion_client': None, 'proxy_jump_host': None,
        'transport_generation': 0, 'display_name': 'No tmux',
        'output_buffer': [], 'output_buffer_size': 0,
        'output_buffer_max': 512000, 'last_activity': time.time(),
    }

    class _NoTmuxChannel(_RuntimeChannel):
        def recv(self, _size):
            # The probe answers a host WITHOUT tmux: the banner half is empty.
            if self.command == ssh_manager.TMUX_PROBE_COMMAND:
                return (b'C.utf8\n'
                        + ssh_manager.TMUX_PROBE_SENTINEL.encode() + b'\n'
                        + b'alice:x:1000:1000:A:/home/alice:/bin/bash\n'
                        + ssh_manager.TMUX_PROBE_SHELL_SENTINEL.encode()
                        + b'\n')
            return b''

        def recv_exit_status(self):
            # 127 = command not found, exactly what a tmux-less host answers.
            return 127

    class _NoTmuxTransport(_RuntimeTransport):
        def open_session(self):
            channel = _NoTmuxChannel(self.host)
            self.host.channels.append(channel)
            return channel

    hosts = []

    def factory():
        host = _RuntimeHost(has_session_status=127)
        host._transport = _NoTmuxTransport(host)
        hosts.append(host)
        return host

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', factory)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))
    # The live swap route resolves the credential server-side from key_id, and
    # the fake key text is not a real PEM -- without this the build would fail
    # on the KEY, not on the tmux contract under test.
    monkeypatch.setattr(ssh_manager, '_load_private_key',
                        lambda _content: object())

    try:
        socket_client.emit('ssh_reconnect', {'session_id': sid})
        events = _collect(socket_client, 'ssh_reconnect_failed',
                          'ssh_reconnected')
        failures = [e for e in events if e['name'] == 'ssh_reconnect_failed']
        assert failures, [e['name'] for e in events]
        assert failures[0]['args'][0]['error'] == (
            ssh_manager.TMUX_REATTACH_UNAVAILABLE_ERROR)
        # The OLD transport is untouched: same objects, still connected.
        session = ssh_manager.sessions[sid]
        assert session['client'] is original_client
        assert session['channel'] is original_channel
        assert session['connected'] is True
        assert session['tmux_session_name'] == 'sshdeck_b5_live_no_tmux'
        # No shell was opened behind the user's back on the new transport.
        for host in hosts:
            for channel in host.channels:
                assert 'invoke_shell' not in channel.calls
        # And the row still names the retained session.
        from app.models import SSHSession
        with app.app_context():
            row = SSHSession.query.filter_by(session_id=sid).first()
            assert row.tmux_session_name == 'sshdeck_b5_live_no_tmux'
            assert row.is_persistent is True
    finally:
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop(sid, None)
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_stale_selected_session_id_cannot_reach_another_session(
        app, monkeypatch):
    """Gate 3: stale targeting is refused, and the real session is untouched.

    The client sends whichever session it believes is selected. A stale id is
    either unknown (a session that has since gone) or belongs to someone else;
    neither may mutate, retire, or reconnect ANY session -- least of all the
    live one the user is actually looking at.
    """
    from app import key_manager
    socket_client, user_id = _authenticated_socket(app, 'b5_stale_target')
    live_sid = 'b5-stale-live'
    _seed_session(app, user_id, live_sid, 'sshdeck_b5_stale_live')
    ssh_manager.sessions[live_sid] = {
        'client': object(), 'channel': object(),
        'host': 'target.example', 'port': 22, 'username': 'alice',
        'user_id': str(user_id), 'connected': True,
        'auth_type': 'key', 'use_tmux': True,
        'tmux_session_name': 'sshdeck_b5_stale_live',
        'bastion_client': None, 'proxy_jump_host': None,
        'transport_generation': 0, 'display_name': 'Live',
        'output_buffer': [], 'output_buffer_size': 0,
        'output_buffer_max': 512000, 'last_activity': time.time(),
    }

    build_calls = []
    key_reads = []
    monkeypatch.setattr(
        ssh_manager, '_build_transport',
        lambda *_a, **_k: build_calls.append(1) or (None, 'x'))
    monkeypatch.setattr(
        key_manager, 'read_key_content',
        lambda *_a, **_k: key_reads.append(1) or ('-----FAKE KEY-----', None))

    try:
        # A session id that does not exist at all.
        socket_client.emit('ssh_reconnect', {'session_id': 'b5-stale-ghost'})
        events = _collect(socket_client, 'ssh_reconnect_failed', 'ssh_error',
                          'ssh_reconnected')
        assert not [e for e in events if e['name'] == 'ssh_reconnected']
        assert build_calls == [], 'a stale id reached the transport build'
        assert key_reads == [], 'key material was read for a stale id'
        # The real live session is exactly as it was.
        assert ssh_manager.sessions[live_sid]['connected'] is True
        assert ssh_manager.sessions[live_sid]['tmux_session_name'] == (
            'sshdeck_b5_stale_live')
        from app.models import SSHSession
        with app.app_context():
            assert SSHSession.query.filter_by(
                session_id=live_sid).first() is not None
    finally:
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop(live_sid, None)
        if socket_client.is_connected():
            socket_client.disconnect()
