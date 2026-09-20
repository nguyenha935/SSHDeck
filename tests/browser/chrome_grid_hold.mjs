#!/usr/bin/env node
/*
 * OUR OWN PANEL MUST NOT RESIZE THE REMOTE PANE.
 *
 * Owner,: "trên desktop chỉ cần mở broadcast lên tắt đi thôi là
 * terminal đang mở omp vẫn nhảy nhảy."
 *
 * Measured before the fix, on this page at 1440x900: turning Broadcast on puts
 * #sessionBar into the desktop flex flow -- 52 px of real height -- so the
 * terminal area goes 780 -> 728 and the fit proposes 45 rows where it had
 * proposed 48. That proposal is the SHARED tmux window: the server takes the
 * minimum, tmux resizes, every attached device repaints, and a prompt like omp
 * redraws in front of the owner. Closing it repeats the whole thing.
 *
 * What is pinned here: the toggle costs NOTHING on the wire, the pane keeps
 * its grid, and the text is what gives -- while a genuine window resize is
 * still reported, panel open or not.
 *
 * Run: node tests/browser/chrome_grid_hold.mjs   (from source/)
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
function checkTrue(label, value, detail) {
    if (value === true) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        ${detail}`); }
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

/*
 * A server that answers an attach the way the real one does: the view is
 * accepted at the size it asked for, and that size comes back as the shared
 * window. Without the window the pane renders its own fit and there is no
 * shared grid to hold, which is not the case under test.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => {
            window.__emits.push({ ev, payload });
            if (ev === 'view_attach') {
                setTimeout(() => {
                    window.__server('view_attached', { session_id: payload.session_id });
                    window.__server('tmux_window_geometry', {
                        session_id: payload.session_id,
                        cols: payload.cols, rows: payload.rows });
                }, 10);
            }
            if (ev === 'ssh_resize') {
                setTimeout(() => window.__server('tmux_window_geometry', {
                    session_id: payload.session_id,
                    cols: payload.cols, rows: payload.rows }), 10);
            }
        },
        connect: noop,
    };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

const S = 'aaaa1111-bcst-4aaa-8aaa-000000000001';
await page.evaluate(id => window.__server('ssh_session_restored', {
    snapshot_version: 1, session_id: id, host: 'tiny', port: 22, username: 'root',
    connected: true, auth_type: 'tailscale', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 'sshdeck_root_x', display_name: null,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
}), S);
await page.waitForTimeout(1200);

const state = () => page.evaluate(id => {
    const key = (TerminalManager.sessionTerminals[id] || [])[0];
    const term = TerminalManager.terminals[key];
    const area = document.querySelector('.terminal-area');
    const bar = document.getElementById('sessionBar');
    return {
        grid: term ? [term.cols, term.rows] : null,
        font: term ? term.options.fontSize : null,
        win: TerminalManager.windowGeometry[id] || null,
        area: area ? Math.round(area.getBoundingClientRect().height) : null,
        bar: bar ? Math.round(bar.getBoundingClientRect().height) : null,
        resizes: window.__emits.filter(e => e.ev === 'ssh_resize')
            .map(e => [e.payload.cols, e.payload.rows]),
    };
}, S);
const clearEmits = () => page.evaluate(() => { window.__emits.length = 0; });

const settled = await state();
checkTrue('§0 the session has a shared window and a grid',
    !!settled.win && settled.grid[1] > 10,
    JSON.stringify(settled));

/* ------------------------------------------------------- §1 Broadcast on */
await clearEmits();
await page.click('#broadcastToggleBtn');
await page.waitForTimeout(700);
const on = await state();
check('§1 opening Broadcast proposes nothing to the server', on.resizes, []);
check('§1 the pane keeps the grid tmux is drawing',
    [on.grid, on.win], [settled.grid, settled.win]);
checkTrue('§1 the composer really did take space from the terminal',
    on.bar > 20 && on.area < settled.area,
    `bar=${on.bar} area=${on.area} was=${settled.area}`);
checkTrue('§1 the text is what gives, and it scales down',
    on.font < settled.font && on.font > 6,
    `font=${on.font} was=${settled.font}`);

/* ------------------------------------------------------ §2 Broadcast off */
await clearEmits();
await page.click('#broadcastToggleBtn');
await page.waitForTimeout(700);
const off = await state();
check('§2 closing it proposes nothing either', off.resizes, []);
check('§2 the grid and the window are exactly where they started',
    [off.grid, off.win], [settled.grid, settled.win]);
check('§2 and the text is back at its own size', off.font, settled.font);
check('§2 the bar is out of the flow again', off.bar, settled.bar);

/* ------------------------------ §3 a real window resize is still reported */
await clearEmits();
await page.click('#broadcastToggleBtn');
await page.waitForTimeout(700);
await clearEmits();
await page.setViewportSize({ width: 1180, height: 760 });
await page.waitForTimeout(900);
const resized = await state();
checkTrue('§3 a genuine window resize while Broadcast is open IS proposed',
    resized.resizes.length >= 1,
    `resizes=${JSON.stringify(resized.resizes)}`);
checkTrue('§3 ... and the pane follows the window it was given',
    !!resized.win && resized.grid[0] === resized.win.cols
        && resized.grid[1] === resized.win.rows,
    JSON.stringify({ grid: resized.grid, win: resized.win }));

// ... and the panel is still held afterwards: closing it costs nothing.
await clearEmits();
await page.click('#broadcastToggleBtn');
await page.waitForTimeout(700);
const closed = await state();
check('§3 closing it after that resize still costs nothing', closed.resizes, []);
check('§3 the grid is the one the server last gave',
    [closed.grid[0], closed.grid[1]], [resized.win.cols, resized.win.rows]);

check('§4 no page errors', errors, []);
await browser.close();
server.close();
console.log(`chrome_grid_hold: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
