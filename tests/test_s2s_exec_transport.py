"""S2S exec-channel transport — no SFTP subsystem contract.

These are integration-style unit tests: a Paramiko-shaped SSH client/transport/
channel double executes the *production remote commands* as real local shell
subprocesses. That exercises shlex quoting, the machine-readable Python listing
protocol, cat relay, destination receiver, sha256+size verification, temp cleanup
and atomic rename without needing a separate sshd in the unit suite.

Most importantly, every fake client has a non-vacuous ``open_sftp`` spy that
raises immediately. Listing plus a real file lifecycle must still pass and the
spy count must stay exactly zero. If production requests the SFTP subsystem at
any point, these tests fail at the request site (and again on the count).
"""

import os
import select
import socket
import subprocess
import threading
import time
import types

import pytest

from app import exec_fs, sftp_handler, socket_events


class _LocalExecChannel:
    """Paramiko Channel subset backed by a real local subprocess."""

    def __init__(self, owner=None):
        self.owner = owner
        self.timeout = 30.0
        self.proc = None
        self.command = None
        self.closed = False
        self._cancel_event = None
        self._cancel_after_first_recv = False
        self._recv_count = 0

    def settimeout(self, timeout):
        self.timeout = timeout

    def exec_command(self, command):
        self.command = command
        self.proc = subprocess.Popen(
            command,
            shell=True,
            executable='/bin/sh',
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        if self.owner is not None:
            self.owner.commands.append(command)
            if command.startswith('cat -- '):
                self._cancel_event = self.owner.cancel_event
                self._cancel_after_first_recv = (
                    self.owner.cancel_source_after_first_recv)

    def send(self, data):
        if self.proc is None or self.proc.stdin is None or self.proc.stdin.closed:
            return 0
        payload = bytes(data)
        try:
            written = os.write(self.proc.stdin.fileno(), payload)
        except BrokenPipeError:
            return 0
        return written

    def sendall(self, data):
        view = memoryview(data)
        while view:
            sent = self.send(view)
            if sent <= 0:
                raise EOFError('channel stdin closed')
            view = view[sent:]

    def shutdown_write(self):
        if self.proc is not None and self.proc.stdin is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass

    @staticmethod
    def _ready(pipe):
        if pipe is None or pipe.closed:
            return False
        readable, _, _ = select.select([pipe.fileno()], [], [], 0)
        return bool(readable)

    def recv_ready(self):
        return self.proc is not None and self._ready(self.proc.stdout)

    def recv_stderr_ready(self):
        return self.proc is not None and self._ready(self.proc.stderr)

    def _read(self, pipe, size):
        if self.proc is None or pipe is None or pipe.closed:
            return b''
        readable, _, _ = select.select(
            [pipe.fileno()], [], [], max(float(self.timeout), 0.0))
        if not readable:
            if self.proc.poll() is not None:
                return b''
            raise socket.timeout()
        chunk = os.read(pipe.fileno(), size)
        if pipe is self.proc.stdout and chunk:
            self._recv_count += 1
            if (self._cancel_after_first_recv and self._recv_count == 1
                    and self._cancel_event is not None):
                self._cancel_event.set()
        return chunk

    def recv(self, size):
        return self._read(self.proc.stdout, size)

    def recv_stderr(self, size):
        return self._read(self.proc.stderr, size)

    def exit_status_ready(self):
        return self.proc is not None and self.proc.poll() is not None

    def recv_exit_status(self):
        if self.proc is None:
            return -1
        return self.proc.wait(timeout=max(float(self.timeout), 1.0))

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.proc is None:
            return
        if self.proc.stdin is not None and not self.proc.stdin.closed:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)
        for pipe in (self.proc.stdout, self.proc.stderr):
            if pipe is not None and not pipe.closed:
                pipe.close()


class _LocalTransport:
    def __init__(self, owner):
        self.owner = owner
        self.channels = []

    def is_active(self):
        return True

    def open_session(self, timeout=None):
        channel = _LocalExecChannel(owner=self.owner)
        if timeout is not None:
            channel.settimeout(timeout)
        self.channels.append(channel)
        return channel


