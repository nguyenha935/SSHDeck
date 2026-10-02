"""The server half of the Files browser (batch 2a).

Found while auditing for the browser (2026-10-02), each pinned here:

  * delete had no guard. A path of " " sanitised to "." -- the SFTP working
    directory, which is home -- so one malformed payload deleted the user's
    home recursively, and "/" was accepted as it stands;
  * sanitize_path refused any path CONTAINING "..", so a file named file..txt
    could not be listed into, renamed, deleted or downloaded;
  * a symlink to a directory was listed as a file, with no target;
  * every operation answered with frames that name no request, so an error
    could not be tied to what caused it.

The SFTP client is a fake: these are the decisions this code makes, not
paramiko's or OpenSSH's (tests/integration covers a real server).
"""
import stat
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app import sftp_handler
from app.sftp_handler import sanitize_path


# ── sanitize_path ────────────────────────────────────────────────────────────

@pytest.mark.parametrize('path, expected', [
    ('file..txt', 'file..txt'),
    ('/opt/v1..2/notes', '/opt/v1..2/notes'),
    ('...', '...'),
    ('/a/../b', '/b'),
])
def test_dotdot_inside_a_name_is_a_name(path, expected):
    assert sanitize_path(path) == expected


@pytest.mark.parametrize('path', ['..', '../x', 'a/../../x', 'a/b/../../..'])
def test_dotdot_as_a_component_is_still_traversal(path):
    assert sanitize_path(path) is None


# ── a fake SFTP server ───────────────────────────────────────────────────────

HOME = '/home/u'
DIR = stat.S_IFDIR | 0o755
FILE = stat.S_IFREG | 0o644
LINK = stat.S_IFLNK | 0o777


class Attr:
    def __init__(self, name, mode, longname=None, uid=None, gid=None):
        self.filename = name
        self.st_mode = mode
        self.st_size = 10
        self.st_mtime = 1759390000
        self.st_uid = uid
        self.st_gid = gid
        if longname is not None:
            self.longname = longname


class FakeSFTP:
    """A tree of paths -> modes; links -> (target, target_mode or None)."""

    def __init__(self, tree, links=None):
        self.tree = dict(tree)
        self.links = dict(links or {})
        self.calls = []

    def normalize(self, path):
        if path in ('.', ''):
            return HOME
        return path if path.startswith('/') else f'{HOME}/{path}'

    def lstat(self, path):
        self.calls.append(('lstat', path))
        path = self.normalize(path)
        if path not in self.tree:
            raise IOError(2, 'No such file')
        return Attr(path.rsplit('/', 1)[-1], self.tree[path])

    def stat(self, path):
        self.calls.append(('stat', path))
        target_mode = self.links.get(path, (None, None))[1]
        if target_mode is None:
            raise IOError(2, 'No such file')
        return Attr(path, target_mode)

    def readlink(self, path):
        self.calls.append(('readlink', path))
        return self.links[path][0]

    def listdir_attr(self, path):
        path = self.normalize(path)
        prefix = path.rstrip('/') + '/'
        return [Attr(p[len(prefix):], mode) for p, mode in self.tree.items()
                if p.startswith(prefix) and '/' not in p[len(prefix):]]

    def remove(self, path):
        self.calls.append(('remove', path))
        self.tree.pop(self.normalize(path), None)

    def rmdir(self, path):
        self.calls.append(('rmdir', path))
        self.tree.pop(self.normalize(path), None)

    def mkdir(self, path):
        self.calls.append(('mkdir', path))

    def rename(self, old, new):
        self.calls.append(('rename', old, new))

    def open(self, path, mode):
        self.calls.append(('open', path, mode))
        return type('Handle', (), {'close': lambda self: None})()


@pytest.fixture
def fake(monkeypatch):
    server = FakeSFTP({
        '/': DIR, '/home': DIR, HOME: DIR, f'{HOME}/sub': DIR,
        f'{HOME}/sub/a.txt': FILE, f'{HOME}/notes.txt': FILE,
        f'{HOME}/to-home': LINK,
    })

    @contextmanager
    def session(session_id):
        yield server, 'session'

    monkeypatch.setattr(sftp_handler, 'sftp_session', session)
    return server


# ── delete guard ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize('path', [' ', '.', '/', HOME, '/home', f'{HOME}/sub/..'])
def test_home_the_root_and_their_parents_are_never_deleted(fake, path):
    before = dict(fake.tree)
    ok, error = sftp_handler.delete_directory_recursive('s1', path)
    assert not ok and 'Refusing to delete' in error
    assert fake.tree == before
    assert [c for c in fake.calls if c[0] in ('remove', 'rmdir')] == []


