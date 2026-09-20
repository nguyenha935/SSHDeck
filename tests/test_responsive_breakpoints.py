"""Guard the responsive breakpoint boundaries in style.css.

The bug this locks down: mobile blocks are bounded at 767px, but one was
written `max-width: 768px`, so at exactly 768px it applied at the same time as
`@media (min-width: 768px)`.  That produced a state present in no design -- the
stacked mobile header (113px tall) with the mobile session bar already hidden --
which is what a tablet in portrait actually got.

These tests are deliberately narrow.  They assert the boundaries do not overlap
and that the breakpoints carrying real layout steps are still there; they do not
try to police how many breakpoints the stylesheet is allowed to have.
"""
import re
from pathlib import Path

STYLE = Path('static/css/style.css')
INDEX = Path('templates/index.html')
TOUCH_ACTION_ROW = Path('static/js/touch-action-row.js')

# `@media` at the start of a line, or indented inside an `@supports` wrapper.
MEDIA = re.compile(r'^[ \t]*@media ([^{]+)\{', re.MULTILINE)
MAX_WIDTH = re.compile(r'max-width:\s*(\d+)px')
MIN_WIDTH = re.compile(r'min-width:\s*(\d+)px')


def media_queries():
    return [q.group(1).strip() for q in MEDIA.finditer(
        STYLE.read_text(encoding='utf-8'))]


def test_no_width_is_matched_by_both_a_mobile_and_a_desktop_block():
    """Every max-width bound must sit strictly below every min-width bound.

    A `max-width: N` block and a `min-width: N` block both match at exactly N.
    When that happens the winner is decided by source order, which is the
    hardest kind of CSS bug to find and the reason 768px had a hybrid layout.
    """
    queries = media_queries()
    upper = {int(m) for q in queries for m in MAX_WIDTH.findall(q)}
    lower = {int(m) for q in queries for m in MIN_WIDTH.findall(q)}

    overlap = upper & lower
    assert not overlap, (
        f'widths matched by both a max-width and a min-width block: '
        f'{sorted(overlap)}'
    )


