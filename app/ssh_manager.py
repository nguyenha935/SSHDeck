import codecs
import paramiko
from paramiko.auth_strategy import AuthStrategy, NoneAuth
import re
import shlex
import time
from collections import OrderedDict
import uuid
import socket
from threading import Condition, Lock, Thread, Timer
import config
from pathlib import Path
from .audit_logger import log_info, log_warning, log_error, log_debug
from .ssh_key_loader import load_private_key as _load_private_key
from .startup_commands import to_terminal_input
from . import tmux_control

sessions = {}
sessions_lock = Lock()
_pending_connections = 0

# ============================================================================
# ONE TMUX CLIENT PER BROWSER SOCKET ("views"). redesign.
# ============================================================================
#
# A tmux-backed session is a tmux SESSION on the remote host plus one SSH
# transport. It has NO session-level PTY channel. Each browser socket that is
# actually DISPLAYING the session opens its own attach channel -- a "view":
#
#     Transport.open_session
#     channel.get_pty('xterm-256color', cols, rows)
#     channel.exec_command("tmux -u attach-session -t '=<name>'")
#
# so tmux sees a genuine client per device, draws each one clipped to its own
# size, and delivers the mouse DECSETs to all of them. The window size follows
# `window-size smallest` (set per window at attach time): the smallest ATTACHED
# client wins, and a browser tab that goes hidden CLOSES its channel, which tmux
# reads as a detach -- measured on tmux 3.7c, the window grew back within 1ms.
#
# That replaces ~2600 lines of geometry arbitration (an authority resolver with
# hysteresis, a per-device floor, a vacated-grid reclaim, ledgers for size /
# visibility / interaction, a window lock, control mode with its own reader,
# per-client refresh-client sizing, an attach seed, a redraw nudge and an output
# announce gate). Every one of those existed only because the old design fanned
# ONE PTY's bytes to every browser in the user's socket.io room, forcing all of
# them onto a single grid. tmux already solves that; the app stopped trying to.
#
# A view record lives in `sessions[session_id]['views'][socket_sid]`:
#     {'channel', 'cols', 'rows', 'thread', 'transport_generation', 'opened_at'}
# Views are NOT sessions: they never count against MAX_SESSIONS, and closing the
# last one leaves the tmux session (and this record) alive and detached.
#
# A NON-TMUX session keeps the old shape exactly: one `channel`, one reader,
# `ssh_output` to the user's room, last-resize-wins. A plain shell has a single
# PTY and cannot be multiplexed, so there is nothing to split.

def _stream_decoder():
    """A UTF-8 decoder that survives a character split across two reads.

    OWNER REPORT: "nó còn bị lỗi chữ thành các ô vuông ??? ở một
    vài vị trí, hàng và ký tự."

    THE MECHANISM. Both readers pull up to 32 KB per `recv` and used to decode
    each chunk on its own with `errors='replace'`. A character whose bytes
    straddle that boundary is then TWO invalid fragments, and both become
    U+FFFD -- the squares the owner sees, scattered at a few positions rather
    than everywhere, because it happens only where a read boundary lands
    inside a multi-byte sequence. Vietnamese text is 2-3 bytes per accented
    letter and the box-drawing a TUI paints with (│ ─ └) is 3, so a busy pane
    hits it regularly; pure ASCII never does, which is why it looked random.

    An incremental decoder keeps the unfinished tail and decodes it when the
    next chunk arrives. Bytes that are genuinely invalid still become U+FFFD,
    so nothing is hidden -- only the artificial split is repaired.
    """
    return codecs.getincrementaldecoder('utf-8')('replace')


def publish_session_output(session_id, socketio_instance, text, room=None):
    """Emit one NON-TMUX session's bytes to the owner's room as `ssh_output`.

    A tmux session never reaches here: its bytes belong to one view and are
    emitted to that view's socket by `read_view_output`. A plain shell has a
    single PTY shared by every tab of the account, so the room is correct there.

    `room` is the reader's cached room; when absent it is derived from the
    session's own user_id, which is what makes this callable from a test with no
    DB. sessions_lock is released before the emit: Engine.IO's emit can block,
    and holding the global registry lock across it would stall every other
    session in the process.
    """
    if not text:
        return False
    if room is None:
        with sessions_lock:
            session = sessions.get(session_id)
            if session is None:
                return False
            user_id = session.get('user_id')
        room = f'user_{user_id}' if user_id is not None else None
    socketio_instance.emit('ssh_output',
                           {'session_id': session_id, 'data': text},
                           room=room)
    return True


def session_uses_tmux(session_id):
    """Is this session running under tmux?

    Read from the SESSION record, never from live config: the transport that was
    actually built is the fact that matters, so flipping a config switch cannot
    change how an already-open session is treated.

    It decides which shape a session has -- views + per-view channels, or the
    single shared channel of a plain shell.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        return bool(session and session.get('use_tmux'))


_reader_handoff = set()
_reader_handoff_lock = Lock()


def _mark_reader_handoff(session_id, transport_generation=0):
    """Retire the reader of ONE exact transport generation.

    `transport_generation` is the generation being REPLACED -- the one the
    reader being retired owns -- not the new one. It defaults to 0 so a caller
    whose session has only ever had one transport needs no argument.
    """
    with _reader_handoff_lock:
        _reader_handoff.add((session_id, transport_generation))


def _transport_was_swapped(session_id, transport_generation=0):
    """True when THIS reader's transport was replaced under it.

    A swapped-out transport reports EOF/errors; that is the swap, not a
    session death. The logical session lives on with the new transport and its
    own new reader, so the old reader must not emit ssh_disconnected nor close
    the session.

    The generation makes the answer exact: a newer reader asking about its own
    generation gets False even while its predecessor's flag is still pending, so
    it can still report a genuine death of the CURRENT transport.
    """
    with _reader_handoff_lock:
        return (session_id, transport_generation) in _reader_handoff


def _discard_reader_handoff(session_id, transport_generation):
    """Drop ONE exact flag. The only cleanup a reader may perform on itself.

    A reader that has not PROVEN it is the current generation may never remove
    another generation's flag: doing so is how gen0's retirement used to be
    deleted by gen1's death, after which gen0 woke with neither a flag nor a
    superseded marker and disconnected a session that was already reported gone.
    """
    with _reader_handoff_lock:
        _reader_handoff.discard((session_id, transport_generation))


def _discard_reader_handoffs(session_id):
    """Drop every pending flag for a session being torn down for good.

    ONLY for close_session, where the logical session ceases to exist and no
    future reader of this id may be silenced by a stale flag. Readers must use
    _discard_reader_handoff (singular, exact) instead -- see its docstring.
    """
    with _reader_handoff_lock:
        for key in [k for k in _reader_handoff if k[0] == session_id]:
            _reader_handoff.discard(key)


# ── Reader identity fences and the per-session AUTHORITY lock ────────────────
#
# A reader is authoritative only while the registry still names ITS generation
# AND ITS channel. Generation alone is not enough for the post-recv fence: it
# proves no swap has been recorded, not that the object this thread just read
# from is still the session's channel. Both are compared by identity.
#
# WHY A CHECK ALONE IS NEVER ENOUGH. A check whose answer is used OUTSIDE its
# lock is exactly the window a mutation lands in, and the observable damage is
# ordering, not state: a socket event cannot be recalled once published, so a
# post-emit re-check is not a fix. Publication must therefore be serialized
# against every mutation that can take a reader's authority away.
#
# THE AUTHORITY LOCK COVERS EVERY AUTHORITY MUTATION, not just swap:
#
#   * swap_session_transport   -- installs a new generation/channel
#   * close_session            -- removes the session entirely
#   * claim_reader_death       -- the exact-current reader popping its session
#   * reader publication       -- emit + buffer append
#
# If close_session were left out, this would still be broken: it could remove and
# close the session between a reader's validation and its emit, and the terminal
# would receive output for a session the user had just closed. So all four take
# the SAME per-session lock, and for one session they are totally ordered.
#
# WHY PER-SESSION AND NOT sessions_lock. Engine.IO's emit can block and can enter
# cleanup paths synchronously; holding the global registry lock across it would
# stall every SSH session in the process while one reader published. A per-session
# lock keeps the ordering local: unrelated sessions never contend, which is
# asserted by test.
#
# ACQUIRING IT SAFELY WHEN THE SESSION MAY VANISH. The lock lives on the session
# dict, so it cannot be read without the registry lock, and the session may be
# removed while a thread waits for it. Every caller therefore follows one
# protocol:
#
#     1. under sessions_lock: fetch the session and its authority lock (a stable
#        object -- created once, never replaced, so two threads racing for the
#        same session always get the same lock)
#     2. release sessions_lock, acquire the authority lock (blocking here cannot
#        stall the registry or any other session)
#     3. under sessions_lock again: RE-VALIDATE, because the session may have
#        been removed or swapped while waiting. A caller that finds its premise
#        gone gives up rather than acting on stale state.
#
# An "orphan" lock -- one belonging to a session already removed -- is harmless:
# step 3 fails and the caller bails. LOCK ORDER is always authority-lock THEN
# sessions_lock; nothing anywhere takes them in the other order.

def _reader_is_current_locked(session_id, transport_generation, channel):
    """Is this reader still the session's authority? CALLER HOLDS sessions_lock.

    Every reader-side check lives under the same lock as the act it guards, and
    inside the authority lock that serializes it against swap, close and death
    claims. A check-only helper whose answer is used later is exactly the window
    those mutations land in.
    """
    session = sessions.get(session_id)
    if session is None or not session.get('connected'):
        return False
    if session.get('transport_generation', 0) != transport_generation:
        return False
    if channel is not None and session.get('channel') is not channel:
        return False
    return True


def _session_authority_lock(session):
    """The per-session publish/swap/close/claim serialization lock.

    STABLE: created once with setdefault and never replaced, so two threads that
    look it up for the same session always receive the same object. It lives ON
    the session dict, so it is popped with the session and never accumulates in a
    side registry. CALLER HOLDS sessions_lock -- creation mutates the shared dict.
    """
    return session.setdefault('_authority_lock', Lock())


def _authority_claim_for(session_id):
    """Step 1 of the protocol: capture (expected_session, authority_lock).

    Returns ``(expected_session, authority_lock)`` or ``(None, None)`` when the
    session is not registered.

    WHY THE SESSION OBJECT IS CAPTURED, NOT JUST THE LOCK. The lock lives ON the
    session dict, so it is stable for as long as that dict exists -- but the dict
    is popped when the session is removed, and the SAME session_id can be
    re-registered as a NEW dict with a NEW lock. A waiter that blocked on the OLD
    session's lock would then wake, revalidate by id, find the NEW session
    (connected, right generation), and mutate or pop it under the OLD session's
    orphan lock. That is the reused-id/orphan-lock race: the replacement session
    is torn down by a waiter that was really waiting for a session that no longer
    exists.

    Capturing the EXACT session object alongside its lock fixes it: after
    acquiring the lock, the waiter re-validates under sessions_lock that
    sessions.get(session_id) IS the same object it captured -- not merely that
    some session is registered under that id. A reused id has a different dict
    object, so the waiter sees a mismatch and returns harmlessly without touching
    the replacement.

    The identity compared is Python object identity (`is`): the session dict is
    unique per registration and never replaced in place, so `is` is exact.

    TEST SYNC HOOK. `authority_claim_hook` (when set by a test) is called with
    (session_id, expected_session, authority_lock) AFTER the claim is captured
    and BEFORE the caller proceeds to acquire the lock. It is the exact boundary
    a deterministic reused-id test needs to prove the waiter has captured A and
    is about to block on A's lock -- so the test can remove A and register B
    before releasing A. The hook is a no-op in production (None) and never alters
    the claim's return value or timing path; it only observes.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        if session is None:
            return None, None
        lock = _session_authority_lock(session)
    if authority_claim_hook is not None:
        authority_claim_hook(session_id, session, lock)
    return session, lock


# The test sync hook. None in production; set to a callable by tests that need
# to observe the exact instant a claim is captured. See _authority_claim_for.
authority_claim_hook = None


def _session_still_expected_locked(session_id, expected_session):
    """Is the session registered under `session_id` STILL `expected_session`?

    CALLER HOLDS sessions_lock. The answer is by OBJECT IDENTITY: a reused id
    registers a NEW dict, so `is` distinguishes "the session I captured" from
    "a replacement reusing the id".
    """
    return sessions.get(session_id) is expected_session


# The three outcomes a retiring reader can have. Named so the reader's finally
# block reads as the decision it is, and so a test can assert the exact one.
READER_RETIRE_CURRENT = 'exact-current-retired'
READER_RETIRE_SUPERSEDED = 'superseded'
READER_RETIRE_GONE = 'already-gone'


def claim_reader_death(session_id, transport_generation, channel):
    """ATOMICALLY decide whether this reader may declare the session dead.

    Returns ``(state, parts)``:

      * READER_RETIRE_CURRENT -- this reader owned the generation AND channel the
        registry still named. The entry has been popped and marked disconnected
        INSIDE the lock, and `parts` is the captured (client, channel, bastion)
        for the caller to close. The caller may now update the DB row, emit
        ssh_disconnected and close those captured parts.
      * READER_RETIRE_SUPERSEDED -- a swap already replaced this reader. `parts`
        is None; retire quietly, touch nothing.
      * READER_RETIRE_GONE -- the session is no longer registered at all (a user
        disconnect or close_session got there first, and it has already reported
        whatever needed reporting). `parts` is None; retire quietly.

    WHY THIS IS ONE ATOMIC STEP. The old finally block asked
    "_transport_was_swapped?" outside the lock and then, on "no", ran a DB write
    and a generic `close_session(session_id)`. A swap landing between those two
    points meant gen0 answered "not swapped" (true at the time), then marked the
    logical session disconnected and closed gen1 -- the replacement transport the
    reconnect had just installed. Popping the entry under the same lock that
    verifies ownership removes that window: whoever pops is, by construction, the
    generation the registry named at that instant, and there is no later generic
    close to hit the wrong transport.

    A `channel` of None NEVER claims CURRENT. A reader can reach its finally
    without ever having bound a channel -- the DB row never appeared, the lookup
    raised, the thread was killed during startup -- and on a session that has had
    no swap its generation still matches. Claiming on generation alone would let
    such a reader pop and tear down a live, healthy current channel it never
    read a byte from. Exact identity is required for a current-death claim, so an
    unbound reader is told it has nothing to claim and retires in silence.

    THE CLAIM IS AN AUTHORITY MUTATION, so it captures the session's authority
    claim (expected_session, authority_lock) and re-validates by OBJECT IDENTITY
    after acquiring the lock. That is what serializes it against an in-flight
    publication AND against a reused-id replacement: a reader mid-emit finishes
    before this claim can remove the session under it, and a waiter whose session
    was removed and re-registered under the same id finds a different dict object
    and returns harmlessly.
    """
    expected_session, authority_lock = _authority_claim_for(session_id)
    if expected_session is None:
        return READER_RETIRE_GONE, None
    with authority_lock:
        with sessions_lock:
            session = sessions.get(session_id)
            if session is None:
                return READER_RETIRE_GONE, None
            # REUSED-ID GUARD: the session registered under this id must be the
            # EXACT object whose lock we hold, not a replacement reusing the id.
            if session is not expected_session:
                return READER_RETIRE_SUPERSEDED, None
            if channel is None:
                # Unbound: no proof of identity, so no authority to declare
                # death.
                return READER_RETIRE_SUPERSEDED, None
            if session.get('transport_generation', 0) != transport_generation:
                return READER_RETIRE_SUPERSEDED, None
            if session.get('channel') is not channel:
                return READER_RETIRE_SUPERSEDED, None
            sessions.pop(session_id, None)
            session['connected'] = False
            return READER_RETIRE_CURRENT, (
                session.get('client'), session.get('channel'),
                session.get('bastion_client'),
                session.get('_sftp_owner_token'))


def _close_retired_parts(session_id, parts):
    """Close the transport parts captured by claim_reader_death.

    Deliberately NOT close_session: that pops by id, and by this point the entry
    has already been popped under the ownership lock. Calling it here would look
    up whatever the id names NOW -- which after a concurrent reconnect is the
    # replacement -- and close that instead.

    W13: `parts` includes the owning session's `_sftp_owner_token`, passed as
    `expected_owner` to close_sftp_cache so a reused-id replacement's SFTP handle
    and lock are never closed here.
    """
    if not parts:
        return
    # parts is (client, channel, bastion_client, sftp_owner_token)
    sftp_owner = parts[3] if len(parts) > 3 else None
    try:
        from .sftp_handler import close_sftp_cache
        close_sftp_cache(session_id, expected_owner=sftp_owner)
    except Exception as e:
        log_debug("Error closing SFTP cache", session_id=session_id,
                  error=str(e))
    _close_transport_parts(parts[0], parts[1], parts[2])

# Logical session ids with a prepare-and-swap reconnect currently building
# its replacement transport. One lifecycle owner: a second reconnect request
# for the same session is rejected while the first is in flight instead of
# racing two replacement transports against each other.
_reconnect_in_flight = set()
_reconnect_in_flight_lock = Lock()

def begin_reconnect(session_id):
    """Claim the reconnect owner slot for a session. False if already claimed."""
    with _reconnect_in_flight_lock:
        if session_id in _reconnect_in_flight:
            return False
        _reconnect_in_flight.add(session_id)
        return True

def end_reconnect(session_id):
    """Release the reconnect owner slot; safe to call unconditionally."""
    with _reconnect_in_flight_lock:
        _reconnect_in_flight.discard(session_id)
TMUX_KILL_TIMEOUT = 2.0

# ── Deterministic UTF-8 for every tmux pane ─────────────────────────────────
#
# MEASURED, not assumed (tests/browser/defect1_pane_locale_ime_probe.py, run
# against the live target, tmux 3.4):
#
#   * paramiko forwards no LANG/LC_* on ANY auth type, and the target's sshd
#     sends none either, so a pane's locale is empty and glibc resolves
#     charmap ANSI_X3.4-1968. In that pane bash/readline runs with
#     `convert-meta on`, which rewrites every byte >= 0x80 as ESC + (byte &
#     0x7F). Composed Vietnamese therefore arrives as
#     "ting Vit xin cho" -- the multi-byte characters are DROPPED at the
#     prompt, with zero U+FFFD to show for it.
#   * The loss is readline+locale, not the transport, the tty layer or tmux:
#     the same per-character delivery into `cat > file` is byte-exact in the
#     very same pane, and one bulk write is byte-exact too. Only the
#     per-character path through readline -- the shape an IME commit and
#     ordinary typing have -- is destroyed.
#   * The old `env LANG=... LC_ALL=... tmux ...` prefix could not fix this in
#     the shape the product uses it. A tmux SERVER's environment is fixed by
#     the FIRST client that starts it; a later `env ... tmux new-session -A`
#     only sets the short-lived tmux CLIENT's environment, and the pane
#     inherits the server's. Measured: prefix-on-attach left the pane at
#     ANSI_X3.4-1968 and per-char input still broken; no-prefix-on-attach to a
#     server started WITH the prefix was byte-exact. The prefix was decorative
#     on every reconnect.
#   * `new-session -e` sets the environment of the SESSION, so the pane's own
#     shell gets it regardless of who started the server. Measured byte-exact
#     on all three input paths, and it survives reconnect for sessions created
#     with it.
#
# LC_CTYPE, not LC_ALL: LC_CTYPE is the only category that decides multi-byte
# character handling, and unlike LC_ALL it leaves the target's own messages,
# collation and time formats alone. LANG is set alongside it as the base
# fallback for anything that reads no LC_* at all.
TMUX_UTF8_ENV_NAMES = ('LANG', 'LC_CTYPE')

# THE VALUE IS THE HOST'S, NOT OURS.
#
# Measured on tmux 3.4 / glibc 2.39, per-character delivery (the
# shape an IME commit has):
#
#   -e LANG=xx_XX.UTF-8 -e LC_CTYPE=xx_XX...    -> "ting Vit xin cho"  MANGLED
#
# A locale name the host does not have is silently ignored by setlocale, so the
# pane falls back to ANSI_X3.4-1968 and is no better off than with no locale at
# all. Naming one value unconditionally therefore only works on hosts that
# happen to have it: this very box lists `C.utf8` and NOT `C.UTF-8`.
#
# So the locale is resolved FROM the target, in the probe round trip that
# already runs, against this candidate list in order. The value sent is the
# host's own spelling, taken verbatim from its `locale -a`, because that is the
# string its setlocale will resolve.
TMUX_UTF8_LOCALE_CANDIDATES = ('C.UTF-8', 'C.utf8', 'en_US.UTF-8')

# What to send when the listing is unreadable, empty, or holds no candidate:
# exactly the value that shipped before host-adaptive resolution existed. A
# probe that tells us nothing must leave behaviour unchanged, never worse.
TMUX_UTF8_FALLBACK_LOCALE = 'C.UTF-8'

# Kept as the FALLBACK pair, and as the shape every caller sees: (name, value)
# tuples ready for `-e name=value`. build_tmux_command composes the real pair
# from the resolved locale.
TMUX_UTF8_ENV = tuple((name, TMUX_UTF8_FALLBACK_LOCALE)
                      for name in TMUX_UTF8_ENV_NAMES)

# One exec round trip answers four questions. `locale -a` runs FIRST and
# `tmux -V` LAST so the channel's exit status is still tmux's own -- the
# availability signal is unchanged, not re-derived from parsed text. The
# sentinels separate the payloads; if they are absent (a shell that could not
# run the sequence) the whole blob is treated as the tmux banner and the
# locale/shell answers fall back, so a probe that half-works degrades instead
# of misfiring.
TMUX_PROBE_SENTINEL = '__SSHDECK_PROBE_BOUNDARY__'
# Discovery: the second sentinel separates the account's passwd entry
# from the tmux banner. The entry is DISCOVERED, never trusted: it is parsed
# by parse_login_shell_from_getent and only a strictly validated shell path
# survives -- nothing from it is ever interpolated back into a command.
TMUX_PROBE_SHELL_SENTINEL = '__SSHDECK_PROBE_BOUNDARY_SHELL__'
# The uid comes from `id -u` (kernel-trusted), never from $USER, which a
# remote environment may leave unset or spoof. stderr is silenced so a host
# without getent contributes an empty segment instead of noise, and tmux -V
# stays last so the exit status remains tmux's availability signal.
# NO extra round trip: the discovery rides inside the one probe every connect
# already makes.
TMUX_PROBE_COMMAND = (
    f'locale -a 2>/dev/null; echo {TMUX_PROBE_SENTINEL}; '
    f'getent passwd "$(id -u)" 2>/dev/null; echo {TMUX_PROBE_SHELL_SENTINEL}; '
    f'tmux -V')

# `locale -a` is a few KB on a full glibc host (152 UTF-8 entries here), so the
# read cap cannot stay at the 256 bytes `tmux -V` alone needed.
TMUX_PROBE_MAX_BYTES = 65536

# `-e` on new-session arrived in tmux 3.2. Below that the option is a usage
# error that kills the channel, so older servers keep the client-side prefix:
# it is inert on attach (as it always was) but does set a FRESH server's
# environment, which is strictly better than nothing and never worse than the
# behaviour it replaces.
TMUX_MIN_VERSION_FOR_SESSION_ENV = (3, 2)

# The two ways a retained reattach can fail CLOSED. Both are returned
# as ordinary (None, error) build failures, so every caller already handles
# them the way it handles a refused connection -- the source session's UI,
# transport, terminal and DB row are untouched and nothing was created on the
# host. They are named constants because the tests and the reconnect route
# assert on the exact user-visible text.
TMUX_REATTACH_UNAVAILABLE_ERROR = (
    'Cannot reconnect: tmux is not available on the host, so the saved '
    'session cannot be reattached')
TMUX_REATTACH_GONE_ERROR = (
    'Cannot reconnect: the saved tmux session no longer exists on the host')


def _parse_tmux_version(banner):
    """(major, minor) from `tmux -V` output, or None when unreadable.

    tmux reports e.g. "tmux 3.4", "tmux 3.3a", "tmux next-3.5". Only the first
    two numbers matter, and an unreadable banner returns None so the caller can
    choose the conservative path rather than guess.
    """
    if not banner:
        return None
    m = re.search(r'(\d+)\.(\d+)', banner)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)))


