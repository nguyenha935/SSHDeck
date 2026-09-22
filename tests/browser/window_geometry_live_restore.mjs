#!/usr/bin/env node
/*
 * The two client halves of the owner report, as gates:
 *
 *   "Màn hình được co lại không ra giữa trên cùng mà vẫn co về góc trái trên
 *    cùng."  -- tmux draws a window smaller than the client in the top-left
 *   corner with filler. The server now holds every view's PTY at the minimum
 *   over the views' TRUE fits and announces it (`tmux_window_geometry`); the
 *   client renders that size, centred, while still REPORTING its true fit.
 *
 *   "Các nút connect không đồng bộ ngay trên điện thoại"  -- a connect on one
 *   socket is announced to the user's others as a `live` restore snapshot;
 *   the receiver lists it without displaying it, and a `replaces_session_id`
 *   retires the stale offer in place. `ssh_session_removed` retires a row
 *   another device deleted.
 *
 * Sections:
 *   §A  geometry below the fit: engine takes the window's size, grid centred,
 *       the true fit is still what was reported (no ssh_resize follows);
 *       geometry above the fit: engine returns to the fit
 *   §B  a live snapshot joins the list and takes no pane, no activation, no
 *       view
 *   §C  a live snapshot replacing a session this page shows takes that
 *       session's pane
 *   §D  ssh_session_removed retires a session
 *   §Z  zero page errors
 *
 * Run: node tests/browser/window_geometry_live_restore.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
}
const checkTrue = (label, actual) => check(label, actual === true, true);
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);

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
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
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
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const INIT = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.io = () => ({
        connected: true, on: record, off: noop, once: record,
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        io: { on: noop },
    });
    window.socket = window.io();
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.showNotification = (m, t) => {};
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const ctx = await browser.newContext({
    viewport: { width: 1426, height: 780 }, hasTouch: false, isMobile: false,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(
    () => typeof SessionManager !== 'undefined' && !!window.socket
        && typeof TerminalManager !== 'undefined',
    null, { timeout: 15000 });
await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
});

const snapshotFrame = (id, i, extra = {}) => Object.assign({
    snapshot_version: 1, session_id: id, host: 'tiny.example', port: 22,
    username: 'sshdtest', connected: true, auth_type: 'password', key_id: null,
    via_jump: null, use_tmux: true, tmux_session_name: `sshdeck_wg_${i}`,
    display_name: `WG S${i}`, pane_index: null, replay_total_chunks: 0,
    replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0,
    legacy_tmux_locale: null,
}, extra);

const TerminalManager_ZOOM_MIN_FONT = await page.evaluate(() => TerminalManager.ZOOM_MIN_FONT);
const S1 = 'aaaa1111-wgxx-4aaa-8aaa-000000000001';
const S2 = 'bbbb2222-wgxx-4bbb-8bbb-000000000002';
const S3 = 'cccc3333-wgxx-4ccc-8ccc-000000000003';
const S4 = 'dddd4444-wgxx-4ddd-8ddd-000000000004';

const serverSend = (ev, payload) =>
    page.evaluate(({ e, p }) => window.__server(e, p), { e: ev, p: payload });
const emitsOf = (ev) => page.evaluate(
    e => window.__emits.filter(x => x.ev === e).map(x => x.payload), ev);
const READ = (sid) => page.evaluate((s) => {
    const keys = TerminalManager.sessionTerminals[s] || [];
    const t = TerminalManager.terminals[keys[0]];
    const wrapper = document.getElementById(`terminal-${s}`);
    const screen = wrapper ? wrapper.querySelector('.xterm-screen') : null;
    return {
        exists: !!SessionManager.sessions[s],
        cols: t ? t.cols : null,
        rows: t ? t.rows : null,
        marginLeft: screen ? parseFloat(screen.style.marginLeft || '0') : null,
        marginTop: screen ? parseFloat(screen.style.marginTop || '0') : null,
        font: t ? t.options.fontSize : null,
        base: TerminalManager.getBaseFontSize(),
        fillW: (screen && wrapper) ? +(screen.getBoundingClientRect().width / wrapper.getBoundingClientRect().width).toFixed(2) : null,
        fillH: (screen && wrapper) ? +(screen.getBoundingClientRect().height / wrapper.getBoundingClientRect().height).toFixed(2) : null,
        screenBottom: screen ? Math.round(screen.getBoundingClientRect().bottom) : null,
        paneBottom: t ? Math.round(t.element.getBoundingClientRect().bottom - parseFloat(getComputedStyle(t.element).paddingBottom)) : null,
        pane: (SessionManager.paneAssignments || []).indexOf(s),
        active: SessionManager.activeSessionId === s,
        view: TerminalManager.views[s] || 'detached',
        visible: wrapper ? !!(wrapper.offsetWidth || wrapper.offsetHeight) : false,
    };
}, sid);

// ── §A geometry ────────────────────────────────────────────────────────────
await serverSend('ssh_session_restored', snapshotFrame(S1, 1));
await page.waitForFunction(
    () => window.__emits.some(e => e.ev === 'view_attach'), null, { timeout: 5000 });
await serverSend('view_attached', { session_id: S1 });
await page.waitForTimeout(200);
const attach = (await emitsOf('view_attach'))[0];
const fit = await READ(S1);
/*
 * The engine is compared with the LATEST report, not the attach payload:
 * the web font lands after the first fit, the cell gets wider, and the fit
 * that follows re-reports the pane (measured: view_attach 164 then
 * ssh_resize 163). What must hold is that the engine and the server agree.
 */
