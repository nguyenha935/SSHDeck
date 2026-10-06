#!/usr/bin/env python3
"""A stand-in for how the omp CLI answers a resize, for the resize-replay gates.

omp (oh-my-pi) draws on the NORMAL screen, straight into the terminal's
scrollback, and answers a SIGWINCH with one transaction. Measured 2026-10-06 on
omp 18.4.4 under tmux 3.7c (pipe-pane on a copy of a real session):

  1. the first SIGWINCH of a burst enters the alternate screen (1049h, at
     2 ms) and draws the live viewport there (6 ms);
  2. every further SIGWINCH re-arms a 120 ms settle window;
  3. once quiet it leaves the alternate screen (1049l) and asks where the
     cursor is (CSI 6n), both at 123 ms, waiting up to 200 ms for the answer;
  4. it then clears the screen AND the scrollback (2J 3J) and replays its whole
     transcript at the current size, at 267 ms -- the time in between is the
     rebuild being computed. This happens on EVERY size change, rows as well as
     columns: `tui.resizeScrollback` defaults to "rebuild", and #ls(cols, rows)
     rebuilds for any change unless it is "preserve". 18.3.0 replayed on a
     change of width only, which is what this file reproduced until then.

Step 4 is what a person sees as the screen running from the top of the
conversation down to the prompt. Only the escape sequences and their timing
are reproduced; nothing here is an agent. The replay is written in 8 KB pieces,
as omp's were; FAKE_OMP_PAUSE_MS holds the replay that long halfway through, as
omp does when the terminal is behind (#Lt waits on pendingOutputBytes; pauses of
174-602 ms were measured).

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
REBUILD = 0.14
CHUNK = 8190
PAUSE = int(os.environ.get('FAKE_OMP_PAUSE_MS', '0')) / 1000
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


def write_all(data):
    # A SIGWINCH can cut a write to a terminal short.
    while data:
        data = data[os.write(1, data):]


def out(data):
    write_all(data.encode())


def log(entry):
    try:
        with open(LOG, 'a') as handle:
            handle.write(json.dumps(entry) + '\n')
    except OSError:
        pass


def paint_history(cols, pause=0):
    rows = [row for i in range(HISTORY) for row in wrap(message(i), cols)]
    data = ('\r\n'.join(rows) + '\r\n').encode()
    for at in range(0, len(data), CHUNK):
        if pause and at <= len(data) // 2 < at + CHUNK:
            time.sleep(pause)
        write_all(data[at:at + CHUNK])
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
                time.sleep(REBUILD)
                size = shutil.get_terminal_size()
                out('\x1b[2J\x1b[3J\x1b[H')
                replayed = paint_history(size.columns, PAUSE)
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
