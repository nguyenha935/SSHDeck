"""S36 — Backspace on an EMPTY composer must live on an event that actually fires.

THE DEFECT THIS PINS. The erase route for "the composer is empty but the terminal's
input line holds text" was implemented inside the `beforeinput` listener, guarded by
`localText === '' && sentLen === 0`. Because `value === sent + local` is an
invariant, that guard means the textarea is EMPTY -- and an empty textarea has
nothing to delete, so the browser announces no content mutation and `beforeinput`
never fires. The branch was unreachable for its entire life.

Measured on the deployed build against a real session (webkit 428x926, with
`ssh_input` shielded at `socket.emit` so no byte reached the live pane):

    box ""     6x Backspace -> keydown 6, keyup 6, beforeinput 0, emits 0
    box "abc"  2x Backspace -> keydown 2, beforeinput:deleteContentBackward 2,
                               input 2, emits 2

Zero `get_terminal_line`, zero `ssh_input`, no notification -- which is the same
zero the S17 note in the source quoted as the PRE-fix measurement ("probe4 B3: one
Backspace on an empty box emitted get_terminal_line=0 and ssh_input=0"). The fix
shipped into a branch that could not run, so the owner kept reporting the defect.

Desktop was always correct here by accident: `#mobileInputBar` computes
`display:none` there, so the key reaches xterm's own helper textarea and 70 presses
produced 70 real DEL bytes. Only the mobile composer has no such path, which is why
desktop probes could never see this.

These rows read app.js from disk, the inverted-pin style
tests/test_composer_taint_condition.py uses.
"""
from pathlib import Path

import pytest

APP_JS = (Path(__file__).resolve().parent.parent
          / 'static' / 'js' / 'app.js')


@pytest.fixture(scope='module')
def source():
    return APP_JS.read_text(encoding='utf-8')


def _keydown_listener(source):
    """The mobileInput keydown listener body."""
    start = source.index("mobileInput.addEventListener('keydown'")
    end = source.index("mobileInput.addEventListener", start + 10)
    return source[start:end]


def test_backspace_is_handled_on_keydown(source):
    """keydown is the ONLY event that fires for an empty textarea."""
    listener = _keydown_listener(source)
    assert "e.key === 'Backspace'" in listener, (
        "the mobileInput keydown listener no longer handles Backspace, so an "
        "empty composer has no erase route at all: beforeinput does not fire "
        "for an empty textarea (measured 6 presses -> 0 beforeinput)")


def test_the_empty_box_branch_sends_exactly_one_del_byte(source):
    """One press, one DEL. The terminal's own line editor decides what it erases."""
    listener = _keydown_listener(source)
    assert "emitTerminalInput(boundKey, '\\x7f')" in listener, (
        "the empty-box Backspace no longer emits a DEL byte through the write "
        "funnel, so the press is silent again -- the owner's report")


def test_the_empty_box_branch_is_gated_on_an_empty_box(source):
    """It must not steal Backspace from a draft that holds characters."""
    listener = _keydown_listener(source)
    assert "mobileInput.value !== ''" in listener, (
        "the keydown Backspace branch is no longer gated on an EMPTY box, so it "
        "would put a raw DEL on the wire for a non-empty local draft that the "
        "browser should edit in the box")


def test_composition_is_never_interrupted(source):
    """A Telex syllable in flight is local by construction."""
    listener = _keydown_listener(source)
    head = listener[:listener.index("if (e.key !== 'Enter')")]
    assert 'e.isComposing || mobileComposing' in head, (
        "the Backspace branch no longer defers to an active composition, so a "
        "Backspace rewriting a Vietnamese syllable would put a DEL on the wire "
        "for a character the remote never received")


def test_the_unreachable_beforeinput_erase_route_is_gone(source):
    """Deleted, not disabled: a dead branch that reads as live is a trap."""
    assert 'composer.eraseUnavailable' not in source, (
        "the notification from the unreachable beforeinput erase route is still "
        "referenced in app.js; that route could never run, so anything reachable "
        "through it is dead code that misleads the next reader")
    assert 'composer.lineCleared' not in source, (
        "the \\x15 line-kill fallback from the unreachable route is still "
        "referenced; the empty-box case now sends one DEL and never destroys the "
        "whole line")


def test_the_nonempty_draft_path_is_local(source):
    """A non-empty composer is purely local text: Backspace edits the box only.

    Desurgery removed the per-char streaming layer, so there is no
    streamed prefix and no whole-cluster DEL branch any more. The empty-box
    guard is what keeps a non-empty draft on the browser's ordinary local edit
    path (no byte on the wire); the keydown branch returns early for it.
    """
    listener = _keydown_listener(source)
    assert "if (mobileInput.value !== '') return;" in listener, (
        "the empty-box guard is gone, so a non-empty local draft would take the "
        "raw-DEL path instead of being edited locally in the box")
