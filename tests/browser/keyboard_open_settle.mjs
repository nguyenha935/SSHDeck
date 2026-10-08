#!/usr/bin/env node
/*
 * OPENING A KEYBOARD MOVES THE CONTENT ONCE, AND THE TEXT KEEPS ITS SIZE.
 *
 * Owner, 2026-09-25: "Xử lý luôn cú chỉnh ... lúc bật bàn phím". Measured at
 * 428x926 (WebKit) with a server that answers a resize in 120 ms, before the
 * fix: the iOS keyboard took the font 12 -> 6 -> 12 and left the prompt under
 * the keyboard for 275 ms; the function keypad took it 12 -> 9.64 -> 12.
 * presentWindowGrid zoomed the OLD window into the new box while this page's
 * own proposal was still on its way, and the answer zoomed it back.
 *
 * OWNER RULING 2026-10-08: a keyboard no longer resizes the remote pane at
 * all -- it holds its grid and pushes the content up, like the composer
 * (TerminalManager.chromeResized), because every resize is a transcript
 * replay under omp. §1 and §2 asserted that a proposal went out and that its
 * answer did not move the content (restated, class a): no proposal goes out
 * and the grid keeps its rows. §3 and §4 pinned the hold on this page's OWN
 * proposal, which a keyboard no longer makes; they now make it with a change
 * of the window's width, which still is one. The same day the text got a
 * floor of 12 px that is never above the reader's own size, so the phone's
 * 12 px base is never shrunk at all: §3 and §4 set a 16 px base, and what they
 * pin -- WHEN the held window is zoomed into -- is unchanged (restated, a).
 *
 * The server here is a stand-in: it answers view_attach and ssh_resize with
 * tmux_window_geometry after RTT ms, with the size asked for, the size it
 * already had (another view holds the window), or not at all.
 *
 *   §1 the iOS keyboard (visual viewport 926 -> 469): nothing is proposed,
 *      the grid and the font keep their size, the last row takes two
 *      positions (before, after) and is anchored within two frames of the box
 *      shrinking; closing it proposes nothing either;
 *   §2 the function keypad: the same;
 *   §3 another view holds the window (the answer is the old size): the zoom
 *      happens as soon as that answer lands, not after the hold runs out;
 *   §4 no answer at all: the hold ends after RESIZE_HOLD_MS and the text zooms;
 *   §Z no page errors.
 *
 * Run: node tests/browser/keyboard_open_settle.mjs   (from source/)
 */
import { webkit } from 'playwright';
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

