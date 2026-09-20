"""W3: how bounded replay is DELIVERED — sid scoping, sequencing, terminators.

The bounds themselves are pinned in tests/test_replay_bounds.py. What matters
here is the wire contract restore depends on, and each assertion maps to a real
defect:

  * replay went to the whole user room, so a second tab connecting redrew the
    first tab's terminals. Every chunk must reach ONLY the connecting sid;
  * the buffer rode along as one inline ``buffered_output`` blob on the restore
    event, raced live output, and had to be written before first paint. It is now
    explicitly sequenced AFTER the snapshot;
  * a session with an EMPTY buffer still has to release the client's replay gate,
    or live output would queue forever behind a replay that never arrives. Hence
    the explicit empty terminator. S35 P30 removed the client's DEPENDENCE on that
    frame as well -- a zero-chunk restore now opens no gate to release -- but the
    terminator stays on the wire for older clients and for a gate opened by an
    out-of-order chunk;
  * a disconnected persistent CANDIDATE is an offer, not a terminal. It must
    receive no replay at all — there is no xterm to write into.

: this wire contract is a NON-TMUX concern. A tmux session's
returning tab opens its own tmux client (`view_attach`), which repaints the
visible screen at that tab's own size and fetches the scrollback in the same
request, so restore sends it no chunks and no terminator at all -- and the
client must not open a replay window for one, or every live frame would queue
behind a terminator that is never coming. The sessions below are therefore
plain SSH sessions, and the tmux rule has its own test at the end.
"""
import importlib
import os
import tempfile
import time
from pathlib import Path

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


def _register(app, username):
    with app.app_context():
        user, error = register_user(username, 'replay-pass-123')
        assert error is None
        return user.id


def _ram_session(user_id, buffer_elements=(), use_tmux=False):
    """One live session in ssh_manager.sessions.

    Plain by default: the gap buffer is the ONLY place a non-tmux session's
    missed output exists, so it is the session shape this wire contract is
    about.
    """
    return {
        'client': object(),
        'channel': object(),
        'host': 'replay.example.com',
        'port': 22,
        'username': 'deploy',
        'user_id': user_id,
        'connected': True,
        'last_activity': time.time(),
        'bastion_client': None,
        'proxy_jump_host': None,
        'auth_type': 'key',
        'use_tmux': use_tmux,
        'tmux_session_name': 'sshdeck_replay' if use_tmux else None,
        'display_name': 'Replay box',
        'output_buffer': list(buffer_elements),
        'output_buffer_size': sum(len(e) for e in buffer_elements),
        'output_buffer_max': 512000,
    }


def _seed(app, user_id, session_id, **kwargs):
    from app.models import SSHSession, db
    fields = {
        'host': 'replay.example.com',
        'port': 22,
        'username': 'deploy',
        'connected': True,
        'is_persistent': True,
        'auth_type': 'key',
        'key_id': 'key-replay-1',
        'tmux_session_name': 'sshdeck_replay',
        'display_name': 'Replay box',
    }
    fields.update(kwargs)
    with app.app_context():
        row = SSHSession(session_id=session_id, user_id=user_id, **fields)
        db.session.add(row)
        db.session.commit()


def _capture_restore(app, user_id, to_sid='sid-CONNECTING'):
    """Run the real restore path with emit spied, returning every event."""
    from app import socket_events
    captured = []
    with app.app_context():
        original_emit = socket_events.emit

        def spy(event, payload=None, **kwargs):
            captured.append((event, payload, kwargs))

        socket_events.emit = spy
        try:
            socket_events.restore_user_sessions(user_id, to_sid=to_sid)
        finally:
            socket_events.emit = original_emit
    return captured


def _chunks(captured, session_id=None):
    out = [p for (e, p, _k) in captured if e == 'ssh_replay_chunk']
    if session_id is not None:
        out = [p for p in out if p['session_id'] == session_id]
    return out


# ---- sequencing -------------------------------------------------------------

def test_replay_chunks_follow_the_snapshot_in_sequence(app):
    """Order on the wire is the contract; the client writes strictly by seq."""
    user_id = _register(app, 'replay_seq_user')
    sid = 'replay-seq-1'
    payload = 'z' * 90000  # more than one chunk
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, [payload])

    captured = _capture_restore(app, user_id)
    names = [e for (e, _p, _k) in captured]

    # The snapshot comes first: the client opens its replay window on it, so a
    # chunk arriving before it would have nowhere to go.
    assert names[0] == 'ssh_session_restored'
    chunks = _chunks(captured, sid)
    assert len(chunks) > 1, 'a 90KB buffer must be split into several chunks'
    assert [c['seq'] for c in chunks] == list(range(1, len(chunks) + 1))
    assert all(c['total'] == len(chunks) for c in chunks)
    # Exactly one terminator, and it is the last chunk.
    assert [c['final'] for c in chunks] == \
        [False] * (len(chunks) - 1) + [True]
    # Reassembly is lossless.
    assert ''.join(c['data'] for c in chunks) == payload


