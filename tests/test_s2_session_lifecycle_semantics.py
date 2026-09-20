"""S2 Phase 1.2 steps 1-2 — idle semantics, Owner protection, worker guard.

The defect this pins, from the production audit: a session was "active" whenever
a browser was merely CONNECTED or the remote end merely PRINTED, neither of which
is a human using it.

  * static/js/app.js runs a 60s interval that emits `keep_alive` whenever the
    socket is connected, with no interaction test;
  * handle_keep_alive then refreshed last_activity for EVERY registry session of
    that user, so one open tab made idle expiry unreachable against the 1800s
    timeout -- the live container shows ZERO "Closed idle session" entries;
  * every output byte refreshed it too, so an emitting pane (prompt redraw,
    clock, MOTD) was immortal even with no tab open;
  * and the reaper had NO persistence exemption of any kind, so the Owner's
    persistent tmux sessions survived only BY ACCIDENT of those refreshers.
    Removing them without an explicit exemption would have started reaping
    exactly the sessions meant to outlive a disconnect.

Every assertion below is an INVERTED pin: it fails on the pre-fix behavior and
passes on the repaired behavior.

No Owner account, no real SSH, no production data: registry entries are plain
dicts with object() handles (the shape the existing suites use), and the socket
half runs through socketio.test_client with a throwaway uuid-stemmed account in
a temp DATA_DIR.
"""
import importlib
import os
import tempfile
import time
import uuid

import pytest


@pytest.fixture(scope='module')
def app():
    saved_data_dir = os.environ.get('DATA_DIR')
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        saved_ratelimit = config.RATELIMIT_ENABLED
        config.RATELIMIT_ENABLED = False

        from app import create_app
        from app.models import db

        test_app = create_app()
        test_app.config.update(TESTING=True, WTF_CSRF_ENABLED=False)
        with test_app.app_context():
            db.create_all()
        yield test_app
        with test_app.app_context():
            db.session.remove()
            db.engine.dispose()
        config.RATELIMIT_ENABLED = saved_ratelimit
    if saved_data_dir is None:
        os.environ.pop('DATA_DIR', None)
    else:
        os.environ['DATA_DIR'] = saved_data_dir


@pytest.fixture
def registry():
    """Own the process-local registry for one test, then restore it."""
    from app import ssh_manager
    saved = dict(ssh_manager.sessions)
    ssh_manager.sessions.clear()
    yield ssh_manager.sessions
    ssh_manager.sessions.clear()
    ssh_manager.sessions.update(saved)


def fake_session(user_id=1, use_tmux=False, idle_for=0.0,
                 interaction_idle_for=None, with_interaction_field=True):
    """A registry entry shaped like create_session's, with object() handles.

    interaction_idle_for defaults to idle_for so a caller can age both clocks
    together; pass them apart to express "output/heartbeat is fresh but the human
    left". with_interaction_field=False reproduces a PRE-UPGRADE entry (and the
    hand-built dicts in the older suites), which must never read as infinitely
    idle.
    """
    now = time.time()
    if interaction_idle_for is None:
        interaction_idle_for = idle_for
    session = {
        'client': object(),
        'channel': object(),
        'host': 'fake.invalid',
        'port': 22,
        'username': 'nobody',
        'user_id': user_id,
        'connected': True,
        'last_activity': now - idle_for,
        'use_tmux': use_tmux,
        'tmux_session_name': 'tmux-fake' if use_tmux else None,
        'display_name': 'Fake',
        'output_buffer': [],
        'output_buffer_size': 0,
        'output_buffer_max': 512000,
    }
    if with_interaction_field:
        session['last_interaction'] = now - interaction_idle_for
    return session


def run_reaper(app, monkeypatch, timeout=60, close_impl=None):
    """Drive the real cleanup_idle_sessions with a short timeout.

    close_session is stubbed to record calls and pop the entry: the real one is
    already covered by tests/test_session_lifecycle.py, and stubbing keeps this
    suite away from any I/O. The emit is captured so a later step (reaper
    notification, not implemented yet) can assert on it without reshaping this
    fixture.
    """
    from app import ssh_manager

    closed = []
    emitted = []

    def fake_close(session_id, kill_tmux=False, expected_session=None):
        closed.append((session_id, kill_tmux))
        ssh_manager.sessions.pop(session_id, None)
        return True

    monkeypatch.setattr(ssh_manager, 'close_session',
                        close_impl if close_impl is not None else fake_close)
    monkeypatch.setattr(ssh_manager.config, 'SESSION_TIMEOUT', timeout)

    class FakeSocketIO:
        def emit(self, event, payload=None, **kwargs):
            # The 4th element records whether the session was STILL registered
            # at the moment of the emit. That is how the close-before-notify
            # order is proven: a frame carrying still_registered=True means the
            # client was told "disconnected" about a session the registry still
            # held, which is the ordering bug the contract forbids.
            session_id = (payload or {}).get('session_id')
            still_registered = session_id in ssh_manager.sessions
            emitted.append((event, payload, kwargs, still_registered))

    import app as app_pkg
    monkeypatch.setattr(app_pkg, 'socketio', FakeSocketIO(), raising=False)

    with app.app_context():
        ssh_manager.cleanup_idle_sessions()
    return closed, emitted


def _restore_this_process_as_holder(app, monkeypatch):
    """Put the claim back in this process's hands after a refusal/takeover test.

    Tests that rewrite the claim row (or the module globals) leave later tests
    starting refused. Fixture cleanup undoes monkeypatches; this restores the
    DB row and re-acquires under a fresh boot id. Prefer this over
    monkeypatch.undo(), which can erase unrelated patches.
    """
    from datetime import datetime, timezone
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    monkeypatch.setattr(worker_guard, '_BOOT_ID', None)
    monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
    monkeypatch.setattr(worker_guard, '_GUARD_PID', None)
    with app.app_context():
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        if claim is None:
            worker_guard.acquire_guard()
            return
        claim.boot_id = worker_guard.boot_id()
        claim.pid = os.getpid()
        claim.pid_starttime = worker_guard._pid_starttime(os.getpid())
        claim.heartbeat_at = datetime.now(timezone.utc)
        _db.session.commit()
        worker_guard.acquire_guard()
    assert worker_guard.guard_is_held()


