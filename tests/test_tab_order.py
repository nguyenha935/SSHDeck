"""The order of the session chips is the account's (item C,).

The server hands `tab_order` to every connecting socket BEFORE the restore
(so restored chips land in place) and keeps what `save_tab_order` sends,
filtered to the user's own rows.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio


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


def _register(app, username):
    from app.auth import register_user
    with app.app_context():
        user, error = register_user(username, 'tab-order-password-123')
        assert error is None, error
        return user.id


def _socket(app, username):
    http_client = app.test_client()
    assert http_client.post('/login', data={'username': username,
                                            'password': 'tab-order-password-123'}).status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    return socket_client


def _seed(app, user_id, session_id):
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(session_id=session_id, user_id=user_id, host='h',
                                  port=22, username='u', connected=False,
                                  is_persistent=True, tmux_session_name=f'sshdeck_{session_id}'))
        db.session.commit()


def _settle(client):
    deadline = time.monotonic() + 0.4
    events = []
    while time.monotonic() < deadline:
        events.extend(client.get_received())
        socketio.sleep(0.02)
    return events


def _saved_order(app, user_id):
    from app.user_settings import get_user_settings
    with app.app_context():
        return get_user_settings(user_id).get('tab_order')


def test_the_order_arrives_before_the_restore_and_is_kept_per_user(app):
    owner_id = _register(app, 'order_owner')
    other_id = _register(app, 'order_other')
    _seed(app, owner_id, 'own-a'); _seed(app, owner_id, 'own-b'); _seed(app, other_id, 'theirs-c')
    client = _socket(app, 'order_owner')
    try:
        names = [e['name'] for e in client.get_received()]
        assert 'tab_order' in names
        assert names.index('tab_order') < names.index('persistent_session_available')
        client.emit('save_tab_order', {'order': ['own-b', 'theirs-c', 'own-a', 'own-b', 'ghost']})
        _settle(client)
        assert _saved_order(app, owner_id) == ['own-b', 'own-a']
        assert _saved_order(app, other_id) == []
        again = _socket(app, 'order_owner')
        try:
            first = next(e for e in again.get_received() if e['name'] == 'tab_order')
            assert first['args'][0] == {'order': ['own-b', 'own-a']}
        finally:
            again.disconnect()
    finally:
        client.disconnect()


@pytest.mark.parametrize('payload', [
    {'order': 'own-a,own-b'}, {'order': [1, 2]}, {'order': ['x' * 65]},
    {'order': ['id'] * 201}, {},
])
def test_a_bad_payload_leaves_the_saved_order_alone(app, payload):
    user_id = _register(app, f'order_bad_{abs(hash(str(payload))) % 100000}')
    _seed(app, user_id, f'keep-{user_id}')
    client = _socket(app, f'order_bad_{abs(hash(str(payload))) % 100000}')
    try:
        client.get_received()
        client.emit('save_tab_order', {'order': [f'keep-{user_id}']})
        _settle(client)
        client.emit('save_tab_order', payload)
        _settle(client)
        assert _saved_order(app, user_id) == [f'keep-{user_id}']
    finally:
        client.disconnect()