def test_snapshot_announces_the_chunk_count_and_no_longer_inlines_the_buffer(app):
    """The blob is gone: an inline 512KB string had to be parsed and written
    before first paint, and it raced live output."""
    user_id = _register(app, 'replay_meta_user')
    sid = 'replay-meta-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, ['hello\r\n'])

    captured = _capture_restore(app, user_id)
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]

    assert 'buffered_output' not in snapshot
    assert snapshot['replay_total_chunks'] == 1
    assert snapshot['replay_truncated'] is False
    assert snapshot['replay_dropped_bytes'] == 0


def test_snapshot_announces_the_replay_line_cap(app):
    """S16 D4-H1: the snapshot carries REPLAY_MAX_LINES.

    The client derives its scrollback capacity from this number instead of
    guessing one. The two were chosen independently and disagreed by a factor of
    33 -- the server replayed up to 5000 lines while the client built its
    terminal with 150 -- so history this very code path had already serialised
    and sent was evicted from the buffer the moment it was written. Announcing
    the cap makes the client's capacity a function of what the server will
    actually deliver, and keeps it correct if the cap is ever retuned.
    """
    user_id = _register(app, 'replay_cap_user')
    sid = 'replay-cap-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, ['hello\r\n'])

    captured = _capture_restore(app, user_id)
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]

    assert snapshot['replay_max_lines'] == ssh_manager.REPLAY_MAX_LINES
    # Non-vacuous: it must be the real cap, not a placeholder that happens to
    # be truthy, and it must be an int the client can clamp with.
    assert isinstance(snapshot['replay_max_lines'], int)
    assert snapshot['replay_max_lines'] > 0


def test_seq_numbering_starts_at_one(app):
    """1-based so "no chunks" can never be confused with "chunk zero"."""
    user_id = _register(app, 'replay_one_user')
    sid = 'replay-one-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, ['x\r\n'])

    chunks = _chunks(_capture_restore(app, user_id), sid)
    assert [c['seq'] for c in chunks] == [1]
    assert chunks[0]['final'] is True


def test_empty_buffer_still_sends_a_terminator(app):
    """Without this the client's live queue never drains.

    The gate opens on the snapshot, so a session with nothing buffered must
    still be told the replay is over — otherwise its live output sits queued
    behind a replay that will never arrive.
    """
    user_id = _register(app, 'replay_empty_user')
    sid = 'replay-empty-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, [])

    captured = _capture_restore(app, user_id)
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]
    assert snapshot['replay_total_chunks'] == 0

    chunks = _chunks(captured, sid)
    assert len(chunks) == 1
    assert chunks[0]['seq'] == 0
    assert chunks[0]['total'] == 0
    assert chunks[0]['data'] == ''
    assert chunks[0]['final'] is True


def test_the_client_opens_no_replay_gate_for_a_zero_chunk_restore():
    """S35 P30: the client must not depend on the terminator above to paint.

    The restore path called ``TerminalManager.beginReplay`` for ANY integer
    ``replay_total_chunks``, zero included. A window opened with nothing to
    replay can only be closed from the far end, and while it is open
    ``writeOutput`` queues every live frame -- so losing, racing or forgetting
    the one terminator asserted above costs a permanently BLANK terminal rather
    than a missing scrollback.

    app.js already stated this contract for the connect path ("Zero chunks ...
    opens nothing at all"), where no terminator is sent at all
    (``emit_attach_replay`` returns early on an empty chunk list). The restore
    path now honours it too, so correctness no longer rests on the two halves
    being paired.

    Pinned as source rather than behaviour because the guard is one condition on
    one line; the behavioural proof, in both directions, is
    /tmp/s35/p30_zero_chunk_replay_gate.mjs.
    """
    source = (Path(__file__).resolve().parents[1]
              / 'static' / 'js' / 'session-manager.js').read_text(encoding='utf-8')

    assert 'if (Number.isInteger(data.replay_total_chunks)\n' \
           '            && data.replay_total_chunks > 0) {' in source, (
        'restoreSession must open a replay window only for a POSITIVE chunk '
        'count; an unguarded beginReplay(sessionId, 0) opens a gate that only '
        'the server can close'
    )
    # The unguarded shape must be gone, not merely shadowed.
    assert 'if (Number.isInteger(data.replay_total_chunks)) {' not in source

    # The legacy inline branch must remain reachable: a payload with no chunk
    # count at all still carries its history in buffered_output.
    assert 'else if (data.buffered_output) {' in source


