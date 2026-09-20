#!/usr/bin/env node
/*
 * S20 item 5 — SESSION-SCOPED INITIALISATION. The Owner's blocking regression,
 * stated as gates.
 *
 * Directive, verbatim: "New blocking regression from
 * owner: all mobile fixes work only on the first SSH connection after page load.
 * Switching connection A to B resurrects old bugs: gestures dead until toggling
 * twice, composer contaminated by notepad content, geometry and sync wrong. Audit
 * first-session-only initialization and stale closures. [...] Add a browser gate:
 * switch A to B, gestures work immediately on B with zero double-toggle, composer
 * contains only B terminal input."
 *
 * THE AUDIT'S ANSWER, measured before writing a line of fix
 * (/tmp/s16work/s20_item5_probe.out). The obvious hypotheses were REFUTED:
 * gesture listeners bind exactly once per wrapper, each terminal key gets its own
 * AbortController, and no notepad text ever reaches the composer. What actually
 * differs about the first connection is WHERE IT IS ATTACHED:
 *
 *   the first session is attached into the pane it will occupy, so it is VISIBLE
 *   at terminal.open() time; every later one is created while an earlier session
 *   still owns the pane, so its wrapper still carries `.unassigned`, which is
 *   `display: none` (measured: display none, height 0).
 *
 * xterm.js 5.3.0 measures the character cell ONCE inside `open()`. In a
 * display:none subtree that measurement is 0x0, `hasValidSize` stays false, and
 * nothing retries. The vendored fit addon then returns UNDEFINED from
 * `proposeDimensions()` forever -- `if (cell.width === 0 ...) return;` -- so:
 * the terminal stays at its constructed 80x24 (geometry), no `ssh_resize`
 * proposal ever reaches the server (sync), and every gesture that divides by a
 * cell or by `.xterm-screen`'s box is dead (measured: 0 wheel frames on such a
 * session against 11 on a healthy one).
 *
 * A second, independent cause of "geometry wrong" was found in the same probe and
 * is gated here too: focusing the Notes textarea makes the browser scroll
 * #workspace to scrollTop 440, putting the terminal pane 352px ABOVE the viewport.
 * #workspace is overflow-y:hidden, so nothing can scroll it back -- the offset
 * survived a blur, a composer focus and two session switches. That is why the
 * defect looked notepad-related AND session-related at once.
 *
 * Sections:
 *   §A  the FIRST connection: the baseline every later one must match
 *   §B  A -> B where B was created while A owned the pane (the production
 *       arrival order): B fits, proposes to the server, and ONE swipe is
 *       answered -- zero double-toggle
 *   §C  going back to A, and to B again, keeps both working (no stale closure,
 *       no per-key state leaking between them)
 *   §D  the composer after the switch contains only B's own input, with the
 *       notepad holding text the whole time
 *   §E  the shell's hidden scrollers: focusing Notes must not push the pane
 *       off-screen, and the terminal's own horizontal pan must survive the
 *       reset (scrollTop is zeroed, scrollLeft is the O3 pan and is not)
 *   §Z  zero page errors
 *
 * Run: node tests/browser/session_switch_init.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`);
    }
}
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);
function checkAtLeast(label, actual, floor) {
    if (typeof actual === 'number' && actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual} >= ${floor})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const STUBS = `
    const noop = () => {};
    window.__emits = [];
    window.__socketHandlers = {};
    window.socket = {
        connected: true, id: 'gate_socket',
        on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop, io: { on: noop, off: noop },
        // save_notepad learns its outcome from the socket.io ACK (the value the
        // server RETURNS), not a broadcast back to itself -- the
        // notepad redesign. The stub must invoke the callback or the client's
        // notepadSaveInFlight latch sticks true after the first save and every
        // later flush early-returns. Mirrors owner_batch_notepad_client.mjs.
        emit: (ev, payload, cb) => {
            window.__emits.push({ ev, payload });
            if (typeof cb === 'function') {
                cb({
                    applied: true,
                    notepad: payload && payload.text != null ? payload.text : '',
                    revision: ((payload && payload.base_revision) || 0) + 1,
                    mode: payload && payload.mode,
                    target_id: payload && payload.target_id,
                });
            }
        },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/i.test(text)) return;
    errors.push(`console: ${text}`);
});
await page.addInitScript(STUBS);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.TerminalManager
    && typeof SessionManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
await page.evaluate(() => {
    document.getElementById('sessionBar')?.classList.remove('hidden');
    window.__emits = [];
});
const cdp = await ctx.newCDPSession(page);

/*
 * Create a session the way the server's `ssh_connected` path does, WITHOUT
 * switching to it. This is the whole point of the gate: in production a second
 * connection is created while the first still owns the pane, so its wrapper is
 * still `.unassigned` (display:none) when `attachTerminal` opens the terminal.
 *
 * tmux with `mouse on` is the product default (ssh_manager
 * ensure_tmux_window_options, run on every view attach), and it decides which
 * gesture row answers a swipe, so the fixture sends the DECSETs tmux's own
 * preamble sends.
 */
async function createInBackground(id) {
    await page.evaluate((id) => {
        SessionManager.createSession({
            session_id: id, host: `${id}.example`, port: 22,
            username: 'gate', display_name: id,
            use_tmux: true, tmux_session_name: `t-${id}`,
        }, null);
        SessionManager.sessions[id].connected = true;
        SessionManager.sessions[id].useTmux = true;
        // The replay window createSession opens (S16 B4) queues live output
        // until the server's terminator closes it, so a fixture that never
        // sends one measures a pane nothing can reach.
        TerminalManager.acceptReplayChunk(id, {
            seq: 0, total: 0, data: '', final: true,
            truncated: false, dropped_bytes: 0,
        });
        (window.__socketHandlers['ssh_output'] || []).forEach(cb => cb({
            session_id: id, data: '\u001b[?1000h\u001b[?1002h\u001b[?1006h',
        }));
    }, id);
    await page.waitForTimeout(400);
}

