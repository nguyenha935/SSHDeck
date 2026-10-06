#!/usr/bin/env node
/*
 * THE COMPOSER PUSHES THE CONTENT UP; IT DOES NOT RESIZE THE REMOTE PANE.
 *
 * Owner, 2026-10-06, on a phone: omp in tmux "giật liên tục lên xuống" whenever
 * the screen size changes, "ngay cả bật bàn phím lên gõ thôi cũng nhảy". The
 * prod log of one typing turn: keyboard 45 -> 24 rows, then the composer
 * growing a line at a time 24 -> 22 -> 21 -> 19, Send 19 -> 24, keyboard
 * closing 24 -> 45 -- six SIGWINCHes, and omp answers every one by replaying
 * its transcript. OWNER RULING 2026-10-06: the composer's growth pushes the
 * content up instead; the keyboard still resizes (OWNER RULING 2026-09-19).
 *
 * A stand-in server answers every ssh_resize with the window geometry, as the
 * real one does, so a resize that gets out is followed through to the engine.
 *
 *   §1 growing the draft to four lines sends no ssh_resize; the grid and the
 *      font stay; the prompt row stays above the composer and the top rows
 *      are what goes out of view;
 *   §2 Send (the box back to one line) sends none either, and the grid sits
 *      in the pane as before;
 *   §3 the keyboard opening with a grown draft is ONE resize, and Send after
 *      it is none: the size reported was the pane with a one-line composer.
 *
 * Chromium and WebKit (the engine of the owner's iPhone).
 *
 * Run: node tests/browser/composer_pan.mjs [--shots DIR]   (from source/)
 */
import { chromium, webkit } from 'playwright';
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
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
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

// The server's part: every ssh_resize is answered with the window it makes.
const INIT = `
    const noop = () => {};
    window.__resizes = [];
    window.socket = {
        connected: true, on: noop, off: noop, once: noop, io: { on: noop }, connect: noop,
        emit: (ev, p) => {
            if (ev !== 'ssh_resize') return;
            window.__resizes.push([p.cols, p.rows]);
            setTimeout(() => TerminalManager.noteWindowGeometry(p.session_id, p.cols, p.rows), 40);
        },
    };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const SID = 'pan-1';
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate((sid) => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
        SessionManager.createSession({
            session_id: sid, host: 'pan.example', port: 22, username: 'panU',
            display_name: 'Pan', auth_type: 'key', key_id: 'k1',
            use_tmux: true, tmux_session_name: 'sshdeck_pan',
        });
        SessionManager.assignSessionToPane(sid, 0);
        TerminalManager.views[sid] = 'attached';
        delete TerminalManager.reportedSizes[sid];
        TerminalManager.reportLocalFit(sid);
    }, SID);
    await page.waitForTimeout(600);

    // A screen the way tmux paints one, on the alternate buffer: numbered rows
    // and the prompt on the last.
    const paint = () => page.evaluate((sid) => {
        const key = TerminalManager.sessionTerminals[sid][0];
        const term = TerminalManager.terminals[key];
        let data = '\x1b[?1049h';
        for (let i = 0; i < term.rows - 1; i++) data += `\x1b[${i + 1};1H\x1b[2Krow${String(i).padStart(2, '0')}`;
        data += `\x1b[${term.rows};1H\x1b[2KPROMPT>`;
        TerminalManager.writeOutput(sid, data);
    }, SID);
    await paint();
    await page.waitForTimeout(400);

    const state = () => page.evaluate((sid) => {
        const key = TerminalManager.sessionTerminals[sid][0];
        const term = TerminalManager.terminals[key];
        const pane = term.element.parentElement.getBoundingClientRect();
        const rows = [...term.element.querySelectorAll('.xterm-rows > div')];
        const find = (t) => rows.find(r => r.textContent.startsWith(t))?.getBoundingClientRect();
        const prompt = find('PROMPT>');
        const first = find('row00');
        const dock = document.getElementById('sessionBar').getBoundingClientRect();
        return {
            grid: [term.cols, term.rows],
            font: term.options.fontSize,
            resizes: window.__resizes.length,
            promptAboveComposer: !!prompt && prompt.bottom <= dock.top + 1 && prompt.top >= pane.top - 1,
            firstInView: !!first && first.top >= pane.top - 1,
            margin: term.element.querySelector('.xterm-screen').style.marginTop,
            dockTop: Math.round(dock.top),
        };
    }, SID);
    const type = async (value) => {
        await page.evaluate((v) => {
            const el = document.getElementById('mobileInput');
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
        await page.waitForTimeout(200);
    };

    const shot = (label) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${label}.png`) });
    const rest = await state();
    await shot('rest');
    await page.evaluate(() => { window.__resizes.length = 0; });
    console.log(`      [${name}] at rest: grid ${rest.grid}, font ${rest.font}, dock top ${rest.dockTop}`);
    check(`${name} §0 at rest the prompt sits above the composer and row 0 is in view`,
        [rest.promptAboveComposer, rest.firstInView], [true, true]);

    /* §1 the draft grows to four lines */
    for (const v of ['a', 'a\nb', 'a\nb\nc', 'a\nb\nc\nd']) await type(v);
    // Past RESIZE_HOLD_MS: a zoom held for an unanswered proposal shows by then.
    await page.waitForTimeout(1700);
    const grown = await state();
    await shot('grown');
    console.log(`      [${name}] four lines: dock top ${grown.dockTop}, margin ${grown.margin}`);
    check(`${name} §1 the composer really grew`, grown.dockTop < rest.dockTop - 40, true);
    check(`${name} §1 growing the draft sends no ssh_resize`, grown.resizes, 0);
    check(`${name} §1 the grid and the font stay as they were`,
        [grown.grid, grown.font], [rest.grid, rest.font]);
    check(`${name} §1 the prompt stays above the composer; the top rows go out of view`,
        [grown.promptAboveComposer, grown.firstInView], [true, false]);

    /* §2 Send: the box back to one line */
    await type('');
    await page.waitForTimeout(600);
    const sent = await state();
    check(`${name} §2 the box going back to one line sends no ssh_resize`, sent.resizes, 0);
    check(`${name} §2 and the pane is as it was at rest`,
        [sent.grid, sent.font, sent.promptAboveComposer, sent.firstInView, sent.dockTop],
        [rest.grid, rest.font, true, true, rest.dockTop]);

    /* §3 the keyboard opens over a grown draft, then Send */
    await type('a\nb\nc\nd');
    await page.setViewportSize({ width: 390, height: 520 });
    await page.waitForTimeout(1200);
    const keyboard = await state();
    await shot('keyboard');
    await type('');
    await page.waitForTimeout(1200);
    const after = await state();
    const sizes = await page.evaluate(() => window.__resizes);
    console.log(`      [${name}] keyboard: ${JSON.stringify(sizes)}`);
    check(`${name} §3 the keyboard is one resize, and Send after it is none`,
        [keyboard.resizes, after.resizes], [1, 1]);
    check(`${name} §3 what was reported is the pane with a one-line composer`,
        sizes[0] && sizes[0][1], after.grid[1]);
    check(`${name} §3 the prompt is above the composer at every step`,
        [keyboard.promptAboveComposer, after.promptAboveComposer], [true, true]);

    check(`${name} no page errors`, errors, []);
    await browser.close();
}
server.close();
console.log(`composer_pan: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
