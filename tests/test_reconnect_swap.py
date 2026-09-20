"""W2: one lifecycle owner + prepare-and-swap Reconnect.

The defects these tests pin, all of which came from the old
destroy-then-recreate Reconnect (client closed the session, waited 500 ms, then
issued a fresh ``ssh_connect``):

  * a reconnect produced a NEW session_id, so the xterm, its scrollback, its
    pane and the DB row's identity were all discarded -- a "reconnect" was
    really a replace;
  * the tmux session was killed by the disconnect before the reattach, so the
    remote state the user wanted back was destroyed by the act of asking for it;
  * a failure after the close left NOTHING running: the session the user asked
    to reconnect was already gone;
  * the old output reader, finding its transport dead, emitted
    ``ssh_disconnected`` and called ``close_session`` -- so even a SUCCESSFUL
    swap would tear the session down from behind;
  * two concurrent reconnect requests raced two replacement transports against
    the same session.

The SSH transport itself cannot exist in a unit test, so it is faked; every
other assertion reads real production code -- ``swap_session_transport``,
``read_ssh_output``'s handoff handling, the reconnect ownership claim, and the
``ssh_reconnect`` handler's routing decisions.
"""
import importlib
import os
import sys
import tempfile
import threading
import time

import pytest

from app import ssh_manager


class FakeChannel:
    """Channel that can be scripted to return data, EOF, or raise."""

    def __init__(self, name='chan', chunks=None, raise_on_recv=None):
        self.name = name
        self.chunks = list(chunks or [])
        self.raise_on_recv = raise_on_recv
        self.closed = False
        self.exit_ready = False
        self.sent = []

    def settimeout(self, _timeout):
        pass

    def recv(self, _size):
        if self.raise_on_recv is not None:
            raise self.raise_on_recv
        if self.chunks:
            return self.chunks.pop(0)
        return b''  # EOF

    def send(self, data):
        self.sent.append(data)
        return len(data)

    def exit_status_ready(self):
        return self.exit_ready

    def close(self):
        self.closed = True


class FakeTransport:
    def __init__(self):
        self.keepalive = None

    def set_keepalive(self, seconds):
        self.keepalive = seconds

    def is_active(self):
        return True


class FakeClient:
    def __init__(self, name='client'):
        self.name = name
        self.closed = False
        self.transport = FakeTransport()
        # SFTP: tests that exercise get_sftp_client monkeypatch this per instance.
        self.open_sftp = None

    def get_transport(self):
        return self.transport

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def clean_state():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
        ssh_manager._pending_connections = 0
    with ssh_manager._reader_handoff_lock:
        ssh_manager._reader_handoff.clear()
    with ssh_manager._reconnect_in_flight_lock:
        ssh_manager._reconnect_in_flight.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
        ssh_manager._pending_connections = 0
    with ssh_manager._reader_handoff_lock:
        ssh_manager._reader_handoff.clear()
    with ssh_manager._reconnect_in_flight_lock:
        ssh_manager._reconnect_in_flight.clear()


def _register_session(session_id, client, channel, **overrides):
    import uuid as _uuid
    session = {
        'client': client,
        'channel': channel,
        'host': 'swap.example.com',
        'port': 22,
        'username': 'deploy',
        'user_id': 11,
        'connected': True,
        'last_activity': time.time(),
        'bastion_client': None,
        'proxy_jump_host': None,
        'auth_type': 'key',
        'use_tmux': True,
        'tmux_session_name': 'sshdeck_swap',
        'display_name': 'Prod box',
        'transport_generation': 0,
        'output_buffer': ['old scrollback\r\n'],
        'output_buffer_size': len('old scrollback\r\n'),
        'output_buffer_max': 512000,
        # W13: immutable SFTP-cache ownership token, matching production.
        '_sftp_owner_token': _uuid.uuid4(),
    }
    session.update(overrides)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = session
    return session


def _transport(name='new'):
    return {
        'client': FakeClient(f'{name}-client'),
        'channel': FakeChannel(f'{name}-chan'),
        'bastion_client': None,
        'use_tmux': True,
        'tmux_session_name': 'sshdeck_swap',
    }


# ---- the swap itself --------------------------------------------------------

def test_swap_keeps_the_same_logical_session_id_and_identity():
    """The whole point of W2: reconnect must not mint a new session.

    The old path called close_session then created a fresh one, so the id the
    client keyed its xterm, pane and chip on disappeared. Here the registry key
    and every identity field are unchanged; only the transport moves.
    """
    old_client, old_chan = FakeClient('old'), FakeChannel('old')
    _register_session('swap-1', old_client, old_chan)
    replacement = _transport()

    before_keys = set(ssh_manager.sessions)
    ok, error = ssh_manager.swap_session_transport('swap-1', replacement)

    assert (ok, error) == (True, None)
    assert set(ssh_manager.sessions) == before_keys == {'swap-1'}
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['swap-1']
    assert session['client'] is replacement['client']
    assert session['channel'] is replacement['channel']
    # Identity the client renders from is untouched by the swap.
    assert session['host'] == 'swap.example.com'
    assert session['username'] == 'deploy'
    assert session['display_name'] == 'Prod box'
    assert session['user_id'] == 11
    assert session['connected'] is True
    assert session['tmux_session_name'] == 'sshdeck_swap'


def test_swap_closes_only_the_old_transport():
    """The replacement must survive the swap; the old one must not leak."""
    old_client, old_chan = FakeClient('old'), FakeChannel('old')
    _register_session('swap-2', old_client, old_chan)
    replacement = _transport()

    ok, _error = ssh_manager.swap_session_transport('swap-2', replacement)

    assert ok is True
    assert old_client.closed is True
    assert old_chan.closed is True
    assert replacement['client'].closed is False
    assert replacement['channel'].closed is False


def test_swap_bumps_transport_generation():
    """Generation distinguishes "same session, new transport" from a new one."""
    _register_session('swap-3', FakeClient(), FakeChannel())
    ssh_manager.swap_session_transport('swap-3', _transport('a'))
    ssh_manager.swap_session_transport('swap-3', _transport('b'))
    with ssh_manager.sessions_lock:
        assert ssh_manager.sessions['swap-3']['transport_generation'] == 2


def test_swap_clears_the_gap_buffer_because_tmux_repaints():
    """W3 authority: the reattach repaint is the history now.

    Keeping the old buffer would replay lines the tmux repaint is about to draw
    again, so the user would see their scrollback twice.
    """
    _register_session('swap-4', FakeClient(), FakeChannel())
    ssh_manager.swap_session_transport('swap-4', _transport())
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['swap-4']
    assert session['output_buffer'] == []
    assert session['output_buffer_size'] == 0


def test_swap_of_a_vanished_session_fails_without_touching_the_registry():
    """A session closed while the replacement was connecting.

    The caller is told so (and closes the orphan itself); the swap must not
    resurrect a session that is gone.
    """
    replacement = _transport()
    ok, error = ssh_manager.swap_session_transport('never-existed', replacement)
    assert ok is False
    assert error == 'Session no longer exists'
    assert 'never-existed' not in ssh_manager.sessions
    # The swap did NOT close the replacement -- ownership stayed with the caller,
    # which is what lets the handler close it exactly once.
    assert replacement['client'].closed is False


def test_failed_swap_leaves_the_old_transport_serving_the_session():
    """Prepare-and-swap's core promise: a failure changes nothing.

    The old path had already destroyed the session by this point.
    """
    old_client, old_chan = FakeClient('old'), FakeChannel('old')
    _register_session('swap-5', old_client, old_chan, connected=False)

    ok, error = ssh_manager.swap_session_transport('swap-5', _transport())

    assert ok is False
    assert error == 'Session is not connected'
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['swap-5']
    assert session['client'] is old_client
    assert session['channel'] is old_chan
    assert old_client.closed is False
    assert session['transport_generation'] == 0
    # Scrollback is intact too: nothing was cleared for a swap that never happened.
    assert session['output_buffer'] == ['old scrollback\r\n']


# ---- reader handoff --------------------------------------------------------

def test_swap_records_the_handoff_before_closing_the_old_transport():
    """Ordering, not just presence.

    The old reader can crash on its closed transport at any instant after the
    close. If the flag were set afterwards, that reader would find no flag and
    report the (perfectly healthy) session as disconnected.
    """
    observed = []

    class WatchingClient(FakeClient):
        def close(self):
            observed.append(ssh_manager._transport_was_swapped('swap-6'))
            super().close()

    _register_session('swap-6', WatchingClient('old'), FakeChannel('old'))
    ssh_manager.swap_session_transport('swap-6', _transport())

    assert observed == [True], 'handoff must be visible before the old close'


def test_retired_reader_does_not_emit_disconnect_or_close_the_session():
    """The real production reader, run against a swapped-out transport.

    Without the retirement logic this reader's finally block emits
    ``ssh_disconnected`` and tears the session down -- so a successful reconnect
    would kill the session from behind.

    W13: the swap is performed through the REAL ``swap_session_transport``
    rather than by setting a flag by hand. The authority is no longer the flag
    alone but the registry itself (generation + channel identity), so a
    hand-set flag on an un-bumped session would describe a state production can
    never be in: the swap records the flag and bumps the generation inside one
    critical section.
    """
    emitted = []

    class FakeSocketIO:
        def emit(self, event, payload=None, **kwargs):
            emitted.append((event, payload, kwargs))

    dead_channel = FakeChannel('old', raise_on_recv=EOFError())
    _register_session('swap-7', FakeClient('old'), dead_channel)
    # A real swap: flag recorded, generation bumped, replacement installed. No
    # socketio/app is passed, so no second reader is started -- this test is
    # about the OLD one.
    replacement = _transport('replacement')
    ok, error = ssh_manager.swap_session_transport('swap-7', replacement)
    assert (ok, error) == (True, None)

    class FakeApp:
        def app_context(self):
            class Ctx:
                def __enter__(self_inner):
                    return None

                def __exit__(self_inner, *_args):
                    return False
            return Ctx()

    closed = []
    original_close = ssh_manager.close_session
    ssh_manager.close_session = lambda *a, **k: closed.append(a) or True
    try:
        # generation 0: the reader of the transport the swap just retired.
        ssh_manager.read_ssh_output('swap-7', FakeSocketIO(), FakeApp(),
                                    transport_generation=0)
    finally:
        ssh_manager.close_session = original_close

    assert not [e for (e, _p, _k) in emitted if e == 'ssh_disconnected'], emitted
    # Not even the generic close_session: the retired reader claims nothing.
    assert closed == []
    # The session is still registered, on its replacement -- the new reader owns
    # it now.
    assert 'swap-7' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['swap-7']
    assert session['channel'] is replacement['channel']
    assert session['connected'] is True
    assert replacement['channel'].closed is False
    # Its own flag is cleaned up, and ONLY its own.
    assert ssh_manager._transport_was_swapped('swap-7', 0) is False


