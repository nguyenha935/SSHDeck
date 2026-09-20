import os
import stat
import secrets
import posixpath
import uuid
from pathlib import Path
from threading import Lock
from contextlib import contextmanager
import config
from . import ssh_manager
from .audit_logger import log_info, log_warning, log_error, log_debug

# == W13 SFTP cache ownership and serialization ==============================
#
# A session_id can be reused by a DIFFERENT session object after
# close+reconnect. To prevent a retired session A from closing the
# replacement B handle, every session cache entry carries the owning session
# _sftp_owner_token (a UUID assigned once at SSH session registration).
#
# DATA SHAPES:
#   _sftp_cache[session_id]          = (sftp_client, owner_token)
#   _sftp_pool_cache[connection_id]  = sftp_client        (pool namespace)
#   _sftp_session_locks[session_id] = Lock (STABLE, never removed)
#
# ONE REGISTRY MUTEX: _sftp_cache_lock protects all three dicts. No other
# mutex touches them, so lock lookup/creation is atomic and a second Lock can
# never be minted for an id whose first Lock is still reachable.
#
# STABLE LOCKS: the per-session Lock is created once and NEVER removed or
# replaced, even when its session retires. A reused id gets the same Lock, so
# waiters and new callers always contend on one object.
#
# SERIALIZATION BOUNDARY (one non-reentrant per-session Lock, no bypass):
#   Sftp_session acquires the Lock, calls get_any_sftp_client.
#   Get_sftp_client PUBLIC: acquires the Lock, calls
#                         _resolve_session_sftp_locked.
#   Close_sftp_cache PUBLIC: acquires the Lock, calls
#                         _close_sftp_cache_locked.
#   Get_any_sftp_client LOCKED helper: caller must already hold the Lock
#                         (sftp_session and the socket download handler do).
# The locked helpers never reacquire the per-session Lock. Session identity,
# connected state, client and owner token are all resolved INSIDE the locked
# boundary, so a caller that waited while A was replaced by B resolves B.

_sftp_cache = {}
_sftp_cache_lock = Lock()

# STABLE per-session lock registry. A Lock is created once per session_id and
# NEVER removed or replaced, even when the session retires: a reused id gets
# the SAME Lock object, so two Lock objects can never coexist for one id.
# Entries are bounded by the number of distinct session/connection ids seen;
# pruning is deliberately deferred because safe deletion would require proving
# no waiter can still reach the old Lock. _sftp_cache_lock is the ONE registry
# mutex: it protects _sftp_cache, _sftp_pool_cache and _sftp_session_locks.
# No other mutex ever touches these dicts.
_sftp_session_locks = {}

# Pool/legacy handles cached for close-time cleanup, keyed by connection_id.
# Kept SEPARATE from _sftp_cache so close_sftp_cache(expected_owner=None) can
# never detach or close a session-owned entry: pool ids and session ids share
# one namespace at the call sites, so the isolation must be structural.
_sftp_pool_cache = {}


def _get_sftp_lock(session_id):
    """Get or create the STABLE per-session Lock serializing SFTP operations.

    Always returns the same Lock object for a given id, atomically created
    under _sftp_cache_lock (the single registry mutex) and never removed.
    """
    with _sftp_cache_lock:
        lock = _sftp_session_locks.get(session_id)
        if lock is None:
            lock = Lock()
            _sftp_session_locks[session_id] = lock
        return lock


# ── Internal helpers: caller MUST hold the per-session Lock ──────────────────

