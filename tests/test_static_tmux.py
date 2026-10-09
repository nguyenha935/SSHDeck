"""A host without tmux gets one; SSHDeck's static build is exactly what it says.

OWNER RULING 2026-10-08: when the target has no tmux, SSHDeck provides it
without asking. The host that prompted it (a Tailscale account, not root) had
no tmux, so the session fell back to a plain shell that ends with the browser.

The host here is modelled per command -- the capability probe, the search for
a tmux off PATH, the copy, the tmux commands -- and every connection goes
through the real create_ssh_connection.
"""
import hashlib
import re
from pathlib import Path

import pytest

from app import ssh_manager

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor' / 'tmux'


# ---- the vendored build ------------------------------------------------------

def _sums():
    rows = (VENDOR / 'SHA256SUMS').read_text().split('\n')
    return dict(reversed(row.split(None, 1)) for row in rows if row.strip())


def test_every_vendored_file_matches_its_recorded_sum():
    sums = _sums()
    on_disk = sorted(p.name for p in VENDOR.iterdir()
                     if p.name not in ('SHA256SUMS', 'README.md'))
    assert sorted(sums) == on_disk
    for name, digest in sums.items():
        assert hashlib.sha256((VENDOR / name).read_bytes()).hexdigest() == digest, name


ELF_MACHINE = {'x86_64': 62, 'aarch64': 183}


@pytest.mark.parametrize('arch', ssh_manager.STATIC_TMUX_ARCHES)
def test_each_architecture_has_a_static_binary_of_that_architecture(arch):
    data = (VENDOR / f'tmux-{ssh_manager.STATIC_TMUX_VERSION}-linux-{arch}').read_bytes()
    assert data[:4] == b'\x7fELF'
    assert int.from_bytes(data[18:20], 'little') == ELF_MACHINE[arch]
    # No program interpreter: nothing on the host is needed to run it.
    assert b'/lib/ld-' not in data and b'ld-linux' not in data


def test_the_version_served_is_the_version_the_script_builds():
    script = (ROOT / 'scripts' / 'build_static_tmux.sh').read_text()
    assert re.search(r'^TMUX_V=(\S+)$', script, re.M).group(1) == ssh_manager.STATIC_TMUX_VERSION


def test_the_licences_of_everything_inside_the_binary_ship_with_it():
    text = (VENDOR / 'LICENSES.txt').read_text()
    for part in ('tmux', 'libevent', 'ncurses', 'musl'):
        assert re.search(rf'^==== {part} \S+ ====$', text, re.M), part


# ---- a host, modelled per command -------------------------------------------

class Host:
    """What one remote host answers. `tmux_on_path` is the probe's `tmux -V`;
    `found` is which TMUX_CANDIDATES entry exists (None: none of them)."""

    def __init__(self, platform='Linux x86_64', tmux_on_path=False, found=None,
                 install_status=0):
        self.platform = platform
        self.tmux_on_path = tmux_on_path
        self.found = found
        self.install_status = install_status
        self.commands = []
        self.stdin = {}


class Channel:
    def __init__(self, host):
        self.host = host
        self.command = None
        self.data = b''
        self.out = b''
        self.status = 0
        self._sent = False

    def settimeout(self, _t):
        pass

    def get_pty(self, *_a):
        pass

    def exec_command(self, command):
        self.command = command
        self.host.commands.append(command)
        host = self.host
        if command == ssh_manager.TMUX_PROBE_COMMAND:
            self.out = (ssh_manager.TMUX_PROBE_SENTINEL.encode() + b'\n'
                        + ssh_manager.TMUX_PROBE_SHELL_SENTINEL.encode() + b'\n'
                        + (b'tmux 3.4\n' if host.tmux_on_path else b''))
            self.status = 0 if host.tmux_on_path else 127
        elif ssh_manager.TMUX_LOCATE_SENTINEL in command:
            self.out = (host.platform.encode() + b'\n'
                        + ssh_manager.TMUX_LOCATE_SENTINEL.encode() + b'\n')
            if host.found is not None:
                self.out += f'{host.found}\ntmux 3.8\n'.encode()
                self.status = 0
            else:
                self.status = 127
        elif 'cat >' in command:
            self.status = host.install_status
            if host.install_status == 0:
                self.out = b'tmux 3.8\n'
                host.found = 0
        elif 'show-environment' in command:
            self.out = b'LC_CTYPE=C.UTF-8\n'
        else:
            self.status = 0

    def sendall(self, data):
        self.data += data

    def shutdown_write(self):
        self.host.stdin[self.command] = self.data

    def recv_ready(self):
        return bool(self.out) and not self._sent

    def recv(self, _n):
        if self._sent:
            return b''
        self._sent = True
        return self.out

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.status

    def recv_stderr(self, _n):
        return b''

    def update_environment(self, _env):
        pass

    def invoke_shell(self):
        pass

    def close(self):
        pass


class Transport:
    def __init__(self, host):
        self.host = host

    def set_keepalive(self, _s):
        pass

    def open_session(self, timeout=None):
        return Channel(self.host)

    def is_active(self):
        return True