/*
 * A connect through the REAL `ssh_connected` handler. `createInBackground`
 * above deliberately calls SessionManager.createSession itself, because §B needs
 * a terminal ATTACHED while its wrapper is still `.unassigned` (display:none)
 * and the handler assigns a pane; so the two entry points stay separate rather
 * than one being bent into the other.
 *
 *: the payload carries no geometry and no transport flag any more.
 * The connect event says a session exists; what this socket DISPLAYS is a
 * separate question it answers for itself by attaching a view.
 */
async function connectViaHandler(id) {
    await page.evaluate((id) => {
        (window.__socketHandlers['ssh_connected'] || []).forEach(cb => cb({
            snapshot_version: 1, session_id: id, host: `${id}.example`, port: 22,
            username: 'gate', display_name: id, use_tmux: true,
            tmux_session_name: `t-${id}`,
            replay_max_lines: 0, replay_total_chunks: 0,
        }));
        SessionManager.sessions[id].connected = true;
        SessionManager.sessions[id].useTmux = true;
        TerminalManager.acceptReplayChunk(id, {
            seq: 0, total: 0, data: '', final: true,
            truncated: false, dropped_bytes: 0,
        });
        (window.__socketHandlers['ssh_output'] || []).forEach(cb => cb({
            session_id: id, data: '\u001b[?1000h\u001b[?1002h\u001b[?1006h',
        }));
    }, id);
    await page.waitForTimeout(400);
}

async function switchTo(id) {
    await page.evaluate((id) => SessionManager.switchSession(id), id);
    await page.waitForTimeout(350);
}

/*
 * The server's answer to this pane's ATTACH.
 *
 * this replaces answerGeometry(). There is no geometry negotiation
 * left: reportLocalFit attaches a view carrying the measured size, and until the
 * ack lands the client holds the state 'attaching'. A fixture that never
 * acknowledges leaves every pane unattached, so a later resize would be parked
 * as a pending size instead of being sent.
 *
 * The withheld-output defect this helper used to exist for is gone with the
 * geometry hold itself: nothing queues live frames behind an answer any more, so
 * bytes reach the engine whether or not the ack has arrived (S35 P41's frozen
 * pane cannot recur).
 */
async function ackViewAttach(id) {
    await page.evaluate((id) => {
        (window.__socketHandlers['view_attached'] || []).forEach(
            cb => cb({ session_id: id }));
    }, id);
    await page.waitForTimeout(120);
}

// Enough history that a scroll gesture has somewhere to go.
async function fillHistory(id, tag) {
    await ackViewAttach(id);
    await page.evaluate(({ id, tag }) => {
        let s = '';
        for (let i = 1; i <= 200; i++) s += `${tag}-LINE-${i}\r\n`;
        (window.__socketHandlers['ssh_output'] || []).forEach(cb =>
            cb({ session_id: id, data: s }));
    }, { id, tag });
    await page.waitForTimeout(250);
}

async function stateOf(id) {
    return await page.evaluate((id) => {
        const s = SessionManager.sessions[id];
        const w = document.getElementById(s.terminalId);
        const keys = TerminalManager.sessionTerminals[id] || [];
        const t = TerminalManager.terminals[keys[0]];
        const screen = t && t.element
            ? t.element.querySelector('.xterm-screen') : null;
        const r = w.getBoundingClientRect();
        return {
            grid: t ? `${t.cols}x${t.rows}` : null,
            reported: TerminalManager.reportedSizes[id]
                ? `${TerminalManager.reportedSizes[id].cols}x${TerminalManager.reportedSizes[id].rows}`
                : null,
            screenH: screen ? Math.round(screen.getBoundingClientRect().height) : -1,
            paneTop: Math.round(r.top),
            wrapperBox: `${Math.round(r.width)}x${Math.round(r.height)}`,
            /*
             * The pane told the server what it fits. that is EITHER
             * form: the first fit of a pane carries its size on `view_attach`
             * (there is no tmux client to resize yet), and every fit after the
             * attach is an `ssh_resize`. Counting only the latter would read a
             * correctly sized first connection as never having measured itself.
             */
            proposals: window.__emits.filter(
                e => (e.ev === 'ssh_resize' || e.ev === 'view_attach')
                    && e.payload.session_id === id
                    && e.payload.cols > 0 && e.payload.rows > 0).length,
        };
    }, id);
}

/*
 * ONE vertical swipe on a session's own wrapper, and what answered it.
 *
 * "Answered" has two legitimate shapes and the gate must accept both, because
 * which one applies is decided by ScrollOwner from live terminal state: under
 * tmux `mouse on` the swipe becomes wheel bytes on the wire (tmux owns the
 * history), and without mouse tracking it moves xterm's own viewport. Asserting
 * only one would fail for a correct build in the other state.
 */
