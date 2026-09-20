"""Low-level SSH exec-channel S2S transport contracts.

The old version of this file tested an in-memory SFTP walker. That transport is
intentionally gone: production dual-pane File Transfer must never request the
SFTP subsystem. Its behavioral lifecycle is now exercised against real local
subprocesses in ``test_s2s_exec_transport.py``. This file preserves and expands
the lower-level coverage with deterministic exec-channel doubles:

  * bounded chunk relay, partial-send backpressure and progress;
  * cancellation before read, after a real chunk, and during partial writes;
  * byte-limit enforcement before destination write;
  * source EOF / timeout behavior and sha256 accumulation;
  * destination receiver summary parsing and failure handling;
  * authenticated session + pool SSH-client lookup without SFTP;
  * precise capability errors, temporary naming and atomic-publish failures.

No test skips and no SFTP fake: these are the production exec primitives.
"""

import hashlib
import socket
import threading
import time
import types

import pytest

from app import exec_fs


class _RelaySource:
    def __init__(self, chunks, *, cancel_event=None, cancel_after=None,
                 timeout_once=False, eof_error=False):
        self.chunks = list(chunks)
        self.cancel_event = cancel_event
        self.cancel_after = cancel_after
        self.timeout_once = timeout_once
        self.eof_error = eof_error
        self.reads = []
        self.timeout = None

    def settimeout(self, value):
        self.timeout = value

    def recv(self, size):
        self.reads.append(size)
        if self.timeout_once:
            self.timeout_once = False
            raise socket.timeout()
        if self.eof_error and not self.chunks:
            raise EOFError()
        chunk = self.chunks.pop(0) if self.chunks else b''
        if (self.cancel_event is not None and self.cancel_after is not None
                and len(self.reads) == self.cancel_after):
            self.cancel_event.set()
        return chunk


class _RelayDestination:
    def __init__(self, *, max_send=None, zero_send=False, cancel_event=None,
                 cancel_after_send=None, timeout_once=False):
        self.max_send = max_send
        self.zero_send = zero_send
        self.cancel_event = cancel_event
        self.cancel_after_send = cancel_after_send
        self.timeout_once = timeout_once
        self.sends = []
        self.data = bytearray()
        self.timeout = None

    def settimeout(self, value):
        self.timeout = value

    def send(self, data):
        if self.timeout_once:
            self.timeout_once = False
            raise socket.timeout()
        if self.zero_send:
            return 0
        payload = bytes(data)
        count = min(len(payload), self.max_send or len(payload))
        self.sends.append(count)
        self.data.extend(payload[:count])
        if (self.cancel_event is not None
                and self.cancel_after_send is not None
                and len(self.sends) == self.cancel_after_send):
            self.cancel_event.set()
        return count


