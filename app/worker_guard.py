"""Single-worker guard and worker/boot identity (S2 rev6, plan Phase 1.2 step 1).

WHY THIS EXISTS. ssh_manager keeps its SSH session registry in a process-local
module global (`sessions = {}`), and the capacity cap counts `len(sessions)` in
that same process. The deployment happens to run `gunicorn -w 1`, but that is
only a Dockerfile CMD default -- nothing detects or refuses a second worker. Two
workers would each hold a disjoint registry, so the cap, the idle reaper and
revoke would silently operate on a fraction of reality, and a booting worker
that cleared socket rows would delete a live worker's rows, logging users out of
their own sessions.

So the dependence is made explicit and self-enforcing here:

  * exactly one claim row (WorkerClaim id=1) may be held;
  * the holder gets ONE boot UUID for its process lifetime, stamped onto every
    SocketSession row it creates;
  * ONLY the holder may reconcile socket rows, and it removes only rows whose
    worker_boot_id is stale or NULL -- never a blanket clear;
  * a process that cannot acquire the claim, or cannot even evaluate it, FAILS
    LOUDLY and serves nothing.

Liveness is evidence-carrying (pid + boot id + a heartbeat the holder refreshes)
so an unclean exit cannot lock the app out of its own startup: a claim whose
holder is provably dead may be taken over, and every takeover is logged loudly,
because silently stealing a claim would reintroduce exactly the row-deletion
hazard this guard prevents.

Multi-worker support is explicitly OUT OF SCOPE. It requires a shared
out-of-process session registry, not a larger lock.
"""
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone

from .audit_logger import log_error, log_info, log_warning
from .models import SSHSession, SocketSession, WorkerClaim, db

# A claim whose heartbeat is older than this AND whose pid is gone is treated as
# dead and may be taken over. Both conditions are required: a live holder that
# is merely busy must never be evicted, and in a container pids are recycled, so
# pid-liveness alone is not proof either.
CLAIM_STALE_AFTER = timedelta(minutes=5)

CLAIM_ROW_ID = 1

# How often the holder refreshes its claim. Must be comfortably shorter than
# CLAIM_STALE_AFTER so a healthy holder never looks stale.
HEARTBEAT_INTERVAL_SECONDS = 30

# One boot id per accepted worker PROCESS, for its whole lifetime. Module-level
# so every part of the process stamps the same identity; regenerated only by a
# genuinely new process (or an explicit reset in tests).
_BOOT_ID = None
_GUARD_HELD = False
# The pid that actually acquired the claim. Compared against os.getpid to
# detect a FORK of the holder (see _fork_of_holder), which is how a preloaded or
# multi-worker gunicorn is caught even when the flags are invisible to us.
_GUARD_PID = None


class WorkerGuardError(RuntimeError):
    """Raised when the single-worker guard cannot be held.

    Fatal by design: the caller (create_app) must not continue, because serving
    without the guard is exactly the multi-worker state this module refuses.
    """


def boot_id():
    """This process's boot id, generated once on first use."""
    global _BOOT_ID
    if _BOOT_ID is None:
        _BOOT_ID = str(uuid.uuid4())
    return _BOOT_ID


def guard_is_held():
    """True only if THIS process acquired the claim in this run."""
    return _GUARD_HELD


def _now():
    return datetime.now(timezone.utc)


