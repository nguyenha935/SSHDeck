# Changelog

All notable changes to SSHDeck are recorded here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