def test_truncation_is_reported_on_every_chunk_and_the_snapshot(app):
    """A silent drop leaves the user unable to tell where their session began."""
    user_id = _register(app, 'replay_trunc_user')
    sid = 'replay-trunc-1'
    payload = ''.join(f'line{i}\n' for i in range(60000))
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, [payload])

    captured = _capture_restore(app, user_id)
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]
    chunks = _chunks(captured, sid)

    assert snapshot['replay_truncated'] is True
    assert snapshot['replay_dropped_bytes'] > 0
    assert all(c['truncated'] is True for c in chunks)
    assert chunks[-1]['dropped_bytes'] == snapshot['replay_dropped_bytes']
    # The NEWEST output survived.
    assert ''.join(c['data'] for c in chunks).endswith('line59999\n')


# ---- scoping ----------------------------------------------------------------

def test_every_replay_chunk_is_scoped_to_the_connecting_sid(app):
    """The multi-tab defect: replay to the user room redrew other tabs."""
    user_id = _register(app, 'replay_sid_user')
    sid = 'replay-sid-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(user_id, ['y' * 70000])

    captured = _capture_restore(app, user_id, to_sid='sid-TAB-TWO')
    rooms = [k.get('room') for (e, _p, k) in captured
             if e == 'ssh_replay_chunk']
    assert rooms, 'no replay chunks emitted'
    assert all(room == 'sid-TAB-TWO' for room in rooms), rooms
    assert f'user_{user_id}' not in rooms


def test_replay_chunks_name_their_own_session(app):
    """Two restored sessions must not have their histories crossed."""
    user_id = _register(app, 'replay_two_user')
    _seed(app, user_id, 'replay-two-a')
    _seed(app, user_id, 'replay-two-b')
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['replay-two-a'] = _ram_session(user_id, ['AAA\r\n'])
        ssh_manager.sessions['replay-two-b'] = _ram_session(user_id, ['BBB\r\n'])

    captured = _capture_restore(app, user_id)
    a = _chunks(captured, 'replay-two-a')
    b = _chunks(captured, 'replay-two-b')

    assert ''.join(c['data'] for c in a) == 'AAA\r\n'
    assert ''.join(c['data'] for c in b) == 'BBB\r\n'
    # Each stream is independently sequenced from 1.
    assert [c['seq'] for c in a] == [1]
    assert [c['seq'] for c in b] == [1]


def test_disconnected_candidate_receives_no_replay(app):
    """A candidate is an offer, not a terminal: there is no xterm to write to.

    Sending it replay would either be dropped or, worse, write into whichever
    terminal the client happened to associate with the id.
    """
    import config
    from app import socket_events
    user_id = _register(app, 'replay_candidate_user')
    sid = 'replay-candidate-1'
    # Persistent, NOT connected, and no RAM record at all.
    _seed(app, user_id, sid, connected=False)

    original = config.TMUX_ENABLED
    config.TMUX_ENABLED = True
    try:
        captured = _capture_restore(app, user_id)
    finally:
        config.TMUX_ENABLED = original

    offers = [p for (e, p, _k) in captured if e == 'persistent_session_available']
    assert len(offers) == 1, 'the candidate should still be offered'
    assert offers[0]['session_id'] == sid
    # No replay, and no replay metadata pretending there is a terminal.
    assert _chunks(captured, sid) == []
    assert 'replay_total_chunks' not in offers[0]
    assert 'buffered_output' not in offers[0]


def test_a_tmux_session_gets_the_snapshot_and_nothing_else(app):
    """The tmux rule, stated as the absence of every replay frame.

    A tmux session is repainted by its own attach, so restore must send no
    chunk and -- load-bearing -- no empty terminator either: the terminator is
    what opens and closes the client's replay window, and a window opened here
    would have nothing to close it.
    """
    user_id = _register(app, 'replay_tmux_user')
    sid = 'replay-tmux-1'
    _seed(app, user_id, sid)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _ram_session(
            user_id, ['z' * 90000], use_tmux=True)

    captured = _capture_restore(app, user_id)

    names = [e for (e, _p, _k) in captured]
    assert names == ['ssh_session_restored']
    assert _chunks(captured, sid) == []
    snapshot = [p for (e, p, _k) in captured if e == 'ssh_session_restored'][0]
    # The count on the snapshot has to agree with the wire, or a client would
    # wait for chunks that were never sent.
    assert snapshot['replay_total_chunks'] == 0
    assert snapshot['replay_truncated'] is False
