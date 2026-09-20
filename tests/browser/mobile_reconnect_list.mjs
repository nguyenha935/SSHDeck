/*
 * What happens when several persistent tmux sessions come back at once.
 *
 * The reported symptom on a phone: "it shows the existing connections but only
 * for a couple of seconds, then it goes straight into a session -- if you don't
 * pick fast you can't pick at all."
 *
 * These tests drive the REAL static/js/session-manager.js. They do not restate
 * its logic: they feed it the same socket payloads the server sends from
 * restore_user_sessions() and then read the resulting DOM. That matters, because
 * the interesting part is an interaction between three functions, and a test that
 * reimplemented any of them would agree with itself and prove nothing.
 *
 * The server does NOT send two competing events for one session:
 * ssh_session_restored covers connected=True rows; persistent_session_available
 * covers is_persistent=True, connected=False. They are disjoint sets.
 *
 * Candidates no longer take pane assignments. The remaining edge case is where
 * their list is painted: falling back to pane zero when no pane is empty clears
 * the live terminal DOM while paneAssignments still says that session owns it.
 * This test covers both sides of the contract: an occupied pane is never touched,
 * while an empty phone pane still shows every candidate in one vertical list.
 *
 * Run: node tests/browser/mobile_reconnect_list.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function startServer() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const fp = path.join(sourceRoot, rel);
        if (!fp.startsWith(sourceRoot) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

let passed = 0;
let failed = 0;

function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}`
            + `\n      want ${JSON.stringify(want)}`);
    }
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// A phone. layout=1 is what the app picks here, and one pane is the whole point.
const context = await browser.newContext({
    viewport: { width: 428, height: 926 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

// Only the containers session-manager.js writes into, plus inert stubs for the
// collaborators it calls. Nothing here reimplements the behaviour under test.
// The real stylesheet, and a grid with a real height. Both matter: the list is
// judged on measured geometry (scrollability, row heights, no overlap), and an
// unstyled zero-height container would report every number as 0 and pass.
await page.setContent(`<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="${base}/static/css/style.css">
    <style>
        /* Stand in for main.main-content, which this harness does not build:
           the grid needs a bounded height for max-height/overflow to mean
           anything. Layout inside the pane is the stylesheet's own. */
        #terminalGrid { height: 700px; }
    </style>
</head><body>
    <div id="sessionBar" class="hidden"><div class="session-tabs-row">
        <div id="sessionTabs" class="session-tabs"></div>
        <!-- P2: the lifecycle toolbar, mirroring templates/index.html. Slice B
             needs the real #sessionActionReconnect control, because accepting an
             offer is now an explicit control press rather than a chip tap. -->
        <div id="sessionActionsControl" class="session-actions-control">
            <button id="sessionActionsBtn" type="button"
                    aria-expanded="false" aria-label="Session actions"></button>
            <!-- The sheet itself. Absent from this fixture until the one-tap
                 select-and-open contract (defect 7 replacement route) needed it:
                 openLifecycleSheet correctly does nothing without a sheet, so its
                 absence read as a product failure. Mirrors templates/index.html. -->
            <div id="sessionActionsSheet" class="session-actions-sheet" hidden inert
                 aria-hidden="true" role="menu">
                <div id="sessionActionsHeading" class="session-actions-heading"></div>
                <div id="sessionActionsToolbar" class="session-actions-toolbar" role="group"
                     aria-label="Session actions">
                    <button id="sessionActionRename" class="session-action-btn" type="button"
                            data-lifecycle-action="rename" aria-label="Rename session" disabled></button>
                    <button id="sessionActionReconnect" class="session-action-btn" type="button"
                            data-lifecycle-action="reconnect" aria-label="Reconnect" disabled></button>
                    <button id="sessionActionReset" class="session-action-btn" type="button"
                            data-lifecycle-action="reset" aria-label="Reset (fresh, no tmux)" disabled></button>
                    <button id="sessionActionClose" class="session-action-btn" type="button"
                            data-lifecycle-action="close" aria-label="Close connection" disabled></button>
                </div>
            </div>
        </div>
    </div></div>
    <div id="terminalsContainer"></div>
    <div id="terminalGrid"></div>