def test_the_touch_shell_is_gated_by_capability_not_width():
    """The dock's existence is decided by interaction capability, never width.

    This is the capability model (plan §12.2). It replaces the D3
    defect, which was `@media (pointer: fine), (min-width: 768px) and
    (min-height: 501px)` with `display: none !important`: the comma made the
    width/height arm an independent OR-branch, so ANY viewport at least
    768x501 hid the dock regardless of pointer -- which is an iPad (834x1194)
    in portrait, a coarse hover-less touch device left with no composer.

    The model is cascade-safe, not negation-based:

      1. A DESKTOP DEFAULT block appears FIRST and hides the dock for a fine
         pointer with hover, at EVERY viewport height:
             @media (pointer: fine) and (hover: hover)
                 { .session-bar { display: none !important; } }
      2. The CANONICAL TOUCH block appears LAST and turns the dock back on for
         any device answering yes to the capability query:
             @media (pointer: coarse), (hover: none), (any-pointer: coarse)
                 { .session-bar { display: flex !important; } ... }

    Both use `!important` at equal specificity, so SOURCE ORDER decides the
    winner: touch wins because it comes last. A hybrid (fine+hover primary
    pointer plus any-pointer:coarse) matches the touch block and not the
    desktop default, so it gets the touch shell -- agreeing with
    TerminalManager.isTouchShell(). The desktop default carries NO height term
    at all: the old `min-height: 501px` guard was removed deliberately (see the
    rationale comment above the rule in style.css) because it left a 13px EMPTY
    session-bar on a short desktop, whose five children were all display:none
    and 0x0 -- dead chrome charged to the terminal. Capability alone decides.
    """
    source = STYLE.read_text(encoding='utf-8')

    # Entry 39: the shell tier is
    # width-driven, but the COMPOSER is exempt: it renders only on
    # pointer:coarse devices or the narrow-width tier. The desktop hide is
    # therefore scoped (fine) and (hover) and NOT narrow-width, so a merely
    # narrowed desktop window (390) still gets the composer.
    desktop = re.search(
        r'@media \(pointer: fine\) and \(hover: hover\) '
        r'and \(min-width: 768px\)\s*\{\s*'
        r'\.session-bar \{\s*display: none !important;', source)
    assert desktop, (
        'the desktop .session-bar default no longer matches its contract: '
        '@media (pointer: fine) and (hover: hover) and (min-width: 768px) '
        'with display: none !important (entry 39 composer exemption)')
    # The converse, so this cannot silently drift back: gating the desktop hide
    # on a viewport height is the D3-era defect this model replaced, and it is
    # what re-introduced dead chrome. A height term here must fail.
    assert not re.search(
        r'@media \(pointer: fine\) and \(hover: hover\)[^{]*'
        r'\((?:min|max)-height:', source), (
        'the desktop .session-bar default regained a viewport-height term; '
        'capability, not height, decides whether the dock exists'
    )

    # The canonical touch block is located by BRACE MATCHING its body, not by
    # requiring `.session-bar` to be the first rule after the opening brace.
    # The previous regex demanded that adjacency and so pinned the ORDER of
    # declarations inside the block: the canonical block legitimately opens with
    # the .deck-window / .main-content / .header flow rules and states
    # `.session-bar { display: flex !important }` further down, which failed the
    # match while the contract itself held. (Verified: that regex also fails
    # against HEAD, so it had been red since the block was reordered.) Matching
    # the block CONTENTS keeps every guarantee -- dropping either !important
    # rule, or moving it out of a capability-gated block, still fails.
    # Entry 39: the canonical touch query carries the narrow-width
    # term, so a 1024px-wide coarse tablet and a 390px fine-pointer emulation
    # both land in the same block.
    # Owner correction: primary capability as a conjunction, so a
    # fine-pointer desktop carrying a touchscreen keeps the approved desktop
    # shell. Read from the module constant rather than restated, so this test
    # cannot drift from the pinned value.
    coarse_query = TOUCH_SHELL_QUERY
    touch_start = None
    for match in MEDIA.finditer(source):
        if match.group(1).strip() != coarse_query:
            continue
        depth = 1
        i = match.end()
        while i < len(source) and depth:
            if source[i] == '{':
                depth += 1
            elif source[i] == '}':
                depth -= 1
            i += 1
        body = source[match.end():i - 1]
        if re.search(r'\.session-bar \{\s*display: flex !important;', body):
            touch_start = match.start()
            touch_body = body
    assert touch_start is not None, (
        'the canonical touch .session-bar override no longer matches its '
        'contract: @media (pointer: coarse), (hover: none), (any-pointer: '
        'coarse) with display: flex !important'
    )

    # The touch block must also turn the composer bar on -- an iPad needs the
    # input bar, not just an empty dock band.
    assert re.search(
        r'\.mobile-input-bar \{\s*display: flex !important;', touch_body), (
        'the canonical touch block no longer turns .mobile-input-bar on')

    # Load-bearing order: the touch override must come AFTER the desktop
    # default, or the equal-specificity !important rules would let the desktop
    # default win and the iPad dock would disappear again.
    assert touch_start > desktop.start(), (
        'the canonical touch override now precedes the desktop default, so the '
        'desktop default wins on source order and touch shells lose their dock'
    )


def test_no_width_only_block_hides_the_dock():
    """Width may gate density, never structural dock visibility.

    Any @media block that sets `display: none` on the dock (.session-bar) or
    the composer (.mobile-input-bar) must carry a capability term (pointer /
    hover / any-pointer) in its query. A width- or height-only hide is exactly
    the D3 shape and is banned.
    """
    source = STYLE.read_text(encoding='utf-8')
    HIDE = re.compile(
        r'\.(?:session-bar|mobile-input-bar)\s*\{[^}]*display:\s*none',
        re.DOTALL)
    CAPABILITY = re.compile(r'pointer|hover')

    for query, body in media_blocks(source):
        if CAPABILITY.search(query):
            continue  # capability-gated block: allowed to hide
        assert not HIDE.search(body), (
            f'a non-capability block hides the dock: @media {query}')


