#!/usr/bin/env node
/*
 * THE APP'S OWN CHROME DOES NOT RESIZE THE REMOTE PANE.
 *
 * Owner, 2026-10-08: resizing Notes or opening Files changes the screen, and
 * omp still jumps while it keeps changing. Measured on main 25fc949, desktop
 * 1440x900, with a server answering every resize: opening Notes proposed 130
 * columns where the pane had 167, a 100 px drag of the splitter five sizes
 * more, closing it 167 again, opening Files 127, opening Commands 130 -- each
 * one a SIGWINCH that omp answers by replaying its transcript. iPad and phone
 * proposed nothing: their panels lie over the terminal.
 *
 * OWNER RULING 2026-10-08: a side panel keeps the grid and the text scales
 * (down to TerminalManager.minFontSize; past it the pane is reported as it
 * is), and the keyboards push the content up (keyboard_open_settle). What
 * still resizes is the window, a rotation, a layout choice, another device.
 * The same day, after seeing it: "Chữ bị thu nhỏ lại quá mức ở 1 số màn hình
 * lớn" -- the floor was 9 px. It is 12 px, never above the reader's own size,
 * so §1-§3 run on a 3840x2160 screen, where a default panel leaves 12.8 px.
 *
 *   §1 desktop: opening, dragging, resetting and closing Notes, Files and
 *      Commands, and one replacing another, propose nothing; the grid stays;
 *      the text scales while a panel is open, never under the floor, and is
 *      back after;
 *   §1b on a 1440x900 screen a default Notes would leave 10.9 px: it resizes
 *      the pane, once each way, and the text stays at its size;
 *   §2 the floor: a panel dragged past it reports the pane as it is, with
 *      the text back at its size, and dragged back holds the grid again;
 *   §3 the window itself resized with a panel open is one proposal, of the
 *      window's change alone;
 *   §4 phone: with the keyboard up and the top rows hidden, the program's
 *      cursor row stays in view; with the cursor hidden, or the content
 *      scrolled (tmux copy mode), the last row does;
 *   §5 phone: rotating with the keyboard up is reported, as the pane now is;
 *   §6 the floor is 12 px and never above the reader's own size: a grid too
 *      large for the pane is drawn at 12 px under a 14 px base, and at 11 px,
 *      not enlarged, under an 11 px one;
 *   §Z no page errors.
 *
 * Run: node tests/browser/chrome_hold.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
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

// A stand-in server: an attach is acknowledged and every size asked for
// becomes the window, after a round trip.
const INIT = `
    const noop = () => {};
    window.__handlers = {}; window.__emits = [];
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.io = () => ({ connected: true, active: true, on: record, off: noop, once: record,
        io: { on: noop },
        emit: (ev, p) => {
            window.__emits.push({ ev, p });
            if ((ev === 'view_attach' || ev === 'ssh_resize') && p && p.cols && p.rows) {
                setTimeout(() => {
                    if (ev === 'view_attach') window.__server('view_attached', { session_id: p.session_id });
                    window.__server('tmux_window_geometry', { session_id: p.session_id, cols: p.cols, rows: p.rows });
                }, 40);
            }
        } });
    window.socket = window.io();
    window.showNotification = noop;
    window.ModalManager = { open: m => m && m.classList.add('show'), close: m => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    const vvH = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
    window.__vvH = null;
    Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true,
        get() { return window.__vvH ?? vvH.get.call(this); } });
`;
const SID = 'abab7777-chrm-4aba-8aba-000000000008';
const snapshot = {
    snapshot_version: 1, session_id: SID, host: 'tiny', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null, use_tmux: true,
    tmux_session_name: 't-chrome', display_name: null, pane_index: null,
    replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0,
    replay_history_lines: 0, legacy_tmux_locale: null,
};
const errors = [];

async function openPage(engine, options) {
    const browser = await engine.launch();
    const ctx = await browser.newContext(options);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    page.setDefaultTimeout(5000);
    await page.route('**/socket.io.min.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(([e, p]) => window.__server(e, p), ['ssh_session_restored', snapshot]);
    await page.waitForTimeout(900);
    return { browser, page };
}