def _resolve_session_sftp_locked(session_id):
    """Owner-aware cache get/create. CALLER HOLDS the per-session Lock.

    Resolves the CURRENT ssh_manager session INSIDE the locked boundary: the
    registered session, its connected state, its client and its owner token
    are all read here, after the per-session Lock was acquired. A caller that
    waited on the Lock while session A was replaced by B therefore resolves B,
    never a stale pre-lock snapshot of A.

    Returns (sftp_client, error). A cache hit is valid only when the cached
    entry owner equals the current session owner. On mismatch (A->B), A stale
    handle is detached under _sftp_cache_lock and closed exactly once OUTSIDE
    it, then B fresh handle is opened and published. The per-session Lock the
    caller holds serializes concurrent calls, so exactly one caller opens the
    fresh handle and exactly one displaced handle is closed.
    """
    try:
        with ssh_manager.sessions_lock:
            session = ssh_manager.sessions.get(session_id)
            if session is None:
                return None, "Session not found"
            if not session['connected']:
                return None, "Session not connected"
            client = session['client']
            current_owner = session.get('_sftp_owner_token')

        cached_sftp = None
        stale_handle_to_close = None
        with _sftp_cache_lock:
            entry = _sftp_cache.get(session_id)
            if entry is not None:
                cached_sftp, cached_owner = entry
                if cached_owner != current_owner:
                    # OWNER MISMATCH (A -> B): detach A entry under the cache
                    # lock; close A handle outside it.
                    del _sftp_cache[session_id]
                    stale_handle_to_close = cached_sftp
                    cached_sftp = None

        if stale_handle_to_close is not None:
            try:
                stale_handle_to_close.close()
            except Exception:
                pass

        if cached_sftp is not None:
            try:
                cached_sftp.stat('.')
                return cached_sftp, None
            except Exception:
                # Handle is stale/broken: detach atomically, close outside.
                with _sftp_cache_lock:
                    current = _sftp_cache.get(session_id)
                    if current is not None and current[0] is cached_sftp:
                        del _sftp_cache[session_id]
                try:
                    cached_sftp.close()
                except Exception:
                    pass

        # Open a fresh SFTP channel for the current session and publish it.
        sftp = client.open_sftp()
        with _sftp_cache_lock:
            _sftp_cache[session_id] = (sftp, current_owner)

        return sftp, None
    except Exception as e:
        return None, str(e)


def _close_sftp_cache_locked(session_id, expected_owner):
    """Owner-aware cache close. CALLER HOLDS the per-session Lock.

    Detaches entries atomically under _sftp_cache_lock, then closes the
    detached handles only AFTER releasing it (Paramiko close can block on
    network I/O and must never run under the registry mutex).

    expected_owner semantics:
      * a session owner token  -- detach+close the session cache entry only
        when its cached owner EQUALS the token, so a retired session can never
        close a reused-id replacement handle;
      * None (pool/legacy)     -- detach+close the pool cache entry for this
        id, and a session cache entry only when that entry itself has owner
        None. Session-owned entries are never affected by a None caller.

    The STABLE per-session Lock is never removed here (or anywhere): removing
    it while a waiter still holds or awaits it would let a new caller mint a
    second Lock for the same id. Returns True when a handle was closed.
    """
    to_close = []
    with _sftp_cache_lock:
        entry = _sftp_cache.get(session_id)
        if entry is not None:
            sftp, cached_owner = entry
            if cached_owner == expected_owner:
                del _sftp_cache[session_id]
                to_close.append(sftp)
        if expected_owner is None:
            pool_sftp = _sftp_pool_cache.pop(session_id, None)
            if pool_sftp is not None:
                to_close.append(pool_sftp)

    for handle in to_close:
        try:
            handle.close()
        except Exception:
            pass
    return bool(to_close)


# ── Public API ───────────────────────────────────────────────────────────────

@contextmanager
def sftp_session(identifier):
    """Context manager: acquire per-session lock and provide SFTP client.

    Ensures only one greenthread uses the cached SFTPClient at a time,
    preventing Paramiko internal request/response queue corruption.

    Acquires the exact stable per-session Lock, then calls get_any_sftp_client
    -- a LOCKED helper that never reacquires. There is no thread-local or
    greenlet-local bypass anywhere: the lock discipline is explicit.

    Usage:
        with sftp_session(session_id) as (sftp, source_type):
            files = sftp.listdir_attr(path)

    Raises SFTPOperationError if no connection is available.
    """
    lock = _get_sftp_lock(identifier)
    with lock:
        sftp, error, source_type = get_any_sftp_client(identifier)
        if error:
            raise SFTPOperationError(error)
        yield sftp, source_type