class Client:
    def __init__(self, host):
        self.transport = Transport(host)

    def load_host_keys(self, _p):
        pass

    def set_missing_host_key_policy(self, _p):
        pass

    def connect(self, **_kw):
        pass

    def get_transport(self):
        return self.transport

    def invoke_shell(self, **_kw):
        return Channel(self.transport.host)

    def close(self):
        pass


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    for session_id in list(ssh_manager.sessions):
        ssh_manager.close_session(session_id)


def connect(monkeypatch, host, **overrides):
    import config
    monkeypatch.setattr(config, 'TMUX_ENABLED', True)
    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', lambda: Client(host))
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _s: None)
    kwargs = {'host': 'target.example', 'port': 22, 'username': 'alice',
              'password': 'pw', 'user_id': 7, 'use_tmux': True}
    kwargs.update(overrides)
    return ssh_manager.create_ssh_connection(**kwargs)


def _registered(session_id):
    with ssh_manager.sessions_lock:
        return dict(ssh_manager.sessions[session_id])


def _uploads(host):
    return [cmd for cmd in host.commands if 'cat >' in cmd]


def test_a_host_with_tmux_on_path_is_left_exactly_as_it_was(monkeypatch):
    host = Host(tmux_on_path=True)
    session_id, error = connect(monkeypatch, host)
    assert error is None
    session = _registered(session_id)
    assert (session['tmux_bin'], session['tmux_provisioned']) == (None, None)
    assert not any(ssh_manager.TMUX_LOCATE_SENTINEL in c for c in host.commands)
    create = [c for c in host.commands if 'new-session' in c]
    assert create and create[0].startswith('tmux -u new-session')


def test_a_tmux_the_user_installed_off_path_is_found_and_used(monkeypatch):
    host = Host(found=1)
    session_id, error = connect(monkeypatch, host)
    assert error is None
    session = _registered(session_id)
    assert session['tmux_bin'] == ssh_manager.TMUX_CANDIDATES[1]
    assert session['tmux_provisioned'] is None and _uploads(host) == []
    create = [c for c in host.commands if 'new-session' in c]
    assert create[0].startswith(ssh_manager.TMUX_CANDIDATES[1] + ' -u new-session')


def test_a_linux_host_without_any_tmux_gets_sshdecks(monkeypatch):
    host = Host(platform='Linux x86_64')
    session_id, error = connect(monkeypatch, host)
    assert error is None
    [upload] = _uploads(host)
    assert upload.startswith('sh -c ')
    shipped = (ssh_manager.STATIC_TMUX_DIR
               / f'tmux-{ssh_manager.STATIC_TMUX_VERSION}-linux-x86_64').read_bytes()
    assert host.stdin[upload] == shipped
    session = _registered(session_id)
    assert session['use_tmux'] is True
    assert session['tmux_bin'] == ssh_manager.SSHDECK_TMUX
    assert ssh_manager.get_session(session_id)['tmux_provisioned'] == ssh_manager.STATIC_TMUX_VERSION
    create = [c for c in host.commands if 'new-session' in c]
    assert create[0].startswith(ssh_manager.SSHDECK_TMUX + ' -u new-session')


def test_each_copy_lands_under_its_own_name_and_is_renamed_into_place(monkeypatch):
    """Two connections provisioning one host at once must not write one file."""
    names = []
    for host in (Host(), Host()):
        connect(monkeypatch, host)
        [upload] = _uploads(host)
        script = upload.replace("'", '')
        [name] = set(re.findall(r'\.tmux-[0-9a-f]{32}', script))
        assert (f'mv -f "$HOME/.local/share/sshdeck/bin/{name}" '
                f'{ssh_manager.SSHDECK_TMUX}') in script
        names.append(name)
    assert names[0] != names[1]


@pytest.mark.parametrize('platform,code', [
    ('Darwin arm64', 'unsupported'),
    ('Linux armv7l', 'unsupported'),
    ('', 'unsupported'),
])
def test_a_host_sshdeck_has_no_build_for_stays_a_plain_shell(monkeypatch, platform, code):
    host = Host(platform=platform)
    session_id, error = connect(monkeypatch, host)
    assert error is None and _uploads(host) == []
    session = _registered(session_id)
    assert (session['use_tmux'], session['tmux_bin']) == (False, None)
    assert ssh_manager.get_session(session_id)['tmux_unavailable'] == {
        'code': code, 'platform': platform}


def test_a_copy_that_does_not_run_there_leaves_a_plain_shell(monkeypatch):
    host = Host(install_status=1)
    session_id, error = connect(monkeypatch, host)
    assert error is None and len(_uploads(host)) == 1
    session = _registered(session_id)
    assert (session['use_tmux'], session['tmux_bin']) == (False, None)
    assert ssh_manager.get_session(session_id)['tmux_unavailable'] == {
        'code': 'failed', 'platform': 'Linux x86_64'}


def test_a_reattach_never_installs_anything(monkeypatch):
    host = Host()
    session_id, error = connect(monkeypatch, host,
                                reconnect_tmux_name='sshdeck_alice_target_22_aaaa')
    assert session_id is None
    assert error == ssh_manager.TMUX_REATTACH_UNAVAILABLE_ERROR
    assert _uploads(host) == []


