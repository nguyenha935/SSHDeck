import re
from pathlib import Path

from tests.locale_sources import LOCALES, all_locale_text, locale_source


def read(path):
    return Path(path).read_text(encoding='utf-8')


def test_template_has_one_empty_pane_renderer_and_loads_launcher_utility_first():
    template = read('templates/index.html')
    assert 'id="noSessions"' not in template
    assert "filename='js/profile-launcher-utils.js'" in template
    assert template.index("filename='js/profile-launcher-utils.js'") < template.index(
        "filename='js/profile-manager.js'"
    )


def test_merged_profile_frontend_assets_have_distinct_cache_versions():
    template = read('templates/index.html')
    # style.css, i18n.js and app.js are carried ahead of upstream by the mobile
    # touch-UX patch (its rounds cache-bust them on every deploy); the other
    # assets are untouched by it and keep upstream's numbers.
    expected_versions = {
        # v57: W14 item 7 — #newConnectionBtn becomes the permanent icon-only
        # first child of .session-tabs-row at every viewport (strip tier
        # metrics + the phone line-sharing rewrite).
        # v59: S12 — the three P1 comment blocks are rewritten to state the
        # shipped contract (D-3 (iv): zero touch-action declarations changed;
        # D-4'/O3: JS owns the horizontal pan by writing scrollLeft). The bytes
        # change even though no declaration does, and v58 is already RELEASED
        # (the running image ships v58 with the pre-S12 bytes), so T12 requires
        # a raise: a browser holding the v58 copy would otherwise never refetch.
        # v60: the notepad mode selector's coarse-pointer 44x44 floor
        # (.notepad-mode-btn). v59 is RELEASED and the running image ships the
        # two chips with NO floor at all -- verified by reading
        # /app/static/css/style.css inside the container -- so without this raise
        # the fix would ship invisibly behind every browser's cached v59.
        # v62 (S21 item 1, ruled): the notes sheet's
        # keyboard-open display:none rule is DELETED and replaced by
        # .notepad-panel.sheet-inert { pointer-events: none }. v61 is RELEASED
        # and the running image ships the display:none flip -- the very flip that
        # swallowed the trusted click on #notepadCloseBtn between mousedown and
        # mouseup (measured /tmp/s16work/s21_j1_mech.out), so a browser holding
        # the v61 stylesheet would keep the sheet unclosable however correct the
        # new JS is. The pin must move with the rule.
        #
        # v63 (S26 R1): base html/body `width/max-width: 100vw` -> `100%`.
        # `vw` counts a classic scrollbar gutter that documentElement's content
        # box does not have, so html/body were laid out gutter-px too wide and
        # every page carried real horizontal overflow on engines with
        # space-reserving scrollbars -- docScrollX 13 -> 0 at all five tiers in
        # WebKit 26.5 with a 13px root bar (/tmp/s16work/s26b_r1/root_webkit.out).
        #
        # v67 (views,): the `.pane-pannable` rules went with the
        # pannable viewport itself -- a view is drawn by tmux clipped to this
        # client's own size, so no pane ever renders a grid wider than itself.
                # v69: a session chip suppresses the iOS callout and text selection
        # BEFORE the finger lands (pointer:coarse). v68 is RELEASED and only
        # painted `.dragging`, which arrives after the gesture, so a cached
        # v68 keeps selecting the chip label on a hold.
        # v70: owner ruling -- the phone-landscape 40px band, the dock slots
        # for the strip and the brand, and the 40px --shell-strip are gone; phone
        # landscape takes the >=768 touch tier (the min-height: 501px terms dropped).
        "filename='css/style.css'": '?v=70',
        # v30: W13-A4 legacy tmux locale chip badge (.chip-locale-warning).
        # v31: W14 item 2 bounded menus + item 6 broadcast picker.
        # v35: the drag-armed chip's lift was a black rgba() literal -- the one
        # colour that cannot follow a theme. It is mixed from --tw-shell now,
        # like every other shadow in the file. v34 is RELEASED (the running
        # image ships the literal), so the pin has to move or a browser holding
        # v34 keeps the black shadow.
                # v36: the `.dragging` selection rule now says why it is there (the
        # mouse drag); touch is handled in style.css v69.
        # v37: the short-landscape command sheet pads 2/4/2 instead of 5/12/4 so
        # its list keeps one row under the two-row header.
        # v38: drag-shift / drag-settle transform transitions for the chip drag
        # (reduced motion: none).
        "filename='css/deck.css'": '?v=40',
        # New: the --tw-* bridge moved out of deck.css so every page
        # can read the ten themes, not just the shell.
        "filename='css/deck-tokens.css'": '?v=1',
        "filename='css/sftp-file-manager.css'": '?v=6',
        # v36: W13-A4 session.legacyTmuxLocale / .legacyTmuxLocaleShort keys
        # in all six locales.
        # v37: W13-B5 session.reconnectRetainBody key in all six locales.
        # v39: W14 items 5/6 keys (composer.resyncPrompt; broadcast.targetMenu
        # / selectAll / targetCount) in all six locales.
        # v40: owner batch keys (notepad.updatedElsewhere;
        # composer.draftStorageUnavailable) in all six locales.
        # v41: S9 / D-10 conflict keys (composer.conflictNotice /
        # conflictKeepMine / conflictTakeTheirs) in all six locales.
        # v43: Đại phẫu -- the composer cross-device sync layer is gone, so its
        # keys are removed (composer.conflictNotice/KeepMine/TakeTheirs,
        # resyncPrompt, sentLocked, eraseUnavailable, broadcast.blockedBy-
        # StreamedDraft) in all six locales. A browser on v42 keeps those strings
        # cached, but nothing references them any more.
        # fix5 v43 -> v44: the broadcast streamed-draft refusal gate is restored
        # (broadcast-input.js), so its message key broadcast.blockedByStreamedDraft
        # is re-added in all six locales -- v43 had dropped the key while the gate
        # was removed, so the refusal fell back to the bare key id. A browser on
        # v43 shows no remedy text, so the pin must move.
        # v50: the six locales moved to static/js/i18n/<lang>.js and this file
        # became the engine; a stale copy would look for a table that is gone.
                # v51: session.closeWarning is gone with the reload dialog and
        # session.signInAgain arrives with the self-healing socket.
                # v52: auth.logoutConfirm is replaced by auth.logoutTitle and
        # auth.logoutLosesSessions in all six locales.
        "filename='js/i18n.js'": '?v=52',
        "filename='js/command-workspace.js'": '?v=4',
        "filename='js/profile-manager.js'": '?v=4',
        "filename='js/jump-host-manager.js'": '?v=4',
        # v11: S17 FIX 4d completion -- the insert-at-prompt write goes through
        # window.emitTerminalInput, so it is no longer swallowed by tmux copy
        # mode. v10 is RELEASED, so the pin must move or the fix ships invisibly.
        "filename='js/command-library.js'": '?v=11',
        "filename='js/command-set-manager.js'": '?v=2',
        # v45: W13-B5 reconnect payload carries the SOURCE session id so the
        # server can bind the reattach claim to the exact saved row.
        # v48: W14 items 5/6 — composer draft store + resync prompt, broadcast
        # allMode/custom-subset rendering.
        # v50: S9 / D-10 lossless composer revision + conflict handling
        # (CLEAN/DIRTY/CONFLICT, persisted revision, the two dock controls).
        # v51: S12 eye-gate fix — refreshComposerConflict() re-measures the
        # composer height when the two 44px conflict controls enter or leave the
        # dock. v50 is already RELEASED (the running image ships v50 without the
        # fix), so the pin must move or the fix ships invisibly.
        # v52: S14-5 — the composer's reverse path: get_terminal_line /
        # terminal_line_data / terminal_line_unavailable (reopen resolves
        # toward terminal truth), the gated reconcile-and-retype on an
        # in-prefix edit, the 90 ms typing-path draft debounce, and the
        # same-text-ACK boundary preservation in adoptCanonicalFrame.
        # v54: S16 -- D1 notepad-owns-keyboard focus contract (the notepad
        # focus listener no longer waits for keyboard-open), D2 terminal-truth
        # re-arm on a degenerate answer.
        # v55: S16/S3 -- the W14-B-3 page-visibility lifecycle
        # (visibilitychange both ways, pagehide, freeze, persisted pageshow,
        # socket reconnect) declaring client_visibility.
        # v57: S17 -- FIX 3 (the read-first empty-box erase: requestTerminalTruth
        #   returns whether a read went on the wire, an in-flight read WAITS, and
        #   \x15 is an announced fallback only) with the applyTerminalTruth rearm
        #   that makes the truth allowance per-transition; and FIX 4d (the single
        #   emitTerminalInput write funnel, which carries the leave_scroll
        #   advisory when this session's scroll is tmux copy mode and then returns
        #   the local viewport to the bottom). One bump: v57 has not shipped.
        # v58: S16 F1-c — app.js's ssh_connected handler ingests the snapshot's
        #   tmux_mouse field (the server-DECLARED policy) into TerminalManager.
        # v59: S17 R2 / audit F5-b — the terminal-truth allowance becomes a
        #   PER-TRANSITION budget: TRUTH_REARM_LIMIT 3 -> 64 and
        #   resetTerminalTruthBudget clears both the in-flight mark and the
        #   spend at four transitions (bind, a 'connected' status write,
        #   regained visibility / persisted pageshow, successful commit).
        #   Still event-driven; the reset itself emits nothing.
        # v60: S17 R3 / audit F5-c — the TRUTHFULNESS CONTRACT: a \x15
        #   correction is now kill + IMMEDIATE RE-STREAM of the surviving
        #   text through the gated funnel, sentLen settles on what the
        #   remote really holds (per-character DEL off the refreshed
        #   mirror), and a refused re-stream raises the conflict pair
        #   instead of leaving a silent phantom line.
        # v61: S20 item 4 — the composer's deletion contract. A trailing
        #   Backspace over a streamed prefix now erases the whole trailing
        #   GRAPHEME CLUSTER (lastGraphemeCluster / delBytesForCluster, sentLen
        #   reduced by the cluster's UTF-16 length), and the beforeinput branch
        #   performs the local edit itself because the browser's own
        #   deleteContentBackward removes only the last combining mark of a
        #   decomposed Vietnamese syllable (measured). Plus the
        #   `sshdeck:prompt-certified` listener, which is what reconciles the
        #   shell's pending line into the composer after a reload or a server
        #   restart. A browser on v60 would keep sending one DEL for a
        #   three-code-point letter, so the pin must move.
        # v62 (S21 items 1+2, ruled): applyTerminalTruth
        #   taints ONLY when the sample installs a nonempty prefix -- on v61 a
        #   successful sample of an EMPTY shell line (a bare prompt, which is what
        #   production answers at page load) tainted the draft, so nothing
        #   streamed, sentLen stayed 0 and the whole-cluster delete branch could
        #   never run (measured /tmp/s16work/s20_prod_taint_probe.out). Plus the
        #   sheet-inert writer that replaces the deleted CSS display:none flip.
        #   A browser on v61 keeps both defects, so the pin must move.
        # v63 (S22, ruled): separatePendingInput
        #   translates the tmux caret COLUMN into a UTF-16 index
        #   (indexForColumn). On v62 the column was used raw, so every
        #   reconciled line carrying a diacritic lost its trailing marks -- the
        #   composer disagreed with the terminal from the first frame after a
        #   reload. Behaviour on a released pin, so it moves.
        # v64 (S23 R1, ruled): delBytesForCluster sends
        #   ONE DEL PER CLUSTER, reversing S22's one-per-code-point rule. On v63
        #   a Backspace over a decomposed cluster spent three DELs, and readline
        #   erases one whole cluster per DEL -- so it destroyed the cluster AND
        #   the two characters before it, leaving the composer showing "ngti"
        #   while the shell held "ng" (measured against the Owner's own shell with
        #   the composer removed from the loop, /tmp/s16work/s22_del_units.out).
        #   A browser on v63 keeps over-erasing the user's real input line, so the
        #   pin must move.
        # S25 R1 -- truth-epoch gates stale terminal_line_data so the
        # post-reload reconcile cannot be clobbered by a frame whose ask
        # left before the user pressed Backspace.
        # S31 D5a -- an empty composer over a terminal line that holds text
        # clears the line (gated reconcileRemoteLine) instead of sending a bare
        # CR that executed it. A browser on v66 keeps running the line.
        # S35 A -- the erase releases the draft it emptied: on v69 the composer
        # streamed nothing at all after an empty-composer erase, so a browser on
        # v69 keeps a frozen composer and mark-first Vietnamese deletion.
        # S36 -- the empty-composer erase moved from `beforeinput` (which never
        # fires for an empty textarea, so the route was unreachable its whole
        # life) onto `keydown`. A browser on v77 keeps a Backspace that puts zero
        # bytes on the wire whenever the composer is empty.
        # v80: Desurgery -- the notepad save is serialized and
        #   re-bases on each ACK's revision, and the composer Send preventDefault
        #   is scoped so a WebKit touch keeps focus AND still fires click. A
        #   browser on v79 self-conflicts the notepad through its own RTT and
        #   cannot type into the terminal from the mobile composer.
        # v81: fix4 -- (owner bullets 2 + 3) streamTargetSession
        #   declines a server-confirmed alternate screen so no keystroke strands
        #   in a TUI's input line on mode exit, and the composer's cross-device
        #   mirror no longer fires mid-composition, so a Telex syllable stops
        #   racing the server echo onto a stale base_revision and the conflictNotice
        #   toast no longer fires on every Vietnamese word. v80 is RELEASED without
        #   either.
        # v82: fix5 -- (owner bullets 2 + 3) the v81 alternate guard is
        #   REVERTED: it regressed the composer to delete-only in every TUI (typing
        #   never streamed while empty-box DEL still fired). And the notepad direct
        #   flush re-bases on the last ACK revision with an applied:false routed
        #   through the focus gate, so a fast typist stops erasing its own char.
        #   v81 is RELEASED with the delete-only composer.
        # v83: fix8 -- (owner "không gõ được Tiếng Việt trên codex")
        #   reconcileRemoteLine reconciles the streamed prefix on the alternate
        #   screen too (sentLen DELs, not the shell-only \x15), so a Telex diacritic
        #   rewrite over a codex/vim pane is no longer preventDefault-swallowed.
        #   v82 is RELEASED unable to type Vietnamese into a TUI.
                        # v93: Logout asks in the app's own modal, and only when a live
        # session has no tmux session to come back to. It used to fire a
        # native confirm() for everyone, every time.
        # v94: the Broadcast toggle calls holdChromeGrid, so opening and
        # closing the desktop composer costs no resize (owner,:
        # "mở broadcast lên tắt đi thôi là terminal đang mở omp vẫn nhảy nhảy").
        "filename='js/app.js'": '?v=95',
        "filename='js/sftp-file-manager.js'": '?v=16',
        # Extracted from a 146-line inline <script> in index.html. Inline script
        # cannot be cache-busted at all -- it ships inside the cached HTML -- so
        # pinning it is the point of moving it out.
                # v12: applyTheme also writes the `theme` cookie, which is the only
        # copy /login can read before there is a user.
        # v13: comments only -- triggerReachableBottom no longer describes the
        # retired 40px band; the measurement is unchanged.
        "filename='js/header-menus.js'": '?v=13',
        # session-manager.js was the one changed asset with no pinned version
        # anywhere, so a change to it could ship behind a stale browser cache
        # with nothing going red. Pinned here for the same reason as the rest.
        # v36: D2a transport-loss candidate promotion + Retry chip retirement
        # (Phase 0 diagnostic msruuq45, owner-approved).
        # v37: W13-A4 legacy tmux locale snapshot ingestion + chip badge +
        # lifecycle-sheet detail annotation.
        # v38: W13-B5 truthful ordinary-disconnected Reconnect routing
        # (retain-confirm / refuse-no-identity / bare restore with intent).
        # v42: W13-B2 direct candidate reconnect (key / tailscale) carries the
        # B5 source session id, without which the server's fail-closed
        # reattach-claim check refuses the frame outright.
        # v43: W14 item 7 — syncLandscapeSessionStrip carries #newConnectionBtn
        # with the strip into the landscape dock and back.
        # v46: S16/S3 -- the restore snapshot's pty_cols/pty_rows comment now
        # states the W14-B-3 rule (min over visible clients) instead of
        # "largest live client wins"; S16/S5 adds the noteServerReplayLines call
        # ahead of createSession so the restored terminal is built with the
        # derived scrollback capacity.
        # v47: S17 FIX 1 -- renderPane moves a held .terminal-wrapper to
        # #terminalsContainer before pane.innerHTML = '', so the wrapper is never
        # detached and its AbortController-bound gesture listeners and xterm
        # buffer survive a re-render; and S17 FIX 5 -- focusActivePane returns
        # early while the Notes textarea owns the keyboard. And S17 FIX 6 --
        # setActivePane reports interaction for the pane the user deliberately
        # switched to (never for a lifecycle-driven target), which is what hands
        # that pane the shared PTY grid instead of waiting for the first
        # keystroke. One bump: v47 has not shipped.
        # v48: S16 F1-c — restoreSession and onReconnected ingest the snapshot's
        #   tmux_mouse field into TerminalManager.noteTmuxMousePolicy.
        # v49: S34 -- the pty_geometry handler learned `render_local`, the
        #   control-mode answer that announces a SOURCE width rather than a grid to
        #   adopt.
        # v52 (S35 P5, owner bullets 1/5): restoreSession stops evicting the
        #   pane's occupant (assignSessionToPane gained displaceOccupant:false on
        #   the restore path) and remembers WHICH session this device was working
        #   in (saveActiveSessionPreference, applied on arrival without claiming
        #   the shared grid). v51 is RELEASED -- the running image serves v51
        #   WITHOUT either fix (verified: 0 matches for displaceOccupant /
        #   saveActiveSessionPreference in /app/static/js/session-manager.js) --
        #   so a browser holding the cached v51 would keep parking the user's
        #   session unassigned after every reload. The pin must move.
        # v53 (S35 P18, owner bullets 1/3/5): all three `render_local` channels --
        #   the live pty_geometry answer, restoreSession and the reconnect ack --
        #   declare the TRANSPORT through noteControlTransport before the
        #   pty_cols/pty_rows guard decides the WIDTH. The route-return snapshot
        #   really does carry render_local: true with a NULL pair (measured on the
        #   real registry functions, /tmp/s35/p16_authority_none.log), and the old
        #   code lost the transport identity with the pair it never had, so a
        #   restored session answered every scroll-exit decision for the legacy
        #   transport. v52 is RELEASED without the fix (verified: 0 matches for
        #   noteControlTransport in /app/static/js/session-manager.js), so a
        #   browser holding the cached v52 keeps the wrong-transport decisions.
        #   The pin must move.
        # S35 P30: restoreSession called TerminalManager.beginReplay
        # unconditionally, so a restore carrying replay_total_chunks:0 opened a
        # replay gate that only the server's empty terminator could close --
        # while it was open writeOutput queued every live frame
        # (terminal-manager.js:3132). The call is now guarded on > 0, matching
        # app.js:1067-1068. v53 is RELEASED without the guard, so the pin must
        # move.
        # v55: S35 P33 -- showPersistentSessionTab no longer drops a
        # `persistent_session_available` offer for a session it already holds.
        # After an app/container restart the server emits ONLY that offer (no
        # ssh_session_restored, no replay chunk), so a preserved document kept a
        # green tab over a dead channel. The record is now transitioned to the
        # candidate state instead.
        # v60: Desurgery -- the `pty_source_changed` handler now
        #   re-fits. Under the S36 minimum a pane WIDER than the source renders
        #   at the source width, so a moved source (a peer hiding/leaving)
        #   changes what this pane must paint; v59 only NOTED it, so a desktop
        #   kept painting the old narrow source until its window was resized.
                # v67: bindLandscapeSessionStrip / syncLandscapeSessionStrip removed with the
                # phone-landscape strip relocation; the lifecycle
                # card stays below its chip and scrolls when at least three rows fit there,
                # instead of flipping above onto the strip (measured at 844x390).
                # v68: handles `screen_diagnostic_saved` (the file name or the
                # refusal) as a notification.
                # v69: a drag you can see -- the chip in hand follows the pointer
                # with a tilt, displaced chips slide to their new slot (FLIP).
                "filename='js/session-manager.js'": '?v=70',
        # v33: S16/S3 -- W14-B-3 min-over-visible: TerminalManager
        # .reportVisibility emits client_visibility, the D3 cosmetic geometry
        # corrections (settled-frame recentre/pannable, fractional rect
        # measurement) and the W14-B-3 contract docstrings.
        # v33 also carries S16/S4 (the alt-screen restore belt moved out of the
        # truncated branch into applyAltScreenBelt, gated on the real buffer type
        # after the parse) and S16/S5 (SCROLLBACK_DEFAULT derived from the
        # server's replay line cap via noteServerReplayLines). All three steps
        # land in one undeployed cycle, so the served version differs from the
        # released v32 exactly once.
        # terminal-manager.js grew the shared capability helper
        # (TOUCH_SHELL_QUERY / isTouchShell / isDesktopShell) in the
        # shell capability model; it was not previously pinned, so a change to
        # it could ship behind a stale browser cache with nothing going red.
        # v29: P1 steps S1/S3-S8 -- scrollback sanitizer, wheel sign, ScrollOwner
        # + row dispatch, single-owner gesture contract, horizontal axis-lock,
        # per-session horizontal intent.
        # v30: S14 -- R3(alpha) gesture authority watch + reconciler; W14-B-2
        # latest-active client tracking (ptyActiveClient), the proposal-settle
        # watch and the quantization guard in reportLocalFit.
        # v32: S16 -- D1 notepadOwnsKeyboard guard on both composer-first
        # redirectors + notepad-focused recomputed on every keyboard pass;
        # D3 visible-client size authority; D4 alt-screen restore belt.
        # v34: S16 post-deploy repairs, both in this one undeployed bump (the
        # cycle allows one version per changed file, and v34 has not shipped):
        #   A5 -- syncScrollBarWidth hoisted above fitTerminal's authority/local
        #     branch, so a client that JOINS a session (which adopts the shared
        #     grid before its first fit) no longer keeps xterm 5.3.0's phantom
        #     15px scrollbar reservation and no longer renders off-centre.
        #   D4-R -- the replay boundary. sanitizeReplayChunk now runs on EVERY
        #     chunk, not only a server-declared truncated one, so a normal tmux
        #     restore can no longer enter the alternate screen and lose the whole
        #     transcript; writeReplayChunk writes one rmcup of its own ahead of
        #     the first chunk (the replay owns the screen for the restore); the
        #     S16/S4 applyAltScreenBelt is removed as both unnecessary and
        #     harmful to a live frame queued during the replay.
        # v35: S17 -- FIX 2 (gate 3 of isSafeToReconcileRemoteLine no longer
        #   tests mouseTrackingMode === 'none': tmux `mouse on` is the product
        #   default, so that predicate was always false in production and it
        #   disabled Resync, reconcile-and-retype and the composer's only erase
        #   route; it now tests ScrollOwner provenance, with gates (1) and (2)
        #   still carrying the real safety) and FIX 5 (the double-tap focus
        #   redirect gains the notepadOwnsKeyboard guard its two siblings at
        #   :1381/:1422 already had, so a note is no longer typed into the
        #   composer). Plus FIX 6 -- TerminalManager.reportInteraction emits the
        #   `client_interaction` frame, which is how a client the user has turned
        #   to but not yet typed in claims the shared PTY grid; a browser on a
        #   stale copy would never send it and its pane would keep rendering a
        #   grid it does not fit. One bump: v35 has not shipped.
        # v36: S16 F1-c — the observer-triggered tmux mouse reassertion:
        #   writeToTerminalWithScroll captures the pre-frame tracking mode and,
        #   when a frame's NET effect clears tracking on a session whose server-
        #   declared policy (snapshot tmux_mouse) says mouse on, reasserts the
        #   declared triple via writeControlNow (engine-local, transcript-clean)
        #   and self-certifies provenance. Covers both restore and reconnect/
        #   attach ordering.
        # v37: S20 items 4/5 — three changes a stale copy would silently drop.
        #   item 4: observeReconcileEvidence raises `sshdeck:prompt-certified`
        #     on the FIRST certification that also passes
        #     isSafeToReconcileRemoteLine, which is the only signal telling the
        #     composer the pane has become readable after a reload/restart.
        #   item 5: ensureCharCellMeasured, called from fitTerminal for every
        #     visible terminal. xterm 5.3.0 measures the char cell once inside
        #     open(), and every connection after the first is opened inside a
        #     display:none `.unassigned` wrapper, so the cell measured 0x0 and
        #     the fit addon returned undefined FOREVER -- the terminal stayed
        #     80x24, no ssh_resize proposal ever reached the server, and every
        #     gesture that divides by a cell was dead (measured).
        #   item 5: resetHiddenShellScrollers + its document-capture scroll
        #     listener. Focusing the Notes textarea scrolled #workspace to 440,
        #     putting the pane 352px above an overflow-y:hidden container that
        #     nothing could scroll back.
        # v38 (S23 R4, ruled): writeNeedsScrollExit now
        #   fires on tmux's PAINTED copy-mode indicator
        #   (tmuxPaneInCopyModeIndicator) as well as the old
        #   isSessionScrolled/!appOwnsMouse pair. On v37 neither conjunct could be
        #   true for a tmux pane with `mouse on` -- the product default -- so the
        #   leave_scroll advisory never fired and every write after a swipe was
        #   discarded by tmux until the user interacted (measured
        #   /tmp/s16work/s22_i4_ordering.out, /tmp/s16work/s22_product_copyexit.out).
        #   A browser on v37 keeps that dead-write window, so the pin must move.
        # v39 (S27): the live-edge intent -- liveEdgeIntent,
        #   noteLiveEdgeIntent (in the ResizeObserver callback) and
        #   restoreLiveEdgeIntent (at the bottom of fitTerminal). A row GROW on a
        #   buffer holding scrollback stranded the viewport 2x the row delta above
        #   the live edge, permanently, painting history where the prompt belongs
        #   (measured baseY 114 / viewportY 86 / gap 28 / last row 8 chars,
        #   /tmp/s26reg/diag3_s27.out). Cause: the app's `.xterm{height:100%}`
        #   grows the absolutely positioned `.xterm-viewport` scroller in the same
        #   layout pass as the pane while xterm still holds the old row count, so
        #   the browser clamps scrollTop and xterm turns that clamp into a real
        #   buffer scroll; the debounced fit then carries the gap into the new
        #   grid. A browser on v38 has no capture point that can see the pre-clamp
        #   buffer, so the pin must move.
        # v40 (S27, second correction): v39 sampled the at-edge state inside
        #   the ResizeObserver callback; on a real browser resize the clamp-induced
        #   scroll lands FIRST, so that sample was already the contaminated one
        #   (measured +55ms: baseY 114, viewportY 105, gap 9, capture false --
        #   /tmp/s26reg/diag9_s27.out). v40 maintains a standing flag from xterm's
        #   own scroll event instead, gated on scroller-height provenance. v39 was
        #   served here, so the pin rises again rather than being reused.
        # v41 (S27, third correction): height provenance alone cannot classify the
        #   clamp, because the ResizeObserver callback and the clamp-scroll race in
        #   both orders over the SAME height value. With two resizes ~100ms apart --
        #   the real production pacing, since the probe advances as soon as a row
        #   paints -- the callback adopted the new height first, so the clamp-scroll
        #   3ms later arrived with EQUAL heights, was read as a deliberate scroll,
        #   and overwrote the flag with false; restoreLiveEdgeIntent then correctly
        #   declined and the strand held gap 20 to +9s (measured: resize +203ms
        #   h=691 true/false->true/true, scroll +206ms h=691 baseY 115 vpY 105
        #   true/true->false/false, /tmp/s26reg/diag14_s27.out). v41 suppresses flag
        #   UPDATES while the pending mark is set, so both orderings are covered.
        #   v40 was served here, so the pin rises rather than being reused.
        # v42 (S29): observeReconcileEvidence's announcement latch moved from
        #   firstCertification (per-session, latched BEFORE the gate) to
        #   evidence.reconcileConfirmed, set inside clearReconcileDesync -- so a
        #   background announcement the bound composer never accepted cannot
        #   consume the one-shot and leave the box empty for 12s after a reload.
        # v43 (S30): tmuxPaneInCopyModeIndicator now also reads the pane's TOP
        #   row. tmux draws the copy-mode position indicator at the pane's
        #   top-right; the S23 window scanned only the last four rows, which
        #   coincided with the indicator solely because that measurement was
        #   taken on an EMPTY pane. On any pane holding real output the detector
        #   answered false while the pane was in copy mode, so writeNeedsScrollExit
        #   stayed false, leave_scroll never rode ssh_input, and tmux discarded
        #   every composer write after a swipe -- the whole S23 R4 fix was inert
        #   in production. Measured on the live deployment across eight gestures
        #   and both viewports: the indicator was on pane row 0 every time
        #   (/tmp/s26reg/s30_p5_G.log, s30_p6_H.log §H2). v42 is RELEASED (the
        #   running image serves it), so the pin must move or the fix ships
        #   invisibly.
        # v44 (S30-B) -- dataIsMouseReport, and the reason it is a behaviour
        #   change rather than a tidy-up. `leave_scroll` was being stamped on the
        #   SGR mouse reports the scroll gesture itself emits, and the server
        #   honours the flag by exiting copy mode INLINE BEFORE the write
        #   (socket_events.py:1188-1196), so those same report bytes were then
        #   written into a pane that had just left copy mode, where readline
        #   printed them as literal text and swallowed the next write's leading
        #   character. Measured end to end on the deployed build with a socket
        #   tape (/tmp/s26reg/s30_p8.log §I1): the reports carrying the flag were
        #   coordinates 33,34,36,38 and the shell line held
        #   "[<64;26;33M[<64;26;34M[<64;26;36M[<64;26;38M"; §I3 caught the eaten
        #   character ("...[<64;26;36Mcho SETTLED"). v43 is released here, so the
        #   pin rises rather than being reused.
        # v45 (S32): the geometry hold gained a bounded WAIT (armedAt + a deadline
        #   that RE-REQUESTS, never drains). A stale v44 keeps the unbounded wait
        #   in which a lost pty_geometry froze the pane behind a 256KB byte bound.
        # v46: S34 -- noteLocalRenderSource records the control-mode source width
        #   WITHOUT writing ptyAuthority, so this client keeps its own fit.
        # v49 (S35 P6, owner's live regression; the helper itself was REMOVED
        #   in v86 -- xterm 6 has no DOM scroller): resyncViewportScroller, called
        #   from fitTerminal beside ensureCharCellMeasured. A terminal that spent
        #   time in a display:none wrapper (a pane switch, a restore, a
        #   route-return) keeps its DOM scroller recorded against the zero-height
        #   box it had while hidden, so the buffer sits at the live edge while
        #   scrollTop is 0 and the whole history is unreachable by wheel or
        #   touch. Measured on the deployed build (/tmp/s35p6/mechanism.mjs):
        #   scrollTop 0 against an expected 1948, wheel-up 163 -> 163 on all
        #   three connects, every ancestor at scroll 0. v48 is RELEASED without
        #   the fix (verified: 0 matches for resyncViewportScroller in
        #   /app/static/js/terminal-manager.js), so a browser holding the cached
        #   v48 would keep the frozen pane. The pin must move.
        # v50 (S35 P18): the transport identity is its OWN record
        #   (controlTransport / noteControlTransport) instead of being inferred
        #   from localRenderSource, because the restore snapshot on the owner's
        #   Terminal -> /admin -> Terminal journey declares render_local: true with
        #   a null geometry pair, and a parked connection (#2/#3 in a display:none
        #   wrapper) never proposes a fit, so no answer can ever supply the width
        #   that used to be the only carrier of the transport fact. isControlModeSession
        #   now reads the declaration; localRenderSource keeps its own validation so
        #   source-width mode still needs a real measured source. v49 is RELEASED
        #   without it (verified: 0 matches for controlTransport in
        #   /app/static/js/terminal-manager.js), so a cached v49 keeps answering
        #   scroll-exit for a transport that is not running. The pin must move.
        # v51: S35 P32 — the S32 answer deadline is the ONLY bound on a geometry
        #   hold, and it latched `rerequested` BEFORE its attempt. That attempt is
        #   reportLocalFit, which returns without emitting on an unlaid-out pane
        #   (:1007), so one no-op spent the retry for the life of the hold: no
        #   ssh_resize left, no pty_geometry could arrive, and the queue grew
        #   against the 256KB cap alone. Measured on the owner's reload journey —
        #   4 frames / 4257 bytes held, prompt and input glyphs still in the queue,
        #   the engine on the stale 51x48 the restore snapshot adopted. v50 is
        #   RELEASED with the eager latch, so a cached v50 keeps that frozen pane.
        # v63: Desurgery -- two fixes. (1) the soft-keyboard ratio
        #   heuristic is gated on a coarse pointer, so a desktop window shrink is
        #   no longer read as "keyboard open" (which pinned --app-height, hid the
        #   header, and made the alt-screen ResizeObserver guard refuse every fit
        #   -- the frame stuck top-left after shrinking). (2) the control-source
        #   render grid takes its ROWS from this pane's own fit, not the engine's
        #   frozen row count, so a shrunk desktop beside a phone no longer cuts
        #   off its bottom rows. v62 is RELEASED without either.
        # v64: fix4 (owner bullet 1) -- consumePendingSourceRepaint
        #   declines the request_pane_repaint nudge on a server-confirmed alternate
        #   screen, so a peer's source move no longer SIGWINCHes the desktop's
        #   full-screen program back to the top of the session. v63 is RELEASED
        #   with the top-jump.
        # v65: fix5 (owner bullets 1 + 4 + 5) -- the v64 guard is
        #   REVERTED (measured: the repaint moves nothing on a source-width alt
        #   client, so the guard only starved the alt pane of the redraw that
        #   refills it after a resize), and a local control-mode resize now marks a
        #   pending repaint so a bare shell repaints without user input. v64 is
        #   RELEASED with the alt-screen resize-blank.
                        # v88: the grid is bottom-anchored in both directions (the centre/bottom
        # flip was the jumping on a desktop resize), and the first size change of
        # a burst is proposed at once so the engine stops painting a stale window.
        # v90: the Unicode 11 addon is loaded and made active, so a full-width row
        # with an emoji measures the same in the engine as in tmux.
        # v89: the rotation-while-keyboard-open branch of the visualViewport resize
        # listener is gone (no exit but a keyboard cycle), and applyViewportVars
        # re-derives the keyboard baseline when a rotation's height arrives one
        # event late (owner,: no header in landscape, header stuck
        # hidden after rotating back).
        # v91: the engine keeps the last 64 KB it was given per session
        # (recordStreamTail) and sendScreenDiagnostic ships it with the grid,
        # buffer offsets and visible rows; the button exists only with
        # ?kbdebug=1 (owner,: the omp prompt row repeated fifty
        # times with nothing recorded to replay).
        # v92: a shrink covers the pane with its last good frame until tmux's
        # repaint arrives. Measured: xterm does not trim the ALTERNATE buffer's
        # lines on resize (118-cell lines stay 118 under a 59-column grid), and
        # every attached tmux client draws on that buffer, so the pane used to
        # render the left 59 columns of the old frame for the ~700 ms until a
        # repaint (owner: "giật nhìn khá khó chịu").
        # v93: the app's own chrome (a desktop Broadcast composer) no longer moves
        # the shared tmux window: the reported fit adds back the pixels that
        # chrome holds, while everything that DRAWS the pane keeps measuring
        # the box as it is.
        "filename='js/terminal-manager.js'": '?v=95',
        # touch-action-row.js owns the six-action global row. It did not exist
        # when this table was written; an unpinned copy of it is the single most
        # damaging stale asset on touch, because the row it builds is the only
        # route to layout, broadcast, transcript, reconnect and notes there.
        # v8: W14 item 7 — SECONDARY drops newConnectionBtn (the strip owns it).
        # v9: syncBrand and the landscape media listener removed -- the brand no
        # longer relocates into the dock.
        "filename='js/touch-action-row.js'": '?v=9',
    }
    for asset, version in expected_versions.items():
        asset_start = template.index(asset)
        asset_tag = template[asset_start:template.index('>', asset_start)]
        assert version in asset_tag


