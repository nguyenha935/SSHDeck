/*
 * A CLICK OR A TAP ON A LINK OPENS OPEN / COPY (OWNER RULING 2026-10-18).
 *
 *   "kiểm tra vấn đề click link trong terminal đi. có cách nào click link mà
 *    nhảy ra được ngoài không?" -- desktop: "Hiện lựa chọn copy hoặc mở";
 *    phone: a small menu, Open / Copy; OSC 8: tmux on the target untouched.
 *
 * Measured on main 0b8de19 (Chromium and WebKit, desktop and touch, tmux mouse
 * reporting on and off): a URL printed as text opened nothing and the pointer
 * stayed `text`; an OSC 8 link opened through a native confirm(), and with
 * mouse reporting on its click also reached tmux as two mouse reports. tmux
 * 3.7c drops OSC 8 unless terminal-features has `hyperlinks`; a URL longer
 * than a row comes from tmux in one run, so xterm wraps it and marks the rows.
 *
 *   §1 desktop: a URL as text is a link (pointer), a click opens the menu by
 *      the pointer, with the whole URL; Open opens a new tab, noopener
 *   §2 Copy copies it
 *   §3 Escape and a press elsewhere close it; Escape reaches no session
 *   §4 punctuation and an unpaired bracket around a URL are not part of it
 *   §5 a URL wrapped over two rows is one link, from either row
 *   §6 a click beside a link is tmux's, as before: no menu, two reports
 *   §7 Shift+click keeps xterm's local selection: no menu
 *   §8 an OSC 8 link opens the same menu, with its real URI, no confirm()
 *   §9 a link that is not http(s) can be copied, not opened
 *   §10 touch: a tap opens a sheet along the bottom of the visible viewport,
 *       focuses nothing (no keyboard) and reaches tmux as nothing
 *   §11 a link on the cursor's row is still a link; the input line beside it
 *       still opens the keyboard
 *   §12 the backdrop closes the sheet; its rows are 44 px; a focused
 *       composer keeps its focus through it
 *   §Z no page errors
 *
 * Run: node tests/browser/terminal_links.mjs   (from source/)
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
    window.__opens = [];
    window.__confirms = 0;
    window.__copied = [];
    window.open = (...args) => { window.__opens.push(args); return null; };
    window.confirm = () => { window.__confirms += 1; return true; };
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied.push(text); } },
    });
`;
const errors = [];
const LONG = `https://example.com/${'w'.repeat(150)}`;
const write = (page, data) => page.evaluate(d => new Promise(resolve =>
    TerminalManager.terminals.s1.write(d, resolve)), data);
// The client point at the middle of a cell (0-based column and row).
const cellPoint = (page, col, row) => page.evaluate(({ col, row }) => {
    const t = TerminalManager.terminals.s1;
    const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: box.left + (col + 0.5) * box.width / t.cols, y: box.top + (row + 0.5) * box.height / t.rows };
}, { col, row });
const menu = page => page.evaluate(() => {
    const node = document.getElementById('terminalLinkMenu');
    if (!node || node.hidden) return { open: false };
    const box = node.getBoundingClientRect();
    const backdrop = document.querySelector('.terminal-link-backdrop');
    const vv = window.visualViewport;
    const rows = [...node.querySelectorAll('.terminal-link-item')].filter(b => !b.hidden);
    return {
        open: true,
        sheet: node.classList.contains('is-sheet'),
        backdrop: !!backdrop && !backdrop.hidden,
        url: node.querySelector('.terminal-link-url').textContent,
        actions: rows.map(b => b.dataset.linkAction),
        rowHeights: rows.map(b => Math.round(b.getBoundingClientRect().height)),
        box: { left: Math.round(box.left), top: Math.round(box.top),
            right: Math.round(box.right), bottom: Math.round(box.bottom) },
        viewport: { width: Math.round(vv.width), bottom: Math.round(vv.offsetTop + vv.height) },
    };
});
const reports = page => page.evaluate(() => window.__emits
    .filter(e => e.evt === 'ssh_input' && /\x1b\[</.test(e.payload?.data || '')).length);
const reset = page => page.evaluate(() => {
    TerminalManager.closeLinkMenu();
    document.activeElement?.blur();
    window.__emits.length = 0;
    window.__opens = [];
    window.__copied = [];
    window.__confirms = 0;
    window.__composerFocusCalls = 0;
});
const action = (page, name) => page.locator(`#terminalLinkMenu [data-link-action="${name}"]`);

// The screen every section reads: tmux's mouse reporting on, as SSHDeck sets.
const SCREEN = '\x1b[?1000h\x1b[?1006h\x1b[3J\x1b[2J\x1b[H'
    + '\x1b[4;1H\x1b]8;;https://example.com/osc8\x1b\\OSC8LINK\x1b]8;;\x1b\\'
    + '\x1b[6;1Hsee https://example.com/plain here'
    + '\x1b[8;1H(docs: https://example.com/a_(b)).'
    + '\x1b[10;1H\x1b]8;;javascript:alert(1)\x1b\\BADLINK\x1b]8;;\x1b\\'
    + `\x1b[13;1H${LONG}`
    + '\x1b[18;1H';

for (const type of [chromium, webkit]) {
    const name = type.name();
    browser = await type.launch();

    // ── desktop ──────────────────────────────────────────────────────────
    {
        const { ctx, page, pageErrors } = await shell({ width: 1280, height: 800, touch: false });
        await page.evaluate(SPY);
        await write(page, SCREEN);
        // mouse.click takes no modifiers: a held key is a real keydown.
        const click = async (col, row, hold = null) => {
            const at = await cellPoint(page, col, row);
            await page.mouse.move(at.x - 4, at.y);
            await page.mouse.move(at.x, at.y);
            await page.waitForTimeout(200);
            if (hold) await page.keyboard.down(hold);
            await page.mouse.click(at.x, at.y);
            if (hold) await page.keyboard.up(hold);
            await page.waitForTimeout(250);
            return at;
        };

        await reset(page);
        const plain = await cellPoint(page, 10, 5);
        await page.mouse.move(plain.x - 4, plain.y);
        await page.mouse.move(plain.x, plain.y);
        await page.waitForTimeout(250);
        check(`§1 [${name}] a URL printed as text is a link: the pointer`,
            await page.evaluate(() => getComputedStyle(TerminalManager.terminals.s1.element
                .querySelector('.xterm-screen')).cursor), 'pointer');
        await page.mouse.click(plain.x, plain.y);
        await page.waitForTimeout(250);
        let m = await menu(page);
        check(`§1 [${name}] a click on it opens the menu with the whole URL`,
            { open: m.open, sheet: m.sheet, url: m.url, actions: m.actions },
            { open: true, sheet: false, url: 'https://example.com/plain', actions: ['open', 'copy'] });
        check(`§1 [${name}] by the pointer, inside the viewport`,
            m.box.left >= plain.x - 1 && m.box.left <= plain.x + 1
            && m.box.top >= plain.y && m.box.top <= plain.y + 8
            && m.box.right <= 1280 && m.box.bottom <= 800, true);
        check(`§1 [${name}] the click reaches tmux as no mouse report`, await reports(page), 0);
        await action(page, 'open').click();
        await page.waitForTimeout(150);
        check(`§1 [${name}] Open opens a new tab, noopener`,
            await page.evaluate(() => window.__opens),
            [['https://example.com/plain', '_blank', 'noopener,noreferrer']]);
        check(`§1 [${name}] and closes the menu`, (await menu(page)).open, false);

        await reset(page);
        await click(10, 5);
        await action(page, 'copy').click();
        await page.waitForTimeout(150);
        check(`§2 [${name}] Copy copies the URL`,
            await page.evaluate(() => window.__copied), ['https://example.com/plain']);
        check(`§2 [${name}] and closes the menu`, (await menu(page)).open, false);

        await reset(page);
        await click(10, 5);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        check(`§3 [${name}] Escape closes it`, (await menu(page)).open, false);
        check(`§3 [${name}] and reaches no session`,
            await page.evaluate(() => window.__emits.filter(e => e.evt === 'ssh_input').length), 0);
        await click(10, 5);
        await page.mouse.click(640, 20);
        await page.waitForTimeout(150);
        check(`§3 [${name}] a press elsewhere closes it`, (await menu(page)).open, false);

        await reset(page);
        await click(14, 7);
        check(`§4 [${name}] "(docs: …/a_(b))." is …/a_(b)`,
            (await menu(page)).url, 'https://example.com/a_(b)');

        await reset(page);
        const cols = await page.evaluate(() => TerminalManager.terminals.s1.cols);
        check(`§5 [${name}] the long URL really wraps onto a second row`,
            await page.evaluate(() => TerminalManager.terminals.s1.buffer.active.getLine(13).isWrapped)
            && LONG.length > cols, true);
        await click(3, 13);
        check(`§5 [${name}] a click on its second row opens the whole URL`, (await menu(page)).url, LONG);
        await reset(page);
        await click(cols - 2, 12);
        check(`§5 [${name}] and on its first row`, (await menu(page)).url, LONG);

        await reset(page);
        await click(40, 5);
        check(`§6 [${name}] a click beside a link opens nothing`, (await menu(page)).open, false);
        check(`§6 [${name}] and is tmux's, as before: two reports`, await reports(page), 2);

        await reset(page);
        await click(10, 5, 'Shift');
        check(`§7 [${name}] Shift+click on a link opens no menu`, (await menu(page)).open, false);
        await page.evaluate(() => TerminalManager.terminals.s1.clearSelection());

        await reset(page);
        await click(3, 3);
        m = await menu(page);
        check(`§8 [${name}] an OSC 8 link opens the menu with its real URI`,
            { url: m.url, actions: m.actions }, { url: 'https://example.com/osc8', actions: ['open', 'copy'] });
        check(`§8 [${name}] and no native confirm()`, await page.evaluate(() => window.__confirms), 0);
        check(`§8 [${name}] nor a mouse report`, await reports(page), 0);

        await reset(page);
        await click(3, 9);
        m = await menu(page);
        check(`§9 [${name}] a javascript: link shows its URI and can only be copied`,
            { url: m.url, actions: m.actions }, { url: 'javascript:alert(1)', actions: ['copy'] });
        check(`§9 [${name}] nothing opened, no confirm()`,
            await page.evaluate(() => [window.__opens.length, window.__confirms]), [0, 0]);

        errors.push(...pageErrors.map(e => `${name} desktop: ${e}`));
        await ctx.close();
    }

    // ── touch ────────────────────────────────────────────────────────────
    {
        const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
        await page.evaluate(SPY);
        await write(page, SCREEN);
        const tap = async (col, row) => {
            const at = await cellPoint(page, col, row);
            await page.touchscreen.tap(at.x, at.y);
            await page.waitForTimeout(450);
            return at;
        };

        await reset(page);
        await tap(10, 5);
        let m = await menu(page);
        check(`§10 [${name}] a tap on a link opens a sheet with the whole URL`,
            { open: m.open, sheet: m.sheet, backdrop: m.backdrop, url: m.url },
            { open: true, sheet: true, backdrop: true, url: 'https://example.com/plain' });
        check(`§10 [${name}] along the bottom of the visible viewport, full width`,
            [Math.abs(m.box.bottom - m.viewport.bottom) <= 1, m.box.left, m.box.right],
            [true, 0, m.viewport.width]);
        check(`§10 [${name}] focusing nothing: no keyboard`,
            await page.evaluate(() => [window.__composerFocusCalls,
                document.activeElement === document.body]), [0, true]);
        check(`§10 [${name}] and reaching tmux as nothing`, await reports(page), 0);
        await action(page, 'open').tap();
        await page.waitForTimeout(200);
        check(`§10 [${name}] Open opens a new tab, noopener`,
            await page.evaluate(() => window.__opens),
            [['https://example.com/plain', '_blank', 'noopener,noreferrer']]);

        await reset(page);
        await write(page, '\x1b[6;30H');
        await tap(10, 5);
        check(`§11 [${name}] a link on the cursor's row is still a link`,
            [(await menu(page)).sheet, await page.evaluate(() => window.__composerFocusCalls)], [true, 0]);
        await reset(page);
        await tap(30, 5);
        check(`§11 [${name}] the input line beside it still opens the keyboard`,
            [(await menu(page)).open, await page.evaluate(() => [window.__composerFocusCalls,
                document.activeElement?.id])], [false, [1, 'mobileInput']]);
        await page.evaluate(() => document.activeElement?.blur());

        await reset(page);
        await tap(10, 5);
        m = await menu(page);
        check(`§12 [${name}] the sheet's rows are 44 px`, m.rowHeights.every(h => h >= 44), true);
        await page.touchscreen.tap(195, 120);
        await page.waitForTimeout(300);
        check(`§12 [${name}] the backdrop closes it`, (await menu(page)).open, false);

        await reset(page);
        await page.locator('#mobileInput').tap();
        await page.waitForTimeout(200);
        await tap(10, 5);
        await action(page, 'copy').tap();
        await page.waitForTimeout(200);
        check(`§12 [${name}] a focused composer stays focused through the sheet (its keyboard stays up)`,
            [await page.evaluate(() => document.activeElement?.id), await page.evaluate(() => window.__copied)],
            ['mobileInput', ['https://example.com/plain']]);

        errors.push(...pageErrors.map(e => `${name} touch: ${e}`));
        await ctx.close();
    }
    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`\nterminal_links: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