</body></html>`, { waitUntil: 'load' });

const cssApplied = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--touch-target-min').trim());
if (cssApplied !== '44px') {
    console.error(`FATAL: style.css did not apply (--touch-target-min="${cssApplied}"); `
        + 'every geometry check below would be measuring an unstyled page');
    process.exit(1);
}

await page.evaluate(() => {
    const noop = () => {};
    // A socket that records emits and lets the test deliver server events.
    // Registered per-event into ONE registry shared by every script: app.js's
    // early sole owner (ssh_session_restored / ssh_replay_chunk) and
    // session-manager.js's own listeners all push into handlers[name].
    const handlers = {};
    window.__emitted = [];
    window.socket = {
        on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
        emit: (name, data) => window.__emitted.push({ name, data }),
        // app.js registers socket.io.on('reconnect_attempt', ...) at load time.
        // The real Socket.IO client exposes the Manager as socket.io; the stub
        // must match that shape so the registration does not throw a pageerror.
        io: { on: noop },
    };
    // app.js's first real statement is window.socket = io(...): io must exist
    // BEFORE app.js loads or it throws. (IO is not the real socket.io client
    // here — the events under test are scripted from this harness either way.)
    window.io = () => window.socket;
    window.__deliver = (name, data) => {
        const list = handlers[name];
        if (!list || list.length === 0) throw new Error(`no handler for ${name}`);
        // Fan-out to every registered owner. Production has exactly one
        // ssh_session_restored owner (app.js); a second registration by
        // SessionManager.init would be visible here as two tabs.
        list.forEach(fn => fn(data));
    };
    window.__handlerCount = (name) => (handlers[name] || []).length;
    window.TerminalManager = {
        isMobile: () => true,
        isTouchShell: () => true,
        terminals: {}, sessionTerminals: {}, terminalContainers: {},
        createTerminal: noop,
        attachTerminal: noop,
        setupInputHandler: noop,
        destroyTerminal: noop,
        fitTerminal: noop, requestFit: noop, cancelPendingFit: noop,
        writeOutput: noop,
        focusTerminal: noop,
        acceptReplayChunk: noop,
        // S16/S5 taught restoreSession to learn the server's replay line cap
        // BEFORE createSession builds the terminal, and S17 FIX 6 added the
        // interaction declaration to the pane-activation path. Both are called
        // unconditionally on the restore route this suite drives, so a stub
        // missing either throws a TypeError inside page.evaluate and the whole
        // file dies before its first reconnect assertion. Stubs only -- this
        // suite is about the reconnect LIST, and the two behaviours are pinned
        // where they belong (tests/browser/s16_d4_scrollback_restore.mjs and
        // tests/browser/s16_d3_visible_authority.mjs §I).
        noteServerReplayLines: noop,
        // S16 F1-c added the same kind of unconditional pre-createSession
        // ingestion for the snapshot's DECLARED tmux mouse policy, for the
        // same reason: the gate must be armed before the session's first frame
        // can reach the engine. Stub only -- the policy behaviour is pinned in
        // tests/browser/f1c_mouse_policy_reassert.mjs.
        noteTmuxMousePolicy: noop,
        reportInteraction: noop,
        reportVisibility: noop,
    };
    window.ProfileManager = {
        createEmptyPaneContent: () => {
            const d = document.createElement('div');
            d.className = 'pane-empty-stub';
            return d;
        },
    };
    window.i18n = { t: key => key };
    window.showNotification = noop;
    window.clearConnectionProfileState = noop;
    // app.js binds DOM listeners and a DOMContentLoaded handler; it is loaded
    // after 'load', so DOMContentLoaded never fires — only its SYNCHRONOUS
    // top-level registrations (window.socket + the early restore/replay sole
    // owners + composer handlers) matter here. Those have no other deps beyond
    // io/showNotification stubs above.
});

/*
 * P1 D1: ssh_session_restored / ssh_replay_chunk are owned by
 * app.js's EARLY sole owners, registered at app.js load time — BEFORE
 * SessionManager.init() can possibly run. This harness loads the REAL app.js
 * first (production load order: app.js before... nothing; app.js precedes
 * header-menus.js and SessionManager.init is driven from app.js's own
 * DOMContentLoaded). Here the harness calls SessionManager.init() explicitly,
 * exactly as app.js does, so the production ownership is exercised end to end:
 * delivering ssh_session_restored through __deliver hits app.js's owner, which
 * either dispatches (initialized) or buffers into __earlyRestoreFrames for the
 * init() drain. session-manager.js itself no longer registers these two events
 * — double registration was the defect D1 removed.
 */
await page.addScriptTag({ url: `${base}/static/js/app.js` });
// app.js overwrites window.showNotification with the production toast that
// needs #notificationContainer. This harness has no toast host, so put the
// noop back: the early sole owners (the only app.js surface under test) do
// not depend on it, and every later production path that would toast stays
// silent rather than throwing.
await page.evaluate(() => { window.showNotification = () => {}; });
await page.addScriptTag({ url: `${base}/static/js/session-manager.js` });

check('harness loaded the real app.js (early sole owner present)',
    await page.evaluate(() => Array.isArray(window.__earlyRestoreFrames)
        && Array.isArray(window.__earlyReplayChunks)), true);
check('harness loaded the real session-manager.js',
    await page.evaluate(() => typeof SessionManager === 'object'), true);
// The D1 ownership contract itself: only ONE handler per event may exist, and
// it must be app.js's — a second registration by SessionManager would
// double-dispatch every frame.
await page.evaluate(() => SessionManager.init());

check('ssh_session_restored has exactly one owner (app.js, not duplicated)',
    await page.evaluate(() => {
        // The early-buffer path (pre-init) is exercised by the load-order
        // itself: app.js registered before SessionManager.init flipped
        // initialized, so any frame that arrived in that window would have
        // been buffered. After init, the dispatch path is live. A second
        // owner registered by SessionManager.init would increment the
        // handler count to 2; that is the D1 defect this check exists to
        // catch. (The leftover-session FAIL from an earlier draft of this
        // check is why we do not restore-then-remove a sentinel here.)
        return window.__handlerCount('ssh_session_restored');
    }), 1);

check('a phone starts on the single-pane layout',
    await page.evaluate(() => SessionManager.layout), 1);

// A connected session restored into the only pane must survive a later candidate.
// Candidates are offers, not terminals, so they may be retained in sessions and
// in the tab strip but must never replace or clear live pane content.
check('a candidate cannot clear occupied pane zero',
    await page.evaluate(() => {
        window.__deliver('ssh_session_restored', {
            session_id: 'live-0',
            host: 'live-host',
            port: 22,
            username: 'ha',
            auth_type: 'key',
            display_name: 'Live session',
            buffered_output: '',
        });

        const wrapper = document.getElementById('terminal-live-0');
        const marker = document.createElement('span');
        marker.dataset.liveTerminalMarker = 'true';
        wrapper.appendChild(marker);

        window.__deliver('persistent_session_available', {
            session_id: 'occupied-offer',
            host: 'waiting-host',
            port: 22,
            username: 'ha',
            key_id: 7,
            auth_type: 'key',
            tmux_session_name: 'sshdeck_waiting',
            display_name: 'Waiting session',
        });

        const pane = document.querySelector(
            '.terminal-pane[data-pane-index="0"]');
        return {
            assignment: SessionManager.paneAssignments[0],
            wrapperInPane: wrapper.parentElement === pane,
            markerPreserved: Boolean(
                pane.querySelector('[data-live-terminal-marker]')),
            offerKnown: Boolean(SessionManager.sessions['occupied-offer']),
            offerTabPresent: Boolean(document.getElementById('tab-occupied-offer')),
            listInOccupiedPane: Boolean(pane.querySelector('[data-reconnect-list]')),
        };
    }), {
        assignment: 'live-0',
        wrapperInPane: true,
        markerPreserved: true,
        offerKnown: true,
        offerTabPresent: true,
        listInOccupiedPane: false,
    });

//: the live session placed on load reports its pane
// (session_pane_index); the property under test is that no CONNECT is sent.
check('occupied-pane candidate arrival does not reconnect automatically',
    await page.evaluate(() => window.__emitted.map(event => event.name)
        .filter(name => name !== 'session_pane_index')), []);

// --- Slice B: an occupied phone must still make a red tab actionable -------
//
// With every pane busy, the reconnect list cannot render (renderReconnectList
// returns silently when no pane is empty), so the row the tap used to target
// does not exist. The tab itself is the remaining touch target -- but P2
// split selection from acceptance: tapping a disconnected or
// candidate chip is selection-only. It sets lifecycleActionTargetId and nothing
// else: no ssh_connect, no prefilled form, no pane change, no focus. The
// explicit acceptance path is the direct Reconnect control in the session tier,
// which routes lifecycleActionTargetId through requestReconnect -- key and
// Tailscale candidates reconnect directly, password candidates open the form.
// Neither the tap nor the control touches paneAssignments, so the live session
// in pane zero must survive both exactly as it survives the candidate's arrival.
check('tapping a disconnected tab selects it without accepting the offer',
    await page.evaluate(() => {
        const before = {
            assignment: SessionManager.paneAssignments[0],
            marker: Boolean(document.querySelector(
                '[data-live-terminal-marker]')),
            active: SessionManager.activeSessionId,
        };
        window.__emitted.length = 0;
        const prefills = [];
        const original = SessionManager.prefillConnectionForm;
        SessionManager.prefillConnectionForm = function (...args) {
            prefills.push(args);
        };
        document.getElementById('tab-occupied-offer').click();
        SessionManager.prefillConnectionForm = original;
        return {
            before,
            emits: window.__emitted.map(e => e.name),
            prefillCalls: prefills.length,
            after: {
                // Selection-only: the offer is still on file and still painted.
                target: SessionManager.lifecycleActionTargetId,
                offerStillKnown: Boolean(SessionManager.sessions['occupied-offer']),
                offerTabStillThere: Boolean(
                    document.getElementById('tab-occupied-offer')),
                targetClass: document.getElementById('tab-occupied-offer')
                    .classList.contains('lifecycle-target'),
                assignment: SessionManager.paneAssignments[0],
                marker: Boolean(document.querySelector(
                    '[data-live-terminal-marker]')),
                active: SessionManager.activeSessionId,
                // A pure selection must not focus anything.
                activeElement: document.activeElement === document.body
                    ? 'body' : document.activeElement.id,
            },
        };
    }), {
        before: { assignment: 'live-0', marker: true, active: 'live-0' },
        emits: [],
        prefillCalls: 0,
        after: { target: 'occupied-offer', offerStillKnown: true,
            offerTabStillThere: true, targetClass: true,
            assignment: 'live-0', marker: true, active: 'live-0',
            activeElement: 'body' },
    });

// The explicit acceptance: with that same key candidate selected, the direct
// Reconnect control performs the reconnect the tap deliberately withheld.
//
// The OFFER SURVIVES the emit, and that is the fix, not a regression. The chip
// used to be removed at emit time (removeSessionUI before the frame went out),
// which is Reset's shape: a connect that then failed left the user with nothing
// to retry from and the transcript handoff with no source. It is now retired by
// completePendingReconnect, once the reply for THIS client_request_id arrives --
// which is asserted immediately below.
check('the direct Reconnect control accepts a key offer with all panes busy',
    await page.evaluate(() => {
        window.__emitted.length = 0;
        const btn = document.getElementById('sessionActionReconnect');
        const preconditions = {
            target: SessionManager.lifecycleActionTargetId,
            controlEnabled: !btn.disabled,
        };
        btn.click();
        return {
            preconditions,
            emits: window.__emitted.map(e => ({
                name: e.name,
                host: e.data && e.data.host,
                tmux: e.data && e.data.reconnect_tmux_name,
            })),
            after: {
                assignment: SessionManager.paneAssignments[0],
                marker: Boolean(document.querySelector(
                    '[data-live-terminal-marker]')),
                active: SessionManager.activeSessionId,
                offerGone: !SessionManager.sessions['occupied-offer'],
                offerTabGone: !document.getElementById('tab-occupied-offer'),
                disconnected: window.__emitted.some(
                    e => e.name === 'ssh_disconnect'),
            },
        };
    }), {
        preconditions: { target: 'occupied-offer', controlEnabled: true },
        emits: [{ name: 'ssh_connect', host: 'waiting-host',
            tmux: 'sshdeck_waiting' }],
        after: { assignment: 'live-0', marker: true, active: 'live-0',
            offerGone: false, offerTabGone: false, disconnected: false },
    });

// ...and it is retired only when its OWN reply lands, correlated by the
// client_request_id the frame carried. Nothing else may retire it.
check('the accepted offer is retired by its own ssh_connected, not by the emit',
    await page.evaluate(() => {
        const frame = window.__emitted.find(e => e.name === 'ssh_connect'
            && e.data && e.data.reconnect_tmux_name === 'sshdeck_waiting');
        const rid = frame && frame.data.client_request_id;
        const before = {
            offerStillKnown: !!SessionManager.sessions['occupied-offer'],
            hasRequestId: typeof rid === 'string' && rid.length > 0,
        };
        // This harness loads session-manager.js ONLY, so there is no app.js
        // ssh_connected handler to deliver to. The retirement itself lives in
        // SessionManager.completePendingReconnect, which that handler calls with
        // exactly these two arguments -- so this drives the real production
        // function, with the real request id, rather than a copy of its body.
        SessionManager.createSession({
            session_id: 'accepted-new', host: 'waiting-host', port: 22,
            username: 'ha', auth_type: 'key', use_tmux: true,
            tmux_session_name: 'sshdeck_waiting', key_id: 7,
            display_name: 'Waiting session',
        }, null);
        SessionManager.completePendingReconnect('accepted-new', rid);
        const out = {
            before,
            offerGone: !SessionManager.sessions['occupied-offer'],
            offerTabGone: !document.getElementById('tab-occupied-offer'),
            newSessionExists: !!SessionManager.sessions['accepted-new'],
            disconnected: window.__emitted.some(e => e.name === 'ssh_disconnect'),
        };
        SessionManager.removeSessionUI('accepted-new');
        window.__emitted.length = 0;
        return out;
    }), {
        before: { offerStillKnown: true, hasRequestId: true },
        offerGone: true, offerTabGone: true, newSessionExists: true,
        disconnected: false,
    });

// A password candidate cannot reconnect without credentials, so accepting it
// must open the prefilled connection form instead -- again without touching any
// pane, and again only from the explicit control, never from the tap.
// prefillConnectionForm is spied (it needs modal DOM this harness lacks), then
// restored so the real method is back for every later suite section.
check('the direct Reconnect control prefills the form for a password offer',
    await page.evaluate(() => {
        window.__deliver('persistent_session_available', {
            session_id: 'pw-offer',
            host: 'pw-host',
            port: 22,
            username: 'ha',
            key_id: null,
            auth_type: 'password',
            tmux_session_name: 'sshdeck_pw',
            display_name: 'PW session',
        });
        const calls = [];
        const original = SessionManager.prefillConnectionForm;
        SessionManager.prefillConnectionForm = function (...args) {
            calls.push(args);
        };
        window.__emitted.length = 0;

        // Selecting it must still not prefill or emit anything.
        document.getElementById('tab-pw-offer').click();
        const onTap = {
            prefillCalls: calls.length,
            emits: window.__emitted.length,
            target: SessionManager.lifecycleActionTargetId,
        };

        // Only the explicit control accepts.
        document.getElementById('sessionActionReconnect').click();
        SessionManager.prefillConnectionForm = original;
        const result = {
            onTap,
            prefillCalls: calls.length,
            prefillId: calls[0] && calls[0][0],
            emits: window.__emitted.map(e => e.name),
            assignment: SessionManager.paneAssignments[0],
            marker: Boolean(document.querySelector(
                '[data-live-terminal-marker]')),
        };
        SessionManager.removeSessionUI('pw-offer');
        window.__emitted.length = 0;
        return result;
    }), {
        onTap: { prefillCalls: 0, emits: 0, target: 'pw-offer' },
        prefillCalls: 1,
        prefillId: 'pw-offer',
        emits: [],
        assignment: 'live-0',
        marker: true,
    });

// Return to the empty single-pane starting state for the existing multi-candidate
// contract below. These are synthetic test sessions; removeSessionUI drives the
// real cleanup path rather than replacing manager or DOM state by hand.
// 'occupied-offer' is already gone -- the accepted reconnect removed it.
await page.evaluate(() => {
    SessionManager.removeSessionUI('live-0');
    window.__emitted.length = 0;
});

// Three persistent tmux sessions come back, exactly as restore_user_sessions()
// sends them: one event each, in a row, no gap.
const CANDIDATES = [
    { session_id: 's1', host: 'alpha', port: 22, username: 'ha', key_id: 7,
        auth_type: 'key', tmux_session_name: 'sshdeck_alpha', display_name: 'Alpha' },
    { session_id: 's2', host: 'beta', port: 22, username: 'ha', key_id: 7,
        auth_type: 'key', tmux_session_name: 'sshdeck_beta', display_name: 'Beta' },
    { session_id: 's3', host: 'gamma', port: 22, username: 'ha', key_id: null,
        auth_type: 'password', tmux_session_name: 'sshdeck_gamma', display_name: 'Gamma' },
];

await page.evaluate(list => {
    list.forEach(data => window.__deliver('persistent_session_available', data));
}, CANDIDATES);

// --- what the user can actually see and choose from -----------------------

check('all three candidates are known to the app',
    await page.evaluate(() => Object.keys(SessionManager.sessions).sort()),
    ['s1', 's2', 's3']);

// The core of the complaint, stated the right way round. Candidates must not
// compete for the pane at all: a candidate has no terminal to show yet, so
// taking a pane for one is what evicted the previous one. So the assertion is
// that NO candidate holds a pane -- and the list check below is what proves all
// three are still reachable.
//
// (An earlier version of this test asserted the opposite -- that no candidate is
// .unassigned -- which quietly demanded the very behaviour that causes the bug,
// and could only ever pass for one candidate out of three.)
check('no candidate takes a pane, so none can evict another',
    await page.evaluate(() => SessionManager.paneAssignments.filter(Boolean)), []);

/*
 * REPLACED SURFACE (owner ruling, defect 7).
 *
 * The overview list this file was written against is gone: the session bar is
 * already the connection list, so a second titled list of the same connections
 * was redundant -- it appeared after a restart and mostly vanished after any chip
 * click. The user-facing GUARANTEES it protected are unchanged and are what these
 * assertions now measure, through the surface that replaced it:
 *
 *   "every candidate is offered"        -> every candidate has a chip
 *   "a readable vertical list"          -> the chip strip scrolls, no overlap
 *   "tapping one reconnects only it"    -> its one-tap action menu Reconnect does
 *   "the others survive"                -> the remaining chips persist
 *
 * The overview must also be genuinely absent, so its removal cannot silently
 * regress back into existence.
 */
check('the redundant reconnect overview screen is absent',
    await page.evaluate(() => ({
        lists: document.querySelectorAll('[data-reconnect-list]').length,
        rows: document.querySelectorAll('[data-reconnect-row]').length,
    })),
    { lists: 0, rows: 0 });

check('every candidate is offered as a chip in the session bar',
    await page.evaluate(() => Array.from(
        document.querySelectorAll('#sessionTabs .session-tab'))
        .map(el => el.id.replace(/^tab-/, ''))
        .filter(id => ['s1', 's2', 's3'].includes(id)).sort()),
    ['s1', 's2', 's3']);

// Nothing may connect on its own. The user picks.
check('no reconnect was sent to the server without the user choosing',
    await page.evaluate(() => window.__emitted.map(e => e.name)),
    []);

// Same readability guarantee, now owned by the chip strip: the candidates are
// laid out in a real scroller with no chip stacked on top of another. The strip
// scrolls horizontally (touch-action:pan-x), which is its approved v5 axis.
check('the chip strip scrolls instead of stacking overlays',
    await page.evaluate(() => {
        const strip = document.getElementById('sessionTabs');
        if (!strip) return 'no #sessionTabs';
        const cs = getComputedStyle(strip);
        const chips = Array.from(strip.querySelectorAll('.session-tab'));
        const overlapping = chips.some((chip, i) => {
            if (i === 0) return false;
            const prev = chips[i - 1].getBoundingClientRect();
            const here = chip.getBoundingClientRect();
            return here.left < prev.right - 1 && here.top < prev.bottom - 1;
        });
        return {
            positioned: chips.every(c =>
                getComputedStyle(c).position !== 'absolute'),
            scrollable: ['auto', 'scroll'].includes(cs.overflowX),
            overlapping,
        };
    }),
    { positioned: true, scrollable: true, overlapping: false });

// Touch targets in the list. 44px is the project's existing contract.
check('every candidate chip meets the 44px touch target',
    await page.evaluate(() => Array.from(
        document.querySelectorAll('#sessionTabs .session-tab'))
        .filter(c => c.getBoundingClientRect().height < 44).length), 0);

// --- choosing one, and only then connecting ------------------------------

// Exactly one connect, and it must be for the row that was tapped.
//
// Identified by host + tmux name, not by session_id: a reconnect deliberately
// does not carry the old id. The server matches on the tmux session name to
// re-attach, and it issues a fresh session_id for the new connection. Asserting
// on an id the protocol never sends would fail forever for the wrong reason.
/*
 * Same guarantee through the replacement route: one tap on the chip selects it
 * AND opens its action menu (defect 5), and Reconnect there connects exactly that
 * session. Identified by host + tmux name rather than session_id, for the reason
 * documented above: a reconnect deliberately does not carry the old id -- the
 * server re-attaches by tmux name and issues a fresh one.
 */
check('one tap on a candidate chip opens its action menu',
    await page.evaluate(() => {
        document.getElementById('tab-s2').click();
        return {
            target: SessionManager.lifecycleActionTargetId,
            sheetOpen: document.getElementById('sessionActionsSheet')?.hidden === false,
            emitted: window.__emitted.length,
        };
    }),
    { target: 's2', sheetOpen: true, emitted: 0 });

check('Reconnect in that menu reconnects that session and no other',
    await page.evaluate(() => {
        SessionManager.dispatchLifecycleAction('reconnect');
        return window.__emitted.map(e => ({
            name: e.name,
            host: e.data && e.data.host,
            tmux: e.data && e.data.reconnect_tmux_name,
        }));
    }),
    [{ name: 'ssh_connect', host: 'beta', tmux: 'sshdeck_beta' }]);

// Picking one must not silently drop the others: alpha and gamma still have their
// chips after beta is taken.
check('the other candidates survive picking one',
    await page.evaluate(() => Array.from(
        document.querySelectorAll('#sessionTabs .session-tab'))
        .map(el => el.id.replace(/^tab-/, ''))
        .filter(id => ['s1', 's3'].includes(id)).sort()),
    ['s1', 's3']);

check('no page errors throughout', pageErrors, []);

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
