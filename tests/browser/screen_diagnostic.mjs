#!/usr/bin/env node
/*
 * THE SCREEN DIAGNOSTIC: what the engine was given, ready to be sent.
 *
 * Owner,: the omp pane showed its prompt row fifty times while
 * `tmux capture-pane` on the host held it once. The host was clean, the raw
 * tmux stream replayed clean into a bare engine, the app's write path was
 * clean when driven synchronously -- and the bytes the browser had actually
 * been handed at the moment it went wrong were gone. This gate pins the
 * client half of the recording that makes the next occurrence replayable:
 *
 *   §1 every string written to the engine lands in the session's tail, in
 *      order, through the live path AND the client-control path, and the tail
 *      is cut to the last STREAM_TAIL_MAX chars;
 *   §2 sendScreenDiagnostic emits the tail with the engine's own account of
 *      the session (grid, buffer, offsets, sizes, the visible rows);
 *   §3 the button exists only with ?kbdebug=1, is pressable (it is NOT inside
 *      the pointer-events:none panel), and sends the ACTIVE session;
 *   §4 the server's answer is shown as a notification, success or refusal;
 *   §5 the tail is released with the terminal;
 *   §6 the timeline: what happened around the capture, in order, as counts
 *      and flags (never the bytes), merged while a stream runs, bounded, and
 *      this session's own entries with the page-wide ones;
 *   §7 the paint: what the DOM shows next to what the buffer holds, and
 *      whether a held frame covers the pane.
 *
 * Run: node tests/browser/screen_diagnostic.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{%\s*include\s*'([^']+)'\s*%\}/g,
        (_, f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
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
            res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return;
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

const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {}; window.__notes = [];
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        connect: noop,
    };
    window.io = () => window.socket;
    window.showNotification = (message, kind) => { window.__notes.push([message, kind]); };
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);

async function open(query) {
    await page.goto(base + query, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
}
async function mount(id) {
    await page.evaluate(id => {
        const host = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = `term-${id}`;
        el.className = 'terminal-wrapper';
        el.style.width = '900px';
        el.style.height = '520px';
        host.appendChild(el);
        SessionManager.activeSessionId = id;
        TerminalManager.createTerminal(id);
        TerminalManager.attachTerminal(id, `term-${id}`);
        TerminalManager.views[id] = 'attached';
    }, id);
    await page.waitForTimeout(600);
}

/* ---------------------------------------------------------- §1 the tail */
await open('/?kbdebug=1');
const S = 'diag-a';
await mount(S);
const tail = await page.evaluate(id => {
    const max = TerminalManager.STREAM_TAIL_MAX;
    TerminalManager.writeOutput(id, 'first ');
    TerminalManager.writeControlNow(id, '\x1b[?1049l');
    TerminalManager.writeOutput(id, 'second\r\n');
    const ordered = TerminalManager.streamTail[id];
    TerminalManager.writeOutput(id, 'x'.repeat(max));
    TerminalManager.writeOutput(id, 'END');
    const cut = TerminalManager.streamTail[id];
    return { max, ordered, cutLength: cut.length, cutEnd: cut.slice(-6) };
}, S);
check('§1 STREAM_TAIL_MAX is 64 KB', tail.max, 65536);
check('§1 live output and client control land in the tail, in order',
    tail.ordered, 'first \x1b[?1049lsecond\r\n');
check('§1 the tail keeps the LAST STREAM_TAIL_MAX chars',
    [tail.cutLength, tail.cutEnd], [65536, 'xxxEND']);
await page.waitForTimeout(300);

/* ------------------------------------------------------ §2 the payload */
const sent = await page.evaluate(async id => {
    const key = (TerminalManager.sessionTerminals[id] || [])[0];
    const term = TerminalManager.terminals[key];
    // xterm parses asynchronously: the rows are read once the write is done.
    await new Promise(r => term.write('\x1b[2J\x1b[H$ prompt here', r));
    TerminalManager.noteWindowGeometry(id, term.cols, term.rows);
    TerminalManager.reportedSizes[id] = { cols: 111, rows: 33, epoch: 0 };
    window.__emits.length = 0;
    const ok = TerminalManager.sendScreenDiagnostic(id);
    const e = window.__emits.find(x => x.ev === 'screen_diagnostic');
    if (!e) return { ok, emitted: false };
    const p = e.payload, g = p.engine;
    return {
        ok, emitted: true,
        session: p.session_id, tailLength: p.tail.length,
        tailMatches: p.tail === TerminalManager.streamTail[id],
        grid: [g.cols, g.rows], buffer: g.buffer, unicode: g.unicode,
        rowsMatch: g.screen.length === term.rows,
        firstRow: g.screen[0].trim(),
        window: g.window, reported: g.reported, view: g.view,
        numbers: ['baseY', 'viewportY', 'cursorX', 'cursorY', 'fontSize', 'tailChars']
            .every(k => typeof g[k] === 'number'),
        agent: typeof g.agent === 'string' && g.agent.length > 0,
    };
}, S);
check('§2 sendScreenDiagnostic emits screen_diagnostic for the session',
    [sent.ok, sent.emitted, sent.session], [true, true, S]);
