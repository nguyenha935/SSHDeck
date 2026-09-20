#!/usr/bin/env node
/*
 * The two client halves of the owner report, as gates:
 *
 *   "Màn hình được co lại không ra giữa trên cùng mà vẫn co về góc trái trên
 *    cùng."  -- tmux draws a window smaller than the client in the top-left
 *   corner with filler. The server now holds every view's PTY at the minimum
 *   over the views' TRUE fits and announces it (`tmux_window_geometry`); the
 *   client renders that size, centred, while still REPORTING its true fit.
 *
 *   "Các nút connect không đồng bộ ngay trên điện thoại"  -- a connect on one
 *   socket is announced to the user's others as a `live` restore snapshot;
 *   the receiver lists it without displaying it, and a `replaces_session_id`
 *   retires the stale offer in place. `ssh_session_removed` retires a row
 *   another device deleted.
 *
 * Sections:
 *   §A  geometry below the fit: engine takes the window's size, grid centred,
 *       the true fit is still what was reported (no ssh_resize follows);
 *       geometry above the fit: engine returns to the fit
 *   §B  a live snapshot joins the list and takes no pane, no activation, no
 *       view
 *   §C  a live snapshot replacing a session this page shows takes that
 *       session's pane
 *   §D  ssh_session_removed retires a session
 *   §Z  zero page errors
 *
 * Run: node tests/browser/app_scroll_return.mjs   (from source/)
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
const checkTrue = (label, actual) => check(label, actual === true, true);
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

/*
 * app_scroll_return.mjs -- Exit scroll inside a full-screen application.
 *
 * Claude Code, codex, vim and less take the wheel themselves, so tmux never
 * enters copy mode and xterm's viewport cannot move: the button's two facts
 * are both false and it could neither appear nor act. It now counts the
 * wheels this client sent INTO such an application and gives them back.
 *
 * The hard rule this gate exists for: a wheel is counted ONLY when the engine
 * encoded it as a mouse report. With tracking off, xterm turns a wheel into
 * CURSOR KEYS, and replaying those drove the owner's codex pane into a state
 * it had to be killed out of.
 */
const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
const S1 = 'aaaa1111-scrl-4aaa-8aaa-000000000001';
const serverSend = (ev, p) => page.evaluate(({ e, q }) => window.__server(e, q), { e: ev, q: p });
await serverSend('ssh_session_restored', { snapshot_version: 1, session_id: S1, host: 'h', port: 22, username: 'u', connected: true,
    auth_type: 'password', key_id: null, via_jump: null, use_tmux: true, tmux_session_name: 'sc', display_name: 'SC', pane_index: null,
    replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null });
await page.waitForFunction(() => window.__emits.some(e => e.ev === 'view_attach'), null, { timeout: 5000 });
await serverSend('view_attached', { session_id: S1 });
await page.waitForTimeout(250);

const wheel = (n, dy) => page.evaluate(({ s, count, delta }) => {
    const t = TerminalManager.terminals[TerminalManager.sessionTerminals[s][0]];
    const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    for (let i = 0; i < count; i++) {
        t.element.dispatchEvent(new WheelEvent('wheel', {
            deltaY: delta, deltaMode: 1, bubbles: true, cancelable: true,
            clientX: Math.round(box.left + box.width / 2),
            clientY: Math.round(box.top + box.height / 2) }));
    }
}, { s: S1, count: n, delta: dy });
const state = () => page.evaluate((s) => ({
    depth: TerminalManager.appScrollDepth[s] || 0,
    scrolled: TerminalManager.isSessionScrolled(s),
    mouse: TerminalManager.appOwnsMouse(s),
    sent: window.__emits.filter(e => e.ev === 'ssh_input').map(e => e.payload.data),
}), S1);
const write = (data) => page.evaluate(({ s, d }) => {
    TerminalManager.terminals[TerminalManager.sessionTerminals[s][0]].write(d);
}, { s: S1, d: data });

// §A the alternate screen WITHOUT mouse tracking: a wheel becomes cursor keys
await write('\x1b[?1049h');
await page.waitForTimeout(150);
await page.evaluate(() => { window.__emits = []; });
await wheel(3, -1);
await page.waitForTimeout(150);
const noMouse = await state();
num('§A no tracking', noMouse);
check('§A the pane does not own the mouse', noMouse.mouse, false);
check('§A nothing is counted', noMouse.depth, 0);
check('§A and the button stays down', noMouse.scrolled, false);

// §B the application takes the mouse: wheels are counted and the button shows
await write('\x1b[?1000h\x1b[?1006h');
await page.waitForTimeout(150);
await page.evaluate(() => { window.__emits = []; });
await wheel(4, -1);
await page.waitForTimeout(200);
const up = await state();
num('§B after four wheel-ups', { depth: up.depth, scrolled: up.scrolled, mouse: up.mouse, sent: up.sent.slice(0, 2) });
check('§B the pane owns the mouse', up.mouse, true);
check('§B four wheels counted', up.depth, 4);
check('§B the button is shown', up.scrolled, true);
checkTrue('§B every byte sent was a mouse report',
    up.sent.length > 0 && up.sent.every(d => d.startsWith('\x1b[<') || d.startsWith('\x1b[M')));

// §C a wheel DOWN pays the debt back one by one
await wheel(1, 1);
await page.waitForTimeout(150);
check('§C a wheel down lowers the count', (await state()).depth, 3);

// §D Exit scroll returns exactly what is owed, as mouse reports
await page.evaluate(() => { window.__emits = []; });
const route = await page.evaluate((s) => TerminalManager.exitScrollAction(s), S1);
await page.waitForTimeout(250);
const done = await state();
num('§D after Exit scroll', { route, depth: done.depth, scrolled: done.scrolled, sent: done.sent.length });
check('§D the route is the local one', route, 'app-owned');
check('§D three wheels went back', done.sent.length, 3);
checkTrue('§D and all of them were mouse reports',
    done.sent.every(d => d.startsWith('\x1b[<') || d.startsWith('\x1b[M')));
check('§D nothing is owed now', done.depth, 0);
check('§D the button is hidden', done.scrolled, false);

// §E the application gives the mouse back: the debt is dropped, not replayed
await wheel(3, -1);
await page.waitForTimeout(150);
checkTrue('§E precondition: something is owed', (await state()).depth > 0);
await write('\x1b[?1000l\x1b[?1049l');
await page.waitForTimeout(700);
const released = await state();
check('§E the debt is dropped when the mouse is released', released.depth, 0);
await page.evaluate(() => { window.__emits = []; });
await page.evaluate((s) => TerminalManager.exitScrollAction(s), S1);
await page.waitForTimeout(200);
check('§E and Exit scroll sends no wheels at all', (await state()).sent.length, 0);

check('§Z no page errors', pageErrors, []);
await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
