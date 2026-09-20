import shlex

import paramiko
import pytest

from app import ssh_manager


class FakeForwardChannel:
    pass


class FakeTransport:
    def __init__(self, owner=None):
        self.owner = owner
        self.keepalive = None
        self.opened_channel = None
        self.forward_channel = FakeForwardChannel()
        self.session_channels = []
        self.open_timeouts = []
        # When set, open_session raises this once the given number of channels
        # have already been opened. Used to prove open_shell_channel's fallback
        # to client.invoke_shell() when a server will not give us a session.
        self.open_session_error = None
        self.open_session_error_after = 0

    def set_keepalive(self, seconds):
        self.keepalive = seconds

    def open_channel(self, kind, destination, source):
        self.opened_channel = (kind, destination, source)
        return self.forward_channel

    def open_session(self, timeout=None):
        self.open_timeouts.append(timeout)
        if (self.open_session_error is not None
                and len(self.session_channels)
                >= self.open_session_error_after):
            raise self.open_session_error
        channel = FakeChannel()
        # The client owns what the HOST reports, so one test can describe one
        # host and every channel it opens agrees.
        if self.owner is not None:
            if self.owner.probe_locale_listing is not None:
                channel.locale_listing = self.owner.probe_locale_listing
            if self.owner.probe_tmux_banner is not None:
                channel.tmux_version_banner = self.owner.probe_tmux_banner
            if self.owner.probe_session_locale is not None:
                channel.session_locale_output = self.owner.probe_session_locale
            if self.owner.probe_login_shell_getent is not None:
                channel.login_shell_getent = self.owner.probe_login_shell_getent
            if self.owner.probe_exit_status is not None:
                channel.probe_exit_status = self.owner.probe_exit_status
            if self.owner.has_session_exit_status is not None:
                channel.has_session_exit_status = (
                    self.owner.has_session_exit_status)
            channel.on_has_session = self.owner.on_has_session
            channel.env_error = self.owner.env_error
        self.session_channels.append(channel)
        return channel

    def is_active(self):
        return True


class FakeChannel:
    # The probe is ONE round trip that carries a `locale -a` listing, a
    # sentinel, and the `tmux -V` banner. The fake answers as a real host would.
    # Tests that care about a specific tmux version or a specific set of
    # installed locales set these per instance (or per class, via
    # install_ssh_clients' probe_* arguments).
    tmux_version_banner = b'tmux 3.4\n'
    # Default: a host with NO listing at all, i.e. the pre-resolution shape.
    # `resolve_tmux_utf8_locale` then returns the historical fallback, so every
    # test written before host-adaptive locales keeps asserting C.UTF-8 and
    # keeps meaning what it meant.
    locale_listing = b''
    # What `tmux show-environment -t '=name' LC_CTYPE` answers on a REATTACH.
    # Default: a session that already carries UTF-8, i.e. NOT a legacy pane.
    session_locale_output = b'LC_CTYPE=C.UTF-8\n'
    # What `getent passwd "$(id -u)"` answers in the probe round trip. The
    # default describes an account whose login shell is the proven /bin/bash,
    # i.e. a host where discovery SUCCEEDS — the shape production consumes
    # now. An empty string answers an empty segment: a host without getent,
    # where discovery degrades to "no answer" and the shipped invoke_shell
    # launch stays exactly as it was.
    login_shell_getent = 'alice:x:1000:1000:Alice:/home/alice:/bin/bash'
    # The probe channel's exit status. 0 = tmux available; a host without
    # tmux exits non-zero (command not found = 127), which is what makes
    # probe_target_capabilities report "tmux unavailable".
    probe_exit_status = 0
    # W13-B5: what `tmux has-session -t '=name'` answers. 0 = the retained
    # session exists (the default: a reattach whose session is still there);
    # non-zero = it is GONE, which is the race the attach-only reconnect must
    # fail closed on rather than recreate.
    has_session_exit_status = 0

    def __init__(self):
        self.closed = False
        self.timeout = None
        self.command = None
        self.pty = None
        self._recv_calls = 0
        # A non-tmux session now asks for its locale on the channel, before the
        # shell starts. These record that request the way a server sees it.
        self.environment = {}
        self.shell_invoked = False
        # The ORDER matters, not just the end state: a server applies `env` to
        # the process it is about to start, so a request made after invoke_shell
        # does nothing at all. This records the sequence so a test can assert it.
        self.calls = []
        # When set, update_environment raises it — a server that ERRORS on an
        # `env` request rather than ignoring it.
        self.env_error = None
        # W13-B5: called with the has-session command as it is issued. A test
        # uses it to change the host's state at that exact instant.
        self.on_has_session = None

    def settimeout(self, timeout):
        self.timeout = timeout

    def exec_command(self, command):
        self.command = command
        self.calls.append('exec_command')
        if self.on_has_session is not None and 'has-session' in command:
            self.on_has_session(command)

    def update_environment(self, environment):
        self.calls.append('update_environment')
        if self.env_error is not None:
            raise self.env_error
        self.environment.update(environment)

    def invoke_shell(self):
        self.calls.append('invoke_shell')
        self.shell_invoked = True

    def _probe_payload(self):
        listing = self.locale_listing or b''
        entry_bytes = (self.login_shell_getent.encode() + b'\n'
                       if self.login_shell_getent else b'')
        if not listing:
            # No listing: the sentinel is still emitted by the real command, so
            # the fake emits it too. The half before it is simply empty.
            return (b'' + ssh_manager.TMUX_PROBE_SENTINEL.encode() + b'\n'
                    + entry_bytes
                    + ssh_manager.TMUX_PROBE_SHELL_SENTINEL.encode() + b'\n'
                    + self.tmux_version_banner)
        return (listing + b'\n' + ssh_manager.TMUX_PROBE_SENTINEL.encode()
                + b'\n' + entry_bytes
                + ssh_manager.TMUX_PROBE_SHELL_SENTINEL.encode() + b'\n'
                + self.tmux_version_banner)

    def recv(self, _size):
        # One payload, then EOF. A fake that returned it forever would let a
        # runaway read loop pass unnoticed.
        self._recv_calls += 1
        if self._recv_calls > 1:
            return b''
        if self.command and 'show-environment' in self.command:
            return self.session_locale_output or b''
        return self._probe_payload()

    def exit_status_ready(self):
        # A short tmux command is run through an exec channel whose exit status
        # is POLLED against a deadline (never recv_exit_status() alone, which
        # ignores the channel timeout and would hang a SocketIO worker on a
        # half-open TCP). The fake answers immediately.
        return True

    def recv_stderr(self, _size):
        # Read only when a command exited non-zero, to report tmux's own
        # reason. Nothing here fails with a message.
        return b''

    def recv_exit_status(self):
        # The probe's availability signal is tmux's own exit status. The
        # default is 0 (tmux available); a host WITHOUT tmux answers nothing
        # for `tmux -V` and exits non-zero, which a test models with a
        # configurable non-zero status (install_ssh_clients' probe_exit_status
        # argument). An empty banner alone does not express that.
        #
        # `has-session` is a DIFFERENT question with its own status: whether
        # the retained tmux session exists right now. A host can have tmux
        # (probe 0) and no longer have that session (has-session non-zero),
        # which is exactly the W13-B5 race, so the two statuses are separate.
        if self.command and 'has-session' in self.command:
            return self.has_session_exit_status
        return self.probe_exit_status

    def get_pty(self, term, width, height):
        self.pty = (term, width, height)
        self.calls.append('get_pty')

    def close(self):
        self.closed = True


class FakeSSHClient:
    def __init__(self, connect_error=None):
        self.connect_error = connect_error
        self.connect_kwargs = None
        # What the probe round trip will report for this host. None means "use
        # the FakeChannel default", which is: no locales listed, tmux 3.4.
        self.probe_locale_listing = None
        self.probe_tmux_banner = None
        # What an EXISTING tmux session answers about its own LC_CTYPE.
        self.probe_session_locale = None
        # What `getent passwd "$(id -u)"` answers during the probe round trip.
        # None means "use the FakeChannel default" (a /bin/bash account); an
        # empty string describes a host with no getent answer at all.
        self.probe_login_shell_getent = None
        # The probe channel's exit status: 0 = tmux available. A host without
        # tmux exits non-zero — model that with 127 (command not found).
        self.probe_exit_status = None
        # W13-B5: what `tmux has-session -t '=name'` answers on this host.
        # None means "use the FakeChannel default" (the session exists); a
        # non-zero value describes a session that is GONE.
        self.has_session_exit_status = None
        # W13-B5: a callable invoked with the has-session command the moment it
        # is issued, so a test can make the session disappear BETWEEN
        # validation and execution rather than before either.
        self.on_has_session = None
        # Set to make every channel refuse an `env` request.
        self.env_error = None
        self.transport = FakeTransport(owner=self)
        self.channel = FakeChannel()
        self.policy = None
        self.loaded_host_keys = None
        self.shell_kwargs = None
        self.closed = False

    def load_host_keys(self, path):
        self.loaded_host_keys = path

    def set_missing_host_key_policy(self, policy):
        self.policy = policy

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs
        if self.connect_error:
            raise self.connect_error

    def get_transport(self):
        return self.transport

    def invoke_shell(self, **kwargs):
        self.shell_kwargs = kwargs
        return self.channel

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    for session_id in list(ssh_manager.sessions):
        ssh_manager.close_session(session_id)


def install_ssh_clients(monkeypatch, *connect_errors, locale_listing=None,
                        tmux_banner=None, session_locale=None, env_error=None,
                        login_shell_getent=None, probe_exit_status=None,
                        has_session_exit_status=None, on_has_session=None):
    """Install the fake SSHClient factory.

    `locale_listing` / `tmux_banner` set what the probe round trip reports, so a
    test can describe the HOST it is talking to rather than patching internals.
    Left unset, the probe reports no locales and tmux 3.4 — the shape every
    pre-existing test in this file was written against.

    `session_locale` sets what an EXISTING tmux session answers about its own
    LC_CTYPE on a reattach; `env_error` makes every channel refuse an `env`
    request, which is the shape of a restrictive AcceptEnv.

    `login_shell_getent` sets what the probe's `getent passwd "$(id -u)"`
    segment answers. An empty string describes a host with no getent; left
    unset, the fake answers a proven /bin/bash account, so a fresh non-tmux
    connect takes the exec'd-login-shell launch by default.

    `probe_exit_status` sets the probe channel's exit status: tmux
    unavailability is a NON-ZERO status (127 = command not found), exactly
    the signal probe_target_capabilities reads. An empty banner with status 0
    is NOT an unavailable probe.

    `has_session_exit_status` sets what `tmux has-session -t '=name'` answers:
    0 = the retained session exists, non-zero = it is gone. `on_has_session` is
    called with that command as it is issued, which is how a test makes the
    session vanish BETWEEN validation and execution.
    """
    clients = []

    def client_factory():
        index = len(clients)
        error = connect_errors[index] if index < len(connect_errors) else None
        client = FakeSSHClient(connect_error=error)
        if locale_listing is not None:
            client.probe_locale_listing = locale_listing
        if tmux_banner is not None:
            client.probe_tmux_banner = tmux_banner
        if session_locale is not None:
            client.probe_session_locale = session_locale
        if env_error is not None:
            client.env_error = env_error
        if login_shell_getent is not None:
            client.probe_login_shell_getent = login_shell_getent
        if probe_exit_status is not None:
            client.probe_exit_status = probe_exit_status
        if has_session_exit_status is not None:
            client.has_session_exit_status = has_session_exit_status
        if on_has_session is not None:
            client.on_has_session = on_has_session
        clients.append(client)
        return client

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', client_factory)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _seconds: None)
    return clients


