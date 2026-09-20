"""Central cleanup helpers for revoking a user's live access."""

import os
from uuid import uuid4

import config

from .audit_logger import log_error, log_info, log_warning
from .models import db, SocketSession, SSHSession, WorkerClaim
from . import connection_pool, ssh_manager


def revoke_user_access(user_id, socketio_instance=None):
    """Disconnect and remove all live resources owned by ``user_id``.

    Cleanup is deliberately best-effort across resource types: one broken SSH
    connection must not prevent the user's sockets, pooled connections, or
    database session metadata from being revoked.

    LOCALITY GATE (S2 step 4). The SSH registry is process-local, so only the
    worker holding the single-worker guard can revoke live transports. Revoking
    from any other process used to report ``ssh_sessions=0, errors=[]`` --
    indistinguishable from success -- which is exactly how the capacity incident
    silently leaked. Now: if a claim exists, its holder is alive, and THIS
    process is not the holder, revoke refuses loudly and touches nothing.
    (If the holder is DEAD -- proved via R2's pid/starttime evidence -- the call
    proceeds: the registry is genuinely empty because transports died with the
    worker, and the divergence report below says so honestly.)
    """
    user_id = int(user_id)
    result = {
        'sockets': 0,
        'ssh_sessions': 0,
        'pool_connections': 0,
        'divergent_session_ids': [],
        'errors': [],
    }

    from . import worker_guard

    claim = db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
    if (claim is not None
            and not worker_guard.guard_is_held()
            and not worker_guard._claim_is_dead(claim)):
        result['errors'].append(f"locality:{claim.pid}:{claim.boot_id}")
        log_error(
            "Refusing revoke from a non-serving process: another live worker "
            "holds the single-worker guard",
            user_id=user_id, holder_pid=claim.pid,
            holder_boot_id=claim.boot_id, pid=os.getpid())
        return result

    socket_sids = [
        row.socket_sid
        for row in SocketSession.query.filter_by(user_id=user_id).all()
    ]
    result['sockets'] = len(socket_sids)

    if socketio_instance is None:
        from . import socketio as socketio_instance

    server = getattr(socketio_instance, 'server', None)
    if server is not None:
        for socket_sid in socket_sids:
            try:
                server.disconnect(socket_sid, namespace='/')
            except Exception as exc:
                result['errors'].append(f'socket:{socket_sid}:{exc}')
                log_warning(
                    "Failed to disconnect revoked Socket.IO session",
                    user_id=user_id,
                    sid=socket_sid,
                    error=str(exc),
                )

    with ssh_manager.sessions_lock:
        # S2 step 4 (expected_session forwarding): capture the session OBJECT
        # inside the same lock as the id, so a concurrent re-registration under
        # a reused id cannot be closed by this revoke (R3-A window).
        ssh_entries = [
            (session_id, session)
            for session_id, session in ssh_manager.sessions.items()
            if str(session.get('user_id')) == str(user_id)
        ]

    # S2 step 4: DB-vs-registry divergence report. A row claiming connected
    # with no registry entry means either a restart race or a stale registry;
    # report it honestly instead of silently closing nothing. Runs on ALL
    # paths, in-process included. Disconnected rows are expected to lack
    # registry entries (reconnect candidates), so they are not divergence.
    registry_ids = {session_id for session_id, _ in ssh_entries}
    for row in SSHSession.query.filter_by(user_id=user_id, connected=True).all():
        if row.session_id not in registry_ids:
            result['divergent_session_ids'].append(row.session_id)
            result['errors'].append(
                f"divergence:{row.session_id}:row-without-registry")

    for session_id, session_obj in ssh_entries:
        try:
            if ssh_manager.close_session(
                    session_id, kill_tmux=True, expected_session=session_obj):
                result['ssh_sessions'] += 1
            else:
                result['errors'].append(f'ssh:{session_id}:close failed')
        except Exception as exc:
            result['errors'].append(f'ssh:{session_id}:{exc}')
            log_warning(
                "Failed to close revoked SSH session",
                user_id=user_id,
                session_id=session_id,
                error=str(exc),
            )

    try:
        result['pool_connections'] = (
            connection_pool.temp_connection_pool.close_all_user_connections(str(user_id))
        )
    except Exception as exc:
        result['errors'].append(f'pool:{exc}')
        log_warning(
            "Failed to close revoked temporary connections",
            user_id=user_id,
            error=str(exc),
        )

    try:
        SocketSession.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        SSHSession.query.filter_by(user_id=user_id).delete(synchronize_session=False)
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        result['errors'].append(f'database:{exc}')
        log_warning(
            "Failed to remove revoked session metadata",
            user_id=user_id,
            error=str(exc),
        )

    log_info(
        "User access revoked",
        user_id=user_id,
        sockets=result['sockets'],
        ssh_sessions=result['ssh_sessions'],
        pool_connections=result['pool_connections'],
        cleanup_errors=len(result['errors']),
        divergent_session_ids=result['divergent_session_ids'],
    )
    return result


def quarantine_user_data(user_id):
    """Atomically move a user's files outside the active user namespace."""
    user_id = int(user_id)
    original = config.DATA_DIR / 'users' / f'user_{user_id}'
    if not original.exists():
        return None, None

    quarantine_root = config.DATA_DIR / 'deleted_users'
    quarantine_root.mkdir(parents=True, exist_ok=True)
    quarantined = quarantine_root / f'user_{user_id}_{uuid4().hex}'
    original.replace(quarantined)
    return original, quarantined


def restore_quarantined_user_data(original, quarantined):
    """Restore a quarantined directory after a failed database deletion."""
    if original is None or quarantined is None or not quarantined.exists():
        return
    original.parent.mkdir(parents=True, exist_ok=True)
    quarantined.replace(original)


def delete_user_account(user, socketio_instance=None):
    """Revoke a user and delete their row without exposing retained files."""
    user_id = int(user.id)
    # S2 step 4: inspect the revoke result. `or {}` normalizes once for any
    # caller/test stub that returns None; everything below reads the
    # Normalized dict with.get only -- no second guard needed.
    revoke_result = revoke_user_access(user_id, socketio_instance) or {}
    # A locality failure means the live resources were NOT revoked.
    # Abort BEFORE quarantine/delete so the operator sees why and can retry
    # from the serving process. Divergence alone does NOT abort: a dead worker
    # genuinely has nothing to close, and the admin's delete intent stands --
    # the orphan tmux is recorded in the result for manual follow-up.
    locality_errors = [
        e for e in revoke_result.get('errors', [])
        if e.startswith('locality:')
    ]
    if locality_errors:
        raise RuntimeError(
            f"Refusing to delete user {user_id}: revocation ran outside the "
            f"serving worker ({'; '.join(locality_errors)}). Live resources "
            "were not revoked.")
    original = quarantined = None

    try:
        original, quarantined = quarantine_user_data(user_id)
        db.session.delete(user)
        db.session.commit()
    except Exception:
        db.session.rollback()
        try:
            restore_quarantined_user_data(original, quarantined)
        except Exception as restore_error:
            log_error(
                "Failed to restore quarantined user data",
                user_id=user_id,
                error=str(restore_error),
            )
        raise

    return quarantined
