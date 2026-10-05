"""The required-field mark: which captions carry it, and where it lives.

OWNER RULING 2026-10-05:
1. A form that also has optional fields marks the caption of every required
   field with " *". A form whose every field is required -- sign in,
   register, change password, add user, upload a key, upload, download --
   carries no mark.
2. The mark is markup, never part of a translated string:
   `<label for="hostInput"><span data-i18n="connection.host">Host</span> *</label>`.

Why 2: static/js/i18n.js updatePageText sets textContent = t(key) on every
[data-i18n] element, English included. A mark inside a string reached every
other use of the key -- the Jump Host radio read "SSH Key *" because
connection.sshKey was also the caption of the key select -- and a mark
written in the template's text was erased on load ("Username *" rendered
"Username"). Outside the translated span it survives the engine and cannot
leak into a choice that shares the key.

These rows read the templates, the quick-connect markup in
sftp-file-manager.js and the locale files: what a locale file holds is what
the engine paints, and the mark sits in markup the engine never touches.
"""
import re
from html.parser import HTMLParser
from pathlib import Path

from tests.locale_sources import LOCALES, locale_source

TEMPLATES = sorted(Path('templates').glob('*.html'))
QUICK_CONNECT = Path('static/js/sftp-file-manager.js')
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'source', 'track', 'wbr'}
KEY = re.compile(r"^        '([^']+)':", re.MULTILINE)
VALUE = re.compile(
    r"""^        '([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$""",
    re.MULTILINE,
)

# The captions that carry the mark, per form: the label's `for`, or its key
# when the caption names a group rather than one control. Required-ness is
# what the client or the server refuses empty; a field shown only for one
# choice is required while it is shown, like the key select.
MARKED = {
    ('index.html', 'connectionForm'): {
        'hostInput', 'portInput', 'usernameInput',
        'passwordInput',            # app.js "Password is required" (password auth)
        'keySelect',                # app.js "SSH key is required" (key auth)
        'jumpHostPasswordInput',    # app.js "Jump host password is required"
        'commandSetSelect',         # server "Command set not found"
        'connectionCommandSelect',  # server "Command not found"
    },
    ('index.html', 'profileEditorForm'): {
        'profileEditorName', 'profileEditorHost', 'profileEditorPort',
        'profileEditorUsername',
        'profileEditorKeySelect',         # server "key_id required for key authentication"
        'profileEditorCommandSetSelect',  # server "Command set not found"
        'profileEditorCommandSelect',     # server "Command not found"
    },
    # Port is optional here: empty becomes 22 in app.js and in the server.
    ('index.html', 'jumpHostForm'): {
        'jhNameInput', 'jhHostInput', 'jhUsernameInput', 'jhKeySelect',
    },
    ('index.html', 'commandSetForm'): {'commandSetNameInput'},
    ('index.html', 'commandForm'): {
        'commandFormName', 'commandFormCommand', 'commandFormDescription',
        'commands.operatingSystems',  # command-library.js "Select at least one OS"
    },
    # Port is optional here too: submitQuickConnect falls back to 22.
    ('sftp-file-manager.js', 'fmQcForm'): {
        'fmQcHost', 'fmQcUsername',
        'fmQcPassword',   # "Password is required" (password auth)
        'fmQcKeySelect',  # "Please select an SSH key" (key auth)
    },
    # Every field required: no mark.
    ('index.html', 'keyUploadForm'): set(),
    ('index.html', 'uploadForm'): set(),
    ('index.html', 'downloadForm'): set(),
    ('index.html', 'dropUploadForm'): set(),
    # Settings → Users since 2026-10-05; the admin page is gone.
    ('index.html', 'addUserForm'): set(),
    ('login.html', None): set(),
    ('register.html', 'registerForm'): set(),
    # Settings -> Account since 2026-10-05; the page it had is gone.
    ('index.html', 'changePasswordForm'): set(),
}


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
        self.content = []  # text and child nodes, in document order

    def children(self):
        return [item for item in self.content if isinstance(item, Node)]

    def walk(self):
        for child in self.children():
            yield child
            yield from child.walk()

    def text(self):
        return ''.join(item if isinstance(item, str) else item.text()
                       for item in self.content)

    def own_text(self):
        return ''.join(item for item in self.content if isinstance(item, str))