def connect_target(**overrides):
    kwargs = {
        'host': 'target.example',
        'port': 22,
        'username': 'alice',
        'user_id': 7,
    }
    kwargs.update(overrides)
    return ssh_manager.create_ssh_connection(**kwargs)


def test_ssh_manager_exposes_the_shared_loader():
    from app.ssh_key_loader import load_private_key

    assert ssh_manager._load_private_key is load_private_key


def test_direct_password_connect_preserves_connect_contract(monkeypatch):
    clients = install_ssh_clients(monkeypatch)

    session_id, error = connect_target(password='secret')

    assert error is None
    assert session_id in ssh_manager.sessions
    assert clients[0].connect_kwargs == {
        'hostname': 'target.example',
        'port': 22,
        'username': 'alice',
        'timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        # banner_timeout / auth_timeout are part of the contract because
        # `timeout` alone covers ONLY the TCP connect. Measured on the deployed
        # build: a peer that accepts the socket then stalls in negotiation left
        # the client with no response for 30.5 seconds before ssh_error arrived,
        # modal open and spinner running the whole time -- the Owner's "I press
        # Connect and nothing happens". Both clocks share the connect budget.
        'banner_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'auth_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'look_for_keys': False,
        'allow_agent': False,
        'password': 'secret',
    }
    assert clients[0].transport.keepalive == 30
    # The non-tmux shell is opened on the transport so its locale can be
    # requested BEFORE the shell starts (open_shell_channel). Since W13-A1
    # discovery, the same probe round trip also answers the account's login
    # shell, so the default launch is the exec'd login shell with the locale
    # riding INSIDE the command line — an env-ignoring server (tailscaled)
    # cannot strip it. client.invoke_shell() remains only as the fallback, so
    # it must NOT have been used on a healthy transport with a proven shell.
    assert clients[0].shell_kwargs is None
    probe_channel, shell_channel = clients[0].transport.session_channels
    assert probe_channel.command == ssh_manager.TMUX_PROBE_COMMAND
    assert shell_channel.calls == ['get_pty', 'exec_command']
    assert shell_channel.pty == ('xterm-256color', 80, 24)
    assert shell_channel.shell_invoked is False
    assert shell_channel.command == ssh_manager.build_login_shell_command(
        'C.UTF-8', '/bin/bash')
    assert shell_channel.timeout == 0.1


@pytest.mark.parametrize(
    ('fixture_name', 'expected_class'),
    [
        ('rsa_private_key_pem', paramiko.RSAKey),
        ('ed25519_private_key_pem', paramiko.Ed25519Key),
        ('ecdsa_private_key_pem', paramiko.ECDSAKey),
    ],
)
def test_direct_supported_key_passes_pkey_not_password(
        monkeypatch, request, fixture_name, expected_class):
    clients = install_ssh_clients(monkeypatch)
    key_content = request.getfixturevalue(fixture_name)

    session_id, error = connect_target(
        password='must-not-be-used',
        key_content=key_content,
    )

    assert error is None
    assert session_id in ssh_manager.sessions
    assert isinstance(clients[0].connect_kwargs['pkey'], expected_class)
    assert 'password' not in clients[0].connect_kwargs
    assert 'key_filename' not in clients[0].connect_kwargs


EXPECTED_UTF8_ENV = '-e LANG=C.UTF-8 -e LC_CTYPE=C.UTF-8'

# The session-level launch is CREATE only.: a reattach runs no
# launch command on the transport at all -- it proves the session with a
# read-only has-session and each browser socket attaches its own client -- so
# `attach-session` is no longer one of the verbs a transport-level launch can
# wear, and a test that finds one has found a defect.
TMUX_LAUNCH_VERBS = ('new-session', 'attach-session')


def tmux_channel_of(client):
    """The channel tmux actually ran on, found by its COMMAND.

    Positional indexing does not survive W13: a session now opens a variable
    number of read-only probe channels around the tmux one (the capability
    probe before it; the `show-environment` locale measurement before it on a
    reattach and AFTER it on a fresh session, since the session has to exist
    before it can be asked). Selecting by command keeps every assertion about
    the tmux command line independent of how many questions surround it.

    Both verbs are still matched, because a reattach is asserted to produce
    NEITHER: launch_channels_of() below is how that is stated, and it would be
    blind to a regression that reintroduced a session-level attach.
    """
    matches = launch_channels_of(client)
    assert len(matches) == 1, [c.command for c in client.transport.session_channels]
    return matches[0]


def launch_channels_of(client):
    """Every channel that ran a tmux LAUNCH verb, in order.

    A fresh session has exactly one (`new-session -d`). A reattach must have
    none: it creates nothing, and it must not attach a session-level client
    either -- nothing would ever resize such a client, so `window-size
    smallest` would pin every real device to its 80x24 default.
    """
    return [c for c in client.transport.session_channels
            if c.command and any(verb in c.command
                                 for verb in TMUX_LAUNCH_VERBS)]


def test_tailscale_tmux_uses_the_shared_utf8_session_env(monkeypatch):
    clients = install_ssh_clients(monkeypatch)

    session_id, error = connect_target(
        auth_type='tailscale',
        use_tmux=True,
        reconnect_tmux_name='existing_session',
    )

    assert error is None
    assert session_id in ssh_manager.sessions
    strategy = clients[0].connect_kwargs['auth_strategy']
    assert isinstance(strategy, ssh_manager.TailscaleSSHAuthStrategy)
    assert clients[0].connect_kwargs == {
        'hostname': 'target.example',
        'port': 22,
        'username': 'alice',
        'timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        # banner_timeout / auth_timeout are part of the contract because
        # `timeout` alone covers ONLY the TCP connect. Measured on the deployed
        # build: a peer that accepts the socket then stalls in negotiation left
        # the client with no response for 30.5 seconds before ssh_error arrived,
        # modal open and spinner running the whole time -- the Owner's "I press
        # Connect and nothing happens". Both clocks share the connect budget.
        'banner_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'auth_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'auth_strategy': strategy,
    }
    assert ssh_manager.sessions[session_id]['auth_type'] == 'tailscale'
    # THREE channels on a REATTACH, in this order: the capability probe; the
    # read-only `has-session` existence check that makes the reattach fail
    # closed if the retained session died since it was validated; and the
    # read-only `show-environment` question that measures whether the existing
    # pane predates the locale fix. All three only ASK: the transport runs no
    # launch at all, because the attach belongs to each browser socket's view.
    (probe_channel, exists_channel, locale_channel) = (
        clients[0].transport.session_channels)
    # ONE round trip, three answers: the `locale -a` half says which UTF-8
    # locale name this host resolves, the sentinel separates the halves, and
    # `tmux -V` comes LAST so the channel's exit status is still tmux's own
    # availability signal.
    assert probe_channel.command == ssh_manager.TMUX_PROBE_COMMAND
    assert probe_channel.command.endswith('tmux -V')
    # Read-only, exact-match: has-session inspects and returns a status. It
    # cannot create, and `=name` cannot match anything but this session.
    assert exists_channel.command == (
        'tmux has-session -t =existing_session 2>/dev/null')
    # Read-only: show-environment prints one variable. It does not attach,
    # resize, send input, respawn a pane or kill anything. `=name` is tmux's
    # EXACT-match form, so the name can never act as a pattern; it goes through
    # shlex.quote, which adds no quotes for a name made only of the characters
    # the server whitelist allows and would add them for anything else.
    assert locale_channel.command == (
        'tmux show-environment -t =existing_session LC_CTYPE 2>&1')
    # No create verb anywhere (W13-B5: a session that vanished cannot be
    # silently recreated under its identity) and no attach either: the command
    # each view will run is built separately, and it is attach-only.
    assert launch_channels_of(clients[0]) == []
    assert ssh_manager.build_tmux_attach_command('existing_session') == (
        'tmux -u attach-session -t =existing_session')


def test_password_tmux_gets_the_same_command_as_tailscale(monkeypatch):
    """Auth type must not decide how a pane handles multi-byte input.

    Measured on the live target
    (tests/browser/defect1_pane_locale_ime_probe.py): with no locale in the
    pane, glibc resolves charmap ANSI_X3.4-1968 and readline runs
    `convert-meta on`, which rewrites every byte >= 0x80 as ESC + (byte & 0x7F).
    Composed Vietnamese typed one character at a time -- the shape an IME commit
    has -- came back as "ting Vit xin cho", while the SAME bytes in one bulk
    write, and the same per-character delivery into `cat`, were byte-exact. So
    the loss is readline+locale, and every auth type is equally exposed to it.

    The old code gave the locale only to Tailscale sessions, which is precisely
    the reported defect: identical input, different result per transport.
    """
    clients = install_ssh_clients(monkeypatch)

    session_id, error = connect_target(
        password='secret',
        use_tmux=True,
        reconnect_tmux_name='existing_session',
    )

    assert error is None
    assert session_id in ssh_manager.sessions
    # Stated on the FRESH launch, the only one a locale can reach: a reattach
    # inherits the pane's own environment and runs no launch at all.
    ssh_manager.close_session(session_id)
    clients = install_ssh_clients(monkeypatch)
    session_id, error = connect_target(password='secret', use_tmux=True)
    assert error is None
    assert EXPECTED_UTF8_ENV in tmux_channel_of(clients[0]).command
    ssh_manager.close_session(session_id)


def test_every_auth_type_produces_an_identical_tmux_command(monkeypatch):
    """The anti-regression for the defect itself, stated as an equality.

    A future branch on auth_type would have to make these two strings differ,
    and this test names that as the failure. Both launch shapes are checked --
    a brand-new session and a reattach -- because W13-B5 made them different
    commands, and the property being defended is that AUTH TYPE never changes
    either one.
    """
    auth_shapes = (
        ('password', {'password': 'secret'}),
        ('key', {'key_content': None, 'password': 'secret'}),
        ('tailscale', {'auth_type': 'tailscale'}),
    )
    commands = {}
    for auth_type, kwargs in auth_shapes:
        clients = install_ssh_clients(monkeypatch)
        session_id, error = connect_target(use_tmux=True, **kwargs)
        assert error is None, auth_type
        commands[auth_type] = tmux_channel_of(clients[0]).command
        ssh_manager.close_session(session_id)

        # The reattach shape, for the same auth type: NOTHING is launched.
        clients = install_ssh_clients(monkeypatch)
        session_id, error = connect_target(
            use_tmux=True, reconnect_tmux_name='existing_session', **kwargs)
        assert error is None, auth_type
        assert launch_channels_of(clients[0]) == [], auth_type
        ssh_manager.close_session(session_id)

    # A fresh session's name carries a random suffix, so the comparable
    # part is the command with the generated name removed.
    comparable = {auth_type: command.rsplit(' -s ', 1)[0]
                  for auth_type, command in commands.items()}
    assert len(set(comparable.values())) == 1, (
        f'auth type still changes the tmux command, so multi-byte input '
        f'behaves differently per transport: {commands}'
    )
    for auth_type, command in commands.items():
        # -u is the CLIENT-side UTF-8 assertion; without it tmux draws an
        # underscore for every multi-byte character whatever the locale is.
        assert 'tmux -u ' in command, auth_type
        assert EXPECTED_UTF8_ENV in command, (auth_type, command)


