"""The `?perf=1` performance report (static/js/perf-probe.js).

One minute of a browser's numbers becomes one log line. The record comes from
the client, so it is shaped here: numbers, short strings and short lists of
numbers survive; anything else is dropped. The ack is what the page times.
"""
import pytest


@pytest.fixture
def owner(app, monkeypatch):
    """One user on socket 'sock-1'; log lines recorded."""
    from app.auth import register_socket_session, register_user
    from app.models import db
    import app.socket_events as socket_events

    with app.app_context():
        user, error = register_user('perfowner', 'perf-password-123')
        assert error is None
        register_socket_session(user.id, 'sock-1')
        db.session.commit()

    lines = []
    monkeypatch.setattr(socket_events, 'log_info',
                        lambda message, **fields: lines.append((message, fields)))
    monkeypatch.setattr(socket_events, 'check_socket_rate_limit', lambda *args: False)
    return socket_events, lines


def call(app, socket_events, payload):
    from flask import request
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'sock-1'
        return socket_events.handle_perf_report(payload)


def test_a_report_is_one_line_of_bounded_numbers(app, owner):
    socket_events, lines = owner
    ack = call(app, socket_events, {'agent': 'Mozilla/5.0 (Windows NT 10.0)', 'report': {
        'tr': 'websocket', 'rtt': 41, 'echo': [38, 90, 140, 25], 'swgl': False,
        'gpu': 'Intel, Intel(R) UHD Graphics 620 ' + 'x' * 100,
        'this-key-is-far-too-long': 1,
        'nested': {'a': 1},
        'many': [1, 2, 3, 4, 5],
        'words': ['a', 'b'],
    }})
    assert ack == {'ok': True}
    assert len(lines) == 1
    message, fields = lines[0]
    assert message == 'perf-report'
    assert fields['user'] == 'perfowner'
    assert fields['agent'] == 'Mozilla/5.0 (Windows NT 10.0)'
    assert fields['perf'] == {
        'tr': 'websocket', 'rtt': 41, 'echo': [38, 90, 140, 25], 'swgl': False,
        'gpu': ('Intel, Intel(R) UHD Graphics 620 ' + 'x' * 100)[:60],
    }


def test_the_record_is_capped_in_keys(app, owner):
    socket_events, lines = owner
    call(app, socket_events, {'report': {f'k{n}': n for n in range(100)}})
    assert len(lines[0][1]['perf']) == socket_events.PERF_REPORT_MAX_KEYS


@pytest.mark.parametrize('payload', [{}, {'report': 'text'}, {'report': [1, 2]}])
def test_no_record_no_line(app, owner, payload):
    socket_events, lines = owner
    assert call(app, socket_events, payload) == {'ok': False}
    assert lines == []


def test_past_the_rate_limit_nothing_is_written(app, owner, monkeypatch):
    socket_events, lines = owner
    monkeypatch.setattr(socket_events, 'check_socket_rate_limit', lambda *args: True)
    assert call(app, socket_events, {'report': {'rtt': 1}}) == {'ok': False}
    assert lines == []
