from types import SimpleNamespace

import pytest


def _create_user(username, password='password123'):
    from app.auth import register_user

    user, error = register_user(username, password)
    assert error is None
    return user


def _login(client, username, password='password123'):
    response = client.post('/login', data={
        'username': username,
        'password': password,
    })
    assert response.status_code == 302


class _FakeSocketServer:
    def __init__(self):
        self.disconnected = []

    def disconnect(self, sid, namespace='/'):
        self.disconnected.append((sid, namespace))


class TestLockedUserRejection:
    def test_locked_user_is_rejected_by_http_and_socket_loaders(self, app):
        with app.app_context():
            from app.auth import load_user, register_socket_session, get_user_from_socket
            from app.models import db

            user = _create_user('lockeduser')
            register_socket_session(user.id, 'locked-sid')
            user.is_locked = True
            db.session.commit()

            assert load_user(str(user.id)) is None
            assert get_user_from_socket('locked-sid') is None

    def test_locked_user_cannot_open_new_socket_connection(self, app, monkeypatch):
        with app.app_context():
            from app.models import db

            user = _create_user('lockedsocket')
            user_id = user.id
            user.is_locked = True
            db.session.commit()

        from flask import request, session
        import app.socket_events as socket_events

        emitted = []
        disconnected = []
        monkeypatch.setattr(
            socket_events,
            'emit',
            lambda event, payload=None, **kwargs: emitted.append((event, payload)),
        )
        monkeypatch.setattr(
            socket_events,
            'disconnect',
            lambda: disconnected.append(True),
        )

        with app.test_request_context('/socket.io'):
            session['_user_id'] = str(user_id)
            request.sid = 'locked-connect-sid'

            assert socket_events.handle_connect() is False

        assert emitted == [('connected', {'status': 'unauthenticated'})]
        assert disconnected == [True]


class TestUserAccessRevocation:
    def test_revocation_closes_only_target_user_resources(self, app, monkeypatch):
        with app.app_context():
            from app import ssh_manager
            from app.models import db, SocketSession, SSHSession
            from app.user_lifecycle import revoke_user_access
            import app.user_lifecycle as lifecycle

            target = _create_user('revoked')
            other = _create_user('other')
            db.session.add_all([
                SocketSession(user_id=target.id, socket_sid='target-sid'),
                SocketSession(user_id=other.id, socket_sid='other-sid'),
                SSHSession(session_id='target-ssh', user_id=target.id,
                           host='target.example', port=22, username='root'),
                SSHSession(session_id='other-ssh', user_id=other.id,
                           host='other.example', port=22, username='root'),
            ])
            db.session.commit()

            ssh_manager.sessions.clear()
            ssh_manager.sessions.update({
                'target-ssh': {'user_id': target.id},
                'other-ssh': {'user_id': other.id},
            })
            close_calls = []

            def fake_close_session(session_id, kill_tmux=False, expected_session=None):
                # No asserts in here: revoke_user_access wraps close_session in
                # try/except, so a failing assert would be swallowed and surface
                # as a confusing "close failed" error instead. Record the call
                # and assert after revoke_user_access() returns.
                close_calls.append((session_id, kill_tmux))
                ssh_manager.sessions.pop(session_id, None)
                return True

            closed_pool = []

            def fake_close_pool(user_id):
                closed_pool.append(user_id)
                return 2

            monkeypatch.setattr(ssh_manager, 'close_session', fake_close_session)
            monkeypatch.setattr(
                lifecycle.connection_pool.temp_connection_pool,
                'close_all_user_connections',
                fake_close_pool,
            )
            fake_socketio = SimpleNamespace(server=_FakeSocketServer())

            result = revoke_user_access(target.id, fake_socketio)

            # Revocation must kill the remote tmux session so a revoked user
            # does not keep a live shell on the target host.
            assert close_calls == [('target-ssh', True)]
            assert 'other-ssh' in ssh_manager.sessions
            assert closed_pool == [str(target.id)]
            assert fake_socketio.server.disconnected == [('target-sid', '/')]
            assert SocketSession.query.filter_by(user_id=target.id).count() == 0
            assert SocketSession.query.filter_by(user_id=other.id).count() == 1
            assert SSHSession.query.filter_by(user_id=target.id).count() == 0
            assert SSHSession.query.filter_by(user_id=other.id).count() == 1
            assert result == {
                'sockets': 1,
                'ssh_sessions': 1,
                'pool_connections': 2,
                'divergent_session_ids': [],
                'errors': [],
            }

            ssh_manager.sessions.clear()

    def test_admin_lock_revokes_user_access(self, app, client, monkeypatch):
        with app.app_context():
            admin = _create_user('admin')
            target = _create_user('locktarget')
            target_id = target.id
            assert admin.is_admin

        _login(client, 'admin')
        revoked = []

        import app.user_lifecycle as lifecycle
        monkeypatch.setattr(
            lifecycle,
            'revoke_user_access',
            lambda user_id, socketio_instance=None: revoked.append(user_id),
        )

        response = client.post(f'/admin/api/users/{target_id}/lock')

        assert response.status_code == 200
        assert response.get_json()['user']['is_locked'] is True
        assert revoked == [target_id]

    def test_logout_revokes_current_user_access(self, app, client, monkeypatch):
        with app.app_context():
            user = _create_user('logoutuser')
            user_id = user.id

        _login(client, 'logoutuser')
        revoked = []

        import app.user_lifecycle as lifecycle
        monkeypatch.setattr(
            lifecycle,
            'revoke_user_access',
            lambda user_id, socketio_instance=None: revoked.append(user_id),
        )

        response = client.post('/logout')

        assert response.status_code == 302
        assert revoked == [user_id]


