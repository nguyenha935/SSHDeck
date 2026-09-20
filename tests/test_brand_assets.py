"""The brand mark: one artwork, four deliveries, no drift.

The owner delivered a pearl-black and a pearl-white mark (SVG + PNG 512) on
. They are vendored under static/icons/ and everything else is
derived from them: the inline symbol the pages use, the favicon, and the raster
icons scripts/build_brand_icons.py writes. These rows exist so a later edit
cannot leave one of those copies behind.
"""
import re
import xml.dom.minidom
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'static' / 'icons'
TEMPLATES = ('index.html', 'login.html', 'register.html', 'change_password.html',
             'admin.html')


def test_the_delivered_artwork_is_vendored():
    for name in ('brand-black.svg', 'brand-white.svg',
                 'brand-512-black.png', 'brand-512-white.png'):
        asset = ICONS / name
        assert asset.exists(), name
        assert asset.stat().st_size > 1000, name


def test_the_inline_symbol_is_the_delivered_geometry():
    """Same path data as the shipped SVG: the symbol is a recolouring, not a
    redraw. Compared on the `d` attributes, which are the drawing."""
    source = (ICONS / 'brand-black.svg').read_text(encoding='utf-8')
    symbol = (ROOT / 'templates' / '_brand_symbol.html').read_text(encoding='utf-8')
    paths = re.findall(r'\sd="([^"]+)"', source)
    assert paths, 'the delivered artwork has no path data'
    for d in paths:
        assert d in symbol, 'the symbol has drifted from the delivered artwork'


def test_the_symbol_paints_only_with_currentcolor():
    """The whole point: `color` decides, so the ten themes decide. A literal
    here would freeze the mark to one of them."""
    symbol = (ROOT / 'templates' / '_brand_symbol.html').read_text(encoding='utf-8')
    body = re.sub(r'<!--.*?-->', '', symbol, flags=re.S)
    assert not re.search(r'#[0-9a-fA-F]{3,8}\b', body), 'a literal colour in the symbol'
    assert 'currentColor' in body
    assert 'id="icon-brand"' in body


def test_every_page_includes_the_symbol_and_uses_it_once():
    for name in TEMPLATES:
        source = (ROOT / 'templates' / name).read_text(encoding='utf-8')
        assert "{% include '_brand_symbol.html' %}" in source, name
        assert source.count('href="#icon-brand"') == 1, name


def test_the_old_glyph_is_no_longer_a_brand_mark():
    """icon-square-terminal stays in the sprite -- profile-manager.js paints an
    empty pane with it -- but no page may still use it as the logo."""
    for name in TEMPLATES:
        source = (ROOT / 'templates' / name).read_text(encoding='utf-8')
        assert 'icon-square-terminal' not in source, name


def test_the_favicon_is_valid_xml_and_switches_with_the_os_theme():
    """Entry 27: a double hyphen inside an XML comment made an earlier
    favicon unparseable and Chromium silently refused it."""
    favicon = ICONS / 'favicon.svg'
    xml.dom.minidom.parse(str(favicon))
    text = favicon.read_text(encoding='utf-8')
    assert 'prefers-color-scheme: dark' in text
    assert '#000000' in text and '#FFFFFF' in text
    for comment in re.findall(r'<!--(.*?)-->', text, flags=re.S):
        assert '--' not in comment, 'a double hyphen inside an XML comment'


def test_the_raster_icons_are_present_and_derived_by_a_committed_script():
    touch = ICONS / 'apple-touch-icon.png'
    ico = ICONS / 'favicon.ico'
    assert touch.exists() and ico.exists()
    script = ROOT / 'scripts' / 'build_brand_icons.py'
    assert script.exists(), 'the raster icons must be reproducible'
    source = script.read_text(encoding='utf-8')
    assert 'brand-512-white.png' in source
    assert 'apple-touch-icon.png' in source and 'favicon.ico' in source


def test_apple_touch_icon_is_opaque_and_the_right_size():
    """iOS composites a transparent icon onto white, which would erase a white
    mark, and it applies its own corner mask."""
    Image = pytest.importorskip('PIL.Image', reason='Pillow is a workstation tool')
    with Image.open(ICONS / 'apple-touch-icon.png') as img:
        assert img.size == (180, 180)
        assert img.mode in ('RGB', 'P'), 'the home-screen icon must be opaque'


def test_the_tab_icon_is_the_glyph_and_its_pin_moved_with_it():
    """The tab icon is the routes on a transparent ground, not the filled plate.

    v2 shipped the plate and read as a black square with a hard edge in a tab
    strip. Changing the bytes without moving the pin would
    leave every browser that already has v2 showing the old square, which is
    the whole reason these pins exist, so the pin is checked here beside the
    content it names.
    """
    favicon = (ICONS / 'favicon.svg').read_text(encoding='utf-8')
    assert '<rect' not in favicon, 'the tab icon must not carry the plate'
    assert 'currentColor' in favicon
    for name in TEMPLATES:
        source = (ROOT / 'templates' / name).read_text(encoding='utf-8')
        for asset in ('favicon.svg', 'favicon.ico', 'apple-touch-icon.png'):
            assert f"filename='icons/{asset}') }}}}?v=3" in source, (name, asset)