check('§2 the tail travels whole', [sent.tailMatches, sent.tailLength], [true, 65536]);
check('§2 the engine report carries grid, buffer, Unicode version and the visible rows',
    [sent.grid.length, sent.buffer, sent.unicode, sent.rowsMatch, sent.firstRow],
    [2, 'normal', '11', true, '$ prompt here']);
check('§2 the sizes the engine announced and was given, and the view state',
    [sent.window, sent.reported, sent.view],
    [{ cols: sent.grid[0], rows: sent.grid[1] }, { cols: 111, rows: 33 }, 'attached']);
check('§2 the offsets are numbers and the agent is named', [sent.numbers, sent.agent], [true, true]);

/* ------------------------------------------------------- §3 the button */
const button = await page.evaluate(id => {
    const btn = document.getElementById('screenDiagnosticBtn');
    if (!btn) return { present: false };
    const panel = document.getElementById('kbdebugPanel');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    window.__emits.length = 0;
    btn.click();
    const e = window.__emits.find(x => x.ev === 'screen_diagnostic');
    return {
        present: true, insidePanel: !!(panel && panel.contains(btn)),
        hit: top === btn, label: btn.textContent,
        sentActive: e ? e.payload.session_id : null,
    };
}, S);
check('§3 with ?kbdebug=1 the button exists, outside the pointer-events:none panel, and is hit-testable',
    [button.present, button.insidePanel, button.hit], [true, false, true]);
check('§3 the button sends the ACTIVE session', button.sentActive, S);
check('§3 the label is translated', button.label, 'Send screen diagnostic');

/* ------------------------------------------------------- §4 the answer */
const notes = await page.evaluate(id => {
    // app.js installs the real showNotification at load; the handler reads
    // window.showNotification at call time, so a recorder can stand in here.
    window.__notes.length = 0;
    window.showNotification = (message, kind) => { window.__notes.push([message, kind]); };
    window.__server('screen_diagnostic_saved', { session_id: id, name: 'screen-x.json', host_rows: 3 });
    window.__server('screen_diagnostic_saved', { session_id: id, error: 'rate_limited' });
    return window.__notes;
}, S);
check('§4 the saved answer and the refusal are both shown', notes, [
    ['Screen diagnostic saved: screen-x.json', 'success'],
    ['Screen diagnostic not saved (rate_limited)', 'error'],
]);

/* ------------------------------------------------------ §5 the release */
const released = await page.evaluate(id => {
    TerminalManager.destroyTerminal(id);
    return Object.prototype.hasOwnProperty.call(TerminalManager.streamTail, id);
}, S);
check('§5 destroyTerminal releases the tail', released, false);

/* -------------------------------------------- §3b without the switch */
await open('/');
await mount('diag-b');
const plain = await page.evaluate(() => ({
    button: !!document.getElementById('screenDiagnosticBtn'),
    tail: typeof TerminalManager.streamTail['diag-b'],
}));
check('§3 without ?kbdebug=1 there is no button, though the tail is still kept',
    plain, { button: false, tail: 'undefined' });
await page.evaluate(() => { TerminalManager.writeOutput('diag-b', 'kept'); });
check('§3 ... kept from the first write on',
    await page.evaluate(() => TerminalManager.streamTail['diag-b']), 'kept');
await page.evaluate(() => TerminalManager.destroyTerminal('diag-b'));

/*
 * The terminals above stack in one container, so a new one sits below the
 * viewport, where xterm does not render at all -- measured: the pane at
 * y=1871 in an 860px page, 3 rows in the buffer and 0 painted in the DOM,
 * which is exactly what §7 exists to report. These two are moved to the top
 * of the container instead. Not position:fixed -- that leaves offsetParent
 * null, isTerminalVisible reads the pane as hidden, and applyWindowGeometry
 * skips it.
 */
