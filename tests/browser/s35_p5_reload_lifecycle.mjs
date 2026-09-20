/*
 * S35 P5 — RELOAD / ROUTE-RETURN LIFECYCLE: the session the user was working
 * in must come back assigned, visible and scrollable.
 *
 * WHAT THE OWNER REPORTED, AND WHAT J1 MEASURED ON PRODUCTION
 * ----------------------------------------------------------------------------
 * Owner bullet 1: "Desktop terminal history must remain touch/wheel scrollable
 * after navigating to another page and back, after reload, and for every SSH
 * connection." Owner bullet 5: "Connect #2 and #3 must behave like #1
 * immediately, without switching away and back."
 *
 * /tmp/s35d/j1_run2.log measured the mechanism on the live product, on SIX of
 * six arrivals (3x Terminal -> /change-password -> Back, 3x reload). The user
 * had been working in connect #1 (9a222db8). On every arrival:
 *
 *     [desktop r1] ON ARRIVAL     wrapperClass "terminal-wrapper unassigned"
 *                                 visible false   rect 0x0   cell 0x0
 *                                 cols 80  rows 24   layers 66
 *                                 centreHits ["body","html"]
 *                                 appActiveSessionId  6041ad28  (connect #3)
 *                                 appPaneAssignments  [6041ad28]
 *     [desktop r1] after switch   visible true    cols 164 rows 40
 *                                 cell 8.439x16   layers 98
 *
 * So nothing was "frozen" and no overlay covered anything: the app simply had
 * the WRONG session in the pane. #1 was parked in #terminalsContainer under
 * `.unassigned` (display:none), which is why its rect was 0x0, why its char
 * cell was 0x0 (xterm 5.3.0 measures the cell once inside open(), and in a
 * display:none subtree that measurement is 0 with no retry), and why it was
 * still at its constructed 80x24 (fitTerminal skips an invisible terminal by
 * isTerminalVisible, terminal-manager.js:4672). elementsFromPoint at a 0x0
 * rect's centre lands on body/html -- an artefact of the empty rect, not a
 * cover. A wheel over a display:none element cannot scroll anything.
 *
 * THE CAUSE, READ FROM THE SOURCE
 * ----------------------------------------------------------------------------
 * A cross-document return re-runs the whole restore loop: templates/index.html
 * :209 <a href="/admin"> and app.js's location.href are real navigations, so
 * the page is built again from the server. (Until a beforeunload
 * listener also kept Chromium out of BFCache, which made even Back a full
 * reload; that listener is gone, so Back can now be a bfcache restore --
 * owner_batch_bfcache_lifecycle.mjs covers that path. This suite measures the
 * cross-document rebuild either way.) socket_events.restore_user_sessions:535
 * then emits one ssh_session_restored per connected row, in DB order, with no
 * ORDER BY.
 *
 * For each frame restoreSession (session-manager.js:178) picks a pane:
 *     pane_index if free   ->   first EMPTY pane   ->   activePaneIndex
 * `pane_index` is dead: it is read at socket_events.py:385/637 and consumed at
 * session-manager.js:276, but NOTHING in the Python ever assigns it (measured
 * on the live DB: 0 of 326 rows carry a non-null pane_index). So on the single
 * pane the desktop was using, restore #1 takes the empty pane 0, and restore #2
 * finds NO empty pane, falls back to activePaneIndex 0, and
 * assignSessionToPane:3957 EVICTS the current occupant -- adds `unassigned`,
 * re-parents it to #terminalsContainer -- then restore #3 evicts #2 the same
 * way. The last row the database happened to return owns the pane, and the
 * session the user was actually in is parked and dead.
 *
 * Two independent defects, and this suite pins both:
 *   D1  A RESTORE MUST NOT EVICT. Assignment already knows a restore is not
 *       interaction (declareInteraction:false, :3985) but still performs the
 *       strongest act of all -- taking an occupied pane away from another
 *       session. Nothing about rebuilding panes from a snapshot justifies that.
 *   D2  THE SELECTION IS NOT REMEMBERED. Which session the user was working in
 *       is workspace state exactly like the split layout (saveLayoutPreference,
 *       :3701) and nothing persists it, so even without D1 the arrival would
 *       select whichever session was restored first rather than the one the
 *       user left.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ----------------------------------------------------------------------------
 * No CSS declaration, no z-index, no overlay claim: J1 measured the centre
 * stack as body/html only because the rect was empty, so an "overlay" assertion
 * would pin an artefact. The scroll rows below therefore assert the two things
 * that were really broken -- the wrapper is laid out, and the wheel moves the
 * ENGINE while every ancestor stays at scroll 0 -- plus that the transport is
 * still live afterwards, which is the half a geometry-only check cannot see.
 *
 * Run: node tests/browser/s35_p5_reload_lifecycle.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/*
 * Arrival screenshots land OUTSIDE the repository tree (AGENTS.md: probes go
 * under /tmp and never become a tracked artefact). S35_P5_SHOTS overrides the
 * directory; set it to an empty string to skip rendering entirely.
 */
const SHOTS = (() => {
    const dir = process.env.S35_P5_SHOTS ?? '/tmp/s35-p5-shots';
    if (!dir) {
        return null;
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch (e) {
        return null;
    }
})();

let pass = 0;
let fail = 0;
const failures = [];
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        failures.push(label);
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
}
function checkTrue(label, actual) {
    check(label, actual === true, true);
}
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

/*
 * The page-side harness: the REAL app scripts, the REAL vendored xterm, a
 * recording socket. `__server` fires the app's OWN registered handlers with
 * the exact frames socket_events.py sends, so the restore path under test is
 * the production path -- nothing under test is reimplemented or stubbed.
 *
 * `ssh_output` is answered synchronously by writing into the live terminal
 * through the app's own writeOutput (the funnel ssh_output itself calls), so a
 * transport-liveness probe sees the same state a live connection would.
 */
