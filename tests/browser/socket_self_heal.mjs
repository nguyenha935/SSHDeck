#!/usr/bin/env node
/*
 * A DROPPED SOCKET MUST COME BACK BY ITSELF.
 *
 * Owner,: "thường xuyên đứt hết nối nếu lâu không thao tác hoặc
 * chuyển tab khác. Quay lại cũng không thể reconnect lại được phải tải lại
 * trang."
 *
 * Read from the server log of the running build: the socket drops, the
 * reconnect handshake arrives without `_user_id`, the server answers
 * `connected {status: 'unauthenticated'}` and hangs up. Socket.IO v4 treats a
 * server-side hangup as final -- reason "io server disconnect" turns its own
 * reconnection OFF -- so nothing in the page ever tried again and the owner
 * had to reload. A reload logged straight back in, which is how we know a
 * credential was still in the browser the whole time.
 *
 * This gate pins the CLIENT half of the repair, which is the half that can be
 * measured without a server:
 *   §1 a server-side hangup is retried, and an ordinary transport drop is left
 *      to Socket.IO's own backoff (retrying there would race it);
 *   §2 every edge where the page is in front of a person again -- the tab
 *      becoming visible, pageshow, the network returning, focus -- asks a
 *      disconnected socket to try once more, and never touches a live one;
 *   §3 `unauthenticated` sends the page to /login carrying where it was, and
 *      the second one inside the guard window does NOT (a redirect loop is
 *      worse than a dead socket, because it takes the terminal with it);
 *   §4 after the guard trips, the reconnect bar offers a way in by hand.
 *
 * Run: node tests/browser/socket_self_heal.mjs   (from source/)
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
    '.woff2': 'font/woff2', '.png': 'image/png' };
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
 * A socket whose connect() is a counter rather than a network call, so "did
 * the page try again" is a number instead of a guess.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    window.__connectCalls = 0;
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        connect: () => { window.__connectCalls += 1; },
    };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
/*
 * The redirect is a REAL navigation -- location.replace cannot be stubbed in
 * Chromium, it is not configurable -- so /login is served as a stub page and
 * the URL the browser actually went to is the measurement.
 */
await page.route('**/login*', r =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
                body: '<!doctype html><title>login stub</title><body>login</body>' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

const calls = () => page.evaluate(() => window.__connectCalls);
const setConnected = (v) => page.evaluate(v2 => { window.socket.connected = v2; }, v);
const reset = () => page.evaluate(() => {
    window.__connectCalls = 0;
    try { sessionStorage.removeItem('sshdeck.reauthAt'); } catch (e) { /* private window */ }
});
async function reopen() {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
}

/* ---------------------------------------------------------------- §1 reason */
await reset();
await setConnected(false);
await page.evaluate(() => window.__server('disconnect', 'transport close'));
await page.waitForTimeout(1300);
check('§1 an ordinary transport drop is left to Socket.IO\'s own backoff',
    await calls(), 0);

await page.evaluate(() => window.__server('disconnect', 'io server disconnect'));
check('§1 the server hangup does not retry instantly (it waits a beat)',
    await calls(), 0);
await page.waitForTimeout(1300);
check('§1 a server hangup IS retried, because Socket.IO will not do it',
    await calls(), 1);

/* ------------------------------------------------------------- §2 wake-ups */
for (const [label, fire] of [
    ['the tab becoming visible', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
    ['the network returning', () => window.dispatchEvent(new Event('online'))],
    ['the window taking focus', () => window.dispatchEvent(new Event('focus'))],
]) {
    await reset();
    await setConnected(false);
    await page.evaluate(fire);
    check(`§2 ${label} wakes a dead socket`, await calls(), 1);
}

await reset();
await setConnected(true);
await page.evaluate(() => {
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
});
check('§2 a live socket is never reconnected underneath itself', await calls(), 0);

/* ------------------------------------------------------- §3 re-authenticate */
await reset();
await Promise.all([
    page.waitForURL(/\/login\?next=/, { timeout: 10000 }),
    page.evaluate(() => window.__server('connected', { status: 'unauthenticated' })),
]);
check('§3 an unauthenticated handshake goes to the login page, carrying where the reader was',
    /\/login\?next=%2F$/.test(page.url()), true);

// sessionStorage survives that navigation: the same tab, the same origin. So
// the page that comes back is exactly the page a real reader would land on if
// /login bounced them straight back with the same stale credential.
await reopen();
let navigated = false;
const onNav = () => { navigated = true; };
page.on('framenavigated', onNav);
await page.evaluate(() => window.__server('connected', { status: 'unauthenticated' }));
await page.waitForTimeout(500);
page.off('framenavigated', onNav);
check('§3 a second refusal inside the guard window does NOT redirect again, so a stale credential cannot become a redirect loop',
    [navigated, /\/login/.test(page.url())], [false, false]);

/* --------------------------------------------------------------- §4 the bar */
const bar = await page.evaluate(() => {
    const el = document.getElementById('reconnectBar');
    return { shown: el ? el.style.display : null,
             link: el ? !!el.querySelector('a[href$="/login"]') : false,
             text: el ? el.textContent.trim().length > 0 : false };
});
check('§4 the bar offers a way in by hand once the guard has tripped',
    [bar.shown, bar.link, bar.text], ['flex', true, true]);

// A success clears the guard, so a later lapse can redirect again.
await page.evaluate(() => window.__server('connected', { status: 'success', username: 'x' }));
await Promise.all([
    page.waitForURL(/\/login\?next=/, { timeout: 10000 }),
    page.evaluate(() => window.__server('connected', { status: 'unauthenticated' })),
]);
check('§4 a successful connect clears the guard for the next time',
    /\/login\?next=/.test(page.url()), true);
await reopen();

check('§5 no page errors', errors, []);
await browser.close();
server.close();
console.log(`socket_self_heal: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
