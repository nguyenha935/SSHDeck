"""D7 — the SFTP surface has no unreachable branches left.

The objective's fix item 7 asks for an audit of "every ``open_sftp``, cache,
connection pool, socket event, handler and frontend Files path", the deletion of
the SFTP branches that are no longer reachable now that server-to-server copies
run over SSH exec, and the preservation of the rest as legitimate features. An
audit is only worth what it is pinned by, so this file is the pin: it derives the
reachability graph from the tree on every run instead of restating a conclusion
that was true once.

Two branches were deleted after being found unreachable here:

  * ``check_exists`` — the socket route, ``sftp_handler.check_exists`` and
    ``exec_fs.check_exists``. The only frontend listener for its reply
    (``file_exists_result``) forwarded to ``this.pendingConflictCheck``, which
    was never assigned anywhere in the file: a dead callback slot behind a dead
    reply behind a route nothing emitted.
  * ``get_file_stat`` — the socket route and ``sftp_handler.get_file_stat``. Its
    reply ``file_stat_result`` had no listener at all; the file manager reads
    size/mode/mtime from the ``directory_listing`` rows it already has.

What is deliberately NOT deleted, and is asserted alive below, is the whole
legitimate surface: single-session Files over SFTP, browser<->server upload and
download, and the dual-pane server-to-server transfer over exec.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def socket_event_names():
    """Every event name the server registers a handler for."""
    return sorted(set(re.findall(r"@socketio\.on\('([a-z_]+)'\)",
                                 read('app/socket_events.py'))))


def frontend_sources():
    """Every shipped frontend file that could emit or listen."""
    js = sorted((ROOT / 'static' / 'js').glob('*.js'))
    templates = sorted((ROOT / 'templates').glob('*.html'))
    return {p: p.read_text(encoding='utf-8') for p in js + templates}


# Events a browser never emits, each for a stated reason. Anything NOT in this
# map must be emitted by shipped frontend code, or it is an unreachable route.
SERVER_ONLY_EVENTS = {
    # Socket.IO's own lifecycle events: the transport raises them, not our code.
    'connect': 'socket.io transport lifecycle',
    'disconnect': 'socket.io transport lifecycle',
    # Answered with a refusal by design: OS probing wrote noise into the user's
    # terminal, so the handler exists to say no rather than to be called.
    'detect_os': 'disabled by design, replies with an error',
    # The session list reaches the client in the connect snapshot
    # (ssh_session_restored per session), so nothing needs to ask for it. Kept
    # because the integration suite drives it as the documented query route.
    'get_sessions': 'covered by the restore snapshot; integration-only route',
    # Emitted by tests/integration/test_paramiko5_socketio.py as the fast
    # teardown path; the UI closes sessions through ssh_disconnect.
    'quick_disconnect': 'integration-only teardown route',
}


def test_every_socket_route_is_reachable_from_shipped_frontend_code():
    """No handler may exist that nothing can call.

    This is the check that found check_exists and get_file_stat. It is derived,
    so a future route added without a caller fails here rather than sitting in
    the tree looking maintained.
    """
    sources = frontend_sources()
    unreachable = []
    for event in socket_event_names():
        if event in SERVER_ONLY_EVENTS:
            continue
        needle = f"'{event}'"
        if not any(needle in text for text in sources.values()):
            unreachable.append(event)
    assert unreachable == [], (
        'socket routes with no shipped caller (delete them or document them in '
        f'SERVER_ONLY_EVENTS with a reason): {unreachable}'
    )


def test_server_only_allowlist_has_no_stale_entries():
    """The allowlist must not outlive the routes it excuses."""
    registered = set(socket_event_names())
    stale = sorted(set(SERVER_ONLY_EVENTS) - registered)
    assert stale == [], f'SERVER_ONLY_EVENTS names routes that no longer exist: {stale}'


def test_no_frontend_listener_waits_for_a_reply_the_server_never_sends():
    """The mirror image: a listener for an event nothing emits is dead too.

    file_exists_result and file_stat_result were exactly this shape. The check is
    restricted to the sftp/file family because the wider event vocabulary is
    shared with terminal streaming, whose emitters live in ssh_manager and are
    reached through socketio.emit rather than emit().
    """
    # Every module that emits toward the client, not just the socket layer:
    # progress and completion frames are emitted from the transfer workers
    # (sftp_handler, binary_transfer) through the socketio instance they are
    # handed, which is exactly as real an emitter as emit() in a handler.
    server = ''.join(read(rel) for rel in (
        'app/socket_events.py', 'app/ssh_manager.py',
        'app/sftp_handler.py', 'app/binary_transfer.py', 'app/exec_fs.py',
    ))
    listened = set()
    for text in frontend_sources().values():
        listened.update(re.findall(
            r"socket\.on\(\s*'((?:file|sftp|directory|transfer)[a-z_]*)'", text))
    orphaned = sorted(name for name in listened if f"'{name}'" not in server)
    assert orphaned == [], (
        f'frontend listens for replies the server never emits: {orphaned}')


def test_the_deleted_branches_are_gone_from_every_layer():
    """A named regression guard, so the two routes cannot quietly return.

    Asserted per layer rather than as one repo-wide grep: a partial revival
    (handler back, helper still missing) is a worse state than either, and this
    names which layer regressed.
    """
    for rel, dead in (
        ('app/socket_events.py', ('check_exists', 'get_file_stat',
                                  'file_exists_result', 'file_stat_result')),
        ('app/sftp_handler.py', ('def check_exists', 'def get_file_stat')),
        ('app/exec_fs.py', ('def check_exists',)),
        ('static/js/sftp-file-manager.js', ('file_exists_result',
                                            'file_stat_result',
                                            'pendingConflictCheck')),
    ):
        source = read(rel)
        for name in dead:
            assert name not in source, f'{name} came back in {rel}'


def test_the_legitimate_sftp_surface_is_untouched():
    """D7 keeps the rest. Each of the three surfaces is asserted alive.

    Without this, the cleanup above could be "satisfied" by deleting the feature,
    which is the failure mode the objective warns about most explicitly.
    """
    events = set(socket_event_names())

    # 1) Single-session Files over SFTP.
    for event in ('list_directory', 'get_home_directory', 'create_directory',
                  'rename_file', 'delete_item', 'preview_file',
                  'open_file_for_edit', 'save_file'):
        assert event in events, f'single-session Files lost its {event} route'
    handler = read('app/sftp_handler.py')
    assert 'def list_directory(' in handler
    assert 'def get_home_directory(' in handler
    assert 'def rename_item(' in handler
    assert 'client.open_sftp()' in handler, (
        'the SFTP transport itself was removed; Files needs it')

    # 2) Browser <-> server upload and download.
    for event in ('upload_file', 'download_file'):
        assert event in events, f'browser<->server transfer lost {event}'
    assert 'def upload_file_chunked(' in handler
    assert 'def download_file_chunked(' in handler

    # 3) Dual-pane server-to-server over exec, never SFTP.
    assert 'transfer_server_to_server' in events
    exec_fs = read('app/exec_fs.py')
    assert 'def transfer_server_to_server(' in exec_fs
    assert 'open_sftp' not in exec_fs, (
        'the exec transport must never request the SFTP subsystem')
    assert 'def list_directory_exec(' in handler
    assert 'def get_home_directory_exec(' in handler


def test_the_exec_transport_has_no_silent_sftp_fallback():
    """S2S must fail loudly on a host without SFTP, never degrade to it.

    The listing route is the one place a fallback could hide, because it takes a
    transport flag. Pinned on the branch itself: exec is selected explicitly and
    its result is returned, with no except/else path reaching the SFTP helper.
    """
    events_src = read('app/socket_events.py')
    start = events_src.index("@socketio.on('list_directory')")
    end = events_src.index('@socketio.on(', start + 10)
    body = events_src[start:end]
    assert "if transport == 'exec':" in body
    assert 'list_directory_exec(' in body
    exec_branch = body[body.index("if transport == 'exec':"):body.index('else:')]
    assert 'list_directory(session_id' not in exec_branch, (
        'the exec listing branch can reach the SFTP helper')
    # And the transport value is validated rather than silently coerced.
    assert "if transport not in (None, 'sftp', 'exec'):" in body
