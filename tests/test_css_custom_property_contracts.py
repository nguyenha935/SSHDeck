"""Guards for the custom properties that cross the JS/CSS boundary.

Two directions, both invisible to a normal review:

  JS writes -> CSS reads   app.js sets --notepad-width on .workspace; the grid
                           and the drag handle read it. Rename either side and
                           the layout silently falls back to its initial column
                           width with no error anywhere.

  CSS declares -> JS reads terminal-manager.js pulls the xterm colour scheme out
                           of CSS with getComputedStyle. These properties look
                           unused to any CSS tool because nothing in the
                           stylesheet references them, so a "dead token" cleanup
                           would drop them and the terminal would stop following
                           the theme.
"""
import re
from pathlib import Path

STYLE = Path('static/css/style.css')
APP_JS = Path('static/js/app.js')
TERMINAL_JS = Path('static/js/terminal-manager.js')


def _declared_properties(css):
    return set(re.findall(r'^\s*(--[a-z0-9-]+)\s*:', css, re.MULTILINE))


NOTEPAD_WIDTH_CONSUMERS = {
    ('.workspace', 'grid-template-columns'),
    ('.resize-handle', 'right'),
    # Not a layout site: the alias declaration itself. Listed so it stays
    # reviewed, since it is the hop the aux-open rules below depend on.
    (':root', '--inspector-width'),
}

# The two aux-open sites read --inspector-width, which :root declares as
# `var(--notepad-width)`. The drag-written width still reaches them, through one
# documented alias. They are listed separately rather than folded into the set
# above so the indirection stays visible: if that alias were ever redeclared as
# a literal, these rules would silently stop tracking the drag.
INSPECTOR_WIDTH_CONSUMERS = {
    ('.workspace:has(.command-rail.aux-open)', 'grid-template-columns'),
    ('.workspace:has(.command-rail.aux-open) .resize-handle', 'right'),
}


def _rules_reading(css, prop):
    """Every (selector, property) pair whose value reads `prop`.

    Declaration based, not line based. A declaration is buffered from its
    property name until the terminating `;` (or the rule's closing brace) and
    `prop` is matched against the JOINED text, so a value wrapped onto following
    lines is still attributed to its property.

    This used to compare per line, which silently under-reported: a declaration
    whose property name and `var()` sat on different lines was invisible to the
    guard, so a consumer could stop reading the token with the assertion still
    green. See Entry 31.
    """
    found = set()
    selector = None
    pending_property = None
    pending_value = []

    def flush():
        """Attribute the buffered declaration, if it read `prop`."""
        nonlocal pending_property, pending_value
        if pending_property is not None and selector:
            if f'var({prop}' in ' '.join(pending_value):
                found.add((selector, pending_property))
        pending_property = None
        pending_value = []

    for line in css.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # A wrapped value never ends in `{`, so rule/at-rule handling is safe to
        # test first; an unterminated declaration is discarded at the boundary.
        if stripped.endswith('{') and not stripped.startswith('@'):
            flush()
            selector = stripped[:-1].strip()
            continue
        if stripped.startswith('}'):
            flush()
            selector = None
            continue
        if selector is None:
            continue
        if pending_property is None:
            # A declaration starts only where a property name is followed by ':'.
            # Guard against ':' inside a selector-like line or a value fragment.
            if ':' not in stripped:
                continue
            name, _, rest = stripped.partition(':')
            name = name.strip()
            if not name or ' ' in name or '(' in name:
                continue
            pending_property = name
            pending_value = [rest]
        else:
            pending_value.append(stripped)
        # `;` terminates the declaration; without it the value continues onto
        # the next line (the multi-line case this parser exists to handle).
        if ';' in pending_value[-1]:
            flush()
    flush()
    return found


def test_notepad_width_is_declared_once_and_read_without_fallbacks():
    css = STYLE.read_text(encoding='utf-8')

    assert '--notepad-width: clamp(240px, 24vw, 320px);' in css

    consumers = _rules_reading(css, '--notepad-width')

    missing = NOTEPAD_WIDTH_CONSUMERS - consumers
    assert not missing, (
        f'these rules no longer read --notepad-width: {sorted(missing)}; the '
        'JS-written width would silently stop reaching the layout'
    )

    extra = consumers - NOTEPAD_WIDTH_CONSUMERS
    assert not extra, (
        f'unreviewed consumer of --notepad-width: {sorted(extra)}; every reader '
        'of the drag-written width must be an intentional layout site'
    )

    # The alias must resolve to the drag-written token, not a literal, or the
    # aux-open sites below would stop tracking the drag without any rule
    # visibly changing.
    assert '--inspector-width: var(--notepad-width);' in css

    inspector = _rules_reading(css, '--inspector-width')
    missing_alias = INSPECTOR_WIDTH_CONSUMERS - inspector
    assert not missing_alias, (
        f'these rules no longer read --inspector-width: {sorted(missing_alias)}; '
        'the JS-written width would silently stop reaching the aux-open layout'
    )
    extra_alias = inspector - INSPECTOR_WIDTH_CONSUMERS
    assert not extra_alias, (
        f'unreviewed consumer of --inspector-width: {sorted(extra_alias)}; every '
        'reader of the aliased width must be an intentional layout site'
    )

    uses = re.findall(r'var\(--notepad-width[^)]*\)', css)
    for use in uses:
        assert use == 'var(--notepad-width)', (
            f'{use} repeats the resting width as a fallback; the declaration in '
            ':root is the single source of truth'
        )


