"""The committed browser fixtures still match what the server produces.

Owner, ("Tại sao test mà lại liên quan đến tmp vậy?"): the browser
gates used to read their fixtures from /tmp, so a reboot left them permanently
red and nothing noticed. The fixtures live in `tests/fixtures/` now, and these
rows are what keeps a committed fixture from going quietly stale against the
code it was generated from.
"""
import pathlib

FIXTURES = pathlib.Path(__file__).parent / 'fixtures'


def _verbatim(name):
    """The fixture's exact bytes. `read_text` would translate CRLF to LF --
    and CRLF is the property under test: a bare LF stair-steps the transcript
    across the screen instead of scrolling it."""
    return (FIXTURES / name).read_bytes().decode('utf-8')


def test_the_history_fixture_matches_the_current_normaliser():
    import sys
    sys.path.insert(0, str(FIXTURES))
    import gen_history_fixture

    committed = _verbatim('b4_history_stream.txt')
    assert committed == gen_history_fixture.build(), (
        'tests/fixtures/b4_history_stream.txt no longer matches what '
        '_normalise_history_text produces. The browser gate would be measuring '
        'bytes the server never sends: regenerate it with '
        '.venv/bin/python tests/fixtures/gen_history_fixture.py and read the '
        'diff before committing -- a changed shape is a product change.'
    )


def test_the_history_fixture_is_the_shape_the_gate_expects():
    stream = _verbatim('b4_history_stream.txt')
    lines = [line for line in stream.split('\r\n') if line]
    assert '\x1b' not in stream, 'an escape survived the normaliser'
    assert '\n' not in stream.replace('\r\n', ''), 'a bare LF survived'
    assert lines[0] == 'HXLINE-0001'
    assert lines[-1] == 'HXLINE-0400'
    assert len(lines) == 400


def test_the_live_replay_capture_is_present_and_usable():
    """The verbatim bytes of one real restore, re-captured from the live
    server on 2026-09-18 with tests/fixtures/capture_live_replay.mjs."""
    capture = _verbatim('live_replay_chunk.txt')
    lines = [line for line in capture.split('\r\n') if line]
    assert len(lines) > 100, 'the capture is too short to scroll a screenful'
    assert 'CAPLINE-356' in capture
    assert 'CAPLINE-400' in capture