def test_capability_query_never_uses_unsupported_negation():
    """The canonical query must not encode touch as a negated fine test.

    `(pointer: fine) and (hover: hover) and not (any-pointer: coarse)` is not a
    safe cross-browser form and, worse, a device that matches none of the
    capability terms would silently fall through. The model is additive (an OR
    of coarse / hover:none / any-pointer:coarse) with a desktop DEFAULT that
    the canonical block overrides by order -- never a `not (...)`.
    """
    source = STYLE.read_text(encoding='utf-8')
    assert 'not (any-pointer' not in source, (
        'style.css encodes the touch shell as a negation; use the additive '
        'canonical query + cascade order instead')
    assert 'not(any-pointer' not in source


def test_capability_query_matches_the_shared_js_helper():
    """CSS and JS must answer "is this a touch shell?" identically.

    The canonical query string is defined once as TerminalManager.TOUCH_SHELL_
    QUERY and mirrored by header-menus.js and by the three CSS media blocks.
    If they drift, CSS could show the dock while JS routes focus as desktop
    (or vice versa). Pin the literal string in both places.
    """
    css = STYLE.read_text(encoding='utf-8')
    tm = Path('static/js/terminal-manager.js').read_text(encoding='utf-8')
    hm = Path('static/js/header-menus.js').read_text(encoding='utf-8')

    # Entry 39 + owner correction: primary capability as a
    # conjunction, with the narrow-width fallback as the second OR branch.
    QUERY = '(pointer: coarse) and (hover: none), (max-width: 767px)'

    assert QUERY in tm, 'terminal-manager.js lost the canonical touch query'
    assert re.search(
        r"TOUCH_SHELL_QUERY:\s*'\(pointer: coarse\) and \(hover: none\), "
        r"\(max-width: 767px\)'", tm), (
        'TOUCH_SHELL_QUERY no longer holds the exact canonical query')
    # The query appears in at least the three structural CSS blocks: the More
    # sheet, the keypad and the canonical dock override.
    assert css.count(QUERY) >= 3, (
        f'expected the canonical query in >=3 CSS blocks, found {css.count(QUERY)}')
    # header-menus.js mirrors it (as the fallback that guarantees lockstep).
    assert QUERY in hm, 'header-menus.js no longer mirrors the canonical query'


def media_blocks(source):
    """Yield (query, body) for each top-level @media block, brace-matched."""
    out = []
    for match in MEDIA.finditer(source):
        depth = 1
        i = match.end()  # position just after the opening '{'
        while i < len(source) and depth:
            if source[i] == '{':
                depth += 1
            elif source[i] == '}':
                depth -= 1
            i += 1
        out.append((match.group(1).strip(), source[match.end():i - 1]))
    return out


def test_every_phone_block_shares_one_upper_bound():
    """Phone-width blocks must all stop at the same pixel.

    Mixing 767 and 768 as "the phone bound" is how the overlap appeared in the
    first place; one number means a reader can trust any single occurrence.
    """
    queries = media_queries()
    bounds = {int(m) for q in queries for m in MAX_WIDTH.findall(q)
              if 700 <= int(m) <= 820}

    assert bounds == {767}, (
        f'phone blocks disagree on their upper bound: {sorted(bounds)}'
    )


# Entry 39: width-driven touch tier; the canonical query carries the
# narrow-width term alongside the capability terms.
#
# OWNER CORRECTION. This constant used to be the four-way OR
#
#     (pointer: coarse), (hover: none), (any-pointer: coarse), (max-width: 767px)
#
# and this file's job is to pin whatever the canonical query IS -- so when the
# owner ruled that a fine-pointer desktop carrying a touchscreen must keep the
# desktop shell, the pinned value had to move with it. The standalone
# (hover: none) and (any-pointer: coarse) branches both matched such a desktop
# and cost it the approved shell; primary capability is now a CONJUNCTION.
#
# The narrow-width fallback is unchanged and still deliberate (Entry 39).
TOUCH_SHELL_QUERY = '(pointer: coarse) and (hover: none), (max-width: 767px)'
SHORT_LANDSCAPE_TERMS = (
    '(pointer: coarse) and (hover: none) and (max-height: 500px)',
)