async function swipeOnce(id) {
    const r = await page.evaluate((id) => {
        const s = SessionManager.sessions[id];
        const w = document.getElementById(s.terminalId);
        const b = w.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2),
            y: Math.round(b.top + b.height / 2) };
    }, id);
    const before = await page.evaluate((id) => {
        const keys = TerminalManager.sessionTerminals[id] || [];
        const t = TerminalManager.terminals[keys[0]];
        window.__emits = window.__emits.filter(e => e.ev !== 'ssh_input');
        return t ? t.buffer.active.viewportY : null;
    }, id);
    await cdp.send('Input.dispatchTouchEvent',
        { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y - 80, id: 11 }] });
    for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: r.x, y: r.y - 80 + i * 25, id: 11 }],
        });
        await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(140);
    const after = await page.evaluate((id) => {
        const keys = TerminalManager.sessionTerminals[id] || [];
        const t = TerminalManager.terminals[keys[0]];
        return {
            viewportY: t ? t.buffer.active.viewportY : null,
            wheelBytes: window.__emits.filter(e => e.ev === 'ssh_input'
                && e.payload.session_id === id
                && /\u001b\[<6[45]/.test(e.payload.data)).length,
        };
    }, id);
    return {
        y: r.y,
        movedViewport: before !== after.viewportY,
        wheelBytes: after.wheelBytes,
        answered: before !== after.viewportY || after.wheelBytes > 0,
    };
}

// ---------------------------------------------------------------------------
// §A  the FIRST connection -- the baseline every later one has to match.
// ---------------------------------------------------------------------------
console.log('\n--- §A the first connection (baseline) ---');
await createInBackground('A');
await switchTo('A');
await fillHistory('A', 'A');
const aState = await stateOf('A');
check('§A the first session fits its pane (not the constructed 80x24)',
    aState.grid !== '80x24', true);
check('§A its .xterm-screen has a real box',
    aState.screenH > 0, true);
checkAtLeast('§A it proposed its size to the server', aState.proposals, 1);
const aSwipe = await swipeOnce('A');
check('§A one swipe is answered on the first connection', aSwipe.answered, true);
const aBaselineGrid = aState.grid;

// ---------------------------------------------------------------------------
// §B  A -> B, with B created while A owned the pane. THE gate.
// ---------------------------------------------------------------------------
console.log('\n--- §B switching to a session attached in the background ---');
await createInBackground('B');
const bHidden = await page.evaluate(() => {
    const w = document.getElementById(SessionManager.sessions['B'].terminalId);
    return { cls: w.className,
        h: Math.round(w.getBoundingClientRect().height),
        display: getComputedStyle(w).display };
});
check('§B precondition: B really was attached while hidden (display:none, 0px)',
    `${bHidden.display}/${bHidden.h}`, 'none/0');
await switchTo('B');
/*
 * S21 item 3 -- the FIRST gesture must be answered BEFORE anything else
 * touches B. Production verification taught this gate a lesson about its own
 * instrumentation (/tmp/s16work/s21_first_swipe.out): on the live box the very
 * first swipe after switching A to B was answered with twelve SGR wheel frames
 * and the pane stayed at viewportY 0, because tmux `mouse on` is the product
 * default and TMUX scrolls its own history -- so an earlier version of that row,
 * which asserted only t.buffer.active.viewportY, reported a WORKING pan as dead.
 *
 * Two consequences for this file:
 *   1. The pre-history swipe below is new. Everything under §A/§C swipes only
 *      after fillHistory() has pumped 200 lines in; those rows could pass while
 *      a dead-first-gesture defect existed and the write "woke" the path -- the
 *      Owner's exact double-toggle report. This one cannot.
 *   2. swipeOnce already records BOTH legitimate answers (wheel bytes OR local
 *      viewport), but nothing forced the gate to prove which shape applied --
 *      a build that answered NOTHING would fail `answered`, yet so would an
 *      INSTRUMENTATION drift (a stub swallowing ssh_input). The discriminant
 *      row pins the mode from live terminal state instead of trusting either
 *      counter: with tmux mouse tracking declared AND the terminal's own modes
 *      confirming it (TerminalManager.appOwnsMouse reads xterm's
 *      mouseTrackingMode directly), a TRUE answered MUST come through the wire
 *      rows, so a single-observable regression can no longer hide behind the
 *      other one.
 */
const bFirstSwipe = await swipeOnce('B');
check('§B the FIRST gesture on B -- before any write to it -- is answered',
    bFirstSwipe.answered, true);
check('§B the first-gesture answer matches the mouse owner read from xterm',
    await page.evaluate((id) => TerminalManager.appOwnsMouse(id), 'B'),
    bFirstSwipe.wheelBytes > 0 || !bFirstSwipe.movedViewport);
if (!(await page.evaluate((id) => TerminalManager.appOwnsMouse(id), 'B'))) {
    // Only when the APP owns the mouse may the answer be the local viewport;
    // assert the wire was genuinely silent then (the discriminant's other half).
    checkAtLeast('§B app-owned mouse: the answer WAS the local viewport',
        bFirstSwipe.wheelBytes === 0 && bFirstSwipe.movedViewport ? 1 : 0, 1);
}
// Non-vacuity for the wire half itself: with tracking on, a REAL SGR prefix is
// required -- any other byte shape would make `wheelBytes` lie.
const sgrShape = await page.evaluate((id) => window.__emits
    .some(e => e.ev === 'ssh_input' && e.payload.session_id === id
        && /\[<6[45];\d+;\d+[Mm]/.test(e.payload.data)), 'B');
if (bFirstSwipe.wheelBytes > 0) {
    check('§B the wire rows are genuine SGR wheel frames', sgrShape, true);
} else {
    check('§B the wire is honestly empty because the app owns the mouse',
        await page.evaluate(() => window.__emits.filter(
            e => e.ev === 'ssh_input').length), 0);
}
await fillHistory('B', 'B');
const bState = await stateOf('B');
check('§B after ONE switch B fits its pane, exactly like the first connection',
    bState.grid, aBaselineGrid);
check('§B B\'s .xterm-screen has a real box (the cell was re-measured)',
    bState.screenH > 0, true);
checkAtLeast('§B B proposed its size to the server (sync)', bState.proposals, 1);
check('§B B\'s pane is inside the viewport, not scrolled off the top',
    bState.paneTop >= 0, true);

const bSwipe1 = await swipeOnce('B');
check('§B ONE swipe is answered on B immediately -- zero double-toggle',
    bSwipe1.answered, true);
const bSwipe2 = await swipeOnce('B');
check('§B and the second swipe is answered too', bSwipe2.answered, true);
// ---------------------------------------------------------------------------
// §C  back to A, and to B again. A per-key state leak or a stale closure would
// show as one of the two going dead after the round trip.
// ---------------------------------------------------------------------------
console.log('\n--- §C the round trip keeps both sessions alive ---');
await switchTo('A');
const aAgain = await stateOf('A');
check('§C A still fits its pane after the round trip', aAgain.grid, aBaselineGrid);
check('§C A\'s pane is still inside the viewport', aAgain.paneTop >= 0, true);
const aSwipe2 = await swipeOnce('A');
check('§C one swipe is answered on A again', aSwipe2.answered, true);

await switchTo('B');
const bAgain = await stateOf('B');
check('§C B still fits its pane', bAgain.grid, aBaselineGrid);
const bSwipe3 = await swipeOnce('B');
check('§C and one swipe is still answered on B', bSwipe3.answered, true);
check('§C each session kept its OWN gesture controller (no shared key)',
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.touchScrollControllers);
        return keys.includes('A') && keys.includes('B')
            && keys.length === new Set(keys).size;
    }), true);

