"""S14-5 — COMPOSER <-> TERMINAL TWO-WAY SYNC: the REVERSE path.

The forward path (composer -> PTY) has existed since the hybrid input model:
`beforeinput` decides, `input` streams, `sentLen` records how much of the draft
is already live in the remote's line editor, and the streamed prefix is
immutable. The REVERSE path — reading what the shell's line editor actually
holds — did not exist at all: `grep -rn capture-pane app static templates`
returned only test files, and no module read the remote's current input line.

Without it the owner contract cannot hold. When SSHDeck reopens a session the
composer restores a draft whose `sentLen` describes characters that may no
longer be at the prompt (another device typed, the shell echoed output, the
line was killed), and nothing reconciles the two. The draft could only ever be
corrected by the user tapping Resync, and only in the direction
composer -> terminal.

This module pins the SERVER half of the fix:

  * `ssh_manager.read_tmux_pending_line` reads the pane's current input line
    over the EXISTING control channel with `tmux capture-pane -p`, read-only,
    under the D-6'-a boundary granted for `refresh-client`:
    it sends no keys, performs no resize, and must not alter PTY authority;
  * it fails CLOSED whenever the visible line is not a shell input line —
    the alternate screen, a non-tmux session, or any tmux output it cannot
    parse — because a wrong line would be reconciled INTO the user's draft.
    Copy mode is NOT such a case (S17 FIX 4c): there `cursor_y`/`cursor_x`
    still address the real shell cursor, the overlay having its own separate
    `copy_cursor_y` format, and with tmux `mouse on` as the product default
    refusing there meant one swipe disabled terminal truth for good;
  * the `get_terminal_line` socket event answers only for a session the
    requesting user owns (`verify_session_ownership`), and a refusal is a
    distinct `terminal_line_unavailable` frame rather than a silent empty line.

The two control calls are driven through the real `_exec_tmux_control`, with
only the SSH transport faked at the seam `tests/test_tmux_control.py` already
uses, so the wiring under test is production wiring.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio, ssh_manager
from app.auth import register_user
from tests.test_tmux_control import (FakeCaptureChannel, FakeControlClient,
                                     FakePTYChannel, SequenceTransport)

TMUX_NAME = 'sshdeck_alice_host_22_abcd1234'
EXACT_TARGET = f'={TMUX_NAME}:'


@pytest.fixture(scope='module')
def app():
    """Module-scoped app so the global Socket.IO handlers register once."""
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


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


def install_line_session(session_id='sess-line',
                         format_output=b'0,0,3,13\n',
                         line_output=b'deploy@box:~$ systemctl status\n',
                         format_exit=0, line_exit=0,
                         use_tmux=True, connected=True,
                         user_id=None, pty_size=(120, 40)):
    """A tmux session whose control transport hands out two capture channels.

    Channel 1 answers the `display-message -p` state query, channel 2 the
    `capture-pane -p` read. A refusing path must leave channel 2 untouched
    (`command is None`) and `transport.opened == 1` — that is how "no read was
    attempted" is proven rather than assumed.
    """
    state_channel = FakeCaptureChannel(exit_status=format_exit,
                                       output=format_output)
    line_channel = FakeCaptureChannel(exit_status=line_exit,
                                      output=line_output)
    transport = SequenceTransport([state_channel, line_channel])
    pty = FakePTYChannel()
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': FakeControlClient(transport),
            'connected': connected,
            'use_tmux': use_tmux,
            'tmux_session_name': TMUX_NAME if use_tmux else None,
            'channel': pty,
            'user_id': user_id,
            'pty_size': pty_size,
        }
    return session_id, state_channel, line_channel, pty, transport


def commands_of(*channels):
    return [c.command for c in channels if c.command is not None]


# ── ssh_manager.read_tmux_pending_line ──────────────────────────────────────

def test_pending_line_reads_the_pane_over_the_control_channel():
    """Two read-only tmux calls: the state query, then `capture-pane -p`."""
    sid, state, line, _pty, transport = install_line_session()

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True and error is None
    assert transport.opened == 2, 'exactly two control channels, no more'
    assert state.command.startswith(f'tmux display-message -t {EXACT_TARGET} -p ')
    for var in ('#{pane_in_mode}', '#{alternate_on}',
                '#{cursor_y}', '#{cursor_x}'):
        assert var in state.command, var
    assert line.command.startswith(f'tmux capture-pane -t {EXACT_TARGET} ')
    assert ' -p ' in f'{line.command} '
    # Both channels are closed by the helper's finally block; a leaked exec
    # channel on every sample would accumulate for the life of the session.
    assert state.closed is True and line.closed is True
    assert pending['line'] == 'deploy@box:~$ systemctl status'
    assert pending['cursor_x'] == 13
    assert pending['cursor_y'] == 3


def test_pending_line_sends_no_keys_and_no_resize_under_d6a():
    """D-6'-a: read-only. No keys reach the PTY and no tmux geometry command is
    issued, so sampling the pane cannot disturb the pane being sampled.