def test_utf8_env_sets_ctype_without_overriding_other_categories():
    """LC_CTYPE, not LC_ALL, and the reason is in the contract.

    LC_CTYPE is the only category that decides multi-byte character handling.
    LC_ALL would also override the target's own messages, collation and time
    formats, which is a user-visible change nobody asked for.
    """
    assert dict(ssh_manager.TMUX_UTF8_ENV) == {
        'LANG': 'C.UTF-8', 'LC_CTYPE': 'C.UTF-8'}
    assert 'LC_ALL' not in dict(ssh_manager.TMUX_UTF8_ENV)
    # The names are the contract; the VALUE is resolved per host below.
    assert ssh_manager.TMUX_UTF8_ENV_NAMES == ('LANG', 'LC_CTYPE')


# ── host-adaptive UTF-8 locale resolution ───────────────────────────────────
#
# Measured, tmux 3.4 / glibc 2.39, per-character delivery (the shape
# an IME commit has), reading the pane back with capture-pane:
#
#   -e LANG/LC_CTYPE=C.UTF-8      -> "tiếng Việt xin chào"  EXACT
#   -e LANG/LC_CTYPE=C.utf8       -> EXACT
#   -e LANG/LC_CTYPE=en_US.UTF-8  -> EXACT
#   -e LANG/LC_CTYPE=vi_VN.UTF-8  -> EXACT
#   -e LANG/LC_CTYPE=POSIX        -> "ting Vit xin cho"    MANGLED
#   -e LANG/LC_CTYPE=xx_XX.UTF-8  -> MANGLED  (absent locale, silently ignored)
#
# So ANY UTF-8 locale the host actually has works, and a name it lacks is no
# better than no locale at all. That is why the value must come from the host's
# own listing rather than from a constant: this very box lists `C.utf8` and NOT
# `C.UTF-8`.

def test_probe_asks_for_the_locale_listing_and_still_ends_with_tmux_v():
    """The exit status must remain tmux's own availability signal.

    `tmux -V` is LAST in the command, so a host without tmux still produces a
    non-zero status and takes the raw-shell fallback. If the order were flipped,
    `locale -a` would decide the status and a tmux-less host would look fine.
    """
    assert ssh_manager.TMUX_PROBE_COMMAND.startswith('locale -a')
    assert ssh_manager.TMUX_PROBE_COMMAND.endswith('tmux -V')
    assert ssh_manager.TMUX_PROBE_SENTINEL in ssh_manager.TMUX_PROBE_COMMAND
    assert ssh_manager.TMUX_PROBE_SHELL_SENTINEL \
        in ssh_manager.TMUX_PROBE_COMMAND
    # `locale -a` on a host without it, and `getent` on a host without it,
    # must not write to the channel.
    assert '2>/dev/null' in ssh_manager.TMUX_PROBE_COMMAND
    # W13-A1 discovery rides the SAME one round trip: uid from `id -u`
    # (kernel-trusted), never $USER, and the shell sentinel sits between the
    # getent segment and `tmux -V` so the exit status stays tmux's.
    assert 'getent passwd "$(id -u)"' in ssh_manager.TMUX_PROBE_COMMAND
    assert '$USER' not in ssh_manager.TMUX_PROBE_COMMAND
    assert ssh_manager.TMUX_PROBE_COMMAND.index(
        ssh_manager.TMUX_PROBE_SENTINEL) < ssh_manager.TMUX_PROBE_COMMAND.index(
        ssh_manager.TMUX_PROBE_SHELL_SENTINEL) < \
        ssh_manager.TMUX_PROBE_COMMAND.rindex('tmux -V')


@pytest.mark.parametrize(
    ('listing', 'expected'),
    [
        # Every candidate, in the host's OWN spelling.
        ('C.UTF-8\nen_US.UTF-8\nPOSIX\n', 'C.UTF-8'),
        ('C.utf8\nen_US.utf8\nvi_VN.utf8\n', 'C.utf8'),
        ('en_US.UTF-8\nfr_FR.UTF-8\n', 'en_US.UTF-8'),
        # Preference order: C.UTF-8 wins over C.utf8 wins over en_US.UTF-8.
        ('en_US.UTF-8\nC.utf8\nC.UTF-8\n', 'C.UTF-8'),
        ('en_US.UTF-8\nC.utf8\n', 'C.utf8'),
        # Unreadable / empty / no candidate: the historical value, unchanged.
        ('', 'C.UTF-8'),
        (None, 'C.UTF-8'),
        ('POSIX\nC\n', 'C.UTF-8'),
        ('vi_VN.UTF-8\nde_DE.UTF-8\n', 'C.UTF-8'),
    ],
)
def test_locale_resolution_picks_the_hosts_own_spelling(listing, expected):
    assert ssh_manager.resolve_tmux_utf8_locale(listing) == expected


def test_locale_matching_is_exact_because_setlocale_is():
    """`C.utf8` and `C.UTF-8` are different names to the target.

    A case-insensitive or normalising match would send a spelling the host does
    not have, which measured MANGLED — indistinguishable from sending nothing.
    """
    assert ssh_manager.resolve_tmux_utf8_locale('c.utf-8\n') == 'C.UTF-8'
    assert ssh_manager.resolve_tmux_utf8_locale('C.UTF8\n') == 'C.UTF-8'
    assert ssh_manager.resolve_tmux_utf8_locale('  C.utf8  \n') == 'C.utf8'


@pytest.mark.parametrize(
    ('raw', 'expected_listing', 'expected_entry', 'expected_banner'),
    [
        # Normal three-segment shape.
        (b'C.utf8\nen_US.utf8\n__SSHDECK_PROBE_BOUNDARY__\n'
         b'alice:x:1000:1000:Alice:/home/alice:/bin/bash\n'
         b'__SSHDECK_PROBE_BOUNDARY_SHELL__\ntmux 3.4\n',
         ['C.utf8', 'en_US.utf8'],
         'alice:x:1000:1000:Alice:/home/alice:/bin/bash',
         'tmux 3.4'),
        # Host without `locale -a`: empty first segment, the rest intact.
        (b'__SSHDECK_PROBE_BOUNDARY__\n'
         b'alice:x:1000:1000:Alice:/home/alice:/bin/bash\n'
         b'__SSHDECK_PROBE_BOUNDARY_SHELL__\ntmux 3.4\n',
         [], 'alice:x:1000:1000:Alice:/home/alice:/bin/bash', 'tmux 3.4'),
        # Host without getent: empty middle segment, banner intact.
        (b'C.utf8\n__SSHDECK_PROBE_BOUNDARY__\n'
         b'__SSHDECK_PROBE_BOUNDARY_SHELL__\ntmux 3.4\n',
         ['C.utf8'], '', 'tmux 3.4'),
        # OLD two-segment answer (a pre-discovery host): the locale listing
        # and banner survive unchanged and the entry is simply empty — a
        # degradation to "no discovery", never a misparse.
        (b'C.utf8\nen_US.utf8\n__SSHDECK_PROBE_BOUNDARY__\ntmux 3.4\n',
         ['C.utf8', 'en_US.utf8'], '', 'tmux 3.4'),
    ],
)
def test_probe_output_splits_into_three_segments(raw, expected_listing,
                                                 expected_entry,
                                                 expected_banner):
    listing, entry, banner = ssh_manager.split_tmux_probe_output(raw)
    assert [l for l in listing.split() if l] == expected_listing
    assert entry.strip() == expected_entry
    assert banner.strip() == expected_banner


def test_a_sentinel_less_probe_is_read_as_a_bare_banner():
    """A shell that could not run the sequence must degrade, not misfire.

    With no sentinel there is no way to tell the parts apart, so the whole blob
    is the banner (the version is still read correctly) and the locale AND the
    discovered shell fall back — the locale to the historical constant, the
    shell to None (the shipped invoke_shell launch). Treating the blob as a
    LISTING or an ENTRY instead could match a candidate or a shell path inside
    unrelated text.
    """
    listing, entry, banner = ssh_manager.split_tmux_probe_output(b'tmux 3.4\n')
    assert listing == ''
    assert entry == ''
    assert banner.strip() == 'tmux 3.4'
    assert ssh_manager._parse_tmux_version(banner) == (3, 4)
    assert ssh_manager.resolve_tmux_utf8_locale(listing) == 'C.UTF-8'
    assert ssh_manager.parse_login_shell_from_getent(entry) is None


def test_resolved_locale_reaches_the_tmux_command(monkeypatch):
    """End to end through the production connect path.

    The host here lists `C.utf8` and NOT `C.UTF-8` — the shape that made a
    hardcoded value useless. The emitted command must carry the host's spelling.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'POSIX\nC\nC.utf8\nen_US.utf8')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    tmux_channel = tmux_channel_of(clients[0])
    assert '-e LANG=C.utf8 -e LC_CTYPE=C.utf8' in tmux_channel.command
    assert 'C.UTF-8' not in tmux_channel.command
    ssh_manager.close_session(session_id)


def test_a_host_with_no_locale_listing_keeps_the_historical_command(monkeypatch):
    """The no-regression case: an unreadable probe behaves exactly as before."""
    clients = install_ssh_clients(monkeypatch, locale_listing=b'')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    tmux_channel = tmux_channel_of(clients[0])
    assert tmux_channel.command == (
        f'tmux -u new-session -d {EXPECTED_UTF8_ENV} '
        f'-s {ssh_manager.sessions[session_id]["tmux_session_name"]}'
    )
    ssh_manager.close_session(session_id)


def test_locale_resolution_is_identical_for_normal_ssh_and_tailscale(monkeypatch):
    """The anti-regression for the ORIGINAL defect, restated for locales.

    Host-adaptive resolution must not reintroduce an auth-type difference: the
    same host must produce the same command for password, key and tailscale.

    Stated on a BRAND-NEW session, because that is the only launch a locale can
    reach: a reattach inherits the pane's own environment and carries no `-e`
    at all (W13-B5 made it attach-only). The reattach's auth-independence is
    pinned by test_every_auth_type_produces_an_identical_tmux_command.
    """
    listing = b'C.utf8\nen_US.utf8\n'
    commands = {}
    for auth_type, kwargs in (
        ('password', {'password': 'secret'}),
        ('key', {'password': 'secret'}),
        ('tailscale', {'auth_type': 'tailscale'}),
    ):
        clients = install_ssh_clients(monkeypatch, locale_listing=listing)
        session_id, error = connect_target(use_tmux=True, **kwargs)
        assert error is None, auth_type
        tmux_channel = tmux_channel_of(clients[0])
        # The generated name differs per session; the locale part must not.
        commands[auth_type] = tmux_channel.command.rsplit(' -s ', 1)[0]
        ssh_manager.close_session(session_id)

    assert len(set(commands.values())) == 1, (
        f'auth type still changes the tmux command: {commands}')
    for auth_type, command in commands.items():
        assert '-e LANG=C.utf8 -e LC_CTYPE=C.utf8' in command, auth_type
        assert 'tmux -u ' in command, auth_type


def test_pre_3_2_host_gets_its_own_locale_in_the_legacy_prefix(monkeypatch):
    """The legacy path must be host-adaptive too, or it is worse than useless."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', tmux_banner=b'tmux 2.9a\n')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    tmux_channel = tmux_channel_of(clients[0])
    assert tmux_channel.command.startswith(
        'env LANG=C.utf8 LC_CTYPE=C.utf8 tmux -u ')
    assert ' -e ' not in tmux_channel.command
    ssh_manager.close_session(session_id)