def test_a_reattach_finds_the_tmux_sshdeck_placed_earlier(monkeypatch):
    host = Host(found=0)
    session_id, error = connect(monkeypatch, host,
                                reconnect_tmux_name='sshdeck_alice_target_22_aaaa')
    assert error is None
    exists = [c for c in host.commands if 'has-session' in c]
    assert exists[0].startswith(ssh_manager.SSHDECK_TMUX + ' has-session')
    assert _registered(session_id)['tmux_bin'] == ssh_manager.SSHDECK_TMUX


def test_every_later_tmux_command_runs_the_same_tmux(monkeypatch):
    host = Host()
    session_id, _error = connect(monkeypatch, host)
    host.commands.clear()
    ok, error, _out = ssh_manager._exec_tmux_control(session_id, 'list-clients',
                                                     capture_output=True)
    assert ok, error
    assert host.commands[-1].startswith(ssh_manager.SSHDECK_TMUX + ' list-clients')
    attach = ssh_manager._tmux(ssh_manager.build_tmux_attach_command('s'),
                               _registered(session_id)['tmux_bin'])
    assert attach.startswith(ssh_manager.SSHDECK_TMUX + ' -u attach-session')
    ssh_manager.close_session(session_id, kill_tmux=True)
    assert any(c.startswith(ssh_manager.SSHDECK_TMUX + ' kill-session')
               for c in host.commands)


def test_nothing_the_host_prints_reaches_a_command(monkeypatch):
    """The answer selects one of OUR candidates by index; an index outside the
    list, or a platform line carrying shell, selects nothing."""
    host = Host(platform='Linux x86_64; rm -rf ~', found=len(ssh_manager.TMUX_CANDIDATES))
    session_id, _error = connect(monkeypatch, host)
    assert _uploads(host) == []
    assert _registered(session_id)['tmux_bin'] is None
    assert ssh_manager.get_session(session_id)['tmux_unavailable']['platform'] == 'Linux x86_64 rm -rf'


def test_a_swapped_transport_brings_its_own_answer(monkeypatch):
    """A reconnect may land on a host whose tmux is now on PATH; the session
    must follow the new transport, not keep the old one's tmux."""
    session_id, _error = connect(monkeypatch, Host())
    name = _registered(session_id)['tmux_session_name']
    assert _registered(session_id)['tmux_bin'] == ssh_manager.SSHDECK_TMUX
    replacement, error = ssh_manager._build_transport(
        'target.example', 22, 'alice', password='pw', use_tmux=True,
        reconnect_tmux_name=name)
    assert error is None
    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient',
                        lambda: Client(Host(tmux_on_path=True)))
    on_path, error = ssh_manager._build_transport(
        'target.example', 22, 'alice', password='pw', use_tmux=True,
        reconnect_tmux_name=name)
    assert error is None and replacement['tmux_bin'] == ssh_manager.SSHDECK_TMUX
    ok, error = ssh_manager.swap_session_transport(session_id, on_path)
    assert ok, error
    assert _registered(session_id)['tmux_bin'] is None


# ---- what the page is told ---------------------------------------------------

@pytest.fixture
def socket_world(app, monkeypatch):
    import config
    import app.socket_events as socket_events
    from app.auth import register_socket_session, register_user
    from app.models import db

    monkeypatch.setattr(config, 'TMUX_ENABLED', True)
    user, error = register_user('tmuxnotice', 'tmux-notice-password-1')
    assert error is None
    register_socket_session(user.id, 'notice-sock')
    db.session.commit()
    order, emitted = [], []

    def fake_create(**_kwargs):
        order.append('connect')
        with ssh_manager.sessions_lock:
            ssh_manager.sessions['notice-id'] = {
                'user_id': str(user.id), 'connected': True, 'use_tmux': True,
                'tmux_session_name': 'sshdeck_alice_h_22_aaaa', 'auth_type': 'password',
                'tmux_bin': ssh_manager.SSHDECK_TMUX, 'tmux_provisioned': '3.8',
                'tmux_unavailable': None, 'client': None, 'channel': None,
                'views': {}, 'host': 'h', 'port': 22, 'username': 'alice'}
        return 'notice-id', None

    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', fake_create)
    monkeypatch.setattr(socket_events, 'release_db_connection',
                        lambda: order.append('release'))
    monkeypatch.setattr(socket_events, 'emit',
                        lambda event, payload=None, **kw: emitted.append((event, payload)))
    yield socket_events, order, emitted
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.pop('notice-id', None)


def test_the_page_is_told_and_the_database_is_let_go_first(app, socket_world):
    from flask import request
    socket_events, order, emitted = socket_world
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'notice-sock'
        socket_events.handle_ssh_connect({'host': 'h', 'port': 22, 'username': 'alice',
                                          'password': 'pw', 'use_tmux': True})
    assert order[:2] == ['release', 'connect']
    [connected] = [payload for event, payload in emitted if event == 'ssh_connected']
    assert (connected['tmux_provisioned'], connected['tmux_unavailable']) == ('3.8', None)