def _as_utc(value):
    """SQLite hands back naive datetimes; compare in UTC or not at all."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _pid_is_alive(pid):
    """Best-effort liveness for a pid in THIS pid namespace.

    signal 0 checks existence without touching the process. NOT sufficient on
    its own: a pid is namespace-local and low in a container (master=1,
    worker=14), so after a restart the SAME number very often exists again as a
    DIFFERENT process. Always pair with _pid_starttime.
    """
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but is not ours to signal -- treat as alive, never take over.
        return True
    except Exception:
        return True
    return True


def _pid_starttime(pid):
    """Kernel start time of ``pid`` (clock ticks since boot), or None.

    THE process-incarnation discriminator, and the reason a fast restart no
    longer has to wait out CLAIM_STALE_AFTER. A pid alone cannot distinguish
    "the holder is still running" from "this pid number was reused by an
    unrelated process after a restart" -- but (pid, starttime) can, because
    starttime is fixed for the life of a process and monotonic across a boot.

    Field 22 of /proc/<pid>/stat, parsed from AFTER the comm field: comm is
    parenthesised and may itself contain spaces, so a naive split() is wrong.
    Returns None when /proc is unavailable (non-Linux, restricted sandbox), and
    callers then fall back to heartbeat staleness alone.
    """
    if not pid or pid <= 0:
        return None
    try:
        with open(f'/proc/{pid}/stat', 'r') as handle:
            raw = handle.read()
        after_comm = raw[raw.rindex(')') + 2:]
        return int(after_comm.split()[19])
    except Exception:
        return None


def _claim_is_dead(claim):
    """Decide whether a claim may be taken over, on the best evidence available.

    Order matters, strongest evidence first:

    1. (pid, starttime) MISMATCH => the recorded process is provably gone and a
       different process now wears its pid. Dead IMMEDIATELY, no waiting. This is
       what fixes the crash-restart lockout: previously a fast restart hit a
       fresh heartbeat plus a live-looking pid and was refused for the whole
       CLAIM_STALE_AFTER window (measured: a 5-minute outage from a 1-second
       crash), because pid alone cannot tell a restarted container's new worker
       from the old one.
    2. (pid, starttime) MATCH => genuinely the same live process. NOT dead, at
       any heartbeat age. A holder whose refresher merely stalled must never be
       evicted; that is the multi-worker case the guard exists to refuse.
    3. pid gone entirely => dead immediately.
    4. starttime unavailable (no /proc) => fall back to heartbeat staleness, the
       old behaviour, since nothing better can be proven.
    """
    recorded_start = getattr(claim, 'pid_starttime', None)
    if recorded_start is not None:
        if not _pid_is_alive(claim.pid):
            return True
        current_start = _pid_starttime(claim.pid)
        if current_start is None:
            # Cannot compare; fall through to the heartbeat rule below.
            pass
        elif current_start != recorded_start:
            return True     # pid reused by a different incarnation
        else:
            return False    # same process, still alive
    elif not _pid_is_alive(claim.pid):
        return True

    heartbeat = _as_utc(claim.heartbeat_at) or _as_utc(claim.claimed_at)
    return heartbeat is None or (_now() - heartbeat) > CLAIM_STALE_AFTER


def _fork_of_holder():
    """True when this process INHERITED a held guard through fork().

    The last line of defence against preload/multi-worker. With
    ``gunicorn --preload`` the app is imported in the MASTER, so the master
    acquires the claim and every forked worker inherits _GUARD_HELD=True and the
    same _BOOT_ID in its copied memory -- each worker would then believe it holds
    a guard it never acquired, while running its own disjoint session registry.
    Comparing the acquiring pid with the current pid catches that regardless of
    how the flags were supplied (argv, a gunicorn config file, or
    GUNICORN_CMD_ARGS).
    """
    return _GUARD_HELD and _GUARD_PID is not None and _GUARD_PID != os.getpid()


def _read_self_cmdline():
    """Return this process's argv as a list of strings, or None if unreadable.

    Extracted so tests can monkeypatch THIS helper rather than builtins.open.
    A gunicorn worker is a fork of the master and therefore carries the master's
    argv, so the flags are visible from inside the worker. Returns None when
    /proc is unavailable; callers then fall back to the fork-of-holder check.
    """
    try:
        with open('/proc/self/cmdline', 'rb') as handle:
            return [part.decode('utf-8', 'replace')
                    for part in handle.read().split(b'\x00') if part]
    except Exception:
        return None


def _reject_unsupported_worker_model():
    """Refuse a preloaded or multi-worker gunicorn, loudly, before serving.

    Only argv can be inspected this way; a config-file or env-var setting is
    caught instead by _fork_of_holder above, so the two checks together cover
    both shapes.
    """
    argv = _read_self_cmdline()
    if not argv:
        return          # cannot inspect; the fork check still applies
    if not any('gunicorn' in part for part in argv):
        return          # not gunicorn (dev server, pytest): nothing to enforce

    if '--preload' in argv or '--preload-app' in argv:
        log_error("Refusing to start: gunicorn --preload is not supported",
                  argv=' '.join(argv), pid=os.getpid())
        raise WorkerGuardError(
            'gunicorn --preload is not supported by this build. Preloading '
            'imports the app in the MASTER, so the master would take the '
            'single-worker claim and every forked worker would inherit it while '
            'running its own disjoint, process-local SSH session registry. '
            'Remove --preload.')

    for index, part in enumerate(argv):
        count = None
        if part in ('-w', '--workers') and index + 1 < len(argv):
            count = argv[index + 1]
        elif part.startswith('--workers='):
            count = part.split('=', 1)[1]
        if count is None:
            continue
        try:
            parsed = int(count)
        except ValueError:
            continue
        if parsed > 1:
            log_error("Refusing to start: more than one worker is configured",
                      workers=parsed, argv=' '.join(argv), pid=os.getpid())
            raise WorkerGuardError(
                f'This build is configured for {parsed} workers, but it keeps '
                'SSH session state in a process-local registry: each worker '
                'would see only a fraction of the sessions, so the capacity '
                'cap, the idle reaper and account revocation would all operate '
                'on partial state. Run with -w 1. Multi-worker support requires '
                'a shared session registry and is out of scope.')


def acquire_guard():
    """Claim single-worker ownership, or raise WorkerGuardError.

    Re-entrant for the SAME process: create_app() runs more than once per
    process (tests, and any embedding that builds a second app), and a process
    that already owns the claim must not lock itself out. A DIFFERENT live
    process is always refused.

    Never returns False: either this process holds the claim on return, or the
    exception stops startup. A guard that cannot be EVALUATED (database error)
    is also fatal -- proceeding would mean serving with the registry
    assumptions unverified, which is the state this guard exists to forbid.
    """
    global _GUARD_HELD, _GUARD_PID
    mine = boot_id()

    # Refuse an unsupported worker model BEFORE any claim work, so the operator
    # sees the real reason rather than a confusing "another worker holds it".
    _reject_unsupported_worker_model()
    if _fork_of_holder():
        log_error("Refusing to start: this process inherited a held guard "
                  "through fork (preload or multi-worker)",
                  holder_pid=_GUARD_PID, pid=os.getpid(), boot_id=mine)
        raise WorkerGuardError(
            f'This process (pid={os.getpid()}) inherited a held single-worker '
            f'guard from pid={_GUARD_PID} through fork, which means the app was '
            'preloaded or more than one worker is running. Each fork has its own '
            'process-local SSH session registry, so only one may serve. Run a '
            'single non-preloaded worker.')

    try:
        claim = db.session.get(WorkerClaim, CLAIM_ROW_ID)
        my_start = _pid_starttime(os.getpid())

        if claim is None:
            db.session.add(WorkerClaim(
                id=CLAIM_ROW_ID, boot_id=mine, pid=os.getpid(),
                pid_starttime=my_start,
                hostname=socket.gethostname(),
                claimed_at=_now(), heartbeat_at=_now(),
            ))
            db.session.commit()
            _GUARD_HELD = True
            _GUARD_PID = os.getpid()
            log_info("Single-worker guard acquired",
                     boot_id=mine, pid=os.getpid())
            return True

        if claim.boot_id == mine and claim.pid == os.getpid():
            # Same process, same boot: refresh and continue (re-entrant path).
            claim.heartbeat_at = _now()
            claim.pid_starttime = my_start
            db.session.commit()
            _GUARD_HELD = True
            _GUARD_PID = os.getpid()
            return True

        if claim.pid == os.getpid() and (
                claim.pid_starttime is None
                or claim.pid_starttime == my_start):
            # Same process (proven by starttime, not just the pid number),
            # different boot id: a second app object inside one process, which is
            # what tests and embeddings do. Adopt rather than refuse -- the
            # registry is still process-local and still single.
            #
            # The starttime check matters: without it, a RESTARTED container whose
            # new worker happens to get the same low pid would take this path by
            # luck rather than by proof.
            claim.boot_id = mine
            claim.pid_starttime = my_start
            claim.heartbeat_at = _now()
            db.session.commit()
            _GUARD_HELD = True
            _GUARD_PID = os.getpid()
            return True

        if _claim_is_dead(claim):
            # Takeover is LOUD on purpose: a silent steal would reintroduce the
            # row-deletion hazard the guard prevents.
            log_warning(
                "Taking over a dead single-worker claim",
                previous_pid=claim.pid, previous_boot_id=claim.boot_id,
                previous_pid_starttime=claim.pid_starttime,
                previous_heartbeat=str(claim.heartbeat_at),
                pid=os.getpid(), boot_id=mine)
            claim.boot_id = mine
            claim.pid = os.getpid()
            claim.pid_starttime = my_start
            claim.hostname = socket.gethostname()
            claim.claimed_at = _now()
            claim.heartbeat_at = _now()
            db.session.commit()
            _GUARD_HELD = True
            _GUARD_PID = os.getpid()
            return True

        _GUARD_HELD = False
        log_error(
            "Refusing to start: another worker holds the single-worker guard",
            holder_pid=claim.pid, holder_boot_id=claim.boot_id,
            holder_hostname=claim.hostname,
            holder_heartbeat=str(claim.heartbeat_at), pid=os.getpid())
        raise WorkerGuardError(
            'Another worker process holds the single-worker guard '
            f'(pid={claim.pid}, boot_id={claim.boot_id}), and that process is '
            'still alive (verified by pid start time, not the pid number alone). '
            'This build keeps SSH session state in a process-local registry, so '
            'it must run exactly one worker (gunicorn -w 1). Multi-worker '
            'operation requires a shared session registry and is not supported.')
    except WorkerGuardError:
        raise
    except Exception as exc:
        db.session.rollback()
        _GUARD_HELD = False
        log_error("Single-worker guard could not be evaluated",
                  error=str(exc), pid=os.getpid())
        raise WorkerGuardError(
            f'The single-worker guard could not be evaluated ({exc}). Refusing '
            'to serve: without it, socket-row cleanup and the session cap '
            'cannot be trusted.') from exc


def heartbeat():
    """Refresh this process's claim. Best-effort: never raises to the caller.

    Wired to a background thread (see app/__init__.py) every
    HEARTBEAT_INTERVAL_SECONDS. Before this was wired, heartbeat_at stayed frozen
    at boot, so "staleness" measured nothing and the claim looked stale after five
    minutes of perfectly healthy operation.

    A fork of the holder must never refresh: that would let a preloaded worker
    keep a claim alive on the real holder's behalf.
    """
    if not _GUARD_HELD or _fork_of_holder():
        return False
    try:
        claim = db.session.get(WorkerClaim, CLAIM_ROW_ID)
        if claim is None or claim.boot_id != boot_id():
            return False
        claim.heartbeat_at = _now()
        db.session.commit()
        return True
    except Exception as exc:
        db.session.rollback()
        log_warning("Failed to refresh single-worker claim", error=str(exc))
        return False


def release_guard():
    """Release on clean shutdown so the next boot needs no takeover.

    Only ever releases THIS process's claim; another holder's row is left alone.
    Fork-aware: a fork that merely INHERITED the held flag (preload/multi-worker)
    must not release a claim it never acquired. Idempotent: a second call after
    a real release (or before any acquire) is a harmless no-op, so the shutdown
    hook and any future atexit layering cannot double-release.

    Never raises and never logs on failure: at atexit the temp DATA_DIR (tests)
    or the process filesystem may already be gone, and a noisy failure would
    mask the real exit. A missed release is recovered by pid_starttime takeover
    on the next boot, never by a 300-second lockout.
    """
    global _GUARD_HELD, _GUARD_PID
    if not _GUARD_HELD or _fork_of_holder():
        return False
    released = False
    try:
        claim = db.session.get(WorkerClaim, CLAIM_ROW_ID)
        if claim is not None and claim.boot_id == boot_id():
            db.session.delete(claim)
            db.session.commit()
            released = True
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
    finally:
        # Always clear the in-process flag, even if the DB row could not be
        # deleted: this process is shutting down either way, and a stale flag
        # would let a subsequent create_app in the same process (tests) think
        # it still holds a claim it no longer owns.
        _GUARD_HELD = False
        _GUARD_PID = None
    if released:
        try:
            log_info("Single-worker guard released", boot_id=boot_id())
        except Exception:
            pass
    return released


_shutdown_registered = False
# The atexit callback itself, stored so tests can invoke the REAL hook without
# depending on atexit internals (Python 3.12 no longer exposes the handler list).
_shutdown_callback = None


def install_shutdown_hook(app):
    """Release the claim at PROCESS EXIT. Registered once per worker process.

    Uses atexit deliberately: it is the only in-repo hook that runs on both
    clean exit and signal-driven interpreter shutdown without fighting
    gunicorn's own signal handling. NOT a request-lifecycle callback -- an
    after_request/teardown hook would release the guard after the first HTTP
    response, which is unsafe. If atexit ever proves unreliable under eventlet,
    the safe fallback is the existing heartbeat + stale takeover: pid_starttime
    already proves a restarted container is a new process, so a missed release
    costs one takeover, never a startup lockout.

    Never raises: a shutdown-time DB failure must not mask the real exit.
    """
    global _shutdown_registered, _shutdown_callback

    import atexit

    def _atexit_release():
        try:
            with app.app_context():
                release_guard()
        except Exception:
            pass

    if not _shutdown_registered:
        atexit.register(_atexit_release)
        _shutdown_registered = True
    _shutdown_callback = _atexit_release


def reconcile_ssh_sessions():
    """Mark every `connected` SSH row disconnected: the registry is empty at boot.

    Guard REQUIRED, like reconcile_socket_sessions. Under `-w 1` the in-RAM
    registry IS the set of live sessions, and a fresh process has none, so a
    row still saying connected=True describes the previous boot. Until this
    ran, such a row was only corrected lazily when its user's socket next
    connected, so `/admin/api/capacity` (registry) and the table disagreed
    right after every deploy. Persistent rows become saved sessions (offered
    for reattach); plain rows just stop claiming to be connected.
    Returns the number of rows changed, or -1 when nothing was touched.
    """
    if not _GUARD_HELD:
        log_warning(
            "Skipping SSH-session reconciliation: single-worker guard not "
            "held (no rows were changed)", pid=os.getpid())
        return -1
    try:
        changed = SSHSession.query.filter_by(connected=True).update(
            {'connected': False}, synchronize_session=False)
        db.session.commit()
        if changed:
            log_info("Marked the previous boot's sessions disconnected at startup",
                     changed=changed)
        return changed
    except Exception as exc:
        db.session.rollback()
        log_error("SSH-session reconciliation failed", error=str(exc))
        return -1


def reconcile_socket_sessions():
    """Remove socket rows that cannot belong to this boot. Guard REQUIRED.

    Scoped, never a blanket clear: only rows whose worker_boot_id differs from
    this process's boot id, or is NULL (pre-upgrade rows, which by definition
    predate this boot), are deleted. Rows stamped with the CURRENT boot id are
    live and are never touched.

    Returns the number of rows removed, or -1 when the guard is not held -- in
    which case NOTHING is deleted. Refusing to clean is always safe; clearing
    without the guard is what destroys another worker's live rows.
    """
    if not _GUARD_HELD:
        log_warning(
            "Skipping socket-session reconciliation: single-worker guard not "
            "held (no rows were deleted)", pid=os.getpid())
        return -1
    mine = boot_id()
    try:
        deleted = SocketSession.query.filter(
            db.or_(SocketSession.worker_boot_id.is_(None),
                   SocketSession.worker_boot_id != mine)
        ).delete(synchronize_session=False)
        db.session.commit()
        if deleted:
            log_info("Reconciled stale socket sessions at startup",
                     deleted=deleted, boot_id=mine)
        return deleted
    except Exception as exc:
        db.session.rollback()
        log_error("Socket-session reconciliation failed", error=str(exc))
        return 0