def test_profile_manager_builds_safe_contextual_launcher_buttons():
    source = read('static/js/profile-manager.js')
    assert 'createEmptyPaneContent(paneIndex)' in source
    assert "button.type = 'button'" in source
    assert 'button.dataset.profileId = profile.id' in source
    assert 'name.textContent = profile.name' in source
    assert 'endpoint.textContent = ProfileLauncherUtils.formatEndpoint(profile)' in source
    assert 'window.launchProfileForPane(profile.id, paneIndex)' in source
    assert 'profile-launcher-card' in source
    assert 'innerHTML = profile' not in source


def test_profile_dependencies_refresh_only_empty_panes():
    profiles = read('static/js/profile-manager.js')
    jump_hosts = read('static/js/jump-host-manager.js')
    sessions = read('static/js/session-manager.js')
    assert 'SessionManager.refreshEmptyPanes()' in profiles
    assert profiles.count('this.refreshEmptyPanes()') >= 2
    assert 'SessionManager.refreshEmptyPanes()' in jump_hosts
    assert 'refreshEmptyPanes()' in sessions
    assert 'if (!this.paneAssignments[index])' in sessions


def test_dynamic_empty_panes_refresh_after_language_changes():
    source = read('static/js/session-manager.js')
    assert "window.addEventListener('languageChanged'" in source
    assert 'this.refreshEmptyPanes()' in source


