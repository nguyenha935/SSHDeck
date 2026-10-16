#!/usr/bin/env node
/*
 * ON A PHONE THE KEYBOARD OPENS ONLY FROM THE COMPOSER (OWNER RULING 2026-10-16).
 *
 *   "click vào nút gửi hoặc click thẳng vào terminal là sẽ lên bàn phím ...
 *    Nút gửi không cần mở bàn phím. Click thẳng vào terminal phải click vào ô
 *    nhập text của terminal mới lên bàn phím."
 *
 * Measured on main 05777b9 (Chromium and WebKit, 390x844 touch): a tap or a
 * double tap on the terminal's content went xterm's textarea -> #mobileInput,
 * and Send focused the composer again whenever it had held focus at the press
 * -- which on a phone it can do with the keyboard put away.
 *
 * "The keyboard is up" is read as "something editable has focus": a phone
 * raises its keyboard for exactly that, and a headless browser has no keyboard
 * to look at. Every focus() on the composer is counted, so a call that lands on
 * an element that already had focus still shows.
 *
 * Playwright's WebKit delivers no click for a tap on a button whose pointerdown
 * is prevented -- Send's, which keeps focus where it is (measured on main
 * 05777b9 too: the line is not sent). The rows that need Send to run are
 * Chromium's; in WebKit they would pass without Send having done anything.
 *
 *   §1 keyboard down: a tap and a double tap on the content leave nothing
 *      editable focused and call no focus() on the composer
 *   §2 keyboard down: Send focuses nothing, empty or with text, and still sends
 *   §3 keyboard up: Send calls no focus() and the composer keeps focus
 *   §4 keyboard up: a tap on the content keeps the composer, and typing still
 *      lands in it (the earlier owner report, still fixed)
 *   §5 a tap on the composer is what opens it
 *   §6 the function keypad open: Send focuses nothing
 *   §Z no page errors
 *
 * Run: node tests/browser/touch_keyboard_focus.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

/*
 * Socket.IO client fixture, served at the vendored path the production template
 * actually loads (templates/index.html:1565).
 *
 * It has to define io() rather than assign window.socket: app.js:15 runs
 * `window.socket = io(...)` at startup, so a socket injected by addInitScript is
 * overwritten and captures nothing. That failure is silent -- it looks exactly
 * like the app not emitting -- which is why the fixture lives at the real path.
 *
 * ssh_input is echoed back as ssh_output so the terminal renders what was
 * transmitted, closing the same loop a remote shell would.
 */
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true,
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) {
            window.__emits.push({ evt, payload, t: performance.now() });
            if (evt === 'ssh_input' && payload && payload.data) {
                (handlers.ssh_output || []).forEach(fn => fn({
                    session_id: payload.session_id, data: payload.data,
                }));
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.io = () => sock;
})();
`;

const EMIT_PRELUDE = 'window.__emits = [];';

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
};

let browser;

async function shell({ width, height, touch }) {
    const ctx = await browser.newContext({
        viewport: { width, height }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(EMIT_PRELUDE);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'visual-s1', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(600);
    return { ctx, page, pageErrors };
}


const SPY = `
    window.__composerFocusCalls = 0;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
        if (this.id === 'mobileInput') window.__composerFocusCalls += 1;
        return focus.apply(this, args);
    };
`;
const errors = [];
const state = (page) => page.evaluate(() => {
    const a = document.activeElement;
    const focused = !a || a === document.body ? 'BODY'
        : a.id ? `#${a.id}`
            : String(a.className).includes('xterm-helper-textarea') ? 'xterm-textarea' : a.tagName;
    const calls = window.__composerFocusCalls;
    window.__composerFocusCalls = 0;
    return { focused, calls };
});
const sends = (page) => page.evaluate(() => window.__emits
    .filter(e => e.evt === 'ssh_input' && /\r/.test(e.payload?.data || '')).length);
const putAway = (page) => page.evaluate(() => {
    document.activeElement?.blur();
    window.__composerFocusCalls = 0;
});

for (const type of [chromium, webkit]) {
    const name = type.name();
    browser = await type.launch();
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
    await page.evaluate(SPY);
    const content = page.locator('#terminal-s1 .xterm-screen');
    const send = page.locator('#mobileSendBtn');
    const composer = page.locator('#mobileInput');

    await putAway(page);
    await content.tap();
    await page.waitForTimeout(300);
    check(`§1 [${name}] a tap on the content focuses nothing editable`,
        await state(page), { focused: 'BODY', calls: 0 });

    await putAway(page);
    await content.tap();
    await page.waitForTimeout(80);
    await content.tap();
    await page.waitForTimeout(300);
    check(`§1 [${name}] a double tap on the content focuses nothing editable`,
        await state(page), { focused: 'BODY', calls: 0 });

    await putAway(page);
    await send.tap();
    await page.waitForTimeout(300);
    check(`§2 [${name}] Send with an empty box focuses nothing`,
        await state(page), { focused: 'BODY', calls: 0 });

    await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        input.value = 'ls';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await putAway(page);
    const before = await sends(page);
    await send.tap();
    await page.waitForTimeout(300);
    check(`§2 [${name}] Send with text focuses nothing`,
        await state(page), { focused: 'BODY', calls: 0 });
    if (name === 'chromium') {
        check(`§2 [${name}] and still sends the line`, (await sends(page)) - before, 1);
    }

    if (name === 'chromium') {
        await composer.tap();
        await page.keyboard.type('pwd');
        await page.evaluate(() => { window.__composerFocusCalls = 0; });
        await send.tap();
        await page.waitForTimeout(300);
        check(`§3 [${name}] keyboard up: Send calls no focus() and the composer keeps it`,
            await state(page), { focused: '#mobileInput', calls: 0 });
    }

    await composer.tap();
    await page.evaluate(() => { window.__composerFocusCalls = 0; });
    await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await content.tap();
    await page.waitForTimeout(300);
    check(`§4 [${name}] keyboard up: a tap on the content keeps the composer`,
        (await state(page)).focused, '#mobileInput');
    await page.keyboard.type('xy');
    check(`§4 [${name}] and typing still lands in it`,
        await page.evaluate(() => document.getElementById('mobileInput').value), 'xy');

    await putAway(page);
    await composer.tap();
    await page.waitForTimeout(200);
    check(`§5 [${name}] a tap on the composer is what focuses it`,
        (await state(page)).focused, '#mobileInput');

    await putAway(page);
    await page.locator('#mobileKeypadBtn').tap();
    await page.waitForTimeout(250);
    await putAway(page);
    await send.tap();
    await page.waitForTimeout(300);
    check(`§6 [${name}] keypad open: Send focuses nothing`,
        await state(page), { focused: 'BODY', calls: 0 });

    errors.push(...pageErrors.map(e => `${name}: ${e}`));
    await ctx.close();
    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`\ntouch_keyboard_focus: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