const lastReport = (await emitsOf('ssh_resize')).filter(r => r.session_id === S1).pop() || attach;
num('§A true fit', { attach: { cols: attach.cols, rows: attach.rows },
    reported: { cols: lastReport.cols, rows: lastReport.rows }, engine: fit });
check('§A the engine holds the reported fit before any geometry', [fit.cols, fit.rows],
    [lastReport.cols, lastReport.rows]);
checkTrue('§A the fit is wider than the phone window we are about to apply', fit.cols > 60);

const resizesBefore = (await emitsOf('ssh_resize')).length;
await serverSend('tmux_window_geometry', { session_id: S1, cols: 51, rows: 20 });
await page.waitForTimeout(150);
const shrunk = await READ(S1);
num('§A after 51x20', shrunk);
check('§A engine takes the window size', [shrunk.cols, shrunk.rows], [51, 20]);
/*
 * RESTATED for OWNER RULING B4 (2026-09-22). This used to read "the grid
 * FILLS the pane width, > 0.97" -- the 2026-09-14 ruling taken literally.
 * Filling the last few per cent costs letter spacing, and unbounded spacing is
 * what the owner reported as unreadable: measured on this very window, the old
 * code put 14.96px between characters, 165.7% of a character's own width.
 *
 * B4 caps the spacing at LETTER_SPACING_MAX_RATIO and leaves the rest as
 * margin. So the pane is either filled, or the leftover is a real margin --
 * and never a frame jammed against one edge, which is the "cut frame in a
 * black field" this section exists for.
 */
checkTrue('§A the grid is centred in whatever it does not fill',
    shrunk.marginLeft >= 0);
checkTrue('§A and it either fills the width or leaves an even margin',
    shrunk.fillW > 0.97 || shrunk.marginLeft > 0);
/*
 * PRESENTED, not merely rendered: a 51x20 window in a 1426x780 pane is drawn
 * at a larger font so it fills the pane on one axis (the owner's "cut frame
 * in a black field"), and the reported fit is still the pane's own.
 */
checkTrue('§A a window below the fit is zoomed (font above the base)',
    shrunk.font > shrunk.base);
checkTrue('§A and fills the pane on one axis', shrunk.fillW > 0.85 || shrunk.fillH > 0.85);
checkTrue('§A the grid stays inside the pane', shrunk.fillW <= 1.01 && shrunk.fillH <= 1.01);
check('§A no ssh_resize follows: the true fit is unchanged and stays reported',
    (await emitsOf('ssh_resize')).length, resizesBefore);
