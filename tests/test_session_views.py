"""VIEWS: one tmux client per browser socket.

A tmux session holds no session-level PTY. It is created detached, and every
browser socket that DISPLAYS it opens its own exec channel, asks for its own
PTY at its own size, and runs `tmux attach-session`. tmux then draws each
client clipped to that client's own size and follows the smallest attached one
(`window-size smallest`), which is what lets two devices show one session at
two sizes -- and what makes DETACHING, not a "hidden" declaration, the way a
device gives its size back.

What this suite pins, all of it against the real ssh_manager with a fake
transport:

  * the registry: a view per sid, its own channel, size and generation;
  * ROUTING: a view's bytes reach ONE socket (`to=sid`), never the room;
  * input: this socket's own view, then any view, then `send-keys` when there
    is no view at all;
  * a repeat attach for the same socket RESIZES instead of attaching twice
    (a second client would be counted by `window-size smallest` until its
    channel happened to die);
  * the options are set BEFORE the attach, because a retained session can
    still carry `window-size manual` from the design this replaced;
  * disconnect closes only the leaving socket's views;
  * the per-session cap, and that views are NOT counted against MAX_SESSIONS;
  * a transport swap re-opens the views it had;
  * a view's own death closes only that view, while a dead transport is the
    SESSION's death and is reported once;
  * GEOMETRY: every PTY is held at the minimum over the views' true fits, the
    minimum is announced to every view BEFORE any PTY changes, and it grows
    back the moment the smallest view leaves;
  * a detach names the view's tmux client by tty (`detach-client`) before
    closing its channel, because the channel close alone takes 4.5s to
    release the client over Tailscale SSH.
"""
import time

import pytest

from app import ssh_manager


@pytest.fixture(autouse=True)
def _clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    # The retired-socket ring is module state too: a sid retired by one test
    # must not refuse an attach under the same name in the next.
    ssh_manager._retired_sockets.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    ssh_manager._retired_sockets.clear()


class FakeViewChannel:
    """One tmux client's channel: records the PTY, the command and the writes."""

    def __init__(self, reads=None):
        self.pty = None
        self.command = None
        self.sent = []
        self.sizes = []
        self.closed = False
        self.timeout = None
        self.socketio = None
        self.frames_before_resize = []
        self._reads = list(reads or [])

    def get_pty(self, term, width, height):
        self.pty = (term, width, height)

    def exec_command(self, command):
        self.command = command

    def settimeout(self, timeout):
        self.timeout = timeout

    def resize_pty(self, width, height):
        self.sizes.append((width, height))
        if self.socketio is not None:
            self.frames_before_resize.append(len(self.socketio.emits))

    def send(self, data):
        payload = data.encode('utf-8') if isinstance(data, str) else data
        self.sent.append(payload)
        return len(payload)

    def recv(self, _size):
        return self._reads.pop(0) if self._reads else b''

    def close(self):
        self.closed = True

    @property
    def exit_status_ready(self):
        return lambda: False


class FakeTransport:
    def __init__(self, active=True, socketio=None):
        self.active = active
        self.channels = []
        self.open_timeouts = []
        self.socketio = socketio

    def open_session(self, timeout=None):
        self.open_timeouts.append(timeout)
        channel = FakeViewChannel()
        channel.socketio = self.socketio
        self.channels.append(channel)
        return channel

    def is_active(self):
        return self.active


class FakeClient:
    def __init__(self, transport):
        self.transport = transport

    def get_transport(self):
        return self.transport

    def close(self):
        pass


class FakeSocketIO:
    """Records emits with their room, which is the routing property under test.

    `gone` is the set of sids the fake socket.io server no longer counts as
    connected, answered through the same `server.manager.is_connected` that
    python-socketio exposes.
    """

    def __init__(self):
        self.emits = []
        self.gone = set()
        manager = type('Manager', (), {})()
        manager.is_connected = lambda sid, namespace: sid not in self.gone
        self.server = type('Server', (), {})()
        self.server.manager = manager

    def emit(self, event, payload=None, **kwargs):
        self.emits.append((event, payload, kwargs))

    def to(self, sid):
        return sid


def install_session(session_id='sess-views', use_tmux=True, connected=True,
                    transport=None):
    transport = transport or FakeTransport()
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': FakeClient(transport),
            'channel': None,
            'host': 'views.example',
            'port': 22,
            'username': 'deploy',
            'user_id': 1,
            'connected': connected,
            'last_activity': time.time(),
            'bastion_client': None,
            'proxy_jump_host': None,
            'auth_type': 'key',
            'use_tmux': use_tmux,
            'tmux_session_name': 'sshdeck_views' if use_tmux else None,
            'display_name': 'Views box',
            'views': {},
            'transport_generation': 3,
            'output_buffer': [],
            'output_buffer_size': 0,
            'output_buffer_max': 512000,
        }
    return transport


def views_of(session_id='sess-views'):
    with ssh_manager.sessions_lock:
        return dict(ssh_manager.sessions[session_id].get('views') or {})