def test_launcher_css_is_scrollable_responsive_and_keyboard_visible():
    source = read('static/css/style.css')
    for selector in (
        '.profile-launcher',
        '.profile-launcher-list',
        '.profile-launcher-card',
        '.profile-launcher-card:focus-visible',
    ):
        assert selector in source
    assert 'overflow-y: auto' in source
    assert 'min-height: var(--touch-target-min)' in source


def test_launcher_cards_keep_content_readable_with_many_profiles():
    source = read('static/css/style.css')

    launcher_list = source[source.index('.profile-launcher-list {'):source.index(
        '.profile-launcher-card {',
    )]
    endpoint = source[source.index('.profile-launcher-endpoint {'):source.index(
        '.profile-launcher-action {',
    )]

    assert 'width: min(1120px, 100%);' in launcher_list
    assert (
        'grid-template-columns: repeat(auto-fit, '
        'minmax(min(300px, 100%), 1fr));'
    ) in launcher_list
    assert 'grid-column: 1 / -1;' in endpoint


def test_mobile_launcher_stacks_status_below_profile_details():
    source = read('static/css/style.css')
    mobile_start = source.index(
        '@media (max-width: 767px) {',
        source.index('.profile-launcher-new'),
    )
    mobile_end = source.index('\n}\n\n.terminal-wrapper', mobile_start)
    mobile = source[mobile_start:mobile_end]

    assert 'grid-template-columns: minmax(0, 1fr);' in mobile
    assert '.profile-launcher-action {' in mobile
    assert 'grid-column: 1;' in mobile
    assert 'grid-row: auto;' in mobile
    assert 'justify-self: start;' in mobile


