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
 * Owner ruling (split screen): a pane keeps the session it was
 * given; selecting a session that is in no pane shows it FULL SCREEN without
 * touching the assignments; assignments are explicit and remembered on the
 * server (pane_index). Headless contract of the client half.
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
const emits = (ev) => page.evaluate(e =>
    window.__emits.filter(x => x.ev === e).map(x => x.payload || null), ev);
const clearEmits = () => page.evaluate(() => { window.__emits.length = 0; });
const ID = (n) => `${n}${n}${n}${n}1111-spl-4aaa-8aaa-00000000000${n}`;
const A = ID('a'), B = ID('b'), C = ID('c'), D = ID('d');
const restore = (id, host, paneIndex) => page.evaluate(({ id, host, paneIndex }) =>
    window.__server('ssh_session_restored', {
        snapshot_version: 1, session_id: id, host, port: 22, username: 'root',
        connected: true, auth_type: 'tailscale', key_id: null, via_jump: null,
        use_tmux: true, tmux_session_name: `sshdeck_root_${host}_22_${id.slice(0, 8)}`,
        display_name: null, pane_index: paneIndex, replay_total_chunks: 0,
        replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0,
        legacy_tmux_locale: null,
    }), { id, host, paneIndex });
const state = () => page.evaluate(() => {
    const grid = document.getElementById('terminalGrid');
    const shown = [...grid.querySelectorAll('.terminal-pane')].map(p =>
        (p.querySelector('.terminal-wrapper') || {}).id || null);
    return {
        layout: SessionManager.layout, panes: SessionManager.paneAssignments.slice(),
        solo: SessionManager.soloSessionId, active: SessionManager.activeSessionId,
        activePane: SessionManager.activePaneIndex, gridClass: grid.className,
        shown: shown.map(id => id ? id.replace('terminal-', '').slice(0, 8) : null),
        displayed: Object.entries(TerminalManager.getDisplayedSessionsMap())
            .filter(([, v]) => v).map(([k]) => k.slice(0, 8)).sort(),
    };
});
const short = (id) => id.slice(0, 8);

// §1 restore honours the remembered pane and leaves the rest as tabs
await page.evaluate(() => SessionManager.setSplitLayout(2, 'default'));
await clearEmits();
await restore(A, 'hosta', 0);
await restore(B, 'hostb', 1);
await restore(C, 'hostc', null);
let st = await state();
check('§1 A and B sit in their remembered panes, C in none', st.panes.map(x => x && short(x)), [short(A), short(B)]);
check('§1 nothing is re-sent for rows that already say so', await emits('session_pane_index'), []);
check('§1 the grid shows exactly A and B', st.shown, [short(A), short(B)]);

// §2 selecting the unassigned session shows it solo, assignments untouched
await page.evaluate((id) => SessionManager.switchSession(id), C);
st = await state();
check('§2 solo = C, grid is a single solo pane', [st.solo && short(st.solo), st.gridClass, st.shown], [short(C), 'terminal-grid split-1 solo', [short(C)]]);
check('§2 the split underneath is untouched', [st.layout, st.panes.map(x => x && short(x))], [2, [short(A), short(B)]]);
check('§2 C is the active session and the only displayed view', [short(st.active), st.displayed], [short(C), [short(C)]]);
check('§2 looking at C assigned nothing on the server', await emits('session_pane_index'), []);

// §3 selecting an assigned session returns to the split at its pane
await page.evaluate((id) => SessionManager.switchSession(id), B);
st = await state();
check('§3 back to the split, B active in pane 2', [st.solo, st.gridClass, st.activePane, short(st.active)], [null, 'terminal-grid split-2', 1, short(B)]);
check('§3 A and B still where they were', st.shown, [short(A), short(B)]);
check('§3 displayed views are the two panes again', st.displayed, [short(A), short(B)].sort());

// §4 explicit assignment through the modal replaces a slot and is persisted
await page.evaluate(() => SessionManager.showPaneAssignmentModal(2, 'default'));
const selects = await page.evaluate(() => [...document.querySelectorAll('#paneAssignmentList select')].map(s => ({ name: s.name, value: s.value.slice(0, 8), options: s.options.length })));
check('§4 one select per pane, preselected to the current occupant', selects, [
    { name: 'pane-0', value: short(A), options: 5 }, { name: 'pane-1', value: short(B), options: 5 }]);
check('§4 the preview mirrors the target grid', await page.evaluate(() => [document.getElementById('panePreview').className,
    [...document.querySelectorAll('#panePreview .pane-preview-cell strong')].map(s => s.textContent)]), ['pane-preview split-2', ['1', '2']]);
await clearEmits();
await page.evaluate((id) => { const s = document.querySelector('#paneAssignmentList select[name="pane-1"]'); s.value = id; s.dispatchEvent(new Event('change')); }, C);
check('§4 the preview follows the choice', await page.evaluate(() => document.querySelectorAll('#panePreview .pane-preview-cell span')[1].textContent), 'root@hostc');
await page.click('#applyPaneAssignment');
st = await state();
check('§4 pane 2 now holds C; A untouched', st.panes.map(x => x && short(x)), [short(A), short(C)]);
const sent = (await emits('session_pane_index')).map(p => ({ id: short(p.session_id), pane: p.pane_index })).sort((x, y) => x.id.localeCompare(y.id));
check('§4 the server hears B left its pane and C took pane 2', sent, [{ id: short(B), pane: null }, { id: short(C), pane: 1 }]);

// §5 a new connection with no free pane arrives solo, evicting nobody
await clearEmits();
await page.evaluate((id) => window.__server('ssh_connected', {
    snapshot_version: 1, session_id: id, host: 'hostd', port: 22, username: 'root',
    client_request_id: null, via_jump: null, use_tmux: true, key_id: null,
    auth_type: 'tailscale', tmux_session_name: 'sshdeck_root_hostd_22_dddd1111',
    display_name: null, legacy_tmux_locale: null, replay_max_lines: 2000,
}), D);
st = await state();
check('§5 D is solo, A and C keep their panes', [st.solo && short(st.solo), st.panes.map(x => x && short(x))], [short(D), [short(A), short(C)]]);

// §6 closing the solo session returns to the split
await page.evaluate((id) => SessionManager.removeSessionUI(id), D);
st = await state();
check('§6 solo cleared, split shown with A and C', [st.solo, st.gridClass, st.shown], [null, 'terminal-grid split-2', [short(A), short(C)]]);

// §7 a layout change keeps the leading slots and reports the dropped one
await clearEmits();
await page.evaluate(() => SessionManager.setSplitLayout(1, 'default'));
st = await state();
check('§7 single pane keeps A', [st.panes.map(x => x && short(x)), st.shown], [[short(A)], [short(A)]]);
check('§7 C is reported as unassigned', (await emits('session_pane_index')).map(p => ({ id: short(p.session_id), pane: p.pane_index })), [{ id: short(C), pane: null }]);
check('§8 no page errors', errors, []);
await browser.close();
server.close();
console.log(`split_sticky: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