def _tmux_supports_session_env(version):
    return bool(version) and version >= TMUX_MIN_VERSION_FOR_SESSION_ENV


def split_tmux_probe_output(raw):
    """(locale_listing, passwd_entry, tmux_banner) from the one probe round trip.

    The two sentinels are what separate the three segments. Without the FIRST
    sentinel there is no way to know which part is which, so the WHOLE blob is
    returned as the banner and the other two segments are empty -- the
    conservative split, because a wrong banner would misjudge tmux's version, a
    wrong listing would pick a locale the host does not have, and a wrong
    passwd entry could feed hostile text to the shell parser (which declines
    anything it does not strictly recognize, so the empty answer is the safe
    one). A host that answers in the OLD two-segment shape (first sentinel
    present, shell sentinel absent) keeps its locale listing and banner intact
    and contributes no passwd entry -- a pre-discovery answer degrades to "no
    discovery", never to a misparse.
    """
    text = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else (raw or '')
    if TMUX_PROBE_SENTINEL not in text:
        return '', '', text
    listing, _, rest = text.partition(TMUX_PROBE_SENTINEL)
    if TMUX_PROBE_SHELL_SENTINEL not in rest:
        return listing, '', rest
    entry, _, banner = rest.partition(TMUX_PROBE_SHELL_SENTINEL)

    # PROTOCOL FRAMING ONLY. The generated probe emits the passwd segment as
    # `echo SENTINEL; getent passwd ...; echo SENTINEL`: exactly ONE '\n'
    # precedes the segment (our own `echo` terminator) and getent terminates
    # its single record with exactly ONE trailing '\n'. Remove exactly that
    # protocol-owned framing — at most one leading LF and at most one trailing
    # LF/CRLF — and nothing else. No unrestricted strip: any interior,
    # leading-surplus or trailing-surplus CR/LF survives, so a hostile or
    # multi-line answer still reaches the parser carrying its newlines and is
    # rejected there, fail-closed.
    if entry.startswith('\n'):
        entry = entry[1:]
    if entry.endswith('\r\n'):
        entry = entry[:-2]
    elif entry.endswith('\n'):
        entry = entry[:-1]
    return listing, entry, banner


def parse_login_shell_from_getent(passwd_entry):
    """The account's login shell from ONE `getent passwd <uid>` entry, or None.

    The entry is DISCOVERED on the remote host and therefore untrusted input:
    nothing here interpolates it into a command. It is only accepted when it
    has EXACTLY the seven colon-separated passwd fields and its last field
    passes the SAME validators build_login_shell_command applies to any login
    shell -- absolute path, safe characters, no `..`, basename in the proven
    POSIX family. Any other shape (wrong field count, empty, relative path,
    fish/csh/nologin, metacharacters, multi-line blobs, hostile commands)
    returns None, and the caller keeps the shipped invoke_shell fallback.

    STRICT FAIL-CLOSED, no exceptions: a passwd record cannot contain a
    newline. ANY CR or ANY LF anywhere in the answer — leading, interior, a
    single trailing one, or many — is declined outright. The split layer
    removes exactly the protocol-owned sentinel/`echo`/getent-record framing
    BEFORE the answer reaches here, so a legitimate production entry arrives
    as one clean line; anything still carrying newline content is hostile or
    malformed input and must never be trimmed to its first line, which would
    silently accept a blob a hostile answer could shape.
    """
    if not isinstance(passwd_entry, str):
        return None
    if '\n' in passwd_entry or '\r' in passwd_entry:
        return None
    text = passwd_entry.strip()
    if not text:
        return None
    fields = text.split(':')
    if len(fields) != 7:
        return None
    shell = fields[6].strip()
    if not shell:
        return None
    if '..' in shell:
        return None
    if not _LOGIN_SHELL_PATH_RE.fullmatch(shell):
        return None
    if shell.rsplit('/', 1)[-1] not in LOGIN_SHELL_BASENAMES:
        return None
    return shell


def resolve_tmux_utf8_locale(locale_listing):
    """The first candidate the host actually has, in its own spelling.

    Matching is EXACT and case-sensitive against the listing's own lines,
    because the string is handed back to the target's setlocale and only its own
    spelling resolves there: `C.utf8` and `C.UTF-8` are different names, and a
    host that lists one does not necessarily accept the other.

    An unreadable or candidate-free listing returns the historical fallback, so
    a host whose probe says nothing behaves exactly as it did before this
    resolution existed.
    """
    available = {line.strip() for line in (locale_listing or '').splitlines()
                 if line.strip()}
    for candidate in TMUX_UTF8_LOCALE_CANDIDATES:
        if candidate in available:
            return candidate
    return TMUX_UTF8_FALLBACK_LOCALE


def build_tmux_command(tmux_session_name, tmux_version, utf8_locale=None):
    """The tmux command that CREATES one session, run on a short exec channel.

: CREATE ONLY, and detached. This used to build the reattach
    command too, but a reattach no longer runs any command at all on the
    transport: it verifies the session exists (read-only `has-session`) and
    every browser socket then attaches its own client with
    build_tmux_attach_command -- see the views note at the top of this module.
    Keeping a reattach branch here would have been a second, unused definition
    of how to attach.

    For BOTH auth types.

    Auth type is deliberately not a parameter. It never had any bearing on how
    a pane handles multi-byte input -- the old branch made Tailscale panes
    behave differently from password panes for no reason that survived
    measurement, which is exactly the defect being fixed. Every session now
    gets the same deterministic UTF-8 treatment.

    W13-B5 is why creating is a branch nothing else can reach. This command
    names a session the caller has just generated, so it can only ever create a
    NEW name; a reattach never comes here. `new-session -A` -- which this path
    once emitted -- attaches when the session exists and CREATES when it does
    not, so a session that vanished between validation and execution silently
    produced an empty replacement pane wearing the retained identity while the
    user was told they had reattached.

    Only a new session can be given a locale (: `-e` against
    an existing session left the running shell's LC_CTYPE empty and
    per-character Vietnamese still mangled). Reattaching keeps the pane exactly
    as it is -- history, running processes and all -- which is a PRESERVATION
    property, not a repair: a pane created without a locale keeps mangling
    multi-byte input for its whole life.

    Because that limitation is invisible from the outside, the reattach path
    MEASURES it (probe_tmux_session_locale, read-only) and reports it as
    `legacy_tmux_locale` so the UI can say so. Nothing here tries to write to
    the existing session: injecting shell commands, sending keys or respawning
    the pane would destroy the very work the reattach exists to preserve.

    `utf8_locale` is the value resolved from the TARGET (resolve_tmux_utf8_locale
    over the probe's `locale -a`). Omitted, it falls back to the historical
    constant, so every existing caller and every unreadable probe behave exactly
    as before.
    """
    # `-u` on EVERY invocation: it is the CLIENT-side assertion that the
    # terminal speaks UTF-8, and without it tmux draws an underscore for every
    # multi-byte character regardless of the pane's locale.
    locale_value = utf8_locale or TMUX_UTF8_FALLBACK_LOCALE
    env_pairs = tuple((name, locale_value) for name in TMUX_UTF8_ENV_NAMES)
    env_args = ''
    prefix = ''
    if _tmux_supports_session_env(tmux_version):
        env_args = ''.join(f' -e {name}={value}'
                           for name, value in env_pairs)
    else:
        # Pre-3.2: no per-session env. The client-side prefix does set a fresh
        # server's environment, which is all a brand-new session needs.
        prefix = ('env ' + ' '.join(f'{name}={value}'
                                    for name, value in env_pairs) + ' ')

    # `-d` -- DETACHED. The create must not attach a client: an attached client
    # would be counted by `window-size smallest` forever (at its 80x24 default,
    # since nothing ever resizes it) and would pin every real device to that
    # size. Each browser socket attaches for itself instead.
    return (f'{prefix}tmux -u new-session -d{env_args} '
            f'-s {tmux_session_name}')


def build_tmux_attach_command(tmux_session_name):
    """The command ONE browser socket's view runs to become a tmux client.

    Exact-match target (`=name`) so a retained name can never act as a pattern
    and reach another session, and no create verb: attaching to a session that
    has gone exits non-zero and the view reports the failure rather than
    silently creating an empty replacement.
    """
    return 'tmux -u attach-session -t ' + shlex.quote(f'={tmux_session_name}')


def build_shell_env(utf8_locale=None):
    """The environment a NON-tmux shell asks for: same names, same value.

    The tmux path expresses UTF-8 as `new-session -e NAME=VALUE`; a plain shell
    has no tmux to carry it, so the identical pair is requested on the channel
    instead. One helper so the two paths can never drift into asking for
    different things -- the drift that WAS the defect when only tmux sessions
    were given a locale at all.
    """
    locale_value = utf8_locale or TMUX_UTF8_FALLBACK_LOCALE
    return {name: locale_value for name in TMUX_UTF8_ENV_NAMES}


# ── Why the channel `env` request is NOT a proof, and what is still missing ──
#
# `channel.update_environment` sends SSH `env` requests, and RFC 4254 sends them
# with want_reply=False. A server that does not want them drops them and tells
# the client nothing at all -- paramiko's own docstring says so. So:
#
#   * OpenSSH refuses every name absent from AcceptEnv (default LC_*, so LANG
#     never arrives, and on many builds not even LC_CTYPE).
#   * tailscaled -- the server that HAS the defect -- implements its own SSH and
#     is free to ignore `env` entirely.
#
# Nothing in the reply stream distinguishes "applied" from "silently dropped".
# The request is therefore kept (it is free, and on an sshd that lists LC_CTYPE
# in AcceptEnv it does work) but it is NOT recorded as a proof: no code here
# claims the non-tmux shell has UTF-8.
#
# The exec-launched login shell. The locale rides INSIDE the exec'd
# command line -- `exec env LANG=... LC_CTYPE=... <shell> -l` -- so a server
# that silently drops SSH `env` requests (tailscaled) cannot strip it. `exec`
# replaces the wrapper shell that runs the command, so the account shell starts
# exactly once and its own `-l` gives login semantics: profiles are sourced
# once, by the shell itself, and nothing user-visible is written to the
# terminal. Shells whose `-l` semantics are not proven are never guessed at:
# the builder returns None and the caller falls back to the shipped
# invoke_shell launch, which degrades to what shipped, never worse.

# Basenames whose `-l` login semantics are proven. Anything else (fish, csh,
# tcsh, nologin, false, ...) is declined.
LOGIN_SHELL_BASENAMES = frozenset(
    ('bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh'))

# One safe token only: no quotes, spaces, $, newlines or metacharacters, so the
# single quotes added below cannot be escaped out of.
_LOGIN_LOCALE_RE = re.compile(r'[A-Za-z0-9._@=+-]+\Z')
# Absolute path, safe characters only. `..` is rejected outright so the path
# cannot climb out of the directory it names.
_LOGIN_SHELL_PATH_RE = re.compile(r'/[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*\Z')


def build_login_shell_command(utf8_locale, login_shell):
    """The exec'd command line that launches a proven POSIX shell with UTF-8.

    Returns None -- never a command -- when the locale is not one safe token,
    the shell is not an absolute path of safe characters, or the shell's `-l`
    semantics are unproven. The caller must then fall back to invoke_shell and
    report UTF-8 as unverified.
    """
    if not isinstance(utf8_locale, str) or not utf8_locale:
        return None
    if not _LOGIN_LOCALE_RE.fullmatch(utf8_locale):
        return None
    if not isinstance(login_shell, str) or not login_shell:
        return None
    if '..' in login_shell:
        return None
    if not _LOGIN_SHELL_PATH_RE.fullmatch(login_shell):
        return None
    if login_shell.rsplit('/', 1)[-1] not in LOGIN_SHELL_BASENAMES:
        return None
    env_args = ' '.join(f"{name}='{utf8_locale}'"
                        for name in TMUX_UTF8_ENV_NAMES)
    return f"exec env {env_args} '{login_shell}' -l"


def open_shell_channel(client, transport, utf8_locale=None,
                       term='xterm-256color', width=80, height=24,
                       login_shell=None):
    """One interactive shell channel that asks for UTF-8 before the shell starts.

    WHY THIS EXISTS. The locale fix used to live entirely inside the `use_tmux`
    branch, so a session with tmux off got no locale request at all. On a
    Tailscale target that is the broken case in full: tailscaled serves SSH
    itself and applies no pam_env, so the shell inherits LANG= empty and
    LC_CTYPE=POSIX (charmap ANSI_X3.4-1968) and readline destroys per-character
    multi-byte input -- the exact shape an IME commit has. OpenSSH sshd on the
    same host reads /etc/default/locale through pam_env and hands out
    en_US.UTF-8 for free, which is why the same profile behaved differently per
    transport.

    The request is made on the CHANNEL, before invoke_shell: the server applies
    `env` to the process it is about to start, and nothing can retrofit a shell
    that is already running. paramiko's `client.invoke_shell(environment=...)`
    cannot be used -- it accepts the keyword and never sends it (verified against
    the installed paramiko/client.py: the body opens a session, calls get_pty and
    invoke_shell, and drops the dict).

    IT IS A REQUEST, NOT A GUARANTEE, and this code does not pretend otherwise:
    want_reply=False means a refusal is indistinguishable from success, so no
    "locale applied" state is derived from it. The proof-carrying launch is the
    exec'd login shell (see build_login_shell_command): its locale rides inside
    the command line, which an env-ignoring server cannot strip.

    FALLBACK IN LAYERS, because a server is free to refuse: a raise on the env
    request is caught and the shell still starts; a failed channel open falls back
    to client.invoke_shell; no usable transport does the same. Connecting NEVER
    depends on the locale request succeeding.

    When `login_shell` names a proven POSIX shell, the launch is instead
    get_pty -> exec_command(build_login_shell_command(...)): the locale travels
    inside the exec'd command line, which an env-ignoring server (tailscaled)
    still runs, and no separate `env` request is made. An unproven shell keeps
    the shipped launch exactly: env request + invoke_shell.
    """
    login_command = build_login_shell_command(utf8_locale, login_shell)
    if transport is not None:
        channel = None
        try:
            channel = transport.open_session()
            if login_command is not None:
                channel.get_pty(term, width, height)
                channel.exec_command(login_command)
                return channel
            try:
                channel.update_environment(build_shell_env(utf8_locale))
            except Exception as env_error:
                # Refused, not fatal: the shell is still worth having, and this
                # is the documented behaviour of a restrictive AcceptEnv.
                log_debug("Shell locale env rejected by server",
                          error=str(env_error))
            channel.get_pty(term, width, height)
            channel.invoke_shell()
            return channel
        except Exception as shell_error:
            log_debug("Falling back to client.invoke_shell",
                      error=str(shell_error))
            if channel is not None:
                try:
                    channel.close()
                except Exception:
                    pass
    return client.invoke_shell(term=term, width=width, height=height)


def probe_target_capabilities(transport):
    """The ONE exec round trip every session makes now, tmux or not.

    Returns ``(tmux_available, tmux_version, utf8_locale, login_shell)``.

    It used to run only inside the `use_tmux` branch, which is why a non-tmux
    session had no resolved locale to ask for. The locale half is what decides
    whether multi-byte input survives, and that question does not depend on
    tmux, so the probe is shared.

    W13-A1 discovery: the SAME round trip also answers the account's login
    shell (`getent passwd "$(id -u)"`), strictly validated by
    parse_login_shell_from_getent. No extra round trip: the discovery rides on
    the probe every connect already makes, and a host whose answer fails
    validation (or has no getent) simply contributes None -- the shipped
    invoke_shell fallback, never worse.

    Any failure degrades to ``(False, None, TMUX_UTF8_FALLBACK_LOCALE, None)``:
    a host that answers nothing behaves exactly as it did before host-adaptive
    resolution existed, and never worse.
    """
    probe_output = b''
    exit_status = 1
    probe_channel = None
    try:
        probe_channel = transport.open_session()
        probe_channel.exec_command(TMUX_PROBE_COMMAND)
        probe_channel.settimeout(3.0)
        try:
            while len(probe_output) < TMUX_PROBE_MAX_BYTES:
                chunk = probe_channel.recv(4096)
                if not chunk:
                    break
                probe_output += chunk
        except Exception:
            pass
        exit_status = probe_channel.recv_exit_status()
    except Exception as probe_error:
        log_debug("Target capability probe failed", error=str(probe_error))
        return False, None, TMUX_UTF8_FALLBACK_LOCALE, None
    finally:
        if probe_channel is not None:
            try:
                probe_channel.close()
            except Exception:
                pass

    locale_listing, passwd_entry, tmux_banner = split_tmux_probe_output(
        probe_output)
    return (exit_status == 0, _parse_tmux_version(tmux_banner),
            resolve_tmux_utf8_locale(locale_listing),
            parse_login_shell_from_getent(passwd_entry))


# Read-only interrogation of ONE existing tmux session's environment. `-t '=name'`
# is tmux's exact-match form, so the name can never act as a pattern.
TMUX_SESSION_LOCALE_PROBE = "tmux show-environment -t {target} LC_CTYPE 2>&1"


def parse_tmux_session_locale(output):
    """True / False / None from `show-environment -t <s> LC_CTYPE` output.

    True  -- the session carries an LC_CTYPE naming a UTF-8 charmap, so a pane
             started in it handles multi-byte input.
    False -- tmux answered "unknown variable", or named a non-UTF-8 value: this
             is a LEGACY pane, created before the locale fix, and reattaching to
             it cannot repair it.
    None  -- the question was not answered. Never guessed either way.
    """
    text = (output or '').strip()
    if not text:
        return None
    if 'unknown variable' in text.lower():
        return False
    for line in text.splitlines():
        line = line.strip()
        if line == '-LC_CTYPE':
            # tmux's explicitly-unset form: the variable is removed from the
            # session environment, which is the same story as never having it.
            return False
        if line.startswith('LC_CTYPE='):
            value = line.split('=', 1)[1].strip()
            if not value:
                return False
            return 'utf' in value.lower()
    return None


def probe_tmux_session_locale(transport, tmux_session_name):
    """Does this EXISTING tmux session carry a UTF-8 LC_CTYPE?

    READ-ONLY BY CONSTRUCTION. `show-environment` prints one variable: it does
    not attach, resize, send input, respawn a pane, restart a process or kill
    anything. Nothing here mutates the user's session.

    It exists because a pane created before the locale fix CANNOT be repaired in
    place -- `-e` on `new-session -A` is a measured no-op against a session that
    already exists (see build_tmux_command). Reattaching such a pane is still the
    right thing to do (it is the user's work, history and running processes), but
    the product must SAY that multi-byte input stays limited in it rather than
    reattach silently and let Vietnamese fail again. Answering that honestly
    needs a measurement, not an assumption.

    Deliberately NOT a repair attempt. `set-environment` would change the
    session environment for FUTURE panes only, and would still be a write to a
    live session the user owns; it cannot fix the running shell, which is the
    reported symptom. So this reads and reports, and the fix for a legacy pane
    remains a NEW session -- which is Reset's job, and is why Reset stays a
    separate, explicitly destructive action instead of being folded in here.

    Returns True / False / None; None means unanswered.
    """
    if transport is None or not tmux_session_name:
        return None
    channel = None
    try:
        channel = transport.open_session()
        channel.settimeout(3.0)
        channel.exec_command(TMUX_SESSION_LOCALE_PROBE.format(
            target=shlex.quote(f'={tmux_session_name}')))
        out = b''
        try:
            while len(out) < 4096:
                chunk = channel.recv(1024)
                if not chunk:
                    break
                out += chunk
        except Exception:
            pass
        return parse_tmux_session_locale(out.decode('utf-8', 'replace'))
    except Exception as probe_error:
        log_debug("tmux session locale probe failed",
                  tmux_session=tmux_session_name, error=str(probe_error))
        return None
    finally:
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass


def probe_tmux_session_locale_with_retry(transport, tmux_session_name,
                                         attempts=3, delay=0.2):
    """The same read-only probe, for a session that was JUST created.

    `new-session` is issued on the interactive channel and the server needs a
    moment to have it; asking once, immediately, would answer None for a session
    that is perfectly fine and is merely half a tick from existing. So the probe
    is retried a few times, and only a definite answer (True/False) short-circuits
    -- an unanswered probe stays None rather than being rounded to False.
    """
    answer = None
    for attempt in range(max(1, attempts)):
        answer = probe_tmux_session_locale(transport, tmux_session_name)
        if answer is not None:
            return answer
        if attempt + 1 < attempts:
            time.sleep(delay)
    return answer


def tmux_session_exists(transport, tmux_session_name):
    """True / False / None: does this EXACT tmux session exist right now?

    READ-ONLY BY CONSTRUCTION: ``has-session`` inspects and never mutates.
    ``-t '=name'`` is tmux's exact-match form, so the name can never act as a
    pattern or reach any other session.

    W13-B5 exists because ``new-session -A`` has two behaviours: attach when
    the session exists, CREATE when it does not. A reconnect's name is
    validated against the saved session BEFORE the transport is built, but the
    session can vanish in between -- and then the -A command the user asked to
    REATTACH silently creates an empty replacement under the retained
    session's identity. The caller must verify existence after the exec and
    fail closed when it is not provably True: None (unanswered) is treated
    exactly like False, never like success.
    """
    if transport is None or not tmux_session_name:
        return None
    channel = None
    try:
        channel = transport.open_session()
        channel.settimeout(3.0)
        channel.exec_command(
            'tmux has-session -t '
            + shlex.quote(f'={tmux_session_name}') + ' 2>/dev/null')
        return channel.recv_exit_status() == 0
    except Exception as probe_error:
        log_debug("tmux existence check failed",
                  tmux_session=tmux_session_name, error=str(probe_error))
        return None
    finally:
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass


class TailscaleSSHAuthStrategy(AuthStrategy):
    """Authenticate through Tailscale SSH without user-managed credentials."""

    def __init__(self, username):
        super().__init__(ssh_config=None)
        self.username = username

    def get_sources(self):
        yield NoneAuth(self.username)


class PersistentHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """Secure host key policy with logging and audit trail."""
    def __init__(self, known_hosts_path):
        self.known_hosts_path = Path(known_hosts_path)

    def missing_host_key(self, client, hostname, key):
        import binascii

        key_type = key.get_name()
        key_fingerprint = binascii.hexlify(key.get_fingerprint()).decode('utf-8')
        key_fingerprint_formatted = ':'.join([key_fingerprint[i:i+2] for i in range(0, len(key_fingerprint), 2)])

        log_warning(f"SECURITY: New SSH host key detected",
                    host=hostname, key_type=key_type, fingerprint=key_fingerprint_formatted)

        host_keys = client.get_host_keys()
        host_keys.add(hostname, key.get_name(), key)
        self.known_hosts_path.parent.mkdir(parents=True, exist_ok=True)

        host_keys.save(str(self.known_hosts_path))
        import os
        os.chmod(str(self.known_hosts_path), 0o600)

        log_info(f"Host key stored", path=str(self.known_hosts_path))

def _exec_on_transport(transport, command, timeout=10.0):
    """Run one short command on a transport that has NO session record yet.

    `_exec_tmux_control` is the normal way to run a tmux command, but it starts
    from a session_id and this runs BEFORE the session is registered -- the
    detached `new-session` in _build_transport. Same shape as that helper: its
    own exec channel, a bounded wait for the exit status, no PTY (nothing here
    needs a terminal), and the channel is always closed.

    Returns ``(ok, error)``. A non-zero exit is a failure with tmux's own
    stderr as the reason, because "the session was not created" must never be
    mistaken for success.
    """
    channel = None
    try:
        channel = transport.open_session(timeout=timeout)
        channel.settimeout(timeout)
        channel.exec_command(command)
        deadline = time.time() + timeout
        while not channel.exit_status_ready() and time.time() < deadline:
            time.sleep(0.05)
        if not channel.exit_status_ready():
            return False, "Timed out running a tmux command"
        status = channel.recv_exit_status()
        if status != 0:
            err = ''
            try:
                err = channel.recv_stderr(4096).decode('utf-8', 'replace')
            except Exception:
                pass
            return False, (err.strip() or f'exit status {status}')
        return True, None
    except Exception as exc:
        return False, str(exc)
    finally:
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass


