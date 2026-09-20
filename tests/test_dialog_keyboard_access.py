"""Guards for keyboard and assistive-technology access to the app shell.

The dialogs already trap focus and restore it on close, so the missing piece was
narrower than it looks: the control that closes them was a <span>. A span is not
in the tab order and does not fire on Enter or Space, so a keyboard user could
open a dialog, tab around inside it, and have no way to dismiss it.
"""
import re
from pathlib import Path

from tests.locale_sources import all_locale_text

INDEX = Path('templates/index.html')
STYLE = Path('static/css/style.css')
SESSION_JS = Path('static/js/session-manager.js')

LANGUAGES = 6


def test_dialog_close_controls_are_buttons():
    source = INDEX.read_text(encoding='utf-8')

    spans = re.findall(r'<span[^>]*class="[^"]*\bclose\b[^"]*"[^>]*>', source)
    assert not spans, (
        f'{len(spans)} close controls are still <span>: not reachable by Tab and '
        'they ignore Enter/Space, so the dialog cannot be dismissed from the '
        'keyboard'
    )

    buttons = re.findall(r'<button[^>]*class="close"[^>]*>', source)
    # 13 since: #tmuxOrphansModal (the orphaned-tmux sweep) is the
    # thirteenth dialog, built with the same <button> close control.
    assert len(buttons) == 13, f'expected 13 dialog close buttons, found {len(buttons)}'
    for button in buttons:
        assert 'type="button"' in button, (
            f'{button} has no type, so it submits any form it sits inside'
        )
        assert 'aria-label' in button, f'{button} has no accessible name'


def test_close_button_keeps_its_appearance_and_shows_focus():
    css = STYLE.read_text(encoding='utf-8')
    block = css[css.index('.close {'):css.index('.close:hover')]

    # A <button> arrives with a UA border, background and font; without these
    # resets the glyph would render inside a grey box.
    assert 'background: none;' in block
    assert 'border: none;' in block
    assert 'font-family: inherit;' in block

    assert '.close:focus-visible' in css, (
        'a keyboard user needs to see which control has focus'
    )


def test_toast_region_is_announced():
    source = INDEX.read_text(encoding='utf-8')
    container = re.search(r'<div[^>]*id="notificationContainer"[^>]*>', source)
    assert container, 'notification container is missing'

    markup = container.group(0)
    assert 'aria-live="polite"' in markup, (
        'toasts are injected with createElement/textContent, so without a live '
        'region a screen reader never announces them'
    )
    assert 'aria-atomic="true"' in markup
    assert 'role="status"' in markup


def test_split_layout_buttons_expose_their_state():
    source = INDEX.read_text(encoding='utf-8')
    session = SESSION_JS.read_text(encoding='utf-8')

    group = re.search(r'<div class="split-controls"[^>]*>', source)
    assert group and 'role="group"' in group.group(0)

    buttons = re.findall(r'<button[^>]*class="split-btn[^"]*"[^>]*>', source)
    # v5 lines 102-110 define EIGHT layout choices, and two pairs of them share
    # a pane count -- "2 dọc"/"2 ngang" are both 2 panes, "4 pane"/"4 + chính"
    # are both 4. So the identity of a choice is the (layout, variant) PAIR, and
    # every canonical button must carry both halves: without data-variant the
    # two same-count buttons are indistinguishable, updateSplitControls would
    # light both, and the menu's click delegation would forward the wrong one.
    # The touch tiers narrow the offered set in JS policy
    # (touch-action-row.js allowedLayouts) and the engine enforces the cap
    # independently (SessionManager.layoutCap), not by removing markup here.
    assert len(buttons) == 8
    identities = [
        (
            re.search(r'data-layout="(\d)"', b).group(1),
            re.search(r'data-variant="([a-z]+)"', b).group(1),
        )
        for b in buttons
    ]
    assert identities == [
        ('1', 'default'),
        ('2', 'default'), ('2', 'rows'),
        ('3', 'default'),
        ('4', 'default'), ('4', 'main'),
        ('5', 'default'),
        ('6', 'default'),
    ]
    # The pair must be unique, or two buttons would compete for the same state.
    assert len(set(identities)) == len(identities)
    pressed = [b for b in buttons if 'aria-pressed="true"' in b]
    assert len(pressed) == 1, 'exactly one layout is selected at rest'
    for button in buttons:
        assert 'aria-pressed=' in button
        assert 'type="button"' in button
        # Two same-count choices means an accessible name of just the number
        # would be ambiguous to a screen reader.
        assert 'aria-label=' in button

    # The class drives styling; aria-pressed is what gets announced. If only the
    # class is updated the announced state freezes at the initial layout.
    definition = re.search(
        r'updateSplitControls\(\)\s*\{(?P<body>.*?)\n    \},',
        session,
        re.DOTALL,
    )
    assert definition, 'updateSplitControls is gone'
    body = definition.group('body')
    assert "classList.toggle('active'" in body
    assert "setAttribute('aria-pressed'" in body
    # Selection must compare BOTH halves. Comparing the count alone would mark
    # "2 dọc" and "2 ngang" as simultaneously active.
    assert 'layoutVariant' in body


def test_numeric_settings_input_has_a_label():
    source = INDEX.read_text(encoding='utf-8')
    assert re.search(r'<label[^>]*for="scrollbackInput"', source), (
        'the scrollback field was named only by a title attribute'
    )


def test_icon_only_broadcast_toggle_has_a_name():
    source = INDEX.read_text(encoding='utf-8')
    button = re.search(r'<button[^>]*id="broadcastToggleBtn"[^>]*>', source).group(0)
    assert 'aria-label=' in button
    assert 'aria-pressed=' in button


def test_heading_order_has_no_gap_before_the_dialogs():
    source = INDEX.read_text(encoding='utf-8')
    levels = [int(m) for m in re.findall(r'<h([1-6])[\s>]', source)]

    assert levels[0] == 1, 'the page should open with its h1'
    assert levels[1] == 2, (
        'the h1 was followed by an h2 that only exists inside a dialog, so the '
        'page body itself had no second-level heading'
    )

    for previous, current in zip(levels, levels[1:]):
        assert current <= previous + 1, (
            f'heading order jumps from h{previous} to h{current}'
        )


def test_hidden_heading_is_readable_not_removed():
    css = STYLE.read_text(encoding='utf-8')
    source = INDEX.read_text(encoding='utf-8')

    assert 'class="visually-hidden"' in source
    block = css[css.index('.visually-hidden {'):]
    block = block[:block.index('}')]
    assert 'display: none' not in block, (
        'display:none would drop the heading from the accessibility tree, which '
        'defeats the point of adding it'
    )
    assert 'position: absolute;' in block


def test_workspace_heading_is_translated_everywhere():
    i18n = all_locale_text()
    values = re.findall(r"'terminal\.workspaceHeading':\s*'([^']+)'", i18n)
    assert len(values) == LANGUAGES, (
        f'{len(values)} of {LANGUAGES} languages define the heading; a missing key '
        'makes i18n.t() fall back to printing the key itself'
    )
    assert len(set(values)) > 1, 'the heading is not actually translated'
