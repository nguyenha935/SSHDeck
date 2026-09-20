#!/usr/bin/env node
/*
 * THE ENGINE MUST MEASURE A ROW THE WAY tmux DOES.
 *
 * Owner, (screenshot): the omp session's prompt row painted over
 * every transcript row above it, fifty copies, while the host pane held one.
 * Measured: the prompt row is 108 characters that tmux (glibc wcwidth,
 * Unicode 15) draws in 109 cells -- U+1F648 SEE-NO-EVIL MONKEY is wide -- and
 * xterm's built-in Unicode 6 table draws in 108, because that table predates
 * the emoji. The full-width row then ends a column early in the engine, the
 * cursor sits a column behind tmux's bookkeeping, and the next repaint lands
 * on the wrong row. createTerminal now loads the Unicode 11 addon, whose
 * tables agree with tmux for every glyph on that row.
 *
 *   §1 the app's own terminal runs Unicode 11;
 *   §2 a row shaped like omp's measures 109 cells there, as tmux draws it
 *      (the expected cells are derived from East Asian Width, the rule
 *      wcwidth follows: W/F = 2, everything else 1);
 *   §3 MUTATION: the same row on a bare engine without the addon measures
 *      108, so the row above exists only while the tables differ.
 *
 * Run: node tests/browser/unicode_width_tmux.mjs   (from source/)
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
    window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.socket = { connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: noop, connect: noop };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

/*
 * The row, shaped like omp's: a box top padded to 109 cells by East Asian
 * Width -- the rule wcwidth follows, so this is the width tmux draws.
 */
const ROW = (() => {
    const eaw = ch => {
        const cp = ch.codePointAt(0);
        // The only wide glyph on this row is the monkey (EAW W); everything
        // else -- box drawing, Greek, arrows, the eye and the wastebasket
        // (EAW N, no emoji presentation) -- is one cell in wcwidth.
        return cp === 0x1F648 ? 2 : 1;
    };
    const cells = s => [...s].reduce((n, ch) => n + eaw(ch), 0);
    const left = '╭── π › ◒ DeepSeek V4.1 Flash \u{1F648} › \u{1F5D1} ~/tmp › \u{1F441} $1.76 ▶─7%';
    const right = '┃──1M─◀ Quy tắc code và giao tiếp ─╮';
    const row = left + '─'.repeat(109 - cells(left) - cells(right)) + right;
    if (cells(row) !== 109) throw new Error(`fixture row is ${cells(row)} cells, not 109`);
    return row;
})();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

const m = await page.evaluate(row => {
    TerminalManager.createTerminal('u11');
    const key = (TerminalManager.sessionTerminals['u11'] || [])[0];
    const app = TerminalManager.terminals[key];
    const bare = new Terminal({ cols: 109, rows: 5, allowProposedApi: true });
    return {
        appVersion: app.unicode.activeVersion,
        appCells: app._core.unicodeService.getStringCellWidth(row),
        bareVersion: bare.unicode.activeVersion,
        bareCells: bare._core.unicodeService.getStringCellWidth(row),
        monkey: [app._core.unicodeService.wcwidth(0x1F648), bare._core.unicodeService.wcwidth(0x1F648)],
    };
}, ROW);
console.log(`      ${JSON.stringify(m)}`);
check('§1 the app terminal runs the Unicode 11 tables', m.appVersion, '11');
check('§2 an omp-shaped full-width row measures 109 cells, as tmux draws it', m.appCells, 109);
check('§2 the monkey is two cells wide, as in wcwidth', m.monkey[0], 2);
check('§3 MUTATION: the bare Unicode 6 engine measures the same row at 108', m.bareCells, 108);
check('§3 because it draws the monkey in one cell', m.monkey[1], 1);
check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`unicode_width_tmux: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