class SFTPOperationError(Exception):
    """Raised when an SFTP operation cannot be performed (no connection, etc.)."""
    pass


def get_sftp_client(session_id):
    """Get cached or create new SFTP client from existing SSH session.

    PUBLIC entry: acquires the stable per-session Lock, then resolves the
    CURRENT session entirely inside the locked boundary (see
    _resolve_session_sftp_locked). A caller that waited here while session A
    was replaced by B resolves and publishes B, never a stale A snapshot.

    Owner-aware cache: a hit is valid only when the cached entry owner equals
    the current session owner token. On mismatch the stale handle is detached
    and closed exactly once, then the fresh handle is opened and cached.
    """
    lock = _get_sftp_lock(session_id)
    with lock:
        return _resolve_session_sftp_locked(session_id)


def close_sftp_cache(session_id, expected_owner=None):
    """Close and remove the cached SFTP client for a session/connection.

    PUBLIC entry: acquires the stable per-session Lock so an in-flight
    sftp_session operation completes before the cache is touched, then calls
    the locked close helper.

    `expected_owner` is the retiring session owner token: the handle is closed
    only when the cached entry owner matches, so a reused-id replacement is
    never closed by the retired session cleanup. None (pool/legacy callers)
    affects only the isolated pool cache and ownerless entries. The stable
    per-session Lock itself is never removed.
    """
    lock = _get_sftp_lock(session_id)
    with lock:
        return _close_sftp_cache_locked(session_id, expected_owner)


def sanitize_path(remote_path):
    """Sanitize and validate remote path to prevent path traversal attacks.

    SECURITY: Blocks path traversal attempts (../) and null bytes.
    Absolute paths are ALLOWED for SFTP operations on remote servers.
    Returns None if path is invalid/malicious.
    """
    if not remote_path or remote_path.strip() == '':
        return '.'

    if '\x00' in remote_path:
        log_warning(f"SECURITY: Null byte in path BLOCKED", path=repr(remote_path))
        return None

    # SFTP/remote paths are always POSIX-style, regardless of the OS this
    # process runs on. Use posixpath so normalization stays correct even when
    # the server itself is hosted on Windows (os.path would emit backslashes).
    normalized = posixpath.normpath(remote_path)

    if '..' in normalized:
        log_warning(f"SECURITY: Path traversal attempt blocked", path=remote_path)
        return None

    return normalized

def list_directory(session_id, remote_path='.'):
    """List files via SFTP for the single-session Files feature.

    This is intentionally separate from the dual-pane S2S route. Files keeps
    its existing SFTP behavior unchanged; File Transfer calls
    ``list_directory_exec`` instead and never requests the subsystem.

    ONE UNDECODABLE NAME MUST NOT HIDE THE DIRECTORY. paramiko decodes every
    filename as strict UTF-8, so a single latin-1 or shift-jis name makes
    `listdir_attr` raise and the whole listing fails -- the owner's "Failed to
    list directory: 'utf-8' codec can't decode byte 0xf6 in position 3"
. The exec lister already carries names as base64 and decodes
    with surrogateescape, so it can show exactly the directory SFTP refused;
    it is the fallback, and only for this error.
    """
    try:
        safe_path = sanitize_path(remote_path)
        if safe_path is None:
            return None, "Invalid path: path traversal detected"

        with sftp_session(session_id) as (sftp, source_type):
            files = []
            entries = sftp.listdir_attr(safe_path)
            for entry in entries:
                is_symlink = stat.S_ISLNK(entry.st_mode)
                files.append({
                    'name': entry.filename,
                    'size': entry.st_size,
                    'mode': entry.st_mode,
                    'is_dir': stat.S_ISDIR(entry.st_mode),
                    'is_symlink': is_symlink,
                    'modified': entry.st_mtime
                })
        return files, None
    except UnicodeDecodeError:
        from . import exec_fs
        files, error = exec_fs.list_directory(session_id, remote_path)
        if error:
            return None, ("a name in this directory is not valid UTF-8 and the"
                          f" fallback listing failed: {error}")
        return files, None
    except SFTPOperationError as e:
        return None, str(e)
    except Exception as e:
        return None, str(e)