@pytest.fixture
def quiet_threads(monkeypatch):
    """Register the reader without running it; the reader has its own tests."""
    started = []

    class NoRunThread:
        def __init__(self, target=None, args=(), daemon=None):
            self.target = target
            self.args = args
            self.daemon = daemon

        def start(self):
            started.append(self.args)

    monkeypatch.setattr(ssh_manager, 'Thread', NoRunThread)
    return started


@pytest.fixture
def no_tmux_commands(monkeypatch):
    """Record the tmux control commands instead of running them.

    The tty discovery is stubbed to "unreadable" here; it has its own tests
    below, which drive `_list_client_ttys` with an explicit sequence.
    """
    calls = []
    monkeypatch.setattr(
        ssh_manager, '_run_tmux_control_command',
        lambda session_id, subcommand, extra_args=None, **kw:
            calls.append((session_id, subcommand, list(extra_args or []),
                          kw.get('target_override')))
            or (True, None))
    monkeypatch.setattr(ssh_manager, '_list_client_ttys', lambda _sid: None)
    monkeypatch.setattr(ssh_manager, '_VIEW_TTY_DISCOVERY_S', 0.0)
    return calls


def test_a_view_is_its_own_tmux_client_at_its_own_size(
        quiet_threads, no_tmux_commands):
    transport = install_session()

    ok, error = ssh_manager.open_session_view(
        'sess-views', 'sid-A', 100, 30, FakeSocketIO(), object())

    assert (ok, error) == (True, None)
    channel = transport.channels[0]
    # A real terminal: tmux sends it the mouse DECSETs and draws it clipped to
    # this size, which is the entire mechanism.
    assert channel.pty == ('xterm-256color', 100, 30)
    # shlex.quote adds no quotes for a name made only of the characters the
    # server whitelist allows, and would add them for anything else.
    assert channel.command == 'tmux -u attach-session -t =sshdeck_views'
    # The open is bounded: an unbounded open_session on a half-open TCP would
    # block the eventlet worker forever.
    assert transport.open_timeouts == [10.0]

    view = views_of()['sid-A']
    assert (view['cols'], view['rows']) == (100, 30)
    # The generation is captured so a reader can tell a swap happened.
    assert view['transport_generation'] == 3


def test_the_tmux_options_are_set_before_the_attach(quiet_threads,
                                                    monkeypatch):
    """A retained session can still carry `window-size manual`.

    Measured on the deploy host: two sessions kept from the previous design
    were at `window-size manual` 128x86 and 90x78, set by the window-locking
    code this rewrite deletes. A client attaching under `manual` is drawn at
    the locked size, so the options have to land first or the first paint of a
    retained session arrives at a foreign geometry.
    """
    order = []
    transport = install_session()

    def record_command(session_id, subcommand, extra_args=None, **_kw):
        order.append(('option', subcommand, list(extra_args or [])))
        return True, None

    original_open = transport.open_session

    def record_open(timeout=None):
        order.append(('attach', None, None))
        return original_open(timeout=timeout)

    # The tty discovery brackets the attach: the clients before, the clients
    # after, and the one that appeared is this view's.
    ttys = iter([set(), {'/dev/pts/7'}])

    def record_discovery(_session_id):
        order.append(('discover', None, None))
        return next(ttys)

    transport.open_session = record_open
    monkeypatch.setattr(ssh_manager, '_run_tmux_control_command',
                        record_command)
    monkeypatch.setattr(ssh_manager, '_list_client_ttys', record_discovery)

    ok, _error = ssh_manager.open_session_view(
        'sess-views', 'sid-A', 80, 24, FakeSocketIO(), object())

    assert ok is True
    kinds = [kind for kind, _sub, _args in order]
    assert kinds.count('attach') == 1
    assert kinds[-3:] == ['discover', 'attach', 'discover'], order
    assert ['window-size', 'smallest'] in [
        args[-2:] for kind, _sub, args in order if kind == 'option']
    assert views_of()['sid-A']['tty'] == '/dev/pts/7'