def _set_claim_to_foreign(app, pid=None, boot='previous-boot',
                          start_offset=-1, heartbeat_fresh=True):
    """Write a claim row owned by a DIFFERENT incarnation.

    pid defaults to this process's parent (alive, not us). start_offset shifts
    the stored pid_starttime by that many ticks, so a value of -1/+1 yields a
    MISMATCHED incarnation for the same pid number. heartbeat_fresh keeps the
    heartbeat at now so the stale-window rule is not what resolves the case --
    only pid_starttime (or pid liveness) can.
    """
    from datetime import datetime, timedelta, timezone
    from app.models import WorkerClaim, db as _db
    from app import worker_guard

    if pid is None:
        pid = os.getppid()
    real_start = worker_guard._pid_starttime(pid)
    with app.app_context():
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        claim.boot_id = boot
        claim.pid = pid
        claim.pid_starttime = (
            None if real_start is None else real_start + start_offset)
        claim.heartbeat_at = (
            datetime.now(timezone.utc) if heartbeat_fresh
            else datetime.now(timezone.utc) - timedelta(hours=24))
        _db.session.commit()
    return pid


# --------------------------------------------------------------------------
# (b) what counts as activity
# --------------------------------------------------------------------------

def test_automatic_keep_alive_does_not_count_as_human_interaction(
        app, registry, monkeypatch):
    """THE headline pin. A connected tab may never confer immortality.

    Pre-fix, handle_keep_alive refreshed last_activity for every session of the
    user, so this session would look brand new and survive. Post-fix the handler
    touches no registry idle state, so the reaper still closes it.
    """
    from app import socket_events

    registry['idle-but-heartbeating'] = fake_session(user_id=7, idle_for=3600)

    class FakeUser:
        id = 7

    # Call the handler exactly as the socket layer would (decorator bypassed:
    # __wrapped__ is the handler body, current_user injected).
    socket_events.handle_keep_alive.__wrapped__(current_user=FakeUser())

    session = registry['idle-but-heartbeating']
    assert time.time() - session['last_interaction'] > 3000, (
        'the automatic keep-alive refreshed human-interaction state; a merely '
        'connected browser must not keep an SSH session alive')

    closed, _ = run_reaper(app, monkeypatch, timeout=60)
    assert [sid for sid, _ in closed] == ['idle-but-heartbeating'], (
        'an idle session survived because a keep-alive arrived')


def test_remote_output_does_not_count_as_human_interaction(
        app, registry, monkeypatch):
    """An emitting pane (prompt redraw, clock, MOTD) is not a person.

    last_activity is fresh (the reader thread bumps it on every byte) while
    last_interaction is old; the session must still be reapable.
    """
    registry['chatty'] = fake_session(idle_for=0, interaction_idle_for=3600)

    closed, _ = run_reaper(app, monkeypatch, timeout=60)
    assert [sid for sid, _ in closed] == ['chatty'], (
        'output-only traffic kept the session alive')


def test_genuine_input_counts_as_human_interaction(app, registry, monkeypatch):
    """The other direction: real input must protect the session.

    Asserted through the real send_ssh_input write path rather than by poking the
    dict, so the test fails if that writer stops updating interaction.
    """
    from app import ssh_manager

    registry['typed-in'] = fake_session(idle_for=3600, interaction_idle_for=3600)

    # Exercise the writer the handler uses, with the send stubbed out.
    class FakeChannel:
        def send(self, data):
            return len(data)

    registry['typed-in']['channel'] = FakeChannel()
    ok, error = ssh_manager.send_ssh_input('typed-in', 'ls\r')
    assert ok, f'send_ssh_input failed: {error}'

    assert time.time() - registry['typed-in']['last_interaction'] < 5, (
        'send_ssh_input did not refresh human-interaction state')

    closed, _ = run_reaper(app, monkeypatch, timeout=60)
    assert closed == [], 'a session with fresh user input was reaped'


def test_exit_scroll_control_action_counts_as_human_interaction(
        registry, monkeypatch):
    """Exiting copy-mode is a deliberate user act, so it refreshes interaction.

    Distinct from ssh_resize, which is an automatic geometry proposal and is
    deliberately NOT interaction. Only the tmux transport helpers are stubbed;
    the real function body (including the interaction write) runs.
    """
    from app import ssh_manager

    registry['scrolled'] = fake_session(
        user_id=3, idle_for=3600, interaction_idle_for=3600)

    # Stub ONLY the tmux control transport. _send_escape_to_session_clients is
    # the function that carries the interaction write, so it must run for real:
    # stubbing it would bypass the code under test. S30-C renamed it (and moved
    # the escape off the interactive PTY onto the control channel), but the
    # interaction write belongs to the ACTION rather than the transport, so it
    # moved with the action and this test still measures the same thing. The
    # stub answers every control command with output '1', which serves as both
    # the pane_in_mode reading and a one-line client list.
    monkeypatch.setattr(
        ssh_manager, '_exec_tmux_control',
        lambda *a, **k: (True, None, '1'))

    result = ssh_manager.exit_tmux_copy_mode('scrolled')
    assert result[0], f'exit_tmux_copy_mode failed: {result[1]}'
    assert time.time() - registry['scrolled']['last_interaction'] < 5, (
        'the exit-scroll control action did not refresh interaction')