def list_directory_exec(session_id, remote_path='.'):
    """List for dual-pane File Transfer via SSH exec (never SFTP)."""
    from . import exec_fs
    return exec_fs.list_directory(session_id, remote_path)

def create_directory(session_id, remote_path):
    """Create a directory on remote server."""
    try:
        safe_path = sanitize_path(remote_path)
        if safe_path is None:
            return False, "Invalid path: path traversal detected"

        with sftp_session(session_id) as (sftp, source_type):
            sftp.mkdir(safe_path)
        return True, None
    except SFTPOperationError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)

def upload_file_chunked(session_id, filename, chunks, remote_path, socketio_instance=None):
    """Upload file from chunks sent by client."""
    try:
        safe_path = sanitize_path(remote_path)
        if safe_path is None:
            return False, "Invalid remote path"

        total_size = sum(len(chunk) for chunk in chunks)
        transferred = 0

        with sftp_session(session_id) as (sftp, source_type):
            with sftp.file(safe_path, 'wb') as remote_file:
                for i, chunk in enumerate(chunks):
                    remote_file.write(chunk)
                    transferred += len(chunk)

                    if socketio_instance:
                        percent = int((transferred / total_size) * 100)
                        socketio_instance.emit('file_progress', {
                            'session_id': session_id,
                            'type': 'upload',
                            'filename': filename,
                            'transferred': transferred,
                            'total': total_size,
                            'percent': percent
                        })

        if socketio_instance:
            socketio_instance.emit('file_complete', {
                'session_id': session_id,
                'type': 'upload',
                'filename': filename,
                'remote_path': safe_path
            })

        return True, None
    except SFTPOperationError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)

def download_file_chunked(session_id, remote_path, socketio_instance=None):
    """Download file and send in chunks to client."""
    try:
        safe_path = sanitize_path(remote_path)
        if safe_path is None:
            return None, "Invalid remote path"

        with sftp_session(session_id) as (sftp, source_type):
            file_stat = sftp.stat(safe_path)
            file_size = file_stat.st_size
            if file_size > config.MAX_DOWNLOAD_SIZE:
                max_mb = config.MAX_DOWNLOAD_SIZE // (1024 * 1024)
                return None, f"File too large for download ({file_size // (1024*1024)}MB). Maximum: {max_mb}MB"
            filename = posixpath.basename(safe_path)

            chunks = []
            transferred = 0

            with sftp.file(safe_path, 'rb') as remote_file:
                while True:
                    chunk = remote_file.read(config.CHUNK_SIZE)
                    if not chunk:
                        break

                    chunks.append(chunk)
                    transferred += len(chunk)

                    if socketio_instance:
                        percent = int((transferred / file_size) * 100)
                        socketio_instance.emit('file_progress', {
                            'session_id': session_id,
                            'type': 'download',
                            'filename': filename,
                            'transferred': transferred,
                            'total': file_size,
                            'percent': percent
                        })

        return {'filename': filename, 'chunks': chunks, 'size': file_size}, None
    except SFTPOperationError as e:
        return None, str(e)
    except Exception as e:
        return None, str(e)

def rename_item(session_id, old_path, new_path):
    """Rename a file or directory on remote server."""
    try:
        safe_old = sanitize_path(old_path)
        safe_new = sanitize_path(new_path)
        if safe_old is None or safe_new is None:
            return False, "Invalid path"

        with sftp_session(session_id) as (sftp, source_type):
            sftp.rename(safe_old, safe_new)
        return True, None
    except SFTPOperationError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)