const state = (page) => page.evaluate((sid) => {
    const t = TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]];
    return {
        resizes: window.__emits.filter(e => e.ev === 'ssh_resize').map(e => [e.p.cols, e.p.rows]),
        grid: [t.cols, t.rows],
        font: t.options.fontSize,
        base: TerminalManager.getBaseFontSize(),
    };
}, SID);
const clear = (page) => page.evaluate(() => { window.__emits.length = 0; });

/* ======================================================= desktop, §1-§3 */
{
    const { browser, page } = await openPage(chromium, { viewport: { width: 3840, height: 2160 } });
    await page.evaluate(() => localStorage.removeItem('workspace-notepad-width'));
    const rest = await state(page);
    // The ruled floor; read from the page where it exists.
    const floor = await page.evaluate(() => (typeof TerminalManager.minFontSize === 'function'
        ? TerminalManager.minFontSize() : 12));
    const step = async (fn, wait = 700) => {
        await clear(page);
        await fn();
        await page.waitForTimeout(wait);
        return state(page);
    };
    const drag = async (dx) => {
        const h = await page.locator('#resizeHandle').boundingBox();
        await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(h.x + h.width / 2 + (dx * i) / 10, h.y + h.height / 2);
            await page.waitForTimeout(30);
        }
        await page.mouse.up();
    };
    console.log(`      [desktop] at rest: grid ${rest.grid}, font ${rest.font}`);

    const notes = await step(() => page.click('#notepadOpenBtn'));
    check('§1 opening Notes proposes nothing and keeps the grid',
        [notes.resizes, notes.grid], [[], rest.grid]);
    check('§1 ...and the text scales into the narrower pane, above the floor',
        notes.font < rest.base && notes.font >= floor, true);
    const wider = await step(() => drag(-100));
    check('§1 dragging the splitter proposes nothing', [wider.resizes, wider.grid], [[], rest.grid]);
    // The handle is 0 px wide; its hit area is a ::before either side of it.
    const reset = await step(async () => {
        const h = await page.locator('#resizeHandle').boundingBox();
        await page.mouse.dblclick(h.x, h.y + h.height / 2);
    });
    check('§1 resetting the splitter proposes nothing', reset.resizes, []);
    const closed = await step(() => page.click('#notepadOpenBtn'));
    check('§1 closing Notes proposes nothing, and the text is back at its size',
        [closed.resizes, closed.grid, closed.font], [[], rest.grid, rest.base]);

    const files = await step(() => page.evaluate(() => window.openFileManager()));
    check('§1 opening Files proposes nothing', [files.resizes, files.grid], [[], rest.grid]);
    const filesClosed = await step(() => page.evaluate(() => window.sftpFileManager.closeInline()));
    check('§1 closing Files proposes nothing', [filesClosed.resizes, filesClosed.font], [[], rest.base]);
    const commands = await step(() => page.evaluate(() => CommandLibrary.openLibrary()));
    check('§1 opening Commands proposes nothing', [commands.resizes, commands.grid], [[], rest.grid]);
    const commandsClosed = await step(() => page.evaluate(() => CommandLibrary.closeLibrary()));
    check('§1 closing Commands proposes nothing', [commandsClosed.resizes, commandsClosed.font], [[], rest.base]);
    await step(() => page.click('#notepadOpenBtn'));
    const replaced = await step(() => page.evaluate(() => window.openFileManager()));
    check('§1 Files replacing Notes proposes nothing', [replaced.resizes, replaced.grid], [[], rest.grid]);
    const allClosed = await step(() => page.evaluate(() => window.sftpFileManager.closeInline()));
    check('§1 ...and closing it leaves the text at its size', [allClosed.resizes, allClosed.font], [[], rest.base]);

    /* ------------------------------------------------------ §2 the floor */
    await step(() => page.click('#notepadOpenBtn'));
    // How many proposals a drag sends is PROPOSAL_SETTLE_MS's business (the
    // first and the last, plus one per settle window the frames outlast); what
    // is ruled here is the size they end on.
    const past = await step(() => drag(-420));
    const pastLast = past.resizes[past.resizes.length - 1];
    check('§2 past the floor the pane is reported as it is: smaller than the grid',
        !!pastLast && pastLast[0] < rest.grid[0] && pastLast[0] === past.grid[0], true);
    check('§2 ...and the text is back at its size', past.font, rest.base);
    const back = await step(() => drag(380));
    check('§2 dragged back above it, the grid it had is asked for again',
        back.resizes[back.resizes.length - 1], rest.grid);
    check('§2 ...and the text scales again', back.font < rest.base && back.font >= 9, true);
    const held = await step(() => page.click('#notepadOpenBtn'));
    check('§2 closing the panel then proposes nothing', held.resizes, []);

    /* ------------------------------------------ §3 the window itself */
    await step(() => page.click('#notepadOpenBtn'));
    const shrunk = await step(() => page.setViewportSize({ width: 3700, height: 2160 }), 900);
    const panelGone = await page.evaluate(() =>
        TerminalManager.proposeBaseFit(TerminalManager.terminals[TerminalManager.sessionTerminals[
            SessionManager.activeSessionId][0]]).cols);
    check('§3 a narrower window with a panel open is one proposal',
        shrunk.resizes.length, 1);
    check('§3 ...of the window\'s change alone, not the panel\'s',
        shrunk.resizes[0] && shrunk.resizes[0][0] < rest.grid[0] && shrunk.resizes[0][0] > panelGone, true);
    const after = await step(() => page.click('#notepadOpenBtn'));
    check('§3 closing the panel after it proposes nothing', after.resizes, []);
    await browser.close();
}

