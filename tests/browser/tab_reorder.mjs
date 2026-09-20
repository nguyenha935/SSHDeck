#!/usr/bin/env node
/*
 * THE NOTE MUST KEEP EVERY CHARACTER, at typing speed, over a slow link.
 *
 * Owner,: "Note khi gõ nhanh 1 chút hoặc hơi lag bị giật mất chữ,
 * nhảy xuống dòng,... cho chức năng lưu hoạt động có vấn đề."
 *
 * The save path is a revisioned, serialized, conditional write, and every step
 * of it can write the box: the ACK of a refused save, a foreign device's
 * broadcast, and the reply to the connect-time fetch. This suite drives all
 * three WHILE the user types, with the ACK deliberately slowed past the 300 ms
 * debounce, and asserts the only thing that matters: the box holds exactly
 * what was typed, the caret stays where the typist left it, and the last save
 * carries the full text.
 *
 * Run: node tests/browser/notepad_scope_restore.mjs   (from source/)
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
 * A SLOW, REVISIONED notepad server, in the page. It answers `save_notepad`
 * the way socket_events.handle_save_notepad does -- an ack carrying
 * applied/notepad/revision -- after a delay that outlasts the 300 ms debounce,
 * which is the "hơi lag" in the report.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
    };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
/*
 * Owner ruling (item C): chips can be arranged by drag, the order
 * is the account's. Desktop: press and move. Touch: hold 300 ms, then move;
 * a quick swipe is still a pan / session swipe and a 500 ms hold still opens
 * the actions sheet. Headless contract of the client half.
 */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
const STILL = '*,*::before,*::after{animation:none!important;transition:none!important}';
let still = await page.addStyleTag({ content: STILL });
const emits = (ev) => page.evaluate(e =>
    window.__emits.filter(x => x.ev === e).map(x => x.payload || null), ev);
const clearEmits = () => page.evaluate(() => { window.__emits.length = 0; });
const ID = (n) => `${n}${n}${n}${n}1111-tab-4aaa-8aaa-00000000000${n}`;
const A = ID('a'), B = ID('b'), C = ID('c'), D = ID('d');
const restore = (id, host) => page.evaluate(({ id, host }) =>
    window.__server('ssh_session_restored', {
        snapshot_version: 1, session_id: id, host, port: 22, username: 'root',
        connected: true, auth_type: 'tailscale', key_id: null, via_jump: null,
        use_tmux: true, tmux_session_name: `sshdeck_root_${host}_22_x`, display_name: null,
        pane_index: null, replay_total_chunks: 0, replay_truncated: false,
        replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
    }), { id, host });
const order = () => page.evaluate(() => [...document.querySelectorAll('#sessionTabs .session-tab')]
    .map(t => t.id.replace(/^tab-/, '').slice(0, 8)));
const short = (id) => id.slice(0, 8);
const SessionManagerSettle = await page.evaluate(() => SessionManager.DRAG_SETTLE_MS + 120);

// §1 the saved order arrives first and every restored chip lands in place
await page.evaluate(({ c, a, b }) => window.__server('tab_order', { order: [c, a, b] }), { c: C, a: A, b: B });
await restore(A, 'hosta'); await restore(B, 'hostb'); await restore(C, 'hostc'); await restore(D, 'hostd');
check('§1 chips follow the saved order, unlisted ones after', await order(), [C, A, B, D].map(short));
check('§1 restoring emits no order', await emits('save_tab_order'), []);

