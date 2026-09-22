#!/usr/bin/env node
/*
 * LEAVING A SCROLL ON A SESSION WITH NO FULL-SCREEN PROGRAM.
 *
 * Owner: "dùng các CLI không có TUI thì nút thoát cuộn vẫn hiện lại sau khi đã
 * thoát cuộn." Measured on the deployment, real #exitScrollBtn, plain prompt:
 *
 *     + 200ms  scrolled:true   indicator:true   appScrollDepth:6
 *     + 600ms  scrolled:FALSE  indicator:false  appScrollDepth:6   <- tmux left
 *     +1200ms  scrolled:TRUE   indicator:false  appScrollDepth:6   <- back
 *     +2500ms  scrolled:TRUE   indicator:false  appScrollDepth:6
 *
 * tmux really did leave copy mode: its `[25/455]` indicator, which sat at
 * exactly the last column of the pane's top row, was gone by +600ms. What
 * brought the control back is the third driver of syncTerminalScrollState --
 * appScrollDepth, still holding 6 wheels.
 *
 * It was stuck because exitScrollAction tests the copy-mode indicator FIRST
 * and returns, so the branch that hands the wheels back (and zeroes the depth)
 * was never reached; and syncTerminalScrollState only zeroes the depth when
 * `!appOwnsMouse`, which is false because tmux turns mouse tracking on for its
 * own clients. A program that holds the mouse never reaches that branch --
 * tmux does not enter copy mode for it -- which is exactly why the owner sees
 * the control working on claude code.
 *
 * Sections:
 *   §A  wheels that went into tmux's copy mode are settled by leaving it: the
 *       depth is zero and the control does not come back
 *   §B  a program holding the mouse still gets its wheels returned
 *   §Z  no page errors
 *
 * Run: node tests/browser/exit_scroll_depth.mjs   (from source/)
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

const S1 = 'cccc3333-scrl-4ccc-8ccc-000000000003';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'h1', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 't-scrl', display_name: null,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};

const pageErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
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

/* Server output goes through the app's own ssh_output handler, which reads
 * `data.data` (app.js:1275) -- not `output`. */
const feed = (payload) => fire('ssh_output', { session_id: S1, data: payload });

const read = () => page.evaluate((s) => {
    const tm = TerminalManager;
    const term = tm.terminals[(tm.sessionTerminals[s] || [])[0]];
    return {
        scrolled: tm.isSessionScrolled(s),
        indicator: tm.tmuxPaneInCopyModeIndicator(term),
        depth: tm.appScrollDepth[s] || 0,
        appOwnsMouse: tm.appOwnsMouse(s),
        mouseReports: tm.mouseReports[s] || 0,
    };
}, S1);

await fire('ssh_session_restored', snapshot);
await page.waitForTimeout(500);

// Fill the pane, turn on the tracking tmux turns on for its clients, and put
// tmux's own copy-mode indicator where tmux puts it: the last column of the
// pane's top row.
await page.evaluate((s) => {
    const tm = TerminalManager;
    const term = tm.terminals[(tm.sessionTerminals[s] || [])[0]];
    const cols = term.cols;
    const indicator = ' '.repeat(Math.max(0, cols - 8)) + '[25/455]';
    window.__indicatorRow = indicator;
    return cols;
}, S1);
await feed('\x1b[?1002h');                        // tmux: mouse tracking on
await page.evaluate(() => {}, null);
await feed('\x1b[H' + (await page.evaluate(() => window.__indicatorRow)) + '\r\n');
for (let i = 0; i < 20; i += 1) await feed(`line ${i}\r\n`);
await page.waitForTimeout(300);

/*
 * The wheels, counted the way the app counts them. `noteAppWheel` is the one
 * place that moves appScrollDepth, and it refuses unless the session really
 * owns the mouse -- so this cannot fake a state the app would not reach.
 * (A synthetic page.mouse.wheel does not get there in this fixture: the
 * engine emits no mouse report for it, and an uncounted wheel was how an
 * earlier version of this suite read broken code as green.)
 */
const counted = await page.evaluate((s) => {
    const moved = [];
    for (let i = 0; i < 6; i += 1) moved.push(TerminalManager.noteAppWheel(s, -240));
    return { moved: moved.filter(Boolean).length, depth: TerminalManager.appScrollDepth[s] };
}, S1);
check('§A the wheels are counted through noteAppWheel', counted.depth, 6);
await page.waitForTimeout(200);

// Put the indicator back at the top: the wheels scrolled the pane's content.
await feed('\x1b[H' + (await page.evaluate(() => window.__indicatorRow)));
await page.waitForTimeout(300);

const scrolled = await read();
check('§A the copy-mode indicator is seen', scrolled.indicator, true);
check('§A tmux tracking counts as the app owning the mouse', scrolled.appOwnsMouse, true);
check('§A and the wheels are still on the counter', scrolled.depth, 6);

// tmux leaves copy mode: the indicator goes, and the server says so.
const route = await page.evaluate((s) => TerminalManager.exitScrollAction(s), S1);
check('§A the control routes to tmux', route, 'tmux-copy-mode');
check('§A and the counted wheels are settled at once',
    (await read()).depth, 0);

// tmux repaints the row WITHOUT the indicator. Erasing the line is what
// does that: forty spaces only covered the first forty columns, and the
// indicator sits at the last one -- which is how this gate first read
// green code as broken.
await feed('\x1b[H\x1b[2K');
await fire('tmux_copy_mode_exited', { session_id: S1, was_in_mode: 1 });
await page.waitForTimeout(1400);                  // past the 500ms sweep
let after = await read();
check('§A the indicator is gone', after.indicator, false);
check('§A and the control does not come back', after.scrolled, false);

/*
 * §B a program that holds the mouse: no copy-mode indicator, so the wheels
 * are owed to the program and returnAppScroll is what settles them.
 */
await page.evaluate((s) => { TerminalManager.appScrollDepth[s] = 3; }, S1);
const route2 = await page.evaluate((s) => TerminalManager.exitScrollAction(s), S1);
check('§B routes to the program that holds the mouse', route2, 'app-owned');
check('§B and its wheels are returned', (await read()).depth, 0);

check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\nexit_scroll_depth: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
