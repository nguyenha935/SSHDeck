import io
import stat
from types import SimpleNamespace

import pytest


class _ChunkReader:
    def __init__(self, chunks):
        self.chunks = iter(chunks)

    def read(self, _size):
        return next(self.chunks, b'')


class _TrackingLock:
    def __init__(self):
        self.acquired = 0
        self.released = 0

    def acquire(self):
        self.acquired += 1

    def release(self):
        self.released += 1


class _RemoteZipSFTP:
    def __init__(self, archive_size):
        self.archive_size = archive_size
        self.removed = []
        self.remote_file_opened = False
        self._client = _RemoteZipSSHClient()

    def stat(self, path):
        if path == '/home/reports':
            return SimpleNamespace(st_mode=stat.S_IFDIR)
        return SimpleNamespace(st_size=self.archive_size)

    def file(self, _path, _mode):
        self.remote_file_opened = True
        raise AssertionError('oversized archive must not be opened')

    def remove(self, path):
        self.removed.append(path)


class _RemoteZipSSHClient:
    def exec_command(self, _command):
        channel = SimpleNamespace(
            settimeout=lambda _timeout: None,
            recv_exit_status=lambda: 0,
        )
        return None, SimpleNamespace(channel=channel), None


def test_copy_file_with_limit_accepts_exact_boundary():
    from app.socket_events import _copy_file_with_limit

    source = _ChunkReader([b'abcd', b'efgh'])
    destination = io.BytesIO()

    copied = _copy_file_with_limit(source, destination, 8)

    assert copied == 8
    assert destination.getvalue() == b'abcdefgh'


def test_copy_file_with_limit_rejects_before_writing_over_boundary():
    from app.socket_events import DownloadSizeLimitExceeded, _copy_file_with_limit

    source = _ChunkReader([b'abcd', b'efgh'])
    destination = io.BytesIO()

    with pytest.raises(DownloadSizeLimitExceeded):
        _copy_file_with_limit(source, destination, 6)

    assert destination.getvalue() == b'abcd'


def test_remote_zip_over_limit_is_rejected_and_cleaned(app, monkeypatch):
    import app.socket_events as socket_events

    lock = _TrackingLock()
    sftp = _RemoteZipSFTP(archive_size=11)
    emitted = []

    monkeypatch.setattr(socket_events.config, 'MAX_ZIP_DOWNLOAD_SIZE', 10)
    monkeypatch.setattr(
        socket_events,
        'verify_session_ownership',
        lambda session_id, user_id: True,
    )
    monkeypatch.setattr(
        socket_events.sftp_handler,
        '_get_sftp_lock',
        lambda session_id: lock,
    )
    monkeypatch.setattr(
        socket_events.sftp_handler,
        'get_any_sftp_client',
        lambda session_id: (sftp, None, 'session'),
    )
    monkeypatch.setattr(
        socket_events.sftp_handler,
        'sanitize_path',
        lambda path: path,
    )
    monkeypatch.setattr(
        socket_events,
        'emit',
        lambda event, payload=None, **kwargs: emitted.append((event, payload)),
    )

    user = SimpleNamespace(id=7, username='download-user')
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        socket_events.handle_download_folder_binary.__wrapped__({
            'session_id': 'owned-session',
            'remote_path': '/home/reports',
        }, current_user=user)

    assert emitted == [('error', {
        'error': 'ZIP archive exceeds the maximum allowed download size'
    })]
    assert sftp.remote_file_opened is False
    assert len(sftp.removed) == 1
    assert sftp.removed[0].startswith('/tmp/reports_')
    assert lock.acquired == 1
    assert lock.released == 1