def test_attach_cannot_retrofit_an_existing_pane_and_the_code_says_so():
    """A reattach cannot repair a pane that already exists.

    MEASURED, tmux 3.4, on a session created with no locale:

        step 1  create without locale, type per-character  -> MANGLED
        step 2  tmux -u new-session -A -e LANG=C.UTF-8 -e LC_CTYPE=C.UTF-8
                -s <same name>
                  rc=1 "open terminal failed: not a terminal"
                  show-environment -> "unknown variable: LC_CTYPE"
                  the RUNNING shell's own LC_CTYPE -> empty
                  type per-character again              -> STILL MANGLED
        step 3  a NEW session on the SAME server, with -e -> EXACT
        step 4  legacy `env ... tmux` against a running server -> MANGLED

    So a pre-fix pane is unfixable in place: its shell was exec'd before any
    locale existed and nothing in a later attach re-enters that process. The
    product's choice is deliberate — PRESERVE the pane (the user's history and
    running processes) rather than kill it to gain UTF-8 — and the only route to
    a fixed pane is a NEW session.

    This test exists so nobody reads "the fix survives reconnect" as "reconnect
    applies the fix". Since W13-B5 the reattach command is attach-only, which
    makes the point structurally: there is no `-e` on it to mistake for a
    repair, and no create verb either. The docstring states the non-repair so
    the next reader does not have to re-measure it.
    """
    reattach = ssh_manager.build_tmux_attach_command('sess_abc')
    fresh = ssh_manager.build_tmux_command('sess_abc', (3, 4),
                                           utf8_locale='C.utf8')
    # Preservation: the exact session name is what brings the pane back, and
    # attach-session is the whole verb -- nothing here can create or modify.
    assert reattach == 'tmux -u attach-session -t =sess_abc'
    # No environment is offered on the attach at all, so it cannot even look
    # like a repair; the locale belongs to the fresh launch only.
    assert ' -e ' not in reattach
    assert 'C.utf8' not in reattach
    assert '-e LANG=C.utf8 -e LC_CTYPE=C.utf8' in fresh
    doc = ssh_manager.build_tmux_command.__doc__
    assert 'PRESERVATION' in doc and 'not a repair' in doc


def test_the_probe_read_cap_admits_a_full_glibc_locale_listing():
    """`locale -a` is a few KB, not 256 bytes.

    Measured on this host: 152 UTF-8 entries, ~2.9 KB of listing. The old cap
    was sized for `tmux -V` alone; leaving it would truncate the listing before
    the sentinel and silently fall back on every full-locale host.
    """
    assert ssh_manager.TMUX_PROBE_MAX_BYTES >= 16384


# ── W13: the NON-tmux transport gets the same locale ────────────────────────
#
# The locale fix used to live entirely inside `if use_tmux:`, so a session with
# tmux off got no locale at all and still mangled Vietnamese. On a Tailscale
# target that is the whole defect: tailscaled serves SSH itself and applies no
# pam_env, so the shell inherits LANG= empty / LC_CTYPE=POSIX (charmap
# ANSI_X3.4-1968); OpenSSH sshd on the same host reads /etc/default/locale
# through pam_env and hands out en_US.UTF-8 for free. Same product code, opposite
# result per transport.

def test_non_tmux_session_launches_the_execd_login_shell(monkeypatch):
    """The exec'd command line IS the locale proof on an env-ignoring server.

    Since W13-A1 discovery, the one probe round trip also answers the
    account's login shell, so the default non-tmux launch is get_pty ->
    exec_command("exec env LANG=… LC_CTYPE=… '/bin/bash' -l"): the locale
    rides INSIDE the command line, which a server that silently drops SSH
    `env` requests (tailscaled) cannot strip. The host's OWN spelling is what
    travels — this box lists C.utf8 and not C.UTF-8, and a name the host
    lacks is silently ignored by setlocale — no better than nothing.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'POSIX\nC\nC.utf8\nen_US.utf8')

    session_id, error = connect_target(password='secret', use_tmux=False)

    assert error is None
    probe_channel, shell_channel = clients[0].transport.session_channels
    assert probe_channel.command == ssh_manager.TMUX_PROBE_COMMAND
    assert shell_channel.calls == ['get_pty', 'exec_command']
    assert shell_channel.command == ssh_manager.build_login_shell_command(
        'C.utf8', '/bin/bash')
    # No separate `env` request on the exec path — the env is the command.
    assert shell_channel.environment == {}
    assert shell_channel.pty == ('xterm-256color', 80, 24)
    assert ssh_manager.sessions[session_id]['utf8_locale'] == 'C.utf8'
    # The discovered, validated shell is carried on the session record: the
    # cache a reconnect reuses instead of re-discovering.
    assert ssh_manager.sessions[session_id]['login_shell'] == '/bin/bash'
    # A non-tmux session has no pane to inherit, so there is no legacy question.
    assert ssh_manager.sessions[session_id]['legacy_tmux_locale'] is None
    ssh_manager.close_session(session_id)


def test_non_tmux_asks_for_the_same_names_as_tmux(monkeypatch):
    """One helper, so the two transports cannot drift apart again.

    LC_CTYPE decides multi-byte handling; LANG is the base fallback. LC_ALL is
    deliberately absent — it would also override the target's messages,
    collation and time formats. The non-tmux exec path expresses the SAME pair
    the tmux `-e` flags carry, inside the exec'd command line.
    """
    assert ssh_manager.build_shell_env('C.utf8') == {
        'LANG': 'C.utf8', 'LC_CTYPE': 'C.utf8'}
    assert set(ssh_manager.build_shell_env()) == set(
        ssh_manager.TMUX_UTF8_ENV_NAMES)
    assert 'LC_ALL' not in ssh_manager.build_shell_env()
    # An unresolved locale falls back to exactly the historical constant.
    assert ssh_manager.build_shell_env(None) == {
        'LANG': ssh_manager.TMUX_UTF8_FALLBACK_LOCALE,
        'LC_CTYPE': ssh_manager.TMUX_UTF8_FALLBACK_LOCALE}

    clients = install_ssh_clients(monkeypatch, locale_listing=b'C.utf8\n')
    session_id, error = connect_target(password='secret', use_tmux=False)
    assert error is None
    _, shell_channel = clients[0].transport.session_channels
    tmux_command = ssh_manager.build_tmux_command('s', (3, 4),
                                                  utf8_locale='C.utf8')
    for name, value in ssh_manager.build_shell_env('C.utf8').items():
        assert f"'{value}'" in shell_channel.command
        assert f'-e {name}={value}' in tmux_command
    ssh_manager.close_session(session_id)


def test_non_tmux_locale_is_identical_for_every_auth_type(monkeypatch):
    """The anti-regression, restated for the non-tmux path.

    The original defect was an auth_type branch. Extending the fix to non-tmux
    must not reintroduce one: password, key and tailscale must launch the SAME
    exec'd login shell with the SAME host locale on the same host — each one
    exercised through its REAL connect contract (password on the wire, pkey
    from key content, and the tailscale NoneAuth strategy), never a password
    call labelled otherwise.
    """
    import io
    listing = b'C.utf8\nen_US.utf8\n'
    key = paramiko.RSAKey.generate(2048)
    pem = io.StringIO()
    key.write_private_key(pem)
    asked = {}
    for auth_type, kwargs in (
        ('password', {'password': 'secret'}),
        ('key', {'key_content': pem.getvalue()}),
        ('tailscale', {}),
    ):
        clients = install_ssh_clients(monkeypatch, locale_listing=listing)
        session_id, error = connect_target(
            use_tmux=False, auth_type=auth_type, **kwargs)
        assert error is None, auth_type
        assert ssh_manager.sessions[session_id]['auth_type'] == auth_type
        connect_kwargs = clients[0].connect_kwargs
        _, shell_channel = clients[0].transport.session_channels
        # Every auth type launches the SAME exec'd login shell carrying the
        # SAME host locale — tailscale included, which is exactly the surface
        # where the env-request shape was stripped and Vietnamese broke.
        assert shell_channel.calls == ['get_pty', 'exec_command'], auth_type
        asked[auth_type] = shell_channel.command
        # The production connect shape, per auth type:
        if auth_type == 'password':
            assert connect_kwargs['password'] == 'secret'
            assert 'auth_strategy' not in connect_kwargs
            assert 'pkey' not in connect_kwargs
        elif auth_type == 'key':
            assert isinstance(connect_kwargs['pkey'], paramiko.RSAKey)
            assert 'password' not in connect_kwargs
            assert 'auth_strategy' not in connect_kwargs
        else:
            assert isinstance(connect_kwargs['auth_strategy'],
                              ssh_manager.TailscaleSSHAuthStrategy)
            assert connect_kwargs['auth_strategy'].username == 'alice'
            assert 'password' not in connect_kwargs
            assert 'pkey' not in connect_kwargs
        ssh_manager.close_session(session_id)

    assert len(set(asked.values())) == 1, (
        f'auth type still changes the non-tmux launch: {asked}')
    assert asked['tailscale'] == ssh_manager.build_login_shell_command(
        'C.utf8', '/bin/bash')


def test_a_server_that_refuses_env_still_gets_a_working_shell(monkeypatch):
    """A restrictive AcceptEnv must cost the user nothing.

    paramiko sends `env` with want_reply=False, so an sshd that simply ignores
    the request never tells us. A server that ERRORS on it raises, and that must
    not fail the connection: the shell is still worth having. With no getent
    answer there is no discovery either, so this is exactly the shipped
    invoke_shell shape — a degradation, never a failure.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        env_error=paramiko.SSHException('env rejected'),
        login_shell_getent='')

    session_id, error = connect_target(password='secret', use_tmux=False)

    assert error is None
    assert session_id in ssh_manager.sessions
    assert ssh_manager.sessions[session_id]['connected'] is True
    _, shell_channel = clients[0].transport.session_channels
    # Nothing was recorded (the request raised), and the shell started anyway.
    assert shell_channel.environment == {}
    assert shell_channel.shell_invoked is True
    ssh_manager.close_session(session_id)