def test_a_second_attach_from_the_same_socket_resizes_instead(
        quiet_threads, no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()

    ssh_manager.open_session_view('sess-views', 'sid-A', 80, 24, socketio,
                                  object())
    ok, error = ssh_manager.open_session_view('sess-views', 'sid-A', 120, 40,
                                              socketio, object())

    assert (ok, error) == (True, None)
    # ONE channel, resized. A second attach would leave the first client
    # counted by `window-size smallest` until its channel happened to die.
    assert len(transport.channels) == 1
    assert transport.channels[0].sizes == [(120, 40)]
    assert views_of()['sid-A']['rows'] == 40


def test_two_sockets_get_two_clients(quiet_threads, no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()

    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    assert len(transport.channels) == 2
    assert transport.channels[0].pty == ('xterm-256color', 51, 48)
    # The second client's PTY opens at the MINIMUM over both fits, and the
    # first is brought to it: tmux would otherwise draw the smaller window in
    # the larger client's top-left corner (see _apply_session_geometry).
    assert transport.channels[1].pty == ('xterm-256color', 51, 47)
    assert transport.channels[0].sizes == [(51, 47)]
    assert sorted(views_of()) == ['desktop', 'phone']
    assert ssh_manager.session_view_count('sess-views') == 2
    # The true fits are kept as reported, not as applied.
    assert (views_of()['desktop']['cols'], views_of()['desktop']['rows']) == (
        165, 47)
    assert views_of()['desktop']['pty'] == (51, 47)


def test_a_view_size_is_rejected_or_clamped_not_trusted(quiet_threads,
                                                        no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()

    ok, error = ssh_manager.open_session_view(
        'sess-views', 'sid-A', 'wide', 30, socketio, object())
    assert (ok, error) == (False, "Invalid view size")
    assert transport.channels == []

    ssh_manager.open_session_view('sess-views', 'sid-B', 99999, -5, socketio,
                                  object())
    assert transport.channels[0].pty == ('xterm-256color', 1000, 1)


def test_the_per_session_view_cap_is_enforced(quiet_threads, no_tmux_commands,
                                              monkeypatch):
    monkeypatch.setattr(ssh_manager.config, 'MAX_VIEWS_PER_SESSION', 2)
    transport = install_session()
    socketio = FakeSocketIO()

    ssh_manager.open_session_view('sess-views', 'a', 80, 24, socketio, object())
    ssh_manager.open_session_view('sess-views', 'b', 80, 24, socketio, object())
    ok, error = ssh_manager.open_session_view('sess-views', 'c', 80, 24,
                                              socketio, object())

    assert (ok, error) == (False, "Too many open views for this session")
    assert len(transport.channels) == 2


def test_views_are_not_counted_against_the_session_limits(
        quiet_threads, no_tmux_commands, monkeypatch):
    """A device joining is not a new session.

    MAX_SESSIONS bounds SSH connections; a view is a second tmux client on one
    existing connection. Counting views there would stop a user opening their
    own session on a second device.
    """
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS', 1)
    monkeypatch.setattr(ssh_manager.config, 'MAX_SESSIONS_PER_USER', 1)
    install_session()
    socketio = FakeSocketIO()

    for sid in ('a', 'b', 'c', 'd'):
        ok, error = ssh_manager.open_session_view('sess-views', sid, 80, 24,
                                                  socketio, object())
        assert (ok, error) == (True, None), sid
    assert ssh_manager.session_view_count('sess-views') == 4
    with ssh_manager.sessions_lock:
        assert len(ssh_manager.sessions) == 1


def test_closing_a_view_closes_its_channel_and_nothing_else(
        quiet_threads, no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    assert ssh_manager.close_session_view('sess-views', 'phone') is True

    # The detach IS the channel close: tmux drops that client and
    # `window-size smallest` stops counting its size.
    assert transport.channels[0].closed is True
    assert transport.channels[1].closed is False
    assert list(views_of()) == ['desktop']
    # The session is untouched -- a session with no views is still alive.
    with ssh_manager.sessions_lock:
        assert ssh_manager.sessions['sess-views']['connected'] is True
    assert ssh_manager.close_session_view('sess-views', 'phone') is False


def test_a_socket_leaving_closes_only_its_own_views(quiet_threads,
                                                    no_tmux_commands):
    first = install_session('sess-1')
    second = install_session('sess-2')
    socketio = FakeSocketIO()
    for session_id in ('sess-1', 'sess-2'):
        ssh_manager.open_session_view(session_id, 'leaving', 80, 24, socketio,
                                      object())
        ssh_manager.open_session_view(session_id, 'staying', 90, 25, socketio,
                                      object())

    closed = ssh_manager.close_views_for_socket('leaving')

    assert sorted(closed) == ['sess-1', 'sess-2']
    assert list(views_of('sess-1')) == ['staying']
    assert list(views_of('sess-2')) == ['staying']
    assert [c.closed for c in first.channels] == [True, False]
    assert [c.closed for c in second.channels] == [True, False]


def geometry_frames(socketio):
    return [(payload['cols'], payload['rows'], kwargs.get('to'))
            for event, payload, kwargs in socketio.emits
            if event == 'tmux_window_geometry']


def test_a_resize_moves_the_shared_minimum(quiet_threads, no_tmux_commands):
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())
    phone, desktop = transport.channels

    ok, error = ssh_manager.resize_session_view('sess-views', 'phone', 60, 50,
                                                socketio_instance=socketio)

    assert (ok, error) == (True, None)
    # The smallest view grew, so every client grows with it -- to the new
    # minimum, not to the phone's own size.
    assert phone.sizes == [(51, 47), (60, 47)]
    assert desktop.sizes == [(60, 47)]
    assert views_of()['phone']['cols'] == 60
    assert geometry_frames(socketio)[-2:] == [(60, 47, 'phone'),
                                              (60, 47, 'desktop')]
    # A socket with no view has nothing to resize, and that is not the
    # session's problem.
    assert ssh_manager.resize_session_view('sess-views', 'nobody', 80, 24) == (
        False, "No view for this socket")


def test_a_resize_above_the_minimum_changes_nothing_on_the_wire(
        quiet_threads, no_tmux_commands):
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    ssh_manager.resize_session_view('sess-views', 'desktop', 200, 47,
                                    socketio_instance=socketio)

    assert transport.channels[1].sizes == []
    assert views_of()['desktop']['cols'] == 200
    # The minimum is unchanged: re-announced, nothing resized.
    assert geometry_frames(socketio)[-2:] == [(51, 47, 'phone'),
                                              (51, 47, 'desktop')]


def test_the_geometry_is_announced_before_any_pty_changes(quiet_threads,
                                                          no_tmux_commands):
    """A resize makes tmux repaint every client at the new size on that
    client's own channel; the announcement must already be ahead of that
    repaint on every socket, or a grown PTY paints a wide screen into an
    engine that is still narrow."""
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())
    phone = transport.channels[0]

    # The phone's PTY was resized once, and the frame that told the phone its
    # new size was already on the phone's socket when it happened.
    #
    #: this used to compare against the TOTAL number of emits,
    # which held only while every announcement of an attach happened after the
    # channel was opened. The attached clients are now brought down to the new
    # minimum BEFORE the new channel is opened (see open_session_view), so the
    # re-announcement that follows the attach lands after this resize. The
    # contract under test -- no PTY moves before the socket has been told --
    # is unchanged, and is what the slice below states directly.
    assert phone.sizes == [(51, 47)]
    announced_first = geometry_frames(socketio)[:phone.frames_before_resize[0]]
    assert (51, 47, 'phone') in announced_first
    assert geometry_frames(socketio)[-2:] == [(51, 47, 'phone'),
                                              (51, 47, 'desktop')]


def test_a_dead_view_does_not_hold_a_slot(quiet_threads, no_tmux_commands,
                                          monkeypatch):
    """A socket that died without a clean disconnect leaves its view behind.

    Enough of those refuse the owner's own re-attach -- "báo không thể gắn
    phiên, phải tải lại trang". A channel that is closed, or that
    has an exit status ready, belongs to nobody and is dropped before anyone
    is refused. A channel that cannot prove it is dead is left alone.
    """
    monkeypatch.setattr(ssh_manager.config, 'MAX_VIEWS_PER_SESSION', 2)
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'one', 80, 24, socketio, object())
    ssh_manager.open_session_view('sess-views', 'two', 80, 24, socketio, object())

    ok, error = ssh_manager.open_session_view('sess-views', 'three', 80, 24,
                                              socketio, object())
    assert (ok, error) == (False, "Too many open views for this session")

    # The first socket's channel dies the way a lost tab's does.
    transport.channels[0].closed = True
    ok, error = ssh_manager.open_session_view('sess-views', 'three', 80, 24,
                                              socketio, object())
    assert (ok, error) == (True, None)
    assert sorted(views_of()) == ['three', 'two']


def test_a_dead_view_is_dropped_on_every_attach(quiet_threads, no_tmux_commands):
    """Not only when the cap is reached.

    A dead view is still a tmux CLIENT: it counts in `window-size smallest`,
    so the device that just arrived can be drawn at a size nobody is looking
    at. A page reload leaves one behind whenever the old socket's disconnect
    arrives after the new socket has attached.
    """
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'old-tab', 51, 20, socketio,
                                  object())
    transport.channels[0].closed = True

    ssh_manager.open_session_view('sess-views', 'new-tab', 165, 47, socketio,
                                  object())

    assert sorted(views_of()) == ['new-tab']
    # The geometry that follows is the survivor's own size, not a minimum
    # taken with a client nobody can see.
    assert geometry_frames(socketio)[-1] == (165, 47, 'new-tab')


