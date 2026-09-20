from flask_socketio import emit, join_room, disconnect
from flask import request, current_app
from flask_login import current_user
from . import (socketio, ssh_manager, profile_manager, key_manager,
               sftp_handler, jump_host_manager, post_connect_manager)
from .decorators import socket_login_required, accepts_raw_payload
from .auth import register_socket_session, get_user_from_socket, check_socket_rate_limit
from .models import db, SSHSession, SocketSession
from .user_settings import (VALID_THEMES, save_user_settings, get_user_settings,
                            get_notepad, save_notepad_revision,
                            effective_notepad_mode, stored_notepad_mode)
from .audit_logger import (log_info, log_warning, log_error, log_debug,
                              log_ssh_connection, log_ssh_disconnect,
                              log_file_upload, log_file_download,
                              log_key_upload, log_key_delete,
                              log_tailscale_ssh_usage)
from .tailscale_ssh import (
    profile_is_authorized_for_launch,
    validate_tailscale_ssh_access,
)
from .storage_utils import storage_lock
from .transfer_registry import TransferLimitExceeded, transfer_registry
from . import binary_transfer, connection_pool
import base64
import json
import os
import posixpath
import re
import socket
import threading
import ipaddress
from datetime import datetime, timezone
from pathlib import Path
import config


class DownloadSizeLimitExceeded(Exception):
    """Raised before a download writes more than its configured byte cap."""


def _copy_file_with_limit(source, destination, max_bytes):
    """Copy a binary stream while enforcing a hard maximum byte count."""
    copied = 0
    while True:
        chunk = source.read(65536)
        if not chunk:
            return copied
        next_size = copied + len(chunk)
        if next_size > max_bytes:
            raise DownloadSizeLimitExceeded(
                f'download exceeds configured limit of {max_bytes} bytes'
            )
        destination.write(chunk)
        copied = next_size

def _is_valid_host(host_str):
    """Validate host is a valid hostname or IP address."""
    try:
        ipaddress.ip_address(host_str)
        return True
    except ValueError:
        pass
    hostname_pattern = re.compile(
        r'^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?'
        r'(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$'
    )
    return bool(hostname_pattern.match(host_str))

def _ip_is_internal(addr):
    """True if an IP address is non-public and therefore off-limits when
    BLOCK_INTERNAL_SSH is enabled.

    Covers loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16 incl. the
    cloud metadata address 169.254.169.254, fe80::/10), RFC1918 / ULA private
    ranges, and other reserved/multicast/unspecified space.
    """
    return (addr.is_loopback or addr.is_link_local or addr.is_private
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified)

def _is_internal_address(host_str):
    """Check whether a host points at an internal address (SSRF protection).

    When BLOCK_INTERNAL_SSH is enabled, prevents SSH connections to internal
    addresses. Hostnames are resolved and EVERY address they map to is checked,
    so a name that resolves to 127.0.0.1 / a private IP / the metadata address
    cannot be used to bypass the guard (a literal-IP-only check could).

    Note: DNS is resolved here and again by paramiko at connect time, so a host
    under attacker DNS control could still rebind in between (TOCTOU). Closing
    that fully would require pinning the connection to the validated IP.
    """
    host_str = (host_str or '').strip()
    if not host_str:
        return False

    # Literal IP address: check it directly.
    try:
        return _ip_is_internal(ipaddress.ip_address(host_str))
    except ValueError:
        pass

    if host_str.lower() in ('localhost', 'localhost.localdomain', 'ip6-localhost'):
        return True

    # Hostname: resolve and reject if ANY resolved address is internal.
    try:
        infos = socket.getaddrinfo(host_str, None)
    except socket.gaierror:
        # Unresolvable name cannot reach an internal service; let the connect fail.
        return False
    for info in infos:
        try:
            if _ip_is_internal(ipaddress.ip_address(info[4][0])):
                return True
        except ValueError:
            continue
    return False

def _validate_ssh_params(host, port, username, allow_internal=False):
    """Validate SSH connection parameters. Returns (clean_host, clean_port, clean_username, error).

    allow_internal: skip the internal-address block. Used for the *target* of a
    ProxyJump connection — it is reached from the bastion, not from this server,
    so internal targets behind a bastion are legitimate. The bastion itself is
    always validated without this flag (it is reached directly by the server).
    """
    host = (host or '').strip()
    if not host:
        return None, None, None, 'Host is required'
    if not _is_valid_host(host):
        return None, None, None, 'Invalid host format'

    if config.BLOCK_INTERNAL_SSH and not allow_internal and _is_internal_address(host):
        log_warning(f"SECURITY: SSH to internal address blocked", host=host)
        return None, None, None, 'Connections to internal addresses are not allowed'

    try:
        port = int(port)
        if not (1 <= port <= 65535):
            return None, None, None, 'Port must be between 1 and 65535'
    except (ValueError, TypeError):
        return None, None, None, 'Invalid port number'

    username = (username or '').strip()
    if not username:
        return None, None, None, 'Username is required'
    if not re.match(r'^[a-zA-Z0-9_\-\.]{1,32}$', username):
        return None, None, None, 'Invalid username format'

    return host, port, username, None

def _handshake_evidence(flask_session):
    """What the handshake actually carried, by NAME only.

    OWNER REPORT: "th\u01b0\u1eddng xuy\u00ean \u0111\u1ee9t h\u1ebft n\u1ed1i n\u1ebfu l\u00e2u kh\u00f4ng thao t\u00e1c
    ho\u1eb7c chuy\u1ec3n tab kh\u00e1c". The server log showed the shape but not the cause:
    twice in one day a reconnect handshake arrived with no `_user_id`, the
    server refused it, and the owner had to reload -- after which the page
    was logged in again with no password, so a credential WAS still in the
    browser. Which one is missing is the whole question, and it cannot be
    answered from the refusal alone.

    So a refusal records which cookies were present and which keys the Flask
    session held. Names only: a session cookie is a bearer token and belongs
    nowhere near a log line.
    """
    remember_name = current_app.config.get('REMEMBER_COOKIE_NAME', 'remember_token')
    session_name = current_app.config.get('SESSION_COOKIE_NAME', 'session')
    return {
        'had_session_cookie': session_name in request.cookies,
        'had_remember_cookie': remember_name in request.cookies,
        'session_keys': sorted(flask_session.keys()),
        'transport': request.args.get('transport', ''),
    }


