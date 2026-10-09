# Static tmux

SSHDeck copies one of these binaries onto a Linux host that has no tmux and
where the account may not install the distribution's own. It lands in
`~/.local/share/sshdeck/bin/tmux`, so a session on that host is still kept
after the browser closes. Nothing else on the host is touched. A host that
already has tmux (on `PATH`, in `~/.local/bin`, `/usr/local/bin` or Homebrew)
uses its own. See `provision_static_tmux` in `app/ssh_manager.py`.

The copy runs its own server (`tmux -L sshdeck`), and once it is on a host
SSHDeck always uses it there, even if the host gains a tmux later. tmux
clients and servers of different versions do not reliably talk to each other:
on 2026-10-09 a tmux 3.3a client against a 3.8 server failed with "server
exited unexpectedly", although both declare protocol 8. On its own socket the
copy never meets the server of the user's own `tmux`. To use its sessions by
hand:

```sh
~/.local/share/sshdeck/bin/tmux -L sshdeck ls
```

| File | What it is |
|---|---|
| `tmux-3.8-linux-x86_64` | tmux 3.8, static (musl), for x86_64 |
| `tmux-3.8-linux-aarch64` | tmux 3.8, static (musl), for aarch64 |
| `LICENSES.txt` | the licences of tmux (ISC), libevent (BSD-3-Clause), ncurses (MIT-style) and musl (MIT) |
| `SHA256SUMS` | the sums of the three files above |

All of it is built by `scripts/build_static_tmux.sh`. The script pins every
source tarball by sha256 and runs in a pinned Alpine image. Two builds from
the same inputs are byte-identical, and `.github/workflows/static-tmux.yml`
rebuilds each architecture on its own runner and fails if a file differs.

## Updating

1. Change the versions and sha256 sums in `scripts/build_static_tmux.sh`.
2. Open a pull request. The workflow builds both architectures, and the
   comparison fails because the committed files are the old ones.
3. Download the `static-tmux-x86_64` and `static-tmux-aarch64` artifacts from
   that run, put their files here, and regenerate the sums:

   ```sh
   cd vendor/tmux && sha256sum tmux-* LICENSES.txt > SHA256SUMS
   ```

4. Set `STATIC_TMUX_VERSION` in `app/ssh_manager.py`. `tests/test_static_tmux.py`
   checks that it matches the script.

A host never has its copy replaced: the sessions it runs would be lost. One
that already has SSHDeck's tmux keeps the version it got.
