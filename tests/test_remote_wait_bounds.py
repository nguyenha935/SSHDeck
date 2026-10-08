"""Every wait on a remote host ends, and none of them holds the database.

2026-10-08, production. A Tailscale host stopped answering one Files listing.
paramiko waits on the network with no limit, so that request never returned;
the Files requests after it queued on the session's SFTP lock, each holding
the pooled database connection its login check had checked out. With the pool
(5 + 10 overflow) empty, every page -- whose user is loaded from the same pool
-- answered 500 until the container was restarted.

The same host had no tmux, and the session that fell back to a plain shell
was saved as persistent: closing it "kept it as a saved session", a chip that
offered a reattach to nothing on every device.

The SFTP rows run a real paramiko server in this process, so what is timed is
paramiko's own waiting, not a fake's.
"""
import socket
import threading
import time
import types

import paramiko
import pytest
from flask import request

from app import sftp_handler, ssh_manager

FAST = 0.5
# Generous: a loaded CI box schedules threads late, never early.
SLACK = 2.0


def _deadline_call(fn, seconds):
    """Run fn on a thread; (finished, result). A regression must fail the row,
    not hang the suite."""
    box = {}

    def run():
        box['result'] = fn()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    return 'result' in box, box.get('result')


# ---- a real SSH server whose SFTP can be made to go silent ------------------

@pytest.fixture(scope='module')
def host_key():
    return paramiko.RSAKey.generate(2048)


class _Server(paramiko.ServerInterface):
    def __init__(self, remote):
        self.remote = remote

    def get_allowed_auths(self, username):
        return 'none'

    def check_auth_none(self, username):
        return paramiko.AUTH_SUCCESSFUL

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED

    def check_channel_subsystem_request(self, channel, name):
        if self.remote.silent_subsystem:
            self.remote.release.wait(10)
            return False
        return super().check_channel_subsystem_request(channel, name)


def _sftp_interface(remote):
    class Interface(paramiko.SFTPServerInterface):
        def canonicalize(self, path):
            return '/home/u'

        def stat(self, path):
            attr = paramiko.SFTPAttributes()
            attr.st_mode = 0o40755
            return attr

        lstat = stat

        def list_folder(self, path):
            if path == '/stuck':
                remote.release.wait(10)
            return []

    return Interface


@pytest.fixture
def remote(host_key, monkeypatch):
    monkeypatch.setattr(sftp_handler, 'SFTP_IO_TIMEOUT_S', FAST, raising=False)
    remote = types.SimpleNamespace(release=threading.Event(),
                                   silent_subsystem=False, server_sides=[])
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)

    def serve():
        conn, _ = listener.accept()
        side = paramiko.Transport(conn)
        side.add_server_key(host_key)
        side.set_subsystem_handler('sftp', paramiko.SFTPServer,
                                   _sftp_interface(remote))
        side.start_server(server=_Server(remote))
        remote.server_sides.append(side)

    threading.Thread(target=serve, daemon=True).start()
    transport = paramiko.Transport(socket.create_connection(listener.getsockname()))
    transport.start_client(timeout=5)
    transport.auth_none('u')
    remote.client = types.SimpleNamespace(get_transport=lambda: transport)
    yield remote
    remote.release.set()
    transport.close()
    for side in remote.server_sides:
        side.close()
    listener.close()


def test_a_listing_the_server_never_answers_gives_up_and_shuts_the_channel(remote):
    sftp = sftp_handler.open_bounded_sftp(remote.client)
    assert sftp.normalize('.') == '/home/u'

    started = time.monotonic()
    with pytest.raises(socket.timeout):
        sftp.listdir_attr('/stuck')
    assert FAST * 0.8 <= time.monotonic() - started < FAST + SLACK
    assert sftp.timed_out is True

    # Shut, not merely late: a request swallowed by an OSError handler would
    # otherwise wait the full period again on a link known dead.
    started = time.monotonic()
    with pytest.raises(OSError):
        sftp.stat('.')
    assert time.monotonic() - started < FAST * 0.4