def test_resize_is_not_interaction(registry, monkeypatch):
    """An automatic geometry proposal is not evidence of a human.

    Ruled in rev5/rev6: the client emits ssh_resize on its own for catch-up
    fits, reconnect adoption, epoch/bfcache re-arms and debounced refits, so
    counting it would recreate the keep-alive immortality through a second
    channel. A resize-only session stays protected by the persistence exemption
    instead, not by activity.
    """
    from app import ssh_manager

    class _RecordingViewChannel:
        def __init__(self):
            self.sizes = []

        def resize_pty(self, width, height):
            self.sizes.append((width, height))

    channel = _RecordingViewChannel()
    registry['resized'] = fake_session(idle_for=3600,
                                       interaction_idle_for=3600,
                                       use_tmux=True)
    registry['resized']['views'] = {
        'sid-A': {'channel': channel, 'cols': 80, 'rows': 24}}
    before = registry['resized']['last_interaction']

    #: a resize now lands on THIS socket's own tmux client, so the
    # proposal is proven to have been carried out and still not counted.
    ok, error = ssh_manager.resize_session_view('resized', 'sid-A', 100, 30)

    assert (ok, error) == (True, None)
    assert channel.sizes == [(100, 30)]
    assert registry['resized']['last_interaction'] == before, (
        'a geometry proposal refreshed human-interaction state')


# --------------------------------------------------------------------------
# (b2) Owner protection — must hold in the SAME change as (b)
# --------------------------------------------------------------------------

def test_persistent_tmux_session_is_never_reaped(app, registry, monkeypatch):
    """The Owner-protection invariant.

    Before this change the reaper had no exemption at all: persistent tmux
    sessions survived only because the keep-alive and output kept refreshing
    them. With those refreshers gone, an explicit exemption is the ONLY thing
    standing between the fix and the Owner losing their sessions. Zero
    interaction, zero output, zero heartbeat -- and it must still be there.
    """
    registry['owner-tmux'] = fake_session(
        user_id=1, use_tmux=True, idle_for=99999, interaction_idle_for=99999)
    registry['ordinary'] = fake_session(
        user_id=1, use_tmux=False, idle_for=99999, interaction_idle_for=99999)

    closed, _ = run_reaper(app, monkeypatch, timeout=60)

    assert 'owner-tmux' not in [sid for sid, _ in closed], (
        'a persistent tmux session was reaped: the Owner exemption is missing')
    assert 'owner-tmux' in registry, 'the persistent session left the registry'
    assert [sid for sid, _ in closed] == ['ordinary'], (
        'the exemption leaked to non-persistent sessions')


def test_persistent_session_is_not_warned_either(app, registry, monkeypatch):
    """No timeout warning for a session that can never time out.

    A warning for an exempt session would tell the user to "type anything to
    keep alive" about a session that needs nothing.
    """
    registry['owner-tmux'] = fake_session(
        user_id=1, use_tmux=True, idle_for=99999, interaction_idle_for=99999)

    closed, emitted = run_reaper(app, monkeypatch, timeout=60)

    assert closed == []
    warnings = [e for e in emitted if e[0] == 'session_timeout_warning']
    assert warnings == [], (
        f'an exempt persistent session was warned about idling: {warnings}')


# --------------------------------------------------------------------------
# backward compatibility of the interaction read
# --------------------------------------------------------------------------

def test_reaped_session_notifies_the_client_on_the_exact_contract(
        app, registry, monkeypatch):
    """S2 step 3: a reap must never be silent, and must use the EXISTING event.

    Pre-fix the close loop emitted NOTHING, so a reaped session left a
    live-looking pane forever. The contract is deliberately exact -- event name,
    payload, room -- because reusing `ssh_disconnected` is what keeps the shipped
    client handler working (it updates session status, refreshes the transfer
    selects and notifies the SFTP manager). Inventing a new event would need a
    client change and would leave older clients silent.
    """
    registry['reaped'] = fake_session(
        user_id=42, idle_for=3600, interaction_idle_for=3600)

    closed, emitted = run_reaper(app, monkeypatch, timeout=60)
    assert [sid for sid, _ in closed] == ['reaped']

    frames = [e for e in emitted if e[0] == 'ssh_disconnected']
    assert len(frames) == 1, (
        f'expected exactly one ssh_disconnected frame, got {emitted}')

    event, payload, kwargs, _still_registered = frames[0]
    assert payload == {'session_id': 'reaped', 'reason': 'Idle timeout'}, (
        f'payload does not match the approved contract: {payload}')
    assert kwargs.get('room') == 'user_42', (
        f'frame was not addressed to the owning user room: {kwargs}')


def test_reaped_session_is_closed_BEFORE_the_client_is_notified(
        app, registry, monkeypatch):
    """The ordering half of the contract, asserted directly.

    Close first, then notify. A client told "disconnected" while the entry is
    still registered can re-request or re-render a session that is about to
    vanish, so the order is part of the contract, not an implementation detail.
    """
    registry['ordered'] = fake_session(
        user_id=7, idle_for=3600, interaction_idle_for=3600)

    _closed, emitted = run_reaper(app, monkeypatch, timeout=60)

    frames = [e for e in emitted if e[0] == 'ssh_disconnected']
    assert len(frames) == 1
    still_registered = frames[0][3]
    assert still_registered is False, (
        'ssh_disconnected was emitted while the session was STILL in the '
        'registry: the reaper notified before closing')


def test_a_failing_notification_cannot_prevent_the_close(
        app, registry, monkeypatch):
    """Capacity must be released even if the client cannot be told.

    The emit is the last step and is contained: a raising emit must not leave the
    session in the registry, or a broken socket layer would silently stop
    reclaiming session slots -- the exact capacity starvation S2 exists to fix.
    """
    from app import ssh_manager

    registry['emit-explodes'] = fake_session(
        user_id=9, idle_for=3600, interaction_idle_for=3600)

    closed = []

    def fake_close(session_id, kill_tmux=False, expected_session=None):
        closed.append((session_id, kill_tmux))
        ssh_manager.sessions.pop(session_id, None)
        return True

    class ExplodingSocketIO:
        def emit(self, *args, **kwargs):
            raise RuntimeError('socket layer is down')

    monkeypatch.setattr(ssh_manager, 'close_session', fake_close)
    monkeypatch.setattr(ssh_manager.config, 'SESSION_TIMEOUT', 60)
    import app as app_pkg
    monkeypatch.setattr(app_pkg, 'socketio', ExplodingSocketIO(), raising=False)

    with app.app_context():
        ssh_manager.cleanup_idle_sessions()   # must not raise

    assert [sid for sid, _ in closed] == ['emit-explodes'], (
        'the close did not happen when the notification failed')
    assert 'emit-explodes' not in ssh_manager.sessions, (
        'a failed notification left the session registered, so its capacity '
        'slot was never reclaimed')