def test_a_server_that_refuses_a_bare_session_falls_back_to_invoke_shell(
        monkeypatch):
    """No transport session, no locale — but still a session.

    open_shell_channel needs transport.open_session() to make the env request.
    A server that refuses one must fall back to client.invoke_shell(), which is
    the exact call that shipped before this change.
    """
    clients = []

    def factory():
        client = FakeSSHClient()
        client.probe_locale_listing = b'C.utf8\n'
        # Let the capability probe through, then refuse the shell session.
        client.transport.open_session_error = paramiko.SSHException('no session')
        client.transport.open_session_error_after = 1
        clients.append(client)
        return client

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', factory)
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda _seconds: None)

    session_id, error = connect_target(password='secret', use_tmux=False)

    assert error is None
    assert session_id in ssh_manager.sessions
    assert clients[0].shell_kwargs == {
        'term': 'xterm-256color', 'width': 80, 'height': 24}
    assert clients[0].channel.timeout == 0.1
    # No env was recorded anywhere: the fallback cannot make the request, and
    # that is a degradation, not a failure.
    assert clients[0].channel.environment == {}
    ssh_manager.close_session(session_id)


# ── W13: legacy-pane detection, read-only ───────────────────────────────────

@pytest.mark.parametrize(
    ('output', 'expected'),
    [
        ('LC_CTYPE=C.UTF-8', True),
        ('LC_CTYPE=C.utf8', True),
        ('LC_CTYPE=en_US.UTF-8\n', True),
        # tmux's own answer for a session created before any locale existed.
        ('unknown variable: LC_CTYPE', False),
        ('Unknown variable: LC_CTYPE', False),
        # A named value that is NOT UTF-8 is no better than none.
        ('LC_CTYPE=POSIX', False),
        ('LC_CTYPE=C', False),
        # tmux's explicit-unset form.
        ('-LC_CTYPE', False),
        ('LC_CTYPE=', False),
        # Unanswered: never guessed either way.
        ('', None),
        (None, None),
        ('some unrelated error', None),
    ],
)
def test_session_locale_parsing_says_legacy_only_when_it_knows(output, expected):
    assert ssh_manager.parse_tmux_session_locale(output) is expected


def test_reattaching_a_legacy_pane_is_reported_not_repaired(monkeypatch):
    """The measured limitation must reach the session record.

    A pane created before the fix cannot be given UTF-8 (its shell was exec'd
    before any locale existed, and an attach never re-enters that process), and
    repairing it would mean writing to the user's live session — injecting
    commands, sending keys or respawning the pane, all of which destroy the work
    the reattach exists to preserve. So the reattach MEASURES the pane and
    records the answer; the UI says so.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'unknown variable: LC_CTYPE\n')

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='legacy_pane')

    assert error is None
    session = ssh_manager.sessions[session_id]
    assert session['legacy_tmux_locale'] is True
    assert session['tmux_session_name'] == 'legacy_pane'
    # PRESERVED, not reset: nothing was launched at all.
    assert launch_channels_of(clients[0]) == []
    # Nothing wrote to the session. Every channel asked a question only.
    commands = [c.command for c in clients[0].transport.session_channels]
    for command in commands:
        assert 'set-environment' not in (command or '')
        assert 'send-keys' not in (command or '')
        assert 'respawn' not in (command or '')
        assert 'kill-session' not in (command or '')
    assert any('show-environment' in (c or '') for c in commands)
    ssh_manager.close_session(session_id)


def test_reattaching_a_utf8_pane_is_not_flagged_legacy(monkeypatch):
    """The companion that stops the flag being vacuously true."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'LC_CTYPE=C.utf8\n')

    session_id, error = connect_target(
        password='secret', use_tmux=True, reconnect_tmux_name='fixed_pane')

    assert error is None
    assert ssh_manager.sessions[session_id]['legacy_tmux_locale'] is False
    ssh_manager.close_session(session_id)


def test_a_fresh_tmux_session_is_measured_not_assumed(monkeypatch):
    """A NEW session is MEASURED, not marked fine by construction.

    Defect #118: fresh sessions used to be stamped legacy_tmux_locale=False on
    the reasoning that "the command being built is the answer". That holds only
    on tmux >= 3.2 (`-e` sets the session's own environment). Below 3.2 -- and on
    any host whose `tmux -V` was unreadable -- the fallback is a client-side
    `env` prefix that a pane inherits only when that client STARTS the server;
    attach to an already-running server and the prefix is inert, yet the session
    was reported as verified-good. So the created session is now asked what it
    actually has, with the same read-only probe the reattach uses.

    Here the measurement answers UTF-8 (default fake session_locale), so the
    honest answer is still "fine" -- but it is MEASURED fine, asserted via the
    show-environment probe rather than assumed.
    """
    clients = install_ssh_clients(monkeypatch, locale_listing=b'C.utf8\n')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    assert ssh_manager.sessions[session_id]['legacy_tmux_locale'] is False
    channels = clients[0].transport.session_channels
    # Capability probe, the tmux channel itself, then the post-creation locale
    # measurement.
    assert len(channels) == 3
    locale_probes = [c for c in channels
                     if 'show-environment' in (c.command or '')]
    assert len(locale_probes) == 1
    ssh_manager.close_session(session_id)


def test_a_fresh_tmux_session_measured_legacy_is_reported_true(monkeypatch):
    """When the measurement says no UTF-8, the NEW session is reported legacy.

    This is the case the old by-construction stamp could never express: a fresh
    session that comes up without a UTF-8 LC_CTYPE (the <3.2 / unreadable-version
    path). Reporting it honestly means legacy_tmux_locale=True, not the False the
    previous code hard-coded.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'-LC_CTYPE\n')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    assert ssh_manager.sessions[session_id]['legacy_tmux_locale'] is True
    ssh_manager.close_session(session_id)


def test_an_unanswered_pane_question_stays_unknown_not_fine(monkeypatch):
    """None is neither True nor False, and must not be collapsed to either.

    A pane we could not ask is UNKNOWN. Reporting it as False (measured fine)
    would tell the UI to promise UTF-8 for a pane nobody checked, which is the
    one answer that lets Vietnamese fail silently again. Reporting it as True
    would warn about panes that are perfectly fine.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', session_locale=b'')

    session_id, error = connect_target(
        password='secret', use_tmux=True, reconnect_tmux_name='silent_pane')

    assert error is None
    session = ssh_manager.sessions[session_id]
    assert session['legacy_tmux_locale'] is None
    assert ssh_manager.get_session(session_id)['legacy_tmux_locale'] is None
    ssh_manager.close_session(session_id)


def test_the_three_probe_answers_stay_three(monkeypatch):
    """The tri-state, asserted as three DIFFERENT session values.

    Stated as an inequality set so a future change that collapses any pair --
    None to False being the dangerous one -- fails here by name rather than
    silently making the UI lie about one class of pane.
    """
    answers = {}
    for label, output in (
        ('legacy', b'unknown variable: LC_CTYPE\n'),
        ('utf8', b'LC_CTYPE=C.utf8\n'),
        ('unknown', b''),
    ):
        clients = install_ssh_clients(
            monkeypatch, locale_listing=b'C.utf8\n', session_locale=output)
        session_id, error = connect_target(
            password='secret', use_tmux=True, reconnect_tmux_name='pane')
        assert error is None, label
        answers[label] = ssh_manager.sessions[session_id]['legacy_tmux_locale']
        ssh_manager.close_session(session_id)

    assert answers == {'legacy': True, 'utf8': False, 'unknown': None}
    assert len({repr(v) for v in answers.values()}) == 3