class TreeBuilder(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.root = self.current = Node('#document', [], None)
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.content.append(node)
        if tag not in VOID:
            self.current = node

    def handle_endtag(self, tag):
        node = self.current
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.current = node.parent

    def handle_data(self, data):
        self.current.content.append(data)


def quick_connect_markup():
    source = QUICK_CONNECT.read_text(encoding='utf-8')
    start = source.index('<form id="fmQcForm">')
    return source[start:source.index('</form>', start) + len('</form>')]


def documents():
    """name -> parsed tree, for every template and the quick-connect form."""
    trees = {page.name: TreeBuilder(page.read_text(encoding='utf-8')).root
             for page in TEMPLATES}
    trees[QUICK_CONNECT.name] = TreeBuilder(quick_connect_markup()).root
    return trees


def is_choice(node):
    """An <option>, or anything inside a <label> that wraps a radio or checkbox."""
    if node.tag == 'option':
        return True
    ancestor = node if node.tag == 'label' else node.parent
    while ancestor is not None:
        if ancestor.tag == 'label':
            return any(d.tag == 'input' and d.attrs.get('type') in ('radio', 'checkbox')
                       for d in ancestor.walk())
        ancestor = ancestor.parent
    return False


def captions(root):
    return [node for node in root.walk() if node.tag == 'label' and not is_choice(node)]


def caption_name(label):
    if label.attrs.get('for'):
        return label.attrs['for']
    keyed = [d.attrs['data-i18n'] for d in label.walk() if d.attrs.get('data-i18n')]
    return keyed[0] if keyed else label.text().strip()


def marked(label):
    return starred(label.text())


def container(trees, page, container_id):
    root = trees[page]
    if container_id is None:
        forms = [node for node in root.walk() if node.tag == 'form']
        assert len(forms) == 1, f'{page}: {len(forms)} forms'
        return forms[0]
    found = [node for node in root.walk() if node.attrs.get('id') == container_id]
    assert len(found) == 1, f'{page}: {len(found)} #{container_id}'
    return found[0]


def test_no_string_carries_the_mark():
    for locale in LOCALES:
        source = locale_source(locale)
        values = locale_values(locale)
        # Floor: every key of the file was read, so no string can hide from
        # the check behind a quoting form the pattern does not know.
        assert set(values) == set(KEY.findall(source)), locale
        assert len(values) > 600, (locale, len(values))
        offenders = sorted(f'{key}: {text!r}' for key, text in values.items() if starred(text))
        assert not offenders, f'{locale}: a translated string carries the mark: {offenders}'


def test_no_choice_carries_the_mark():
    choices = [(name, node) for name, root in documents().items()
               for node in root.walk()
               if node.attrs.get('data-i18n') and is_choice(node)]
    # Floor: the scan reaches the choices that once read "SSH Key *" -- the
    # auth-type <option>s of the connection modal and the profile editor and
    # the Jump Host radio.
    ssh_key = sorted((name, node.tag) for name, node in choices
                     if node.attrs['data-i18n'] == 'connection.sshKey')
    assert ssh_key == [('index.html', 'option'), ('index.html', 'option'),
                       ('index.html', 'span')], ssh_key
    offenders = [f'{name}: <{node.tag} data-i18n="{node.attrs["data-i18n"]}"> '
                 f'{node.text().strip()!r}' for name, node in choices if starred(node.text())]
    assert not offenders, offenders


def test_the_mark_sits_outside_the_translated_text():
    english = locale_values('en')
    found = 0
    for name, root in documents().items():
        for label in captions(root):
            if not marked(label):
                continue
            found += 1
            where = f'{name}: caption of {caption_name(label)}'
            # On the label itself, data-i18n would replace the whole text --
            # the mark included -- on load.
            assert not label.attrs.get('data-i18n'), where
            assert starred(label.own_text()), f'{where}: the mark is not the label\'s own text'
            spans = [child for child in label.children() if child.attrs.get('data-i18n')]
            assert len(spans) == 1, f'{where}: {len(spans)} translated spans'
            # The text served before the engine runs is the English string.
            key = spans[0].attrs['data-i18n']
            assert spans[0].text().strip() == english[key], (where, spans[0].text())
    # Floor: every marked caption the ruling names was inspected.
    assert found == sum(len(names) for names in MARKED.values()), found


def test_the_marks_follow_the_ruling():
    trees = documents()
    for (page, container_id), expected in MARKED.items():
        form = container(trees, page, container_id)
        labels = captions(form)
        assert labels, f'{page} #{container_id}: no captions found'
        have = {caption_name(label) for label in labels if marked(label)}
        assert have == expected, (
            f'{page} #{container_id}: marked {sorted(have)}, ruling {sorted(expected)}')

        # A form with a mark has optional fields, so every control the
        # browser itself refuses empty is marked -- a required field added
        # later cannot arrive unmarked.
        if expected:
            controls = {node.attrs.get('id') for node in form.walk()
                        if 'required' in node.attrs}
            unmarked = sorted(controls - have)
            assert controls and not unmarked, (
                f'{page} #{container_id}: required but unmarked {unmarked}')


def test_no_form_outside_the_ruling_carries_the_mark():
    trees = documents()
    listed = set()
    for page, container_id in MARKED:
        listed.update(id(label) for label in captions(container(trees, page, container_id)))
    stray = [f'{name}: caption of {caption_name(label)}'
             for name, root in trees.items() for label in captions(root)
             if marked(label) and id(label) not in listed]
    assert not stray, stray