def test_no_notification_when_close_session_reports_failure(
        app, registry, monkeypatch):
    """A failed close must produce NO log-as-closed and NO client frame.

    close_session returns False in three cases, and the third is the dangerous
    one: a REUSED id, where a DIFFERENT session object is now registered under
    that id. close_session deliberately refuses to pop that replacement ("our
    lock is an orphan; do NOT pop the replacement"). If the reaper emitted
    anyway, it would tell the client that a session id had disconnected while a
    LIVE session was running under exactly that id -- the client handler would
    mark the replacement disconnected and tear down a working pane.
    """
    closed_attempts = []

    def refusing_close(session_id, kill_tmux=False, expected_session=None):
        closed_attempts.append(session_id)
        return False          # e.g. reused id, or already gone

    registry['refused'] = fake_session(
        user_id=5, idle_for=3600, interaction_idle_for=3600)

    _closed, emitted = run_reaper(
        app, monkeypatch, timeout=60, close_impl=refusing_close)

    assert closed_attempts == ['refused'], 'the reaper did not attempt the close'
    assert [e for e in emitted if e[0] == 'ssh_disconnected'] == [], (
        'ssh_disconnected was emitted although close_session returned False: a '
        'live replacement under a reused id would be reported as dead')


def test_reused_id_replacement_is_left_untouched_and_unannounced(
        app, registry, monkeypatch):
    """The reused-id case end to end, against the REAL close_session.

    A stale entry is selected for reaping, then replaced under the same id by a
    different session object before the close runs. The real close_session must
    refuse (identity mismatch), the replacement must survive, and the client must
    hear nothing about that id.
    """
    from app import ssh_manager

    stale = fake_session(user_id=6, idle_for=3600, interaction_idle_for=3600)
    registry['recycled'] = stale
    replacement = fake_session(user_id=6, idle_for=0, interaction_idle_for=0)

    real_close = ssh_manager.close_session
    swapped = {'done': False}

    def close_after_swap(session_id, kill_tmux=False, expected_session=None):
        # Simulate the race precisely: between selection and close, the id is
        # re-registered with a DIFFERENT dict object. The caller's
        # expected_session MUST be forwarded -- that is the identity the reaper
        # decided on, and without it close_session would re-capture the
        # replacement and close it (the TOCTOU this pin exists to catch).
        if not swapped['done']:
            ssh_manager.sessions[session_id] = replacement
            swapped['done'] = True
        return real_close(session_id, kill_tmux=kill_tmux,
                          expected_session=expected_session)

    _closed, emitted = run_reaper(
        app, monkeypatch, timeout=60, close_impl=close_after_swap)

    assert swapped['done'], 'the swap never happened; the test proved nothing'
    assert ssh_manager.sessions.get('recycled') is replacement, (
        'the replacement session was popped by a close that targeted the '
        'session it replaced')
    assert [e for e in emitted if e[0] == 'ssh_disconnected'] == [], (
        'the reaper announced a disconnect for an id whose live replacement is '
        'still running')


def test_close_session_with_expected_identity_refuses_a_replaced_entry(registry):
    """Direct pin on the R3-A parameter, independent of the reaper.

    A is judged closable under an id, then B is registered under the SAME id
    before the close lands. close_session(id, expected_session=A) must refuse
    (B is not A) and leave B registered; close_session(id, expected_session=B)
    must then succeed and pop B. Together they prove the caller's identity is
    what is compared, not whatever the registry holds at close time.
    """
    from app import ssh_manager

    a = fake_session(user_id=8)
    b = fake_session(user_id=8)

    # Caller decided on A, but B is already registered under the same id.
    registry['contested'] = b
    assert ssh_manager.close_session('contested', expected_session=a) is False, (
        'close_session closed B under A\'s identity: reused-id bug')
    assert registry.get('contested') is b, 'the replacement was popped'

    # B's own identity closes it normally.
    assert ssh_manager.close_session('contested', expected_session=b) is True
    assert 'contested' not in registry, 'B should have been popped by its own close'


def test_close_session_default_identity_unchanged_for_existing_callers(registry):
    """R3-A is additive: the default (no expected_session) keeps today's
    behavior for all existing call sites -- capture identity at entry, close
    whatever is registered. If this broke, every existing caller changed shape.
    """
    from app import ssh_manager

    s = fake_session(user_id=8)
    registry['default-path'] = s
    assert ssh_manager.close_session('default-path') is True
    assert 'default-path' not in registry, (
        'the default identity path no longer closes the registered session')

    # And a missing id still returns False without raising.
    assert ssh_manager.close_session('never-was') is False


def test_exempt_persistent_session_is_never_notified_as_disconnected(
        app, registry, monkeypatch):
    """The exemption and the notification must not fight each other.

    An exempt session is not closed, so it must not receive a disconnect frame
    either -- that would tear down the Owner's pane in the UI while the session
    is still alive on the server.
    """
    registry['owner-tmux'] = fake_session(
        user_id=1, use_tmux=True, idle_for=99999, interaction_idle_for=99999)

    closed, emitted = run_reaper(app, monkeypatch, timeout=60)

    assert closed == []
    assert [e for e in emitted if e[0] == 'ssh_disconnected'] == [], (
        'an exempt persistent session was reported disconnected')


def test_pre_upgrade_entry_without_interaction_field_is_not_infinitely_idle(
        app, registry, monkeypatch):
    """A missing field must never read as "idle forever".

    Sessions created before this change -- and the hand-built registry dicts in
    the older suites (test_b5_reconnect_validation, test_reconnect_swap,
    test_replay_delivery, test_session_snapshot, test_reconnect_socket_events) --
    carry only last_activity. The reaper must fall back to it rather than
    treating the absent key as an epoch-old timestamp.
    """
    registry['legacy-fresh'] = fake_session(
        idle_for=0, with_interaction_field=False)
    registry['legacy-stale'] = fake_session(
        idle_for=3600, with_interaction_field=False)

    closed, _ = run_reaper(app, monkeypatch, timeout=60)

    assert 'legacy-fresh' not in [sid for sid, _ in closed], (
        'a fresh pre-upgrade session was reaped via a missing-key fallback bug')
    assert 'legacy-stale' in [sid for sid, _ in closed], (
        'a stale pre-upgrade session was not reaped')