const INIT = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.io = () => ({
        connected: true, on: record, off: noop, once: record,
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        io: { on: noop },
    });
    window.socket = window.io();
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.showNotification = (m, t) => {};
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function freshPage(seed, disableD2 = false, device = null) {
    const ctx = await browser.newContext(device || {
        viewport: { width: 1426, height: 780 },
        hasTouch: false, isMobile: false,
    });
    if (seed) {
        await ctx.addInitScript(([k, v, off]) => {
            try { localStorage.setItem(k, v); } catch (e) { /* blocked */ }
            /*
             * RED PROOF SEAM, harness-side only. S35_RED_NO_SELECTION=1 makes
             * the page report NO remembered selection to the app, which is
             * exactly the pre-D2 world (nothing persisted the selection at
             * all). Used by run-red-proofs.mjs to demonstrate this suite goes
             * red without the D2 behaviour -- no production file is touched
             * to obtain the red, so the restore-after-mutation risk does not
             * exist.
             */
            if (off) {
                try { localStorage.removeItem(k); } catch (e) { /* blocked */ }
            }
        }, [seed[0], seed[1], disableD2 ? 1 : 0]);
    }
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(
        () => typeof SessionManager !== 'undefined' && !!window.socket
            && typeof TerminalManager !== 'undefined',
        null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    return { ctx, page, pageErrors };
}

/*
 * The snapshot frame socket_events._build_session_snapshot emits. Field for
 * field the production shape; pane_index null is the measured DB reality
 * (0 of 326 rows carry a value).
 */
const snapshotFrame = (id, i, extra = {}) => Object.assign({
    snapshot_version: 1,
    session_id: id,
    host: 'tiny.example',
    port: 22,
    username: 'sshdtest',
    connected: true,
    auth_type: 'password',
    key_id: null,
    via_jump: null,
    use_tmux: true,
    tmux_session_name: `sshdeck_p5_${i}`,
    display_name: `P5 S${i}`,
    pane_index: null,
    replay_total_chunks: 0,
    replay_truncated: false,
    replay_dropped_bytes: 0,
    replay_history_lines: 0,
    legacy_tmux_locale: null,
}, extra);

/*
 * Paint real history: write through the app's own output funnel so the buffer
 * and the viewport scrollbar are exactly what a live session would have.
 *
 * The count is not arbitrary. The grid here is 164x40, so 40 lines merely
 * FILLS the screen (measured: baseY 1) and a scroll-up would be testing a
 * one-row range. 120 lines leaves ~81 rows above the viewport -- comfortably
 * mid-history, which is the starting state T1/T2 mandate; starting at the live
 * edge would make a scroll-up a no-op BY DESIGN and the assertion vacuous.
 */
async function paint(page, sid, tag, lines = 120) {
    let out = '';
    for (let i = 1; i <= lines; i++) out += `${tag}-${i}\r\n`;
    await page.evaluate(({ s, o }) =>
        TerminalManager.writeOutput(s, o), { s: sid, o: out });
    /*
     * Wait for the ENGINE, not for a frame count. xterm's write() is queued
     * into its parser and `_innerWrite` yields every 12ms, so a double-rAF is
     * not a drain: with 120 lines the buffer was still empty two frames later
     * (measured baseY 0 with vpScrollHeight 660). The public write callback
     * fires when this chunk has parsed, and Viewport.syncScrollArea then needs
     * one more frame to resize .xterm-scroll-area, which is what gives the
     * scroller its range.
     */
    await page.evaluate(({ s }) => new Promise(res => {
        const key = (TerminalManager.sessionTerminals[s] || [])[0];
        const t = TerminalManager.terminals[key];
        if (!t) { res(); return; }
        t.write('', () => requestAnimationFrame(() =>
            requestAnimationFrame(res)));
    }), { s: sid });
}

/*
 * The server's answer to this pane's ATTACH.
 *
 * this replaces answerGeometry(). A restored pane asks for its own
 * tmux client (view_attach, carrying the size it measured) and the ack is what
 * moves it to 'attached', so a fixture that never acks leaves later fits parked
 * as pending sizes.
 *
 * The reason the OLD helper was load-bearing is gone with it: a pty_geometry
 * answer used to be the only thing that released the S27 geometry hold, and
 * without it every paint sat queued (measured held=true, bufLen 40 = screen
 * only, baseY 0). Nothing queues live output any more.
 */
async function ackViewAttach(page, sid) {
    await page.evaluate((s) => window.__server('view_attached',
        { session_id: s }), sid);
    await page.waitForTimeout(120);
}
const S1 = 'aaaa1111-p5xx-4aaa-8aaa-000000000001';
const S2 = 'bbbb2222-p5xx-4bbb-8bbb-000000000002';
const S3 = 'cccc3333-p5xx-4ccc-8ccc-000000000003';

const SNAPSHOTS = {};
const READ = (sid) => {
    const SM = SessionManager;
    const TM = TerminalManager;
    const keys = (TM.sessionTerminals[sid] || []);
    const t = TM.terminals[keys[0]];
    const wrapper = document.getElementById(`terminal-${sid}`);
    const cell = t?._core?._renderService?.dimensions?.css?.cell || null;
    return {
        sessions: Object.keys(SM.sessions).length,
        appActiveSessionId: SM.activeSessionId || null,
        appPaneAssignments: (SM.paneAssignments || []).slice(),
        // Which sessions actually OWN the visible grid, whatever the split
        // underneath records (a solo session is shown without being assigned).
        gridWrappers: [...document.querySelectorAll('#terminalGrid .terminal-wrapper')]
            .map(el => el.id.replace(/^terminal-/, '')),
        wrapperClass: wrapper ? wrapper.className : null,
        wrapperParentId: wrapper?.parentElement?.id || null,
        visible: wrapper ? !!(wrapper.offsetWidth || wrapper.offsetHeight) : false,
        rect: wrapper ? (r => ({ w: r.width, h: r.height }))(wrapper.getBoundingClientRect()) : null,
        cell: cell ? { w: cell.width, h: cell.height } : null,
        cols: t ? t.cols : null,
        rows: t ? t.rows : null,
        baseY: t ? t.buffer.active.baseY : null,
        viewportY: t ? t.buffer.active.viewportY : null,
        layers: wrapper ? wrapper.querySelectorAll('*').length : null,
        // Ancestor/frame scroll -- I2/T4: the frame must never move.
        docScrollTop: document.documentElement.scrollTop,
        docScrollLeft: document.documentElement.scrollLeft,
        workspaceTop: (() => {
            const el = document.getElementById('workspace');
            return el ? el.scrollTop : null;
        })(),
        paneTop: (() => {
            const el = wrapper ? wrapper.closest('.terminal-pane') : null;
            return el ? el.scrollTop : 0;
        })(),
        // The engine's own scroller, for contrast with the ancestors above.
        vpScrollTop: (() => {
            const el = wrapper ? wrapper.querySelector('.xterm-viewport') : null;
            return el ? el.scrollTop : null;
        })(),
        vpScrollHeight: (() => {
            const el = wrapper ? wrapper.querySelector('.xterm-viewport') : null;
            return el ? el.scrollHeight : null;
        })(),
    };
};

// --- SETUP: the working desktop, three sessions, user in #1 -----------------
// The frames are built HERE, node-side, and passed in: snapshotFrame is a
// node const and is not reachable from page context.
const FRAMES = [[1, S1], [2, S2], [3, S3]].map(([n, id]) => snapshotFrame(id, n));

/*
 * Restore in an EXPLICIT order. socket_events.restore_user_sessions has no
 * ORDER BY (:535), so on production the order is whatever the database hands
 * back; the two orders exercised here bracket the interesting cases for a
 * user working in S2:
 *   ['S1','S3','S2']  -- S2 arrives LAST: only the remembered selection can
 *                        give it the pane (D1 alone leaves the FIRST arrival
 *                        holding it).
 *   ['S3','S1','S2']  -- same property with the other non-S2 session first,
 *                        so passing is not an artefact of S1-vs-S3 ordering.
 * Both must end with S2 active, assigned, visible -- with NO manual switch,
 * which is the whole point of the owner's "without switching away and back".
 */
async function restoreAll(page, order = ['S1', 'S2', 'S3']) {
    const byName = { S1, S2, S3 };
    for (const name of order) {
        const frame = FRAMES.find(f => f.session_id === byName[name]);
        await page.evaluate(f => window.__server('ssh_session_restored', f), frame);
        /*
         * The EMPTY REPLAY TERMINATOR, exactly as the server sends it.
         *
         * restoreSession opens a replay window for any integer
         * replay_total_chunks -- zero included (session-manager.js:306) -- and
         * socket_events.py:590-600 therefore always emits a seq-0 final chunk
         * when there was nothing to replay, "or live output would sit queued
         * behind a replay that never arrives". A harness that skipped it left
         * the gate open and every later write queued in liveQueue instead of
         * reaching the engine: measured as baseY 0 with 40 lines painted.
         */
        await page.evaluate(id => window.__server('ssh_replay_chunk', {
            session_id: id, seq: 0, total: 0, data: '',
            final: true, truncated: false, dropped_bytes: 0,
        }), frame.session_id);
    }
    await page.waitForTimeout(200);
}

const first = await freshPage();
{
    const { page } = first;
    await restoreAll(page, ['S1', 'S2', 'S3']);
    await ackViewAttach(page, S1);
    await ackViewAttach(page, S2);
    await ackViewAttach(page, S3);
    await paint(page, S1, 'P5S1');
    await paint(page, S2, 'P5S2');
    await paint(page, S3, 'P5S3');
    // The deliberate act: the user selects #2 and works there. S2 is chosen
    // over S1 so that "first-restored wins" and "remembered selection wins"
    // are distinguishable verdicts: on the S1,S3,S2 order below, S2 is the
    // LAST snapshot, so only the selection can put it in the pane; on the
    // S3,S1,S2 order the reverse. A suite that worked in S1 could pass both
    // orders by accident.
    await page.evaluate(s => SessionManager.switchSession(s), S2);
    await page.waitForTimeout(300);
    const workState = await page.evaluate(READ, S2);
    num('[setup] working state, session #2', workState);
    checkTrue('§0 the user can be in session #2 with it assigned',
        workState.appActiveSessionId === S2);
    checkTrue('§0 the selection was PERSISTED for the next load',
        await page.evaluate(() =>
            localStorage.getItem('activeSessionId')) === S2);
}

/*
 * THE RETURN. A full reload, in both the orders the database can hand back,
 * for a user who was working in S2. The route-return leg and the plain reload
 * leg are two separate journeys on production (plan Part 3: S7a and S7b are
 * separate measurement paths) and both are broken by the same restore loop,
 * so each gets its own page, its own restore order, and its own assertions.
 * The subject is S2 -- the MIDDLE connection -- so neither "first restored
 * wins" (true for order S1,S3,S2) nor "last restored wins" (the pre-fix
 * behaviour) can masquerade as the remembered selection.
 */
const SEED = ['activeSessionId', S2];

async function returnJourney(label, order, seed, disableD2 = false, device = null,
    expectedGrid = null) {
    /*
     * THE CONTEXT IS THE USER'S. A real Terminal -> Admin -> Terminal hop is
     * the SAME browser context re-navigating: localStorage -- where the
     * deliberate S2 selection and the split layout live -- comes WITH it. A
     * fresh context would start empty and the D2 path under test would never
     * even run; seed therefore injects exactly the key the departed page had
     * written, nothing more.
     */
    const { ctx, page, pageErrors } = await freshPage(seed, disableD2, device);
    await restoreAll(page, order);
    /*
     * History exists on the RETURN leg too: the remote has been running the
     * whole time the page was away, so the shell's output above the screen is
     * exactly what the user comes back to scroll. Painted here, before the
     * arrival read, through the same funnel -- a restore with an empty
     * scrollback could not be "unscrollable" and the row would pass vacuously.
     *
     * attachTerminal clears the screen and only then drains what was buffered
     * during its double-rAF + 50ms readiness window (terminal-manager.js:2194),
     * so painting must WAIT for terminalReady or the whole history lands
     * before the clear and is wiped. waitForReady is what makes the paint
     * deterministic; measured without it: baseY 0 on the return leg, baseY 81
     * on the setup leg, identical code.
     */
    for (const sid of [S1, S2, S3]) {
        await page.waitForFunction((s) => {
            const keys = TerminalManager.sessionTerminals[s] || [];
            return keys.length > 0
                && keys.every(k => TerminalManager.terminalReady[k]);
        }, sid, { timeout: 8000 });
    }
    await ackViewAttach(page, S2);
    await paint(page, S2, 'P5S2');
    await page.waitForTimeout(400);
    const arrival = await page.evaluate(READ, S2);
    num(`[${label}] ON ARRIVAL, session #2 (order ${order.join(',')})`, arrival);

    checkTrue(`§1 ${label}: the session the user worked in is the ACTIVE one on arrival, with NO manual switch`,
        arrival.appActiveSessionId === S2);
    checkTrue(`§1 ${label}: #2's wrapper is assigned to a pane (not .unassigned)`,
        /^terminal-wrapper( |$)/.test(arrival.wrapperClass)
        && !/(^| )unassigned( |$)/.test(arrival.wrapperClass));
    checkTrue(`§1 ${label}: #2 is VISIBLE (has a box)`,
        arrival.visible === true && arrival.rect.w > 0 && arrival.rect.h > 0);
    checkTrue(`§1 ${label}: #2's char cell is measured (not the 0x0 of a display:none open)`,
        arrival.cell !== null && arrival.cell.w > 0 && arrival.cell.h > 0);
    // The expected grid is the one this viewport really fits. It moved
    // 164 -> 163 columns with the xterm 6 upgrade (a slightly different cell
    // measurement) and 163x40 -> 166x41, when the pane's 8px
    // inset was removed so the grid reaches the edge and the fit began
    // measuring the real scrollbar gutter instead of reserving a flat 14px.
    // 1412px of wrapper less an 8px gutter is 166.6 cells of 8.4277px, and
    // 660px is 41.25 rows of 16px. The property asserted is unchanged.
    checkTrue(`§1 ${label}: #2 renders a real grid (not the constructed 80x24)`,
        expectedGrid ? arrival.cols === expectedGrid.cols
            && arrival.rows === expectedGrid.rows
            : arrival.cols !== 80 && arrival.rows !== 24);
    /*
     * (owner ruling, split screen): a restored session that owns no
     * pane is shown SOLO -- the grid holds it alone while `paneAssignments`
     * still records the split underneath, so that array is no longer the proxy
     * for "nobody stole the pane". The property this row exists for is
     * asserted directly instead: the grid holds #2's wrapper and no other.
     */
    checkTrue(`§1 ${label}: #1 and #3 did NOT steal the pane from #2`,
        JSON.stringify(arrival.gridWrappers) === JSON.stringify([S2]));

    // §2 ancestors stay at zero while the ENGINE scrolls -- I2/T4. The wheel
    // goes through the real event path onto the real .xterm element. On a
    // phone the grid renders WIDER than the pane (S34 pane-pannable), so the
    // .xterm box's CENTRE can sit inside the clipped region where no hit test
    // lands -- the wheel then never reaches the viewport and the row would
    // fail on coordinates, not on the journey. device tells the two apart:
    // desktop wheels at the box centre, phone swipes through the REAL touch
    // path at a visible x, the same trusted-gesture route
    // p1_tmux_vertical_gesture.mjs uses.
    if (device) {
        const wr = await page.evaluate((s) => {
            const el = document.getElementById(`terminal-${s}`);
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, w: r.width, h: r.height };
        }, S2);
        const cdp = await ctx.newCDPSession(page);
        const vx = Math.round(wr.left + Math.min(wr.w / 2, 100));
        const yLow = Math.round(wr.top + wr.h * 0.8);
        const yHigh = Math.round(wr.top + wr.h * 0.2);
        await cdp.send('Input.dispatchTouchEvent',
            { type: 'touchStart', touchPoints: [{ x: vx, y: yHigh, id: 51 }] });
        for (let s = 1; s <= 8; s++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{
                    x: vx,
                    y: Math.round(yHigh + ((yLow - yHigh) * s) / 8), id: 51,
                }],
            });
            await page.waitForTimeout(18);
        }
        await cdp.send('Input.dispatchTouchEvent',
            { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(300);
    } else {
        const box = await page.locator(`#terminal-${S2} .xterm`).boundingBox();
        if (box) {
            const cx = box.x + box.width / 2;
            const cy = box.y + Math.min(box.height / 2, 300);
            await page.mouse.move(cx, cy);
            for (let i = 0; i < 8; i++) {
                await page.mouse.wheel(0, -240);
                await page.waitForTimeout(60);
            }
            await page.waitForTimeout(500);
        }
    }
    const scrolled = await page.evaluate(READ, S2);
    num(`[${label}] after wheel UP`, scrolled);
    checkTrue(`§2 ${label}: the wheel moved the ENGINE's viewport (viewportY < baseY)`,
        scrolled.viewportY !== null && scrolled.baseY !== null
        && scrolled.viewportY < scrolled.baseY);
    checkTrue(`§2 ${label}: the document stayed at scroll 0`,
        scrolled.docScrollTop === 0 && scrolled.docScrollLeft === 0);
    checkTrue(`§2 ${label}: #workspace stayed at scrollTop 0`,
        scrolled.workspaceTop === 0);
    checkTrue(`§2 ${label}: the pane stayed at scrollTop 0`,
        scrolled.paneTop === 0);
    checkTrue(`§2 ${label}: the engine's own scroller has a scrollbar to move`,
        scrolled.vpScrollHeight !== null && scrolled.vpScrollHeight > 0);

    // §3 transport still live: a byte the user types reaches the wire, and the
    // funnel is the production one (window.emitTerminalInput).
    const emitsBefore = await page.evaluate(
        () => window.__emits.filter(e => e.ev === 'ssh_input').length);
    await page.evaluate(s => window.emitTerminalInput(s, 'x'), S2);
    await page.waitForTimeout(300);
    const inputs = await page.evaluate(
        () => window.__emits.filter(e => e.ev === 'ssh_input'));
    checkTrue(`§3 ${label}: typing still reaches the transport after the return`,
        inputs.length === emitsBefore + 1
        && inputs[inputs.length - 1].payload.session_id === S2
        && inputs[inputs.length - 1].payload.data === 'x');

    /*
     * §3b — the return must NOT claim the shared grid. S17 FIX 6: a page
     * rebuilding from a snapshot is not the user working in this client, so
     * no client_interaction may leave it -- otherwise a phone reloading in a
     * pocket takes the PTY grid from a desktop somebody is typing in (the R5
     * defect). The deliberate switch in SETUP legitimately emits; the RETURN
     * legs never do.
     */
    const interactions = await page.evaluate(
        () => window.__emits.filter(e => e.ev === 'client_interaction').length);
    checkTrue(`§3b ${label}: the restore claimed NO shared-grid interaction`,
        interactions === 0);

    checkTrue(`§4 ${label}: no page error across the journey`,
        pageErrors.length === 0);

    /*
     * ARRIVAL SHOT — the eyes-on gate (AGENTS.md §2). The rows above measure
     * the arrival numerically; this renders WHAT THE USER SEES on it, which is
     * the only way to catch a state that measures right and looks wrong (a
     * pane that is laid out but paints nothing, a label naming the other
     * connection). Taken AFTER the wheel and the typed byte, so the image is
     * the end state of the whole journey, not a mid-restore frame.
     *
     * Written outside the repository tree so no probe artefact can be
     * committed; SHOTS is skipped entirely when the dir cannot be created.
     */
    if (SHOTS) {
        const file = `${SHOTS}/p5-${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
        await page.screenshot({ path: file });
        num(`[${label}] arrival shot`, file);
    }
    await ctx.close();
}

// Both legs, both orders, always the remembered S2 and no manual switch.
// S35_RED_NO_SELECTION=1 is the red-proof hook (see freshPage): the harness
// reports no remembered selection to the page -- exactly the pre-D2 world,
// where nothing persisted the selection at all -- and the suite must go red
// on the active/assigned/visible rows. Never set in a normal run.
const RED_NO_SELECTION = process.env.S35_RED_NO_SELECTION === '1';
await returnJourney('route-return S1,S3,S2', ['S1', 'S3', 'S2'], SEED, RED_NO_SELECTION,
    null, { cols: 166, rows: 41 });
await returnJourney('reload S3,S1,S2', ['S3', 'S1', 'S2'], SEED, RED_NO_SELECTION,
    null, { cols: 166, rows: 41 });
// The phone leg renders the SAME restore journey at owner-bullet-2 width. The
// grid is left unasserted beyond "not the constructed 80x24": a 390px phone
// fits its own local grid (S34 control-mode rendering), and pinning a number
// here would assert a geometry the restore does not own.
if (!RED_NO_SELECTION) {
    await returnJourney('phone390 route-return S1,S3,S2', ['S1', 'S3', 'S2'], SEED, false,
        { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
            deviceScaleFactor: 1 });
}


/*
 * =============================================================================
 * §5 — KB1: AFTER A RELOAD, HISTORY DRAG.
 * =============================================================================
 *
 * Owner bullet 1 names TWO gestures, "touch/wheel scrollable", and §2 above
 * only ever exercised the WHEEL (desktop) and a touch swipe (phone). The
 * owner's KB1 report is specifically that after a desktop reload he cannot DRAG
 * the history -- and a drag is not a wheel: a wheel is a discrete xterm
 * `onWheel` -> scrollLines path, while a drag is a sustained pointer sequence
 * that moves a SCROLLBAR (either the engine's own native one, or this app's
 * custom `.terminal-scrollbar`) or auto-scrolls a text selection. None of those
 * three paths has ever had an assertion in this suite, so "wheel works after
 * reload" says nothing about them.
 *
 * WHAT THIS SECTION MUST DISTINGUISH, because two very different causes produce
 * the same "frozen" experience and the fix for one is wrong for the other:
 *
 *   (a) CSS / geometry:  the wide-grid contract (`.pane-pannable .xterm
 *       { width: fit-content }`, the wrapper's `overflow-x: hidden !important`)
 *       leaving the drag target unhittable or the scroller with no range. This
 *       would show as a MISSING or ZERO-SIZED target, or as an ancestor moving
 *       instead of the engine.
 *   (b) LIFECYCLE / scroll-owner:  the drag reaching the engine and moving it,
 *       and then something -- restoreLiveEdgeIntent, the 500ms updateScrollbar
 *       interval -- putting it back. This
 *       would show as MOVED-THEN-RETURNED.
 *
 * So every drag below is read THREE times: before, immediately after, and again
 * after a settle. A drag that never moved the engine is (a)-shaped; a drag that
 * moved it and lost it is (b)-shaped. The ancestors are read every time too, so
 * a drag that moved the FRAME instead of the engine (I2/T4) is never mistaken
 * for a working drag.
 */
const DRAG_READ = (sid) => {
    const TM = TerminalManager;
    const keys = (TM.sessionTerminals[sid] || []);
    const t = TM.terminals[keys[0]];
    const wrapper = document.getElementById(`terminal-${sid}`);
    const vp = wrapper ? wrapper.querySelector('.xterm-viewport') : null;
    const xterm = wrapper ? wrapper.querySelector('.xterm') : null;
    const bar = wrapper ? wrapper.querySelector('.terminal-scrollbar') : null;
    const thumb = wrapper ? wrapper.querySelector('.terminal-scrollbar-thumb') : null;
    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
            right: r.right, bottom: r.bottom };
    };
    return {
        // WHERE THE HISTORY IS. viewportY < baseY means the user is reading
        // back; viewportY === baseY is the live edge.
        viewportY: t ? t.buffer.active.viewportY : null,
        baseY: t ? t.buffer.active.baseY : null,
        cols: t ? t.cols : null,
        rows: t ? t.rows : null,
        // THE ENGINE'S OWN SCROLLER, and whether it has a real classic
        // scrollbar gutter a pointer can grab at all.
        vpScrollTop: vp ? vp.scrollTop : null,
        vpScrollHeight: vp ? vp.scrollHeight : null,
        vpClientHeight: vp ? vp.clientHeight : null,
        vpGutter: vp ? vp.offsetWidth - vp.clientWidth : null,
        vpRect: box(vp),
        // THE APP'S OWN SCROLLBAR -- the element setupScrollbar builds and
        // installs a mousedown drag on.
        barExists: !!bar,
        barRect: box(bar),
        barDisplay: bar ? getComputedStyle(bar).display : null,
        barPosition: bar ? getComputedStyle(bar).position : null,
        barClientHeight: bar ? bar.clientHeight : null,
        thumbExists: !!thumb,
        thumbRect: box(thumb),
        thumbPosition: thumb ? getComputedStyle(thumb).position : null,
        thumbStyleTop: thumb ? thumb.style.top : null,
        thumbStyleHeight: thumb ? thumb.style.height : null,
        // THE CSS CONTRACT (a)-side: is this desktop pane in the wide-grid
        // state at all, and can the drag target be clipped away?
        wrapperClass: wrapper ? wrapper.className : null,
        wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
        wrapperScrollLeft: wrapper ? wrapper.scrollLeft : null,
        xtermWidth: xterm ? getComputedStyle(xterm).width : null,
        xtermOverflowX: xterm ? getComputedStyle(xterm).overflowX : null,
        // I2 / T4: the outer frame must not move, whatever the gesture.
        docScrollTop: document.documentElement.scrollTop,
        workspaceTop: (() => {
            const el = document.getElementById('workspace');
            return el ? el.scrollTop : null;
        })(),
        paneTop: (() => {
            const el = wrapper ? wrapper.closest('.terminal-pane') : null;
            return el ? el.scrollTop : 0;
        })(),
    };
};

/*
 * The arithmetic setupScrollbar's own drag handler performs, read from the LIVE
 * elements rather than recomputed here. handleMouseMove divides by
 * `trackHeight - thumbHeight`, so this reports that divisor: 0 makes the
 * quotient non-finite and every drag lands on a clamp, which is a freeze that
 * no amount of pointer movement can escape.
 */
const BAR_MATH = (sid) => {
    const TM = TerminalManager;
    const keys = (TM.sessionTerminals[sid] || []);
    const t = TM.terminals[keys[0]];
    const wrapper = document.getElementById(`terminal-${sid}`);
    const bar = wrapper ? wrapper.querySelector('.terminal-scrollbar') : null;
    if (!t || !bar) return null;
    const buffer = t.buffer.active;
    const totalLines = buffer.length;
    const maxScroll = totalLines - t.rows;
    const trackHeight = bar.clientHeight;
    const thumbHeight = Math.max(30, (t.rows / totalLines) * trackHeight);
    const divisor = trackHeight - thumbHeight;
    // What a 60px upward drag would compute, exactly as handleMouseMove does.
    const scrollDelta = (-60 / divisor) * maxScroll;
    const newScroll = Math.max(0,
        Math.min(maxScroll, Math.round(buffer.viewportY + scrollDelta)));
    return {
        totalLines, maxScroll, trackHeight, thumbHeight, divisor,
        scrollDelta: Number.isFinite(scrollDelta) ? scrollDelta : String(scrollDelta),
        newScroll: Number.isFinite(newScroll) ? newScroll : String(newScroll),
        divisorIsUsable: Number.isFinite(divisor) && divisor > 0,
    };
};

{
    /*
     * A REAL desktop reload arrival, built by the same helpers the journeys
     * above use, so the state under the drag is the state §1/§2 already pinned:
     * S2 remembered, assigned, visible, 164x40, with 120 lines of history.
     */
    const { ctx, page, pageErrors } = await freshPage(SEED, false, null);
    await restoreAll(page, ['S3', 'S1', 'S2']);
    for (const sid of [S1, S2, S3]) {
        await page.waitForFunction((s) => {
            const keys = TerminalManager.sessionTerminals[s] || [];
            return keys.length > 0
                && keys.every(k => TerminalManager.terminalReady[k]);
        }, sid, { timeout: 8000 });
    }
    await ackViewAttach(page, S2);
    await paint(page, S2, 'P5KB1');
    await page.waitForTimeout(400);

    const start = await page.evaluate(DRAG_READ, S2);
    num('§5 KB1 arrival, before any drag', start);
    const math = await page.evaluate(BAR_MATH, S2);
    num('§5 KB1 the app scrollbar drag arithmetic, on the live elements', math);

    // GUARDS: without these the drag rows could pass or fail vacuously.
    checkTrue('§5 GUARD there is real history to drag through (baseY > 0)',
        start.baseY !== null && start.baseY > 0);
    checkTrue('§5 GUARD the arrival starts AT the live edge, so any move is a real move',
        start.viewportY === start.baseY);
    checkTrue('§5 GUARD this desktop pane is NOT in the wide-grid pannable state',
        !/(^| )pane-pannable( |$)/.test(start.wrapperClass || ''));
    /*
     * Range to move through, read from the BUFFER. `.xterm-viewport` is not a
     * portable proof of it: xterm 6 renders with no DOM scroll range at all
     * (scrollHeight === clientHeight), while the scrollback it holds is the
     * same.
     */
    checkTrue('§5 GUARD the engine has scrollback range to drag through',
        start.baseY > 0);

    /*
     * --- (1) THE APP'S OWN SCROLLBAR ------------------------------------------
     * setupScrollbar builds `.terminal-scrollbar` on EVERY attach and installs a
     * mousedown->document-mousemove drag on its thumb. If that control ships, it
     * must be draggable; if its geometry makes it undraggable, that is the
     * defect, and the rows below say which.
     */
    /*
     * THE CONTRACT (owner call, S35 P36): a scrollbar control must either be
     * grabbable or not exist. The retired `.terminal-scrollbar` was neither --
     * present in the DOM, invisible, and mathematically unable to position
     * anything (divisor 0 -> +/-Infinity). These rows fail on BOTH shapes of
     * wrong, so they cannot be satisfied by re-introducing a broken control:
     * if the element comes back it must have a real box, an absolute thumb and
     * a usable divisor; if it is absent the drag surface is the engine's own.
     */
    if (start.barExists) {
        checkTrue('§5.1 a shipped scrollbar control has a real box to grab',
            start.barRect !== null && start.barRect.w > 0 && start.barRect.h > 0);
        checkTrue('§5.1 its thumb is positioned by the top it is given (not static)',
            start.thumbPosition === 'absolute');
        checkTrue('§5.1 its drag arithmetic has a usable divisor (trackHeight > thumbHeight)',
            math !== null && math.divisorIsUsable === true);
    } else {
        checkTrue('§5.1 no dead scrollbar control is shipped over the pane',
            start.barExists === false && start.thumbExists === false);
        checkTrue('§5.1 and its degenerate drag arithmetic is gone with it',
            math === null);
    }
    /*
     * The retired control's ONE live effect must survive its removal:
     * syncTerminalScrollState had exactly one caller (inside the old
     * updateScrollbar) and is the only path that turns Exit-Scroll ON. So the
     * observer must still be registered per terminal key, and still be the
     * thing destroyTerminalKey cleans.
     */
    const stateObs = await page.evaluate((s) => {
        const TM = TerminalManager;
        const key = (TM.sessionTerminals[s] || [])[0];
        return {
            hasCleanup: typeof TM.scrollbarCleanups[key] === 'function',
            hasObserver: typeof TM.observeScrollState === 'function',
            scrolledStateReported: TM.isSessionScrolled(s),
        };
    }, S2);
    num('§5.1 the retained scroll-state observer', stateObs);
    checkTrue('§5.1 the scroll-state observer is registered for this terminal key',
        stateObs.hasCleanup === true && stateObs.hasObserver === true);

    /*
     * --- (2) THE ENGINE'S NATIVE SCROLLBAR, DRAGGED WITH A REAL POINTER -------
     * This is the gesture the owner performs. The whole sequence goes through
     * the browser's own hit testing on the real .xterm-viewport gutter: no
     * synthetic scroll, no scrollTop write.
     */
    /*
     * FIXTURE CONTROL FIRST -- can this environment drag a native scrollbar AT
     * ALL? A headless browser driven over CDP may not deliver a thumb drag to
     * the compositor, and without this control a harness limitation would be
     * indistinguishable from the owner's defect. So the identical pointer
     * sequence is run on a PLAIN overflow:scroll div with the same gutter, on
     * the same page. If the control does not move either, the environment
     * cannot host this gesture and §5.2 reports UNAVAILABLE instead of RED.
     */
    const ctl = await page.evaluate(() => {
        /*
         * The control must carry the SAME scrollbar declarations as
         * .xterm-viewport (style.css:5773-5825): a plain div gets this
         * platform's OVERLAY scrollbar, whose gutter is 0 and which no pointer
         * can grab -- comparing against that would prove nothing about the
         * classic 8px gutter the terminal actually has.
         */
        const st = document.createElement('style');
        st.textContent = '#__dragControl{overflow-y:scroll!important;'
            + 'scrollbar-width:thin;scrollbar-gutter:stable}'
            + '#__dragControl::-webkit-scrollbar{width:8px}'
            + '#__dragControl::-webkit-scrollbar-track{background:transparent}'
            + '#__dragControl::-webkit-scrollbar-thumb{background:#888;'
            + 'border-radius:8px}';
        document.head.appendChild(st);
        const d = document.createElement('div');
        d.id = '__dragControl';
        d.style.cssText = 'position:fixed;left:20px;top:120px;width:200px;'
            + 'height:300px;overflow-y:scroll;z-index:99999;background:#111';
        const inner = document.createElement('div');
        inner.style.cssText = 'height:3000px';
        d.appendChild(inner);
        document.body.appendChild(d);
        d.scrollTop = d.scrollHeight;
        const r = d.getBoundingClientRect();
        return { right: r.right, bottom: r.bottom, top: r.top,
            gutter: d.offsetWidth - d.clientWidth, scrollTop: d.scrollTop };
    });
    if (ctl.gutter > 0) {
        const cx = ctl.right - (ctl.gutter / 2);
        const cy = ctl.bottom - 12;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(cx, cy - (i * 18));
            await page.waitForTimeout(24);
        }
        await page.mouse.up();
    }
    const ctlAfter = await page.evaluate(() => {
        const d = document.getElementById('__dragControl');
        const v = d ? d.scrollTop : null;
        if (d) d.remove();
        return v;
    });
    const nativeDragIsHostable = ctl.gutter > 0 && ctlAfter !== null
        && ctlAfter < ctl.scrollTop;
    num('§5.2 FIXTURE CONTROL native scrollbar drag on a plain div',
        { gutter: ctl.gutter, before: ctl.scrollTop, after: ctlAfter,
            hostable: nativeDragIsHostable });

    let nativeAfter = null;
    let nativeSettled = null;
    if (nativeDragIsHostable && start.vpGutter > 0 && start.vpRect) {
        const gx = start.vpRect.right - (start.vpGutter / 2);
        // The pane arrives at the live edge, so the thumb sits at the BOTTOM of
        // the track; grab it there and drag upward through the history.
        const gy = start.vpRect.bottom - 12;
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(gx, gy - (i * 18));
            await page.waitForTimeout(24);
        }
        nativeAfter = await page.evaluate(DRAG_READ, S2);
        await page.mouse.up();
        await page.waitForTimeout(700);
        nativeSettled = await page.evaluate(DRAG_READ, S2);
        num('§5.2 during the native gutter drag', nativeAfter);
        num('§5.2 after releasing and settling 700ms', nativeSettled);
        checkTrue('§5.2 the native drag moved the ENGINE back into history',
            nativeAfter.viewportY < start.viewportY);
        checkTrue('§5.2 THE (b) TEST: the position SURVIVES the release and the settle',
            nativeSettled.viewportY < nativeSettled.baseY);
        checkTrue('§5.2 the drag moved the engine, not the outer frame (I2/T4)',
            nativeSettled.docScrollTop === 0 && nativeSettled.workspaceTop === 0
            && nativeSettled.paneTop === 0);
    } else {
        /*
         * Reported, never silently skipped. The control above proves whether the
         * ENVIRONMENT can host a native thumb drag; when it cannot, this is a
         * harness limit and saying "RED" would be a false product claim. The row
         * still prints so the section is never silent about what it did not test.
         */
        num('§5.2 UNAVAILABLE native thumb drag is not hostable here',
            { vpGutter: start.vpGutter, controlHostable: nativeDragIsHostable });
        console.log('SKIP  §5.2 native .xterm-viewport thumb drag'
            + ' (environment cannot drag a native scrollbar; see FIXTURE CONTROL)');
    }

    /*
     * --- (3) DRAG-SELECT AUTOSCROLL ------------------------------------------
     * The other desktop drag: press inside the grid and pull above the top edge.
     * xterm's SelectionService auto-scrolls the viewport while the pointer is
     * held outside the box, which is how a user drags a selection back through
     * history. Run from the LIVE EDGE again so the movement is unambiguous.
     */
    await page.evaluate((s) => {
        const keys = TerminalManager.sessionTerminals[s] || [];
        const t = TerminalManager.terminals[keys[0]];
        if (t) t.scrollToBottom();
    }, S2);
    await page.waitForTimeout(200);
    const selStart = await page.evaluate(DRAG_READ, S2);
    const sbox = await page.locator(`#terminal-${S2} .xterm-screen`).boundingBox();
    if (sbox && selStart.viewportY === selStart.baseY) {
        await page.mouse.move(sbox.x + Math.min(sbox.width / 2, 300),
            sbox.y + sbox.height - 30);
        await page.mouse.down();
        // Pull well above the top edge and HOLD: the autoscroll is driven by a
        // timer while the pointer stays outside, so it needs wall-clock time.
        await page.mouse.move(sbox.x + Math.min(sbox.width / 2, 300), sbox.y - 60);
        await page.waitForTimeout(900);
        const selDuring = await page.evaluate(DRAG_READ, S2);
        await page.mouse.up();
        await page.waitForTimeout(500);
        const selAfter = await page.evaluate(DRAG_READ, S2);
        num('§5.3 during the drag-select above the top edge', selDuring);
        num('§5.3 after releasing the selection drag', selAfter);
        checkTrue('§5.3 dragging a selection above the top edge scrolled into history',
            selDuring.viewportY < selStart.viewportY);
        checkTrue('§5.3 and the outer frame never moved',
            selDuring.docScrollTop === 0 && selDuring.workspaceTop === 0
            && selDuring.paneTop === 0);
    } else {
        check('§5.3 UNAVAILABLE a laid-out .xterm-screen at the live edge to drag from',
            { hasBox: !!sbox, atEdge: selStart.viewportY === selStart.baseY },
            { hasBox: true, atEdge: true });
    }

    /*
     * --- (4) WHAT THE RELOAD LEFT BEHIND ------------------------------------
     * plan Part 3 T8 ("số interval scrollbar không tăng sau mỗi vòng") asks
     * whether a re-attach leaks the control. Measured here because a SECOND
     * `.terminal-scrollbar` over the same pane would be an alternative
     * explanation for a dead drag -- a stale bar with a stale closure on top of
     * the live one -- and it has to be excluded by count, not by reading the
     * cleanup code.
     */
    const leak = await page.evaluate((s) => {
        const wrapper = document.getElementById(`terminal-${s}`);
        const vp = wrapper ? wrapper.querySelector('.xterm-viewport') : null;
        return {
            barsInThisWrapper: wrapper
                ? wrapper.querySelectorAll('.terminal-scrollbar').length : null,
            barsInDocument: document.querySelectorAll('.terminal-scrollbar').length,
            wrappersInDocument: document.querySelectorAll('.terminal-wrapper').length,
            // Is the app's bar inside the box the wrapper actually shows?
            barInsideWrapperBox: (() => {
                const bar = wrapper?.querySelector('.terminal-scrollbar');
                if (!bar || !wrapper) return null;
                const b = bar.getBoundingClientRect();
                const w = wrapper.getBoundingClientRect();
                return b.top < w.bottom && b.bottom > w.top;
            })(),
            // The NATIVE scrollbar is the one the user can actually see.
            nativeGutter: vp ? vp.offsetWidth - vp.clientWidth : null,
        };
    }, S2);
    num('§5.4 what the reload left behind', leak);
    checkTrue('§5.4 no re-attach leak: at most one app scrollbar per wrapper',
        leak.barsInThisWrapper !== null && leak.barsInThisWrapper <= 1
        && leak.barsInDocument <= leak.wrappersInDocument);
    checkTrue('§5.4 any shipped scrollbar lies inside the box its pane shows',
        leak.barsInThisWrapper === 0 || leak.barInsideWrapperBox === true);
    checkTrue('§5.4 the engine’s own scrollbar is present for the user to drag',
        leak.nativeGutter !== null && leak.nativeGutter > 0);

    checkTrue('§5 no page errors across the drag journey', pageErrors.length === 0);
    if (SHOTS) {
        const file = `${SHOTS}/p5-kb1-drag.png`;
        await page.screenshot({ path: file });
        num('§5 KB1 drag shot', file);
    }
    await ctx.close();
}

await first.ctx.close();

// ===========================================================================
// 6  DESKTOP RELOAD: THE I-BEAM HANG -- RETIRED.
//
// Owner: "Desktop terminal history cannot be scrolled after reloading page,
// enters typing state with I-beam/caret cursor and hangs without scrolling,
// requires reloading multiple times."
//
// Sections S6, S6b, S6c, S6d and S6e measured the CLIENT-SIDE REPAIR for that
// report: the snapshot declared tmux's mouse policy (`tmux_mouse`), the client
// held the DECSET bytes and re-wrote them when a reload's stream had not
// established tracking, and two further sections measured that the repair meant
// nothing on a control client and on the edge path.
//
// The report had ONE cause and it is gone. A control-mode client never received
// tmux's mouse DECSETs at all (measured: mouseTrackingMode 'none' for the
// session's whole life), so after a reload the engine reported that it would
// send no mouse bytes -- xterm styles that as the I-beam -- and a wheel became
// neither an SGR report for tmux nor a local scroll, since tmux holds the
// history and xterm's own scrollback was empty. A view is a real tmux client:
// it receives the DECSETs with its own attach, every attach, so there is no
// policy to declare, no bytes to re-assert and nothing to repair.
//
// S6f below survives: it is about the CARET the replay leaves behind, which is
// a property of the replay stream rather than of the mouse.

// --- S6f THE RELOAD CARET: the replay must leave it ON the pending row -------
//
// S35 P78, the CLIENT half of the owner's two live reports:
//   A "reload or page navigation loses composer caret/text and bottom tmux row"
//   B "empty composer cannot erase existing tmux pending input"
//
// The server half is `build_replay_chunks`, which appended a CRLF after the
// control-mode seed. The seed IS the pane's current screen, so that terminator
// opened one row too many and xterm's caret landed BELOW the row tmux says it is
// on. Measured on a real tmux 3.4 pane (/tmp/s35/p76_seed_caret.py): tmux
// reported cursor_y=2 cursor_x=26 on `bash-5.2# echo PENDINGTEXT` while the
// delivered stream ended `...echo PENDINGTEXT\r\n`.
//
// This stanza measures what the CLIENT then does with each of the two streams,
// through the production write funnel, so the consequence is evidence rather
// than an argument. Both arms are asserted: the fixed stream must certify the
// prompt and open the erase gate, and the old stream must NOT -- which is what
// makes the first arm non-vacuous.
for (const arm of [
    { label: 'S6f FIXED  (no terminator after the screen)',
        tail: 'sshdtest@tiny:~$ echo PENDINGTEXT', certifies: true },
    { label: 'S6f OLD    (screen followed by CRLF)',
        tail: 'sshdtest@tiny:~$ echo PENDINGTEXT\r\n', certifies: false },
]) {
    const { ctx, page, pageErrors } = await freshPage();
    const SID = S1;
    // replay_total_chunks: 1 -- the snapshot must ANNOUNCE the chunk that follows.
    // S35 P30: a zero-chunk snapshot opens no replay window at all, so a chunk
    // delivered afterwards has nowhere to land (measured: the first run of this
    // stanza read caretRow "" on BOTH arms, which is the fixture, not the app).
    await page.evaluate(f => window.__server('ssh_session_restored', f),
        snapshotFrame(SID, 1, {
            replay_total_chunks: 1 }));
    // The replay carries history, then the pane's screen -- the real order
    // build_replay_chunks emits, with the arm's tail as its last bytes.
    await page.evaluate(({ id, tail }) => {
        let out = '';
        for (let i = 1; i <= 40; i++) out += 'SEED-ROW-' + i + '\r\n';
        // seq is 1-BASED on the wire (socket_events.py:580 emits index + 1);
        // acceptReplayChunk writes nothing for seq 0, which it treats as the
        // empty terminator. The first two runs of this stanza sent seq 0 and
        // measured caretRow "" on BOTH arms -- the fixture swallowing its own
        // bytes, not the product.
        window.__server('ssh_replay_chunk', {
            session_id: id, seq: 1, total: 1, data: out + tail,
            final: true, truncated: false, dropped_bytes: 0,
        });
    }, { id: SID, tail: arm.tail });
    await page.waitForTimeout(250);
    await ackViewAttach(page, SID);
    await page.waitForTimeout(250);

    const st = await page.evaluate((id) => {
        const t = TerminalManager.terminals[(TerminalManager.sessionTerminals[id] || [])[0]];
        const b = t.buffer.active;
        const caret = b.getLine(b.baseY + b.cursorY);
        return {
            caretRow: caret ? caret.translateToString(true) : null,
            cursorX: b.cursorX,
            bufferType: b.type,
        };
    }, SID);
    num(arm.label, st);
    check(`${arm.label}: GUARD the engine really parsed the stream (non-vacuous)`,
        st.bufferType, 'normal');
    if (arm.certifies) {
        check('S6f the caret is left ON the pending row, not below it',
            (st.caretRow || '').trimEnd(), 'sshdtest@tiny:~$ echo PENDINGTEXT');
        check('S6f the caret column is past the prompt', st.cursorX > 0, true);
    } else {
        check('S6f the OLD stream leaves the caret on a BLANK row',
            (st.caretRow || '').trim(), '');
    }
    check(`${arm.label}: no page errors`, pageErrors, []);
    await ctx.close();
}

await browser.close();
await server.close();

console.log(`\ns35_p5_reload_lifecycle: ${pass} passed, ${fail} failed`);
if (failures.length) {
    console.log('FAILURES:');
    failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
