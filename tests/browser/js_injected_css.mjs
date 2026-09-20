/*
 * The two UI surfaces that used to ship their own CSS from JavaScript.
 *
 * sftp-file-manager.js appended an 82-line <style> the first time an upload
 * started; drag-drop-manager.js appended a 42-line one on DOMContentLoaded and
 * wrote the overlay's own box through style.cssText. 124 lines of CSS arriving
 * from JS, which fails in three ways the stylesheet does not:
 *
 * drag-drop-manager.js has since been RETIRED along with binary-transfer-client.js:
 * every upload path in it was gated behind a transferClient that could never be
 * constructed (the guard tested window.BinaryTransferClient, which that file never
 * assigned), so its only observable effect was a second full-window overlay
 * stacked on the canonical one. Its half of this contract now targets the
 * canonical #dropOverlay, and the rules it used to inject are asserted ABSENT
 * rather than relocated. The sftp half is unchanged.
 *
 *   - index.html cache-busts by hand with ?v=N per asset. A <style> built inside
 *     a function has no URL, so an edit to those rules could not be busted at
 *     all: a returning browser kept the old JS, which kept injecting the old CSS.
 *   - They could not reach the token scale, and did not: raw 8px radii, 16/20px
 *     padding, z-index 999999 and 10000 with no tier behind either.
 *   - They redeclared keyframes that already existed. slideInRight and
 *     slideOutRight are byte-identical to notificationSlideIn/Out, and a
 *     duplicate @keyframes name replaces the earlier one for the whole document
 *     -- so the two toast systems were already sharing whichever loaded last.
 *
 * What this file asserts, and why each one is measured rather than grepped:
 *
 *   1. Neither file injects a <style> or writes cssText any more. Static, but the
 *      cheapest guard against the pattern coming back.
 *   2. Both surfaces still RENDER correctly with only the stylesheet loaded --
 *      driven through the real code paths (a real dragenter with a file payload;
 *      a real upload batch), because "the CSS moved" and "the CSS still applies"
 *      are different claims and only the second one matters.
 *   3. The success state follows the theme. It read a success-bg property that
 *      nothing declares, so all ten themes got one hardcoded green. Measured by
 *      switching data-theme and reading the computed colour.
 *   4. The overlay outranks a modal and a toast. It covers the window while a
 *      drag is in progress; if a modal painted over it the drop target would be
 *      invisible. Measured from computed z-index, not from the source number.
 *
 * Run: node tests/browser/js_injected_css.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const html = renderTemplate();

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
            return;
        }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------- no injection -----
{
    console.log('--- the CSS no longer ships from JavaScript ---');
    const files = ['sftp-file-manager.js', 'session-manager.js',
                   'header-menus.js', 'app.js'];
    for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, 'static/js', f), 'utf8');
        check(`${f}: no <style> element built at runtime`,
            /createElement\(\s*['"]style['"]\s*\)/.test(src), false);
        check(`${f}: no style.cssText block`,
            /\.style\.cssText/.test(src), false);
    }

    // The rules have to be somewhere, and that somewhere is the one stylesheet
    // index.html pins a version on.
    const css = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');
    for (const cls of ['.upload-progress-notification', '.drop-overlay',
                       '.session-overlay-tmux', '.theme-color-dot.is-light']) {
        check(`style.css declares ${cls}`, css.includes(`${cls} {`), true);
    }

    /*
     * The retired module's own rules must be gone, not relocated: a selector
     * left behind here would style an overlay that no longer exists, and the
     * `bounce` keyframe was private to its icon.
     */
    for (const dead of ['.drag-drop-overlay', 'dragDropHint']) {
        check(`style.css no longer declares ${dead}`, css.includes(dead), false);
    }
    check('bounce went with the overlay that was its only user',
        css.includes('@keyframes bounce'), false);
    check('no rule is left animating the removed keyframe',
        /animation:[^;]*\bbounce\b/.test(css), false);

    // Every changed asset has one exact production reference and its current pin;
    // drag-drop-manager.js (now retired) once had no pin at all, which is the
    // failure this contract exists to prevent. Counting the complete reference
    // rejects stale duplicate tags as well as a missing or merely higher
    // arbitrary version.
    const template = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    for (const [asset, version] of [
        // v57: W14 item 7 strip '+' (style.css owns the tier metrics).
        // v58: owner batch asset changes.
        // v59: S12 P1 comment rewrite. Comment-only, so no declaration and no
        // computed style changed (T-CSS1 136/0) -- but the BYTES changed and v58
        // is already released, and T12 keys off bytes, not behaviour.
        // v60: the notepad mode selector's coarse-pointer 44x44 floor. Unlike
        // v59 this one DOES change a computed style, and v59 is released without
        // it, so the raise is what makes the fix reach a cached browser.
        // v62: S21 item 1 -- the keyboard-open display:none rule on
        // .notepad-panel is DELETED (that flip between mousedown and mouseup is
        // what swallowed the close click) and replaced by a
        // .sheet-inert pointer-events rule. A real declaration change on a
        // released pin, so the raise is what makes it reach a cached browser.
        // v63: S26 R1 -- the base html/body rules change `width/max-width: 100vw`
        // to `100%`. `vw` counts a classic, space-reserving scrollbar gutter that
        // documentElement's content box does not have, so html and body were laid
        // out gutter-px too wide and every page carried real horizontal overflow
        // wherever such scrollbars exist: docScrollX 13 -> 0 at all five tiers in
        // WebKit 26.5 with a 13px root bar (/tmp/s16work/s26b_r1/root_webkit.out).
        // ipad-landscape is the Owner's reported breakpoint. Another declaration
        // change on a released pin, so it must raise too.
        // v64: S35 P31 (owner's Notepad mode-toggle report) -- in a NARROW desktop
        // rail both children of .notepad-title were shrinkable, so the two-chip
        // segmented control wrapped its 'Per-server' label and grew the header
        // 58 -> 70px, pushing Note content down. .notepad-mode-toggle now declares
        // `flex: none` and .notepad-title > span truncates instead. Real
        // declaration changes on a released pin, so it must raise.
        // v65: owner batch -- the composer conflict controls moved to
        // their own dock line (.mobile-composer-actions) and the dock charges
        // --composer-conflict-line for it. A browser on v64 has no such line, so
        // the pair collapses the text box to 55-124px again while the new app.js
        // charges height for a line that is still display:none. Real declaration
        // change on a released pin, so it must raise.
        // v66: owner batch (second pass) -- the rejected dock line is
        // deleted and the Resync/conflict controls stand in an absolutely
        // positioned popover instead (.composer-conflict-sheet). The Send
        // icon-only rule no longer hides .composer-resync-btn's label, because
        // that button now paints one. A cached v65 still charges
        // --composer-conflict-line and hides the popover's label, so the pin
        // must move.
        // v68: Phase 2 -- the resync/conflict popover rules are
        // gone with the sheets themselves.
        ['css/style.css', 70],
        // deck.css owns the v5 shell and is edited every bucket, so it needs the
        // same pin contract as style.css. It was missing from this table -- which
        // is exactly the "no pin at all" failure described above.
        // v30: W13-A4 legacy tmux locale chip badge (.chip-locale-warning).
        // v31: W14 item 2 bounded menus + item 6 broadcast picker.
        // v32: owner batch asset changes.
        // v38: drag-shift / drag-settle transitions for the chip drag.
        ['css/deck.css', 38],
        ['css/deck-tokens.css', 1],
        ['css/sftp-file-manager.css', 6],
        // v28: owner batch (terminal-manager untouched by P1 D1-D3,
        // re-pinned to the served version).
        // v29: P1 steps S1/S3-S8 -- strict scrollback sanitizer, wheel sign fix,
        // ScrollOwner + row dispatch, single-owner gesture contract, horizontal
        // axis-lock, per-session horizontal intent preservation.
        // v30: S14 -- R3(alpha) gesture authority watch + reconciler; W14-B-2
        // latest-active client tracking (ptyActiveClient), proposal-settle
        // watch, quantization guard in reportLocalFit.
        // v32: S16/S1+S2 -- D1 notepadOwnsKeyboard guard on both composer-first
        // redirectors, notepad-focused recomputed on every keyboard pass, and
        // the D2 learned prompt column with its invalidations. (This table
        // carried a stale 31 through that step; corrected here with the S3
        // bump rather than left to rot.)
        // v33: S16/S3 -- W14-B-3 min-over-visible: reportVisibility emits
        // client_visibility, plus the D3 geometry corrections (settled-frame
        // recentre/pannable, fractional rect measurement). Also carries S16/S4
        // (applyAltScreenBelt for every replay, decided after the parse) and
        // S16/S5 (scrollback default derived from the server replay cap).
        // v34: the S16 post-deploy repairs -- A5 (syncScrollBarWidth hoisted
        // above fitTerminal's branch, so a joining client drops xterm's phantom
        // 15px reservation) and D4-R (the replay boundary cleans every chunk, the
        // replay claims the screen before its first byte, and S16/S4's
        // applyAltScreenBelt is removed).
        // v35: S17 -- FIX 2 (isSafeToReconcileRemoteLine gate 3 stops testing
        // mouseTrackingMode === 'none', which tmux `mouse on` made an
        // always-false predicate, and tests ScrollOwner provenance instead) and
        // FIX 5 (the missing notepadOwnsKeyboard guard on the double-tap focus
        // redirect). Both ride ONE bump: v35 has not shipped, and the cycle
        // allows one version per changed file.
        // v36: S16 F1-c -- the observer-triggered tmux mouse reassertion
        // (declaredTmuxMouse gate, two-shape boundary trigger, bounded
        // per-session budget, engine-local writeControlNow bytes) plus the
        // readiness-drain fix that carries sessionId through pendingOutput.
        // (This table carried a stale 35 through that step; corrected here.)
        // v37: S20 items 4/5 -- observeReconcileEvidence raises
        // `sshdeck:prompt-certified` on the first certification that also passes
        // isSafeToReconcileRemoteLine (item 4's reload/restart reconcile hook);
        // ensureCharCellMeasured re-runs xterm's one-shot char measurement from
        // fitTerminal, without which every connection after the first -- opened
        // inside a display:none `.unassigned` wrapper -- keeps a 0x0 cell, so
        // the fit addon returns undefined forever and geometry, the server
        // proposal and every gesture stay dead; and resetHiddenShellScrollers
        // zeroes scrollTop on the overflow-hidden shell boxes, without which
        // focusing Notes leaves the terminal pane 352px above the viewport with
        // nothing able to scroll it back.
        // v38: S23 R4 -- writeNeedsScrollExit fires on tmux's PAINTED copy-mode
        // indicator (the new tmuxPaneInCopyModeIndicator) as well as the old
        // isSessionScrolled/!appOwnsMouse pair. On v37 NEITHER conjunct could be
        // true for a tmux pane with `mouse on`, which is the product default:
        // appOwnsMouse is true because tmux's mouse mode turns tracking on for
        // the outer terminal too, and isSessionScrolled is false because tmux
        // scrolls its own copy and leaves xterm's viewport at the bottom. So the
        // leave_scroll advisory never fired, and tmux discarded every write after
        // a swipe until the user interacted (measured
        // /tmp/s16work/s22_i4_ordering.out).
        // v39: S27 -- the live-edge intent (liveEdgeIntent /
        // noteLiveEdgeIntent / restoreLiveEdgeIntent). The app's own
        // `.xterm{height:100%}` (style.css:5729) grows the absolutely-positioned
        // `.xterm-viewport` scroller in the SAME layout pass as the pane, while
        // xterm still holds the old row count: maxScrollTop falls, the browser
        // clamps scrollTop, and xterm turns the clamp into a real buffer scroll.
        // The debounced fit then carried the gap into the new grid, so a row
        // GROW on a buffer with scrollback stranded the viewport 2x the row delta
        // above the live edge, permanently -- measured on the live box as
        // baseY 114 / viewportY 86 / gap 28 with the last visible row 8 chars
        // (the Owner's "resize/repaint goes blank"). v38 has no capture point
        // that can see this: fitTerminal reads the already-clamped buffer. The
        // ResizeObserver callback appeared to (diag7 Q1: gap 0 there, gap 12 one
        // turn later), so v39 sampled the state in that callback.
        // v40: THAT SAMPLING POINT WAS WRONG, and v39 shipped to this origin
        // before the production probe said so. diag9_s27.out, first sample +55ms
        // after a real BROWSER viewport grow, read baseY 114 / viewportY 105 /
        // gap 9 with the v39 capture ALREADY holding atLiveEdge false: on a
        // browser-driven resize the clamp-induced scroll is dispatched BEFORE the
        // ResizeObserver callback, so no resize-time sample is trustworthy. The
        // diag7 fixture only won that race because it changed the height from JS,
        // which delivers the callback in the same rendering update. v40 keeps a
        // STANDING flag maintained from xterm's own scroll event, gated on
        // scroller-height provenance (unchanged height = a decision and refreshes
        // it; changed height = a clamp, so the flag is kept and marked pending).
        // A browser holding v39 keeps the strand, so the pin must move again.
        // v41: height provenance ALONE is not enough. The ResizeObserver callback
        // and the clamp-scroll race over the same height value, and with two
        // resizes ~100ms apart (production's real pacing) the callback adopts the
        // new height first -- so the clamp arrives with EQUAL heights, is read as a
        // deliberate scroll, and overwrites the flag with false (measured
        // /tmp/s26reg/diag14_s27.out: strand gap 20, permanent to +9s). v41
        // suppresses flag updates while the pending mark is set. v40 was served, so
        // the pin rises again.
        // v42 (S29): observeReconcileEvidence's announcement latch moved from
        // firstCertification (per-session, latched BEFORE the gate) to
        // evidence.reconcileConfirmed, set inside clearReconcileDesync -- so a
        // background announcement the bound composer never accepted cannot consume
        // the one-shot and leave the composer empty for 12s after a reload.
        // NOTE ON THE RECORD: this table, and the coupled assertion in
        // tests/test_modal_shell_contract.py, were both left at 41 when S29 raised
        // the template to 42, so both were red on the tree S29 declared complete.
        // Corrected here rather than renumbered silently.
        // v43 (S30): tmuxPaneInCopyModeIndicator also reads the pane's TOP row.
        // tmux draws its copy-mode position indicator at the pane's top-right; the
        // S23 window scanned only the last four rows, which coincided with the
        // indicator solely because that measurement was taken on an EMPTY pane. On
        // any pane holding real output the detector answered false while the pane
        // WAS in copy mode, so writeNeedsScrollExit stayed false, `leave_scroll`
        // never rode ssh_input (app.js:1334-1338), and tmux discarded every
        // composer write after a swipe -- the whole S23 R4 fix was inert in
        // production. Proved causal by runtime mutation on the live deployment
        // (/tmp/s26reg/s30_p5_G.log arms A/B/C); the indicator was on pane row 0 in
        // all eight measured gestures across both viewports (s30_p6_H.log §H2).
        // v44 (S30-B): the funnel no longer stamps `leave_scroll` on a payload
        // that IS an SGR mouse report. The advisory's premise -- "a byte the user
        // deliberately sends is not a read" -- does not hold for the bytes that
        // ARE the scroll: the gesture's synthesized wheels (rows D/E, :2524-2556)
        // and a desktop wheel both arrive at the funnel as reports, and the
        // server honours the flag by exiting copy mode INLINE BEFORE the write
        // (socket_events.py:1188-1196), so those same bytes were written into a
        // live pane where readline printed them as raw text and swallowed the
        // next write's leading character -- the Owner's raw-escape debris
        // (/tmp/s26reg/s30_p8.log sections I1/I3). v43 is released, so the pin
        // rises rather than being reused.
        // v45: S32 -- the geometry hold gained a bounded WAIT (an armedAt instant
        // plus a deadline that RE-REQUESTS the authoritative geometry; it never
        // drains, so the gate stays event-closed). v44 is released, so the pin
        // rises rather than being reused.
        // v48 (S34): the control-mode transport. This table was left at 47 while
        // templates/index.html shipped 48, so THIS GATE WAS NOT COVERING
        // terminal-manager.js at all -- the same hole the app.js row records
        // above, found by the S35 run and corrected here rather than left open.
        // v50 (S35 P18): AND IT LAGGED AGAIN. Measured this run on a tree with
        // the P18 change reverted in the template only (/tmp/s35/iso_pre18_tpl,
        // log /tmp/s35/r18_jsinj_pre18.log): RC=1, 115 passed / 2 failed, this
        // row and the session-manager row below, both red against the SERVED
        // v49/v52 -- i.e. red before P18 touched anything. Classified (a): the
        // table asserted a superseded pin, not an app defect. It is corrected to
        // the pin the template serves now, which is what keeps the gate covering
        // the asset instead of covering a number nobody ships. The change the pin
        // exists for here: isControlModeSession reads its own controlTransport
        // record, so a restore snapshot carrying render_local with a NULL geometry
        // pair still leaves the client knowing the transport.
        // v51: S35 P32 -- the geometry-hold answer deadline latches its
        // re-request only after an ssh_resize really left. A declined attempt (an
        // unlaid-out pane: reportLocalFit returns false at :1007) used to spend the
        // only retry there is, so the hold froze with the prompt/input bytes still
        // queued and the engine on the stale 51x48 the restore adopted -- the
        // owner's reload defect. v50 is RELEASED with the eager latch, so a cached
        // v50 keeps the frozen pane.
        // v63: bug-fix -- markPendingSourceRepaint + the post-settle
        // request_pane_repaint emit in scheduleSettledProposal.finish(). A cached
        // v62 never asks for the redraw, so a moved control-mode source stays
        // mangled until reload; the pin must move.
        // v64/v65: released between this table's last edit and the owner batch;
        // the table carried a stale 63 through them and is corrected here rather
        // than left to rot.
        // v66: owner batch -- an alternate-screen shrink holds its row
        // count (resizeTerminalPreservingAltRows) so a desktop resize over
        // tailscale no longer trims rows off the top of a codex TUI, and the
        // exit-scroll state reads settled scroll (settledAtBottom) rather than a
        // viewport the browser clamped mid-resize. A cached v65 keeps both
        // defects, so the pin must move.
        // v67: owner batch (second pass) -- ScrollOwner.resolve takes
        // the session id and reads the SERVER-published pane screen state rather
        // than the engine's buffer type, which tmux pins at attach and which
        // therefore decided the gesture row by fresh-connect-vs-restored instead
        // of by what the pane holds (owner report 3: exit-scroll appeared on one
        // session and not another). A cached v66 keeps the attach artefact.
        // v69: Phase 1b -- windowGeometry (the engine holds the session's
        // minimum, centred). v70: Phase 2 -- the reconcile-evidence group is
        // deleted with the composer that read it.
        // v71: Phase 3 -- the WebKit composition rescue (Safari + a
        // Vietnamese IME delivered nothing for a composed syllable) and the
        // ?kbdebug=1 keyboard log. A cached v70 keeps the silent letters.
        // v72: -- ENGINE == WINDOW == PTY (an alternate grid now
        // shrinks to the server's window size, which is what leaves tmux's
        // `·` filler rows behind when it does not), and the ?kbdebug=1 log
        // also reaches the server.
        // v73: measured on the owner's Safari -- its Vietnamese IME rewrites
        // the word with `insertReplacementText`, which xterm ignores, so the
        // app now delivers any input event the engine dropped.
        // v74: -- a shared window below the pane's fit is drawn
        // zoomed to fill the pane (the desktop showed a 413px strip in a
        // 1426px pane); a held grid taller than the pane shows its LAST
        // rows; every Safari input event is reconciled again (the v73 skip of
        // `insertText` lost the first letter of a word). A cached v73 keeps
        // the strip and the lost letter.
        // v77: the keyboard hold lets a taller pane grow the window
        // (reportHeldGrowth), a short window sits against the composer while
        // the keyboard is up, and ?kbdebug=1 logs the grid geometry.
        // v78: the zoom cap is 6x (an 83-row desktop against a 20-row phone
        // window needed more than 3x), and the grid log carries painted rows.
        // v79: fits come from the measured character (the rendered cell moved
        // with the grid: 138<->139 forever), the grid fills the pane on both
        // axes with text scaled both ways, and Exit scroll knows tmux copy mode.
        // v81: a wheel is replayed to a full-screen application only when the
        // engine encoded it as a mouse report, and the replay carries real
        // coordinates (a blind burst of cursor keys froze a codex pane).
        // v82: the fit measures the real scrollbar gutter instead of
        // reserving 14px for an overview ruler xterm does not draw.
        // v83: a rotation is detected by the viewport WIDTH, not by
        // window.inner*, which a phone updates after the resize event.
        // v91: the 64 KB stream tail and the screen diagnostic.
        // v92: a shrink holds the pane on its last good frame until tmux's
        // repaint lands (the alternate buffer keeps its old line widths).
        // v93: the app's own chrome (a desktop Broadcast composer) no longer moves
        // the shared tmux window: the reported fit adds back the pixels that
        // chrome holds, while everything that DRAWS the pane keeps measuring
        // the box as it is.
        ['js/terminal-manager.js', 93],
        ['js/sftp-file-manager.js', 16],
        // v11: S17 FIX 4d completion -- the insert-at-prompt write routes through
        // window.emitTerminalInput, so it is no longer swallowed by tmux copy
        // mode. v10 is RELEASED, so the pin must move or the fix ships invisibly.
        ['js/command-library.js', 11],
        // v36: W13-A4 session.legacyTmuxLocale keys in all six locales.
        // v37: W13-B5 session.reconnectRetainBody key in all six locales.
        // v39: W14 items 5/6 keys in all six locales.
        // v40: owner batch keys (notepad.updatedElsewhere;
        // composer.draftStorageUnavailable).
        // v41: P1 step S9 / D-10 composer conflict keys
        // (composer.conflictNotice / conflictKeepMine / conflictTakeTheirs) in
        // all six locales.
        // v43: desurgery -- the seven composer/broadcast keys of the
        // removed sync layer are deleted in all six locales
        // (broadcast.blockedByStreamedDraft, composer.sentLocked,
        // composer.resyncPrompt, composer.conflictNotice, .conflictKeepMine,
        // .conflictTakeTheirs, composer.eraseUnavailable). A browser on v42 still
        // ships them, so the pin moves. (notepad.updatedElsewhere and
        // composer.draftStorageUnavailable are KEPT -- both still fire.)
        // v44: released after this table's last edit; the pin carried a stale 43
        // and is corrected to the served version here.
        // v45: owner batch (second pass) -- the seven composer keys the
        // conflict/resync surfaces read are RESTORED in all six locales
        // (resyncPrompt, resyncNotice, conflictGroup, conflictKeepMine,
        // conflictTakeTheirs, conflictNotice, sentLocked). v43 deleted them with
        // the removed sync layer, but app.js reads them again, so on a cached
        // v44 t() falls through and paints the raw key at the user.
        // v47: Phase 2 -- the nine composer.* keys of the deleted sheets are
        // gone; terminal.keypadClearLine added, all six locales.
        ['js/i18n.js', 52],
        // v37: W13-A4 legacy tmux locale snapshot ingestion + chip badge +
        // lifecycle-sheet detail annotation. (The table carried a stale 35
        // here since the D2a bump to 36; both are corrected in one edit.)
        // v38: W13-B5 truthful ordinary-disconnected Reconnect routing.
        // v42: W13-B2 direct candidate reconnect carries the B5 source
        // session id, so the fail-closed reattach-claim check honours it.
        // v43: W14 item 7 — the strip button travels with the strip into the
        // landscape dock.
        // v44: 0209f10 raise. v45: P1 D1 — SessionManager.init loses the
        // restore/replay socket.on ownership to app.js's early sole owner and
        // gains grid-before-drain buffer splicing.
        // v46: S16/S3 — the restore snapshot's pty_cols/pty_rows contract note
        // states the W14-B-3 rule instead of "largest live client wins"; S16/S5
        // learns replay_max_lines before the terminal is built.
        // v47: S17 FIX 1 (renderPane relocates a held .terminal-wrapper to
        // #terminalsContainer before wiping the pane, so the gesture listeners
        // and the xterm buffer survive) and S17 FIX 5 (focusActivePane declines
        // to take the keyboard from a focused Notes textarea). One bump: v47 has
        // not shipped.
        // v48: S16 F1-c -- restoreSession and onReconnected ingest the
        // snapshot's tri-state tmux_mouse into TerminalManager (restore before
        // createSession; the reconnect ack's None is a deliberate no-op).
        // (This table carried a stale 47 through that step; corrected here.)
        // v51: left at 50 here while the template shipped 51 -- another instance
        // of this table lagging the served pin, corrected in the S35 run.
        // v53 (S35 P18): lagging a third time -- measured red at 51 against the
        // served v52 on the pre-P18 template (/tmp/s35/r18_jsinj_pre18.log), so
        // this is a superseded assertion, class (a), not a defect. The pin it now
        // tracks carries the transport declaration on all three render_local
        // channels (restoreSession, the reconnect ack, the live pty_geometry
        // handler) ahead of the pty_cols/pty_rows guard.
        // v54: S35 P30 -- restoreSession called TerminalManager.beginReplay
        // unconditionally, so a restore carrying replay_total_chunks:0 opened
        // a replay gate that only the server's empty terminator could close --
        // while it was open writeOutput queued every live frame
        // (terminal-manager.js:3132). The call is now guarded on > 0, matching
        // app.js:1067-1068. v53 is RELEASED without the guard, so the pin must
        // move.
        // v55: S35 P33 -- persistent_session_available for an already-held
        // session now transitions it out of the connected state instead of
        // being dropped by an early return.
        // v60: bug-fix -- pty_source_changed marks the pending
        // post-settle repaint before requestFit. A cached v59 lacks the mark, so
        // the desktop never requests the redraw after a source move.
        // v62: Phase 1b -- tmux_window_geometry listener; a live
        // restore snapshot parks the session (replaces_session_id retires the
        // stale offer in place).
        // v68: screen_diagnostic_saved shown as a notification.
        // v69: the chip drag is animated (follow + tilt, displaced chips slide).
        ['js/session-manager.js', 69],
        // v7: W14 item 6 broadcast target picker semantics (allMode/custom
        // subset), stable under the review contract.
        // v8: S17 FIX 4d completion -- sendAll routes each session through
        // window.emitTerminalInput, so a scrolled session in the broadcast set is
        // not the one that silently drops the command. v7 is RELEASED.
        // v9: Phase 2 -- the open guard reads window.__composerMirrorLen.
        ['js/broadcast-input.js', 9],
        // v45: W13-B5 reconnect payload carries the SOURCE session id so the
        // server can bind the reattach claim to the exact saved row.
        // v48: W14 items 5/6 composer draft store + resync + broadcast labels.
        // v49: 0209f10 raise. v50: P1 D1 early sole owner for restore/replay
        // + D3 canonical composer-frame adoption (data/updated/conflict) with
        // per-key debounce timers.
        // v51: S12 eye-gate fix — the conflict reveal re-measures the composer
        // height, so a wrapped draft cannot paint over the help line.
        // v52: S14-5 — the composer's reverse path: get_terminal_line /
        // terminal_line_data / terminal_line_unavailable (reopen resolves
        // toward terminal truth), the gated reconcile-and-retype on an
        // in-prefix edit, the 90 ms typing-path draft debounce, and the
        // same-text-ACK boundary preservation in adoptCanonicalFrame.
        // v54: S16/S1+S2 -- D1 notepad focus contract (the notepad focus
        // listener no longer waits for keyboard-open) and D2 terminal-truth
        // re-arm on a degenerate answer. (Stale 53 in this table through that
        // step; corrected here.)
        // v55: S16/S3 -- the W14-B-3 page-visibility lifecycle
        // (visibilitychange both ways, pagehide, freeze, persisted pageshow,
        // socket reconnect) declaring client_visibility.
        // v57: S17 -- FIX 3's read-first empty-box erase plus the
        // applyTerminalTruth rearm, and FIX 4d's single emitTerminalInput write
        // funnel carrying the leave_scroll advisory. One bump: v57 has not
        // shipped.
        // v58: S16 F1-c -- ssh_connected ingests the declared tmux_mouse
        // policy before the session's first frame can reach the engine.
        // v59: S17 R2 / audit F5-b -- the terminal-truth allowance becomes a
        // PER-TRANSITION budget (TRUTH_REARM_LIMIT 3 -> 64 plus
        // resetTerminalTruthBudget at bind / 'connected' write / regained
        // visibility / successful commit). Behaviour change, so the pin moves.
        // v60: S17 R3 / audit F5-c -- the TRUTHFULNESS CONTRACT: a \x15
        // correction is kill + IMMEDIATE RE-STREAM of the surviving text,
        // sentLen settles on what the remote really holds, and a refused
        // re-stream raises the conflict pair. Behaviour change, so the pin
        // moves.
        // v61: S20 item 4 -- whole-GRAPHEME deletion (the trailing cluster erased
        // in one press, sentLen reduced by its UTF-16 length, the local edit
        // performed by the handler because the browser's own
        // deleteContentBackward removes only the last combining mark of a
        // decomposed Vietnamese syllable) plus the `sshdeck:prompt-certified`
        // listener that reconciles the shell's pending line after a reload or a
        // server restart. A browser on v60 cannot erase a cluster at all, so the
        // pin moves.
        // v62: S21 items 1+2 -- the conditional taint in applyTerminalTruth
        // (an EMPTY sample no longer freezes the composer) and the sheet-inert
        // writer that replaces the deleted CSS flip. Both are behaviour on a
        // released pin, so the pin moves.
        // v63: S22 -- the caret COLUMN is translated to a UTF-16 index, so a
        // reconciled Vietnamese line is no longer truncated. Behaviour change on
        // a released pin.
        // v64: S23 R1 -- delBytesForCluster sends ONE DEL PER CLUSTER, reversing
        // S22's one-per-code-point rule. Measured against the Owner's own shell
        // with the composer removed from the loop
        // (/tmp/s16work/s22_del_units.out): readline erases one WHOLE cluster per
        // DEL, so v63's three DELs destroyed the cluster AND the two characters
        // before it -- composer "ngti", shell "ng". A browser on v63 keeps
        // over-erasing the user's real input line, so the pin moves.
        // S25 R1 -- truth-epoch prevents stale terminal_line_data
        // answers from clobbering correct local edits.
        // v66: S30-B -- the funnel gates `leave_scroll` on
        // TerminalManager.dataIsMouseReport, so a scroll report never asks the
        // server to leave copy mode and never yanks the viewport mid-gesture.
        // Behaviour change on a released pin, so the pin moves.
        // v67: S31 D5a -- an empty composer over a terminal line that HOLDS text
        // clears that line instead of running it. This table was left at 66 when
        // the template shipped 67, so THIS GATE WAS NOT COVERING app.js at all --
        // found by the S32 run, and corrected here rather than left as a hole.
        // v70: S35 A -- the empty-composer erase releases the draft's taint once
        // it has spent the last DEL of the installed prefix. On v69 the composer
        // was frozen for the rest of the page life after that erase.
        // v79: desurgery -- the per-char streaming + cross-device
        // draft mirror + dirty/conflict/tainted/sentLen state machine between the
        // composer and tmux is REMOVED. Desktop types straight into xterm; mobile
        // keeps composer+Send with an all-local draft (zero ssh_input until Send).
        // The one surviving composer->tmux byte is the S31/S35 empty-erase. The
        // notepad sync was redesigned to an ack + skip_sid model (no self-echo).
        // A browser on v70 still ships the removed state machine, so the pin moves.
        // v80: bug-fix -- the non-broadcast composer now types LIVE
        // (each keystroke streams to the active session and empties the box;
        // Telex held until compositionend; Send = \r). A cached v79 still ships
        // the all-local draft, so the pin moves.
        // v81-v83: released between this table's last edit and the owner batch;
        // the table carried a stale 80 through them and is corrected here.
        // v84: owner batch -- refreshComposerConflict moves the pair
        // into #mobileComposerActions and charges --composer-conflict-line for
        // the line it occupies. Must ship with style.css v65: old CSS with new JS
        // charges height for a display:none line. So the pin moves.
        // v85: owner batch (second pass) -- the rejected dock line is
        // gone; Resync and the conflict pair live in an anchored popover, Resync
        // is gated on a recorded desync rather than on a non-empty box, and the
        // reconcile no longer refuses on an unproven pane (it chooses the clear
        // BYTE: \x15 only for a certified shell prompt, DELs otherwise), which is
        // what unfreezes the composer on a Claude Code session. A cached v84
        // keeps the frozen box and the extra buttons, so the pin moves.
        // v87: Phase 1b -- ssh_session_removed listener. v88: Phase 2 -- the
        // composer is a diff mirror of the terminal line; the classifier, the
        // draft store, the resync and conflict sheets and the truth budget are
        // deleted. A cached v86 still paints the resync sheet.
        // v89: the note's live typist wins a save conflict instead of losing
        // the words they are typing.
        // v94: the Broadcast toggle holds the grid across its own composer.
        ['js/app.js', 94],
        // v9: 0209f10 raise. v10: P1 D2 trigger-anchored More-sheet position
        // (top = trigger.bottom+1, bottom auto, measured maxHeight) — Entry 27 R4.
        ['js/header-menus.js', 13],
        // The touch global/action row module. Added at v=1 and pinned here like
        // every other production asset; bumped on each change since.
        // v8: W14 item 7 — SECONDARY drops the strip-owned newConnectionBtn.
        ['js/touch-action-row.js', 9],
    ]) {
        const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exactReference = new RegExp(
            `filename='${escapedAsset}'\\s*\\)\\s*\\}\\}\\?v=${version}(?=["'])`, 'g');
        check(`${asset} has exactly one production ?v=${version} reference`,
            (template.match(exactReference) || []).length, 1);
        const anyReference = new RegExp(
            `filename='${escapedAsset}'\\s*\\)\\s*\\}\\}\\?v=\\d+`, 'g');
        check(`${asset} has no stale or duplicate versioned reference`,
            (template.match(anyReference) || []).length, 1);
    }
}