class _NoSFTPClient:
    """SSH client whose SFTP request is a hard test failure."""

    def __init__(self):
        self.open_sftp_calls = 0
        self.commands = []
        self.cancel_event = None
        self.cancel_source_after_first_recv = False
        self.transport = _LocalTransport(self)

    def get_transport(self):
        return self.transport

    def open_sftp(self):
        self.open_sftp_calls += 1
        raise AssertionError('production requested forbidden SFTP subsystem')


@pytest.fixture
def local_clients(monkeypatch):
    source = _NoSFTPClient()
    destination = _NoSFTPClient()

    def lookup(identifier):
        if identifier == 'src':
            return source, None
        if identifier == 'dst':
            return destination, None
        return None, 'not found'

    monkeypatch.setattr(exec_fs, 'get_ssh_client', lookup)
    # Capability cache can retain answers across object lifetimes; replace it
    # with a fresh WeakKeyDictionary for deterministic command-spy assertions.
    import weakref
    monkeypatch.setattr(exec_fs, '_capability_cache', weakref.WeakKeyDictionary())
    return source, destination


def _temp_entries(directory):
    return [p for p in directory.iterdir()
            if '.sshdeck-transfer-' in p.name]


class TestMachineReadableListingNeverUsesSFTP:

    def test_listing_round_trips_hostile_filenames(self, tmp_path, local_clients):
        source, destination = local_clients
        names = [
            'ordinary.txt',
            'space name.txt',
            'tab\tname.txt',
            'line\nname.txt',
            '-leading-dash.txt',
            'Tiếng Việt 日本語 🚀.txt',
            "quote'and\"double.txt",
        ]
        for index, name in enumerate(names):
            (tmp_path / name).write_bytes(f'payload-{index}'.encode())
        (tmp_path / 'a directory').mkdir()

        files, error = sftp_handler.list_directory_exec('src', str(tmp_path))

        assert error is None
        got = {item['name']: item for item in files}
        assert set(got) == set(names) | {'a directory'}
        assert got['a directory']['is_dir'] is True
        assert got['line\nname.txt']['size'] == len(b'payload-3')
        assert got['Tiếng Việt 日本語 🚀.txt']['is_symlink'] is False

        # Non-vacuous: production really opened exec channels and ran Python,
        # while the hard-failing SFTP spy was never touched.
        assert source.commands
        assert any(command.startswith('python3 -')
                   for command in source.commands)
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)
        # Fragile human-readable listing is forbidden, not merely unused by
        # this data set.
        assert not any('ls ' in command or command.endswith('ls')
                       for command in source.commands)

    def test_socket_route_listing_plus_file_copy_never_requests_sftp(
            self, tmp_path, local_clients, monkeypatch):
        """The whole production route, not merely an internal helper.

        Drive the real Socket.IO list handler with the exact transport flag the
        dual-pane client sends, then drive the real S2S entry point. A mutation
        from list_directory_exec -> list_directory would hit open_sftp() and
        fail immediately because both SSH clients carry a hard-failing spy.
        """
        source, destination = local_clients
        src = tmp_path / 'route source.txt'
        dst = tmp_path / 'route destination.txt'
        src.write_bytes(b'route lifecycle payload')

        emitted = []
        monkeypatch.setattr(socket_events, 'verify_session_ownership',
                            lambda session_id, user_id: True)
        monkeypatch.setattr(socket_events, 'emit',
                            lambda event, payload: emitted.append((event, payload)))

        # Make a route mutation to the SFTP listing hit the forbidden-subsystem
        # spy, rather than merely fail because no SFTP fake was installed.
        def forbidden_sftp_lookup(identifier):
            client = source if identifier == 'src' else destination
            return client.open_sftp(), None

        monkeypatch.setattr(sftp_handler, 'get_sftp_client',
                            forbidden_sftp_lookup)
        monkeypatch.setattr(sftp_handler, 'get_sftp_client_from_pool',
                            lambda _identifier: (None, 'not pooled'))
        user = types.SimpleNamespace(id=7, username='tester')

        socket_events.handle_list_directory.__wrapped__({
            'session_id': 'src',
            'remote_path': str(tmp_path),
            'transport': 'exec',
        }, current_user=user)

        listings = [payload for event, payload in emitted
                    if event == 'directory_listing']
        assert len(listings) == 1
        assert 'route source.txt' in {f['name'] for f in listings[0]['files']}

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'route-file')
        assert (ok, error) == (True, None)
        assert dst.read_bytes() == b'route lifecycle payload'
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_missing_transport_keeps_single_session_sftp_route(
            self, monkeypatch):
        """Files remains separate and unchanged: no flag means SFTP listing."""
        called = []
        emitted = []
        monkeypatch.setattr(socket_events, 'verify_session_ownership',
                            lambda session_id, user_id: True)
        monkeypatch.setattr(socket_events, 'emit',
                            lambda event, payload: emitted.append((event, payload)))
        monkeypatch.setattr(
            socket_events.sftp_handler, 'list_directory',
            lambda session_id, path: (called.append(('sftp', session_id, path))
                                      or [], None))
        monkeypatch.setattr(
            socket_events.sftp_handler, 'list_directory_exec',
            lambda *args: pytest.fail('single-session Files routed through exec'))

        socket_events.handle_list_directory.__wrapped__({
            'session_id': 'single', 'remote_path': '/files',
        }, current_user=types.SimpleNamespace(id=7, username='tester'))

        assert called == [('sftp', 'single', '/files')]
        assert [event for event, _payload in emitted] == ['directory_listing']

    def test_missing_python3_reports_precise_unsupported(self, tmp_path,
                                                         local_clients,
                                                         monkeypatch):
        source, _destination = local_clients
        real_has = exec_fs._client_has

        def missing_python(client, name):
            if client is source and name == 'python3':
                return False
            return real_has(client, name)

        monkeypatch.setattr(exec_fs, '_client_has', missing_python)
        files, error = sftp_handler.list_directory_exec('src', str(tmp_path))

        assert files is None
        assert error == ('Remote host has no python3; cannot run machine-readable '
                         'filesystem operations')
        assert source.open_sftp_calls == 0


