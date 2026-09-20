#!/usr/bin/env python3
"""Regenerate `b4_history_stream.txt` from the SHIPPED history normaliser.

WHY A GENERATED FIXTURE. `tests/browser/s16_b4_attach_history.mjs` measures
what the browser does with the bytes the SERVER injects as scrollback. A
hand-written stream in the gate would measure the browser only: mutation b4_m2
(paint the history instead of streaming it) left that gate 32/0 green while six
pytest rows went red. So the bytes come from `_normalise_history_text` itself,
imported here rather than copied, which makes the fixture the server's own
output by construction.

WHY IT IS COMMITTED. The original lived in /tmp and disappeared with the
machine's reboot, leaving the gate permanently red (owner,: "Tại
sao test mà lại liên quan đến tmp vậy?"). It is a repo file now, and
`tests/test_fixture_freshness.py` fails if the committed bytes stop matching
what the current normaliser produces -- a stale fixture can no longer pass
unnoticed.

Run: .venv/bin/python tests/fixtures/gen_history_fixture.py
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# `config` refuses to import in production without a SECRET_KEY, and importing
# the app package is what makes this the SERVER's own normaliser. Generating a
# fixture is not production, so a throwaway key is supplied when the
# environment has none -- exactly what tests/conftest.py does.
os.environ.setdefault('SECRET_KEY', 'fixture-generation-only')

from app.ssh_manager import (  # noqa: E402  (path set above)
    HISTORY_MAX_BYTES, REPLAY_MAX_LINES, _normalise_history_text)

FIXTURE = pathlib.Path(__file__).with_name('b4_history_stream.txt')
LINES = 400


def raw_capture(lines=LINES):
    """One `capture-pane -p -J` answer in the shape tmux really returns.

    Decorated the way a real pane is -- SGR colour around a line, an OSC title
    tmux echoes back, a stray CR from a progress line, and a BEL -- so the
    fixture proves the normaliser's stripping rather than assuming it. What
    survives must be exactly the plain transcript.
    """
    out = []
    for number in range(1, lines + 1):
        text = f'HXLINE-{number:04d}'
        if number % 50 == 0:
            text = f'\x1b[1;32m{text}\x1b[0m'
        elif number % 37 == 0:
            text = f'\x1b]0;a title\x07{text}'
        elif number % 23 == 0:
            text = f'{text}\r'
        out.append(text)
    return '\n'.join(out) + '\n'


def build():
    return _normalise_history_text(raw_capture(), HISTORY_MAX_BYTES,
                                   REPLAY_MAX_LINES)


if __name__ == '__main__':
    stream = build()
    # newline='' so the CRLF terminators reach the file verbatim on any host.
    FIXTURE.write_text(stream, encoding='utf-8', newline='')
    print(f'{FIXTURE}: {len(stream)} bytes, '
          f'{len([l for l in stream.split(chr(13) + chr(10)) if l])} lines')
