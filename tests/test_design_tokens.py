"""Guard the spacing and radius token scale in style.css.

The point of these tokens is that the stylesheet has ONE list of step sizes and
uses it, instead of 20 loose numbers where a 10 and a 12 mean the same thing to
the person writing them.  So the tests here check two things: that the scale is
declared with the values it was measured from, and that spacing declarations
actually reach for it instead of re-typing the number.

What they deliberately do NOT check: that every px in the file is a token.  Some
values are genuinely off the scale (5, 7, 9, 11, 13, 26, 40) and folding them in
would move real pixels -- a design decision, not a rename.  Borders, shadows,
transforms and font sizes are not spacing and are out of scope.
"""
import re
from pathlib import Path

STYLE = Path('static/css/style.css')

SPACING_PROPS = (
    'padding', 'margin', 'gap', 'row-gap', 'column-gap',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
)

# The scale, as measured: 92% of the 298 px values inside padding/margin/gap.
EXPECTED_SPACING = {
    '--sp-2': '2px', '--sp-4': '4px', '--sp-6': '6px', '--sp-8': '8px',
    '--sp-10': '10px', '--sp-12': '12px', '--sp-14': '14px',
    '--sp-16': '16px', '--sp-18': '18px', '--sp-20': '20px',
    '--sp-24': '24px', '--sp-32': '32px',
}

EXPECTED_RADIUS = {
    '--radius-sm': '4px', '--radius-md': '6px',
    '--radius-lg': '8px', '--radius-pill': '999px',
}

DECL = re.compile(r'^[ \t]*([a-z-]+)[ \t]*:[ \t]*([^;]+);', re.MULTILINE)
BARE_PX = re.compile(r'(?<![\w.-])(\d+)px\b')


def source():
    return STYLE.read_text(encoding='utf-8')


def root_block():
    text = source()
    start = text.index(':root {')
    return text[start:text.index('\n}', start)]


def test_the_scale_is_declared_with_the_values_it_was_measured_from():
    """Each token must keep its pixel value.

    These are not arbitrary names: --sp-12 is 12px because 12px is what the
    stylesheet used 59 times.  If a value drifts, every one of the ~250 call
    sites moves at once, which is exactly the failure a token scale invites.
    """
    root = root_block()
    for token, value in {**EXPECTED_SPACING, **EXPECTED_RADIUS}.items():
        assert f'{token}: {value};' in root, (
            f'{token} is missing from :root or no longer equals {value}'
        )


def test_no_scale_has_two_tokens_with_the_same_value():
    """Two names for one number, WITHIN a scale, defeats the purpose.

    This is the mistake --danger-color/--error-color already made in this file:
    synonyms leave the next person guessing which to use.

    Checked per scale, not across them: --sp-4 and --radius-sm are both 4px and
    that is fine -- one is a distance between things, the other is how round a
    corner is.  They are free to diverge later precisely because they are
    separate names.
    """
    root = root_block()
    for scale in (EXPECTED_SPACING, EXPECTED_RADIUS):
        values = {}
        for token in scale:
            found = re.search(rf'{re.escape(token)}:\s*([^;]+);', root)
            assert found, f'{token} not declared'
            value = found.group(1).strip()
            assert value not in values, (
                f'{token} and {values[value]} are both {value}'
            )
            values[value] = token


def test_spacing_declarations_use_the_scale_instead_of_repeating_the_number():
    """No spacing value may re-type a number the scale already names.

    A literal 12px next to a var(--sp-12) is how the scale rots: it looks
    tokenised, so nobody notices half the file is not.
    """
    on_scale = {int(v.rstrip('px')) for v in EXPECTED_SPACING.values()}
    offenders = []

    for prop, value in DECL.findall(source()):
        if prop not in SPACING_PROPS:
            continue
        for number in BARE_PX.findall(value):
            if int(number) in on_scale:
                offenders.append(f'{prop}: {value}')

    assert not offenders, (
        'spacing declarations still hard-code a value the scale names: '
        + '; '.join(sorted(set(offenders))[:8])
    )


def test_the_scale_is_actually_used_across_the_stylesheet():
    """Declaring tokens nobody references would be worse than not having them.

    Pinned as a floor, not an exact count, so ordinary edits do not fail this;
    it exists to catch a mass revert that leaves the declarations orphaned.
    """
    uses = len(re.findall(r'var\(--sp-\d+\)', source()))
    assert uses > 200, f'only {uses} spacing token references left'


def test_off_scale_spacing_values_are_left_as_literals():
    """The values that are off the scale must stay off it.

    5, 7, 9, 11, 13, 26 and 40 are not on the scale; if one of them turns into
    a var() then either the scale grew silently or a value got rounded, and
    rounding moves pixels.  Either way it is not a rename any more.
    """
    off_scale = {5, 7, 9, 11, 13, 26, 40}
    root = root_block()

    for number in off_scale:
        assert f'--sp-{number}:' not in root, (
            f'--sp-{number} appeared: the scale grew, so this is no longer a '
            f'pure rename'
        )


def test_touch_target_minimum_is_untouched():
    """44px is a tested accessibility contract, not a spacing step.

    It must not be folded into the scale even though 44 is on a 4px grid: it
    means "the smallest thing a finger can hit", which is a different idea from
    "one unit of space".
    """
    assert '--touch-target-min: 44px;' in root_block()