def test_profile_launcher_stylesheet_uses_current_cache_version():
    template = read('templates/index.html')

    # Ahead of upstream's ?v=4: the mobile touch-UX patch cache-busts style.css
    # on each of its rounds. Kept in step with the same asset in
    # test_merged_profile_frontend_assets_have_distinct_cache_versions above --
    # this file states the style.css pin TWICE, so a raise must move both or one
    # row goes red while the other passes.
    assert "filename='css/style.css') }}?v=70" in template


def test_retired_upload_modules_are_fully_gone():
    """drag-drop-manager.js and binary-transfer-client.js are retired.

    Their upload paths were unreachable: binary-transfer-client.js declared
    `class BinaryTransferClient` as a top-level binding in a classic script, so
    it never landed on `window`, and the guard `window.BinaryTransferClient` in
    drag-drop-manager.js could never pass. The only observable effect of the
    pair was a second drag overlay competing with the canonical one.

    This replaces the ?v=2 pin that used to be asserted above. A stale cached
    copy is no longer the failure mode -- a resurrected module is -- so the
    contract moves from "is pinned" to "is absent from disk and from the
    template", which is the stronger of the two.
    """
    for gone in ('static/js/drag-drop-manager.js',
                 'static/js/binary-transfer-client.js'):
        assert not Path(gone).exists(), f'{gone} was retired and must not return'

    template = read('templates/index.html')
    for reference in ('drag-drop-manager.js', 'binary-transfer-client.js',
                      'dragDropManager', 'BinaryTransferClient'):
        assert reference not in template, f'{reference} still referenced in template'

    # Exactly one drag overlay, and it is the canonical one.
    assert 'id="dropOverlay"' in template
    assert template.count('id="dropOverlay"') == 1

    # The SFTP panes dismiss the window overlay through their own helper now,
    # not through the retired manager.
    sftp = read('static/js/sftp-file-manager.js')
    assert 'window.dragDropManager' not in sftp
    assert 'hideWindowDropOverlay' in sftp

    css = read('static/css/style.css')
    for dead in ('.drag-drop-overlay', 'dragDropHint'):
        assert dead not in css, f'{dead} is dead CSS for a retired module'
    # bounce was private to the retired overlay's icon; a keyframe with no user
    # is dead weight, and a rule still animating it would be a live defect.
    assert '@keyframes bounce' not in css
    assert not re.search(r'animation:[^;]*\bbounce\b', css)
    assert '.drop-overlay {' in css