def _without_comments(source):
    """Strip /* ... */ so prose about a removed selector is not a use of it.

    The stylesheet documents the table removal by naming the old selectors, so a
    plain substring search for them matches the explanation and never the rule.
    """
    return re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)


def test_command_library_rail_keeps_its_responsive_steps():
    """The Command Library has three genuine steps -- do not collapse them.

    Fine-pointer desktop is a side rail, the canonical coarse capability block
    turns it into a bottom sheet that leaves the terminal visible, and short
    landscape drops the OS filter and the header-actions cluster to buy sheet
    height.

    P2 (bucket P) rebuilt each library entry as ONE tappable 46px row per
    mockup v5 line 181, replacing the old wrapped vertical cards. The new row
    layout lives in deck.css. The touch bottom-sheet positioning and the short-
    landscape OS-filter removal remain in style.css, which is what this test
    reads for breakpoint contracts.

    Guards:
    - The five-column table selectors must stay gone from style.css.
    - The row base rule must live in deck.css with flex-direction: row (the only
      correct layout per v5 line 181).
    - The row code/small must CLIP in deck.css (white-space: nowrap) so a long
      command never pushes the trailing glyph outside its 46px row.
    - The touch bottom-sheet declarations must remain in style.css.
    - Short landscape must still drop the OS-filter toolbar in style.css.
    - The old short-landscape flex-direction exception is gone: the row is
      already single-line at every tier, so there is nothing to compact.
    """
    DECK = Path('static/css/deck.css')
    style_src = STYLE.read_text(encoding='utf-8')
    style_rules = _without_comments(style_src)
    deck_rules = _without_comments(DECK.read_text(encoding='utf-8'))
    style_blocks = media_blocks(style_rules)

    # Dead table selectors must not return.
    for selector in ('.commands-table-wrapper', '.commands-table-header',
                     '.commands-table-body'):
        assert selector not in style_rules, (
            f'{selector} is back in style.css; the Command Library ships single-'
            'line rows, not a five-column table'
        )
        assert selector not in deck_rules, (
            f'{selector} is back in deck.css; same reason'
        )

    # The row base rule now lives in deck.css and must be a row (mockup v5
    # line 181 draws ONE 46px tappable row per entry, not a stacked card).
    card = re.search(r'\n\.command-row \{(.*?)\n\}', deck_rules, re.DOTALL)
    assert card, '.command-row base rule not found in deck.css'
    assert 'flex-direction: row' in card.group(1), (
        'v5 line 181 requires a single horizontal row; flex-direction: column '
        'is the old stacked-card design which was removed in bucket P2'
    )

    # Code clips, not wraps: the row is a fixed 46px, so a wrapping command
    # would push the trailing glyph outside its row. The clipping declarations
    # deliberately live in the grouped code/small rule; the following code-only
    # rule owns typography only. Match that ownership explicitly rather than
    # forcing a duplicate white-space declaration into production CSS.
    code = re.search(
        r'\n\.command-rail-item code,\s*\n\.command-rail-item small '
        r'\{(.*?)\n\}', deck_rules, re.DOTALL)
    assert code, '.command-rail-item code/small clipping rule not found in deck.css'
    assert 'white-space: nowrap' in code.group(1), (
        'code inside a 46px row must clip (white-space: nowrap), not wrap '
        '(white-space: pre-wrap was the card-era rule)'
    )

    # Touch bottom-sheet declarations must remain in style.css.
    sheet = [body for query, body in style_blocks
             if ' '.join(query.split()) == TOUCH_SHELL_QUERY
             and re.search(r'\n\s*\.command-rail \{', body)]
    assert len(sheet) == 1, (
        f'expected exactly one canonical capability block to define the rail '
        f'bottom sheet, found {len(sheet)}'
    )
    sheet = sheet[0]

    for declaration in ('position: absolute', 'left: 0', 'right: 0',
                        'bottom: 0', 'transform: translateY(100%)'):
        assert declaration in sheet, (
            f'the touch bottom sheet lost `{declaration}`; the rail must dock '
            'off-screen at the bottom rather than occupy a grid track'
        )

    assert 'height: min(56dvh, 66%)' in sheet, (
        'the sheet must be height-capped so the live terminal stays visible'
    )
    assert '.command-rail.aux-open' in sheet and 'translateY(0)' in sheet, (
        'the open state must slide the sheet up'
    )

    # Short-landscape: the OS filter toolbar is dropped in style.css.
    short = [body for query, body in style_blocks
             if all(term in ' '.join(query.split())
                    for term in SHORT_LANDSCAPE_TERMS)]
    assert len(short) == 1, (
        f'expected exactly one short-landscape block, found {len(short)}'
    )
    short = short[0]

    toolbar = re.search(
        r'\.command-rail \.os-filter-toolbar \{(.*?)\n\s*\}', short, re.DOTALL)
    assert toolbar, (
        'short landscape no longer has a .command-rail .os-filter-toolbar rule'
    )
    assert 'display: none' in toolbar.group(1), (
        'short landscape must still drop the OS filter to buy sheet height; '
        f'found declarations: {toolbar.group(1).strip()!r}'
    )
    # The short-landscape flex-direction: row exception is gone: every tier
    # already renders a single horizontal row (flex-direction: row in the base
    # deck.css rule), so there is nothing left to compact in this block.
    assert 'flex-direction: row' not in short, (
        'short landscape must not re-assert flex-direction: row; the row is '
        'already horizontal in deck.css at every tier, and restating it here '
        'would mask a regression in the base rule'
    )