check('§A windowGeometry recorded',
    await page.evaluate(s => TerminalManager.windowGeometry[s], S1), { cols: 51, rows: 20 });

/*
 * A window LARGER than this pane is still the engine's size. The server sets
 * every view's PTY to the window, so that is how many rows and columns tmux
 * paints for this client; rendering fewer would leave tmux addressing rows the
 * engine does not have, which scrolls the content up (owner,:
 * "khung nội dung chuẩn của terminal bị đẩy lên cao"). The pane simply clips.
 * In practice the window is the MINIMUM over the views' fits, so it is never
 * larger than this one's -- except transiently, which is what this row pins.
 */
await serverSend('tmux_window_geometry', { session_id: S1, cols: 500, rows: 200 });
await page.waitForTimeout(150);
const grown = await READ(S1);
check('§A a window larger than the pane is still what the engine renders',
    [grown.cols, grown.rows], [500, 200]);
//: text scales both ways -- a window past the pane shrinks the
// font toward the floor instead of keeping the base and overflowing.
check('§A a window above the fit shrinks the text to the floor', grown.font, TerminalManager_ZOOM_MIN_FONT);
checkTrue('§A a grid taller than the pane shows its LAST rows (bottom anchored)',
    grown.marginTop < 0 && Math.abs(grown.screenBottom - grown.paneBottom) <= 1);

// A detach clears the geometry so the next attach starts from the fit.
await page.evaluate(s => TerminalManager.detachViews([s]), S1);
check('§A detach clears the geometry',
    await page.evaluate(s => TerminalManager.windowGeometry[s] ?? null, S1), null);
await page.evaluate(() => TerminalManager.syncViews());
await page.waitForTimeout(100);
await serverSend('view_attached', { session_id: S1 });

// ── §B live snapshot: listed, not displayed ─────────────────────────────────
const viewAttachesBefore = (await emitsOf('view_attach')).length;
await serverSend('ssh_session_restored',
    snapshotFrame(S2, 2, { live: true, replaces_session_id: null }));
await page.waitForTimeout(250);
const live = await READ(S2);
const s1AfterLive = await READ(S1);
num('§B live S2', live);
checkTrue('§B the live session exists', live.exists);
check('§B it took no pane', live.pane, -1);
check('§B it is not active', live.active, false);
check('§B S1 keeps the pane and stays active', [s1AfterLive.pane, s1AfterLive.active], [0, true]);
check('§B no view was attached for it', (await emitsOf('view_attach')).length, viewAttachesBefore);
check('§B its view state stays detached', live.view, 'detached');
checkTrue('§B its chip is rendered', await page.evaluate(
    s => !!document.getElementById(`tab-${s}`), S2));

// ── §C live snapshot replacing the session in the pane ─────────────────────
await serverSend('ssh_session_restored',
    snapshotFrame(S3, 3, { live: true, replaces_session_id: S1 }));
await page.waitForTimeout(300);
const replaced = await READ(S1);
const replacement = await READ(S3);
num('§C S1 -> S3', { replaced, replacement });
check('§C the replaced session is gone', replaced.exists, false);
check('§C the replacement took its pane', replacement.pane, 0);
checkTrue('§C the replacement is displayed', replacement.visible);

// ── §D removal ──────────────────────────────────────────────────────────────
await serverSend('ssh_session_restored',
    snapshotFrame(S4, 4, { live: true, replaces_session_id: null }));
await page.waitForTimeout(100);
checkTrue('§D S4 listed', (await READ(S4)).exists);
await serverSend('ssh_session_removed', { session_id: S4 });
await page.waitForTimeout(100);
check('§D ssh_session_removed retires it', (await READ(S4)).exists, false);
check('§D a removal for an unknown id is harmless',
    await page.evaluate(() => { window.__server('ssh_session_removed', { session_id: 'nope' }); return true; }),
    true);

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z zero page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