def test_profile_launch_prefills_before_requesting_submit():
    source = read('static/js/app.js')
    start = source.index('function launchProfileForPane')
    end = source.index('window.launchProfileForPane', start)
    body = source[start:end]
    assert body.index('openConnectionModalForPane(paneIndex)') < body.index(
        'selectConnectionProfile(profileId)'
    )
    assert body.index('selectConnectionProfile(profileId)') < body.index(
        'form.requestSubmit()'
    )
    assert "mode === 'connect'" in body
    assert 'isSelectedProfileReady(selected)' in body


def test_auto_launch_has_no_coupled_save_profile_state():
    """RETIRED NEGATIVE, W14 item 8 (owner-approved plan, test contract update).

    The original assertions were:
        assert 'saveProfileCheck' not in template
        assert 'profileNameInput' not in template
        assert "socket.emit('save_profile'" not in source

    Documented reason for retirement: that test existed to guarantee that
    profile LAUNCH (launchProfileForPane) never couples a profile SAVE. W14
    item 8 ADDS save-as-profile to the connection modal, so the two
    template-absence assertions now contradict the approved feature. The
    third assertion (app.js never emits save_profile) survives in substance
    below: the emit stays inside ProfileManager.saveProfile (profile-manager.js)
    and app.js still contains no direct save_profile emit. The decoupling is
    now enforced by POSITIVE contracts instead of blanket absence.
    """
    source = read('static/js/app.js')

    # 1. The launch path still couples NO save: launchProfileForPane neither
    #    checks the box nor calls saveProfile, and app.js never emits the
    #    frame itself -- the emit lives only in profile-manager.js.
    start = source.index('function launchProfileForPane')
    end = source.index('window.launchProfileForPane', start)
    launch_body = source[start:end]
    assert 'saveProfile' not in launch_body
    assert 'saveProfileCheck' not in launch_body
    assert "socket.emit('save_profile'" not in source
    assert "save_profile" in read('static/js/profile-manager.js')

    # 2. The save gate is the checkbox state AT SUBMIT, keyed to the exact
    #    request, and only for an ordinary connect (never reset/reconnect).
    assert 'saveProfileCheck && saveProfileCheck.checked' in source
    assert '!resetMeta && !reconnectMeta' in source
    assert 'pendingProfileSaveMap.set(currentConnectRequestId' in source

    # 3. The save fires only on SUCCESS: consumed inside the ssh_connected
    #    handler and never at emit time.
    assert 'pendingProfileSaveMap.has(data.client_request_id)' in source
    assert 'ProfileManager.saveProfile(profilePayload)' in source

    # 4. The storable payload is built from individual fields and never reads
    #    the password input; connectionData (which carries the password) is
    #    never the source.
    builder_start = source.index('function buildConnectionProfilePayload')
    builder_end = source.index('return payload;\n    }', builder_start)
    builder = source[builder_start:builder_end]
    assert "'passwordInput'" not in builder
    assert 'password' not in builder
    assert 'connectionData' not in builder


