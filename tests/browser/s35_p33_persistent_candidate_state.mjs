/*
 * S35 P33 — A PERSISTENT-SESSION OFFER MUST NOT LEAVE A TAB LOOKING CONNECTED.
 *
 * WHAT THE OWNER MEASURED ON PRODUCTION ( 05:30:31, P31)
 * ----------------------------------------------------------------------------
 * The existing admin browser reconnected and the server logged exactly two
 * `Persistent tmux session available for reconnect` events, one per surviving
 * tmux session, and NOTHING else -- no ssh_session_restored, no
 * ssh_replay_chunk, no replay terminator. The owner's screenshot shows exactly
 * those two tabs still GREEN / "connected" with both buffers empty and the
 * caret at the origin.
 *
 * WHY THE SERVER SENDS ONLY THAT, READ FROM THE SOURCE
 * ----------------------------------------------------------------------------
 * restore_user_sessions (socket_events.py:522) gates the whole restore on the
 * IN-MEMORY manager:
 *
 *     session = ssh_manager.get_session(session_id)
 *     if session and session.get('connected'):
 *         ... _build_session_snapshot -> ssh_session_restored
 *         ... build_replay_chunks     -> ssh_replay_chunk (+ final terminator)
 *     else:
 *         db_session.connected = False        # :617
 *
 * An app/container restart empties ssh_manager while the sqlite rows still say
 * connected=True, so EVERY row takes the else branch: no snapshot and no replay
 * frame is ever emitted for it. The row is then re-offered a few lines later as
 * a reconnect CANDIDATE (`persistent_session_available`, :627). That is the
 * intended contract -- the tmux session on the remote host really did survive,
 * but this server process has no channel to it, so the only honest thing it can
 * say is "available for reconnect".
 *
 * THE CLIENT DEFECT
 * ----------------------------------------------------------------------------
 * showPersistentSessionTab (session-manager.js:468) already encodes that
 * contract correctly for a session it has never seen: `connected: false`,
 * updateSessionStatus(..., 'disconnected'), no pane assignment, and an entry in
 * the reconnect list. But its first statement is
 *
 *     if (this.sessions[session_id]) { return; }
 *
 * and on a SOCKET RECONNECT under a preserved document that guard is exactly the
 * case that matters: the record from before the restart is still there, still
 * `connected: true`, still owning a green tab and a live-looking pane. The offer
 * is dropped on the floor, so the UI keeps asserting a connection this server
 * process cannot have. That is the owner's screenshot: green tab, dead channel.
 *
 * WHAT THIS SUITE PINS
 * ----------------------------------------------------------------------------
 * With EXACTLY TWO persisted sessions already present and connected, one
 * `persistent_session_available` per session must leave NEITHER of them
 * claiming a connection, and both must be reachable as reconnect candidates.
 * The two guards above every assertion make a zero-session vacuous pass
 * impossible.
 *
 * Run: node tests/browser/s35_p33_persistent_candidate_state.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0; const failures = [];
function check(l, a, e) {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) { pass++; console.log(`PASS  ${l}`); }
    else { fail++; failures.push(l); console.log(`FAIL  ${l}\n        expected ${E}\n        actual   ${A}`); }
}
const note = (l, v) => console.log(`NOTE  ${l} = ${JSON.stringify(v)}`);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png' };
let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8')
    .replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1')
    .replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1')
    .replace(/\{%[^%]*%\}/g, '').replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]')
    .replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass')
    .replace(/\{\{[^}]*\}\}/g, '');
const server = await new Promise(r => { const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === '/index.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return; }
    const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        res.writeHead(404); res.end('x'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(fs.readFileSync(fp));
}); s.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const INIT = `
    const noop = () => {}; window.__emits = []; window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.io = () => ({ connected: true, on: record, off: noop, once: record,
        emit: (ev, p) => window.__emits.push({ ev, payload: p }), io: { on: noop } });
    window.socket = window.io();
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.showNotification = () => {};
    window.ModalManager = { open: m => m && m.classList.add('show'),
        close: m => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const ctx = await browser.newContext({ viewport: { width: 1426, height: 780 } });
const page = await ctx.newPage();
const pageErrors = []; page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

const SID_A = 'p33persa', SID_B = 'p33persb';
const offer = (id, i) => ({
    snapshot_version: 1, session_id: id, host: 'tiny.example', port: 22,
    username: 'sshdtest', key_id: null, auth_type: 'password',
    tmux_session_name: `sshdeck_p33_${i}`, display_name: `P33 S${i}`, pane_index: null,
});
const restoredFrame = (id, i) => Object.assign({}, offer(id, i), {
    connected: true, use_tmux: true, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
    render_local: false, pty_cols: 164, pty_rows: 40,
});

/* The pre-restart world: both sessions live and connected in THIS document. */
for (const [id, i] of [[SID_A, 1], [SID_B, 2]]) {
    await page.evaluate((f) => window.__server('ssh_session_restored', f), restoredFrame(id, i));
    await page.waitForTimeout(150);
    await page.evaluate((s) => window.__server('ssh_replay_chunk', { session_id: s,
        seq: 0, total: 0, data: '', final: true, truncated: false, dropped_bytes: 0 }), id);
}
await page.waitForTimeout(400);