def test_an_attach_that_finishes_after_its_socket_left_is_refused(
        quiet_threads, no_tmux_commands, monkeypatch):
    """The orphan of, as measured on the deploy host.

    A phone's socket lived 0.7s: it disconnected at 06:59:28.94, so
    handle_disconnect found no view to close; its attach then finished at
    06:59:29.68 and registered a 59x43 view whose tmux client (/dev/pts/5)
    held the desktop's window at 59 columns for an hour. The disconnect lands
    here in the middle of the attach's tty discovery -- the network I/O the
    lock is released for -- and the attach must then refuse to register and
    release the client it just named.
    """
    transport = install_session()
    socketio = FakeSocketIO()
    polls = iter([set(), {'/dev/pts/5'}])

    def discover(_sid):
        ttys = next(polls)
        if ttys:
            # The socket goes away while the client is being named.
            ssh_manager.close_views_for_socket('flap', socketio_instance=socketio)
        return ttys
    monkeypatch.setattr(ssh_manager, '_list_client_ttys', discover)

    ok, error = ssh_manager.open_session_view('sess-views', 'flap', 59, 43,
                                              socketio, object())

    assert (ok, error) == (False, "Socket gone")
    assert views_of() == {}
    assert transport.channels[0].closed is True
    assert ('sess-views', 'detach-client', [], '/dev/pts/5') in no_tmux_commands
    assert quiet_threads == []