async function mountInView(id) {
    await mount(id);
    await page.evaluate(id => {
        const el = document.getElementById(`term-${id}`);
        el.parentElement.prepend(el);
    }, id);
    await page.waitForTimeout(300);
}

/* ---------------------------------------------------- §6 the timeline */
await mountInView('diag-t');
const tl = await page.evaluate(async (id) => {
    const tm = TerminalManager;
    tm.timeline.length = 0;
    tm.noteTimeline('elsewhere', 'resize', { cols: 1, rows: 1 });
    tm.writeOutput(id, 'hello ');
    tm.writeOutput(id, 'world\r\n');
    tm.writeControlNow(id, '\x1b[?1049h');
    // A GROW: a shrink that leaves no wide row behind releases its cover at
    // once (nothing to hide), so it could not show a held frame at all.
    const term = tm.terminals[id];
    tm.noteWindowGeometry(id, term.cols + 10, term.rows);
    await new Promise(r => setTimeout(r, 80));
    // ?. throughout: a missing record must report its rows, not crash the gate.
    const coveredWhileHeld = tm.paintEvidence(id)?.covered;
    tm.releaseFrozenPane(id);
    window.__server('disconnect', 'transport close');
    window.__server('connect');
    document.dispatchEvent(new Event('visibilitychange'));
    const report = tm.screenDiagnosticReport(id);
    for (let i = 0; i < 450; i += 1) tm.noteTimeline(id, 'filler', { i });
    return {
        types: report.timeline.map(e => e.e + (e.src ? ':' + e.src : '')
            + (e.e === 'socket' ? ':' + e.up : '')),
        out: report.timeline.find(e => e.e === 'write' && e.src === 'out'),
        ctl: report.timeline.find(e => e.e === 'write' && e.src === 'ctl'),
        sessions: [...new Set(report.timeline.map(e => e.s))],
        text: JSON.stringify(report.timeline),
        ring: [tm.timeline.length, tm.timeline[tm.timeline.length - 1].i],
        coveredWhileHeld,
        coveredAfter: report.paint?.covered,
    };
}, 'diag-t');
const inOrder = (seq, want) => {
    let at = 0;
    for (const item of seq) if (item === want[at]) at += 1;
    return at === want.length;
};
check('§6 writes, geometry, cover, resize, uncover, socket and page are recorded in order',
    inOrder(tl.types, ['write:out', 'write:ctl', 'geometry', 'cover', 'resize',
        'uncover', 'socket:0', 'socket:1', 'page']), true);
check('§6 the buffer switch the control write caused is recorded after it',
    tl.types.indexOf('buffer') > tl.types.indexOf('write:ctl'), true);
check('§6 two writes in a row are one entry: count, bytes, printable',
    [tl.out?.k, tl.out?.n, tl.out?.p], [2, 13, 11]);
check('§6 the alternate-screen switch is flagged, and has nothing printable',
    [tl.ctl?.enter, tl.ctl?.p], [1, 0]);
check('§6 no byte of what was written is kept', /hello|world/.test(tl.text), false);
check("§6 another session's entries stay out of this session's report",
    tl.sessions.every(s => s === '' || s === 'diag-t'), true);
check('§6 the ring keeps the newest TIMELINE_MAX entries', tl.ring, [400, 449]);

/* ------------------------------------------------------- §7 the paint */
await mountInView('diag-p');
const paint = await page.evaluate(async (id) => {
    const tm = TerminalManager;
    tm.writeOutput(id, 'one\r\ntwo\r\nthree');
    await new Promise(r => setTimeout(r, 150));
    const report = tm.screenDiagnosticReport(id);
    return {
        paint: report.paint,
        bufferPainted: report.screen.filter(r => r.trim()).length,
        rows: report.rows,
    };
}, 'diag-p');
check('§7 the DOM rows are counted, one per grid row', paint.paint?.domRows, paint.rows);
check('§7 what the DOM paints matches what the buffer holds (and is not nothing)',
    [paint.paint?.domPainted, paint.bufferPainted], [3, 3]);
check('§7 a held frame is reported while it covers the pane, and not after',
    [tl.coveredWhileHeld >= 0, tl.coveredAfter], [true, -1]);
check('§7 the screen and pane rects, the page state and the element are there',
    [paint.paint?.screen?.length, paint.paint?.pane?.length, paint.paint?.page, paint.paint?.connected],
    [4, 4, 'visible', true]);

check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`screen_diagnostic: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
