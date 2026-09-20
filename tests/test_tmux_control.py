import threading
import time

import pytest

from app import ssh_manager


class FakeExecChannel:
    """Records the command run on a short-lived exec channel."""

    def __init__(self, exit_status=0, exec_error=None):
        self.exit_status = exit_status
        self.exec_error = exec_error
        self.command = None
        self.timeout = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def exec_command(self, command):
        self.command = command
        if self.exec_error:
            raise self.exec_error

    def recv(self, _n):
        return b''

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.exit_status

    def close(self):
        self.closed = True


class FakeControlTransport:
    def __init__(self, channel, active=True):
        self._channel = channel
        self._active = active
        self.opened = 0
        self.open_timeout = None

    def is_active(self):
        return self._active

    def open_session(self, timeout=None):
        # _run_tmux_control_command bounds the channel open with timeout=3.0 so a
        # half-open TCP cannot block the eventlet worker; accept and record it.
        self.opened += 1
        self.open_timeout = timeout
        return self._channel


class FakeControlClient:
    def __init__(self, transport):
        self._transport = transport

    def get_transport(self):
        return self._transport


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


def install_tmux_session(session_id='sess-1', tmux_name='sshdeck_alice_host_22_abcd1234',
                         exit_status=0, exec_error=None, active=True,
                         use_tmux=True, connected=True):
    channel = FakeExecChannel(exit_status=exit_status, exec_error=exec_error)
    transport = FakeControlTransport(channel, active=active)
    client = FakeControlClient(transport)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': client,
            'connected': connected,
            'use_tmux': use_tmux,
            'tmux_session_name': tmux_name,
        }
    return session_id, channel, transport


# ---- _run_tmux_control_command -------------------------------------------

def test_control_command_targets_the_exact_session():
    session_id, channel, _ = install_tmux_session(tmux_name='sshdeck_alice_host_22_abcd1234')

    ok, err = ssh_manager._run_tmux_control_command(
        session_id, 'set-option', ['mouse', 'off'])

    assert ok is True
    assert err is None
    # Target placed right after the subcommand and every part is quoted.
    assert channel.command == "tmux set-option -t sshdeck_alice_host_22_abcd1234 mouse off"
    assert channel.closed is True


def test_control_command_quotes_the_target():
    # Even though SSHDeck generates safe names, a name with shell metacharacters
    # must be passed as a single quoted argument, never interpolated raw.
    session_id, channel, _ = install_tmux_session(tmux_name='weird; rm -rf /')

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'off'])

    assert ok is True
    assert "'weird; rm -rf /'" in channel.command
    # The dangerous text is inside a single quoted token, not runnable.
    assert channel.command.startswith("tmux set-option -t 'weird; rm -rf /' mouse off")


def test_control_command_rejects_non_tmux_session():
    session_id, channel, _ = install_tmux_session(use_tmux=False)

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'off'])

    assert ok is False
    assert 'not a tmux session' in err
    assert channel.command is None


def test_control_command_rejects_unknown_session():
    ok, err = ssh_manager._run_tmux_control_command('missing', 'set-option', ['mouse', 'off'])

    assert ok is False
    assert err == 'Session not found'


def test_control_command_reports_nonzero_exit():
    session_id, channel, _ = install_tmux_session(exit_status=1)

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'off'])

    assert ok is False
    assert 'status 1' in err
    assert channel.closed is True


def test_control_command_closes_channel_on_error():
    session_id, channel, _ = install_tmux_session(exec_error=RuntimeError('boom'))

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'off'])

    assert ok is False
    assert 'boom' in err
    # A failure must still close the channel and must NOT drop the SSH session.
    assert channel.closed is True
    assert session_id in ssh_manager.sessions


def test_control_command_requires_active_transport():
    session_id, channel, _ = install_tmux_session(active=False)

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'off'])

    assert ok is False
    assert 'transport is not active' in err
    assert channel.command is None


# ---- set_tmux_mouse_mode --------------------------------------------------

def test_set_mouse_mode_on():
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mouse_mode(session_id, True)

    assert ok is True
    assert channel.command.endswith('mouse on')
    # Session-scoped only: never a global (-g) or server (-s) option.
    assert ' -g ' not in channel.command
    assert ' -s ' not in channel.command