def test_a_retired_socket_is_refused_even_while_the_server_still_lists_it(
        quiet_threads, no_tmux_commands):
    """python-socketio runs the disconnect handler BEFORE it drops the sid, so
    for the length of that handler `is_connected` still says yes. The ring
    close_views_for_socket writes is what answers for that window."""
    install_session()
    socketio = FakeSocketIO()          # nothing in `gone`: the server says yes
    ssh_manager.close_views_for_socket('early', socketio_instance=socketio)

    ok, error = ssh_manager.open_session_view('sess-views', 'early', 80, 24,
                                              socketio, object())

    assert (ok, error) == (False, "Socket gone")
    assert views_of() == {}


def test_a_view_whose_socket_is_gone_is_released_on_the_next_geometry_pass(
        quiet_threads, no_tmux_commands, monkeypatch):
    """A view that slipped through anyway -- any future race -- is not kept:
    the next size change releases its client by tty and hands its size back."""
    ttys = iter([set(), {'/dev/pts/5'}, set(), {'/dev/pts/6'}])
    monkeypatch.setattr(ssh_manager, '_list_client_ttys',
                        lambda _sid: next(ttys))
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'phone', 59, 43, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 109, 59, socketio,
                                  object())
    assert transport.channels[1].pty == ('xterm-256color', 59, 43)
    del no_tmux_commands[:]

    socketio.gone.add('phone')
    ok, _ = ssh_manager.resize_session_view('sess-views', 'desktop', 109, 59,
                                            socketio_instance=socketio)

    assert ok is True
    assert list(views_of()) == ['desktop']
    assert transport.channels[0].closed is True
    assert no_tmux_commands[0] == ('sess-views', 'detach-client', [],
                                   '/dev/pts/5')
    assert transport.channels[1].sizes[-1] == (109, 59)
    assert geometry_frames(socketio)[-1] == (109, 59, 'desktop')


def test_a_socket_dead_view_is_released_when_another_socket_attaches(
        quiet_threads, no_tmux_commands):
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'orphan', 59, 43, socketio,
                                  object())
    socketio.gone.add('orphan')

    ssh_manager.open_session_view('sess-views', 'desktop', 109, 59, socketio,
                                  object())

    assert list(views_of()) == ['desktop']
    assert transport.channels[0].closed is True
    assert geometry_frames(socketio)[-1] == (109, 59, 'desktop')


def test_attached_clients_shrink_before_the_new_one_attaches(quiet_threads,
                                                            no_tmux_commands):
    """The attached clients reach the new minimum BEFORE the smaller client's
    channel is opened.

    Measured on tmux 3.7c: with a 165x47 client already attached,
    a 49x47 client attaching sends the big client a FULL repaint of 23078
    bytes, 10580 of them the `·` filler tmux draws around a window smaller
    than the client, and the real frame follows only when this module shrinks
    that client. Shrinking first costs 992 bytes and no filler at all -- one
    frame instead of two, and no flash.
    """
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())
    desktop = transport.channels[0]
    assert desktop.sizes == []

    opened_before = len(transport.channels)
    order = []
    original_open = transport.open_session

    def watched_open(timeout=None):
        order.append(('open', tuple(desktop.sizes)))
        return original_open(timeout=timeout)

    transport.open_session = watched_open
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())

    assert len(transport.channels) == opened_before + 1
    # The desktop was already at the new minimum when the phone's channel was
    # opened -- the whole point.
    assert order == [('open', ((51, 47),))]
    assert desktop.sizes == [(51, 47)]
    # And the phone's own PTY is opened at that size, never resized after.
    assert transport.channels[1].pty == ('xterm-256color', 51, 47)
    assert transport.channels[1].sizes == []


def test_closing_the_smallest_view_hands_its_size_back(quiet_threads,
                                                       no_tmux_commands):
    socketio = FakeSocketIO()
    transport = install_session(transport=FakeTransport(socketio=socketio))
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    ssh_manager.close_session_view('sess-views', 'phone',
                                   socketio_instance=socketio)

    assert transport.channels[1].sizes == [(165, 47)]
    assert geometry_frames(socketio)[-1] == (165, 47, 'desktop')


def test_a_detach_names_the_clients_tty_before_closing_the_channel(
        quiet_threads, no_tmux_commands, monkeypatch):
    """Measured from the container against the Tailscale SSH server: the
    channel close releases the tmux client after 4573ms, `detach-client -t
    <tty>` after 51ms. The tty is what the detach names."""
    ttys = iter([set(), {'/dev/pts/3'}])
    monkeypatch.setattr(ssh_manager, '_list_client_ttys',
                        lambda _sid: next(ttys))
    transport = install_session()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48,
                                  FakeSocketIO(), object())
    assert views_of()['phone']['tty'] == '/dev/pts/3'
    del no_tmux_commands[:]

    assert ssh_manager.close_session_view('sess-views', 'phone') is True

    assert no_tmux_commands == [('sess-views', 'detach-client', [],
                                 '/dev/pts/3')]
    assert transport.channels[0].closed is True