def test_an_sftp_subsystem_that_never_answers_gives_up(remote):
    remote.silent_subsystem = True
    finished, outcome = _deadline_call(
        lambda: _raised(lambda: sftp_handler.open_bounded_sftp(remote.client)),
        FAST + SLACK)
    assert finished, 'the subsystem request waited past its bound'
    assert isinstance(outcome, sftp_handler.SFTPOperationError)
    assert str(outcome) == sftp_handler.SERVER_SILENT


def _raised(fn):
    try:
        fn()
    except Exception as exc:
        return exc
    return None


@pytest.fixture
def quiet_session(remote):
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['quiet'] = {
            'connected': True, 'client': remote.client, 'user_id': '1',
            '_sftp_owner_token': object()}
    yield 'quiet'
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop('quiet', None)
    sftp_handler.close_sftp_cache(
        'quiet', expected_owner=sftp_handler._sftp_cache.get('quiet', (None, None))[1])


def test_files_says_the_server_went_silent_and_the_next_listing_reopens(quiet_session):
    finished, outcome = _deadline_call(
        lambda: sftp_handler.list_directory(quiet_session, '/stuck'), FAST + SLACK)
    assert finished, 'the listing waited past its bound'
    assert outcome == (None, sftp_handler.SERVER_SILENT)

    # The cached handle is dead; the next request opens a fresh channel
    # instead of reporting the old silence.
    assert sftp_handler.list_directory(quiet_session, '/home/u') == ([], None)


def test_files_names_the_silence_when_a_channel_cannot_even_open(remote, quiet_session):
    """Not "No active connection found": the session exists, its server is
    what went quiet, and that is what the Files pane must say."""
    remote.silent_subsystem = True
    finished, outcome = _deadline_call(
        lambda: sftp_handler.list_directory(quiet_session, '/home/u'), FAST + SLACK)
    assert finished, 'the listing waited past its bound'
    assert outcome == (None, sftp_handler.SERVER_SILENT)


# ---- the database is not held while a remote host is waited for -----------

def test_requests_queued_on_a_silent_server_hold_no_database_connection(app, monkeypatch):
    """The incident's mechanism, end to end through the real login check and
    the real list_directory handler: requests on one session queue behind a
    silent server. Each would keep the connection its login check took."""
    import app.socket_events as socket_events
    from app.auth import register_socket_session, register_user
    from app.models import db

    callers = 8
    user, error = register_user('poolwatch', 'pool-watch-password-1')
    assert error is None
    for i in range(callers):
        register_socket_session(user.id, f'pool-sock-{i}')
    db.session.commit()
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['pooled'] = {'connected': True, 'user_id': str(user.id)}

    silent = threading.Event()

    class Handle:
        def listdir_attr(self, path):
            return []

    def silent_server(identifier):
        silent.wait(10)
        return Handle(), None, 'session'

    arrived = []
    real_lock = sftp_handler._get_sftp_lock

    def counting_lock(identifier):
        arrived.append(identifier)
        return real_lock(identifier)

    monkeypatch.setattr(sftp_handler, 'get_any_sftp_client', silent_server)
    monkeypatch.setattr(sftp_handler, '_get_sftp_lock', counting_lock)
    monkeypatch.setattr(socket_events, 'emit', lambda *a, **k: None)

    def one_request(i):
        with app.test_request_context('/socket.io'):
            request.sid = f'pool-sock-{i}'
            socket_events.handle_list_directory(
                {'session_id': 'pooled', 'remote_path': '/'})

    pool = db.engine.pool
    before = pool.checkedout()
    threads = [threading.Thread(target=one_request, args=(i,), daemon=True)
               for i in range(callers)]
    try:
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + 5
        while len(arrived) < callers and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(arrived) == callers
        time.sleep(0.05)
        assert pool.checkedout() == before, (
            f'{pool.checkedout() - before} database connection(s) held by '
            f'requests waiting on a silent server')
    finally:
        silent.set()
        for thread in threads:
            thread.join(5)
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('pooled', None)


