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
 * Run: node tests/browser/fit_stability.mjs   (from source/)
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


const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 }, hasTouch: false, isMobile: false });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
const S1 = 'aaaa1111-jitt-4aaa-8aaa-000000000001';
// the server of a lone desktop: every reported fit becomes the window
await page.evaluate((s) => {
    const orig = window.socket.emit;
    window.socket.emit = (ev, p) => {
        orig(ev, p);
        if (ev === 'view_attach') { setTimeout(() => { window.__server('view_attached', { session_id: p.session_id });
            window.__server('tmux_window_geometry', { session_id: p.session_id, cols: p.cols, rows: p.rows }); }, 20); }
        if (ev === 'ssh_resize') { setTimeout(() => window.__server('tmux_window_geometry', { session_id: p.session_id, cols: p.cols, rows: p.rows }), 20); }
    };
}, S1);
await page.evaluate((s) => window.__server('ssh_session_restored', { snapshot_version: 1, session_id: s, host: 'h', port: 22, username: 'u', connected: true,
    auth_type: 'password', key_id: null, via_jump: null, use_tmux: true, tmux_session_name: 'jt', display_name: 'JT', pane_index: null,
    replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null }), S1);
await page.waitForTimeout(600);
const state = () => page.evaluate((s) => {
    const t = TerminalManager.terminals[TerminalManager.sessionTerminals[s][0]];
    const em = window.__emits.filter(e => e.ev === 'ssh_resize' || e.ev === 'view_attach').map(e => `${e.payload.cols}x${e.payload.rows}`);
    return { engine: `${t.cols}x${t.rows}`, font: t.options.fontSize, win: TerminalManager.windowGeometry[s], emits: em, n: window.__emits.length,
        ml: t.element.querySelector('.xterm-screen').style.marginLeft };
}, S1);
/*
 * fit_stability.mjs -- a fit must be a fixed point.
 *
 * xterm 6 reports `css.cell.width` as the rounded canvas width divided by
 * the current column count, so a proposal computed from it depends on the
 * grid it is about to replace. At 1216px wide (Chromium, 14px) the fit was
 * 139 at 138 cols and 138 at 139 cols; a lone desktop, whose every report
 * becomes the window, resized 29 times a second -- the owner's "giật cửa sổ
 * liên tục". The proposal now comes from the measured character. Every width
 * here must settle in at most one report and the engine must equal it.
 */
let bad = 0;
const rows = [];
for (const w of [1200, 1210, 1214, 1215, 1216, 1217, 1218, 1222, 1280, 1366, 1426]) {
    await page.setViewportSize({ width: w, height: 780 });
    await page.waitForTimeout(350);
    const a = await state();
    await page.waitForTimeout(700);
    const b = await state();
    const late = b.emits.slice(a.emits.length);
    const mismatch = b.win && b.engine !== `${b.win.cols}x${b.win.rows}`;
    const ok = late.length === 0 && !mismatch;
    if (!ok) bad += 1;
    rows.push(`${ok ? 'PASS' : 'FAIL'}  width ${w}: settled at ${b.engine}${late.length ? ' late=' + JSON.stringify(late) : ''}${mismatch ? ' window=' + JSON.stringify(b.win) : ''}`);
}
console.log(rows.join('\n'));
check('§Z no page errors', pageErrors, []);
await browser.close(); server.close();
const total = rows.length + 1;
console.log(`${total - bad - fail} passed, ${bad + fail} failed`);
process.exit(bad + fail === 0 ? 0 : 1);