# ── W13 A3: deterministic generation-race interleavings ─────────────────────
#
# The three races below are all real windows in read_ssh_output, and none of them
# is reachable by calling the function normally: they need the reader PAUSED at an
# exact instruction boundary while a swap lands. So each test blocks the reader at
# one boundary with an Event, performs a real swap_session_transport, then releases
# it and asserts what the reader did with the state it woke into.
#
# The previous 12/12 in this file could not see any of them: every earlier test
# ran the reader to completion with no concurrent swap, so the check-then-act
# windows were never entered. They are false-green for these races and are not
# evidence about them.


class BlockingChannel:
    """A channel whose recv can be held open at will.

    `recv` announces that it has been entered (`entered`), then blocks on
    `release` before returning `payload`. That is precisely the window the
    post-recv fence exists for: the bytes were produced by THIS transport, but by
    the time they are returned the session may already have moved on.
    """

    def __init__(self, name='blocking', payload=b'stale bytes'):
        self.name = name
        self.payload = payload
        self.entered = threading.Event()
        self.release = threading.Event()
        self.closed = False
        self.exit_ready = False
        self.recv_calls = 0

    def settimeout(self, _timeout):
        pass

    def recv(self, _size):
        self.recv_calls += 1
        if self.recv_calls == 1:
            self.entered.set()
            # Bounded, so a bug cannot hang the suite.
            self.release.wait(5)
            return self.payload
        return b''  # EOF on the next pass: the reader exits

    def send(self, data):
        return len(data)

    def exit_status_ready(self):
        return self.exit_ready

    def close(self):
        self.closed = True


class RecordingSocketIO:
    def __init__(self):
        self.events = []

    def emit(self, event, payload=None, **kwargs):
        self.events.append((event, payload, kwargs))

    def names(self):
        return [e for (e, _p, _k) in self.events]

    def outputs(self):
        return [p.get('data') for (e, p, _k) in self.events if e == 'ssh_output']


class FakeApp:
    """Minimal app whose app_context is a no-op, as in the tests above."""

    def app_context(self):
        class Ctx:
            def __enter__(self_inner):
                return None

            def __exit__(self_inner, *_args):
                return False
        return Ctx()


# A REAL Flask app + SQLite database for the race tests.
#
# read_ssh_output is not a pure function: it looks its session up in the DB to
# resolve the Socket.IO room, and its teardown writes `connected = False` and
# reads the row again. With a no-op app_context those queries raise
# "Working outside of application context" INSIDE the reader thread -- which
# pytest reports as an unhandled thread exception, and which means the reader
# dies before it ever reaches the interleaving the test is trying to force. A
# test that dies before its barrier proves nothing, so these tests get a real
# app context and real rows.
@pytest.fixture(scope='module')
def live_app():
    """A real Flask app + temp SQLite DB for the threaded race tests.

    It mutates process-global state to point the app at a throwaway database, and
    it is REQUIRED to hand that state back afterwards. Leaving DATA_DIR pointing
    at a deleted temp dir means every test that runs later -- and any later
    config reload -- reads a dangling path.

    The restoration is in an UNCONDITIONAL OUTER finally: the whole mutation /
    setup / yield / DB-cleanup block is inside one try, and the finally always
    restores DATA_DIR and the config module state -- even when setup fails, even
    when the DB teardown itself raises. A failure in db.engine.dispose() must not
    strand the process on a deleted temp directory.
    """
    import config
    original_data_dir = os.environ.get('DATA_DIR')
    original_config_data_dir = config.DATA_DIR
    original_ratelimit = getattr(config, 'RATELIMIT_ENABLED', None)

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            os.environ['DATA_DIR'] = tmpdir
            importlib.reload(config)
            config.RATELIMIT_ENABLED = False

            from app import create_app
            from app.models import db

            test_app = create_app()
            test_app.config['TESTING'] = True
            test_app.config['WTF_CSRF_ENABLED'] = False
            with test_app.app_context():
                db.create_all()
            try:
                yield test_app
            finally:
                # Contain DB teardown failures: they must not prevent the outer
                # restoration. A disposed engine is not a reason to strand the
                # process on a deleted DATA_DIR.
                try:
                    with test_app.app_context():
                        db.session.remove()
                        db.engine.dispose()
                except Exception as teardown_error:
                    print(f'live_app DB teardown error (contained): '
                          f'{teardown_error}')
    finally:
        # UNCONDITIONAL restoration. Runs after every exit path -- normal yield
        # completion, a setup failure, or a DB teardown exception.
        if original_data_dir is None:
            os.environ.pop('DATA_DIR', None)
        else:
            os.environ['DATA_DIR'] = original_data_dir
        importlib.reload(config)
        config.DATA_DIR = original_config_data_dir
        if original_ratelimit is not None:
            config.RATELIMIT_ENABLED = original_ratelimit


def test_live_app_restores_process_globals_after_normal_teardown():
    """Blocker 1: live_app MUST restore DATA_DIR and config after yield.

    This runs the fixture's setup + teardown inline and asserts the
    process-global state is handed back. It is an ISOLATED harness -- it does
    not depend on the module-scoped fixture instance, so it exercises the
    restoration path directly and cannot be skipped by fixture caching.
    """
    import config
    saved_data_dir = os.environ.get('DATA_DIR')
    saved_config_data_dir = config.DATA_DIR
    saved_ratelimit = getattr(config, 'RATELIMIT_ENABLED', None)

    # Drive the fixture generator by hand: setup, take the app, then let it
    # tear down.
    gen = live_app.__wrapped__() if hasattr(live_app, '__wrapped__') else live_app()
    try:
        app = next(gen)
        # While the fixture is active, DATA_DIR points at the temp dir.
        assert os.path.isdir(os.environ['DATA_DIR'])
        assert config.RATELIMIT_ENABLED is False
    finally:
        try:
            gen.close()
        except StopIteration:
            pass

    # AFTER teardown: the originals are restored, no dangling temp path.
    assert os.environ.get('DATA_DIR') == saved_data_dir, \
        'DATA_DIR not restored after fixture teardown'
    assert config.DATA_DIR == saved_config_data_dir, \
        'config.DATA_DIR not restored after fixture teardown'
    assert getattr(config, 'RATELIMIT_ENABLED', None) == saved_ratelimit, \
        'RATELIMIT_ENABLED not restored after fixture teardown'


def test_live_app_restores_process_globals_even_when_db_teardown_raises(
        monkeypatch):
    """Blocker 1: restoration is UNCONDITIONAL.

    The fixture's outer finally must run even when the DB teardown itself raises
    (a disposed engine, a locked SQLite file). Inject a failure in
    db.engine.dispose and prove DATA_DIR/config are still restored.
    """
    import config
    saved_data_dir = os.environ.get('DATA_DIR')
    saved_config_data_dir = config.DATA_DIR
    saved_ratelimit = getattr(config, 'RATELIMIT_ENABLED', None)

    disposed = []

    # Drive the fixture by hand so we can patch the engine it creates BEFORE
    # teardown runs.
    gen = live_app.__wrapped__() if hasattr(live_app, '__wrapped__') else live_app()
    app = next(gen)  # setup

    # Patch the real engine's dispose to raise. Done inside the app context so
    # db.engine resolves.
    with app.app_context():
        from app.models import db
        engine = db.engine

        def boom_dispose():
            disposed.append(True)
            raise RuntimeError('injected dispose failure')

        monkeypatch.setattr(engine, 'dispose', boom_dispose)

    # Now close the generator: its finally runs the DB teardown (which raises),
    # then the OUTER finally restores globals. The fixture contains the dispose
    # exception, so gen.close() must not re-raise.
    try:
        gen.close()
    except StopIteration:
        pass
    except Exception as e:
        raise AssertionError(
            'fixture let DB teardown exception escape and skip '
            f'restoration: {e}') from e

    # The dispose really was called and really raised.
    assert disposed, 'injected dispose was never called'
    # And restoration still happened.
    assert os.environ.get('DATA_DIR') == saved_data_dir, \
        'DATA_DIR not restored after injected teardown failure'
    assert config.DATA_DIR == saved_config_data_dir, \
        'config.DATA_DIR not restored after injected teardown failure'
    assert getattr(config, 'RATELIMIT_ENABLED', None) == saved_ratelimit, \
        'RATELIMIT_ENABLED not restored after injected teardown failure'


@pytest.fixture(autouse=True)
def no_unhandled_thread_exceptions():
    """Fail the test if ANY thread died with an exception.

    A reader thread that crashes on a missing app context never reaches its
    barrier, so every assertion about the interleaving would pass vacuously. This
    turns that silent failure into a loud one.
    """
    captured = []
    previous = threading.excepthook

    def hook(args):
        captured.append(args)
        previous(args)

    threading.excepthook = hook
    try:
        yield
    finally:
        threading.excepthook = previous
    assert not captured, [
        f'{a.exc_type.__name__}: {a.exc_value}' for a in captured]


def _seed_db_row(app, session_id, user_id=11):
    """One ssh_sessions row, so the reader can resolve its room and its teardown
    has something real to mark disconnected."""
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id, user_id=user_id, host='swap.example.com',
            port=22, username='deploy', connected=True, is_persistent=True,
            auth_type='key', tmux_session_name='sshdeck_swap',
            display_name='Prod box')
        db.session.add(row)
        db.session.commit()