const browser = await chromium.launch();

const STUBS = `
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop, io: { on: noop } };
    window.TerminalManager = {
        createTerminal: noop, disposeTerminal: noop, fitAllTerminals: noop,
        fitTerminal: noop, focusTerminal: noop, applyThemeToAll: noop,
        requestFit: noop, cancelPendingFit: noop,
        getTerminal: () => null, writeToTerminal: noop,
    };
`;

// -------------------------------------- SFTP mobile toolbar touch floor -----
{
    console.log('\n--- SFTP mobile toolbar touch floor ---');

    const viewports = [
        { width: 359, height: 800 },
        // 390x844 (iPhone 12/13/14/15) is the most common phone width in use;
        // 359 and 428 bracket it without ever testing it.
        { width: 390, height: 844 },
        { width: 428, height: 926 },
    ];
    const expectedIds = [
        'fmRefresh',
        'fmNewFolder',
        'fmTransfer',
        'fmDownload',
        'fmRename',
        'fmDelete',
    ];
    /*
     * ALL SIX are visible on a phone, #fmTransfer included (owner correction
     *, Entry 40).
     *
     * This list used to omit fmTransfer, matching a CSS rule that hid the
     * Transfer action in .fm-mobile-mode. That rule made the server-to-server
     * surface's entire purpose unreachable on the tier most likely to need it,
     * which is the defect Entry 40 corrects: transfer mode keeps single-pane
     * SIZING on phones but restores the Transfer action and the
     * Source/Destination switcher. The 44px floors below are unchanged and now
     * cover fmTransfer too.
     */
    const expectedVisibleIds = [
        'fmRefresh',
        'fmNewFolder',
        'fmTransfer',
        'fmDownload',
        'fmRename',
        'fmDelete',
    ];

    for (const viewport of viewports) {
        const ctx = await browser.newContext({
            viewport,
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: 3,
        });

        try {
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(String(e)));
            await page.addInitScript(STUBS);
            await page.goto(base, { waitUntil: 'load' });
            await page.addStyleTag({
                content: '*,*::before,*::after{animation:none!important;transition:none!important}',
            });

            /*
             * The dual-pane SERVER-TO-SERVER surface is what this section
             * measures. It is not legacy: it is what the global "File Transfer"
             * menu item opens (Entry 40), while
             * window.openFileManager() routes to the per-session inline
             * inspector (mockup line 182). Opened here through the production
             * entry point for this surface, so the toolbar being measured is the
             * one a user actually gets.
             */
            await page.evaluate(() => {
                window.openTransferSurface();      // constructs + opens the
                                                   // server-to-server surface
            });

            const modalCount = await page.locator('#sftpFileManager.show').count();
            const buttons = await page.evaluate(() =>
                Array.from(document.querySelectorAll('.fm-toolbar .btn'))
                    .map(button => {
                        const cs = getComputedStyle(button);
                        const rect = button.getBoundingClientRect();
                        return {
                            id: button.id,
                            display: cs.display,
                            minWidth: cs.minWidth,
                            minHeight: cs.minHeight,
                            width: rect.width,
                            height: rect.height,
                        };
                    }));

            const label = `${viewport.width}px`;
            check(`${label}: the real SFTP file manager opened`, modalCount, 1);
            check(`${label}: every real toolbar button exists`,
                buttons.map(button => button.id), expectedIds);
            check(`${label}: every toolbar button computes a 44px minimum width`,
                buttons.map(button => button.minWidth),
                expectedIds.map(() => '44px'));
            check(`${label}: every toolbar button computes a 44px minimum height`,
                buttons.map(button => button.minHeight),
                expectedIds.map(() => '44px'));

            /*
             * NOTHING in the toolbar is hidden on a phone any more (Entry 40).
             * Asserting the empty set is stricter than the old
             * `=== ['fmTransfer']`: it forbids every toolbar action from being
             * hidden, not just this one from being visible.
             */
            check(`${label}: no toolbar action is hidden on a phone`,
                buttons.filter(button => button.display === 'none')
                    .map(button => button.id), []);

            const visibleButtons = buttons.filter(button => button.display !== 'none');
            check(`${label}: the expected toolbar buttons are visible`,
                visibleButtons.map(button => button.id), expectedVisibleIds);
            check(`${label}: every visible toolbar button renders at least 44px wide`,
                visibleButtons.filter(button => button.width < 44)
                    .map(button => `${button.id}:${button.width}`), []);
            check(`${label}: every visible toolbar button renders at least 44px tall`,
                visibleButtons.filter(button => button.height < 44)
                    .map(button => `${button.id}:${button.height}`), []);
            check(`${label}: no page errors`, errors, []);
        } finally {
            await ctx.close();
        }
    }
}