class TestFileLifecycleNeverUsesSFTP:

    def test_real_file_copy_verifies_and_atomically_publishes(
            self, tmp_path, local_clients):
        source, destination = local_clients
        src_dir = tmp_path / "source dir"
        dst_dir = tmp_path / "destination dir"
        src_dir.mkdir()
        dst_dir.mkdir()
        source_path = src_dir / "-weird\tTiếng Việt\n'file.bin"
        dest_path = dst_dir / "-copied\tTiếng Việt\n'file.bin"
        payload = (bytes(range(256)) * 1024) + b'\x00final'
        source_path.write_bytes(payload)

        events = []

        class Recorder:
            def emit(self, event, data, room=None):
                events.append((event, data, room))

        ok, error = sftp_handler.transfer_server_to_server(
            source_session_id='src', source_path=str(source_path),
            dest_session_id='dst', dest_path=str(dest_path),
            transfer_id='exec-file-1', socketio_instance=Recorder(),
            user_room='sid-owner', chunk_size=4096)

        assert (ok, error) == (True, None)
        assert dest_path.read_bytes() == payload
        assert _temp_entries(dst_dir) == []
        names = [event for event, _data, _room in events]
        assert names.count('s2s_transfer_started') == 1
        assert 's2s_transfer_progress' in names
        assert 's2s_transfer_complete' not in names
        assert 's2s_transfer_error' not in names
        progress = [data for event, data, _room in events
                    if event == 's2s_transfer_progress']
        assert progress[-1]['percent'] == 100
        assert progress[-1]['status'] == 'completed'
        assert all(room == 'sid-owner' for _event, _data, room in events)

        # Production exercised a real cat channel and a real destination
        # receiver/publish sequence, while SFTP was a hard-failing spy.
        assert any(command.startswith('cat -- ')
                   for command in source.commands)
        assert any(command.startswith('python3 -c ')
                   for command in destination.commands)
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_existing_file_is_atomically_replaced(self, tmp_path, local_clients):
        source, destination = local_clients
        src = tmp_path / 'new.bin'
        dst = tmp_path / 'existing.bin'
        src.write_bytes(b'new content')
        dst.write_bytes(b'old content which must not be truncated early')

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-replace')

        assert (ok, error) == (True, None)
        assert dst.read_bytes() == b'new content'
        assert _temp_entries(tmp_path) == []
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_cancel_midstream_removes_temp_and_preserves_destination(
            self, tmp_path, local_clients):
        source, destination = local_clients
        cancel = threading.Event()
        source.cancel_event = cancel
        source.cancel_source_after_first_recv = True
        src = tmp_path / 'large-source.bin'
        dst = tmp_path / 'protected-destination.bin'
        src.write_bytes(os.urandom(1024 * 1024))
        dst.write_bytes(b'original stays intact')

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-cancel',
            cancel_event=cancel, chunk_size=4096)

        assert (ok, error) == (False, 'Transfer cancelled')
        assert dst.read_bytes() == b'original stays intact'
        assert _temp_entries(tmp_path) == []
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_size_limit_refuses_before_destination_write(
            self, tmp_path, local_clients):
        source, destination = local_clients
        src = tmp_path / 'too-large.bin'
        dst = tmp_path / 'must-not-exist.bin'
        src.write_bytes(b'x' * 4097)

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-limit',
            max_bytes=4096)

        assert (ok, error) == (
            False, 'Transfer exceeds configured size limit')
        assert not dst.exists()
        assert _temp_entries(tmp_path) == []
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)


