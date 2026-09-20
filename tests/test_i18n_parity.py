import re
from pathlib import Path

from tests.locale_sources import LOCALES, locale_source



def locale_keys():
    """Every locale's key set, read from its OWN file.

    The six locales lived in one 206 KB `i18n.js` until, when they
    were split so a page loads English plus the reader's language instead of
    all six (owner: "Dự án đẻ ra quá nhiều thứ sẽ làm nặng"). The parity
    property is unchanged -- every locale carries the same keys as English --
    only where the strings are read from.
    """
    keys = {}
    for locale in LOCALES:
        source = locale_source(locale)
        assert f'window.__i18n.{locale} = {{' in source, (
            f'{locale}.js must register itself on window.__i18n'
        )
        keys[locale] = set(re.findall(r"^        '([^']+)':", source, re.MULTILINE))
    return keys


def test_all_locales_have_matching_translation_keys():
    keys_by_locale = locale_keys()
    expected_locales = set(LOCALES)
    assert set(keys_by_locale) == expected_locales

    # Every locale must carry the SAME key set as English, not just Vietnamese.
    # A key added to en (and vi) but forgotten in de/fr/es/zh used to slip
    # through because only vi was compared.
    en_keys = keys_by_locale['en']
    for locale in expected_locales:
        missing = en_keys - keys_by_locale[locale]
        extra = keys_by_locale[locale] - en_keys
        assert not missing, f"{locale} is missing keys: {sorted(missing)}"
        assert not extra, f"{locale} has extra keys: {sorted(extra)}"

    assert all(
        'connection.tailscaleSSH' in keys
        for keys in keys_by_locale.values()
    )
    assert all(
        {
            'connection.commandSet',
            'connection.commandSetHint',
            'commandSets.manage',
            'commandSets.create',
            'commandSets.saveToLibrary',
            'commandSets.useSudo',
            'commandSets.useSudoHint',
            'commandSets.sudoBadge',
        } <= keys
        for keys in keys_by_locale.values()
    )

    # The docked Notepad control and the sheet's exit-scroll caption, plus the
    # clipboard result strings, must exist in every locale. tmux.exitScroll
    # drives BOTH the visible caption and the aria-label (label-in-name); it
    # replaced the longer tmux.exitCopyMode, which is no longer referenced.
    for key in ('terminal.notepad', 'tmux.exitScroll', 'tmux.exitedCopyMode',
                'tmux.notInCopyMode', 'tmux.exitCopyModeFailed',
                'clipboard.copyFailed'):
        assert all(key in keys for keys in keys_by_locale.values()), key


def test_english_command_set_copy_explains_execution_boundaries():
    english_block = locale_source('en')
    match = re.search(
        r"'connection\.commandSetHint': '([^']+)'",
        english_block,
    )

    assert match is not None
    hint = match.group(1).lower()
    assert 'remote host' in hint
    assert 'not in sshdeck' in hint
    assert 'tmux' in hint
    assert 'not run again' in hint


def test_all_popup_translation_references_exist_in_every_locale():
    sources = [
        Path('templates/index.html').read_text(encoding='utf-8'),
        Path('templates/admin.html').read_text(encoding='utf-8'),
        Path('static/js/sftp-file-manager.js').read_text(encoding='utf-8'),
    ]
    referenced_keys = set()
    for source in sources:
        referenced_keys.update(
            re.findall(
                r'data-i18n(?:-placeholder|-title|-label|-aria-label)?="([^"]+)"',
                source,
            )
        )

    missing_by_locale = {}
    for locale, keys in locale_keys().items():
        missing = sorted(referenced_keys - keys)
        if missing:
            missing_by_locale[locale] = missing

    assert missing_by_locale == {}


def test_popup_inputs_use_explicit_placeholder_translation_attribute():
    source = Path('templates/index.html').read_text(encoding='utf-8')
    popup_source = source[source.index('<div class="modal'):source.index(
        '<script src=',
    )]
    translated_fields = re.findall(
        r'<(?:input|textarea)\b[^>]*\bdata-i18n="[^"]+"[^>]*>',
        popup_source,
    )

    assert translated_fields == []


def test_dynamic_popup_select_placeholders_refresh_with_language():
    profile_source = Path('static/js/profile-manager.js').read_text(encoding='utf-8')
    jump_host_source = Path('static/js/jump-host-manager.js').read_text(encoding='utf-8')

    assert re.search(
        r"this\.t\(\s*'connection\.selectProfile'",
        profile_source,
    )
    assert re.search(
        r"this\.t\(\s*'connection\.selectSSHKey'",
        profile_source,
    )
    assert "window.addEventListener('languageChanged'" in jump_host_source
    assert 'window.JumpHostManager.renderSelect();' in jump_host_source


def test_the_engine_carries_no_strings_and_can_fetch_a_locale():
    """What the split is FOR: i18n.js is the engine, not the table.

    If a locale ever creeps back into it, the page silently starts shipping
    strings nobody asked for again -- which is the 206 KB this replaced.
    """
    engine = Path('static/js/i18n.js').read_text(encoding='utf-8')
    assert len(engine) < 16 * 1024, (
        'i18n.js grew past the engine size: are the strings back in it?'
    )
    for locale in LOCALES:
        assert f"    {locale}: {{" not in engine, f'{locale} strings are in the engine'
    # The table comes from the files, and a language picked later is fetched.
    assert 'window.__i18n = window.__i18n || {}' in engine
    assert '/static/js/i18n/${lang}.js' in engine
    assert "document.cookie = `lang=" in engine


def test_every_page_loads_english_plus_the_readers_language():
    """The server decides which file the page carries, from the `lang` cookie,
    so a reader never sees English flash before their own language lands."""
    for name in ('index.html', 'admin.html', 'login.html', 'register.html',
                 'change_password.html'):
        page = Path('templates') / name
        source = page.read_text(encoding='utf-8')
        assert "filename='js/i18n/en.js'" in source, f'{name} must load English'
        # One literal line per language rather than a computed path: the
        # browser gates render these templates with a plain substitution that
        # cannot evaluate a Jinja expression, and a computed src would reach
        # them empty -- the page itself loaded as a script.
        for locale in LOCALES[1:]:
            assert f"{{% if lang == '{locale}' %}}" in source or \
                   f"{{% elif lang == '{locale}' %}}" in source, (
                f'{name} must be able to load {locale}')
            assert f"filename='js/i18n/{locale}.js'" in source, (
                f'{name} must name {locale}.js literally')
        assert 'data-i18n-version=' in source, (
            f'{name} must tell the engine which pin a runtime fetch uses'
        )

    app_source = Path('app/__init__.py').read_text(encoding='utf-8')
    assert "request.cookies.get('lang')" in app_source
    assert app_source.count('lang=reader_language()') >= 5
