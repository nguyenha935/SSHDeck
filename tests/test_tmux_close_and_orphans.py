"""Closing a tmux session kills the remote tmux FIRST, and orphans are a join.

Owner ruling: a tmux-backed connection must always come back to
exactly its tmux session, and the code must not leave garbage on the host.
The old `ssh_disconnect` deleted the saved row and then asked close_session
to kill the tmux over a transport that might already be dead -- an orphan
nobody could reach. Now the kill comes first; a failed kill keeps the row as
a saved session and offers it again. Orphans (`sshdeck_*` sessions no row
points at) are listed and killed only by explicit request.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio, ssh_manager


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
def clean_registry():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


class FakeExecChannel:
    """One exec channel: records the command, answers a fixed status/stdout."""

    def __init__(self, exit_status=0, output=b''):
        self.exit_status = exit_status
        self.output = output
        self.command = None
        self._drained = False

    def settimeout(self, _t):
        pass

    def exec_command(self, command):
        self.command = command

    def recv_ready(self):
        return bool(self.output) and not self._drained

    def recv(self, n):
        if self._drained or not self.output:
            return b''
        self._drained = True
        return self.output[:n]

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.exit_status

    def close(self):
        pass


class FakeTransport:
    def __init__(self, channels, active=True):
        self.channels = list(channels)
        self.active = active
        self.commands = []

    def is_active(self):
        return self.active

    def open_session(self, timeout=None):
        channel = self.channels.pop(0) if self.channels else FakeExecChannel()
        self.commands.append(channel)
        return channel


class FakeClient:
    def __init__(self, transport):
        self.transport = transport
        self.closed = False

    def get_transport(self):
        return self.transport

    def close(self):
        self.closed = True


def _install_live(session_id, user_id, tmux_name, channels, host='h.example'):
    transport = FakeTransport(channels)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'user_id': str(user_id), 'connected': True, 'use_tmux': True,
            'tmux_session_name': tmux_name, 'client': FakeClient(transport),
            'channel': None, 'views': {}, 'host': host, 'port': 22,
            'username': 'u',
        }
    return transport


def _commands(transport):
    return [c.command for c in transport.commands]


# ---- ssh_manager helpers ------------------------------------------------------

def test_kill_targets_the_exact_session_name():
    transport = _install_live('s-kill', 1, 'sshdeck_u_h_22_aaaa1111', [FakeExecChannel(0)])
    ok, err = ssh_manager.kill_tmux_session('s-kill')
    assert (ok, err) == (True, None)
    assert _commands(transport) == ['tmux kill-session -t =sshdeck_u_h_22_aaaa1111']


def test_kill_by_name_refuses_a_name_that_is_not_an_identifier():
    transport = _install_live('s-kill2', 1, 'sshdeck_u_h_22_aaaa1111', [FakeExecChannel(0)])
    ok, err = ssh_manager.kill_tmux_session('s-kill2', 'evil; rm -rf /')
    assert ok is False and err
    assert _commands(transport) == []


def test_kill_reports_a_dead_transport_instead_of_pretending():
    transport = _install_live('s-dead', 1, 'sshdeck_u_h_22_aaaa1111', [])
    transport.active = False
    ok, err = ssh_manager.kill_tmux_session('s-dead')
    assert ok is False
    assert 'not active' in err


def test_list_sessions_sends_no_target_and_parses_rows():
    out = (b'sshdeck_u_h_22_aaaa1111 1700000000 1\n'
           b'termix-2-2cbd 1700000001 0\n'
           b'bad name 1 0\n'
           b'sshdeck_u_h_22_bbbb2222 notanumber 0\n')
    transport = _install_live('s-list', 1, 'sshdeck_u_h_22_aaaa1111',
                              [FakeExecChannel(0, out)])
    ok, err, rows = ssh_manager.list_tmux_sessions('s-list')
    assert (ok, err) == (True, None)
    assert _commands(transport) == [
        "tmux list-sessions -F '#{session_name} #{session_created} #{session_attached}'"]
    assert rows == [
        {'name': 'sshdeck_u_h_22_aaaa1111', 'created': 1700000000, 'attached': 1},
        {'name': 'termix-2-2cbd', 'created': 1700000001, 'attached': 0},
    ]


# ---- socket handlers ----------------------------------------------------------

def _authenticated_socket(app, username):
    from app.auth import register_user
    password = 'close-orphans-password-123'
    with app.app_context():
        user, error = register_user(username, password)
        assert error is None, error
        user_id = user.id
    http_client = app.test_client()
    assert http_client.post('/login', data={'username': username,
                                            'password': password}).status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client, user_id


def _collect(socket_client, seconds=0.5):
    deadline = time.monotonic() + seconds
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        socketio.sleep(0.02)
    return events


def _seed_row(app, user_id, session_id, tmux_name, connected=True, host='h.example'):
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(
            session_id=session_id, user_id=user_id, host=host, port=22,
            username='u', connected=connected, is_persistent=True,
            tmux_session_name=tmux_name))
        db.session.commit()


def _row(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        row = SSHSession.query.filter_by(session_id=session_id).first()
        return None if row is None else {'connected': row.connected,
                                         'tmux': row.tmux_session_name}


def test_closing_a_live_session_kills_its_tmux_then_deletes_the_row(app):
    client, user_id = _authenticated_socket(app, 'close_live_ok')
    try:
        _seed_row(app, user_id, 'live-ok', 'sshdeck_u_h_22_cccc3333')
        transport = _install_live('live-ok', user_id, 'sshdeck_u_h_22_cccc3333',
                                  [FakeExecChannel(0)])
        client.emit('ssh_disconnect', {'session_id': 'live-ok'})
        events = _collect(client)
        assert _commands(transport) == ['tmux kill-session -t =sshdeck_u_h_22_cccc3333']
        assert _row(app, 'live-ok') is None
        assert ssh_manager.get_session('live-ok') is None
        names = [e['name'] for e in events]
        assert 'ssh_disconnected' in names
        assert 'ssh_session_kept' not in names
        assert 'persistent_session_available' not in names
    finally:
        client.disconnect()


def test_a_failed_kill_keeps_the_row_as_a_saved_session_and_offers_it(app):
    client, user_id = _authenticated_socket(app, 'close_live_kept')
    try:
        _seed_row(app, user_id, 'live-kept', 'sshdeck_u_h_22_dddd4444')
        transport = _install_live('live-kept', user_id, 'sshdeck_u_h_22_dddd4444',
                                  [FakeExecChannel(1)])
        client.emit('ssh_disconnect', {'session_id': 'live-kept'})
        events = _collect(client)
        assert len(_commands(transport)) == 1
        assert _row(app, 'live-kept') == {'connected': False,
                                          'tmux': 'sshdeck_u_h_22_dddd4444'}
        assert ssh_manager.get_session('live-kept') is None
        by_name = {e['name']: e for e in events}
        assert by_name['ssh_session_kept']['args'][0]['session_id'] == 'live-kept'
        offer = by_name['persistent_session_available']['args'][0]
        assert offer['tmux_session_name'] == 'sshdeck_u_h_22_dddd4444'
    finally:
        client.disconnect()


def test_dropping_a_candidate_touches_no_tmux(app):
    """The reset copy promises the remote keeps running; pinned again here
    because the handler now kills on the live path."""
    client, user_id = _authenticated_socket(app, 'close_candidate')
    try:
        _seed_row(app, user_id, 'cand-1', 'sshdeck_u_h_22_eeee5555', connected=False)
        client.emit('ssh_disconnect', {'session_id': 'cand-1'})
        _collect(client)
        assert _row(app, 'cand-1') is None
    finally:
        client.disconnect()


def test_orphans_are_the_prefix_minus_every_row(app):
    client, user_id = _authenticated_socket(app, 'orphans_list')
    other_client, other_id = _authenticated_socket(app, 'orphans_other')
    try:
        _seed_row(app, user_id, 'mine-live', 'sshdeck_u_h_22_ffff6666')
        _seed_row(app, other_id, 'theirs-saved', 'sshdeck_u_h_22_0000aaaa', connected=False)
        out = (b'sshdeck_u_h_22_ffff6666 1 1\n'
               b'sshdeck_u_h_22_0000aaaa 2 0\n'
               b'sshdeck_u_h_22_9999zzzz 3 0\n'
               b'termix-2-2cbd 4 0\n')
        _install_live('mine-live', user_id, 'sshdeck_u_h_22_ffff6666',
                      [FakeExecChannel(0, out)])
        client.emit('tmux_orphans_list', {'session_id': 'mine-live'})
        events = {e['name']: e for e in _collect(client)}
        payload = events['tmux_orphans']['args'][0]
        assert payload['host'] == 'h.example'
        assert payload['checked'] == 4
        assert payload['orphans'] == [
            {'name': 'sshdeck_u_h_22_9999zzzz', 'created': 3, 'attached': 0}]
    finally:
        client.disconnect()
        other_client.disconnect()


def test_orphan_kill_refuses_names_that_belong_to_anyone(app):
    client, user_id = _authenticated_socket(app, 'orphan_kill_refuse')
    try:
        _seed_row(app, user_id, 'k-live', 'sshdeck_u_h_22_1111bbbb')
        transport = _install_live('k-live', user_id, 'sshdeck_u_h_22_1111bbbb',
                                  [FakeExecChannel(0)])
        for name in ['sshdeck_u_h_22_1111bbbb', 'termix-2-2cbd', 'x; true', '']:
            client.emit('tmux_orphan_kill', {'session_id': 'k-live', 'name': name})
        events = [e for e in _collect(client) if e['name'] == 'tmux_orphans_error']
        assert len(events) == 4
        assert _commands(transport) == []
    finally:
        client.disconnect()


def test_orphan_kill_runs_the_exact_kill_and_acks(app):
    client, user_id = _authenticated_socket(app, 'orphan_kill_ok')
    try:
        _seed_row(app, user_id, 'k2-live', 'sshdeck_u_h_22_2222cccc')
        transport = _install_live('k2-live', user_id, 'sshdeck_u_h_22_2222cccc',
                                  [FakeExecChannel(0)])
        client.emit('tmux_orphan_kill', {'session_id': 'k2-live',
                                         'name': 'sshdeck_u_h_22_dead0000'})
        events = {e['name']: e for e in _collect(client)}
        assert _commands(transport) == ['tmux kill-session -t =sshdeck_u_h_22_dead0000']
        assert events['tmux_orphan_killed']['args'][0]['name'] == 'sshdeck_u_h_22_dead0000'
    finally:
        client.disconnect()


# ---- boot reconciliation -----------------------------------------------------

def test_boot_marks_every_connected_row_disconnected(app, monkeypatch):
    from app import worker_guard
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(session_id='boot-1', user_id=1, host='h', port=22,
                                  username='u', connected=True, is_persistent=True,
                                  tmux_session_name='sshdeck_u_h_22_boot0001'))
        db.session.add(SSHSession(session_id='boot-2', user_id=1, host='h', port=22,
                                  username='u', connected=True, is_persistent=False))
        db.session.commit()
        mine = SSHSession.query.filter(SSHSession.session_id.in_(['boot-1', 'boot-2']))
        monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
        assert worker_guard.reconcile_ssh_sessions() == -1
        assert mine.filter_by(connected=True).count() == 2
        monkeypatch.setattr(worker_guard, '_GUARD_HELD', True)
        assert worker_guard.reconcile_ssh_sessions() >= 2
        assert mine.filter_by(connected=True).count() == 0
        # Both rows survive: the persistent one as a saved session.
        assert SSHSession.query.filter_by(session_id='boot-1').first().is_persistent
        assert worker_guard.reconcile_ssh_sessions() == 0