def _build_transport(host, port, username, password=None, key_path=None, key_content=None,
                     proxy_jump_host=None, proxy_jump_port=None, proxy_jump_username=None,
                     proxy_jump_password=None, proxy_jump_key_content=None,
                     use_tmux=False, reconnect_tmux_name=None,
                     auth_type='password', login_shell=None):
    """Establish one SSH transport and its terminal channel.

    This is the shared "connect" step for BOTH ordinary sessions and
    prepare-and-swap reconnects. It never touches the session registry or
    output readers, and never starts a reader thread, so it can build a NEW
    transport while an old one is still serving the session. On any failure it
    closes what it opened and returns (None, error); it reserves a capacity
    slot for the duration of the connection attempt only.
    """
    global _pending_connections

    bastion_client = None
    client = None
    slot_reserved = False
    try:
        with sessions_lock:
            if len(sessions) + _pending_connections >= config.MAX_SESSIONS:
                return None, "Maximum number of sessions reached"
            _pending_connections += 1
            slot_reserved = True

        # Optional ProxyJump: connect to the bastion first, then tunnel to the target.
        sock = None
        if proxy_jump_host:
            bastion_client = paramiko.SSHClient()
            if config.KNOWN_HOSTS_FILE.exists():
                bastion_client.load_host_keys(str(config.KNOWN_HOSTS_FILE))
            bastion_client.set_missing_host_key_policy(PersistentHostKeyPolicy(config.KNOWN_HOSTS_FILE))

            # `timeout` COVERS ONLY THE TCP CONNECT. paramiko keeps the banner
            # exchange and the auth negotiation on separate clocks
            # (banner_timeout, auth_timeout) and this code set neither, so a peer
            # that accepts the socket and then stalls fell back to paramiko's own
            # generous defaults.
            #
            # Measured on the deployed build against a peer that answers the TCP
            # connect instantly and then refuses to negotiate (the container's
            # network namespace is shared with tailscale-gateway, so a tailnet IP
            # on port 22 reaches Tailscale's OWN ssh server, banner
            # `SSH-2.0-Tailscale`, which does not do password auth): the client
            # received NOTHING for 30.5 seconds, then `ssh_error`. The whole time
            # The modal stayed open with a spinner. That silence is the user's
            # "I press Connect and nothing happens" -- the attempt was alive, just
            # mute for half a minute.
            #
            # Both clocks are pinned to the same budget as the TCP connect: a peer
            # that will not send a banner or will not finish auth inside the window
            # the user already accepted for connecting is a failure worth reporting
            # NOW, not in half a minute.
            bastion_auth = {
                'hostname': proxy_jump_host,
                'port': proxy_jump_port or 22,
                'username': proxy_jump_username,
                'timeout': config.SSH_CONNECT_TIMEOUT,
                'banner_timeout': config.SSH_CONNECT_TIMEOUT,
                'auth_timeout': config.SSH_CONNECT_TIMEOUT,
                'look_for_keys': False,
                'allow_agent': False,
            }
            if proxy_jump_key_content:
                bastion_auth['pkey'] = _load_private_key(proxy_jump_key_content)
            elif proxy_jump_password:
                bastion_auth['password'] = proxy_jump_password
            else:
                return None, "Jump host authentication method not provided"

            bastion_client.connect(**bastion_auth)
            bastion_transport = bastion_client.get_transport()
            if bastion_transport:
                bastion_transport.set_keepalive(30)
            sock = bastion_transport.open_channel(
                'direct-tcpip', (host, port), ('127.0.0.1', 0)
            )
            log_info("Jump host connection established", bastion=proxy_jump_host)

        client = paramiko.SSHClient()
        if config.KNOWN_HOSTS_FILE.exists():
            client.load_host_keys(str(config.KNOWN_HOSTS_FILE))
        client.set_missing_host_key_policy(PersistentHostKeyPolicy(config.KNOWN_HOSTS_FILE))

        # Same two clocks as the jump-host block above, and for the same measured
        # reason: `timeout` alone left a stalling peer mute for 30.5 seconds.
        auth_kwargs = {
            'hostname': host,
            'port': port,
            'username': username,
            'timeout': config.SSH_CONNECT_TIMEOUT,
            'banner_timeout': config.SSH_CONNECT_TIMEOUT,
            'auth_timeout': config.SSH_CONNECT_TIMEOUT
        }
        if sock:
            auth_kwargs['sock'] = sock

        if auth_type == 'tailscale':
            auth_kwargs['auth_strategy'] = TailscaleSSHAuthStrategy(username)
        else:
            auth_kwargs['look_for_keys'] = False
            auth_kwargs['allow_agent'] = False
            if key_content:
                auth_kwargs['pkey'] = _load_private_key(key_content)
            elif key_path:
                auth_kwargs['key_filename'] = key_path
            elif password:
                auth_kwargs['password'] = password
            else:
                return None, "No authentication method provided"

        client.connect(**auth_kwargs)

        transport = client.get_transport()
        if transport:
            transport.set_keepalive(30)

        # ONE probe round trip for EVERY session, tmux or not. The `locale -a`
        # half decides whether multi-byte input survives, and that question is
        # not tmux's: a non-tmux shell needs the same locale asked for on its
        # own channel (open_shell_channel). Running the probe only inside the
        # tmux branch is what left non-tmux Tailscale sessions mangling Telex.
        tmux_available, tmux_version, utf8_locale, discovered_shell = \
            probe_target_capabilities(transport)

        # Discovery contract: a caller-supplied `login_shell` wins
        # as-is (reconnect/restore/cache paths carry the validated value);
        # otherwise the probe's VALIDATED answer is persisted for EVERY
        # successful connection, tmux or not. Consuming it is launch-shaped,
        # persisting it is not: the non-tmux branch and the tmux-unavailable
        # fallback launch the exec'd login shell with it, and a successful
        # tmux session still caches it on the record so any later plain-shell
        # launch of the same logical session (a reconnect whose host lost
        # tmux, a restored candidate) reuses the validated value instead of
        # discovering again. The tmux launch itself NEVER consumes the shell:
        # tmux owns the launch (its own `-e` locale contract). This is also
        # the performance contract: discovery rides inside the one existing
        # probe round trip -- no second round trip, never one per channel.
        if login_shell is None:
            login_shell = discovered_shell

        tmux_session_name = None
        legacy_tmux_locale = None
        if use_tmux:
            safe_host = host.replace('.', '_').replace(':', '_').replace('-', '_')
            safe_user = username.replace('.', '_').replace('-', '_')
            if reconnect_tmux_name:
                # The reattach keeps the name EXACTLY so the user's pane,
                # history and running processes come back untouched. No create
                # command is built for it at all, so a name that stopped
                # existing produces a failure, never a replacement.
                tmux_session_name = reconnect_tmux_name
            else:
                unique_suffix = uuid.uuid4().hex[:8]
                tmux_session_name = f"{config.TMUX_SESSION_PREFIX}_{safe_user}_{safe_host}_{port}_{unique_suffix}"

            log_info(f"Using tmux persistent session", tmux_session=tmux_session_name, host=f"{host}:{port}")

            if not tmux_available:
                if reconnect_tmux_name:
                    # FAIL CLOSED. A retained reattach whose host has no tmux
                    # cannot be honoured, and the shipped fallback -- silently
                    # opening a plain shell -- is the exact fail-open B5
                    # forbids: the user asked to come back to their pane and
                    # would instead be handed a bare shell wearing the
                    # session's name, with the retained tmux session (if it
                    # still exists on a host that merely lost tmux from PATH)
                    # left behind unreachable. Only a BRAND-NEW connection is
                    # allowed to degrade to a shell.
                    log_warning(
                        "Refusing a tmux reattach on a host without tmux",
                        host=f"{host}:{port}",
                        tmux_session=reconnect_tmux_name)
                    return None, TMUX_REATTACH_UNAVAILABLE_ERROR
                log_warning(f"tmux not found on target host, falling back to regular shell",
                           host=f"{host}:{port}")
                tmux_session_name = None
                use_tmux = False
                channel = open_shell_channel(client, transport,
                                             utf8_locale=utf8_locale,
                                             login_shell=login_shell)
                channel.settimeout(0.1)
            else:
                # The retained session must be PROVEN to exist before
                # the attach runs. The name was validated against the DB row
                # before this transport was built, but the session can die in
                # between -- and the attach-only command below cannot recreate
                # it, so without this check the user would get an attach that
                # exits immediately and a session record claiming a tmux pane
                # that is gone. Only a definite True proceeds: False and None
                # (unanswered probe) both fail closed, and nothing has been
                # created, swapped or retired at this point.
                if reconnect_tmux_name:
                    if tmux_session_exists(
                            transport, reconnect_tmux_name) is not True:
                        log_warning(
                            "Refusing a tmux reattach: the retained session "
                            "does not exist on the host",
                            host=f"{host}:{port}",
                            tmux_session=reconnect_tmux_name)
                        return None, TMUX_REATTACH_GONE_ERROR

                # A REATTACH inherits the pane's own environment, and `-e`
                # cannot change it (measured: no-op against an existing
                # session). So ask the session what it has, read-only, and
                # report it: a pane created before the locale fix stays a
                # legacy pane, and the UI must say so rather than promise UTF-8
                # it cannot deliver.
                #
                # TRI-STATE, and it must stay one. True = measured legacy,
                # False = measured fine, None = the question was not answered
                # (no channel, a timeout, unparseable output). Collapsing None
                # to False would report an UNKNOWN pane as verified-good, which
                # is the one answer that lets Vietnamese fail silently again.
                if reconnect_tmux_name:
                    has_utf8 = probe_tmux_session_locale(
                        transport, reconnect_tmux_name)
                    # None must SURVIVE the conversion. `has_utf8 is False`
                    # alone would map an unanswered probe to "not legacy", i.e.
                    # report an UNKNOWN pane as verified-good -- the one answer
                    # that lets Vietnamese fail silently again.
                    legacy_tmux_locale = (
                        None if has_utf8 is None else (has_utf8 is False))
                    if legacy_tmux_locale is True:
                        log_info("Reattaching a pre-locale tmux session; "
                                 "multi-byte input stays limited in it",
                                 tmux_session=reconnect_tmux_name)
                    elif legacy_tmux_locale is None:
                        log_debug("Could not determine the tmux session's "
                                  "locale; reporting it as unknown",
                                  tmux_session=reconnect_tmux_name)

                # NO session-level client is launched here.
                #
                # A brand-new connection CREATES the session detached; a
                # reattach was just proven to exist and needs no command at
                # all. Either way this transport ends up holding a tmux
                # SESSION and no attached client, and every browser socket
                # attaches for itself (open_session_view).
                #
                # An attached client launched here would be permanent and
                # invisible: nothing resizes it, so `window-size smallest`
                # would pin every real device to its 80x24 default forever.
                if not reconnect_tmux_name:
                    created_ok, created_error = _exec_on_transport(
                        transport,
                        build_tmux_command(tmux_session_name, tmux_version,
                                           utf8_locale=utf8_locale))
                    if not created_ok:
                        log_warning("Could not create the tmux session",
                                    tmux_session=tmux_session_name,
                                    error=created_error)
                        return None, "Failed to create the tmux session"
                channel = None

                # A FRESH session is MEASURED too, not assumed good.
                #
                # It used to be marked legacy=False by construction, on the
                # reasoning that "the command being built is the answer". That is
                # true only on tmux >= 3.2, where `-e` sets the SESSION's own
                # environment. Below that -- and on any host whose `tmux -V` was
                # unreadable, which takes the same branch -- the fallback is a
                # CLIENT-side `env` prefix, and a tmux client's environment is
                # inherited by the pane only when that client is the one that
                # STARTS the server. Attach to a server that already exists and
                # the prefix is inert: the pane comes up with the old server's
                # environment and mangles multi-byte input exactly like a legacy
                # pane, while the session was reported as verified-good.
                #
                # So the created session is asked what it actually has, with the
                # same read-only probe the reattach uses. `new-session` may need
                # a moment before the session is addressable, hence the short
                # retry; an unanswered probe stays None (unknown), never False.
                if not reconnect_tmux_name:
                    has_utf8 = probe_tmux_session_locale_with_retry(
                        transport, tmux_session_name)
                    legacy_tmux_locale = (
                        None if has_utf8 is None else (has_utf8 is False))
                    if legacy_tmux_locale is True:
                        log_warning(
                            "A NEW tmux session came up without a UTF-8 "
                            "LC_CTYPE; multi-byte input is limited in it",
                            tmux_session=tmux_session_name,
                            tmux_version=str(tmux_version))
                    elif legacy_tmux_locale is None:
                        log_debug("Could not measure the new tmux session's "
                                  "locale; reporting it as unknown",
                                  tmux_session=tmux_session_name)
        else:
            # When a proven POSIX login shell is supplied, the launch is
            # the exec'd command line -- the locale rides inside it, so an
            # env-ignoring server (tailscaled) cannot strip it. Absent or
            # unproven, this is exactly the shipped shape: env request +
            # invoke_shell (see open_shell_channel).
            channel = open_shell_channel(client, transport,
                                         utf8_locale=utf8_locale,
                                         login_shell=login_shell)
            channel.settimeout(0.1)

        # Hand off ownership: the caller now owns client/channel/bastion.
        result = {
            'client': client,
            'channel': channel,
            'bastion_client': bastion_client,
            'use_tmux': use_tmux,
            'tmux_session_name': tmux_session_name,
            # The locale actually asked for, and whether the pane we attached to
            # predates it. Both travel to the session record so the UI can be
            # honest about a legacy pane instead of inferring.
            'utf8_locale': utf8_locale,
            'legacy_tmux_locale': legacy_tmux_locale,
            # The proven login shell this transport launched with (or None):
            # carried so a prepare-and-swap reconnect launches the SAME shape.
            'login_shell': login_shell,
        }
        client = None
        bastion_client = None
        return result, None

    except paramiko.AuthenticationException:
        return None, "Authentication failed - invalid credentials"
    except paramiko.SSHException as e:
        # Detail to the server log only; the client gets a generic message so
        # low-level errors cannot be used to probe remote hosts/ports.
        log_warning("SSH connection failed", host=f"{host}:{port}", error=str(e))
        return None, "SSH connection failed"
    except socket.timeout:
        return None, "Connection timeout - host unreachable"
    except socket.error as e:
        log_warning("SSH network error", host=f"{host}:{port}", error=str(e))
        return None, "Network error - could not reach host"
    except Exception as e:
        log_error("SSH connection unexpected error", host=f"{host}:{port}", error=str(e))
        return None, "Connection failed"
    finally:
        if slot_reserved:
            with sessions_lock:
                _pending_connections -= 1

        # Close whatever we opened but could not hand off.
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        if bastion_client is not None:
            try:
                bastion_client.close()
            except Exception:
                pass


def create_ssh_connection(host, port, username, password=None, key_path=None, key_content=None,
                          socketio_instance=None, app=None, user_id=None,
                          proxy_jump_host=None, proxy_jump_port=None, proxy_jump_username=None,
                          proxy_jump_password=None, proxy_jump_key_content=None,
                          use_tmux=False, reconnect_tmux_name=None,
                          auth_type='password', startup_commands='',
                          display_name=None, login_shell=None):
    """
    Create a new SSH connection and return session ID.

    Args:
        host: SSH server hostname
        port: SSH server port
        username: SSH username
        password: Password for authentication (optional)
        key_path: Path to SSH key file - DEPRECATED, use key_content instead
        key_content: Decrypted SSH private key content (preferred)
        socketio_instance: SocketIO instance for output streaming
        app: Flask app instance
        user_id: User ID for session tracking
        proxy_jump_*: Optional jump host (bastion) connection parameters
        auth_type: Target authentication method (password, key, or tailscale)
    """
    # S2 step 6 (R6-A): per-user ceiling BEFORE any transport work or global
    # reservation. Count this user's live registry entries under the lock.
    # Distinct error string so the client can tell per-user from global.
    # _build_transport has no user_id (shared with prepare-and-swap), so the
    # per-user check lives here, where user_id is known.
    if user_id is not None:
        with sessions_lock:
            user_live = sum(
                1 for s in sessions.values()
                if str(s.get('user_id')) == str(user_id))
            if user_live >= config.MAX_SESSIONS_PER_USER:
                return None, "Per-user session limit reached"

    transport_result, error = _build_transport(
        host, port, username,
        password=password, key_path=key_path, key_content=key_content,
        proxy_jump_host=proxy_jump_host, proxy_jump_port=proxy_jump_port,
        proxy_jump_username=proxy_jump_username,
        proxy_jump_password=proxy_jump_password,
        proxy_jump_key_content=proxy_jump_key_content,
        use_tmux=use_tmux, reconnect_tmux_name=reconnect_tmux_name,
        auth_type=auth_type, login_shell=login_shell)
    if error:
        return None, error

    client = transport_result['client']
    channel = transport_result['channel']
    bastion_client = transport_result['bastion_client']
    use_tmux = transport_result['use_tmux']
    tmux_session_name = transport_result['tmux_session_name']

    session_id = str(uuid.uuid4())
    # Immutable owner token for SFTP-cache ownership. Assigned ONCE per
    # session registration; survives reuse of the session_id by a different
    # session object. Threaded through claim_reader_death parts and
    # _close_retired_parts so a retired session A whose id was reused by B can
    # never close B's SFTP handle or lock.
    sftp_owner_token = uuid.uuid4()

    time.sleep(0.1)

    with sessions_lock:
        # S2 step 6: re-check BOTH ceilings at registration. The reserve at
        # _build_transport only saw the global count; between reserve and
        # register another of this user's sessions may have landed.
        user_live = 0
        if user_id is not None:
            user_live = sum(
                1 for s in sessions.values()
                if str(s.get('user_id')) == str(user_id))
        if len(sessions) >= config.MAX_SESSIONS:
            capacity_reached = True
            capacity_error = "Maximum number of sessions reached"
        elif user_id is not None and user_live >= config.MAX_SESSIONS_PER_USER:
            capacity_reached = True
            capacity_error = "Per-user session limit reached"
        else:
            capacity_reached = False
            capacity_error = None
            sessions[session_id] = {
                'client': client,
                'channel': channel,
                'host': host,
                'port': port,
                'username': username,
                'user_id': user_id,
                'connected': True,
                'last_activity': time.time(),
                # S2 rev6: HUMAN interaction, kept separate from last_activity.
                # last_activity is connectivity/output liveness -- it is bumped
                # by every output byte and by the transport swap, and it used to
                # be bumped by the automatic 60s keep_alive as well, which made
                # idle expiry unreachable for any user with a tab open. Only
                # genuine user acts touch last_interaction: send_ssh_input and
                # the exit-scroll control action, with session creation as the
                # bootstrap value. The idle reaper reads THIS field.
                'last_interaction': time.time(),
                'bastion_client': bastion_client,
                'proxy_jump_host': proxy_jump_host,
                'auth_type': auth_type,
                'use_tmux': use_tmux,
                'tmux_session_name': tmux_session_name,
                'display_name': display_name,
                # The UTF-8 locale this transport asked for, and whether the
                # tmux pane it attached to predates the locale fix. Carried on
                # the session so the snapshot can tell the UI honestly, instead
                # of the UI guessing from a name.
                'utf8_locale': transport_result.get('utf8_locale'),
                'legacy_tmux_locale': transport_result.get(
                    'legacy_tmux_locale'),
                # The proven login shell this session's shell channel
                # launched with (None when it used the shipped invoke_shell
                # shape). Carried so a reconnect swaps in the SAME shape.
                'login_shell': transport_result.get('login_shell'),
                # The LOGICAL session id is stable for the user's whole
                # session; only the transport underneath it is replaceable via
                # swap_session_transport.
                'transport_generation': 0,
                # The gap buffer is a NON-TMUX concern only: a plain shell has
                # no scrollback anywhere else, so the bytes emitted between two
                # page loads have to be kept here to be replayed. A tmux
                # session's history lives in tmux and a fresh attach repaints
                # the screen, so its reader never appends here.
                'output_buffer': [],
                'output_buffer_size': 0,
                'output_buffer_max': 512000,  # 512KB max buffer
                # ONE TMUX CLIENT PER BROWSER SOCKET (see the module header):
                # socket_sid -> view record. Empty until a socket asks to
                # display this session; a detached session is a normal state.
                'views': {},
                # Immutable SFTP-cache ownership token.
                '_sftp_owner_token': sftp_owner_token,
            }

    if capacity_reached:
        _close_transport_parts(client, channel, bastion_client)
        return None, capacity_error

    # ONE READER PER BYTE STREAM, and a tmux session has none at this point.
    #
    # A non-tmux session owns a single PTY channel, so its reader starts here and
    # publishes to the owner's room. A tmux session has no session-level client
    # at all: the bytes belong to each view, and read_view_output is started by
    # open_session_view when a browser socket actually attaches.
    if socketio_instance and app and channel is not None:
        thread = Thread(
            target=read_ssh_output,
            args=(session_id, socketio_instance, app),
            daemon=True
        )
        thread.start()

    if startup_commands and not reconnect_tmux_name:
        terminal_input = to_terminal_input(startup_commands).rstrip('\r') + '\r'
        delivered, _delivery_error = send_ssh_input(
            session_id, terminal_input, require_complete=True
        )
        if not delivered:
            close_session(session_id, kill_tmux=use_tmux)
            return None, "Connection failed"

    return session_id, None


def _close_transport_parts(client, channel, bastion_client):
    """Best-effort close of one transport's pieces; never raises."""
    for closer in (
        lambda: channel and channel.close(),
        lambda: client and client.close(),
        lambda: bastion_client and bastion_client.close(),
    ):
        try:
            closer()
        except Exception as e:
            log_debug(f"Error closing transport part", error=str(e))