// ---------------------------------------------------------------------------
// §D  the composer after the switch holds ONLY B's own input, with the notepad
// holding text throughout. The directive's own wording: "composer contains only
// B terminal input".
// ---------------------------------------------------------------------------
console.log('\n--- §D composer containment across the switch ---');
// STREAMING model (fix5, owner bullet 2 — the composer's confirmed-good fix3
// contract, restored by reverting the fix4 banking regression). A trusted append
// streams to the active session's wire in real time (app.js beforeinput ->
// pendingStream -> streamBytes); Send commits only the UNSENT tail plus the CR
// that runs the line the remote already holds. This section asserts the SWITCH
// still contains each draft to its own session — no text and no bytes leak across
// a switch — which is orthogonal to when the bytes leave.
await switchTo('A');
await page.click('#mobileInput');
await page.evaluate(() => { window.__emits = []; });
await page.keyboard.insertText('A-ONLY-TEXT');
await page.waitForTimeout(80);
check("§D precondition: A's typing is in the composer box",
    await page.inputValue('#mobileInput'), 'A-ONLY-TEXT');
check("§D precondition: A's typing streamed to A's wire in real time",
    await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_input' && e.payload.session_id === 'A').length > 0), true);
check("§D and every streamed byte went to A, never elsewhere",
    await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_input').every(e => e.payload.session_id === 'A')), true);
// Notes holds its own text the whole time, through its production input event.
await page.evaluate(() => {
    const note = document.getElementById('sessionNotepad');
    const panel = document.getElementById('notepadPanel');
    if (panel) panel.classList.remove('collapsed');
    note.focus();
    note.value = 'NOTEPAD-ONLY-TEXT';
    note.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);

await switchTo('B');
const bBox = await page.inputValue('#mobileInput');
check('§D after the switch the box holds no text from A', bBox.includes('A-ONLY'), false);
check('§D and none from the notepad', bBox.includes('NOTEPAD'), false);
check('§D B starts from an empty draft', bBox, '');
await page.click('#mobileInput');
await page.evaluate(() => { window.__emits = []; });
await page.keyboard.insertText('B-INPUT');
await page.waitForTimeout(80);
check('§D typing on B is in B\'s box',
    await page.inputValue('#mobileInput'), 'B-INPUT');
check('§D B\'s typing streamed to B\'s wire, never to A',
    await page.evaluate(() => {
        const ins = window.__emits.filter(e => e.ev === 'ssh_input');
        return ins.length > 0 && ins.every(e => e.payload.session_id === 'B');
    }), true);
// Send commits the line the remote already holds: the unsent tail is empty, so
// Send is the bare CR that runs it (app.js commitTerminalDraft, fully-streamed box).
await page.evaluate(() => window.commitTerminalDraft(
    document.getElementById('mobileInput')));
await page.waitForTimeout(80);
const streamedNow = await page.evaluate(() => window.__emits
    .filter(e => e.ev === 'ssh_input')
    .map(e => `${e.payload.session_id}:${e.payload.data}`));
check("§D Send put a byte on the wire (non-vacuous)",
    streamedNow.length > 0, true);
check('§D and every byte went to B, never to A',
    streamedNow.every(row => row.startsWith('B:')), true);
check("§D Send committed B's line with the run CR",
    streamedNow.some(row => row === 'B:\r'), true);
check('§D the notepad still holds its own text (nothing was moved out of it)',
    await page.inputValue('#sessionNotepad'), 'NOTEPAD-ONLY-TEXT');
check('§D after Send the box is empty (committed draft is cleared)',
    await page.inputValue('#mobileInput'), '');
// A's line was streamed but never committed (no Send on A), so switching back
// finds A's own draft preserved — per-session, and never B's.
check('§D switching back to A restores A\'s own uncommitted draft',
    await (async () => { await switchTo('A'); return page.inputValue('#mobileInput'); })(),
    'A-ONLY-TEXT');

// ---------------------------------------------------------------------------
// §F  KB6 — CONNECTION 2/3 PARITY AS ONE WHOLE WORKFLOW: scroll state,
//     composer draft isolation and NOTE isolation together, on a third
//     connection as well as a second.
//
// §D above proves the composer is contained, and it runs in the notepad's
// GLOBAL scope, where one text is correct everywhere and must NOT be refetched
// on a switch. The scope the owner's report actually implicates is PER-SERVER:
// there the note belongs to one connection, so a switch has to REBIND it.
// Nothing in this suite -- or any other -- had ever entered that scope, so the
// whole session-scoped note path was untested.
//
// Two things are asserted that no existing row covers, and both are about
// WHEN the note's owner is decided:
//
//   §F.2  the debounced save reads `currentNotepadTarget` at FIRE time
//         (app.js:5857), 300ms after the text was captured at input time
//         (app.js:5845). A switch inside that window therefore writes the text
//         typed for connection #1 into connection #2's bucket.
//   §F.3  adoptNotepadFrame's "protect focused editor while actively typing"
//         guard (app.js:1489) returns for EVERY non-self-echo frame, including
//         the switch refetch that refreshNotepadHost just asked for
//         (app.js:5756-5761). So the box keeps showing the previous
//         connection's note while the user is on the new one.
//
// The harness owes the page the server's replies, because there is no server:
// `notepad_data` is delivered exactly as socket_events sends it, carrying the
// mode/target the request asked for, which is what adoptNotepadFrame gates on.
// ---------------------------------------------------------------------------
console.log('\n--- §F KB6 connection 2/3 parity: scroll, composer, notes ---');

await createInBackground('C');
await switchTo('C');
await fillHistory('C', 'C');

// Open the panel and enter PER-SERVER scope through the real control.
await page.evaluate(() => {
    document.getElementById('notepadPanel')?.classList.remove('collapsed');
});
/*
 * The scope control is dispatched on the ELEMENT, not through a hit test. At
 * this 390px viewport the panel sits under #workspace, which intercepts pointer
 * events -- that is the mobile panel's own layout question and belongs to §E and
 * to owner bullet 2, not here. This section is about what the note logic does
 * once the scope is per-server, so it drives the production click listener
 * directly and makes no claim about the affordance's reachability.
 */
await page.evaluate(() =>
    document.getElementById('notepadModeServerBtn')?.click());
await page.waitForTimeout(150);
check('§F GUARD the panel really is in per-server scope',
    await page.getAttribute('#notepadModeServerBtn', 'aria-checked'), 'true');

// The server's reply, shaped as socket_events emits it.
async function deliverNote(target, text, revision = 1) {
    await page.evaluate(({ t, x, r }) => {
        (window.__socketHandlers['notepad_data'] || []).forEach(cb => cb({
            mode: 'per_server', target_id: t, notepad: x, revision: r,
            stored_mode: 'per_server',
        }));
    }, { t: target, x: text, r: revision });
    await page.waitForTimeout(120);
}
const noteBox = () => page.inputValue('#sessionNotepad');
const lastGetNote = () => page.evaluate(() => {
    const rows = window.__emits.filter(e => e.ev === 'get_notepad');
    return rows.length ? (rows[rows.length - 1].payload || null) : null;
});

/*
 * §F.1 — each connection shows ITS OWN note. Seeded per session while that
 * session is active, so the frame's target matches what adoptNotepadFrame
 * requires; then re-visited to prove the rebind, not the seeding.
 */
for (const [id, text] of [['A', 'NOTE-FOR-A'], ['B', 'NOTE-FOR-B'], ['C', 'NOTE-FOR-C']]) {
    await switchTo(id);
    // Nothing focused, no pending save: the plain rebind path.
    await page.evaluate(() => document.getElementById('sessionNotepad')?.blur());
    await deliverNote(id, text);
    check(`§F.1 ${id}'s own note is on screen while ${id} is active`,
        await noteBox(), text);
    const req = await lastGetNote();
    check(`§F.1 the switch to ${id} asked the server for ${id}'s bucket`,
        req && req.mode === 'per_server' && req.target_id === id, true);
}

/*
 * §F.2 THE RED — a switch inside the 300ms save debounce must not move the text
 * to the new connection. The text was typed FOR A; whatever bucket it lands in
 * must be A's.
 */
await switchTo('A');
await deliverNote('A', 'NOTE-FOR-A');
await page.evaluate(() => { window.__emits = []; });
await page.evaluate(() => {
    const note = document.getElementById('sessionNotepad');
    note.focus();
    note.value = 'TYPED-WHILE-ON-A';
    note.dispatchEvent(new Event('input', { bubbles: true }));
});
// Switch INSIDE the debounce window (the timer is 300ms; switchTo waits 350ms
// afterwards, so the save fires during the switch, which is the race).
await page.waitForTimeout(60);
await switchTo('B');
await page.waitForTimeout(400);
const saves = await page.evaluate(() => window.__emits
    .filter(e => e.ev === 'save_notepad')
    .map(e => ({ target: e.payload.target_id, text: e.payload.text })));
num('§F.2 save_notepad frames emitted across the switch', saves);
check('§F.2 GUARD the debounced save really did fire (non-vacuous)',
    saves.length > 0, true);
check('§F.2 THE RED: text typed on A is never saved into another connection’s bucket',
    saves.every(s => !(s.text === 'TYPED-WHILE-ON-A' && s.target !== 'A')), true);
check('§F.2 and it is saved for A, the connection it was typed for',
    saves.some(s => s.text === 'TYPED-WHILE-ON-A' && s.target === 'A'), true);

/*
 * §F.2b THE RED, THE OTHER ORDER — the switch's refetch reply can arrive BEFORE
 * the 300ms save fires. adoptNotepadFrame then reaches its
 * `if (notepadPendingSaveTimer) { clearTimeout(...) }` (app.js:1493-1496) and
 * cancels it. Clearing is right for a frame about the SAME bucket -- it is a
 * fresher truth for that text -- but this frame is about ANOTHER connection, so
 * the edit the user made on A is discarded and never reaches the server at all.
 * Same root as §F.2: a pending save carries no record of whose text it is.
 */
await switchTo('A');
await deliverNote('A', 'NOTE-FOR-A', 7);
await page.evaluate(() => { window.__emits = []; });
await page.evaluate(() => {
    const note = document.getElementById('sessionNotepad');
    note.focus();
    note.value = 'EDITED-ON-A-THEN-LEFT';
    note.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(40);
await page.evaluate(() => SessionManager.switchSession('B'));
// The reply lands INSIDE the debounce window, which is the race.
await page.waitForTimeout(40);
await deliverNote('B', 'NOTE-FOR-B', 3);
await page.waitForTimeout(500);
const saves2 = await page.evaluate(() => window.__emits
    .filter(e => e.ev === 'save_notepad')
    .map(e => ({ target: e.payload.target_id, text: e.payload.text,
        base: e.payload.base_revision })));
num('§F.2b save_notepad frames when the reply beats the timer', saves2);
check('§F.2b THE RED: an edit made on A is not discarded by B’s refetch',
    saves2.some(x => x.text === 'EDITED-ON-A-THEN-LEFT'), true);
check('§F.2b THE RED: and it is saved for A, against A’s own revision',
    saves2.some(x => x.text === 'EDITED-ON-A-THEN-LEFT'
        && x.target === 'A' && x.base === 7), true);

/*
 * §F.3 THE RED — and B's own note must reach the box. The request went out on
 * the switch; the reply is delivered here exactly as the server would.
 */
await deliverNote('B', 'NOTE-FOR-B');
const bNote = await noteBox();
num('§F.3 the note box after switching to B mid-save', bNote);
check('§F.3 THE RED: the box does not still show what was typed on A',
    bNote.includes('TYPED-WHILE-ON-A'), false);
check('§F.3 THE RED: B’s own note is on screen', bNote, 'NOTE-FOR-B');

/*
 * §F.4 — scroll state on connection #2 AND #3, in the same journey as the note
 * and composer rows above, which is what "whole workflow" means here: the
 * earlier sections proved these one at a time on a fresh page.
 */
for (const id of ['B', 'C']) {
    await switchTo(id);
    const sw = await swipeOnce(id);
    const after = await stateOf(id);
    /*
     * WHICH SHAPE COUNTS IS NOT OURS TO PICK. This fixture declares tmux
     * `mouse on` (createInBackground sends the DECSETs tmux's own preamble
     * sends), so ScrollOwner routes the swipe to the WIRE as SGR wheel bytes and
     * the engine's own viewportY deliberately does NOT move -- see swipeOnce's
     * docstring. Asserting viewportY movement here would fail a correct build,
     * so the reachability row reads the same evidence §B does: the swipe was
     * answered, and the bytes it produced are genuine wheel frames for THIS
     * session.
     */
    num(`§F.4 ${id} swipe answer`, { movedViewport: sw.movedViewport,
        wheelBytes: sw.wheelBytes, answered: sw.answered });
    check(`§F.4 connection ${id} answers a swipe with no double-toggle`,
        sw.answered, true);
    check(`§F.4 connection ${id} fits its pane, like the first connection`,
        after.grid, aBaselineGrid);
    check(`§F.4 connection ${id} kept its history reachable across the workflow`,
        sw.wheelBytes > 0 || sw.movedViewport, true);
}

/*
 * §F.5 — composer draft isolation across THREE connections, after all the note
 * traffic above. §D proved two; the owner's report is about #2 and #3.
 */
// STREAMING model (fix5): typing streams to THIS connection's wire in real time.
// §F.5 proves draft ISOLATION — each connection's bytes reach only its own wire,
// and Send commits (and clears) that connection's line without touching another.
for (const id of ['A', 'B', 'C']) {
    await switchTo(id);
    // Start each connection from a clean line: §D left A holding an uncommitted
    // draft, so commit whatever is banked here before the isolation probe. The
    // commit is per-active-session and cannot cross to another connection.
    await page.evaluate(() => window.commitTerminalDraft(document.getElementById('mobileInput')));
    await page.click('#mobileInput');
    await page.evaluate(() => { window.__emits = []; });
    await page.keyboard.insertText(`DRAFT-${id}`);
    await page.waitForTimeout(80);
    // Typing streamed live, and only to this connection.
    const typed = await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_input')
        .map(e => `${e.payload.session_id}:${e.payload.data}`));
    check(`§F.5 connection ${id} streamed its typing live to its own wire`,
        typed.length > 0, true);
    check(`§F.5 connection ${id}'s typing went only to ${id}`,
        typed.every(row => row.startsWith(`${id}:`)), true);
    check(`§F.5 connection ${id}'s draft is in the box`,
        await page.inputValue('#mobileInput'), `DRAFT-${id}`);
    // Send commits this connection's line (the run CR) — to this connection only.
    await page.evaluate(() => { window.__emits = []; });
    await page.evaluate(() => window.commitTerminalDraft(document.getElementById('mobileInput')));
    await page.waitForTimeout(80);
    const streamed = await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_input')
        .map(e => `${e.payload.session_id}:${e.payload.data}`));
    check(`§F.5 Send committed ${id}'s line to the wire (non-vacuous)`,
        streamed.length > 0, true);
    check(`§F.5 Send went only to ${id}, never to another connection`,
        streamed.every(row => row.startsWith(`${id}:`)), true);
    check(`§F.5 connection ${id}'s box is empty after Send`,
        await page.inputValue('#mobileInput'), '');
}
const drafts = {};
for (const id of ['A', 'B', 'C']) {
    await switchTo(id);
    drafts[id] = await page.inputValue('#mobileInput');
}
num('§F.5 each connection’s box after the whole workflow', drafts);
check('§F.5 every connection’s box is empty, none holds another’s text',
    drafts.A === '' && drafts.B === '' && drafts.C === '', true);

// ---------------------------------------------------------------------------
// §E  the shell's hidden scrollers. Focusing Notes must not leave the terminal
// pane above the viewport, and the reset must not touch the horizontal pan.
// ---------------------------------------------------------------------------
console.log('\n--- §E the pane stays on screen when Notes takes focus ---');
{
    const before = await page.evaluate(() => {
        const ws = document.getElementById('workspace');
        const w = document.getElementById(SessionManager.sessions['A'].terminalId);
        return { ws: Math.round(ws.scrollTop),
            paneTop: Math.round(w.getBoundingClientRect().top) };
    });
    check('§E precondition: nothing is offset to begin with', before.ws, 0);
    await page.evaluate(() => {
        document.getElementById('sessionNotepad').focus();
    });
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
        const ws = document.getElementById('workspace');
        const w = document.getElementById(SessionManager.sessions['A'].terminalId);
        return { ws: Math.round(ws.scrollTop),
            paneTop: Math.round(w.getBoundingClientRect().top),
            overflowY: getComputedStyle(ws).overflowY };
    });
    check('§E #workspace is overflow-y:hidden, so an offset could never be undone',
        after.overflowY, 'hidden');
    check('§E focusing Notes leaves #workspace unscrolled', after.ws, 0);
    check('§E so the terminal pane is still on screen',
        after.paneTop, before.paneTop);

    /*
     * The companion row, and the reason the reset is scrollTOP only: the
     * terminal wrapper's own scrollLeft IS the horizontal pan (O3/D-4'), which
     * the Owner confirmed working in production. A reset that zeroed scrollLeft
     * would silently destroy it, and every other row here would still pass.
     */
    const pan = await page.evaluate(() => {
        const w = document.getElementById(SessionManager.sessions['A'].terminalId);
        w.scrollLeft = 40;
        const written = w.scrollLeft;
        // Provoke the reset through the same event the shell listens on.
        document.getElementById('sessionNotepad').focus();
        document.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('scroll'));
        return { written, after: w.scrollLeft };
    });
    if (pan.written > 0) {
        check('§E the horizontal pan survives the scroll reset',
            pan.after, pan.written);
    } else {
        // A pane that is not pannable right now cannot carry a pan; say so
        // rather than assert a vacuous equality.
        check('§E (pane not pannable in this state -- pan row not applicable)',
            pan.after, 0);
    }
}