// ----------------------------------- SFTP action sheet lifecycle -----
{
    console.log('\n--- SFTP mobile action sheet lifecycle ---');

    /*
     * On a phone .fm-context-menu is display:none, so #fmActionSheet is the only
     * route to download / rename / delete / new folder. close() tore down the
     * context menu and the drop targets but left the sheet's .visible class on,
     * so reopening the panel showed the sheet already up over a selection that
     * no longer existed.
     *
     * The sheet is position: fixed inside .modal-content, whose backdrop-filter
     * makes it the containing block, and it is stowed by a transform rather than
     * removed from the flow. So a display check cannot tell stowed from
     * presented: this measures how much of the sheet actually lands inside the
     * viewport, and reports the class alongside it.
     */
    const viewports = [
        { width: 359, height: 780 },
        // See the note above: 390 is the most common real phone width.
        { width: 390, height: 844 },
        { width: 428, height: 926 },
    ];
    const STOWED = 'visible=false stowed=true presented=false';

    for (const viewport of viewports) {
        const ctx = await browser.newContext({
            viewport,
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: 3,
        });

        try {
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(String(e)));
            await page.addInitScript(STUBS);
            await page.goto(base, { waitUntil: 'load' });
            await page.addStyleTag({
                content: '*,*::before,*::after{animation:none!important;transition:none!important}',
            });

            const steps = await page.evaluate(() => {
                const describe = () => {
                    const el = document.getElementById('fmActionSheet');
                    const rect = el.getBoundingClientRect();
                    const onScreen = Math.max(0,
                        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
                    return `visible=${el.classList.contains('visible')}`
                        + ` stowed=${onScreen <= 2}`
                        + ` presented=${onScreen >= 300}`;
                };

                // As above: the action sheet belongs to the legacy dual-pane
                // modal, so open THAT surface rather than the v5 inline
                // inspector the header button now opens.
                window.openFileManager();
                window.sftpFileManager.open();
                const opened = describe();

                window.sftpFileManager.showActionSheet();
                const shown = describe();

                window.sftpFileManager.close();
                const closed = describe();

                window.sftpFileManager.open();
                const reopened = describe();

                return { opened, shown, closed, reopened };
            });

            const label = `${viewport.width}px`;
            check(`${label}: a fresh panel starts with the sheet stowed`,
                steps.opened, STOWED);
            check(`${label}: showing the sheet presents it`,
                steps.shown, 'visible=true stowed=false presented=true');
            // The defect: close() left .visible on, so the state outlived the
            // panel. Asserted on the class, not on geometry -- a closed modal is
            // display:none, so every rect is 0 and geometry alone cannot see it.
            check(`${label}: closing the panel clears the sheet state`,
                steps.closed, STOWED);
            check(`${label}: reopening does not resurrect the sheet`,
                steps.reopened, STOWED);
            check(`${label}: no page errors`, errors, []);
        } finally {
            await ctx.close();
        }
    }
}