const before = await page.evaluate(([a, b]) => [a, b].map(s => ({
    exists: !!SessionManager.sessions[s],
    connected: !!(SessionManager.sessions[s] || {}).connected,
})), [SID_A, SID_B]);
note('state before the restart boundary', before);

/* GUARD: without exactly two connected sessions every row below is vacuous. */
check('GUARD exactly two sessions exist', before.filter(s => s.exists).length, 2);
check('GUARD both are connected before the boundary',
    before.filter(s => s.connected).length, 2);

/*
 * THE BOUNDARY. The app restarted: ssh_manager is empty, so the server marks
 * both rows disconnected and offers each one back as a reconnect candidate --
 * and NOTHING else. The socket reconnects under the SAME document, so the
 * client's own records survive.
 */
await page.evaluate(() => window.__server('connect', {}));
await page.waitForTimeout(80);
for (const [id, i] of [[SID_A, 1], [SID_B, 2]]) {
    await page.evaluate((f) => window.__server('persistent_session_available', f), offer(id, i));
    await page.waitForTimeout(120);
}
await page.waitForTimeout(400);

const after = await page.evaluate(([a, b]) => [a, b].map(s => {
    const rec = SessionManager.sessions[s] || {};
    const tab = document.getElementById(`tab-${s}`);
    const dot = tab ? tab.querySelector('.status-dot, .session-status, [class*="status"]') : null;
    return {
        exists: !!SessionManager.sessions[s],
        connected: !!rec.connected,
        isCandidate: !!rec.isPersistentCandidate,
        tabClass: tab ? tab.className : null,
        dotClass: dot ? dot.className : null,
    };
}), [SID_A, SID_B]);
note('state after the restart boundary', after);

check('GUARD two sessions are still under inspection', after.filter(s => s.exists).length, 2);

for (const [i, s] of after.entries()) {
    const tag = i === 0 ? 'A' : 'B';
    check(`THE OWNER SHAPE: session ${tag} no longer claims a connection`, s.connected, false);
    check(`THE OWNER SHAPE: session ${tag} is offered as a reconnect candidate`, s.isCandidate, true);
    check(`THE OWNER SHAPE: session ${tag}'s tab is not painted connected`,
        /\bconnected\b/.test(s.tabClass || '') || /\bconnected\b/.test(s.dotClass || ''), false);
}
check('no page errors', pageErrors.length, 0);
if (pageErrors.length) note('page errors', pageErrors.slice(0, 3));

console.log('');
if (failures.length) { console.log('FAILED ROWS:'); failures.forEach(f => console.log('  - ' + f)); }
console.log(`\n${pass} passed, ${fail} failed.`);
await ctx.close(); await browser.close(); server.close();
process.exit(fail ? 1 : 0);