def test_a_directory_inside_home_is_deleted_with_its_contents(fake):
    ok, error = sftp_handler.delete_directory_recursive('s1', f'{HOME}/sub')
    assert (ok, error) == (True, None)
    assert f'{HOME}/sub' not in fake.tree and f'{HOME}/sub/a.txt' not in fake.tree


def test_a_link_to_home_is_removed_as_a_link(fake):
    ok, error = sftp_handler.delete_directory_recursive('s1', f'{HOME}/to-home')
    assert (ok, error) == (True, None)
    assert ('remove', f'{HOME}/to-home') in fake.calls
    assert HOME in fake.tree


# ── create and rename never touch an existing name ───────────────────────────

def test_create_file_opens_exclusively(fake):
    assert sftp_handler.create_file('s1', f'{HOME}/new.txt') == (True, None)
    assert ('open', f'{HOME}/new.txt', 'x') in fake.calls


@pytest.mark.parametrize('call', [
    lambda: sftp_handler.create_file('s1', f'{HOME}/notes.txt'),
    lambda: sftp_handler.create_directory('s1', f'{HOME}/sub'),
    lambda: sftp_handler.rename_item('s1', f'{HOME}/sub', f'{HOME}/notes.txt'),
])
def test_an_existing_name_is_refused_and_said_so(fake, call):
    ok, error = call()
    assert not ok and error.endswith('already exists')
    assert [c for c in fake.calls if c[0] in ('open', 'mkdir', 'rename')] == []


# ── listing: owner, group, symlinks ──────────────────────────────────────────

def listing(monkeypatch, entries, links):
    server = FakeSFTP({}, links)
    server.listdir_attr = lambda path: entries

    @contextmanager
    def session(session_id):
        yield server, 'session'

    monkeypatch.setattr(sftp_handler, 'sftp_session', session)
    files, error = sftp_handler.list_directory('s1', '/opt')
    assert error is None
    return {f['name']: f for f in files}, server


def test_owner_and_group_come_from_the_long_name(monkeypatch):
    rows, _ = listing(monkeypatch, [
        Attr('app.py', FILE, '-rw-r--r--    1 www-data adm  18 Oct  2 14:05 app.py', 33, 4),
        Attr('bare', FILE, None, 0, 0),
        Attr('odd', FILE, 'not an ls line', 7, 8),
    ], {})
    assert (rows['app.py']['owner'], rows['app.py']['group']) == ('www-data', 'adm')
    assert (rows['bare']['owner'], rows['bare']['group']) == ('0', '0')
    assert (rows['odd']['owner'], rows['odd']['group']) == ('7', '8')


def test_a_symlink_says_where_it_points_and_what_that_is(monkeypatch):
    rows, _ = listing(monkeypatch, [
        Attr('current', LINK), Attr('gone', LINK), Attr('app.py', FILE),
    ], {
        '/opt/current': ('releases/v74', DIR),
        '/opt/gone': ('nowhere', None),
    })
    assert {k: rows['current'][k] for k in ('link_target', 'target_is_dir', 'broken')} == {
        'link_target': 'releases/v74', 'target_is_dir': True, 'broken': False}
    assert (rows['gone']['target_is_dir'], rows['gone']['broken']) == (False, True)
    assert 'link_target' not in rows['app.py']


def test_link_resolution_is_bounded_per_listing(monkeypatch):
    count = sftp_handler.LINK_DETAIL_LIMIT + 6
    entries = [Attr(f'l{i}', LINK) for i in range(count)]
    links = {f'/opt/l{i}': ('t', FILE) for i in range(count)}
    rows, server = listing(monkeypatch, entries, links)
    resolved = [name for name, row in rows.items() if 'link_target' in row]
    assert len(resolved) == sftp_handler.LINK_DETAIL_LIMIT
    assert len(rows) == count
    assert sum(1 for c in server.calls if c[0] in ('stat', 'readlink')) == 2 * len(resolved)


def test_link_resolution_stops_at_its_time_budget(monkeypatch):
    # The first reading sets the deadline; then 0.1 s passes per link. With a
    # 0.15 s budget the links checked at 0.0 and 0.1 are resolved, the rest
    # are listed without a target -- however many the count cap would allow.
    clock = iter([0.0] + [k * 0.1 for k in range(10)])
    monkeypatch.setattr(sftp_handler, 'time', SimpleNamespace(monotonic=lambda: next(clock)))
    entries = [Attr(f'l{i}', LINK) for i in range(5)]
    rows, server = listing(monkeypatch, entries, {f'/opt/l{i}': ('t', FILE) for i in range(5)})
    assert sorted(name for name, row in rows.items() if 'link_target' in row) == ['l0', 'l1']
    assert len(rows) == 5