def test_new_sessions_carry_the_interaction_field_from_creation(app):
    """create_session bootstraps last_interaction, so the fallback is only ever
    needed for pre-upgrade entries."""
    from pathlib import Path
    source = (Path(__file__).resolve().parent.parent /
              'app' / 'ssh_manager.py').read_text(encoding='utf-8')
    create_block = source[source.index("sessions[session_id] = {"):]
    create_block = create_block[:create_block.index('}')]
    assert "'last_interaction'" in create_block, (
        'create_session does not bootstrap last_interaction')


# --------------------------------------------------------------------------
# step 1 — single-worker guard, boot identity, scoped reconciliation
# --------------------------------------------------------------------------

def test_guard_is_held_after_startup_and_stamps_a_boot_id(app):
    """create_app must have acquired the guard; a boot id must exist."""
    from app import worker_guard

    assert worker_guard.guard_is_held(), (
        'create_app returned without holding the single-worker guard')
    assert worker_guard.boot_id(), 'no boot id was generated'
    with app.app_context():
        from app.models import WorkerClaim
        from app.models import db as _db
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        assert claim is not None, 'no claim row was written'
        assert claim.boot_id == worker_guard.boot_id()
        assert claim.pid == os.getpid()


def test_heartbeat_advances_when_wired(app):
    """heartbeat() must actually move heartbeat_at forward for the holder.

    The defect this prevents is the pre-R2 one where heartbeat_at froze at boot
    for the whole worker's lifetime."""
    from datetime import datetime, timedelta, timezone
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    with app.app_context():
        assert worker_guard.acquire_guard() is True
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        before = claim.heartbeat_at
        # Backdate so the refresh is unambiguously an advance, not noise.
        claim.heartbeat_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        _db.session.commit()

        assert worker_guard.heartbeat() is True

        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        after = claim.heartbeat_at
        assert worker_guard._as_utc(after) > worker_guard._as_utc(before), (
            f'heartbeat did not advance: {before} -> {after}')


def test_shutdown_hook_is_registered_once_across_many_apps(app):
    """atexit hook installs once per worker process, however many app objects
    the process builds. Repeated install calls must not stack callbacks.

    Counted with atexit._ncallbacks() because Python 3.12 no longer exposes the
    registered handlers as a list (_run_exitfuncs is a method)."""
    import atexit
    from app import worker_guard

    count_before = atexit._ncallbacks()
    worker_guard.install_shutdown_hook(app)
    worker_guard.install_shutdown_hook(app)
    worker_guard.install_shutdown_hook(app)
    assert atexit._ncallbacks() == count_before, (
        'install_shutdown_hook stacked multiple atexit callbacks')
    assert worker_guard._shutdown_registered is True
    assert worker_guard._shutdown_callback is not None, (
        'the shutdown callback was not stored for testability')


def test_graceful_shutdown_callback_releases_the_claim(app):
    """The atexit callback must release THIS boot's claim, and be idempotent.

    Invokes the REAL hook stored in worker_guard._shutdown_callback (Python 3.12
    does not let tests enumerate atexit handlers), asserting the claim row is
    gone, that a SECOND call is a harmless no-op, and re-acquiring for later
    tests.
    """
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    with app.app_context():
        assert worker_guard.acquire_guard() is True
        assert worker_guard.guard_is_held()

    assert worker_guard._shutdown_callback is not None, (
        'create_app did not store the atexit callback')
    our_callback = worker_guard._shutdown_callback

    our_callback()   # graceful shutdown path
    with app.app_context():
        assert _db.session.get(
            WorkerClaim, worker_guard.CLAIM_ROW_ID) is None, (
            'the shutdown callback did not release the claim')
        assert worker_guard.guard_is_held() is False

        our_callback()   # idempotent second call: no row, no exception
        assert _db.session.get(
            WorkerClaim, worker_guard.CLAIM_ROW_ID) is None

        assert worker_guard.acquire_guard() is True   # re-acquire for later


def test_a_fork_of_the_holder_cannot_release_or_heartbeat(app, monkeypatch):
    """A fork inherits _GUARD_HELD but must neither release nor heartbeat.

    Preload/multi-worker scenario: the master acquires, the worker inherits the
    flag. If the worker could release or heartbeat, it would tear down or keep
    warm a claim it never acquired.
    """
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    with app.app_context():
        assert worker_guard.acquire_guard() is True
        holder_boot = worker_guard.boot_id()

        monkeypatch.setattr(worker_guard, '_GUARD_HELD', True)
        monkeypatch.setattr(worker_guard, '_GUARD_PID', os.getpid() + 1)

        assert worker_guard.release_guard() is False, (
            'a fork of the holder released the claim')
        assert worker_guard.heartbeat() is False, (
            'a fork of the holder refreshed the claim')

        monkeypatch.setattr(worker_guard, '_GUARD_PID', os.getpid())
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        assert claim is not None, 'the fork released the real holder\'s claim'
        assert claim.boot_id == holder_boot


def test_fast_crash_restart_is_not_refused_or_delayed(app, monkeypatch):
    """THE crash-loop pin. Proven bad before R2: refused for a full 300s.

    A restart gets a fresh pid namespace where the old pid number may exist
    again as a DIFFERENT process. With the old pid-only check, a fresh
    heartbeat + live-looking pid => REFUSED until CLAIM_STALE_AFTER. With
    pid_starttime, (pid, starttime) MISMATCH proves the holder is gone =>
    immediate takeover, no waiting.
    """
    from app import worker_guard

    _set_claim_to_foreign(app, boot='previous-boot', start_offset=-1)

    monkeypatch.setattr(worker_guard, '_BOOT_ID', 'restarted-boot')
    monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
    monkeypatch.setattr(worker_guard, '_GUARD_PID', None)

    from app.models import WorkerClaim, db as _db
    with app.app_context():
        started = time.monotonic()
        assert worker_guard.acquire_guard() is True, (
            'fast crash-restart was refused -- the 300-second lockout is back')
        assert time.monotonic() - started < 5, (
            'fast crash-restart was delayed')
        refreshed = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        assert refreshed.boot_id == 'restarted-boot'
        assert refreshed.pid == os.getpid()

    _restore_this_process_as_holder(app, monkeypatch)


