"""SSH exec-channel filesystem and server-to-server transfer transport.

Production S2S File Transfer (dual-pane listing + copy) must never request the
SSH SFTP subsystem. Hosts such as the host deliberately omit
``Subsystem sftp``; enabling it or editing sshd_config is forbidden.

This module talks only over SSH exec channels on already-authenticated
sessions (or temporary pool connections):

  * listing / home / exists — capability-checked Python 3 helper on the remote,
    with a length-delimited JSON payload and base64-encoded names so spaces,
    tabs, newlines, leading dashes and non-ASCII filenames round-trip safely;
  * file copy — source ``cat``, backend relay with backpressure / progress /
    cancel / sha256, destination write to ``.sshdeck-transfer-<token>.tmp``,
    verify size+sha256, atomic rename, cleanup on error or cancel;
  * directory copy — bounded preflight sizing (python3 walker) then a
    capability-checked ``tar`` stream both ends, else a clear unsupported error
    (never silent, and never human-readable ``ls`` parsing).

Every remote path is passed through ``shlex.quote``; ``--`` guards every argv
position, so a filename starting with ``-`` can never become a flag.
"""

import hashlib
import json
import posixpath
import secrets
import shlex
import socket
import threading
import time
import weakref
from base64 import b64decode, b64encode

import config
from . import ssh_manager
from .audit_logger import log_debug, log_error, log_info, log_warning


# ── public error types (shared contract with sftp_handler / tests) ───────────

class ExecFSError(Exception):
    """Base error for exec-channel filesystem operations."""


class TransferCancelled(ExecFSError):
    """A transfer stopped because its cancel event was set, not because of error."""


class TransferSizeExceeded(ExecFSError):
    """A streamed transfer exceeded its configured byte limit."""


class TransferMemberLimitExceeded(ExecFSError):
    """A recursive transfer exceeded its entry-count limit (preflight walker)."""


class UnsupportedRemote(ExecFSError):
    """Remote host lacks a required capability (python3, tar, cat)."""


# ── constants ────────────────────────────────────────────────────────────────

_EXEC_TIMEOUT_S = 300.0
_PROBE_TIMEOUT_S = 8.0
_LIST_TIMEOUT_S = 30.0
_MAX_LIST_BYTES = 8 * 1024 * 1024
_MAX_PROBE_BYTES = 64 * 1024
_MAX_WALK_DEPTH = 50

# Every remote script starts with this argv normalizer: the channel is opened
# as `python3 - -- <paths...>` (or `python3 -c <runner> -- <paths...>`), which
# yields sys.argv == ['-'|'-c', '--', path, ...]. `_args` is exactly the path
# list, so a filename beginning with '-' can never be mistaken for a flag and
# no path ever sits at a position Python itself interprets.
_ARGV_HEAD = "import sys\n_args=[_a for _a in sys.argv[1:] if _a!='--']\n"

_REMOTE_LIST_PY = _ARGV_HEAD + r'''
import os, json, stat, base64
path = _args[0]
out = []
try:
    with os.scandir(path) as it:
        for entry in it:
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            name = entry.name
            if isinstance(name, str):
                raw = name.encode('utf-8', 'surrogateescape')
            else:
                raw = name
            out.append({
                'n': base64.b64encode(raw).decode('ascii'),
                's': int(st.st_size),
                'm': int(st.st_mode),
                't': int(getattr(st, 'st_mtime', 0) or 0),
                'd': bool(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)),
                'l': bool(stat.S_ISLNK(st.st_mode)),
            })
except FileNotFoundError:
    sys.stderr.write('ENOENT\n'); sys.exit(2)
except PermissionError:
    sys.stderr.write('EACCES\n'); sys.exit(3)
except NotADirectoryError:
    sys.stderr.write('ENOTDIR\n'); sys.exit(4)
except OSError as e:
    sys.stderr.write('EIO:%s\n' % getattr(e, 'errno', '')); sys.exit(5)
sys.stdout.write(json.dumps(out, separators=(',', ':')))
'''

_REMOTE_STAT_PY = _ARGV_HEAD + r'''
import os, json, stat
path = _args[0]
try:
    st = os.lstat(path)
except FileNotFoundError:
    sys.stdout.write(json.dumps({'exists': False})); sys.exit(0)
except PermissionError:
    sys.stderr.write('EACCES\n'); sys.exit(3)
except OSError as e:
    sys.stderr.write('EIO:%s\n' % getattr(e, 'errno', '')); sys.exit(5)
sys.stdout.write(json.dumps({
    'exists': True,
    'size': int(st.st_size),
    'mode': int(st.st_mode),
    'mtime': int(getattr(st, 'st_mtime', 0) or 0),
    'is_dir': bool(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)),
    'is_symlink': bool(stat.S_ISLNK(st.st_mode)),
    'is_reg': bool(stat.S_ISREG(st.st_mode)),
}, separators=(',', ':')))
'''

_REMOTE_HOME_PY = r'''
import os, sys
sys.stdout.write(os.path.expanduser('~'))
'''

# Destination receiver: file bytes arrive on stdin, target path in argv.
# Prints exactly "SIZE HEXDIGEST" on success.
_REMOTE_RECV_PY = _ARGV_HEAD + r'''
import hashlib
path = _args[0]
h = hashlib.sha256()
n = 0
with open(path, 'wb') as f:
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        f.write(chunk)
        h.update(chunk)
        n += len(chunk)
sys.stdout.write('%d %s\n' % (n, h.hexdigest()))
'''