def test_the_session_projection_carries_the_locale_facts(monkeypatch):
    """get_session is what the snapshot reads, so the facts must be in it."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'unknown variable: LC_CTYPE\n')

    session_id, error = connect_target(
        password='secret', use_tmux=True, reconnect_tmux_name='legacy_pane')

    assert error is None
    projected = ssh_manager.get_session(session_id)
    assert projected['utf8_locale'] == 'C.utf8'
    assert projected['legacy_tmux_locale'] is True
    ssh_manager.close_session(session_id)


@pytest.mark.parametrize(
    ('banner', 'expected'),
    [
        ('tmux 3.4', (3, 4)),
        ('tmux 3.3a', (3, 3)),
        ('tmux 3.2', (3, 2)),
        ('tmux 2.9a', (2, 9)),
        ('tmux next-3.5', (3, 5)),
        ('bash: tmux: command not found', None),
        ('', None),
        (None, None),
    ],
)
def test_tmux_version_parsing(banner, expected):
    assert ssh_manager._parse_tmux_version(banner) == expected


def test_pre_3_2_tmux_keeps_the_client_side_prefix():
    """`-e` on new-session arrived in tmux 3.2.

    On an older server `-e` is a usage error that kills the channel, so a FRESH
    session falls back to the legacy `env ...` prefix rather than break the
    session outright. A reattach never needed either: it carries no environment
    at all (W13-B5 attach-only), and the prefix was always inert on attach --
    a tmux server's environment is fixed by whichever client started it.
    """
    fresh = ssh_manager.build_tmux_command('s1', (2, 9))
    assert fresh == (
        'env LANG=C.UTF-8 LC_CTYPE=C.UTF-8 tmux -u new-session -d -s s1')

    # The attach is built by its own function, which takes no version at all:
    # there is nothing version-gated left in it, so an old server and a new one
    # get the identical command.
    reattach = ssh_manager.build_tmux_attach_command('s1')
    assert reattach == 'tmux -u attach-session -t =s1'
    assert ' -e ' not in reattach


def test_unreadable_tmux_version_takes_the_conservative_path():
    """An unreadable banner must not gamble on `-e`.

    If the version cannot be read, assuming 3.2+ would risk a usage error that
    kills the session. The fallback prefix works on every version. Only the
    FRESH launch is exposed to this: an attach carries no `-e` to gamble with.
    """
    fresh = ssh_manager.build_tmux_command('s1', None)
    assert fresh.startswith('env LANG=C.UTF-8 LC_CTYPE=C.UTF-8 tmux -u ')
    assert ' -e ' not in fresh

    reattach = ssh_manager.build_tmux_attach_command('s1')
    assert reattach == 'tmux -u attach-session -t =s1'


def test_reattach_preserves_the_exact_session_name_and_attach_semantics():
    """The exact name and attach-ONLY semantics are what reconnect promises.

    The session name is what brings back the user's existing pane, history and
    running processes. `-t '=name'` is tmux's exact-match form, so the retained
    name can never act as a pattern and reach a different session, and
    attach-session cannot create: a name that stopped existing produces a
    failure, never a replacement pane wearing the retained identity.
    """
    reattach = ssh_manager.build_tmux_attach_command('tmux_alice_host_22_abc')
    assert reattach == 'tmux -u attach-session -t =tmux_alice_host_22_abc'
    # The create verb and its attach-or-create flag must be absent ENTIRELY:
    # `new-session -A` is what silently manufactured a replacement identity.
    assert 'new-session' not in reattach
    assert '-A' not in reattach

    fresh = ssh_manager.build_tmux_command('tmux_alice_host_22_abc', (3, 4))
    # The fresh launch is the ONLY one allowed to create, and it never attaches
    # to a name it did not just generate.
    assert 'new-session' in fresh
    assert '-A' not in fresh
    assert 'attach-session' not in fresh
    assert fresh.endswith(' -s tmux_alice_host_22_abc')


def test_reattach_target_is_shell_quoted_so_a_name_cannot_break_out():
    """Defence in depth behind the server-side whitelist.

    A reconnect name is already refused unless it matches
    ^[A-Za-z0-9_]{1,190}$, and such a name needs no quoting -- so the quoting
    must be proven with a name the whitelist would reject, or the assertion is
    vacuous. shlex.quote is what guarantees a name can never become a second
    command or a second argument even if it reached here another way.
    """
    plain = ssh_manager.build_tmux_attach_command('s1')
    assert plain == 'tmux -u attach-session -t =s1'

    hostile = ssh_manager.build_tmux_attach_command('a; reboot')
    assert hostile == "tmux -u attach-session -t '=a; reboot'"
    # One argument, and the `=` stays INSIDE it: exact-match targeting survives
    # the quoting, so the name cannot be reinterpreted as a pattern either.
    assert shlex.split(hostile) == [
        'tmux', '-u', 'attach-session', '-t', '=a; reboot']


# ── W13-B5: a retained reattach fails CLOSED, never creates ─────────────────
#
# `new-session -A` has two behaviours: attach when the session exists, CREATE
# when it does not. A reconnect whose retained session died between validation
# and execution therefore used to SILENTLY manufacture an empty replacement
# pane wearing the retained identity -- the user was told they had reattached.
# The contract that replaces it:
#
#   * the reattach command is attach-only (no create verb, no -A, no -e);
#   * before it runs, the retained session must be PROVEN to exist with a
#     read-only has-session; only a definite True proceeds;
#   * a gone session (or an unanswered check) fails closed: no session is
#     registered, nothing is created on the host, and every resource opened is
#     closed again -- the source's UI, transport and DB row are untouched
#     because nothing was swapped or retired.

def test_tmux_session_exists_reads_the_exit_status_and_never_creates():
    """The existence check is read-only BY CONSTRUCTION."""
    transport = RecordingTransport()
    assert ssh_manager.tmux_session_exists(transport, 'sshdeck_live') is True
    assert ssh_manager.tmux_session_exists(
        RecordingTransportWithStatus(1), 'sshdeck_live') is False
    # An unanswered check (a channel that throws) is None -- never False and
    # never True, because the caller must treat it like failure, not success.
    assert ssh_manager.tmux_session_exists(RaisingTransport(), 's') is None
    # And degenerate inputs cannot reach the host at all.
    assert ssh_manager.tmux_session_exists(None, 's') is None
    assert ssh_manager.tmux_session_exists(RecordingTransport(), '') is None
    # Every command issued was the read-only exact-match question.
    for channel in transport.channels:
        assert channel.command == 'tmux has-session -t =sshdeck_live 2>/dev/null'
        assert 'new-session' not in channel.command
        assert '-A' not in channel.command


class RecordingTransport:
    def __init__(self):
        self.channels = []

    def open_session(self):
        channel = FakeChannel()
        self.channels.append(channel)
        return channel


class RecordingTransportWithStatus:
    """A transport whose has-session answers a specific non-zero status."""

    def __init__(self, exit_status):
        self.exit_status = exit_status
        self.channels = []

    def open_session(self):
        channel = FakeChannel()
        channel.has_session_exit_status = self.exit_status
        # Make EVERY exec on this channel answer the has-session status, not
        # the probe default: this host only ever gets asked one question.
        channel.probe_exit_status = self.exit_status
        self.channels.append(channel)
        return channel


class RaisingTransport:
    def open_session(self):
        raise OSError('channel unavailable')


def test_a_reattach_with_the_session_present_is_attach_only(monkeypatch):
    """The success shape: has-session answers, then the attach runs.

    Pinned as the WHOLE command sequence, in order: the capability probe, the
    read-only existence check and the read-only locale measurement. Every one
    of them only ASKS -- there is no create verb anywhere in it, and since
 no attach either, because the attach belongs to each browser
    socket's own view.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'LC_CTYPE=C.utf8\n')

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='sshdeck_retained')

    assert error is None
    commands = [c.command for c in clients[0].transport.session_channels]
    assert commands == [
        ssh_manager.TMUX_PROBE_COMMAND,
        'tmux has-session -t =sshdeck_retained 2>/dev/null',
        'tmux show-environment -t =sshdeck_retained LC_CTYPE 2>&1',
    ]
    # The session registered is the RETAINED one -- no fresh name was minted.
    assert ssh_manager.sessions[session_id]['tmux_session_name'] == (
        'sshdeck_retained')
    ssh_manager.close_session(session_id)


def test_a_reattach_fails_closed_when_the_session_is_gone_at_execution(
        monkeypatch):
    """The race B5 exists to fix, modelled at the moment it matters.

    The retained session was validated against the DB row before the transport
    was built, and the host answered has-session GONE (non-zero). The build
    must fail with the correlated error: no session registered, no tmux command
    ever issued that could CREATE the name, and nothing left open.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        has_session_exit_status=1)

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='sshdeck_vanished')

    assert session_id is None
    assert error == ssh_manager.TMUX_REATTACH_GONE_ERROR
    assert len(ssh_manager.sessions) == 0
    # No verb that can create the identity ran at all -- the only tmux
    # commands issued were the read-only questions.
    commands = [c.command for c in clients[0].transport.session_channels]
    for command in commands:
        assert 'new-session' not in command
        assert 'attach-session' not in command
    assert any('has-session' in (c or '') for c in commands)
    # No orphan resources: the client the transport opened is closed again,
    # and the pending-connection slot is released.
    assert clients[0].closed is True
    assert ssh_manager._pending_connections == 0
    # The existence check precedes the locale measurement: a gone session is
    # never asked what locale it has.
    assert commands == [
        ssh_manager.TMUX_PROBE_COMMAND,
        'tmux has-session -t =sshdeck_vanished 2>/dev/null',
    ]


def test_the_existence_check_runs_before_anything_could_have_created(
        monkeypatch):
    """ORDERING, observed from inside the check itself.

    The value of the check is entirely in its position: if any launch verb had
    already run, the replacement pane would already exist and refusing
    afterwards would be too late. The fake calls back at the exact instant the
    has-session command is issued, and at that instant NO launch verb may have
    been issued on any channel.
    """
    seen_at_check = {}
    clients_box = []

    def on_check(command):
        launch_commands = [
            c.command for c in clients_box[0].transport.session_channels
            if c.command and any(verb in c.command
                                 for verb in TMUX_LAUNCH_VERBS)]
        seen_at_check['command'] = command
        seen_at_check['launches'] = launch_commands

    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'LC_CTYPE=C.utf8\n',
        on_has_session=on_check)
    clients_box.append(None)

    # The factory runs lazily, so the box is filled on the first open_session.
    original_factory = ssh_manager.paramiko.SSHClient

    def capturing_factory():
        client = original_factory()
        clients_box[0] = client
        return client

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', capturing_factory)

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='sshdeck_ordered')

    assert error is None
    assert seen_at_check['command'] == (
        'tmux has-session -t =sshdeck_ordered 2>/dev/null')
    assert seen_at_check['launches'] == [], (
        'a tmux launch had already run when existence was checked, so the '
        'check can no longer prevent a replacement pane')
    ssh_manager.close_session(session_id)


def test_a_reattach_fails_closed_when_existence_cannot_be_confirmed(
        monkeypatch):
    """An UNANSWERED existence check is failure, not optimism.

    None must be treated exactly like False: if the host will not confirm the
    session exists, the attach is refused. Rounding None to "probably there"
    would hand the user an attach that exits immediately -- or, worse, the
    very replacement pane this check exists to prevent.
    """

    class RaisingAfterProbeTransport:
        """The probe round trip works; the very next channel throws."""

        def __init__(self, owner=None):
            self.owner = owner
            self.keepalive = None
            self.session_channels = []
            self.forward_channel = FakeForwardChannel()

        def set_keepalive(self, seconds):
            self.keepalive = seconds

        def open_channel(self, kind, destination, source):
            return self.forward_channel

        def open_session(self):
            channel = FakeChannel()
            if self.owner is not None and self.owner.probe_locale_listing:
                channel.locale_listing = self.owner.probe_locale_listing
            self.session_channels.append(channel)
            if len(self.session_channels) > 1:
                raise OSError('existence check could not be answered')
            return channel

        def is_active(self):
            return True

    clients = install_ssh_clients(monkeypatch, locale_listing=b'C.utf8\n')

    original_get_transport = ssh_manager.paramiko.SSHClient
    # Re-wrap so the first client hands back a transport that cannot answer.
    def raising_factory():
        client = original_get_transport()
        client.transport = RaisingAfterProbeTransport(owner=client)
        return client

    monkeypatch.setattr(ssh_manager.paramiko, 'SSHClient', raising_factory)

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='sshdeck_unconfirmed')

    assert session_id is None
    assert error == ssh_manager.TMUX_REATTACH_GONE_ERROR
    assert len(ssh_manager.sessions) == 0
    for command in [c.command for c in clients[0].transport.session_channels]:
        # A channel whose exec_command never ran has command=None; neither
        # shape may carry a create verb.
        assert 'new-session' not in (command or '')
        assert 'attach-session' not in (command or '')
    assert ssh_manager._pending_connections == 0


def test_a_reattach_on_a_host_without_tmux_fails_closed_no_fallback(
        monkeypatch):
    """A retained reattach whose host lost tmux is NOT downgraded to a shell.

    The brand-new-connection fallback exists because a fresh session can be
    served by a plain shell; a RETAINED one cannot -- the pane it promises is
    tmux's. Silently opening a shell would wear the session's label while
    delivering nothing of it, so the build refuses with the named error.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', tmux_banner=b'',
        probe_exit_status=127)

    session_id, error = connect_target(
        password='secret', use_tmux=True,
        reconnect_tmux_name='sshdeck_retained')

    assert session_id is None
    assert error == ssh_manager.TMUX_REATTACH_UNAVAILABLE_ERROR
    assert len(ssh_manager.sessions) == 0
    # No shell of any kind was opened behind the user's back.
    for channel in clients[0].transport.session_channels:
        assert 'invoke_shell' not in channel.calls
        assert 'new-session' not in (channel.command or '')
        assert 'attach-session' not in (channel.command or '')
    assert clients[0].shell_kwargs is None
    assert ssh_manager._pending_connections == 0


