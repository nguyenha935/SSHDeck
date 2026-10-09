"""Every HTTP request body is bounded; the signed-in upload alone has a larger cap.

Werkzeug 3.1.9 stopped bounding urlencoded forms by max_form_memory_size
(pallets/werkzeug#3251), so MAX_CONTENT_LENGTH is the only bound left.
MEASURED 2026-10-09 without it: a 64 MB POST /login, before any login, was
read whole. CSRF is ON wherever it matters: CSRFProtect reads the form -- the
whole body -- before any view, so the bound has to hold ahead of it.
"""
import io

import pytest

import config

PASSWORD = 'size-limit-password'
MB = 1024 * 1024


class Body(io.RawIOBase):
    """A request body of `size` bytes that records how much of it was read.

    Seekable because the test client measures a stream by seeking to its end;
    a seek reads nothing.
    """

    def __init__(self, size):
        self.size = self.left = size
        self.read_bytes = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.size - self.left

    def seek(self, offset, whence=io.SEEK_SET):
        target = {io.SEEK_SET: 0, io.SEEK_CUR: self.tell(), io.SEEK_END: self.size}[whence] + offset
        self.left = self.size - target
        return target

    def readinto(self, buffer):
        n = min(len(buffer), self.left)
        buffer[:n] = b'x' * n
        self.left -= n
        self.read_bytes += n
        return n


def post_body(client, path, size, content_type):
    body = Body(size)
    response = client.post(path, input_stream=body, content_length=size,
                           content_type=content_type)
    return response, body


def upload(client, size):
    return client.post('/api/upload', data={
        'file': (io.BytesIO(b'x' * size), 'f.bin'),
        'session_id': 'no-such-session', 'remote_path': '/tmp'})


@pytest.fixture
def signed_in(app, client):
    with app.app_context():
        from app.auth import register_user
        register_user('sizeuser', PASSWORD)
    response = client.post('/login', data={'username': 'sizeuser', 'password': PASSWORD})
    assert response.status_code == 302
    return client


def test_the_bound_is_one_megabyte_and_the_upload_cap_is_larger(app):
    assert app.config['MAX_CONTENT_LENGTH'] == config.MAX_REQUEST_SIZE == MB
    assert config.MAX_UPLOAD_SIZE > config.MAX_REQUEST_SIZE


def test_a_huge_form_before_login_is_refused_unread(app, client):
    app.config['WTF_CSRF_ENABLED'] = True
    response, body = post_body(client, '/login', 64 * MB,
                               'application/x-www-form-urlencoded')
    assert response.status_code == 413
    assert body.read_bytes == 0


@pytest.mark.parametrize('size, status', [
    (MB, 400),       # read, then refused for its missing CSRF token
    (MB + 1, 413),
])
def test_the_form_bound_is_exact(app, client, size, status):
    app.config['WTF_CSRF_ENABLED'] = True
    body = b'username=a&password=' + b'x' * (size - 20)
    response = client.post('/login', data=body,
                           content_type='application/x-www-form-urlencoded')
    assert response.status_code == status


def test_json_is_bounded_too(signed_in):
    response = signed_in.post('/api/account/password', data=b'{"x": "' + b'y' * 2 * MB + b'"}',
                              content_type='application/json')
    assert response.status_code == 413


def test_the_signed_in_upload_passes_the_bound_before_csrf_reads_it(app, signed_in):
    app.config['WTF_CSRF_ENABLED'] = True
    response = upload(signed_in, 5 * MB)
    # Parsed whole, then refused for the token this test does not send.
    assert response.status_code == 400 and b'CSRF' in response.data


def test_the_signed_in_upload_reaches_its_view(signed_in):
    response = upload(signed_in, 5 * MB)
    assert (response.status_code, response.get_json()) == (403, {'error': 'Unauthorized'})


def test_an_upload_over_its_cap_is_refused_unread_in_json(app, signed_in):
    app.config['WTF_CSRF_ENABLED'] = True
    response, body = post_body(signed_in, '/api/upload', config.MAX_UPLOAD_SIZE + 1,
                               'multipart/form-data; boundary=b')
    assert response.status_code == 413
    assert response.get_json() == {'error': 'File too large. Maximum: 100MB'}
    assert body.read_bytes == 0


def test_an_upload_before_login_keeps_the_small_bound(app, client):
    app.config['WTF_CSRF_ENABLED'] = True
    response = upload(client, 5 * MB)
    assert response.status_code == 413