# ---- the chip's latency probe ----------------------------------------------

class _SilentTransport:
    def __init__(self):
        self.calls = 0
        self.answer = threading.Event()

    def is_active(self):
        return True

    def global_request(self, kind, wait=True):
        self.calls += 1
        self.answer.wait(10)
        return None


def test_a_latency_probe_ends_and_never_piles_up(monkeypatch):
    monkeypatch.setattr(ssh_manager, 'LATENCY_PROBE_TIMEOUT_S', 0.2, raising=False)
    transport = _SilentTransport()
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['lat'] = {
            'connected': True,
            'client': types.SimpleNamespace(get_transport=lambda: transport)}
    try:
        started = time.monotonic()
        finished, latency = _deadline_call(
            lambda: ssh_manager.measure_session_latency('lat'), SLACK)
        assert finished and latency is None
        assert time.monotonic() - started < 0.2 + SLACK

        # The first request is still out: a second poll sends nothing.
        started = time.monotonic()
        assert ssh_manager.measure_session_latency('lat') is None
        assert time.monotonic() - started < 0.1
        assert transport.calls == 1

        transport.answer.set()
        deadline = time.monotonic() + SLACK
        while 'lat' in ssh_manager._latency_probes and time.monotonic() < deadline:
            time.sleep(0.01)
        assert isinstance(ssh_manager.measure_session_latency('lat'), int)
        assert transport.calls == 2
    finally:
        transport.answer.set()
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('lat', None)


# ---- a host without tmux gives a plain session -----------------------------

@pytest.fixture
def plain_world(app, monkeypatch):
    import config
    import app.socket_events as socket_events
    from app.auth import register_socket_session, register_user
    from app.models import db

    for name, value in (('TAILSCALE_SSH_ENABLED', True),
                        ('TAILSCALE_SSH_ALLOWED_SSHDECK_USERS', frozenset()),
                        ('TAILSCALE_SSH_ALLOWED_TARGETS', frozenset()),
                        ('TAILSCALE_SSH_ALLOWED_REMOTE_USERS', frozenset()),
                        ('TMUX_ENABLED', True)):
        monkeypatch.setattr(config, name, value)
    user, error = register_user('plainshell', 'plain-shell-password-1')
    assert error is None
    register_socket_session(user.id, 'plain-sock')
    db.session.commit()

    emitted = []

    def fake_create(**kwargs):
        # What create_ssh_connection registers when the host has no tmux:
        # a plain shell, whatever was asked.
        with ssh_manager.sessions_lock:
            ssh_manager.sessions['plain-id'] = {
                'user_id': str(user.id), 'connected': True, 'use_tmux': False,
                'tmux_session_name': None, 'auth_type': 'tailscale',
                'client': types.SimpleNamespace(close=lambda: None),
                'channel': None, 'views': {}, 'host': 'h', 'port': 22,
                'username': 'u'}
        return 'plain-id', None

    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', fake_create)
    monkeypatch.setattr(socket_events, 'emit',
                        lambda event, payload=None, **kw: emitted.append((event, payload)))
    monkeypatch.setattr(socket_events.socketio, 'emit',
                        lambda event, payload=None, **kw: emitted.append((event, payload)))
    yield types.SimpleNamespace(user_id=user.id, emitted=emitted,
                                socket_events=socket_events)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop('plain-id', None)