# Atomic publish: os.replace is atomic on POSIX (one rename syscall).
_REMOTE_PUBLISH_PY = _ARGV_HEAD + r'''
import os
src, dst = _args[0], _args[1]
if not os.path.lexists(src):
    sys.stderr.write('ENOENT\n'); sys.exit(2)
os.replace(src, dst)
'''

_REMOTE_UNLINK_PY = _ARGV_HEAD + r'''
import os
path = _args[0]
try:
    if os.path.isdir(path) and not os.path.islink(path):
        import shutil
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)
except FileNotFoundError:
    pass
'''

_REMOTE_MKDIR_PY = _ARGV_HEAD + r'''
import os
path = _args[0]
os.makedirs(path, exist_ok=False)
'''

# Source reader fallback when cat is missing: streams the file to stdout.
_REMOTE_CAT_PY = _ARGV_HEAD + r'''
with open(_args[0], 'rb') as f:
    while True:
        b = f.read(65536)
        if not b:
            break
        sys.stdout.buffer.write(b)
'''

# Directory source: launch tar with an argv-safe NUL-delimited file list.
# Directories and regular files are included; symlinks and special files are
# skipped (matching the historical SFTP walker, which never followed symlinks).
# tar's stdout is inherited directly by this helper, so the archive streams to
# the SSH channel with no buffering in Python.
_REMOTE_TAR_SOURCE_PY = _ARGV_HEAD + r'''
import os, stat, subprocess
root = _args[0]
p = subprocess.Popen(
    ['tar', '--null', '-C', root, '--no-recursion', '-T', '-', '-cf', '-'],
    stdin=subprocess.PIPE,
    stdout=sys.stdout.buffer,
    stderr=sys.stderr.buffer,
)
def send(rel):
    p.stdin.write(rel.encode('utf-8', 'surrogateescape') + b'\0')
send('.')
def walk(path, rel):
    with os.scandir(path) as it:
        for entry in it:
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            mode = st.st_mode
            child_rel = entry.name if rel == '.' else rel + '/' + entry.name
            if stat.S_ISLNK(mode):
                continue
            if stat.S_ISDIR(mode):
                send(child_rel)
                walk(entry.path, child_rel)
            elif stat.S_ISREG(mode):
                send(child_rel)
walk(root, '.')
p.stdin.close()
sys.exit(p.wait())
'''

# Bounded preflight walker: sums regular-file sizes and counts entries without
# following symlinks. Enforces the member ceiling and the byte ceiling BEFORE
# any tar stream starts. Prints "TOTAL COUNT".
_REMOTE_WALK_PY = _ARGV_HEAD + r'''
import os, stat
root = _args[0]
max_members = int(_args[1])
max_bytes = int(_args[2])
max_depth = int(_args[3])
total = 0
count = 0
def walk(path, depth):
    global total, count
    if depth > max_depth:
        sys.stderr.write('EDEPTH\n'); sys.exit(6)
    with os.scandir(path) as it:
        for entry in it:
            count += 1
            if count > max_members:
                sys.stderr.write('EMEMBERS\n'); sys.exit(7)
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            m = st.st_mode
            if stat.S_ISLNK(m):
                continue
            if stat.S_ISDIR(m):
                walk(entry.path, depth + 1)
            else:
                total += st.st_size
                if total > max_bytes:
                    sys.stderr.write('ESIZE\n'); sys.exit(8)
try:
    walk(root, 0)
except FileNotFoundError:
    sys.stderr.write('ENOENT\n'); sys.exit(2)
except PermissionError:
    sys.stderr.write('EACCES\n'); sys.exit(3)
sys.stdout.write('%d %d\n' % (total, count))
'''


# ── SSH client lookup (never opens SFTP) ─────────────────────────────────────

def get_ssh_client(identifier):
    """Return (paramiko.SSHClient, None) or (None, error) for a session/pool id.

    Looks up the live SSH session registry first, then the temporary connection
    pool. Only the SSH client is returned: this module never opens an SFTP
    channel, so hosts without ``Subsystem sftp`` are fully supported.
    """
    try:
        with ssh_manager.sessions_lock:
            session = ssh_manager.sessions.get(identifier)
            if session is not None:
                if not session.get('connected'):
                    return None, 'Session not connected'
                client = session.get('client')
                if client is None:
                    return None, 'No SSH client for session'
                return client, None

        from . import connection_pool
        pool = connection_pool.temp_connection_pool
        with pool.lock:
            conn = pool.connections.get(identifier)
            if conn is not None:
                client = conn.get('client')
                if client is None:
                    return None, 'No SSH client for connection'
                conn['last_used'] = time.time()
                return client, None

        return None, f'No active connection found for: {identifier}'
    except Exception as exc:
        return None, str(exc)


def _transport_of(client):
    transport = client.get_transport() if client is not None else None
    if transport is None or not transport.is_active():
        raise ExecFSError('SSH transport is not active')
    return transport


# ── capability probes ────────────────────────────────────────────────────────
# Memoized per CLIENT OBJECT (WeakKeyDictionary), so a probe result dies with
# Its client and a recycled id can never serve a stale answer.

_capability_lock = threading.Lock()
_capability_cache = weakref.WeakKeyDictionary()


