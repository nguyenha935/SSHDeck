"""S16 B4 — TMUX HISTORY INJECTION. The Owner must be able to scroll back.

THE DEFECT, measured on the deployed build and confirmed in review:
with tmux driving the pane, 400 echoed lines leave the client holding exactly
one viewport (bufferLength 47, nonEmpty 47, scrollbackCapacity 5000 unused) —
BEFORE any reload. tmux repaints its window with absolute cursor addressing
(`ESC[H` + one `ESC[K\r\n` per row) and keeps history in ITS OWN buffer, and
cursor-addressed painting never scrolls anything off xterm's top. So xterm's
scrollback cannot fill BY CONSTRUCTION. The history is not lost — it is in tmux,
and the client had no way to see it.

The replay path never asked for it. `output_buffer` is appended to only from
live `channel.recv` (read_ssh_output), `build_replay_chunks` joins exactly that
buffer, and the only `capture-pane` in the server was the composer's one-row
truth read. Reasoning and the rejected alternatives (copy-mode forwarding;
disabling tmux's alternate screen) are in /tmp/s16work/b4_history_architecture.txt.

WHAT THIS PINS

  §H1-H2   the history read is `capture-pane -p -J -S -<N> -E -1`, exact-target,
           N = min(history_size, max_lines). `-E -1` ends ABOVE the visible
           window, so history and the current screen are disjoint and no line is
           delivered twice (verified against a live pane).
  §H3      no history is NOT an error and runs no capture at all.
  §H4-H5   NEITHER the alternate screen NOR copy mode is a blanket refusal.
           Copy mode was re-pointed by S17 FIX 4a and the alternate screen by
           S35 P27, for the SAME reason: both flags describe what the pane is
           DISPLAYING, not what the history buffer holds, and `-E -1` excludes
           the displayed window by construction. What still fails closed on the
           alternate screen is an EMPTY read -- no history_size, or a capture
           that normalises to nothing -- because then there is no shell
           transcript to deliver and an empty success would retire the restore
           path's one production warning.
  §H6      the injected stream is CRLF-terminated — a LINE STREAM is the whole
           mechanism, because only a line that scrolls off the top enters
           xterm's scrollback.
  §H7      the injected stream carries NO control bytes. Not "only SGR" — none.
           That property is what makes this option safe next to the D4-R
           boundary, and it is asserted rather than hoped for.
  §H8-H9   both budgets keep the NEWEST history, like every other replay bound.
  §H10-H12 every failure is returned, never raised, and an oversize history is
           retried once smaller rather than abandoning history entirely.
  §H13-H15 history is delivered BEFORE the gap buffer in ONE contiguous
           sequence, and a history failure still delivers the gap buffer —
           history is an ENRICHMENT, never a precondition for a restore.
  §H16-H19 the wire contract on the paths the Owner named. RE-POINTED
: history now rides the ATTACH (`view_attach`, one tmux
           client per socket), and the RESTORE event carries no replay for a
           tmux session at all. On a second device the old shared gap buffer
           would have replayed bytes that device had already been shown, so
           delivering history per attach is what makes it correct rather than
           merely simpler. A non-tmux connect is unchanged.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import ssh_manager


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


class FakeChannel:
    """One short-lived exec channel that streams a bounded stdout payload.

    Mirrors tests/test_tmux_control.py's FakeCaptureChannel: exit_status_ready()
    is True at once, so _exec_tmux_control skips its wait loop and reads stdout
    through the final drain.
    """

    def __init__(self, output=b'', exit_status=0, exec_error=None):
        self.output = output
        self.exit_status = exit_status
        self.exec_error = exec_error
        self.command = None
        self.closed = False
        self._sent = 0

    def settimeout(self, timeout):
        self.timeout = timeout

    def exec_command(self, command):
        self.command = command
        if self.exec_error:
            raise self.exec_error

    def recv_ready(self):
        return self._sent < len(self.output)

    def recv(self, n):
        if self._sent >= len(self.output):
            return b''
        chunk = self.output[self._sent:self._sent + n]
        self._sent += len(chunk)
        return chunk

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.exit_status

    def close(self):
        self.closed = True


class SequenceTransport:
    def __init__(self, channels, active=True):
        self._channels = list(channels)
        self._active = active
        self.opened = 0

    def is_active(self):
        return self._active

    def open_session(self, timeout=None):
        channel = self._channels[self.opened]
        self.opened += 1
        return channel


class FakeClient:
    def __init__(self, transport):
        self._transport = transport

    def get_transport(self):
        return self._transport


def _install(channels, session_id='sess-hx', use_tmux=True, connected=True,
             tmux_name='sshdeck_alice_host_22_abcd1234'):
    transport = SequenceTransport(channels)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': FakeClient(transport),
            'connected': connected,
            'use_tmux': use_tmux,
            'tmux_session_name': tmux_name,
        }
    return session_id, transport


def _state(in_mode=0, alternate_on=0, history_size=0):
    return f'{in_mode},{alternate_on},{history_size}\n'.encode()


def _history(lines):
    return ('\n'.join(lines) + '\n').encode()


# ---- §H1-H2 the read itself ------------------------------------------------

def test_history_read_asks_tmux_for_the_history_region_only():
    # §H1. `-S -<N>` reaches N lines back and `-E -1` stops on the line ABOVE the
    # visible window, so the history and the current screen are disjoint: the
    # screen is painted by tmux's own repaint, and a line delivered twice would
    # show the user a duplicated transcript.
    state = FakeChannel(output=_state(history_size=356))
    cap = FakeChannel(output=_history([f'HX-{i}' for i in range(1, 357)]))
    session_id, _ = _install([state, cap])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True and error is None
    # shlex.quote leaves plain tokens unquoted, so assert on the argv tokens
    # rather than on quoted spelling: what matters is the exact flags and values.
    argv = cap.command.split()
    assert argv[:3] == ['tmux', 'capture-pane', '-t']
    assert '-J' in argv
    assert argv[argv.index('-S') + 1] == '-356'
    assert argv[argv.index('-E') + 1] == '-1'
    # -e is deliberately absent: see §H7.
    assert '-e' not in argv
    assert text.count('HX-1\r\n') == 1


def test_history_read_is_scoped_to_this_session_exactly():
    # §H2. Same boundary every other control helper respects: the exact-target
    # form, built from the STORED session name, so the read can never reach
    # another tool's tmux session on the same host/account.
    state = FakeChannel(output=_state(history_size=10))
    cap = FakeChannel(output=_history([f'HX-{i}' for i in range(10)]))
    session_id, _ = _install([state, cap], tmux_name='sshdeck_alice_host_22_abcd1234')

    ok, _error, _text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    argv = cap.command.split()
    assert argv[argv.index('-t') + 1] == '=sshdeck_alice_host_22_abcd1234:'
    assert '-g' not in argv and '-s' not in argv



def test_history_bounded_by_the_line_budget_not_by_history_size():
    # §H2b. N = min(history_size, max_lines). tmux's history_limit is the user's
    # own tmux setting and must not be changed, so the SERVER's budget is what
    # bounds the read.
    state = FakeChannel(output=_state(history_size=100000))
    cap = FakeChannel(output=_history(['HX'] * 10))
    session_id, _ = _install([state, cap])

    ok, _error, _text = ssh_manager.read_tmux_history(session_id, max_lines=500)

    assert ok is True
    assert '-500' in cap.command


# ---- §H3-H5 when NOT to read ------------------------------------------------

def test_empty_history_runs_no_capture_and_is_not_an_error():
    # §H3. A brand-new pane has nothing above the screen. "No history" is a
    # normal answer, and the capture must not run at all -- an exec channel per
    # attach is a real cost and a `-S -0` read would hand back the screen.
    state = FakeChannel(output=_state(history_size=0))
    session_id, transport = _install([state])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True and error is None
    assert text == ''
    assert transport.opened == 1


def test_alternate_screen_replays_real_shell_history():
    # §H4, RE-POINTED by S35 P27. This row previously asserted that the alternate
    # screen fails closed unconditionally. That specification was wrong FOR THIS
    # READER and it caused the Owner's "history gone after a reload": 6 refusals
    # in production logs across 2 sessions.
    #
    # The old reasoning ("what tmux would return is that application's screen")
    # confused the WINDOW with the BUFFER, exactly as the copy-mode row did before
    # S17 FIX 4a. The capture is `-S -<N> -E -1`: `-E -1` ends on the line ABOVE
    # the visible window, so the alternate GRID -- which IS that window -- is
    # excluded by construction. Measured on tmux 3.4 against a real pane
    # (/tmp/s35/p27_alt_screen_history_guard.py, leg G): with `less` owning the
    # pane, `capture-pane -p -J -S -163 -E -1` returned 163 lines of genuine
    # pre-TUI SHELL transcript and ZERO alt-grid content, and `history_size` was
    # preserved for the TUI's whole lifetime. The alt grid was reachable only at
    # `-S 0`.
    #
    # So the history a reload needs is the SHELL's, it is intact while a TUI is
    # up, and refusing it discarded readable data. Nothing is loosened: the two
    # rows below pin the empty cases, and the seed keeps its own refusal.
    state = FakeChannel(output=_state(alternate_on=1, history_size=400))
    capture = FakeChannel(output=_history(['shell-line-1', 'shell-line-2']))
    session_id, transport = _install([state, capture])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    assert error is None
    assert 'shell-line-1' in text and 'shell-line-2' in text
    # The capture really ran: the refusal used to short-circuit before it.
    assert transport.opened == 2
    assert '-E' in capture.command and '-1' in capture.command


def test_alternate_screen_with_an_empty_capture_still_fails_closed():
    # SAFETY, kept separate from the row above. A capture that normalises to
    # nothing means there is no shell transcript above the TUI's grid, so this
    # stays a refusal rather than an empty success -- the restore path's single
    # WARNING for this state must still fire.
    state = FakeChannel(output=_state(alternate_on=1, history_size=400))
    capture = FakeChannel(output=b'')
    session_id, transport = _install([state, capture])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is False
    assert text == ''
    assert 'alternate' in error.lower()


def test_alternate_screen_with_no_history_still_fails_closed():
    # SAFETY. history_size == 0 with a full-screen program in the window: there
    # is nothing above the grid at all, no capture runs, and the refusal stands.
    state = FakeChannel(output=_state(alternate_on=1, history_size=0))
    session_id, transport = _install([state])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is False
    assert text == ''
    assert 'alternate' in error.lower()
    assert transport.opened == 1


def test_copy_mode_still_reads_history():
    # §H5, RE-POINTED by S17 FIX 4a. This row previously asserted that copy mode
    # fails closed. That specification was wrong and it caused the Owner's R6b:
    # tmux `mouse on` is the product default (socket_events.py:309), so ONE
    # upward swipe puts the pane into copy mode -- making the gesture that
    # produces history to read the same gesture that suppressed reading it.
    # Measured on one build: no prior gesture delivered 314 rows, one swipe
    # delivered none.
    #
    # The old reasoning ("the visible region is scroll content") confused the
    # OVERLAY with the BUFFER. `pane_in_mode` reports that a scroll overlay is
    # being displayed; it says nothing about what tmux holds. The capture is
    # bounded by `history_size` and ends at `-E -1`, both properties of the
    # history buffer, so the same disjoint history/screen boundary §H1 pins still
    # holds in copy mode -- the data was readable and the refusal discarded it.
    # ssh_manager.py:3095-3097 is the proof: history_size is read from the same
    # answer and is non-zero here.
    #
    # Nothing is loosened: the alternate screen still fails closed (§H4), and
    # this row now asserts the STRONGER property that the read actually happens
    # and returns the history.
    state = FakeChannel(output=_state(in_mode=1, history_size=400))
    cap = FakeChannel(output=_history([f'HX-{i}' for i in range(1, 401)]))
    session_id, transport = _install([state, cap])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True and error is None
    # The capture really ran -- a second exec channel, not a refusal that never
    # opened one. This is what the old assertion (opened == 1) was hiding.
    assert transport.opened == 2
    argv = cap.command.split()
    assert argv[:3] == ['tmux', 'capture-pane', '-t']
    assert argv[argv.index('-E') + 1] == '-1'
    assert text.count('HX-1\r\n') == 1
    assert text.count('HX-400\r\n') == 1


# ---- §H6-H7 the SHAPE of what is injected ----------------------------------

def test_injected_history_is_a_crlf_line_stream():
    # §H6. THE MECHANISM. xterm's scrollback is fed only by lines that scroll off
    # the top, and only a newline-terminated stream scrolls. tmux's capture is
    # LF-separated; a bare LF on a terminal moves down without returning to
    # column 0, so every line would stair-step. CRLF is what makes the transcript
    # both scroll and align.
    state = FakeChannel(output=_state(history_size=3))
    cap = FakeChannel(output=_history(['first', 'second', 'third']))
    session_id, _ = _install([state, cap])

    ok, _error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    assert text == 'first\r\nsecond\r\nthird\r\n'
    assert '\n' not in text.replace('\r\n', '')


def test_injected_history_contains_no_control_bytes_at_all():
    # §H7. Not "only SGR" -- NONE. This is the property that makes server-side
    # injection safe beside the D4-R boundary: a stream with no escape bytes
    # cannot switch screens, cannot erase, and gives the replay cleaner nothing
    # to do. It is why the read uses `-p` and not `-p -e`. A tmux that returned
    # escapes anyway (an option change, a future version) must be neutralised
    # here rather than trusted.
    state = FakeChannel(output=_state(history_size=2))
    cap = FakeChannel(output=b'\x1b[1;32mgreen\x1b[m\n\x1b[?1049hplain\n')
    session_id, _ = _install([state, cap])

    ok, _error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    assert '\x1b' not in text
    assert '[1;32m' not in text and '[?1049h' not in text
    assert 'green' in text and 'plain' in text


def test_control_bytes_other_than_tab_are_removed():
    # §H7b. Tabs are legitimate transcript content and are kept; BS, CR inside a
    # line, VT and BEL are not, and a lone CR would overwrite the line the user
    # is trying to read.
    state = FakeChannel(output=_state(history_size=1))
    cap = FakeChannel(output=b'col1\tcol2\x08\x0b\x07 end\rOVER\n')
    session_id, _ = _install([state, cap])

    ok, _error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    assert '\t' in text
    for byte in ('\x08', '\x0b', '\x07'):
        assert byte not in text
    assert text.endswith('\r\n')
    assert text.count('\r') == 1


# ---- §H8-H9 budgets --------------------------------------------------------

def test_line_budget_keeps_the_newest_history():
    # §H8. Same rule as every other replay bound: when the budget bites, the
    # NEWEST output survives. The lines nearest the current screen are the ones
    # the user is scrolling back toward.
    state = FakeChannel(output=_state(history_size=10))
    cap = FakeChannel(output=_history([f'HX-{i}' for i in range(1, 11)]))
    session_id, _ = _install([state, cap])

    ok, _error, text = ssh_manager.read_tmux_history(
        session_id, max_lines=4)

    assert ok is True
    lines = [ln for ln in text.split('\r\n') if ln]
    assert lines == ['HX-7', 'HX-8', 'HX-9', 'HX-10']


def test_byte_budget_keeps_the_newest_history_on_whole_lines():
    # §H9. The byte trim cuts on a LINE boundary, never mid-line: a half line at
    # the top of the scrollback is indistinguishable to the user from corrupted
    # output.
    state = FakeChannel(output=_state(history_size=5))
    cap = FakeChannel(output=_history(['aaaaaaaaaa'] * 4 + ['newest']))
    session_id, _ = _install([state, cap])

    ok, _error, text = ssh_manager.read_tmux_history(
        session_id, max_bytes=30)

    assert ok is True
    assert len(text) <= 30
    assert text.endswith('newest\r\n')
    for line in [ln for ln in text.split('\r\n') if ln]:
        assert line in ('aaaaaaaaaa', 'newest')


# ---- §H10-H12 failures are returned, never raised --------------------------

def test_non_tmux_session_is_a_returned_refusal():
    # §H10. A plain SSH session has no tmux to ask. Returned, not raised: a
    # restore must never fail because history was unavailable.
    session_id, _ = _install([FakeChannel()], use_tmux=False)

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is False and text == ''
    assert 'tmux' in error.lower()


def test_unknown_session_is_a_returned_refusal():
    # §H10b.
    ok, error, text = ssh_manager.read_tmux_history('no-such-session')

    assert ok is False and text == ''
    assert error


def test_capture_failure_is_returned_not_raised():
    # §H11. A dead transport, a tmux that exits non-zero, a pane that vanished
    # between the two commands -- every one of them is "no history available",
    # and the caller delivers the gap buffer as it does today.
    state = FakeChannel(output=_state(history_size=50))
    cap = FakeChannel(output=b'', exit_status=1)
    session_id, _ = _install([state, cap])

    ok, error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is False and text == ''
    assert error


def test_oversize_history_is_retried_smaller_before_giving_up():
    # §H12. The output cap is a hard error by design (a hijacked remote must not
    # stream unbounded data into the worker), but a legitimately huge history is
    # the EXPECTED case for a long-lived session. So an oversize read is retried
    # once with a halved line budget rather than abandoning history entirely --
    # some history beats none, and the retry is bounded to one.
    state = FakeChannel(output=_state(history_size=5000))
    flood = FakeChannel(output=b'x' * (ssh_manager.HISTORY_MAX_BYTES + 4096))
    smaller = FakeChannel(output=_history([f'HX-{i}' for i in range(1, 21)]))
    session_id, transport = _install([state, flood, smaller])

    ok, _error, text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    assert 'HX-20' in text
    # exactly three channels: the state query, the oversize read, one retry.
    assert transport.opened == 3
    assert '-2500' in smaller.command


# ---- §H13-H15 build_replay_chunks composition -------------------------------

def _seed_buffer(session_id, elements, use_tmux=True):
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': object(),
            'channel': object(),
            'connected': True,
            'use_tmux': use_tmux,
            'tmux_session_name': 'sshdeck_replay',
            'output_buffer': list(elements),
            'output_buffer_size': sum(len(e) for e in elements),
            'output_buffer_max': 512000,
        }


def test_history_precedes_the_gap_buffer_in_one_sequence(monkeypatch):
    # §H13. Order is the whole point: history is OLDER than the gap buffer, so it
    # must be written first or the transcript reads backwards. One contiguous
    # sequence, not a second replay window -- the client's replay gate is opened
    # once per restore and a second window would race the first.
    _seed_buffer('sess-c', ['LIVE-TAIL\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (True, None, 'OLD-1\r\nOLD-2\r\n'))

    chunks, meta = ssh_manager.build_replay_chunks('sess-c')

    joined = ''.join(chunks)
    assert joined.index('OLD-1') < joined.index('LIVE-TAIL')
    assert meta['history_lines'] == 2
    assert meta['total_chunks'] == len(chunks)


def test_a_history_failure_still_delivers_the_gap_buffer(monkeypatch):
    # §H14. History is an ENRICHMENT, never a precondition. Before this change a
    # restore delivered the gap buffer and nothing else; it must still do exactly
    # that when tmux cannot be read.
    _seed_buffer('sess-f', ['LIVE-TAIL\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (False, 'Pane is on the alternate screen', ''))

    chunks, meta = ssh_manager.build_replay_chunks('sess-f')

    assert ''.join(chunks) == 'LIVE-TAIL\r\n'
    assert meta['history_lines'] == 0
    assert meta['truncated'] is False


def test_non_tmux_session_asks_for_no_history(monkeypatch):
    # §H15. A plain SSH session scrolls xterm directly -- its scrollback fills
    # the ordinary way and there is nothing to inject. No control channel is
    # opened for it.
    calls = []
    _seed_buffer('sess-plain', ['PLAIN\r\n'], use_tmux=False)

    def spy(*_a, **_k):
        calls.append(1)
        return (True, None, 'SHOULD-NOT-APPEAR\r\n')

    monkeypatch.setattr(ssh_manager, 'read_tmux_history', spy)

    chunks, meta = ssh_manager.build_replay_chunks('sess-plain')

    assert calls == []
    assert ''.join(chunks) == 'PLAIN\r\n'
    assert meta['history_lines'] == 0


def test_history_is_counted_in_the_line_budget_not_added_on_top(monkeypatch):
    # §H15b. The client sizes its scrollback from REPLAY_MAX_LINES, so the
    # combined stream must respect that same number. History plus gap buffer
    # exceeding it trims from the FRONT -- i.e. the oldest history -- exactly as
    # the existing bound does.
    _seed_buffer('sess-b', [''.join(f'TAIL-{i}\r\n' for i in range(1, 6))])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (True, None,
                           ''.join(f'OLD-{i}\r\n' for i in range(1, 11))))

    chunks, meta = ssh_manager.build_replay_chunks('sess-b', max_lines=6)

    joined = ''.join(chunks)
    lines = [ln for ln in joined.split('\r\n') if ln]
    assert joined.count('\n') <= 6
    # Line-exact, not substring: 'OLD-1' is a prefix of 'OLD-10', and the
    # surviving window legitimately contains the latter.
    assert lines == ['OLD-10', 'TAIL-1', 'TAIL-2', 'TAIL-3', 'TAIL-4', 'TAIL-5']
    assert meta['truncated'] is True
    # The history that survived the trim is reported, not the history that was
    # read: nine of the ten OLD lines were dropped from the front.
    assert meta['history_lines'] == 1



def test_no_line_is_delivered_twice_across_the_history_screen_boundary():
    # §H20. NOT by inspection -- asserted on the delivered bytes.
    #
    # The history read ends at `-E -1` and tmux's own repaint draws the visible
    # screen, so the two must be DISJOINT. Modelled the way a real pane is: a
    # 2000-line pane whose last 47 rows are the visible window, where
    # `capture-pane -S -<N> -E -1` returns rows 1..(N) ending immediately above
    # row 1954. If `-E -1` were dropped (or made `-E -0`), tmux would include the
    # visible rows and every one of them would arrive twice -- once as replayed
    # scrollback and once from the repaint the user is looking at.
    pane = [f'ROW-{i}' for i in range(1, 2001)]
    visible = pane[-47:]
    above_screen = pane[:-47]

    state = FakeChannel(output=_state(history_size=len(above_screen)))
    cap = FakeChannel(output=_history(above_screen))
    session_id, _ = _install([state, cap])

    ok, _error, history = ssh_manager.read_tmux_history(session_id)
    assert ok is True

    delivered = [ln for ln in history.split('\r\n') if ln]
    # 1. the history stops exactly above the visible window
    assert delivered[-1] == 'ROW-1953'
    assert visible[0] == 'ROW-1954'
    # 2. nothing the repaint will draw is inside the delivered stream
    assert set(delivered).isdisjoint(set(visible))
    # 3. and the delivered stream contains no line twice on its own
    assert len(delivered) == len(set(delivered))


def test_a_dropped_end_bound_would_deliver_the_screen_twice(monkeypatch):
    # §H20b. The mutation this pins, stated positively: the `-E -1` argument is
    # what makes §H20 true, so its presence is asserted on the ARGV rather than
    # trusted. A capture without it returns the visible rows as well, and the
    # user sees the current screen duplicated above itself.
    state = FakeChannel(output=_state(history_size=100))
    cap = FakeChannel(output=_history([f'ROW-{i}' for i in range(1, 101)]))
    session_id, _ = _install([state, cap])

    ok, _error, _text = ssh_manager.read_tmux_history(session_id)

    assert ok is True
    argv = cap.command.split()
    assert '-E' in argv, 'the capture MUST bound its end, or history overlaps the screen'
    assert argv[argv.index('-E') + 1] == '-1'


def test_the_combined_stream_contains_no_duplicated_line(monkeypatch):
    # §H20c. The same property one level up, on what build_replay_chunks actually
    # emits: the history and the gap buffer are adjacent, not overlapping, so the
    # joined stream has no repeated line either.
    _seed_buffer('sess-dup', ['TAIL-1\r\nTAIL-2\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (True, None,
                           ''.join(f'HIST-{i}\r\n' for i in range(1, 51))))

    chunks, _meta = ssh_manager.build_replay_chunks('sess-dup')

    lines = [ln for ln in ''.join(chunks).split('\r\n') if ln]
    assert len(lines) == 52
    assert len(lines) == len(set(lines))
    assert lines[0] == 'HIST-1' and lines[-1] == 'TAIL-2'


# ---- §H16-H19 the wire contract, on BOTH paths the Owner named ---------------

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


def _register(app, username):
    from app.auth import register_user
    with app.app_context():
        user, error = register_user(username, 'history-pass-123')
        assert error is None
        return user.id


def _ram_session(user_id, buffer_elements=()):
    return {
        'client': object(),
        'channel': object(),
        'host': 'hx.example.com',
        'port': 22,
        'username': 'deploy',
        'user_id': user_id,
        'connected': True,
        'last_activity': time.time(),
        'bastion_client': None,
        'proxy_jump_host': None,
        'auth_type': 'key',
        'use_tmux': True,
        'tmux_session_name': 'sshdeck_hx',
        'display_name': 'HX box',
        'output_buffer': list(buffer_elements),
        'output_buffer_size': sum(len(e) for e in buffer_elements),
        'output_buffer_max': 512000,
    }


def _seed_row(app, user_id, session_id):
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id, user_id=user_id,
            host='hx.example.com', port=22, username='deploy',
            connected=True, is_persistent=True, auth_type='key',
            key_id='key-hx-1', tmux_session_name='sshdeck_hx',
            display_name='HX box')
        db.session.add(row)
        db.session.commit()


def _capture_restore(app, user_id, to_sid='sid-HX'):
    from app import socket_events
    captured = []
    with app.app_context():
        original_emit = socket_events.emit

        socket_events.emit = lambda event, payload=None, **kw: captured.append(
            (event, payload, kw))
        try:
            socket_events.restore_user_sessions(user_id, to_sid=to_sid)
        finally:
            socket_events.emit = original_emit
    return captured


def test_a_restoring_tmux_tab_gets_its_history_from_the_attach(app, monkeypatch):
    # §H16, RE-POINTED. The RELOAD path, which is the Owner's
    # literal complaint ("Tải lại mobile vẫn mất lịch sử").
    #
    # The restore event itself no longer carries replay for a tmux session: the
    # returning tab opens its OWN tmux client, and that attach repaints the
    # visible screen at that tab's size. History is the lines ABOVE the screen,
    # so it rides the attach instead -- which is also what makes it correct on a
    # second device, where the old shared gap buffer would have replayed bytes
    # the other device had already been shown.
    user_id = _register(app, 'hx_restore_user')
    _seed_row(app, user_id, 'sess-hx-restore')
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-hx-restore'] = _ram_session(
            user_id, ['LIVE-TAIL\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (True, None,
                           ''.join(f'HIST-{i}\r\n' for i in range(1, 201))))

    captured = _capture_restore(app, user_id)

    # Restore: the snapshot alone, announcing nothing to replay.
    assert [e for (e, _p, _k) in captured].count('ssh_session_restored') == 1
    assert [p for (e, p, _k) in captured if e == 'ssh_replay_chunk'] == []
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]
    assert snapshot['replay_total_chunks'] == 0

    # Attach: the history, and only the history.
    from app import socket_events
    chunks, meta = socket_events.prepare_attach_replay('sess-hx-restore', True)
    joined = ''.join(chunks)
    assert 'HIST-1' in joined and 'HIST-200' in joined
    assert 'LIVE-TAIL' not in joined
    assert meta['total_chunks'] == len(chunks)


def test_an_unreadable_history_still_lets_the_tab_attach(app, monkeypatch):
    # §H17. Same path, tmux unreadable. History is an ENRICHMENT: a failed read
    # sends no chunks, reports no error to the client, and the attach proceeds.
    user_id = _register(app, 'hx_restore_fail_user')
    _seed_row(app, user_id, 'sess-hx-fail')
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-hx-fail'] = _ram_session(
            user_id, ['LIVE-TAIL\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (False, 'SSH transport is not active', ''))

    captured = _capture_restore(app, user_id)
    assert [e for (e, _p, _k) in captured].count('ssh_session_restored') == 1
    assert [p for (e, p, _k) in captured if e == 'ssh_replay_chunk'] == []

    from app import socket_events
    chunks, meta = socket_events.prepare_attach_replay('sess-hx-fail', True)
    assert chunks == []
    assert meta['total_chunks'] == 0


def test_attach_history_excludes_the_gap_buffer(monkeypatch):
    # §H18. THE ATTACH PATH, and the reason it needs its own shape.
    #
    # On RESTORE nothing reattaches, so the gap buffer is the only record of the
    # bytes the old tab missed and it must be replayed. On ATTACH the bytes in
    # that buffer were ALSO just emitted live to this very client (read_ssh_output
    # emits and appends), so replaying them would paint tmux's reattach repaint
    # twice. Attach therefore delivers HISTORY ONLY.
    _seed_buffer('sess-attach', ['ATTACH-REPAINT\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history',
        lambda *_a, **_k: (True, None, 'HIST-1\r\nHIST-2\r\n'))

    chunks, meta = ssh_manager.build_replay_chunks(
        'sess-attach', include_buffer=False)

    joined = ''.join(chunks)
    assert 'HIST-1' in joined and 'HIST-2' in joined
    assert 'ATTACH-REPAINT' not in joined
    assert meta['history_lines'] == 2


def test_attach_with_no_history_produces_no_chunks(monkeypatch):
    # §H18b. A brand-new tmux session has nothing above its screen, so a fresh
    # connect delivers nothing -- the client's window is released by the
    # terminator, exactly as an empty restore is today.
    _seed_buffer('sess-attach-empty', ['ATTACH-REPAINT\r\n'])
    monkeypatch.setattr(
        ssh_manager, 'read_tmux_history', lambda *_a, **_k: (True, None, ''))

    chunks, meta = ssh_manager.build_replay_chunks(
        'sess-attach-empty', include_buffer=False)

    assert chunks == []
    assert meta['total_chunks'] == 0
    assert meta['history_lines'] == 0


def test_connect_announces_a_replay_window_before_the_chunks(app, monkeypatch):
    # §H19. The wire contract on connect, and why it is TWO steps.
    #
    # The client opens its replay window from `replay_total_chunks` on the
    # session payload, so the count must be known BEFORE `ssh_connected` is
    # emitted and the chunks must follow AFTER it. Hence prepare/emit rather than
    # one call: a single call could only emit chunks into a window that did not
    # exist yet, and the client would write history as if it were live output.
    from app import socket_events

    monkeypatch.setattr(
        ssh_manager, 'build_replay_chunks',
        lambda _sid, **_k: (['HIST-1\r\n'], {
            'bytes': 8, 'lines': 1, 'truncated': False, 'dropped_bytes': 0,
            'total_chunks': 1, 'history_lines': 1}))

    chunks, meta = socket_events.prepare_attach_replay(
        'sess-hx-attach', use_tmux=True)
    assert meta['total_chunks'] == 1

    captured = []
    with app.app_context():
        original = socket_events.emit
        socket_events.emit = lambda event, payload=None, **kw: captured.append(
            (event, payload))
        try:
            socket_events.emit_attach_replay('sess-hx-attach', chunks, meta)
        finally:
            socket_events.emit = original

    assert [e for (e, _p) in captured] == ['ssh_replay_chunk']
    payload = captured[0][1]
    assert payload['session_id'] == 'sess-hx-attach'
    assert payload['seq'] == 1 and payload['final'] is True
    assert payload['data'] == 'HIST-1\r\n'


def test_connect_with_no_history_opens_no_window_at_all(app, monkeypatch):
    # §H19b. No history -> no announced count and no chunks, so the client never
    # opens a window it would then have to have released. This is what keeps a
    # fresh connect on exactly today's code path.
    from app import socket_events

    monkeypatch.setattr(
        ssh_manager, 'build_replay_chunks',
        lambda _sid, **_k: ([], {
            'bytes': 0, 'lines': 0, 'truncated': False, 'dropped_bytes': 0,
            'total_chunks': 0, 'history_lines': 0}))

    chunks, meta = socket_events.prepare_attach_replay(
        'sess-empty', use_tmux=True)
    assert chunks == [] and meta['total_chunks'] == 0

    captured = []
    with app.app_context():
        original = socket_events.emit
        socket_events.emit = lambda event, payload=None, **kw: captured.append(
            (event, payload))
        try:
            socket_events.emit_attach_replay('sess-empty', chunks, meta)
        finally:
            socket_events.emit = original

    assert captured == []


def test_connect_asks_for_no_history_on_a_non_tmux_session(monkeypatch):
    # §H19c. A plain SSH connect is byte-for-byte unchanged: no history read, no
    # replay window, no terminator. The mechanism exists only because tmux
    # repaints instead of scrolling.
    from app import socket_events
    calls = []

    def spy(_sid, **_k):
        calls.append(1)
        return ([], {})

    monkeypatch.setattr(ssh_manager, 'build_replay_chunks', spy)

    chunks, meta = socket_events.prepare_attach_replay(
        'sess-plain', use_tmux=False)

    assert calls == []
    assert chunks == [] and meta['total_chunks'] == 0