class TestDirectoryTarTransport:

    def test_real_directory_lifecycle_uses_tar_not_sftp(
            self, tmp_path, local_clients):
        source, destination = local_clients
        src = tmp_path / 'source tree'
        dst = tmp_path / 'destination tree'
        src.mkdir()
        (src / 'space name.txt').write_text('space')
        (src / 'tab\tline\nname.txt').write_text('tab newline')
        nested = src / 'Tiếng Việt 日本語'
        nested.mkdir()
        (nested / '-leading.bin').write_bytes(b'\x00\x01\x02')
        # Directory transport preserves the former SFTP rule: symlinks are
        # skipped, never followed out of the source tree.
        (src / 'escape link').symlink_to('/etc/passwd')

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-dir',
            is_dir=True, max_members=20, max_bytes=1024 * 1024,
            chunk_size=4096)

        assert (ok, error) == (True, None)
        assert (dst / 'space name.txt').read_text() == 'space'
        assert (dst / 'tab\tline\nname.txt').read_text() == 'tab newline'
        assert (dst / 'Tiếng Việt 日本語' / '-leading.bin').read_bytes() \
            == b'\x00\x01\x02'
        assert not (dst / 'escape link').exists()
        assert _temp_entries(tmp_path) == []
        assert any(command.startswith('python3 -c ')
                   for command in source.commands)
        assert any(command.startswith('tar -C ')
                   for command in destination.commands)
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_missing_tar_reports_clear_unsupported(
            self, tmp_path, local_clients, monkeypatch):
        source, destination = local_clients
        src = tmp_path / 'tree'
        dst = tmp_path / 'out'
        src.mkdir()
        (src / 'f').write_bytes(b'x')
        real_has = exec_fs._client_has

        def missing_dest_tar(client, name):
            if client is destination and name == 'tar':
                return False
            return real_has(client, name)

        monkeypatch.setattr(exec_fs, '_client_has', missing_dest_tar)

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-no-tar', is_dir=True)

        assert ok is False
        assert error == ('Remote host has no tar; cannot extract the directory '
                         'on the destination')
        assert not dst.exists()
        assert _temp_entries(tmp_path) == []
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)

    def test_member_ceiling_refuses_before_tar_stream(
            self, tmp_path, local_clients):
        source, destination = local_clients
        src = tmp_path / 'many'
        dst = tmp_path / 'out'
        src.mkdir()
        for index in range(5):
            (src / f'f{index}').write_bytes(b'x')

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'exec-members',
            is_dir=True, max_members=3)

        assert (ok, error) == (
            False, 'Transfer exceeds configured member limit')
        assert not dst.exists()
        # Capability probes may mention tar, but no stream helper or extraction
        # command may start before the bounded member preflight refuses.
        assert not any(command.startswith('tar -C ')
                       for command in destination.commands)
        assert not any(command.startswith('python3 -c ')
                       for command in source.commands)
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0)


