"""Every icon the app names exists in the sprite.

The move from Ant Design to the Lucide sprite renamed every `#icon-...` written
out in markup, but not the names sftp-file-manager.js assembles at run time:
getFileIcon returned code / picture / key / file-text and the context menu asked
for swap / edit / folder-add / reload / delete. None is a symbol, so those file
rows and five of a file's seven menu entries drew an empty box (measured
2026-10-02 in files_panel.mjs: 5 of its 12 files). Nothing checked the names a
script builds, only those a template writes, so this test reads both.

Each "nothing unknown" assertion has a floor beside it -- a pattern that stopped
matching would otherwise pass by finding nothing.
"""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SPRITE = REPO / 'static/icons/icons.svg'
MANIFEST = REPO / 'static/icons/manifest.json'
NAME = r'[a-z0-9]+(?:-[a-z0-9]+)*'


def _sprite_symbols():
    return set(re.findall(r'<symbol id="icon-(%s)"' % NAME, SPRITE.read_text()))


def _scripts():
    return [p for p in sorted((REPO / 'static/js').glob('*.js'))]


def _templates():
    return sorted((REPO / 'templates').glob('*.html'))


def _call_arguments(source, function):
    """The text of the first argument of every `function(` call in source."""
    for match in re.finditer(r'\b%s\(' % re.escape(function), source):
        depth, i = 1, match.end()
        while True:
            if source[i] in '([{':
                depth += 1
            elif source[i] in ')]}':
                depth -= 1
                if depth == 0:
                    break
            elif source[i] == ',' and depth == 1:
                break
            i += 1
        yield source[match.end():i].strip()


def test_the_manifest_lists_exactly_the_sprites_symbols():
    manifest = json.loads(MANIFEST.read_text())
    symbols = _sprite_symbols()
    assert len(symbols) >= 60
    assert sorted(manifest['symbols']) == sorted('icon-' + name for name in symbols)


def test_every_icon_written_in_markup_or_script_exists():
    symbols = _sprite_symbols()
    named = {}
    for path in _templates() + _scripts():
        # `#icon-${name}` is assembled at run time; the next test covers it.
        # The lookahead takes the whole name: without a-z0-9 in it, the
        # `chevron` of `#icon-chevron-${...}` backtracked into `chevro`.
        # href="#icon-..." is a same-document symbol, not the sprite: the
        # brand mark is inline on purpose (templates/_brand_symbol.html).
        for name in re.findall(r'(?<!")#icon-(%s)(?![-$a-z0-9])' % NAME, path.read_text()):
            named.setdefault(name, set()).add(path.name)
    assert len(named) >= 40
    assert {name: sorted(files) for name, files in named.items()
            if name not in symbols} == {}


def test_every_icon_a_script_assembles_exists():
    symbols = _sprite_symbols()
    named = {}
    for path in _scripts():
        source = path.read_text()
        for argument in _call_arguments(source, 'spriteIcon'):
            literal = re.fullmatch(r"'(%s)'" % NAME, argument)
            # A literal, or the results of a ternary: the names it can return.
            names = [literal.group(1)] if literal else re.findall(
                r"[?:]\s*'(%s)'" % NAME, argument)
            for name in names:
                named.setdefault(name, set()).add(path.name)
        for name in re.findall(r"\bicon:\s*'(%s)'" % NAME, source):
            named.setdefault(name, set()).add(path.name)
    assert {'arrow-right-left', 'pencil', 'trash-2', 'ellipsis-vertical'} <= set(named)
    assert {name: sorted(files) for name, files in named.items()
            if name not in symbols} == {}


def test_every_file_type_icon_exists():
    source = (REPO / 'static/js/sftp-file-manager.js').read_text()
    table = re.search(r'this\.fileIcons = new Map\(Object\.entries\(\{(.*?)\}\)\)',
                      source, re.S)
    assert table, 'the extension table moved; point this test at it'
    icons = re.findall(r"'(%s)':\s*\[" % NAME, table.group(1))
    assert len(icons) >= 9
    assert sorted(set(icons) - _sprite_symbols()) == []


def test_the_sprite_pin_lives_in_the_templates_only():
    """Scripts read the sprite URL from the page's `icon-sprite` meta, so a
    symbol added later is one pin raise in the templates, and a sub-path
    deployment resolves through url_for."""
    for path in _scripts():
        assert 'icons.svg?v=' not in path.read_text(), path.name
    pins = set()
    for path in _templates():
        pins |= set(re.findall(r"icons/icons\.svg'\) \}\}\?v=(\d+)", path.read_text()))
    index = (REPO / 'templates/index.html').read_text()
    meta = re.search(r'<meta name="icon-sprite" content="\{\{ url_for\(\'static\', '
                     r'filename=\'icons/icons\.svg\'\) \}\}\?v=(\d+)">', index)
    assert meta, 'templates/index.html must declare the icon-sprite meta'
    assert pins == {meta.group(1)}
