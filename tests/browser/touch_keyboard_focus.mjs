#!/usr/bin/env node
/*
 * ON A PHONE THE KEYBOARD OPENS FROM THE COMPOSER AND FROM THE TERMINAL'S OWN
 * INPUT LINE, NOWHERE ELSE (OWNER RULING 2026-10-16).
 *
 *   "click vào nút gửi hoặc click thẳng vào terminal là sẽ lên bàn phím ...
 *    Nút gửi không cần mở bàn phím. Click thẳng vào terminal phải click vào ô
 *    nhập text của terminal mới lên bàn phím."
 *
 * "Ô nhập text của terminal" is the terminal's input line: the row the cursor
 * is on, or one either side (Cậu chose it, 2026-10-16). The first attempt
 * (v109/v107) read it as the composer and let xterm focus its textarea, then
 * dropped that focus a moment later. On the owner's iPhone that moment flashed
 * the screen as if resized, every tap after the keyboard had been up once
 * raised it again (iOS keeps the composer focused with its keyboard away), and
 * the input line no longer opened anything.
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
 *   §7 a tap on the cursor's row, or one either side, opens it; two rows
 *      away does not
 *   §8 the composer still focused with its keyboard away (iOS): a tap on the
 *      input line blurs and focuses it again; with the keyboard up, nothing
 *   §9 the composer focused: a tap on the content calls no focus()
 *   §10 xterm's textarea never takes focus, not even for a moment
 *   §11 a note being typed keeps its focus through a tap on the input line
 *   §12 a desktop click on the terminal still focuses xterm, also with the
 *      Broadcast composer on screen
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
    // Every focus that lands, the transient ones included (§10).
    window.__focusins = [];
    document.addEventListener('focusin', (e) => {
        const t = e.target;
        window.__focusins.push(t.id ? '#' + t.id
            : String(t.className).includes('xterm-helper-textarea') ? 'xterm-textarea' : t.tagName);
    }, true);
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
// The client point of a viewport row of the active terminal, mid-width.
const rowPoint = (page, row) => page.evaluate((r) => {
    const t = TerminalManager.terminals.s1;
    const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    const cell = box.height / t.rows;
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + (r + 0.5) * cell) };
}, row);
// Scrollback first, as in any real session: the cursor's buffer row is then
// baseY + cursorY, not its viewport row.
const cursorTo = (page, row) => page.evaluate((r) => new Promise(resolve =>
    TerminalManager.terminals.s1.write(`${'line\r\n'.repeat(200)}\x1b[${r + 1};1H`,
        () => resolve(TerminalManager.terminals.s1.buffer.active.baseY))), row);
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

    // Taps further apart than DOUBLE_TAP_MS (300), so none reads as a double.
    await page.evaluate(() => {
        window.__composerBlurs = 0;
        document.getElementById('mobileInput').addEventListener('blur', () => {
            window.__composerBlurs += 1;
        });
    });
    const CURSOR = 9;
    check(`§7 [${name}] the terminal has scrollback above the cursor`,
        (await cursorTo(page, CURSOR)) > 0, true);
    for (const [delta, opens] of [[0, true], [1, true], [-1, true], [2, false], [-2, false]]) {
        await putAway(page);
        const at = await rowPoint(page, CURSOR + delta);
        await page.touchscreen.tap(at.x, at.y);
        await page.waitForTimeout(450);
        check(`§7 [${name}] a tap ${delta === 0 ? 'on the cursor\'s row' : `${delta > 0 ? '+' : ''}${delta} row(s) from it`} ${opens ? 'opens' : 'does not open'} the keyboard`,
            await state(page), opens ? { focused: '#mobileInput', calls: 1 } : { focused: 'BODY', calls: 0 });
    }

    const line = await rowPoint(page, CURSOR);
    await composer.tap();
    await page.evaluate(() => {
        document.body.classList.remove('keyboard-open');
        window.__composerFocusCalls = 0;
        window.__composerBlurs = 0;
    });
    await page.touchscreen.tap(line.x, line.y);
    await page.waitForTimeout(450);
    check(`§8 [${name}] composer focused, keyboard away: the input line blurs and focuses it again`,
        { ...(await state(page)), blurs: await page.evaluate(() => window.__composerBlurs) },
        { focused: '#mobileInput', calls: 1, blurs: 1 });
    await page.evaluate(() => {
        document.body.classList.add('keyboard-open');
        window.__composerBlurs = 0;
    });
    await page.touchscreen.tap(line.x, line.y);
    await page.waitForTimeout(450);
    check(`§8 [${name}] keyboard up: the input line leaves it alone`,
        { ...(await state(page)), blurs: await page.evaluate(() => window.__composerBlurs) },
        { focused: '#mobileInput', calls: 0, blurs: 0 });
    await page.evaluate(() => document.body.classList.remove('keyboard-open'));

    const far = await rowPoint(page, CURSOR + 6);
    await composer.tap();
    await page.evaluate(() => { window.__composerFocusCalls = 0; });
    await page.touchscreen.tap(far.x, far.y);
    await page.waitForTimeout(300);
    check(`§9 [${name}] composer focused: a tap on the content calls no focus()`,
        await state(page), { focused: '#mobileInput', calls: 0 });

    await page.evaluate(() => TerminalManager.terminals.s1.focus());
    check(`§10 [${name}] xterm's textarea never took focus, through every tap here or terminal.focus()`,
        await page.evaluate(() => window.__focusins.filter(f => f === 'xterm-textarea').length), 0);

    await page.evaluate(() => {
        document.getElementById('notepadPanel').classList.add('mobile-open');
        document.getElementById('sessionNotepad').focus();
        window.__composerFocusCalls = 0;
    });
    const noteLine = await rowPoint(page, CURSOR);
    check(`§11 [${name}] the input line is uncovered with the Notes sheet open`,
        await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#terminal-s1'), noteLine), true);
    await page.touchscreen.tap(noteLine.x, noteLine.y);
    await page.waitForTimeout(450);
    check(`§11 [${name}] a note being typed keeps its focus through a tap on the input line`,
        await state(page), { focused: '#sessionNotepad', calls: 0 });

    errors.push(...pageErrors.map(e => `${name}: ${e}`));
    await ctx.close();

    const desk = await shell({ width: 1280, height: 800, touch: false });
    await desk.page.locator('#terminal-s1 .xterm-screen').click();
    await desk.page.waitForTimeout(200);
    check(`§12 [${name}] a desktop click on the terminal still focuses xterm`,
        (await state(desk.page)).focused, 'xterm-textarea');
    await desk.page.evaluate(() => {
        document.activeElement?.blur();
        document.body.classList.add('broadcast-composer');
    });
    check(`§12 [${name}] the Broadcast composer is on screen on a desktop`,
        await desk.page.evaluate(() => document.getElementById('mobileInput').offsetParent !== null), true);
    await desk.page.locator('#terminal-s1 .xterm-screen').click();
    await desk.page.waitForTimeout(200);
    check(`§12 [${name}] with it, a desktop click on the terminal still focuses xterm`,
        (await state(desk.page)).focused, 'xterm-textarea');
    errors.push(...desk.pageErrors.map(e => `${name} desktop: ${e}`));
    await desk.ctx.close();
    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`\ntouch_keyboard_focus: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