def swap_session_transport(session_id, transport_result, socketio_instance=None, app=None):
    """W2 prepare-and-swap: replace a live session's transport atomically.

    ``transport_result`` is a READY transport from ``_build_transport`` (its
    tmux reattach already verified). The swap, under the session's own AUTHORITY
    lock, records the reader handoff, points the SAME logical session at the new
    client/channel, bumps transport_generation and clears the server-side gap
    buffer; then OUTSIDE the lock closes the old transport and starts a new
    output reader for the new one. The logical session_id, xterm, pane, display
    name and scrollback on the client are untouched.

    WHY THE AUTHORITY LOCK. The old reader can still hold output it read before
    the swap started, and it publishes under the very lock this swap takes. So for
    ONE session, publish and swap are totally ordered: the reader's
    validate-emit-append either completes first (bytes land while the old
    generation is still the authority, which is legitimate) or starts after the
    bump and is rejected. No stale chunk can interleave, and no stale event can be
    published after the swap.

    The lock is PER-SESSION: unrelated sessions never touch it, so one slow swap
    cannot stall every other connection. Lock order is authority-lock then
    sessions_lock; sessions_lock is held only to fetch the lock and to perform the
    registry mutation, never across any network call.
    """
    # Step 1 of the authority protocol: capture (expected_session, authority_lock).
    # The expected_session object is what makes the reused-id guard work: after
    # acquiring the lock we re-validate by OBJECT IDENTITY, so a session removed
    # and re-registered under the same id (a NEW dict) is detected and the swap
    # returns harmlessly rather than mutating the replacement under an orphan
    # lock.
    expected_session, authority_lock = _authority_claim_for(session_id)
    if expected_session is None:
        # Session vanished while the new transport was connecting: the new
        # transport is orphaned; caller must not leak it.
        return False, "Session no longer exists"

    # Step 2: serialize against THIS session's in-flight publication, close and
    # death claim. Nothing global is held here, so a blocked acquire stalls this
    # swap alone -- never another session.
    with authority_lock:
        with sessions_lock:
            # Step 3: RE-VALIDATE by exact identity, not just id presence.
            # Between the two acquisitions the session may have been closed, or
            # removed and re-registered under the same id as a NEW dict. The lock
            # we hold may therefore be an ORPHAN -- it belongs to a session that
            # is gone. Acting on stale state would install a transport for a
            # session that no longer exists, or worse, mutate a replacement
            # reusing the id. The identity check catches both.
            session = sessions.get(session_id)
            if session is None:
                return False, "Session no longer exists"
            if session is not expected_session:
                # Reused id: the session under this id is a DIFFERENT object.
                # Our lock is an orphan; touch nothing.
                return False, "Session no longer exists"
            if not session.get('connected'):
                return False, "Session is not connected"

            # The generation being RETIRED, captured before the bump: the flag
            # names the exact reader that owns the transport about to be closed,
            # so a reader of a LATER generation can neither consume it nor be
            # silenced by it.
            retiring_generation = session.get('transport_generation', 0)
            _mark_reader_handoff(session_id, retiring_generation)

            old_client = session['client']
            old_channel = session['channel']
            old_bastion = session.get('bastion_client')
            # The views belong to the OLD transport's channels. Their SIZES are
            # what must survive: the same sockets are still watching the same
            # panes, so each one is re-attached at the size it last reported
            # rather than waiting for the next fit to arrive.
            old_views = session.get('views') or {}
            view_sizes = [(sid, v.get('cols') or 80, v.get('rows') or 24)
                          for sid, v in old_views.items()]
            session['views'] = {}

            session['client'] = transport_result['client']
            session['channel'] = transport_result['channel']
            session['bastion_client'] = transport_result['bastion_client']
            session['use_tmux'] = transport_result['use_tmux']
            session['tmux_session_name'] = transport_result['tmux_session_name']
            # The replacement transport is the authority on both: it is the one
            # that asked for the locale and the one that measured the pane it
            # attached to.
            session['utf8_locale'] = transport_result.get('utf8_locale')
            session['legacy_tmux_locale'] = transport_result.get(
                'legacy_tmux_locale')
            # The replacement transport is equally authoritative on the launch
            # shape it used.
            session['login_shell'] = transport_result.get('login_shell')
            session['last_activity'] = time.time()
            new_generation = retiring_generation + 1
            session['transport_generation'] = new_generation
            # Gap buffer belongs to the OLD transport; the reattach repaint is
            # the new source of history. Keeping both would show old lines twice.
            session['output_buffer'] = []
            session['output_buffer_size'] = 0

    # The old clients are released through the NEW transport (the session
    # record already names it), so a Tailscale-served old transport cannot keep
    # them counted for the seconds it takes to notice the channel closes.
    for sid, view in list(old_views.items()):
        _detach_view(session_id, view, 'transport swapped')
    _close_transport_parts(old_client, old_channel, old_bastion)

    # A tmux session has no session-level channel, so only a NON-TMUX swap
    # starts a session reader. The generation is passed so the reader cannot
    # start consuming a successor's channel after the next swap.
    if socketio_instance and app and transport_result.get('channel') is not None:
        thread = Thread(
            target=read_ssh_output,
            args=(session_id, socketio_instance, app, new_generation),
            daemon=True
        )
        thread.start()

    # Re-attach every socket that was watching, at the size it last held. Each
    # view opens its own channel on the NEW transport, so the panes come back
    # without the client having to notice the swap at all.
    if socketio_instance and app and transport_result.get('use_tmux'):
        for sid, cols, rows in view_sizes:
            ok, view_error = open_session_view(
                session_id, sid, cols, rows, socketio_instance, app)
            if not ok:
                log_warning("Could not re-attach a view after a swap",
                            session_id=session_id, error=view_error)

    return True, None

def read_ssh_output(session_id, socketio_instance, app, transport_generation=0):
    """Background greenthread to continuously read SSH output and emit to client.

    IMPORTANT: Do NOT use select.select() on the paramiko channel here.
    Under eventlet, select.select() watches the transport socket FD, which
    conflicts with paramiko's own transport reader greenthread and any
    concurrent SFTP operations on the same transport. This causes SFTP
    operations to hang intermittently.

    Instead, use channel.recv() directly with a timeout. Paramiko's channel
    internally uses green-compatible Events (monkey-patched threading.Event)
    that properly yield to other greenthreads.

    W13: `transport_generation` is the generation this reader was STARTED for,
    and it is what makes the reader exact. Two things follow from it:

      * the reader binds to ITS OWN channel once and never re-reads
        session['channel'], so after a swap it cannot start consuming its
        successor's channel and split one byte stream between two threads;
      * every handoff question and the final consume are asked for this exact
        generation, so a reader can neither be silenced by nor steal the flag
        that belongs to a different one.

    A generation mismatch found at the top of the loop is itself the retirement
    signal: the swap already replaced this reader, whether or not its channel
    has noticed yet.
    """
    from datetime import datetime, timezone

    cached_room = None
    last_db_update = 0
    decoder = _stream_decoder()
    # Set once the loop establishes this reader really is the current one, so the
    # finally block can tell "I was replaced" from "I never started".
    superseded = False
    # The channel THIS reader owns, remembered for the atomic claim in the
    # finally block. It is captured on the first iteration and never re-read from
    # the registry, so the claim compares the object this thread actually read
    # from rather than whatever the id names later.
    bound_channel = None

    try:
        with app.app_context():
            from .models import SSHSession, db

            db_session = None
            for _attempt in range(30):
                db_session = SSHSession.query.filter_by(session_id=session_id).first()
                if db_session:
                    break
                time.sleep(0.1)

            if db_session:
                cached_room = f'user_{db_session.user_id}'

            if not cached_room:
                log_error(f"No DB session found for output reader", session_id=session_id)
                return

            while True:
                with sessions_lock:
                    if session_id not in sessions:
                        break
                    session = sessions[session_id]
                    if not session['connected']:
                        break
                    # The session has moved on to a newer transport: this reader
                    # is retired by definition, and must not read the successor's
                    # channel even once.
                    if session.get('transport_generation', 0) != transport_generation:
                        superseded = True
                        break
                    channel = session['channel']
                    # The SAME authority lock swap_session_transport,
                    # close_session and claim_reader_death take. Held around
                    # publication so all four are totally ordered for this
                    # session -- and it is per-session, so no other connection is
                    # affected by whatever happens inside it.
                    authority_lock = _session_authority_lock(session)
                    # Capture the EXACT session object whose lock we hold. The
                    # publish block re-validates by IDENTITY after acquiring the
                    # lock, so a reused id (a new dict under the same id) is
                    # detected and the chunk is dropped rather than published
                    # under an orphan lock.
                    expected_session = session
                    # Bound ONCE: after this the reader never adopts a channel it
                    # did not start with, and the finally-block claim can name the
                    # exact object it read from.
                    if bound_channel is None:
                        bound_channel = channel
                    elif channel is not bound_channel:
                        # The registry's generation still matches but the channel
                        # object changed: something replaced the transport without
                        # bumping the generation. Retire rather than read a
                        # channel this reader does not own.
                        superseded = True
                        break

                try:
                    data = channel.recv(32768)
                    if data:
                        import re as _re
                        decoded_data = decoder.decode(data)
                        # Filter Device Attributes responses (ESC[c sequences only).
                        # Bare-pattern regexes were removed because they corrupt
                        # legitimate output like "padding:0;color:red".
                        decoded_data = _re.sub(r'\x1b\[[?>]?[0-9;]*c', '', decoded_data)
                        if not decoded_data:
                            # Nothing to emit; skip
                            continue

                        now = time.time()
                        # ── ATOMIC PUBLISH, UNDER THE AUTHORITY LOCK ───────
                        #
                        # For ONE session, publication must be totally ordered
                        # against EVERY authority mutation -- swap, close and the
                        # exact-current death claim. A check-only fence leaves a
                        # window where this reader validates, the session is
                        # swapped or closed, and it then emits anyway: the
                        # terminal receives output for a transport that is gone,
                        # after the repaint (or after the close). A socket event
                        # cannot be recalled, so a later re-check is not a fix.
                        #
                        # All four operations take THIS session's authority lock,
                        # so while this publish holds it none of them can land.
                        #
                        # WHY THE GLOBAL LOCK IS NOT HELD ACROSS THE EMIT.
                        # Engine.IO's emit can block or synchronously enter
                        # cleanup paths; holding sessions_lock across it would
                        # stall every SSH session in the process. So:
                        #
                        #   authority_lock:                    (per-session)
                        #     sessions_lock: validate gen + channel identity
                        #     (sessions_lock RELEASED)
                        #     emit                              global lock free
                        #     sessions_lock: re-validate, append
                        #
                        # The authority lock is held throughout, so the emit is
                        # still ordered against swap/close/claim; only the global
                        # registry lock is released, which is what keeps unrelated
                        # sessions running (asserted by test).
                        with authority_lock:
                            with sessions_lock:
                                # Validate gen + channel identity AND that the
                                # session registered under this id is still the
                                # EXACT object whose lock we hold. A reused id
                                # registers a new dict; without this check a
                                # reader of the old session would publish under
                                # its orphan lock into the replacement's room.
                                if not _reader_is_current_locked(
                                        session_id, transport_generation, channel):
                                    superseded = True
                                elif not _session_still_expected_locked(
                                        session_id, expected_session):
                                    superseded = True

                            if not superseded:
                                # Publish through the ONE gated emit site.
                                # Before the announce gate existed this was a bare
                                # socketio_instance.emit, and on a fresh connect it
                                # fired into a client that did not yet know the
                                # session id -- measured 3 of 3 connects, one
                                # 58-byte frame each, discarded by writeOutputNow
                                # with console.error
                                # (/tmp/s35/r17_writeoutput_race.log). The append
                                # below is unchanged: the gap buffer must record
                                # the bytes either way, because a later reload
                                # replays from it.
                                publish_session_output(
                                    session_id, socketio_instance, decoded_data,
                                    room=cached_room)

                                with sessions_lock:
                                    # Re-validate for state consistency. Authority
                                    # cannot have changed (the lock is held), so
                                    # this catches only same-thread invariants; it
                                    # is kept because the append must never touch
                                    # a session that is not this reader's.
                                    if _reader_is_current_locked(
                                            session_id, transport_generation,
                                            channel) and _session_still_expected_locked(
                                            session_id, expected_session):
                                        sessions[session_id]['last_activity'] = now
                                        buf = sessions[session_id].get('output_buffer')
                                        if buf is not None:
                                            buf.append(decoded_data)
                                            sessions[session_id]['output_buffer_size'] += len(decoded_data)
                                            # Trim buffer if over max
                                            while sessions[session_id]['output_buffer_size'] > sessions[session_id].get('output_buffer_max', 512000) and len(buf) > 1:
                                                removed = buf.pop(0)
                                                sessions[session_id]['output_buffer_size'] -= len(removed)
                                    else:
                                        superseded = True

                        if superseded:
                            break

                        if now - last_db_update >= 10.0:
                            last_db_update = now
                            try:
                                db_session = SSHSession.query.filter_by(session_id=session_id).first()
                                if db_session:
                                    db_session.last_activity = datetime.now(timezone.utc)
                                    db.session.commit()
                            except Exception:
                                db.session.rollback()
                    else:
                        # EOF. Whether this is the swap or a real death is
                        # decided in the finally block, by THIS generation's own
                        # flag -- either way this reader is finished.
                        break
                except socket.timeout:
                    # A timeout is not an error; but if the swap has already
                    # retired this generation there is nothing left to read.
                    if _transport_was_swapped(session_id, transport_generation):
                        superseded = True
                        break
                except EOFError:
                    if not _transport_was_swapped(session_id, transport_generation):
                        log_debug("SSH channel EOF", session_id=session_id)
                    break
                except Exception as e:
                    if not _transport_was_swapped(session_id, transport_generation):
                        log_error(f"Error reading from channel", error=str(e), exc_info=True)
                    break

                if channel.closed or channel.exit_status_ready():
                    break

    except Exception as e:
        log_error(f"Error in output reader thread", error=str(e), exc_info=True)
    finally:
        # W2/W13: a reader whose transport was swapped under it must NOT report
        # the logical session as disconnected -- the session is alive on the new
        # transport, with a reader of its own.
        #
        # THE DECISION IS ATOMIC. The previous shape was check-then-act: ask
        # "was I swapped?" outside the lock, then (on "no") write the DB row and
        # call the generic close_session(session_id). A swap landing between
        # those two points meant this reader answered truthfully for the instant
        # it asked, and then marked the logical session disconnected and closed
        # the REPLACEMENT transport that had just been installed under the same
        # id. claim_reader_death does the ownership test and the registry pop in
        # ONE critical section, and hands back the exact parts it popped, so
        # there is no id-based close left to hit the wrong transport.
        #
        # `superseded` is a hint, never the authority: the atomic claim is asked
        # in every case, and it is what decides.
        state, parts = claim_reader_death(
            session_id, transport_generation, bound_channel)

        if state != READER_RETIRE_CURRENT:
            # Superseded, or the session is already gone. Retire quietly, and
            # clean up ONLY this generation's own flag -- bulk-discarding here is
            # how gen1's death used to delete the retirement gen0 was still owed,
            # after which gen0 woke with nothing and disconnected the session a
            # second time.
            _discard_reader_handoff(session_id, transport_generation)
            log_debug("Output reader retired without claiming the session",
                      session_id=session_id,
                      transport_generation=transport_generation,
                      state=state, superseded=superseded)
            return

        # EXACTLY CURRENT: a genuine death of the transport the session still
        # named. This reader owns the teardown.
        #
        # Its own flag may still be set if a swap was recorded and then failed
        # before bumping the generation; drop that one flag only. Every other
        # generation's flag belongs to a reader that must still be allowed to
        # retire quietly.
        _discard_reader_handoff(session_id, transport_generation)

        # Report the death, then close the parts. The report has two independent
        # halves (DB update, socket emit), each of which can RAISE, and a raise
        # must not leak the captured channel/client/bastion or skip the other
        # half. So each half is contained with its own rollback/log, and the
        # parts are closed in an outer finally that runs no matter what.
        try:
            with app.app_context():
                from .models import SSHSession, db
                room = cached_room
                # DB half: query + set connected + commit, with rollback on any
                # failure. A commit failure leaves the row's `connected` flag
                # untrusted, so the emit is still attempted only when the row
                # could be read -- but a commit failure must never strand the
                # SQLAlchemy session in a half-open transaction.
                try:
                    db_session = SSHSession.query.filter_by(
                        session_id=session_id).first()
                    if db_session:
                        db_session.connected = False
                        db.session.commit()
                        if not room:
                            room = f'user_{db_session.user_id}'
                except Exception as db_error:
                    try:
                        db.session.rollback()
                    except Exception as rollback_error:
                        log_debug("Rollback failed after DB report error",
                                  session_id=session_id,
                                  error=str(rollback_error))
                    log_error("Error updating DB on session death",
                              session_id=session_id, error=str(db_error),
                              exc_info=True)

                # Emit half: independent. Attempted only when a room is known
                # (either cached or resolved from the row above). Contained so a
                # failure here does not prevent the parts close.
                if room:
                    try:
                        socketio_instance.emit('ssh_disconnected', {
                            'session_id': session_id,
                            'reason': 'Connection closed'
                        }, room=room)
                    except Exception as emit_error:
                        log_error("Error emitting ssh_disconnected",
                                  session_id=session_id, error=str(emit_error),
                                  exc_info=True)
        except Exception as report_error:
            # Outer guard: a context-manager or import failure still reaches the
            # parts close below.
            log_error("Error reporting session death",
                      session_id=session_id, error=str(report_error),
                      exc_info=True)
        finally:
            # The CAPTURED parts, not close_session(session_id): the entry was
            # already popped under the ownership lock, so an id lookup here would
            # find whatever the id names now -- after a concurrent reconnect, the
            # replacement. Closing them here, in a finally, guarantees the
            # teardown completes even when the report above failed.
            _close_retired_parts(session_id, parts)

def send_tmux_keys(session_id, data):
    """Deliver bytes to a tmux pane WITHOUT being one of its clients, via `send-keys -H`.

: this is no longer the input path. Every browser socket that
    displays a session has its own attach channel and writes to it directly, so
    keystrokes reach the pane as keystrokes from a real terminal. This remains
    the fallback for the two cases with no view to write to:

      * the post-connect startup commands, which run before any browser has
        attached;
      * Broadcast to a session this socket is not displaying.

    `-H` takes the bytes as HEX pairs, which is the only form that cannot be
    reinterpreted -- no key-name lookup ("Enter", "C-c"), no UTF-8 ambiguity, no
    escaping question. Measured on tmux 3.4 (/tmp/s34/multi.log):
    `send-keys -H ... 65 63 68 6f 20 48 45 58 0d` produced `echo HEX` at the
    prompt and ran it.

    ORIGINAL NOTE, kept because the ordering argument still applies to bursts:

    S34. A control-mode client's stdin is the tmux COMMAND channel, not the pane:
    writing raw bytes there would be read as commands. tmux's own mechanism for
    injecting bytes is `send-keys`, and `-H` takes them as HEX pairs, which is the
    only form that cannot be reinterpreted -- no key-name lookup ("Enter", "C-c"),
    no UTF-8 ambiguity, no escaping question. Measured on tmux 3.4
    (/tmp/s34/multi.log): `send-keys -H ... 65 63 68 6f 20 48 45 58 0d` produced
    `echo HEX` at the prompt and ran it, and both attached control clients saw the
    echo.

    A per-keystroke exec channel cannot keep order: each one is I/O, so eventlet
    switches inside it and handler N+1 can complete before handler N.

    Measured defect (/tmp/s34/lifecycle_diag2.log, /tmp/s34/f_input.log): each
    keystroke is its own `ssh_input` event, and the previous implementation ran each
    one through `_exec_tmux_control`, which opens a short-lived SSH exec channel
    (`transport.open_session(timeout=3.0)`) and waits for its exit status. Both are
    I/O, so eventlet switches inside them and handler N+1 can complete before
    handler N. Live consequences, both deterministic before this fix and both
    reordering-shaped:

        typed   echo S34TYPED          landed  e chSo34TYEPD
        typed   echo LCQXDZEP-BEFORE   landed  echo LCQXDZEP-BEFOE   (R on the
                                               NEXT prompt)

    A per-session lock around the sends narrowed it but could not close it: a
    handler yields BEFORE the lock (session lookup, sessions_lock), so two
    keystrokes 2ms apart can still acquire out of order. Ordering has to come from
    the transport, not from a race for a lock.

    So the command is written to the session's ONE control channel -- the same
    channel the reader reads, which is what `tmux -CC` treats as its command input.
    The socket is then the queue, exactly as on the legacy path, and the bytes reach
    tmux in the order the writes were issued. Measured on a real pty
    (/tmp/s34/f_stdin2.log): 31 characters written as 31 separate stdin commands
    2ms apart produced the line INTACT, and running it produced the right output.

    The reader is unaffected. tmux answers each command with a `%begin`/`%end`
    block on the same stream, and the parser already skips those: measured on a
    genuinely interleaved capture (/tmp/s34/interleaved.txt, 3 `%begin` blocks and
    6 `%output` notifications), the parse delivered both pane markers and leaked no
    `%begin`, `%end` or command text into the terminal.

    Every byte is sent, in order, in ONE command: a split would let another
    client's keystroke interleave inside a multi-byte grapheme or an escape
    sequence. The hex encoding is generated here rather than by shlex, so the
    command line is digits and spaces only and cannot carry a metacharacter at all.

    UTF-8 is encoded explicitly: Vietnamese input is multi-byte, and tmux must
    receive the same bytes the browser sent or a diacritic becomes mojibake. This
    is the same encode the legacy `channel.send(str)` path performs implicitly.
    """
    payload = data.encode('utf-8') if isinstance(data, str) else bytes(data)
    if not payload:
        return True, None

    # ONE COMMAND PER CHUNK, on its own exec channel, serialised per session.
    #
    # The command is a tmux control command, so it travels the same way every
    # other tmux control command does (_exec_tmux_control). The per-session lock
    # is what keeps a multi-chunk payload contiguous: two writers interleaving
    # their chunks would corrupt the pane's line. Chunking is on a BYTE boundary
    # of the already-encoded payload, so it can never fall inside a UTF-8
    # sequence; 512 bytes per command is far above any realistic burst while
    # keeping each command line short.
    lock = _get_tmux_control_lock(session_id)
    if lock is None:
        return False, "Session not found"

    with lock:
        for start in range(0, len(payload), 512):
            chunk = payload[start:start + 512]
            hex_args = ['-H'] + [f'{byte:02x}' for byte in chunk]
            ok, error = _run_tmux_control_command(
                session_id, 'send-keys', hex_args, exact_target=True)
            if not ok:
                return False, error
    return True, None


# ============================================================================
# VIEWS -- one tmux client per browser socket. See the module header.
# ============================================================================