// __ANSWER: 'asked' (the size asked for), 'held' (the window as it was), 'none'.
const INIT = `
    const noop = () => {};
    window.__handlers = {}; window.__emits = [];
    window.__RTT = 120; window.__ANSWER = 'asked'; window.__window = null;
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    const answer = (p, attach) => setTimeout(() => {
        if (attach) window.__server('view_attached', { session_id: p.session_id });
        if (window.__ANSWER === 'none') return;
        if (window.__ANSWER === 'asked' || !window.__window) window.__window = { cols: p.cols, rows: p.rows };
        window.__server('tmux_window_geometry', { session_id: p.session_id, ...window.__window });
    }, window.__RTT);
    window.io = () => ({ connected: true, active: true, on: record, off: noop, once: record,
        io: { on: noop },
        emit: (ev, p) => {
            window.__emits.push({ ev, p, t: performance.now() });
            if ((ev === 'view_attach' || ev === 'ssh_resize') && p && p.cols && p.rows) {
                answer(p, ev === 'view_attach');
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
const S1 = 'abab7777-sett-4aba-8aba-000000000007';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'tiny', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null, use_tmux: true,
    tmux_session_name: 't-settle', display_name: null, pane_index: null,
    replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0,
    replay_history_lines: 0, legacy_tmux_locale: null,
};
const W = 428, H = 926, KB_VV = 469;
const errors = [];
const browser = await webkit.launch();

async function openPage() {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(([e, p]) => window.__server(e, p), ['ssh_session_restored', snapshot]);
    await page.waitForTimeout(900);
    let out = '';
    for (let i = 1; i <= 80; i += 1) out += `row ${String(i).padStart(3, '0')} ${'x'.repeat(20)}\r\n`;
    await page.evaluate(([s, d]) => window.__server('ssh_output', { session_id: s, data: d }), [S1, out + '$ ']);
    await page.waitForTimeout(700);
    return { ctx, page };
}

/* Every frame for `ms`: the box, the grid, the text size, and where the last
 * row sits -- read from what the DOM holds. */
async function record(page, trigger, ms) {
    await page.evaluate((ms) => {
        window.__emits.length = 0;
        const rec = window.__rec = [];
        const t0 = window.__t0 = performance.now();
        const find = () => {
            for (const row of document.querySelectorAll('.terminal-pane .xterm-rows > div')) {
                if (row.textContent.includes('row 080')) {
                    const r = row.getBoundingClientRect();
                    return [Math.round(r.top), Math.round(r.bottom)];
                }
            }
            return null;
        };
        const tick = () => {
            const box = document.querySelector('.terminal-area').getBoundingClientRect();
            const t = TerminalManager.terminals[TerminalManager.sessionTerminals[SessionManager.activeSessionId]?.[0]];
            rec.push({ t: performance.now() - t0, bottom: Math.round(box.bottom),
                rows: t.rows, font: t.options.fontSize, marker: find() });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        };
        // The first sample is taken NOW, before the trigger: the keyboard's
        // visual-viewport event shrinks the box synchronously, so the first
        // frame after it already shows the smaller box.
        tick();
    }, ms);
    await trigger();
    await page.waitForTimeout(ms + 200);
    return page.evaluate(() => ({
        rec: window.__rec,
        resizes: window.__emits.filter(e => e.ev === 'ssh_resize').length,
        base: TerminalManager.getBaseFontSize(),
    }));
}

function settleRows(label, { rec, resizes, base }) {
    const first = rec[0];
    const last = rec[rec.length - 1];
    check(`${label}: nothing is proposed and the grid keeps its rows`,
        [resizes, last.rows], [0, first.rows]);
    check(`${label}: the text never changes size`,
        [...new Set(rec.map(f => f.font))], [base]);
    const tops = rec.map(f => f.marker && f.marker[0]);
    const positions = tops.filter((v, i) => i === 0 || v !== tops[i - 1]);
    check(`${label}: the last row takes two positions, before and after (${positions.join(' -> ')})`,
        positions.length, 2);
    const shrunk = rec.findIndex(f => f.bottom < first.bottom);
    // From the shrink on: before it, the row was above the OLD edge anyway.
    const anchored = rec.findIndex((f, i) => i >= shrunk && f.marker && f.marker[1] <= f.bottom);
    check(`${label}: it is above the new edge within two frames of the box shrinking`,
        shrunk >= 0 && anchored >= shrunk && anchored - shrunk <= 2, true);
}

// Closing it: nothing proposed, the grid as it was.
async function closes(page, label, trigger) {
    const before = await page.evaluate(() => TerminalManager.terminals[
        TerminalManager.sessionTerminals[SessionManager.activeSessionId][0]].rows);
    await page.evaluate(() => { window.__emits.length = 0; });
    await trigger();
    await page.waitForTimeout(900);
    check(`${label}: closing it proposes nothing either`, await page.evaluate(() => [
        window.__emits.filter(e => e.ev === 'ssh_resize').length,
        TerminalManager.terminals[TerminalManager.sessionTerminals[SessionManager.activeSessionId][0]].rows,
    ]), [0, before]);
}

/* ------------------------------------------------- §1 the iOS keyboard */
{
    const { ctx, page } = await openPage();
    const r = await record(page, () => page.evaluate((h) => {
        document.getElementById('mobileInput').focus();
        window.__vvH = h;
        window.visualViewport.dispatchEvent(new Event('resize'));
    }, KB_VV), 1200);
    settleRows('§1 iOS keyboard', r);
    await closes(page, '§1 iOS keyboard', () => page.evaluate(() => {
        window.__vvH = null;
        window.visualViewport.dispatchEvent(new Event('resize'));
    }));
    await ctx.close();
}

/* ----------------------------------------------- §2 the function keypad */
{
    const { ctx, page } = await openPage();
    const r = await record(page, () => page.click('#mobileKeypadBtn'), 1200);
    settleRows('§2 keypad', r);
    await closes(page, '§2 keypad', () => page.click('#mobileKeypadBtn'));
    await ctx.close();
}

// A base above the floor, so a zoom into the held window can be seen.
async function largerBase(page) {
    await page.evaluate(() => TerminalManager.updateFontSize(16));
    await page.waitForTimeout(900);
}

/* ---------------------------- §3 another view holds the window as it was */
{
    const { ctx, page } = await openPage();
    await largerBase(page);
    // A production round trip: the server's resize path is an exec channel,
    // measured at 432-472 ms, so the answer lands AFTER the settle present --
    // with 120 ms here the settle timer happened to present it and hid a
    // missing presentNow on the unchanged-geometry path (mutation M3).
    await page.evaluate(() => { window.__ANSWER = 'held'; window.__RTT = 400; });
    const r = await record(page, () => page.setViewportSize({ width: W - 60, height: H }), 1200);
    const zoomed = r.rec.find(f => f.font < r.base);
    check('§3 the old window stays, so the text zooms to fit it', !!zoomed, true);
    check('§3 as soon as the answer lands, not after the hold (RESIZE_HOLD_MS)',
        !!zoomed && zoomed.t >= 350 && zoomed.t < 1000, true);
    await ctx.close();
}

/* ------------------------------------------------------ §4 no answer */
{
    const { ctx, page } = await openPage();
    await largerBase(page);
    await page.evaluate(() => { window.__ANSWER = 'none'; });
    const r = await record(page, () => page.setViewportSize({ width: W - 60, height: H }), 2200);
    const hold = await page.evaluate(() => TerminalManager.RESIZE_HOLD_MS);
    const early = r.rec.filter(f => f.t < hold - 100).some(f => f.font < r.base);
    const late = r.rec.find(f => f.font < r.base);
    check('§4 while the answer may still come, the text keeps its size', early, false);
    check('§4 once the hold runs out, it zooms', !!late && late.t >= hold - 100, true);
    await ctx.close();
}

check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`\nkeyboard_open_settle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