: the PTY-authority snapshot this used to compare before/after is
    gone with the authority resolver -- each browser socket owns its own tmux
    client now, so there is no single session size to snapshot. "Nothing
    changed" is asserted where it stays observable: the bytes written to the
    PTY and the tmux commands run.
    """
    sid, state, line, pty, _transport = install_line_session()

    ok, _error, _pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True
    assert pty.sent == [], 'the interactive PTY must receive nothing'
    for command in commands_of(state, line):
        for forbidden in ('send-keys', 'resize-window', 'resize-pane',
                          'set-option', 'copy-mode', 'refresh-client'):
            assert forbidden not in command, (forbidden, command)


def test_pending_line_capture_window_is_bounded_and_ends_at_the_cursor_row():
    """The read is bounded to the cursor row plus four rows above it, so a
    wrapped input line is recoverable without ever streaming a whole pane."""
    sid, _state, line, _pty, _transport = install_line_session(
        format_output=b'0,0,30,7\n', line_output=b'a\nb\nc\nd\n$ hello\n')

    ok, _error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True
    assert ' -S 26 ' in f'{line.command} '
    assert ' -E 30 ' in f'{line.command} '
    # -J joins the rows tmux itself wrapped, so a wrapped command line comes
    # back as ONE logical line instead of visual fragments.
    assert ' -J ' in f'{line.command} '
    # The cursor row is the LAST row of the window; earlier rows are context
    # that only matters when the line wrapped into the cursor row.
    assert pending['line'] == '$ hello'


def test_pending_line_window_never_starts_above_the_pane_top():
    sid, _state, line, _pty, _transport = install_line_session(
        format_output=b'0,0,2,4\n', line_output=b'$ ls\n')

    ok, _error, _pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True
    assert ' -S 0 ' in f'{line.command} '


def test_pending_line_survives_a_line_longer_than_the_format_cap():
    """A real command line is longer than the 64-byte cap that bounds a format
    query, so the capture read must carry its own larger bound. Without it the
    reader would report "too much output" for an ordinary long command."""
    long_line = ('$ ' + 'x' * 300).encode()
    sid, _state, _line, _pty, _transport = install_line_session(
        format_output=b'0,0,3,302\n', line_output=long_line + b'\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True, error
    assert pending['line'] == long_line.decode()


def test_pending_line_still_reads_the_line_in_copy_mode():
    """S17 FIX 4c, RE-POINTED from `..._fails_closed_in_copy_mode`.

    The old row asserted that copy mode refuses. That specification was wrong
    and it broke the composer exactly on the device: tmux `mouse on` is the
    product default (socket_events.py:309), so one upward swipe puts the pane in
    copy mode, and this function is the composer's ONLY source of terminal truth
    (socket_events.py:2016 is the sole call site) -- so the refusal disabled the
    read-first erase and left only its destructive \\x15 fallback.

    Measured on a scratch tmux 3.4 server (/tmp/s16work/s17_copymode_keys.py):
    in copy mode `pane_in_mode` is 1 while `cursor_y`/`cursor_x` STILL describe
    the real shell cursor (0,0,23,39 normal -> 1,0,22,39 in copy mode), the
    overlay's own cursor being the separate `copy_cursor_y` format (12), and
    `capture-pane -p -J -S 0 -E <cursor_y>` returned the true pending row
    'root@the host:/tmp# echo pendingtext'. The overlay is a VIEW; the
    addressed rows are unchanged.

    Nothing is loosened: the alternate screen still fails closed (the row
    below), and this row now asserts the STRONGER property that the capture
    really runs and returns the real line.
    """
    sid, _state, line, _pty, transport = install_line_session(
        format_output=b'1,0,3,13\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True and error is None
    # The capture really ran -- the old row asserted `line.command is None` and
    # `transport.opened == 1`, which is precisely the defect.
    assert transport.opened == 2
    assert line.command is not None
    assert ' -E 3 ' in f'{line.command} '
    assert pending['line'] == 'deploy@box:~$ systemctl status'
    assert pending['cursor_x'] == 13
    assert pending['cursor_y'] == 3


def test_pending_line_in_copy_mode_on_the_alternate_screen_still_refuses():
    """S17 FIX 4c: the two flags were split, so pin the combination too --
    `alternate_on` refuses whatever `pane_in_mode` says."""
    sid, _state, line, _pty, transport = install_line_session(
        format_output=b'1,1,3,13\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is False
    assert pending is None
    assert error
    assert line.command is None
    assert transport.opened == 1


def test_pending_line_in_copy_mode_at_column_zero_is_still_an_empty_line():
    """S17 FIX 4c widened copy mode ONLY. The cursor_x == 0 answer is untouched:
    an empty cursor row is still reported as an empty line with no capture."""
    sid, _state, line, _pty, transport = install_line_session(
        format_output=b'1,0,3,0\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True and error is None
    assert pending == {'line': '', 'cursor_x': 0, 'cursor_y': 3}
    assert line.command is None
    assert transport.opened == 1


def test_pending_line_fails_closed_on_the_alternate_screen():
    """vim/nano/less own the screen; its last row is not a shell input line."""
    sid, _state, line, _pty, transport = install_line_session(
        format_output=b'0,1,3,13\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is False
    assert pending is None
    assert error
    assert line.command is None
    assert transport.opened == 1


@pytest.mark.parametrize('output', [
    b'\n',                 # nothing at all
    b'0,0,3\n',            # a field short
    b'0,0,3,13,80\n',      # a field long
    b'x,0,3,13\n',         # not a number
    b'0,0,-1,13\n',        # negative row
    b'garbage\n',
])
def test_pending_line_fails_closed_on_unparsable_tmux_state(output):
    """Anything the reader cannot parse is an error, never a guess: a wrong
    line would be reconciled straight into the user's draft."""
    sid, _state, line, _pty, transport = install_line_session(
        format_output=output)

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is False
    assert pending is None
    assert error
    assert line.command is None
    assert transport.opened == 1


