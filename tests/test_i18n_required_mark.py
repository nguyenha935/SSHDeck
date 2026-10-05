"""A trailing asterisk marks a required field, so it belongs on the caption of
that field and on nothing the reader picks.

2026-10-05: the Jump Host dialog's auth-type radio read "SSH Key *". One key,
connection.sshKey, carried the asterisk in all six locales and served both as
the caption of the key select -- required once key auth is picked
(app/profile_manager.py and app/jump_host_manager.py refuse a key profile
without key_id; profile-manager.js sets keySelect.required) -- and as the
CHOICE that reveals it: the two auth-type <option>s, the radio, and the
auth-type badge JumpHostManager.renderList paints on every saved jump host.
The caption has its own key now, connection.sshKeyField, as Host and Port
carry theirs; the choice is plain.

static/js/i18n.js updatePageText sets textContent = t(key) on every
[data-i18n] element, English included, so what a locale file holds for a key
is exactly what the reader sees. These rows read the locale files and the
templates rather than rendering them.
"""
import re
from html.parser import HTMLParser
from pathlib import Path

from tests.locale_sources import LOCALES, locale_source

TEMPLATES = sorted(Path('templates').glob('*.html'))
I18N_ATTRS = ('data-i18n', 'data-i18n-placeholder', 'data-i18n-title',
              'data-i18n-label', 'data-i18n-aria-label')
SSH_KEY_FIELDS = ('keySelect', 'profileEditorKeySelect', 'jhKeySelect')
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'source', 'track', 'wbr'}
VALUE = re.compile(
    r"""^        '([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$""",
    re.MULTILINE,
)


def locale_values(locale):
    """key -> string; a duplicated key resolves as the object literal does."""
    return {key: single or double
            for key, single, double in VALUE.findall(locale_source(locale))}


def starred(text):
    return text.rstrip().endswith('*')


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = dict(attrs)
        self.parent = parent
        self.children = []
        self.data = []

    def walk(self):
        for child in self.children:
            yield child
            yield from child.walk()

    def text(self):
        return ''.join(self.data) + ''.join(child.text() for child in self.children)


class TreeBuilder(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.root = self.current = Node('#document', [], None)
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_endtag(self, tag):
        node = self.current
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.current = node.parent

    def handle_data(self, data):
        self.current.data.append(data)


def pages():
    for page in TEMPLATES:
        yield page.name, TreeBuilder(page.read_text(encoding='utf-8')).root


def is_choice(node):
    """An <option>, or text inside a <label> that wraps a radio or checkbox."""
    if node.tag == 'option':
        return True
    ancestor = node.parent
    while ancestor is not None:
        if ancestor.tag == 'label':
            return any(d.tag == 'input' and d.attrs.get('type') in ('radio', 'checkbox')
                       for d in ancestor.walk())
        ancestor = ancestor.parent
    return False


def test_no_choice_carries_the_required_mark():
    english = locale_values('en')
    choices = []
    for name, root in pages():
        for node in root.walk():
            key = node.attrs.get('data-i18n')
            if key and is_choice(node):
                choices.append((name, node, key))

    # Floor: the scan reaches the choices this defect was about -- the
    # auth-type <option>s of the connection modal and the profile editor and
    # the Jump Host radio -- not an empty set that passes by finding nothing.
    ssh_key_choices = [(name, node.tag) for name, node, key in choices
                       if key == 'connection.sshKey']
    assert sorted(ssh_key_choices) == [
        ('index.html', 'option'), ('index.html', 'option'), ('index.html', 'span'),
    ], ssh_key_choices
    assert 'auth.password' in {key for _, _, key in choices}

    fallbacks = [f'{name}: <{node.tag} data-i18n="{key}"> {node.text().strip()!r}'
                 for name, node, key in choices if starred(node.text())]
    assert not fallbacks, fallbacks

    for locale in LOCALES:
        values = locale_values(locale)
        offenders = sorted({
            f'{key}: {values.get(key, english.get(key, key))!r}'
            for _, _, key in choices
            if starred(values.get(key, english.get(key, key)))
        })
        assert not offenders, f'{locale}: a choice reads as a required caption: {offenders}'


def test_the_required_mark_lives_on_field_captions_only():
    values = {locale: locale_values(locale) for locale in LOCALES}
    marked = {key for strings in values.values()
              for key, text in strings.items() if starred(text)}
    # Floor: the caption split out of connection.sshKey is one of them.
    assert 'connection.sshKeyField' in marked, sorted(marked)

    for key in sorted(marked):
        unmarked = [locale for locale in LOCALES if not starred(values[locale].get(key, ''))]
        assert not unmarked, f'{key} marks a required field in some locales but not {unmarked}'

    uses = []
    for name, root in pages():
        for node in root.walk():
            for attr in I18N_ATTRS:
                if node.attrs.get(attr) in marked:
                    uses.append((name, node, attr))
    assert uses, 'no template uses a marked caption key at all'
    misused = [f'{name}: <{node.tag} {attr}="{node.attrs[attr]}">'
               for name, node, attr in uses
               if not (attr == 'data-i18n' and node.tag == 'label'
                       and node.attrs.get('for') and not is_choice(node))]
    assert not misused, f'a marked key is used for something other than a field caption: {misused}'


def test_scripts_paint_no_marked_string():
    """A script that names a marked key paints the asterisk outside a caption
    -- as JumpHostManager.renderList did on each saved jump host's badge."""
    marked = {key for locale in LOCALES
              for key, text in locale_values(locale).items() if starred(text)}
    scripts = {path: path.read_text(encoding='utf-8')
               for path in Path('static/js').glob('*.js')}
    # Floor: the scan reads the script that painted the badge, and finds the
    # plain key it paints now.
    badge = scripts[Path('static/js/jump-host-manager.js')]
    assert "i18n.t('connection.sshKey')" in badge

    named = sorted(f'{path}: {key}' for path, source in scripts.items()
                   for key in marked
                   if re.search(rf"""['"`]{re.escape(key)}['"`]""", source))
    assert not named, named


def test_the_ssh_key_field_captions_keep_the_required_mark():
    index = dict(pages())['index.html']
    values = {locale: locale_values(locale) for locale in LOCALES}
    for field in SSH_KEY_FIELDS:
        captions = [node for node in index.walk()
                    if node.tag == 'label' and node.attrs.get('for') == field]
        assert len(captions) == 1, f'{field}: {len(captions)} captions'
        caption = captions[0]
        key = caption.attrs.get('data-i18n')
        for locale in LOCALES:
            assert starred(values[locale].get(key, '')), (
                f'{field} caption ({key}) is not marked required in {locale}')
        # The text served before the engine runs is the English string.
        assert caption.text().strip() == values['en'][key], (field, caption.text())
