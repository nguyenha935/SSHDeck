"""Desurgery — a pan must not flip into selection mid-gesture.

THE DEFECT THE OWNER REPORTED ("pan janky"). The long-press timer armed at
touchstart for EVERY touch and was only cancelled once the finger crossed the
10px swipe threshold (MOVE_THRESHOLD). A slow or short pan that had not yet
travelled 10px within the 500ms window let the timer fire, so the gesture
flipped into text selection (`touch-selecting`, a real selection anchored under
the finger) in the middle of a swipe -- the pan stalled and the screen started
selecting instead.

THE FIX. A separate, smaller cancel radius (LONG_PRESS_CANCEL_PX) abandons the
pending long-press as soon as the finger starts to travel -- before the 10px
axis threshold -- so a pan reads as a pan from its first few pixels. A dead-still
long-press (zero travel) is untouched and still selects at 500ms, which is why
the 10px MOVE_THRESHOLD that decides swipe-vs-hold is deliberately left alone.

Inverted pins, read from disk in the same style as
tests/test_reconcile_evidence_cursor_row.py: each fails on the pre-fix source
(cancel keyed only on MOVE_THRESHOLD) and passes on the repaired one.
"""
from pathlib import Path

import pytest

TM_JS = (Path(__file__).resolve().parent.parent
         / 'static' / 'js' / 'terminal-manager.js')


@pytest.fixture(scope='module')
def source():
    return TM_JS.read_text(encoding='utf-8')


def _touchmove_listener(source):
    """The setupTouchGestures touchmove listener body."""
    start = source.index("wrapper.addEventListener('touchmove'")
    end = source.index("wrapper.addEventListener('touchend'", start)
    return source[start:end]


def test_a_separate_smaller_cancel_radius_exists(source):
    """The long-press cancel radius must be its own constant, below 10px."""
    assert 'LONG_PRESS_CANCEL_PX' in source, (
        "the dedicated long-press cancel radius is gone, so a pan can only "
        "abandon the timer at the 10px swipe threshold and a slow/short swipe "
        "flips into selection mid-gesture again")
    # It must be strictly smaller than MOVE_THRESHOLD, or it buys nothing.
    import re
    m = re.search(r'LONG_PRESS_CANCEL_PX\s*=\s*(\d+)', source)
    assert m, 'LONG_PRESS_CANCEL_PX has no numeric assignment'
    assert int(m.group(1)) < 10, (
        f"LONG_PRESS_CANCEL_PX={m.group(1)} is not below the 10px MOVE_THRESHOLD, "
        "so it cancels no earlier than the old code did")


def test_the_timer_is_cancelled_before_the_swipe_threshold(source):
    """touchmove must cancel the long-press on the small radius, while pending."""
    listener = _touchmove_listener(source)
    assert 'LONG_PRESS_CANCEL_PX' in listener, (
        "touchmove no longer cancels the long-press on the small radius, so the "
        "early-cancel never runs")
    assert 'longPressTimer !== null' in listener, (
        "the early cancel is not guarded on a pending timer; it must only act "
        "while the long-press is still armed")


def test_the_swipe_threshold_still_decides_swipe_versus_hold(source):
    """MOVE_THRESHOLD is unchanged: a dead-still finger still selects at 500ms."""
    assert 'const MOVE_THRESHOLD = 10;' in source, (
        "MOVE_THRESHOLD moved; a still-finger long-press depends on the 10px "
        "swipe threshold being the axis decision, not the cancel radius")