check('§Z no page errors', errors.join(' | '), '');


// ---------------------------------------------------------------------------
// §G  SWITCH-CONNECT-TWICE — the Owner's KB6 tail, as a whole workflow.
//
// "On mobile, switching to a different Connect loses touch scrolling/gestures
// until you switch back and forth twice." Everything §A-§F measure about a
// switch is state: the grid, the box, the note, the draft. None of them put a
// FINGER on the pane the switch just brought forward, which is the only way this
// claim can be seen at all.
//
// The shape is deliberately asymmetric: the same gesture is measured on the
// FIRST arrival at a connection and again after a second round trip to it. A
// build where both answer has no defect; a build where only the second answers
// is exactly the Owner's report, and the diagnostics printed with each step say
// WHICH link of the chain broke rather than only that it did.
// ---------------------------------------------------------------------------
console.log('\n--- §G switch-connect-twice: does the gesture survive a switch ---');

async function gestureDiag(id) {
    return await page.evaluate((id) => {
        const s = SessionManager.sessions[id];
        const w = document.getElementById(s.terminalId);
        const keys = TerminalManager.sessionTerminals[id] || [];
        const t = TerminalManager.terminals[keys[0]];
        const xt = w ? w.querySelector('.xterm') : null;
        const screen = w ? w.querySelector('.xterm-screen') : null;
        const b = w ? w.getBoundingClientRect() : null;
        const cx = b ? Math.round(b.left + b.width / 2) : -1;
        const cy = b ? Math.round(b.top + b.height / 2) : -1;
        const hit = (b && b.width > 0 && b.height > 0)
            ? document.elementFromPoint(cx, cy) : null;
        return {
            wrapperInDoc: !!(w && document.contains(w)),
            unassigned: !!(w && w.classList.contains('unassigned')),
            display: w ? getComputedStyle(w).display : null,
            visibility: w ? getComputedStyle(w).visibility : null,
            rect: b ? `${Math.round(b.width)}x${Math.round(b.height)}@`
                + `${Math.round(b.left)},${Math.round(b.top)}` : null,
            insidePane: !!(w && w.closest && w.closest('.terminal-pane')),
            paneActive: !!(w && w.closest && w.closest('.terminal-pane')
                && w.closest('.terminal-pane').classList.contains('active')),
            // Does the centre of the pane actually resolve to this wrapper?
            hitIsInsideWrapper: !!(hit && w && (w === hit || w.contains(hit))),
            hitId: hit ? (hit.id || hit.className || hit.tagName) : null,
            // The gesture handlers themselves.
            controllerKeys: Object.keys(TerminalManager.touchScrollControllers || {}),
            hasController: !!(TerminalManager.touchScrollControllers || {})[keys[0]],
            grid: t ? `${t.cols}x${t.rows}` : null,
            screenH: screen ? Math.round(screen.getBoundingClientRect().height) : -1,
            xtermH: xt ? Math.round(xt.getBoundingClientRect().height) : -1,
            baseY: t ? t.buffer.active.baseY : -1,
            viewportY: t ? t.buffer.active.viewportY : -1,
            touchAction: w ? getComputedStyle(w).touchAction : null,
            activeSession: SessionManager.activeSessionId,
        };
    }, id);
}

