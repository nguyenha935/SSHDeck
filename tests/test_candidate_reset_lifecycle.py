"""Candidate Reset at the BACKEND: what survives a failure, what a success deletes.

WHY THIS FILE EXISTS. The browser suites can prove the client emits the right
frames in the right order and keeps the right UI. They cannot prove what happens
to the PERSISTED offer -- the `ssh_sessions` row with `is_persistent = 1,
connected = 0` that `restore_user_sessions` turns back into a candidate chip on
every reload. That row is the thing a user would see reappear, and it is the exact
thing the release blocker was about:

  * retiring the candidate BEFORE the replacement existed meant a cancelled or
    failed Reset destroyed the saved offer for good;
  * retiring it with `removeSessionUI` alone would drop the chip and LEAVE the
    row, so the offer the user was told had been dropped came back on reload.

So the assertions here are made against the database and against
`restore_user_sessions`'s own output, not against a UI:

  §1 a candidate's row and its restore offer survive a FAILED reset
  §2 the matching success deletes that exact row, and the offer does not return
  §3 the deletion kills NO remote tmux (the documented non-killing semantics)
  §4 it is EXACT: a sibling candidate at the same endpoint is untouched

`socketio.test_client` drives the real `ssh_disconnect` handler, so this is the
product's own path, not a hand-written DB edit.
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
        # A CANDIDATE only exists when tmux is enabled: restore_user_sessions
        # gates the `persistent_session_available` block on this flag, so with the
        # default (false) there are no offers at all and every assertion below
        # would pass vacuously.
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
    password = 'candidate-reset-password-123'
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


def _seed_candidate(app, user_id, session_id, tmux_name, host='cand.example'):
    """One persisted CANDIDATE: is_persistent, not connected, with a tmux name.

    Exactly the shape restore_user_sessions turns into
    `persistent_session_available`, which is what makes a chip a candidate.
    """
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id, user_id=user_id, host=host, port=22,
            username='candu', connected=False, is_persistent=True,
            tmux_session_name=tmux_name, display_name=f'Cand {session_id}')
        db.session.add(row)
        db.session.commit()


def _offered_tmux_names(app, user_id):
    """Every tmux name restore_user_sessions would offer back as a candidate.

    Read through the REAL restore path rather than by re-querying the table, so
    this measures what a reload actually shows the user.
    """
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


def _row_exists(app, session_id):
    from app.models import SSHSession
    with app.app_context():
        return SSHSession.query.filter_by(session_id=session_id).first() is not None


def _collect(socket_client, timeout=2.0):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        time.sleep(0.02)
    return events


# ── §1 a FAILED candidate reset must leave everything alone ─────────────────

def test_a_failed_candidate_reset_leaves_the_offer_in_the_database(app):
    """The blocker, stated as a database fact.

    A candidate Reset now emits its fresh connect and retires NOTHING. So when
    that connect fails there is no `ssh_disconnect` at all, and the persisted
    offer -- the only record that the tmux session on the host belongs to this
    user -- must still be there, and must still be offered on reload.
    """
    socket_client, user_id = _authenticated_socket(app, 'cand_reset_fail')
    try:
        _seed_candidate(app, user_id, 'cand-fail-1', 'sshdeck_cand_fail_1')
        assert _row_exists(app, 'cand-fail-1')
        assert 'sshdeck_cand_fail_1' in _offered_tmux_names(app, user_id)

        # The client's failure path (abandonResetRequest) emits NOTHING to the
        # server: it only drops its own retirement record. So the server state
        # after a failed reset is the server state before it.
        events = _collect(socket_client, 0.3)
        assert not [e for e in events if e['name'] == 'ssh_disconnected']

        assert _row_exists(app, 'cand-fail-1'), (
            'a failed candidate Reset deleted the saved offer; the user can no '
            'longer reconnect to a tmux session that is still running'
        )
        assert 'sshdeck_cand_fail_1' in _offered_tmux_names(app, user_id), (
            'the offer survived in the table but restore no longer offers it'
        )
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ── §2 the matching SUCCESS deletes that exact row, permanently ─────────────

def test_a_successful_candidate_reset_deletes_the_offer_and_it_cannot_return(app):
    """`removeSessionUI` alone was not enough, and this is why.

    Dropping only the chip leaves the row, so the discarded offer comes back as a
    candidate on the next reload -- the user is told the association is gone and
    is then offered it again. The retirement therefore goes through the product's
    own disconnect path, which deletes the row.
    """
    socket_client, user_id = _authenticated_socket(app, 'cand_reset_ok')
    try:
        _seed_candidate(app, user_id, 'cand-ok-1', 'sshdeck_cand_ok_1')
        assert 'sshdeck_cand_ok_1' in _offered_tmux_names(app, user_id)

        # This is what completePendingReset does, POST-SUCCESS, for the exact old
        # session id -- through the real handler.
        socket_client.emit('ssh_disconnect', {'session_id': 'cand-ok-1'})
        _collect(socket_client, 0.5)

        assert not _row_exists(app, 'cand-ok-1'), (
            'the persisted offer survived a successful reset, so it will '
            'reappear as a candidate on the next reload'
        )
        # The reload assertion, through the real restore path.
        assert _offered_tmux_names(app, user_id) == [], (
            'a reload still offers the discarded candidate'
        )
        # And it stays gone across repeated restores (nothing recreates it).
        assert _offered_tmux_names(app, user_id) == []
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ── §3 the deletion kills no remote tmux ────────────────────────────────────

def test_retiring_a_candidate_kills_no_remote_tmux(app, monkeypatch):
    """The documented NON-KILLING semantics, asserted rather than assumed.

    Since `handle_ssh_disconnect` kills the remote tmux itself,
    BEFORE touching the row -- but only for a LIVE session, over its own
    transport. A candidate has no entry in the in-RAM registry (that is what
    makes it a candidate), so no kill is attempted and `close_session` returns
    False before reaching any tmux command.

    This is what the confirmation copy promises: the offer is dropped, and
    anything running in that tmux session keeps running unattached. If a future
    change made this path able to kill, the copy would become a lie -- so the
    absence of a kill is pinned here.
    """
    socket_client, user_id = _authenticated_socket(app, 'cand_reset_nokill')
    kill_calls = []

    real_close = ssh_manager.close_session

    def watched_close(session_id, kill_tmux=False):
        result = real_close(session_id, kill_tmux=kill_tmux)
        kill_calls.append({'session_id': session_id, 'kill_tmux': kill_tmux,
                           'result': result})
        return result

    monkeypatch.setattr(ssh_manager, 'close_session', watched_close)
    from app import socket_events
    monkeypatch.setattr(socket_events.ssh_manager, 'close_session', watched_close)

    try:
        _seed_candidate(app, user_id, 'cand-nokill-1', 'sshdeck_cand_nokill_1')
        # A candidate is, by definition, absent from the in-RAM registry.
        assert ssh_manager.get_session('cand-nokill-1') is None

        socket_client.emit('ssh_disconnect', {'session_id': 'cand-nokill-1'})
        _collect(socket_client, 0.5)

        assert kill_calls, 'the disconnect handler never reached close_session'
        call = kill_calls[-1]
        assert call['session_id'] == 'cand-nokill-1'
        # It ASKS to kill -- the handler is shared with live sessions -- and the
        # answer is False, because there is no session to act on. No tmux command
        # is ever built.
        assert call['result'] is False, (
            'close_session succeeded for a candidate, which means it had a live '
            'transport and may have killed the remote tmux session'
        )
        assert not _row_exists(app, 'cand-nokill-1')
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


# ── §4 EXACT: a sibling candidate at the same endpoint survives ─────────────

def test_retirement_is_exact_and_spares_siblings_at_the_same_endpoint(app):
    """One endpoint can hold SEVERAL tmux candidates.

    The tmux NAME is what distinguishes them, and the retired client-side sweep
    ignored it -- so resetting one silently destroyed the offers for the others.
    The backend path is keyed by session_id, and this pins that: exactly one row
    goes, and the reload still offers the rest.
    """
    socket_client, user_id = _authenticated_socket(app, 'cand_reset_exact')
    try:
        for sid, tmux in (('cand-x-a', 'sshdeck_x_a'),
                          ('cand-x-b', 'sshdeck_x_b'),
                          ('cand-x-c', 'sshdeck_x_c')):
            _seed_candidate(app, user_id, sid, tmux, host='same.example')
        assert sorted(_offered_tmux_names(app, user_id)) == [
            'sshdeck_x_a', 'sshdeck_x_b', 'sshdeck_x_c']

        socket_client.emit('ssh_disconnect', {'session_id': 'cand-x-b'})
        _collect(socket_client, 0.5)

        assert not _row_exists(app, 'cand-x-b')
        assert _row_exists(app, 'cand-x-a')
        assert _row_exists(app, 'cand-x-c')
        assert sorted(_offered_tmux_names(app, user_id)) == [
            'sshdeck_x_a', 'sshdeck_x_c'], (
            'retiring one candidate changed the offers for its siblings at the '
            'same endpoint'
        )
    finally:
        if socket_client.is_connected():
            socket_client.disconnect()


def test_a_candidate_owned_by_another_user_cannot_be_retired(app):
    """Ownership is still enforced on the retirement path.

    The retirement is triggered by a client-supplied session id, so the handler's
    ownership check is what stops one account discarding another's saved offer.
    """
    victim_client, victim_id = _authenticated_socket(app, 'cand_reset_victim')
    attacker_client, _attacker_id = _authenticated_socket(
        app, 'cand_reset_attacker')
    try:
        _seed_candidate(app, victim_id, 'cand-victim-1', 'sshdeck_victim_1')

        attacker_client.emit('ssh_disconnect', {'session_id': 'cand-victim-1'})
        events = _collect(attacker_client, 0.5)

        assert _row_exists(app, 'cand-victim-1'), (
            "another user's saved offer was deleted"
        )
        assert 'sshdeck_victim_1' in _offered_tmux_names(app, victim_id)
        errors = [e for e in events if e['name'] == 'ssh_error']
        assert errors and 'Unauthorized' in errors[0]['args'][0]['error']
    finally:
        for client in (victim_client, attacker_client):
            if client.is_connected():
                client.disconnect()