class TestRevokeLocality:
    """S2 step 4 pins: foreign-process refusal, divergence, delete abort,
    expected_session forwarding. Fakes only — no Owner account, no real SSH,
    no tmux."""

    def _foreign_live_claim(self, app, monkeypatch):
        """Rewrite the claim to a DIFFERENT live incarnation and drop the held
        flag, so the locality gate sees a live foreign holder. Fixture cleanup
        restores the monkeypatched module globals automatically."""
        import os
        from app import worker_guard
        from app.models import WorkerClaim, db

        foreign_pid = os.getppid()
        with app.app_context():
            claim = db.session.get(WorkerClaim, worker_guard.CLAIM_ROW_ID)
            claim.boot_id = 'foreign-serving-boot'
            claim.pid = foreign_pid
            claim.pid_starttime = worker_guard._pid_starttime(foreign_pid)
            from datetime import datetime, timezone
            claim.heartbeat_at = datetime.now(timezone.utc)
            db.session.commit()
        monkeypatch.setattr(worker_guard, '_GUARD_HELD', False)
        monkeypatch.setattr(worker_guard, '_GUARD_PID', None)

    def test_foreign_process_revoke_refuses_loudly_and_touches_nothing(
            self, app, monkeypatch):
        """The capacity-incident pin: revoking from a process that is not the
        serving worker must fail LOUDLY -- never the old 0-closed-0-errors
        that looked like success."""
        from types import SimpleNamespace
        from app.models import db, SocketSession, SSHSession
        from app.user_lifecycle import revoke_user_access
        from app import ssh_manager

        with app.app_context():
            target = _create_user('foreign_target')
            db.session.add_all([
                SocketSession(user_id=target.id, socket_sid='foreign-sid'),
                SSHSession(session_id='foreign-ssh', user_id=target.id,
                           host='foreign.example', port=22, username='root'),
            ])
            db.session.commit()
            target_id = target.id

        self._foreign_live_claim(app, monkeypatch)

        close_calls = []
        monkeypatch.setattr(
            ssh_manager, 'close_session',
            lambda *a, **k: close_calls.append((a, k)) or True)
        server = _FakeSocketServer()

        with app.app_context():
            result = revoke_user_access(target_id, SimpleNamespace(server=server))

        assert any(e.startswith('locality:') for e in result['errors']), (
            f'no locality refusal in result: {result}')
        assert close_calls == [], 'a foreign process attempted a registry close'
        assert server.disconnected == [], (
            'a foreign process disconnected sockets it does not serve')
        with app.app_context():
            assert SocketSession.query.filter_by(user_id=target_id).count() == 1, (
                'a foreign process deleted DB rows')
            assert SSHSession.query.filter_by(user_id=target_id).count() == 1

    def test_connected_row_without_registry_entry_is_reported_not_silent(
            self, app, monkeypatch):
        """A connected DB row with no registry entry is reported honestly on
        ALL paths -- the divergence the incident hid behind an empty errors list."""
        from types import SimpleNamespace
        from app.models import db, SSHSession
        from app.user_lifecycle import revoke_user_access
        from app import ssh_manager

        with app.app_context():
            target = _create_user('divergent_target')
            db.session.add(SSHSession(
                session_id='divergent-ssh', user_id=target.id,
                host='divergent.example', port=22, username='root',
                connected=True))
            db.session.commit()
            target_id = target.id
            ssh_manager.sessions.clear()   # registry has nothing for this user

        with app.app_context():
            result = revoke_user_access(
                target_id, SimpleNamespace(server=_FakeSocketServer()))

        assert result['divergent_session_ids'] == ['divergent-ssh']
        assert any(e.startswith('divergence:divergent-ssh')
                   for e in result['errors'])
        assert result['ssh_sessions'] == 0, (
            'a nonexistent registry entry was counted as a closed session')
        ssh_manager.sessions.clear()

    def test_delete_user_account_aborts_on_locality_error(self, app, monkeypatch):
        """Deleting an account from a non-serving process must fail BEFORE
        quarantine/delete; the user row survives and nothing is quarantined."""
        import config
        from types import SimpleNamespace
        from app.models import db, User
        from app.user_lifecycle import delete_user_account

        with app.app_context():
            target = _create_user('abort_target')
            target_id = target.id

        self._foreign_live_claim(app, monkeypatch)

        with app.app_context():
            with pytest.raises(RuntimeError, match='outside the serving worker'):
                delete_user_account(
                    db.session.get(User, target_id),
                    SimpleNamespace(server=None))

        with app.app_context():
            assert db.session.get(User, target_id) is not None, (
                'the account was deleted despite the locality refusal')
        assert not list((config.DATA_DIR / 'deleted_users').glob(
            f'user_{target_id}_*')), (
            'quarantine happened despite the locality refusal')

    def test_revoke_forwards_expected_session_to_close(self, app, monkeypatch):
        """R3-A window in revoke: the identity captured under sessions_lock is
        the one passed to close_session, so a reused-id replacement cannot be
        closed by a revoke."""
        from types import SimpleNamespace
        from app.models import db, SSHSession
        from app.user_lifecycle import revoke_user_access
        from app import ssh_manager

        with app.app_context():
            target = _create_user('forward_target')
            target_id = target.id
            # Row matches the registry entry: no divergence noise in this pin.
            db.session.add(SSHSession(
                session_id='forward-ssh', user_id=target.id,
                host='forward.example', port=22, username='root',
                connected=True))
            db.session.commit()

        captured = {}
        session_obj = {'user_id': target_id, 'connected': True}
        ssh_manager.sessions.clear()
        ssh_manager.sessions['forward-ssh'] = session_obj

        def recording_close(session_id, kill_tmux=False, expected_session=None):
            captured['session_id'] = session_id
            captured['kill_tmux'] = kill_tmux
            captured['expected_session'] = expected_session
            ssh_manager.sessions.pop(session_id, None)
            return True

        monkeypatch.setattr(ssh_manager, 'close_session', recording_close)

        with app.app_context():
            result = revoke_user_access(
                target_id, SimpleNamespace(server=_FakeSocketServer()))

        assert result['ssh_sessions'] == 1
        assert captured['session_id'] == 'forward-ssh'
        assert captured['kill_tmux'] is True
        assert captured['expected_session'] is session_obj, (
            'revoke did not forward the identity it captured under the lock')
        ssh_manager.sessions.clear()