class TestRelayBackpressureAndCancellation:

    def test_precancelled_relay_reads_and_writes_nothing(self):
        cancel = threading.Event()
        cancel.set()
        source = _RelaySource([b'payload'])
        dest = _RelayDestination()

        with pytest.raises(exec_fs.TransferCancelled):
            exec_fs._relay_with_backpressure(
                source, dest, cancel_event=cancel, max_bytes=100,
                chunk_size=16)

        assert source.reads == []
        assert dest.sends == []

    def test_happy_path_relays_multiple_chunks(self):
        source = _RelaySource([b'abc', b'defg', b''])
        dest = _RelayDestination()

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=8)

        assert transferred == 7
        assert bytes(dest.data) == b'abcdefg'
        assert source.reads == [8, 8, 8]

    def test_cancel_after_first_real_read_stops_before_write(self):
        cancel = threading.Event()
        source = _RelaySource([b'first', b'second'], cancel_event=cancel,
                              cancel_after=1)
        dest = _RelayDestination()

        with pytest.raises(exec_fs.TransferCancelled):
            exec_fs._relay_with_backpressure(
                source, dest, cancel_event=cancel, max_bytes=100,
                chunk_size=8)

        # The stop lands after recv but before destination send.
        assert source.reads == [8]
        assert bytes(dest.data) == b''

    def test_cancel_during_partial_write_stops_within_one_chunk(self):
        cancel = threading.Event()
        source = _RelaySource([b'abcdefgh', b''])
        dest = _RelayDestination(max_send=2, cancel_event=cancel,
                                 cancel_after_send=1)

        with pytest.raises(exec_fs.TransferCancelled):
            exec_fs._relay_with_backpressure(
                source, dest, cancel_event=cancel, max_bytes=100,
                chunk_size=8)

        assert 0 < len(dest.data) < 8
        assert source.reads == [8]

    def test_byte_ceiling_is_checked_before_destination_write(self):
        source = _RelaySource([b'12345'])
        dest = _RelayDestination()

        with pytest.raises(exec_fs.TransferSizeExceeded):
            exec_fs._relay_with_backpressure(
                source, dest, cancel_event=None, max_bytes=4, chunk_size=8)

        assert bytes(dest.data) == b''

    def test_partial_sends_are_retried_before_next_source_read(self):
        source = _RelaySource([b'abcdefgh', b''])
        dest = _RelayDestination(max_send=3)

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=8)

        assert transferred == 8
        assert bytes(dest.data) == b'abcdefgh'
        assert dest.sends == [3, 3, 2]
        assert source.reads == [8, 8]

    def test_zero_length_destination_send_is_a_real_failure(self):
        source = _RelaySource([b'abc'])
        dest = _RelayDestination(zero_send=True)

        with pytest.raises(exec_fs.ExecFSError,
                           match='destination write failed'):
            exec_fs._relay_with_backpressure(
                source, dest, cancel_event=None, max_bytes=100,
                chunk_size=8)

    def test_progress_reports_monotonic_totals(self):
        progress = []
        source = _RelaySource([b'a', b'bc', b'def', b''])
        dest = _RelayDestination()

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=4,
            progress=progress.append)

        assert transferred == 6
        assert progress == [1, 3, 6]

    def test_sha256_is_updated_over_exact_relayed_bytes(self):
        hasher = hashlib.sha256()
        source = _RelaySource([b'alpha', b'\x00beta', b''])
        dest = _RelayDestination()

        exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=16,
            hasher=hasher)

        assert hasher.hexdigest() == hashlib.sha256(
            b'alpha\x00beta').hexdigest()

    def test_source_timeout_is_retried_not_treated_as_eof(self):
        source = _RelaySource([b'after-timeout', b''], timeout_once=True)
        dest = _RelayDestination()

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=32)

        assert transferred == len(b'after-timeout')
        assert bytes(dest.data) == b'after-timeout'
        assert len(source.reads) == 3

    def test_destination_timeout_is_retried_with_same_partial_view(self):
        source = _RelaySource([b'payload', b''])
        dest = _RelayDestination(timeout_once=True)

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=16)

        assert transferred == 7
        assert bytes(dest.data) == b'payload'

    def test_source_eoferror_finishes_cleanly(self):
        source = _RelaySource([b'payload'], eof_error=True)
        dest = _RelayDestination()

        transferred = exec_fs._relay_with_backpressure(
            source, dest, cancel_event=None, max_bytes=100, chunk_size=16)

        assert transferred == 7
        assert bytes(dest.data) == b'payload'


class _ReceiverChannel:
    def __init__(self, stdout, stderr=b'', status=0, *, ready=True,
                 never_exit=False):
        self.stdout = bytearray(stdout)
        self.stderr = bytearray(stderr)
        self.status = status
        self.ready = ready
        self.never_exit = never_exit
        self.shutdowns = 0

    def shutdown_write(self):
        self.shutdowns += 1

    def exit_status_ready(self):
        return False if self.never_exit else self.ready

    def recv_ready(self):
        return bool(self.stdout)

    def recv_stderr_ready(self):
        return bool(self.stderr)

    def recv(self, size):
        chunk = bytes(self.stdout[:size])
        del self.stdout[:size]
        return chunk

    def recv_stderr(self, size):
        chunk = bytes(self.stderr[:size])
        del self.stderr[:size]
        return chunk

    def recv_exit_status(self):
        return self.status


