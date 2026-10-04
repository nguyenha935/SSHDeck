#!/usr/bin/env node
/*
 * THE PERFORMANCE PROBE (static/js/perf-probe.js, `?perf=1`) -- audit
 * 2026-10-04: what typing and scrolling cost on the owner's machines.
 *
 * Sections:
 *   §1  off unless asked: no probe, no report, nothing listening
 *   §2  `?perf=1` turns it on and the device remembers; `?perf=0` turns it off
 *   §3  input to echo: the time from an ssh_input to that session's next
 *       output, and to the frame after it is painted
 *   §4  what is counted: output volume, the glyphs a monospace font may lack,
 *       wheels over the terminal, the grid on screen
 *   §5  the record: every field one the server keeps whole; the machine's
 *       details once; the round trip from the previous ack; the transport
 *   §6  no content: neither typed nor received text reaches a report
 *   §7  a minute without activity sends nothing; a minute with some sends one
 *   §8  the app is untouched: output still reaches the terminal
 *   §Z  no page errors
 *
 * Run: node tests/browser/perf_probe.mjs   (from source/)
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
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
}
function between(label, actual, low, high) {
    const ok = actual >= low && actual <= high;
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (${actual} in [${low}, ${high}])`);
}

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
 * A socket.io stand-in with what the probe listens on (onAny, onAnyOutgoing,
 * the engine's transport) and acks. Attach and resize are answered the way
 * the real server does, so the session's terminal is drawn.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {}; window.__any = []; window.__anyOut = [];
    window.__ackDelay = 30;
    const geometry = (p) => setTimeout(() => window.__server('tmux_window_geometry',
        { session_id: p.session_id, cols: p.cols, rows: p.rows }), 10);
    window.socket = {
        connected: true, connect: noop, off: noop,
        io: { on: noop, engine: { transport: { name: 'websocket' } } },
        on: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        once: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        onAny: (fn) => window.__any.push(fn),
        onAnyOutgoing: (fn) => window.__anyOut.push(fn),
        emit: (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            window.__anyOut.forEach(fn => fn(ev, payload));
            if (ev === 'view_attach') {
                setTimeout(() => window.__server('view_attached', { session_id: payload.session_id }), 10);
                geometry(payload);
            }
            if (ev === 'ssh_resize') geometry(payload);
            if (typeof ack === 'function') setTimeout(() => ack({ ok: true }), window.__ackDelay);
        },
    };
    window.io = () => window.socket;
    window.__server = (ev, payload) => {
        window.__any.forEach(fn => fn(ev, payload));
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'aaaa1111-perf-4aaa-8aaa-000000000001';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'tiny.example', port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 'one', display_name: 'tiny',
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};

const pageErrors = [];
async function openPage(ctx, query = '', clock = false) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    if (clock) await page.clock.install();
    await page.goto(`${base}/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    return page;
}
async function withContext(label, fn) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
        await fn(ctx);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${label}: stopped\n        ${String(e.message).split('\n')[0]}`);
    } finally {
        await ctx.close();
    }
}
const fire = (page, ev, payload) => page.evaluate(([e, p]) => window.__server(e, p), [ev, payload]);
const reports = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'perf_report').map(e => e.payload));
async function restore(page) {
    await fire(page, 'ssh_session_restored', snapshot);
    await fire(page, 'connect', null);
    await page.waitForTimeout(1200);
}

// ── §1 off unless asked ─────────────────────────────────────────────────────
await withContext('§1', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await page.evaluate(() => window.socket.emit('ssh_input', { session_id: 'x', data: 'a' }));
    await fire(page, 'ssh_output', { session_id: S1, data: 'hello' });
    check('§1 without ?perf there is no probe', await page.evaluate(() => typeof window.SSHDeckPerf), 'undefined');
    check('§1 ...and nothing listens on the socket', await page.evaluate(() =>
        [window.__any.length, window.__anyOut.length]), [0, 0]);
    check('§1 ...and no report is sent', (await reports(page)).length, 0);
});

// ── §2 on, remembered, off ──────────────────────────────────────────────────
await withContext('§2', async (ctx) => {
    let page = await openPage(ctx, '?perf=1');
    check('§2 ?perf=1 turns it on', await page.evaluate(() => typeof window.SSHDeckPerf?.flush), 'function');
    check('§2 ...and the device remembers', await page.evaluate(() => localStorage.getItem('sshdeck.perf')), '1');
    await page.close();
    page = await openPage(ctx);
    check('§2 a later visit without the query is still measured', await page.evaluate(() =>
        typeof window.SSHDeckPerf?.flush), 'function');
    await page.close();
    page = await openPage(ctx, '?perf=0');
    check('§2 ?perf=0 turns it off and forgets', await page.evaluate(() =>
        [typeof window.SSHDeckPerf, localStorage.getItem('sshdeck.perf')]), ['undefined', null]);
});

// ── §3–§6, §8 ───────────────────────────────────────────────────────────────
await withContext('§3', async (ctx) => {
    const page = await openPage(ctx, '?perf=1');
    await restore(page);

    // §3 input to echo, 40 ms on the wire.
    await page.evaluate((id) => {
        window.socket.emit('ssh_input', { session_id: id, data: 'SECRET-INPUT' });
        setTimeout(() => window.__server('ssh_output', { session_id: id, data: 'SECRET-OUTPUT-123' }), 40);
    }, S1);
    await page.waitForTimeout(200);

    // §4 what is counted.
    await fire(page, 'ssh_output', { session_id: S1,
        data: ' ⠋ \u{1F648} ─── plain text' });
    await page.evaluate(() => {
        const el = document.querySelector('.xterm');
        for (let k = 0; k < 3; k++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    });
    await page.waitForTimeout(100);
    const first = await page.evaluate(() => window.SSHDeckPerf.flush());
    await page.waitForTimeout(100);

    between('§3 input to echo is the time on the wire', first.echo[0], 35, 150);
    check('§3 ...one sample', first.echo[3], 1);
    between('§3 input to paint comes after the echo', first.paint[0] - first.echo[0], 0, 120);
    check('§3 the key was counted', first.keys, 1);
    check('§4 output counted: two messages', first.outMsgs, 2);
    check('§4 private-use, braille, emoji and box-drawing glyphs counted', first.glyph, [2, 1, 1, 3]);
    check('§4 wheels over the terminal counted', first.wheels, 3);
    check('§4 the grid on screen is reported', first.grid[0] > 0 && first.grid[1] > 0 && first.grid[2] > 0
        && first.grid[3] >= 1, true);

    // §5 the record.
    const keptWhole = (record) => Object.entries(record).filter(([key, value]) => !(key.length <= 16 && (
        typeof value === 'number' || typeof value === 'boolean'
        || (typeof value === 'string' && value.length <= 60)
        || (Array.isArray(value) && value.length <= 4 && value.every(n => typeof n === 'number'))))).map(([k]) => k);
    check('§5 every field is one the server keeps whole', keptWhole(first), []);
    check('§5 no more fields than the server keeps', Object.keys(first).length <= 40, true);
    check('§5 the first record carries the machine', ['dpr', 'view', 'cores', 'font', 'fonts', 'gpu', 'swgl']
        .filter(k => !(k in first)), []);
    check('§5 the transport is named', first.tr, 'websocket');
    check('§5 no round trip measured yet', first.rtt, -1);
    await page.evaluate((id) => window.socket.emit('ssh_input', { session_id: id, data: 'b' }), S1);
    const second = await page.evaluate(() => window.SSHDeckPerf.flush());
    check('§5 later records leave the machine out', ['dpr', 'gpu', 'fonts'].filter(k => k in second), []);
    between('§5 the round trip is the previous ack', second.rtt, 25, 200);
    check('§5 the counters start again each record', [second.keys, second.outMsgs, second.wheels], [1, 0, 0]);

    // §6 no content.
    const sent = JSON.stringify(await reports(page));
    check('§6 neither typed nor received text is in a report',
        ['SECRET-INPUT', 'SECRET-OUTPUT', 'plain text'].filter(s => sent.includes(s)), []);
    check('§6 two reports sent, each with the agent', (await reports(page)).map(r => typeof r.agent), ['string', 'string']);

    // §8 the app is untouched.
    check('§8 output still reaches the terminal', await page.evaluate((id) => {
        const term = TerminalManager.terminals[(TerminalManager.sessionTerminals[id] || [])[0]];
        const buf = term.buffer.active;
        let text = '';
        for (let y = 0; y < buf.length; y++) text += buf.getLine(y)?.translateToString(true) || '';
        return text.includes('SECRET-OUTPUT-123') && text.includes('plain text');
    }, S1), true);
});

// ── §7 one report a minute, only with activity ──────────────────────────────
await withContext('§7', async (ctx) => {
    const page = await openPage(ctx, '?perf=1', true);
    await page.clock.runFor(61000);
    check('§7 an idle minute sends nothing', (await reports(page)).length, 0);
    await fire(page, 'ssh_output', { session_id: S1, data: 'x' });
    await page.clock.runFor(60000);
    check('§7 a minute with output sends one report', (await reports(page)).length, 1);
    await page.clock.runFor(60000);
    check('§7 ...and the next idle minute none', (await reports(page)).length, 1);
});

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
