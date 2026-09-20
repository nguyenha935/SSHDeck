"""The header menus after moving them out of an inline <script>.

templates/index.html carried 146 lines of inline JavaScript driving the theme
picker, the language picker and the account dropdown, wired by five inline
onclick= attributes. Inline script cannot be cache-busted -- it ships inside the
cached HTML, so a browser holding a stale page holds stale handlers -- and inline
onclick= forces every handler to be a window global.

These are static checks over the extracted file and the template. The behaviour
that a static check cannot see (a click actually opening the menu, a theme
actually applying) is measured in tests/browser/header_menus.mjs.
"""
import re
from pathlib import Path

HEADER_MENUS = Path('static/js/header-menus.js')
INDEX = Path('templates/index.html')
STYLE = Path('static/css/style.css')


def _js() -> str:
    return HEADER_MENUS.read_text(encoding='utf-8')

def _js_code() -> str:
    """_js() with /* ... */ comments stripped.

    Absence assertions need this: prose explaining why a selector or binding was
    REMOVED names it, and a bare substring search then reads that explanation as
    the thing still being present. Only block comments are stripped -- this file
    uses them for every load-bearing note.
    """
    return re.sub(r'/\*.*?\*/', '', _js(), flags=re.S)


def _html() -> str:
    return INDEX.read_text(encoding='utf-8')


def test_no_inline_script_block_remains_in_the_template():
    html = _html()
    # The flashed-messages block is the one legitimate inline script: it renders
    # a Jinja value (get_flashed_messages) that has no meaning outside the
    # template. Everything else must be a real file with a ?v= pin.
    inline_blocks = html.count('<script>')
    assert inline_blocks == 1, (
        f'expected only the flashed-messages inline block, found {inline_blocks}'
    )
    assert 'get_flashed_messages' in html


def test_no_inline_onclick_attributes_remain():
    assert 'onclick=' not in _html(), (
        'an inline onclick= forces the handler to be a window global and has to '
        'be edited in lockstep with the markup it sits in'
    )


def test_extracted_file_is_loaded_and_pinned():
    html = _html()
    assert html.count("filename='js/header-menus.js'") == 1
    tag_start = html.index("filename='js/header-menus.js'")
    tag = html[tag_start:html.index('>', tag_start)]
    assert '?v=13' in tag, 'header-menus.js must use the current production cache pin'


def test_every_theme_in_the_picker_has_a_stylesheet_block():
    """A theme offered in the menu that has no CSS silently does nothing.

    `glass` is the exception and is asserted separately below: it has no
    [data-theme="glass"] block because it IS :root.
    """
    js = _js()
    css = STYLE.read_text(encoding='utf-8')
    ids = [line.split("id: '")[1].split("'")[0]
           for line in js.splitlines() if "{ id: '" in line]
    assert len(ids) == 10, f'expected 10 themes, parsed {len(ids)}: {ids}'
    assert ids[0] == 'glass'
    for theme_id in ids[1:]:
        assert f'[data-theme="{theme_id}"]' in css, f'{theme_id} has no CSS block'


def test_glass_is_the_default_and_is_root_not_a_data_theme_block():
    css = STYLE.read_text(encoding='utf-8')
    assert '[data-theme="glass"]' not in css
    assert "data-theme=\"{{ theme|default('glass') }}\"" in _html()
    assert "|| 'glass'" in _js(), 'the picker must fall back to the default theme'


def test_apply_theme_stays_global_and_repaints_the_terminals():
    """The terminal palette contract.

    TerminalManager reads --term-* out of CSS with getCssVar(), so a theme change
    only reaches the live xterm instances through applyThemeToAll(). Dropping
    that call leaves the page themed and every terminal on the old palette, which
    no CSS test would catch.
    """
    js = _js()
    assert 'window.applyTheme = applyTheme' in js
    assert 'TerminalManager.applyThemeToAll()' in js


def test_account_menu_closes_on_actions_but_not_on_the_expanders():
    """Closing on .account-expander would shut the menu on the way to a theme."""
    js = _js()
    assert "closest('.account-action')" in js
    assert "closest('.account-expander')" not in js