const gestureStep = async (id, label) => {
    const diag = await gestureDiag(id);
    const sw = await swipeOnce(id);
    console.log(`      §G ${label}: swipe=${JSON.stringify(sw)}`);
    console.log(`      §G ${label}: diag=${JSON.stringify(diag)}`);
    return { diag, sw };
};

await createInBackground('G2');
await switchTo('G2');
await fillHistory('G2', 'G2');
// Back to the first connection, so 'G2' is a connection we ARRIVE AT by
// switching rather than one we happen to be sitting on.
await switchTo('A');
await page.waitForTimeout(200);

// (1) The baseline: the gesture works on the connection we are on.
const first = await gestureStep('A', 'on A before any switch');
check('§G GUARD the baseline gesture is answered at all (non-vacuous)',
    first.sw.answered, true);
check('§G GUARD A really holds history to scroll', first.diag.baseY > 0, true);

// (2) THE CLAIM: switch to another Connect, then put a finger on its pane.
await switchTo('G2');
const arrive1 = await gestureStep('G2', 'first arrival at G2');
check('§G the switched-to connection is the active session',
    arrive1.diag.activeSession, 'G2');
check('§G GUARD its pane is on screen and hit-testable',
    `${arrive1.diag.display}/${arrive1.diag.hitIsInsideWrapper}`, 'block/true');