@socketio.on('connect')
def handle_connect():
    """Handle client connection - authenticate and restore sessions."""
    from flask import session as flask_session

    user_id = flask_session.get('_user_id')
    if not user_id:
        # The Flask session is not the only credential the browser holds. A
        # "remember me" login also leaves a signed remember cookie, and
        # flask_login resolves it on first touch of current_user -- writing
        # `_user_id` back into the session as it goes. Reading it here is the
        # difference between a socket that heals itself and one that stays
        # dead until the owner reloads the page by hand.
        if current_user.is_authenticated:
            user_id = flask_session.get('_user_id') or current_user.get_id()
        else:
            log_warning(f"Unauthenticated connection attempt", sid=request.sid,
                        **_handshake_evidence(flask_session))
            emit('connected', {'status': 'unauthenticated'})
            disconnect()
            return False

    from .models import User
    user = db.session.get(User, int(user_id))
    if not user or user.is_locked:
        log_warning(f"User not found during connect", user_id=user_id, sid=request.sid)
        emit('connected', {'status': 'unauthenticated'})
        disconnect()
        return False

    socket_sid = request.sid
    user_agent = request.headers.get('User-Agent', '')
    register_socket_session(user.id, socket_sid, user_agent)

    room = f'user_{user.id}'
    join_room(room)

    log_info(f"Client connected: {user.username}", user=user.username, sid=socket_sid)

    # The arranged tab order goes out BEFORE the sessions so every chip the
    # restore creates lands in its remembered place (item C,).
    emit('tab_order', {'order': get_user_settings(user.id).get('tab_order') or []})

    # Scope the restore to THIS connecting socket: a second tab of the same
    # account must not replay scrollback into the first tab's terminals.
    restore_user_sessions(user.id, to_sid=socket_sid)

    emit('connected', {
        'status': 'success',
        'username': user.username
    })

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection - cleanup socket session."""
    socket_sid = request.sid
    user = get_user_from_socket(socket_sid)

    # Every tmux client this socket held goes away with it: each view is
    # detached by tty and its channel closed, so a surviving device gets its
    # own size back at once (see ssh_manager._detach_view for why the channel
    # close alone is not prompt over Tailscale SSH). The SESSION is untouched:
    # a session with no views is a normal detached session, and the remote
    # work keeps running. Done before -- and regardless of -- the user lookup:
    # it also RETIRES the sid, which is what stops an attach still in flight
    # from registering a view for a socket that no longer exists.
    detached = ssh_manager.close_views_for_socket(
        socket_sid, socketio_instance=socketio)
    if detached:
        log_debug(f"Detached {len(detached)} view(s) for the closed socket",
                  sid=socket_sid)
    ssh_manager.forget_input_turns(socket_sid)

    if user:
        log_info(f"Client disconnected: {user.username}", user=user.username, sid=socket_sid)

        SocketSession.query.filter_by(socket_sid=socket_sid).delete()
        db.session.commit()

        # Scoped to THIS socket, never to the user: a second tab of the same
        # account may be watching its own transfer, and closing this one must not
        # cancel it. Records remember the sid that created them.
        cancelled = transfer_registry.cancel_all_for_socket(user.id, socket_sid)
        if cancelled:
            log_info(f"Cancelled {cancelled} transfer(s) for the disconnected socket",
                     user=user.username, sid=socket_sid)

        # S2 step 5: last-socket proof is LIVE room membership, not the DB row
        # count. A stale SocketSession row within a single boot (crash before
        # the delete above, or sweeper not yet run) must never suppress the
        # Quick-Connect pool cleanup or the user-wide transfer sweep.
        #
        # python-socketio triggers this handler BEFORE manager.disconnect, so
        # the disconnecting sid is STILL in the room here -- exclude it
        # explicitly. get_participants is this-worker-only, which matches the
        # -w 1 topology the guard enforces. Empty / missing manager is treated
        # as "no other live sockets" (fail open toward cleanup, never toward
        # suppression).
        other_live = _other_live_sids_for_user(user.id, excluding_sid=socket_sid)
        if not other_live:
            closed = connection_pool.temp_connection_pool.close_all_user_connections(str(user.id))
            if closed > 0:
                log_info(f"Cleaned up {closed} Quick Connect connection(s) for {user.username}")
            # Verified last socket: nothing remains that could own a transfer, so
            # sweep any record whose owner_sid was never captured.
            swept = transfer_registry.cancel_all_for_user(user.id)
            if swept:
                log_info(f"Cancelled {swept} remaining transfer(s) on last-socket disconnect",
                         user=user.username)
            log_debug(f"Last socket for {user.username} disconnected, SSH sessions preserved")
        else:
            log_debug(f"Socket {socket_sid[:8]}… disconnected for {user.username}; "
                      f"{len(other_live)} other live socket(s) remain")


def _other_live_sids_for_user(user_id, excluding_sid=None):
    """S2 step 5: the sids currently in this user's room on THIS worker.

    Returns a set of socket sids, optionally excluding one sid (the
    disconnecting one, which python-socketio has not yet removed from the
    room by the time the 'disconnect' handler runs).

    Used as the last-socket proof instead of the SocketSession row count: a
    stale DB row within a single boot must never suppress the Quick-Connect
    pool cleanup or the user-wide transfer sweep.

    Fail-open toward CLEANUP: if the manager is unavailable or the enumeration
    raises, return the empty set so the last-socket path still runs. Running
    cleanup when there is nothing to clean is a harmless no-op; suppressing
    cleanup is the defect this helper exists to prevent.
    """
    try:
        server = getattr(socketio, 'server', None)
        manager = getattr(server, 'manager', None) if server is not None else None
        if manager is None or not hasattr(manager, 'get_participants'):
            return set()
        room = f'user_{int(user_id)}'
        live = {sid for sid, _eio_sid in manager.get_participants('/', room)}
        if excluding_sid is not None:
            live.discard(excluding_sid)
        return live
    except Exception as exc:
        log_warning("Failed to enumerate live sids for last-socket check",
                    user_id=user_id, error=str(exc))
        return set()


def _build_session_snapshot(session_id, db_session):
    """Canonical SessionSnapshot v1 projection.

    The ONE place that merges the in-RAM transport record with the DB row for
    restore / get_sessions / reconnect, so no consumer re-derives this from
    ``ssh_manager.sessions`` directly. Precedence when sources disagree: the
    RAM record wins for live state (connected, tmux identity, auth type), the
    DB row wins for persisted identity the RAM record never carries
    (key_id, pane_index, snapshot_version). Secrets never enter the snapshot:
    key_id is an opaque reference, never key material.
    """
    session = ssh_manager.get_session(session_id) or {}
    connected = bool(session.get('connected'))
    # NO GEOMETRY IN THE SNAPSHOT. Each browser socket attaches its own tmux
    # client at its own size (see the views note in ssh_manager), so there is no
    # shared grid for a restoring client to adopt -- it fits its pane locally
    # and its view's PTY carries that size to tmux.
    return {
        'snapshot_version': 1,
        'session_id': session_id,
        'host': db_session.host,
        'port': db_session.port,
        'username': db_session.username,
        'connected': connected,
        'auth_type': session.get('auth_type') or db_session.auth_type,
        'key_id': db_session.key_id,
        'via_jump': session.get('via_jump'),
        'use_tmux': session.get('use_tmux', False) if connected
        else bool(db_session.is_persistent),
        'tmux_session_name': session.get('tmux_session_name')
        or db_session.tmux_session_name,
        'display_name': session.get('display_name') or db_session.display_name,
        'pane_index': db_session.pane_index,
        # The server's replay LINE cap, carried so the client's
        # scrollback default can be DERIVED from it instead of guessed. The
        # client kept 150 lines while this path was prepared to send up to 5000,
        # so history the server had already delivered was discarded on arrival.
        # A client that does not understand this field keeps its compile-time
        # fallback, which is the same number.
        'replay_max_lines': ssh_manager.REPLAY_MAX_LINES,
        # Multi-byte input honesty. True means the attached tmux pane was
        # created before the UTF-8 locale fix, so its RUNNING shell cannot be
        # given a locale -- `-e` on `new-session -A` is a measured no-op against
        # an existing session, and repairing it would mean writing to the user's
        # live pane. The UI states the limitation; the only route to a fixed pane
        # is a NEW session, which is Reset's job. False = measured fine,
        # None = not measured (a restored row nobody has reattached yet).
        'legacy_tmux_locale': session.get('legacy_tmux_locale'),
    }


def _announce_session_to_other_sockets(user_id, session_id, db_session,
                                       replaces_session_id=None):
    """A session this socket just opened exists for the user's OTHER sockets too.

    Nothing used to tell them: a phone that had offered a reconnect for a
    saved row kept offering it after the desktop had claimed it -- and its own
    Reconnect was then refused, because the claim deleted the row -- until a
    reload rebuilt the list. So every successful connect is announced to the
    rest of the user's sockets as a restore-shaped snapshot:

      * `live: True` -- the session was opened elsewhere just now, not
        restored for THIS page: the receiver adds it to its session list and
        does not display it, activate it, or replay anything for it;
      * `replaces_session_id` -- the saved row a reconnect claim retired, so
        the receiver can retire the stale offer in the same step.

    The requester is excluded: it hears `ssh_connected`.
    """
    snapshot = _build_session_snapshot(session_id, db_session)
    snapshot.update({
        'live': True,
        'replaces_session_id': replaces_session_id,
        'replay_total_chunks': 0,
        'replay_truncated': False,
        'replay_dropped_bytes': 0,
        'replay_history_lines': 0,
    })
    emit('ssh_session_restored', snapshot, room=f'user_{user_id}',
         include_self=False)


def prepare_attach_replay(session_id, use_tmux):
    """The SCROLLBACK a freshly attached view should be given, as replay chunks.

    Returns ``(chunks, meta)``; ``([], empty_meta)`` when there is nothing to
    send.

    A view's own `tmux attach` repaints the VISIBLE screen for that client at
    that client's size -- that is what makes one tmux client per socket work at
    all. What the attach does NOT bring is the scrollback ABOVE the screen,
    which lives in tmux, so that is what this reads (`read_tmux_history`, to
    `-E -1`, the line directly above the window) and what the client writes into
    its xterm before the attach paint lands.

    It is plain text: `_normalise_history_text` strips every escape, so the
    client re-wraps it at its own width like any terminal re-wraps scrollback.

    Non-tmux sessions get nothing here: a plain SSH session scrolls xterm
    directly, so its scrollback fills the ordinary way and the bytes it missed
    while away come from the gap buffer on the restore path instead.
    """
    empty = {'bytes': 0, 'lines': 0, 'truncated': False, 'dropped_bytes': 0,
             'total_chunks': 0, 'history_lines': 0}
    if not use_tmux:
        return [], empty
    try:
        return ssh_manager.build_replay_chunks(
            session_id, include_buffer=False)
    except Exception as exc:
        # A connect must never fail because history could not be read.
        log_debug("attach history replay unavailable",
                  session_id=session_id, error=str(exc))
        return [], empty


def emit_attach_replay(session_id, chunks, meta, to_sid=None):
    """Emit the prepared attach chunks, in order, AFTER the session event.

    Same wire shape restore uses (1-based seq, total, final, truncated), so the
    client's existing sequenced writer handles both paths identically. No
    terminator is sent when there are no chunks: on this path the window is only
    opened when the count is non-zero, so there is nothing to release -- which is
    what keeps a fresh connect on exactly today's code path.
    """
    if not chunks:
        return
    room = to_sid if to_sid is not None else None
    total = len(chunks)
    for index, chunk in enumerate(chunks):
        payload = {
            'session_id': session_id,
            'seq': index + 1,
            'total': total,
            'data': chunk,
            'final': index + 1 == total,
            'truncated': meta.get('truncated', False),
            'dropped_bytes': meta.get('dropped_bytes', 0),
        }
        if room is not None:
            emit('ssh_replay_chunk', payload, room=room)
        else:
            emit('ssh_replay_chunk', payload)


def _offer_persistent_session(db_session, room):
    """Tell `room` that this saved tmux session can be reattached."""
    emit('persistent_session_available', {
        'snapshot_version': 1,
        'session_id': db_session.session_id,
        'host': db_session.host,
        'port': db_session.port,
        'username': db_session.username,
        'key_id': db_session.key_id,
        'auth_type': db_session.auth_type,
        'tmux_session_name': db_session.tmux_session_name,
        'display_name': db_session.display_name,
        'pane_index': db_session.pane_index
    }, room=room)
    log_info(f"Persistent tmux session available for reconnect",
             host=db_session.host, tmux_session=db_session.tmux_session_name)


def restore_user_sessions(user_id, to_sid=None):
    """Restore active SSH sessions when user reconnects.

    ``to_sid`` scopes every restore/candidate event to the CONNECTING socket.
    The previous broadcast to the whole user room replayed scrollback into the
    other tabs of the same account; a second tab connecting must not redraw
    the first tab's terminals. ``None`` keeps the room broadcast for callers
    that have no single target socket.
    """
    # Clean up old disconnected non-persistent sessions
    SSHSession.query.filter_by(user_id=user_id, connected=False, is_persistent=False).delete()
    db.session.commit()

    db_sessions = SSHSession.query.filter_by(user_id=user_id, connected=True).all()

    room = to_sid if to_sid is not None else f'user_{user_id}'

    for db_session in db_sessions:
        session_id = db_session.session_id

        session = ssh_manager.get_session(session_id)

        if session and session.get('connected'):
            snapshot = _build_session_snapshot(session_id, db_session)
            # key_id is included unconditionally: a restored key session must
            # be able to reconnect silently exactly like a candidate can.
            #
            # REPLAY IS A NON-TMUX CONCERN NOW.
            #
            # A tmux session's returning tab opens its OWN tmux client
            # (`view_attach`), and that attach repaints the visible screen for
            # that client at its own size; the scrollback above the screen is
            # fetched by the same request (`history: true`). So this path sends
            # no chunks for a tmux session, and -- load-bearing -- the client
            # must therefore not open a replay window for one: a window opened
            # with nothing to replay would queue every live frame behind a
            # terminator that is never coming.
            #
            # A plain SSH session has no history anywhere but here, so the gap
            # buffer is still replayed as bounded, explicitly sequenced chunks
            # after the snapshot, with the empty terminator that releases the
            # client's queue when there was nothing to send.
            use_tmux = bool(session.get('use_tmux'))
            if use_tmux:
                chunks, replay_meta = [], {
                    'total_chunks': 0, 'truncated': False,
                    'dropped_bytes': 0, 'history_lines': 0}
            else:
                chunks, replay_meta = ssh_manager.build_replay_chunks(session_id)
            snapshot['replay_total_chunks'] = replay_meta['total_chunks']
            snapshot['replay_truncated'] = replay_meta['truncated']
            snapshot['replay_dropped_bytes'] = replay_meta['dropped_bytes']
            snapshot['replay_history_lines'] = replay_meta.get(
                'history_lines', 0)
            emit('ssh_session_restored', snapshot, room=room)

            for index, chunk in enumerate(chunks):
                emit('ssh_replay_chunk', {
                    'session_id': session_id,
                    # 1-based so a client can never confuse "no chunks" with
                    # "chunk zero", and can detect a gap rather than silently
                    # rendering out of order.
                    'seq': index + 1,
                    'total': replay_meta['total_chunks'],
                    'data': chunk,
                    'final': index + 1 == replay_meta['total_chunks'],
                    'truncated': replay_meta['truncated'],
                    'dropped_bytes': replay_meta['dropped_bytes'],
                }, room=room)
            if not chunks and not use_tmux:
                # An explicit empty terminator: the client's replay queue must
                # be released even when there was nothing to replay, or live
                # output would sit queued behind a replay that never arrives.
                emit('ssh_replay_chunk', {
                    'session_id': session_id,
                    'seq': 0,
                    'total': 0,
                    'data': '',
                    'final': True,
                    'truncated': False,
                    'dropped_bytes': 0,
                }, room=room)
            log_info(f"Restored SSH session {session_id}", user_id=user_id,
                     room=room, replay_chunks=replay_meta['total_chunks'],
                     replay_truncated=replay_meta['truncated'])
        else:
            db_session.connected = False
            db.session.commit()
            log_debug(f"SSH session {session_id} no longer active, marked disconnected")

    # Restore disconnected persistent tmux sessions as reconnect candidates
    if config.TMUX_ENABLED:
        persistent_sessions = SSHSession.query.filter_by(
            user_id=user_id, is_persistent=True, connected=False
        ).all()
        for db_session in persistent_sessions:
            _offer_persistent_session(db_session, room)

@socketio.on('ssh_connect')
@socket_login_required
def handle_ssh_connect(data, current_user=None):
    """Handle SSH connection request with input validation."""
    password = None
    key_content = None
    bastion_password = None
    bastion_key_content = None
    # Session_id is pre-bound BEFORE client_request_id, and the order
    # matters. The except block drops this session's announce gate, and an
    # exception BEFORE create_ssh_connection returns would otherwise raise
    # NameError inside the handler for the original failure -- turning one
    # reported error into an unreported one. It goes FIRST because this file's
    # shipped contract (tests/browser/lifecycle_entry_matrix.mjs) pins
    # `client_request_id = None` as immediately followed by the
    # `if isinstance(data, dict):` that resolves it; inserting anything between
    # the two breaks that pin, and the pin is right -- the correlation id must be
    # the LAST thing established before the try.
    session_id = None
    # Resolved BEFORE the try block so the outer handler can still correlate.
    # Without it an unexpected exception emitted ssh_error with no
    # client_request_id, and the client could not tell which request had failed:
    # a reconnect intent then stayed claimed forever and its session became
    # permanently un-reconnectable behind the one-owner guard.
    client_request_id = None
    if isinstance(data, dict):
        raw_request_id = data.get('client_request_id')
        if isinstance(raw_request_id, str) and len(raw_request_id) <= 128:
            client_request_id = raw_request_id
    try:
        password = data.get('password')
        key_id = data.get('key_id')
        auth_type = data.get('auth_type') or ('key' if key_id else 'password')

        def emit_error(message):
            emit('ssh_error', {'error': message, 'client_request_id': client_request_id})

        with storage_lock(f'command-config:{current_user.id}'):
            startup_commands, startup_commands_error = (
                post_connect_manager.resolve_configuration(
                    current_user.id, data
                )
            )
        if startup_commands_error:
            emit_error(startup_commands_error)
            return

        if check_socket_rate_limit(current_user.id, 'ssh_connect', config.RATELIMIT_SSH_CONNECT):
            log_warning("SSH connect rate limit hit", user=current_user.username)
            emit_error('Too many connection attempts. Please wait a moment.')
            return

        proxy_jump = data.get('proxy_jump')

        # The target may be internal when reached via a bastion (legitimate).
        host, port, username, error = _validate_ssh_params(
            data.get('host'), data.get('port', 22), data.get('username'),
            allow_internal=bool(proxy_jump)
        )
        if error:
            emit_error(error)
            return

        if auth_type not in {'password', 'key', 'tailscale'}:
            emit_error('Invalid authentication method')
            return

        if auth_type == 'tailscale':
            access_error = validate_tailscale_ssh_access(current_user, host, username)
            log_tailscale_ssh_usage(
                current_user.username, host, port, username, request.remote_addr,
                allowed=access_error is None, error=access_error
            )
            if access_error:
                emit_error(access_error)
                return

        if auth_type == 'password' and not password:
            emit_error('Password required')
            return

        if auth_type == 'key' and not key_id:
            emit_error('Password or SSH key required')
            return

        if key_id:
            key_content, key_error = key_manager.read_key_content(current_user.id, key_id)
            if key_error:
                emit_error(f'SSH key error: {key_error}')
                return

        # Resolve optional ProxyJump / bastion parameters. The bastion is reached
        # directly by the server, so it is validated WITHOUT allow_internal.
        bastion_host = bastion_port = bastion_username = None
        if proxy_jump:
            bastion_host, bastion_port, bastion_username, bastion_error = _validate_ssh_params(
                proxy_jump.get('host'), proxy_jump.get('port', 22), proxy_jump.get('username')
            )
            if bastion_error:
                emit_error(f'Jump host: {bastion_error}')
                return
            bastion_password = proxy_jump.get('password')
            bastion_key_id = proxy_jump.get('key_id')
            if not bastion_password and not bastion_key_id:
                emit_error('Jump host password or SSH key required')
                return
            if bastion_key_id:
                bastion_key_content, bastion_key_error = key_manager.read_key_content(
                    current_user.id, bastion_key_id
                )
                if bastion_key_error:
                    emit_error(f'Jump host SSH key error: {bastion_key_error}')
                    return

        use_tmux = bool(data.get('use_tmux')) and config.TMUX_ENABLED
        reconnect_tmux_name = None
        raw_name = data.get('reconnect_tmux_name')
        if raw_name:
            # A reconnect NAME is a REATTACH CLAIM. It is either
            # honoured exactly or refused entirely -- there is no third state
            # that silently converts it into a fresh connection.
            #
            # * TMUX_ENABLED=false: reattaching is impossible by definition,
            #   so the claim must fail CLOSED, not be dropped into a bare or
            #   fresh connection the user never asked for.
            # * invalid shape: refused, same as before.
            # * not owned by the EXACT source session: refused. The old code
            #   DROPPED an unowned name and reconnected fresh -- which is how
            #   a control labelled Reconnect performed Reset's outcome.
            if not use_tmux:
                emit_error('Cannot reconnect a tmux session: '
                           'tmux is disabled on this server')
                return
            import re as _re
            # Whitelist: alphanumeric, underscores, max 190 chars
            if not _re.match(r'^[A-Za-z0-9_]{1,190}$', raw_name):
                emit_error('Invalid tmux session name')
                return
            # Bind the claim to the EXACT source session and endpoint. Every
            # reconnecting row carries the source session_id, so a valid name
            # that belongs to a DIFFERENT session, host, port, username, or
            # another user is tampering and is refused here -- before any
            # transport is built and before the source is mutated or retired.
            source_session_id = data.get('session_id')
            if not isinstance(source_session_id, str) or not source_session_id:
                emit_error('Reconnect requires the source session id')
                return
            existing = SSHSession.query.filter_by(
                session_id=source_session_id,
                user_id=current_user.id,
                tmux_session_name=raw_name,
                is_persistent=True
            ).first()
            if existing is None:
                emit_error('Cannot reconnect: the saved tmux session was '
                           'not found for this connection')
                return
            if (existing.host != host or existing.port != port
                    or existing.username != username):
                emit_error('Cannot reconnect: the connection details do not '
                           'match the saved session')
                return
            reconnect_tmux_name = raw_name

        # Display name is normalized BEFORE the transport is created so the
        # in-RAM session record and the DB row share the exact same value.
        display_name = data.get('display_name')
        if display_name:
            display_name = display_name.strip()[:128] or None

        session_id, error = ssh_manager.create_ssh_connection(
            host=host,
            port=int(port),
            username=username,
            password=password,
            key_content=key_content,
            socketio_instance=socketio,
            app=current_app._get_current_object(),
            user_id=current_user.id,
            proxy_jump_host=bastion_host,
            proxy_jump_port=bastion_port,
            proxy_jump_username=bastion_username,
            proxy_jump_password=bastion_password,
            proxy_jump_key_content=bastion_key_content,
            use_tmux=use_tmux,
            reconnect_tmux_name=reconnect_tmux_name,
            auth_type=auth_type,
            startup_commands='' if reconnect_tmux_name else startup_commands,
            display_name=display_name,
        )

        if password:
            password = None
        if key_content:
            key_content = None

        if error:
            emit_error(error)
        else:
            created_session = ssh_manager.get_session(session_id)
            if not created_session:
                log_error("SSH session disappeared after creation", session_id=session_id)
                emit_error("Connection failed")
                return
            created_tmux_name = created_session.get('tmux_session_name') if use_tmux else None
            replaced_session_id = None

            try:
                # Display name and key identity are persisted
                # UNCONDITIONALLY below. Gating them on use_tmux made a
                # restored non-tmux session un-renamable and unable to
                # reconnect silently; identity is not a tmux-only concept.
                # Clean up the specific old disconnected persistent session when
                # reconnecting to avoid ghost tabs on refresh.
                if use_tmux and reconnect_tmux_name:
                    old_session = SSHSession.query.filter_by(
                        user_id=current_user.id, host=host, port=port,
                        is_persistent=True, connected=False,
                        tmux_session_name=reconnect_tmux_name
                    ).first()
                    if old_session:
                        replaced_session_id = old_session.session_id
                        db.session.delete(old_session)
                        log_info(f"Cleaned up old persistent session",
                                user=current_user.username, host=host,
                                tmux_session=reconnect_tmux_name)

                ssh_session = SSHSession(
                    session_id=session_id,
                    user_id=current_user.id,
                    host=host,
                    port=port,
                    username=username,
                    is_persistent=use_tmux,
                    key_id=key_id,
                    auth_type=auth_type,
                    tmux_session_name=created_tmux_name,
                    display_name=display_name
                )
                db.session.add(ssh_session)
                db.session.commit()
                _announce_session_to_other_sockets(
                    current_user.id, session_id, ssh_session,
                    replaces_session_id=replaced_session_id)
            except Exception as db_err:
                db.session.rollback()
                log_error(f"Failed to record SSH session in database",
                          error=str(db_err), session_id=session_id)

            # NO ATTACH REPLAY AND NO TMUX OPTIONS HERE.
            #
            # Both belong to the view, not to the connect: the client answers
            # `ssh_connected` by building its terminal and then asking for a
            # view (`view_attach`), which is where the tmux options are set and
            # where the scrollback is fetched, at the size that view really has.
            # Doing it here would mean guessing a size and repainting a pane no
            # browser is watching yet.
            emit('ssh_connected', {
                'snapshot_version': 1,
                'session_id': session_id,
                'host': host,
                'port': port,
                'username': username,
                'client_request_id': client_request_id,
                'via_jump': bastion_host,
                'use_tmux': use_tmux,
                # Unconditional. A non-tmux key session must reconnect
                # silently after reload exactly like a tmux one.
                'key_id': key_id,
                'auth_type': auth_type,
                'tmux_session_name': created_tmux_name,
                'display_name': display_name,
                # True when this connect REATTACHED a pane created before
                # the locale fix. Its running shell cannot be retrofitted, so
                # the UI says so instead of promising UTF-8 it cannot deliver.
                'legacy_tmux_locale': created_session.get(
                    'legacy_tmux_locale'),
                # The client's scrollback capacity is DERIVED from this cap,
                # so it is still declared here even though the history itself
                # now arrives with the view.
                'replay_max_lines': ssh_manager.REPLAY_MAX_LINES,
            })
            log_ssh_connection(current_user.username, host, port, True, request.remote_addr)

    except Exception as e:
        log_error(f"SSH connection failed", error=str(e), user=current_user.username)
        # The correlation id travels on EVERY error path, including this one:
        # the client releases the reconnect claim for exactly this request, and
        # an uncorrelated failure would leave it claimed for the session's life.
        emit('ssh_error', {'error': 'Connection failed',
                           'client_request_id': client_request_id})
    finally:
        password = None
        key_content = None
        bastion_password = None
        bastion_key_content = None

@socketio.on('ssh_reconnect')
@socket_login_required
def handle_ssh_reconnect(data, current_user=None):
    """W2 prepare-and-swap reconnect of ONE live session.

    The old lifecycle was destroy-then-recreate: the client closed the session
    (killing the tmux session with it), waited 500 ms and issued a brand new
    ``ssh_connect``, which produced a NEW session_id -- so the terminal, its
    scrollback, its pane and its identity were all discarded, and a failure
    left the user with nothing at all.

    Here the replacement transport is built FIRST, while the old one keeps
    serving the session. Only once it is ready (tmux reattach included) is it
    swapped in under the same logical session_id, so the xterm instance, pane
    placement, display name and DB row all survive. On any failure the old
    transport is still live and the client is told the session is unchanged.

    Credentials are resolved server-side from the persisted key_id: the client
    never re-sends key material, and a password session cannot reconnect
    silently (it has no stored secret) -- that route stays the pre-filled modal.
    """
    session_id = None
    key_content = None
    claimed = False
    try:
        if not isinstance(data, dict):
            return
        session_id = data.get('session_id')
        if not session_id or not isinstance(session_id, str):
            return

        def emit_failure(message, code='failed'):
            emit('ssh_reconnect_failed', {
                'session_id': session_id,
                'error': message,
                'code': code,
            })

        if not verify_session_ownership(session_id, current_user.id):
            emit('ssh_error', {'error': 'Unauthorized access to session',
                               'session_id': session_id})
            return

        if check_socket_rate_limit(current_user.id, 'ssh_connect',
                                   config.RATELIMIT_SSH_CONNECT):
            log_warning("SSH reconnect rate limit hit", user=current_user.username)
            emit_failure('Too many connection attempts. Please wait a moment.',
                         'rate_limited')
            return

        live = ssh_manager.get_session(session_id)
        if not live or not live.get('connected'):
            # Not a live session: this is the candidate/offline route, which is
            # a fresh connect (ssh_connect), not a transport swap.
            emit_failure('Session is not connected', 'not_live')
            return

        db_session = SSHSession.query.filter_by(session_id=session_id).first()
        if db_session is None:
            emit_failure('Session is not connected', 'not_live')
            return

        auth_type = live.get('auth_type') or db_session.auth_type or 'password'
        key_id = db_session.key_id

        # Only credentials the SERVER can re-supply on its own may swap
        # silently. A password session has no stored secret, so it must go back
        # through the form; saying so explicitly lets the client open the modal
        # instead of showing a bare error.
        if auth_type == 'password':
            emit_failure('Password required', 'password_required')
            return
        if auth_type == 'key':
            if not key_id:
                emit_failure('Password required', 'password_required')
                return
            key_content, key_error = key_manager.read_key_content(
                current_user.id, key_id)
            if key_error:
                emit_failure(f'SSH key error: {key_error}', 'key_error')
                return
        elif auth_type == 'tailscale':
            access_error = validate_tailscale_ssh_access(
                current_user, db_session.host, db_session.username)
            log_tailscale_ssh_usage(
                current_user.username, db_session.host, db_session.port,
                db_session.username, request.remote_addr,
                allowed=access_error is None, error=access_error
            )
            if access_error:
                emit_failure(access_error, 'unauthorized')
                return
        else:
            emit_failure('Invalid authentication method', 'invalid_auth')
            return

        # A jump-host session cannot be rebuilt from the server alone: the
        # bastion secret is never persisted. Route it to the form rather than
        # silently reconnecting DIRECTLY to a host that is only reachable (and
        # only authorized) through its bastion.
        if live.get('via_jump'):
            emit_failure('Password required', 'password_required')
            return

        # One lifecycle owner: reject a second in-flight reconnect for the same
        # session instead of racing two replacement transports.
        if not ssh_manager.begin_reconnect(session_id):
            emit_failure('Reconnect already in progress', 'in_flight')
            return
        claimed = True

        host = db_session.host
        port = db_session.port
        username = db_session.username
        # Reattach whenever a tmux identity exists: owning a name IS tmux
        # intent, so a reconnect must never silently downgrade an attached tmux
        # session to a raw shell (Reset is the only intentional raw-shell route).
        #
        # Deliberately NOT gated on config.TMUX_ENABLED. That flag governs
        # whether a NEW session may opt into tmux; this session already has a
        # running tmux session, and flipping the flag off must not turn a
        # reconnect into the very downgrade this route exists to prevent.
        #
        # Nor can it downgrade by accident. `_build_transport` now
        # REFUSES a retained reattach whose host has no tmux, or whose retained
        # session no longer exists, instead of falling back to a plain shell --
        # so this route either reattaches the exact session or fails with the
        # old transport still serving. It can never create a replacement
        # identity and never hands back a bare shell wearing this session's
        # label.
        tmux_name = live.get('tmux_session_name') or db_session.tmux_session_name
        use_tmux = bool(live.get('use_tmux') or tmux_name)

        client_sid = request.sid
        app = current_app._get_current_object()
        pending_key_content = key_content
        key_content = None

        def _run_reconnect():
            transport_result = None
            local_key_content = pending_key_content
            try:
                transport_result, build_error = ssh_manager._build_transport(
                    host, port, username,
                    key_content=local_key_content,
                    use_tmux=use_tmux,
                    reconnect_tmux_name=tmux_name if use_tmux else None,
                    auth_type=auth_type,
                    # The replacement transport launches the SAME shape
                    # the session it replaces used; a None keeps the shipped
                    # invoke_shell fallback.
                    login_shell=live.get('login_shell'),
                )
                local_key_content = None
                if build_error:
                    # Nothing was swapped: the OLD transport is still serving
                    # this session, so the client keeps everything it has.
                    socketio.emit('ssh_reconnect_failed', {
                        'session_id': session_id,
                        'error': build_error,
                        'code': 'failed',
                    }, to=client_sid)
                    return

                swapped, swap_error = ssh_manager.swap_session_transport(
                    session_id, transport_result,
                    socketio_instance=socketio, app=app)
                if not swapped:
                    # The session died while the replacement was connecting.
                    # Close the orphan so the new transport is not leaked.
                    ssh_manager._close_transport_parts(
                        transport_result.get('client'),
                        transport_result.get('channel'),
                        transport_result.get('bastion_client'))
                    socketio.emit('ssh_reconnect_failed', {
                        'session_id': session_id,
                        'error': swap_error or 'Reconnect failed',
                        'code': 'failed',
                    }, to=client_sid)
                    return
                transport_result = None

                with app.app_context():
                    row = SSHSession.query.filter_by(session_id=session_id).first()
                    new_tmux_name = ssh_manager.get_session(session_id) or {}
                    swapped_tmux_name = new_tmux_name.get('tmux_session_name')
                    swapped_use_tmux = bool(new_tmux_name.get('use_tmux'))
                    if row is not None:
                        # Safe DB-row ordering: the SAME row is updated in place
                        # after the swap succeeded. No row is deleted and no
                        # second row is created, so a failed reconnect can never
                        # orphan or duplicate this session's persisted identity.
                        try:
                            row.connected = True
                            row.is_persistent = swapped_use_tmux
                            row.tmux_session_name = swapped_tmux_name
                            row.snapshot_version = 1
                            db.session.commit()
                        except Exception as db_err:
                            db.session.rollback()
                            log_error("Failed to update session row after reconnect",
                                      error=str(db_err), session_id=session_id)
                        snapshot = _build_session_snapshot(session_id, row)
                    else:
                        snapshot = None

                # The tmux options and every view are re-established by
                # swap_session_transport: it re-attaches each socket that was
                # watching, at the size it last held, and open_session_view sets
                # the options on the way in.
                payload = snapshot if snapshot is not None else {
                    'snapshot_version': 1,
                    'session_id': session_id,
                }
                socketio.emit('ssh_reconnected', payload, to=client_sid)
                log_info("Session transport reconnected",
                         session_id=session_id, host=host,
                         tmux_session=swapped_tmux_name)
            except Exception as task_err:
                log_error("Reconnect task failed", error=str(task_err),
                          session_id=session_id)
                if transport_result is not None:
                    ssh_manager._close_transport_parts(
                        transport_result.get('client'),
                        transport_result.get('channel'),
                        transport_result.get('bastion_client'))
                socketio.emit('ssh_reconnect_failed', {
                    'session_id': session_id,
                    'error': 'Reconnect failed',
                    'code': 'failed',
                }, to=client_sid)
            finally:
                local_key_content = None
                ssh_manager.end_reconnect(session_id)

        claimed = False  # ownership passes to the task's finally block
        socketio.start_background_task(_run_reconnect)

    except Exception as e:
        log_error("SSH reconnect error", error=str(e), session_id=session_id)
        emit('ssh_reconnect_failed', {
            'session_id': session_id,
            'error': 'Reconnect failed',
            'code': 'failed',
        })
    finally:
        key_content = None
        if claimed and session_id:
            ssh_manager.end_reconnect(session_id)

@socketio.on('ssh_input')
def handle_ssh_input(data=None):
    """Handle user input to SSH session, in the order the events arrived.

    The ticket is taken here, before the authentication decorator does its
    DB work, because that work is where handler N yields and handler N+1 gets
    ahead of it (see ssh_manager.begin_input_turn for the measurement).
    """
    ticket = ssh_manager.begin_input_turn(request.sid)
    try:
        return _handle_ssh_input_in_turn(data)
    finally:
        ssh_manager.end_input_turn(request.sid, ticket)


@socket_login_required
def _handle_ssh_input_in_turn(data, current_user=None):
    """The `ssh_input` handler proper; runs once its socket's turn has come.

    S17 FIX 4d -- the `leave_scroll` advisory field.

    Measured on a scratch tmux 3.4 server (/tmp/s16work/s17_copymode_keys2.py
    and _keys3.py, a real attached client on a pty, which is the same
    interactive channel send_ssh_input writes to): while the pane is in copy
    mode tmux DISCARDS every byte written to that channel. 'echo SENDTEST' + CR
    left the shell row untouched; so did \\x7f and \\x15; a printable 'X' did not
    even move `copy_cursor_y`, so the bytes are not consumed as copy-mode
    commands, they are dropped. A single ESC to the same channel left copy mode
    (pane_in_mode 1 -> 0) and the next two DELs erased two real characters.

    Since tmux `mouse on` is the product default (:309), an ordinary upward
    swipe puts the pane in copy mode -- so the composer's ENTIRE write path
    (Send, streamed characters, DEL, \\x15) was silently dead after a scroll.

    The client sets `leave_scroll` only when it believes THIS session's scroll
    is tmux copy mode rather than xterm scrollback (TerminalManager
    .isSessionScrolled true AND appOwnsMouse false -- exactly the existing
    exitScrollAction discrimination, no new predicate). When present and truthy
    the pane is taken out of copy mode INLINE, before the write: dispatched as a
    background task it would race the write and the bytes would be swallowed
    again. exit_tmux_copy_mode queries pane_in_mode first and is a no-op when
    the pane is not in a mode, so at a normal prompt this costs nothing -- and
    the flag is absent there anyway. Its result is deliberately ignored: the
    write is what the user asked for and must proceed either way.

    Never unconditional: without the flag nothing is called, which is what keeps
    the Owner's working touch scrolling untouched.
    """
    try:
        session_id = data.get('session_id')
        input_data = data.get('data')

        if not session_id or input_data is None:
            return

        if not verify_session_ownership(session_id, current_user.id):
            emit('ssh_error', {'error': 'Unauthorized access to session', 'session_id': session_id})
            return

        if not isinstance(input_data, str):
            return

        if data.get('leave_scroll') is True:
            try:
                ssh_manager.exit_tmux_copy_mode(session_id)
            except Exception as exit_err:
                # An advisory step must never cost the user their keystroke.
                log_warning("leave_scroll exit copy-mode failed",
                            session_id=session_id, error=str(exit_err))

        # The bytes go to THIS socket's own tmux client when it has one, so a
        # keystroke reaches the pane as a keystroke from that device's terminal.
        # That is what makes IME and multi-byte input behave like a real
        # terminal instead of a synthesised `send-keys` stream. A socket with no
        # view (Broadcast to a pane it is not displaying) falls back inside
        # send_ssh_input.
        success, error = ssh_manager.send_ssh_input(
            session_id, input_data, socket_sid=request.sid)
        if error:
            emit('ssh_error', {'error': error, 'session_id': session_id})
            return

    except Exception as e:
        log_error(f"SSH input error", error=str(e))
        emit('ssh_error', {'error': 'Input error'})

@socketio.on('tmux_exit_copy_mode')
@socket_login_required
def handle_tmux_exit_copy_mode(data, current_user=None):
    """Leave tmux copy-mode / dismiss its command-prompt for one owned session.

    Touch-swipe scrolling drops the pane into copy-mode, where letter keys are
    copy-mode commands and g/f/t open a prompt on the status line; on mobile
    there is no Escape key to get back out. The actual work runs in a background
    task because it talks to the remote host over SSH, and this worker is the
    single eventlet worker that serves every other session's I/O.
    """
    session_id = None
    try:
        if not isinstance(data, dict):
            return
        session_id = data.get('session_id')
        if not session_id or not isinstance(session_id, str):
            return

        if not verify_session_ownership(session_id, current_user.id):
            emit('ssh_error', {'error': 'Unauthorized access to session',
                               'session_id': session_id})
            return

        # The request context (and request.sid) is gone by the time the task
        # runs, so capture the target client now and emit to it explicitly.
        client_sid = request.sid

        def _run_exit_copy_mode():
            try:
                success, error, was_in_mode = ssh_manager.exit_tmux_copy_mode(session_id)
            except Exception as task_err:
                log_error("tmux exit copy-mode failed",
                          error=str(task_err), session_id=session_id)
                success, error, was_in_mode = False, None, False
            if not success and error:
                # Log the real reason server-side; the UI only needs to know it
                # failed, not the transport/tmux internals.
                log_debug("tmux exit copy-mode unsuccessful",
                          session_id=session_id, error=error)
            socketio.emit('tmux_copy_mode_exited', {
                'session_id': session_id,
                'ok': bool(success),
                # Whether the pane really was in a mode. Lets the UI distinguish
                # "left scroll mode" from "was not in scroll mode" instead of
                # claiming success for a no-op, which made the button look broken.
                'was_in_mode': bool(was_in_mode),
                'error': None if success else 'Failed to exit tmux copy mode'
            }, to=client_sid)

        socketio.start_background_task(_run_exit_copy_mode)

    except Exception as e:
        log_error("tmux exit copy-mode error", error=str(e),
                  session_id=session_id)
        emit('ssh_error', {'error': 'Failed to exit tmux copy mode',
                           'session_id': session_id})

@socketio.on('keep_alive')
@socket_login_required
def handle_keep_alive(data=None, current_user=None):
    """Connectivity heartbeat only. Must NOT refresh SSH idle state.

    S2 rev6. static/js/app.js starts a 60s interval that emits this event
    whenever the socket is connected, with no interaction test of any kind. This
    handler used to set `last_activity` on EVERY registry session belonging to
    the user, so a single open browser tab kept every one of that user's SSH
    sessions alive forever: against SESSION_TIMEOUT (1800s) the idle reaper could
    never fire, which is why the production logs show zero idle closures. A tab
    being open is CONNECTIVITY LIVENESS, not a human using the session.

    The event is deliberately kept rather than removed: the shipped client emits
    it, and the socket layer's own bookkeeping still wants it -- the
    @socket_login_required decorator refreshes SocketSession.last_activity for
    the connection through get_user_from_socket, which is the DB-side connection
    record and correctly has nothing to do with SSH idle expiry.

    Anything that should keep an SSH session alive without a human must be an
    EXPLICIT exemption the reaper reads (see the persistent/tmux exemption in
    ssh_manager.cleanup_idle_sessions), never a side effect of a heartbeat that
    applies to every user equally.
    """
    return None

@socketio.on('ssh_resize')
@socket_login_required
def handle_ssh_resize(data, current_user=None):
    """Resize what THIS socket's terminal shows.

    One browser socket, one tmux client, one size (see the views note in
    ssh_manager): the size goes to this socket's own view PTY and nowhere else.
    Nothing is broadcast and nothing is answered, because there is no shared
    grid left for other clients to converge on -- tmux decides the pane from the
    attached clients under `window-size smallest`.

    A resize for a session this socket has NO view on is dropped silently. That
    is the ordinary state of a parked or hidden pane, and the client re-attaches
    (`view_attach`) when it becomes visible again rather than proposing a size
    into the void.

    A NON-TMUX session still has exactly one PTY for every tab of the account,
    so there the last resize wins; a plain shell cannot be multiplexed.
    """
    session_id = None
    try:
        session_id = data.get('session_id')
        rows = data.get('rows')
        cols = data.get('cols')

        if not all([session_id, rows, cols]):
            return

        if not verify_session_ownership(session_id, current_user.id):
            return

        ok, error = ssh_manager.resize_session_view(
            session_id, request.sid, cols, rows, socketio_instance=socketio)
        if not ok:
            log_debug("Resize not applied", session_id=session_id, error=error)

    except Exception as e:
        log_debug(f"Resize exception: {e}", session_id=session_id)


@socketio.on('view_attach')
@socket_login_required
def handle_view_attach(data, current_user=None):
    """THIS socket asks to display a session: give it its own tmux client.

    Payload ``{session_id, cols, rows, history}``. Answers `view_attached` on
    success and `view_error` on refusal, both to the asking socket only.

    ORDER MATTERS AND IS GUARANTEED BY THE SOCKET. When `history` is set the
    scrollback chunks are emitted BEFORE the attach is opened, so they reach the
    client ahead of the attach repaint -- socket.io preserves per-connection
    order, so no gate or hold is needed to keep them apart. The history is the
    lines ABOVE the screen; the repaint is the screen.

    `history` is the client's own one-shot flag: it asks for the scrollback the
    first time it attaches to a session on this page, and not on the re-attaches
    that happen every time a pane is hidden and shown.
    """
    session_id = None
    try:
        if not isinstance(data, dict):
            return
        session_id = data.get('session_id')
        if not isinstance(session_id, str) or not session_id:
            return
        if not verify_session_ownership(session_id, current_user.id):
            emit('view_error', {'session_id': session_id,
                                'error': 'Session not found'})
            return

        session = ssh_manager.get_session(session_id) or {}
        use_tmux = bool(session.get('use_tmux'))
        if not use_tmux:
            # A plain shell has one PTY that every tab already receives through
            # the room. Nothing to attach, and saying so is not an error.
            emit('view_attached', {'session_id': session_id,
                                   'shared': True})
            return

        if data.get('history'):
            chunks, meta = prepare_attach_replay(session_id, True)
            if chunks:
                emit_attach_replay(session_id, chunks, meta,
                                   to_sid=request.sid)

        ok, error = ssh_manager.open_session_view(
            session_id, request.sid, data.get('cols'), data.get('rows'),
            socketio, current_app._get_current_object())
        if not ok:
            log_warning("Could not attach a view", session_id=session_id,
                        error=error)
            emit('view_error', {'session_id': session_id, 'error': error})
            return
        emit('view_attached', {'session_id': session_id})
    except Exception as e:
        log_error("view_attach failed", session_id=session_id, error=str(e))
        emit('view_error', {'session_id': session_id,
                            'error': 'Could not attach'})


@socketio.on('view_detach')
@socket_login_required
def handle_view_detach(data, current_user=None):
    """THIS socket stops displaying one or more sessions: drop its tmux clients.

    Payload ``{session_ids: [...]}``. Closing the channel IS the detach, so the
    pane stops constraining `window-size smallest` and another device gets its
    own size back at once. The session keeps running, and the socket may attach
    again whenever the pane becomes visible.

    Ownership is verified per id, and an id this socket has no view on is a
    no-op rather than an error -- the client may legitimately detach twice (a
    hidden tab that is then closed).
    """
    try:
        if not isinstance(data, dict):
            return
        session_ids = data.get('session_ids')
        if not isinstance(session_ids, list):
            single = data.get('session_id')
            session_ids = [single] if single else []
        for session_id in session_ids[:64]:
            if not isinstance(session_id, str) or not session_id:
                continue
            if not verify_session_ownership(session_id, current_user.id):
                continue
            ssh_manager.close_session_view(session_id, request.sid,
                                           reason='client detached',
                                           socketio_instance=socketio)
    except Exception as e:
        log_debug(f"view_detach exception: {e}")


@socketio.on('ssh_disconnect')
@socket_login_required
def handle_ssh_disconnect(data, current_user=None):
    """Close a session: the remote tmux FIRST, the saved row only afterwards.

 (owner: tmux-backed connections must always come back to
    exactly their tmux session, and the code must not leave garbage on the
    host). The old order deleted the persistent row and THEN asked
    close_session to kill the tmux -- which it only does over a live
    transport -- so a dead transport left a tmux session running with no row
    pointing at it: an orphan nobody can reach. Now a LIVE persistent session
    kills its tmux first; if that fails the row stays as a saved session
    (connected=False) and every device is offered it again, so the running
    work is still one Reconnect away.

    A CANDIDATE (no live transport) keeps the documented drop semantics:
    the offer is deleted and nothing on the host is touched -- that is what
    the reset copy promises, and the orphan sweep (tmux_orphans_list) is the
    place such a session can later be closed from.
    """
    try:
        session_id = data.get('session_id')
        if not session_id:
            return

        if not verify_session_ownership(session_id, current_user.id):
            emit('ssh_error', {'error': 'Unauthorized access to session'})
            return

        ssh_session = SSHSession.query.filter_by(session_id=session_id).first()
        host = ssh_session.host if ssh_session else 'unknown'
        port = ssh_session.port if ssh_session else 0
        persistent = bool(ssh_session is not None and ssh_session.is_persistent)
        live = ssh_manager.get_session(session_id) is not None
        killed, kill_error = False, None
        if persistent and live:
            killed, kill_error = ssh_manager.kill_tmux_session(session_id)
        keep_row = persistent and live and not killed
        if ssh_session:
            try:
                if persistent and not keep_row:
                    db.session.delete(ssh_session)
                else:
                    ssh_session.connected = False
                db.session.commit()
            except Exception as db_err:
                db.session.rollback()
                log_error(f"Failed to update SSH session in database",
                          error=str(db_err), session_id=session_id)

        success = ssh_manager.close_session(session_id, kill_tmux=False)
        room = f'user_{current_user.id}'
        if success:
            socketio.emit('ssh_disconnected', {
                'session_id': session_id,
                'reason': 'User requested disconnect'
            }, room=room)
            log_ssh_disconnect(current_user.username, host, port, request.remote_addr, reason='User requested')
        if keep_row:
            log_warning("Session closed but its tmux session could not be "
                        "killed; kept as a saved session",
                        session_id=session_id, host=host, error=kill_error)
            emit('ssh_session_kept', {'session_id': session_id,
                                      'error': kill_error})
            _offer_persistent_session(ssh_session, room)
        elif persistent:
            # The saved row is gone, so no device can offer a reconnect for
            # it any more; the requester retires its own chip on its ack path.
            emit('ssh_session_removed', {'session_id': session_id},
                 room=room, include_self=False)

    except Exception as e:
        emit('ssh_error', {'error': 'Disconnect failed'})


@socketio.on('save_tab_order')
@socket_login_required
def handle_save_tab_order(data, current_user=None):
    """Remember the order the user arranged their session chips in.

    Owner ruling (item C): chips can be dragged into place, and
    the order is the account's, not the device's. Only ids of this user's
    rows are kept, in the order given, capped at 200; a bad payload is
    ignored rather than clearing what was saved.
    """
    order = data.get('order')
    if not isinstance(order, list) or len(order) > 200:
        return
    if not all(isinstance(item, str) and 0 < len(item) <= 64 for item in order):
        return
    own = {row[0] for row in db.session.query(SSHSession.session_id)
           .filter_by(user_id=current_user.id).all()}
    kept = []
    for session_id in order:
        if session_id in own and session_id not in kept:
            kept.append(session_id)
    save_user_settings(current_user.id, {'tab_order': kept})
    emit('tab_order', {'order': kept}, room=f'user_{current_user.id}',
         include_self=False)


@socketio.on('session_pane_index')
@socket_login_required
def handle_session_pane_index(data, current_user=None):
    """Remember which split pane this session sits in (None = no pane).

    Owner ruling: the split is workspace state every device shares,
    so the pane lives on the row (`pane_index`, a column that until now was
    only ever read) and a restore puts the session back exactly there. Only
    the client knows the assignment, so it reports every change; the value is
    bounded by the largest layout (six panes).
    """
    session_id = data.get('session_id')
    pane_index = data.get('pane_index')
    if not isinstance(session_id, str) or not session_id:
        return
    if pane_index is not None and (isinstance(pane_index, bool)
                                   or not isinstance(pane_index, int)
                                   or not 0 <= pane_index < 6):
        return
    if not verify_session_ownership(session_id, current_user.id):
        return
    row = SSHSession.query.filter_by(session_id=session_id).first()
    if row is None or row.pane_index == pane_index:
        return
    try:
        row.pane_index = pane_index
        db.session.commit()
    except Exception as db_err:
        db.session.rollback()
        log_error("Failed to record the session's pane",
                  session_id=session_id, error=str(db_err))


def _known_tmux_names():
    """Every tmux name a saved or live row points at, for ANY user: a name in
    this set belongs to somebody and is never an orphan."""
    return {row[0] for row in db.session.query(SSHSession.tmux_session_name)
            .filter(SSHSession.tmux_session_name.isnot(None)).all()}


@socketio.on('tmux_orphans_list')
@socket_login_required
def handle_tmux_orphans_list(data, current_user=None):
    """List the SSHDeck tmux sessions on this session's host that no row
    points at. Answers `tmux_orphans` or `tmux_orphans_error` to the asker.

    "Orphan" is a JOIN, not a count: the owner keeps several saved sessions
    per host on purpose, and every one of those has a row. Only names with
    SSHDeck's own prefix are listed, so tmux sessions of other tools on the
    same account (another tool, the user's own) are never offered for killing.
    """
    session_id = data.get('session_id')
    if not isinstance(session_id, str) or not session_id:
        return
    if not verify_session_ownership(session_id, current_user.id):
        emit('tmux_orphans_error', {'session_id': session_id,
                                    'error': 'Session not found'})
        return
    live = ssh_manager.get_session(session_id)
    if not live or not live.get('use_tmux'):
        emit('tmux_orphans_error', {'session_id': session_id,
                                    'error': 'Session is not a live tmux session'})
        return
    ok, error, rows = ssh_manager.list_tmux_sessions(session_id)
    if not ok:
        emit('tmux_orphans_error', {'session_id': session_id, 'error': error})
        return
    prefix = f'{config.TMUX_SESSION_PREFIX}_'
    known = _known_tmux_names()
    orphans = [row for row in rows
               if row['name'].startswith(prefix) and row['name'] not in known]
    emit('tmux_orphans', {'session_id': session_id, 'host': live.get('host'),
                          'orphans': orphans, 'checked': len(rows)})


@socketio.on('tmux_orphan_kill')
@socket_login_required
def handle_tmux_orphan_kill(data, current_user=None):
    """Kill ONE orphan by name over this session's transport.

    The name is re-checked against the rows at the moment of the kill, so a
    session that became somebody's (a reconnect landed in between) is refused.
    Answers `tmux_orphan_killed` or `tmux_orphans_error`.
    """
    session_id = data.get('session_id')
    name = data.get('name')
    if not isinstance(session_id, str) or not session_id:
        return
    if not verify_session_ownership(session_id, current_user.id):
        emit('tmux_orphans_error', {'session_id': session_id, 'name': name,
                                    'error': 'Session not found'})
        return
    prefix = f'{config.TMUX_SESSION_PREFIX}_'
    if (not isinstance(name, str) or not ssh_manager.TMUX_SESSION_NAME_RE.match(name)
            or not name.startswith(prefix)):
        emit('tmux_orphans_error', {'session_id': session_id, 'name': name,
                                    'error': 'Invalid tmux session name'})
        return
    if name in _known_tmux_names():
        emit('tmux_orphans_error', {'session_id': session_id, 'name': name,
                                    'error': 'That tmux session belongs to a saved session'})
        return
    ok, error = ssh_manager.kill_tmux_session(session_id, name)
    if not ok:
        emit('tmux_orphans_error', {'session_id': session_id, 'name': name,
                                    'error': error})
        return
    log_info("Orphan tmux session killed", user=current_user.username,
             session_id=session_id, tmux_session=name)
    emit('tmux_orphan_killed', {'session_id': session_id, 'name': name})

@socketio.on('candidate_reset')
@socket_login_required
# Below socket_login_required so the marker is set on the raw function BEFORE
# that decorator reads it. This is the ONLY handler exempt from the non-dict
# Refusal: it echoes request_id on every reply, so it answers a
# malformed frame with a CORRELATED error the generic refusal cannot express --
# and it mutates nothing on that path.
@accepts_raw_payload
def handle_candidate_reset(data, current_user=None):
    """W13-B6: correlated deletion of a persistent session's saved row.

    A candidate has no live transport, so retiring it is purely a database
    act -- and like every database act it must be ATOMIC between the DB and
    the UI. The old retirement rode `ssh_disconnect`, which answered nothing
    about the deletion: the client removed the chip, then emitted, then hoped.
    This handler is the correlated replacement.

    * `session_id` identifies the row; `request_id` is echoed on EVERY reply
      (success AND every error), so the client can act on exactly its own
      answer and never on someone else's -- including the outer exception
      handler, which also carries it.
    * Validation fails closed, before any write: shape, ownership, row
      existence, persistence. A candidate's row is `is_persistent`; a row
      that is not persistent is not a candidate, and deleting it here would
      retire a record a live or ordinary-disconnected session still relies
      on.
    * The deletion is a single transaction: commit, THEN ack. If the commit
      raises, the session rolls back and a correlated error goes out -- the
      row is provably still there, so the client keeping its chip is the
      truthful state.
    * `close_session(kill_tmux=False)` is defensive only: a candidate by
      definition has no entry in the in-RAM registry, so it returns False
      and nothing on the host changes. kill_tmux is deliberately False: a
      row that somehow gained a live entry mid-flight must be closed, never
      have its tmux killed, by a retirement that only promised "SSHDeck
      stops managing the saved offer".

    Emits (all carrying `request_id`):
      candidate_reset_ack   {'ok': True,  'session_id', 'request_id'}
      candidate_reset_error {'error', 'session_id', 'request_id'}
    """
    data = data if isinstance(data, dict) else {}
    request_id = data.get('request_id')
    session_id = data.get('session_id')
    try:
        # The correlated shape, validated before anything else: an answer the
        # client cannot match to a request is worse than no answer at all,
        # so a missing id refuses rather than guessing one.
        if not isinstance(request_id, str) or not request_id:
            emit('candidate_reset_error',
                 {'error': 'Missing request_id', 'session_id': session_id})
            return
        if not isinstance(session_id, str) or not session_id:
            emit('candidate_reset_error',
                 {'error': 'Missing session_id', 'request_id': request_id})
            return

        if not verify_session_ownership(session_id, current_user.id):
            emit('candidate_reset_error',
                 {'error': 'Unauthorized', 'session_id': session_id,
                  'request_id': request_id})
            return

        ssh_session = SSHSession.query.filter_by(session_id=session_id).first()
        if ssh_session is None:
            emit('candidate_reset_error',
                 {'error': 'Session not found', 'session_id': session_id,
                  'request_id': request_id})
            return
        if not ssh_session.is_persistent:
            emit('candidate_reset_error',
                 {'error': 'Not a persistent candidate session',
                  'session_id': session_id, 'request_id': request_id})
            return

        host = ssh_session.host
        port = ssh_session.port
        try:
            db.session.delete(ssh_session)
            db.session.commit()
        except Exception as db_err:
            db.session.rollback()
            log_error("Candidate reset: DB deletion failed",
                      error=str(db_err), session_id=session_id)
            emit('candidate_reset_error',
                 {'error': 'Failed to delete the saved session',
                  'session_id': session_id, 'request_id': request_id})
            return

        # The row is gone for certain; only now may the UI retire it -- on
        # this device by the correlated ack, on every other by the removal.
        ssh_manager.close_session(session_id, kill_tmux=False)
        emit('candidate_reset_ack',
             {'ok': True, 'session_id': session_id, 'request_id': request_id})
        emit('ssh_session_removed', {'session_id': session_id},
             room=f'user_{current_user.id}', include_self=False)
        log_ssh_disconnect(current_user.username, host, port,
                           request.remote_addr,
                           reason='Candidate reset (correlated ack)')

    except Exception as e:
        log_error("Candidate reset failed", error=str(e),
                  session_id=data.get('session_id'))
        emit('candidate_reset_error',
             {'error': 'Candidate reset failed',
              'session_id': data.get('session_id'),
              'request_id': request_id})

@socketio.on('list_profiles')
@socket_login_required
def handle_list_profiles(data=None, current_user=None):
    """Return list of saved connection profiles for this user."""
    try:
        profiles = []
        for stored_profile in profile_manager.load_profiles(current_user.id):
            profile = dict(stored_profile)
            if profile.get('auth_type') == 'tailscale':
                profile['tailscale_authorized'] = (
                    profile_is_authorized_for_launch(current_user, profile)
                )
            profiles.append(profile)
        emit('profiles_list', {'profiles': profiles})
    except Exception as e:
        log_error("Failed to load profiles", error=str(e))
        emit('error', {'error': 'Failed to load profiles'})

@socketio.on('save_profile')
@socket_login_required
def handle_save_profile(data, current_user=None):
    """Create or update a connection profile without starting SSH."""
    try:
        data = data if isinstance(data, dict) else {}
        auth_type = data.get('auth_type')
        host = data.get('host')
        username = data.get('username')

        if auth_type == 'tailscale':
            access_error = validate_tailscale_ssh_access(current_user, host, username)
            if access_error:
                emit('error', {'error': access_error})
                return {'success': False, 'error': access_error}

        profile, error = profile_manager.upsert_profile(current_user.id, data)

        if error:
            emit('error', {'error': error})
            return {'success': False, 'error': error}
        else:
            payload = {'success': True, 'profile': profile}
            emit('profile_saved', payload)
            handle_list_profiles(current_user=current_user)
            return payload

    except Exception as e:
        log_error("Failed to save profile", error=str(e))
        emit('error', {'error': 'Failed to save profile'})
        return {'success': False, 'error': 'Failed to save profile'}

@socketio.on('delete_profile')
@socket_login_required
def handle_delete_profile(data, current_user=None):
    """Delete a connection profile for this user."""
    try:
        profile_id = data.get('profile_id')
        if not profile_id:
            emit('error', {'error': 'Profile ID required'})
            return

        success = profile_manager.delete_profile(current_user.id, profile_id)
        if success:
            emit('profile_deleted', {'profile_id': profile_id})
            handle_list_profiles(current_user=current_user)
        else:
            emit('error', {'error': 'Failed to delete profile'})

    except Exception as e:
        log_error("Failed to delete profile", error=str(e))
        emit('error', {'error': 'Failed to delete profile'})

@socketio.on('list_jump_hosts')
@socket_login_required
def handle_list_jump_hosts(data=None, current_user=None):
    """Return list of saved jump hosts for this user."""
    try:
        emit('jump_hosts_list', {'jump_hosts': jump_host_manager.load_jump_hosts(current_user.id)})
    except Exception as e:
        log_error("Failed to load jump hosts", error=str(e))
        emit('error', {'error': 'Failed to load jump hosts'})

@socketio.on('save_jump_host')
@socket_login_required
def handle_save_jump_host(data, current_user=None):
    """Save a new jump host (bastion) for this user. Never stores a password."""
    try:
        jump_host, error = jump_host_manager.add_jump_host(
            user_id=current_user.id,
            name=data.get('name'),
            host=data.get('host'),
            port=data.get('port', 22),
            username=data.get('username'),
            auth_type=data.get('auth_type'),
            key_id=data.get('key_id')
        )
        if error:
            emit('error', {'error': error})
        else:
            emit('jump_host_saved', {'jump_host': jump_host})
            handle_list_jump_hosts(current_user=current_user)
    except Exception as e:
        log_error("Failed to save jump host", error=str(e))
        emit('error', {'error': 'Failed to save jump host'})

@socketio.on('delete_jump_host')
@socket_login_required
def handle_delete_jump_host(data, current_user=None):
    """Delete a jump host for this user."""
    try:
        jump_host_id = data.get('jump_host_id')
        if not jump_host_id:
            emit('error', {'error': 'Jump host ID required'})
            return
        if jump_host_manager.delete_jump_host(current_user.id, jump_host_id):
            emit('jump_host_deleted', {'jump_host_id': jump_host_id})
            handle_list_jump_hosts(current_user=current_user)
        else:
            emit('error', {'error': 'Failed to delete jump host'})
    except Exception as e:
        log_error("Failed to delete jump host", error=str(e))
        emit('error', {'error': 'Failed to delete jump host'})

@socketio.on('list_keys')
@socket_login_required
def handle_list_keys(data=None, current_user=None):
    """Return list of stored SSH keys for this user."""
    try:
        keys = key_manager.load_key_summaries(current_user.id)
        emit('keys_list', {'keys': keys})
    except Exception as e:
        log_error("Failed to load keys", error=str(e))
        emit('error', {'error': 'Failed to load keys'})

@socketio.on('upload_key')
@socket_login_required
def handle_upload_key(data, current_user=None):
    """Store a new SSH private key for this user."""
    try:
        name = data.get('name')
        key_content = data.get('key_content')

        if not all([name, key_content]):
            emit('error', {'error': 'Name and key content required'})
            return

        # SSH private keys are a few KB at most; reject oversized input outright
        # so a client cannot force large writes to disk.
        if len(name) > 128:
            emit('error', {'error': 'Key name too long (max 128 characters)'})
            return
        if len(key_content) > 64 * 1024:
            emit('error', {'error': 'Key content too large (max 64KB)'})
            return

        key_meta, error = key_manager.save_key(current_user.id, name, key_content)
        if error:
            log_key_upload(current_user.username, name, False, request.remote_addr)
            emit('error', {'error': error})
        else:
            log_key_upload(current_user.username, name, True, request.remote_addr)
            emit('key_uploaded', {'key': key_meta})
            handle_list_keys(current_user=current_user)

    except Exception as e:
        emit('error', {'error': 'Failed to upload key'})

@socketio.on('delete_key')
@socket_login_required
def handle_delete_key(data, current_user=None):
    """Delete an SSH key for this user."""
    try:
        key_id = data.get('key_id')
        if not key_id:
            emit('error', {'error': 'Key ID required'})
            return

        success = key_manager.delete_key(current_user.id, key_id)
        if success:
            log_key_delete(current_user.username, key_id, request.remote_addr)
            emit('key_deleted', {'key_id': key_id})
            handle_list_keys(current_user=current_user)
        else:
            emit('error', {'error': 'Failed to delete key'})

    except Exception as e:
        emit('error', {'error': 'Failed to delete key'})

@socketio.on('upload_file')
@socket_login_required
def handle_upload_file(data, current_user=None):
    """Handle file upload via SFTP."""
    try:
        session_id = data.get('session_id')
        filename = data.get('filename')
        file_data = data.get('file_data')
        remote_path = data.get('remote_path')

        if not all([session_id, filename, file_data, remote_path]):
            emit('error', {'error': 'Missing required fields for file upload'})
            return

        max_size = config.MAX_UPLOAD_SIZE
        estimated_size = len(file_data) * 0.75 if file_data else 0
        if estimated_size > max_size:
            max_mb = max_size // (1024 * 1024)
            emit('error', {'error': f'File too large. Maximum size: {max_mb}MB'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session'})
                return

        file_bytes = base64.b64decode(file_data)

        chunk_size = 65536
        chunks = [file_bytes[i:i+chunk_size] for i in range(0, len(file_bytes), chunk_size)]

        success, error = sftp_handler.upload_file_chunked(
            session_id=session_id,
            filename=filename,
            chunks=chunks,
            remote_path=remote_path,
            socketio_instance=socketio
        )

        if error:
            emit('error', {'error': f'Upload failed: {error}'})
        else:
            log_file_upload(current_user.username, target_host='via-sftp', filename=filename,
                          size=len(file_bytes), success=True, ip_address=request.remote_addr)

    except Exception as e:
        emit('error', {'error': 'Upload failed'})

@socketio.on('download_file')
@socket_login_required
def handle_download_file(data, current_user=None):
    """Handle file download via SFTP."""
    try:
        session_id = data.get('session_id')
        remote_path = data.get('remote_path')

        if not all([session_id, remote_path]):
            emit('error', {'error': 'Missing required fields for file download'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session'})
                return

        result, error = sftp_handler.download_file_chunked(
            session_id=session_id,
            remote_path=remote_path,
            socketio_instance=socketio
        )

        if error:
            emit('error', {'error': f'Download failed: {error}'})
        else:
            file_bytes = b''.join(result['chunks'])
            file_data = base64.b64encode(file_bytes).decode('utf-8')

            emit('file_download_ready', {
                'filename': result['filename'],
                'file_data': file_data,
                'size': result['size']
            })
            log_file_download(current_user.username, target_host='via-sftp', filename=result['filename'],
                            size=result['size'], success=True, ip_address=request.remote_addr)

    except Exception as e:
        emit('error', {'error': 'Download failed'})

@socketio.on('list_directory')
@socket_login_required
def handle_list_directory(data, current_user=None):
    """List files in remote directory."""
    import time as _time
    _t0 = _time.time()
    try:
        session_id = data.get('session_id')
        remote_path = data.get('remote_path', '.')

        if not session_id:
            emit('error', {'error': 'Session ID required'})
            return

        authorized = False
        if verify_session_ownership(session_id, current_user.id):
            authorized = True
        else:
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if conn_info and conn_info['user_id'] == str(current_user.id):
                authorized = True

        _t1 = _time.time()
        if not authorized:
            log_warning(f"list_directory unauthorized", session_id=session_id, user=current_user.username)
            emit('error', {'error': 'Unauthorized access to session'})
            return

        # The dual-pane S2S File Transfer route explicitly selects exec. The
        # single-session Files feature sends no transport flag and keeps its
        # established SFTP behavior unchanged.
        transport = data.get('transport')
        if transport not in (None, 'sftp', 'exec'):
            emit('error', {'error': 'Invalid listing transport'})
            return
        if transport == 'exec':
            files, error = sftp_handler.list_directory_exec(
                session_id, remote_path)
        else:
            files, error = sftp_handler.list_directory(session_id, remote_path)
        _t2 = _time.time()

        if error:
            log_warning(f"list_directory failed", path=remote_path, error=error,
                       auth_ms=int((_t1-_t0)*1000), sftp_ms=int((_t2-_t1)*1000))
            emit('error', {'error': f'Failed to list directory: {error}'})
        else:
            log_info(f"list_directory OK", path=remote_path, files=len(files),
                    auth_ms=int((_t1-_t0)*1000), sftp_ms=int((_t2-_t1)*1000))
            emit('directory_listing', {
                'session_id': session_id,
                'path': remote_path,
                'files': files
            })

    except Exception as e:
        log_error(f"list_directory exception", error=str(e), elapsed_ms=int((_time.time()-_t0)*1000))
        emit('error', {'error': 'Failed to list directory'})

@socketio.on('get_sessions')
@socket_login_required
def handle_get_sessions(data=None, current_user=None):
    """Get list of active SSH sessions for this user."""
    try:
        db_sessions = SSHSession.query.filter_by(user_id=current_user.id, connected=True).all()

        sessions = []
        for db_session in db_sessions:
            session = ssh_manager.get_session(db_session.session_id)
            if session and session.get('connected'):
                sessions.append(_build_session_snapshot(db_session.session_id, db_session))

        emit('sessions_list', {'sessions': sessions})
    except Exception as e:
        log_error("Failed to get sessions", error=str(e))
        emit('error', {'error': 'Failed to get sessions'})

@socketio.on('set_theme')
@socket_login_required
def handle_set_theme(data, current_user=None):
    """Persist theme selection for the current user."""
    try:
        theme = data.get('theme')
        if theme not in VALID_THEMES:
            emit('error', {'error': 'Invalid theme'})
            return

        success = save_user_settings(current_user.id, {'theme': theme})
        if success:
            emit('theme_updated', {'theme': theme})
        else:
            emit('error', {'error': 'Failed to save theme'})
    except Exception as e:
        log_error("Failed to save theme", error=str(e))
        emit('error', {'error': 'Failed to save theme'})

@socketio.on('get_notepad')
@socket_login_required
def handle_get_notepad(data=None, current_user=None):
    """Return the persisted notepad text AND revision for the current user and scope.

    S17 D2, two defects fixed here.

    1. The EFFECTIVE mode is echoed, not the requested one. A ``per_server``
       request carrying no ``target_id`` cannot address a per-server bucket, so
       ``get_notepad`` reads the GLOBAL note -- and this handler used to label
       that reply ``per_server``. The client's adoptNotepadFrame matches on the
       label, so it accepted global text as per-server content: silent data
       mislabelling. The label now names the bucket that was actually read.
    2. A request with NO mode means "tell me the scope I chose". The client sends
       exactly that on connect (app.js `socket.emit('get_notepad')`), so the
       persisted ``notepad_mode`` is resolved here and returned, which is what
       lets the panel come back on Per-server after a reload instead of always
       landing on Global.
    3. S17 D2: every frame also carries ``stored_mode`` -- the raw persisted
       preference, independent of the resolution used for content. It must ride
       separately because the EFFECTIVE mode legitimately collapses to
       'global' whenever no ``target_id`` is bound (per-server needs a target
       to address), and connect time is exactly that state; a client keying
       restoration off the effective mode could therefore never restore
       per_server. The label still names the bucket actually read.
    """
    try:
        payload = data if isinstance(data, dict) else {}
        # Absent key means "no preference"; an explicit value still wins.
        requested_mode = payload.get('mode')
        target_id = payload.get('target_id')
        stored_mode = stored_notepad_mode(current_user.id)
        mode = effective_notepad_mode(requested_mode, stored_mode, target_id)
        text, revision = get_notepad(current_user.id, mode=mode, target_id=target_id)
        emit('notepad_data', {
            'notepad': text,
            'revision': revision,
            'mode': mode,
            'stored_mode': stored_mode,
            'target_id': target_id,
        })
    except Exception as e:
        log_error("Failed to load notepad", error=str(e))
        emit('error', {'error': 'Failed to load notepad'})

@socketio.on('save_notepad')
@socket_login_required
def handle_save_notepad(data, current_user=None):
    """Persist the notepad text with the revision/conflict contract.

    Item 2: the notepad used to be one global
    last-write-wins key that could resurrect deleted text across devices. The
    revision guard fixed that; the ``base_revision`` on every save is what a
    stale device is refused against.

    Redesigned to kill the self-echo round trip. The SAVER learns
    the outcome through the socket.io ACK -- the value this handler RETURNS --
    and never through a broadcast back to itself. Echoing the save to the saver
    was the jank: the saver's own frame overwrote its ``.value`` and clamped the
    caret while the user was still typing. Now:

    * the write's result is RETURNED to the caller's ack:
      ``{'applied': True,  'notepad', 'revision', 'mode', 'target_id'}`` on a
      write, or ``{'applied': False, ...}`` carrying the server truth when the
      ``base_revision`` was stale (the saver adopts it -- no separate
      ``notepad_conflict`` event, no round trip);
    * OTHER devices still converge via a ``notepad_updated`` broadcast, but the
      saver is excluded with ``skip_sid`` so its box is never rewritten by its
      own keystroke;
    * a save WITHOUT ``base_revision`` (pre-upgrade clients) still applies as
      last-write-wins; such a client simply ignores the ack it did not request.
    """
    try:
        text = data.get('text', '')
        if len(text) > 100000:
            return {'error': 'Notepad content too large (max 100KB)'}

        base_revision = data.get('base_revision')
        mode = data.get('mode', 'global')
        target_id = data.get('target_id')
        ok, result = save_notepad_revision(current_user.id, text, base_revision, mode=mode, target_id=target_id)
        if not ok:
            return {'error': 'Failed to save notepad'}

        payload = {
            'applied': result['applied'],
            'notepad': result['notepad'],
            'revision': result['revision'],
            'mode': result.get('mode', mode),
            'target_id': result.get('target_id', target_id),
        }
        if result['applied']:
            # Converge every OTHER device; skip_sid excludes the saver so its
            # own save can never echo back to overwrite its box or caret.
            emit('notepad_updated', payload, room=f'user_{current_user.id}',
                 skip_sid=request.sid)
        # The saver gets the result -- applied or stale -- through the ack.
        return payload
    except Exception as e:
        log_error("Failed to save notepad", error=str(e))
        return {'error': 'Failed to save notepad'}


@socketio.on('get_terminal_line')
@socket_login_required
def handle_get_terminal_line(data, current_user=None):
    """Answer with the shell's current pending input line for one session.

    S14-5: the composer must resolve toward the TERMINAL's truth when a
    session reopens. Ownership is checked BEFORE any tmux command runs — the
    same verify_session_ownership gate every session-scoped handler uses — so
    a foreign session id is refused without touching that session's transport.

    A refusal is its own frame (`terminal_line_unavailable` with a reason),
    never an empty `terminal_line_data`: an empty line would read as "the
    shell's line is empty" and could wrongly release the composer's lock.

    """
    payload = data if isinstance(data, dict) else {}
    session_id = payload.get('session_id')
    if not isinstance(session_id, str) or not session_id:
        emit('terminal_line_unavailable', {
            'session_id': session_id if isinstance(session_id, str) else None,
            'reason': 'Missing or invalid session_id',
        })
        return

    if not verify_session_ownership(session_id, current_user.id):
        emit('error', {'error': 'Unauthorized access to session'})
        return

    ok, reason, pending = ssh_manager.read_tmux_pending_line(session_id)
    if not ok:
        emit('terminal_line_unavailable',
             {'session_id': session_id, 'reason': reason})
        return
    emit('terminal_line_data', {
        'session_id': session_id,
        'line': pending['line'],
        'cursor_x': pending['cursor_x'],
        'cursor_y': pending['cursor_y'],
    })

@socketio.on('kbdebug_log')
@socket_login_required
def handle_kbdebug_log(data, current_user=None):
    """Record what a browser's keyboard really reported (`?kbdebug=1`).

    The Safari + Vietnamese IME defect exists on one machine with one input
    method, so the only way to see it from here is to have that browser say
    what it observed. The overlay paints the same lines on screen; this is the
    copy that reaches the server log, so diagnosing it costs the owner three
    keystrokes instead of a screenshot.

    Bounded and inert by default: the client only emits while the query
    parameter is present, at most 40 lines per batch, and each line is
    truncated. Nothing is stored.
    """
    payload = data if isinstance(data, dict) else {}
    lines = payload.get('lines')
    if not isinstance(lines, list):
        return
    agent = str(payload.get('agent', ''))[:200]
    for line in lines[:40]:
        log_info("kbdebug", user=current_user.username, agent=agent,
                 line=str(line)[:400])


SCREEN_DIAGNOSTIC_TAIL_MAX = 65536
SCREEN_DIAGNOSTIC_ROWS_MAX = 500
SCREEN_DIAGNOSTIC_ROW_CHARS = 1024
SCREEN_DIAGNOSTIC_RATELIMIT = '6 per minute'
_SCREEN_DIAGNOSTIC_NUMBERS = ('cols', 'rows', 'baseY', 'viewportY', 'cursorX',
                              'cursorY', 'fontSize', 'letterSpacing',
                              'lineHeight', 'tailChars')
_SCREEN_DIAGNOSTIC_STRINGS = ('buffer', 'unicode', 'view', 'agent', 'href')


def _bounded_engine_report(engine):
    """Keep only the fields the diagnostic knows, each at a bounded size.

    The report is written to disk under the account's name, so it is shaped
    here rather than trusted: numbers as numbers, a handful of short strings,
    two small geometry objects, and the visible rows capped in count and in
    width. Anything else the client sends is dropped.
    """
    out = {}
    for key in _SCREEN_DIAGNOSTIC_NUMBERS:
        value = engine.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = value
    for key in _SCREEN_DIAGNOSTIC_STRINGS:
        value = engine.get(key)
        if isinstance(value, str):
            out[key] = value[:200]
    for key in ('window', 'reported'):
        value = engine.get(key)
        if isinstance(value, dict):
            out[key] = {k: value[k] for k in ('cols', 'rows')
                        if isinstance(value.get(k), int)}
    rows = engine.get('screen')
    if isinstance(rows, list):
        out['screen'] = [str(r)[:SCREEN_DIAGNOSTIC_ROW_CHARS]
                         for r in rows[:SCREEN_DIAGNOSTIC_ROWS_MAX]]
    return out


def _screen_diagnostic_path(username, session_id):
    stem = re.sub(r'[^A-Za-z0-9_-]', '_', str(username))[:40] or 'user'
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder = Path(config.DATA_DIR) / 'diagnostics'
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f'screen-{stem}-{session_id[:8]}-{stamp}.json'


@socketio.on('screen_diagnostic')
@socket_login_required
def handle_screen_diagnostic(data, current_user=None):
    """Save what a browser saw of one session next to what tmux holds.

    Owner,: the omp pane showed the prompt row fifty times while
    the host pane held one, and nothing had recorded the bytes the browser
    was given, so the defect could not be replayed. The client now keeps the
    last 64 KB of each session's stream; on request (the `?kbdebug=1`
    button) it sends that tail with the engine's own state, and this handler
    puts it in one file with the pane as tmux holds it at the same moment.
    Replaying the tail into a bare engine against that pane is the whole
    reproduction.

    Bounded on every axis: the tail is cut to 64 KB, the engine report to
    known fields (see _bounded_engine_report), the tmux captures to 256 KB,
    six requests per user per minute, and only sessions the account owns.
    """
    session_id = data.get('session_id')
    if not isinstance(session_id, str) or not session_id:
        emit('screen_diagnostic_saved', {'error': 'no_session'})
        return
    if not verify_session_ownership(session_id, current_user.id):
        emit('screen_diagnostic_saved', {'session_id': session_id,
                                         'error': 'not_owned'})
        return
    if check_socket_rate_limit(current_user.id, 'screen_diagnostic',
                               SCREEN_DIAGNOSTIC_RATELIMIT):
        emit('screen_diagnostic_saved', {'session_id': session_id,
                                         'error': 'rate_limited'})
        return
    tail = data.get('tail')
    tail = tail[-SCREEN_DIAGNOSTIC_TAIL_MAX:] if isinstance(tail, str) else ''
    engine = data.get('engine')
    engine = _bounded_engine_report(engine if isinstance(engine, dict) else {})
    host = ssh_manager.capture_screen_for_diagnostic(session_id)
    record = {
        'version': 1,
        'saved_at': datetime.now(timezone.utc).isoformat(),
        'user': current_user.username,
        'session_id': session_id,
        'engine': engine,
        'tail': tail,
        'host': host,
    }
    try:
        path = _screen_diagnostic_path(current_user.username, session_id)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(record, fh, ensure_ascii=False)
        os.chmod(path, 0o600)
    except OSError as exc:
        log_warning("screen-diagnostic not saved", user=current_user.username,
                    session_id=session_id, error=str(exc))
        emit('screen_diagnostic_saved', {'session_id': session_id,
                                         'error': 'not_saved'})
        return
    host_rows = len(host.get('screen') or []) if isinstance(host, dict) else 0
    log_info("screen-diagnostic saved", user=current_user.username,
             session_id=session_id, path=str(path), tail_chars=len(tail),
             engine_rows=len(engine.get('screen') or []), host_rows=host_rows)
    emit('screen_diagnostic_saved', {'session_id': session_id,
                                     'name': path.name,
                                     'host_rows': host_rows})


@socketio.on('list_commands')
@socket_login_required
def handle_list_commands(data, current_user=None):
    """Return list of commands (system + user) filtered by OS."""
    try:
        from . import command_manager

        os_filter = data.get('os_filter')

        commands = command_manager.get_all_commands(current_user.id, os_filter)
        emit('commands_list', {'commands': commands})
    except Exception as e:
        log_error("Failed to load commands", error=str(e))
        emit('error', {'error': 'Failed to load commands'})

@socketio.on('add_command')
@socket_login_required
def handle_add_command(data, current_user=None):
    """Add a new user command."""
    try:
        from . import command_manager

        name = data.get('name')
        command = data.get('command')
        parameters = data.get('parameters', '')
        description = data.get('description')
        os_list = data.get('os', ['all'])
        category = data.get('category', 'custom')

        if not all([name, command, description]):
            emit('error', {'error': 'Name, command, and description are required'})
            return

        new_cmd = command_manager.add_user_command(
            current_user.id, name, command, parameters, description, os_list, category
        )
        if not new_cmd:
            emit('error', {'error': 'Failed to add command'})
            return {'success': False, 'error': 'Failed to add command'}

        emit('command_added', {'command': new_cmd})
        handle_list_commands({}, current_user=current_user)
        return {'success': True, 'command': new_cmd}

    except Exception as e:
        log_error("Failed to add command", error=str(e))
        emit('error', {'error': 'Failed to add command'})
        return {'success': False, 'error': 'Failed to add command'}

@socketio.on('update_command')
@socket_login_required
def handle_update_command(data, current_user=None):
    """Update an existing user command."""
    try:
        from . import command_manager

        command_id = data.get('command_id')
        name = data.get('name')
        command = data.get('command')
        parameters = data.get('parameters', '')
        description = data.get('description')
        os_list = data.get('os', ['all'])
        category = data.get('category', 'custom')

        if not all([command_id, name, command, description]):
            emit('error', {'error': 'Command ID, name, command, and description are required'})
            return

        success = command_manager.update_user_command(
            current_user.id, command_id, name, command, parameters, description, os_list, category
        )

        if success:
            emit('command_updated', {'command_id': command_id})
            handle_list_commands({}, current_user=current_user)
        else:
            emit('error', {'error': 'Failed to update command'})

    except Exception as e:
        log_error("Failed to update command", error=str(e))
        emit('error', {'error': 'Failed to update command'})

@socketio.on('delete_command')
@socket_login_required
def handle_delete_command(data, current_user=None):
    """Delete a user command."""
    try:
        from . import command_manager

        command_id = data.get('command_id')
        if not command_id:
            emit('error', {'error': 'Command ID required'})
            return

        success, error, usages = command_manager.delete_user_command(current_user.id, command_id)
        if success:
            emit('command_deleted', {'command_id': command_id})
            handle_list_commands({}, current_user=current_user)
            return {'success': True, 'command_id': command_id}
        else:
            payload = {
                'success': False,
                'error': error or 'Failed to delete command',
                'code': 'in_use' if usages else 'delete_failed',
            }
            if usages:
                payload['usages'] = usages
            emit('error', payload)
            return payload

    except Exception as e:
        log_error("Failed to delete command", error=str(e))
        emit('error', {'error': 'Failed to delete command'})


def _command_set_error(error, usages=None):
    if usages:
        code = 'in_use'
    elif error in ('Command set not found', 'Profile not found'):
        code = 'not_found'
    elif error and 'unreadable' in error:
        code = 'storage_error'
    else:
        code = 'validation_error'
    payload = {'success': False, 'error': error, 'code': code}
    if usages:
        payload['usages'] = usages
    emit('error', payload)
    return payload


@socketio.on('list_command_sets')
@socket_login_required
def handle_list_command_sets(data=None, current_user=None):
    """Return all named command sets owned by the current user."""
    from . import command_set_manager

    command_sets, error = command_set_manager.load_command_sets_with_resolution(
        current_user.id
    )
    if error:
        return _command_set_error(error)
    payload = {'success': True, 'command_sets': command_sets}
    emit('command_sets_list', payload)
    return payload


@socketio.on('save_command_set')
@socket_login_required
def handle_save_command_set(data, current_user=None):
    """Create or update a named command set."""
    from . import command_set_manager

    command_set, error = command_set_manager.upsert_command_set(current_user.id, data)
    if error:
        return _command_set_error(error)
    payload = {'success': True, 'command_set': command_set}
    emit('command_set_saved', payload)
    handle_list_command_sets(current_user=current_user)
    return payload


@socketio.on('duplicate_command_set')
@socket_login_required
def handle_duplicate_command_set(data, current_user=None):
    """Duplicate one of the current user's command sets."""
    from . import command_set_manager

    data = data if isinstance(data, dict) else {}
    command_set, error = command_set_manager.duplicate_command_set(
        current_user.id, data.get('command_set_id')
    )
    if error:
        return _command_set_error(error)
    payload = {'success': True, 'command_set': command_set}
    emit('command_set_saved', payload)
    handle_list_command_sets(current_user=current_user)
    return payload