def _client_has(client, name):
    with _capability_lock:
        per_client = _capability_cache.get(client)
        if per_client is not None and name in per_client:
            return per_client[name]
    # `command -v` is POSIX; exit 0 with a path means present.
    status, stdout, _stderr = _run_exec(
        client,
        'command -v ' + shlex.quote(name),
        timeout=_PROBE_TIMEOUT_S,
        max_stdout=4096,
    )
    present = status == 0 and bool(stdout.strip())
    with _capability_lock:
        per_client = _capability_cache.get(client)
        if per_client is None:
            per_client = {}
            try:
                _capability_cache[client] = per_client
            except TypeError:
                # Client not weak-referenceable: skip caching rather than fail.
                return present
        per_client[name] = present
    return present


def _require(client, name, purpose):
    if not _client_has(client, name):
        raise UnsupportedRemote(
            f'Remote host has no {name}; cannot {purpose}'
        )


# ── low-level exec helpers ───────────────────────────────────────────────────

def _is_cancelled(cancel_event):
    """True only when a cancel event was supplied AND is set."""
    return cancel_event is not None and cancel_event.is_set()


def _close_channel(channel):
    if channel is None:
        return
    try:
        channel.close()
    except Exception:
        pass


def _abort_streams(source_channel, destination_channel):
    """Stop both remote commands before temporary-path cleanup.

    The destination receiver owns an open file descriptor on the temp path.
    Closing its SSH channel without first sending stdin EOF can leave the remote
    process alive briefly; an unlink racing that process can lose and leave the
    temp file behind. Send EOF, wait boundedly for the receiver to flush/exit,
    then close both channels. Errors are intentionally swallowed here because
    the original transfer exception is the one the caller must report.
    """
    _close_channel(source_channel)
    if destination_channel is not None:
        try:
            destination_channel.shutdown_write()
        except Exception:
            pass
        try:
            _await_exit(destination_channel, 5.0)
            destination_channel.recv_exit_status()
        except Exception:
            pass
    _close_channel(destination_channel)


def _open_exec(client, command, *, timeout=_EXEC_TIMEOUT_S):
    """Open a session channel and exec ``command``. Caller owns the channel."""
    transport = _transport_of(client)
    channel = transport.open_session(timeout=min(timeout, 30.0))
    channel.settimeout(timeout)
    channel.exec_command(command)
    return channel


def _run_exec(client, command, *, input_bytes=None, timeout=_PROBE_TIMEOUT_S,
              max_stdout=_MAX_PROBE_BYTES):
    """Run a short command to completion. Returns (exit_status, stdout, stderr).

    ``input_bytes`` (when given) is the complete stdin, written before stdout
    is drained — used to ship python3 helper scripts over the exec channel.
    """
    channel = None
    try:
        channel = _open_exec(client, command, timeout=timeout)
        if input_bytes:
            try:
                channel.sendall(input_bytes)
            except Exception:
                pass
            try:
                channel.shutdown_write()
            except Exception:
                pass

        stdout = bytearray()
        stderr = bytearray()

        def _drain_both(final=False):
            while True:
                if channel.recv_ready():
                    chunk = channel.recv(65536)
                    if chunk:
                        stdout.extend(chunk)
                        if len(stdout) > max_stdout:
                            raise ExecFSError(
                                'remote command produced too much output')
                        continue
                if channel.recv_stderr_ready():
                    chunk = channel.recv_stderr(65536)
                    if chunk:
                        stderr.extend(chunk)
                        if len(stderr) > max_stdout:
                            raise ExecFSError(
                                'remote command produced too much stderr')
                        continue
                break

        deadline = time.monotonic() + timeout
        while not channel.exit_status_ready():
            if time.monotonic() >= deadline:
                raise ExecFSError('remote command timed out')
            _drain_both()
            time.sleep(0.01)
        _drain_both(final=True)

        status = channel.recv_exit_status()
        return status, bytes(stdout), bytes(stderr)
    finally:
        _close_channel(channel)


def _python_dash_command(argv_paths):
    """Build ``python3 - -- <quoted paths>``: script arrives on stdin."""
    parts = ['python3', '-']
    if argv_paths:
        parts.append('--')
        parts.extend(argv_paths)
    return ' '.join(shlex.quote(p) for p in parts)


def _python_c_command(script, argv_paths=()):
    """Build ``python3 -c <runner> -- <quoted paths>``.

    The script is base64-wrapped inside the -c runner so the command needs no
    shell-quoting of the script body, and stdin stays FREE for payload bytes
    (used by the destination receiver, which reads the file stream on stdin).
    """
    script_b64 = b64encode(script.encode('utf-8')).decode('ascii')
    runner = (
        "import base64; exec(base64.b64decode('%s').decode('utf-8'))" % script_b64
    )
    parts = ['python3', '-c', runner]
    if argv_paths:
        parts.append('--')
        parts.extend(argv_paths)
    return ' '.join(shlex.quote(p) for p in parts)


def _run_python(client, script, argv_paths=(), *, timeout=_PROBE_TIMEOUT_S,
                max_stdout=_MAX_PROBE_BYTES):
    """Run one helper script via ``python3 -`` with shell-quoted path args."""
    _require(client, 'python3', 'run machine-readable filesystem operations')
    payload = script.encode('utf-8')
    if not payload.endswith(b'\n'):
        payload += b'\n'
    return _run_exec(
        client,
        _python_dash_command(argv_paths),
        input_bytes=payload,
        timeout=timeout,
        max_stdout=max_stdout,
    )


def _decode_error(stderr_bytes, status, fallback):
    err = stderr_bytes.decode('utf-8', 'replace').strip()
    return err or f'{fallback} (exit {status})'