/* -------------------------------------- §1b under the floor, 1440x900 */
{
    const { browser, page } = await openPage(chromium, { viewport: { width: 1440, height: 900 } });
    await page.evaluate(() => localStorage.removeItem('workspace-notepad-width'));
    const rest = await state(page);
    await clear(page);
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(900);
    const opened = await state(page);
    const own = await page.evaluate((sid) => {
        const fit = TerminalManager.proposeBaseFit(TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]]);
        return [fit.cols, fit.rows];
    }, SID);
    check('§1b a default Notes under the floor reports the pane as it is, and the text stays at its size',
        [opened.resizes.length > 0, opened.resizes[opened.resizes.length - 1], opened.grid, opened.font],
        [true, own, own, rest.base]);
    await clear(page);
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(900);
    const closed = await state(page);
    check('§1b closing it asks for the grid it had, at its size',
        [closed.resizes[closed.resizes.length - 1], closed.font], [rest.grid, rest.base]);
    await browser.close();
}

/* ========================================================= phone, §4-§5 */
for (const [name, engine, extra] of [['webkit', webkit, {}], ['chromium', chromium, { isMobile: true }]]) {
    const { browser, page } = await openPage(engine, {
        viewport: { width: 428, height: 926 }, hasTouch: true, deviceScaleFactor: 2, ...extra,
    });
    // A full-screen program: every row numbered, on the alternate screen.
    await page.evaluate((sid) => {
        const t = TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]];
        let data = '\x1b[?1049h';
        for (let i = 1; i <= t.rows; i++) data += `\x1b[${i};1H\x1b[2Kline ${String(i).padStart(2, '0')}`;
        window.__server('ssh_output', { session_id: sid, data });
    }, SID);
    await page.waitForTimeout(400);
    const inView = (label) => page.evaluate((label) => {
        const area = document.querySelector('.terminal-area').getBoundingClientRect();
        const row = [...document.querySelectorAll('.terminal-pane .xterm-rows > div')]
            .find(r => r.textContent.startsWith(label));
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return r.top >= area.top - 1 && r.bottom <= area.bottom + 1;
    }, label);
    await clear(page);
    await page.evaluate(() => {
        document.getElementById('mobileInput').focus();
        window.__vvH = 469;
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(500);
    const rows = await page.evaluate((sid) =>
        TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]].rows, SID);
    const kb = await state(page);
    check(`§4 ${name}: the keyboard proposes nothing and the top rows are out of view`,
        [kb.resizes, await inView('line 01'), await inView(`line ${String(rows).padStart(2, '0')}`)],
        [[], false, true]);
    await page.evaluate((sid) => window.__server('ssh_output', { session_id: sid, data: '\x1b[3;1H' }), SID);
    await page.waitForTimeout(300);
    check(`§4 ${name}: the program's cursor on row 3 brings row 3 into view`,
        await inView('line 03'), true);
    check(`§4 ${name}: and the pane clips what runs past its bottom; it does not scroll it`,
        await page.evaluate((sid) => {
            const el = TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]].element;
            return [getComputedStyle(el).overflowY, el.scrollHeight > el.clientHeight, el.scrollTop];
        }, SID), ['hidden', true, 0]);
    await page.evaluate((sid) => window.__server('ssh_output', { session_id: sid, data: '\x1b[?25l\x1b[2;1H' }), SID);
    await page.waitForTimeout(300);
    check(`§4 ${name}: a hidden cursor leaves the last row in view`,
        [await inView('line 02'), await inView(`line ${String(rows).padStart(2, '0')}`)], [false, true]);
    // A swipe scrolls the content and the frame stays at the bottom (OWNER
    // RULING 2026-10-08): tmux in copy mode, its position on the top row, the
    // cursor shown on row 3.
    await page.evaluate(([sid, cols]) => window.__server('ssh_output', { session_id: sid,
        data: `\x1b[1;${cols - 7}H[5/120]\x1b[?25h\x1b[3;1H` }), [SID, kb.grid[0]]);
    await page.waitForTimeout(1000);
    check(`§4 ${name}: scrolled (tmux copy mode), the frame stays at the bottom`,
        [await page.evaluate((sid) => TerminalManager.isSessionScrolled(sid), SID),
            await inView('line 03'), await inView(`line ${String(rows).padStart(2, '0')}`)],
        [true, false, true]);

    /* ---------------------------------------- §5 rotating with it up */
    await clear(page);
    await page.evaluate(() => { window.__vvH = 260; });
    await page.setViewportSize({ width: 926, height: 428 });
    await page.waitForTimeout(900);
    const rotated = await state(page);
    check(`§5 ${name}: rotating with the keyboard up is reported`,
        rotated.resizes.length >= 1, true);
    // A rotation is the viewport itself changing: the keyboard's room is not
    // carried across it, so what is reported is the pane as it now is.
    check(`§5 ${name}: ...as the pane now is, the keyboard's room not carried across`,
        await page.evaluate((sid) => {
            const t = TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]];
            const fit = TerminalManager.proposeBaseFit(t);
            const sent = window.__emits.filter(e => e.ev === 'ssh_resize').pop();
            const held = typeof TerminalManager.chromeHeld === 'function'
                ? TerminalManager.chromeHeld(t, 'pan') : null;
            return [held, !!sent && sent.p.rows === fit.rows];
        }, SID), [{ width: 0, height: 0 }, true]);
    await browser.close();
}

/* ------------------------- §6 the floor, and never above the reader's size */
{
    const { browser, page } = await openPage(chromium, { viewport: { width: 1440, height: 900 } });
    // A grid far larger than the pane, presented: the font the floor leaves.
    const drawnAt = (base) => page.evaluate(([sid, base]) => {
        const t = TerminalManager.terminals[TerminalManager.sessionTerminals[sid][0]];
        TerminalManager.updateFontSize(base);
        t.resize(t.cols * 3, t.rows * 3);
        TerminalManager.presentWindowGrid(t);
        return [typeof TerminalManager.minFontSize === 'function'
            ? TerminalManager.minFontSize() : null, t.options.fontSize];
    }, [SID, base]);
    check('§6 under a 14 px base the floor is 12 px, and a grid too large is drawn at it',
        await drawnAt(14), [12, 12]);
    check('§6 under an 11 px base the floor is 11 px: the text is not enlarged',
        await drawnAt(11), [11, 11]);
    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`chrome_hold: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
