"""A session opened or retired on ONE socket is news for the user's OTHERS.

Owner report (phone next to desktop): "Các nút connect không đồng
bộ ngay trên điện thoại, click reconnect mà vẫn hiển thị tab chưa connect bên
cạnh, phải tải lại mới hết." The desktop claimed a saved row; the phone kept
offering it, and its own Reconnect was refused because the claim had deleted
the row. Nothing told the phone. These tests pin what now does:

  §1 a successful connect is announced to the user's other sockets as an
     `ssh_session_restored` snapshot marked `live`, carrying the row a
     reconnect claim retired (`replaces_session_id`); the requester hears
     `ssh_connected` only, never the announcement;
  §2 a candidate reset and a persistent session's disconnect announce
     `ssh_session_removed` to the other sockets, not to the requester (its
     own ack path retires its chip); a non-persistent disconnect removes no
     row and so announces nothing;
  §3 another user's sockets hear none of it.

`socketio.test_client` drives the real handlers with two sockets logged in as
the same account.
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
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


PASSWORD = 'propagation-pass-123'


def _login_socket(app, username):
    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username, 'password': PASSWORD})
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client


def _user_with_two_sockets(app, username):
    with app.app_context():
        user, error = register_user(username, PASSWORD)
        assert error is None, error
        user_id = user.id
    return user_id, _login_socket(app, username), _login_socket(app, username)


def _seed_row(app, user_id, session_id, tmux_name, **overrides):
    from app.models import SSHSession, db
    fields = {
        'host': 'target.example', 'port': 22, 'username': 'alice',
        'connected': False, 'is_persistent': True, 'auth_type': 'password',
        'tmux_session_name': tmux_name,
    }
    fields.update(overrides)
    with app.app_context():
        db.session.add(SSHSession(
            session_id=session_id, user_id=user_id, **fields))
        db.session.commit()


def _collect(socket_client, *event_names, timeout=3):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if event_names and any(e['name'] in event_names for e in events):
            break
        socketio.sleep(0.02)
    return events


def _named(events, name):
    return [e['args'][0] for e in events if e['name'] == name]


def _fake_build(monkeypatch, new_session_id, tmux_name):
    monkeypatch.setattr(
        ssh_manager, 'create_ssh_connection',
        lambda **_kw: (new_session_id, None))
    monkeypatch.setattr(
        ssh_manager, 'get_session',
        lambda _sid: {'tmux_session_name': tmux_name, 'connected': True,
                      'use_tmux': True, 'legacy_tmux_locale': None,
                      'auth_type': 'password', 'display_name': 'Prod box'})


def _connect_payload(**extra):
    payload = {'host': 'target.example', 'port': 22, 'username': 'alice',
               'auth_type': 'password', 'password': 'secret',
               'use_tmux': True}
    payload.update(extra)
    return payload


# ── §1 connects ──────────────────────────────────────────────────────────────

def test_a_reconnect_claim_is_announced_live_with_the_row_it_replaced(
        app, monkeypatch):
    user_id, desktop, phone = _user_with_two_sockets(app, 'prop_claim')
    _seed_row(app, user_id, 'old-row', 'sshdeck_prop_claim')
    _fake_build(monkeypatch, 'new-live', 'sshdeck_prop_claim')
    try:
        desktop.emit('ssh_connect', _connect_payload(
            reconnect_tmux_name='sshdeck_prop_claim', session_id='old-row'))
        assert _named(_collect(desktop, 'ssh_connected', 'ssh_error'),
                      'ssh_connected')

        announced = _named(_collect(phone, 'ssh_session_restored'),
                           'ssh_session_restored')
        assert len(announced) == 1
        frame = announced[0]
        assert frame['session_id'] == 'new-live'
        assert frame['live'] is True
        assert frame['replaces_session_id'] == 'old-row'
        assert frame['tmux_session_name'] == 'sshdeck_prop_claim'
        assert frame['connected'] is True
        # Restore-shaped, so the client's one restore path handles it -- and
        # with nothing to replay, so no replay window is ever opened for it.
        assert frame['snapshot_version'] == 1
        assert frame['replay_total_chunks'] == 0
        # The requester is not told twice.
        assert not _named(_collect(desktop, timeout=0.3),
                          'ssh_session_restored')
    finally:
        desktop.disconnect()
        phone.disconnect()


def test_a_plain_connect_is_announced_live_replacing_nothing(app, monkeypatch):
    user_id, desktop, phone = _user_with_two_sockets(app, 'prop_plain')
    _fake_build(monkeypatch, 'plain-live', 'sshdeck_prop_plain')
    try:
        desktop.emit('ssh_connect', _connect_payload())
        assert _named(_collect(desktop, 'ssh_connected', 'ssh_error'),
                      'ssh_connected')

        announced = _named(_collect(phone, 'ssh_session_restored'),
                           'ssh_session_restored')
        assert len(announced) == 1
        assert announced[0]['session_id'] == 'plain-live'
        assert announced[0]['live'] is True
        assert announced[0]['replaces_session_id'] is None
    finally:
        desktop.disconnect()
        phone.disconnect()


# ── §2 retirements ───────────────────────────────────────────────────────────

def test_a_candidate_reset_is_announced_as_a_removal(app):
    user_id, desktop, phone = _user_with_two_sockets(app, 'prop_reset')
    _seed_row(app, user_id, 'reset-row', 'sshdeck_prop_reset')
    try:
        desktop.emit('candidate_reset', {'session_id': 'reset-row',
                                         'request_id': 'req-1'})
        acks = _named(_collect(desktop, 'candidate_reset_ack',
                               'candidate_reset_error'),
                      'candidate_reset_ack')
        assert acks and acks[0]['request_id'] == 'req-1'

        removed = _named(_collect(phone, 'ssh_session_removed'),
                         'ssh_session_removed')
        assert removed == [{'session_id': 'reset-row'}]
        assert not _named(_collect(desktop, timeout=0.3),
                          'ssh_session_removed')
    finally:
        desktop.disconnect()
        phone.disconnect()


def test_a_persistent_disconnect_is_announced_as_a_removal(app, monkeypatch):
    user_id, desktop, phone = _user_with_two_sockets(app, 'prop_disc')
    _seed_row(app, user_id, 'disc-row', 'sshdeck_prop_disc', connected=True)
    monkeypatch.setattr(ssh_manager, 'close_session',
                        lambda *_a, **_k: True)
    try:
        desktop.emit('ssh_disconnect', {'session_id': 'disc-row'})
        _collect(desktop, 'ssh_disconnected', 'ssh_error')

        events = _collect(phone, 'ssh_session_removed')
        assert _named(events, 'ssh_session_removed') == [
            {'session_id': 'disc-row'}]
        # The status frame still reaches the whole room, removal follows it.
        names = [e['name'] for e in events]
        assert names.index('ssh_disconnected') < names.index(
            'ssh_session_removed')
    finally:
        desktop.disconnect()
        phone.disconnect()


def test_a_non_persistent_disconnect_removes_no_row_and_announces_none(
        app, monkeypatch):
    user_id, desktop, phone = _user_with_two_sockets(app, 'prop_plain_disc')
    _seed_row(app, user_id, 'plain-row', None, connected=True,
              is_persistent=False)
    monkeypatch.setattr(ssh_manager, 'close_session',
                        lambda *_a, **_k: True)
    try:
        desktop.emit('ssh_disconnect', {'session_id': 'plain-row'})
        _collect(desktop, 'ssh_disconnected', 'ssh_error')

        events = _collect(phone, 'ssh_disconnected')
        assert _named(events, 'ssh_disconnected')
        assert not _named(_collect(phone, timeout=0.3), 'ssh_session_removed')
    finally:
        desktop.disconnect()
        phone.disconnect()


# ── §3 other users ───────────────────────────────────────────────────────────

def test_another_user_hears_nothing(app, monkeypatch):
    user_id, desktop, _phone = _user_with_two_sockets(app, 'prop_owner')
    _phone.disconnect()
    _other_id, stranger, _s2 = _user_with_two_sockets(app, 'prop_stranger')
    _s2.disconnect()
    _seed_row(app, user_id, 'owner-row', 'sshdeck_prop_owner')
    _fake_build(monkeypatch, 'owner-live', 'sshdeck_prop_owner')
    try:
        desktop.emit('ssh_connect', _connect_payload(
            reconnect_tmux_name='sshdeck_prop_owner', session_id='owner-row'))
        assert _named(_collect(desktop, 'ssh_connected', 'ssh_error'),
                      'ssh_connected')
        desktop.emit('candidate_reset', {'session_id': 'missing-row',
                                         'request_id': 'req-x'})
        _collect(desktop, 'candidate_reset_ack', 'candidate_reset_error')

        heard = [e['name'] for e in _collect(stranger, timeout=0.5)]
        assert 'ssh_session_restored' not in heard
        assert 'ssh_session_removed' not in heard
    finally:
        desktop.disconnect()
        stranger.disconnect()