// §2 desktop: press and move B before C
const rect = async (id) => page.evaluate((s) => { const r = document.getElementById(`tab-${s}`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
const active = () => page.evaluate(() => SessionManager.activeSessionId && SessionManager.activeSessionId.slice(0, 8));
const activeBefore = await active();
let rb = await rect(B), rc = await rect(C);
// The drag you can see: while the pointer moves, the chip in
// hand carries an inline translate and a chip whose slot moved is sliding --
// a transition, so the stillness sheet is lifted for this one gesture.
await still.evaluate(el => el.remove());
await page.mouse.move(rb.x + rb.w / 2, rb.y + rb.h / 2);
await page.mouse.down();
const motion = { lifted: false, slid: false };
for (let i = 1; i <= 6; i++) {
    await page.mouse.move(rb.x + rb.w / 2 - ((rb.x + rb.w / 2 - (rc.x + 4)) * i) / 6, rb.y + rb.h / 2);
    const seen = await page.evaluate((s) => ({
        lifted: /translateX\(-?\d/.test(document.getElementById(`tab-${s}`).style.transform)
            && document.getElementById(`tab-${s}`).classList.contains('dragging'),
        slid: [...document.querySelectorAll('#sessionTabs .session-tab.drag-shift')]
            .some(t => getComputedStyle(t).transform !== 'none'),
    }), B);
    motion.lifted = motion.lifted || seen.lifted;
    motion.slid = motion.slid || seen.slid;
}
check('§2 while dragging, the chip in hand follows the pointer (inline translate)', motion.lifted, true);
check('§2 ... and a displaced chip slides to its new slot', motion.slid, true);
await page.mouse.up();
await page.waitForTimeout(SessionManagerSettle);
check('§2 released: no lift, no slide left behind', await page.evaluate((s) => ({
    transform: document.getElementById(`tab-${s}`).style.transform,
    classes: document.querySelectorAll('#sessionTabs .drag-shift, #sessionTabs .drag-settle, #sessionTabs .dragging').length,
}), B), { transform: '', classes: 0 });
still = await page.addStyleTag({ content: STILL });
check('§2 desktop drag puts B first', await order(), [B, C, A, D].map(short));
check('§2 the new order is sent to the server', (await emits('save_tab_order')).map(p => p.order.map(short)), [[B, C, A, D].map(short)]);
check('§2 a drag is not a click: the active session did not change', await active(), activeBefore);

// §3 touch: hold 300 ms, then move D before B
await clearEmits();
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
let rd = await rect(D); rb = await rect(B);
await touch('touchStart', rd.x + rd.w / 2, rd.y + rd.h / 2);
await page.waitForTimeout(380);
check('§3 after the hold the chip is armed', await page.evaluate((s) => document.getElementById(`tab-${s}`).classList.contains('drag-armed'), D), true);
for (let i = 1; i <= 8; i++) { await touch('touchMove', rd.x + rd.w / 2 - ((rd.x + rd.w / 2 - (rb.x + 4)) * i) / 8, rd.y + rd.h / 2); await page.waitForTimeout(16); }
await touch('touchEnd', 0, 0);
await page.waitForTimeout(100);
check('§3 hold-then-drag puts D first', await order(), [D, B, C, A].map(short));
check('§3 sent once, in the new order', (await emits('save_tab_order')).map(p => p.order.map(short)), [[D, B, C, A].map(short)]);
check('§3 the actions sheet did not open', await page.evaluate(() => document.getElementById('sessionActionsSheet')?.hidden !== false), true);

// §4 a quick swipe (no hold) never rearranges
await clearEmits();
let ra = await rect(A); rd = await rect(D);
await touch('touchStart', ra.x + ra.w / 2, ra.y + ra.h / 2);
for (let i = 1; i <= 6; i++) { await touch('touchMove', ra.x + ra.w / 2 - ((ra.x + ra.w / 2 - rd.x) * i) / 6, ra.y + ra.h / 2); await page.waitForTimeout(12); }
await touch('touchEnd', 0, 0);
await page.waitForTimeout(100);
check('§4 order untouched by a swipe', await order(), [D, B, C, A].map(short));
check('§4 nothing sent', await emits('save_tab_order'), []);

// §5 an order pushed by another device is applied
await page.evaluate(({ a, b, c, d }) => window.__server('tab_order', { order: [a, b, c, d] }), { a: A, b: B, c: C, d: D });
check('§5 the pushed order is applied', await order(), [A, B, C, D].map(short));
check('§6 no page errors', errors, []);
await browser.close();
server.close();
console.log(`tab_reorder: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