@socketio.on('delete_command_set')
@socket_login_required
def handle_delete_command_set(data, current_user=None):
    """Delete an unused command set."""
    from . import command_set_manager

    data = data if isinstance(data, dict) else {}
    command_set_id = data.get('command_set_id')
    success, error, usages = command_set_manager.delete_command_set(
        current_user.id, command_set_id
    )
    if not success:
        return _command_set_error(error, usages)
    payload = {'success': True, 'command_set_id': command_set_id}
    emit('command_set_deleted', payload)
    handle_list_command_sets(current_user=current_user)
    return payload


@socketio.on('convert_legacy_command_set')
@socket_login_required
def handle_convert_legacy_command_set(data, current_user=None):
    """Convert one profile's legacy startup text into a named command set."""
    from . import command_set_manager

    data = data if isinstance(data, dict) else {}
    profile = profile_manager.get_profile(current_user.id, data.get('profile_id'))
    if not profile:
        return _command_set_error('Profile not found')
    if profile.get('command_set_id'):
        return _command_set_error('Profile already uses a command set')
    legacy_commands = profile.get('startup_commands')
    if not isinstance(legacy_commands, str) or not legacy_commands.strip():
        return _command_set_error('Profile has no legacy startup commands')

    command_set, error = command_set_manager.upsert_command_set(current_user.id, {
        'name': data.get('name'),
        'description': data.get('description', ''),
        'use_sudo': False,
        'steps': [{'type': 'inline', 'command': legacy_commands}],
    })
    if error:
        return _command_set_error(error)

    updated_profile, error = profile_manager.assign_command_set(
        current_user.id, profile['id'], command_set['id']
    )
    if error:
        return _command_set_error(error)
    payload = {
        'success': True,
        'command_set': command_set,
        'profile': updated_profile,
    }
    emit('command_set_converted', payload)
    handle_list_command_sets(current_user=current_user)
    handle_list_profiles(current_user=current_user)
    return payload

