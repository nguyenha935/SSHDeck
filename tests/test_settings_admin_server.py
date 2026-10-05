"""Administration inside Settings: what the server owns.

The /admin page is gone (owner ruling 2026-10-05: one Settings in the app).
Its address now lands on Settings → Users, the administration sections and
their script reach an administrator's page only, and the settings API answers
a malformed body with 400 -- a reset that was not a list used to raise a
TypeError (`**_settings_payload` without the call) and answer 500.
"""
import re
from pathlib import Path

import pytest

from app import app_settings
from tests.locale_sources import LOCALES, locale_source

PASSWORD = 'pw-123456789'


@pytest.fixture
def accounts(app):
    with app.app_context():
        from app.auth import register_user
        # The first account on a fresh database is the bootstrap admin.
        admin, err = register_user('setadmin', PASSWORD)
        assert err is None and admin.is_admin
        user, err = register_user('setuser', PASSWORD)
        assert err is None and not user.is_admin
        app_settings.reset()
    yield
    with app.app_context():
        app_settings.reset()


def sign_in(client, username):
    assert client.post('/login', data={'username': username,
                                       'password': PASSWORD}).status_code == 302
    return client


def test_the_old_admin_address_opens_settings_on_users(accounts, client):
    response = sign_in(client, 'setadmin').get('/admin')
    assert response.status_code == 302
    assert response.headers['Location'].endswith('/#settings/users')


def test_the_old_admin_address_still_refuses_a_user(accounts, client):
    assert sign_in(client, 'setuser').get('/admin').status_code == 403


def test_the_old_admin_address_asks_to_sign_in_first(accounts, client):
    response = client.get('/admin')
    assert response.status_code == 302
    assert '/login' in response.headers['Location']


def test_only_an_administrator_page_carries_administration(accounts, app):
    from flask import g
    pages = {}
    for name in ('setadmin', 'setuser'):
        # The `app` fixture holds an app context, which every request reuses,
        # so Flask-Login's cached user would carry over to the next account.
        g.pop('_login_user', None)
        pages[name] = sign_in(app.test_client(), name).get('/').get_data(as_text=True)
    for marker in ('js/settings-admin.js', 'id="sv-users"', 'id="sv-sessions"',
                   'id="sv-audit"', 'id="sv-system"'):
        assert marker in pages['setadmin'], marker
        assert marker not in pages['setuser'], marker
    # The account menu has no separate administration entry any more.
    assert 'adminPanelBtn' not in pages['setadmin']


@pytest.mark.parametrize('body', [
    [1, 2],                      # not an object
    'reset',                     # not an object
    {'reset': 'everything'},     # neither "all" nor a list -- the old 500
    {'reset': [1]},              # a list, but not of keys
    {'reset': {'max_sessions': 1}},
])
def test_a_malformed_settings_body_is_refused_with_400(accounts, client, body):
    response = sign_in(client, 'setadmin').post('/admin/api/settings', json=body)
    assert response.status_code == 400
    reply = response.get_json()
    assert reply['errors']
    # The refusal still carries the table, so the page can redraw from it.
    assert {row['key'] for row in reply['settings']} == set(app_settings.SETTINGS)


def test_a_reset_of_named_keys_still_works(accounts, client, app):
    sign_in(client, 'setadmin')
    assert client.post('/admin/api/settings', json={'max_sessions': 7}).status_code == 200
    response = client.post('/admin/api/settings', json={'reset': ['max_sessions']})
    assert response.status_code == 200
    row = next(r for r in response.get_json()['settings'] if r['key'] == 'max_sessions')
    assert (row['overridden'], row['value']) == (False, row['default'])


def test_user_times_name_their_zone(accounts, client, app):
    """SQLite gives the column back without its zone; the API names it UTC.

    Measured on prod: users.last_login read back as '2026-10-03 08:50:25' for a
    sign-in at 15:50 in Vietnam, and the page parsed it as local time.
    """
    from datetime import datetime
    sign_in(client, 'setadmin')
    rows = client.get('/admin/api/users').get_json()['users']
    admin = next(row for row in rows if row['username'] == 'setadmin')
    for field in ('created_at', 'last_login'):
        moment = datetime.fromisoformat(admin[field])
        assert moment.utcoffset() is not None and moment.utcoffset().total_seconds() == 0, field


def test_every_string_the_administration_sections_use_is_in_every_locale():
    source = Path('static/js/settings-admin.js').read_text(encoding='utf-8')
    keys = set(re.findall(r"'((?:admin|settings|common)\.[A-Za-z0-9_.]+)'", source))
    # The keys the script builds rather than names.
    families = {
        '`admin.done_${action}`': [f'admin.done_{a}' for a in
                                   ('promote', 'demote', 'lock', 'unlock', 'delete')],
        '`admin.per_${': [f'admin.per_{u}' for u in ('second', 'minute', 'hour')],
        '`admin.set.${key}`': [f'admin.set.{k}' for k in app_settings.SETTINGS
                               if k != 'registration_enabled'],
        '`admin.set.${key}Hint`': [f'admin.set.{k}Hint' for k in app_settings.SETTINGS
                                   if k != 'registration_enabled'],
    }
    for pattern, built in families.items():
        assert pattern in source, pattern
        keys.update(built)
    assert len(keys) > 60
    for locale in LOCALES:
        text = locale_source(locale)
        missing = sorted(key for key in keys if f"'{key}':" not in text)
        assert not missing, (locale, missing)
