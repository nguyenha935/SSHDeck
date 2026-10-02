"""Transfer progress reaches the socket that asked for the transfer, and only it.

file_progress and file_complete used to be emitted with no recipient, which
Flask-SocketIO broadcasts to every connected client: every signed-in user
received each transfer's file name, remote path and session id, and the file
manager counted another user's uploads against its own batch. Found by reading
sftp_handler.py and binary_transfer.py on 2026-10-02; not observed on the wire.

Pinned at both layers: the four transfer functions emit only to `to_sid` (and
nothing without one), and the four socket handlers name the requesting socket.
"""
import base64
from contextlib import contextmanager

import pytest

from app import binary_transfer, sftp_handler


class FakeSocketIO:
    def __init__(self):
        self.emits = []

    def emit(self, event, payload=None, **kwargs):
        self.emits.append((event, payload, kwargs))


class FakeRemoteFile:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def write(self, chunk):
        pass

    def read(self, size):
        chunk = self.data[self.pos:self.pos + size]
        self.pos += len(chunk)
        return chunk


class FakeSFTP:
    def __init__(self, data):
        self.data = data

    def file(self, path, mode):
        return FakeRemoteFile(self.data if 'r' in mode else b'')

    def stat(self, path):
        return type('Stat', (), {'st_size': len(self.data)})()


@pytest.fixture
def remote(monkeypatch):
    # Four 64 KiB chunks, so every transfer emits several progress events.
    data = b'x' * 200_000

    @contextmanager
    def fake_session(session_id):
        yield FakeSFTP(data), 'session'

    monkeypatch.setattr(sftp_handler, 'sftp_session', fake_session)
    return data


def _chunks(data):
    return [data[i:i + 65536] for i in range(0, len(data), 65536)]


TRANSFERS = {
    'binary upload': lambda sio, sid, data: binary_transfer.handle_binary_upload(
        's1', 'a.bin', data, '/tmp/a.bin', socketio_instance=sio, to_sid=sid),
    'binary download': lambda sio, sid, data: binary_transfer.handle_binary_download(
        's1', '/tmp/a.bin', socketio_instance=sio, to_sid=sid),
    'chunked upload': lambda sio, sid, data: sftp_handler.upload_file_chunked(
        's1', 'a.bin', _chunks(data), '/tmp/a.bin', socketio_instance=sio, to_sid=sid),
    'chunked download': lambda sio, sid, data: sftp_handler.download_file_chunked(
        's1', '/tmp/a.bin', socketio_instance=sio, to_sid=sid),
}


@pytest.mark.parametrize('name', sorted(TRANSFERS))
def test_every_transfer_event_names_the_requesting_socket(remote, name):
    sio = FakeSocketIO()
    result = TRANSFERS[name](sio, 'sock-A', remote)

    assert result[1] is None, result
    # The floor beside the property: a run that emitted nothing would pass it.
    assert len(sio.emits) >= 4
    assert {event for event, _payload, _kw in sio.emits} <= {'file_progress', 'file_complete'}
    assert [kw for _event, _payload, kw in sio.emits] == [{'to': 'sock-A'}] * len(sio.emits)


@pytest.mark.parametrize('name', sorted(TRANSFERS))
def test_with_no_socket_to_name_nothing_is_sent(remote, name):
    sio = FakeSocketIO()
    result = TRANSFERS[name](sio, None, remote)

    assert result[1] is None, result
    assert sio.emits == []


@pytest.fixture
def owner(app, monkeypatch):
    """One user owning session 's1' on socket 'sock-1', and the four transfer
    functions replaced by recorders of the arguments the handlers pass."""
    from app.auth import register_socket_session, register_user
    from app.models import db, SSHSession
    import app.socket_events as socket_events

    with app.app_context():
        user, error = register_user('progressowner', 'progress-password-123')
        assert error is None
        db.session.add(SSHSession(session_id='s1', user_id=user.id, host='h', port=22,
                                  username='root', connected=True))
        register_socket_session(user.id, 'sock-1')
        db.session.commit()

    calls = {}

    def recorder(name, result):
        def record(*_args, **kwargs):
            calls[name] = kwargs
            return result
        return record

    monkeypatch.setattr(binary_transfer, 'handle_binary_upload',
                        recorder('binary upload', (True, None)))
    monkeypatch.setattr(binary_transfer, 'handle_binary_download',
                        recorder('binary download', (None, 'stopped here')))
    monkeypatch.setattr(sftp_handler, 'upload_file_chunked',
                        recorder('chunked upload', (True, None)))
    monkeypatch.setattr(sftp_handler, 'download_file_chunked',
                        recorder('chunked download', (None, 'stopped here')))
    monkeypatch.setattr(socket_events, 'emit', lambda *_a, **_k: None)
    return socket_events, calls


def test_the_handlers_name_the_requesting_socket(app, owner):
    from flask import request
    socket_events, calls = owner
    payloads = {
        'handle_upload_file': {'session_id': 's1', 'filename': 'a',
                               'file_data': base64.b64encode(b'abc').decode(),
                               'remote_path': '/tmp/a'},
        'handle_download_file': {'session_id': 's1', 'remote_path': '/tmp/a'},
        'handle_upload_file_binary': {'session_id': 's1', 'filename': 'a',
                                      'file_data': b'abc', 'remote_path': '/tmp/a'},
        'handle_download_file_binary': {'session_id': 's1', 'remote_path': '/tmp/a'},
    }
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'sock-1'
        for handler, payload in payloads.items():
            getattr(socket_events, handler)(payload)

    assert {name: kwargs.get('to_sid') for name, kwargs in calls.items()} == {
        'binary upload': 'sock-1',
        'binary download': 'sock-1',
        'chunked upload': 'sock-1',
        'chunked download': 'sock-1',
    }
