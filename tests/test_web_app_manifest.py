"""SSHDeck installs as an app: one manifest, linked from every page.

static/app.webmanifest is what lets Chrome on Android and desktop offer
"Install app", and what iOS reads for the home-screen name and the standalone
window. Its URLs are RELATIVE to the manifest so the one static file is right
under any mount point: the manifest is served from <root>/static/, so "../"
is the app's root whether that is "/" or "/deck/". No service worker: an SSH
workspace has nothing to do offline, and Chrome no longer requires one to
install from the menu.
"""
import json
import re
import struct
from pathlib import Path
from urllib.parse import urljoin

import pytest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / 'static'
MANIFEST = STATIC / 'app.webmanifest'
TEMPLATES = ('index.html', 'login.html', 'register.html')
LINK = re.compile(r'<link rel="manifest" href="\{\{ url_for\(\'static\', '
                  r'filename=\'app\.webmanifest\'\) \}\}\?v=(\d+)">')


def manifest():
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b'\x89PNG\r\n\x1a\n', path.name
    return struct.unpack('>II', head[16:24])


def test_the_manifest_declares_a_standalone_app():
    data = manifest()
    assert data['name'] == 'SSHDeck'
    assert data['short_name'] == 'SSHDeck'
    assert data['display'] == 'standalone'
    for key in ('background_color', 'theme_color'):
        assert re.fullmatch(r'#[0-9a-f]{6}', data[key]), key


def test_its_urls_are_relative_so_any_mount_point_works():
    data = manifest()
    for key in ('id', 'start_url', 'scope'):
        assert data[key] == '../', key
    for prefix in ('/', '/deck/'):
        at = f'https://example.test{prefix}static/app.webmanifest?v=1'
        assert urljoin(at, data['start_url']) == f'https://example.test{prefix}'


def test_every_icon_exists_at_its_declared_size():
    icons = manifest()['icons']
    purposes = set()
    for icon in icons:
        path = STATIC / icon['src'].split('?')[0]
        width, height = png_size(path)
        assert icon['sizes'] == f'{width}x{height}', icon['src']
        assert icon['type'] == 'image/png'
        purposes.add((icon['purpose'], icon['sizes']))
    # Chrome needs a 192 and a 512; Android crops a launcher icon to the
    # maskable one when it is there.
    assert {('any', '192x192'), ('any', '512x512'), ('maskable', '512x512')} <= purposes


def test_every_page_links_it_once_with_one_pin():
    pins = set()
    for name in TEMPLATES:
        source = (ROOT / 'templates' / name).read_text(encoding='utf-8')
        found = LINK.findall(source)
        assert len(found) == 1, name
        pins.update(found)
    assert len(pins) == 1, pins


@pytest.mark.parametrize('base', ['http://localhost/', 'http://localhost/deck/'])
def test_the_login_page_reaches_the_manifest_and_it_points_home(client, base):
    page = client.get('/login', base_url=base)
    assert page.status_code == 200
    href = re.search(r'<link rel="manifest" href="([^"]+)"', page.get_data(as_text=True))
    assert href, 'no manifest link on the login page'
    url = urljoin(base + 'login', href.group(1))
    assert url.startswith(base + 'static/'), url
    # Werkzeug's test client mounts the app at base_url; the path is the rest.
    served = client.get('/' + url[len(base):].split('?')[0], base_url=base)
    assert served.status_code == 200
    assert served.mimetype == 'application/manifest+json'
    data = json.loads(served.get_data(as_text=True))
    assert urljoin(url, data['start_url']) == base