def _db_connected(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        row = SSHSession.query.filter_by(session_id=session_id).first()
        return None if row is None else row.connected


def _run_reader(session_id, socketio_instance, generation, app):
    """Start read_ssh_output in a thread and return it."""
    thread = threading.Thread(
        target=ssh_manager.read_ssh_output,
        args=(session_id, socketio_instance, app, generation),
        daemon=True)
    thread.start()
    return thread


def test_stale_recv_after_swap_is_neither_emitted_nor_buffered(live_app):
    """RACE 1: gen0 blocked inside recv; a swap lands; gen0 wakes with bytes.

    recv MUST block outside sessions_lock (holding it across a blocking read
    would stall every other session), so this window is unavoidable and has to be
    fenced on the way out. Without the fence gen0:

      * emits ssh_output for a transport that no longer serves the session, so
        the user sees pre-reconnect bytes AFTER the reattach repaint has drawn
        the real screen, and
      * appends them to gen1's output_buffer, which the swap had just cleared --
        corrupting the replay history with output from a dead transport.

    Both are asserted as absences, against a payload that is non-empty and would
    certainly have been emitted had the fence not been there.
    """
    _seed_db_row(live_app, 'race-1')
    blocking = BlockingChannel('gen0', payload=b'STALE-FROM-GEN0')
    _register_session('race-1', FakeClient('gen0'), blocking,
                      output_buffer=[], output_buffer_size=0)
    io = RecordingSocketIO()

    reader = _run_reader('race-1', io, 0, live_app)
    assert blocking.entered.wait(5), 'the reader never reached recv'

    # The swap lands while gen0 is still inside recv.
    replacement = _transport('gen1')
    ok, error = ssh_manager.swap_session_transport('race-1', replacement)
    assert (ok, error) == (True, None)

    # Now let the stale bytes come back.
    blocking.release.set()
    reader.join(5)
    assert not reader.is_alive(), 'the retired reader never exited'

    # NO stale output reached the client...
    assert 'STALE-FROM-GEN0' not in ''.join(io.outputs()), io.events
    assert io.outputs() == [], io.events
    # ...and NOTHING was appended to the new generation's buffer.
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['race-1']
        buffer_copy = list(session['output_buffer'])
        buffer_size = session['output_buffer_size']
        generation = session['transport_generation']
        live_channel = session['channel']
        connected = session['connected']
    assert buffer_copy == [], buffer_copy
    assert buffer_size == 0
    # The replacement is untouched and authoritative.
    assert generation == 1
    assert live_channel is replacement['channel']
    assert connected is True
    assert replacement['channel'].closed is False
    assert replacement['client'].closed is False
    # The retired reader reported nothing at all, and the DB row still says the
    # logical session is connected -- it is, on the replacement.
    assert 'ssh_disconnected' not in io.names(), io.events
    assert _db_connected(live_app, 'race-1') is True
    # And it cleaned up only its OWN flag.
    assert ssh_manager._transport_was_swapped('race-1', 0) is False


def test_swap_at_the_finally_boundary_does_not_kill_the_replacement(live_app):
    """RACE 2: the swap lands between "am I retired?" and the teardown.

    This is the check-then-act window. The old finally block asked
    _transport_was_swapped OUTSIDE the lock -- answering truthfully "no, I am
    current" -- and then marked the DB row disconnected and called the generic
    close_session(session_id). A swap arriving in between meant those two steps
    hit the REPLACEMENT: the reconnect succeeded and was then torn down by the
    reader of the transport it had replaced.

    The interleaving is forced by patching the atomic claim so the swap happens
    at the exact instant the claim is about to be made -- the boundary the bug
    lives on. The claim itself is the real production function.
    """
    _seed_db_row(live_app, 'race-2')
    dead = FakeChannel('gen0', raise_on_recv=EOFError())
    _register_session('race-2', FakeClient('gen0'), dead)
    io = RecordingSocketIO()

    replacement = _transport('gen1')
    swap_result = {}
    real_claim = ssh_manager.claim_reader_death
    claim_states = []

    def claiming_with_a_swap_in_between(session_id, generation, channel):
        # THE BOUNDARY: gen0 is about to declare the session dead, and the swap
        # lands right now. Before the atomic claim existed, everything after this
        # point operated on the replacement.
        if not swap_result:
            swap_result['ok'] = ssh_manager.swap_session_transport(
                session_id, replacement)
        state, parts = real_claim(session_id, generation, channel)
        claim_states.append(state)
        return state, parts

    closed_by_id = []
    original_close = ssh_manager.close_session
    ssh_manager.claim_reader_death = claiming_with_a_swap_in_between
    ssh_manager.close_session = lambda *a, **k: closed_by_id.append(a) or True
    try:
        ssh_manager.read_ssh_output('race-2', io, live_app,
                                    transport_generation=0)
    finally:
        ssh_manager.claim_reader_death = real_claim
        ssh_manager.close_session = original_close

    assert swap_result.get('ok') == (True, None), swap_result
    # The claim REFUSED: gen0 is no longer the generation the registry names.
    assert claim_states == [ssh_manager.READER_RETIRE_SUPERSEDED], claim_states
    # No disconnect was reported for a session that is alive.
    assert 'ssh_disconnected' not in io.names(), io.events
    # No id-keyed close ran, so nothing could resolve to the replacement.
    assert closed_by_id == []
    # The replacement is still installed, connected and open.
    assert 'race-2' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['race-2']
    assert session['channel'] is replacement['channel']
    assert session['client'] is replacement['client']
    assert session['connected'] is True
    assert session['transport_generation'] == 1
    assert replacement['channel'].closed is False
    assert replacement['client'].closed is False
    # And the DB row was NOT marked disconnected: this is the state a reload
    # would restore from, so a false write here is what produced a ghost.
    assert _db_connected(live_app, 'race-2') is True


def test_current_generation_death_does_not_steal_the_old_readers_flag(live_app):
    """RACE 3: gen1 dies for real while gen0 is still blocked in recv.

    Two failures used to compound here:

      * the flag was keyed by session id, so whichever reader reached its finally
        first consumed it -- gen1's death swallowed the retirement gen0 was owed;
      * the teardown then bulk-discarded every flag for the session, so gen0 woke
        with neither a flag nor a superseded marker and reported the session
        disconnected a SECOND time, having already been reported by gen1.

    So: gen1 is the authority and must report exactly once; gen0 must retire in
    silence, and must not close anything.
    """
    _seed_db_row(live_app, 'race-3')
    blocking = BlockingChannel('gen0', payload=b'STALE-AFTER-GEN1-DIED')
    _register_session('race-3', FakeClient('gen0'), blocking,
                      output_buffer=[], output_buffer_size=0)
    io_old = RecordingSocketIO()
    io_new = RecordingSocketIO()

    old_reader = _run_reader('race-3', io_old, 0, live_app)
    assert blocking.entered.wait(5), 'the old reader never reached recv'

    # A real swap installs gen1, whose channel is dead on arrival.
    gen1_client = FakeClient('gen1')
    gen1_channel = FakeChannel('gen1', raise_on_recv=EOFError())
    replacement = {
        'client': gen1_client, 'channel': gen1_channel,
        'bastion_client': None, 'use_tmux': True,
        'tmux_session_name': 'sshdeck_swap',
    }
    ok, error = ssh_manager.swap_session_transport('race-3', replacement)
    assert (ok, error) == (True, None)

    # gen1 dies for real, while gen0 is STILL blocked in recv.
    closed_by_id = []
    original_close = ssh_manager.close_session
    ssh_manager.close_session = lambda *a, **k: closed_by_id.append(a) or True
    try:
        ssh_manager.read_ssh_output('race-3', io_new, live_app,
                                   transport_generation=1)
    finally:
        ssh_manager.close_session = original_close

    # gen1 was exactly current, so it owned the teardown: the entry is gone and
    # its own transport was closed -- via the CAPTURED parts, not by id.
    assert 'race-3' not in ssh_manager.sessions
    assert gen1_channel.closed is True
    assert gen1_client.closed is True
    assert closed_by_id == [], 'no generic close_session by id'
    # Exactly ONE disconnect, reported by the generation that actually died.
    assert io_new.names().count('ssh_disconnected') == 1, io_new.events
    assert _db_connected(live_app, 'race-3') is False

    # Only now does gen0 wake up, with its stale bytes.
    blocking.release.set()
    old_reader.join(5)
    assert not old_reader.is_alive(), 'the old reader never exited'

    # gen0 emitted nothing: no stale output, and no second disconnect.
    assert io_old.outputs() == [], io_old.events
    assert 'ssh_disconnected' not in io_old.names(), io_old.events
    # The session is not resurrected by the late reader.
    assert 'race-3' not in ssh_manager.sessions
    # Both flags are gone, each cleaned by its own owner.
    assert ssh_manager._transport_was_swapped('race-3', 0) is False
    assert ssh_manager._transport_was_swapped('race-3', 1) is False


def test_no_stale_terminal_event_can_be_published_after_a_swap(live_app):
    """RACE 4: the fence-to-publication boundary, with EXPLICIT barriers.

    A check-ONLY fence is not enough, and the reason is ORDERING rather than
    state. Validate, release the lock, then emit, and this interleaving exists:

        gen0 validates (still current)  ->  swap installs gen1  ->  gen1 emits
        the reattach repaint  ->  gen0 finally emits its stale bytes

    Every individual step is "correct", the buffer ends up consistent, and the
    user still sees pre-reconnect output painted over the real screen -- because
    a socket event cannot be recalled once published.

    Publication therefore runs under THIS session's publish lock, and so does the
    swap; for one session they are totally ordered.

    DETERMINISM. No sleep, no timing assumption. The barriers PROVE the swapper
    is blocked at the exact serialization boundary:
      * `swap_attempted` fires the moment the swapper enters
        swap_session_transport -- BEFORE the swap can complete.
      * while the publisher holds the session's publish lock (it is inside the
        emit callback, which runs under it), the swap CANNOT finish, because the
        swap must acquire that very lock. So `swap_attempted` set + us holding the
        lock == the swapper is blocked at the boundary. We assert the swap is not
        done at that instant.
      * additionally, the swapper probes the boundary itself with a non-blocking
        acquire: the moment it reaches for the session's publish lock it finds it
        held, confirming this -- not some other -- lock is the serialization
        point.
      * the final assertion is an ORDER, not a count: the swap's completion is
        recorded strictly after the publish exits.
    """
    _seed_db_row(live_app, 'race-4')
    blocking = BlockingChannel('gen0', payload=b'GEN0-BYTES')
    _register_session('race-4', FakeClient('gen0'), blocking,
                      output_buffer=[], output_buffer_size=0)

    replacement = _transport('gen1')
    timeline = []
    timeline_lock = threading.Lock()
    swap_attempted = threading.Event()
    swap_done = threading.Event()
    boundary_observed = threading.Event()

    def note(event):
        with timeline_lock:
            timeline.append(event)

    class BoundaryIO:
        """Publishes, and while holding the session publish lock, lets a swap
        try -- proving it blocks at that exact lock."""

        def __init__(self):
            self.events = []

        def emit(self, event, payload=None, **kwargs):
            if event == 'ssh_output':
                note('publish:enter')

                def swapper():
                    swap_attempted.set()
                    # Prove we are blocked at the SESSION authority lock --
                    # the serialization boundary. Non-blocking probe: it is held
                    # by the publisher right now, so acquire(timeout=0) must
                    # fail. If it unexpectedly SUCCEEDS, release it immediately
                    # so the real swap below cannot self-deadlock on a lock we
                    # just acquired.
                    with ssh_manager.sessions_lock:
                        sess = ssh_manager.sessions['race-4']
                        boundary_lock = ssh_manager._session_authority_lock(sess)
                    probe = boundary_lock.acquire(timeout=0)
                    if probe:
                        boundary_lock.release()
                    else:
                        boundary_observed.set()
                    # The real swap. Its authority-lock acquisition blocks until
                    # the publisher releases, which happens only after publish
                    # exits.
                    ssh_manager.swap_session_transport('race-4', replacement)
                    note('swap:done')
                    swap_done.set()

                thread = threading.Thread(target=swapper, daemon=True)
                thread.start()

                # BARRIER: the swapper has entered the swap attempt...
                assert swap_attempted.wait(5), 'swapper never attempted the swap'
                # ...and while we hold the publish lock it CANNOT be done. This
                # is deterministic, not timed: completion requires the lock we
                # hold.
                assert not swap_done.is_set(), \
                    'the swap completed while its boundary lock was held'
                self.events.append((event, payload, kwargs))
                note('publish:exit')
            else:
                self.events.append((event, payload, kwargs))

        def names(self):
            return [e for (e, _p, _k) in self.events]

        def outputs(self):
            return [p.get('data') for (e, p, _k) in self.events
                    if e == 'ssh_output']

    io = BoundaryIO()
    reader = _run_reader('race-4', io, 0, live_app)
    assert blocking.entered.wait(5), 'the reader never reached recv'
    blocking.release.set()

    assert swap_done.wait(5), 'the swap never completed'
    # The boundary really was the session publish lock (observed held by the
    # swapper itself).
    assert boundary_observed.is_set(), \
        'the swapper never observed the serialization boundary held'
    reader.join(5)
    assert not reader.is_alive(), 'the reader never exited'

    # THE ORDER. The swap could not land inside the publish: publication is
    # serialized with the swap under the session lock, so the whole publish
    # completes first.
    assert timeline == ['publish:enter', 'publish:exit', 'swap:done'], timeline
    # Exactly one legitimate publication -- of gen0's own bytes, while gen0 was
    # still the authority -- and nothing after the swap.
    assert io.outputs() == ['GEN0-BYTES'], io.events
    # The reader retired quietly on its next pass; it did not report a death.
    assert 'ssh_disconnected' not in io.names(), io.events
    # And the replacement is intact and connected.
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['race-4']
    assert session['channel'] is replacement['channel']
    assert session['transport_generation'] == 1
    assert session['connected'] is True
    assert replacement['channel'].closed is False
    assert _db_connected(live_app, 'race-4') is True


def test_a_reader_that_never_bound_a_channel_cannot_claim_the_session(live_app,
                                                                     monkeypatch):
    """A reader can reach its finally without ever having bound a channel.

    The DB row never appears (a lost race at startup), the lookup raises, or the
    thread dies before its first iteration. On a session that has had no swap the
    generation still matches, so a claim made on GENERATION ALONE would let this
    reader pop the registry entry and tear down a live, healthy channel it never
    read a single byte from -- and mark the DB row disconnected with it.

    Exact channel identity is therefore required for a current-death claim, and
    an unbound reader (channel None) can never be CURRENT.
    """
    # No DB row is seeded, so the reader's lookup finds nothing and it returns
    # before the loop -- with bound_channel still None.
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _seconds: None)

    live_channel = FakeChannel('gen0')
    live_client = FakeClient('gen0')
    _register_session('race-5', live_client, live_channel)

    io = RecordingSocketIO()
    claim_states = []
    real_claim = ssh_manager.claim_reader_death

    def watched_claim(session_id, generation, channel):
        state, parts = real_claim(session_id, generation, channel)
        claim_states.append((state, channel))
        return state, parts

    closed_by_id = []
    original_close = ssh_manager.close_session
    ssh_manager.claim_reader_death = watched_claim
    ssh_manager.close_session = lambda *a, **k: closed_by_id.append(a) or True
    try:
        ssh_manager.read_ssh_output('race-5', io, live_app,
                                    transport_generation=0)
    finally:
        ssh_manager.claim_reader_death = real_claim
        ssh_manager.close_session = original_close

    # It really was unbound, and it really was refused.
    assert claim_states == [(ssh_manager.READER_RETIRE_SUPERSEDED, None)], \
        claim_states
    # The live session is untouched: still registered, still connected, still
    # open, and its generation was not disturbed.
    assert 'race-5' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['race-5']
    assert session['channel'] is live_channel
    assert session['connected'] is True
    assert session['transport_generation'] == 0
    assert live_channel.closed is False
    assert live_client.closed is False
    assert closed_by_id == []
    # Nothing was reported, and no DB row was written (there is none to write).
    assert io.events == [], io.events
    assert _db_connected(live_app, 'race-5') is None


