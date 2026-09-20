#!/usr/bin/env node
/*
 * ONE view_attach PER SESSION PER LOAD -- and what rides on it.
 *
 * Measured on the deployment 2026-09-20, with the call stack recorded at the
 * emit, every session attached TWICE on a page load:
 *
 *   486ms view_attach history=true   syncViews  <- applyActiveSession
 *   488ms view_attach history=false  syncViews  <- resetSocketEpoch  <- connect
 *
 * The attaches a loading page has already sent are BUFFERED by socket.io and
 * go out on the very socket whose `connect` then fired, so there was nothing
 * stale to forget: the reset threw them away and sent them again. It cost two
 * things. The doubled burst is half of what pushed a three-pane reload past
 * the 16 packets python-engineio will decode in one polling payload -- above
 * which the WHOLE payload is discarded with a 200 back, and the page sat on a
 * stale frame for 7 seconds until its own attach retry. And the attach that
 * survived carried `history:false`, because the first had already claimed the
 * one-shot, so a page whose first attach was the discarded one never pulled
 * its scrollback at all.
 *
 * Sections:
 *   §A  the measured order (restore, then connect): ONE attach, and it asks
 *       for the history
 *   §B  the other order (connect, then restore): still one
 *   §C  a RECONNECT still re-attaches -- that is what resetSocketEpoch is for
 *   §D  the ack behind an attach sends no resize for a size the attach already
 *       carried, and still sends one for a size that really changed
 *   §Z  no page errors
 *
 * Run: node tests/browser/view_attach_once.mjs   (from source/)
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

/*
 * The socket is a recorder: `on` keeps the app's own handlers and __server
 * invokes them, so every frame below runs the production path. Nothing fires
 * on its own -- a section that does not call __server sees no events at all,
 * which is what lets the ORDER of connect and restore be the variable.
 */
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
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'aaaa1111-atto-4aaa-8aaa-000000000001';
const SNAPSHOT = {
    snapshot_version: 1, session_id: S1, host: 'h', port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 'jt', display_name: 'JT',
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};

const pageErrors = [];
async function openPage(width = 1200, height = 780) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(
        () => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined',
        null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    return page;
}

const attaches = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'view_attach')
    .map(e => ({ size: `${e.payload.cols}x${e.payload.rows}`, history: e.payload.history })));
const resizes = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'ssh_resize').map(e => `${e.payload.cols}x${e.payload.rows}`));
const fire = (page, ev, payload) => page.evaluate(
    ([e, p]) => window.__server(e, p), [ev, payload ?? null]);

// ── §A the measured order: the restore lands, then the socket says connect ──
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', SNAPSHOT);
    await page.waitForTimeout(500);
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const rows = await attaches(page);
    check('§A restore-then-connect sends exactly one view_attach', rows.length, 1);
    check('§A and it asks for the scrollback', rows.map(r => r.history), [true]);
    await page.context().close();
}

// ── §B the other order, for the same answer ─────────────────────────────────
{
    const page = await openPage();
    await fire(page, 'connect');
    await page.waitForTimeout(200);
    await fire(page, 'ssh_session_restored', SNAPSHOT);
    await page.waitForTimeout(700);
    const rows = await attaches(page);
    check('§B connect-then-restore sends exactly one view_attach', rows.length, 1);
    check('§B and it asks for the scrollback', rows.map(r => r.history), [true]);
    await page.context().close();
}

/*
 * §C A RECONNECT MUST STILL RE-ATTACH. This is the case resetSocketEpoch
 * exists for: the new socket has a new sid, the server's client-size registry
 * is keyed by sid, and the tmux clients opened on the old socket went with it.
 * A fix for §A that also silenced this would strand the page detached.
 */
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', SNAPSHOT);
    await page.waitForTimeout(500);
    await fire(page, 'connect');
    await page.waitForTimeout(400);
    await fire(page, 'view_attached', { session_id: S1 });
    await page.waitForTimeout(300);
    const before = (await attaches(page)).length;
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const after = await attaches(page);
    check('§C a reconnect re-attaches, exactly once', after.length - before, 1);
    check('§C the re-attach carries a size', after[after.length - 1].size.includes('x'), true);
    await page.context().close();
}

/*
 * §D THE RESIZE BEHIND THE ACK. A fit that lands while an attach is in flight
 * is parked and applied on the ack. When it is the size the attach already
 * carried, the server has nothing to do -- it opened the channel's PTY at that
 * size -- and the resize costs a tmux `refresh-client`, an exec channel
 * measured at 432-472ms, on every pane of the session.
 *
 * The parked fit is produced the way the app produces one: the reconnect of
 * §C bumps the proposal epoch, so the next fit re-proposes rather than being
 * deduped, and requestFit is the app's own entry point for it.
 */
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', SNAPSHOT);
    await page.waitForTimeout(500);
    await fire(page, 'connect');
    await page.waitForTimeout(400);
    await fire(page, 'view_attached', { session_id: S1 });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__emits.length = 0; });

    await fire(page, 'connect');                       // re-attach, in flight
    await page.waitForTimeout(150);
    await page.evaluate((s) => TerminalManager.requestFit(s), S1);
    await page.waitForTimeout(400);                    // the proposal settles
    await fire(page, 'view_attached', { session_id: S1 });
    await page.waitForTimeout(300);
    check('§D an unchanged size behind the ack sends no resize', await resizes(page), []);

    await page.evaluate(() => { window.__emits.length = 0; });
    await fire(page, 'connect');                       // re-attach, in flight
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 900, height: 640 });
    await page.waitForTimeout(400);
    const attachSize = (await attaches(page)).pop().size;
    await fire(page, 'view_attached', { session_id: S1 });
    await page.waitForTimeout(300);
    const sent = await resizes(page);
    check('§D a size that really changed is still sent', sent.length, 1);
    check('§D and it is not the size the attach carried',
        sent.length === 1 && sent[0] !== attachSize, true);
    await page.context().close();
}

check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\nview_attach_once: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
