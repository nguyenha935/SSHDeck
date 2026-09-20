"""W1: canonical SessionSnapshot v1 contract, persistence and restore scoping.

These tests pin the defects that made reconnect-after-reload unreliable:

  * the restore payload omitted ``key_id``, so a restored KEY session could not
    reconnect silently even though an equivalent persistent CANDIDATE could --
    the client gates silent reconnect on that field;
  * ``display_name`` / ``key_id`` were persisted only when ``use_tmux`` was
    true, so a plain SSH session lost its identity across a reload;
  * restore was emitted to the whole user room, so a second tab connecting
    replayed scrollback into the first tab's terminals;
  * the snapshot projection did not carry ``auth_type``, so the server silently
    fell back to the DB value and the RAM record was never actually consulted.

Every assertion below reads the real production handler output; nothing about
the snapshot is stubbed except the SSH transport itself, which cannot exist in
a unit test.
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
    """Module-scoped app so the global Socket.IO handlers register once.

    Same rationale as tests/test_tmux_socket_events.py: the function-scoped
    conftest fixture re-initializes the shared socketio instance per test and
    breaks event routing for later clients.
    """
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        config.RATELIMIT_ENABLED = False

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


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


def _register(app, username):
    with app.app_context():
        user, error = register_user(username, 'snapshot-pass-123')
        assert error is None
        return user.id


def _login_socket(app, username):
    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': username,
        'password': 'snapshot-pass-123',
    })
    assert response.status_code == 302
    client = socketio.test_client(app, flask_test_client=http_client)
    assert client.is_connected()
    return client


def _fake_ram_session(user_id, *, connected=True, use_tmux=True,
                      tmux_name='sshdeck_snap', auth_type='key',
                      display_name='Prod box', jump=None,
                      legacy_tmux_locale=None):
    return {
        'client': object(),
        'channel': object(),
        'host': 'snap.example.com',
        'port': 22,
        'username': 'deploy',
        'user_id': user_id,
        'connected': connected,
        'last_activity': time.time(),
        'bastion_client': None,
        'proxy_jump_host': jump,
        'auth_type': auth_type,
        'use_tmux': use_tmux,
        'tmux_session_name': tmux_name,
        'display_name': display_name,
        # W13-A4: tri-state pane locale measurement (see _build_transport).
        'legacy_tmux_locale': legacy_tmux_locale,
        'output_buffer': [],
        'output_buffer_size': 0,
        'output_buffer_max': 512000,
    }


def _seed(app, user_id, session_id, **db_kwargs):
    from app.models import SSHSession, db
    with app.app_context():
        row = SSHSession(
            session_id=session_id,
            user_id=user_id,
            host='snap.example.com',
            port=22,
            username='deploy',
            connected=True,
            **db_kwargs,
        )
        db.session.add(row)
        db.session.commit()


# ---- schema -----------------------------------------------------------------

def test_schema_has_additive_snapshot_columns(app):
    """pane_index/snapshot_version exist and are additive (nullable/defaulted).

    A NOT NULL column without a default would break the previous image on
    rollback, so the nullability is asserted, not just the presence.
    """
    from sqlalchemy import inspect
    from app.models import db
    with app.app_context():
        columns = {c['name']: c for c in inspect(db.engine).get_columns('ssh_sessions')}
        assert 'pane_index' in columns
        assert 'snapshot_version' in columns
        assert columns['pane_index']['nullable'] is True
        assert columns['snapshot_version']['default'] is not None \
            or columns['snapshot_version']['nullable'] is False


def test_migration_is_idempotent(app):
    """Running the migration twice must not raise or duplicate columns."""
    from sqlalchemy import inspect
    from app.models import db, ensure_ssh_session_columns
    with app.app_context():
        before = len(inspect(db.engine).get_columns('ssh_sessions'))
        ensure_ssh_session_columns()
        ensure_ssh_session_columns()
        after = len(inspect(db.engine).get_columns('ssh_sessions'))
        assert before == after


# ---- snapshot projection ----------------------------------------------------

def test_snapshot_carries_auth_type_from_ram_not_db_fallback(app):
    """auth_type must come from the live record, not silently from the DB.

    Before W1 the projection omitted auth_type entirely, so
    ``session.get('auth_type', db.auth_type)`` ALWAYS took the DB branch. Here
    RAM and DB deliberately disagree: RAM must win.
    """
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_authtype')
    sid = 'snapshot-authtype-1'
    _seed(app, user_id, sid, auth_type='password', is_persistent=True,
          key_id='key-abc', tmux_session_name='sshdeck_snap')
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(user_id, auth_type='key')

    with app.app_context():
        row = SSHSession.query.filter_by(session_id=sid).first()
        snapshot = socket_events._build_session_snapshot(sid, row)

    assert snapshot['auth_type'] == 'key'
    assert snapshot['snapshot_version'] == 1


def test_snapshot_never_contains_secrets(app):
    """Only the opaque key_id reference may appear -- never key material."""
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_secrets')
    sid = 'snapshot-secrets-1'
    _seed(app, user_id, sid, auth_type='key', key_id='key-ref-1',
          is_persistent=True)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(user_id)

    with app.app_context():
        row = SSHSession.query.filter_by(session_id=sid).first()
        snapshot = socket_events._build_session_snapshot(sid, row)

    forbidden = {'password', 'key_content', 'client', 'channel', 'pkey',
                 'bastion_client', 'proxy_jump_password'}
    assert forbidden.isdisjoint(snapshot.keys())
    assert snapshot['key_id'] == 'key-ref-1'


def test_snapshot_reports_jump_host_identity(app):
    """via_jump is projected from the RAM record's proxy_jump_host."""
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_jump')
    sid = 'snapshot-jump-1'
    _seed(app, user_id, sid, auth_type='key', is_persistent=True)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(
            user_id, jump='bastion.example.com')

    with app.app_context():
        row = SSHSession.query.filter_by(session_id=sid).first()
        snapshot = socket_events._build_session_snapshot(sid, row)

    assert snapshot['via_jump'] == 'bastion.example.com'