def session_transport_alive(session_id):
    """Is this session's SSH transport still up?

    Used to tell a view's own death (its attach exited, or the tmux session
    ended) apart from the session's death (the SSH connection went away). The
    first closes one view; only the second tears the session down.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        client = session.get('client') if session else None
    if client is None:
        return False
    try:
        transport = client.get_transport()
        return bool(transport and transport.is_active())
    except Exception:
        return False


def ensure_tmux_window_options(session_id):
    """Set the session-scoped tmux options every view depends on.

    Idempotent by construction: setting an option that is already set costs one
    short command and changes nothing, so this runs on every attach and needs no
    "have I done it yet" flag that could drift out of step with the real tmux
    state.

    `window-size smallest` IS THE MULTI-DEVICE POLICY (owner ruling
): the window follows the SMALLEST attached client, so every
    device can display the whole pane, and a device that stops watching detaches
    -- measured on tmux 3.7c, closing one client's channel returned the window
    to the survivor's size within 1ms. It is set with `-w` on this session's
    current window, and a session hook repeats it for any window created later,
    because `window-size` is a WINDOW option and a new window would otherwise
    inherit the server default (`latest`). Measured on tmux 3.7c:
    with the hook a window created afterwards reads back `window-size
    smallest`; without it the option is unset on that window.

    Every target is the exact-match form WITH the trailing colon (`=name:`,
    exact_target=True), which is the form these commands accept -- measured on
    the same host, `show-options -t '=name'` answers "no such session" while
    `-t '=name:'` answers correctly.

    `mouse on` is what puts wheel and touch gestures into tmux's copy mode, and
    `mode-keys emacs` is what the client's gesture code assumes. Both are
    session-scoped, never `-g`: the tmux server is shared with whatever else the
    user runs on that host.

    Reported, never raised: a session that will not take an option still works.
    A session that is not a tmux session issues NO command at all: there is no
    tmux to configure, and reporting that as a failure would log a warning on
    every plain-shell attach.
    """
    session = get_session(session_id)
    if not session or not session.get('use_tmux'):
        return True, None

    # A TUPLE LITERAL, so all four are attempted before any result is read.
    # They fail independently and each decides a different part of the
    # interaction model: a session left with `smallest` but without `mouse on`
    # cannot be scrolled at all, so stopping at the first failure would turn one
    # refused option into several broken behaviours.
    #
    # Mouse and mode-keys go through their own helpers rather than being
    # restated here: those validate their argument and are the single
    # definition of how each is set.
    errors = [error for ok, error in (
        _run_tmux_control_command(session_id, 'set-option',
                                  ['-w', 'window-size', 'smallest'],
                                  exact_target=True),
        _run_tmux_control_command(session_id, 'set-hook',
                                  ['after-new-window',
                                   'set-option -w window-size smallest'],
                                  exact_target=True),
        set_tmux_mouse_mode(session_id, True),
        set_tmux_mode_keys(session_id, 'emacs'),
    ) if not ok]
    if errors:
        log_warning("Could not set every tmux option for the session",
                    session_id=session_id, error=errors[0])
        return False, errors[0]
    return True, None


def session_view_count(session_id):
    with sessions_lock:
        session = sessions.get(session_id)
        return len(session.get('views') or {}) if session else 0


def _list_client_ttys(session_id):
    """The ttys of every client attached to this session, or None if unreadable."""
    ok, _error, out = _exec_tmux_control(
        session_id, 'list-clients', ['-F', '#{client_tty}'],
        exact_target=True, capture_output=True,
        max_output=_CLIENT_TTY_LIST_MAX_OUTPUT)
    if not ok:
        return None
    return {line.strip() for line in out.splitlines() if line.strip()}


# How long an attach may take to show up in `list-clients` before the view is
# registered without a tty. Measured over Tailscale from the container: 75ms.
_VIEW_TTY_DISCOVERY_S = 1.0


def _detach_view(session_id, view, reason):
    """Release ONE view's tmux client NOW, then close its channel.

    Closing the channel alone is not a prompt detach on every SSH server.
    Measured from the container against a tailnet host, the host every Tailscale
    session in this deployment reaches:

        OpenSSH          channel close -> client gone in    1 ms
        Tailscale SSH    channel close -> client gone in 4573 ms
        Tailscale SSH    detach-client -t <tty>          ->   51 ms

    Tailscale's SSH server (`SSH-2.0-Tailscale`) only tears the session
    process down on a timeout after the channel closes, so for those 4.5
    seconds the phone that just stopped watching was still counted by
    `window-size smallest` and the desktop stayed narrow -- the owner's
    "phiên tailscale không tự nhả về kích thước ngay". Asking tmux to detach
    the client by its tty is server-independent and immediate; the channel
    close afterwards is just hygiene, since the client process exits by itself.
    """
    tty = view.get('tty')
    if tty:
        ok, error = _run_tmux_control_command(
            session_id, 'detach-client', target_override=tty)
        if not ok:
            log_debug("detach-client failed; falling back to the channel close",
                      session_id=session_id, tty=tty, error=error)
    try:
        view['channel'].close()
    except Exception as exc:
        log_debug("Error closing a view channel", session_id=session_id,
                  reason=reason, error=str(exc))


# Sockets whose views were closed because the SOCKET went away. Kept so an
# attach that was still in flight when its socket disconnected cannot register
# a view afterwards (see open_session_view). A ring, not a set: sids are never
# reused, so the only thing that matters is the last few hundred.
_RETIRED_SOCKETS_MAX = 1024
_retired_sockets = OrderedDict()


def _retire_socket(socket_sid):
    _retired_sockets[socket_sid] = True
    _retired_sockets.move_to_end(socket_sid)
    while len(_retired_sockets) > _RETIRED_SOCKETS_MAX:
        _retired_sockets.popitem(last=False)


def _socket_is_connected(socketio_instance, socket_sid):
    """False only when the socket.io server can PROVE this sid is gone.

    Two proofs. The retired ring above answers for a socket whose disconnect
    handler already ran -- python-socketio still counts that sid as connected
    while its own handler is executing, which is exactly the window an
    in-flight attach can land in. The manager answers for everything after.
    A server that cannot be asked (tests, no server object) counts as
    connected: this must never drop a view it cannot prove is orphaned.
    """
    if socket_sid in _retired_sockets:
        return False
    server = getattr(socketio_instance, 'server', None)
    manager = getattr(server, 'manager', None) if server is not None else None
    if manager is None or not hasattr(manager, 'is_connected'):
        return True
    try:
        return bool(manager.is_connected(socket_sid, '/'))
    except Exception:
        return True


def _view_is_dead(view, socketio_instance=None, socket_sid=None):
    """True when this view can no longer reach anyone.

    Two ways to be dead. The channel says so: closed, or an exit status ready.
    Or the SOCKET the view was opened for is gone while its channel is still a
    live tmux client -- the orphan the owner hit: a socket that
    lived 0.7s disconnected at 06:59:28.94 and its attach finished at
    06:59:29.68, leaving a 59x43 client on /dev/pts/5 that held the desktop's
    window at 59 columns for an hour. Anything this cannot prove is left alone
    -- dropping a live view would detach a device that is watching.
    """
    if socket_sid is not None and not _socket_is_connected(
            socketio_instance, socket_sid):
        return True
    channel = view.get('channel') if isinstance(view, dict) else None
    if channel is None:
        return True
    try:
        if getattr(channel, 'closed', False):
            return True
        ready = getattr(channel, 'exit_status_ready', None)
        if callable(ready) and ready():
            return True
    except Exception:
        return False
    return False


def _session_geometry_target(views):
    """The size every client of the session is drawn at: the component-wise
    minimum over the sizes the attached views really fit."""
    cols = min(v['cols'] for v in views.values())
    rows = min(v['rows'] for v in views.values())
    return cols, rows


def _apply_session_geometry(session_id, socketio_instance, target=None,
                            immediate_redraw=False):
    """Bring every view's PTY to the session's target size, and say so first.

    WHY THE SERVER SIZES THE PTYs. tmux would compute the same minimum on its
    own (`window-size smallest`), but it draws a larger client with the window
    in the TOP-LEFT corner and filler everywhere else, and there is no tmux
    option to place it anywhere else. The owner wants the shrunken screen
    centred at the top. A client can only centre what it renders, and what it
    renders has to be the size its PTY is -- otherwise the status line and the
    filler, which tmux draws at the PTY's full width, land past the rendered
    grid. So every view's PTY is set to the minimum, each client renders that
    grid centred in its pane, and each client keeps REPORTING its true fit
    (view['cols'/'rows']) so the minimum can grow back the moment the
    smallest device leaves.

    This is a derived value with one rule and no ownership -- it is not the
    old authority resolver. Nothing here decides who "holds" a grid, no client
    is told to wait, and a client that reports a new fit simply moves the
    minimum.

    `target` overrides the minimum for the ONE case where the minimum is not
    yet in the registry: a view that is about to attach. See open_session_view
    on why the clients already attached are brought down to it first.

    ORDER IS THE CONTRACT: `tmux_window_geometry` is emitted to EVERY view
    before ANY PTY is resized. A resize makes tmux repaint every client at
    the new size, and those bytes go out on each view's own reader; socket.io
    keeps per-socket order, so a frame emitted here first reaches the client
    first, and the engine is already at the new size when the repaint lands.
    Growing a PTY before the client knew would paint a wide screen into a
    narrow engine -- the S27 defect, reintroduced -- which is why the emits are
    not interleaved with the resizes.
    """
    orphaned = {}
    with sessions_lock:
        session = sessions.get(session_id)
        registry = (session.get('views') or {}) if session else {}
        # A view whose socket has gone is still a tmux client and would hold
        # the minimum at a size nobody is looking at; it is released here, on
        # the path every size change takes, so nothing can hold it for long.
        for sid in [sid for sid in registry
                    if not _socket_is_connected(socketio_instance, sid)]:
            orphaned[sid] = registry.pop(sid)
        views = dict(registry)
    for sid, view in orphaned.items():
        log_info("Releasing a view whose socket is gone", session_id=session_id,
                 sid=sid, tty=view.get('tty'))
        _detach_view(session_id, view, 'socket gone')
    if not views:
        return
    cols, rows = target if target else _session_geometry_target(views)
    if socketio_instance is not None:
        for sid in views:
            try:
                socketio_instance.emit(
                    'tmux_window_geometry',
                    {'session_id': session_id, 'cols': cols, 'rows': rows},
                    to=sid)
            except Exception as exc:
                log_debug("Could not announce the window geometry",
                          session_id=session_id, error=str(exc))
    redrawn = []
    for sid, view in views.items():
        if view.get('pty') == (cols, rows):
            continue
        try:
            view['channel'].resize_pty(width=cols, height=rows)
            view['pty'] = (cols, rows)
            if view.get('tty'):
                redrawn.append(view['tty'])
        except Exception as exc:
            log_debug("Could not resize a view's PTY", session_id=session_id,
                      sid=sid, error=str(exc))
    _redraw_clients(session_id, redrawn, immediate=immediate_redraw)


REDRAW_SETTLE_SECONDS = 0.25

_redraw_timers = {}
_redraw_lock = Lock()


def _redraw_clients(session_id, ttys, immediate=False):
    """Ask tmux to paint these clients again, once the resizing has stopped.

    WHY AT ALL. tmux fills the area outside its window with a border column and
    dots (measured on 3.7c; 10.580 of them in the attach case). A client whose
    PTY has just GROWN is bigger than the window until tmux redraws, so it gets
    that filler -- and when nothing else is happening in the pane, an idle
    shell prompt, nothing ever overwrites it.
    The owner saw the leftovers: "terminal bi ve nhieu hang ........ phai 1 luc
    sau moi tu ve lai man hinh chuan".

    WHY NOT INLINE. `_exec_tmux_control` opens a short-lived exec channel, which
    is a network round trip -- 432-472 ms over this tailnet, measured
. Running it inside the resize path would make every size change
    wait for it. So the redraw is deferred and COALESCED per session: a drag
    that lands twenty geometries still costs one redraw, a quarter second after
    the last one.

    `refresh-client -t <tty>` is a redraw and nothing else: it changes no size,
    touches no option, and addresses exactly the one client whose tty this
    module recorded when it attached. A failure is logged and dropped -- a
    missed repaint is cosmetic, and tmux draws over it at the next output.

    WHY `immediate`. The quarter second is there for a DRAG, which
    lands geometry after geometry; an attach, a detach or a dead view is ONE
    event, and waiting a quarter second for a burst that will never come just
    adds to the gap in which the other devices show the leftovers of their old
    frame (see terminal-manager freezePaneForShrink for what that gap looks
    like). Those callers ask for the redraw straight away. The drag path,
    resize_session_view, keeps the coalesce -- that is the case it was
    measured for.
    """
    if not ttys:
        return

    def run():
        with _redraw_lock:
            _redraw_timers.pop(session_id, None)
        for tty in ttys:
            try:
                ok, reason, _ = _exec_tmux_control(
                    session_id, 'refresh-client', target_override=tty)
                if not ok:
                    log_debug("Could not ask tmux to redraw a client",
                              session_id=session_id, error=reason)
            except Exception as exc:
                log_debug("Could not ask tmux to redraw a client",
                          session_id=session_id, error=str(exc))

    with _redraw_lock:
        pending = _redraw_timers.pop(session_id, None)
        if pending is not None:
            pending.cancel()
        timer = Timer(0 if immediate else REDRAW_SETTLE_SECONDS, run)
        timer.daemon = True
        _redraw_timers[session_id] = timer
        timer.start()


def open_session_view(session_id, socket_sid, cols, rows,
                      socketio_instance, app):
    """Attach ONE browser socket to a tmux session as its own tmux client.

    Returns ``(ok, error)``. Re-entrant: a socket that already has a view is
    resized instead of attaching twice, which is what makes the client free to
    call this whenever a pane becomes visible.

    The channel is an ordinary exec channel with a PTY, so tmux sees a genuine
    terminal: it sends this client the mouse DECSETs, draws it clipped to its own
    size, repaints it in full on attach, and counts it in `window-size smallest`.
    That is the whole mechanism -- there is no geometry arbitration left in this
    module because tmux performs it.

    Views are NOT sessions and are deliberately not counted against
    MAX_SESSIONS; the bound is MAX_VIEWS_PER_SESSION, which exists only so a
    buggy or hostile client cannot open channels without limit on one transport.

    `cols`/`rows` are what THIS socket's pane fits. The PTY is opened at the
    session's target size instead (the minimum over every attached view, this
    one included) so the attach repaint already has the geometry every client
    renders; see _apply_session_geometry for why the minimum is applied
    server-side rather than left to `window-size smallest`.
    """
    try:
        cols = max(1, min(int(cols), 1000))
        rows = max(1, min(int(rows), 500))
    except (TypeError, ValueError):
        return False, "Invalid view size"

    with sessions_lock:
        session = sessions.get(session_id)
        if session is None:
            return False, "Session not found"
        if not session.get('connected'):
            return False, "Session is not connected"
        if not session.get('use_tmux'):
            return False, "Session is not a tmux session"
        views = session.setdefault('views', {})
        # EVERY ATTACH, NOT ONLY A FULL ONE.
        #
        # A socket that died without a clean disconnect leaves its view behind,
        # and that view is still a tmux CLIENT: it keeps counting in the
        # session's minimum, so the device that just arrived can be drawn at a
        # size nobody is looking at, and enough of them refuse the owner's own
        #). A page reload produces one of these whenever the old
        # socket's disconnect arrives after the new socket has attached.
        # Dropping them here costs a dict scan; a channel that cannot prove it
        # is dead is left alone (_view_is_dead).
        swept = {}
        for dead_sid in [sid for sid, view in views.items()
                         if sid != socket_sid
                         and _view_is_dead(view, socketio_instance, sid)]:
            log_debug("Dropping a dead view", session_id=session_id,
                      sid=dead_sid)
            swept[dead_sid] = views.pop(dead_sid)
        existing = views.get(socket_sid)
        if existing is not None:
            existing['cols'] = cols
            existing['rows'] = rows
        elif len(views) >= config.MAX_VIEWS_PER_SESSION:
            return False, "Too many open views for this session"
        client = session.get('client')
        tmux_session_name = session.get('tmux_session_name')
        generation = session.get('transport_generation', 0)
        target = _session_geometry_target(
            dict(views, **{socket_sid: {'cols': cols, 'rows': rows}}))

    # A swept view's channel may still be a live tmux client (its socket is
    # what died), so it is released by tty, not merely forgotten.
    for dead_sid, view in swept.items():
        _detach_view(session_id, view, 'swept at attach')

    if existing is not None:
        # Already attached: this is a resize, and it is the ONLY thing a repeat
        # call may do. Re-attaching would leave the old client counted by
        # `window-size smallest` until its channel happened to die.
        _apply_session_geometry(session_id, socketio_instance,
                                immediate_redraw=True)
        return True, None

    if client is None or not tmux_session_name:
        return False, "Session has no tmux transport"

    """Shrink the clients that are already attached BEFORE this one arrives.

    MEASURED (tmux 3.7c, /tmp/orderprobe.py,). A 165x47 client is
    attached; a 49x47 client attaches beside it:

      attach first, then shrink the big client   23078 bytes, 10580 `·`
      shrink the big client first, then attach     992 bytes,     0 `·`

    The first line is a FULL-SCREEN repaint: the moment the small client
    attaches, tmux recomputes the window and redraws every bigger client with
    the window drawn small and `·` filler over the rest, and only when this
    module then shrinks that client's pty does the real frame follow. Two full
    frames for one attach, the first of them filler -- that is the flash the
    owner sees as "giật mất hình rồi lại có hình". Bringing the
    attached clients down to the target first means tmux never has a client
    bigger than its window, so there is no filler frame to send.
    """
    _apply_session_geometry(session_id, socketio_instance, target=target,
                            immediate_redraw=True)

    # BEFORE the attach, not after, and the reason is measured. A tmux session
    # this build did not create carries whatever options the previous design
    # left on it: on the deploy host, two retained sessions were found at
    # `window-size manual` 128x86 and 90x78, set by the window-locking code this
    # rewrite deletes. A client attaching under `manual` is drawn at the locked
    # size until the option changes, so the first paint of a retained session
    # would arrive at a foreign geometry and correct itself a moment later.
    # Setting the options first costs four short commands on a session that
    # already exists -- it was created by _build_transport or proven by
    # has-session -- and they are idempotent, so every attach may run them.
    ensure_tmux_window_options(session_id)

    # The attach and the tty discovery run under the session's control lock,
    # so two sockets attaching at once cannot each mistake the other's client
    # for their own: the client that appears in `list-clients` between the
    # snapshot and the poll is this attach's, and it is what
    # `detach-client -t` will name when this socket stops watching.
    lock = _get_tmux_control_lock(session_id)
    if lock is None:
        return False, "Session not found"
    tty = None
    with lock:
        before = _list_client_ttys(session_id)
        try:
            transport = client.get_transport()
            if transport is None or not transport.is_active():
                return False, "SSH transport is not active"
            channel = transport.open_session(timeout=10.0)
            channel.get_pty('xterm-256color', target[0], target[1])
            channel.exec_command(build_tmux_attach_command(tmux_session_name))
            channel.settimeout(0.1)
        except Exception as exc:
            return False, str(exc)
        if before is not None:
            deadline = time.time() + _VIEW_TTY_DISCOVERY_S
            while True:
                time.sleep(min(0.03, _VIEW_TTY_DISCOVERY_S))
                after = _list_client_ttys(session_id)
                if after is None:
                    break
                new = after - before
                if new:
                    # More than one new client means somebody else attached
                    # in the same window; then nothing can be named safely.
                    tty = next(iter(new)) if len(new) == 1 else None
                    break
                if time.time() >= deadline:
                    break
    if tty is None:
        log_debug("View attached without a tty; detach will fall back to "
                  "the channel close", session_id=session_id, sid=socket_sid)

    # Register BEFORE the reader starts, so the reader can always find its own
    # record, and re-validate BOTH identities: the session can have gone while
    # the channel was being opened (network I/O above releases the lock), and
    # so can the SOCKET. A socket that disconnected during the attach had its
    # views closed by handle_disconnect before this one existed, so a view
    # registered now would belong to nobody, and its tmux client would hold
    # `window-size smallest` for everyone else until the transport died
    # (: an hour). It is released by the tty just found.
    if not _socket_is_connected(socketio_instance, socket_sid):
        log_info("Attach finished after its socket left; releasing the client",
                 session_id=session_id, sid=socket_sid, tty=tty)
        _detach_view(session_id, {'channel': channel, 'tty': tty},
                     'socket gone')
        return False, "Socket gone"
    with sessions_lock:
        session = sessions.get(session_id)
        if session is None or not session.get('connected'):
            try:
                channel.close()
            except Exception:
                pass
            return False, "Session not found"
        views = session.setdefault('views', {})
        if socket_sid in views:
            # Two attaches raced. Keep the registered one and drop this channel;
            # the other is already being read.
            try:
                channel.close()
            except Exception:
                pass
            return True, None
        views[socket_sid] = {
            'channel': channel,
            # What the pane really fits (reported), and what its PTY is
            # currently set to (applied). The two differ whenever a smaller
            # device is attached.
            'cols': cols,
            'rows': rows,
            'pty': target,
            'tty': tty,
            'thread': None,
            'transport_generation': generation,
            'opened_at': time.time(),
        }

    thread = Thread(
        target=read_view_output,
        args=(session_id, socket_sid, channel, generation,
              socketio_instance, app),
        daemon=True,
    )
    thread.daemon = True
    with sessions_lock:
        session = sessions.get(session_id)
        view = (session.get('views') or {}).get(socket_sid) if session else None
        if view is not None:
            view['thread'] = thread
    # Announced BEFORE the reader runs: the attach repaint is the first thing
    # this channel produces, and the client must already know its geometry
    # when that repaint lands (see _apply_session_geometry on ordering).
    _apply_session_geometry(session_id, socketio_instance,
                            immediate_redraw=True)
    thread.start()

    log_info("View attached", session_id=session_id, sid=socket_sid,
             cols=cols, rows=rows, pty=f"{target[0]}x{target[1]}", tty=tty)
    return True, None


def close_session_view(session_id, socket_sid, reason='detached',
                       socketio_instance=None):
    """Detach ONE socket's tmux client. Returns whether a view was closed.

    The record is popped BEFORE the client is released, so the view's own
    reader -- which wakes on the EOF the detach produces -- finds no record and
    retires silently instead of reporting a closed view the client never lost.
    The tmux session, the pane and this session record are untouched: a
    session with no views is a normal, fully alive, detached session. The
    survivors' geometry is recomputed at once, which is what hands a leaving
    phone's columns back to the desktop.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        if session is None:
            return False
        view = (session.get('views') or {}).pop(socket_sid, None)
    if view is None:
        return False
    _detach_view(session_id, view, reason)
    log_debug("View detached", session_id=session_id, sid=socket_sid,
              reason=reason)
    _apply_session_geometry(session_id, socketio_instance,
                            immediate_redraw=True)
    return True


def close_views_for_socket(socket_sid, reason='socket closed',
                           socketio_instance=None):
    """Detach every view this socket holds. Returns the session ids affected.

    The sid is retired FIRST: an attach for it that is still in flight will
    then refuse to register (open_session_view), whether it lands while this
    handler is still running or after it.
    """
    _retire_socket(socket_sid)
    with sessions_lock:
        owning = [sid for sid, session in sessions.items()
                  if socket_sid in (session.get('views') or {})]
    closed = []
    for session_id in owning:
        if close_session_view(session_id, socket_sid, reason=reason,
                              socketio_instance=socketio_instance):
            closed.append(session_id)
    return closed


def resize_session_view(session_id, socket_sid, cols, rows,
                         socketio_instance=None):
    """Record what ONE socket's pane fits now. Returns ``(ok, error)``.

    For a tmux session the size is this view's TRUE fit; the PTYs are then
    brought to the session's minimum by _apply_session_geometry, so a device
    growing past the smallest one changes nothing on the wire, and the
    smallest one growing moves every client.

    A NON-TMUX session has one PTY for every tab of the account, so the last
    resize wins; that is unchanged and unavoidable for a plain shell.
    """
    try:
        cols = max(1, min(int(cols), 1000))
        rows = max(1, min(int(rows), 500))
    except (TypeError, ValueError):
        return False, "Invalid size"

    with sessions_lock:
        session = sessions.get(session_id)
        if session is None:
            return False, "Session not found"
        if not session.get('use_tmux'):
            return resize_terminal(session_id, rows, cols)
        view = (session.get('views') or {}).get(socket_sid)
        if view is None:
            return False, "No view for this socket"
        view['cols'] = cols
        view['rows'] = rows

    _apply_session_geometry(session_id, socketio_instance)
    return True, None


def read_view_output(session_id, socket_sid, channel, transport_generation,
                     socketio_instance, app):
    """Read ONE view's tmux client and emit its bytes to ONE socket.

    The per-view twin of read_ssh_output, and deliberately much smaller: a view
    owns no shared state. It has no gap buffer (a reload re-attaches and tmux
    repaints, and the scrollback above the screen comes from read_tmux_history),
    no authority to publish and no replay window to order against, so there is
    nothing for a lock to serialise here.

    What it must still get right is WHOSE death it is reporting:

      * the view's own channel ended while the SSH transport is still up -- the
        attach exited, or the tmux session was killed. Only this view is closed,
        and the socket is told with `view_closed`;
      * the transport itself is gone -- that is the SESSION's death, and it is
        reported exactly once through the same `claim_reader_death` /
        `ssh_disconnected` path the non-tmux reader uses.

    Do NOT use select.select() on the paramiko channel here: under eventlet it
    watches the transport socket FD and conflicts with paramiko's own transport
    reader and any concurrent SFTP on the same transport. `settimeout(0.1)` plus
    socket.timeout is the shape the legacy reader already proved.
    """
    reason = 'closed'
    decoder = _stream_decoder()
    try:
        while True:
            with sessions_lock:
                session = sessions.get(session_id)
                if session is None or not session.get('connected'):
                    reason = 'session gone'
                    break
                view = (session.get('views') or {}).get(socket_sid)
                if view is None or view['channel'] is not channel:
                    # Detached, or replaced by a newer attach for the same
                    # socket. Either way this reader is retired and must not
                    # touch the successor's channel.
                    return
                if session.get('transport_generation', 0) != transport_generation:
                    reason = 'transport swapped'
                    break

            try:
                raw = channel.recv(32768)
                if not raw:
                    reason = 'attach ended'
                    break
                decoded = decoder.decode(raw)
                # The same Device-Attributes filter the legacy reader applies,
                # for the same reason: xterm answers ESC[c as if the host had
                # asked, and a replayed answer would be typed into the pane.
                decoded = re.sub(r'\x1b\[[?>]?[0-9;]*c', '', decoded)
                if decoded:
                    socketio_instance.emit(
                        'ssh_output',
                        {'session_id': session_id, 'data': decoded},
                        to=socket_sid)
                    with sessions_lock:
                        session = sessions.get(session_id)
                        if session is not None:
                            session['last_activity'] = time.time()
            except socket.timeout:
                continue
            except EOFError:
                reason = 'attach ended'
                break
            except Exception as exc:
                reason = str(exc)
                break

            if channel.closed or channel.exit_status_ready():
                reason = 'attach exited'
                break
    except Exception as exc:
        log_error("Error in a view reader", session_id=session_id,
                  error=str(exc), exc_info=True)
        reason = str(exc)
    finally:
        _retire_view(session_id, socket_sid, channel, transport_generation,
                     socketio_instance, app, reason)