// ------------------------------------------------------- drag overlay -----
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(200);

    console.log('\n--- drag overlay, driven by a real dragover ---');

    /*
     * Count first. The defect the retired module caused was TWO full-window drag
     * overlays on a single drag, so the number present is itself the contract --
     * asserting only that "an overlay appeared" would have passed throughout the
     * period when two of them did.
     */
    const roots = '.drop-overlay, .drag-drop-overlay';
    check('exactly one full-window drag overlay exists',
        await page.locator(roots).count(), 1);
    check('and it is the canonical one',
        await page.locator('#dropOverlay').count(), 1);

    const resting = await page.evaluate(() =>
        document.getElementById('dropOverlay').classList.contains('hidden'));
    check('at rest it is hidden', resting, true);

    /*
     * A real DragEvent carrying a file. app.js reveals #dropOverlay from a
     * document-level dragover; dragenter is dispatched too so any handler keyed
     * on either event has had its chance to add a competing overlay.
     */
    const shown = await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
        for (const type of ['dragenter', 'dragover']) {
            document.dispatchEvent(new DragEvent(type, {
                dataTransfer: dt, bubbles: true, cancelable: true,
            }));
        }
        const el = document.getElementById('dropOverlay');
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const host = el.parentElement.getBoundingClientRect();
        return {
            overlayCount: document.querySelectorAll(
                '.drop-overlay, .drag-drop-overlay').length,
            hidden: el.classList.contains('hidden'),
            display: cs.display,
            covers: Math.round(r.width) === Math.round(host.width)
                && Math.round(r.height) === Math.round(host.height),
            title: el.querySelector('.drop-title')?.textContent.trim(),
        };
    });

    check('a real drag still produces exactly one overlay', shown.overlayCount, 1);
    check('a file dragged in reveals it', shown.hidden, false);
    check('it is laid out when revealed', shown.display, 'flex');
    check('it covers its host container', shown.covers, true);
    check('it states its purpose', shown.title, 'Drop file to upload');

    check('no page errors', errors, []);
    await ctx.close();
}

