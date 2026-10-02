"""A saved session reattached after a restart keeps its identity.

Measured 2026-10-02 (production log, then a throwaway instance): every
reconnect after an SSHDeck restart retired the saved row and inserted a new one
under a fresh id, so the pane it sat in, its place among the chips and every
other device's copy of its chip were lost. The reattach now registers the
transport under the row's own id and updates that row in place.
"""
import pytest

TMUX = 'sshdeck_root_h_22_aaaa'


def _set_policy(monkeypatch):
    import config
    monkeypatch.setattr(config, 'TAILSCALE_SSH_ENABLED', True)
    monkeypatch.setattr(config, 'TAILSCALE_SSH_ALLOWED_SSHDECK_USERS', frozenset())
    monkeypatch.setattr(config, 'TAILSCALE_SSH_ALLOWED_TARGETS', frozenset())
    monkeypatch.setattr(config, 'TAILSCALE_SSH_ALLOWED_REMOTE_USERS', frozenset())
    monkeypatch.setattr(config, 'TMUX_ENABLED', True)


@pytest.fixture
def world(app, monkeypatch):
    """One user, one saved (disconnected) tailscale row in pane 1, fakes for
    the transport registry, and every emit captured."""
    from app import ssh_manager
    from app.auth import register_socket_session, register_user
    from app.models import db, SSHSession
    import app.socket_events as socket_events

    _set_policy(monkeypatch)
    with app.app_context():
        user, error = register_user('reattachadmin', 'reattach-password-123')
        assert error is None
        db.session.add(SSHSession(
            session_id='saved-id', user_id=user.id, host='h', port=22,
            username='root', connected=False, is_persistent=True,
            auth_type='tailscale', tmux_session_name=TMUX,
            display_name='Saved', pane_index=1))
        register_socket_session(user.id, 'sock-1')
        db.session.commit()
        user_id = user.id

    state = {'calls': [], 'registered': {}, 'emitted': [], 'fail': None}

    def fake_create(**kwargs):
        state['calls'].append(kwargs)
        if state['fail']:
            return None, state['fail']
        session_id = kwargs.get('session_id') or 'fresh-id'
        state['registered'][session_id] = {
            'connected': True, 'auth_type': 'tailscale', 'use_tmux': True,
            'tmux_session_name': TMUX}
        return session_id, None

    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', fake_create)
    monkeypatch.setattr(ssh_manager, 'get_session',
                        lambda session_id: state['registered'].get(session_id))
    monkeypatch.setattr(socket_events, 'emit',
                        lambda event, payload=None, **kw: state['emitted'].append(
                            (event, payload, kw)))
    state.update(user_id=user_id, socket_events=socket_events,
                 ssh_manager=ssh_manager)
    yield state
    ssh_manager.end_reconnect('saved-id')