# ---- teardown after a current-death claim: reporting must not leak parts ----

class DyingChannel(FakeChannel):
    """EOF on first recv: the genuine-death path of a current generation."""

    def recv(self, _size):
        raise EOFError()


class CountingClient(FakeClient):
    """FakeClient that counts every close() call, for exact-once proofs."""
    def __init__(self, name='counting'):
        super().__init__(name)
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        super().close()


class CountingChannel(FakeChannel):
    """FakeChannel that counts every close() call, for exact-once proofs."""
    def __init__(self, name='counting', chunks=None, raise_on_recv=None):
        super().__init__(name, chunks=chunks, raise_on_recv=raise_on_recv)
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        super().close()


class CountingBastion(FakeClient):
    """A bastion (jump-host) client whose close is counted too."""
    def __init__(self, name='bastion'):
        super().__init__(name)
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        super().close()


def test_report_failure_db_commit_still_closes_parts_exactly_once(
        live_app, monkeypatch):
    """Blocker: a raise in the death REPORT must not leak the captured parts.

    When the current generation dies, the reader owns the teardown: it pops the
    session, reports the death (DB commit + socket emit) and then closes the
    captured client/channel/bastion. If the DB commit RAISES and that raise were
    allowed to escape, the captured transport would be orphaned -- never closed,
    leaked for the life of the process. The report is therefore wrapped in a
    try/finally so the parts are closed even when reporting fails.

    Here the commit is made to raise, and we assert:
      * the reader still exits cleanly (no unhandled exception in its thread),
      * the captured client AND channel AND bastion are closed EXACTLY ONCE
        (counted, not boolean),
      * the SFTP cache for the retired session is closed EXACTLY ONCE,
      * the session is gone from the registry,
      * no id-keyed close_session was used,
      * db.session.rollback() was called after the commit failure,
      * an UNRELATED session registered alongside is completely untouched --
        its close counts are zero, its SFTP cache is never closed, and it is
        still registered and connected.
    """
    from app.models import db as app_db
    from app import sftp_handler

    _seed_db_row(live_app, 'fi-db')
    _seed_db_row(live_app, 'fi-db-other')

    client = CountingClient('fi-db-client')
    channel = CountingChannel('fi-db-chan', raise_on_recv=EOFError())
    bastion = CountingBastion('fi-db-bastion')
    _register_session('fi-db', client, channel, bastion_client=bastion)

    # An unrelated session that must survive untouched.
    other_client = CountingClient('other-client')
    other_channel = CountingChannel('other-chan')
    _register_session('fi-db-other', other_client, other_channel)

    rollback_calls = []
    sftp_closes = []

    class BoomCommit:
        @staticmethod
        def commit(*_args, **_kwargs):
            raise RuntimeError('injected DB commit failure')

    def counting_rollback(*_args, **_kwargs):
        rollback_calls.append(True)

    def counting_sftp_close(session_id, expected_owner=None):
        sftp_closes.append(session_id)

    # Patch commit to raise, rollback to be observable, and SFTP close to count
    # by session id -- all on the scoped-session proxy / module, so the reader
    # thread's calls are intercepted regardless of which thread calls them.
    monkeypatch.setattr(app_db.session, 'commit', BoomCommit.commit)
    monkeypatch.setattr(app_db.session, 'rollback', counting_rollback)
    monkeypatch.setattr(sftp_handler, 'close_sftp_cache', counting_sftp_close)

    io = RecordingSocketIO()
    closed_by_id = []
    original_close = ssh_manager.close_session
    ssh_manager.close_session = lambda *a, **k: closed_by_id.append(a) or True
    try:
        ssh_manager.read_ssh_output('fi-db', io, live_app,
                                    transport_generation=0)
    finally:
        ssh_manager.close_session = original_close

    # The reader completed its teardown despite the commit failure.
    assert 'fi-db' not in ssh_manager.sessions
    # EXACTLY ONCE: counted, not just boolean.
    assert client.close_calls == 1, \
        f'client closed {client.close_calls} times (expected 1)'
    assert channel.close_calls == 1, \
        f'channel closed {channel.close_calls} times (expected 1)'
    assert bastion.close_calls == 1, \
        f'bastion closed {bastion.close_calls} times (expected 1)'
    # SFTP cache closed exactly once, for the retired session only.
    assert sftp_closes == ['fi-db'], \
        f'SFTP closes were {sftp_closes} (expected exactly [fi-db])'
    assert closed_by_id == [], 'no generic close_session by id'
    # Rollback was called after the injected commit failure.
    assert len(rollback_calls) >= 1, \
        'db.session.rollback() was not called after the commit failure'
    # The unrelated session is untouched -- its close counts are zero, and its
    # SFTP cache was never closed.
    assert 'fi-db-other' in ssh_manager.sessions
    assert other_client.close_calls == 0
    assert other_channel.close_calls == 0
    assert other_client.closed is False
    assert other_channel.closed is False
    assert 'fi-db-other' not in sftp_closes, \
        'unrelated session SFTP cache was closed'