def _as_socket(app, fn, payload):
    with app.test_request_context('/socket.io',
                                  environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'plain-sock'
        fn(payload)


def _names(world):
    return [event for event, _payload in world.emitted]


def _row(session_id):
    from app.models import SSHSession
    row = SSHSession.query.filter_by(session_id=session_id).first()
    return None if row is None else (row.connected, row.is_persistent,
                                     row.tmux_session_name)


def test_a_session_that_fell_back_to_a_plain_shell_closes_for_good(app, plain_world):
    events = plain_world.socket_events
    _as_socket(app, events.handle_ssh_connect,
               {'host': 'h', 'port': 22, 'username': 'u',
                'auth_type': 'tailscale', 'use_tmux': True})
    connected = [p for e, p in plain_world.emitted if e == 'ssh_connected']
    assert len(connected) == 1
    assert (connected[0]['use_tmux'], connected[0]['tmux_session_name']) == (False, None)
    assert _row('plain-id') == (True, False, None)

    plain_world.emitted.clear()
    _as_socket(app, events.handle_ssh_disconnect, {'session_id': 'plain-id'})
    names = _names(plain_world)
    assert 'ssh_disconnected' in names
    assert 'ssh_session_kept' not in names
    assert 'persistent_session_available' not in names
    assert _row('plain-id') == (False, False, None)

    # The user's next page clears it like any closed plain session.
    plain_world.emitted.clear()
    with app.test_request_context('/socket.io'):
        events.restore_user_sessions(plain_world.user_id, to_sid='plain-sock')
    assert _row('plain-id') is None
    assert 'persistent_session_available' not in _names(plain_world)


def test_boot_turns_a_saved_session_without_tmux_into_a_plain_row(app, monkeypatch):
    from app import worker_guard
    from app.models import SSHSession, db

    db.session.add(SSHSession(session_id='no-tmux', user_id=1, host='h', port=22,
                              username='u', connected=True, is_persistent=True,
                              tmux_session_name=None))
    db.session.add(SSHSession(session_id='with-tmux', user_id=1, host='h', port=22,
                              username='u', connected=False, is_persistent=True,
                              tmux_session_name='sshdeck_u_h_22_keep0001'))
    db.session.commit()
    monkeypatch.setattr(worker_guard, '_GUARD_HELD', True)
    worker_guard.reconcile_ssh_sessions()
    db.session.expire_all()
    assert _row('no-tmux') == (False, False, None)
    assert _row('with-tmux') == (False, True, 'sshdeck_u_h_22_keep0001')


# ---- a disconnect cleans up even when the database cannot answer -----------

def test_a_disconnect_detaches_its_views_even_when_the_database_fails(app, monkeypatch):
    import app.socket_events as socket_events
    detached = []
    monkeypatch.setattr(ssh_manager, 'close_views_for_socket',
                        lambda sid, socketio_instance=None: detached.append(sid) or [])

    def pool_exhausted(sid):
        raise RuntimeError('QueuePool limit of size 5 overflow 10 reached')

    monkeypatch.setattr(socket_events, 'get_user_from_socket', pool_exhausted)
    with app.test_request_context('/socket.io'):
        request.sid = 'gone-sock'
        with pytest.raises(RuntimeError):
            socket_events.handle_disconnect()
    assert detached == ['gone-sock']


def test_opening_a_quick_connect_sftp_does_not_hold_the_pool_lock(monkeypatch):
    """Every user's quick connections share the pool's lock; the SFTP open
    waits on a remote host, so it must happen outside it."""
    from app import connection_pool
    pool = connection_pool.TemporaryConnectionPool.__new__(
        connection_pool.TemporaryConnectionPool)
    opening = threading.Event()
    answer = threading.Event()

    def slow_open(client=None):
        opening.set()
        answer.wait(5)
        return 'sftp'

    # Both openers are the same slow open, so the row measures WHERE the open
    # happens, whichever one the pool calls.
    pool.connections = {'qc': {
        'client': types.SimpleNamespace(get_transport=lambda: _SilentTransport(),
                                        open_sftp=slow_open),
        'sftp': None, 'last_used': 0, 'user_id': '1'}}
    pool.lock = threading.Lock()
    monkeypatch.setattr(sftp_handler, 'open_bounded_sftp', slow_open, raising=False)
    worker = threading.Thread(target=pool.get_sftp_client, args=('qc',), daemon=True)
    worker.start()
    try:
        assert opening.wait(SLACK)
        assert pool.lock.acquire(timeout=0.2), 'the pool lock is held across the open'
        pool.lock.release()
    finally:
        answer.set()
        worker.join(SLACK)
