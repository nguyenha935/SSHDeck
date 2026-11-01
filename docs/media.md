# README media

[Back to README](../README.md)

**Captured from a live system.** `handoff.gif`, `touch.png`, `phone-landscape.png` and `desktop.png` are screenshots of a real SSHDeck connected over SSH to a real server, both built for the capture and removed afterwards: a disposable OpenSSH container and a local SSHDeck with generated accounts, the same throwaway world the live browser gates run in. The phone is WebKit at 390 × 844 (844 × 390 in landscape), the desktop Chromium at 1280 × 800. The project, files and output on screen are sample data created for the capture. `handoff.gif` is a sequence of those screenshots with captions, not a screen recording: between frames the desktop browser is really closed and the phone's really opened, and the session on the server keeps running throughout.

**Illustrations.** The remaining images (`filemanager.png`, `commandlibrary.png`, `command-sets.gif`, `file-editing.gif`, `connection-panel.png`, `keys.png`, `connection-options.png`, `themes.png`) show the interface with demonstration accounts and fixture responses. Hostnames, paths, listings and output are sample data; they illustrate the interface rather than a successful live connection. The GIFs among them are paced sequences of captured UI states, and the file-save state is simulated.

Regenerate them with `node scripts/readme-media/capture.mjs` (needs Docker, like the live gates) followed by `python3 scripts/readme-media/compose.py <capture dir> assets/` (needs Pillow).

The phone frames in `touch.png` are, left to right: the composer with the terminal keys open, the sheet a tapped link opens, the Files sheet beside the terminal, and the full-screen file browser.