def test_a_brand_new_connection_still_falls_back_when_the_host_lacks_tmux(
        monkeypatch):
    """The companion: the fallback survives for sessions that NEVER promised
    a tmux pane. Without it, every fresh session on a tmux-less host would now
    refuse to connect -- the opposite defect."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', tmux_banner=b'',
        probe_exit_status=127)

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    session = ssh_manager.sessions[session_id]
    assert session['use_tmux'] is False
    assert session['tmux_session_name'] is None
    ssh_manager.close_session(session_id)


def test_a_fresh_session_never_checks_existence_and_creates_its_own_name(
        monkeypatch):
    """Brand-new stays separate from retained, verb and questions and all.

    A fresh session mints its OWN name (so it is the only thing that may use
    the create verb), never asks has-session (there is nothing retained to
    check), and never attaches.
    """
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        session_locale=b'LC_CTYPE=C.utf8\n')

    session_id, error = connect_target(password='secret', use_tmux=True)

    assert error is None
    commands = [c.command for c in clients[0].transport.session_channels]
    assert not any('has-session' in (c or '') for c in commands)
    assert not any('attach-session' in (c or '') for c in commands)
    created = ssh_manager.sessions[session_id]['tmux_session_name']
    assert created.startswith(ssh_manager.config.TMUX_SESSION_PREFIX + '_')
    assert created != 'sshdeck_retained'
    assert any(c.startswith('tmux -u new-session')
               and c.endswith(f' -s {created}') for c in commands)
    ssh_manager.close_session(session_id)


def test_proxy_jump_password_opens_direct_tcpip_channel(monkeypatch):
    clients = install_ssh_clients(monkeypatch)

    session_id, error = connect_target(
        password='target-password',
        proxy_jump_host='bastion.example',
        proxy_jump_port=2222,
        proxy_jump_username='jump-user',
        proxy_jump_password='jump-password',
    )

    assert error is None
    assert session_id in ssh_manager.sessions
    bastion, target = clients
    assert bastion.connect_kwargs == {
        'hostname': 'bastion.example',
        'port': 2222,
        'username': 'jump-user',
        'timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        # banner_timeout / auth_timeout are part of the contract because
        # `timeout` alone covers ONLY the TCP connect. Measured on the deployed
        # build: a peer that accepts the socket then stalls in negotiation left
        # the client with no response for 30.5 seconds before ssh_error arrived,
        # modal open and spinner running the whole time -- the Owner's "I press
        # Connect and nothing happens". Both clocks share the connect budget.
        'banner_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'auth_timeout': ssh_manager.config.SSH_CONNECT_TIMEOUT,
        'look_for_keys': False,
        'allow_agent': False,
        'password': 'jump-password',
    }
    assert bastion.transport.opened_channel == (
        'direct-tcpip',
        ('target.example', 22),
        ('127.0.0.1', 0),
    )
    assert target.connect_kwargs['sock'] is bastion.transport.forward_channel
    assert ssh_manager.sessions[session_id]['bastion_client'] is bastion


def test_proxy_jump_key_uses_supported_pkey(
        monkeypatch, rsa_private_key_pem):
    clients = install_ssh_clients(monkeypatch)

    session_id, error = connect_target(
        password='target-password',
        proxy_jump_host='bastion.example',
        proxy_jump_port=22,
        proxy_jump_username='jump-user',
        proxy_jump_key_content=rsa_private_key_pem,
    )

    assert error is None
    assert session_id in ssh_manager.sessions
    assert isinstance(clients[0].connect_kwargs['pkey'], paramiko.RSAKey)
    assert 'password' not in clients[0].connect_kwargs


def test_target_failure_closes_bastion(monkeypatch):
    clients = install_ssh_clients(
        monkeypatch,
        None,
        paramiko.SSHException('target-marker'),
    )

    session_id, error = connect_target(
        password='target-password',
        proxy_jump_host='bastion.example',
        proxy_jump_port=22,
        proxy_jump_username='jump-user',
        proxy_jump_password='jump-password',
    )

    assert session_id is None
    assert error == 'SSH connection failed'
    assert clients[0].closed is True
    assert ssh_manager.sessions == {}


def test_authentication_exception_keeps_generic_client_error(monkeypatch):
    install_ssh_clients(
        monkeypatch,
        paramiko.AuthenticationException('credential-marker'),
    )

    session_id, error = connect_target(password='secret')

    assert session_id is None
    assert error == 'Authentication failed - invalid credentials'
    assert 'credential-marker' not in error


def test_ssh_exception_keeps_detail_in_server_log_only(monkeypatch):
    install_ssh_clients(monkeypatch, paramiko.SSHException('server-marker'))
    logged = []
    monkeypatch.setattr(
        ssh_manager,
        'log_warning',
        lambda message, **fields: logged.append((message, fields)),
    )

    session_id, error = connect_target(password='secret')

    assert session_id is None
    assert error == 'SSH connection failed'
    assert 'server-marker' not in error
    assert logged == [(
        'SSH connection failed',
        {'host': 'target.example:22', 'error': 'server-marker'},
    )]

# ── W13-A1: the exec-launched login shell (locale survives an env-ignoring server) ──

def test_build_login_shell_command_sets_locale_then_execs_the_shell():
    """The command IS the proof-carrying launch: the locale rides inside the
    exec'd command line, so a server that silently drops SSH `env` requests
    (tailscaled) cannot strip it. `exec` replaces the wrapper shell that runs
    the command, so the account shell starts exactly once and its own `-l`
    gives login semantics -- profiles are sourced once, by the shell itself."""
    cmd = ssh_manager.build_login_shell_command('C.utf8', '/bin/bash')
    assert cmd == "exec env LANG='C.utf8' LC_CTYPE='C.utf8' '/bin/bash' -l"

def test_build_login_shell_command_quotes_every_interpolated_value():
    """Single quotes, so the remote shell that runs the command cannot expand
    or word-split anything that came from the network."""
    cmd = ssh_manager.build_login_shell_command('en_US.utf8', '/usr/bin/zsh')
    assert "'en_US.utf8'" in cmd
    assert "'/usr/bin/zsh'" in cmd

@pytest.mark.parametrize('bad_locale', [
    "C.utf8'; rm -rf /; '",
    'C.utf8$(reboot)',
    'C.utf8 en_US.utf8',
    'C.utf8\n',
    "C.ut'f8",
    '',
    None,
])
def test_build_login_shell_command_rejects_unsafe_locales(bad_locale):
    assert ssh_manager.build_login_shell_command(bad_locale, '/bin/bash') is None

@pytest.mark.parametrize('bad_shell', [
    'bash',                     # not absolute: PATH games
    '/bin/bash; reboot',
    '/bin/bash$(x)',
    "/bin/ba'sh",
    '/bin/bash -c evil',
    '/bin/bash\n',
    '/bin/../bin/bash',
    '',
    None,
])
def test_build_login_shell_command_rejects_unsafe_shells(bad_shell):
    assert ssh_manager.build_login_shell_command('C.utf8', bad_shell) is None

@pytest.mark.parametrize('shell', ['/usr/bin/fish', '/bin/csh', '/bin/tcsh',
                                   '/sbin/nologin', '/bin/false'])
def test_build_login_shell_command_declines_unproven_shells(shell):
    """A shell whose `-l` semantics are not proven is never guessed at: the
    caller must fall back to invoke_shell and report UTF-8 as unverified."""
    assert ssh_manager.build_login_shell_command('C.utf8', shell) is None

@pytest.mark.parametrize('shell', ['/bin/bash', '/usr/bin/bash', '/bin/zsh',
                                   '/usr/bin/zsh', '/bin/sh', '/usr/bin/sh',
                                   '/bin/dash', '/usr/bin/ksh', '/bin/mksh'])
def test_build_login_shell_command_supports_the_posix_family(shell):
    cmd = ssh_manager.build_login_shell_command('C.utf8', shell)
    assert cmd is not None
    assert f"'{shell}'" in cmd
    assert cmd.rstrip().endswith('-l')

def test_open_shell_channel_execs_the_login_shell_when_supported():
    """With a proven shell the launch is get_pty -> exec_command(login shell):
    invoke_shell is NOT used, and no separate `env` request is made -- the env
    travels inside the command line, which an env-ignoring server still runs."""
    client = FakeSSHClient()
    channel = ssh_manager.open_shell_channel(
        client, client.transport, utf8_locale='C.utf8',
        login_shell='/bin/bash')
    assert channel is client.transport.session_channels[-1]
    assert channel.calls == ['get_pty', 'exec_command']
    assert channel.shell_invoked is False
    assert channel.command == ssh_manager.build_login_shell_command(
        'C.utf8', '/bin/bash')
    assert channel.pty == ('xterm-256color', 80, 24)

def test_open_shell_channel_falls_back_to_invoke_shell_for_unproven_shells():
    """No usable shell keeps the pre-W13 launch exactly: env request +
    invoke_shell. Behaviour degrades to what shipped, never worse."""
    client = FakeSSHClient()
    channel = ssh_manager.open_shell_channel(
        client, client.transport, utf8_locale='C.utf8',
        login_shell='/usr/bin/fish')
    assert channel is client.transport.session_channels[-1]
    assert channel.calls == ['update_environment', 'get_pty', 'invoke_shell']
    assert channel.command is None


# ── W13-A1 discovery: the account login shell, strictly validated ───────────
#
# The discovery rides inside the ONE probe round trip every connect already
# makes (`getent passwd "$(id -u)"`, uid kernel-trusted, never $USER). Its
# answer is DISCOVERED, never trusted: only a strictly validated shell path
# survives parse_login_shell_from_getent, and nothing from it is ever
# interpolated back into a command. A host that fails validation, or has no
# getent, contributes None — the shipped invoke_shell fallback, never worse.

@pytest.mark.parametrize(
    ('entry', 'expected'),
    [
        ('alice:x:1000:1000:Alice:/home/alice:/bin/bash', '/bin/bash'),
        ('bob:x:1001:1001::/home/bob:/usr/bin/zsh', '/usr/bin/zsh'),
        ('root:x:0:0:root:/root:/bin/sh', '/bin/sh'),
        ('x:x:1:1::/tmp:/bin/dash', '/bin/dash'),
        ('x:x:1:1::/tmp:/usr/bin/ksh', '/usr/bin/ksh'),
        ('x:x:1:1::/tmp:/bin/mksh', '/bin/mksh'),
    ],
)
def test_parse_login_shell_accepts_proven_posix_shells(entry, expected):
    """Exactly seven passwd fields and a proven POSIX basename survive."""
    assert ssh_manager.parse_login_shell_from_getent(entry) == expected


@pytest.mark.parametrize('entry', [
    # Unproven family members — declined exactly like build_login_shell_command.
    'alice:x:1000:1000:Alice:/home/alice:/usr/bin/fish',
    'alice:x:1000:1000:Alice:/home/alice:/bin/csh',
    'alice:x:1000:1000:Alice:/home/alice:/bin/tcsh',
    'alice:x:1000:1000:Alice:/home/alice:/sbin/nologin',
    'alice:x:1000:1000:Alice:/home/alice:/bin/false',
    # Malformed entries — wrong field counts and empty answers.
    'alice:x:1000:1000:Alice:/home/alice',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash:',
    'alice:x:1000:1000:Alice:/home/alice:',
    '',
    None,
    '   \n',
    # Hostile or unsafe shell fields — declined outright, never interpolated.
    'alice:x:1000:1000:Alice:/home/alice:bin/bash',
    'alice:x:1000:1000:Alice:/home/alice:/bin/../bin/bash',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash;reboot',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash$(x)',
    "alice:x:1000:1000:Alice:/home/alice:/bin/ba'sh",
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash -c evil',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash\nrm -rf /',
    # CR/LF variants — the parser fails closed on ANY newline character,
    # including a bare trailing CR: a passwd record cannot contain one, so an
    # answer that does is declined whole, never trimmed to its first line.
    '\ralice:x:1000:1000:Alice:/home/alice:/bin/bash',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash\r',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash\r\n',
    'alice:x:1000:1000:Alice:/home/alice:/bin/ba\rsh',
])
def test_parse_login_shell_rejects_everything_unproven_or_hostile(entry):
    assert ssh_manager.parse_login_shell_from_getent(entry) is None


def test_split_removes_exactly_the_protocol_framing_around_the_entry():
    """The generated probe frames the passwd segment with exactly one '\n'
    from our own `echo` before it and one '\n' from getent's record
    terminator after it. split_tmux_probe_output removes exactly that framing
    so the parser receives ONE clean line — no unrestricted strip."""
    entry = 'alice:x:1000:1000:Alice:/home/alice:/bin/bash'
    s1 = ssh_manager.TMUX_PROBE_SENTINEL
    s2 = ssh_manager.TMUX_PROBE_SHELL_SENTINEL
    # Production shape: entry terminated by getent's newline.
    raw = f'C.utf8\n{s1}\n{entry}\n{s2}\ntmux 3.4\n'.encode()
    listing, parsed, banner = ssh_manager.split_tmux_probe_output(raw)
    assert listing.split() == ['C.utf8']
    assert parsed == entry
    assert banner.strip() == 'tmux 3.4'
    assert ssh_manager.parse_login_shell_from_getent(parsed) == '/bin/bash'
    # CRLF record termination is protocol framing too.
    raw_crlf = f'C.utf8\n{s1}\n{entry}\r\n{s2}\ntmux 3.4\n'.encode()
    _, parsed_crlf, _ = ssh_manager.split_tmux_probe_output(raw_crlf)
    assert parsed_crlf == entry
    assert ssh_manager.parse_login_shell_from_getent(parsed_crlf) == '/bin/bash'


@pytest.mark.parametrize(
    ('segment', 'expected'),
    [
        # A SECOND leading newline is not protocol framing: it survives, and
        # the parser fails closed on it.
        ('\n\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\n', None),
        # An interior CR survives framing removal and fails closed.
        ('alice:x:1000:1000:Alice:/home/alice:/bin/ba\rsh\n', None),
        # A surplus trailing newline beyond the record terminator survives.
        ('alice:x:1000:1000:Alice:/home/alice:/bin/bash\n\n', None),
        # A bare trailing CR is not protocol framing: it survives and fails.
        ('alice:x:1000:1000:Alice:/home/alice:/bin/bash\r', None),
        # A second line (hostile injection) survives framing removal and the
        # parser rejects the whole answer — never trimmed to line one.
        ('alice:x:1000:1000:Alice:/home/alice:/bin/bash\n'
         'mallory:x:666:666::/tmp:/bin/bash\n', None),
        # Clean segment: framing removed, parser validates.
        ('alice:x:1000:1000:Alice:/home/alice:/bin/bash\n', '/bin/bash'),
    ],
)
def test_split_keeps_every_non_protocol_newline_so_the_parser_fails_closed(
        segment, expected):
    """Only the protocol-owned framing is removed; any other CR/LF reaches
    the parser and is rejected there."""
    s1 = ssh_manager.TMUX_PROBE_SENTINEL
    s2 = ssh_manager.TMUX_PROBE_SHELL_SENTINEL
    raw = f'C.utf8\n{s1}\n{segment}{s2}\ntmux 3.4\n'.encode()
    _, parsed, _ = ssh_manager.split_tmux_probe_output(raw)
    assert ssh_manager.parse_login_shell_from_getent(parsed) == expected


@pytest.mark.parametrize('entry', [
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash\nhostile',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash\n'
    'mallory:x:666:666::/tmp:/bin/bash',
    '\n\nalice:x:1000:1000:Alice:/home/alice:/bin/bash',
])
def test_parse_login_shell_fails_closed_on_any_multiline_answer(entry):
    """A multi-line answer is never trimmed to its first line: that would
    silently accept a blob a hostile answer could shape."""
    assert ssh_manager.parse_login_shell_from_getent(entry) is None


def test_discovery_launches_the_execd_shell_for_non_tmux(monkeypatch):
    """End to end through the production connect path: the discovered shell
    reaches the exec'd command line for BOTH ordinary SSH and the tailscale
    auth strategy — the surface where the env-request shape was stripped."""
    for kwargs in ({'password': 'secret'}, {'auth_type': 'tailscale'}):
        clients = install_ssh_clients(
            monkeypatch, locale_listing=b'C.utf8\n',
            login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/zsh')
        session_id, error = connect_target(use_tmux=False, **kwargs)
        assert error is None
        _, shell_channel = clients[0].transport.session_channels
        assert shell_channel.calls == ['get_pty', 'exec_command']
        assert shell_channel.command == ssh_manager.build_login_shell_command(
            'C.utf8', '/bin/zsh')
        assert ssh_manager.sessions[session_id]['login_shell'] == '/bin/zsh'
        ssh_manager.close_session(session_id)


def test_discovery_keeps_invoke_shell_when_the_shell_is_unproven(monkeypatch):
    """A host whose account shell is fish keeps the shipped shape exactly:
    env request + invoke_shell. Discovery degrades, never misfires."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/usr/bin/fish')
    session_id, error = connect_target(password='secret', use_tmux=False)
    assert error is None
    _, shell_channel = clients[0].transport.session_channels
    assert shell_channel.calls == [
        'update_environment', 'get_pty', 'invoke_shell']
    assert shell_channel.environment == {
        'LANG': 'C.utf8', 'LC_CTYPE': 'C.utf8'}
    assert ssh_manager.sessions[session_id]['login_shell'] is None
    ssh_manager.close_session(session_id)