def test_set_mouse_mode_off():
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mouse_mode(session_id, False)

    assert ok is True
    assert channel.command.endswith('mouse off')


def test_set_mouse_mode_rejects_non_boolean():
    # A truthy non-bool (e.g. the string 'on' from a malformed client) must be
    # rejected before any tmux command runs, so the option can only ever be the
    # literal on/off this helper controls.
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mouse_mode(session_id, 'on')

    assert ok is False
    assert 'Invalid mouse mode' in err
    assert channel.command is None


def test_control_command_bounds_channel_open_with_timeout():
    # A half-open TCP must not block the eventlet worker at open_session: the
    # helper passes an explicit timeout so the open is bounded like the exit-wait.
    session_id, _channel, transport = install_tmux_session()

    ok, err = ssh_manager._run_tmux_control_command(session_id, 'set-option', ['mouse', 'on'])

    assert ok is True
    assert transport.open_timeout is not None


# ---- set_tmux_mode_keys ---------------------------------------------------

def test_set_mode_keys_emacs():
    session_id, channel, _ = install_tmux_session(tmux_name='sshdeck_alice_host_22_abcd1234')

    ok, err = ssh_manager.set_tmux_mode_keys(session_id, 'emacs')

    assert ok is True
    assert err is None
    # Window-scoped (-w) option pinned on the exact session (-t <name>). The
    # helper hardcodes -t <session> right after the subcommand, then appends the
    # extra args, so the flag order is: set-option -t <name> -w mode-keys emacs.
    assert channel.command == (
        "tmux set-option -t sshdeck_alice_host_22_abcd1234 -w mode-keys emacs"
    )
    # Session/window-scoped only: never a global (-g) or server (-s) option, so
    # the shared server's global mode-keys and other tools' sessions are untouched.
    assert ' -g ' not in channel.command
    assert ' -s ' not in channel.command


def test_set_mode_keys_defaults_to_emacs():
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mode_keys(session_id)

    assert ok is True
    assert channel.command.endswith('-w mode-keys emacs')


def test_set_mode_keys_allows_vi():
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mode_keys(session_id, 'vi')

    assert ok is True
    assert channel.command.endswith('-w mode-keys vi')


def test_set_mode_keys_rejects_unknown_mode():
    # Anything other than the two tmux key tables must be rejected before any
    # tmux command runs, so this option can only ever be emacs/vi.
    session_id, channel, _ = install_tmux_session()

    ok, err = ssh_manager.set_tmux_mode_keys(session_id, 'dvorak')

    assert ok is False
    assert 'Invalid mode-keys' in err
    assert channel.command is None


# ---- capture-output primitive & exact target ------------------------------

class FakeCaptureChannel:
    """Exec channel that streams a bounded stdout payload for capture_output.

    exit_status_ready() is True immediately, so _exec_tmux_control skips its
    wait loop and reads stdout via the final drain: recv() yields the payload
    once, then b'' (EOF), and recv_ready() flips to False so the drain stops.
    """

    def __init__(self, exit_status=0, output=b'', exec_error=None):
        self.exit_status = exit_status
        self.output = output
        self.exec_error = exec_error
        self.command = None
        self.timeout = None
        self.closed = False
        self._drained = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def exec_command(self, command):
        self.command = command
        if self.exec_error:
            raise self.exec_error

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
        self.closed = True


class FakePTYChannel:
    """Stand-in for the session's interactive PTY channel (session['channel'])."""

    def __init__(self, send_error=None):
        self.sent = []
        self.send_error = send_error

    def send(self, data):
        if self.send_error:
            raise self.send_error
        self.sent.append(data)
        return len(data)


class SequenceTransport:
    """Transport that hands out a pre-built channel per open_session() call.

    exit_tmux_copy_mode opens ONE channel per control command, in this order:

        pane_in_mode query          (always)
        list-clients -F client_tty  (only when the pane really is in a mode)
        send-keys -K Escape         (one per attached client tty)
        copy-mode -q                (unless an earlier step failed)

    so tests supply the channels in that order and assert on each independently.
    S30-C added the middle two: the escape used to be a byte written to the
    session's interactive PTY, which is the defect these tests now guard against.
    """

    def __init__(self, channels, active=True):
        self._channels = list(channels)
        self._active = active
        self.opened = 0
        self.open_timeout = None

    def is_active(self):
        return self._active

    def open_session(self, timeout=None):
        self.open_timeout = timeout
        channel = self._channels[self.opened]
        self.opened += 1
        return channel