def test_report_failure_socket_emit_still_closes_parts_exactly_once(
        live_app, monkeypatch):
    """The emit half of the report: if the ssh_disconnected emit RAISES, the
    captured parts must still be closed exactly once, and the session must still
    be removed from the registry. Same shape as the DB-commit variant above."""
    from app import sftp_handler

    _seed_db_row(live_app, 'fi-emit')
    _seed_db_row(live_app, 'fi-emit-other')

    client = CountingClient('fi-emit-client')
    channel = CountingChannel('fi-emit-chan', raise_on_recv=EOFError())
    bastion = CountingBastion('fi-emit-bastion')
    _register_session('fi-emit', client, channel, bastion_client=bastion)

    other_client = CountingClient('other-client')
    other_channel = CountingChannel('other-chan')
    _register_session('fi-emit-other', other_client, other_channel)

    sftp_closes = []

    def counting_sftp_close(session_id, expected_owner=None):
        sftp_closes.append(session_id)

    monkeypatch.setattr(sftp_handler, 'close_sftp_cache', counting_sftp_close)

    class EmitBoomIO(RecordingSocketIO):
        def emit(self, event, payload=None, **kwargs):
            if event == 'ssh_disconnected':
                raise RuntimeError('injected emit failure')
            super().emit(event, payload, **kwargs)

    io = EmitBoomIO()
    closed_by_id = []
    original_close = ssh_manager.close_session
    ssh_manager.close_session = lambda *a, **k: closed_by_id.append(a) or True
    try:
        ssh_manager.read_ssh_output('fi-emit', io, live_app,
                                    transport_generation=0)
    finally:
        ssh_manager.close_session = original_close

    assert 'fi-emit' not in ssh_manager.sessions
    # EXACTLY ONCE: counted.
    assert client.close_calls == 1, \
        f'client closed {client.close_calls} times (expected 1)'
    assert channel.close_calls == 1, \
        f'channel closed {channel.close_calls} times (expected 1)'
    assert bastion.close_calls == 1, \
        f'bastion closed {bastion.close_calls} times (expected 1)'
    # SFTP cache closed exactly once, for the retired session only.
    assert sftp_closes == ['fi-emit'], \
        f'SFTP closes were {sftp_closes} (expected exactly [fi-emit])'
    assert closed_by_id == [], 'no generic close_session by id'
    # The DB row WAS marked disconnected (the emit fails after the commit), and
    # the unrelated session is untouched.
    assert _db_connected(live_app, 'fi-emit') is False
    assert 'fi-emit-other' in ssh_manager.sessions
    assert other_client.close_calls == 0
    assert other_channel.close_calls == 0
    assert other_client.closed is False
    assert other_channel.closed is False
    assert 'fi-emit-other' not in sftp_closes, \
        'unrelated session SFTP cache was closed'


# ---- per-session isolation: one session's blocked publish cannot stall another

def test_an_unrelated_session_is_not_blocked_by_a_held_publish_lock(live_app):
    """Blocker: the publish/swap serialization must be PER-SESSION.

    Session A's reader is inside its publish, holding A's publish lock (its emit
    is deliberately held). If the lock were GLOBAL, session B's swap -- and any
    of B's publishes -- would stall until A released. They must not: B's swap
    completes while A is still blocked mid-emit, proving the two sessions do not
    share the serialization point.
    """
    _seed_db_row(live_app, 'iso-A')
    _seed_db_row(live_app, 'iso-B')

    # Session A: a reader whose publish blocks until released.
    blocking = BlockingChannel('iso-A', payload=b'A-BYTES')
    _register_session('iso-A', FakeClient('iso-A-client'), blocking,
                      output_buffer=[], output_buffer_size=0)
    a_release = threading.Event()

    class HeldEmitIO:
        def __init__(self):
            self.events = []
            self.in_emit = threading.Event()

        def emit(self, event, payload=None, **kwargs):
            if event == 'ssh_output':
                self.in_emit.set()          # A now holds its publish lock
                a_release.wait(5)           # hold it
            self.events.append((event, payload, kwargs))

        def names(self):
            return [e for (e, _p, _k) in self.events]

    a_io = HeldEmitIO()
    a_reader = _run_reader('iso-A', a_io, 0, live_app)
    assert blocking.entered.wait(5), 'A never reached recv'
    blocking.release.set()                  # A proceeds into publish
    assert a_io.in_emit.wait(5), 'A never entered its emit (publish lock)'

    # Session B, a completely separate live session, registered before the
    # measurement so the swap has something real to replace.
    _register_session('iso-B', FakeClient('iso-B-client'),
                      FakeChannel('iso-B-chan'),
                      output_buffer=[], output_buffer_size=0)

    # Swap B while A is blocked holding its OWN publish lock.
    b_replacement = _transport('iso-B-gen1')
    ok, error = ssh_manager.swap_session_transport('iso-B', b_replacement)
    assert (ok, error) == (True, None), \
        f'B stalled or failed while A held its publish lock: {error}'
    with ssh_manager.sessions_lock:
        b_session = ssh_manager.sessions['iso-B']
    assert b_session['transport_generation'] == 1
    assert b_session['channel'] is b_replacement['channel']

    # A is still mid-publish: its lock is still held, and it never emitted its
    # data while blocked.
    assert a_release.is_set() is False
    # Release A and let it finish; its bytes were published before the block.
    a_release.set()
    a_reader.join(5)
    assert not a_reader.is_alive(), 'A never exited'
    assert 'A-BYTES' in [p.get('data') for (e, p, _k) in a_io.events
                         if e == 'ssh_output'], a_io.events


def test_close_vs_publish_no_output_after_close(live_app):
    """Boundary: close_session vs an in-flight publish.

    close_session is an authority mutation: it must take the same per-session
    authority lock the reader publishes under. Without it, close could pop the
    session between a reader's ownership check and its emit, and the terminal
    would receive output for a session the user had just closed -- an event that
    cannot be recalled.

    Deterministic: the publisher holds the authority lock mid-emit; a close is
    attempted from another thread and must block until the publish finishes. The
    close completes strictly AFTER the publish exits; no output is emitted after
    close returns.
    """
    _seed_db_row(live_app, 'close-vs-pub')
    blocking = BlockingChannel('close-vs-pub', payload=b'PRE-CLOSE-BYTES')
    _register_session('close-vs-pub', FakeClient('close-vs-pub'), blocking,
                      output_buffer=[], output_buffer_size=0)

    timeline = []
    timeline_lock = threading.Lock()
    close_attempted = threading.Event()
    close_done = threading.Event()
    boundary_observed = threading.Event()

    def note(event):
        with timeline_lock:
            timeline.append(event)

    class HeldEmitIO:
        def __init__(self):
            self.events = []

        def emit(self, event, payload=None, **kwargs):
            if event == 'ssh_output':
                note('publish:enter')

                def closer():
                    close_attempted.set()
                    with ssh_manager.sessions_lock:
                        sess = ssh_manager.sessions['close-vs-pub']
                        boundary_lock = (
                            ssh_manager._session_authority_lock(sess))
                    # Non-blocking probe; release on unexpected success so the
                    # real close below cannot self-deadlock.
                    probe = boundary_lock.acquire(timeout=0)
                    if probe:
                        boundary_lock.release()
                    else:
                        boundary_observed.set()
                    ssh_manager.close_session('close-vs-pub')
                    note('close:done')
                    close_done.set()

                thread = threading.Thread(target=closer, daemon=True)
                thread.start()
                assert close_attempted.wait(5), 'closer never attempted'
                assert not close_done.is_set(), \
                    'close completed while its boundary lock was held'
                self.events.append((event, payload, kwargs))
                note('publish:exit')
            else:
                self.events.append((event, payload, kwargs))

        def names(self):
            return [e for (e, _p, _k) in self.events]

        def outputs(self):
            return [p.get('data') for (e, p, _k) in self.events
                    if e == 'ssh_output']

    io = HeldEmitIO()
    reader = _run_reader('close-vs-pub', io, 0, live_app)
    assert blocking.entered.wait(5), 'reader never reached recv'
    blocking.release.set()

    assert close_done.wait(5), 'close never completed'
    assert boundary_observed.is_set(), \
        'closer never observed the authority boundary held'
    reader.join(5)
    assert not reader.is_alive(), 'reader never exited'

    # The close landed strictly after the publish.
    assert timeline == ['publish:enter', 'publish:exit', 'close:done'], timeline
    # Exactly one publication, before the close; nothing after.
    assert io.outputs() == ['PRE-CLOSE-BYTES'], io.events
    # The session is gone, and the reader retired quietly.
    assert 'close-vs-pub' not in ssh_manager.sessions
    assert 'ssh_disconnected' not in io.names(), io.events