def test_save_as_profile_checkbox_defaults_off_and_name_input_exists():
    """W14 item 8: the checkbox exists, is UNCHECKED in the served markup
    (default OFF), and the profile-name input exists. An ordinary Connect is
    unchanged because nothing is checked at load."""
    template = read('templates/index.html')
    check_html = template[template.index('id="saveProfileCheck"'):]
    # The tag must not carry a checked attribute; look at the tag up to '>'.
    tag_end = check_html.index('>')
    assert 'checked' not in check_html[:tag_end]
    assert 'id="profileNameInput"' in template
    assert 'id="profileNameGroup"' in template


def test_password_modes_focus_the_missing_runtime_secret():
    source = read('static/js/app.js')
    start = source.index('function launchProfileForPane')
    end = source.index('window.launchProfileForPane', start)
    body = source[start:end]
    assert "mode === 'password'" in body
    assert "document.getElementById('passwordInput')" in body
    assert "mode === 'jump-host-password'" in body
    assert "document.getElementById('jumpHostPasswordInput')" in body
    assert '.focus()' in body


def test_form_readiness_blocks_stale_auth_key_and_jump_host_state():
    source = read('static/js/app.js')
    assert 'function isSelectedProfileReady(profile)' in source
    assert "authTypeSelect.value !== profile.auth_type" in source
    assert "keySelect.value !== profile.key_id" in source
    assert "jumpHostSelect.value !== (profile.jump_host_id || '')" in source