def test_option_clicks_are_delegated_not_bound_per_option():
    """Both lists are rebuilt with innerHTML on every init.

    A per-option listener would need re-attaching after each rebuild, which is
    how you end up with dead options or handlers stacked two deep.
    """
    js = _js()
    assert "closest('.theme-option')" in js
    assert "closest('.lang-option')" in js
    assert '.onclick =' not in js, 'use addEventListener, not .onclick ='


def test_the_two_reattached_buttons_have_a_binding_somewhere():
    """openFileManager and location.reload lost their inline handlers."""
    html = _html()
    for button_id in ('fileTransferBtn', 'reloadPageBtn'):
        assert f'id="{button_id}"' in html
    sftp = Path('static/js/sftp-file-manager.js').read_text(encoding='utf-8')
    assert "getElementById('fileTransferBtn')" in sftp
    app = Path('static/js/app.js').read_text(encoding='utf-8')
    assert "getElementById('reloadPageBtn')" in app


def test_expanders_carry_ids_so_handlers_need_not_live_in_the_markup():
    html = _html()
    assert 'id="themeExpanderHeader"' in html
    assert 'id="langExpanderHeader"' in html
    js = _js()
    assert "byId('themeExpanderHeader')" in js
    assert "byId('langExpanderHeader')" in js