def test_app_js_still_writes_the_property_css_reads():
    app = APP_JS.read_text(encoding='utf-8')

    assert "setProperty('--notepad-width'" in app
    assert "removeProperty('--notepad-width')" in app


def test_notepad_drag_leaves_terminal_fitting_to_resize_observer():
    """Pointermove may change the track but must not queue fit timers.

    terminal-manager owns a debounced ResizeObserver for the wrapper, so an
    explicit delayed fit here creates one additional layout measurement per drag
    event and turns a sustained resize into timer fan-out.
    """
    app = APP_JS.read_text(encoding='utf-8')
    match = re.search(
        r'const resize = \(e\) => \{(?P<body>[\s\S]*?)\n\s*const stopResize =',
        app,
    )
    assert match, 'setupResizeHandle no longer exposes the resize callback shape'
    body = match.group('body')

    assert "setProperty('--notepad-width'" in body, (
        'the drag callback no longer changes the auxiliary track it owns'
    )
    assert 'setTimeout(' not in body, (
        'the drag callback queues delayed work per pointermove; the terminal '
        'ResizeObserver must remain the single debounced fit owner'
    )
    assert 'TerminalManager.fitTerminal' not in body
    assert 'ssh_resize' not in body


def test_terminal_colours_read_from_css_are_all_declared():
    css = STYLE.read_text(encoding='utf-8')
    terminal = TERMINAL_JS.read_text(encoding='utf-8')

    read_from_css = set(re.findall(r"getCssVar\('(--[a-z0-9-]+)'", terminal))
    assert read_from_css, 'terminal-manager no longer reads any CSS variable'

    missing = sorted(read_from_css - _declared_properties(css))
    assert not missing, (
        f'terminal-manager.js reads {missing} but style.css never declares them; '
        'the terminal would fall back to hard-coded colours and stop following '
        'the active theme'
    )


def test_theme_blocks_all_carry_the_full_terminal_palette():
    """Every theme must override every colour terminal-manager reads.

    The check above only proves a property is declared *somewhere*. A theme that
    declares 22 of the 23 terminal colours still renders, but that one cell
    inherits :root and looks wrong against the rest of the palette -- and with
    ten themes the odds of noticing by eye are poor.
    """
    css = STYLE.read_text(encoding='utf-8')
    terminal = TERMINAL_JS.read_text(encoding='utf-8')

    palette = sorted(
        name for name in re.findall(r"getCssVar\('(--[a-z0-9-]+)'", terminal)
        if name.startswith('--term-')
    )
    assert palette, 'terminal-manager no longer reads any --term-* colour'

    counts = {name: len(re.findall(rf'{name}:', css)) for name in set(palette)}
    expected = max(counts.values())
    short = sorted(name for name, n in counts.items() if n < expected)
    assert not short, (
        f'{short} are declared fewer than {expected} times, so at least one theme '
        'inherits them from :root instead of overriding them'
    )


def test_every_property_css_uses_is_declared_or_written_by_js():
    css = STYLE.read_text(encoding='utf-8')

    used = set(re.findall(r'var\(\s*(--[a-z0-9-]+)', css))
    declared = _declared_properties(css)

    # \s* after the paren on purpose: these calls are long enough that the
    # property name often lands on the next line, and a same-line-only pattern
    # reports a contract as broken when it is merely wrapped.
    runtime_written = set()
    for source in (APP_JS, TERMINAL_JS):
        runtime_written.update(
            re.findall(r"setProperty\(\s*'(--[a-z0-9-]+)'",
                       source.read_text(encoding='utf-8'))
        )

    undefined = sorted(used - declared - runtime_written)
    assert not undefined, (
        f'style.css reads {undefined}, which nothing declares and no JS writes; '
        'those rules silently do nothing (or fall back to a literal that drifts '
        'from the theme)'
    )


def test_error_colour_is_the_one_name_for_the_danger_state():
    css = STYLE.read_text(encoding='utf-8')

    assert '--danger-color' not in css, (
        'style.css referenced --danger-color, a property that is never declared, '
        'while --error-color already exists and is themed'
    )

    per_theme = re.findall(r'--error-color:\s*([^;]+);', css)
    assert len(per_theme) >= 10, (
        f'--error-color is only declared {len(per_theme)} times; it should be set '
        'in :root plus every theme block'
    )
    assert len(set(v.strip() for v in per_theme)) > 1, (
        'every theme declares the same --error-color, so the danger state does '
        'not actually follow the theme'
    )