class ExitChannels:
    """The channels one exit_tmux_copy_mode call opens, named by their command.

    A tuple return stopped being readable once the sequence grew from two
    commands to four, and a positional unpack is exactly how a test starts
    asserting on the wrong channel.
    """

    def __init__(self, session_id, query, clients, sendkeys, copy, pty, transport):
        self.session_id = session_id
        self.query = query          # display-message -p '#{pane_in_mode}'
        self.clients = clients      # list-clients -F '#{client_tty}'
        self.sendkeys = sendkeys    # one per tty: send-keys -t <tty> -K Escape
        self.copy = copy            # copy-mode -q
        self.pty = pty              # the interactive channel; must stay UNUSED
        self.transport = transport


def install_exit_session(session_id='sess-exit',
                         tmux_name='sshdeck_alice_host_22_abcd1234',
                         query_output=b'1', query_exit=0, query_error=None,
                         tty_output=b'/dev/pts/7\n', tty_exit=0,
                         sendkeys_exit=0,
                         copy_exit=0, with_channel=True,
                         active=True, use_tmux=True, connected=True):
    query_channel = FakeCaptureChannel(exit_status=query_exit,
                                       output=query_output, exec_error=query_error)
    clients_channel = FakeCaptureChannel(exit_status=tty_exit, output=tty_output)
    ttys = [line for line in tty_output.decode().splitlines() if line.strip()]
    sendkeys_channels = [FakeCaptureChannel(exit_status=sendkeys_exit, output=b'')
                         for _ in ttys]
    copy_channel = FakeCaptureChannel(exit_status=copy_exit, output=b'')
    # Only an in-mode pane reaches the escape steps, so the channel sequence a
    # test must supply depends on the query answer. Building it from the same
    # condition the product branches on keeps the fixture honest.
    reaches_escape = (query_error is None and query_exit == 0
                      and query_output.strip() == b'1')
    if reaches_escape:
        channels = ([query_channel, clients_channel]
                    + sendkeys_channels + [copy_channel])
    else:
        channels = [query_channel, copy_channel]
    transport = SequenceTransport(channels, active=active)
    client = FakeControlClient(transport)
    pty = FakePTYChannel() if with_channel else None
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': client,
            'connected': connected,
            'use_tmux': use_tmux,
            'tmux_session_name': tmux_name,
            'channel': pty,
        }
    return ExitChannels(session_id, query_channel, clients_channel,
                        sendkeys_channels, copy_channel, pty, transport)


def test_exec_control_captures_stdout():
    # capture_output=True returns the (decoded, cap-bounded) stdout as the third
    # element so exit_tmux_copy_mode can read #{pane_in_mode}.
    session_id, _, _ = install_tmux_session()
    session = ssh_manager.sessions[session_id]
    # Replace the plain channel with a capture channel that streams '1'.
    cap = FakeCaptureChannel(output=b'1\n')
    session['client']._transport._channel = cap

    ok, err, out = ssh_manager._exec_tmux_control(
        session_id, 'display-message', ['-p', '#{pane_in_mode}'],
        exact_target=True, capture_output=True)

    assert ok is True and err is None
    assert out.strip() == '1'
    assert cap.closed is True


def test_exec_control_rejects_oversized_output():
    # More than _TMUX_CONTROL_MAX_OUTPUT bytes is a hard error, never a silent
    # truncation — a hijacked remote cannot stream unbounded data into the worker.
    session_id, _, _ = install_tmux_session()
    session = ssh_manager.sessions[session_id]
    flood = b'x' * (ssh_manager._TMUX_CONTROL_MAX_OUTPUT + 8)
    session['client']._transport._channel = FakeCaptureChannel(output=flood)

    ok, err, out = ssh_manager._exec_tmux_control(
        session_id, 'display-message', ['-p', '#{pane_in_mode}'],
        exact_target=True, capture_output=True)

    assert ok is False
    assert 'too much output' in err
    assert out == ''


# ---- exit_tmux_copy_mode --------------------------------------------------