def test_pending_line_refuses_a_non_tmux_session():
    sid, state, line, _pty, transport = install_line_session(use_tmux=False)

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is False
    assert pending is None
    assert error
    assert state.command is None and line.command is None
    assert transport.opened == 0


def test_pending_line_refuses_an_unknown_session():
    ok, error, pending = ssh_manager.read_tmux_pending_line('no-such-session')

    assert ok is False
    assert pending is None
    assert error


def test_pending_line_at_column_zero_is_an_empty_line_not_a_stale_row():
    """Cursor at column 0 means the row holds nothing — a fresh row after
    Enter, or the exact wrap boundary. Reporting the row ABOVE it would hand
    the composer a finished command as its pending input, so this answers with
    an empty line and reads no pane at all."""
    sid, _state, line, _pty, transport = install_line_session(
        format_output=b'0,0,7,0\n')

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is True and error is None
    assert pending == {'line': '', 'cursor_x': 0, 'cursor_y': 7}
    assert line.command is None
    assert transport.opened == 1


def test_pending_line_propagates_a_failed_capture_as_an_error():
    sid, _state, _line, _pty, _transport = install_line_session(line_exit=1)

    ok, error, pending = ssh_manager.read_tmux_pending_line(sid)

    assert ok is False
    assert pending is None
    assert error


