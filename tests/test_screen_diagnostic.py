"""The screen diagnostic: what a browser saw, filed beside what tmux holds.

Owner,: the omp pane showed its prompt row fifty times while the
host pane held it once, and nothing had recorded the bytes the browser was
given, so the defect could not be replayed. `screen_diagnostic` is the
recording: the client's 64 KB stream tail and engine report, the pane as
tmux holds it, one JSON file under DATA_DIR/diagnostics.

Driven through ``socketio.test_client`` so this is the production handler and
the production decorator; only the tmux capture is faked, because there is no
transport here. What is pinned is the shape a person will rely on when they
open the file, and every bound the handler promises: ownership, the rate
limit, the tail cut, the engine report cut, the file mode.
"""
import importlib
import json
import os
import stat
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


_user_counter = [0]
PASSWORD = 'screen-diag-pass-123'


def _authenticated_socket(app, stem):
    """One account per call: the rate limit is per user and counts every call."""
    _user_counter[0] += 1
    username = f'{stem}_{_user_counter[0]}'
    with app.app_context():
        user, error = register_user(username, PASSWORD)
        assert error is None
        user_id = user.id
    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username, 'password': PASSWORD})
    assert response.status_code == 302
    client = socketio.test_client(app, flask_test_client=http_client)
    assert client.is_connected()
    client.get_received()
    return client, user_id, username


def _seed_session(app, user_id, session_id):
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(
            session_id=session_id, user_id=user_id, host='target.example',
            port=22, username='alice', connected=True, is_persistent=True,
            auth_type='password', tmux_session_name=f'sshdeck-{session_id[:8]}'))
        db.session.commit()