def test_submit_keeps_target_pane_until_all_passwords_are_validated():
    source = read('static/js/app.js')
    start = source.index(
        "document.getElementById('connectionForm').addEventListener('submit'"
    )
    end = source.index("document.getElementById('keyUploadForm')", start)
    body = source[start:end]
    assert body.index('pendingPaneIndex = null') > body.index(
        "showNotification('Jump host password is required'"
    )
    assert "document.getElementById('passwordInput').focus()" in body
    assert "document.getElementById('jumpHostPasswordInput').focus()" in body


def test_dropdown_and_launcher_share_profile_selection_logic():
    source = read('static/js/app.js')
    assert 'function selectConnectionProfile(profileId)' in source
    change_start = source.index(
        "document.getElementById('profileSelect').addEventListener('change'"
    )
    change_body = source[change_start:change_start + 350]
    assert 'selectConnectionProfile(e.target.value)' in change_body


def test_f3_placeholders():
    """F3: mobileInputPlaceholder updated to concise one-liners,
    one per locale; all legacy long values absent; index.html fallback updated.

    The locale blocks used to be sliced out of one combined file by indentation.
    Since the split each language is its own file, so the slicing --
    and the boundary drift it was written to catch -- is gone.
    """
    expected_values = {
        'en': 'Command\u2026',
        'vi': 'Nh\u1eadp l\u1ec7nh\u2026',
        'de': 'Befehl\u2026',
        'fr': 'Commande\u2026',
        'es': 'Comando\u2026',
        'zh': '\u8f93\u5165\u547d\u4ee4\u2026',
    }
    assert set(expected_values) == set(LOCALES)
    for locale, expected in expected_values.items():
        source = locale_source(locale)
        key_pair = f"'terminal.mobileInputPlaceholder': '{expected}'"
        assert key_pair in source, f'{locale}.js is missing {key_pair!r}'
        assert source.count("'terminal.mobileInputPlaceholder':") == 1, (
            f'{locale}.js defines the placeholder more than once')

    # All legacy long placeholders are absent
    legacy = [
        'Type or paste here...',
        'Nh\u1eadp ho\u1eb7c d\u00e1n v\u00e0o \u0111\u00e2y...',
        'Hier tippen oder einf\u00fcgen...',
        'Tapez ou collez ici...',
        'Escribe o pega aqu\u00ed...',
        '\u5728\u8fd9\u91cc\u8f93\u5165\u6216\u7c98\u8d34...',
    ]
    text = all_locale_text()
    for old in legacy:
        assert old not in text, f"legacy placeholder still present: {old!r}"

    # index.html fallback
    index_html = read('templates/index.html')
    assert 'placeholder="Command…"' in index_html, \
        "index.html fallback not updated"