// ---------------------------------------------------- upload progress -----
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(200);

    console.log('\n--- upload progress toast, driven through showUploadProgress ---');

    const built = await page.evaluate(() => {
        const fm = new SFTPFileManager();
        window.__fm = fm;
        fm.currentUploadBatch = { completed: 3, total: 8 };
        fm.showUploadProgress();
        const el = document.querySelector('.upload-progress-notification');
        if (!el) return { missing: true };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const bar = document.querySelector('.upload-progress-bar');
        const fill = document.querySelector('.upload-progress-fill');
        const stats = document.querySelector('.upload-progress-stats');
        return {
            radius: cs.borderTopLeftRadius,
            padding: cs.padding,
            zIndex: cs.zIndex,
            top: Math.round(r.top),
            rightGap: Math.round(window.innerWidth - r.right),
            minWidth: cs.minWidth,
            barHeight: Math.round(bar.getBoundingClientRect().height),
            fillRatio: Math.round(
                fill.getBoundingClientRect().width
                / bar.getBoundingClientRect().width * 100),
            tabular: getComputedStyle(stats).fontVariantNumeric,
            count: document.querySelector('.upload-progress-count').textContent,
            percent: document.querySelector('.upload-progress-percent').textContent,
        };
    });

    check('the toast was built', built.missing !== true, true);
    // Tokens, resolved: --radius-lg is 8px and --sp-16 is 16px. Reading the
    // computed value rather than the declaration proves the token resolves.
    check('radius resolves to --radius-lg (8px)', built.radius, '8px');
    check('padding resolves to --sp-16 (16px)', built.padding, '16px');
    // It used to sit at top 80 / right 20 while .notification-container sits at
    // 24/24, so the two toast stacks were misaligned at both edges.
    check('it shares the toast corner (top)', built.top, 24);
    check('it shares the toast corner (right)', built.rightGap, 24);
    check('it sits in the toast tier', built.zIndex, '11000');
    check('it keeps its 300px floor', built.minWidth, '300px');
    check('the bar keeps its 6px height', built.barHeight, 6);
    check('the fill reflects 3 of 8', built.fillRatio, 38);
    check('ticking digits do not shift width', built.tabular, 'tabular-nums');
    check('the count is rendered', built.count, '3 / 8');
    check('the percentage is rendered', built.percent, '38%');

    // Update path: same element, new numbers.
    const updated = await page.evaluate(() => {
        window.__fm.currentUploadBatch = { completed: 8, total: 8 };
        window.__fm.showUploadProgress();
        return {
            toasts: document.querySelectorAll('.upload-progress-notification').length,
            count: document.querySelector('.upload-progress-count').textContent,
            percent: document.querySelector('.upload-progress-percent').textContent,
        };
    });
    check('a second call updates rather than stacking', updated.toasts, 1);
    check('the count updated', updated.count, '8 / 8');
    check('the percentage updated', updated.percent, '100%');

    /*
     * The success state, across every theme. This is the assertion the piece
     * exists for: the background read a property that nothing declares, so the
     * fallback -- one hardcoded green -- was what all ten themes rendered.
     */
    console.log('\n--- the success state follows the theme ---');
    const css = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');
    const THEMES = ['glass', ...[...css.matchAll(/body\[data-theme="([a-z-]+)"\]\s*\{/g)]
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i)];

    const backgrounds = [];
    const borders = [];
    for (const theme of THEMES) {
        const m = await page.evaluate(t => {
            document.body.setAttribute('data-theme', t);
            const el = document.querySelector('.upload-progress-notification');
            el.classList.add('success');
            const cs = getComputedStyle(el);
            return { bg: cs.backgroundColor, border: cs.borderTopColor };
        }, theme);
        backgrounds.push(m.bg);
        borders.push(m.border);
    }

    check(`measured across ${THEMES.length} themes`, THEMES.length >= 10, true);
    // 9 not 10: noir and arctic-ice declare the same --success-color, so they
    // legitimately share the derived background.
    check('the success background differs per theme',
        new Set(backgrounds).size >= 9, true);
    check('the success border differs per theme',
        new Set(borders).size >= 9, true);
    check('every theme resolves to a real colour',
        backgrounds.every(b => b && b !== 'rgba(0, 0, 0, 0)'), true);

    check('no page errors', errors, []);
    await ctx.close();
}

// ------------------------------------------------- keyframes are shared -----
{
    console.log('\n--- no duplicate keyframes came along ---');
    const css = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');
    const sftp = fs.readFileSync(path.join(ROOT, 'static/js/sftp-file-manager.js'), 'utf8');

    for (const name of ['slideInRight', 'slideOutRight']) {
        check(`${name} was not carried into the stylesheet`,
            css.includes(`@keyframes ${name}`), false);
        check(`${name} is gone from sftp-file-manager.js`,
            sftp.includes(name), false);
    }
    // The animation still has to run, under the name that already existed.
    check('the toast slides out under the shared name',
        sftp.includes('notificationSlideOut'), true);
    /*
     * bounce was the one keyframe that was genuinely new, and it was private to
     * the retired overlay's icon. With that overlay gone the keyframe has no
     * user, so a declaration here would be dead weight -- and any rule still
     * naming it would be animating nothing. Both are asserted absent above; this
     * records the inversion so the earlier "is declared" contract is not simply
     * dropped.
     */
    check('bounce did not outlive the overlay it was written for',
        css.includes('@keyframes bounce'), false);
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