# ---- restore payload completeness ------------------------------------------

RECONNECT_REQUIRED_FIELDS = (
    'session_id', 'host', 'port', 'username',
    'auth_type', 'key_id', 'use_tmux', 'tmux_session_name', 'display_name',
)


def test_restore_payload_is_superset_of_reconnect_needs(app):
    """The restore event must carry every field silent reconnect needs.

    This is the non-vacuous guard for the critical defect: key_id was missing,
    so a restored key session was forced through the password modal. The field
    list is asserted explicitly so dropping any one of them fails here.
    """
    from app import socket_events
    user_id = _register(app, 'snapshot_restore_super')
    sid = 'snapshot-restore-1'
    _seed(app, user_id, sid, auth_type='key', key_id='key-restore-1',
          is_persistent=True, tmux_session_name='sshdeck_snap',
          display_name='Prod box')
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(user_id)

    captured = []
    with app.app_context():
        original_emit = socket_events.emit

        def spy(event, payload=None, **kwargs):
            captured.append((event, payload, kwargs))

        socket_events.emit = spy
        try:
            socket_events.restore_user_sessions(user_id, to_sid='sid-A')
        finally:
            socket_events.emit = original_emit

    restored = [p for (e, p, _k) in captured if e == 'ssh_session_restored']
    assert len(restored) == 1
    payload = restored[0]
    missing = [f for f in RECONNECT_REQUIRED_FIELDS if f not in payload]
    assert not missing, f'restore payload missing {missing}'
    assert payload['key_id'] == 'key-restore-1'
    assert payload['use_tmux'] is True
    assert payload['tmux_session_name'] == 'sshdeck_snap'
    assert payload['snapshot_version'] == 1


