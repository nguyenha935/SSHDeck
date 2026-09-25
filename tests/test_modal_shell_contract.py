"""Piece E static modal-shell contract.

The contract was recorded in /opt/sshdeck/state/deployment.json (note, piece E)
and in docs/DESIGN.md on the branch feat/design-standard. Both are gone: the
ledger was deleted with the rest of the WebSSH-era state, and
that pre-v5 design standard was retired, superseded by the v5
mockup, the amendment (docs/spec/) and static/css/deck-tokens.css. What records
a deployment is the git log; the contract itself is the
assertions below.
The two dynamic SFTP roots and admin addUserModal are not served by the
index.html-only browser harness; their contract is enforced here, each
dynamic constructor isolated as its own bounded block.

Every assertion below was originally written at module level, which pytest
collects as ZERO tests: the file exited 5 ("no tests collected") and proved
nothing to any per-file gate, even though the asserts did run at import. The
checks are now grouped into named test functions by subject, each assertion
preserved verbatim with its original failure message. See Entry 32.
"""
import re
import pathlib

S = pathlib.Path(__file__).resolve().parent.parent
idx = (S / "templates/index.html").read_text()
adm = (S / "templates/admin.html").read_text()
js = (S / "static/js/sftp-file-manager.js").read_text()
css = (S / "static/css/style.css").read_text()
tp = (S / "tests/test_profile_launcher_ui.py").read_text()

ROOTS = ["connectionModal", "profileManagementModal", "keyManagementModal",
         "commandSetsModal", "jumpHostManagementModal", "fileTransferModal",
         "commandFormModal", "commandPaletteModal", "shortcutsModal",
         "dropUploadModal", "paneAssignmentModal"]

LEGACY = {"connectionModal": "modal-wide", "profileManagementModal": "modal-large",
          "keyManagementModal": "modal-wide", "commandSetsModal": "modal-xlarge",
          "jumpHostManagementModal": "modal-wide"}

# Each dynamic constructor is isolated as its own bounded block so it can be
# proven individually: its class assignment + role + aria + span.close id all
# live inside that same block (aggregate counts are not used).
fm_block = js[js.index("createModal() {"):js.index("createQuickConnectModal() {")]
qc_block = js[js.index("createQuickConnectModal() {"):js.index("setupEventListeners() {")]
# Single 85vh cap, generic 44px close rule, reduced-motion scoping.
blk = css[css.index(".modal-shell"):]


def root(html, rid):
    m = re.search(r'<div class="([^"]*)" id="' + rid + r'"([^>]*)>', html)
    assert m, f"root not found: {rid}"
    return m.group(1), m.group(2)


def test_index_roots_carry_shell_token_and_a11y_contract():
    # 11 index roots: shell token + full a11y contract.
    for rid in ROOTS:
        cls, attrs = root(idx, rid)
        assert "modal-shell" in cls.split(), f"shell missing: {rid}"
        assert 'role="dialog"' in attrs and 'aria-modal="true"' in attrs, f"contract: {rid}"


def test_legacy_size_tokens_preserved_on_migrated_roots():
    for rid, tok in LEGACY.items():
        assert tok in root(idx, rid)[0], f"legacy token lost: {rid}"


def test_file_preview_modal_excluded_from_shell():
    # filePreviewModal excluded.
    assert "modal-shell" not in root(idx, "filePreviewModal")[0]


def test_index_roots_keep_focusable_close_buttons():
    # Focusable closes on the migrated index roots (template buttons).
    assert len(re.findall(r'<button type="button" class="close"', idx)) >= 11


def test_admin_add_user_modal_shell_and_a11y():
    # admin root verified independently: shell + role + aria-modal.
    acls, aattrs = root(adm, "addUserModal")
    assert "modal-shell" in acls.split()
    assert 'role="dialog"' in aattrs and 'aria-modal="true"' in aattrs


def test_sftp_file_manager_modal_constructor_block():
    assert "modal.className = 'modal modal-xlarge modal-shell';" in fm_block
    assert "setAttribute('role', 'dialog')" in fm_block
    assert "setAttribute('aria-modal', 'true')" in fm_block
    assert '<span class="close" id="fmClose"' in fm_block
    # Span-close contract: the span carries class "close" (target of the generic
    # .modal-shell .close 44px rule).
    assert '<span class="close" id="fmClose"' in fm_block