def test_an_ambiguous_tty_discovery_records_none(quiet_threads,
                                                 no_tmux_commands,
                                                 monkeypatch):
    """Two clients appearing in the same window cannot be told apart, and a
    wrong tty would detach ANOTHER device; the detach then falls back to the
    channel close."""
    ttys = iter([{'/dev/pts/1'}, {'/dev/pts/1', '/dev/pts/2', '/dev/pts/3'}])
    monkeypatch.setattr(ssh_manager, '_list_client_ttys',
                        lambda _sid: next(ttys))
    transport = install_session()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48,
                                  FakeSocketIO(), object())
    assert views_of()['phone']['tty'] is None
    del no_tmux_commands[:]

    ssh_manager.close_session_view('sess-views', 'phone')

    assert no_tmux_commands == []
    assert transport.channels[0].closed is True


def test_output_goes_to_one_socket_not_to_the_room(monkeypatch,
                                                   no_tmux_commands):
    """THE ROUTING PROPERTY. Each view's bytes are that socket's own.

    The old design read ONE channel and fanned it to the whole user room, which
    is why every device had to share one grid. A view's reader emits with
    `to=<sid>`; an emit without it would put one device's clipped paint on
    another device's screen.
    """
    install_session()
    socketio = FakeSocketIO()
    channel = FakeViewChannel(reads=[b'PAINT-FOR-ONE\r\n', b''])
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-views']['views']['sid-A'] = {
            'channel': channel, 'cols': 80, 'rows': 24, 'thread': None,
            'transport_generation': 3, 'opened_at': time.time(),
        }

    ssh_manager.read_view_output('sess-views', 'sid-A', channel, 3, socketio,
                                 None)

    outputs = [(p, k) for e, p, k in socketio.emits if e == 'ssh_output']
    assert len(outputs) == 1
    payload, kwargs = outputs[0]
    assert payload == {'session_id': 'sess-views', 'data': 'PAINT-FOR-ONE\r\n'}
    assert kwargs == {'to': 'sid-A'}
    for _event, _payload, kwargs in socketio.emits:
        assert 'room' not in kwargs


def test_a_device_attributes_answer_is_never_replayed(monkeypatch,
                                                      no_tmux_commands):
    """xterm answers ESC[c as if the host had asked; a replay would type it."""
    install_session()
    socketio = FakeSocketIO()
    channel = FakeViewChannel(reads=[b'ok\x1b[?62;c done', b''])
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-views']['views']['sid-A'] = {
            'channel': channel, 'cols': 80, 'rows': 24, 'thread': None,
            'transport_generation': 3, 'opened_at': time.time(),
        }

    ssh_manager.read_view_output('sess-views', 'sid-A', channel, 3, socketio,
                                 None)

    data = [p['data'] for e, p, _k in socketio.emits if e == 'ssh_output']
    assert data == ['ok done']


def test_a_views_own_death_closes_that_view_and_tells_that_socket(
        monkeypatch, no_tmux_commands):
    install_session()
    socketio = FakeSocketIO()
    channel = FakeViewChannel(reads=[b''])
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-views']['views']['sid-A'] = {
            'channel': channel, 'cols': 80, 'rows': 24, 'thread': None,
            'transport_generation': 3, 'opened_at': time.time(),
        }

    ssh_manager.read_view_output('sess-views', 'sid-A', channel, 3, socketio,
                                 None)

    # The transport is alive, so the SESSION is alive: only the view closed.
    closed = [(p, k) for e, p, k in socketio.emits if e == 'view_closed']
    assert len(closed) == 1
    assert closed[0][0]['session_id'] == 'sess-views'
    assert closed[0][1] == {'to': 'sid-A'}
    assert views_of() == {}
    assert not any(e == 'ssh_disconnected' for e, _p, _k in socketio.emits)
    with ssh_manager.sessions_lock:
        assert ssh_manager.sessions['sess-views']['connected'] is True