def test_pid_starttime_match_is_never_taken_over(app, monkeypatch):
    """A matching (pid, starttime) is a genuinely live holder. Not dead at ANY
    heartbeat age, even a stalled one -- that is the multi-worker refusal the
    guard exists to enforce."""
    from app import worker_guard

    live_pid = os.getppid()
    foreign_start = worker_guard._pid_starttime(live_pid)
    _set_claim_to_foreign(app, pid=live_pid, boot='genuine-holder',
                          start_offset=0, heartbeat_fresh=False)
    # Force staleness via a very old heartbeat.
    from app.models import WorkerClaim, db as _db
    with app.app_context():
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        from datetime import datetime, timedelta, timezone
        claim.heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=24)
        _db.session.commit()
        assert worker_guard._claim_is_dead(claim) is False, (
            'a live holder with a matching pid_starttime was judged dead')

    _restore_this_process_as_holder(app, monkeypatch)


def test_pid_starttime_mismatch_permits_takeover(app, monkeypatch):
    """Same pid number, different kernel start time => provably a different
    process. Takeover must be immediate and loud, even with a fresh heartbeat
    and no stale window."""
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    # Fresh heartbeat in the helper, but this test wants the pid-starttime to be
    # the ONLY signal, so it must NOT rely on staleness either.
    _set_claim_to_foreign(app, boot='other-boot', start_offset=1)

    monkeypatch.setattr(worker_guard, '_BOOT_ID', 'our-boot')
    monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
    monkeypatch.setattr(worker_guard, '_GUARD_PID', None)

    with app.app_context():
        assert worker_guard.acquire_guard() is True
        assert _db.session.get(
            WorkerClaim, worker_guard.CLAIM_ROW_ID).boot_id == 'our-boot'

    _restore_this_process_as_holder(app, monkeypatch)


def test_preload_flag_is_rejected_loudly(monkeypatch):
    """gunicorn --preload must be refused at startup, not inherited."""
    from app import worker_guard

    monkeypatch.setattr(worker_guard, '_read_self_cmdline',
                        lambda: ['gunicorn', '--preload', '-w', '1',
                                 '--bind', '0.0.0.0:5000', 'start:app'])
    with pytest.raises(worker_guard.WorkerGuardError) as excinfo:
        worker_guard._reject_unsupported_worker_model()
    assert '--preload' in str(excinfo.value)


def test_multi_worker_count_is_rejected_loudly(monkeypatch):
    """-w 2 (or --workers=2) must be refused at startup."""
    from app import worker_guard

    monkeypatch.setattr(worker_guard, '_read_self_cmdline',
                        lambda: ['gunicorn', '--worker-class', 'eventlet',
                                 '-w', '2', '--bind', '0.0.0.0:5000', 'start:app'])
    with pytest.raises(worker_guard.WorkerGuardError) as excinfo:
        worker_guard._reject_unsupported_worker_model()
    assert 'workers' in str(excinfo.value).lower()


def test_single_worker_cmdline_is_accepted(monkeypatch):
    """The actual production CMD (-w 1, no preload) must pass the check."""
    from app import worker_guard

    monkeypatch.setattr(worker_guard, '_read_self_cmdline',
                        lambda: ['gunicorn', '--worker-class', 'eventlet',
                                 '-w', '1', '--bind', '0.0.0.0:5000', 'start:app'])
    worker_guard._reject_unsupported_worker_model()   # must not raise


def test_a_fork_of_the_holder_is_refused_on_reacquire(app, monkeypatch):
    """End-to-end fork refusal: a process that inherited the held flag but whose
    pid differs from the acquiring pid must raise on any acquire attempt."""
    from app import worker_guard

    monkeypatch.setattr(worker_guard, '_GUARD_HELD', True)
    monkeypatch.setattr(worker_guard, '_GUARD_PID', os.getpid() + 1)
    monkeypatch.setattr(worker_guard, '_BOOT_ID', 'forked-child-boot')

    with pytest.raises(worker_guard.WorkerGuardError) as excinfo:
        worker_guard.acquire_guard()
    assert 'inherited' in str(excinfo.value)


def test_a_different_live_process_is_refused_loudly(app, monkeypatch):
    """A second worker must fail loudly and must not serve.

    The stored holder must be a genuinely live, correctly-identified process or
    the test proves nothing: pid alone is namespace-local and reusable, so a
    live-looking number with a wrong pid_starttime would take the TAKEOVER path
    instead of the refusal path. Use this process's parent (alive, different pid)
    together with its REAL kernel start time, and a fresh heartbeat, so refusal
    is the only legal outcome.
    """
    from datetime import datetime, timezone
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    foreign_pid = os.getppid()
    with app.app_context():
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        claim.boot_id = 'foreign-boot-id'
        claim.pid = foreign_pid
        claim.pid_starttime = worker_guard._pid_starttime(foreign_pid)
        claim.heartbeat_at = datetime.now(timezone.utc)
        _db.session.commit()

        monkeypatch.setattr(worker_guard, '_BOOT_ID', 'our-new-boot-id')
        monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
        monkeypatch.setattr(worker_guard, '_GUARD_PID', None)

        with pytest.raises(worker_guard.WorkerGuardError) as excinfo:
            worker_guard.acquire_guard()
        assert 'still alive' in str(excinfo.value)
        assert not worker_guard.guard_is_held()

        _restore_this_process_as_holder(app, monkeypatch)


