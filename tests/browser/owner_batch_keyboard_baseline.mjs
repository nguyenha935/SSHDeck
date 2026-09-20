/*
 * Item 8A: keyboard overlay — visualViewport
 * baseline must rebase while the keyboard is CLOSED.
 *
 * The detector (terminal-manager.js applyViewportVars) decides "keyboard
 * open" from vv.height / viewportBaselineHeight < 0.75. The baseline used to
 * be captured ONCE at load and only rebased on rotation. When the page loads
 * (or bfcache-restores) with the keyboard still up, the baseline IS the
 * keyboard-shrunk height — and every later keyboard-open reads ratio ~1.0,
 * so --app-height is never pinned, body.keyboard-open never lands, and the
 * keyboard slides over the terminal. That is the owner's regression.
 *
 * Pinned here (mobile_shell_trusted.mjs §E only drives the healthy-baseline
 * path, which is why the defect shipped through a green gate):
 *
 *   §A load with a keyboard-shrunk viewport (baseline = shrunk), close the
 *      keyboard, then reopen it — the reopen MUST pin --app-height to the
 *      keyboard viewport and set body.keyboard-open. Fails before the fix
 *      (ratio 500/500 = 1.0 -> detector blind).
 *   §B the close itself stays unpinned: no --app-height, no keyboard-open.
 *   §C a page that loads keyboard-CLOSED behaves exactly as before (guard
 *      against over-rebasing the healthy path).
 *
 * Run: node tests/browser/owner_batch_keyboard_baseline.mjs   (from source/)
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
const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = { connected: true, on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop } };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
// The emulated visualViewport height, driven per step. Installed BEFORE any
// app script runs so terminal-manager.js captures this as its baseline.
const vvOverride = (initial) => `
    window.__vvHeight = ${initial};
    Object.defineProperty(window.visualViewport, 'height', {
        configurable: true, get: () => window.__vvHeight });
`;
const readState = (page) => page.evaluate(() => ({
    appHeight: document.documentElement.style.getPropertyValue('--app-height') || null,
    keyboardOpen: document.body.classList.contains('keyboard-open'),
}));

// ── §A/§B: page LOADS with the keyboard open (baseline = shrunk) ──────────
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.addInitScript(vvOverride(500));   // keyboard-up load
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

    // Keyboard closes -> viewport returns to 844. No pin either way.
    await page.evaluate(() => {
        window.__vvHeight = 844;
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    const closed = await readState(page);
    check('§B keyboard close: no --app-height pin', closed.appHeight, null);
    check('§B keyboard close: no keyboard-open class', closed.keyboardOpen, false);

    // Keyboard opens AGAIN. With the stale 500 baseline the old detector sees
    // 500/500 = 1.0 and stays blind; the fix rebased on the close above.
    await page.evaluate(() => {
        window.__vvHeight = 500;
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    const open = await readState(page);
    check('§A reopened keyboard pins --app-height to 500px', open.appHeight, '500px');
    check('§A reopened keyboard sets body.keyboard-open', open.keyboardOpen, true);
    check('§Z shrunk-load: no page errors', errors, []);
    await ctx.close();
}

// ── §C: healthy load stays exactly as before ───────────────────────────────
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    // No vv override: baseline = the real 844.
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    const atRest = await readState(page);
    check('§C healthy load: no pin at rest', atRest.appHeight, null);
    check('§C healthy load: no keyboard-open at rest', atRest.keyboardOpen, false);
    // Keyboard opens (844 -> 469, the real-device measurement from the code).
    await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', {
            configurable: true, get: () => 469 });
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    const open = await readState(page);
    check('§C healthy open: pin to 469px', open.appHeight, '469px');
    check('§C healthy open: keyboard-open set', open.keyboardOpen, true);
    check('§Z healthy: no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