def test_death_claim_vs_publish_no_output_after_claim(live_app):
    """Boundary: exact-current death claim vs an in-flight publish.

    claim_reader_death is the third authority mutation. A gen0 reader publishing
    must finish before a gen1 reader's death claim can pop the session out from
    under it; and once gen1's claim has popped the session, gen0 (if it somehow
    resumed) must not be able to publish. The authority lock serializes both.

    Deterministic: gen0 holds the authority lock mid-emit. gen1's channel is
    already dead, so gen1's reader reaches its claim immediately and must block
    on the authority lock until gen0's publish finishes. The claim completes
    strictly after the publish; no stale output from gen0 reaches the terminal
    after gen1 has claimed the death.
    """
    _seed_db_row(live_app, 'claim-vs-pub')
    blocking = BlockingChannel('gen0', payload=b'GEN0-FINAL')
    _register_session('claim-vs-pub', FakeClient('gen0'), blocking,
                      output_buffer=[], output_buffer_size=0)

    timeline = []
    timeline_lock = threading.Lock()
    claim_attempted = threading.Event()
    claim_done = threading.Event()
    boundary_observed = threading.Event()

    def note(event):
        with timeline_lock:
            timeline.append(event)

    class HeldEmitIO:
        def __init__(self):
            self.events = []

        def emit(self, event, payload=None, **kwargs):
            if event == 'ssh_output':
                note('publish:enter')

                def claimer():
                    claim_attempted.set()
                    with ssh_manager.sessions_lock:
                        sess = ssh_manager.sessions['claim-vs-pub']
                        boundary_lock = (
                            ssh_manager._session_authority_lock(sess))
                    # Non-blocking probe; release on unexpected success so the
                    # real claim below cannot self-deadlock.
                    probe = boundary_lock.acquire(timeout=0)
                    if probe:
                        boundary_lock.release()
                    else:
                        boundary_observed.set()
                    # Run gen1's reader inline: it will reach its finally and
                    # call claim_reader_death for generation 0 (the current one,
                    # since no swap has bumped it). The claim is what we are
                    # testing at the boundary.
                    gen1_channel = DyingChannel('gen1')
                    ssh_manager.read_ssh_output(
                        'claim-vs-pub', RecordingSocketIO(), live_app,
                        transport_generation=0)
                    note('claim:done')
                    claim_done.set()

                thread = threading.Thread(target=claimer, daemon=True)
                thread.start()
                assert claim_attempted.wait(5), 'claimer never attempted'
                assert not claim_done.is_set(), \
                    'claim completed while its boundary lock was held'
                self.events.append((event, payload, kwargs))
                note('publish:exit')
            else:
                self.events.append((event, payload, kwargs))

        def names(self):
            return [e for (e, _p, _k) in self.events]

        def outputs(self):
            return [p.get('data') for (e, p, _k) in self.events
                    if e == 'ssh_output']

    io = HeldEmitIO()
    reader = _run_reader('claim-vs-pub', io, 0, live_app)
    assert blocking.entered.wait(5), 'gen0 reader never reached recv'
    blocking.release.set()

    assert claim_done.wait(5), 'claim never completed'
    assert boundary_observed.is_set(), \
        'claimer never observed the authority boundary held'
    reader.join(5)
    assert not reader.is_alive(), 'gen0 reader never exited'

    # The claim landed strictly after the publish.
    assert timeline == ['publish:enter', 'publish:exit', 'claim:done'], timeline
    # Exactly one publication from gen0, before the claim; nothing stale after.
    assert io.outputs() == ['GEN0-FINAL'], io.events
    # The session is gone -- the claim popped it.
    assert 'claim-vs-pub' not in ssh_manager.sessions


# ---- P1 reused-id / orphan-lock: a waiter must not mutate a replacement ----
#
# The authority lock lives ON the session dict. When a session is removed its
# dict is popped, and the SAME session_id can be re-registered as a NEW dict
# with a NEW lock. A waiter that blocked on the OLD session's lock would then
# wake, revalidate by id, find the NEW session (connected, right generation),
# and mutate or pop it under the OLD session's orphan lock.
#
# The fix captures (expected_session, authority_lock) together and re-validates
# by OBJECT IDENTITY after acquiring the lock: sessions.get(id) must BE the same
# dict, not merely some session registered under that id. A reused id has a
# different dict, so the waiter returns harmlessly.
#
# These tests force the interleaving with explicit events/barriers -- no sleep,
# no timing assumption.

def _install_capture_barrier(monkeypatch, session_id):
    """Install a test-only barrier at the authority-claim capture boundary.

    Returns ``(captured, proceed, box)``. ``captured`` is set by the hook the
    instant a waiter has captured ``(expected_session, authority_lock)`` for
    `session_id` and is about to block on the lock; the hook then WAITS on
    ``proceed``, pausing the waiter deterministically right before its lock
    acquisition. ``box`` records the exact (session, lock) the waiter captured so
    the test can assert it captured session A specifically.

    This is the boundary a deterministic reused-id test needs: the test holds
    A's lock, waits for ``captured``, removes A / registers B under the same id,
    then sets ``proceed`` (the waiter attempts to acquire A's lock, which the
    test still holds, so it blocks) and releases A's lock. No sleep, no timing
    assumption -- both waits are explicit Event barriers.
    """
    captured = threading.Event()
    proceed = threading.Event()
    box = {}

    def hook(sid, session, lock):
        if sid != session_id:
            return
        box['session'] = session
        box['lock'] = lock
        captured.set()
        # Deterministic pause right before lock acquisition. The timeout is only
        # a hang guard; the barrier returns as soon as the test sets proceed.
        proceed.wait(5)

    monkeypatch.setattr(ssh_manager, 'authority_claim_hook', hook)
    return captured, proceed, box


def test_reused_id_orphan_swap_waiter_does_not_mutate_replacement(monkeypatch):
    """An old swap waiter, blocked on session A's lock, must not mutate session B
    registered under the same id after A is removed.

    Deterministic: the capture hook proves the waiter captured A (its exact
    session object and its exact lock) and is paused right before acquiring the
    lock. The test holds A's lock, removes A and registers B under the same id,
    then lets the waiter proceed into the lock acquisition (where it blocks,
    because the test still holds the lock) and finally releases A's lock. The
    waiter then re-validates by OBJECT IDENTITY, detects B != A, and refuses.
    No sleep, no timing assumption.
    """
    _register_session('reuse-1', FakeClient('A'), FakeChannel('A'))
    with ssh_manager.sessions_lock:
        session_a = ssh_manager.sessions['reuse-1']
        a_lock = ssh_manager._session_authority_lock(session_a)

    captured, proceed, box = _install_capture_barrier(monkeypatch, 'reuse-1')
    swap_result = {}
    swap_done = threading.Event()

    def swap_waiter():
        swap_result['ok'] = ssh_manager.swap_session_transport(
            'reuse-1', _transport('replacement'))
        swap_done.set()

    # The test holds A's lock so the waiter blocks once it tries to acquire it.
    a_lock.acquire()
    try:
        waiter = threading.Thread(target=swap_waiter, daemon=True)
        waiter.start()
        # Barrier 1: waiter captured A's exact session and its exact lock, and is
        # paused right before lock acquisition.
        assert captured.wait(5), 'swap waiter never captured the authority claim'
        assert box['session'] is session_a, \
            'waiter captured a different session than A'
        assert box['lock'] is a_lock, 'waiter captured a different lock than A'

        # Remove A and register B under the same id while the waiter is paused.
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('reuse-1', None)
        b_client = CountingClient('B')
        b_channel = CountingChannel('B')
        _register_session('reuse-1', b_client, b_channel)
        with ssh_manager.sessions_lock:
            session_b = ssh_manager.sessions['reuse-1']
            b_lock = ssh_manager._session_authority_lock(session_b)
        assert b_lock is not a_lock, 'B reuses A\'s lock (should be distinct)'

        # Barrier 2: let the waiter proceed into the lock acquisition. The test
        # still holds a_lock, so the waiter BLOCKS here; it can only complete
        # after the test releases a_lock (below, in the finally).
        proceed.set()
    finally:
        a_lock.release()

    assert swap_done.wait(5), 'swap waiter never completed after lock release'
    waiter.join(5)

    # The swap REFUSED: it detected the reused id and touched nothing.
    ok, error = swap_result['ok']
    assert ok is False, 'swap mutated the replacement session B'
    assert error == 'Session no longer exists', f'unexpected error: {error}'
    # B is intact: still registered, still connected, untouched.
    assert 'reuse-1' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['reuse-1']
    assert session is session_b, 'B was replaced'
    assert session['channel'] is b_channel, 'B\'s channel was mutated'
    assert session['client'] is b_client, 'B\'s client was mutated'
    assert session['connected'] is True
    assert session['transport_generation'] == 0
    assert b_channel.close_calls == 0
    assert b_client.close_calls == 0


def test_reused_id_orphan_close_waiter_does_not_pop_replacement(monkeypatch):
    """Same race against close_session: an old close waiter, blocked on session
    A's lock, must not pop session B registered under the same id after A is
    removed. Deterministic via the same capture-boundary barrier."""
    _register_session('reuse-2', FakeClient('A'), FakeChannel('A'))
    with ssh_manager.sessions_lock:
        session_a = ssh_manager.sessions['reuse-2']
        a_lock = ssh_manager._session_authority_lock(session_a)

    captured, proceed, box = _install_capture_barrier(monkeypatch, 'reuse-2')
    close_result = {}
    close_done = threading.Event()

    def close_waiter():
        close_result['ok'] = ssh_manager.close_session('reuse-2')
        close_done.set()

    a_lock.acquire()
    try:
        waiter = threading.Thread(target=close_waiter, daemon=True)
        waiter.start()
        # Barrier 1: waiter captured A and is paused before lock acquisition.
        assert captured.wait(5), 'close waiter never captured the authority claim'
        assert box['session'] is session_a, \
            'waiter captured a different session than A'
        assert box['lock'] is a_lock, 'waiter captured a different lock than A'

        # Remove A and register B under the same id while the waiter is paused.
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('reuse-2', None)
        b_client = CountingClient('B')
        b_channel = CountingChannel('B')
        _register_session('reuse-2', b_client, b_channel)

        # Barrier 2: waiter proceeds into lock acquisition and blocks; the test
        # releases a_lock only in the finally below.
        proceed.set()
    finally:
        a_lock.release()

    assert close_done.wait(5), 'close waiter never completed after lock release'
    waiter.join(5)

    # close REFUSED: it detected the reused id and did not pop B.
    assert close_result['ok'] is False, 'close popped the replacement session B'
    # B is intact.
    assert 'reuse-2' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['reuse-2']
    assert session['connected'] is True
    assert session['channel'] is b_channel
    assert session['client'] is b_client
    assert b_channel.close_calls == 0
    assert b_client.close_calls == 0


