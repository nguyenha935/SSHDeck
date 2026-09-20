"""S34 — the composer height publish must be a SETTLED measurement.

THE DEFECT, MEASURED (/tmp/s34/growth_diag.log and the sweep log).

`composer_growth_quantum` §Q1 allows AT MOST FOUR distinct published
`--composer-content-height` values while the box fills to its 4-line cap, and on the
real page the steady states use every one of them:

    lineHeight 20, vertical padding+border 24, cap 104
    published  ["62px", "82px", "102px", "104px"]     <- 2, 3, 4 lines, then clamped

So the budget has ZERO margin, and one transient frame overruns it. That is what
happened: the suite passed 8/8 standalone but went red about 1 run in 4 when it ran
after another composer suite in the sweep (`7 passed, 1 failed`,
"§Q1 at most four distinct published composer heights for six newlines").

WHY A TRANSIENT FRAME EXISTS AT ALL. The publish is quantized on the LINE COUNT, but
the measured HEIGHT is deliberately a trigger too -- a rotation or a split changes the
box height without changing the line count, and the dock must follow it. Inside a rAF,
however, `getBoundingClientRect()` can be read after the new content has been applied
but before the new box height has: that frame publishes a height belonging to no steady
state, and the next frame immediately supersedes it.

THE FIX, and why it does not hide a real change: the publish now requires the measured
height to MATCH the height its own line count settles at (within half a line). A frame
that does not is re-scheduled rather than published -- bounded to two retries, after
which it publishes anyway, because an unusual layout must never wedge the dock at a
stale height. A genuine width change settles at a new height for the SAME line count
within a frame or two and publishes normally, so responsiveness is unchanged.
"""
import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent
APP = (SOURCE / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
CSS = (SOURCE / 'static' / 'css' / 'style.css').read_text(encoding='utf-8')


def _publish_body():
    start = APP.index('const publishComposerContentHeight = () => {')
    rest = APP[start + 20:]
    nxt = re.search(r'\n        (?:const|let|var|function|window\.) ', rest)
    assert nxt is not None
    return APP[start:start + 20 + nxt.start()]


def _code(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'^\s*//.*$', '', text, flags=re.MULTILINE)


class TestOnlyASettledHeightIsPublished:

    def test_the_publish_compares_the_measurement_to_its_settled_height(self):
        code = _code(_publish_body())
        assert re.search(r'\bsettled\b', code), (
            'the publish must know what height its line count settles at')
        assert re.search(r'Math\.abs\(\s*height\s*-\s*settled\s*\)', code), (
            'the guard is the distance between the measurement and the settled height')

    def test_the_tolerance_is_derived_from_the_line_height(self):
        """Half a line: big enough to accept sub-pixel rounding, small enough that a
        whole line's difference is never mistaken for settled. A hardcoded pixel
        tolerance would break with the font size."""
        code = _code(_publish_body())
        assert re.search(r'lh\s*/\s*2', code)

    def test_an_unsettled_frame_reschedules_instead_of_publishing(self):
        code = _code(_publish_body())
        idx = code.index('Math.abs(')
        after = code[idx:idx + 400]
        assert 'publishComposerContentHeight()' in after
        assert 'return' in after

    def test_the_retry_is_bounded(self):
        """An unusual layout must never wedge the dock at a stale height, so the
        refusal has a ceiling and then publishes anyway."""
        code = _code(_publish_body())
        assert 'SETTLE_RETRIES' in code
        assert re.search(r'SETTLE_RETRIES\s*=\s*[1-9]', _code(APP))

    def test_the_attempt_counter_resets_on_a_publish(self):
        """Otherwise the second real change of the session could never retry."""
        code = _code(_publish_body())
        assert code.count('composerSettleAttempt = 0') >= 2

    def test_the_settled_height_is_clamped_by_the_cap(self):
        """Past the cap the box stops growing and the internal scroll takes over, so
        the settled height is the cap, not lines*lineHeight."""
        code = _code(_publish_body())
        assert re.search(r'Math\.min\(\s*cap\s*,', code)


class TestTheQuantizationContractIsIntact:

    def test_the_line_count_is_still_the_primary_trigger(self):
        code = _code(_publish_body())
        assert 'publishedLineCount' in code
        assert re.search(r'lines\s*===\s*publishedLineCount', code)

    def test_the_height_is_still_a_trigger(self):
        """A rotation or split changes the height without changing the line count."""
        code = _code(_publish_body())
        assert re.search(r'height\s*===\s*publishedHeight', code)

    def test_the_published_value_is_the_measured_height(self):
        """Never a computed approximation: the dock must match the textarea to the
        pixel, and `settled` is only used to decide WHETHER to publish."""
        code = _code(_publish_body())
        assert re.search(r"const next = height \+ 'px'", code)

    def test_the_publish_still_happens_in_one_animation_frame(self):
        code = _code(_publish_body())
        assert 'cancelAnimationFrame(composerMeasureFrame)' in code
        assert 'requestAnimationFrame(' in code

    def test_the_cap_is_measured_not_hardcoded(self):
        code = _code(_publish_body())
        assert 'composerCap()' in code

    def test_the_css_ceiling_still_matches_the_four_line_cap(self):
        """The two halves are one contract (style.css says so); a drift between them
        is what would make the settled height unreachable."""
        assert re.search(r'max-height:\s*108px', CSS)
        assert 'COMPOSER_CAP_LINES = 4' in APP
