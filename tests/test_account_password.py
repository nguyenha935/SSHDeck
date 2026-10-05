"""Changing one's own password from Settings → Account (POST /api/account/password).

The form page /change-password is gone (owner ruling 2026-10-05: one Settings
in the app); its checks, their order, the rate limit and the audit record moved
to this endpoint unchanged. A refusal names the field and a reason code, so the
page can word it in the reader's language.
"""
import pytest

PASSWORD = 'current-password'


@pytest.fixture
def signed_in(app, client):
    with app.app_context():
        from app.auth import register_user
        register_user('pwuser', PASSWORD)
    response = client.post('/login', data={'username': 'pwuser', 'password': PASSWORD})
    assert response.status_code == 302
    return client


def change(client, current=PASSWORD, new='brand-new-password', confirm=None):
    return client.post('/api/account/password', json={
        'current_password': current,
        'new_password': new,
        'confirm_password': new if confirm is None else confirm,
    })


def password_is(app, password):
    with app.app_context():
        from app.models import User
        return User.query.filter_by(username='pwuser').one().check_password(password)


def test_the_password_changes_and_is_audited(app, signed_in, monkeypatch):
    import app as app_module
    audited = []
    monkeypatch.setattr(app_module, 'log_password_change',
                        lambda user, ok, ip: audited.append((user, ok)))
    response = change(signed_in)
    assert (response.status_code, response.get_json()) == (200, {'ok': True})
    assert password_is(app, 'brand-new-password')
    assert audited == [('pwuser', True)]


@pytest.mark.parametrize('kwargs, field, error, extra', [
    ({'current': 'not-the-password'}, 'current_password', 'incorrect', {}),
    ({'confirm': 'something-else-1'}, 'confirm_password', 'mismatch', {}),
    ({'new': 'short'}, 'new_password', 'too_short', {'min': 8}),
    ({'new': PASSWORD}, 'new_password', 'unchanged', {}),
])
def test_a_refusal_names_the_field_and_changes_nothing(app, signed_in, kwargs, field, error, extra):
    response = change(signed_in, **kwargs)
    assert response.status_code == 400
    assert response.get_json() == {'field': field, 'error': error, **extra}
    assert password_is(app, PASSWORD)


def test_the_current_password_is_checked_before_anything_else(app, signed_in):
    # The form's order: a wrong current password is reported even when the
    # new pair is also wrong, so the endpoint does not confirm what is checked.
    response = change(signed_in, current='not-the-password', new='x', confirm='y')
    assert response.get_json()['field'] == 'current_password'


@pytest.mark.parametrize('body', [{}, {'current_password': PASSWORD},
                                  {'current_password': 1, 'new_password': 2, 'confirm_password': 3}])
def test_a_malformed_body_is_refused(app, signed_in, body):
    response = signed_in.post('/api/account/password', json=body)
    assert (response.status_code, response.get_json()) == (400, {'error': 'invalid'})
    assert password_is(app, PASSWORD)


def test_past_the_rate_limit_nothing_is_checked(app, signed_in, monkeypatch):
    import app as app_module
    import config
    monkeypatch.setattr(config, 'RATELIMIT_ENABLED', True)
    monkeypatch.setattr(app_module, 'check_rate_limit', lambda *args: True)
    response = change(signed_in)
    assert (response.status_code, response.get_json()) == (429, {'error': 'rate_limited'})
    assert password_is(app, PASSWORD)


def test_signed_out_it_does_nothing(app, client):
    with app.app_context():
        from app.auth import register_user
        register_user('pwuser', PASSWORD)
    response = change(client)
    assert response.status_code in (302, 401)
    assert password_is(app, PASSWORD)


def test_without_the_csrf_token_it_is_refused(app, signed_in):
    app.config['WTF_CSRF_ENABLED'] = True
    try:
        response = change(signed_in)
    finally:
        app.config['WTF_CSRF_ENABLED'] = False
    assert response.status_code == 400
    assert password_is(app, PASSWORD)


def test_the_old_page_opens_settings_at_account(signed_in):
    response = signed_in.get('/change-password')
    assert response.status_code == 302
    assert response.headers['Location'].endswith('/#settings/account')