def test_exit_copy_mode_in_mode_keys_the_clients_then_clears():
    # pane_in_mode == '1': deliver Escape as a KEY to this session's attached
    # clients over the control channel, then run the idempotent `copy-mode -q`.
    #
    # S30-C REPLACED A PTY WRITE, AND THIS IS THE BITING ROW. This test used to
    # assert `pty.sent == ['\x1b']`, i.e. it PINNED the Owner's defect: a bare
    # ESC on the interactive channel is coalesced by tmux's escape-time with the
    # user's very next bytes and forwarded as a META sequence, so readline ate
    # the write's leading character ('echo LANDS' -> 'cho LANDS') and erased a
    # whole word per erase press ('echo tiến' -> 'echo '). Measured on a scratch
    # server with a real attached client: /tmp/s26reg/s30_p10.log (arms D/E),
    # /tmp/s26reg/s30_p11.log (arms G1/H/H2), and reproduced on the deployment
    # in /tmp/s26reg/s30_p7b.log.
    fx = install_exit_session(query_output=b'1')

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is True and err is None
    # The pane really was in a mode, so the UI may say it left scroll mode.
    assert was_in_mode is True
    # The query targets the exact pane =<session>:. shlex.quote leaves the
    # metacharacter-free target bare, but the tmux format string is quoted so
    # its #{...} can never be reinterpreted by the shell.
    assert fx.query.command == (
        "tmux display-message -t =sshdeck_alice_host_22_abcd1234: "
        "-p '#{pane_in_mode}'"
    )
    # THE CLIENTS ARE DERIVED FROM THIS SESSION'S OWN NAME, never from user
    # input, so another tool's client on a shared host cannot be addressed.
    assert fx.clients.command == (
        "tmux list-clients -t =sshdeck_alice_host_22_abcd1234: "
        "-F '#{client_tty}'"
    )
    # NOT ONE BYTE reached the interactive PTY. This is the assertion the fix
    # exists for: reinstate the PTY write and this row goes red.
    assert fx.pty.sent == []
    # The escape is a KEY, delivered to the client tty tmux itself reported.
    assert [c.command for c in fx.sendkeys] == [
        "tmux send-keys -t /dev/pts/7 -K Escape"
    ]
    # copy-mode -q also targets the exact pane, session-scoped, no -g/-s.
    assert fx.copy.command == (
        "tmux copy-mode -t =sshdeck_alice_host_22_abcd1234: -q"
    )
    for command in (fx.query.command, fx.clients.command,
                    fx.sendkeys[0].command, fx.copy.command):
        assert ' -g ' not in command and ' -s ' not in command
    # query + list-clients + one send-keys + copy-mode.
    assert fx.transport.opened == 4
    assert fx.query.closed is True and fx.clients.closed is True
    assert fx.sendkeys[0].closed is True and fx.copy.closed is True


def test_exit_copy_mode_keys_every_attached_client():
    # The Owner's own shape is phone AND desktop on one session, so the escape
    # must reach EVERY attached client: a prompt open on the client that was not
    # keyed would still swallow that client's next write. One send-keys per tty,
    # each targeting the tty tmux reported, and still no PTY byte anywhere.
    fx = install_exit_session(query_output=b'1',
                              tty_output=b'/dev/pts/7\n/dev/pts/9\n')

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is True and err is None and was_in_mode is True
    assert [c.command for c in fx.sendkeys] == [
        "tmux send-keys -t /dev/pts/7 -K Escape",
        "tmux send-keys -t /dev/pts/9 -K Escape",
    ]
    assert fx.pty.sent == []
    # query + list-clients + two send-keys + copy-mode.
    assert fx.transport.opened == 5
    assert fx.copy.command is not None


def test_exit_copy_mode_detached_session_has_nobody_to_key():
    # A persistent session with no attached client is the ORDINARY state, not a
    # failure: tmux still holds the pane, so the pane-side `copy-mode -q` must
    # still run and the call must still succeed. Nothing is sent, because there
    # is no client key handling to send to.
    fx = install_exit_session(query_output=b'1', tty_output=b'')

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is True and err is None
    assert was_in_mode is True
    assert fx.sendkeys == []            # no client, so no key was delivered
    assert fx.pty.sent == []
    assert fx.copy.command is not None  # the pane mode is still cleared
    # query + list-clients + copy-mode; no send-keys channel was opened.
    assert fx.transport.opened == 3