def delete_directory_recursive(session_id, path):
    """Recursively delete a directory and all its contents."""
    import stat as stat_module

    try:
        safe_path = sanitize_path(path)
        if safe_path is None:
            return False, "Invalid path"

        def _delete_recursive(sftp_client, dir_path, base_path, depth=0):
            """
            Internal recursive delete function with security checks.

            SECURITY: Validates each path to prevent symlink attacks and
            limits recursion depth to prevent stack overflow.
            """
            if depth > 50:
                raise ValueError("Maximum recursion depth exceeded")

            for entry in sftp_client.listdir_attr(dir_path):
                full_path = f"{dir_path}/{entry.filename}"

                if stat_module.S_ISLNK(entry.st_mode):
                    sftp_client.remove(full_path)
                    continue

                if stat_module.S_ISDIR(entry.st_mode):
                    _delete_recursive(sftp_client, full_path, base_path, depth + 1)
                    sftp_client.rmdir(full_path)
                else:
                    sftp_client.remove(full_path)

        with sftp_session(session_id) as (sftp, source_type):
            stat_result = sftp.lstat(safe_path)
            if stat_module.S_ISDIR(stat_result.st_mode):
                _delete_recursive(sftp, safe_path, safe_path)
                sftp.rmdir(safe_path)
            elif stat_module.S_ISLNK(stat_result.st_mode):
                sftp.remove(safe_path)
            else:
                sftp.remove(safe_path)

        return True, None
    except SFTPOperationError as e:
        return False, str(e)
    except FileNotFoundError:
        return False, "File or directory not found"
    except Exception as e:
        return False, str(e)

def get_home_directory(session_id):
    """Get home directory via SFTP for the single-session Files feature."""
    try:
        with sftp_session(session_id) as (sftp, source_type):
            home_path = sftp.normalize('.')
        return home_path, None
    except SFTPOperationError as e:
        return None, str(e)
    except Exception as e:
        return None, str(e)


def get_home_directory_exec(session_id):
    """Get home directory for dual-pane File Transfer via exec (never SFTP)."""
    from . import exec_fs
    return exec_fs.get_home_directory(session_id)


def read_file_preview(session_id, path, max_bytes=512000, offset=0, tail_lines=None):
    """
    Read file content for preview purposes.

    Args:
        session_id: Session ID or connection ID
        path: File path on remote server
        max_bytes: Maximum bytes to read (default 500KB)
        offset: Byte offset to start reading from
        tail_lines: If set, read last N lines instead of from beginning

    Returns:
        tuple: (content_dict, error)
               content_dict contains: content, size, truncated, is_binary
    """
    try:
        safe_path = sanitize_path(path)
        if safe_path is None:
            return None, "Invalid path"

        with sftp_session(session_id) as (sftp, source_type):
            file_stat = sftp.stat(safe_path)
            file_size = file_stat.st_size

            max_preview_size = getattr(config, 'MAX_PREVIEW_SIZE', 512000)
            max_bytes = min(max_bytes, max_preview_size)

            max_supported_file = getattr(config, 'MAX_SUPPORTED_FILE_SIZE', 1024 * 1024 * 1024)
            if file_size > max_supported_file:
                return None, f"File too large ({file_size} bytes). Maximum supported size is {max_supported_file} bytes."

            truncated = file_size > max_bytes
            read_size = min(file_size, max_bytes)

            content = b''

            with sftp.file(safe_path, 'rb') as remote_file:
                if tail_lines:
                    seek_pos = max(0, file_size - max_bytes)
                    remote_file.seek(seek_pos)
                    content = remote_file.read(max_bytes)

                    lines = content.split(b'\n')
                    if len(lines) > tail_lines:
                        content = b'\n'.join(lines[-tail_lines:])
                        truncated = True
                else:
                    if offset > 0:
                        remote_file.seek(offset)
                    content = remote_file.read(read_size)

        is_binary = False
        try:
            sample = content[:1024]
            if b'\x00' in sample:
                is_binary = True
            else:
                sample.decode('utf-8')
        except UnicodeDecodeError:
            is_binary = True

        if is_binary:
            content_str = None
        else:
            try:
                content_str = content.decode('utf-8')
            except UnicodeDecodeError:
                try:
                    content_str = content.decode('latin-1')
                except Exception:
                    is_binary = True
                    content_str = None

        return {
            'content': content_str,
            'size': file_size,
            'read_size': len(content),
            'truncated': truncated,
            'is_binary': is_binary,
            'offset': offset
        }, None

    except SFTPOperationError as e:
        return None, str(e)
    except FileNotFoundError:
        return None, "File not found"
    except PermissionError:
        return None, "Permission denied"
    except Exception as e:
        return None, str(e)

