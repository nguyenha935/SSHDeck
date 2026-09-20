"""S2 step 6 — cap surface: per-user limit, admin force-close, telemetry.

Fakes only. No Owner account, no real SSH, no tmux, no deploy.
Reuses the FakeSSHClient / clean_session_state patterns from
tests/test_session_lifecycle.py so reservation mechanics stay compatible.
"""
import threading

import pytest

from app import ssh_manager


class FakeChannel:
    def __init__(self):
        self.closed = False

    def settimeout(self, _timeout):
        pass

    def close(self):
        self.closed = True


class FakeTransport:
    def set_keepalive(self, _seconds):
        pass

    def is_active(self):
        return True

    def open_session(self, timeout=None):
        return FakeChannel()

    def get_exception(self):
        return None


class FakeSSHClient:
    def __init__(self):
        self.transport = FakeTransport()
        self.channel = FakeChannel()
        self.closed = False

    def load_host_keys(self, _path):
        pass

    def set_missing_host_key_policy(self, _policy):
        pass

    def connect(self, **_kwargs):
        pass

    def get_transport(self):
        return self.transport

    def invoke_shell(self, **_kwargs):
        return self.channel

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def clean_session_state():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
        ssh_manager._pending_connections = 0
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
        ssh_manager._pending_connections = 0


def _connect(user_id=7, **overrides):
    kwargs = {
        'host': 'target.example',
        'port': 22,
        'username': 'alice',
        'password': 'secret',
        'user_id': user_id,
    }
    kwargs.update(overrides)
    return ssh_manager.create_ssh_connection(**kwargs)


def _seed_registry(session_id, user_id, **overrides):
    import time
    sess = {
        'client': FakeSSHClient(),
        'channel': FakeChannel(),
        'host': 'h.example',
        'port': 22,
        'username': 'u',
        'user_id': user_id,
        'connected': True,
        'use_tmux': False,
        'tmux_session_name': None,
        'display_name': None,
        'last_activity': time.time(),
        'last_interaction': time.time(),
        'bastion_client': None,
        'proxy_jump_host': None,
        'auth_type': 'password',
    }
    sess.update(overrides)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = sess
    return sess


# --------------------------------------------------------------------------
# R6-A / R6-D — per-user and global ceilings, distinct errors
# --------------------------------------------------------------------------

def test_per_user_limit_refuses_while_global_still_has_room(monkeypatch):
    """A user at MAX_SESSIONS_PER_USER is refused even when global has room."""
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS', 10)
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS_PER_USER', 2)
    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', FakeSSHClient)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)

    sid1, err1 = _connect(user_id=1)
    sid2, err2 = _connect(user_id=1)
    assert err1 is None and err2 is None
    assert sid1 in ssh_manager.sessions and sid2 in ssh_manager.sessions

    sid3, err3 = _connect(user_id=1)
    assert sid3 is None
    assert err3 == 'Per-user session limit reached'

    # A different user can still connect (global has room).
    sid_other, err_other = _connect(user_id=2)
    assert err_other is None
    assert sid_other in ssh_manager.sessions


def test_global_cap_still_refuses_at_ceiling(monkeypatch):
    """Global ceiling still wins when the registry is full, even if per-user
    would allow this user another slot."""
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS', 2)
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS_PER_USER', 10)
    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', FakeSSHClient)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)

    assert _connect(user_id=1)[1] is None
    assert _connect(user_id=2)[1] is None

    sid, err = _connect(user_id=3)
    assert sid is None
    assert err == 'Maximum number of sessions reached'


def test_existing_pending_reservation_still_works_with_both_limits(monkeypatch):
    """The pending-reservation pin from test_session_lifecycle stays true
    under both ceilings: a reserved slot blocks a second connect at global=1."""
    connect_started = threading.Event()
    connect_release = threading.Event()

    class BlockingClient(FakeSSHClient):
        def connect(self, **_kwargs):
            connect_started.set()
            assert connect_release.wait(2)

    created = []

    def factory():
        c = BlockingClient() if not created else FakeSSHClient()
        created.append(c)
        return c

    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS', 1)
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS_PER_USER', 10)
    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', factory)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)

    first_result = []
    t = threading.Thread(
        target=lambda: first_result.append(_connect(user_id=1)), daemon=True)
    t.start()
    assert connect_started.wait(2)

    sid2, err2 = _connect(user_id=2)
    assert sid2 is None
    assert err2 == 'Maximum number of sessions reached'

    connect_release.set()
    t.join(2)
    assert first_result[0][1] is None


# --------------------------------------------------------------------------
# R6-C — GET /admin/api/capacity
# --------------------------------------------------------------------------