check('§G THE CLAIM: a gesture on the FIRST arrival is answered',
    arrive1.sw.answered, true);

// (3) The Owner's workaround: back and forth a second time.
await switchTo('A');
await page.waitForTimeout(200);
await switchTo('G2');
const arrive2 = await gestureStep('G2', 'second arrival at G2');
check('§G a gesture on the SECOND arrival is answered too',
    arrive2.sw.answered, true);
check('§G and the two arrivals behave IDENTICALLY (no two-switch ritual)',
    `${arrive1.sw.answered}/${arrive1.sw.wheelBytes > 0}`,
    `${arrive2.sw.answered}/${arrive2.sw.wheelBytes > 0}`);

// (4) The connection we LEFT must still answer when we come back to it, and it
// must not have been left with stranded handlers: a second handler set on one
// wrapper answers a single swipe twice.
await switchTo('A');
const backOnA = await gestureStep('A', 'back on A after two round trips');
check('§G the connection we left still answers a gesture',
    backOnA.sw.answered, true);
check('§G one swipe is answered ONCE, not twice (no stacked handlers)',
    backOnA.sw.wheelBytes, first.sw.wheelBytes);
check('§G there is exactly one gesture controller per live terminal',
    backOnA.diag.controllerKeys.length,
    (await page.evaluate(() => Object.keys(TerminalManager.terminals).length)));