# ── high-level FS operations ─────────────────────────────────────────────────

def list_directory(identifier, remote_path='.'):
    """List a remote directory via exec. Returns (files_list, error_or_None).

    Each entry matches the historical SFTP shape:
    ``{name, size, mode, is_dir, is_symlink, modified}``.
    """
    from .sftp_handler import sanitize_path

    safe_path = sanitize_path(remote_path)
    if safe_path is None:
        return None, 'Invalid path: path traversal detected'

    client, error = get_ssh_client(identifier)
    if error:
        return None, error

    try:
        status, stdout, stderr = _run_python(
            client, _REMOTE_LIST_PY, (safe_path,),
            timeout=_LIST_TIMEOUT_S,
            max_stdout=_MAX_LIST_BYTES,
        )
    except UnsupportedRemote as exc:
        return None, str(exc)
    except Exception as exc:
        return None, str(exc)

    if status != 0:
        err = stderr.decode('utf-8', 'replace').strip()
        if status == 2 or err.startswith('ENOENT'):
            return None, 'No such file or directory'
        if status == 3 or err.startswith('EACCES'):
            return None, 'Permission denied'
        if status == 4 or err.startswith('ENOTDIR'):
            return None, 'Not a directory'
        return None, err or f'list failed (exit {status})'

    try:
        raw_entries = json.loads(stdout.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, f'invalid list payload: {exc}'

    if not isinstance(raw_entries, list):
        return None, 'invalid list payload: not an array'

    files = []
    for item in raw_entries:
        if not isinstance(item, dict) or 'n' not in item:
            continue
        try:
            name = b64decode(item['n']).decode('utf-8', 'surrogateescape')
        except Exception:
            continue
        # Defense in depth: never surface a name that could rebuild a path.
        if not name or '/' in name or '\x00' in name or name in ('.', '..'):
            continue
        files.append({
            'name': name,
            'size': int(item.get('s') or 0),
            'mode': int(item.get('m') or 0),
            'is_dir': bool(item.get('d')),
            'is_symlink': bool(item.get('l')),
            'modified': int(item.get('t') or 0),
        })
    return files, None


def get_home_directory(identifier):
    """Return (absolute_home_path, error) via exec."""
    client, error = get_ssh_client(identifier)
    if error:
        return None, error
    try:
        status, stdout, stderr = _run_python(
            client, _REMOTE_HOME_PY, (),
            timeout=_PROBE_TIMEOUT_S,
            max_stdout=4096,
        )
    except Exception as exc:
        return None, str(exc)
    if status != 0:
        return None, _decode_error(stderr, status,
                                   'Failed to resolve home directory')
    home = stdout.decode('utf-8', 'replace').strip()
    if not home.startswith('/'):
        return None, 'Invalid home directory from remote'
    return home, None


def _stat_remote(client, path):
    """lstat one path on the remote. Returns the decoded stat dict."""
    status, stdout, stderr = _run_python(
        client, _REMOTE_STAT_PY, (path,),
        timeout=_PROBE_TIMEOUT_S,
        max_stdout=4096,
    )
    if status != 0:
        err = stderr.decode('utf-8', 'replace').strip()
        if status == 3 or err.startswith('EACCES'):
            raise ExecFSError('Permission denied')
        raise ExecFSError(_decode_error(stderr, status, 'stat failed'))
    try:
        info = json.loads(stdout.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ExecFSError(f'invalid stat payload: {exc}') from exc
    if not isinstance(info, dict):
        raise ExecFSError('invalid stat payload: not an object')
    return info


def _temp_sibling(dest_path):
    """A unique temporary path beside ``dest_path`` (same directory)."""
    return f'{dest_path}.sshdeck-transfer-{secrets.token_hex(12)}.tmp'


def _remote_unlink(client, path):
    """Best-effort bounded removal of a temporary file or tree."""
    try:
        _run_python(client, _REMOTE_UNLINK_PY, (path,),
                    timeout=_PROBE_TIMEOUT_S, max_stdout=1024)
    except Exception as exc:
        log_debug('remote temp cleanup failed', path=path, error=str(exc))


def _remote_publish(client, temp_path, final_path):
    status, _stdout, stderr = _run_python(
        client, _REMOTE_PUBLISH_PY, (temp_path, final_path),
        timeout=_PROBE_TIMEOUT_S, max_stdout=1024,
    )
    if status != 0:
        raise ExecFSError(
            'atomic replacement is unavailable'
            if status == 2 else
            _decode_error(stderr, status, 'atomic publish failed')
        )


def _remote_mkdir(client, path):
    status, _stdout, stderr = _run_python(
        client, _REMOTE_MKDIR_PY, (path,),
        timeout=_PROBE_TIMEOUT_S, max_stdout=1024,
    )
    if status != 0:
        raise ExecFSError(_decode_error(stderr, status, 'mkdir failed'))


def _walk_directory_total(client, source_path, max_members, max_bytes):
    """Preflight a tree: total regular-file bytes and entry count.

    Refuses oversized / over-member trees BEFORE any byte is streamed, and gives
    directory progress a real denominator. Symlinks are counted but never
    followed or totalled.
    """
    status, stdout, stderr = _run_python(
        client, _REMOTE_WALK_PY,
        (source_path, str(max_members), str(max_bytes), str(_MAX_WALK_DEPTH)),
        timeout=_LIST_TIMEOUT_S,
        max_stdout=4096,
    )
    if status != 0:
        err = stderr.decode('utf-8', 'replace').strip()
        if status == 7 or err.startswith('EMEMBERS'):
            raise TransferMemberLimitExceeded()
        if status == 8 or err.startswith('ESIZE'):
            raise TransferSizeExceeded()
        if status == 6 or err.startswith('EDEPTH'):
            raise ExecFSError('Maximum directory depth exceeded (50 levels)')
        if status == 2 or err.startswith('ENOENT'):
            raise ExecFSError(f'Source directory not found: {source_path}')
        if status == 3 or err.startswith('EACCES'):
            raise ExecFSError('Permission denied')
        raise ExecFSError(_decode_error(stderr, status, 'directory sizing failed'))
    parts = stdout.decode('ascii', 'replace').split()
    if len(parts) != 2:
        raise ExecFSError('directory sizing returned invalid summary')
    try:
        total = int(parts[0])
        count = int(parts[1])
    except ValueError as exc:
        raise ExecFSError('directory sizing returned invalid numbers') from exc
    if total < 0 or count < 0:
        raise ExecFSError('directory sizing returned invalid numbers')
    return total, count


# ── streaming transfer ───────────────────────────────────────────────────────

def _relay_with_backpressure(src_channel, dst_channel, *, cancel_event, max_bytes,
                             chunk_size, progress=None, hasher=None):
    """Copy src stdout -> dst stdin. Returns bytes transferred.

    Backpressure: the next chunk is only read after the previous chunk has been
    fully written into the destination channel. Cancellation is checked before
    each read AND after each write, so a stop lands within one chunk in both
    directions. The byte ceiling is enforced before the write, so an oversized
    source never lands bytes past the limit.
    """
    transferred = 0
    # Short channel timeouts keep cancel checks responsive even on an idle or
    # slow stream; the overall deadline belongs to the caller.
    try:
        src_channel.settimeout(1.0)
        dst_channel.settimeout(1.0)
    except Exception:
        pass

    while True:
        if _is_cancelled(cancel_event):
            raise TransferCancelled()
        try:
            chunk = src_channel.recv(chunk_size)
        except socket.timeout:
            continue
        except EOFError:
            return transferred

        if not chunk:
            return transferred

        next_size = transferred + len(chunk)
        if next_size > max_bytes:
            raise TransferSizeExceeded()

        # Write the whole chunk before reading more (backpressure).
        view = memoryview(chunk)
        while len(view):
            if _is_cancelled(cancel_event):
                raise TransferCancelled()
            try:
                sent = dst_channel.send(view)
            except socket.timeout:
                if _is_cancelled(cancel_event):
                    raise TransferCancelled()
                continue
            if not isinstance(sent, int) or sent <= 0:
                raise ExecFSError('destination write failed')
            view = view[sent:]

        if hasher is not None:
            hasher.update(chunk)
        transferred = next_size
        if progress:
            progress(transferred)
        if _is_cancelled(cancel_event):
            raise TransferCancelled()


def _await_exit(channel, timeout, *, cap=65536):
    """Wait for a channel's remote command to exit, draining residual output.

    Returns the collected stderr bytes (for error messages). Draining matters:
    a remote command that wrote more than the SSH window can hold would
    otherwise never exit, turning the deadline into a guaranteed timeout.
    """
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    while not channel.exit_status_ready():
        if time.monotonic() >= deadline:
            raise ExecFSError('remote command did not exit in time')
        try:
            if channel.recv_ready():
                channel.recv(65536)
            if channel.recv_stderr_ready():
                chunk = channel.recv_stderr(65536)
                if chunk and len(stderr) < cap:
                    stderr.extend(chunk)
        except (socket.timeout, EOFError):
            pass
        time.sleep(0.01)
    # Final drain after exit.
    try:
        while channel.recv_ready():
            if not channel.recv(65536):
                break
        while channel.recv_stderr_ready():
            chunk = channel.recv_stderr(65536)
            if not chunk:
                break
            if len(stderr) < cap:
                stderr.extend(chunk)
    except (socket.timeout, EOFError):
        pass
    return bytes(stderr)


def _finish_recv(dst_channel, *, timeout=_EXEC_TIMEOUT_S):
    """Close dest stdin, wait for the receiver, parse its ``SIZE HASH`` line."""
    try:
        dst_channel.shutdown_write()
    except Exception:
        pass

    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    while not dst_channel.exit_status_ready():
        if time.monotonic() >= deadline:
            raise ExecFSError('destination receiver timed out')
        try:
            if dst_channel.recv_ready():
                chunk = dst_channel.recv(4096)
                if chunk:
                    stdout.extend(chunk)
                    if len(stdout) > 4096:
                        raise ExecFSError(
                            'destination receiver produced too much output')
            if dst_channel.recv_stderr_ready():
                chunk = dst_channel.recv_stderr(4096)
                if chunk:
                    stderr.extend(chunk)
        except (socket.timeout, EOFError):
            pass
        time.sleep(0.01)

    # Final drain after exit: the summary often becomes readable at this point.
    try:
        while dst_channel.recv_ready():
            chunk = dst_channel.recv(4096)
            if not chunk:
                break
            stdout.extend(chunk)
        while dst_channel.recv_stderr_ready():
            chunk = dst_channel.recv_stderr(4096)
            if not chunk:
                break
            stderr.extend(chunk)
    except (socket.timeout, EOFError):
        pass

    status = dst_channel.recv_exit_status()
    if status != 0:
        raise ExecFSError(
            _decode_error(bytes(stderr), status,
                          'destination receiver failed'))

    line = bytes(stdout).decode('ascii', 'replace').strip()
    parts = line.split()
    if len(parts) != 2:
        raise ExecFSError('destination receiver returned invalid summary')
    try:
        size = int(parts[0])
    except ValueError as exc:
        raise ExecFSError(
            'destination receiver returned invalid size') from exc
    digest = parts[1].lower()
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ExecFSError('destination receiver returned invalid digest')
    return size, digest


def _open_source_stream(client, path):
    """Open the source reader channel (cat preferred, python3 fallback)."""
    if _client_has(client, 'cat'):
        # `cat --` so a filename starting with `-` is never a flag.
        return _open_exec(client, 'cat -- ' + shlex.quote(path),
                          timeout=_EXEC_TIMEOUT_S)
    _require(client, 'python3', 'read the source file')
    return _open_exec(client, _python_c_command(_REMOTE_CAT_PY, (path,)),
                      timeout=_EXEC_TIMEOUT_S)


def _open_dest_recv(client, temp_path):
    """Open the destination receiver: file bytes on stdin, path in argv."""
    _require(client, 'python3', 'verify sha256 on the destination')
    # The receiver script rides in -c (base64-wrapped), so stdin stays free
    # for the payload bytes.
    return _open_exec(client, _python_c_command(_REMOTE_RECV_PY, (temp_path,)),
                      timeout=_EXEC_TIMEOUT_S)


def transfer_file(source_client, source_path, dest_client, dest_path, *,
                  cancel_event=None, max_bytes=None, chunk_size=None,
                  progress=None):
    """Stream one file source→dest. Returns bytes transferred.

    Bytes land on a unique ``.sshdeck-transfer-<token>.tmp`` sibling of the
    destination and are published by a single atomic os.replace only after the
    stream completed, the relay sha256 matches the destination sha256, and the
    sizes agree. On any failure or cancel the temporary file is removed and the
    real destination is untouched.
    """
    max_bytes = config.MAX_ZIP_DOWNLOAD_SIZE if max_bytes is None else max_bytes
    chunk_size = config.CHUNK_SIZE if chunk_size is None else chunk_size

    if _is_cancelled(cancel_event):
        raise TransferCancelled()

    src_info = _stat_remote(source_client, source_path)
    if not src_info.get('exists'):
        raise ExecFSError(f'Source file not found: {source_path}')
    if src_info.get('is_dir'):
        raise ExecFSError('Source path is a directory')

    file_size = int(src_info.get('size') or 0)
    # Refuse before opening any stream when the ceiling is already exceeded.
    if file_size > max_bytes:
        raise TransferSizeExceeded()

    temporary_path = _temp_sibling(dest_path)
    src_ch = None
    dst_ch = None
    hasher = hashlib.sha256()
    transferred = 0
    published = False

    try:
        src_ch = _open_source_stream(source_client, source_path)
        dst_ch = _open_dest_recv(dest_client, temporary_path)

        transferred = _relay_with_backpressure(
            src_ch, dst_ch,
            cancel_event=cancel_event,
            # Remaining budget, so a later caller composing transfers cannot
            # exceed the aggregate ceiling one file at a time.
            max_bytes=max_bytes,
            chunk_size=chunk_size,
            progress=progress,
            hasher=hasher,
        )

        # Re-checked after the stream and BEFORE the rename: a cancel that
        # arrives on the final chunk must not publish the file.
        if _is_cancelled(cancel_event):
            raise TransferCancelled()

        src_stderr = _await_exit(src_ch, 10.0)
        src_status = src_ch.recv_exit_status()
        if src_status != 0:
            raise ExecFSError(
                _decode_error(src_stderr, src_status, 'source read failed'))

        dest_size, dest_digest = _finish_recv(dst_ch)
        backend_digest = hasher.hexdigest()

        if dest_size != transferred:
            raise ExecFSError(
                f'size mismatch: relayed {transferred}, '
                f'destination wrote {dest_size}')
        if file_size and dest_size != file_size:
            raise ExecFSError(
                f'size mismatch: source {file_size}, destination {dest_size}')
        if dest_digest != backend_digest:
            raise ExecFSError('sha256 mismatch between relay and destination')

        if _is_cancelled(cancel_event):
            raise TransferCancelled()

        _remote_publish(dest_client, temporary_path, dest_path)
        published = True
        return transferred
    except Exception:
        # Stop both remote commands BEFORE cleanup. If the receiver remains
        # alive while unlink runs, it can recreate/continue writing the temp
        # path after cleanup and leave garbage behind on cancel.
        _abort_streams(src_ch, dst_ch)
        src_ch = None
        dst_ch = None
        if not published:
            _remote_unlink(dest_client, temporary_path)
        raise
    finally:
        _close_channel(src_ch)
        _close_channel(dst_ch)


def transfer_directory(source_client, source_path, dest_client, dest_path, *,
                       cancel_event=None, max_bytes=None, max_members=None,
                       chunk_size=None, progress=None, directory_total=None,
                       directory_count=None):
    """Stream one directory tree via tar. Returns (bytes_streamed, total_size).

    Capabilities are checked up front and missing ones are reported clearly:
    python3 on the source (bounded sizing), tar on BOTH ends, python3 on the
    destination (mkdir / publish). The tree is extracted into a temporary root
    and published by exactly one atomic rename; an existing destination is
    refused, never merged.

    ``directory_total`` / ``directory_count`` are the preflight regular-file
    byte total and entry count. When omitted they are computed here via the
    bounded walker (which also enforces the member and byte ceilings BEFORE any
    byte is streamed). Pass them from the caller when the caller has already
    sized the tree, so progress has its denominator from the first chunk
    instead of only at the end, and the walker is not run twice.
    """
    max_bytes = config.MAX_ZIP_DOWNLOAD_SIZE if max_bytes is None else max_bytes
    max_members = (
        config.MAX_TRANSFER_MEMBERS if max_members is None else max_members)
    chunk_size = config.CHUNK_SIZE if chunk_size is None else chunk_size

    if _is_cancelled(cancel_event):
        raise TransferCancelled()

    _require(source_client, 'python3', 'size the source directory')
    _require(source_client, 'tar', 'stream the source directory')
    _require(dest_client, 'tar', 'extract the directory on the destination')
    _require(dest_client, 'python3', 'publish the directory on the destination')

    src_info = _stat_remote(source_client, source_path)
    if not src_info.get('exists'):
        raise ExecFSError(f'Source directory not found: {source_path}')
    if not src_info.get('is_dir'):
        raise ExecFSError('Source path is not a directory')

    # Refuse an existing destination up front: a directory is published by
    # exactly one rename, so there is no safe way to replace a tree part-way.
    dest_info = _stat_remote(dest_client, dest_path)
    if dest_info.get('exists'):
        raise ExecFSError('destination already exists')

    if directory_total is None or directory_count is None:
        # Preflight first: refuse an oversized tree before copying bytes, and
        # give progress a whole-transfer denominator.
        directory_total, directory_count = _walk_directory_total(
            source_client, source_path, max_members, max_bytes)

    temporary_path = _temp_sibling(dest_path)
    src_ch = None
    dst_ch = None
    published = False

    try:
        _remote_mkdir(dest_client, temporary_path)

        # Source helper writes an argv-safe NUL-delimited list to tar and skips
        # symlinks/special files; destination extracts into the temporary root.
        # Every path is a quoted argv element, never interpolated as shell syntax.
        src_cmd = _python_c_command(_REMOTE_TAR_SOURCE_PY, (source_path,))
        dst_cmd = 'tar -C %s -xf -' % shlex.quote(temporary_path)

        src_ch = _open_exec(source_client, src_cmd, timeout=_EXEC_TIMEOUT_S)
        dst_ch = _open_exec(dest_client, dst_cmd, timeout=_EXEC_TIMEOUT_S)

        # The CONTENT ceiling was already enforced by the preflight walker.
        # The relayed stream is the tar ARCHIVE, which adds a bounded header
        # per member (~512 bytes) plus block padding; give the relay that head
        # room so a tree exactly at the content ceiling is not spuriously
        # refused while the stream remains bounded.
        relay_budget = max_bytes + directory_count * 1024 + 65536

        transferred = _relay_with_backpressure(
            src_ch, dst_ch,
            cancel_event=cancel_event,
            max_bytes=relay_budget,
            chunk_size=chunk_size,
            progress=progress,
            hasher=None,
        )

        if _is_cancelled(cancel_event):
            raise TransferCancelled()

        try:
            dst_ch.shutdown_write()
        except Exception:
            pass

        src_stderr = _await_exit(src_ch, _EXEC_TIMEOUT_S)
        dst_stderr = _await_exit(dst_ch, _EXEC_TIMEOUT_S)
        src_status = src_ch.recv_exit_status()
        dst_status = dst_ch.recv_exit_status()
        if src_status != 0:
            raise ExecFSError(
                _decode_error(src_stderr, src_status, 'source tar failed'))
        if dst_status != 0:
            raise ExecFSError(
                _decode_error(dst_stderr, dst_status, 'destination tar failed'))

        if _is_cancelled(cancel_event):
            raise TransferCancelled()

        # Re-check immediately before publish: the destination must still be absent.
        dest_info = _stat_remote(dest_client, dest_path)
        if dest_info.get('exists'):
            raise ExecFSError('destination already exists')

        _remote_publish(dest_client, temporary_path, dest_path)
        published = True
        return transferred, directory_total
    except Exception:
        # Stop tar on both ends before removing the extraction root. Otherwise
        # destination tar can repopulate the tree after cleanup wins its race.
        _abort_streams(src_ch, dst_ch)
        src_ch = None
        dst_ch = None
        if not published:
            # Bounded, fail-safe: partial temporary trees are removed so a
            # cancelled directory copy does not accumulate remote garbage.
            _remote_unlink(dest_client, temporary_path)
        raise
    finally:
        _close_channel(src_ch)
        _close_channel(dst_ch)


def transfer_server_to_server(source_session_id, source_path, dest_session_id,
                              dest_path, transfer_id, socketio_instance=None,
                              is_dir=False, user_room=None, cancel_event=None,
                              max_bytes=None, max_members=None,
                              chunk_size=None):
    """Server-to-server copy over SSH exec channels (never SFTP).

    Signature and event contract match the historical SFTP implementation so
    the socket layer, transfer registry and UI stay unchanged:

      * emits ``s2s_transfer_started`` and ``s2s_transfer_progress`` only;
      * emits NEITHER s2s_transfer_complete NOR s2s_transfer_error — the socket
        layer owns terminal emission because only it can consult the transfer
        registry to decide whether this outcome actually won the race;
      * returns ``(success: bool, error: str or None)``.
    """
    max_bytes = config.MAX_ZIP_DOWNLOAD_SIZE if max_bytes is None else max_bytes
    max_members = (
        config.MAX_TRANSFER_MEMBERS if max_members is None else max_members)
    chunk_size = config.CHUNK_SIZE if chunk_size is None else chunk_size

    from .sftp_handler import sanitize_path
    source_path = sanitize_path(source_path)
    dest_path = sanitize_path(dest_path)
    if source_path is None or dest_path is None:
        return False, 'Invalid path'

    source_client, error = get_ssh_client(source_session_id)
    if error:
        return False, f'Source connection error: {error}'
    dest_client, error = get_ssh_client(dest_session_id)
    if error:
        return False, f'Destination connection error: {error}'

    log_debug('S2S exec transfer starting', transfer_id=transfer_id,
              is_dir=bool(is_dir))

    try:
        def emit_progress(filename, transferred, total, status='transferring'):
            """Emit progress to the owning room.

            The total is clamped up to the transferred count so a stale or
            under-reported total can never produce a percent above 100 or a
            negative one.
            """
            if socketio_instance and user_room:
                safe_total = max(int(total), int(transferred), 0)
                percent = (
                    min(100, max(0, int((transferred / safe_total) * 100)))
                    if safe_total > 0 else 0
                )
                socketio_instance.emit('s2s_transfer_progress', {
                    'transfer_id': transfer_id,
                    'filename': filename,
                    'transferred': transferred,
                    'total': safe_total,
                    'percent': percent,
                    'status': status,
                }, room=user_room)

        if socketio_instance and user_room:
            socketio_instance.emit('s2s_transfer_started', {
                'transfer_id': transfer_id,
                'source_path': source_path,
                'dest_path': dest_path,
                'is_dir': bool(is_dir),
            }, room=user_room)

        filename = posixpath.basename(source_path.rstrip('/')) or source_path

        if is_dir:
            # Preflight BEFORE any byte streams, exactly like the historical
            # SFTP walker: refuse an oversized/over-member tree up front and
            # give progress a whole-transfer denominator from chunk one.
            directory_total, directory_count = _walk_directory_total(
                source_client, source_path, max_members, max_bytes)

            def report(n):
                # n is the streamed tar-archive byte count, whose relationship
                # to the content total is not monotonic-bounded; clamp it so a
                # small tree in a large archive can never show >100% or a
                # backwards row, and let the terminal event below carry the
                # real content total.
                emit_progress(filename, min(n, directory_total) if
                              directory_total > 0 else n,
                              directory_total if directory_total > 0
                              else max(n, 1))

            transferred, _walked = transfer_directory(
                source_client, source_path, dest_client, dest_path,
                cancel_event=cancel_event,
                max_bytes=max_bytes,
                max_members=max_members,
                chunk_size=chunk_size,
                progress=report,
                directory_total=directory_total,
                directory_count=directory_count,
            )
            # Publish a final progress on the real denominator. The streamed
            # byte count is the tar archive size, not the content size, so the
            # terminal event reports the walked content total.
            emit_progress(filename, directory_total, directory_total,
                          'completed')
        else:
            src_info = _stat_remote(source_client, source_path)
            if not src_info.get('exists'):
                return False, f'Source file not found: {source_path}'
            total = int(src_info.get('size') or 0)
            if total > max_bytes:
                raise TransferSizeExceeded()

            def report(n):
                emit_progress(filename, n, total if total > 0 else max(n, 1))

            transferred = transfer_file(
                source_client, source_path, dest_client, dest_path,
                cancel_event=cancel_event,
                max_bytes=max_bytes,
                chunk_size=chunk_size,
                progress=report,
            )
            emit_progress(filename, transferred,
                          total if total > 0 else max(transferred, 1),
                          'completed')

        # A cancel that lands after the last byte but before this point must
        # not be reported as a completed transfer.
        if _is_cancelled(cancel_event):
            raise TransferCancelled()

        # NO s2s_transfer_complete HERE: emitting completion from this layer
        # Raced the socket layer's registry.complete. The outcome is reported
        # through the return value; progress events only are emitted here.
        return True, None

    except TransferCancelled:
        # Deliberate stop, not a failure: no s2s_transfer_error is emitted, so
        # the client shows a cancelled row instead of a red error toast.
        log_info('S2S transfer cancelled', transfer_id=transfer_id)
        return False, 'Transfer cancelled'

    except TransferSizeExceeded:
        log_warning('S2S transfer exceeded size limit', transfer_id=transfer_id)
        return False, 'Transfer exceeds configured size limit'

    except TransferMemberLimitExceeded:
        log_warning('S2S transfer exceeded member limit', transfer_id=transfer_id)
        return False, 'Transfer exceeds configured member limit'

    except UnsupportedRemote as exc:
        # Clear, honest unsupported: name the missing capability, never fake it.
        log_warning('S2S transfer unsupported on remote',
                    transfer_id=transfer_id, error=str(exc))
        return False, str(exc)

    except ExecFSError as exc:
        message = str(exc)
        if message.startswith('Source file not found') \
                or message.startswith('Source directory not found'):
            log_error('S2S transfer failed', error=message,
                      transfer_id=transfer_id)
            return False, message
        log_error('S2S transfer failed', error=message, transfer_id=transfer_id)
        return False, 'Transfer failed'

    except Exception as exc:
        # No s2s_transfer_error emission here: the socket layer decides whether
        # this outcome won the terminal race (see the docstring).
        log_error('S2S transfer failed', error=str(exc), transfer_id=transfer_id)
        return False, 'Transfer failed'