# ── handlers: one correlated reply ───────────────────────────────────────────

@pytest.fixture
def owner(app, monkeypatch):
    """One user owning session 's1' on socket 'sock-1'; emits recorded."""
    from app.auth import register_socket_session, register_user
    from app.models import db, SSHSession
    import app.socket_events as socket_events

    with app.app_context():
        user, error = register_user('browserowner', 'browser-password-123')
        assert error is None
        db.session.add(SSHSession(session_id='s1', user_id=user.id, host='h', port=22,
                                  username='root', connected=True))
        register_socket_session(user.id, 'sock-1')
        db.session.commit()

    emits = []
    monkeypatch.setattr(socket_events, 'emit', lambda event, payload=None, **kw: emits.append((event, payload)))
    return socket_events, emits


def call(app, socket_events, handler, payload):
    from flask import request
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'sock-1'
        getattr(socket_events, handler)(payload)


def test_delete_items_answers_once_with_a_result_per_item(app, owner, monkeypatch):
    socket_events, emits = owner
    outcomes = {'/opt/a': (True, None), '/opt/b': (False, 'Permission denied')}
    monkeypatch.setattr(sftp_handler, 'delete_directory_recursive',
                        lambda session_id, path: outcomes[path])
    call(app, socket_events, 'handle_delete_items',
         {'session_id': 's1', 'paths': ['/opt/a', '/opt/b'], 'request_id': 'r1'})
    assert emits == [('fm_result', {
        'request_id': 'r1', 'op': 'delete_items', 'session_id': 's1', 'results': [
            {'path': '/opt/a', 'ok': True, 'error': None},
            {'path': '/opt/b', 'ok': False, 'error': 'Permission denied'},
        ]})]


@pytest.mark.parametrize('payload, message', [
    ({'session_id': 's1', 'paths': []}, 'Missing required fields'),
    ({'session_id': 's1', 'paths': ['/opt/a', '']}, 'Missing required fields'),
    ({'session_id': 's1', 'paths': '/opt/a'}, 'Missing required fields'),
    ({'session_id': 's1', 'paths': ['/x'] * 1001}, 'At most 1000 items at a time'),
    ({'session_id': 'someone-else', 'paths': ['/opt/a']}, 'Unauthorized access'),
])
def test_delete_items_refusals_name_the_request(app, owner, monkeypatch, payload, message):
    socket_events, emits = owner
    ran = []
    monkeypatch.setattr(sftp_handler, 'delete_directory_recursive',
                        lambda *args: ran.append(args) or (True, None))
    call(app, socket_events, 'handle_delete_items', {**payload, 'request_id': 'r2'})
    assert ran == []
    assert emits == [('fm_result', {
        'request_id': 'r2', 'op': 'delete_items', 'session_id': payload['session_id'],
        'results': [{'path': None, 'ok': False, 'error': message}]})]


@pytest.mark.parametrize('handler, op, fn, payload', [
    ('handle_create_file', 'create_file', 'create_file', {'remote_path': '/opt/n.txt'}),
    ('handle_create_directory', 'create_directory', 'create_directory', {'remote_path': '/opt/n'}),
    ('handle_rename_file', 'rename_file', 'rename_item', {'old_path': '/opt/a', 'new_path': '/opt/b'}),
])
def test_a_browser_operation_fails_into_its_own_reply_not_the_generic_error(
        app, owner, monkeypatch, handler, op, fn, payload):
    socket_events, emits = owner
    monkeypatch.setattr(sftp_handler, fn, lambda *args: (False, 'n already exists'))
    call(app, socket_events, handler, {'session_id': 's1', 'request_id': 'r3', **payload})
    path = payload.get('remote_path') or payload['old_path']
    assert emits == [('fm_result', {
        'request_id': 'r3', 'op': op, 'session_id': 's1',
        'results': [{'path': path, 'ok': False, 'error': 'n already exists'}]})]


@pytest.mark.parametrize('handler, fn, payload, reply', [
    ('handle_create_directory', 'create_directory', {'remote_path': '/opt/n'},
     ('directory_created', {'path': '/opt/n'})),
    ('handle_rename_file', 'rename_item', {'old_path': '/opt/a', 'new_path': '/opt/b'},
     ('file_renamed', {'old_path': '/opt/a', 'new_path': '/opt/b'})),
])
def test_without_a_request_id_the_legacy_replies_are_unchanged(
        app, owner, monkeypatch, handler, fn, payload, reply):
    socket_events, emits = owner
    monkeypatch.setattr(sftp_handler, fn, lambda *args: (True, None))
    call(app, socket_events, handler, {'session_id': 's1', **payload})
    assert emits == [reply]
