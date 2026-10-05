"""The keyboard log and the first attach report (`kbdebug_log`).

Both reach the server log through this one event, and both are switched on in
Settings → Diagnostics, which only an administrator sees. The keyboard log
carries what was typed, so the server writes it for an administrator and for
nobody else, whatever a page sends.
"""
import pytest


@pytest.fixture
def accounts(app, monkeypatch):
    """An administrator on socket 'sock-1', a user on 'sock-2'; log lines
    recorded."""
    from app.auth import register_socket_session, register_user
    from app.models import db
    import app.socket_events as socket_events

    with app.app_context():
        admin, error = register_user('kbdadmin', 'kbd-password-123')
        assert error is None
        admin.is_admin = True
        register_socket_session(admin.id, 'sock-1')
        plain, error = register_user('kbdplain', 'kbd-password-123')
        assert error is None
        assert not plain.is_admin
        register_socket_session(plain.id, 'sock-2')
        db.session.commit()

    lines = []
    monkeypatch.setattr(socket_events, 'log_info',
                        lambda message, **fields: lines.append((message, fields)))
    return socket_events, lines


def call(app, socket_events, payload, sid):
    from flask import request
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = sid
        return socket_events.handle_kbdebug_log(payload)


def test_an_administrators_lines_are_written_bounded(app, accounts):
    socket_events, lines = accounts
    call(app, socket_events, {'agent': 'A' * 300,
                              'lines': ['x' * 500] + [f'line {n}' for n in range(60)]}, 'sock-1')
    assert len(lines) == 40
    assert {message for message, _ in lines} == {'kbdebug'}
    first = lines[0][1]
    assert (first['user'], len(first['agent']), len(first['line'])) == ('kbdadmin', 200, 400)


def test_anyone_elses_lines_are_not_written(app, accounts):
    socket_events, lines = accounts
    call(app, socket_events, {'lines': ['attach-report session=abc painted=0']}, 'sock-2')
    assert lines == []
