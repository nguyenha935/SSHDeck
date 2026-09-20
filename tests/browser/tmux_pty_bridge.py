"""A stand-in for SSHDeck's server side, for the terminal_resize_tmux test.

Runs a real tmux on a real PTY and exposes it over a loopback TCP socket, so a
Playwright-driven xterm can act as the client. The point is that the PTY size
changes ONLY when the browser asks for it, exactly like production: the app emits
`ssh_resize` and `ssh_manager.resize_terminal` calls `channel.resize_pty`. A test
can therefore prove that keeping the two sizes in step is what fixes tmux's
painting, rather than asserting it from a mock.

Line protocol on the socket:
  in   SIZE <rows> <cols>   -> TIOCSWINSZ on the PTY   (== ssh_resize)
  in   IN <hex>             -> write bytes to the PTY  (== ssh_input)
  in   QUIT                 -> tear down
  out  OUT <hex>            -> bytes read from the PTY (== ssh_output)

argv: <tmux-socket-name> <tcp-port> <rows> <cols>
"""
import fcntl
import os
import pty
import select
import socket
import struct
import subprocess
import sys
import termios
import threading
import time

SOCK_NAME = sys.argv[1]
PORT = int(sys.argv[2])
ROWS, COLS = int(sys.argv[3]), int(sys.argv[4])

# A private tmux server (-L <name>), so this never touches the developer's own
# tmux sessions or any other tool sharing the default socket.
subprocess.run(['tmux', '-L', SOCK_NAME, 'kill-server'], stderr=subprocess.DEVNULL)
time.sleep(0.3)

pid, master = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('tmux', ['tmux', '-L', SOCK_NAME, 'new-session', '-s', 'probe'])


def set_size(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


set_size(ROWS, COLS)

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', PORT))
server.listen(1)
print('READY', flush=True)

conn, _ = server.accept()
stream = conn.makefile('rwb')


def pump_pty():
    while True:
        readable, _, _ = select.select([master], [], [], 0.2)
        if not readable:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        try:
            stream.write(b'OUT ' + data.hex().encode() + b'\n')
            stream.flush()
        except Exception:
            break


threading.Thread(target=pump_pty, daemon=True).start()

for line in stream:
    line = line.strip()
    if line.startswith(b'SIZE '):
        _, rows, cols = line.split()
        set_size(int(rows), int(cols))
    elif line.startswith(b'IN '):
        os.write(master, bytes.fromhex(line[3:].decode()))
    elif line == b'QUIT':
        break

subprocess.run(['tmux', '-L', SOCK_NAME, 'kill-server'], stderr=subprocess.DEVNULL)
