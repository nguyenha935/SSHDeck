#!/usr/bin/env python3
"""A stand-in for how the omp CLI answers a resize, for the resize-replay gates.

omp (oh-my-pi, @oh-my-pi/pi-tui 18.3.0) draws on the NORMAL screen, straight
into the terminal's scrollback, and answers a SIGWINCH with one transaction
(src/tui.ts, read 2026-09-24):

  1. the first SIGWINCH of a burst enters the alternate screen (1049h) and
     draws the live viewport there (lines 1490-1551);
  2. every further SIGWINCH re-arms a 120 ms settle window
     (RESIZE_VIEWPORT_SETTLE_MS, line 837);
  3. once quiet it leaves the alternate screen (1049l) and asks where the
     cursor is (CSI 6n), waiting up to 200 ms for the answer
     (RESIZE_PROBE_TIMEOUT_MS, line 839);
  4. if the WIDTH changed it replays the whole transcript at the new width
     below what is on screen (#prepareResizeReplay, lines 2691-2722); a
     height-only change repaints the viewport alone.

Step 4 is what a person sees as the screen running from the top of the
conversation down to the prompt. Only the escape sequences and their timing
are reproduced; nothing here is an agent.

Every transaction is appended to $FAKE_OMP_LOG (one JSON line) so a gate can
count replays. Ctrl-C exits.
"""
import json
import os
import select
import shutil
import signal
import sys
import termios
import time
import tty

SETTLE = 0.12
PROBE_TIMEOUT = 0.2
HISTORY = int(os.environ.get('FAKE_OMP_HISTORY', '400'))
LOG = os.environ.get('FAKE_OMP_LOG', '/tmp/fake_omp_resize.log')
WORDS = ('the pane replays every committed row at the new width so the '
         'scrollback reads right after a resize').split()


def message(i):
    words = ' '.join(WORDS[(i + k) % len(WORDS)] for k in range(8 + (i * 7) % 23))
    return f'transcript {i:04d} {words}'


def wrap(text, cols):
    return [text[k:k + cols] for k in range(0, len(text), cols)] or ['']


def viewport(cols):
    bar = '─' * max(0, cols - 2)
    return [f'╭{bar}╮', 'omp-live prompt', f'╰{bar}╯']


def out(data):
    os.write(1, data.encode())


def log(entry):
    try:
        with open(LOG, 'a') as handle:
            handle.write(json.dumps(entry) + '\n')
    except OSError:
        pass


def paint_history(cols):
    rows = [row for i in range(HISTORY) for row in wrap(message(i), cols)]
    out('\r\n'.join(rows) + '\r\n')
    return len(rows)


def paint_viewport(cols):
    out('\r\n'.join(viewport(cols)))


def probe_cursor():
    out('\x1b[6n')
    deadline = time.monotonic() + PROBE_TIMEOUT
    reply = b''
    while time.monotonic() < deadline and not reply.endswith(b'R'):
        ready, _, _ = select.select([0], [], [], max(0, deadline - time.monotonic()))
        if ready:
            reply += os.read(0, 64)
    return reply


def main():
    pending = {'winch': False}
    signal.signal(signal.SIGWINCH, lambda *_: pending.update(winch=True))
    old = termios.tcgetattr(0)
    tty.setcbreak(0)
    cols = shutil.get_terminal_size().columns
    paint_history(cols)
    paint_viewport(cols)
    in_alt = False
    settle_at = None
    try:
        while True:
            if pending['winch']:
                pending['winch'] = False
                if not in_alt:
                    in_alt = True
                    out('\x1b[?1049h\x1b[H\x1b[2J')
                    paint_viewport(shutil.get_terminal_size().columns)
                settle_at = time.monotonic() + SETTLE
            if in_alt and time.monotonic() >= settle_at:
                in_alt = False
                out('\x1b[?1049l')
                reply = probe_cursor()
                size = shutil.get_terminal_size()
                replayed = 0
                if size.columns != cols:
                    out('\r\n')
                    replayed = paint_history(size.columns)
                    paint_viewport(size.columns)
                log({'t': time.time(), 'from': cols, 'to': size.columns,
                     'rows': size.lines, 'replayed_rows': replayed,
                     'cpr': bool(reply)})
                cols = size.columns
            wait = 0.02 if in_alt else 0.2
            ready, _, _ = select.select([0], [], [], wait)
            if ready and b'\x03' in os.read(0, 64):
                return
    except KeyboardInterrupt:
        return
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)


if __name__ == '__main__':
    main()
