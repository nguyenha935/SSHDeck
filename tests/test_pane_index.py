"""The split pane a session sits in lives on its row.

`pane_index` was a column that only ever got read, so the restore branch that
honoured it was dead and every reload re-dealt the panes. The client now
reports each change through `session_pane_index`; this pins the handler's
bounds and ownership.
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


def _authenticated_socket(app, username):
    from app.auth import register_user
    password = 'pane-index-password-123'
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


def _seed(app, user_id, session_id, pane_index=None):
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(session_id=session_id, user_id=user_id, host='h',
                                  port=22, username='u', connected=True,
                                  is_persistent=True, pane_index=pane_index,
                                  tmux_session_name=f'sshdeck_u_h_22_{session_id}'))
        db.session.commit()


def _pane(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        return SSHSession.query.filter_by(session_id=session_id).first().pane_index


def _settle(socket_client):
    deadline = time.monotonic() + 0.4
    while time.monotonic() < deadline:
        socket_client.get_received()
        socketio.sleep(0.02)


def test_the_pane_is_recorded_and_cleared(app):
    client, user_id = _authenticated_socket(app, 'pane_owner')
    try:
        _seed(app, user_id, 'p1')
        client.emit('session_pane_index', {'session_id': 'p1', 'pane_index': 3})
        _settle(client)
        assert _pane(app, 'p1') == 3
        client.emit('session_pane_index', {'session_id': 'p1', 'pane_index': None})
        _settle(client)
        assert _pane(app, 'p1') is None
    finally:
        client.disconnect()


def test_out_of_range_and_non_integer_values_are_ignored(app):
    client, user_id = _authenticated_socket(app, 'pane_bounds')
    try:
        _seed(app, user_id, 'p2', pane_index=1)
        for bad in [6, -1, '2', 2.5, True]:
            client.emit('session_pane_index', {'session_id': 'p2', 'pane_index': bad})
        _settle(client)
        assert _pane(app, 'p2') == 1
    finally:
        client.disconnect()


def test_another_users_row_is_untouched(app):
    owner, owner_id = _authenticated_socket(app, 'pane_victim')
    other, _other_id = _authenticated_socket(app, 'pane_attacker')
    try:
        _seed(app, owner_id, 'p3', pane_index=0)
        other.emit('session_pane_index', {'session_id': 'p3', 'pane_index': 5})
        _settle(other)
        assert _pane(app, 'p3') == 0
    finally:
        owner.disconnect()
        other.disconnect()