def test_mobile_more_settings_structure_and_lifecycle_ownership():
    html = _html()
    js = _js()

    # OWNER CORRECTION: "mobile still exposes two menu entry points".
    # The intermediate surface this test used to require -- #mobileMoreActions
    # (a list of four proxy buttons), #mobileSettingsBtn -> #mobileSettingsView
    # -> #mobileSettingsBackBtn (a navigation step to reach the real account
    # tree) and the #mobileProfilesBtn proxy -- WAS the second menu. It is gone,
    # so the ids are asserted absent below instead of present here.
    mobile_ids = (
        'mobileMoreBtn', 'mobileMoreSheet',
        'mobileSettingsHost',
        # mobileNotepadBtn is gone: the v5 shell relocates the single canonical
        # #notepadOpenBtn into the action row instead of shipping a second
        # touch-only Note button.
        'notepadOpenBtn',
        # Exit-scroll is the one shared contextual dock control, not a More clone.
        'exitScrollBtn',
    )
    for element_id in mobile_ids:
        assert html.count(f'id="{element_id}"') == 1, element_id
    assert 'id="mobileExitCopyModeBtn"' not in html

    # Attribute CONTRACTS, read off the element that carries the id, rather than
    # an exact indentation match. The previous form pinned the literal leading
    # whitespace of three multi-line tags, so reflowing the markup failed the
    # test while the shipped semantics were byte-for-byte equivalent (verified:
    # every attribute below was present, only the indent width had changed).
    # Matching per-attribute keeps the same coverage -- dropping `inert`, the
    # dialog role or an aria hook still fails -- and cannot be broken by an
    # editor reindenting the template.
    def _tag_with_id(element_id):
        match = re.search(r'<[a-zA-Z][^<>]*id="' + re.escape(element_id) + r'"[^<>]*>',
                          html, re.S)
        assert match, f'no tag carries id="{element_id}"'
        return ' '.join(match.group(0).split())

    sheet = _tag_with_id('mobileMoreSheet')
    for attr in ('role="dialog"', 'aria-labelledby="mobileMoreTitle"',
                 'aria-hidden="true"', 'hidden', 'inert'):
        assert attr in sheet, f'mobileMoreSheet lost {attr}'

    more_btn = _tag_with_id('mobileMoreBtn')
    for attr in ('type="button"', 'aria-label="More actions"',
                 'aria-haspopup="dialog"', 'aria-controls="mobileMoreSheet"',
                 'aria-expanded="false"'):
        assert attr in more_btn, f'mobileMoreBtn lost {attr}'
    # Piece F: ONE canonical menu, so the whole intermediate surface is absent
    # from the served markup -- not merely hidden. A hidden second menu is still
    # a second menu, one CSS edit away from being visible again.
    for gone in ('mobileMoreActions', 'mobileSettingsView', 'mobileSettingsBtn',
                 'mobileSettingsBackBtn', 'mobileProfilesBtn',
                 'mobileNewConnectionBtn', 'mobileFilesBtn', 'mobileCommandsBtn'):
        assert f'id="{gone}"' not in html, (
            f'{gone} is part of the removed second menu surface')

    # Every proxy is gone with it: a proxy that fires .click() at a real control
    # is a duplicate of that action by definition. The canonical actions are
    # MOVED by touch-action-row.js instead, so each exists exactly once.
    assert 'data-mobile-action-target' not in html, (
        'proxy actions reintroduce a second copy of a canonical action')

    # The real controls each still exist exactly once. W14 item 7 gives
    # #newConnectionBtn one permanent home as the FIRST CHILD of the session
    # strip row at every viewport -- it is no longer a relocated header global.
    for once in ('manageProfilesBtn', 'newConnectionBtn', 'fileTransferBtn',
                 'commandLibraryBtn', 'reloadPageBtn'):
        assert html.count(f'id="{once}"') == 1, once
    strip_row = html[html.index('<div class="session-tabs-row">'):]
    assert strip_row.index('id="newConnectionBtn"') < strip_row.index(
        'id="sessionTabs"'), (
            'New Connection must remain the first child of the session strip')

    # The sheet's only child is the single host that receives the canonical tree.
    sheet_start = html.index('id="mobileMoreSheet"')
    sheet = html[sheet_start:html.index('</section>', sheet_start)]
    assert 'id="mobileSettingsHost"' in sheet
    assert sheet.count('<div') == 1, (
        'the sheet must host exactly one container, not competing views')

    # ONE dismissal path (owner correction, second pass).
    #
    # The sheet-level click handler this used to require is gone. It matched
    # `.mobile-more-action`, the class the three relocated globals carried while
    # they were DIRECT children of #mobileSettingsHost -- i.e. siblings of the
    # account tree, painted as separate cards. Those three are now inserted INSIDE
    # the tree as `.account-item .account-action` rows, so the tree handler's
    # .account-action branch dismisses the menu for every row including them.
    # Keeping both handlers would close the menu twice on one click.
    js_code = _js_code()
    assert "byId('accountDropdownHeader')?.addEventListener('click'" in js_code, (
        'the tree handler is the one dismissal path for every menu row')
    assert "byId('mobileMoreSheet')?.addEventListener('click'" not in js_code, (
        'a second, sheet-level dismissal handler is back alongside the tree one')
    assert '.mobile-more-action' not in js_code, (
        'the sibling-card class is back; the menu must have one row system')
    assert "byId('mobileMoreActions')?.addEventListener('click'" not in js_code
    # And the removed navigation must not be re-bound.
    assert "byId('mobileSettingsBtn')" not in js_code
    assert "byId('mobileSettingsBackBtn')" not in js

    assert html.count('id="accountDropdownRestoreMarker"') == 1
    # The restore marker went with the phone-landscape strip relocation it
    # served: the strip has one home, no marker.
    assert 'id="sessionTabsRestoreMarker"' not in html
    assert 'id="mobileLandscapeSessionSlot"' not in html
    assert html.count('id="sessionTabs"') == 1
    assert html.count('id="notepadOpenBtn"') == 1
    assert 'id="mobileNotepadBtn"' not in html
    assert html.count('id="exitScrollBtn"') == 1
    assert 'id="mobileExitCopyModeBtn"' not in html

    lifecycle_contracts = (
        "element.toggleAttribute('inert', inactive)",
        "element.setAttribute('aria-hidden', String(inactive))",
        "marker.after(dropdown)",
        "host.appendChild(dropdown)",
        # "action.dataset.mobileActionTarget" and "target.click()" were required
        # here. They are the PROXY-FORWARDING path: read a
        # data-mobile-action-target off the clicked entry and dispatch a synthetic
        # click at the real control elsewhere in the document. No proxy has existed
        # since the intermediate menu was deleted (this same test asserts
        # data-mobile-action-target is absent from the markup, above), so the
        # branch could never run -- and requiring it here would forbid removing the
        # dead code. Their absence is asserted below instead.
        "byId('sessionBar')",
        "new MutationObserver",
        "mobileShellMedia.addEventListener('change'",
        "let initialized = false",
    )
    for contract in lifecycle_contracts:
        assert contract in js, contract

    # The proxy-forwarding path must stay gone: a handler that dispatches a
    # synthetic click at a real control is a second copy of that action's entry
    # point, which is what the owner reported as a duplicate menu.
    for forbidden in ('dataset.mobileActionTarget', 'target.click()'):
        assert forbidden not in _js_code(), (
            f'{forbidden} reintroduces proxy forwarding into the one menu')