def test_narrow_form_bounds_stay_where_they_are():
    """480 and 520 are upper bounds that already fit their content.

    Both are tempting to "tidy" into a shared 479px phone bound.  Measuring says
    otherwise: dropping the 520px stop to 479px costs 480-520px its two-column
    mode selector and its stacked set picker, and dropping the 480px stop costs
    480px its entire phone layout.  They are pinned by value because the reason
    they are correct is not visible from reading them.
    """
    queries = media_queries()
    bounds = {int(m) for q in queries for m in MAX_WIDTH.findall(q)
              if 400 <= int(m) <= 600}

    assert bounds == {480, 520}, (
        f'the narrow-form breakpoints moved: expected {{480, 520}}, '
        f'got {sorted(bounds)}'
    )

    source = STYLE.read_text(encoding='utf-8')
    narrow = re.search(
        r'@media \(max-width: 520px\) \{(.*?)\n\}', source, re.DOTALL)
    assert narrow, 'no max-width: 520px block'
    assert '.command-set-selector-row' in narrow.group(1)
    assert '.post-connect-mode-selector' in narrow.group(1)


def test_mode_selector_narrow_rule_wins_over_the_base_rule():
    """Source order is load-bearing here, so assert the order, not just the rule.

    `.post-connect-mode-selector` sets four columns at no breakpoint at all.
    The two-column override has the same specificity, so it only wins if it
    appears later in the file.  Moving it earlier silently gives phones four
    columns -- which happened once while writing this change.

    Both positions are selector-scoped.  A bare search for the declaration text
    is not unique in this stylesheet: `.mobile-more-actions` declares the same
    `repeat(2, minmax(0, 1fr))` far earlier, so an unscoped comparison measures
    that rule instead and fails while both real rules are correctly ordered.
    """
    source = STYLE.read_text(encoding='utf-8')

    FOUR = 'grid-template-columns: repeat(4, minmax(0, 1fr));'
    TWO = 'grid-template-columns: repeat(2, minmax(0, 1fr));'

    base_rule = re.search(
        r'\n\.post-connect-mode-selector \{(.*?)\n\}', source, re.DOTALL)
    assert base_rule, '.post-connect-mode-selector base rule not found'
    assert FOUR in base_rule.group(1), (
        'the base .post-connect-mode-selector rule no longer sets four columns')

    narrow = re.search(
        r'@media \(max-width: 520px\) \{(.*?)\n\}', source, re.DOTALL)
    assert narrow, 'no max-width: 520px block'
    override_rule = re.search(
        r'\.post-connect-mode-selector \{(.*?)\n    \}',
        narrow.group(1), re.DOTALL)
    assert override_rule, (
        'the 520px block no longer overrides .post-connect-mode-selector')
    assert TWO in override_rule.group(1), (
        'the 520px .post-connect-mode-selector override no longer sets two '
        'columns')

    base = base_rule.start(1) + base_rule.group(1).index(FOUR)
    override = (narrow.start(1) + override_rule.start(1)
                + override_rule.group(1).index(TWO))

    assert override > base, (
        'the 2-column override for .post-connect-mode-selector now sits before '
        'the 4-column base rule, so it loses on source order'
    )