def test_every_client_byte_write_goes_through_the_one_input_funnel():
    """S17 FIX 4d invariant: ONE client funnel writes bytes to a session.

    tmux DISCARDS every byte written to the attached client's channel while the
    pane is in copy mode (measured on a scratch tmux 3.4 server: text + CR,
    \\x7f, \\x15 and a printable byte all vanished without moving copy_cursor_y),
    and tmux `mouse on` is the product default, so any write path that bypasses
    the funnel is silently dead after a scroll -- a wheel scroll on desktop
    enters copy mode exactly as a touch swipe does on mobile.

    The funnel is `window.emitTerminalInput` (app.js): it attaches the
    `leave_scroll` advisory when TerminalManager.writeNeedsScrollExit says this
    session's scroll is tmux copy mode rather than xterm scrollback, and it
    reconciles the local viewport afterwards. A future path that emits
    `ssh_input` on its own would reintroduce the defect in exactly one corner,
    which is the failure mode this test exists to catch.

    Four client paths write bytes, all through the funnel:
      1. the composer -- streamed characters and the per-press DEL, the explicit
         Send, and reconcileRemoteLine's \\x15 (app.js), plus the sticky
         Ctrl/Alt sequence and the function keypad;
      2. raw xterm onData, i.e. typing directly into the terminal
         (session-manager.js setupInputHandler);
      3. the command library's insert-at-prompt (command-library.js);
      4. broadcast sendAll, decided PER SESSION (broadcast-input.js).
    """
    funnel_definition = "window.emitTerminalInput = "
    app = read('static/js/app.js')
    assert funnel_definition in app, 'the funnel itself is gone'

    # Files allowed to name ssh_input, and the reason each one may.
    guarded_fallback_files = {
        'static/js/session-manager.js',
        'static/js/command-library.js',
        'static/js/broadcast-input.js',
    }

    emit_call = "emit('ssh_input'"
    for path in sorted(guarded_fallback_files):
        source = read(path)
        assert 'window.emitTerminalInput(' in source, \
            f'{path} no longer routes through the funnel'
        # Each of these loads BEFORE app.js in index.html, so the funnel does not
        # exist while the file is parsed. The direct emit is permitted only as a
        # typeof-guarded fallback beside the funnel call -- never on its own.
        assert source.count(emit_call) == 1, \
            f'{path} should keep exactly one guarded fallback emit'
        assert "typeof window.emitTerminalInput === 'function'" in source, \
            f'{path} emits ssh_input without guarding on the funnel'

    # app.js may emit exactly once: inside the funnel.
    assert app.count(emit_call) == 1, \
        'app.js should emit ssh_input only from inside emitTerminalInput'
    funnel_start = app.index(funnel_definition)
    assert app.index(emit_call) > funnel_start, \
        'app.js emits ssh_input before/outside the funnel definition'

    # No OTHER client file may write bytes at all.
    for js in sorted(Path('static/js').glob('*.js')):
        rel = js.as_posix()
        if rel in guarded_fallback_files or rel == 'static/js/app.js':
            continue
        assert emit_call not in read(rel), \
            f'{rel} bypasses the S17 FIX 4d input funnel'


def test_the_input_funnel_carries_the_scroll_advisory_and_reconciles_the_viewport():
    """The funnel's two halves, pinned at source level.

    The post-write viewport reconciliation must reuse what the
    tmux_copy_mode_exited handler already does rather than inventing a second
    mechanism.

    S23 R4 CHANGED what this test demands of the
    predicate. It used to assert that the advisory came from the
    isSessionScrolled/appOwnsMouse pair and nothing else ("no new predicate").
    That was wrong, and it was wrong in a way that made the funnel useless on the
    only pane that needs it: a tmux session with `mouse on` turns mouse tracking
    on for the outer terminal too, so appOwnsMouse is TRUE at a bare prompt
    (measured trackingMode 'drag' with nothing running but bash,
    /tmp/s16work/s22_product_copyexit.out), while a swipe leaves xterm's own
    viewport at the bottom because tmux scrolls its own copy, so
    isSessionScrolled is FALSE. Both conjuncts false means the advisory never
    fired and every write after a swipe was discarded by tmux until the user
    interacted. The pair is KEPT as the fallback -- it still catches the
    xterm-scrollback case -- and the copy-mode indicator is now the primary
    signal, so both are required here.
    """
    app = read('static/js/app.js')
    funnel = app[app.index('window.emitTerminalInput = '):]
    funnel = funnel[:funnel.index('\n    };') + 1]

    assert 'writeNeedsScrollExit' in funnel, \
        'the funnel must ask the predicate, not decide for itself'
    assert 'leave_scroll' in funnel
    assert 'scrollSessionToBottom' in funnel, \
        'tmux repaints at the bottom; the local viewport must follow'
    assert 'setScrollState' in funnel

    terminal_manager = read('static/js/terminal-manager.js')
    predicate = terminal_manager[
        terminal_manager.index('writeNeedsScrollExit(sessionId)'):]
    predicate = predicate[:predicate.index('\n    },') + 1]
    assert 'tmuxPaneInCopyModeIndicator' in predicate, \
        ('the advisory no longer fires on the painted copy-mode indicator, so a '
         'tmux pane with mouse on -- the product default -- silently discards '
         'every write after a swipe (S23 R4)')
    # The pre-S23 pair stays as the fallback: it is the one that catches a plain
    # xterm-scrollback scroll on a session tmux is not managing.
    assert 'isSessionScrolled' in predicate
    assert '!this.appOwnsMouse' in predicate

    # Anchored on the METHOD DEFINITION, not on the name: the first occurrence in
    # the file is the call site inside writeNeedsScrollExit, and slicing from
    # there measured the caller instead of the reader.
    reader = terminal_manager[
        terminal_manager.index('\n    tmuxPaneInCopyModeIndicator(terminal) {'):]
    reader = reader[:reader.index('\n    },') + 1]
    assert '[0-9]+\\/[0-9]+' in reader, \
        'the indicator reader no longer looks for tmux\'s [N/M] shape'
    assert 'translateToString' in reader, \
        'the indicator must be read off the PAINTED screen, not inferred'


def test_only_deliberate_activation_records_the_remembered_session():
    """The two things that must NOT count as the user choosing a pane.

    Two paths reach the same activation code and neither is the user:

      * removeSessionUI's pane repair (preserveLifecycleTarget) -- internal
        maintenance;
      * restoreSession's pane assignment (declareInteraction: false) -- a page
        rebuilding itself from a snapshot, before the user has touched anything.

: what these gate is now the REMEMBERED SELECTION only. The
    interaction declaration they used to gate is gone with the shared grid --
    there is no authority to take, because each socket has its own tmux client
    -- but the suppressions still matter: a phone waking in a pocket and
    reloading must not overwrite the session the user last chose.

    Pinned here rather than only in the browser gate because both are ABSENCES.
    A gate can prove a recording happens; only reading the guard proves the two
    suppressions are still wired to the two call sites, and a future edit that
    drops either argument would leave every existing row green.
    """
    sessions = read('static/js/session-manager.js')

    # The restore call site passes the suppression explicitly.
    restore = sessions[sessions.index('restoreSession(data) {'):]
    restore = restore[:restore.index('assignSessionToPane(') + 400]
    assert 'declareInteraction: false' in restore, \
        'restoreSession must not record a reloaded pane as the user\'s choice'

    # The guard itself requires BOTH conditions, so neither path can slip
    # through if the other is removed.
    guard = sessions[sessions.index('setActivePane(paneIndex, {'):]
    guard = guard[:guard.index('this.saveActiveSessionPreference(') + 200]
    assert 'declareInteraction = true' in guard, \
        'declareInteraction must default to true -- an ordinary tap counts'
    assert '!preserveLifecycleTarget && declareInteraction' in guard, \
        'both suppressions must gate the one recording'

    # The interaction channel is gone, on both sides.
    assert 'reportInteraction' not in sessions
    assert "client_interaction" not in read('static/js/terminal-manager.js')