class TestSafeUserDeletion:
    def test_deleted_user_data_is_quarantined_and_not_inherited(self, app, client):
        with app.app_context():
            from app.models import db

            admin = _create_user('deleteadmin')
            target = _create_user('deletetarget')
            target_id = target.id
            target_data_dir = target.get_data_dir()
            (target_data_dir / 'private-marker.txt').write_text(
                'must-not-be-inherited',
                encoding='utf-8',
            )
            assert admin.is_admin

        _login(client, 'deleteadmin')
        response = client.post(f'/admin/api/users/{target_id}/delete')

        assert response.status_code == 200
        with app.app_context():
            import config
            from app.auth import register_user
            from app.models import db, User

            assert db.session.get(User, target_id) is None
            assert not target_data_dir.exists()

            quarantined = list(
                (config.DATA_DIR / 'deleted_users').glob(f'user_{target_id}_*')
            )
            assert len(quarantined) == 1
            assert (quarantined[0] / 'private-marker.txt').read_text(
                encoding='utf-8'
            ) == 'must-not-be-inherited'

            replacement, error = register_user('replacement', 'password123')
            assert error is None
            assert replacement.id == target_id
            assert not (replacement.get_data_dir() / 'private-marker.txt').exists()

    def test_failed_database_delete_restores_quarantined_data(
        self, app, monkeypatch
    ):
        with app.app_context():
            from app.models import db, User
            import app.user_lifecycle as lifecycle

            target = _create_user('restoretarget')
            target_id = target.id
            target.is_locked = True
            target_data_dir = target.get_data_dir()
            marker = target_data_dir / 'restore-marker.txt'
            marker.write_text('restore-me', encoding='utf-8')
            db.session.commit()

            monkeypatch.setattr(
                lifecycle,
                'revoke_user_access',
                lambda user_id, socketio_instance=None: None,
            )
            monkeypatch.setattr(
                db.session,
                'commit',
                lambda: (_ for _ in ()).throw(RuntimeError('forced commit failure')),
            )

            with pytest.raises(RuntimeError, match='forced commit failure'):
                lifecycle.delete_user_account(target, SimpleNamespace(server=None))

            assert db.session.get(User, target_id) is not None
            assert db.session.get(User, target_id).is_locked is True
            assert marker.read_text(encoding='utf-8') == 'restore-me'
