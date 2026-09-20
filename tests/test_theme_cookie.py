"""The sign-in page renders the reader's theme, not always `glass`.

/login and /register have no user to look up, so they used to render the
default theme whatever the reader had chosen -- the one surface that could not
match the rest of the product. header-menus.js writes a `theme` cookie whenever
a theme is picked and index.html re-writes it from the saved setting, so the
server can read it exactly as it already reads `lang`.
"""
import re
from pathlib import Path

from app.user_settings import VALID_THEMES

ROOT = Path(__file__).resolve().parent.parent


def test_the_theme_list_lives_in_one_place():
    """Two readers, one list: the socket handler that saves a theme and the
    route that validates the cookie."""
    assert len(VALID_THEMES) == 10
    assert VALID_THEMES[0] == 'glass'
    events = (ROOT / 'app' / 'socket_events.py').read_text(encoding='utf-8')
    assert 'theme not in VALID_THEMES' in events
    assert "'arctic-ice'" not in events, 'the handler kept its own copy of the list'


def test_login_renders_the_theme_from_the_cookie(client):
    for theme in VALID_THEMES:
        client.set_cookie('theme', theme)
        page = client.get('/login').get_data(as_text=True)
        assert f'data-theme="{theme}"' in page, theme


def test_an_unknown_theme_falls_back_instead_of_reaching_the_page(client):
    for bogus in ('evil', '', 'glass; rm -rf', 'GLASS'):
        client.set_cookie('theme', bogus)
        page = client.get('/login').get_data(as_text=True)
        assert 'data-theme="glass"' in page, bogus


def test_register_reads_it_too(client):
    client.set_cookie('theme', 'noir')
    page = client.get('/register').get_data(as_text=True)
    assert 'data-theme="noir"' in page


def test_the_app_page_hands_the_saved_theme_to_the_browser(app, client):
    """A browser that has never picked a theme still learns the saved one, so
    the next visit to /login already matches."""
    from app.models import db, User
    with app.app_context():
        user = User(username='themer', is_admin=False)
        user.set_password('correct-horse-battery')
        db.session.add(user)
        db.session.commit()
        from app.user_settings import save_user_settings
        save_user_settings(user.id, {'theme': 'noir'})
        user_id = user.id

    with client.session_transaction() as session:
        session['_user_id'] = str(user_id)
        session['_fresh'] = True

    response = client.get('/')
    cookies = response.headers.getlist('Set-Cookie')
    assert any(c.startswith('theme=noir') for c in cookies), cookies


def test_the_picker_writes_the_cookie():
    source = (ROOT / 'static' / 'js' / 'header-menus.js').read_text(encoding='utf-8')
    block = source[source.index('function applyTheme(themeId)'):]
    block = block[:block.index('\n    }')]
    assert 'document.cookie' in block
    assert 'max-age=31536000' in block
    assert 'SameSite=Lax' in block
