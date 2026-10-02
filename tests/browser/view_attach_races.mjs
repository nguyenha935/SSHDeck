#!/usr/bin/env node
/*
 * AN ACK DOES NOT ALWAYS ANSWER THE PAGE'S LAST ATTACH.
 *
 * Two races, both measured 2026-10-02 on a throwaway instance (gunicorn
 * eventlet, as prod), both on main before this gate.
 *
 * 1. AN ATTACH THE PAGE WITHDREW MUST STAY WITHDRAWN.
 *
 * Measured 2026-10-02 on a throwaway instance (gunicorn eventlet, as prod):
 * connect two sessions back to back, then split. The second connect hides the
 * first session behind it while the first one's `view_attach` is still in
 * flight, so the page sends `view_detach` for it before `view_attached` comes
 * back. The server runs each event in its own greenlet, and the detach landed
 * on either side of the attach's registration:
 *
 *   before it  -- a no-op, and the server kept a client for a hidden pane
 *   after it   -- the client was detached, and the server held none
 *
 * Either way the late ack set the view `attached`. In the second order the
 * pane was dead: tmux at `clients=0`, the split's resize answered "No view for
 * this socket", the page sure it was attached. 1 run in 6 on main.
 *
 * The rule: an ack for a session this page no longer displays is answered
 * with a second detach and leaves the view detached; an ack for a session
 * displayed again by then is accepted.
 *
 * 2. THE SIZE THE SERVER KEPT IS THE ONE THAT COUNTS. A split made right after
 * a connect hides the new session's pane and shows it again, narrower, while
 * its first attach is still opening. Both attaches are in flight; the server
 * keeps the one that registers first, with ITS size, and drops the other's.
 * Both acks then looked the same, so the page sent nothing: the pane's client
 * stayed at the full-width 167 columns while the pane fitted 83. The ack now
 * carries the registered size, and a page that asked for another one last
 * sends exactly one resize to it.
 *
 * Sections:
 *   §A  the tab is hidden while the attach is in flight
 *   §B  another session takes the pane while the attach is in flight
 *   §C  hidden and shown again before the ack: the ack is the wanted one
 *   §D  displayed but detached (an attach timed out twice): a late ack is kept
 *   §E  an ack reporting another size: one resize, to the size asked for last
 *   §F  an ack reporting the size asked for: nothing
 *   §G  the measured sequence: hidden, narrowed and shown while the first
 *       attach opens; both acks report the first size; one resize
 *   §Z  no page errors
 *
 * Run: node tests/browser/view_attach_races.mjs   (from source/)
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

// The socket is a recorder; __server runs the app's own handlers.
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
    // The document's visibility, under the test's control (see hide/show).
    window.__visibility = 'visible';
    Object.defineProperty(document, 'visibilityState',
        { configurable: true, get: () => window.__visibility });
`;

const S1 = 'aaaa1111-wdrn-4aaa-8aaa-000000000001';
const S2 = 'bbbb2222-wdrn-4bbb-8bbb-000000000002';
const snapshot = (session_id, tmux) => ({
    snapshot_version: 1, session_id, host: 'h', port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: tmux, display_name: tmux,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
});

const pageErrors = [];
async function openPage() {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 } });
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

const fire = (page, ev, payload) => page.evaluate(
    ([e, p]) => window.__server(e, p), [ev, payload ?? null]);
const clear = (page) => page.evaluate(() => { window.__emits.length = 0; });
// Every view message and resize since the last clear, in order, as `ev id`.
const traffic = (page) => page.evaluate(() => window.__emits
    .filter(e => ['view_attach', 'view_detach', 'ssh_resize'].includes(e.ev))
    .flatMap(e => (e.ev === 'view_detach' ? e.payload.session_ids : [e.payload.session_id])
        .map(id => `${e.ev} ${id.slice(0, 4)}`)));
const viewState = (page, id) => page.evaluate((s) => TerminalManager.views[s] || null, id);
const setVisibility = async (page, state) => {
    await page.evaluate((v) => {
        window.__visibility = v;
        document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await page.waitForTimeout(150);
};
const ack = async (page, id, size) => {
    await fire(page, 'view_attached', { session_id: id, ...(size || {}) });
    await page.waitForTimeout(150);
};
// The size the page's last view_attach carried.
const lastAttachSize = (page) => page.evaluate(() => {
    const e = window.__emits.filter(x => x.ev === 'view_attach').pop();
    return e ? { cols: e.payload.cols, rows: e.payload.rows } : null;
});
const resizeSizes = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'ssh_resize').map(e => `${e.payload.cols}x${e.payload.rows}`));

// ── §A the tab is hidden while the attach is in flight ──────────────────────
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    check('§A setup: the attach is in flight', [await traffic(page), await viewState(page, S1)],
        [['view_attach aaaa'], 'attaching']);
    await clear(page);

    await setVisibility(page, 'hidden');
    check('§A hiding the tab detaches it', await traffic(page), ['view_detach aaaa']);
    await clear(page);

    await ack(page, S1);
    check('§A the late ack leaves the view detached', await viewState(page, S1), 'detached');
    check('§A and detaches again, sending nothing else', await traffic(page), ['view_detach aaaa']);
    await clear(page);

    await setVisibility(page, 'visible');
    await page.waitForTimeout(400);
    check('§A shown again it ATTACHES (a resize would address no client)',
        await traffic(page), ['view_attach aaaa']);
    await clear(page);
    await ack(page, S1);
    check('§A and that ack is kept', [await viewState(page, S1), await traffic(page)], ['attached', []]);
    await page.context().close();
}

// ── §B another session takes the pane while the attach is in flight ────────
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await page.evaluate((s) => {
        SessionManager.setSplitLayout(1);
        SessionManager.assignSessionToPane(s, 0);
    }, S1);
    await fire(page, 'ssh_session_restored', snapshot(S2, 'two'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const displayed = await page.evaluate(() => TerminalManager.displayedViews());
    check('§B setup: one pane, S1 in it, S2 not shown',
        [displayed[S1], displayed[S2]], [true, false]);
    check('§B setup: only S1 is attaching', [await traffic(page), await viewState(page, S1)],
        [['view_attach aaaa'], 'attaching']);
    await clear(page);

    await page.evaluate((s) => SessionManager.assignSessionToPane(s, 0), S2);
    await page.waitForTimeout(400);
    const moved = await traffic(page);
    check('§B S2 taking the pane detaches S1 and attaches S2',
        [moved.includes('view_detach aaaa'), moved.includes('view_attach bbbb')], [true, true]);
    await clear(page);

    await ack(page, S1);
    check('§B the late ack for S1 leaves it detached', await viewState(page, S1), 'detached');
    check('§B and detaches S1 again', await traffic(page), ['view_detach aaaa']);
    await clear(page);
    await ack(page, S2);
    check('§B S2\'s own ack is kept', [await viewState(page, S2), await traffic(page)], ['attached', []]);

    await page.evaluate((s) => SessionManager.assignSessionToPane(s, 0), S1);
    await page.waitForTimeout(400);
    const back = await traffic(page);
    check('§B S1 back in the pane ATTACHES, and is never resized as if attached',
        [back.includes('view_attach aaaa'), back.includes('ssh_resize aaaa')], [true, false]);
    await page.context().close();
}

// ── §C hidden and shown again before the ack: the ack is the wanted one ─────
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    await clear(page);
    await setVisibility(page, 'hidden');
    await setVisibility(page, 'visible');
    await page.waitForTimeout(400);
    check('§C setup: detached, then attaching again',
        [await traffic(page), await viewState(page, S1)],
        [['view_detach aaaa', 'view_attach aaaa'], 'attaching']);
    await clear(page);
    await ack(page, S1);
    check('§C the first ack marks the wanted view attached', await viewState(page, S1), 'attached');
    check('§C and detaches nothing', await traffic(page), []);
    await page.context().close();
}

// ── §D displayed but detached (an attach timed out twice): a late ack is kept
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    await page.evaluate((s) => {
        TerminalManager.noteViewError(s, 'attach timed out');   // retried at once
        TerminalManager.noteViewError(s, 'attach timed out');   // now waits 5s
    }, S1);
    check('§D setup: displayed, detached, a retry waiting',
        await page.evaluate((s) => [TerminalManager.views[s],
            TerminalManager.displayedViews()[s], !!TerminalManager.viewRetryTimers[s]], S1),
        ['detached', true, true]);
    await clear(page);
    await ack(page, S1);
    check('§D the late ack is kept: attached, the retry cancelled',
        await page.evaluate((s) => [TerminalManager.views[s], !!TerminalManager.viewRetryTimers[s]], S1),
        ['attached', false]);
    check('§D and no detach was sent', await traffic(page), []);
    await page.context().close();
}

// ── §E an ack reporting another size: one resize, to the size asked for last ──
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const asked = await lastAttachSize(page);
    await clear(page);
    await ack(page, S1, { cols: asked.cols + 84, rows: asked.rows });
    check('§E one resize, to the size the attach asked for',
        await resizeSizes(page), [`${asked.cols}x${asked.rows}`]);
    check('§E and the view is attached', await viewState(page, S1), 'attached');
    await page.context().close();
}

// ── §F an ack reporting the size asked for: nothing ────────────────────────
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const asked = await lastAttachSize(page);
    await clear(page);
    await ack(page, S1, asked);
    check('§F no resize (it would cost a tmux refresh-client for nothing)',
        await resizeSizes(page), []);
    await page.context().close();
}

// ── §G the measured sequence ───────────────────────────────────────────────
{
    const page = await openPage();
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one'));
    await fire(page, 'connect');
    await page.waitForTimeout(500);
    const first = await lastAttachSize(page);
    await clear(page);
    await setVisibility(page, 'hidden');
    await page.setViewportSize({ width: 700, height: 780 });
    await page.waitForTimeout(300);
    await setVisibility(page, 'visible');
    await page.waitForTimeout(400);
    const second = await lastAttachSize(page);
    check('§G setup: detached, then a narrower attach is in flight',
        [await traffic(page), second && second.cols < first.cols],
        [['view_detach aaaa', 'view_attach aaaa'], true]);
    await clear(page);
    await ack(page, S1, first);         // the first attach registered first
    await ack(page, S1, first);         // the second lost the race
    check('§G exactly one resize, to the narrower size',
        await resizeSizes(page), [`${second.cols}x${second.rows}`]);
    check('§G and the view is attached', await viewState(page, S1), 'attached');
    await page.context().close();
}

check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\nview_attach_races: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