def test_reconciliation_never_deletes_rows_without_the_guard(app, monkeypatch):
    """Guard absent => NOTHING is deleted. Never a blanket clear.

    This is the invariant that protects a live worker's rows from a booting one.
    """
    from app import worker_guard
    from app.models import SocketSession, db as _db
    from app.auth import register_user

    with app.app_context():
        user, error = register_user(f'guard{uuid.uuid4().hex[:8]}', 'pw-123456789')
        assert error is None
        _db.session.add(SocketSession(
            user_id=user.id, socket_sid=f'sid-{uuid.uuid4().hex[:8]}',
            worker_boot_id='some-other-boot'))
        _db.session.commit()
        before = SocketSession.query.count()
        assert before >= 1

        monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
        result = worker_guard.reconcile_socket_sessions()

        assert result == -1, 'reconciliation did not report a skipped guard'
        assert SocketSession.query.count() == before, (
            'rows were deleted while the single-worker guard was not held')


def test_reconciliation_removes_only_stale_and_null_boot_ids(app):
    """Scoped cleanup: current-boot rows survive, stale and NULL rows go."""
    from app import worker_guard
    from app.models import SocketSession, db as _db
    from app.auth import register_user

    with app.app_context():
        user, error = register_user(f'recon{uuid.uuid4().hex[:8]}', 'pw-123456789')
        assert error is None
        SocketSession.query.delete()
        _db.session.commit()

        # Independent of test order: assert the precondition rather than assuming
        # a previous test left the guard held.
        assert worker_guard.guard_is_held(), 'guard not held; precondition failed'
        mine = worker_guard.boot_id()
        _db.session.add_all([
            SocketSession(user_id=user.id, socket_sid='sid-current',
                          worker_boot_id=mine),
            SocketSession(user_id=user.id, socket_sid='sid-previous-boot',
                          worker_boot_id='a-previous-boot'),
            SocketSession(user_id=user.id, socket_sid='sid-pre-upgrade',
                          worker_boot_id=None),
        ])
        _db.session.commit()

        deleted = worker_guard.reconcile_socket_sessions()
        assert deleted == 2, f'expected 2 stale/NULL rows removed, got {deleted}'

        remaining = {row.socket_sid for row in SocketSession.query.all()}
        assert remaining == {'sid-current'}, (
            f'wrong rows survived reconciliation: {remaining}')


def test_register_socket_session_stamps_the_current_boot_id(app):
    """Rows this worker creates must be recognizable as live on its next boot."""
    from app import worker_guard
    from app.auth import register_socket_session, register_user
    from app.models import SocketSession

    with app.app_context():
        user, error = register_user(f'stamp{uuid.uuid4().hex[:8]}', 'pw-123456789')
        assert error is None
        sid = f'sid-{uuid.uuid4().hex[:8]}'
        register_socket_session(user.id, sid, user_agent='pytest')

        row = SocketSession.query.filter_by(socket_sid=sid).first()
        assert row is not None
        assert row.worker_boot_id == worker_guard.boot_id(), (
            'register_socket_session did not stamp the worker boot id')


def test_dead_claim_can_be_taken_over_so_a_crash_cannot_lock_startup(
        app, monkeypatch):
    """Liveness recovery: a stale heartbeat AND a dead pid may be taken over.

    Without this an unclean exit would lock the app out of its own startup.
    """
    from datetime import datetime, timedelta, timezone
    from app import worker_guard
    from app.models import WorkerClaim, db as _db

    with app.app_context():
        claim = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        claim.boot_id = 'crashed-boot'
        claim.pid = 999999                      # not a live pid
        claim.heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=2)
        _db.session.commit()

        monkeypatch.setattr(worker_guard, '_BOOT_ID', 'recovering-boot')
        monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)

        assert worker_guard.acquire_guard() is True
        refreshed = _db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
        assert refreshed.boot_id == 'recovering-boot'
        assert refreshed.pid == os.getpid()

        monkeypatch.undo()
        worker_guard.acquire_guard()


def test_a_live_claim_with_a_stale_heartbeat_is_not_stolen(app):
    """A matching (pid, starttime) is never dead, even with a stalled heartbeat.

    Under the R2 rule a live holder is identified by pid_starttime match, not by
    heartbeat freshness. A holder whose refresher merely stalled must never be
    evicted -- that is the multi-worker refusal the guard exists to enforce.
    """
    from datetime import datetime, timedelta, timezone
    from app import worker_guard
    from app.models import WorkerClaim

    stalled = WorkerClaim(
        boot_id='stalled-but-alive',
        pid=os.getpid(),
        pid_starttime=worker_guard._pid_starttime(os.getpid()),
        heartbeat_at=datetime.now(timezone.utc) - timedelta(hours=2))
    with app.app_context():
        assert worker_guard._claim_is_dead(stalled) is False, (
            'a live process with a matching pid_starttime was judged dead '
            'on heartbeat age alone')


# --------------------------------------------------------------------------
# contract pins: the keep_alive route stays, the idle write does not
# --------------------------------------------------------------------------

def test_keep_alive_route_still_exists_and_is_payload_safe(app):
    """The shipped client emits keep_alive every 60s; the route must stay.

    Removing the route would log a stream of unknown-event noise and break the
    S1 payload contract's coverage. Keeping the route while removing its idle
    write is the whole point of the fix.
    """
    from pathlib import Path
    import inspect
    from app import socket_events

    source = (Path(__file__).resolve().parent.parent /
              'app' / 'socket_events.py').read_text(encoding='utf-8')
    assert "@socketio.on('keep_alive')" in source, 'the keep_alive route vanished'

    params = list(inspect.signature(
        socket_events.handle_keep_alive.__wrapped__).parameters)
    assert params[0] == 'data' and 'current_user' in params, (
        f'keep_alive broke the S1 handler contract: {params}')