@socketio.on('detect_os')
@socket_login_required
def handle_detect_os(data, current_user=None):
    """OS detection disabled to avoid terminal noise."""
    emit('error', {'error': 'OS detection is disabled'})

@socketio.on('save_session_name')
@socket_login_required
def handle_save_session_name(data, current_user=None):
    """Save session display name to database."""
    try:
        session_id = data.get('session_id')
        display_name = data.get('display_name')
        if display_name:
            display_name = display_name.strip()[:128] or None
        if not session_id:
            return
        ssh_session = SSHSession.query.filter_by(
            session_id=session_id, user_id=current_user.id
        ).first()
        if ssh_session:
            ssh_session.display_name = display_name if display_name else None
            db.session.commit()
    except Exception as e:
        db.session.rollback()
        log_error("Failed to save session name", error=str(e))

@socketio.on('session_latency')
@socket_login_required
def handle_session_latency(data, current_user=None):
    """Per-session SSH round-trip time for the chip's <small> line.

    Mockup line 87: each desktop chip reads "root · 34 ms". The status bar's
    figure is browser<->SSHDeck and is the same for every chip, so the number
    has to be measured on each session's own transport.

    Ownership is verified exactly as every other session-scoped handler does,
    so one user can never probe another's session. Only the session id and an
    integer millisecond figure are ever emitted -- no host, credential, or
    transport detail.
    """
    session_id = None
    try:
        session_id = (data or {}).get('session_id')
        if not session_id:
            return
        if not verify_session_ownership(session_id, current_user.id):
            return
        latency = ssh_manager.measure_session_latency(session_id)
        emit('session_latency', {
            'session_id': session_id,
            'latency_ms': latency,
        })
    except Exception as e:
        log_debug(f"Latency handler error: {e}", session_id=session_id)


