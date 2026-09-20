"""Item 3.1 / G1 (P1 ruling): SFTP inline panel active session rebinding.

Tests logic contract of SFTPFileManager inline pane:
  * handleActiveSessionChanged rebinds state.sessionId and hostInfo;
  * openInline detects a switched active session and issues a listing;
  * if the panel is open, an active session switch issues that listing at once;
  * if the panel is closed, the switch sets refreshOnOpen instead.
"""


from pathlib import Path

# See tests/test_mobile_geometry.py: a source read finds the repository from
# this file, never from a deployment path.
REPO = Path(__file__).resolve().parents[1]


def test_sftp_file_manager_has_active_session_listener():
    with open(REPO / 'static/js/sftp-file-manager.js', 'r') as f:
        content = f.read()

    # Must listen to sshdeck:active-session-changed
    assert "document.addEventListener('sshdeck:active-session-changed'" in content

    # Must define handleActiveSessionChanged
    assert "handleActiveSessionChanged(newSessionId)" in content

    # openInline must detect session switch
    assert "this.panes['inline'].sessionId !== currentSessionId" in content

    # ------------------------------------------------------------------
    # RE-POINTED, S17 D3. CLASSIFICATION: asserting-the-old-specification.
    #
    # This used to assert `this.requestPaneListing('inline', currentSessionId`
    # -- i.e. it pinned the exact mechanism that S17 D3 root-caused AS THE
    # DEFECT. requestPaneListing records navigation intent in pendingPath, and
    # nothing ever clears the inline pane's intent (onSourceChange only voids
    # left/right), so guard 1 in the directory_listing handler
    #     if (state.pendingPath !== null && data.path !== state.pendingPath)
    # then rejected every later reply whose path differed -- unsolicited
    # refreshes, server pushes, another client's change -- and guard 2's $HOME
    # auto-landing, which requires pendingPath === null, could never fire.
    # Measured as three red rows in panel_contracts §7: the inline pane never
    # rendered a fresh response and stayed on its opening path.
    #
    # The authorising specification is the distinction onSourceChange already
    # states in its own comment for the identical case: an OPENING listing is a
    # DEFAULT, not a request, so it records no intent. Explicit navigation still
    # goes through requestPaneListing (asserted below), which is where
    # correlating a reply with a request is meaningful.
    #
    # NOT a weakening: what this contract exists to defend is that the rebind
    # ASKS THE SERVER for the new session's directory. That is asserted directly
    # -- the emit, its event name, its pane and its session -- plus the two
    # branches of the open/closed behaviour, and the fact that the correlated
    # helper still exists and is still used by real navigation.
    # ------------------------------------------------------------------
    assert "this.socket.emit('list_directory'," in content
    assert "this.remoteFilesystemPayload('inline', currentSessionId," in content
    assert "this.remoteFilesystemPayload('inline', targetSessionId," in content

    # The correlated helper must still exist and still be used for real
    # navigation, or D3's fix would have removed the correlation guard wholesale.
    assert "requestPaneListing(pane, sessionId, path)" in content
    assert "this.requestPaneListing(pane, sessionId, path);" in content
    assert "this.requestPaneListing(pane, sessionId, state.path);" in content

    # And the opening listings must NOT record intent: no requestPaneListing
    # call for the inline pane anywhere.
    assert "requestPaneListing('inline'" not in content

    # Both branches of the rebind: open -> ask now, closed -> refresh on open.
    assert "state.refreshOnOpen = true;" in content