def test_discovery_keeps_invoke_shell_when_getent_answers_nothing(monkeypatch):
    """A host with no getent answer contributes an empty segment: no
    discovery, the shipped launch, and a None login_shell on the record."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', login_shell_getent='')
    session_id, error = connect_target(password='secret', use_tmux=False)
    assert error is None
    _, shell_channel = clients[0].transport.session_channels
    assert shell_channel.calls == [
        'update_environment', 'get_pty', 'invoke_shell']
    assert shell_channel.shell_invoked is True
    assert ssh_manager.sessions[session_id]['login_shell'] is None
    ssh_manager.close_session(session_id)


def test_the_tmux_launch_never_consumes_the_discovered_shell(monkeypatch):
    """tmux owns the launch: the discovered shell must not leak into the tmux
    branch (its `-e` locale contract is the one that applies there), even
    though the SAME probe round trip answers it."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/bash')
    session_id, error = connect_target(password='secret', use_tmux=True)
    assert error is None
    tmux_channel = tmux_channel_of(clients[0])
    assert 'new-session' in tmux_channel.command
    assert '/bin/bash' not in tmux_channel.command
    assert '-e LANG=C.utf8' in tmux_channel.command
    ssh_manager.close_session(session_id)


def test_a_successful_tmux_connection_persists_the_discovered_shell(monkeypatch):
    """The persistence contract: a SUCCESSFUL tmux connection caches the
    validated discovered shell on the record even though the tmux launch does
    not consume it — so any later plain-shell launch of this logical session
    (a reconnect whose host lost tmux, a restored candidate) reuses the
    validated value instead of discovering again."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/bash')
    session_id, error = connect_target(password='secret', use_tmux=True)
    assert error is None
    session = ssh_manager.sessions[session_id]
    assert session['use_tmux'] is True
    assert session['tmux_session_name']
    # Both surfaces a reconnect reads carry the validated shell.
    assert session['login_shell'] == '/bin/bash'
    assert ssh_manager.get_session(session_id)['login_shell'] == '/bin/bash'
    # Exactly one probe round trip: persistence did not add a second exec.
    probe_commands = [c.command for c in clients[0].transport.session_channels
                      if c.command == ssh_manager.TMUX_PROBE_COMMAND]
    assert len(probe_commands) == 1
    ssh_manager.close_session(session_id)


def test_discovery_applies_to_the_tmux_unavailable_fallback(monkeypatch):
    """A host genuinely WITHOUT tmux — the probe's `tmux -V` exits NON-ZERO
    (127 = command not found), which is the signal probe_target_capabilities
    reads; an empty banner with exit status 0 would NOT be an unavailable
    probe — falls back to a plain shell, and that shell gets the discovered
    launch: the fallback IS the non-tmux launch. Nothing tmux is created or
    attached."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n', tmux_banner=b'',
        probe_exit_status=127,
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/bash')
    session_id, error = connect_target(password='secret', use_tmux=True)
    assert error is None
    session = ssh_manager.sessions[session_id]
    # The probe said "no tmux": no new-session command was issued anywhere,
    # and the session record says so too.
    assert not any(c.command and 'new-session' in c.command
                   for c in clients[0].transport.session_channels)
    assert session['use_tmux'] is False
    assert session['tmux_session_name'] is None
    # The shell channel took the discovered exec'd launch.
    shell_channels = [c for c in clients[0].transport.session_channels
                      if c.calls and c.calls != ['exec_command']]
    assert len(shell_channels) == 1
    assert shell_channels[0].calls == ['get_pty', 'exec_command']
    assert shell_channels[0].command == ssh_manager.build_login_shell_command(
        'C.utf8', '/bin/bash')
    assert session['login_shell'] == '/bin/bash'
    ssh_manager.close_session(session_id)


def test_discovery_runs_once_per_connect_and_not_per_channel(monkeypatch):
    """The performance contract: discovery rides inside the ONE existing
    probe round trip. One connect opens exactly one channel carrying the
    probe command — a second discovery exec would appear as a second."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/bash')
    session_id, error = connect_target(password='secret', use_tmux=False)
    assert error is None
    probe_commands = [c.command for c in clients[0].transport.session_channels
                      if c.command == ssh_manager.TMUX_PROBE_COMMAND]
    assert probe_commands == [ssh_manager.TMUX_PROBE_COMMAND]
    ssh_manager.close_session(session_id)


def test_cached_caller_shell_wins_over_the_discovery_result(monkeypatch):
    """A caller-supplied validated shell (the reconnect/restore/cache path)
    WINS over what the host's discovery answers: the cached value is reused
    verbatim, and the probe's different answer is NOT substituted in. The
    capability probe itself still runs exactly once — caching skips the
    substitution, not the round trip it rides in."""
    clients = install_ssh_clients(
        monkeypatch, locale_listing=b'C.utf8\n',
        login_shell_getent='alice:x:1000:1000:Alice:/home/alice:/bin/zsh')
    session_id, error = connect_target(
        password='secret', use_tmux=False, login_shell='/bin/bash')
    assert error is None
    _, shell_channel = clients[0].transport.session_channels
    assert shell_channel.command == ssh_manager.build_login_shell_command(
        'C.utf8', '/bin/bash')
    assert ssh_manager.sessions[session_id]['login_shell'] == '/bin/bash'
    probe_commands = [c.command for c in clients[0].transport.session_channels
                      if c.command == ssh_manager.TMUX_PROBE_COMMAND]
    assert len(probe_commands) == 1
    ssh_manager.close_session(session_id)
