/*
 * Item 4: navigation/BFCache terminal lifecycle.
 *
 * §L: leaving the shell and coming back via a persisted pageshow (BFCache
 * restore) must restore the HeaderMenus sessionBar observer AND re-fit
 * terminals. The former code cleaned up on pagehide and never re-bound, so
 * after a restore the More sheet no longer closed when the dock hid and
 * terminals kept a stale fit. Pinned: after a synthetic persisted pageshow,
 * hiding the sessionBar while the sheet is open closes the sheet (observer
 * alive), and fitAllTerminals was asked for (recorded via a spy).
 *
 * Run: node tests/browser/owner_batch_bfcache_lifecycle.mjs   (from source/)
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
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

// §L — BFCache restore lifecycle on a phone shell.
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
        // Spy fitAllTerminals so the restore's forced refit is observable.
        window.__fitAll = 0;
        const tm = window.TerminalManager;
        const orig = tm.fitAllTerminals.bind(tm);
        tm.fitAllTerminals = function (...a) { window.__fitAll++; return orig(...a); };
    });
    await page.waitForTimeout(200);

    // Simulate leaving (pagehide) and returning via BFCache (persisted pageshow).
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        window.__fitAll = 0;
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForTimeout(400);

    const l1 = await page.evaluate(() => ({ fitAll: window.__fitAll }));
    check('§L persisted pageshow forces a terminal refit', l1.fitAll >= 1, true);

    // The HeaderMenus observer must be ALIVE after the restore: hiding the
    // dock while the sheet is open must close the sheet.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(300);
    const wasOpen = await page.evaluate(() => !document.getElementById('mobileMoreSheet').hidden);
    check('§L sheet opens after the restore', wasOpen, true);
    await page.evaluate(() => {
        document.getElementById('sessionBar').classList.add('hidden');
    });
    await page.waitForTimeout(250);
    const closed = await page.evaluate(() => document.getElementById('mobileMoreSheet').hidden);
    check('§L hiding the dock closes the sheet after a persisted restore (observer alive)', closed, true);
    check('§Z lifecycle: no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