def test_sftp_quick_connect_modal_constructor_block():
    assert "qcModal.className = 'modal modal-small modal-shell';" in qc_block
    assert "setAttribute('role', 'dialog')" in qc_block
    assert "setAttribute('aria-modal', 'true')" in qc_block
    assert '<span class="close" id="fmQcClose"' in qc_block
    assert '<span class="close" id="fmQcClose"' in qc_block
    # qc's real click-close handler is anchored at its real location: inside its
    # own constructor block.
    assert ("document.getElementById('fmQcClose').addEventListener('click', "
            "() => this.closeQuickConnect());") in qc_block


def test_fm_close_handler_wired_exactly_once_file_wide():
    # fm's handler is wired in setupEventListeners, not inside createModal, so
    # it is proven exactly once file-wide rather than inside a block.
    assert js.count("document.getElementById('fmClose').addEventListener('click', "
                    "() => this.close());") == 1


def test_modal_shell_css_contract():
    # CSS contract: single 85vh cap, generic 44px close rule (span+button), no
    # transition:all, reduced-motion scoped to the two animating elements only.
    assert "max-height: min(85vh, 85dvh);" in blk
    assert ".modal-shell .close { display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;" in blk
    assert "transition: all" not in blk and "transition:all" not in blk
    assert ".modal-shell * { animation" not in blk
    assert re.search(r"\.modal-shell \{ animation: none; \}", blk)
    assert re.search(r"\.modal-shell \.modal-content \{ animation: none; \}", blk)