def _claim(app, world, **extra):
    from flask import request
    payload = {'host': 'h', 'port': 22, 'username': 'root',
               'auth_type': 'tailscale', 'use_tmux': True,
               'reconnect_tmux_name': TMUX, 'session_id': 'saved-id',
               'client_request_id': 'req-1'}
    payload.update(extra)
    with app.test_request_context('/socket.io', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        request.sid = 'sock-1'
        world['socket_events'].handle_ssh_connect(payload)


def _events(world, name):
    return [payload for event, payload, _kw in world['emitted'] if event == name]


def _rows(app, user_id):
    from app.models import SSHSession
    with app.app_context():
        return [(r.session_id, r.connected, r.pane_index, r.display_name)
                for r in SSHSession.query.filter_by(user_id=user_id).all()]


def test_the_reattach_keeps_the_id_the_row_and_its_pane(app, world):
    _claim(app, world)
    assert world['calls'][0]['session_id'] == 'saved-id'
    connected = _events(world, 'ssh_connected')
    assert len(connected) == 1
    assert connected[0]['session_id'] == 'saved-id'
    assert connected[0]['pane_index'] == 1
    assert _rows(app, world['user_id']) == [('saved-id', True, 1, 'Saved')]
    # The other pages hear the same id, with nothing to retire.
    announced = _events(world, 'ssh_session_restored')
    assert announced and announced[0]['session_id'] == 'saved-id'
    assert announced[0]['replaces_session_id'] is None


def test_the_claim_is_released_on_success_and_on_failure(app, world):
    _claim(app, world)
    assert world['ssh_manager'].begin_reconnect('saved-id') is True
    world['ssh_manager'].end_reconnect('saved-id')

    world['registered'].clear()
    from app.models import SSHSession, db
    with app.app_context():
        SSHSession.query.filter_by(session_id='saved-id').first().connected = False
        db.session.commit()
    world['fail'] = 'Authentication failed'
    _claim(app, world, client_request_id='req-2')
    assert _events(world, 'ssh_error')[-1]['client_request_id'] == 'req-2'
    assert world['ssh_manager'].begin_reconnect('saved-id') is True
    assert _rows(app, world['user_id']) == [('saved-id', False, 1, 'Saved')]


def test_a_second_claim_while_one_is_in_flight_is_refused(app, world):
    assert world['ssh_manager'].begin_reconnect('saved-id') is True
    _claim(app, world)
    assert world['calls'] == []
    assert _events(world, 'ssh_error')[0]['code'] == 'in_flight'


def test_an_offer_another_device_already_reattached_is_refused(app, world):
    _claim(app, world)
    world['emitted'].clear()
    _claim(app, world, client_request_id='req-2', from_candidate=True)
    assert len(world['calls']) == 1
    error = _events(world, 'ssh_error')[0]
    assert (error['code'], error['client_request_id']) == ('already_live', 'req-2')
    assert _rows(app, world['user_id']) == [('saved-id', True, 1, 'Saved')]


def test_a_restore_says_whether_the_account_remembers_any_pane(app, world):
    from flask import request
    from app.models import SSHSession, db
    world['registered']['live-id'] = {'connected': True, 'use_tmux': True,
                                      'auth_type': 'tailscale'}
    with app.app_context():
        db.session.add(SSHSession(session_id='live-id', user_id=world['user_id'],
                                  host='h', port=22, username='root',
                                  connected=True, is_persistent=True,
                                  auth_type='tailscale',
                                  tmux_session_name='sshdeck_root_h_22_bbbb'))
        db.session.commit()

    def restored_flag():
        world['emitted'].clear()
        with app.test_request_context('/socket.io'):
            request.sid = 'sock-1'
            world['socket_events'].restore_user_sessions(world['user_id'], to_sid='sock-1')
        return [p['account_has_panes'] for p in _events(world, 'ssh_session_restored')]

    # The saved offer remembers pane 1, so the live one must not take pane 0.
    assert restored_flag() == [True]
    with app.app_context():
        SSHSession.query.filter_by(session_id='saved-id').first().pane_index = None
        db.session.commit()
    assert restored_flag() == [False]


def test_an_id_still_registered_is_never_overwritten(monkeypatch):
    from app import ssh_manager

    closed = []
    monkeypatch.setattr(ssh_manager, '_build_transport', lambda *a, **k: (
        {'client': 'c', 'channel': None, 'bastion_client': None,
         'use_tmux': True, 'tmux_session_name': TMUX}, None))
    monkeypatch.setattr(ssh_manager, '_close_transport_parts',
                        lambda *parts: closed.append(parts))
    monkeypatch.setattr(ssh_manager.time, 'sleep', lambda s: None)
    sentinel = {'user_id': 7, 'connected': True}
    with ssh_manager.sessions_lock:
        ssh_manager.sessions['taken-id'] = sentinel
    try:
        session_id, error = ssh_manager.create_ssh_connection(
            'h', 22, 'root', user_id=7, use_tmux=True, session_id='taken-id')
        assert (session_id, error) == (None, 'Session is already connected')
        assert ssh_manager.sessions['taken-id'] is sentinel
        assert closed == [('c', None, None)]
    finally:
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('taken-id', None)


def test_a_view_of_a_session_with_no_transport_is_refused(app, world):
    """An offer has a row but no transport. Its empty record used to read as
    a plain shell and answer view_attached for a client never opened -- which,
    once the reattach kept the id, left the page sure it was attached while
    tmux had no client for it (measured on the restart reproduction)."""
    from flask import request
    with app.test_request_context('/socket.io'):
        request.sid = 'sock-1'
        world['socket_events'].handle_view_attach(
            {'session_id': 'saved-id', 'cols': 80, 'rows': 24, 'history': True})
    assert _events(world, 'view_attached') == []
    assert _events(world, 'view_error') == [
        {'session_id': 'saved-id', 'error': 'Session is not connected'}]


def test_the_ack_reports_the_size_the_server_kept(app, world, monkeypatch):
    """view_attached carries the size this socket's view is registered at,
    which is not always the size the request asked for: of two attaches in
    flight the first to register is kept (test_session_views). The page
    resizes to what it asked for last when the two differ."""
    from flask import request
    ssh_manager = world['ssh_manager']
    world['registered']['saved-id'] = {
        'connected': True, 'use_tmux': True, 'tmux_session_name': TMUX}

    def open_kept_first(session_id, socket_sid, cols, rows, *_rest):
        with ssh_manager.sessions_lock:
            ssh_manager.sessions[session_id] = {
                'views': {socket_sid: {'cols': 167, 'rows': 48}}}
        return True, None

    monkeypatch.setattr(ssh_manager, 'open_session_view', open_kept_first)
    try:
        with app.test_request_context('/socket.io'):
            request.sid = 'sock-1'
            world['socket_events'].handle_view_attach(
                {'session_id': 'saved-id', 'cols': 83, 'rows': 48})
    finally:
        with ssh_manager.sessions_lock:
            ssh_manager.sessions.pop('saved-id', None)
    assert _events(world, 'view_attached') == [
        {'session_id': 'saved-id', 'cols': 167, 'rows': 48}]