# ── the get_terminal_line socket event ──────────────────────────────────────

_registered = {}


def _login(app, stem):
    registered = _registered.setdefault(id(app), set())
    if stem not in registered:
        with app.app_context():
            user, error = register_user(stem, 'terminal-truth-pass-123')
            assert error is None
        registered.add(stem)
    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': stem, 'password': 'terminal-truth-pass-123',
    })
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client


def _user_id(app, stem):
    from app.models import User
    with app.app_context():
        return User.query.filter_by(username=stem).first().id


def _received(socket_client, name, timeout=5):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if any(event['name'] == name for event in events):
            break
        socketio.sleep(0.02)
    return [event['args'][0] for event in events if event['name'] == name]


def test_terminal_line_answers_the_owner_with_the_pending_line(app, monkeypatch):
    client = _login(app, 'truth_owner')
    user_id = _user_id(app, 'truth_owner')
    sid, _state, _line, _pty, _transport = install_line_session(
        session_id='truth-own-1', user_id=user_id)

    client.emit('get_terminal_line', {'session_id': sid})
    frames = _received(client, 'terminal_line_data')

    assert len(frames) == 1
    assert frames[0]['session_id'] == sid
    assert frames[0]['line'] == 'deploy@box:~$ systemctl status'
    assert frames[0]['cursor_x'] == 13
    client.disconnect()


def test_terminal_line_refuses_a_session_the_user_does_not_own(app):
    """A foreign session id must be refused BEFORE any tmux command runs."""
    with app.app_context():
        user, error = register_user('truth_owner2', 'terminal-truth-pass-123')
        assert error is None
        owner_id = user.id
    intruder = _login(app, 'truth_intruder')
    sid, state, line, _pty, transport = install_line_session(
        session_id='truth-foreign-1', user_id=owner_id)

    intruder.emit('get_terminal_line', {'session_id': sid})
    errors = _received(intruder, 'error')

    assert errors, 'an unowned session must be refused'
    assert _received(intruder, 'terminal_line_data', timeout=0.3) == []
    assert state.command is None and line.command is None
    assert transport.opened == 0
    intruder.disconnect()


def test_terminal_line_reports_a_refusal_as_unavailable_with_a_reason(app):
    """A refusal is its own frame. An empty `terminal_line_data` would read as
    "the shell's line is empty" and wrongly release the composer's lock."""
    client = _login(app, 'truth_unavail')
    user_id = _user_id(app, 'truth_unavail')
    sid, _state, _line, _pty, _transport = install_line_session(
        session_id='truth-unavail-1', user_id=user_id,
        format_output=b'0,1,3,13\n')

    client.emit('get_terminal_line', {'session_id': sid})
    frames = _received(client, 'terminal_line_unavailable')

    assert len(frames) == 1
    assert frames[0]['session_id'] == sid
    assert frames[0]['reason']
    assert _received(client, 'terminal_line_data', timeout=0.3) == []
    client.disconnect()


def test_terminal_line_without_a_session_id_is_unavailable_not_an_exception(app):
    client = _login(app, 'truth_nosid')

    client.emit('get_terminal_line', {})
    frames = _received(client, 'terminal_line_unavailable')

    assert len(frames) == 1
    assert frames[0]['reason']
    client.disconnect()