def test_a_dead_transport_is_the_sessions_death_reported_once(
        monkeypatch, no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()
    channels = [FakeViewChannel(reads=[b'']), FakeViewChannel(reads=[b''])]
    with ssh_manager.sessions_lock:
        for sid, channel in zip(('sid-A', 'sid-B'), channels):
            ssh_manager.sessions['sess-views']['views'][sid] = {
                'channel': channel, 'cols': 80, 'rows': 24, 'thread': None,
                'transport_generation': 3, 'opened_at': time.time(),
            }
    transport.active = False
    claims = []

    def fake_claim(session_id, transport_generation, channel):
        # The real one pops the registry entry inside the lock so exactly one
        # reader may declare the death; the second gets SUPERSEDED/GONE.
        claims.append((session_id, transport_generation))
        if len(claims) == 1:
            return ssh_manager.READER_RETIRE_CURRENT, (None, None, None)
        return ssh_manager.READER_RETIRE_GONE, None

    monkeypatch.setattr(ssh_manager, 'claim_reader_death', fake_claim)
    monkeypatch.setattr(ssh_manager, '_close_retired_parts',
                        lambda *_a, **_k: None)

    # The death path takes an app context to mark the DB row; a context manager
    # that does nothing is enough here, because the DB row is the session
    # lifecycle's own contract and has its own tests.
    class FakeApp:
        def app_context(self):
            class Ctx:
                def __enter__(self_inner):
                    return None

                def __exit__(self_inner, *_exc):
                    return False
            return Ctx()

    for sid, channel in zip(('sid-A', 'sid-B'), channels):
        ssh_manager.read_view_output('sess-views', sid, channel, 3, socketio,
                                     FakeApp())

    # A dead transport is the session's death, not a view's, so no view_closed
    # invites a re-attach onto a transport that is gone.
    assert not any(e == 'view_closed' for e, _p, _k in socketio.emits)
    # And both readers went through the ONE ownership claim, so the death can
    # be reported once however many devices were watching.
    assert len(claims) == 2


def test_input_prefers_this_sockets_own_view(quiet_threads, no_tmux_commands):
    transport = install_session()
    socketio = FakeSocketIO()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    ok, error = ssh_manager.send_ssh_input('sess-views', 'ls\r',
                                           socket_sid='desktop')

    assert (ok, error) == (True, None)
    # The bytes reach the pane as keystrokes from a real terminal, on the
    # writer's OWN client -- no send-keys hex, which is where Vietnamese broke.
    assert transport.channels[1].sent == [b'ls\r']
    assert transport.channels[0].sent == []


def test_input_from_a_socket_with_no_view_uses_any_view(quiet_threads,
                                                        no_tmux_commands):
    """Broadcast writes to a session this socket is not displaying."""
    transport = install_session()
    socketio = FakeSocketIO()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())

    ok, error = ssh_manager.send_ssh_input('sess-views', 'uptime\r',
                                           socket_sid='some-other-socket')

    assert (ok, error) == (True, None)
    assert transport.channels[0].sent == [b'uptime\r']


def test_input_with_no_view_at_all_falls_back_to_send_keys(quiet_threads,
                                                          monkeypatch):
    """Post-connect startup commands run before any browser has attached."""
    install_session()
    sent = []
    monkeypatch.setattr(
        ssh_manager, '_run_tmux_control_command',
        lambda session_id, subcommand, extra_args=None, **_kw:
            sent.append((subcommand, list(extra_args or []))) or (True, None))

    ok, error = ssh_manager.send_ssh_input('sess-views', 'echo hi\r')

    assert (ok, error) == (True, None)
    assert len(sent) == 1
    subcommand, args = sent[0]
    assert subcommand == 'send-keys'
    # HEX pairs: the one form tmux cannot reinterpret as a key name.
    assert args[0] == '-H'
    assert ''.join(args[1:]) == 'echo hi\r'.encode('utf-8').hex()


def test_a_transport_swap_reopens_the_views_it_had(quiet_threads,
                                                  no_tmux_commands):
    old_transport = install_session()
    socketio = FakeSocketIO()
    ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                  object())
    ssh_manager.open_session_view('sess-views', 'desktop', 165, 47, socketio,
                                  object())

    new_transport = FakeTransport()
    ok, error = ssh_manager.swap_session_transport(
        'sess-views',
        {'client': FakeClient(new_transport), 'channel': None,
         'bastion_client': None, 'use_tmux': True,
         'tmux_session_name': 'sshdeck_views', 'utf8_locale': 'C.UTF-8',
         'legacy_tmux_locale': False, 'login_shell': None},
        socketio, object())

    assert (ok, error) == (True, None)
    # Each socket gets a client on the NEW transport, at the size it had: the
    # old channels died with the old transport, so a view that was not re-opened
    # would be a device with no output and no way to ask for one.
    assert len(new_transport.channels) == 2
    # (at the minimum, as on any attach: the phone re-opened first at its
    # own size, the desktop at the minimum, and the phone was brought to it)
    assert sorted(c.pty[1:] for c in new_transport.channels) == [(51, 47),
                                                                 (51, 48)]
    assert sorted(views_of()) == ['desktop', 'phone']
    assert all(c.closed for c in old_transport.channels)


# ---- a character split across two reads ----------------

def _read_one_view(channel, socketio):
    """Drive the view reader over `channel` and return what it emitted."""
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['sess-views']['views']['sid-A'] = {
            'channel': channel, 'cols': 80, 'rows': 24, 'thread': None,
            'transport_generation': 3, 'opened_at': time.time(),
        }
    ssh_manager.read_view_output('sess-views', 'sid-A', channel, 3, socketio,
                                 None)
    return ''.join(payload['data'] for event, payload, _kwargs
                   in socketio.emits if event == 'ssh_output')