class TestNoSftpNoFallbackNoSkipGate:
    """W8 gate: S2S must succeed with the SFTP subsystem unavailable, and must
    not silently degrade to an SFTP path when exec is refused.

    The other tests in this module already keep ``open_sftp_calls`` at zero, but
    they do so as a side condition of whatever else they assert. These three
    make the three failure modes the owner named -- SFTP invoked, implicit
    fallback, silent skip -- first-class named assertions that cannot be
    satisfied vacuously.
    """

    def test_s2s_file_copy_succeeds_while_open_sftp_raises(
            self, tmp_path, local_clients):
        """The happy path, with SFTP hard-disabled on BOTH ends.

        ``_NoSFTPClient.open_sftp`` raises. A real byte-verified copy must still
        complete. This is the positive proof that the exec transport does not
        need the subsystem -- not merely that it happens not to call it.
        """
        source, destination = local_clients
        src = tmp_path / 'payload.bin'
        dst = tmp_path / 'delivered.bin'
        # Large enough to cross the relay's chunk boundary more than once.
        payload = os.urandom(256 * 1024)
        src.write_bytes(payload)

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'w8-no-sftp-ok')

        assert (ok, error) == (True, None), (
            f'S2S copy failed with SFTP disabled: {error!r}')
        assert dst.read_bytes() == payload, 'destination bytes differ'
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0), (
            'production requested the SFTP subsystem during an S2S copy')
        assert _temp_entries(tmp_path) == [], 'temp artifact left behind'

    def test_exec_refusal_reports_error_and_never_falls_back_to_sftp(
            self, tmp_path, local_clients, monkeypatch):
        """When the exec route cannot run, the transfer FAILS loudly.

        No implicit fallback: the result must be an error, the destination must
        not exist, and ``open_sftp`` must still never be requested. A fallback
        would show up as either a success or a non-zero spy count.
        """
        source, destination = local_clients
        src = tmp_path / 'src.txt'
        dst = tmp_path / 'dst.txt'
        src.write_bytes(b'content')

        real_has = exec_fs._client_has

        def no_reader(client, name):
            # Deny every command the source could use to read the file, so the
            # exec route has no viable path at all.
            if name in ('cat', 'python3'):
                return False
            return real_has(client, name)

        monkeypatch.setattr(exec_fs, '_client_has', no_reader)

        ok, error = sftp_handler.transfer_server_to_server(
            'src', str(src), 'dst', str(dst), 'w8-no-fallback')

        assert ok is False, 'exec refusal must not report success'
        assert error, 'exec refusal must carry a diagnostic message'
        assert not dst.exists(), 'destination created despite refused transfer'
        assert (source.open_sftp_calls, destination.open_sftp_calls) == (0, 0), (
            'refused exec transfer fell back to the SFTP subsystem')
        assert _temp_entries(tmp_path) == [], 'temp artifact left behind'

    def test_gate_body_runs_and_cannot_be_vacuously_satisfied(
            self, tmp_path, local_clients):
        """No-skip guard.

        A skipped or short-circuited gate proves nothing, so this asserts the
        spy itself is live: calling ``open_sftp`` directly MUST raise. If the
        double were ever replaced with a permissive one, the two tests above
        would keep passing while proving nothing -- this one goes red instead.
        """
        source, destination = local_clients

        for label, client in (('source', source), ('destination', destination)):
            with pytest.raises(AssertionError):
                client.open_sftp()
            # The failed request is still counted, so reset for later use.
            client.open_sftp_calls = 0
            assert client.open_sftp_calls == 0, f'{label} spy not resettable'