def test_admin_capacity_is_registry_backed(app, client, monkeypatch):
    """Capacity endpoint reports registry truth, not the DB alone."""
    from app.auth import register_user
    from app.models import db

    with app.app_context():
        admin, err = register_user('capadmin', 'pw-123456789')
        assert err is None
        admin.is_admin = True
        db.session.commit()
        other, err = register_user('capuser', 'pw-123456789')
        assert err is None
        other_id = other.id

    _seed_registry('live-1', user_id=other_id, host='a.example')
    _seed_registry('live-2', user_id=other_id, host='b.example', use_tmux=True)

    assert client.post('/login', data={
        'username': 'capadmin', 'password': 'pw-123456789'}).status_code == 302

    response = client.get('/admin/api/capacity')
    assert response.status_code == 200
    body = response.get_json()
    assert body['max_sessions'] >= 1
    assert body['max_sessions_per_user'] >= 1
    assert body['total_live'] == 2
    assert body['pending'] == 0
    assert any(u['user_id'] == other_id and u['live'] == 2
               for u in body['by_user'])
    sids = {s['session_id'] for s in body['sessions']}
    assert sids == {'live-1', 'live-2'}
    tmux_row = next(s for s in body['sessions'] if s['session_id'] == 'live-2')
    assert tmux_row['use_tmux'] is True
    assert tmux_row['user_username'] == 'capuser'


def test_admin_capacity_requires_admin(app, client):
    from app.auth import register_user

    with app.app_context():
        # First user on a fresh DB is bootstrapped admin (app/auth.py).
        bootstrap, err = register_user('capboot', 'pw-123456789')
        assert err is None
        assert bootstrap.is_admin is True
        user, err = register_user('cappleb', 'pw-123456789')
        assert err is None
        assert user.is_admin is False

    assert client.post('/login', data={
        'username': 'cappleb', 'password': 'pw-123456789'}).status_code == 302
    assert client.get('/admin/api/capacity').status_code == 403


# --------------------------------------------------------------------------
# R6-B — POST /admin/api/sessions/<id>/close
# --------------------------------------------------------------------------

def test_admin_force_close_defaults_to_detach(app, client, monkeypatch):
    """Default kill_tmux=False; registry entry gone; optional hard kill path."""
    from app.auth import register_user
    from app.models import db

    with app.app_context():
        admin, err = register_user('closeadmin', 'pw-123456789')
        assert err is None
        admin.is_admin = True
        db.session.commit()

    sess = _seed_registry('force-me', user_id=99, use_tmux=True,
                          tmux_session_name='tmux_force')
    close_calls = []

    def recording_close(session_id, kill_tmux=False, expected_session=None):
        close_calls.append({
            'session_id': session_id,
            'kill_tmux': kill_tmux,
            'expected_session': expected_session,
        })
        ssh_manager.sessions.pop(session_id, None)
        return True

    monkeypatch.setattr(ssh_manager, 'close_session', recording_close)

    assert client.post('/login', data={
        'username': 'closeadmin', 'password': 'pw-123456789'}).status_code == 302

    # Default detach.
    response = client.post('/admin/api/sessions/force-me/close',
                           json={})
    assert response.status_code == 200
    body = response.get_json()
    assert body == {'ok': True, 'session_id': 'force-me', 'kill_tmux': False}
    assert close_calls[0]['kill_tmux'] is False
    assert close_calls[0]['expected_session'] is sess
    assert 'force-me' not in ssh_manager.sessions

    # 404 when already gone.
    assert client.post('/admin/api/sessions/force-me/close',
                       json={}).status_code == 404

    # Hard kill when explicitly requested.
    sess2 = _seed_registry('force-hard', user_id=99, use_tmux=True)
    response = client.post('/admin/api/sessions/force-hard/close',
                           json={'kill_tmux': True})
    assert response.status_code == 200
    assert response.get_json()['kill_tmux'] is True
    assert close_calls[-1]['kill_tmux'] is True
    assert close_calls[-1]['expected_session'] is sess2


def test_admin_force_close_requires_admin(app, client):
    from app.auth import register_user

    with app.app_context():
        # First user on a fresh DB is bootstrapped admin (app/auth.py).
        bootstrap, err = register_user('closeboot', 'pw-123456789')
        assert err is None
        assert bootstrap.is_admin is True
        user, err = register_user('closepleb', 'pw-123456789')
        assert err is None
        assert user.is_admin is False

    _seed_registry('nope', user_id=1)
    assert client.post('/login', data={
        'username': 'closepleb', 'password': 'pw-123456789'}).status_code == 302
    assert client.post('/admin/api/sessions/nope/close',
                       json={}).status_code == 403