def test_keep_alive_handler_no_longer_writes_registry_idle_state(app):
    """Static pin on the removed write.

    The functional pin above proves the behavior; this one names the mechanism so
    a future edit cannot quietly reintroduce the loop that made idle expiry
    unreachable.
    """
    from pathlib import Path
    source = (Path(__file__).resolve().parent.parent /
              'app' / 'socket_events.py').read_text(encoding='utf-8')
    start = source.index("@socketio.on('keep_alive')")
    end = source.index('@socketio.on(', start + 10)
    block = source[start:end]
    # Scan CODE only. The docstring deliberately explains the removed
    # last_activity write, so a raw substring check would match its prose and
    # fail for the wrong reason.
    doc_open = block.index('"""')
    doc_close = block.index('"""', doc_open + 3) + 3
    body = block[:doc_open] + block[doc_close:]
    assert 'last_activity' not in body, (
        'keep_alive writes last_activity again: a connected tab would once more '
        'make every one of that user/s SSH sessions immortal')
    assert 'last_interaction' not in body, (
        'keep_alive writes last_interaction: an automatic heartbeat must never '
        'count as human interaction')


# --------------------------------------------------------------------------
# S2 step 5 — last-socket proof is live room membership, not the DB row count
# --------------------------------------------------------------------------

def test_other_live_sids_helper_excludes_and_fails_open(app, monkeypatch):
    """Unit pin on _other_live_sids_for_user.

    * excludes the disconnecting sid (required because the handler runs
      BEFORE manager.disconnect removes it from the room);
    * returns the empty set when the manager is missing (fail-open toward
      cleanup, never toward suppression).
    """
    from app import socket_events

    class FakeManager:
        def __init__(self, by_room):
            self._by_room = by_room
        def get_participants(self, namespace, room):
            for sid in self._by_room.get(room, ()):
                yield (sid, f'eio-{sid}')

    class FakeServer:
        def __init__(self, manager):
            self.manager = manager

    import app as app_pkg
    monkeypatch.setattr(
        app_pkg.socketio, 'server',
        FakeServer(FakeManager({'user_7': ('sid-A', 'sid-B', 'sid-C')})),
        raising=False)

    assert socket_events._other_live_sids_for_user(7, excluding_sid='sid-B') == {
        'sid-A', 'sid-C'}
    assert socket_events._other_live_sids_for_user(7) == {
        'sid-A', 'sid-B', 'sid-C'}
    assert socket_events._other_live_sids_for_user(7, excluding_sid='sid-Z') == {
        'sid-A', 'sid-B', 'sid-C'}

    monkeypatch.setattr(app_pkg.socketio, 'server', None, raising=False)
    assert socket_events._other_live_sids_for_user(7, excluding_sid='sid-A') == set()


def test_stale_db_row_does_not_suppress_last_socket_cleanup(app, monkeypatch):
    """THE step-5 pin: a phantom SocketSession row must never suppress the
    Quick-Connect pool cleanup or the user-wide transfer sweep.

    One REAL socket is connected; a second DB row is planted under the same
    user with a sid that exists in no room. On the real socket's disconnect,
    the last-socket proof must come from live room membership (empty after
    excluding the disconnecting sid), so both cleanups fire. Pre-fix this
    failed: other_sessions == 1 from the stale row suppressed everything.
    """
    from types import SimpleNamespace
    from app import socket_events, socketio
    from app.auth import register_user
    from app.models import SocketSession, db

    with app.app_context():
        user, error = register_user(f's5stale_{uuid.uuid4().hex[:8]}',
                                    'pw-123456789')
        assert error is None
        username = user.username
        user_id = user.id

    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username, 'password': 'pw-123456789'})
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()

    # Plant the phantom row: same user, sid that is in NO room.
    with app.app_context():
        db.session.add(SocketSession(
            user_id=user_id, socket_sid='phantom-stale-sid'))
        db.session.commit()
        assert SocketSession.query.filter_by(user_id=user_id).count() == 2

    pool_calls = []
    sweep_calls = []
    monkeypatch.setattr(
        socket_events.connection_pool.temp_connection_pool,
        'close_all_user_connections',
        lambda uid: pool_calls.append(uid) or 0)
    monkeypatch.setattr(
        socket_events.transfer_registry, 'cancel_all_for_user',
        lambda uid: sweep_calls.append(uid) or 0)

    socket_client.disconnect()

    assert pool_calls == [str(user_id)], (
        'the Quick-Connect pool cleanup was suppressed by a stale DB row')
    assert sweep_calls == [user_id], (
        'the user-wide transfer sweep was suppressed by a stale DB row')


def test_two_live_sockets_suppress_then_fire_last_socket_cleanup(app, monkeypatch):
    """Two live sockets for one user: the FIRST disconnect must NOT fire the
    last-socket path (the other is still in the room); the SECOND must fire
    both the Quick-Connect pool cleanup and the user-wide transfer sweep.

    This is the positive half of the gate: live membership, not the DB count,
    decides lastness. Pre-fix this would also pass on a clean two-socket
    journey (no stale rows), so it is a regression pin for the new room-based
    proof rather than a red-today inverted pin.
    """
    from app import socket_events, socketio
    from app.auth import register_user

    with app.app_context():
        user, error = register_user(f's5two_{uuid.uuid4().hex[:8]}',
                                    'pw-123456789')
        assert error is None
        username = user.username
        user_id = user.id

    def _open():
        http = app.test_client()
        assert http.post('/login', data={
            'username': username, 'password': 'pw-123456789'}).status_code == 302
        sc = socketio.test_client(app, flask_test_client=http)
        assert sc.is_connected()
        sc.get_received()
        return sc

    first = _open()
    second = _open()

    pool_calls = []
    sweep_calls = []
    monkeypatch.setattr(
        socket_events.connection_pool.temp_connection_pool,
        'close_all_user_connections',
        lambda uid: pool_calls.append(uid) or 0)
    monkeypatch.setattr(
        socket_events.transfer_registry, 'cancel_all_for_user',
        lambda uid: sweep_calls.append(uid) or 0)

    first.disconnect()
    assert pool_calls == [], (
        'last-socket cleanup fired while a second live socket remains')
    assert sweep_calls == [], (
        'user-wide transfer sweep fired while a second live socket remains')

    second.disconnect()
    assert pool_calls == [str(user_id)], (
        'last-socket pool cleanup did not fire on the final disconnect')
    assert sweep_calls == [user_id], (
        'user-wide transfer sweep did not fire on the final disconnect')