def test_restore_is_scoped_to_the_connecting_socket(app):
    """Restore must target the requesting sid, never the whole user room.

    Broadcasting to ``user_<id>`` made a second tab's connect replay scrollback
    into the first tab's terminals.
    """
    from app import socket_events
    user_id = _register(app, 'snapshot_restore_sid')
    sid = 'snapshot-restore-2'
    _seed(app, user_id, sid, auth_type='key', key_id='k', is_persistent=True)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(user_id)

    captured = []
    with app.app_context():
        original_emit = socket_events.emit

        def spy(event, payload=None, **kwargs):
            captured.append((event, payload, kwargs))

        socket_events.emit = spy
        try:
            socket_events.restore_user_sessions(user_id, to_sid='sid-CONNECTING')
        finally:
            socket_events.emit = original_emit

    rooms = [k.get('room') for (e, _p, k) in captured
             if e in ('ssh_session_restored', 'persistent_session_available')]
    assert rooms, 'no restore events emitted'
    assert all(room == 'sid-CONNECTING' for room in rooms), rooms
    assert f'user_{user_id}' not in rooms


def test_candidate_payload_also_versioned_and_complete(app):
    """A persistent candidate keeps its reconnect fields and gains the version."""
    import config
    from app import socket_events
    user_id = _register(app, 'snapshot_candidate')
    sid = 'snapshot-candidate-1'
    from app.models import SSHSession, db
    with app.app_context():
        db.session.add(SSHSession(
            session_id=sid, user_id=user_id, host='snap.example.com', port=22,
            username='deploy', connected=False, is_persistent=True,
            auth_type='key', key_id='key-cand-1',
            tmux_session_name='sshdeck_cand', display_name='Candidate box'))
        db.session.commit()

    captured = []
    with app.app_context():
        original_emit = socket_events.emit
        original_tmux_enabled = config.TMUX_ENABLED
        # Candidate offers are gated on TMUX_ENABLED, which defaults to false.
        config.TMUX_ENABLED = True

        def spy(event, payload=None, **kwargs):
            captured.append((event, payload, kwargs))

        socket_events.emit = spy
        try:
            socket_events.restore_user_sessions(user_id, to_sid='sid-B')
        finally:
            socket_events.emit = original_emit
            config.TMUX_ENABLED = original_tmux_enabled

    offers = [p for (e, p, _k) in captured
              if e == 'persistent_session_available']
    assert len(offers) == 1
    assert offers[0]['key_id'] == 'key-cand-1'
    assert offers[0]['tmux_session_name'] == 'sshdeck_cand'
    assert offers[0]['snapshot_version'] == 1


# ---- unconditional persistence ---------------------------------------------

def test_display_name_and_key_id_persist_without_tmux(app, monkeypatch):
    """A plain (non-tmux) session must keep its name and key identity.

    Previously both were written as NULL unless use_tmux was true, so a plain
    key session lost its identity on reload and could never reconnect silently.
    """
    from app.models import SSHSession
    username = 'snapshot_notmux'
    _register(app, username)
    client = _login_socket(app, username)
    client.get_received()

    created_id = 'snapshot-notmux-session'

    def fake_create(**kwargs):
        with ssh_manager.sessions_lock:
            ssh_manager.sessions[created_id] = _fake_ram_session(
                1, use_tmux=False, tmux_name=None, auth_type='key',
                display_name=kwargs.get('display_name'))
        return created_id, None

    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', fake_create)
    monkeypatch.setattr(ssh_manager, 'set_tmux_mouse_mode',
                        lambda *_a, **_k: (True, None))
    # The handler resolves the key BEFORE connecting; no real key exists here,
    # and reading key material is not what this test is about.
    from app import key_manager
    monkeypatch.setattr(key_manager, 'read_key_content',
                        lambda *_a, **_k: ('-----FAKE KEY-----', None))

    try:
        client.emit('ssh_connect', {
            'host': 'snap.example.com',
            'port': 22,
            'username': 'deploy',
            'auth_type': 'key',
            'key_id': 'key-plain-1',
            'use_tmux': False,
            'display_name': 'Plain box',
            'client_request_id': 'req-notmux',
        })
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            client.get_received()
            with app.app_context():
                row = SSHSession.query.filter_by(session_id=created_id).first()
                if row is not None:
                    break
            time.sleep(0.02)

        with app.app_context():
            row = SSHSession.query.filter_by(session_id=created_id).first()
            assert row is not None, 'session row was never recorded'
            assert row.display_name == 'Plain box'
            assert row.key_id == 'key-plain-1'
            assert row.is_persistent is False
    finally:
        if client.is_connected():
            client.disconnect()


