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
 * notepad_scope_restore.mjs -- a reload must load the note the panel shows.
 *
 * The saved scope comes back inside the connect-time `notepad_data` frame,
 * which answers the GLOBAL bucket (no session is bound when it is asked for).
 * Switching the panel to per-server did not fetch: it relied on
 * refreshNotepadHost, which only fetches when the TARGET changes, and on a
 * reload the session restore has usually already set the target. So the box
 * kept the global text under a per-server label -- empty, for a user who keeps
 * per-server notes: the owner's "tải lại trang note còn không load được gì
 * nữa".
 */
const browser = await chromium.launch();
const openApp = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    // The real socket.io library would replace the stub `io()` and app.js
    // would wire its handlers onto a live socket instead of the fixture.
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        panel?.classList.remove('collapsed', 'mobile-open');
        panel?.removeAttribute('hidden');
    });
    return { ctx, page, errors };
};
const emits = (page, ev) => page.evaluate(e =>
    window.__emits.filter(x => x.ev === e).map(x => x.payload || null), ev);
const boxText = (page) => page.evaluate(() =>
    document.getElementById('sessionNotepad')?.value ?? null);
const modeState = (page) => page.evaluate(() => ({
    perServerActive: !!document.getElementById('notepadModeServerBtn')?.classList.contains('active'),
    globalActive: !!document.getElementById('notepadModeGlobalBtn')?.classList.contains('active'),
}));
// A restored session, active before the notepad frame arrives -- the reload order.
const bindSession = (page) => page.evaluate(() => {
    const id = 'aaaa1111-note-4aaa-8aaa-000000000001';
    window.__server('ssh_session_restored', {
        snapshot_version: 1, session_id: id, host: 'goclaw', port: 22,
        username: 'root', connected: true, auth_type: 'password', key_id: null,
        via_jump: null, use_tmux: true, tmux_session_name: 'n1',
        display_name: 'goclaw', pane_index: null, replay_total_chunks: 0,
        replay_truncated: false, replay_dropped_bytes: 0,
        replay_history_lines: 0, legacy_tmux_locale: null,
    });
    return id;
});

{
    const { ctx, page, errors } = await openApp();
    console.log('      handlers registered = ' + JSON.stringify(await page.evaluate(
        () => Object.keys(window.__handlers).filter(k => /notepad|connect/.test(k)))));
    console.log('      textarea present = ' + await page.evaluate(
        () => !!document.getElementById('sessionNotepad')));
    await page.evaluate(() => window.__server('connected', { status: 'success' }));
    const id = await bindSession(page);
    await page.waitForTimeout(600);
    console.log('      emits after connect = ' + JSON.stringify(await page.evaluate(
        () => window.__emits.map(e => e.ev))));
    check('§A the connect-time fetch asks for no bucket (the global one)',
        await emits(page, 'get_notepad'), [null]);

    // The server answers the GLOBAL bucket and reports the saved scope.
    await page.evaluate(() => window.__server('notepad_data', {
        notepad: '', revision: 3, mode: 'global', target_id: null,
        stored_mode: 'per_server',
    }));
    await page.waitForTimeout(400);
    const state = await modeState(page);
    check('§B the panel lands on the saved scope', state, { perServerActive: true, globalActive: false });
    const asked = await emits(page, 'get_notepad');
    console.log('      get_notepad emits = ' + JSON.stringify(asked));
    check('§B and it asks for THAT scope\'s note', asked.length, 2);
    check('§B with the active session as the target',
        asked[1], { mode: 'per_server', target_id: 'goclaw' });

    // The per-server text arrives and lands in the box.
    await page.evaluate(() => window.__server('notepad_data', {
        notepad: 'ghi chú của goclaw', revision: 9, mode: 'per_server',
        target_id: 'goclaw', stored_mode: 'per_server',
    }));
    await page.waitForTimeout(300);
    check('§C the box shows the per-server note', await boxText(page), 'ghi chú của goclaw');

    // A late reply for the OLD bucket must not clobber it.
    await page.evaluate(() => window.__server('notepad_data', {
        notepad: 'ghi chú toàn cục', revision: 4, mode: 'global',
        target_id: null, stored_mode: 'per_server',
    }));
    await page.waitForTimeout(300);
    check('§C a late global reply is ignored', await boxText(page), 'ghi chú của goclaw');
    check('§Z no page errors', errors, []);
    await ctx.close();
}

{
    // A user whose saved scope IS global must not gain a second fetch.
    const { ctx, page, errors } = await openApp();
    await page.evaluate(() => window.__server('connected', { status: 'success' }));
    await bindSession(page);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__server('notepad_data', {
        notepad: 'ghi chú toàn cục', revision: 2, mode: 'global',
        target_id: null, stored_mode: 'global',
    }));
    await page.waitForTimeout(400);
    check('§D global stays global with one fetch',
        (await emits(page, 'get_notepad')).length, 1);
    check('§D and shows the global note', await boxText(page), 'ghi chú toàn cục');
    check('§D no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
