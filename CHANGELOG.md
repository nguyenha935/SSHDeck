# Changelog

All notable changes to SSHDeck are recorded here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-01

Six weeks of work, most of it on the two things SSHDeck is for: using a
terminal properly from a phone, and keeping one session alive across every
device you open it on.

### Touch

- **The keyboard opens when you mean it.** A tap on the terminal's own input
  line (the cursor's row, or one row either side) opens the keyboard; a tap
  anywhere else scrolls or reads without it popping up, and the terminal never
  takes focus behind the composer's back.
- **The keyboard and the keys panel push the content up; they do not resize
  the window.** The remote grid keeps its size, so full-screen programs do not
  redraw and other devices on the same session are not squeezed. The same
  holds for the app's own panels on a desktop: Notes, Files, Commands and the
  split divider shrink the text (never below 12 px) instead of the remote pane.
- **Input methods**: what a Vietnamese (or other) IME commits is sent once, in
  order, even when key events arrive in a burst — no more doubled or dropped
  stretches when typing fast.
- **Links in the output** open a small Open / Copy menu on a click, or a sheet
  above the keyboard on a tap.
- **Install as an app**: a web app manifest and icons, so Android, iOS and
  desktop Chrome/Edge can put SSHDeck on the home screen in its own window.
- Hover styles show only to a mouse; on touch a control lights up while it is
  pressed, instead of staying highlighted after the finger lifts.
- Dialog fields are 44 px tall with 16 px text on touch, and checkbox labels
  sit beside their boxes.

### Sessions

- **A restart keeps everything in place.** After an SSHDeck restart each
  session is reattached under its own id, in its own pane; sessions using a key
  or Tailscale reconnect without asking.
- **tmux where there is none.** A new persistent connection to a host without
  tmux installs the distribution's package when the account is root or has
  passwordless sudo, and otherwise places a static tmux 3.8 (Linux x86_64 and
  aarch64) in `~/.local/share/sshdeck/bin`, running on its own `sshdeck`
  socket. The static builds are reproducible and rebuilt by CI.
- A tmux session whose SSH connection drops is now shown as disconnected,
  instead of looking connected until the page reloaded.
- Programs that replay their whole screen on a size change (omp and similar)
  are covered until the replay has finished, instead of flickering.
- Page reloads attach each session once, with its history, instead of twice.

### Files

- A full **Files browser**: expand the Files panel to cover the workspace
  (full screen on a phone) with columns, sorting, filtering, multi-select,
  keyboard shortcuts, inline rename and create, batch delete, and a menu on
  every row.
- Every file type has its own icon, and touch devices get row actions that
  used to need a right-click.
- Deleting the home directory, or any directory that contains it, is refused;
  creating or renaming onto an existing name is refused instead of overwriting.
- File transfer progress goes only to the browser that started the transfer.

### Settings

- One **Settings** view inside the app replaces the separate admin page, the
  change-password page and the menus: appearance, terminal, account, and for
  administrators users, running sessions, the audit log, system limits and
  diagnostics. `/admin` and `/change-password` now open it.
- An optional **WebGL renderer** for the terminal, switchable in Settings.
- Diagnostics (performance probe, keyboard log, screen diagnostic) are
  administrator-only and live in Settings; the keyboard log switches itself
  off after an hour. The `?renderer=`, `?perf=` and `?kbdebug=` addresses no
  longer do anything.

### Fixes that matter

- **Resizing a session without tmux could lock the whole server** until it was
  restarted: every connect, keystroke and disconnect of every user waited on a
  lock that was never released. Fixed; it is the most likely cause of the
  outage on 2026-10-08.
- Every wait on a remote server in Files and in the latency probe is bounded
  (20 s of silence), so one unresponsive host can no longer exhaust the
  database connection pool for everyone.
- Request bodies are capped at 1 MB (`MAX_REQUEST_SIZE`), uploads excepted;
  Werkzeug 3.1.9 had stopped capping form bodies before sign-in.
- A file dragged over the window and not dropped no longer leaves the drop
  overlay on screen.

### Upgrading

- No configuration change is required. The Docker image is now published:
  `ghcr.io/nguyenha935/sshdeck:0.2.0` (and `:latest`).
- Changing the pane layout on one device no longer clears pane assignments on
  the server; panes beyond the new layout are hidden and come back when it
  grows again.
- The per-page first-attach report is off by default (Settings → Diagnostics).

### Dependencies

cryptography 48.0.1 → 50.0.2 (CVE-2026-69247, -69248, -69249), Werkzeug
3.1.8 → 3.1.9 (CVE-2026-102598), paramiko 5.0.0 → 5.1.0, eventlet 0.41.1 →
0.41.3, Flask-SocketIO 5.6.1 → 5.7.0, redis pinned at 8.1.0, socket.io-client
4.8.4, highlight.js 11.12.0, and `@xterm/addon-webgl` 0.19.0 added. Every
GitHub Action is pinned to a commit.

### Testing

88 pytest files carrying 1360 tests (1358 pass, 2 skip), and 134 browser
gates: 124 headless on Chromium and WebKit, 9 live, and one that compares
computed styles against a baseline it is handed. The live gates no longer use
any real account or host: each run builds a throwaway SSHDeck and OpenSSH
container and removes them afterwards. A required CI check rejects commits
that carry tool attribution instead of a person's name.

## [0.1.0] - 2026-09-20

First public release. SSHDeck has been running in private deployment since
July 2026; this is the point at which the repository itself is published.

### The session model

- **Every browser socket is its own tmux client.** A session is attached per
  socket (`view_attach` / `view_detach`), so tmux draws each device at that
  device's size instead of one shared PTY being re-sized under everyone. The
  window tmux draws is the component-wise minimum over the attached views, and
  it is announced (`tmux_window_geometry`) before the repaint that follows it.
- **The tmux frame always fills the pane; the text is what scales.** A device
  smaller than the shared window shrinks its glyphs rather than clipping the
  frame.
- **A panel of the app's own never resizes the remote pane** — opening the
  desktop Broadcast composer holds the grid and scales the text instead.
- **Persistence**: sessions survive a page reload, a reconnect and an app
  restart; a dropped socket re-attaches by itself, and an orphaned tmux client
  is released rather than holding everyone at its size.

### The terminal

- xterm 6 with the Unicode 11 width tables, so a row measures the same in the
  browser as it does in tmux.
- A shrink holds the pane on its last good frame until tmux repaints, instead
  of showing the left half of the old frame.
- Scrollback, copy-mode and mouse handling that stay correct inside
  full-screen programs (claude, codex, vim) and under touch.
- Vietnamese IME input, including a composition rescue path for WebKit.

### The rest

- SFTP file manager with dual-pane browsing, inline editing and
  server-to-server transfer over the existing SSH channels.
- Command library and command sets; broadcast to several sessions; notepad.
- Saved profiles, SSH key management, jump hosts, Tailscale SSH identity.
- Admin panel: users, limits, audit log.
- Ten themes, six interface languages, a touch-first shell.
- A screen diagnostic (`?kbdebug=1`) that records what the engine was given
  next to what tmux holds, so a wrong screen can be replayed.

### Licence

Released under the PolyForm Noncommercial License 1.0.0. Parts of the project
derive from WebSSH by H31mdall and keep their MIT notice; the bundled browser
libraries and Python packages keep their own terms. See `LICENSE` and
`NOTICE.md`.

### Testing

72 pytest files carrying 1180 tests, and 112 browser gates.
`node scripts/run_gates.mjs` runs 99 of them headless across Chromium and
WebKit; 12 more drive a real server and are opted into with `--live`, and one
compares computed styles against a baseline it has to be handed.

`.github/workflows/ci.yml` runs the pytest suite, the headless gates and an
audit of the vendored assets on every pull request and every push. The Docker
image job depends on all three, so nothing is published from a red build.