def _retire_view(session_id, socket_sid, channel, transport_generation,
                 socketio_instance, app, reason):
    """One view's reader has ended. Decide whether the SESSION died with it."""
    with sessions_lock:
        session = sessions.get(session_id)
        views = (session.get('views') or {}) if session else {}
        mine = views.get(socket_sid)
        if mine is not None and mine['channel'] is channel:
            views.pop(socket_sid, None)
        else:
            # Somebody else already retired this view (a detach, or a swap).
            session = None
    try:
        channel.close()
    except Exception:
        pass
    if session is None:
        return

    if session_transport_alive(session_id):
        # The transport is fine, so this is the VIEW's death only. The client is
        # told so it can decide whether to re-attach; the session stays alive
        # and every other device keeps working -- at the size the survivors
        # fit, now that this one no longer counts.
        log_debug("View reader retired", session_id=session_id,
                  sid=socket_sid, reason=reason)
        _apply_session_geometry(session_id, socketio_instance,
                                immediate_redraw=True)
        try:
            socketio_instance.emit('view_closed',
                                   {'session_id': session_id,
                                    'reason': reason},
                                   to=socket_sid)
        except Exception as exc:
            log_debug("Could not report a closed view",
                      session_id=session_id, error=str(exc))
        return

    # The transport is gone: the SESSION is dead. Report it once, through the
    # same ownership claim the non-tmux reader uses, so two views dying together
    # cannot report it twice.
    state, parts = claim_reader_death(session_id, transport_generation, None)
    if state != READER_RETIRE_CURRENT:
        return
    try:
        with app.app_context():
            from .models import SSHSession, db
            room = None
            try:
                db_session = SSHSession.query.filter_by(
                    session_id=session_id).first()
                if db_session:
                    db_session.connected = False
                    db.session.commit()
                    room = f'user_{db_session.user_id}'
            except Exception as db_error:
                try:
                    db.session.rollback()
                except Exception:
                    pass
                log_error("Error updating DB on session death",
                          session_id=session_id, error=str(db_error))
            if room:
                try:
                    socketio_instance.emit('ssh_disconnected',
                                           {'session_id': session_id,
                                            'reason': 'Connection closed'},
                                           room=room)
                except Exception as emit_error:
                    log_error("Error emitting session death",
                              session_id=session_id, error=str(emit_error))
    finally:
        _close_retired_parts(session_id, parts)


# --- Input order ---------------------------------------------------------------
# Every keystroke is its own `ssh_input` event and Flask-SocketIO runs every
# event handler in its own greenlet. The handler does I/O BEFORE it writes: the
# socket's user is looked up in the DB, and every 30 s that lookup also commits
# a last-activity update. Handler N yields there while handler N+1 runs through
# to the write. Measured live (Playwright typing into a fresh tmux
# session on the host): `for i in $(seq 1 200); do...` reached the shell as
# ` 1 200); donef; python3 /tmp/tuipro; do echo ...` at full speed, as `fio irn`
# at 40 ms per key and as `ofr i in` at 150 ms per key -- one commit holds a
# keystroke longer than a fast typist's interval, so this is not a harness
# artefact. A ticket is taken at the FIRST statement of the handler, before any
# I/O, so tickets carry the order the events arrived in, and the write waits for
# its turn. Per SOCKET, not per session: one device types in order, and a
# socket can only ever delay itself.
INPUT_TURN_TIMEOUT_S = 2.0
_input_turns = {}
_input_turns_lock = Lock()


def begin_input_turn(socket_sid):
    """Take this socket's next ticket and wait until it is being served.

    Returns the ticket; the caller passes it to end_input_turn in a `finally`.
    A predecessor that never ends (its greenlet was killed) holds a successor
    for at most INPUT_TURN_TIMEOUT_S, after which the successor proceeds: the
    order degrades to what it was before rather than freezing the keyboard.
    """
    with _input_turns_lock:
        state = _input_turns.get(socket_sid)
        if state is None:
            state = {'next': 0, 'serving': 0, 'cond': Condition()}
            _input_turns[socket_sid] = state
        ticket = state['next']
        state['next'] = ticket + 1
    deadline = time.time() + INPUT_TURN_TIMEOUT_S
    with state['cond']:
        while state['serving'] < ticket:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            state['cond'].wait(remaining)
    return ticket


def end_input_turn(socket_sid, ticket):
    """This ticket is done: serve the next one."""
    with _input_turns_lock:
        state = _input_turns.get(socket_sid)
    if state is None:
        return
    with state['cond']:
        if state['serving'] <= ticket:
            state['serving'] = ticket + 1
        state['cond'].notify_all()


def forget_input_turns(socket_sid):
    """The socket is gone; drop its counters."""
    with _input_turns_lock:
        _input_turns.pop(socket_sid, None)


def send_ssh_input(session_id, data, require_complete=False, socket_sid=None):
    """Send user input to the session, from the socket that typed it.

    Routing, in order, for a TMUX session:

      1. `socket_sid`'s own view -- the normal case. The bytes go to that
         socket's own tmux client, exactly as if the user had typed into a
         terminal on that device, which is what makes IME and multi-byte input
         behave like a real terminal.
      2. ANY view of the session, when the caller has none (Broadcast from a
         socket that is not displaying this session).
      3. `send_tmux_keys`, when the session has no attached view at all
         (startup commands, or a detached session receiving Broadcast).

    A NON-TMUX session has exactly one PTY channel and takes it directly.
    """
    try:
        import re as _re
        # Filter Device Attributes responses (ESC[c sequences only) that
        # xterm.js may echo back as input. Bare-pattern regexes were removed
        # because they corrupt legitimate input like "100c" or "cat file".
        if isinstance(data, str):
            data = _re.sub(r'\x1b\[[?>]?[0-9;]*c', '', data)
        if not data:
            return True, None

        with sessions_lock:
            if session_id not in sessions:
                return False, "Session not found"

            session = sessions[session_id]
            if not session['connected']:
                return False, "Session not connected"

            channel = session['channel']
            if channel is None:
                views = session.get('views') or {}
                view = views.get(socket_sid)
                if view is None and views:
                    view = next(iter(views.values()))
                channel = view['channel'] if view else None
            use_tmux = bool(session.get('use_tmux'))

        if channel is None:
            if not use_tmux:
                return False, "No channel for session"
            # No view is attached: fall back to send-keys.
            ok, error = send_tmux_keys(session_id, data)
            if not ok:
                return False, error
            with sessions_lock:
                if session_id in sessions:
                    now = time.time()
                    sessions[session_id]['last_activity'] = now
                    sessions[session_id]['last_interaction'] = now
            return True, None

        if require_complete:
            remaining = data.encode('utf-8') if isinstance(data, str) else data
            while remaining:
                sent = channel.send(remaining)
                if not isinstance(sent, int) or sent <= 0:
                    return False, "Failed to send SSH input"
                remaining = remaining[sent:]
        else:
            channel.send(data)

        with sessions_lock:
            if session_id in sessions:
                now = time.time()
                sessions[session_id]['last_activity'] = now
                # S2 rev6: this is the primary HUMAN interaction signal -- the
                # user actually sent these bytes.
                sessions[session_id]['last_interaction'] = now

        return True, None
    except Exception as e:
        return False, str(e)

def resize_terminal(session_id, rows, cols):
    """Resize terminal PTY."""
    try:
        with sessions_lock:
            if session_id not in sessions:
                return False, "Session not found"

            session = sessions[session_id]
            channel = session['channel']

        channel.resize_pty(width=cols, height=rows)
        return True, None
    except Exception as e:
        return False, str(e)

# Control commands that capture output only ever read a tmux format string
# like "#{pane_in_mode}", i.e. a byte or two. Cap the read so a misbehaving or
# hijacked remote cannot stream unbounded data into this worker.
_TMUX_CONTROL_MAX_OUTPUT = 64

def _get_tmux_control_lock(session_id):
    """Per-session lock for multi-step control sequences (query -> act), so two
    concurrent requests cannot both read the same stale tmux state and then both
    act on it (e.g. both sending an ESC, the second leaking into the shell).

    The lock lives on the session dict itself rather than in a module-level
    registry: it is then created with the session and dropped with it, so there
    is no separate lifetime to manage and no cleanup hook in close_session.

    Returns None when the session no longer exists. sessions_lock is only held
    to look the lock up — never across the network I/O that follows.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        if session is None:
            return None
        lock = session.get('tmux_control_lock')
        if lock is None:
            lock = Lock()
            session['tmux_control_lock'] = lock
        return lock


def _drain_tmux_output(channel, stdout, final=False,
                       max_output=None):
    """Read whatever stdout is available, capped at max_output bytes
    (_TMUX_CONTROL_MAX_OUTPUT by default).

    Returns the accumulated bytes, or None if the remote sent more than the cap
    (an error, deliberately not a silent truncation). final=True keeps reading
    until the channel reports EOF/no more data, for use after exit.
    """
    if max_output is None:
        max_output = _TMUX_CONTROL_MAX_OUTPUT
    while True:
        if not final and not channel.recv_ready():
            return stdout
        try:
            chunk = channel.recv(max_output + 1 - len(stdout))
        except socket.timeout:
            return stdout
        if not chunk:
            return stdout
        stdout += chunk
        if len(stdout) > max_output:
            return None
        if final and not channel.recv_ready():
            return stdout


def _run_tmux_control_command(session_id, subcommand, extra_args=None,
                              exact_target=False, target_override=None):
    """Run a single tmux control command for an SSHDeck-managed session.

    Thin wrapper over _exec_tmux_control that discards captured output, so the
    existing callers keep their (ok, error) contract.
    """
    ok, error, _ = _exec_tmux_control(
        session_id, subcommand, extra_args=extra_args,
        exact_target=exact_target, capture_output=False,
        target_override=target_override
    )
    return ok, error


def _exec_tmux_control(session_id, subcommand, extra_args=None,
                       exact_target=False, capture_output=False,
                       max_output=None, target_override=None,
                       no_target=False):
    """Run a single tmux control command for an SSHDeck-managed session.

    The command is built as `tmux <subcommand> -t <session> <extra_args...>`
    and runs on a short-lived exec channel over the session's existing
    transport, so it never touches the interactive PTY that is attached to
    tmux. Only sessions that SSHDeck itself created with tmux are eligible, and
    the tmux target is always the server-verified session name for this
    session_id — the caller never supplies a raw target. Every argument is
    shell-quoted, so the command is scoped to this one tmux session and cannot
    affect global options, ~/.tmux.conf, or sessions owned by other tools
    (e.g. another tool) on the same host/account.

    exact_target=True targets `=<session>:` instead of the bare session name:
    the leading `=` forces an exact (non-prefix) session match and the trailing
    `:` selects that session's current window/pane, which is what pane-scoped
    commands (copy-mode, display-message -p) need. Still built from the stored
    session name only.

    capture_output=True reads up to max_output bytes of stdout (_TMUX_CONTROL_MAX_OUTPUT
    by default) and returns it as the third element; more output than that is an
    error, not a silent truncation.

    target_override replaces the computed `-t` value with a caller-supplied one.
    It exists for two subcommands: `refresh-client`, whose `-t` takes a
    target-CLIENT (a tty) and not a target-session, so the session forms this
    helper builds can never address it (measured on tmux 3.4); and
    `kill-session` from kill_tmux_session, whose exact-match `=<name>` is the
    session's own name or a name list_tmux_sessions read back from tmux and
    validated. The value is shell-quoted like every other part; a caller may
    not pass a raw user string.

    no_target=True omits `-t` altogether, for the one subcommand that takes no
    target: `list-sessions` (tmux rejects `-t` there with its usage text).

    Returns (True, None, stdout) on success or (False, reason, '') on failure.
    A failure here must never tear down the SSH/persistent session; callers
    surface the error to the UI instead.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        if not session:
            return False, "Session not found", ''
        if not session.get('connected'):
            return False, "Session not connected", ''
        if not session.get('use_tmux') or not session.get('tmux_session_name'):
            return False, "Session is not a tmux session", ''
        client = session.get('client')
        tmux_session_name = session['tmux_session_name']

    if not client:
        return False, "No SSH client for session", ''

    control_channel = None
    try:
        transport = client.get_transport()
        if not transport or not transport.is_active():
            return False, "SSH transport is not active", ''

        # Build a fully-quoted command with the target placed immediately after
        # the subcommand, where tmux expects it. The target session name was
        # generated and stored by SSHDeck (or validated against a user-owned
        # SSHSession on reconnect), but quote it anyway so it can only ever be
        # a single argument to tmux.
        target = f'={tmux_session_name}:' if exact_target else tmux_session_name
        if target_override is not None:
            target = target_override
        parts = ['tmux', subcommand] if no_target else ['tmux', subcommand, '-t', target]
        if extra_args:
            parts.extend(str(arg) for arg in extra_args)
        command = ' '.join(shlex.quote(part) for part in parts)

        # Bound the channel open too: on a half-open TCP, open_session with no
        # timeout blocks this eventlet SocketIO worker forever — the same bug
        # Class the close_session hardening fixed. settimeout only covers I/O
        # after the channel exists, so it cannot bound the open itself.
        control_channel = transport.open_session(timeout=3.0)
        control_channel.settimeout(3.0)
        control_channel.exec_command(command)
        # Recv_exit_status waits on an internal event and ignores the channel
        # timeout, so on a half-open TCP or a hung tmux it would block this
        # SocketIO handler forever. Poll exit_status_ready against a deadline
        # so the wait is genuinely bounded.
        deadline = time.monotonic() + 3.0
        stdout = b''
        while not control_channel.exit_status_ready():
            if time.monotonic() >= deadline:
                return False, "tmux command timed out", ''
            if capture_output:
                # Drain while waiting: a tmux that writes more than the SSH
                # window can hold would otherwise never exit, turning the
                # deadline above into a guaranteed timeout.
                stdout = _drain_tmux_output(control_channel, stdout,
                                            max_output=max_output)
                if stdout is None:
                    return False, "tmux command produced too much output", ''
            time.sleep(0.05)
        exit_status = control_channel.recv_exit_status()
        if exit_status != 0:
            return False, f"tmux command exited with status {exit_status}", ''
        if capture_output:
            stdout = _drain_tmux_output(control_channel, stdout, final=True,
                                        max_output=max_output)
            if stdout is None:
                return False, "tmux command produced too much output", ''
            return True, None, stdout.decode('utf-8', 'replace')
        return True, None, ''
    except Exception as e:
        log_debug("tmux control command failed",
                  session_id=session_id, error=str(e))
        return False, str(e), ''
    finally:
        if control_channel is not None:
            try:
                control_channel.close()
            except Exception:
                pass

TMUX_SESSION_NAME_RE = re.compile(r'^[A-Za-z0-9_]{1,190}$')
# What list_tmux_sessions passes on: other tools name their sessions with
# dots and dashes (another tool), and they must be counted; only a name
# that is a plain identifier (every SSHDeck name is) can ever be killed.
TMUX_LISTED_NAME_RE = re.compile(r'^[A-Za-z0-9_.-]{1,190}$')
# One line per tmux session on the host; 64 KiB is ~250 sessions of the
# longest names allowed, far beyond any account's real number of sessions.
TMUX_LIST_MAX_OUTPUT = 64 * 1024


