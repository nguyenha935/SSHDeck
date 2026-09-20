/*
 * Item 5: Exit Scroll must EXIT — real scroll state,
 * not the appOwnsMouse conflation.
 *
 * The defect: syncTerminalScrollState OR-ed appOwnsMouse(sessionId) into the
 * scroll state, so a claude/vim/htop session (mouse tracking on) always
 * showed Exit Scroll even though tmux was never in copy-mode. Clicking sent
 * tmux_exit_copy_mode, the server answered was_in_mode:0 (a no-op), the
 * handler hid the button — and the setupScrollbar 500ms resync interval
 * re-derived appOwnsMouse=true and showed it again. The button could never
 * exit anything.
 *
 * Contract pinned here, against the REAL terminal-manager.js and a REAL xterm
 * (exit_scroll_contract.mjs stubs TerminalManager wholesale and can never see
 * this — that is the false confidence the owner named):
 *
 *   §A an app-owned session (DECSET 1002 written to the terminal) scrolled
 *      away from bottom shows the button; clicking performs a CLIENT-SIDE
 *      scroll to bottom, sends NO tmux_exit_copy_mode, and the button stays
 *      hidden through the 500ms resync interval (it never resurrects);
 *   §B a session WITHOUT mouse tracking scrolled away from bottom shows the
 *      button; clicking emits exactly one tmux_exit_copy_mode; the
 *      was_in_mode:true reply hides it and it stays hidden;
 *   §C at-bottom terminal never shows the button — app-owned or not.
 *
 * Run: node tests/browser/owner_batch_exit_scroll_actionable.mjs  (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = Array.isArray(actual) ? actual.join(', ') : actual;
    const e = Array.isArray(expected) ? expected.join(', ') : expected;
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${JSON.stringify(e)}\n        actual   ${JSON.stringify(a)}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png' };
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}
const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return; }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const INIT = `
    const noop = () => {};
    window.__handlers = {};
    window.__emits = [];
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.io = () => ({ connected: true, on: record, off: noop, once: record,
        emit: (ev, p) => window.__emits.push({ ev, p }), io: { on: noop } });
    window.socket = window.io();
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

// One tmux session with a real terminal.
await page.evaluate(() => {
    SessionManager.sessions.A = { id: 'A', session_id: 'A', host: 'h', port: 22,
        username: 'u', authType: 'key', keyId: 'k', jumpHostId: null, displayName: 'A',
        connected: true, isPersistentCandidate: false, tmuxSessionName: 't_A',
        terminalId: 'term-A', useTmux: true, viaJump: null, latencyMs: null };
    SessionManager.createSessionTab('A', 'h', 'u');
    SessionManager.activeSessionId = 'A';
    const grid = document.getElementById('terminalGrid');
    const pane0 = grid.querySelector('.terminal-pane');
    pane0.querySelectorAll('.pane-empty').forEach(e => e.remove());
    const w = document.createElement('div');
    w.className = 'terminal-wrapper';
    w.id = 'wrap-a';
    pane0.appendChild(w);
    TerminalManager.createTerminal('A', 'A');
    TerminalManager.attachTerminal('A', 'wrap-a', 'A');
});
await page.waitForFunction(() => window.TerminalManager.terminalReady['A'] === true, null, { timeout: 10000 });
await page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    for (let i = 1; i <= 60; i++) t.writeln(`line ${i}`);
});
await page.waitForTimeout(200);

const btnVisible = () => page.evaluate(() => !document.getElementById('exitScrollBtn').hidden);

// ── §A app-owned scroll: the button must ACT, not fake it ─────────────────
await page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    t.write('\x1b[?1002h');          // claude-style drag tracking
    t.scrollLines(-10);              // user scrolled away from the bottom
});
await page.evaluate(() => document.dispatchEvent(
    new CustomEvent('sshdeck:active-session-changed', { detail: { sessionId: 'A' } })));
await page.waitForTimeout(800);      // let the 500ms resync interval derive state
check('§A app-owned + scrolled away shows Exit Scroll', await btnVisible(), true);
check('§A appOwnsMouse is really true (DECSET 1002)',
    await page.evaluate(() => TerminalManager.appOwnsMouse('A')), true);

await page.evaluate(() => {
    window.__emits.length = 0;
    // dispatchEvent: the current code disables the button and only re-enables
    // it from the server reply, so a guarded Playwright click would hang on
    // the very defect under test.
    document.getElementById('exitScrollBtn').dispatchEvent(new Event('click'));
});
await page.waitForTimeout(150);
const a1 = await page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    return {
        exitEmits: window.__emits.filter(e => e.ev === 'tmux_exit_copy_mode').length,
        atBottom: t.buffer.active.viewportY >= t.buffer.active.baseY,
        hiddenNow: document.getElementById('exitScrollBtn').hidden,
    };
});
check('§A click performs NO tmux_exit_copy_mode (client-side exit)', a1.exitEmits, 0);
check('§A the terminal is scrolled back to the bottom', a1.atBottom, true);
check('§A the button hides immediately', a1.hiddenNow, true);
await page.waitForTimeout(900);      // past the 500ms resync interval
check('§A the button stays hidden through the resync (no resurrection)',
    await btnVisible(), false);

// ── §C at-bottom never shows it ────────────────────────────────────────────
await page.waitForTimeout(700);
check('§C at-bottom app-owned session: button hidden', await btnVisible(), false);

// ── §B real tmux copy-mode path: one emit, reply hides, stays hidden ───────
await page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    t.write('\x1b[?1002l');          // app exited; tmux world again
    t.scrollLines(-10);
});
await page.waitForTimeout(800);
check('§B no-mouse + scrolled away shows Exit Scroll', await btnVisible(), true);
await page.evaluate(() => {
    window.__emits.length = 0;
    document.getElementById('exitScrollBtn').dispatchEvent(new Event('click'));
});
await page.waitForTimeout(120);
const b1 = await page.evaluate(() => ({
    exitEmits: window.__emits.filter(e => e.ev === 'tmux_exit_copy_mode').length,
    session: window.__emits.filter(e => e.ev === 'tmux_exit_copy_mode')[0]?.p?.session_id,
}));
check('§B click emits exactly one tmux_exit_copy_mode', b1.exitEmits, 1);
check('§B the emit targets the active session', b1.session, 'A');
// Server answered: it really exited copy-mode.
await page.evaluate(() => {
    (window.__handlers['tmux_copy_mode_exited'] || []).forEach(fn =>
        fn({ ok: true, was_in_mode: true, session_id: 'A' }));
});
await page.waitForTimeout(150);
check('§B was_in_mode reply hides the button', await btnVisible(), false);
await page.waitForTimeout(900);
check('§B the button stays hidden after the resync interval', await btnVisible(), false);

check('§Z no page errors', errors, []);
await ctx.close();
await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