def test_cache_pins_coupled_to_profile_launcher_test():
    # Cache-pin coupling: every edited asset's pin raised in template and test.
    # sftp-file-manager.js moved 12 -> 13 with the listing-correlation guards
    # (Entry 44), 13 -> 14 with the D7 removal of the dead
    # file_exists_result listener, and 14 -> 15 with S17 D3 (the inline pane's
    # opening listing stops recording navigation intent, so guard 1 no longer
    # rejects every later reply); this is the THIRD place its pin is written,
    # and the reason this test exists is that missing one of them ships the
    # change behind a stale browser cache with nothing going red.
    #
    # style.css 58 -> 59: S12 rewrote three P1 comment blocks. Comment-only, so
    # T-CSS1 measured computed styles identical (136/0), but T12 keys off BYTES
    # and v58 is already the released number (the running image ships v58 with
    # the pre-S12 bytes), so the pin had to move here too. This site is the
    # FOURTH -- the plan's §8.8 note listing three is one short, which is exactly
    # the failure mode this test guards.
    #
    # style.css 59 -> 60 (S17, the authorised .notepad-mode-btn touch floor): the
    # count is really FIVE, and this test proves it by going red. The pin is
    # written in templates/index.html, TWICE in tests/test_profile_launcher_ui.py
    # (the version table and test_profile_launcher_stylesheet_uses_current_cache
    # _version), in tests/browser/js_injected_css.mjs, and in the three
    # assertions below. app/__init__.py holds no asset pin at all -- it was named
    # as a fourth table but greps clean for 'css/style.css'.
    #
    # style.css 61 -> 62 + app.js 61 -> 62 (S21, ruled):
    # style.css DELETES the keyboard-open display:none rule on .notepad-panel
    # (that flip between mousedown and mouseup swallowed the close click) and
    # adds a touch-tier-scoped .sheet-inert pointer-events rule; app.js gets the
    # conditional taint in applyTerminalTruth plus the sheet-inert writer. Both
    # assets are behaviour on released pins, so both moves are asserted here as
    # well -- six sites now.
    #
    # app.js 63 -> 64 + terminal-manager.js 37 -> 38 (S23, ruled).
    # R1: delBytesForCluster sends ONE DEL PER CLUSTER, reversing
    # S22's one-per-code-point rule -- readline erases a whole cluster per DEL,
    # so the old rule destroyed two extra characters of the user's real input
    # line (/tmp/s16work/s22_del_units.out). R4: writeNeedsScrollExit fires on
    # tmux's painted copy-mode indicator, because neither of the old conjuncts
    # can be true for a tmux pane with `mouse on` -- the product default -- so
    # every write after a swipe was discarded. style.css is UNCHANGED by S23 and
    # stays at 62: the contract forbids lowering a pin, and raising one whose
    # bytes did not change invalidates a cache for nothing.
    #
    # S25 R1: app.js 64 -> 65. A monotonically increasing per-session truth
    # epoch gates every `get_terminal_line` answer. Without the gate,
    # applyTerminalTruth installed a stale answer over a correct local edit
    # and inflated sentLen against the remote -- measured end to end
    # (/tmp/s16work/s23_i4_clobber.out). The four production rows the gate
    # turns green are the Owner's oldest complaint: after a reload the composer
    # does not match the terminal.
    #
    # S26 R1: style.css 62 -> 63. The base html/body rules changed
    # `width/max-width: 100vw` to `100%` (style.css:260-262, 267-269). `vw` is
    # defined against the viewport INCLUDING a classic, space-reserving scrollbar
    # gutter, while the boxes those rules size live inside documentElement's
    # CONTENT box, which excludes it -- so on any engine with space-reserving
    # scrollbars html and body were laid out gutter-px wider than the room they
    # had and `scrollWidth - clientWidth` equalled the gutter on EVERY page.
    # Measured in WebKit 26.5 with a 13px root bar, real template and
    # stylesheets (/tmp/s16work/s26b_r1/root_webkit.out): docScrollX 13 -> 0 at all five
    # tiers, ipad-landscape included -- the Owner's reported breakpoint and the
    # exact 13px the eye gate recorded. Chromium 149 here draws overlay
    # scrollbars (gutter 0), which is why CI never saw it. This is a released
    # stylesheet changing layout behaviour, so the pin must move with it.
    # S27: terminal-manager.js 38 -> 40 (two bumps, both released to this
    # origin during the round). The live-edge intent
    # (liveEdgeIntent / noteLiveEdgeIntent / restoreLiveEdgeIntent) closes the
    # row-GROW strand: the app's own `.xterm{height:100%}` grows the absolutely
    # positioned `.xterm-viewport` scroller in the same layout pass as the pane
    # while xterm still holds the old row count, so the browser clamps scrollTop
    # and xterm turns the clamp into a real buffer scroll -- then the debounced
    # fit carries the gap into the new grid. Measured on the live box as
    # baseY 114 / viewportY 86 / gap 28 with the last visible row 8 chars, and it
    # was permanent (/tmp/s26reg/diag3_s27.out); localised to the CSS+debounce
    # pair on the vendored engine (diag4-diag7). v38 is released and has no
    # capture point that can see the pre-clamp buffer, so the pin must move with
    # the fix. style.css is UNCHANGED by S27 and stays at 63: the rule it names is
    # the cause but is CORRECT -- the fix is in the observer, not the stylesheet.
    #
    # WHY 40 AND NOT 39. v39 was built and deployed here with the capture sampled
    # inside the ResizeObserver callback, on the strength of a fixture where that
    # callback still saw the pre-clamp buffer. The production probe then measured
    # the opposite on a real browser resize (diag9_s27.out, +55ms: baseY 114,
    # viewportY 105, gap 9, capture already atLiveEdge false): the clamp-induced
    # scroll is dispatched BEFORE the callback, so no resize-time sample is
    # trustworthy. v40 replaces it with a standing flag maintained from xterm's own
    # scroll event, gated on scroller-height provenance. Since v39 really was
    # served, the pin must rise again rather than be reused -- the contract raises,
    # never reuses or lowers.
    # WHY 41 AND NOT 40. v40 was built and deployed here with the provenance rule
    # keyed on the scroller height ALONE, and the production probe measured that
    # rule losing a race it cannot see: the ResizeObserver callback adopts the new
    # height BEFORE the clamp-scroll arrives when two resizes land ~100ms apart --
    # which is §R4's real pacing -- so the clamp arrives with EQUAL heights, is
    # read as a deliberate scroll, and overwrites the flag with false
    # (diag14_s27.out: resize +203ms h=691 true/false->true/true; scroll +206ms
    # h=691 baseY 115 vpY 105 true/true->false/false; strand gap 20 permanent to
    # +9s). v41 adds the `pending` suppression so a scroll arriving while a geometry
    # change is in flight cannot rewrite the intent. v40 really was served, so the
    # pin rises again -- the contract raises, never reuses or lowers.
    #
    # WHY 43, AND A CORRECTION TO THIS TEST'S OWN RECORD. This site was LEFT
    # BEHIND at v41 while S29 raised terminals-manager.js to v42 in
    # templates/index.html and in tests/test_profile_launcher_ui.py. So this
    # assertion and the launcher table were both red on the tree S29 declared
    # complete, which is exactly the failure mode the comment above says this test
    # exists to catch -- it caught it, and the red was not acted on. Recorded here
    # rather than quietly renumbered.
    #   v42 (S29): observeReconcileEvidence's announcement latch moved from
    #     firstCertification to evidence.reconcileConfirmed, set inside
    #     clearReconcileDesync, so an announcement the bound composer never
    #     accepted cannot consume the one-shot and leave the box empty for 12s.
    #   v43 (S30): tmuxPaneInCopyModeIndicator also reads the pane's TOP row.
    #     tmux draws its copy-mode position indicator at the pane's top-right; the
    #     S23 window scanned only the last four rows, which coincided with the
    #     indicator solely because that measurement was taken on an EMPTY pane. On
    #     any pane holding output the detector answered false while the pane WAS in
    #     copy mode, so writeNeedsScrollExit stayed false, `leave_scroll` never
    #     rode ssh_input, and tmux discarded every composer write after a swipe --
    #     the whole S23 R4 fix was inert in production, and that is the Owner's
    #     "composer still cannot send deletion to the real terminal line".
    #     Proved causal by runtime mutation on the live deployment: widening the
    #     scanned window made the identical write reach the shell, restoring the
    #     shipped method brought the discard back (/tmp/s26reg/s30_p5_G.log arms
    #     A/B/C). The indicator was on pane row 0 in all eight measured gestures
    #     across both viewports (s30_p6_H.log §H2). v42 is released here, so the
    #     pin rises rather than being reused.
    #   v44 (S30-B): the funnel no longer stamps `leave_scroll` on a payload
    #     that IS an SGR mouse report. The advisory's own premise -- "a byte the
    #     user deliberately sends is not a read" -- does not hold for the bytes
    #     that ARE the scroll: the gesture's synthesized wheels and a desktop
    #     wheel both arrive at the funnel as reports, and the server honours the
    #     flag by exiting copy mode INLINE BEFORE the write (socket_events.py
    #     :1188-1196), so those same bytes landed in a live pane where readline
    #     printed them as raw text and swallowed the next write's first
    #     character (/tmp/s26reg/s30_p8.log). v43 is released here, so the pin
    #     rises rather than being reused. app.js moves the same step: 65 -> 66
    #     for the dataIsMouseReport gate in the funnel.
    #   app.js v66 -> v67 (S31 D5a, owner defect 5): an empty composer over a
    #     terminal line that HOLDS TEXT now clears that line instead of running
    #     it. Measured on production (/tmp/s26reg/s31c_run1.log): with the box
    #     empty and `echo RANMARK31C` at the prompt, Send emitted a bare `\r`
    #     and the shell EXECUTED it -- a standalone `RANMARK31C` output row came
    #     back. A browser on v66 keeps running the line the user meant to clear,
    #     so the pin must move. The bare CR is preserved for an already-empty
    #     prompt (the two shipped cases), and the erase reuses the gated
    #     reconcileRemoteLine, so an unsafe pane still refuses rather than
    #     firing a blind \x15.
    #   terminal-manager v44 -> v45 (S32, geometry-hold liveness): the hold now
    #     carries an armedAt instant and a bounded WAIT. It stayed event-closed --
    #     the deadline RE-REQUESTS the authoritative geometry, it never drains --
    #     but a lost pty_geometry used to strand output behind a 256KB byte bound,
    #     which measurement puts at ~185 scroll notches (r1g_run1.log ATTEMPT 4
    #     held 4257 bytes across three notches with the painted row frozen at 75).
    #     A browser on v44 keeps the unbounded wait, so the pin must move.
    # style.css v63 -> v64 (S35 P31, owner's Notepad mode-toggle report): in a
    # NARROW desktop rail both children of .notepad-title were squeezed by the
    # initial `flex-shrink: 1`, so "Per-server" wrapped to two lines and measured
    # 54.9x28 beside its sibling's 43.8x16 -- taking .notepad-mode-toggle and
    # .notepad-title 22px -> 34px and .notepad-header 58px -> 70px, all of it out of
    # the notes textarea. Measured at 1024x768 with the panel open, fine pointer, so
    # the 44px coarse floor is not involved (/tmp/s35/p31_final.log; removing the two
    # declarations reproduces 70/34/34 and 54.9x28 exactly). The heading now carries
    # the flex-truncation idiom and the toggle is `flex: none`, so the deficit falls
    # on the static label instead of on the control's height. A browser on v63 keeps
    # the thickened toggle and the shortened note area, so the pin must move.
    assert "filename='css/style.css') }}?v=71" in idx
    assert "filename='js/sftp-file-manager.js') }}?v=16" in idx
    # app.js v69 -> v70 (S35 A, owner's composer/erase requirement): after the
    # empty-composer erase spends its last DEL, the draft is released from the
    # taint applyTerminalTruth set when it installed the shell's line. Measured on
    # production (/tmp/s35/d3_taint_and_seed.log): on v69 the draft stayed tainted,
    # so typing after an erase streamed NOTHING for the rest of the page's life
    # (box "abc", sentLen 0, wire []) and Vietnamese deletion fell back to the
    # browser's mark-first edit with zero bytes. A browser on v69 keeps that frozen
    # composer, so the pin must move.
    # S36: v77 -> v78 -- the empty-composer erase moved off `beforeinput`, which
    # never fires for an empty textarea, onto `keydown`. A browser on v77 keeps a
    # Backspace that emits nothing at all whenever the composer is empty, so the
    # pin must move.
    # Desurgery v79 -> v80: notepad saves serialized + re-based on each ACK; the
    # composer Send preventDefault scoped so a WebKit touch keeps focus and still
    # fires click. A browser on v79 self-conflicts the notepad and cannot type
    # into the terminal from the mobile composer, so the pin must move.
    # fix4 v80 -> v81 (owner bullets 2 + 3): streamTargetSession declines a
    # server-confirmed alternate screen (no stale text stranded in a TUI's input
    # line on mode exit), and the composer's cross-device mirror no longer fires
    # mid-composition -- a Telex syllable's recomposition steps stopped racing the
    # server echo onto a stale base_revision, which was raising the conflictNotice
    # toast on every Vietnamese word. A browser on v80 keeps both defects, so the
    # pin must move.
    # fix5 v81 -> v82 (owner bullets 2 + 3, REVERT + notepad): the v81 alternate
    # guard REGRESSED the composer to delete-only in every TUI (streamTargetSession
    # returned null on the alternate screen, so typing never streamed while
    # empty-box DEL still fired -- "chỉ xóa được"); it is reverted. And the notepad
    # save now re-bases its direct flush on the last ACK's revision and routes an
    # applied:false through the focus gate, so a fast typist stops self-conflicting
    # and erasing the just-typed char. A browser on v81 keeps both defects, so the
    # pin must move.
    # fix8 v82 -> v83 (owner "không gõ được Tiếng Việt trên codex"):
    # reconcileRemoteLine now reconciles the streamed prefix on the ALTERNATE
    # screen too (clearing with sentLen DELs instead of the shell-only \x15), so a
    # Telex diacritic rewrite over a codex/vim pane is no longer
    # preventDefault-swallowed and Vietnamese is typable into a TUI. A browser on
    # v82 still cannot type Vietnamese into a full-screen program, so the pin moves.
    # v94 -> v95: the first connect of a page no longer runs
    # resetSocketEpoch, so a load sends ONE view_attach per session instead of
    # two. A browser on v94 keeps doubling the startup burst -- which is what
    # pushed it past the 16 packets python-engineio decodes -- and keeps losing
    # its scrollback when the first attach is the one discarded.
    # v96 -> v97: wakeSocket leaves a socket that is still connecting alone;
    # the load's own pageshow sent a second CONNECT and the server dropped the
    # session while the page still reported itself connected.
    assert "filename='js/app.js') }}?v=98" in idx
    # S34: v46 -- the control-mode transport. pty_geometry may now arrive with
    # `render_local`, which this client must NOT adopt as its grid (it wraps the
    # relative %output stream at its own fit instead). A browser on v45 would adopt
    # the source width and be back to panning a foreign grid, so the pin must move.
    # S35 P18: v49 -> v50 -- the transport identity became its own record, because
    # the route-return snapshot declares render_local with a NULL geometry pair and
    # a parked connection never proposes a fit that could carry a width. A browser
    # on v49 keeps deciding scroll-exit for the legacy transport on a restored
    # control session, so the pin must move again.
    # Desurgery v62 -> v63: the soft-keyboard ratio heuristic is gated on a
    # coarse pointer (a desktop window shrink is no longer read as keyboard-open),
    # and the control-source render grid takes its ROWS from this pane's own fit.
    # A browser on v62 sticks the frame top-left after a desktop shrink, so the
    # pin must move.
    # fix4 v63 -> v64 (owner bullet 1, desktop "nhảy lên trên đầu phiên"):
    # consumePendingSourceRepaint declines the request_pane_repaint nudge on a
    # server-confirmed alternate screen. A peer's source move used to fire a
    # SIGWINCH that threw the desktop's full-screen program (claude cli, vim) back
    # to line one; the grid is already held at the source width there, so the nudge
    # was pure harm. A browser on v63 keeps the top-jump, so the pin must move.
    # fix5 v64 -> v65 (owner bullets 1 + 4 + 5, REVERT): the v64 alternate guard is
    # reverted -- measured on the real engine, the incoming home+clear+repaint
    # moves NOTHING on a source-width alt client (the pan is preserved by
    # snapshotPanIntent/restorePanIntent, and the alt buffer has no scrollback), so
    # the guard only STARVED the alt-screen pane of the one repaint that refills it
    # (owner bullet 4 resize-blank). The local control-mode resize now also marks a
    # pending repaint, so a bare shell repaints without user input (bullets 4 + 5).
    # A browser on v64 keeps the resize-blank, so the pin must move.
    #
    # VIEWS,: terminal-manager v67 -> v68, session-manager v60 -> v61,
    # app v85 -> v86, i18n v45 -> v46, style v66 -> v67. These five ship as ONE
    # unit because they change the wire protocol: the client now asks for its own
    # tmux client (view_attach / view_detach) instead of negotiating a shared
    # grid, so a browser holding any one of the old files would either keep
    # proposing sizes nothing answers or hold a geometry channel the server no
    # longer speaks.
    #
    # terminal-manager v65 -> v66, style v64 -> v65, app v83 -> v84 (owner batch
    #). Three user-visible behaviours change together, and a browser
    # holding any one of the old files keeps the corresponding defect:
    #   - terminal-manager: an alternate-screen shrink no longer trims rows off
    #     the top (the codex-over-tailscale "nhay len tren dau"), and the
    #     exit-scroll state is read from settled scroll rather than a viewport
    #     the browser clamped mid-resize (the keyboard open/close flicker).
    #   - style + app: the composer conflict controls moved to their own dock
    #     line, so they no longer collapse the text box to 55-124px. The CSS
    #     line and the JS that charges its height term must ship as a pair --
    #     old CSS with new JS would charge height for a line that is still
    #     display:none.
    # v93 -> v94: an attach records the size it carried, so the ack no longer
    # sends an ssh_resize for a size the server already opened the PTY at. A
    # browser on v93 keeps paying a refresh-client exec per pane per load.
    # v96 -> v97: a column change holds the pane on its last good frame until
    # the repaint has been quiet (omp replays its transcript after a settle),
    # a grow included. A browser on v96 shows omp's replay run past.
    assert "filename='js/terminal-manager.js') }}?v=98" in idx
    assert "\"filename='css/style.css'\": '?v=71'," in tp
    assert "\"filename='js/sftp-file-manager.js'\": '?v=16'," in tp
    assert "\"filename='js/app.js'\": '?v=98'," in tp
    # session-manager v51 -> v52 (S35 P5): restore-driven pane eviction stopped
    # (displaceOccupant:false) and the remembered session selection is applied on
    # arrival. v51 is RELEASED without the fix, so the pin must move.
    # v52 -> v53 (S35 P18): restoreSession, the reconnect ack and the live
    # pty_geometry handler each declare the transport before the pair guard.
    # v53 -> v54 (S35 P30): restoreSession called TerminalManager.beginReplay
    # unconditionally, so a restore carrying replay_total_chunks:0 opened a
    # replay gate that only the server's empty terminator could close -- while
    # it was open writeOutput queued every live frame
    # (terminal-manager.js:3132). The call is now guarded on > 0, matching
    # app.js:1067-1068. v53 is RELEASED without the guard, so the pin must
    # move.
    # Desurgery v59 -> v60: the pty_source_changed handler now re-fits (a moved
    # source changes what a wider pane renders under the S36 minimum).
    assert "\"filename='js/session-manager.js'\": '?v=70'," in tp
    assert "\"filename='js/terminal-manager.js'\": '?v=98'," in tp
    assert "style.css') }}?v=71\" in template" in tp


def test_command_workspace_modal_renamed_to_command_sets():
    # The Command Library left this modal host for the non-blocking #commandRail,
    # so commandWorkspaceModal became commandSetsModal (sets only, no tablist).
    # Asserting the old id is gone keeps the rename from silently regressing back
    # into a second, competing host for the same content.
    assert 'id="commandWorkspaceModal"' not in idx
    assert 'id="commandRail"' in idx