def read_file_for_edit(session_id, path, max_bytes=None):
    """
    Read a full text file for editing.

    Unlike read_file_preview, this never truncates: files larger than the
    editor limit or detected as binary are rejected, so that a later save
    cannot silently shorten or corrupt the original file.

    Returns:
        tuple: (content_dict, error)
               content_dict contains: content, size, encoding, newline
    """
    try:
        safe_path = sanitize_path(path)
        if safe_path is None:
            return None, "Invalid path"

        if max_bytes is None:
            max_bytes = getattr(config, 'MAX_EDITOR_FILE_SIZE', 5 * 1024 * 1024)

        with sftp_session(session_id) as (sftp, source_type):
            file_stat = sftp.stat(safe_path)
            file_size = file_stat.st_size

            if file_size > max_bytes:
                max_mb = max_bytes // (1024 * 1024)
                return None, (f"File too large to edit ({file_size // (1024 * 1024)}MB). "
                              f"Maximum: {max_mb}MB")

            with sftp.file(safe_path, 'rb') as remote_file:
                raw = remote_file.read(file_size)

        # Binary detection mirrors read_file_preview.
        is_binary = b'\x00' in raw[:1024]

        encoding = 'utf-8'
        content_str = None
        if not is_binary:
            try:
                content_str = raw.decode('utf-8')
            except UnicodeDecodeError:
                try:
                    content_str = raw.decode('latin-1')
                    encoding = 'latin-1'
                except Exception:
                    is_binary = True

        if is_binary or content_str is None:
            return None, "Binary file cannot be edited"

        # Remember the original newline style, then normalize to LF for the
        # browser textarea; the original style is restored on save.
        newline = 'crlf' if b'\r\n' in raw else 'lf'
        content_str = content_str.replace('\r\n', '\n')

        return {
            'content': content_str,
            'size': file_size,
            'encoding': encoding,
            'newline': newline
        }, None

    except SFTPOperationError as e:
        return None, str(e)
    except FileNotFoundError:
        return None, "File not found"
    except PermissionError:
        return None, "Permission denied"
    except Exception as e:
        return None, str(e)