def kill_tmux_session(session_id, name=None):
    """Kill ONE tmux session on the host this LIVE session is connected to.

    `name` defaults to the session's own tmux session (the user chose "Close
    session"); the orphan sweep passes a name it read back from tmux. Either
    way the target is the exact-match form `=<name>`, so a prefix can never
    reach a sibling session. Returns ``(ok, error)``; a session with no live
    transport cannot kill anything and says so, which is what lets
    handle_ssh_disconnect keep the saved row instead of orphaning the tmux.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        own = session.get('tmux_session_name') if session else None
    target = name or own
    if not target or not TMUX_SESSION_NAME_RE.match(target):
        return False, "No tmux session to kill"
    return _run_tmux_control_command(session_id, 'kill-session',
                                     target_override='=' + target)


def list_tmux_sessions(session_id):
    """Every tmux session the SSH user of this live session can see.

    Returns ``(ok, error, rows)`` with one ``{'name', 'created', 'attached'}``
    per session. A name outside TMUX_LISTED_NAME_RE is dropped; killing is
    gated separately by TMUX_SESSION_NAME_RE in kill_tmux_session.
    """
    # Space-separated, not tab: tmux 3.7c renders a TAB in a -F format as
    # `_` ( over the app's own transport), which merged the
    # three fields into one and made every host look orphan-free. Names in
    # TMUX_LISTED_NAME_RE carry no whitespace, so a split on whitespace is
    # exact.
    ok, error, output = _exec_tmux_control(
        session_id, 'list-sessions',
        ['-F', '#{session_name} #{session_created} #{session_attached}'],
        capture_output=True, no_target=True,
        max_output=TMUX_LIST_MAX_OUTPUT)
    if not ok:
        return False, error, []
    rows = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) != 3 or not TMUX_LISTED_NAME_RE.match(parts[0]):
            continue
        try:
            rows.append({'name': parts[0], 'created': int(parts[1]),
                         'attached': int(parts[2])})
        except ValueError:
            continue
    return True, None, rows


def set_tmux_mouse_mode(session_id, enabled):
    """Set tmux mouse mode for a single SSHDeck-managed tmux session.

    enabled=True  -> mouse on: tmux owns the pointer, so the terminal (xterm)
                     forwards wheel/drag/touch to tmux, which scrolls its own
                     history and drives copy-mode — the same behaviour as any
                     tmux+mouse setup. This is the default SSHDeck initializes.
                     Shift+drag still forces a local browser selection in xterm
                     (so Ctrl+C can copy via xterm's native copy handler).
    enabled=False -> mouse off: the browser keeps the pointer for local text
                     selection.

    Session-scoped via `set-option -t <session>`; never uses -g/-s, so global
    tmux config and other tools' sessions are untouched.
    """
    if not isinstance(enabled, bool):
        return False, "Invalid mouse mode"
    value = 'on' if enabled else 'off'
    return _run_tmux_control_command(
        session_id, 'set-option', ['mouse', value]
    )

def set_tmux_mode_keys(session_id, mode='emacs'):
    """Force the copy-mode key table for a single SSHDeck-managed tmux session.

    The shared tmux server's global mode-keys is derived from $EDITOR when the
    server starts and has been observed to drift (emacs -> vi). Under vi the
    active table is copy-mode-vi, whose MouseDragEnd1Pane binding is
    stop-selection: it freezes the selection but never sets a buffer and never
    emits OSC 52, so a mouse-drag copy silently produces an empty clipboard.
    Pinning this session to emacs makes drag-end run copy-pipe-and-cancel, which
    (with set-clipboard on) emits OSC 52 back to the browser.

    Session/window-scoped via `set-option -w -t <session>`; never -g/-s, so the
    global config and other tools' sessions (e.g. another tool) are untouched. This
    only affects copy-mode key bindings (users copy with the mouse); it does not
    change the shell's readline vi/emacs mode, which is a different layer.
    """
    if mode not in ('emacs', 'vi'):
        return False, "Invalid mode-keys"
    return _run_tmux_control_command(
        session_id, 'set-option', ['-w', 'mode-keys', mode]
    )


# How far above the cursor row the pending-line read may reach. A
# wrapped shell input line lives on the rows just above the cursor; four rows
# covers any realistic command width without ever streaming a whole pane.
_PENDING_LINE_CONTEXT_ROWS = 4

# The capture read's own output cap. It must exceed the format-query
# cap (_TMUX_CONTROL_MAX_OUTPUT) because a real command line is longer than a
# tmux format string -- bounded, but not by a bound sized for 64 bytes.
_PENDING_LINE_MAX_OUTPUT = 4096

# The ONE refusal reason that means "the pane is on the alternate screen".
#
# `read_tmux_pending_line` already reads `#{alternate_on}` as the first of its two
# tmux commands, so the caller that gets this reason back has been told the pane's
# screen state for free. Naming it here rather than at the call site is what stops
# that from being a string comparison against prose: the handler in socket_events
# imports this constant, and a test can assert the two sides agree. A refusal with
# any OTHER reason -- dead transport, unparsable format, non-tmux session -- says
# nothing about the screen, and the client must treat it as unknown rather than
# reading it as "normal".
PENDING_LINE_ALTERNATE_REASON = "Pane is not at a shell prompt"


def read_tmux_pending_line(session_id):
    """Read the shell's current input line from an SSHDeck-managed tmux pane.

    S14-5 (defect ruling): the composer is the ONE authoritative
    input surface, and when a session reopens its draft must resolve toward
    the TERMINAL's truth. This helper is that truth's only source: it reads
    the pane's visible line at the cursor with `tmux capture-pane -p`, over
    the SAME control channel every other control helper uses -- never the
    interactive PTY.

    D-6'-a boundary (the same reasoning granted for
    _send_escape_to_session_clients): this is a READ. It sends no keys,
    performs no resize, and does not alter PTY authority. The exact-target
    form (`=<session>:`) scopes both commands to this one session; no -g/-s
    touches global state or another tool's sessions.

    Two commands run on two short-lived exec channels:

      1. `display-message -p` answers `pane_in_mode`, `alternate_on`,
         `cursor_y` and `cursor_x`. The read FAILS CLOSED on the alternate
         screen and at column 0: on the alternate screen the row belongs to
         vim/nano/less, and at column 0 the row holds nothing while reporting
         the row ABOVE it would hand back a FINISHED command as pending input.
         Copy mode is NOT a refusal (S17 FIX 4c): `cursor_y`/`cursor_x` keep
         describing the real shell cursor there -- the overlay's own cursor is
         the separate `copy_cursor_y` format -- and with tmux `mouse on` as the
         product default one swipe would otherwise disable terminal truth
         entirely. Measured on a scratch tmux 3.4 server.
      2. `capture-pane -p -J -S <cursor_y-N> -E <cursor_y>` reads the cursor
         row plus a few rows of context, joined (-J) so a tmux-wrapped line
         arrives as one logical line. The window ends AT the cursor row --
         never below it, where empty filler lives.

    Every failure -- non-tmux session, dead transport, alternate screen,
    unparsable format output, failed capture, oversize output -- is
    returned as (False, reason, None). A caller must treat "cannot read" as
    "no terminal truth available", never as an empty line.

    Returns (True, None, {'line': str, 'cursor_x': int, 'cursor_y': int}) on
    success. `line` carries the prompt WITH the typed text exactly as painted;
    separating the prompt from the typed text is the CLIENT's job (it knows
    the sentLen boundary), so nothing here guesses a prompt shape.
    """
    # Query -> read under the per-session control lock, so two concurrent
    # samples cannot interleave their two channels (the same discipline
    # exit_tmux_copy_mode uses for its query -> act pair).
    control_lock = _get_tmux_control_lock(session_id)
    if control_lock is None:
        return False, "Session not found", None

    with control_lock:
        ok, error, output = _exec_tmux_control(
            session_id, 'display-message',
            ['-p', '#{pane_in_mode},#{alternate_on},#{cursor_y},#{cursor_x}'],
            exact_target=True, capture_output=True
        )
        if not ok:
            return False, error, None

        parts = output.strip().split(',')
        if len(parts) != 4:
            # WARNING, not DEBUG: production runs at INFO
            # (audit_logger.py:146), so this refusal was invisible while the
            # composer silently had no terminal truth to work from.
            log_warning("tmux pending-line state unparsable",
                        session_id=session_id, output=output[:32])
            return False, "Unexpected tmux state", None
        try:
            in_mode, alternate_on, cursor_y, cursor_x = (
                int(value) for value in parts)
        except ValueError:
            log_warning("tmux pending-line state not numeric",
                        session_id=session_id, output=output[:32])
            return False, "Unexpected tmux state", None
        if min(in_mode, alternate_on, cursor_y, cursor_x) < 0:
            return False, "Unexpected tmux state", None
        if alternate_on:
            # Fail closed: a full-screen application (vim/nano/less) owns the
            # screen, so the row at the cursor is its painting and not a shell
            # input line. No capture runs, nothing is guessed.
            # The string below IS the screen fact for socket_events to publish;
            # see PENDING_LINE_ALTERNATE_REASON so a second read is not paid.
            return False, PENDING_LINE_ALTERNATE_REASON, None
        # Copy mode is NOT a refusal, for the same reason it was
        # removed from read_tmux_history -- and here it is measured directly
        # on a scratch tmux 3.4 server (/tmp/s16work/s17_copymode_keys.py, own
        # socket, own session):
        #
        #   normal:                   pane_in_mode,alternate_on,cursor_y,cursor_x
        #                             = 0,0,23,39
        #   copy mode, 10 cursor-up:  = 1,0,22,39   and copy_cursor_y = 12
        #   capture-pane -p -J -S 0 -E <cursor_y> in copy mode returned
        #   'root@the host:/tmp# echo pendingtext' -- the real pending row.
        #
        # So `cursor_y`/`cursor_x` keep describing the REAL shell cursor while
        # the pane is in copy mode; the overlay's own cursor is a DIFFERENT
        # format, `copy_cursor_y`, which this function never reads. Copy mode is
        # a VIEW over the same addressed rows, so the capture below is unchanged
        # in what it returns. Do not re-add the refusal believing cursor_y is
        # the overlay's -- it is not.
        #
        # Why it matters: tmux `mouse on` is the product default
        # (socket_events.py:309), so one upward swipe puts the pane in copy mode.
        # This function is the composer's ONLY source of terminal truth
        # (socket_events.py:2016, the sole call site), so refusing here disabled
        # The read exactly on the device and exactly in the state the user
        # Reports, which made the read-first erase fall through to its
        # destructive \x15 fallback.

        if cursor_x == 0:
            # An empty cursor row: after Enter, or the exact wrap boundary.
            # Answering with the row above would report a finished command as
            # pending input, so the honest answer is an empty line.
            return True, None, {'line': '', 'cursor_x': 0,
                                'cursor_y': cursor_y}

        window_start = max(0, cursor_y - _PENDING_LINE_CONTEXT_ROWS)

        ok, error, raw = _exec_tmux_control(
            session_id, 'capture-pane',
            ['-p', '-J', '-S', str(window_start), '-E', str(cursor_y)],
            exact_target=True, capture_output=True,
            max_output=_PENDING_LINE_MAX_OUTPUT
        )
        if not ok:
            return False, error, None
        # -J joins wrapped rows; the cursor row is the LAST non-empty row of
        # the window. Empty rows below the cursor do not exist in this window
        # by construction (-E ends at it).
        lines = [ln for ln in raw.split('\n') if ln != '']
        return True, None, {
            'line': lines[-1] if lines else '',
            'cursor_x': cursor_x, 'cursor_y': cursor_y,
        }


# The client-tty listing's own output cap. It must exceed the format-string cap
# (_TMUX_CONTROL_MAX_OUTPUT = 64) because the answer is one tty PATH per
# attached client, and a session legitimately has several -- one per browser
# socket displaying it, which is the whole point of views. 1024 holds ~50
# typical `/dev/pts/NNN` lines while still being a hard bound on what a hijacked
# remote could stream.
_CLIENT_TTY_LIST_MAX_OUTPUT = 1024


def _send_escape_to_session_clients(session_id):
    """Deliver the Escape KEY to this session's attached tmux clients.

    S30-C REPLACES A PTY WRITE THAT WAS THE OWNER'S DEFECT. Until now this step
    wrote one bare ESC byte to the session's own interactive channel, and the
    docstring justified that by claiming a client target "cannot be resolved
    reliably on a tmux server shared with other tools". Both halves of that were
    wrong, and the first half was actively harmful.

    WHY THE PTY WRITE WAS WRONG. handle_ssh_input runs exit_tmux_copy_mode
    INLINE immediately before the user's write (socket_events.py:1188-1196), and
    the step in between (`copy-mode -q`) travels a SEPARATE short-lived exec
    channel (_exec_tmux_control), i.e. one round trip -- tens of milliseconds
    against tmux's 500ms `escape-time`. tmux therefore read the ESC and the
    user's very next bytes as ONE key stream and forwarded a META sequence to
    the pane, where readline applied it. Measured with a real attached client on
    an isolated scratch server (/tmp/s26reg/s30_p10.log, s30_p11.log):

        ESC + 'echo LANDS'                  -> shell line 'cho LANDS'   (M-e)
        ESC + DEL DEL on 'echo tiến'        -> shell line 'echo '       (M-DEL =
                                               backward-kill-word: a WHOLE WORD)
        ESC + a >escape-time gap + write    -> 'echo LANDS' intact

    which is exactly what production verification reported on the S30-B build
    (/tmp/s26reg/s30_p7b.log): 'cho LANDS', 'cho SETTLED', and two whole-word
    erases. It also had a race: the gate reads `pane_in_mode` on one channel and
    acts on another, so a pane that leaves the mode in between put the ESC on a
    LIVE readline (s30_p11.log arm H, reproduced).

    WHY THE ESCAPE CANNOT SIMPLY BE DROPPED. Its documented job is real. With a
    command-prompt provably open, `copy-mode -q` alone did NOT dismiss it -- the
    invoking client stayed blocked and the following write never reached the
    shell (/tmp/s26reg/s30_p14.log arm T, /tmp/s26reg/s30_p15.log arm T). Drop
    the escape and composer text lands IN the tmux prompt bar, where an Enter
    runs a tmux command. That is worse than the defect being fixed. Nor can the
    send be gated on a prompt signal: with a prompt provably open and provably
    dismissed, NO tmux 3.4 format moved -- eight candidates, all flat, including
    `#{client_prompt}` and `#{client_flags}` (/tmp/s26reg/s30_p16.log via
    s30_p16_promptfmt.py).

    SO THE ESCAPE MOVES OFF THE PTY AND BECOMES A KEY, addressed per client:
    `list-clients` scoped to this session's exact target for the ttys, then one
    command per tty. That is now every browser socket displaying the session,
    which is correct -- a command prompt or copy mode is the PANE's state, so
    every client watching it has to be released. The
    key never touches the pane's byte stream, so there is nothing for
    escape-time to coalesce with and no latency is added. Measured, same scratch
    shape:

        prompt open  -> the prompt IS dismissed and the write reaches the shell
                        (s30_p15.log arm X)
        copy mode    -> pane_in_mode 1 -> 0 and an IMMEDIATE write lands WHOLE
                        (s30_p15.log arms Y/Z, s30_p17.log T3/T4)
        NOTHING open -> harmless: the write behind it is untouched and two
                        erases remove two graphemes, so the stale-gate race
                        above can no longer hurt anyone
                        (/tmp/s26reg/s30_p16.log arms AA/BB/CC, with arm DD
                        showing the OLD mechanism still breaking that same
                        race -- the rows bite)
        a dead tty   -> a bounded non-zero failure, never a hang
                        (s30_p17.log T5: "can't find pane")

    The argument order this module builds (`-t <tty>` before `-K`) was executed
    verbatim rather than assumed, because an unexecuted control command is how
    refresh-client failed silently for the whole life of that feature
    (s30_p17.log T1/T2, both rc=0).

    D-6'-a boundary. The tty list is derived from the session's own stored name,
    never from user input, so another tool's client on a shared host can never
    be addressed; no `-g`/`-s` reads or writes global state; no resize happens
    and PTY authority is untouched. A detached session has no client to key and
    is a success with nothing sent -- the pane-side `copy-mode -q` still runs.

    Returns (ok, error) like every other control helper.
    """
    ok, error, out = _exec_tmux_control(
        session_id, 'list-clients', ['-F', '#{client_tty}'],
        exact_target=True, capture_output=True,
        max_output=_CLIENT_TTY_LIST_MAX_OUTPUT
    )
    if not ok:
        return False, error
    ttys = [line.strip() for line in out.splitlines() if line.strip()]
    if not ttys:
        # Detached persistent session: tmux holds the pane, but there is no
        # client key handling to deliver Escape to. Not a failure -- and the
        # caller's idempotent `copy-mode -q` still clears the pane mode.
        return True, None
    first_error = None
    for tty in ttys:
        ok, error = _run_tmux_control_command(
            session_id, 'send-keys', ['-K', 'Escape'], target_override=tty)
        if not ok and first_error is None:
            first_error = error
    if first_error is not None:
        return False, first_error

    with sessions_lock:
        if session_id in sessions:
            now = time.time()
            sessions[session_id]['last_activity'] = now
            # S2 rev6: exiting copy-mode is a deliberate user control action, so
            # it counts as human interaction (unlike the automatic geometry
            # proposals that ssh_resize carries). This write lived in the PTY
            # Helper replaced; it belongs to the ACTION, not to the
            # transport, so it moves with the action.
            sessions[session_id]['last_interaction'] = now
    return True, None


def exit_tmux_copy_mode(session_id):
    """Leave tmux copy-mode (and any open command-prompt) for one session.

    Touch-swipe scrolling dispatches wheel events, and tmux's default
    WheelUpPane binding puts the pane into `copy-mode -e`. Inside copy-mode
    ordinary letters are copy-mode commands, and g/f/t open a command-prompt on
    the status line — which is what makes typed text appear to land in "the tmux
    bar" instead of the shell. The user needs a way back that does not depend on
    a physical Escape key.

    Sequence, all scoped to this session's own pane/client:
      1. `display-message -p -t '=<session>:' '#{pane_in_mode}'` — ask tmux
         whether the pane really is in a mode.
      2. If it is (exactly "1"), deliver the Escape KEY to this session's
         attached clients over the control channel
         (_send_escape_to_session_clients). That dismisses an open
         command-prompt, which `copy-mode -q` cannot do. S30-C: this used to
         write a bare ESC BYTE to the interactive PTY, which tmux coalesced
         with the user's next bytes inside `escape-time` and forwarded as a
         META sequence -- readline then ate the write's leading character and
         erased a whole word per erase press. The measurements are in that
         helper's docstring.
      3. `copy-mode -q -t '=<session>:'` — clear any mode the pane is still in.
         Idempotent, so it is safe when step 2 already left the mode.
      4. If the pane is not in a mode ("0"), skip the escape entirely: there is
         nothing to dismiss, so sending is pointless. It is no longer DANGEROUS
         either -- an escape with nothing to consume it is measured harmless
         under the new delivery (/tmp/s26reg/s30_p16.log) -- which is what
         closes the race where the pane left the mode between this query and
         the delivery.

    Anything unexpected — a query failure, output that is neither "0" nor "1", a
    failed channel write, a failed copy-mode — is returned as a real error. It
    is never reported as success.

    Returns (ok, error, was_in_mode). `was_in_mode` reports what step 1 actually
    found, so the UI can say "left scroll mode" when there was something to leave
    and "not in scroll mode" when there was not. Both are successes — a button
    that says nothing in the second case reads as a broken button, which is how
    this one was reported.

    Never changes global tmux state, key tables, or another tool's session: the
    target is always built from the stored session name and no -g/-s is used.
    """
    # Hold a per-session control lock across query -> act so two concurrent
    # clicks cannot both read pane_in_mode=1 and both send an ESC (the second of
    # which would leak into the shell). sessions_lock is never held here.
    control_lock = _get_tmux_control_lock(session_id)
    if control_lock is None:
        return False, "Session not found", False

    with control_lock:
        ok, error, output = _exec_tmux_control(
            session_id, 'display-message', ['-p', '#{pane_in_mode}'],
            exact_target=True, capture_output=True
        )
        if not ok:
            return False, error, False

        in_mode = output.strip()
        if in_mode not in ('0', '1'):
            log_debug("Unexpected tmux pane_in_mode output",
                      session_id=session_id, output=in_mode[:16])
            return False, "Unexpected tmux state", False

        was_in_mode = in_mode == '1'

        if was_in_mode:
            sent, send_error = _send_escape_to_session_clients(session_id)
            if not sent:
                return False, send_error, was_in_mode

        cleared, clear_error = _run_tmux_control_command(
            session_id, 'copy-mode', ['-q'], exact_target=True
        )
        return cleared, clear_error, was_in_mode


def close_session(session_id, kill_tmux=False, expected_session=None):
    """Close SSH session and clean up resources.

    kill_tmux: If True and the session uses tmux, kill the remote tmux session.
               Default False — idle timeout and server restart detach only,
               leaving tmux running so the session shows up as a reconnect
               candidate. Pass True only from explicit user disconnect.

    expected_session: optional CALLER-DECIDED identity (the exact session dict
               object the caller judged closable). When provided, re-validation
               under the authority lock compares against IT instead of the
               session captured at close_session's own entry. This closes the
               reaper's TOCTOU: the idle sweep decides under sessions_lock and
               calls close_session AFTER releasing the lock, so an id that is
               re-registered in between must not let close_session capture the
               REPLACEMENT as its expected identity and close it. The default
               None preserves today's behavior for every existing call site —
               each keeps capturing its own identity at entry.

    W13: the REMOVAL takes the session's AUTHORITY lock, exactly like swap and
    the exact-current death claim. Removal is an authority mutation: without the
    lock it could pop and close the session between a reader's ownership check
    and that reader's socket emit, so the terminal would receive output for a
    session the user had just closed -- and a published event cannot be recalled,
    which is why a post-emit re-check is not a fix. Holding the lock means an
    in-flight publication completes first, and every publication that starts
    afterwards finds the session gone and drops its chunk.
    """
    try:
        # Step 1: capture (expected_session, authority_lock). The expected
        # session object is what catches a reused id: if the session is removed
        # and re-registered under the same id while we wait, the dict under that
        # id is a DIFFERENT object, and we must not pop it.
        #
        # When the CALLER provides expected_session, that object is the decided
        # identity: capture its authority lock directly instead of re-reading the
        # registry. Reading the registry here would let a replacement that
        # arrived after the caller's decision become the expected identity --
        # the exact race the parameter exists to prevent.
        if expected_session is not None:
            # sessions_lock is REQUIRED around _session_authority_lock: its
            # setdefault mutates the shared dict, and its contract says the
            # caller holds sessions_lock.
            with sessions_lock:
                authority_lock = _session_authority_lock(expected_session)
        else:
            expected_session, authority_lock = _authority_claim_for(session_id)
            if expected_session is None:
                return False

        # Step 2/3: serialize against publication, swap and death claims for THIS
        # session, then re-validate by EXACT IDENTITY -- the session may have
        # been closed while we waited, or removed and re-registered under the
        # same id. In either case the lock we hold is an orphan and there is
        # nothing to do; touching the replacement would be the reused-id bug.
        # With a caller-provided expected_session the comparison runs against
        # THAT identity, so a replacement registered between the caller's
        # decision and this re-validation is refused.
        with authority_lock:
            with sessions_lock:
                session = sessions.get(session_id)
                if session is None:
                    return False
                if session is not expected_session:
                    # Reused id: a different session is now registered under this
                    # id. Our lock is an orphan; do NOT pop the replacement.
                    return False
                sessions.pop(session_id, None)
                session['connected'] = False
        # Capture the popped session's SFTP owner token for exact cleanup.
        sftp_owner = session.get('_sftp_owner_token')

        # The session is gone for good, so no reader of it may ever again
        # be told "you were swapped out". Leaving a stale flag behind would let a
        # future reader of a REUSED id retire silently instead of reporting a
        # genuine death.
        _discard_reader_handoffs(session_id)

        # All network I/O happens after removing the session from the shared
        # registry, so a slow or half-open SSH transport cannot block unrelated
        # session operations behind sessions_lock.
        try:
            from .sftp_handler import close_sftp_cache
            close_sftp_cache(session_id, expected_owner=sftp_owner)
        except Exception as e:
            log_debug(f"Error closing SFTP cache", session_id=session_id, error=str(e))

        if kill_tmux and session.get('use_tmux') and session.get('tmux_session_name') and session['client']:
            kill_channel = None
            try:
                transport = session['client'].get_transport()
                if transport and transport.is_active():
                    kill_channel = transport.open_session(timeout=TMUX_KILL_TIMEOUT)
                    kill_channel.settimeout(TMUX_KILL_TIMEOUT)
                    command = 'tmux kill-session -t ' + shlex.quote(session['tmux_session_name'])
                    timeout_guard = Timer(TMUX_KILL_TIMEOUT, kill_channel.close)
                    timeout_guard.daemon = True
                    timeout_guard.start()
                    try:
                        kill_channel.exec_command(command)
                        try:
                            kill_channel.recv(1)
                        except Exception:
                            pass
                    finally:
                        timeout_guard.cancel()
            except Exception as e:
                log_debug(f"Error killing tmux session", session_id=session_id, error=str(e))
            finally:
                if kill_channel is not None:
                    try:
                        kill_channel.close()
                    except Exception:
                        pass

        # Every view's channel first: each one is an attached tmux client, and
        # closing it is how tmux learns the device is gone.
        for view_sid, view in list((session.get('views') or {}).items()):
            try:
                view['channel'].close()
            except Exception as e:
                log_debug("Error closing a view channel",
                          session_id=session_id, error=str(e))

        if session['channel']:
            try:
                session['channel'].close()
            except Exception as e:
                log_debug(f"Error closing channel", session_id=session_id, error=str(e))

        if session['client']:
            try:
                session['client'].close()
            except Exception as e:
                log_debug(f"Error closing SSH client", session_id=session_id, error=str(e))

        if session.get('bastion_client'):
            try:
                session['bastion_client'].close()
            except Exception as e:
                log_debug(f"Error closing jump host client", session_id=session_id, error=str(e))

        return True
    except Exception as e:
        log_error(f"Error closing session", session_id=session_id, error=str(e))
        return False

def get_session(session_id):
    """Get session info by ID."""
    with sessions_lock:
        if session_id in sessions:
            session = sessions[session_id]
            return {
                'id': session_id,
                'host': session['host'],
                'port': session['port'],
                'username': session['username'],
                'connected': session['connected'],
                'via_jump': session.get('proxy_jump_host'),
                'use_tmux': session.get('use_tmux', False),
                'tmux_session_name': session.get('tmux_session_name'),
                'display_name': session.get('display_name'),
                # Auth_type was absent from this projection, so every
                # consumer doing session.get('auth_type', db_row.auth_type)
                # silently took the DB branch and the live value was never
                # read. The live record is authoritative for it.
                'auth_type': session.get('auth_type'),
                # The locale asked for, and whether the attached tmux pane
                # predates the locale fix. True means "reattached a legacy pane:
                # its running shell cannot be given UTF-8, only a NEW session
                # can". False means measured fine; None means not measured.
                'utf8_locale': session.get('utf8_locale'),
                'legacy_tmux_locale': session.get('legacy_tmux_locale'),
                'login_shell': session.get('login_shell'),
            }
    return None

def measure_session_latency(session_id):
    """Round-trip time in ms to the SSH host of one session, or None.

    Mockup line 87 puts a per-session number on every desktop chip
    ("root · 34 ms"). The app previously had only ONE latency figure -- the
    status bar's Engine.IO heartbeat (app.js StatusBar), which is
    browser<->SSHDeck and identical for every chip. A per-chip number has to be
    measured per transport.

    The probe is an SSH global request with a name that no server implements, so
    every conforming server answers SSH_MSG_REQUEST_FAILURE (RFC 4254 s4). That
    failure IS the successful measurement: paramiko returns None for a denied
    request, and the round trip is what we time. Nothing is executed on the
    remote host, no channel is opened, and no shell output is disturbed -- which
    matters because the session's channel is carrying the user's live terminal.

    sessions_lock is held only to look the client up, never across the network
    round trip.
    """
    with sessions_lock:
        session = sessions.get(session_id)
        if not session or not session.get('connected'):
            return None
        client = session.get('client')
    if not client:
        return None
    try:
        transport = client.get_transport()
        if not transport or not transport.is_active():
            return None
        started = time.monotonic()
        # keepalive@sshdeck is deliberately not a real request name; the
        # server's REQUEST_FAILURE is the reply we time.
        transport.global_request('keepalive@sshdeck', wait=True)
        elapsed_ms = int(round((time.monotonic() - started) * 1000))
        # A negative or absurd figure is a broken clock, not a measurement.
        if elapsed_ms < 0 or elapsed_ms > 60000:
            return None
        return elapsed_ms
    except Exception as e:
        log_debug("Latency probe failed", session_id=session_id, error=str(e))
        return None


# W3 replay bounds. The server buffer holds up to 512KB (output_buffer_max);
# what may be REPLAYED into a fresh xterm is bounded separately and more
# tightly, because replay competes with the first paint of the restored
# terminal. Both a byte budget and a line budget apply: 256KB of one enormous
# line and 256KB of 40k short lines cost very different amounts to render, and
# only bounding bytes let the second case stall the restore.
REPLAY_MAX_BYTES = 262144      # 256KB of replayable history
REPLAY_MAX_LINES = 5000        # ...and at most this many lines of it
REPLAY_CHUNK_BYTES = 32768     # one sequenced chunk on the wire


# The history read's own output cap. tmux's history is the one control
# read that is legitimately large -- a few hundred KB for a long-lived pane --
# so it cannot share the format-string cap (_TMUX_CONTROL_MAX_OUTPUT = 64) or
# even the pending-line cap (4096). It is still bounded, and an oversize answer
# is an error that triggers ONE smaller retry rather than a silent truncation:
# a stream cut at an arbitrary byte would put a half line at the top of the
# user's scrollback.
HISTORY_MAX_BYTES = 393216      # 384KB, comfortably above REPLAY_MAX_BYTES

# Everything except TAB is stripped from captured history. See
# tests/test_tmux_history_injection.py: the property that makes server-side
# injection safe next to the D4-R replay boundary is that the injected stream
# provably contains NO control bytes -- not "only SGR". `capture-pane -p`
# (without -e) measured exactly 0 escape bytes over 580 lines, so this is a belt
# against a future tmux or a changed option, not a routine transformation.
_HISTORY_CONTROL_RE = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
_HISTORY_ESCAPE_RE = re.compile(
    r'\x1b(?:\[[0-9;:?<>=]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)'
    r'|[()#][0-9A-Za-z]|[=>NOc]|.)')


def _normalise_history_text(raw, max_bytes, max_lines):
    """Turn one `capture-pane` answer into a bounded CRLF line stream.

    THE MECHANISM, in one function. xterm's scrollback is fed only by lines that
    SCROLL OFF THE TOP, and only a newline-terminated stream scrolls -- which is
    exactly what tmux's own repaint is not (it addresses rows absolutely, so
    nothing ever leaves the top and the scrollback cannot fill by construction).
    So the transcript is delivered as plain lines and xterm does the scrolling.

    CRLF, not LF: a bare LF moves down without returning to column 0, so an
    LF-only transcript stair-steps across the screen.

    Trimming keeps the NEWEST lines and always cuts on a line boundary, matching
    build_replay_chunks -- the lines nearest the current screen are the ones the
    user is scrolling back toward, and a half line at the top of the scrollback
    reads as corruption.
    """
    if not raw:
        return ''
    text = _HISTORY_ESCAPE_RE.sub('', raw)
    text = _HISTORY_CONTROL_RE.sub('', text)
    text = text.replace('\r', '')
    lines = text.split('\n')
    # capture-pane terminates its last line, so the split leaves one empty tail
    # element; a pane whose last history line is genuinely blank contributes
    # nothing visible either way.
    if lines and lines[-1] == '':
        lines.pop()
    if not lines:
        return ''
    if max_lines and max_lines > 0 and len(lines) > max_lines:
        lines = lines[-max_lines:]
    out = ''.join(line + '\r\n' for line in lines)
    if max_bytes and max_bytes > 0 and len(out) > max_bytes:
        # Drop whole lines from the front until the budget is met.
        while lines and len(out) > max_bytes:
            lines.pop(0)
            out = ''.join(line + '\r\n' for line in lines)
    return out


def _read_tmux_saved_grid(session_id, max_output):
    """The pane's SAVED (normal) grid, readable only while a TUI owns the pane.

    S35 P78. `capture-pane -a` reads the screen tmux set aside when the program
    switched to the alternate screen -- i.e. the last rows of the SHELL's own
    transcript, the ones the user was looking at before the TUI opened. It is not
    the TUI's rendering: `-a` and the plain read address different grids.

    Measured on a real tmux 3.4 pane with `less` in the foreground and 40 echoed
    marker rows above it (/tmp/s35/p74 output):

        plain  -S -<history_size> -E -1   ->  ROW-1  .. ROW-29
        -a     (visible, saved grid)      ->  ROW-30 .. ROW-40
        comm -12 of the two               ->  EMPTY (disjoint by construction)

    So the newest 11 rows of genuine shell transcript existed ONLY behind `-a`,
    and refusing outright -- which is what produced the 18 logged
    "Pane is on the alternate screen" warnings in 48h -- discarded them.

    On a NORMAL screen the command fails with "no alternate screen", so callers
    must only reach here with `alternate_on` set; this never runs otherwise and
    costs a normal reload nothing.

    Returns the raw stdout, or '' for any failure -- this is an enrichment on top
    of an enrichment and must never cost the scrollback already read.
    """
    ok, _error, raw = _exec_tmux_control(
        session_id, 'capture-pane', ['-a', '-p', '-J'],
        exact_target=True, capture_output=True, max_output=max_output)
    return raw if ok else ''


_DIAGNOSTIC_CAPTURE_MAX = 262144


def capture_screen_for_diagnostic(session_id):
    """What tmux holds for this session's pane, for a screen diagnostic.

    The one honest reference when a browser's screen looks wrong is the pane
    on the host: if tmux holds one prompt row and the engine shows fifty, the
    bytes were right and the drawing was not. Three short control
    commands over the existing transport, each bounded like every other tmux
    control call: the pane as text, the pane with its attributes, and the
    geometry tmux believes in. Nothing here touches the interactive PTY.
    """
    out = {}
    ok, reason, text = _exec_tmux_control(
        session_id, 'capture-pane', ['-p'], exact_target=True,
        capture_output=True, max_output=_DIAGNOSTIC_CAPTURE_MAX)
    out['screen'] = text.split('\n') if ok else None
    if not ok:
        out['error'] = reason
        return out
    ok, reason, text = _exec_tmux_control(
        session_id, 'capture-pane', ['-p', '-e'], exact_target=True,
        capture_output=True, max_output=_DIAGNOSTIC_CAPTURE_MAX)
    out['screen_with_attributes'] = text if ok else None
    ok, reason, text = _exec_tmux_control(
        session_id, 'display-message',
        ['-p', '#{window_width}x#{window_height} pane=#{pane_width}x#{pane_height}'
         ' alt=#{alternate_on} cmd=#{pane_current_command}'
         ' cursor=#{cursor_x},#{cursor_y} history=#{history_size}'],
        exact_target=True, capture_output=True, max_output=1024)
    out['geometry'] = text.strip() if ok else None
    ok, reason, text = _exec_tmux_control(
        session_id, 'list-clients',
        ['-F', '#{client_tty} #{client_width}x#{client_height} #{client_activity}'],
        capture_output=True, max_output=4096)
    out['clients'] = text.strip().split('\n') if ok and text.strip() else []
    return out


def read_tmux_history(session_id, max_bytes=None, max_lines=None):
    """Read the SCROLLBACK HISTORY of an SSHDeck-managed tmux pane (S16 B4).

    THE DEFECT THIS EXISTS FOR. With tmux driving the pane the remote never
    sends a scrolling line stream: tmux repaints its window with absolute cursor
    addressing (`ESC[H` plus one `ESC[K\\r\\n` per row) and keeps the history in
    its OWN buffer. Cursor-addressed painting never scrolls a line off xterm's
    top, and xterm's scrollback is fed only by lines that do -- so the client's
    scrollback could not fill however large it was set (measured: 400 lines
    echoed, 47 held, capacity 5000 unused, before any reload). The history was
    never lost; it was in tmux and the client had no way to see it. The Owner's
    report is exactly that: he cannot swipe back through the session.

    So this is the ONE place that asks tmux for what it holds. The alternatives
    (forwarding scroll gestures into copy-mode; stopping tmux using the alternate
    screen) were rejected in writing -- see /tmp/s16work/b4_history_architecture.txt.

    D-6'-a boundary, the same one granted for the per-client escape: this is a
    READ. It sends NO keys into the pane,
    performs no resize, does not alter PTY authority, never enters copy mode,
    attaches no second client, and changes no tmux option (history-limit
    included). The exact-target form scopes both commands to this one session.

    Two commands on two short-lived exec channels:

      1. `display-message -p` answers `pane_in_mode`, `alternate_on` and
         `history_size`. The read FAILS CLOSED on the alternate screen -- there
         what tmux would return is a full-screen application's own screen, and
         reinjecting it as scrollback would fabricate history the user never saw
         scroll past. It does NOT fail closed in copy mode (S17 FIX 4a): with
         tmux `mouse on` as the product default a swipe enters copy mode, so
         refusing there meant the gesture that produces history to read was the
         gesture that suppressed it, and `pane_in_mode` describes the overlay
         being displayed rather than what the history buffer holds.
         `history_size == 0` means there is nothing above the screen, and no
         capture runs at all.
      2. `capture-pane -p -J -S -<N> -E -1`, N = min(history_size, max_lines).
         `-E -1` ends on the line ABOVE the visible window, so the history and
         the current screen are DISJOINT -- tmux's own repaint draws the screen,
         and a line delivered twice would show a duplicated transcript.
         `-J` joins tmux-wrapped rows so the client re-wraps them at ITS width
         (which under W14-B-3 is the shared authority grid, usually not the width
         tmux wrapped at). No `-e`: see _normalise_history_text.

    Every failure -- non-tmux session, dead transport, alternate screen,
    unparsable state, failed capture -- is RETURNED as
    (False, reason, ''). History is an enrichment; a restore must never fail
    because it was unavailable.

    Returns (True, None, text) where text is a CRLF-terminated line stream, ''
    when the pane has no history.
    """
    max_bytes = HISTORY_MAX_BYTES if max_bytes is None else max_bytes
    max_lines = REPLAY_MAX_LINES if max_lines is None else max_lines

    control_lock = _get_tmux_control_lock(session_id)
    if control_lock is None:
        return False, "Session not found", ''

    with control_lock:
        ok, error, output = _exec_tmux_control(
            session_id, 'display-message',
            ['-p', '#{pane_in_mode},#{alternate_on},#{history_size}'],
            exact_target=True, capture_output=True
        )
        if not ok:
            return False, error, ''

        parts = output.strip().split(',')
        if len(parts) != 3:
            log_debug("tmux history state unparsable",
                      session_id=session_id, output=output[:32])
            return False, "Unexpected tmux state", ''
        try:
            in_mode, alternate_on, history_size = (int(v) for v in parts)
        except ValueError:
            log_debug("tmux history state not numeric",
                      session_id=session_id, output=output[:32])
            return False, "Unexpected tmux state", ''
        if min(in_mode, alternate_on, history_size) < 0:
            return False, "Unexpected tmux state", ''
        # The alternate screen is NO LONGER a blanket refusal here.
        #
        # The old refusal justified itself with "what sits above the window is a
        # full-screen application's own painting". That is false for the range
        # THIS function reads: the capture below ends at `-E -1`, the line
        # directly above the visible window, so the alternate GRID -- which IS
        # that window -- is excluded by construction. The module already says so
        # twice, at build_replay_chunks' seed comment and its trim comment.
        #
        # Measured on tmux 3.4 against a real pane
        # (/tmp/s35/p27_alt_screen_history_guard.py, leg G): with `less` owning
        # the pane, `capture-pane -p -J -S -163 -E -1` returned the 163 lines of
        # genuine pre-TUI SHELL transcript and ZERO alt-grid content, and
        # `history_size` was preserved for the TUI's whole lifetime. The alt grid
        # was reachable only at `-S 0`.
        #
        # This is the same correction for copy mode, and the
        # reasoning recorded below transfers word for word: `alternate_on` says
        # the pane is DISPLAYING a full-screen program; it says nothing about
        # what tmux HOLDS. Refusing here discarded the shell's entire scrollback
        # On any reload that happened while a TUI was up -- the user's "history
        # gone after a reload", with 6 such refusals in production logs across 2
        # sessions.
        #
        #
        # What is still refused is an EMPTY capture on the alternate screen: with
        # nothing readable above the window there is no shell transcript to
        # deliver, and reporting an empty success would retire the restore path's
        # one production warning for this state.
        # Copy mode is NO LONGER a refusal.
        #
        # tmux `mouse on` is the product default (socket_events.py:309), so a
        # single upward swipe puts the pane INTO copy mode -- which made the very
        # action that creates history to read the action that suppressed reading
        # it. Measured on one build: run 1 with no prior gesture delivered 314
        # Rows, run 2 after one swipe delivered none. The requirement ("scroll
        # up, reload, history gone") is exactly that, and it is deterministic.
        #
        # The refusal was also unnecessary on its own terms. `pane_in_mode` says
        # the pane is displaying a scroll overlay; it says nothing about what
        # tmux HOLDS. The capture below is bounded by `history_size` and ends at
        # `-E -1`, both of which are properties of the history buffer, not of the
        # overlay -- so the data was readable and the refusal discarded it.

        if history_size == 0:
            # Nothing above the screen. A normal answer, and no capture runs:
            # an exec channel per attach is a real cost, and `-S -0` would hand
            # back the visible screen instead of history.
            if alternate_on:
                # `_read_tmux_saved_grid` existed, was measured and
                # was covered by tests, but had ZERO call sites -- dead code. This
                # is the branch it was written for: with a TUI owning the pane and
                # no scrollback above the window, the newest rows of genuine SHELL
                # transcript live ONLY behind `capture-pane -a`, the grid tmux set
                # aside when the program switched to the alternate screen.
                #
                # An EMPTY read still fails closed: with nothing readable there is
                # no transcript to deliver, and reporting an empty success would
                # retire the restore path's one production warning for this state.
                raw = _read_tmux_saved_grid(session_id, HISTORY_MAX_BYTES)
                text = _normalise_history_text(raw, max_bytes, max_lines) if raw else ''
                if not text:
                    return False, "Pane is on the alternate screen", ''
                return True, None, text
            return True, None, ''

        lines_wanted = history_size
        if max_lines and max_lines > 0:
            lines_wanted = min(lines_wanted, max_lines)

        # ONE retry, halved. The output cap must stay a hard error (a hijacked
        # remote cannot be allowed to stream unbounded data into this worker),
        # but a legitimately huge history is the EXPECTED case for a long-lived
        # pane -- so rather than abandoning history entirely, ask for less. One
        # retry only: this runs on the restore path and must stay bounded.
        attempts = [lines_wanted]
        if lines_wanted > 1:
            attempts.append(max(1, lines_wanted // 2))

        last_error = None
        for attempt in attempts:
            ok, error, raw = _exec_tmux_control(
                session_id, 'capture-pane',
                ['-p', '-J', '-S', str(-attempt), '-E', '-1'],
                exact_target=True, capture_output=True,
                # The READ cap is the module constant, never the caller's trim
                # budget. They are different bounds for different reasons: the
                # cap protects this worker from a remote streaming unbounded
                # data, while max_bytes is how much of a legitimate answer the
                # client is willing to render. Conflating them made a small trim
                # budget reject a perfectly good capture.
                max_output=HISTORY_MAX_BYTES
            )
            if ok:
                text = _normalise_history_text(raw, max_bytes, max_lines)
                if alternate_on:
                    # The scrollback just read ends at
                    # `-E -1`, the line ABOVE the window, so it STOPS where the
                    # saved grid begins -- the two are disjoint by construction
                    # (measured: plain read gave ROW-1..29, `-a` gave ROW-30..40,
                    # comm -12 of the two was empty).
                    #
                    # The saved grid is NEWER than the scrollback, so it goes
                    # AFTER it: the other order reads the transcript backwards.
                    saved_raw = _read_tmux_saved_grid(session_id, HISTORY_MAX_BYTES)
                    saved = (_normalise_history_text(saved_raw, max_bytes, max_lines)
                             if saved_raw else '')
                    if not text and not saved:
                        return False, "Pane is on the alternate screen", ''
                    return True, None, (text + saved) if text else saved
                return True, None, text
            last_error = error
            if 'too much output' not in (error or ''):
                # Not a size problem -- a dead transport or a vanished pane.
                # Retrying with fewer lines cannot help.
                break

        return False, last_error or "Could not read tmux history", ''


def _split_oversized_element(element, limit):
    """Break one buffer element into pieces no larger than ``limit`` bytes.

    Buffer elements are whatever ``channel.recv`` happened to return, so a
    single element can be far larger than a chunk (a 200KB paste, `cat` of a
    minified file). Emitting it whole would blow the chunk budget it was
    supposed to respect, so oversized elements are split rather than dropped --
    the bound is on chunk size, never on whether the content survives.
    """
    if limit <= 0:
        return [element]
    return [element[i:i + limit] for i in range(0, len(element), limit)] or ['']


def build_replay_chunks(session_id, max_bytes=None, max_lines=None,
                        chunk_bytes=None, include_buffer=True):
    """Bounded, ordered replay of one session's HISTORY plus its gap buffer.

    Returns ``(chunks, meta)`` where ``chunks`` is a list of strings to send in
    order and ``meta`` describes what was included:
    ``{'bytes', 'lines', 'truncated', 'dropped_bytes', 'total_chunks',
    'history_lines'}``.

    TWO SOURCES, in age order, in ONE sequence.

      1. tmux's own SCROLLBACK HISTORY (read_tmux_history), for tmux sessions.
         This is S16 B4. tmux repaints rather than scrolls, so nothing the client
         ever received could fill its scrollback -- the history sat in tmux where
         the client could not see it, which is the Owner's "cannot swipe back"
         report. It is delivered as a plain CRLF line stream, so xterm scrolls it
         into scrollback the ordinary way and the gesture/pan code needs no
         change.
      2. the GAP BUFFER: the bytes this client missed while it was away. Newer
         than the history, so it follows it -- the other order reads backwards.

    ``include_buffer=False`` delivers HISTORY ONLY, and it is what every TMUX
    caller uses: a tmux session keeps no gap buffer (its reader is per view and
    never appends), and the view's own attach repaints the visible screen, so the
    only thing missing from the client is the scrollback ABOVE that screen.

    The budgets apply to the COMBINED stream, not per source: the client sizes its
    scrollback from REPLAY_MAX_LINES, so that number is what the whole replay must
    fit inside. When either budget bites, the OLDEST content is trimmed from the
    front -- the newest screen is what the user needs, and a dropped prefix is
    announced, never silently discarded.

    Ordering is the caller's to preserve: the chunks must reach the client in list
    order and before any live output for the same session.
    """
    import re as _re

    max_bytes = REPLAY_MAX_BYTES if max_bytes is None else max_bytes
    max_lines = REPLAY_MAX_LINES if max_lines is None else max_lines
    chunk_bytes = REPLAY_CHUNK_BYTES if chunk_bytes is None else chunk_bytes

    empty_meta = {'bytes': 0, 'lines': 0, 'truncated': False,
                  'dropped_bytes': 0, 'total_chunks': 0, 'history_lines': 0}

    with sessions_lock:
        if session_id not in sessions:
            return [], dict(empty_meta)
        use_tmux = bool(sessions[session_id].get('use_tmux'))
        buf = list(sessions[session_id].get('output_buffer') or [])

    # The history read happens OUTSIDE sessions_lock: it is network I/O over a
    # short-lived exec channel, and holding the registry lock across it would
    # serialise every other session operation for the duration of a restore.
    history = ''
    # THE SCROLLBACK IS ALWAYS SAFE TO REPLAY, because it is text, not a paint.
    #
    # `read_tmux_history` reads to `-E -1` -- the line directly above the visible
    # window -- and `_normalise_history_text` strips every escape, so what arrives
    # is a plain CRLF line stream. A client renders it at its OWN width and
    # re-wraps long lines, which is exactly what any terminal does to scrollback.
    #
    # The old design had to refuse it whenever a full-screen program owned the
    # pane: there the client was fed an absolutely-addressed paint for somebody
    # else's width, and the scrollback landed on top of it. With one tmux client
    # per socket the attach repaint is produced FOR THIS CLIENT at its own size,
    # so there is nothing to collide with.
    if use_tmux:
        # Module-qualified so a monkeypatched read_tmux_history is honoured and
        # so the call site reads as the boundary it is.
        ok, history_error, history = read_tmux_history(
            session_id, max_lines=max_lines)
        if not ok:
            # History is an ENRICHMENT, never a precondition: the restore
            # proceeds with exactly what it delivered before this existed.
            #
            # Logged at WARNING, not DEBUG. Production runs at INFO,
            # So every refusal here was invisible -- which is why a clean
            # log was mistaken for evidence that history injection worked. The
            # user-visible symptom (R6b: history gone after a reload) has exactly
            # one server-side trace and it must be readable at the production
            # level. It is bounded by construction: one line per attach.
            log_warning("tmux history unavailable for replay",
                        session_id=session_id, error=history_error)
            history = ''
    history_lines = history.count('\n')

    output = ''.join(buf) if include_buffer else ''
    if not history and not output:
        return [], dict(empty_meta)

    # Same Device-Attributes filter the live path applies, for the same reason:
    # a replayed ESC[c would be answered by xterm as if the host had just asked.
    # Only the gap buffer can contain one -- the history stream is stripped of
    # every escape by _normalise_history_text.
    output = _re.sub(r'\x1b\[[?>]?[0-9;]*c', '', output)
    # Age order, oldest first: scrollback, then the gap buffer (non-tmux only).
    output = history + output
    original_len = len(output)

    truncated = False

    # Byte budget: keep the tail.
    if len(output) > max_bytes:
        output = output[-max_bytes:]
        truncated = True

    # Line budget: keep the last max_lines lines. Counted after the byte trim so
    # the two budgets compose instead of fighting.
    if max_lines > 0:
        newline_count = output.count('\n')
        # Strictly greater: a buffer sitting exactly at the budget is complete,
        # and must not be reported as truncated.
        if newline_count > max_lines:
            # Cut just after the (newline_count - max_lines)-th newline from the
            # START, which leaves exactly max_lines newline-terminated lines.
            # Counting max_lines newlines from the END and cutting after the last
            # one found is an off-by-one: that newline belongs to the line
            # BEFORE the range being kept, so it leaves max_lines - 1.
            to_skip = newline_count - max_lines
            pos = -1
            for _ in range(to_skip):
                pos = output.find('\n', pos + 1)
                if pos == -1:
                    break
            if pos >= 0:
                output = output[pos + 1:]
                truncated = True

    dropped_bytes = original_len - len(output)
    # Report the history that SURVIVED the trim, not the history that was read.
    # Both budgets cut from the FRONT, and the front is where the history is, so
    # a budget that bites eats the oldest history first -- reporting the pre-trim
    # number would overstate what the client actually received.
    if dropped_bytes >= len(history):
        history_lines = 0
    elif dropped_bytes > 0:
        history_lines = history[dropped_bytes:].count('\n')

    chunks = []
    for piece in _split_oversized_element(output, chunk_bytes):
        if piece:
            chunks.append(piece)

    meta = {
        'bytes': len(output),
        'lines': output.count('\n'),
        'truncated': truncated,
        'dropped_bytes': dropped_bytes,
        'total_chunks': len(chunks),
        # How many lines of the delivered stream came from tmux's history. It is
        # the number that says whether the B4 mechanism actually did anything on
        # this restore, so it is reported rather than inferred from the total.
        'history_lines': history_lines,
    }
    return chunks, meta


def get_output_buffer(session_id):
    """Get buffered output for a session (gap-filler replay on reconnect).

    The byte join and the Device-Attributes filter run OUTSIDE sessions_lock:
    the lock guards the record map, and holding it across a ~512KB regex
    serializes every other session operation while one restore replays. The
    list copy taken under the lock is what gets processed.
    """
    import re as _re
    with sessions_lock:
        if session_id not in sessions:
            return ''
        buf = list(sessions[session_id].get('output_buffer') or [])
    if not buf:
        return ''
    output = ''.join(buf)
    # Filter Device Attributes responses (ESC[c sequences only)
    output = _re.sub(r'\x1b\[[?>]?[0-9;]*c', '', output)
    return output

def cleanup_idle_sessions():
    """Clean up sessions that have been idle too long."""
    try:
        from . import socketio
        current_time = time.time()
        to_close = []
        to_warn = []

        with sessions_lock:
            for session_id, session in sessions.items():
                # S2 rev6 (a): the persistent/tmux exemption is checked BEFORE
                # The timeout comparison, never after. The user's persistent
                # tmux sessions used to survive only by accident -- the
                # automatic keep-alive and remote output kept refreshing them --
                # so removing those refreshers without this exemption would
                # start reaping exactly the sessions that are meant to outlive
                # a disconnect. `use_tmux` is the registry's copy of the value
                # the DB's SSHSession.is_persistent is derived from (set at
                # create and re-set on every transport swap), so no DB query is
                # needed here: this runs on a bare thread with no app context.
                if session.get('use_tmux'):
                    session['_warned'] = False
                    continue

                # S2 rev6 (b): read HUMAN interaction, not connectivity/output
                # liveness. .get with a fallback chain is required, not
                # stylistic: sessions created before this field existed, and the
                # hand-built registry dicts in the existing test fixtures, carry
                # only last_activity -- and a missing key must never read as
                # "infinitely idle".
                last_interaction = session.get('last_interaction')
                if last_interaction is None:
                    last_interaction = session.get('last_activity', current_time)
                idle_time = current_time - last_interaction

                if idle_time > config.SESSION_TIMEOUT:
                    # S2 step 3: capture user_id HERE, inside the lock. The
                    # notification needs the owning room, and close_session pops
                    # the entry -- so after the close there is nothing left to
                    # read it from. Same tuple shape as to_warn below.
                    #
                    # S2 step R3-A: also capture the SESSION OBJECT ITSELF -- the
                    # identity this sweep DECIDED to close. close_session receives
                    # it as expected_session, so an id re-registered between this
                    # decision and the close is refused instead of closed.
                    to_close.append((session_id, session.get('user_id'), session))
                elif idle_time > (config.SESSION_TIMEOUT - 120) and not session.get('_warned'):
                    to_warn.append((session_id, session.get('user_id')))
                    session['_warned'] = True
                elif idle_time <= (config.SESSION_TIMEOUT - 120) and session.get('_warned'):
                    session['_warned'] = False

        for session_id, user_id in to_warn:
            if user_id:
                room = f'user_{user_id}'
                socketio.emit('session_timeout_warning', {
                    'session_id': session_id
                }, room=room)
                log_debug(f"Sent timeout warning for session: {session_id}")

        for session_id, user_id, decided_session in to_close:
            # S2 step 3, approved contract: CLOSE FIRST, then notify -- and
            # notify ONLY on a confirmed close.
            #
            # close_session returns False in three cases (no authority claim,
            # entry already gone, and REUSED ID -- a different session object now
            # registered under this id, which it deliberately refuses to pop:
            # "our lock is an orphan; do NOT pop the replacement"). In every one
            # of those cases this sweep closed nothing, so it must claim nothing:
            # announcing a disconnect for a reused id would tell the client that
            # the LIVE replacement had died, and its handler would mark that
            # session disconnected and tear down a working pane. A published
            # event cannot be recalled.
            #
            # S2 step R3-A: decided_session is the identity this sweep judged
            # idle, captured under sessions_lock above. Passing it closes the
            # TOCTOU between the idle decision and the close: an id
            # re-registered in between is refused, not closed. Without it,
            # close_session would capture the replacement as its own expected
            # identity and close a session the sweep never judged.
            if not close_session(session_id, expected_session=decided_session):
                log_debug("Idle close did not apply; leaving any replacement "
                          "untouched and emitting nothing",
                          session_id=session_id)
                continue

            log_info(f"Closed idle session: {session_id}")

            # Reuse the EXISTING ssh_disconnected event rather than inventing
            # one: it already carries {session_id, reason}, is emitted by the
            # user-disconnect route and the transport-death path, and the shipped
            # client handler already updates session status, refreshes the
            # transfer selects and notifies the SFTP manager. A new event would
            # need a client change and would leave older clients silent -- the
            # "reaped session leaves a live-looking pane" defect.
            #
            # Contained, like the transport-death emit: the close has already
            # reclaimed the capacity slot, so a failing emit must never propagate
            # and must never undo it. A broken socket layer that aborted the
            # sweep would silently stop reclaiming slots -- the capacity
            # starvation this row exists to fix.
            if user_id:
                try:
                    socketio.emit('ssh_disconnected', {
                        'session_id': session_id,
                        'reason': 'Idle timeout',
                    }, room=f'user_{user_id}')
                except Exception as emit_error:
                    log_error("Error emitting ssh_disconnected after idle close",
                              session_id=session_id, error=str(emit_error))

    except Exception as e:
        log_error(f"Error cleaning up idle sessions", error=str(e))

import atexit

def cleanup_all_sessions():
    """Close all sessions on application exit."""
    with sessions_lock:
        session_ids = list(sessions.keys())

    for session_id in session_ids:
        close_session(session_id)

atexit.register(cleanup_all_sessions)
