"""W13-B6: candidate Reset DB/UI ATOMICITY via correlated ack.

WHY THIS FILE EXISTS. The browser suites prove the client asks and waits; they
cannot prove what the server does with the ask. B6's contract is a database
fact, and this file asserts it against the REAL `candidate_reset` handler
through `socketio.test_client`:

  §1 a successful correlated retirement DELETES the row, acks with the EXACT
     request id, and offers nothing back on restore;
  §2 two retirements in flight are answered separately and each ack names its
     OWN request id and session id -- correlation never crosses;
  §3 every refusal is a CORRELATED error: the row survives, the error carries
     the request id, and nothing is deleted -- unauthorized, unknown session,
     non-persistent row, missing ids;
  §4 a failed DB commit rolls back and answers with a correlated error -- the
     row is provably still there;
  §5 the retirement kills NO tmux (kill_tmux=False) -- a row that somehow
     gained a live entry mid-flight is closed, never killed, by an act that
     only promised to drop SSHDeck's saved offer.

`socketio.test_client` drives the real handler, so this is the product's own
path, not a hand-written DB edit.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio, ssh_manager
from app.auth import register_user

@pytest.fixture(scope='module')
def app():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        config.RATELIMIT_ENABLED = False
        # Candidates only exist when tmux is enabled: restore_user_sessions
        # gates the persistent offer on this flag.
        config.TMUX_ENABLED = True

        from app import create_app
        from app.models import db

        test_app = create_app()
        from app import socket_events
        importlib.reload(socket_events)
        test_app.config['TESTING'] = True
        test_app.config['WTF_CSRF_ENABLED'] = False
        with test_app.app_context():
            db.create_all()
        yield test_app
        with test_app.app_context():
            db.session.remove()
            db.engine.dispose()

def _authenticated_socket(app, username):
    password = 'candidate-reset-b6-password-123'
    with app.app_context():
        user, error = register_user(username, password)
        assert error is None, error
        user_id = user.id

    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username, 'password': password})
    assert response.status_code == 302

    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client, user_id

def _seed_candidate(app, user_id, session_id, tmux_name, host='b6.example'):
    """One persisted CANDIDATE: is_persistent, not connected, with a tmux name."""
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id, user_id=user_id, host=host, port=22,
            username='b6u', connected=False, is_persistent=True,
            tmux_session_name=tmux_name, display_name=f'B6 {session_id}')
        db.session.add(row)
        db.session.commit()

def _seed_non_persistent(app, user_id, session_id, host='b6.example'):
    """A NON-persistent row: the shape B6 must REFUSE to delete."""
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id, user_id=user_id, host=host, port=22,
            username='b6u', connected=False, is_persistent=False,
            display_name=f'B6 live-ish {session_id}')
        db.session.add(row)
        db.session.commit()

def _row_exists(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        return SSHSession.query.filter_by(session_id=session_id).first() is not None

def _offered_tmux_names(app, user_id):
    """Every tmux name restore_user_sessions would offer back as a candidate."""
    from app import socket_events
    offers = []

    def fake_emit(event, payload, **_kwargs):
        if event == 'persistent_session_available':
            offers.append(payload.get('tmux_session_name'))

    with app.app_context():
        original = socket_events.emit
        socket_events.emit = fake_emit
        try:
            socket_events.restore_user_sessions(user_id, to_sid='test-sid')
        finally:
            socket_events.emit = original
    return offers

def _collect(socket_client, timeout=2.0):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        time.sleep(0.02)
    return events

# ── §1 the success: delete, ack, and the offer is gone for good ─────────────

def test_a_successful_candidate_reset_deletes_the_row_and_acks_the_exact_request(app):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_success')
    _seed_candidate(app, user_id, 'b6-ok-1', 'tmux_b6_ok_1')
    assert _row_exists(app, 'b6-ok-1')

    socket_client.emit('candidate_reset', {
        'session_id': 'b6-ok-1', 'request_id': 'retire_b6_ok_1'})
    events = _collect(socket_client)

    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    assert errors == []
    assert len(acks) == 1
    # The correlated shape: ok, the EXACT session, the EXACT request id.
    assert acks[0]['args'][0] == {
        'ok': True, 'session_id': 'b6-ok-1', 'request_id': 'retire_b6_ok_1'}

    # The row is gone, and restore offers nothing back -- the user will not be
    # re-offered the association they were told was dropped.
    assert not _row_exists(app, 'b6-ok-1')
    assert 'tmux_b6_ok_1' not in _offered_tmux_names(app, user_id)

    # The deletion answers with NOTHING destructive: no ssh_disconnected frame
    # for this id (the client's own ack handler is the only authority).
    assert not [e for e in events if e['name'] == 'ssh_disconnected'
                and e['args'][0].get('session_id') == 'b6-ok-1']

# ── §2 correlation: two retirements answer separately, never crossed ────────

def test_two_retirements_in_flight_each_ack_their_own_request(app):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_pair')
    _seed_candidate(app, user_id, 'b6-pair-a', 'tmux_b6_pair_a')
    _seed_candidate(app, user_id, 'b6-pair-b', 'tmux_b6_pair_b')

    socket_client.emit('candidate_reset', {
        'session_id': 'b6-pair-a', 'request_id': 'retire_pair_a'})
    socket_client.emit('candidate_reset', {
        'session_id': 'b6-pair-b', 'request_id': 'retire_pair_b'})
    events = _collect(socket_client)

    acks = [e['args'][0] for e in events
            if e['name'] == 'candidate_reset_ack']
    assert len(acks) == 2
    by_session = {a['session_id']: a for a in acks}
    assert by_session['b6-pair-a']['request_id'] == 'retire_pair_a'
    assert by_session['b6-pair-b']['request_id'] == 'retire_pair_b'
    assert by_session['b6-pair-a']['ok'] is True
    assert by_session['b6-pair-b']['ok'] is True
    assert not _row_exists(app, 'b6-pair-a')
    assert not _row_exists(app, 'b6-pair-b')

# ── §3 every refusal is a CORRELATED error, and nothing is deleted ──────────

def test_another_users_candidate_is_refused_and_kept(app):
    victim_socket, victim_id = _authenticated_socket(app, 'b6_victim')
    attacker_socket, _ = _authenticated_socket(app, 'b6_attacker')
    _seed_candidate(app, victim_id, 'b6-guarded', 'tmux_b6_guarded')

    attacker_socket.emit('candidate_reset', {
        'session_id': 'b6-guarded', 'request_id': 'retire_stolen'})
    events = _collect(attacker_socket)

    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert acks == []
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Unauthorized'
    assert errors[0]['args'][0]['request_id'] == 'retire_stolen'
    assert errors[0]['args'][0]['session_id'] == 'b6-guarded'
    # The victim's offer is untouched.
    assert _row_exists(app, 'b6-guarded')

def test_an_unknown_session_is_refused_with_a_correlated_error(app):
    socket_client, _ = _authenticated_socket(app, 'b6_user_unknown')
    socket_client.emit('candidate_reset', {
        'session_id': 'b6-does-not-exist', 'request_id': 'retire_ghost'})
    events = _collect(socket_client)
    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert acks == []
    assert len(errors) == 1
    # Ownership is checked BEFORE existence: an id that belongs to nobody
    # answers 'Unauthorized', not 'Session not found' -- the handler refuses
    # to reveal whether an arbitrary session id exists to a caller who does
    # not own it. 'Session not found' is reserved for the race where the row
    # disappears between an ownership check that passed (in-RAM) and the
    # query, and is proven in the pair test's design. Either way the answer
    # is correlated and nothing is deleted.
    assert errors[0]['args'][0]['error'] == 'Unauthorized'
    assert errors[0]['args'][0]['request_id'] == 'retire_ghost'

def test_a_row_gone_between_ownership_and_query_answers_session_not_found(
        app, monkeypatch):
    """The genuine 'Session not found' race.

    `verify_session_ownership` passes on the IN-RAM registry without touching
    the database, so a row that is deleted (or was never persisted) while the
    session still lives in RAM passes ownership and then hits the query. That
    gap must answer with a correlated 'Session not found', never an ack, and
    delete nothing.
    """
    socket_client, user_id = _authenticated_socket(app, 'b6_user_race')
    ghost_id = 'b6-ram-only'
    # In-RAM registration only: no DB row is created.
    ssh_manager.sessions[ghost_id] = {'user_id': str(user_id)}
    try:
        socket_client.emit('candidate_reset', {
            'session_id': ghost_id, 'request_id': 'retire_race'})
        events = _collect(socket_client)
    finally:
        ssh_manager.sessions.pop(ghost_id, None)

    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert acks == []
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Session not found'
    assert errors[0]['args'][0]['request_id'] == 'retire_race'
    assert errors[0]['args'][0]['session_id'] == ghost_id

def test_a_non_persistent_row_is_refused_and_kept(app):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_nonpersistent')
    _seed_non_persistent(app, user_id, 'b6-liveish')

    socket_client.emit('candidate_reset', {
        'session_id': 'b6-liveish', 'request_id': 'retire_liveish'})
    events = _collect(socket_client)

    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert acks == []
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Not a persistent candidate session'
    assert errors[0]['args'][0]['request_id'] == 'retire_liveish'
    # B6 must never delete a record a live or ordinary-disconnected session
    # still relies on.
    assert _row_exists(app, 'b6-liveish')

def test_missing_ids_are_refused_correlated(app):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_shape')
    _seed_candidate(app, user_id, 'b6-shape', 'tmux_b6_shape')

    # Missing request_id: refused, and nothing named by session_id is deleted.
    socket_client.emit('candidate_reset', {'session_id': 'b6-shape'})
    events = _collect(socket_client)
    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Missing request_id'
    assert _row_exists(app, 'b6-shape')

    socket_client.get_received()
    # Missing session_id: refused, correlated by the request id.
    socket_client.emit('candidate_reset', {'request_id': 'retire_nowhere'})
    events = _collect(socket_client)
    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Missing session_id'
    assert errors[0]['args'][0]['request_id'] == 'retire_nowhere'

    socket_client.get_received()
    # A non-dict payload is treated as missing everything, never a crash.
    socket_client.emit('candidate_reset', 'not-a-dict')
    events = _collect(socket_client)
    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Missing request_id'
    # The candidate still stands.
    assert _row_exists(app, 'b6-shape')

# ── §4 a failed commit rolls back: the row stays, the error correlates ──────

def test_a_failed_db_commit_keeps_the_row_and_answers_correlated(
        app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_dbfail')
    _seed_candidate(app, user_id, 'b6-dbfail', 'tmux_b6_dbfail')

    from app.models import db as models_db
    real_commit = models_db.session.commit

    def failing_commit(*_args, **_kwargs):
        raise RuntimeError('simulated commit failure')

    monkeypatch.setattr(models_db.session, 'commit', failing_commit)
    try:
        socket_client.emit('candidate_reset', {
            'session_id': 'b6-dbfail', 'request_id': 'retire_dbfail'})
        events = _collect(socket_client)
    finally:
        monkeypatch.setattr(models_db.session, 'commit', real_commit)

    errors = [e for e in events if e['name'] == 'candidate_reset_error']
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert acks == []
    assert len(errors) == 1
    assert errors[0]['args'][0]['error'] == 'Failed to delete the saved session'
    assert errors[0]['args'][0]['request_id'] == 'retire_dbfail'
    # Rollback means the row is provably still there -- the client keeping
    # its chip on the error ack is the truthful state.
    assert _row_exists(app, 'b6-dbfail')

    # And once the database is healthy again, the same request succeeds.
    socket_client.get_received()
    socket_client.emit('candidate_reset', {
        'session_id': 'b6-dbfail', 'request_id': 'retire_dbfail_retry'})
    events = _collect(socket_client)
    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert len(acks) == 1
    assert acks[0]['args'][0]['request_id'] == 'retire_dbfail_retry'
    assert not _row_exists(app, 'b6-dbfail')

# ── §5 the retirement NEVER kills a tmux session ────────────────────────────

def test_a_successful_retirement_closes_with_kill_tmux_false(app, monkeypatch):
    socket_client, user_id = _authenticated_socket(app, 'b6_user_nokill')
    _seed_candidate(app, user_id, 'b6-nokill', 'tmux_b6_nokill')

    calls = []
    real_close = ssh_manager.close_session
    monkeypatch.setattr(ssh_manager, 'close_session',
                        lambda sid, kill_tmux=False: calls.append(
                            (sid, kill_tmux)) or False)
    try:
        socket_client.emit('candidate_reset', {
            'session_id': 'b6-nokill', 'request_id': 'retire_nokill'})
        events = _collect(socket_client)
    finally:
        monkeypatch.setattr(ssh_manager, 'close_session', real_close)

    acks = [e for e in events if e['name'] == 'candidate_reset_ack']
    assert len(acks) == 1
    # A candidate has no in-RAM entry, so close is defensive only -- but IF it
    # is ever reached, it must be kill_tmux=False: dropping SSHDeck's saved
    # offer must never kill what is running on the host.
    assert calls == [('b6-nokill', False)]
    assert not _row_exists(app, 'b6-nokill')
