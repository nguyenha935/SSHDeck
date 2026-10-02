"""Item 3.1 / G1 (P1 ruling): SFTP inline panel active session rebinding.

Tests logic contract of SFTPFileManager inline pane:
  * handleActiveSessionChanged rebinds state.sessionId and hostInfo;
  * openInline detects a switched active session and issues a listing;
  * if the panel is open, an active session switch issues that listing at once;
  * if the panel is closed, the switch leaves the pane needing its first
    listing, and opening the panel issues it.
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

    # openInline must detect session switch, and rebind through the one
    # helper handleActiveSessionChanged uses too.
    assert "if (currentSessionId && state.sessionId !== currentSessionId) {" in content
    assert "this.bindInlineSession(currentSessionId);" in content
    assert "this.bindInlineSession(targetSessionId);" in content

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
    #
    # RE-POINTED 2026-10-02 (files panel, batch 1). CLASSIFICATION: the
    # opening listing moved, unchanged in kind, into loadInlineDefault, which
    # openInline and handleActiveSessionChanged both call -- so the session it
    # lists is the pane's bound one, `state.sessionId`, rather than the two
    # local names it used to be spelled with. It also asks for $HOME now,
    # which is what lets the panel open there instead of at '/'.
    assert "this.socket.emit('list_directory'," in content
    assert "this.remoteFilesystemPayload('inline', state.sessionId," in content
    assert "this.socket.emit('get_home_directory',\n            this.remoteFilesystemPayload('inline', state.sessionId));" in content

    # The correlated helper must still exist and still be used for real
    # navigation, or D3's fix would have removed the correlation guard wholesale.
    assert "requestPaneListing(pane, sessionId, path)" in content
    assert "this.requestPaneListing(pane, sessionId, path);" in content
    assert "this.requestPaneListing(pane, sessionId, state.path);" in content

    # And the opening listings must NOT record intent: no requestPaneListing
    # call for the inline pane anywhere.
    assert "requestPaneListing('inline'" not in content

    # Both branches of the rebind: open -> ask now, closed -> ask on open.
    #
    # RE-POINTED 2026-10-02. This asserted `state.refreshOnOpen = true;`, the
    # closed branch's whole mechanism -- and the mechanism did not work:
    # openInline only repainted the cached state when the pane was already
    # bound, so a session switched while the panel was closed opened on an
    # "Empty directory" that was never listed (measured: files_panel.mjs §4
    # against main's sftp-file-manager.js emits no list_directory on open).
    # The flag that is honoured now is
    # needsListing, set by bindInlineSession and acted on by openInline.
    assert "if (this.isInlineOpen()) {\n            this.loadInlineDefault();" in content
    assert "needsListing: true," in content
    assert "if (state.type && state.needsListing) {\n            this.loadInlineDefault();" in content