def test_a_character_split_across_two_reads_is_not_replaced(monkeypatch,
                                                            no_tmux_commands):
    """THE SQUARES THE OWNER SEES.

    `recv` returns up to 32 KB, and the boundary lands wherever the network
    put it. Decoding each chunk on its own turns a character whose bytes
    straddle that boundary into two U+FFFD -- scattered squares at a few
    positions, which is exactly the report. Vietnamese is 2-3 bytes per
    accented letter and a TUI's box-drawing is 3, so a busy pane hits it;
    pure ASCII never does.
    """
    install_session()
    socketio = FakeSocketIO()
    text = 'Tiếng Việt │ đang chạy └─ ổn định'
    raw = text.encode('utf-8')
    # Split INSIDE the first multi-byte letter, and again inside the box rule.
    first = raw.index('ế'.encode('utf-8')) + 1
    second = raw.index('│'.encode('utf-8')) + 2
    channel = FakeViewChannel(reads=[raw[:first], raw[first:second],
                                     raw[second:], b''])
    emitted = _read_one_view(channel, socketio)

    assert '�' not in emitted, (
        'a character was split across two reads and both halves became U+FFFD '
        '-- the squares in the owner report'
    )
    assert emitted == text


def test_bytes_that_are_really_invalid_are_still_replaced(monkeypatch,
                                                          no_tmux_commands):
    """The repair fixes the artificial split only: genuinely broken bytes
    must still surface as U+FFFD rather than be swallowed."""
    install_session()
    socketio = FakeSocketIO()
    channel = FakeViewChannel(reads=[b'ok \xff\xfe broken\r\n', b''])
    emitted = _read_one_view(channel, socketio)

    assert '�' in emitted
    assert emitted.startswith('ok ') and emitted.endswith('broken\r\n')


def test_the_decoder_is_per_reader_not_shared():
    """Two readers must not share a decoder: one reader's unfinished tail
    would then be decoded into the other reader's stream."""
    first = ssh_manager._stream_decoder()
    second = ssh_manager._stream_decoder()
    assert first is not second
    head = 'ế'.encode('utf-8')[:1]
    assert first.decode(head) == ''
    # The second decoder knows nothing about the first one's pending byte.
    assert second.decode(b'A') == 'A'


# --------------------------------------------------------------------------
# WHO WAITS A QUARTER SECOND FOR A REDRAW, AND WHO DOES NOT
#
# The coalesce exists for a DRAG, which lands geometry after geometry. An
# attach, a detach or a dead view is one event, and the quarter second is added
# straight onto the gap in which every other device is still showing the
# leftovers of its old frame (terminal-manager freezePaneForShrink covers that
# gap; this is the half that shortens it).
# --------------------------------------------------------------------------

def test_an_immediate_redraw_does_not_wait_for_the_coalesce(monkeypatch):
    import time as _time
    fired = []
    monkeypatch.setattr(
        ssh_manager, '_exec_tmux_control',
        lambda *a, **kw: (fired.append(_time.monotonic()), (True, None, ''))[1])

    started = _time.monotonic()
    ssh_manager._redraw_clients('sess-redraw', ['/dev/pts/9'], immediate=True)
    deadline = started + 0.2
    while not fired and _time.monotonic() < deadline:
        _time.sleep(0.005)
    assert fired, "an immediate redraw never ran"
    assert fired[0] - started < ssh_manager.REDRAW_SETTLE_SECONDS


def test_a_coalesced_redraw_still_waits(monkeypatch):
    import time as _time
    fired = []
    monkeypatch.setattr(
        ssh_manager, '_exec_tmux_control',
        lambda *a, **kw: (fired.append(_time.monotonic()), (True, None, ''))[1])

    started = _time.monotonic()
    ssh_manager._redraw_clients('sess-redraw', ['/dev/pts/9'])
    _time.sleep(ssh_manager.REDRAW_SETTLE_SECONDS / 2)
    assert fired == [], "the coalesce window is gone"
    deadline = started + ssh_manager.REDRAW_SETTLE_SECONDS + 0.4
    while not fired and _time.monotonic() < deadline:
        _time.sleep(0.005)
    assert fired, "a coalesced redraw never ran"


def test_attach_and_detach_redraw_at_once_while_a_drag_coalesces(
        quiet_threads, no_tmux_commands):
    asked = []
    original = ssh_manager._redraw_clients
    try:
        ssh_manager._redraw_clients = (
            lambda session_id, ttys, immediate=False: asked.append(immediate))
        socketio = FakeSocketIO()
        install_session(transport=FakeTransport(socketio=socketio))

        # Two views: a detach that leaves NO view returns before the redraw
        # (there is nobody left to redraw), so the case under test needs a
        # survivor.
        ssh_manager.open_session_view('sess-views', 'phone', 51, 48, socketio,
                                      object())
        ssh_manager.open_session_view('sess-views', 'desktop', 165, 47,
                                      socketio, object())
        attach = list(asked)
        asked.clear()

        ssh_manager.resize_session_view('sess-views', 'phone', 60, 50,
                                        socketio_instance=socketio)
        drag = list(asked)
        asked.clear()

        ssh_manager.close_session_view('sess-views', 'phone',
                                       socketio_instance=socketio)
        detach = list(asked)
    finally:
        ssh_manager._redraw_clients = original

    # An attach passes through the pre-shrink pass and the attach itself; both
    # are one-off events and neither waits.
    assert attach and all(attach)
    assert drag == [False]
    assert detach == [True]