def test_notepad_open_btn_is_relocated_on_touch_not_duplicated():
    """Note is MOVED to the touch action row, never cloned or CSS-hidden.

    The old contract hid `.tab-row-actions #notepadOpenBtn` with display:none on
    coarse pointers, so the desktop copy stayed in the DOM while a second Note
    control drove the sheet. The v5 shell replaced that with relocation:
    touch-action-row.js records each action's real home once and moves the one
    element between the desktop toolbar and the action row.

    That makes duplication -- not cascade order -- the failure mode worth
    pinning. Two Note controls would both answer to the same id, and the sheet
    would drive whichever one the DOM happened to return first. So this asserts
    a single #notepadOpenBtn, that it is a declared relocation target, and that
    the relocator never falls back to hiding it.
    """
    template = INDEX.read_text(encoding='utf-8')
    assert template.count('id="notepadOpenBtn"') == 1, (
        'Note must exist exactly once; a second copy would make the sheet act '
        'on whichever element the DOM returned first'
    )
    assert 'id="mobileNotepadBtn"' not in template, (
        'the separate mobile Note button was retired in favour of relocating '
        'the single canonical control'
    )

    row = TOUCH_ACTION_ROW.read_text(encoding='utf-8')
    assert "{ id: 'notepadOpenBtn' }" in row, (
        'Note is no longer a declared relocation target, so it would be left '
        'behind in the desktop toolbar on touch'
    )
    # The second assertion here required Note to appear a SECOND time, as
    # "{ id: 'notepadOpenBtn', label: 'terminal.notepad' }" in the PRIMARY list.
    # That list is gone (owner correction, second pass): its
    # into-the-sheet path was never reached -- both sync() branches called
    # dockPrimary(false) once phone landscape gained its 40px header band
    # (entry 1) -- and the two extra row classes it declared for the
    # menu surface are what let a second visual row system exist there. Note's
    # relocation is fully expressed by the RELOCATED entry asserted above; a
    # duplicate declaration is what this file elsewhere calls the cascade hazard.
    # Comment-stripped, so the note above explaining the removal is not itself
    # read as a use of the removed code -- the same reason _without_comments()
    # exists for the stylesheet assertions in this file.
    row_code = _without_comments(row)
    assert 'const PRIMARY = [' not in row_code, (
        'the dead PRIMARY-into-sheet list is back; it declares a second row '
        'shape for the one canonical menu'
    )
    assert 'dockPrimary' not in row_code, (
        'dockPrimary() is back; its only call sites passed intoSheet=false, so '
        'it moved nothing while advertising a second sheet entry shape'
    )

    # The relocator must move, not hide: a display:none path would resurrect the
    # exact duplication the v5 shell removed.
    assert 'notepadOpenBtn' not in _without_comments(
        STYLE.read_text(encoding='utf-8')), (
        'style.css targets #notepadOpenBtn again; the touch shell relocates it '
        'instead of hiding it, so an ID rule here would fight the relocation'
    )
