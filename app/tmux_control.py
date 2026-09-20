"""tmux helpers that survive the views redesign.

WHAT WAS HERE. A full tmux CONTROL-MODE (`tmux -CC`) protocol reader: line
framing, `%output` payload decoding with octal escapes, notification parsing and
a `ControlSession` state machine. Control mode existed so one SSH channel could
carry every browser's pane at its own size, and it cost more than it bought:
a control client is not a terminal, so tmux never sent it the mouse DECSETs
(wheel and touch scrolling died inside full-screen programs), and its stdin is
a command channel, so every keystroke had to be re-encoded as `send-keys -H`
hex (which is where Vietnamese IME input broke).

Each browser socket is now a REAL tmux client on its own channel, so the pane's
bytes arrive as ordinary terminal output and the protocol reader is gone.

What is left is the one parser the ordinary `list-clients` read needs.
"""

import re


def parse_client_size(listing_line):
    """`#{client_tty}|#{client_width}|#{client_height}` -> (tty, cols, rows).

    A CONTROL-mode client prints its width and an EMPTY height, so a format that
    joins them (`#{client_width}x#{client_height}`) yields `51x` and a naive
    split on 'x' produces a crash or a zero. Measured on tmux 3.4
    (/tmp/s33/cc.log): `tty=/dev/pts/431 80x flags=...,control-mode,...`. The two
    dimensions are therefore requested as separate fields and a missing one is
    returned as None rather than guessed.
    """
    if not listing_line:
        return None
    parts = listing_line.strip().split('|')
    if len(parts) < 2:
        return None
    tty = parts[0].strip()
    if not tty:
        return None

    def _dim(value):
        value = value.strip()
        if not value.isdigit():
            return None
        number = int(value)
        return number if number > 0 else None

    cols = _dim(parts[1])
    rows = _dim(parts[2]) if len(parts) > 2 else None
    return tty, cols, rows
