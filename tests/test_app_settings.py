"""Admin-editable limits.

Every limit is a typed, bounded key in `app_settings.SETTINGS`; a saved value
is applied to the `config` module at once and again at boot, and the value
the process started with stays the default a reset returns to.
"""
import json

import pytest

import config
from app import app_settings
from app.models import User, db


@pytest.fixture(autouse=True)
def restore_config(app):
    """Every test starts from the environment defaults and leaves them behind."""
    with app.app_context():
        app_settings.reset()
    yield
    with app.app_context():
        app_settings.reset()


def test_every_setting_reports_its_environment_default(app):
    with app.app_context():
        rows = {row['key']: row for row in app_settings.describe()}
    assert set(rows) == set(app_settings.SETTINGS)
    assert rows['max_sessions']['value'] == config.MAX_SESSIONS
    assert rows['max_sessions']['default'] == app_settings.env_default('max_sessions')
    assert rows['max_sessions']['overridden'] is False
    assert rows['session_timeout']['unit'] == 'seconds'
    assert rows['ssh_connect_ratelimit']['type'] == 'rate'


def test_a_saved_value_is_applied_at_once_and_persisted(app):
    with app.app_context():
        ok, errors = app_settings.update({'max_sessions_per_user': 7,
                                          'ssh_connect_ratelimit': '12 per hour',
                                          'ratelimit_enabled': False}, actor='tester')
        assert (ok, errors) == (True, {})
        assert config.MAX_SESSIONS_PER_USER == 7
        assert config.RATELIMIT_SSH_CONNECT == '12 per hour'
        assert config.RATELIMIT_ENABLED is False
        saved = json.load(open(config.DATA_DIR / 'app_settings.json'))
        assert saved['max_sessions_per_user'] == 7
        rows = {row['key']: row for row in app_settings.describe()}
        assert rows['max_sessions_per_user']['overridden'] is True


def test_a_refused_body_changes_nothing(app):
    with app.app_context():
        before = config.MAX_SESSIONS
        ok, errors = app_settings.update({'max_sessions': 5000,
                                          'max_views_per_session': 4})
        assert ok is False
        assert 'max_sessions' in errors
        assert config.MAX_SESSIONS == before
        assert config.MAX_VIEWS_PER_SESSION != 4


@pytest.mark.parametrize('key, value', [
    ('max_sessions', 0), ('max_sessions', 'ten'), ('max_sessions', True),
    ('max_views_per_session', 65), ('session_timeout', 30),
    ('ssh_connect_ratelimit', '60/minute'), ('ssh_connect_ratelimit', '0 per minute'),
    ('login_ratelimit', 5), ('ratelimit_enabled', 'maybe'), ('nonsense', 1),
])
def test_bounds_and_shapes_are_enforced(key, value):
    ok, _reason = app_settings.coerce(key, value)
    assert ok is False


def test_boot_applies_the_saved_file(app):
    with app.app_context():
        app_settings.update({'max_sessions': 42})
        setattr(config, 'MAX_SESSIONS', 1)   # a fresh process starts from env
        with open(config.DATA_DIR / 'app_settings.json', 'r+', encoding='utf-8') as f:
            data = json.load(f)
            data['max_views_per_session'] = 'broken'
            f.seek(0); f.truncate(); json.dump(data, f)
        assert app_settings.apply_saved() == ['max_sessions']
        assert config.MAX_SESSIONS == 42


def test_reset_returns_to_the_environment_default(app):
    with app.app_context():
        default = app_settings.env_default('session_timeout')
        app_settings.update({'session_timeout': 600})
        assert config.SESSION_TIMEOUT == 600
        app_settings.reset(['session_timeout'])
        assert config.SESSION_TIMEOUT == default
        assert 'session_timeout' not in json.load(open(config.DATA_DIR / 'app_settings.json'))


def test_registration_helpers_keep_their_shape(app):
    with app.app_context():
        assert app_settings.set_registration_enabled(False) is False
        assert app_settings.is_registration_enabled() is False
        assert config.REGISTRATION_ENABLED is False


# ---- the admin routes ------------------------------------------------------

def _admin_client(app, client, username='limits_admin'):
    from app.auth import register_user
    with app.app_context():
        user, error = register_user(username, 'admin-password-123')
        assert error is None, error
        user.is_admin = True
        db.session.commit()
    assert client.post('/login', data={'username': username,
                                       'password': 'admin-password-123'}).status_code == 302
    return client


def test_admin_reads_the_table_and_the_legacy_flag(app, client):
    _admin_client(app, client)
    data = client.get('/admin/api/settings').get_json()
    assert 'registration_enabled' in data
    assert {row['key'] for row in data['settings']} == set(app_settings.SETTINGS)


def test_admin_saves_valid_changes_and_is_refused_invalid_ones(app, client):
    _admin_client(app, client)
    ok = client.post('/admin/api/settings', json={'max_sessions': 33,
                                                  'login_ratelimit': '9 per minute'})
    assert ok.status_code == 200
    assert config.MAX_SESSIONS == 33
    rows = {row['key']: row for row in ok.get_json()['settings']}
    assert rows['login_ratelimit']['value'] == '9 per minute'
    bad = client.post('/admin/api/settings', json={'max_sessions': -1, 'bogus': 1})
    assert bad.status_code == 400
    assert set(bad.get_json()['errors']) == {'max_sessions', 'bogus'}
    assert config.MAX_SESSIONS == 33
    reset = client.post('/admin/api/settings', json={'reset': 'all'})
    assert reset.status_code == 200
    assert config.MAX_SESSIONS == app_settings.env_default('max_sessions')


def test_a_non_admin_cannot_touch_the_table(app, client):
    from app.auth import register_user
    with app.app_context():
        # The first user ever registered becomes admin (auth.py), so the
        # plain user must be the second one.
        _first, error = register_user('limits_first_admin', 'admin-password-123')
        assert error is None
        user, error = register_user('limits_user', 'user-password-123')
        assert error is None
        assert not user.is_admin
    client.post('/login', data={'username': 'limits_user', 'password': 'user-password-123'})
    assert client.post('/admin/api/settings', json={'max_sessions': 3}).status_code in (302, 403)
    assert config.MAX_SESSIONS != 3