def test_exit_copy_mode_no_longer_needs_the_interactive_channel():
    # Before S30-C this path REQUIRED session['channel'] and failed with "No
    # channel for session" without it, because the escape was a byte written
    # there. The escape is now a control command, so a session whose interactive
    # channel is missing still leaves copy mode correctly. This also pins that
    # the PTY is not merely unused by accident -- it is not needed at all.
    fx = install_exit_session(query_output=b'1', with_channel=False)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is True and err is None
    assert was_in_mode is True
    assert fx.pty is None
    assert [c.command for c in fx.sendkeys] == [
        "tmux send-keys -t /dev/pts/7 -K Escape"
    ]


def test_no_bare_escape_is_written_to_any_session_channel():
    # THE STRUCTURAL GUARD. The behavioural rows above assert on a fake channel,
    # so a second, differently-spelled PTY escape somewhere else in the module
    # would not disturb them. The defect was a bare ESC on the interactive
    # channel, so the module must contain no such write at all.
    import re
    from pathlib import Path
    source = Path(ssh_manager.__file__).read_text(encoding='utf-8')

    # ANY spelling, not one literal. Measured: a mutant written as
    # `_mut['channel'].send('\x1b')` slipped past an exact-string check while
    # the behavioural rows caught it, so this row was strengthened to match the
    # SEND ITSELF -- any receiver, either quote style, optional spacing.
    escape_writes = re.findall(r"\.send\(\s*['\"]\\x1b['\"]\s*\)", source)
    assert escape_writes == [], (
        f'a bare ESC is written to a channel again: {escape_writes}')
    # And the helper that used to do it is gone rather than left dead.
    assert '_send_escape_to_session_channel' not in source
    # The replacement is present and reached from the copy-mode exit.
    assert '_send_escape_to_session_clients' in source


def test_exit_copy_mode_not_in_mode_never_sends_escape():
    # pane_in_mode == '0': there is nothing to dismiss, so no escape is sent at
    # all -- not to the clients and (as always now) not to the PTY. The
    # idempotent copy-mode -q still runs.
    fx = install_exit_session(query_output=b'0')

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is True and err is None
    # Success, but there was nothing to leave: the UI must say "not in scroll
    # mode" rather than claiming it exited one.
    assert was_in_mode is False
    assert fx.pty.sent == []               # no Escape leaked into the shell
    assert fx.clients.command is None      # the clients were never even listed
    assert all(c.command is None for c in fx.sendkeys)
    assert fx.copy.command is not None     # copy-mode -q still ran
    assert fx.transport.opened == 2


def test_exit_copy_mode_rejects_unexpected_pane_state():
    # Any output that is neither '0' nor '1' is a real error: send no escape and
    # do not run copy-mode blindly.
    fx = install_exit_session(query_output=b'banana')

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'Unexpected tmux state' in err
    assert was_in_mode is False       # never guessed from a bad reading
    assert fx.pty.sent == []
    assert fx.clients.command is None
    assert fx.copy.command is None    # copy-mode never ran
    assert fx.transport.opened == 1   # only the query channel opened


def test_exit_copy_mode_query_failure_is_a_real_error():
    # A failed pane_in_mode query is surfaced, not swallowed; nothing else runs.
    fx = install_exit_session(query_exit=1)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'status 1' in err
    assert fx.pty.sent == []
    assert fx.clients.command is None
    assert fx.copy.command is None


def test_exit_copy_mode_client_listing_failure_is_a_real_error():
    # The escape is now two commands, so it has two failure modes and both must
    # abort rather than report a partial success. First: the client listing.
    fx = install_exit_session(query_output=b'1', tty_exit=1)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'status 1' in err
    assert was_in_mode is True        # the query DID read a real mode
    assert all(c.command is None for c in fx.sendkeys)
    assert fx.copy.command is None
    assert fx.pty.sent == []


def test_exit_copy_mode_key_delivery_failure_is_a_real_error():
    # Second failure mode: the key itself. A refused send-keys is surfaced and
    # copy-mode -q does NOT run, exactly as a failed PTY write used to abort.
    fx = install_exit_session(query_output=b'1', sendkeys_exit=1)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'status 1' in err
    assert was_in_mode is True
    assert fx.sendkeys[0].command == "tmux send-keys -t /dev/pts/7 -K Escape"
    assert fx.copy.command is None
    assert fx.pty.sent == []


