# Workflows

[Back to README](../README.md)

## Persistent sessions

A normal SSH session is a live connection held by the SSHDeck process. Refreshing a page can reattach to that live session, but a database row alone cannot preserve its shell across a process restart.

Persistent mode creates a tmux session on the remote host. Browser closure, SSH idle timeout and an SSHDeck restart leave that remote session running, and the page reattaches each session to the pane it was in. Reconnect may require authentication again; password connections reopen the form, while usable key or Tailscale credentials can reconnect directly.

When a new persistent connection finds no tmux, SSHDeck provides one. If the account is root or has passwordless `sudo`, it installs the distribution's package (apt, dnf, yum, apk, pacman or zypper) in the background and waits up to 60 seconds. Otherwise, or if that takes longer, it copies a static tmux to `~/.local/share/sshdeck/bin/tmux` on Linux x86_64 and aarch64; that copy runs its own server on the `sshdeck` socket, so it never touches tmux sessions that were already on the host (`~/.local/share/sshdeck/bin/tmux -L sshdeck ls` lists its sessions). Reconnecting never installs anything. If tmux still cannot be provided, the connection falls back to a regular shell and the page says so.

Each visible tmux view has its own client channel. The remote window follows the smallest attached client. Hidden views detach; regular non-tmux views share a PTY with last-resize-wins geometry.

Explicitly disconnecting a live persistent session attempts to kill its remote tmux session. If that fails, SSHDeck retains the saved record for recovery. Removing an already disconnected candidate only forgets the saved record; it does not reach the host to kill tmux. Logout, account locking and account deletion revoke live connections and may terminate their remote tmux sessions. Do not treat logout as equivalent to closing a browser tab.

## Terminal interaction

Browser mode supports local text selection and terminal history scrolling. Application mouse mode forwards mouse input to terminal applications such as vim and htop. Use the Copy/Paste controls for clipboard operations; clipboard permissions depend on the browser and secure context.

On touch devices the composer at the bottom of the screen mirrors the terminal's input line: typing, pasting and input-method text appear on the remote line as you edit, and nothing runs until Send. Tapping the terminal's input line (the cursor's row, or one row either side) opens the keyboard; a tap elsewhere does not. The on-screen keyboard and the special-key keypad push the terminal content up rather than resizing the remote window, so full-screen programs do not redraw and other devices on the same session keep their size.

Broadcast selects all connected sessions or a fixed subset. Review the visible targets before sending. All-target selection includes new eligible sessions; a manually chosen subset remains explicit.

## Files and transfers

| Surface | Purpose | Remote requirements |
| --- | --- | --- |
| Files in the workspace | Browse the active connection; upload, download, preview and edit | SFTP subsystem |
| File Transfer in the account menu | Choose separate source and destination locations | SSH exec; `python3` for remote filesystem operations |
| Remote directory transfer | Relay a directory between hosts | `python3` and `tar` on both hosts |
| Text preview/editor | Read and save text from either entry point | SFTP; editor defaults to a 5 MiB maximum |

File Transfer relays data through the SSHDeck host. It does not require the two remote hosts to connect directly to each other. File transfers verify the destination digest before publication; directory transfers use a tar stream and temporary destination before publication. Transfers expose progress and cancellation, subject to configured bounds.

Local folder browsing requires the browser's File System Access API and permission. Where unavailable, use supported upload/download controls instead. File permissions and remote account access still determine which operations can succeed.

Notes and Commands share the auxiliary workspace area with inline Files. Notes are scoped to your account globally or to a server, rather than to an individual browser tab.