def test_key_manager_read_is_not_required_for_snapshot(app):
    """The snapshot never reads key material, only the reference."""
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_nokeyread')
    sid = 'snapshot-nokeyread-1'
    _seed(app, user_id, sid, auth_type='key', key_id='key-ref-2',
          is_persistent=True)
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = _fake_ram_session(user_id)

    with app.app_context():
        row = SSHSession.query.filter_by(session_id=sid).first()
        snapshot = socket_events._build_session_snapshot(sid, row)
    assert snapshot['key_id'] == 'key-ref-2'
    assert 'key_content' not in snapshot


# ---- W13-A4: legacy tmux locale propagation -------------------------------

def test_snapshot_carries_the_legacy_tmux_locale_measurement(app):
    """The tri-state pane measurement rides on every snapshot.

    ``True`` (the attached pane predates the UTF-8 locale fix) must reach the
    client verbatim so the chip and the lifecycle sheet can say so; the value
    is never coerced, defaulted or dropped on the way. A measured-fine pane
    (``False``) and an unmeasured session (``None``) each keep their exact
    value too, because the client distinguishes all three: only the explicit
    ``True`` paints a warning, and conflating ``False`` with ``None`` would
    either warn about healthy panes or hide the limitation.
    """
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_legacy')
    for sid, value in [('snapshot-legacy-true', True),
                       ('snapshot-legacy-false', False),
                       ('snapshot-legacy-none', None)]:
        _seed(app, user_id, sid, auth_type='key', key_id='key-leg',
              is_persistent=True)
        with ssh_manager.sessions_lock:
            ssh_manager.sessions[sid] = _fake_ram_session(
                user_id, legacy_tmux_locale=value)

    with app.app_context():
        for sid, value in [('snapshot-legacy-true', True),
                           ('snapshot-legacy-false', False),
                           ('snapshot-legacy-none', None)]:
            row = SSHSession.query.filter_by(session_id=sid).first()
            snapshot = socket_events._build_session_snapshot(sid, row)
            assert 'legacy_tmux_locale' in snapshot
            assert snapshot['legacy_tmux_locale'] is value


def test_snapshot_of_an_unmeasured_ram_session_is_none_not_missing(app):
    """A RAM record without the measurement keys snapshots ``None``.

    Older in-RAM sessions (created before the probe carried this field) have
    no ``legacy_tmux_locale`` key at all. The snapshot must still CONTAIN the
    key with ``None``: the client treats absent and null identically today,
    but the projection contract is that every snapshot v1 field is present,
    and a silently missing key would make a future strict consumer crash
    instead of reading ``None``.
    """
    from app import socket_events
    from app.models import SSHSession
    user_id = _register(app, 'snapshot_legacy_absent')
    sid = 'snapshot-legacy-absent-1'
    _seed(app, user_id, sid, auth_type='key', key_id='key-leg2',
          is_persistent=True)
    ram = _fake_ram_session(user_id)
    del ram['legacy_tmux_locale']
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[sid] = ram

    with app.app_context():
        row = SSHSession.query.filter_by(session_id=sid).first()
        snapshot = socket_events._build_session_snapshot(sid, row)
    assert 'legacy_tmux_locale' in snapshot
    assert snapshot['legacy_tmux_locale'] is None