def test_exit_copy_mode_copy_mode_failure_is_a_real_error():
    # A non-zero `copy-mode -q` after a successful escape is still a real
    # failure. The escape DID go out first -- as a key to the client, and still
    # not as a byte on the PTY.
    fx = install_exit_session(query_output=b'1', copy_exit=1)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'status 1' in err
    assert fx.sendkeys[0].command == "tmux send-keys -t /dev/pts/7 -K Escape"
    assert fx.pty.sent == []


def test_exit_copy_mode_rejects_non_tmux_session():
    fx = install_exit_session(use_tmux=False)

    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode(fx.session_id)

    assert ok is False
    assert 'not a tmux session' in err
    assert fx.pty.sent == []
    assert fx.clients.command is None


def test_exit_copy_mode_rejects_unknown_session():
    ok, err, was_in_mode = ssh_manager.exit_tmux_copy_mode('missing')

    assert ok is False
    assert err == 'Session not found'
    assert was_in_mode is False


def test_exit_copy_mode_serializes_concurrent_requests():
    # Two concurrent exit requests on one session must not interleave their
    # query -> ESC -> copy-mode sequence: the per-session control lock serializes
    # them, so no two tmux exec commands ever run at the same time. Without the
    # lock, both threads' pane_in_mode queries would overlap and the second could
    # act on state the first is still changing (double ESC into the shell).
    session_id = 'sess-concurrent'
    state = {'now': 0, 'max': 0}
    counter_lock = threading.Lock()

    class TrackingChannel:
        def __init__(self):
            self.closed = False
        def settimeout(self, timeout):
            pass
        def exec_command(self, command):
            with counter_lock:
                state['now'] += 1
                state['max'] = max(state['max'], state['now'])
            time.sleep(0.02)
            with counter_lock:
                state['now'] -= 1
        def recv_ready(self):
            return False
        def recv(self, n):
            return b'1'
        def exit_status_ready(self):
            return True
        def recv_exit_status(self):
            return 0
        def close(self):
            self.closed = True

    class FactoryTransport:
        def __init__(self):
            self.open_timeout = None
        def is_active(self):
            return True
        def open_session(self, timeout=None):
            self.open_timeout = timeout
            return TrackingChannel()

    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': FakeControlClient(FactoryTransport()),
            'connected': True,
            'use_tmux': True,
            'tmux_session_name': 'sshdeck_alice_host_22_abcd1234',
            'channel': FakePTYChannel(),
        }

    results = []
    def worker():
        results.append(ssh_manager.exit_tmux_copy_mode(session_id))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert all(ok is True for ok, _err, _was_in_mode in results)
    # The lock held across the whole sequence means exec commands never overlap.
    assert state['max'] == 1


def test_control_lock_lives_on_the_session_and_is_reused():
    # The lock is stored on the session dict, not in a module-level registry, so
    # it is created with the session and dropped with it — no separate lifetime
    # to manage and no cleanup hook inside close_session.
    session_id = 'sess-lock-owned'
    install_tmux_session(session_id=session_id)

    lock = ssh_manager._get_tmux_control_lock(session_id)
    assert lock is not None
    with ssh_manager.sessions_lock:
        assert ssh_manager.sessions[session_id]['tmux_control_lock'] is lock
    # A second call must hand back the SAME lock, otherwise two concurrent
    # requests would each take their own lock and serialize nothing.
    assert ssh_manager._get_tmux_control_lock(session_id) is lock


def test_control_lock_is_none_for_unknown_session():
    # A vanished session has no lock to take; the caller must get None rather
    # than a fresh lock that guards nothing (or a KeyError).
    assert ssh_manager._get_tmux_control_lock('missing') is None


def test_close_session_drops_control_lock_with_the_session():
    # Closing the session removes the whole session dict, so the lock goes with
    # it and the registry cannot grow for the process lifetime.
    session_id = 'sess-lock-cleanup'
    install_tmux_session(session_id=session_id)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id]['channel'] = None
    assert ssh_manager._get_tmux_control_lock(session_id) is not None

    ssh_manager.close_session(session_id)

    assert session_id not in ssh_manager.sessions
    assert ssh_manager._get_tmux_control_lock(session_id) is None
