#!/usr/bin/env python3
"""A stand-in for the omp CLI's screen, for live_omp_prompt_width.mjs.

What matters is the SHAPE, not the program: rows padded to the full terminal
width by the program's own width tables (the same tables tmux uses) that
contain an emoji xterm's Unicode 6 table draws one cell narrower (U+1F648),
under a prompt box of the same shape as omp's. tmux repaints the whole client
screen on attach and refresh, row after row; a row that ends a cell early in
the engine leaves the cursor a column behind tmux's bookkeeping, and the rows
after it are drawn shifted -- or over each other. Every row here is exactly
`cols` cells by East Asian Width, the rule wcwidth follows.

The screen is then held (the spinner ticks in place) until Ctrl-C.
"""
import shutil
import sys
import time
import unicodedata


def cells(text):
    return sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in text)


def padded(left, right=''):
    return left + '\u2500' * max(0, cols - cells(left) - cells(right)) + right


SPIN = '\u25d0\u25d3\u25d1\u25d2'
cols = shutil.get_terminal_size().columns
sys.stdout.write('\x1b[?25l\x1b[2J\x1b[H')
for i in range(1, 26):
    # Half the rows carry the monkey: the drift needs a wide glyph on a
    # full-width row, and the plain rows between them show where the
    # following row lands.
    mark = ' \U0001f648 ' if i % 2 else ' -- '
    sys.stdout.write(padded(f'row {i:02d}{mark}') + '\n')
right = '\u2503\u2500\u25001M\u2500\u25c0 Quy t\u1eafc code v\u00e0 giao ti\u1ebfp \u2500\u256e'
bottom = '\u2570\u2500' + ' ' * (cols - 4) + '\u2500\u256f'
try:
    n = 0
    while True:
        # Every other tick a transcript line lands above the box, the way a
        # streaming answer does; the box is then redrawn two rows lower.
        if n % 2 == 0:
            sys.stdout.write(f'\x1b[2Ktranscript line {n // 2:03d}\n')
        left = f'\u256d\u2500\u2500 \u03c0 \u203a {SPIN[n % 4]} DeepSeek V4.1 Flash \U0001f648 \u203a \U0001f5d1 ~/tmp \u203a \U0001f441 $1.76 \u25b6\u25007%'
        sys.stdout.write('\x1b[2K' + padded(left, right) + '\n' + '\x1b[2K' + bottom + '\x1b[1A\r')
        sys.stdout.flush()
        n += 1
        time.sleep(0.15)
finally:
    sys.stdout.write('\x1b[?25h\n')
