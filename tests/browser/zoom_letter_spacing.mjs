#!/usr/bin/env node
/*
 * HOW A GRID THAT IS NOT THIS PANE'S SHAPE IS PRESENTED (OWNER RULING B4).
 *
 * Owner: "Khi màn hình bị giãn không còn phóng to chữ nữa mà chuyển qua kéo
 * dãn toàn bộ khoảng cách giữa các chữ rất khó đọc và xấu."
 *
 * Two sources, measured separately:
 *   (a) the font was floored to a whole pixel although xterm accepts a
 *       fraction (14 -> 8.429px, 14.5 -> 8.730px, 15 -> 9.031px), and the
 *       remainder became letter spacing: 1.1-3.8% of a character;
 *   (b) zoom follows the tighter axis, so the spare on the other axis became
 *       letter spacing with no limit -- 8.4% of a character in the owner's own
 *       capture (engine 59x45 font 26 ls 1.32 in a pane fitting 118x84).
 *
 * B4: fill until it stops reading, then leave the rest as margin, which
 * recentreTerminalScreen already splits evenly.
 *
 * Sections:
 *   §A  a grid narrower than the pane is zoomed, and the spacing between
 *       characters never exceeds LETTER_SPACING_MAX_RATIO of a character
 *   §B  the font is allowed to be fractional
 *   §Z  no page errors
 *
 * Run: node tests/browser/zoom_letter_spacing.mjs   (from source/)
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
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
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
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'dddd4444-zoom-4ddd-8ddd-000000000004';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'h1', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 't-zoom', display_name: null,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};

const pageErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*',
    r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(
    () => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined',
    null, { timeout: 15000 });
await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

const fire = (ev, payload) => page.evaluate(
    ([e, p]) => window.__server(e, p), [ev, payload ?? null]);

await fire('ssh_session_restored', snapshot);
await page.waitForTimeout(500);

/*
 * A window SMALLER than this pane, and a different shape -- the case a phone
 * creates for a desktop. noteWindowGeometry is the app's own entry for it.
 */
const measure = async (cols, rows) => {
    await page.evaluate(({ s, c, r }) => TerminalManager.noteWindowGeometry(s, c, r),
        { s: S1, c: cols, r: rows });
    await page.waitForTimeout(500);
    return page.evaluate((s) => {
        const tm = TerminalManager;
        const term = tm.terminals[(tm.sessionTerminals[s] || [])[0]];
        const cs = term._core._charSizeService;
        const screen = term.element.querySelector('.xterm-screen');
        return {
            grid: `${term.cols}x${term.rows}`,
            font: term.options.fontSize,
            letterSpacing: term.options.letterSpacing,
            charWidth: cs.width,
            ratio: cs.width ? term.options.letterSpacing / cs.width : null,
            marginLeft: screen ? screen.style.marginLeft : null,
        };
    }, S1);
};

const cap = await page.evaluate(() => TerminalManager.LETTER_SPACING_MAX_RATIO);
console.log(`      cap = ${cap} of a character`);

let worst = 0;
const shapes = [[60, 20], [59, 45], [70, 30], [40, 40]];
for (const [c, r] of shapes) {
    const m = await measure(c, r);
    worst = Math.max(worst, m.ratio || 0);
    console.log(`      lưới ${String(c) + 'x' + r}  ->  font ${m.font}  ls ${m.letterSpacing}`
        + `  (${((m.ratio || 0) * 100).toFixed(1)}% ký tự)  marginLeft ${m.marginLeft || '0'}`);
}
check('§A spacing never passes the cap', worst <= cap + 0.001, true);

const zoomed = await measure(59, 45);
check('§A the grid is the one the window announced', zoomed.grid, '59x45');
// A whole-pixel font is what threw the remainder into the spacing, so the
// row has to say FRACTIONAL and nothing weaker. (An earlier version wrote
// `isInteger === false || font === round(font)`, which is true for every
// number there is -- a row that could never fail.)
check('§B the font keeps its fraction', Number.isInteger(zoomed.font), false);
check('§B and it is larger than the base', zoomed.font > 14, true);
check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\nzoom_letter_spacing: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
