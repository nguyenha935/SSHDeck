"""Step 3 / G8, G9, G12: Mobile Geometry, More Sheet, History Gestures, Add Connection.

Tests:
  * test_mobile_more_sheet_bottom_dock_upward_anchoring: verifies positionMobileMore
    anchors upward from dock with positive reachable maxHeight when trigger is inside dock.
  * test_mobile_touch_gesture_tmux_scroll_forwarding: S11 -- drives the real
    browser gesture suite (tests/browser/p1_tmux_vertical_gesture.mjs) so the
    tmux vertical-gesture contract is measured, not string-matched.
  * test_new_connection_button_visual_pill_geometry: verifies 34px visual pill inset inside 44px touch box.
"""
from pathlib import Path
import re

# The repository this file belongs to, found from the file itself: these tests
# read source files, and a checkout is not always at a deployment path (a fresh
# clone, a CI runner, a contributor's laptop). Measured: the three
# reads below named the server's own deployment directory, so this suite
# passed there and errored on every other checkout.
REPO = Path(__file__).resolve().parents[1]
import shutil
import subprocess

import pytest


def test_mobile_more_sheet_bottom_dock_upward_anchoring():
    header_menus = (REPO / 'static/js/header-menus.js').read_text(encoding='utf-8')
    assert 'function positionMobileMore()' in header_menus
    # P1 D2 (Entry 27 R4): anchor below the live trigger, not the dock.
    # bottom auto, right within the viewport, and maxHeight bounded by the
    # measured floor above the dock (or visual viewport).
    #
    # RE-POINTED, S17 step B. This row asserted the
    # literal `const top = rect.bottom + 1;`, i.e. 1px below the trigger's
    # PAINTED bottom. CLASSIFICATION: asserting-the-old-specification — that
    # premise IS the defect Entry 50 records. In phone landscape the band paints
    # 40px (Entry 1) but a finger reaches 44px (Entry 3's invisible ::after), and
    # because the card out-stacks the buttons it took rows 41..43 straight back
    # off all five hit boxes (measured 44x41). The authorising spec line is
    # Entry 3: the approved target is the REACHABLE box, so "1px below the
    # trigger" has to be measured from the edge a finger reaches.
    #
    # Not loosened: the 1px hang is still pinned exactly, and TWO further
    # assertions are added — the helper must exist, and it must consider both
    # edges rather than blindly trusting the pseudo-element.
    assert 'const top = reachableBottom + 1;' in header_menus
    assert 'function triggerReachableBottom(trigger, rect)' in header_menus
    assert 'return Math.max(rect.bottom, anchor + shift + height);' in header_menus
    assert "sheet.style.bottom = 'auto'" in header_menus
    assert 'sheet.style.right =' in header_menus
    assert 'const maxHeight = Math.max(120, Math.floor(floorY - top - 1));' in header_menus
    # The trigger (not a dock query alone) must be the measured anchor.
    assert 'trigger.getBoundingClientRect()' in header_menus


def test_mobile_touch_gesture_tmux_scroll_forwarding():
    """S11 (plan §5.2 / §8.8): BEHAVIOURAL, not string-presence.

    The original body was:

        assert 'setupTouchGestures(' in terminal_mgr
        assert 'isTmuxSession' in terminal_mgr
        assert '!isMouseTrackingOn() && !isTmuxSession' in terminal_mgr

    Why it was replaced (class (a), see /tmp/s11work/CLASSIFICATION.md): those
    three lines pinned the exact guard S5 deleted. `useTmux` is an app-level
    flag xterm knows nothing about, so gating the local-scroll branch on it was
    the P8 defect itself -- the test certified it. Worse, a string-presence
    assertion is green whatever the runtime does: it cannot see direction,
    amplitude, byte emission, or which row owns the gesture.

    The replacement measures the behaviour the old test was reaching for -- a
    vertical gesture on a tmux session scrolls history and emits no bytes -- with
    trusted CDP touch events in a real browser. That needs playwright, which
    lives on the node side of this repo, so this test DELEGATES to
    tests/browser/p1_tmux_vertical_gesture.mjs and fails on its exit code.
    Coverage does not fall: 3 string assertions become 34 measured ones (17 per
    viewport, at 390x844 and 926x428), including the T2 already-at-the-bottom
    no-op and the wheel-free mechanism rows that no string test could express.

    Skipped only when node or the browser is genuinely unavailable, never to
    hide a failure: a non-zero exit code from the suite fails this test and its
    output is attached to the assertion.
    """
    node = shutil.which('node')
    if node is None:
        pytest.skip('node is not available for the browser gesture suite')

    repo = REPO
    suite = repo / 'tests/browser/p1_tmux_vertical_gesture.mjs'
    assert suite.exists(), f'{suite} is the behavioural replacement and must exist'

    completed = subprocess.run(
        [node, str(suite)],
        cwd=str(repo),
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
    )
    output = f'{completed.stdout}\n{completed.stderr}'
    if completed.returncode != 0 and 'browserType.launch' in output:
        pytest.skip(f'chromium is not installed for playwright:\n{output[-800:]}')
    # The same precondition, one step earlier: on a runner that has node but has
    # never run `npm install`, the suite cannot even import playwright. That is
    # the browser toolchain being absent, not a defect -- and it is what the CI
    # workflow looks like today, which installs the Python side only.
    if completed.returncode != 0 and (
            "Cannot find package 'playwright'" in output
            or 'ERR_MODULE_NOT_FOUND' in output):
        pytest.skip(f'the browser toolchain is not installed:\n{output[-400:]}')

    assert completed.returncode == 0, (
        f'p1_tmux_vertical_gesture.mjs failed (rc={completed.returncode}):\n{output}'
    )
    # The suite must have actually run its rows -- a green exit with zero
    # assertions would be a vacuous pass.
    match = re.search(r'(\d+) passed, (\d+) failed', completed.stdout)
    assert match is not None, f'no result line in suite output:\n{output}'
    passed, failed = int(match.group(1)), int(match.group(2))
    assert failed == 0, f'{failed} gesture assertions failed:\n{output}'
    assert passed >= 34, (
        f'expected at least 34 measured assertions, got {passed}:\n{completed.stdout}'
    )


def test_new_connection_button_visual_pill_geometry():
    style = (REPO / 'static/css/style.css').read_text(encoding='utf-8')
    match = re.search(r'#newConnectionBtn\.strip-new-connection::before\s*\{([^}]+)\}', style)
    assert match is not None
    block = match.group(1)
    # 5px inset on 44px box yields 34px visual pill
    assert 'inset: 5px;' in block or 'inset: 5px' in block