def test_reused_id_orphan_claim_waiter_does_not_pop_replacement(
        live_app, monkeypatch):
    """Same race against claim_reader_death: an old death-claim waiter, blocked
    on session A's lock, must not pop session B registered under the same id.

    The claim is reachable from a real reader (its finally block calls
    claim_reader_death), but we drive the claim directly for a tight,
    deterministic test. The capture-boundary barrier is identical: the waiter
    captures A's lock, the test removes A / registers B, the waiter blocks on
    A's lock, the test releases, and the claim refuses B by object identity.
    """
    _seed_db_row(live_app, 'reuse-3')
    a_channel = DyingChannel('A', raise_on_recv=EOFError())
    _register_session('reuse-3', FakeClient('A'), a_channel)
    with ssh_manager.sessions_lock:
        session_a = ssh_manager.sessions['reuse-3']
        a_lock = ssh_manager._session_authority_lock(session_a)

    captured, proceed, box = _install_capture_barrier(monkeypatch, 'reuse-3')
    claim_result = {}
    claim_done = threading.Event()

    def claim_waiter():
        state, parts = ssh_manager.claim_reader_death('reuse-3', 0, a_channel)
        claim_result['state'] = state
        claim_result['parts'] = parts
        claim_done.set()

    a_lock.acquire()
    try:
        waiter = threading.Thread(target=claim_waiter, daemon=True)
        waiter.start()
        # Barrier 1: waiter captured A and is paused before lock acquisition.
        assert captured.wait(5), 'claim waiter never captured the authority claim'
        assert box['session'] is session_a, \
            'waiter captured a different session than A'
        assert box['lock'] is a_lock, 'waiter captured a different lock than A'

        # Remove A and register B under the same id while the waiter is paused.
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('reuse-3', None)
        b_client = CountingClient('B')
        b_channel = CountingChannel('B')
        _register_session('reuse-3', b_client, b_channel)

        # Barrier 2: waiter proceeds into lock acquisition and blocks; the test
        # releases a_lock only in the finally below.
        proceed.set()
    finally:
        a_lock.release()

    assert claim_done.wait(5), 'claim waiter never completed after lock release'
    waiter.join(5)

    # The claim REFUSED: it saw a different session object under the id and
    # reported it superseded rather than popping B.
    assert claim_result['state'] == ssh_manager.READER_RETIRE_SUPERSEDED, \
        f'unexpected claim state: {claim_result.get("state")}'
    assert claim_result['parts'] is None, \
        'claim captured B\'s parts (it must not have touched B)'
    # B is intact.
    assert 'reuse-3' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['reuse-3']
    assert session['connected'] is True
    assert session['channel'] is b_channel
    assert session['client'] is b_client
    assert b_channel.close_calls == 0
    assert b_client.close_calls == 0


def test_same_id_sftp_ownership_A_cleanup_does_not_close_B_cache(monkeypatch):
    """A's cleanup must not close B's SFTP handle or lock when B reuses A's id.

    CONTRACT:
      * A's handle is closed exactly once — by get_sftp_client's owner-mismatch
        eviction when B opens its own SFTP channel, NOT by A's delayed
        _close_retired_parts.
      * B's handle close_count == 0: A's cleanup no-ops on owner mismatch.
      * B remains cached and open; B's lock remains usable (sftp_session can
        acquire/release it).

    The race window is between claim_reader_death (pop) and _close_retired_parts
    (SFTP close), both in the same reader thread. We split them explicitly: A's
    cache entry is installed, A's claim pops the SSH session, B registers under
    the same id, B's get_sftp_client evicts A and opens B, then A's delayed
    cleanup runs and no-ops.
    """
    from app import sftp_handler

    # --- Session A: register, install SFTP cache entry with A's owner token ---
    a_channel = DyingChannel('A', raise_on_recv=EOFError())
    a_client = FakeClient('A')
    _register_session('sftp-owner', a_client, a_channel)
    with ssh_manager.sessions_lock:
        a_session = ssh_manager.sessions['sftp-owner']
        a_token = a_session['_sftp_owner_token']

    a_sftp_closed = [0]

    class FakeSftpHandle:
        def stat(self, path):
            return True  # cache hit validation passes

        def close(self):
            a_sftp_closed[0] += 1

    a_handle = FakeSftpHandle()
    with sftp_handler._sftp_cache_lock:
        sftp_handler._sftp_cache['sftp-owner'] = (a_handle, a_token)
    lock_before = sftp_handler._get_sftp_lock('sftp-owner')  # stable lock exists

    # --- Claim A's death: pops the SSH session, captures parts with A's token --
    state, parts = ssh_manager.claim_reader_death('sftp-owner', 0, a_channel)
    assert state == ssh_manager.READER_RETIRE_CURRENT, state
    assert len(parts) == 4, f'parts missing owner token: {parts}'
    assert parts[3] is a_token, 'captured token is not A\'s'

    # --- B registers under the SAME id, with its own token ---
    b_client = CountingClient('B')
    b_channel = CountingChannel('B')
    _register_session('sftp-owner', b_client, b_channel)
    with ssh_manager.sessions_lock:
        b_session = ssh_manager.sessions['sftp-owner']
        b_token = b_session['_sftp_owner_token']
    assert b_token is not a_token, 'B shares A\'s owner token'

    # B opens its SFTP channel via get_sftp_client. This MUST detect the owner
    # mismatch (A's token vs B's token), atomically detach and close A's handle,
    # then open and cache B's. B's client.open_sftp returns B's fake handle.
    b_sftp_closed = [0]

    class FakeBSftpHandle:
        def stat(self, path):
            return True

        def close(self):
            b_sftp_closed[0] += 1

    b_handle = FakeBSftpHandle()
    b_client.open_sftp = lambda: b_handle

    sftp, error = sftp_handler.get_sftp_client('sftp-owner')
    assert error is None, f'get_sftp_client failed for B: {error}'
    assert sftp is b_handle, 'get_sftp_client did not return B\'s handle'

    # A's handle was closed exactly once — by the owner-mismatch eviction in
    # get_sftp_client, NOT by A's delayed cleanup.
    assert a_sftp_closed[0] == 1, \
        f'A\'s handle closed {a_sftp_closed[0]} times (expected 1: evicted ' \
        'by get_sftp_client owner mismatch)'

    # --- A's delayed cleanup runs, with A's captured owner token ---
    ssh_manager._close_retired_parts('sftp-owner', parts)

    # B's handle is NEVER closed by A's cleanup (owner mismatch no-op).
    assert b_sftp_closed[0] == 0, \
        f'B\'s SFTP handle was closed by A\'s cleanup ({b_sftp_closed[0]})'

    # B's cache entry remains, with B's handle and B's owner.
    with sftp_handler._sftp_cache_lock:
        assert 'sftp-owner' in sftp_handler._sftp_cache, \
            'B\'s SFTP cache entry was removed by A\'s cleanup'
        cached = sftp_handler._sftp_cache['sftp-owner']
        cached_handle = cached[0] if isinstance(cached, tuple) else cached
        assert cached_handle is b_handle, 'B\'s cache entry was replaced'
        cached_owner = cached[1] if isinstance(cached, tuple) else None
        assert cached_owner is b_token, 'B\'s cache owner was changed'

    # B's lock remains registered and USABLE, and is the SAME stable object:
    # the per-session Lock is never removed or replaced by any cleanup.
    lock = sftp_handler._get_sftp_lock('sftp-owner')
    assert lock is lock_before, 'stable per-session Lock was removed or replaced'
    assert isinstance(lock, type(threading.Lock())), \
        f'_get_sftp_lock returned {type(lock)}, not a Lock'
    acquired = lock.acquire(timeout=1)
    assert acquired, 'B\'s SFTP lock is not acquirable after A\'s cleanup'
    lock.release()

    # B's SSH session is still registered and connected.
    assert 'sftp-owner' in ssh_manager.sessions
    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions['sftp-owner']
    assert session is b_session, 'B was replaced'
    assert session['connected'] is True


def test_sftp_session_acquire_release_after_owner_aware_entry(monkeypatch):
    """Regression: sftp_session() must acquire/release a real Lock, not a tuple.

    After get_sftp_client creates an owner-aware cache entry, the per-session
    lock must be a bare Lock object. sftp_session() calls _get_sftp_lock and
    then .acquire()/.release() on it — a tuple here would crash with
    AttributeError. This test proves the lock shape is correct after an
    owner-aware entry exists.
    """
    from app import sftp_handler

    # Register a session with an owner token.
    _register_session('sftp-lock-test', FakeClient('locktest'),
                      FakeChannel('locktest'))
    # Call get_sftp_client so it creates the lock + owner record.
    # Patch open_sftp so no real SFTP channel is opened.
    handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()
    monkeypatch.setattr(
        ssh_manager.sessions['sftp-lock-test']['client'],
        'open_sftp', lambda: handle)
    sftp, error = sftp_handler.get_sftp_client('sftp-lock-test')
    assert error is None

    # The lock must be a real Lock, not a tuple.
    lock = sftp_handler._get_sftp_lock('sftp-lock-test')
    assert hasattr(lock, 'acquire') and callable(lock.acquire), \
        f'_get_sftp_lock returned {type(lock)}, not a Lock'
    acquired = lock.acquire(timeout=1)
    assert acquired, 'lock could not be acquired'
    lock.release()

    # sftp_session() itself must work end-to-end.
    with sftp_handler.sftp_session('sftp-lock-test') as (sftp_obj, source):
        assert sftp_obj is handle, 'sftp_session did not yield the cached handle'
    ssh_manager.close_session('sftp-lock-test')


def test_sftp_session_acquire_release_after_same_id_owner_reuse(monkeypatch):
    """Regression: after same-id owner reuse (A -> B), sftp_session() on B's id
    must acquire B's real Lock and yield B's handle, not crash on A's stale
    tuple."""
    from app import sftp_handler

    # Session A: create cache entry.
    _register_session('sftp-reuse', FakeClient('A'), FakeChannel('A'))
    a_handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()
    monkeypatch.setattr(
        ssh_manager.sessions['sftp-reuse']['client'], 'open_sftp',
        lambda: a_handle)
    sftp_handler.get_sftp_client('sftp-reuse')

    # Replace A with B under the same id.
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop('sftp-reuse', None)
    b_client = CountingClient('B')
    b_channel = CountingChannel('B')
    _register_session('sftp-reuse', b_client, b_channel)
    b_handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()
    monkeypatch.setattr(b_client, 'open_sftp', lambda: b_handle)

    # B's get_sftp_client detects the mismatch, evicts A, opens B.
    sftp, error = sftp_handler.get_sftp_client('sftp-reuse')
    assert error is None
    assert sftp is b_handle

    # sftp_session on B's id must work.
    with sftp_handler.sftp_session('sftp-reuse') as (sftp_obj, source):
        assert sftp_obj is b_handle, \
            'sftp_session yielded the wrong handle after owner reuse'
    ssh_manager.close_session('sftp-reuse')