/*
 * (5) THE ROOT OF THE OWNER'S REPORT, and it is not the gesture.
 *
 * Every row above says the gesture FIRES: 11 SGR wheel frames reach the wire on
 * the first arrival exactly as on the fourth. Under tmux `mouse on` -- the
 * product default -- that is all the client does: tmux owns history, so the
 * scroll the user SEES is the repaint tmux sends back as `ssh_output`. So the
 * question "did touch scrolling work" is answered by whether that repaint
 * reaches the screen.
 *
 * WHAT IT USED TO BE, and why the rows below are now short. A switch armed a
 * GEOMETRY HOLD: setActivePane made the arriving pane visible, the
 * ResizeObserver refit it, reportLocalFit armed the hold before emitting
 * ssh_resize, and until the server answered, writeOutput queued every live
 * frame. Measured (/tmp/s35/probe_scrollback.mjs): after the switch held=true;
 * swipe wheelBytes=11, answered=true; repaint on screen FALSE with 21 bytes in
 * the hold; the answer arrives and the repaint appears. That was the Owner's
 * sentence exactly -- the gesture is not lost, the ANSWER to it is withheld --
 * and a second switch re-proposed, produced an answer, drained the queue, hence
 * "switch back and forth twice and it works".
 *
 *: there is no hold and no answer to wait for. A view is this
 * socket's own tmux client, so nothing about its size is negotiated and nothing
 * queues output. The rows below therefore assert the END STATE the owner wanted
 * -- the swipe reaches the wire and its repaint is painted immediately, with no
 * second switch and no answer needed.
 */
const FRESH = 'G3';
await connectViaHandler(FRESH);
await switchTo('A');
await ackViewAttach('A');
await switchTo(FRESH);
await page.waitForTimeout(200);

const swipeOnArrival = await swipeOnce(FRESH);
check('§G GUARD the gesture itself DOES reach the wire (it is not the gesture)',
    swipeOnArrival.wheelBytes > 0, true);

// tmux answers the wheel with a repaint, the way it does on the real wire.
await page.evaluate((id) => (window.__socketHandlers['ssh_output'] || []).forEach(cb =>
    cb({ session_id: id, data: 'SCROLLED-BY-THE-SWIPE\r\n' })), FRESH);
await page.waitForTimeout(200);
const painted = async () => await page.evaluate((id) => {
    const t = TerminalManager.terminals[(TerminalManager.sessionTerminals[id] || [])[0]];
    const b = t.buffer.active;
    for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        if (l && l.translateToString(true).includes('SCROLLED-BY-THE-SWIPE')) return true;
    }
    return false;
}, FRESH);
const onScreenFirst = await painted();
console.log(`      §G repaint on screen after the swipe = ${onScreenFirst}`);
check('§G THE DEFECT: what the gesture scrolled is PAINTED, not withheld',
    onScreenFirst, true);
// And it is painted on the FIRST arrival, with no ack and no second switch --
// the "switch back and forth twice" ritual has nothing left to fix.
check('§G the pane is not even attached yet, and the bytes still landed',
    await page.evaluate((id) => TerminalManager.views[id], FRESH), 'attaching');

await ctx.close();
await browser.close();
server.close();
console.log(`\nsession_switch_init: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