def write_file_text(session_id, path, content_str, encoding='utf-8', newline='lf'):
    """
    Write edited text content back to a remote file.

    Writes atomically: content is written to a temp file in the same directory
    first, then renamed over the target, so an interrupted transfer cannot leave
    a half-written or empty file. Falls back to a direct overwrite if the server
    does not support the posix-rename extension.
    """
    try:
        safe_path = sanitize_path(path)
        if safe_path is None:
            return False, "Invalid path"

        # The browser textarea always uses LF; restore the original style.
        text = content_str.replace('\r\n', '\n')
        if newline == 'crlf':
            text = text.replace('\n', '\r\n')

        if encoding not in ('utf-8', 'latin-1'):
            encoding = 'utf-8'
        try:
            data = text.encode(encoding)
        except UnicodeEncodeError:
            data = text.encode('utf-8')

        tmp_path = safe_path + '.sshdeck-tmp-' + os.urandom(4).hex()

        with sftp_session(session_id) as (sftp, source_type):
            try:
                with sftp.file(tmp_path, 'wb') as remote_file:
                    remote_file.write(data)
                try:
                    sftp.posix_rename(tmp_path, safe_path)
                except (IOError, OSError, AttributeError):
                    # Server lacks posix-rename; fall back to direct overwrite.
                    with sftp.file(safe_path, 'wb') as remote_file:
                        remote_file.write(data)
                    try:
                        sftp.remove(tmp_path)
                    except Exception:
                        pass
            except Exception:
                # Best-effort cleanup of the temp file on failure.
                try:
                    sftp.remove(tmp_path)
                except Exception:
                    pass
                raise

        return True, None
    except SFTPOperationError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)

def get_sftp_client_from_pool(connection_id):
    """Get SFTP client from temporary connection pool."""
    from . import connection_pool
    return connection_pool.temp_connection_pool.get_sftp_client(connection_id)

def get_any_sftp_client(identifier):
    """
    Get SFTP client from either an SSH session or temporary connection pool.

    LOCKED HELPER: the caller MUST already hold the per-session Lock obtained
    via _get_sftp_lock(identifier). Both callers do -- sftp_session acquires
    it in its with-block, and the socket download handler acquires it manually
    before calling here. This function never acquires the per-session Lock, so
    there is no reacquire and no deadlock.

    Pool clients are recorded in the ISOLATED _sftp_pool_cache (never the
    session cache) so close_sftp_cache(expected_owner=None) can clean them up
    without ever touching a session-owned entry.

    Args:
        identifier (str): Session ID or connection ID

    Returns:
        tuple: (sftp_client, error, source_type)
               source_type is 'session' or 'pool'
    """
    sftp, error = _resolve_session_sftp_locked(identifier)
    if sftp:
        return sftp, None, 'session'

    sftp, error = get_sftp_client_from_pool(identifier)
    if sftp:
        with _sftp_cache_lock:
            _sftp_pool_cache[identifier] = sftp
        return sftp, None, 'pool'

    return None, f"No active connection found for: {identifier}", None

def transfer_server_to_server(source_session_id, source_path, dest_session_id,
                              dest_path, transfer_id, socketio_instance=None,
                              is_dir=False, user_room=None, cancel_event=None,
                              max_bytes=None, max_members=None,
                              chunk_size=None):
    """
    Direct server-to-server transfer over SSH EXEC channels (never SFTP).

    This is the production S2S File Transfer transport. It streams data from
    the source SSH host to the destination SSH host over two already-
    authenticated sessions' exec channels without buffering the whole file
    locally, and without requesting the SFTP subsystem at any point. Hosts
    without ``Subsystem sftp`` (e.g. the host) work unchanged.

    The implementation lives in ``app.exec_fs`` (cat relay with sha256 + size
    verification into ``.sshdeck-transfer-<token>.tmp`` and atomic rename for
    files; capability-checked tar streaming for directories). This wrapper
    keeps the historical signature and event contract so the socket layer,
    transfer registry and tests that drive this entry point are unchanged:

      * emits ``s2s_transfer_started`` and ``s2s_transfer_progress`` only;
      * emits NEITHER s2s_transfer_complete NOR s2s_transfer_error — the
        socket layer owns terminal emission because only it can consult the
        transfer registry to decide whether this outcome actually won the
        cancel/complete race;
      * returns ``(success: bool, error: str or None)``.
    """
    from . import exec_fs
    return exec_fs.transfer_server_to_server(
        source_session_id, source_path, dest_session_id, dest_path,
        transfer_id, socketio_instance=socketio_instance,
        is_dir=is_dir, user_room=user_room, cancel_event=cancel_event,
        max_bytes=max_bytes, max_members=max_members, chunk_size=chunk_size)