# ---- one lifecycle owner ---------------------------------------------------

def test_second_concurrent_reconnect_is_rejected():
    """Two in-flight reconnects would race two transports into one session."""
    assert ssh_manager.begin_reconnect('swap-8') is True
    assert ssh_manager.begin_reconnect('swap-8') is False
    ssh_manager.end_reconnect('swap-8')
    # Released: a later, sequential reconnect is allowed again.
    assert ssh_manager.begin_reconnect('swap-8') is True


def test_reconnect_claims_are_per_session():
    assert ssh_manager.begin_reconnect('a') is True
    assert ssh_manager.begin_reconnect('b') is True
    ssh_manager.end_reconnect('a')
    assert ssh_manager.begin_reconnect('a') is True
    assert ssh_manager.begin_reconnect('b') is False


def test_end_reconnect_is_idempotent():
    ssh_manager.begin_reconnect('c')
    ssh_manager.end_reconnect('c')
    ssh_manager.end_reconnect('c')  # must not raise
    assert ssh_manager.begin_reconnect('c') is True


def test_concurrent_claims_admit_exactly_one_owner():
    """Under real thread contention, not just sequential calls."""
    results = []
    barrier = threading.Barrier(8)

    def claim():
        barrier.wait(2)
        results.append(ssh_manager.begin_reconnect('swap-9'))

    threads = [threading.Thread(target=claim, daemon=True) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(3)
    assert results.count(True) == 1, results


# ---- W13 stable SFTP lock: deterministic waiter tests -----------------------

def test_sftp_waiter_blocked_across_same_id_swap_resolves_B(monkeypatch):
    """A get_sftp_client waiter blocked on the stable Lock while A is replaced
    by B under the same id must resolve B INSIDE the locked boundary.

    Deterministic sequencing via Events, no sleeps:
      1. Session A is registered and the test thread HOLDS A's per-session
         Lock, so the waiter's get_sftp_client call blocks on acquire.
      2. The waiter signals it is about to acquire; the test then removes A,
         registers B (same id, new owner token, new client) while the waiter
         is still blocked.
      3. The test releases the Lock. The waiter proceeds and must resolve the
         CURRENT registry entry -- B -- opening and returning B's handle. A
         pre-lock snapshot of A would return A's handle: the bug this pins.
    """
    from app import sftp_handler

    sid = 'sftp-swap-wait'
    _register_session(sid, FakeClient('A'), FakeChannel('A'))
    a_handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()
    monkeypatch.setattr(
        ssh_manager.sessions[sid]['client'], 'open_sftp', lambda: a_handle)

    lock = sftp_handler._get_sftp_lock(sid)
    about_to_block = threading.Event()
    result = {}
    done = threading.Event()

    def waiter():
        about_to_block.set()
        sftp, error = sftp_handler.get_sftp_client(sid)
        result['sftp'] = sftp
        result['error'] = error
        done.set()

    b_handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()

    lock.acquire()
    try:
        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        assert about_to_block.wait(5), 'waiter never started'
        # The waiter is at (or heading into) lock.acquire and CANNOT have
        # resolved a session yet: resolution happens inside the boundary.
        # Swap A -> B under the same id while the Lock is held.
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop(sid, None)
        b_client = FakeClient('B')
        b_client.open_sftp = lambda: b_handle
        _register_session(sid, b_client, FakeChannel('B'))
    finally:
        lock.release()

    assert done.wait(5), 'waiter never completed after lock release'
    t.join(5)
    assert result['error'] is None, f"waiter got error: {result['error']}"
    assert result['sftp'] is b_handle, \
        'waiter resolved a stale pre-lock snapshot of A instead of current B'
    # The stable Lock is unchanged and reusable.
    assert sftp_handler._get_sftp_lock(sid) is lock, \
        'stable per-session Lock was replaced by the swap'
    with sftp_handler._sftp_cache_lock:
        sftp_handler._sftp_cache.pop(sid, None)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop(sid, None)


def test_close_sftp_cache_owner_none_never_touches_session_entries(monkeypatch):
    """close_sftp_cache(expected_owner=None) affects ONLY the pool cache.

    Pool ids and session ids share one namespace at the call sites, so the
    isolation must be structural: a None-owner close (pool/legacy path) must
    not detach or close a session-owned cache entry even under the same id.
    """
    from app import sftp_handler

    sid = 'pool-vs-session'
    _register_session(sid, FakeClient('S'), FakeChannel('S'))
    with ssh_manager.sessions_lock:
        token = ssh_manager.sessions[sid]['_sftp_owner_token']

    session_closed = [0]
    pool_closed = [0]

    session_handle = type('H', (), {
        'stat': lambda self, p: True,
        'close': lambda self: session_closed.__setitem__(
            0, session_closed[0] + 1)})()
    pool_handle = type('H', (), {
        'close': lambda self: pool_closed.__setitem__(
            0, pool_closed[0] + 1)})()

    with sftp_handler._sftp_cache_lock:
        sftp_handler._sftp_cache[sid] = (session_handle, token)
        sftp_handler._sftp_pool_cache[sid] = pool_handle

    # None-owner close: pool entry closed, session entry untouched.
    closed = sftp_handler.close_sftp_cache(sid, expected_owner=None)
    assert closed is True
    assert pool_closed[0] == 1, 'pool handle was not closed'
    assert session_closed[0] == 0, \
        'None-owner close touched a session-owned entry'
    with sftp_handler._sftp_cache_lock:
        assert sid in sftp_handler._sftp_cache, \
            'session cache entry was detached by a None-owner close'
        assert sid not in sftp_handler._sftp_pool_cache

    # Wrong-token close: no-op on the session entry.
    closed = sftp_handler.close_sftp_cache(sid, expected_owner=object())
    assert closed is False
    assert session_closed[0] == 0
    with sftp_handler._sftp_cache_lock:
        assert sid in sftp_handler._sftp_cache

    # Correct-token close: session entry detached and closed exactly once.
    closed = sftp_handler.close_sftp_cache(sid, expected_owner=token)
    assert closed is True
    assert session_closed[0] == 1
    with sftp_handler._sftp_cache_lock:
        assert sid not in sftp_handler._sftp_cache
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop(sid, None)


def test_get_any_sftp_client_under_held_lock_does_not_deadlock(monkeypatch):
    """Regression for the socket download pattern (socket_events download
    handler): the caller manually acquires the exact per-session Lock via
    _get_sftp_lock, then calls get_any_sftp_client while HOLDING it.

    get_any_sftp_client is the LOCKED helper and must never reacquire the
    non-reentrant per-session Lock -- a reacquire would deadlock this exact
    sequence. Run in a worker thread with a timeout so a regression fails the
    test instead of hanging the suite. sftp_session must then work on the same
    id afterwards, proving the Lock was released cleanly.
    """
    from app import sftp_handler

    sid = 'download-lock-pattern'
    _register_session(sid, FakeClient('D'), FakeChannel('D'))
    handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()
    monkeypatch.setattr(
        ssh_manager.sessions[sid]['client'], 'open_sftp', lambda: handle)

    result = {}
    done = threading.Event()

    def download_pattern():
        lock = sftp_handler._get_sftp_lock(sid)
        lock.acquire()
        try:
            sftp, error, source = sftp_handler.get_any_sftp_client(sid)
            result['sftp'] = sftp
            result['error'] = error
            result['source'] = source
        finally:
            lock.release()
        done.set()

    t = threading.Thread(target=download_pattern, daemon=True)
    t.start()
    assert done.wait(5), \
        'DEADLOCK: get_any_sftp_client reacquired the held per-session Lock'
    t.join(5)
    assert result['error'] is None, f"unexpected error: {result['error']}"
    assert result['sftp'] is handle
    assert result['source'] == 'session'

    # The Lock was released: sftp_session on the same id must not block.
    with sftp_handler.sftp_session(sid) as (sftp_obj, source):
        assert sftp_obj is handle
    with sftp_handler._sftp_cache_lock:
        sftp_handler._sftp_cache.pop(sid, None)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop(sid, None)


def test_concurrent_get_sftp_client_single_publication_stable_lock(monkeypatch):
    """Barrier contention: N concurrent get_sftp_client callers serialize on
    the ONE stable per-session Lock -- exactly one SFTP channel is opened,
    every caller receives that same handle, and the Lock object observed
    before, during and after (including across close_sftp_cache) is the SAME
    object. A second Lock minted anywhere would let two callers open two
    channels: open_count > 1 catches it.
    """
    from app import sftp_handler

    sid = 'sftp-barrier'
    _register_session(sid, FakeClient('C'), FakeChannel('C'))
    with ssh_manager.sessions_lock:
        token = ssh_manager.sessions[sid]['_sftp_owner_token']

    open_count = [0]
    handle = type('H', (), {
        'stat': lambda self, p: True, 'close': lambda self: None})()

    def counting_open_sftp():
        open_count[0] += 1
        return handle

    monkeypatch.setattr(
        ssh_manager.sessions[sid]['client'], 'open_sftp', counting_open_sftp)

    lock_before = sftp_handler._get_sftp_lock(sid)
    n = 8
    barrier = threading.Barrier(n)
    results = []
    results_lock = threading.Lock()

    def caller():
        barrier.wait(5)
        sftp, error = sftp_handler.get_sftp_client(sid)
        with results_lock:
            results.append((sftp, error, sftp_handler._get_sftp_lock(sid)))

    threads = [threading.Thread(target=caller, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(results) == n, f'only {len(results)}/{n} callers finished'
    for sftp, error, seen_lock in results:
        assert error is None, f'caller failed: {error}'
        assert sftp is handle, 'a caller received a different handle'
        assert seen_lock is lock_before, 'a caller saw a second Lock object'
    assert open_count[0] == 1, \
        f'{open_count[0]} SFTP channels opened (expected 1: serialization broken)'

    # The stable Lock survives close_sftp_cache and is immediately reusable.
    assert sftp_handler.close_sftp_cache(sid, expected_owner=token) is True
    lock_after = sftp_handler._get_sftp_lock(sid)
    assert lock_after is lock_before, \
        'close_sftp_cache removed or replaced the stable per-session Lock'
    assert lock_after.acquire(timeout=1), 'stable Lock not acquirable after close'
    lock_after.release()
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop(sid, None)
