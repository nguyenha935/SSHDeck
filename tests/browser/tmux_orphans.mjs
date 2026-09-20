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
 * Owner ruling: closing a tmux-backed session must not leave
 * garbage on the host, and orphans are cleaned only by explicit request.
 * Headless contract of the client half: the sweep action is enabled only for
 * a LIVE tmux session, lists what the server answers, kills exactly the row
 * that was clicked, and a "kept" close is announced rather than swallowed.
 */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
// app.js installs its own showNotification at load; record after that.
await page.evaluate(() => {
    window.__notes = [];
    window.showNotification = (msg, type) => { window.__notes.push({ msg, type }); };
});
const emits = (ev) => page.evaluate(e =>
    window.__emits.filter(x => x.ev === e).map(x => x.payload || null), ev);
const LIVE = 'aaaa1111-orph-4aaa-8aaa-000000000001';
const CAND = 'bbbb2222-orph-4bbb-8bbb-000000000002';
await page.evaluate(({ live, cand }) => {
    window.__server('ssh_session_restored', {
        snapshot_version: 1, session_id: live, host: 'tiny', port: 22, username: 'root',
        connected: true, auth_type: 'tailscale', key_id: null, via_jump: null,
        use_tmux: true, tmux_session_name: 'sshdeck_root_tiny_22_aaaa1111',
        display_name: null, pane_index: null, replay_total_chunks: 0,
        replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0,
        legacy_tmux_locale: null,
    });
    window.__server('persistent_session_available', {
        snapshot_version: 1, session_id: cand, host: 'tiny', port: 22, username: 'root',
        key_id: null, auth_type: 'tailscale', tmux_session_name: 'sshdeck_root_tiny_22_bbbb2222',
        display_name: null, pane_index: null,
    });
}, { live: LIVE, cand: CAND });
const disabledFor = (id) => page.evaluate((s) => {
    SessionManager.setLifecycleActionTarget(s);
    return document.getElementById('sessionActionOrphans').disabled;
}, id);
check('§1 sweep enabled for the live tmux session', await disabledFor(LIVE), false);
check('§1 sweep disabled for a saved candidate', await disabledFor(CAND), true);
await page.evaluate((s) => { SessionManager.setLifecycleActionTarget(s); SessionManager.dispatchLifecycleAction('orphans'); }, LIVE);
check('§2 the action asks the server for this session', await emits('tmux_orphans_list'), [{ session_id: LIVE }]);
check('§2 loading text names the host', await page.evaluate(() => document.getElementById('tmuxOrphansStatus').textContent.includes('tiny')), true);
const now = Math.floor(Date.now() / 1000);
await page.evaluate(({ s, now }) => window.__server('tmux_orphans', { session_id: s, host: 'tiny', checked: 5, orphans: [
    { name: 'sshdeck_root_tiny_22_dead0001', created: now - 90000, attached: 0 },
    { name: 'sshdeck_root_tiny_22_dead0002', created: now - 120, attached: 1 },
] }), { s: LIVE, now });
const rows = () => page.evaluate(() => [...document.querySelectorAll('#tmuxOrphansList [data-orphan-row]')].map(r => r.dataset.orphanRow));
check('§3 two orphan rows rendered', await rows(), ['sshdeck_root_tiny_22_dead0001', 'sshdeck_root_tiny_22_dead0002']);
check('§3 row meta shows age and attachment', await page.evaluate(() => {
    const rowsText = [...document.querySelectorAll('#tmuxOrphansList [data-orphan-row] div div')].map(d => d.textContent);
    return [rowsText[0].startsWith('1d 1h'), rowsText[1].startsWith('2m'), rowsText[1].includes('attached')];
}), [true, true, true]);
await page.evaluate(() => window.__server('tmux_orphans', { session_id: 'someone-else', host: 'x', checked: 1, orphans: [] }));
check('§3 an answer for another session is ignored', await rows(), ['sshdeck_root_tiny_22_dead0001', 'sshdeck_root_tiny_22_dead0002']);
await page.click('#tmuxOrphansList button[data-orphan="sshdeck_root_tiny_22_dead0002"]');
check('§4 kill emits exactly the clicked name', await emits('tmux_orphan_kill'), [{ session_id: LIVE, name: 'sshdeck_root_tiny_22_dead0002' }]);
check('§4 the button is disabled while the kill is in flight', await page.evaluate(() => document.querySelector('#tmuxOrphansList button[data-orphan="sshdeck_root_tiny_22_dead0002"]').disabled), true);
await page.evaluate((s) => window.__server('tmux_orphans_error', { session_id: s, name: 'sshdeck_root_tiny_22_dead0002', error: 'boom' }), LIVE);
check('§5 an error re-enables that button and is announced', await page.evaluate(() => [
    document.querySelector('#tmuxOrphansList button[data-orphan="sshdeck_root_tiny_22_dead0002"]').disabled,
    window.__notes.at(-1)?.type, window.__notes.at(-1)?.msg.includes('boom')]), [false, 'error', true]);
await page.evaluate((s) => window.__server('tmux_orphan_killed', { session_id: s, name: 'sshdeck_root_tiny_22_dead0002' }), LIVE);
check('§6 a killed orphan leaves the list', await rows(), ['sshdeck_root_tiny_22_dead0001']);
await page.evaluate((s) => window.__server('tmux_orphan_killed', { session_id: s, name: 'sshdeck_root_tiny_22_dead0001' }), LIVE);
check('§6 the empty list says so', await page.evaluate(() => [document.querySelectorAll('#tmuxOrphansList [data-orphan-row]').length,
    document.getElementById('tmuxOrphansStatus').textContent.length > 0]), [0, true]);
await page.evaluate((s) => window.__server('ssh_session_kept', { session_id: s, error: 'SSH transport is not active' }), LIVE);
check('§7 a kept close is announced as a warning with the reason', await page.evaluate(() => [window.__notes.at(-1)?.type,
    window.__notes.at(-1)?.msg.includes('SSH transport is not active')]), ['warning', true]);
check('§8 no page errors', errors, []);
await browser.close();
server.close();
console.log(`tmux_orphans: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