class TestDestinationReceiverSummary:

    def test_valid_summary_returns_size_and_digest(self):
        digest = hashlib.sha256(b'abc').hexdigest()
        channel = _ReceiverChannel(f'3 {digest}\n'.encode())

        assert exec_fs._finish_recv(channel, timeout=0.1) == (3, digest)
        assert channel.shutdowns == 1

    @pytest.mark.parametrize('summary', [b'', b'3', b'3 hash extra'])
    def test_invalid_summary_shape_is_refused(self, summary):
        channel = _ReceiverChannel(summary)
        with pytest.raises(exec_fs.ExecFSError,
                           match='invalid summary'):
            exec_fs._finish_recv(channel, timeout=0.1)

    def test_invalid_size_is_refused(self):
        channel = _ReceiverChannel(b'NaN ' + b'a' * 64 + b'\n')
        with pytest.raises(exec_fs.ExecFSError, match='invalid size'):
            exec_fs._finish_recv(channel, timeout=0.1)

    @pytest.mark.parametrize('digest', [b'a' * 63, b'g' * 64, b'a' * 65])
    def test_invalid_digest_is_refused(self, digest):
        channel = _ReceiverChannel(b'1 ' + digest + b'\n')
        with pytest.raises(exec_fs.ExecFSError, match='invalid digest'):
            exec_fs._finish_recv(channel, timeout=0.1)

    def test_nonzero_receiver_exit_surfaces_stderr(self):
        channel = _ReceiverChannel(b'', b'remote disk full\n', status=7)
        with pytest.raises(exec_fs.ExecFSError, match='remote disk full'):
            exec_fs._finish_recv(channel, timeout=0.1)

    def test_receiver_timeout_is_bounded(self):
        channel = _ReceiverChannel(b'', never_exit=True)
        started = time.monotonic()
        with pytest.raises(exec_fs.ExecFSError, match='timed out'):
            exec_fs._finish_recv(channel, timeout=0.02)
        assert time.monotonic() - started < 0.5


class _Client:
    def __init__(self):
        self.open_sftp_calls = 0

    def open_sftp(self):
        self.open_sftp_calls += 1
        raise AssertionError('forbidden SFTP request')


class TestSSHClientLookupNeverOpensSFTP:

    def test_live_session_returns_stored_ssh_client(self, monkeypatch):
        client = _Client()
        monkeypatch.setitem(exec_fs.ssh_manager.sessions, 'session-id', {
            'connected': True, 'client': client,
        })

        got, error = exec_fs.get_ssh_client('session-id')

        assert (got, error) == (client, None)
        assert client.open_sftp_calls == 0
        exec_fs.ssh_manager.sessions.pop('session-id', None)

    def test_disconnected_session_is_refused_without_sftp(self, monkeypatch):
        client = _Client()
        monkeypatch.setitem(exec_fs.ssh_manager.sessions, 'closed-id', {
            'connected': False, 'client': client,
        })

        got, error = exec_fs.get_ssh_client('closed-id')

        assert got is None
        assert error == 'Session not connected'
        assert client.open_sftp_calls == 0
        exec_fs.ssh_manager.sessions.pop('closed-id', None)

    def test_pool_lookup_returns_client_and_refreshes_last_used(self,
                                                                monkeypatch):
        from app import connection_pool
        pool = connection_pool.temp_connection_pool
        client = _Client()
        record = {'client': client, 'last_used': 0}
        with pool.lock:
            pool.connections['pool-id'] = record
        try:
            before = time.time()
            got, error = exec_fs.get_ssh_client('pool-id')
            assert (got, error) == (client, None)
            assert record['last_used'] >= before
            assert client.open_sftp_calls == 0
        finally:
            with pool.lock:
                pool.connections.pop('pool-id', None)

    def test_unknown_identifier_reports_precise_error(self):
        got, error = exec_fs.get_ssh_client('never-existed')
        assert got is None
        assert error == 'No active connection found for: never-existed'


class TestPathAndCapabilityPrimitives:

    def test_temp_path_is_sibling_and_unique(self):
        first = exec_fs._temp_sibling('/tmp/name with spaces')
        second = exec_fs._temp_sibling('/tmp/name with spaces')
        assert first.startswith(
            '/tmp/name with spaces.sshdeck-transfer-')
        assert first.endswith('.tmp')
        assert first != second

    def test_python_command_quotes_every_path_as_one_argument(self):
        command = exec_fs._python_c_command(
            'pass', ("/tmp/a b", "/tmp/line\nname", "/tmp/'quote", '-dash'))
        # shlex.split is the inverse check: all hostile names remain exactly one
        # argv element and '--' precedes them.
        import shlex
        argv = shlex.split(command)
        assert argv[:3] == ['python3', '-c', argv[2]]
        assert argv[3:] == [
            '--', '/tmp/a b', '/tmp/line\nname', "/tmp/'quote", '-dash']

    def test_require_names_missing_capability_precisely(self, monkeypatch):
        client = _Client()
        monkeypatch.setattr(exec_fs, '_client_has',
                            lambda _client, name: False)
        with pytest.raises(
                exec_fs.UnsupportedRemote,
                match='Remote host has no tar; cannot stream the source directory'):
            exec_fs._require(client, 'tar', 'stream the source directory')
        assert client.open_sftp_calls == 0
