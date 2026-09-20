"""The licence notice has to be visible on a RUNNING deployment.

The PolyForm Noncommercial License makes one thing an obligation rather than a
courtesy: whoever passes the software on must pass on the lines the licensor
marked `Required Notice:`. A notice that only exists in a file inside a
container proves nothing about a deployment you can see only from outside, so
it is published on three surfaces that an operator cannot serve the product
without -- and each of them is pinned here, because "nobody removed it" is not
something a reader can check by looking at the source.

These tests also pin the notice AGAINST `LICENSE`. One copy of the words is
governing and the others are duplicates; if they drift, the duplicates are what
a court would be shown, so drift is the failure mode worth catching.
"""
from pathlib import Path

from app.version import (COMMERCIAL_CONTACT, LICENSE_ID, LICENSE_NAME,
                         PROJECT_NAME, REQUIRED_NOTICE, SOURCE_URL, VERSION,
                         notice_payload)

ROOT = Path(__file__).resolve().parent.parent
# /change-password sits behind the login, so an anonymous client is
# redirected before it renders. Its copy of the notice is pinned by
# test_one_partial_feeds_all_three_pages instead.
PUBLIC_AUTH_PAGES = ('/login', '/register')


def test_the_notice_matches_the_licence_word_for_word():
    """LICENSE is the governing copy. app/version.py must quote it exactly."""
    first_line = (ROOT / 'LICENSE').read_text(encoding='utf-8').splitlines()[0]
    assert first_line == REQUIRED_NOTICE
    assert first_line.startswith('Required Notice:')


def test_the_licence_is_the_one_the_project_claims():
    licence = (ROOT / 'LICENSE').read_text(encoding='utf-8')
    assert '# PolyForm Noncommercial License 1.0.0' in licence
    assert LICENSE_NAME in licence
    # The permission that makes the whole thing work, quoted from the licence
    # itself: if this sentence ever leaves the file, the terms changed.
    assert 'Any noncommercial purpose is a permitted purpose.' in licence


def test_the_upstream_notice_is_still_carried():
    """MIT's one condition. Dropping it would be infringement by us."""
    upstream = (ROOT / 'UPSTREAM-MIT-LICENSE.txt').read_text(encoding='utf-8')
    assert 'MIT License' in upstream
    assert 'H31mdall' in upstream
    assert 'The above copyright notice and this permission notice' in upstream
    assert 'UPSTREAM-MIT-LICENSE.txt' in (ROOT / 'LICENSE').read_text(encoding='utf-8')


def test_every_third_party_notice_is_present_and_not_empty():
    """static/vendor/ once shipped four libraries with their notices stripped,
    which MIT and BSD both forbid. This is the tripwire for that recurring."""
    for rel in ('NOTICE.md',
                'static/vendor/xterm/LICENSE',
                'static/vendor/highlight/LICENSE',
                'static/vendor/socketio/LICENSE',
                'static/vendor/material-icons/LICENSE'):
        body = (ROOT / rel).read_text(encoding='utf-8')
        assert len(body) > 200, rel
    notice = (ROOT / 'NOTICE.md').read_text(encoding='utf-8')
    # Paramiko is the one copyleft dependency; the right to replace it is a
    # right the LGPL gives the user and one our licence must not erode.
    assert 'LGPL-2.1' in notice
    assert 'You may replace it.' in notice


def test_there_is_a_published_way_to_buy_a_commercial_licence():
    """'Commercial use needs a licence' is an empty sentence without one."""
    commercial = (ROOT / 'COMMERCIAL.md').read_text(encoding='utf-8')
    assert COMMERCIAL_CONTACT in commercial
    assert 'COMMERCIAL.md' in (ROOT / 'LICENSE').read_text(encoding='utf-8')


def test_api_version_answers_without_an_account(client):
    """A notice nobody can read without signing in is not a notice."""
    response = client.get('/api/version')
    assert response.status_code == 200
    body = response.get_json()
    assert body == notice_payload()
    assert body['required_notice'] == REQUIRED_NOTICE
    assert body['name'] == PROJECT_NAME
    assert body['version'] == VERSION
    assert body['license'] == LICENSE_ID
    assert body['source'] == SOURCE_URL
    assert body['commercial_licence_contact'] == COMMERCIAL_CONTACT


def test_api_version_tells_nothing_about_the_deployment(client):
    """It describes the software, not the machine running it."""
    body = client.get('/api/version').get_json()
    assert set(body) == {
        'name', 'version', 'license', 'license_name', 'license_url',
        'required_notice', 'source', 'commercial_licence_contact',
    }


def test_the_notice_rides_every_response(client):
    for path in ('/api/version', '/login', '/register', '/nope-404'):
        response = client.get(path)
        assert response.headers.get('X-SSHDeck-Notice') == REQUIRED_NOTICE, path


def test_the_sign_in_pages_show_the_notice(client):
    """The one page a hosted SSHDeck must show the public."""
    for path in PUBLIC_AUTH_PAGES:
        page = client.get(path).get_data(as_text=True)
        assert REQUIRED_NOTICE in page, path
        assert LICENSE_NAME in page, path
        assert f'{PROJECT_NAME} {VERSION}' in page, path


def test_the_notice_is_plain_text_at_rest(client):
    """Not a link, not a hover state, not a dialog.

    auth_pages_v5.mjs holds every `a[href]` to a 44px target at every touch
    viewport, which an 11px citation cannot honestly meet -- and a notice does
    not need to be clickable to be read, copied or screenshotted.
    """
    page = client.get('/login').get_data(as_text=True)
    start = page.index('a5-notice')
    block = page[start:page.index('</p>', start)]
    assert '<a ' not in block
    assert 'href' not in block


def test_one_partial_feeds_all_three_pages():
    """So a change that drops the notice is a diff against one obvious file."""
    partial = ROOT / 'templates' / '_notice_footer.html'
    assert 'notice.required_notice' in partial.read_text(encoding='utf-8')
    for page in ('login.html', 'register.html', 'change_password.html'):
        body = (ROOT / 'templates' / page).read_text(encoding='utf-8')
        assert "{% include '_notice_footer.html' %}" in body, page