def _answer(client, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for event in client.get_received():
            if event['name'] == 'screen_diagnostic_saved':
                return event['args'][0]
        socketio.sleep(0.02)
    raise AssertionError('no screen_diagnostic_saved within the timeout')


def _collect_all(client, settle=0.2):
    deadline = time.monotonic() + settle
    events = []
    while time.monotonic() < deadline:
        events.extend(client.get_received())
        socketio.sleep(0.02)
    return events


def _fake_capture(monkeypatch, host=None):
    calls = []

    def capture(session_id):
        calls.append(session_id)
        return dict(host or {'screen': ['$ prompt', ''], 'geometry': '80x24'})

    monkeypatch.setattr(ssh_manager, 'capture_screen_for_diagnostic', capture)
    return calls


def _diagnostics_dir():
    import config
    return os.path.join(config.DATA_DIR, 'diagnostics')


def _files():
    folder = _diagnostics_dir()
    return sorted(os.listdir(folder)) if os.path.isdir(folder) else []


# --------------------------------------------------------------- the record

def test_diagnostic_is_filed_with_the_host_pane(app, monkeypatch):
    client, user_id, username = _authenticated_socket(app, 'filed')
    _seed_session(app, user_id, 'diag-session-0001')
    calls = _fake_capture(monkeypatch)
    before = set(_files())

    client.emit('screen_diagnostic', {
        'session_id': 'diag-session-0001',
        'tail': 'hello \x1b[2Kworld\r\n',
        'engine': {'cols': 80, 'rows': 24, 'buffer': 'normal', 'baseY': 3,
                   'viewportY': 3, 'cursorX': 2, 'cursorY': 23,
                   'fontSize': 14, 'unicode': '11', 'tailChars': 19,
                   'window': {'cols': 80, 'rows': 24, 'junk': 'x'},
                   'reported': {'cols': 100, 'rows': 40},
                   'screen': ['row one', 'row two']},
    })
    answer = _answer(client)

    assert calls == ['diag-session-0001']
    assert 'error' not in answer
    assert answer['session_id'] == 'diag-session-0001'
    assert answer['host_rows'] == 2
    new = sorted(set(_files()) - before)
    assert new == [answer['name']]
    assert answer['name'].startswith(f'screen-{username}-diag-ses-')
    assert answer['name'].endswith('.json')

    path = os.path.join(_diagnostics_dir(), answer['name'])
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with open(path, encoding='utf-8') as fh:
        record = json.load(fh)
    assert record['version'] == 1
    assert record['user'] == username
    assert record['session_id'] == 'diag-session-0001'
    assert record['tail'] == 'hello \x1b[2Kworld\r\n'
    assert record['host'] == {'screen': ['$ prompt', ''], 'geometry': '80x24'}
    engine = record['engine']
    assert engine['cols'] == 80 and engine['rows'] == 24
    assert engine['buffer'] == 'normal' and engine['unicode'] == '11'
    assert engine['baseY'] == 3 and engine['cursorY'] == 23
    # The small objects are shaped, not copied.
    assert engine['window'] == {'cols': 80, 'rows': 24}
    assert engine['reported'] == {'cols': 100, 'rows': 40}
    assert engine['screen'] == ['row one', 'row two']


def test_tail_and_engine_report_are_cut_to_their_bounds(app, monkeypatch):
    from app import socket_events
    client, user_id, _ = _authenticated_socket(app, 'bounds')
    _seed_session(app, user_id, 'diag-session-0002')
    _fake_capture(monkeypatch)

    tail = 'x' * 70000 + 'END'
    client.emit('screen_diagnostic', {
        'session_id': 'diag-session-0002',
        'tail': tail,
        'engine': {
            'cols': '80',               # wrong type: dropped
            'rows': True,               # bool is not a number here: dropped
            'baseY': 5,
            'buffer': 'n' * 500,        # cut to 200
            'secret': 'not a known field',
            'window': 'not an object',
            'screen': [str(i) * 2000 for i in range(600)],
        },
    })
    answer = _answer(client)
    assert 'error' not in answer

    with open(os.path.join(_diagnostics_dir(), answer['name']),
              encoding='utf-8') as fh:
        record = json.load(fh)
    assert len(record['tail']) == socket_events.SCREEN_DIAGNOSTIC_TAIL_MAX
    assert record['tail'].endswith('END')
    engine = record['engine']
    assert 'cols' not in engine and 'rows' not in engine
    assert engine['baseY'] == 5
    assert len(engine['buffer']) == 200
    assert 'secret' not in engine and 'window' not in engine
    assert len(engine['screen']) == socket_events.SCREEN_DIAGNOSTIC_ROWS_MAX
    assert all(len(row) == socket_events.SCREEN_DIAGNOSTIC_ROW_CHARS
               for row in engine['screen'])


def test_a_capture_failure_is_still_filed(app, monkeypatch):
    # The host side failing (no transport, tmux gone) is itself a finding;
    # the browser's half is kept and the error travels with it.
    client, user_id, _ = _authenticated_socket(app, 'hostfail')
    _seed_session(app, user_id, 'diag-session-0003')
    _fake_capture(monkeypatch, host={'screen': None, 'error': 'Session not found'})

    client.emit('screen_diagnostic', {
        'session_id': 'diag-session-0003', 'tail': 'abc', 'engine': {}})
    answer = _answer(client)
    assert 'error' not in answer
    assert answer['host_rows'] == 0
    with open(os.path.join(_diagnostics_dir(), answer['name']),
              encoding='utf-8') as fh:
        record = json.load(fh)
    assert record['host'] == {'screen': None, 'error': 'Session not found'}
    assert record['tail'] == 'abc'


# --------------------------------------------------------------- refusals

def test_a_session_of_another_account_is_refused(app, monkeypatch):
    client, _, _ = _authenticated_socket(app, 'intruder')
    _, owner_id, _ = _authenticated_socket(app, 'owner')
    _seed_session(app, owner_id, 'diag-session-0004')
    calls = _fake_capture(monkeypatch)
    before = _files()

    client.emit('screen_diagnostic', {
        'session_id': 'diag-session-0004', 'tail': 'x', 'engine': {}})
    answer = _answer(client)
    assert answer == {'session_id': 'diag-session-0004', 'error': 'not_owned'}
    assert calls == []
    assert _files() == before


def test_a_missing_session_id_is_refused(app, monkeypatch):
    client, _, _ = _authenticated_socket(app, 'nosession')
    calls = _fake_capture(monkeypatch)
    before = _files()

    client.emit('screen_diagnostic', {'tail': 'x'})
    assert _answer(client) == {'error': 'no_session'}
    # A payload that is not an object never reaches the handler: the
    # decorator's contract (decorators.py, S1) refuses it with an error frame.
    client.emit('screen_diagnostic', 'not even an object')
    refused = [e for e in _collect_all(client) if e['name'] == 'error']
    assert refused and refused[0]['args'][0] == {'error': 'Invalid payload'}
    assert calls == []
    assert _files() == before


def test_the_seventh_request_in_a_minute_is_rate_limited(app, monkeypatch):
    from app import socket_events
    assert socket_events.SCREEN_DIAGNOSTIC_RATELIMIT == '6 per minute'
    client, user_id, _ = _authenticated_socket(app, 'ratelimit')
    _seed_session(app, user_id, 'diag-session-0006')
    calls = _fake_capture(monkeypatch)

    for _ in range(6):
        client.emit('screen_diagnostic', {
            'session_id': 'diag-session-0006', 'tail': '', 'engine': {}})
        assert 'error' not in _answer(client)
    assert len(calls) == 6

    client.emit('screen_diagnostic', {
        'session_id': 'diag-session-0006', 'tail': '', 'engine': {}})
    assert _answer(client) == {'session_id': 'diag-session-0006',
                               'error': 'rate_limited'}
    assert len(calls) == 6


# ------------------------------------------------- the host-side capture

def test_capture_reads_the_pane_through_bounded_control_calls(monkeypatch):
    calls = []
    outputs = {
        ('capture-pane', ('-p',)): 'line one\nline two\n',
        ('capture-pane', ('-p', '-e')): '\x1b[32mline one\x1b[0m\nline two\n',
        ('display-message',): '80x24 pane=80x24 alt=0 cmd=bash cursor=2,1 history=40\n',
        ('list-clients',): '/dev/pts/3 80x24 1700000000\n',
    }

    def fake(session_id, subcommand, extra_args=None, exact_target=False,
             capture_output=False, max_output=None, **_):
        calls.append((session_id, subcommand, tuple(extra_args or ()),
                      exact_target, capture_output, max_output))
        key = (subcommand, tuple(extra_args or ()))
        if subcommand in ('display-message', 'list-clients'):
            key = (subcommand,)
        return True, None, outputs[key]

    monkeypatch.setattr(ssh_manager, '_exec_tmux_control', fake)
    out = ssh_manager.capture_screen_for_diagnostic('sess-1')

    assert out['screen'] == ['line one', 'line two', '']
    assert out['screen_with_attributes'].startswith('\x1b[32m')
    assert out['geometry'] == '80x24 pane=80x24 alt=0 cmd=bash cursor=2,1 history=40'
    assert out['clients'] == ['/dev/pts/3 80x24 1700000000']
    assert 'error' not in out
    # Every call is scoped to the exact session, captures output, and the two
    # pane reads carry the explicit diagnostic cap (the default cap is 64
    # bytes, which would refuse any real pane).
    assert [c[0] for c in calls] == ['sess-1'] * 4
    assert [c[1] for c in calls] == [
        'capture-pane', 'capture-pane', 'display-message', 'list-clients']
    assert all(c[4] is True for c in calls)
    assert calls[0][3] is True and calls[1][3] is True and calls[2][3] is True
    assert calls[0][5] == ssh_manager._DIAGNOSTIC_CAPTURE_MAX
    assert calls[1][5] == ssh_manager._DIAGNOSTIC_CAPTURE_MAX


def test_capture_stops_at_the_first_failure(monkeypatch):
    calls = []

    def fake(session_id, subcommand, *args, **kwargs):
        calls.append(subcommand)
        return False, 'Session not connected', ''

    monkeypatch.setattr(ssh_manager, '_exec_tmux_control', fake)
    out = ssh_manager.capture_screen_for_diagnostic('sess-2')
    assert out == {'screen': None, 'error': 'Session not connected'}
    assert calls == ['capture-pane']


def test_timeline_and_paint_are_kept_flat_and_bounded():
    """The two records the client adds are shaped here, not trusted."""
    from app.socket_events import (SCREEN_DIAGNOSTIC_TIMELINE_MAX,
                                   _bounded_engine_report)
    normal = [{'t': i, 's': 'abcd1234', 'e': 'write', 'src': 'out', 'k': 2}
              for i in range(SCREEN_DIAGNOSTIC_TIMELINE_MAX + 50)]
    odd = {'e': 'x' * 500, 'nested': {'a': 1}, 'rect': [1, 2, 3, 4, 5],
           'k' * 40: 1, 'ok': True}
    out = _bounded_engine_report({
        'timeline': normal + ['not a record', odd],
        'paint': {'domRows': 24, 'screen': [0, 0, 900, 520],
                  'look': 'x' * 200, 'deep': {'x': 1}},
        'now': 5,
    })
    kept = out['timeline']
    # The newest TIMELINE_MAX items, of which one is not a record.
    assert len(kept) == SCREEN_DIAGNOSTIC_TIMELINE_MAX - 1
    assert kept[0]['t'] == 52 and kept[-2]['t'] == 449
    assert kept[-1] == {'e': 'x' * 60, 'ok': True}
    assert out['paint'] == {'domRows': 24, 'screen': [0, 0, 900, 520], 'look': 'x' * 60}
    assert out['now'] == 5