def verify_session_ownership(session_id, user_id):
    """
    Verify that a session belongs to a user.

    Checks in-memory sessions first (fast path), then falls back to database.
    The DB query is done outside the lock to avoid blocking the SSH output reader.
    """
    if not session_id or not user_id:
        return False

    user_id_str = str(user_id)

    with ssh_manager.sessions_lock:
        session = ssh_manager.sessions.get(session_id)
        if session and session.get('user_id') is not None:
            return str(session.get('user_id')) == user_id_str

    ssh_session = SSHSession.query.filter_by(session_id=session_id).first()
    if ssh_session is not None:
        return str(ssh_session.user_id) == user_id_str

    return False

@socketio.on('upload_file_binary')
@socket_login_required
def handle_upload_file_binary(data, current_user=None):
    """Handle binary file upload (no base64 encoding)."""
    try:
        session_id = data.get('session_id')
        filename = data.get('filename')
        file_data = data.get('file_data')
        remote_path = data.get('remote_path')

        if not all([session_id, filename, file_data, remote_path]):
            emit('error', {'error': 'Missing required fields for binary upload'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session/connection'})
                return

        success, error = binary_transfer.handle_binary_upload(
            session_id=session_id,
            filename=filename,
            binary_data=file_data,
            remote_path=remote_path,
            socketio_instance=socketio
        )

        if error:
            emit('error', {'error': f'Upload failed: {error}'})
        else:
            log_file_upload(current_user.username, target_host='via-sftp', filename=filename,
                          size=len(file_data), success=True, ip_address=request.remote_addr)

    except Exception as e:
        emit('error', {'error': 'Upload failed'})

@socketio.on('download_file_binary')
@socket_login_required
def handle_download_file_binary(data, current_user=None):
    """Handle binary file download (no base64 encoding)."""
    try:
        session_id = data.get('session_id')
        remote_path = data.get('remote_path')
        for_preview = data.get('for_preview', False)

        if not all([session_id, remote_path]):
            emit('error', {'error': 'Missing required fields for binary download'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session/connection'})
                return

        binary_data, error = binary_transfer.handle_binary_download(
            session_id=session_id,
            remote_path=remote_path,
            socketio_instance=socketio
        )

        if error:
            emit('error', {'error': f'Download failed: {error}'})
        else:
            import os
            import base64
            filename = os.path.basename(remote_path)

            if for_preview:
                encoded_data = base64.b64encode(binary_data).decode('ascii')
                emit('file_download_ready_binary', {
                    'session_id': session_id,
                    'filename': filename,
                    'file_data': encoded_data,
                    'size': len(binary_data),
                    'for_preview': True,
                    'encoding': 'base64'
                })
            else:
                emit('file_download_ready_binary', {
                    'session_id': session_id,
                    'filename': filename,
                    'file_data': binary_data,
                    'size': len(binary_data),
                    'for_preview': False
                })
            log_file_download(current_user.username, target_host='via-sftp', filename=filename,
                            size=len(binary_data), success=True, ip_address=request.remote_addr)

    except Exception as e:
        emit('error', {'error': 'Download failed'})

@socketio.on('download_folder_binary')
@socket_login_required
def handle_download_folder_binary(data, current_user=None):
    """Handle folder download as ZIP archive."""
    try:
        import zipfile
        import tempfile
        import os

        session_id = data.get('session_id')
        remote_path = data.get('remote_path')

        if not all([session_id, remote_path]):
            emit('error', {'error': 'Missing required fields for folder download'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session/connection'})
                return

        _sftp_lock = sftp_handler._get_sftp_lock(session_id)
        _sftp_lock.acquire()
        try:
            sftp, error, source_type = sftp_handler.get_any_sftp_client(session_id)
        except Exception as e:
            _sftp_lock.release()
            log_error("SFTP client error", error=str(e))
            emit('error', {'error': 'SFTP operation failed'})
            return
        if error:
            _sftp_lock.release()
            emit('error', {'error': error})
            return

        safe_path = sftp_handler.sanitize_path(remote_path)
        if safe_path is None:
            _sftp_lock.release()
            emit('error', {'error': 'Invalid remote path'})
            return

        try:
            file_stat = sftp.stat(safe_path)
            import stat
            if not stat.S_ISDIR(file_stat.st_mode):
                _sftp_lock.release()
                emit('error', {'error': 'Path is not a directory'})
                return
        except FileNotFoundError:
            _sftp_lock.release()
            emit('error', {'error': 'Remote directory not found'})
            return
        except Exception as e:
            # Any other stat failure (permission, broken channel) must still
            # release the held per-session Lock or every later SFTP operation
            # on this session deadlocks.
            _sftp_lock.release()
            log_error("Folder download stat failed", error=str(e))
            emit('error', {'error': 'Folder download failed'})
            return

        folder_name = os.path.basename(safe_path.rstrip('/'))

        def is_safe_for_shell(path):
            """Validate path is safe for shell command use (defense in depth)."""
            if not path:
                return False
            dangerous_chars = ['\n', '\r', '\x00', '`', '$', '|', ';', '&']
            return not any(c in path for c in dangerous_chars)

        remote_zip_path = f"/tmp/{folder_name}_{os.urandom(8).hex()}.zip"

        try:
            ssh_client = sftp._client if hasattr(sftp, '_client') else None
            if ssh_client and is_safe_for_shell(safe_path):
                import shlex
                parent_dir = os.path.dirname(safe_path)
                base_name = os.path.basename(safe_path)

                if not (is_safe_for_shell(parent_dir) and is_safe_for_shell(base_name)):
                    raise ValueError("Path contains unsafe characters")

                zip_command = f"cd {shlex.quote(parent_dir)} && zip -r -q {shlex.quote(remote_zip_path)} {shlex.quote(base_name)}"

                stdin, stdout, stderr = ssh_client.exec_command(zip_command)
                stdout.channel.settimeout(300)
                exit_code = stdout.channel.recv_exit_status()

                if exit_code == 0:
                    log_debug(f"Remote ZIP created: {remote_zip_path}")

                    zip_path = None
                    remote_completed = False
                    try:
                        remote_zip_stat = sftp.stat(remote_zip_path)
                        remote_zip_size = getattr(remote_zip_stat, 'st_size', None)
                        if (remote_zip_size is not None and
                                remote_zip_size > config.MAX_ZIP_DOWNLOAD_SIZE):
                            raise DownloadSizeLimitExceeded(
                                'remote ZIP exceeds configured size limit'
                            )

                        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False, mode='wb') as tmp_zip:
                            zip_path = tmp_zip.name
                            os.chmod(zip_path, 0o600)
                            with sftp.file(remote_zip_path, 'rb') as remote_file:
                                _copy_file_with_limit(
                                    remote_file,
                                    tmp_zip,
                                    config.MAX_ZIP_DOWNLOAD_SIZE,
                                )

                        with open(zip_path, 'rb') as f:
                            zip_data = f.read()

                        emit('file_download_ready_binary', {
                            'session_id': session_id,
                            'filename': f"{folder_name}.zip",
                            'file_data': zip_data,
                            'size': len(zip_data),
                            'for_preview': False
                        })

                        log_info(f"Folder download (remote): {folder_name}.zip", user=current_user.username)
                        remote_completed = True
                    except DownloadSizeLimitExceeded:
                        remote_completed = True
                        log_warning(
                            "Remote ZIP download rejected by size limit",
                            user=current_user.username,
                            path=safe_path,
                            max_size=config.MAX_ZIP_DOWNLOAD_SIZE,
                        )
                        emit('error', {
                            'error': 'ZIP archive exceeds the maximum allowed download size'
                        })
                    finally:
                        if zip_path and os.path.exists(zip_path):
                            try:
                                os.unlink(zip_path)
                            except Exception as cleanup_err:
                                log_warning(f"Failed to cleanup temp file", path=zip_path, error=str(cleanup_err))

                        try:
                            sftp.remove(remote_zip_path)
                        except Exception as remote_cleanup_err:
                            log_warning(f"Failed to cleanup remote ZIP", path=remote_zip_path, error=str(remote_cleanup_err))

                        if remote_completed and source_type == 'pool':
                            sftp.close()

                    if remote_completed:
                        _sftp_lock.release()
                        return
                else:
                    log_debug(f"Remote zip command failed, falling back to SFTP method")

        except Exception as e:
            log_debug(f"Remote ZIP creation failed, falling back to SFTP method", error=str(e))

        zip_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.zip', delete=False, mode='wb') as tmp_zip:
                zip_path = tmp_zip.name
            os.chmod(zip_path, 0o600)

            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zipf:
                file_count = 0
                error_count = 0

                cumulative_size = 0
                max_zip_size = config.MAX_ZIP_DOWNLOAD_SIZE

                def add_folder_to_zip(sftp_client, remote_folder, zip_prefix='', depth=0):
                    """Recursively add folder contents to ZIP."""
                    nonlocal file_count, error_count, cumulative_size

                    if depth > 50:
                        log_warning(f"Maximum recursion depth exceeded in folder download: {remote_folder}")
                        error_count += 1
                        return

                    try:
                        items = sftp_client.listdir_attr(remote_folder)

                        if not items and zip_prefix:
                            zipf.writestr(zip_prefix + '/', '')

                        for item in items:
                            item_path = f"{remote_folder}/{item.filename}"
                            zip_item_path = f"{zip_prefix}/{item.filename}" if zip_prefix else item.filename

                            try:
                                try:
                                    item_lstat = sftp_client.lstat(item_path)
                                except Exception:
                                    item_lstat = item

                                if stat.S_ISLNK(item_lstat.st_mode):
                                    log_debug(f"Skipping symlink in ZIP download: {item_path}")
                                    continue

                                if stat.S_ISDIR(item_lstat.st_mode):
                                    zipf.writestr(zip_item_path + '/', '')
                                    add_folder_to_zip(sftp_client, item_path, zip_item_path, depth + 1)
                                else:
                                    # Enforce the size limit using the file's stat
                                    # size BEFORE reading it, so a single huge file
                                    # cannot be pulled entirely into memory first.
                                    file_size = item_lstat.st_size or 0
                                    if cumulative_size + file_size > max_zip_size:
                                        max_mb = max_zip_size // (1024 * 1024)
                                        raise ValueError(f"Folder exceeds maximum download size ({max_mb}MB)")
                                    with sftp_client.file(item_path, 'rb') as remote_file:
                                        file_data = remote_file.read()
                                        cumulative_size += len(file_data)
                                        if cumulative_size > max_zip_size:
                                            max_mb = max_zip_size // (1024 * 1024)
                                            raise ValueError(f"Folder exceeds maximum download size ({max_mb}MB)")
                                        zipf.writestr(zip_item_path, file_data)
                                    file_count += 1
                            except ValueError:
                                raise
                            except Exception as item_error:
                                error_count += 1
                                log_debug(f"Error adding {item_path}", error=str(item_error))

                    except ValueError:
                        raise
                    except Exception as e:
                        log_error(f"Error reading directory {remote_folder}", error=str(e))
                        raise

                log_debug(f"Starting folder download: {folder_name} from {safe_path}")
                add_folder_to_zip(sftp, safe_path, folder_name)
                log_debug(f"Added {file_count} files to ZIP ({error_count} errors)")

            with open(zip_path, 'rb') as f:
                zip_data = f.read()

            emit('file_download_ready_binary', {
                'session_id': session_id,
                'filename': f"{folder_name}.zip",
                'file_data': zip_data,
                'size': len(zip_data),
                'for_preview': False
            })

            log_info(f"Folder download: {folder_name}.zip", user=current_user.username)

        finally:
            if zip_path and os.path.exists(zip_path):
                try:
                    os.unlink(zip_path)
                except Exception as cleanup_err:
                    log_warning(f"Failed to cleanup temp file", path=zip_path, error=str(cleanup_err))

            if source_type == 'pool':
                sftp.close()

            _sftp_lock.release()

    except Exception as e:
        log_error("Folder download failed", error=str(e))
        emit('error', {'error': 'Folder download failed'})

@socketio.on('quick_connect')
@socket_login_required
def handle_quick_connect(data, current_user=None):
    """Create temporary SSH connection for file transfers without active session."""
    try:
        if check_socket_rate_limit(current_user.id, 'ssh_connect', config.RATELIMIT_SSH_CONNECT):
            log_warning("Quick connect rate limit hit", user=current_user.username)
            emit('quick_connect_error', {'error': 'Too many connection attempts. Please wait a moment.'})
            return

        password = data.get('password')
        key_id = data.get('key_id')

        host, port, username, error = _validate_ssh_params(
            data.get('host'), data.get('port', 22), data.get('username')
        )
        if error:
            emit('quick_connect_error', {'error': error})
            return

        if not password and not key_id:
            emit('quick_connect_error', {'error': 'Password or SSH key required'})
            return

        key_content = None
        if key_id:
            key_content, key_error = key_manager.read_key_content(current_user.id, key_id)
            if key_error:
                emit('quick_connect_error', {'error': f'SSH key error: {key_error}'})
                return

        connection_id, error = connection_pool.temp_connection_pool.create_connection(
            host=host,
            port=port,
            username=username,
            password=password,
            key_content=key_content,
            user_id=str(current_user.id)
        )

        if password:
            password = None
        if key_content:
            key_content = None

        if error:
            emit('quick_connect_error', {'error': error})
        else:
            emit('quick_connect_success', {
                'connection_id': connection_id,
                'host': host,
                'port': port,
                'username': username
            })
            log_info(f"Quick connection created: {connection_id}", user=current_user.username, host=host)

    except Exception as e:
        log_error("Quick connect failed", error=str(e))
        emit('quick_connect_error', {'error': 'Connection failed'})
    finally:
        password = None
        key_content = None

@socketio.on('quick_disconnect')
@socket_login_required
def handle_quick_disconnect(data, current_user=None):
    """Close a temporary connection."""
    try:
        connection_id = data.get('connection_id')

        if not connection_id:
            emit('error', {'error': 'Connection ID required'})
            return

        conn_info = connection_pool.temp_connection_pool.get_connection_info(connection_id)
        if not conn_info or conn_info['user_id'] != str(current_user.id):
            emit('error', {'error': 'Unauthorized access to connection'})
            return

        success = connection_pool.temp_connection_pool.close_connection(connection_id)

        if success:
            emit('quick_disconnect_success', {'connection_id': connection_id})
        else:
            emit('error', {'error': 'Connection not found'})

    except Exception as e:
        log_error("Quick disconnect failed", error=str(e))
        emit('error', {'error': 'Disconnect failed'})

@socketio.on('create_directory')
@socket_login_required
def handle_create_directory(data, current_user=None):
    """Create a directory on remote server."""
    try:
        session_id = data.get('session_id')
        remote_path = data.get('remote_path')

        if not all([session_id, remote_path]):
            emit('error', {'error': 'Missing required fields'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access'})
                return

        success, error = sftp_handler.create_directory(session_id, remote_path)

        if error:
            emit('error', {'error': f'Failed to create directory: {error}'})
        else:
            emit('directory_created', {'path': remote_path})

    except Exception as e:
        log_error("Create directory failed", error=str(e))
        emit('error', {'error': 'Failed to create directory'})

@socketio.on('rename_file')
@socket_login_required
def handle_rename_file(data, current_user=None):
    """Rename a file or directory on remote server."""
    try:
        session_id = data.get('session_id')
        old_path = data.get('old_path')
        new_path = data.get('new_path')

        if not all([session_id, old_path, new_path]):
            emit('error', {'error': 'Missing required fields'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access'})
                return

        success, error = sftp_handler.rename_item(session_id, old_path, new_path)

        if error:
            emit('error', {'error': f'Failed to rename: {error}'})
        else:
            emit('file_renamed', {'old_path': old_path, 'new_path': new_path})
            log_info(f"Renamed: {old_path} -> {new_path}", user=current_user.username)

    except Exception as e:
        log_error("Rename failed", error=str(e))
        emit('error', {'error': 'Failed to rename'})

@socketio.on('delete_item')
@socket_login_required
def handle_delete_item(data, current_user=None):
    """Delete a file or directory (recursive) on remote server."""
    try:
        session_id = data.get('session_id')
        path = data.get('path')

        if not all([session_id, path]):
            emit('error', {'error': 'Missing required fields'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access'})
                return

        success, error = sftp_handler.delete_directory_recursive(session_id, path)

        if error:
            emit('error', {'error': f'Failed to delete: {error}'})
        else:
            emit('item_deleted', {'path': path})
            log_info(f"Deleted: {path}", user=current_user.username)

    except Exception as e:
        log_error("Delete failed", error=str(e))
        emit('error', {'error': 'Failed to delete'})

@socketio.on('get_home_directory')
@socket_login_required
def handle_get_home_directory(data, current_user=None):
    """Get the home directory of the SFTP session."""
    import time as _time
    _t0 = _time.time()
    try:
        session_id = data.get('session_id')

        if not session_id:
            emit('error', {'error': 'Session ID required'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access'})
                return

        _t1 = _time.time()
        transport = data.get('transport')
        if transport not in (None, 'sftp', 'exec'):
            emit('error', {'error': 'Invalid listing transport'})
            return
        if transport == 'exec':
            home_path, error = sftp_handler.get_home_directory_exec(session_id)
        else:
            home_path, error = sftp_handler.get_home_directory(session_id)
        _t2 = _time.time()

        if error:
            log_warning(f"get_home_directory failed", error=error,
                       auth_ms=int((_t1-_t0)*1000), sftp_ms=int((_t2-_t1)*1000))
            emit('error', {'error': f'Failed to get home directory: {error}'})
        else:
            log_info(f"get_home_directory OK", path=home_path,
                    auth_ms=int((_t1-_t0)*1000), sftp_ms=int((_t2-_t1)*1000))
            emit('home_directory', {'session_id': session_id, 'path': home_path})

    except Exception as e:
        log_error(f"get_home_directory exception", error=str(e),
                 elapsed_ms=int((_time.time()-_t0)*1000))
        emit('error', {'error': 'Failed to get home directory'})

@socketio.on('preview_file')
@socket_login_required
def handle_preview_file(data, current_user=None):
    """
    Read file content for preview purposes.
    Supports text files, code files, and log files with tail mode.
    """
    try:
        session_id = data.get('session_id')
        path = data.get('path')
        max_bytes = data.get('max_bytes', 512000)
        offset = data.get('offset', 0)
        tail_lines = data.get('tail_lines')

        if not all([session_id, path]):
            emit('error', {'error': 'Missing required fields'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access'})
                return

        result, error = sftp_handler.read_file_preview(
            session_id=session_id,
            path=path,
            max_bytes=max_bytes,
            offset=offset,
            tail_lines=tail_lines
        )

        if error:
            emit('preview_error', {'error': f'Failed to read file: {error}', 'path': path})
        else:
            import os
            result['filename'] = os.path.basename(path)
            result['path'] = path
            emit('preview_data', result)

    except Exception as e:
        log_error("Preview failed", error=str(e))
        emit('preview_error', {'error': 'Preview failed', 'path': data.get('path', '')})

@socketio.on('open_file_for_edit')
@socket_login_required
def handle_open_file_for_edit(data, current_user=None):
    """Load a full text file for inline editing (no truncation, text only)."""
    try:
        session_id = data.get('session_id')
        path = data.get('path')

        if not all([session_id, path]):
            emit('edit_error', {'error': 'Missing required fields', 'path': path or ''})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('edit_error', {'error': 'Unauthorized access', 'path': path})
                return

        result, error = sftp_handler.read_file_for_edit(session_id=session_id, path=path)

        if error:
            emit('edit_error', {'error': f'Failed to open file: {error}', 'path': path})
        else:
            import os
            result['filename'] = os.path.basename(path)
            result['path'] = path
            emit('edit_data', result)

    except Exception as e:
        log_error("Open for edit failed", error=str(e))
        emit('edit_error', {'error': 'Failed to open file for editing', 'path': data.get('path', '')})

@socketio.on('save_file')
@socket_login_required
def handle_save_file(data, current_user=None):
    """Save edited text content back to a remote file via SFTP."""
    try:
        session_id = data.get('session_id')
        path = data.get('path')
        content = data.get('content')
        encoding = data.get('encoding', 'utf-8')
        newline = data.get('newline', 'lf')

        if session_id is None or path is None or content is None:
            emit('error', {'error': 'Missing required fields for save'})
            return

        content_bytes = content.encode('utf-8', errors='ignore')
        max_size = config.MAX_EDITOR_FILE_SIZE
        if len(content_bytes) > max_size:
            max_mb = max_size // (1024 * 1024)
            emit('error', {'error': f'File too large to save. Maximum size: {max_mb}MB'})
            return

        if not verify_session_ownership(session_id, current_user.id):
            conn_info = connection_pool.temp_connection_pool.get_connection_info(session_id)
            if not conn_info or conn_info['user_id'] != str(current_user.id):
                emit('error', {'error': 'Unauthorized access to session'})
                return

        success, error = sftp_handler.write_file_text(
            session_id=session_id,
            path=path,
            content_str=content,
            encoding=encoding,
            newline=newline
        )

        if error:
            emit('error', {'error': f'Save failed: {error}'})
        else:
            import os
            log_file_upload(current_user.username, target_host='via-sftp-edit',
                            filename=os.path.basename(path), size=len(content_bytes),
                            success=True, ip_address=request.remote_addr)
            emit('file_saved', {'path': path})

    except Exception as e:
        log_error("Save failed", error=str(e))
        emit('error', {'error': 'Save failed'})

@socketio.on('transfer_server_to_server')
@socket_login_required
def handle_transfer_server_to_server(data, current_user=None):
    """Start a server-to-server transfer and ACK the id the SERVER issued.

    The client does not name the transfer. It emits the request, reads
    ``{'success': True, 'transfer_id': ...}`` from this ack, and binds its queue
    row, progress, error and cancel controls to that id. A client-chosen id would
    let one tab name (and therefore cancel) a transfer it does not own, and let
    two tabs collide on the same id.
    """
    try:
        source_session_id = data.get('source_session_id')
        source_path = data.get('source_path')
        dest_session_id = data.get('dest_session_id')
        dest_path = data.get('dest_path')
        is_dir = data.get('is_dir', False)
        # Deliberately no transfer_id is read from `data`: the id does not exist
        # until the registry issues one below. Because there is no id to correlate
        # against yet, the validation failures below ACK instead of emitting a
        # terminal event.

        if not all([source_session_id, source_path, dest_session_id, dest_path]):
            return {'success': False, 'error': 'Missing required fields'}

        # Same-host transfers are refused SERVER-SIDE. The frontend also checks
        # this, but frontend validation is not a trust boundary: a crafted emit
        # would otherwise have the server copy a file onto itself through a
        # temporary path, spending a worker slot and two SFTP channels on a
        # no-op, and on the directory path refusing only after the whole tree was
        # copied into a temp root.
        if str(source_session_id) == str(dest_session_id):
            return {'success': False,
                    'error': 'Source and destination must be different hosts'}

        source_path = sftp_handler.sanitize_path(source_path)
        dest_path = sftp_handler.sanitize_path(dest_path)
        if source_path is None or dest_path is None:
            return {'success': False, 'error': 'Invalid path'}

        source_authorized = False
        if verify_session_ownership(source_session_id, current_user.id):
            source_authorized = True
        else:
            conn_info = connection_pool.temp_connection_pool.get_connection_info(source_session_id)
            if conn_info and conn_info['user_id'] == str(current_user.id):
                source_authorized = True

        if not source_authorized:
            return {'success': False,
                    'error': 'Unauthorized access to source server'}

        dest_authorized = False
        if verify_session_ownership(dest_session_id, current_user.id):
            dest_authorized = True
        else:
            conn_info = connection_pool.temp_connection_pool.get_connection_info(dest_session_id)
            if conn_info and conn_info['user_id'] == str(current_user.id):
                dest_authorized = True

        if not dest_authorized:
            return {'success': False,
                    'error': 'Unauthorized access to destination server'}

        user_id = current_user.id

        """
        OWNER-SOCKET DELIVERY (review round 6).

        These events used to go to `user_<id>`, i.e. to EVERY tab this user has
        open. A tab that did not request the transfer therefore received started /
        progress / complete for an id it had never queued, and its client-side
        early-event buffer accumulated entries for a row it would never create --
        one tab's activity growing another tab's memory.

        Flask-SocketIO puts every client in a room named by its own sid, so the
        owning socket's sid IS a room, and addressing it delivers to exactly the
        request that created the transfer. The per-user room stays as the fallback
        for the case where the sid is unavailable, so no event is ever dropped.
        Ownership for CANCEL is still checked against user_id in the registry: this
        narrows event delivery, it does not widen or replace the authorization
        check.
        """
        owner_sid = getattr(request, 'sid', None)
        user_room = owner_sid or f'user_{current_user.id}'
        # The record (and its id) exists BEFORE the thread starts, so a cancel
        # arriving immediately after the ack still finds the transfer. Creating it
        # also reserves this user's worker slot; the worker's finally releases it.
        try:
            record = transfer_registry.create(
                user_id=user_id,
                source_session_id=source_session_id,
                dest_session_id=dest_session_id,
                owner_sid=owner_sid,
                metadata={
                    'source_path': source_path,
                    'dest_path': dest_path,
                    'is_dir': bool(is_dir),
                },
            )
        except TransferLimitExceeded:
            return {'success': False,
                    'error': 'Too many transfers already running'}

        transfer_id = record.transfer_id
        # Captured HERE, not polled by id inside the worker: cancel drops the
        # record, so a registry lookup would stop reporting the cancellation.
        cancel_event = record.cancel_event

        def run_transfer():
            try:
                # A cancel can win while the transfer is still PENDING, in the gap
                # between create and this thread actually running. mark_running
                # returning False means "already terminalized" -- return without
                # opening any SFTP connection.
                if not transfer_registry.mark_running(transfer_id, user_id):
                    return

                success, error = sftp_handler.transfer_server_to_server(
                    source_session_id=source_session_id,
                    source_path=source_path,
                    dest_session_id=dest_session_id,
                    dest_path=dest_path,
                    transfer_id=transfer_id,
                    socketio_instance=socketio,
                    is_dir=is_dir,
                    user_room=user_room,
                    cancel_event=cancel_event
                )

                # Exactly one terminal event per transfer. The registry boolean is
                # the gate: if a cancel already terminalized this transfer, both
                # Complete and fail return False and nothing is emitted, so a
                # cancelled row is never overwritten by a late error or success.
                #
                # The COMPLETE event is emitted here, gated on complete, and no
                # longer by sftp_handler: emitting it down there happened before
                # this call, so a cancel arriving in the gap produced both a
                # Cancelled and a Complete row for one transfer.
                if success:
                    if transfer_registry.complete(transfer_id, user_id):
                        socketio.emit('s2s_transfer_complete', {
                            'transfer_id': transfer_id,
                            # The client's completion toast reads data.filename;
                            # without it the message read "Transfer complete:
                            # undefined".
                            'filename': posixpath.basename(source_path.rstrip('/')),
                            'source_path': source_path,
                            'dest_path': dest_path
                        }, room=user_room)
                elif transfer_registry.fail(transfer_id, user_id):
                    socketio.emit('s2s_transfer_error', {
                        'transfer_id': transfer_id,
                        'error': error or 'Transfer failed'
                    }, room=user_room)
            except Exception as error:
                # A crash in the worker is still a terminal outcome, and still
                # owes the client exactly one error event.
                log_error('S2S transfer worker failed',
                          exception_type=type(error).__name__,
                          transfer_id=transfer_id)
                if transfer_registry.fail(transfer_id, user_id):
                    socketio.emit('s2s_transfer_error', {
                        'transfer_id': transfer_id,
                        'error': 'Transfer failed'
                    }, room=user_room)
            finally:
                # The slot is held until the worker has actually finished
                # unwinding, so a start/cancel loop cannot spawn threads without
                # limit. Every exit path above passes through here.
                transfer_registry.release_worker_slot(transfer_id, user_id)

        # Thread CONSTRUCTION and start share one guarded path. The constructor
        # was previously outside it, so a failure there (thread limit reached,
        # a patched/instrumented Thread raising) left the record active and its
        # worker slot held forever, permanently consuming one of the user's five
        # slots even though no worker existed to release it.
        try:
            transfer_thread = threading.Thread(target=run_transfer, daemon=True)
            transfer_thread.start()
        except Exception:
            # The worker's finally will never run, so this path owes both the
            # terminal transition and the slot -- exactly once each.
            transfer_registry.fail(transfer_id, user_id)
            transfer_registry.release_worker_slot(transfer_id, user_id)
            raise

        log_info(f"S2S transfer started: {source_path} -> {dest_path}", user=current_user.username)

        # The client binds its queue row to this id.
        return {'success': True, 'transfer_id': transfer_id}

    except Exception as e:
        log_error("S2S transfer setup failed", error=str(e), user=current_user.username)
        return {'success': False, 'error': 'Failed to start transfer'}


@socketio.on('cancel_transfer')
@socket_login_required
def handle_cancel_transfer(data, current_user=None):
    """Cancel a server-to-server transfer owned by the REQUESTING SOCKET.

    Mirrors upstream/main's handle_cancel_transfer in shape -- the ack is the
    client's signal, so the frontend paints the cancelled row only when the server
    confirms it actually cancelled -- but the authorization is narrower, and
    deliberately so (registry invariant 7).

    AUTHORIZATION IS OWNER-SOCKET, NOT USER (release blocker, review round 6).
    This used to call `transfer_registry.cancel(transfer_id, user_id)`, i.e. it
    authorized on user_id alone. Two defects followed, and they contradicted the
    disconnect path, which was already socket-scoped:

      * a SECOND TAB of the same account that learned a transfer_id could stop a
        copy it never started, while the tab that did start it was never told;
      * the terminal event went to `user_<id>`, so EVERY tab of the account
        received a cancellation for an id it had never queued -- the same
        cross-tab leak the started/progress/complete events were already fixed
        for.

    Now: only the socket recorded as `owner_sid` may cancel an owner-bound
    transfer, and the event is delivered to that sid alone. A same-user non-owner
    tab, a different user, an unknown id and an already-finished transfer all
    receive the identical opaque {'success': False} with NO event emitted, so the
    ack cannot become an existence oracle for transfers the caller does not own.

    Legacy fallback: a record with no recorded owner_sid (created before a sid
    could be captured) is still cancellable by its owning USER, and its event
    falls back to the per-user room because there is no sid to address. This
    cannot widen authority -- a record that HAS an owner_sid is never cancellable
    by another sid.
    """
    transfer_id = data.get('transfer_id') if isinstance(data, dict) else None
    requester_sid = getattr(request, 'sid', None)
    try:
        cancelled, owner_sid = transfer_registry.cancel_for_owner(
            transfer_id, current_user.id, requester_sid)
    except Exception as error:
        log_error('Transfer cancellation failed', user=current_user.username,
                  exception_type=type(error).__name__)
        cancelled, owner_sid = False, None

    if cancelled:
        log_info('S2S transfer cancellation requested',
                 user=current_user.username)
        # The recorded owner, never the user room. Only a legacy record with no
        # owner_sid falls back, and only because it has no sid to address.
        socketio.emit('s2s_transfer_cancelled', {
            'transfer_id': transfer_id,
            'status': 'cancelled',
        }, room=owner_sid or f'user_{current_user.id}')

    return {'success': bool(cancelled)}
