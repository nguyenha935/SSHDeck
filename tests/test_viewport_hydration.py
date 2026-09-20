"""Step 3 / G4, G5: Zero-Interaction Hydration & Reconnect Catch-up.

Tests:
  * test_early_frame_buffering_in_app_js: verifies window.__earlyRestoreFrames and
    window.__earlyReplayChunks are set up at parse time with socket listeners.
  * test_session_manager_drains_early_frames: verifies SessionManager.init() drains
    buffered frames upon DOMContentLoaded.
  * test_reconnect_reattaches_the_view_and_fits: verifies onReconnected drops
    the dead view and re-fits, which is what re-attaches it.
"""
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent


def test_early_frame_buffering_in_app_js():
    app_js = (SRC / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
    assert 'window.__earlyRestoreFrames = [];' in app_js
    assert 'window.__earlyReplayChunks = [];' in app_js
    assert "window.socket.on('ssh_session_restored'" in app_js
    assert "window.socket.on('ssh_replay_chunk'" in app_js


def test_session_manager_drains_early_frames():
    sm_js = (SRC / 'static' / 'js' / 'session-manager.js').read_text(encoding='utf-8')
    assert 'window.__earlyRestoreFrames' in sm_js
    assert 'window.__earlyReplayChunks' in sm_js
    assert 'earlyRestores.forEach(' in sm_js
    assert 'earlyReplays.forEach(' in sm_js


def test_reconnect_reattaches_the_view_and_fits():
    """: a swap replaces the transport, so the tmux client this
    socket held died with it. There is no authoritative grid to adopt any more
    -- the ack carries no geometry -- so the reconnect marks the view detached
    and re-fits, and reportLocalFit turns that fit into the attach."""
    sm_js = (SRC / 'static' / 'js' / 'session-manager.js').read_text(encoding='utf-8')
    assert 'onReconnected(data)' in sm_js
    body = sm_js[sm_js.index('    onReconnected(data) {'):]
    body = body[:body.index('\n    },') + 1]
    assert 'TerminalManager.noteViewDropped?.(sessionId)' in body
    assert 'TerminalManager.requestFit(sessionId)' in body
    # And nothing adopts a shared grid any more.
    assert 'adoptPtyAuthority' not in sm_js
    assert 'pty_cols' not in sm_js
