#!/usr/bin/env node
/*
 * A RESTART MUST NOT COST A SESSION ITS IDENTITY, ITS CHIP OR ITS PANE.
 *
 * Reported 2026-10-02: two sessions split across two panes, SSHDeck restarted,
 * and afterwards every reconnect produced a new chip in place of the old one,
 * the panes were lost, the first session to come back on its own took a pane
 * that was not its own, and a session that lost its pane stayed at a half-pane
 * size. Measured on production logs and then reproduced end to end on a
 * throwaway instance: the reattach after a restart retired the saved row and
 * re-inserted it under a NEW id (so everything keyed by the id was lost); offers
 * held no pane; a page's "first live session takes the first pane" fallback
 * took a pane an offer remembered; a one-pane page wrote "no pane" back for a
 * session it could not place, erasing the desktop's second pane; and other open
 * pages never heard about a pane change, so one of them kept the session in a
 * half pane and held it at that size everywhere.
 *
 * The contract, page side (the server side is pinned in
 * tests/test_reattach_identity.py and tests/test_pane_index.py):
 *   §1 an offer goes back to the pane its row remembers, reporting nothing;
 *   §2 a live session restored first does not take a pane an offer remembers,
 *      while a page with no remembered panes still fills its first pane;
 *   §3 every keyless offer is reattached by itself, one at a time, the session
 *      the user was on first, never a password offer (owner ruling 2026-10-02);
 *   §4 the reattach keeps the id, so the offer is promoted in place: the same
 *      chip and wrapper, the same pane, a terminal and a view, no second
 *      "Connecting" chip, and a background reattach leaves the connection form
 *      and the toasts alone;
 *   §5 a claim another page already won (already_live) is no error and the
 *      queue goes on;
 *   §6 another page's announcement of the same id promotes the offer here too;
 *   §7 a pane change from another page is applied here, never echoed;
 *   §8 a page that cannot place a session reports nothing, and a pane that
 *      comes back into view gets back the session that remembers it;
 *   §9 a user's act reports exactly the sessions it moved;
 *   §10 an offer is never attached as a view; once promoted it is.
 *
 * Run: node tests/browser/pane_identity_restart.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{%\s*include\s+'([^']+)'\s*%\}/g,
        (m, f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
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

// A stand-in for the server: every emit is recorded, and the test sends each
// server event itself, in the order the production log showed.
const STUBS = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    window.socket = {
        connected: true, id: 'sock-pir',
        on: (n, cb) => { (window.__handlers[n] ||= []).push(cb); },
        off: noop, once: noop, onAny: noop,
        emit: (n, p) => { window.__emits.push([n, JSON.parse(JSON.stringify(p ?? null))]); },
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.__send = (n, d) => (window.__handlers[n] || []).forEach(cb => cb(d));
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    const tmux = id => 'sshdeck_root_h_22_' + id;
    window.__offer = (id, o = {}) => window.__send('persistent_session_available', Object.assign({
        snapshot_version: 1, session_id: id, host: 'h', port: 22, username: 'root',
        key_id: null, auth_type: 'tailscale', tmux_session_name: tmux(id),
        display_name: null, pane_index: null }, o));
    window.__restored = (id, o = {}) => window.__send('ssh_session_restored', Object.assign({
        snapshot_version: 1, session_id: id, host: 'h', port: 22, username: 'root',
        connected: true, auth_type: 'tailscale', key_id: null, via_jump: null,
        use_tmux: true, tmux_session_name: tmux(id), display_name: null,
        pane_index: null, replay_max_lines: 5000, legacy_tmux_locale: false,
        replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0,
        replay_history_lines: 0, account_has_panes: false }, o));
    window.__connected = (id, req, o = {}) => window.__send('ssh_connected', Object.assign({
        snapshot_version: 1, session_id: id, host: 'h', port: 22, username: 'root',
        client_request_id: req, via_jump: null, use_tmux: true, key_id: null,
        auth_type: 'tailscale', tmux_session_name: tmux(id), display_name: null,
        pane_index: null, legacy_tmux_locale: false, replay_max_lines: 5000 }, o));
`;

const browser = await chromium.launch();
const errors = [];

async function open({ layout = 2, preferred = null } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    if (preferred) {
        await page.addInitScript(p => { try { localStorage.setItem('activeSessionId', p); } catch (e) {} }, preferred);
    }
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && SessionManager.initialized === true, null, { timeout: 15000 });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate((n) => {
        SessionManager.setSplitLayout(n);
        window.__toasts = [];
        window.showNotification = (m, t) => window.__toasts.push(`${t}:${m}`);
        window.__closed = [];
        const close = window.ModalManager.close.bind(window.ModalManager);
        window.ModalManager.close = (el) => { window.__closed.push(el && el.id); return close(el); };
        window.__emits.length = 0;
    }, layout);
    return { ctx, page };
}
const settle = (page, ms = 80) => page.waitForTimeout(ms);
const emits = (page, name) => page.evaluate(n => window.__emits.filter(e => e[0] === n).map(e => e[1]), name);
const panes = page => page.evaluate(() => SessionManager.paneAssignments.slice());
const claims = async page => (await emits(page, 'ssh_connect')).map(c => ({
    id: c.session_id, req: c.client_request_id, from_candidate: c.from_candidate,
    name: c.reconnect_tmux_name }));

// ---------------------------------------------------------------------------
// §1 offers hold their remembered panes; §10 an offer is never a view
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => {
        __offer('PA', { pane_index: 1, auth_type: 'password' });
        __offer('PB', { pane_index: 0, auth_type: 'password' });
        __offer('PC', { pane_index: 0, auth_type: 'password' });
    });
    await settle(page);
    check('§1 each offer goes back to the pane its row remembers', await panes(page), ['PB', 'PA']);
    check('§1 a second offer remembering a held pane is not placed (nothing evicted)',
        await page.evaluate(() => SessionManager.paneAssignments.includes('PC')), false);
    check('§1 placing offers reports nothing to the server', await emits(page, 'session_pane_index'), []);
    check('§10 no view is attached for an offer', await emits(page, 'view_attach'), []);
    check('§10 attachView refuses an offer outright',
        await page.evaluate(() => TerminalManager.attachView('PA', { cols: 80, rows: 24 })), false);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2 the fallback never takes a remembered pane
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => {
        __restored('LV', { pane_index: null, account_has_panes: true });
        __offer('PO', { pane_index: 0, auth_type: 'password' });
    });
    await settle(page);
    check('§2 a live session restored first leaves the pane an offer remembers',
        await panes(page), ['PO', null]);
    check('§2 and reports nothing', await emits(page, 'session_pane_index'), []);
    await ctx.close();
}
{
    const { ctx, page } = await open();
    await page.evaluate(() => __restored('FR', { pane_index: null, account_has_panes: false }));
    await settle(page);
    check('§2 with no remembered pane anywhere, the first live session fills pane 1',
        await panes(page), ['FR', null]);
    check('§2 and that becomes its remembered pane',
        await emits(page, 'session_pane_index'), [{ session_id: 'FR', pane_index: 0 }]);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §3 keyless offers come back one at a time; §4 promotion in place
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open({ preferred: 'K2' });
    await page.evaluate(() => {
        // The connection form is open: a background reattach must leave it.
        window.ModalManager.open(document.getElementById('connectionModal'));
        __offer('K1', { pane_index: 0 });
        __offer('K2', { pane_index: 1, auth_type: 'key', key_id: 'key-1' });
        __offer('PW', { auth_type: 'password' });
        document.querySelectorAll('.session-tab').forEach(t => { t.dataset.mark = 'orig'; });
        document.querySelectorAll('.terminal-wrapper').forEach(w => { w.dataset.mark = 'orig'; });
    });
    await settle(page);
    let c = await claims(page);
    const name = id => `sshdeck_root_h_22_${id}`;
    check('§3 the session the user was on is reattached first, and alone',
        c.map(x => x.id), ['K2']);
    check('§3 the claim names its own row and says it is an offer',
        [c[0].from_candidate, c[0].name], [true, name('K2')]);
    check('§4 no second "Connecting" chip appears beside the offer',
        await page.evaluate(() => document.querySelectorAll('[id^="pending-"]').length), 0);
    check('§4 the offer\'s own chip shows the connecting state',
        await page.evaluate(() => document.querySelector('#tab-K2 .status-dot').classList.contains('connecting')), true);
    await page.evaluate(([req]) => __connected('K2', req, { auth_type: 'key', key_id: 'key-1', pane_index: 1 }), [c[0].req]);
    await settle(page, 300);
    c = await claims(page);
    check('§3 the next offer is claimed only once the first has answered',
        c.map(x => x.id), ['K2', 'K1']);
    const k2 = await page.evaluate(() => ({
        chip: document.getElementById('tab-K2').dataset.mark || 'NEW',
        chips: document.querySelectorAll('#tab-K2').length,
        wrapper: document.getElementById('terminal-K2').dataset.mark || 'NEW',
        pane: SessionManager.paneAssignments.indexOf('K2'),
        live: SessionManager.sessions.K2.connected && !SessionManager.sessions.K2.isPersistentCandidate,
        terminals: (TerminalManager.sessionTerminals.K2 || []).length,
    }));
    check('§4 the reattached session is the same chip, the same wrapper, in the same pane, live, with a terminal',
        k2, { chip: 'orig', chips: 1, wrapper: 'orig', pane: 1, live: true, terminals: 1 });
    check('§4 and its view is attached', (await emits(page, 'view_attach')).some(v => v.session_id === 'K2'), true);
    await page.evaluate(([req]) => __connected('K1', req, { pane_index: 0 }), [c[1].req]);
    await settle(page, 300);
    check('§3 a password offer is never reattached by itself',
        (await claims(page)).map(x => x.id), ['K2', 'K1']);
    check('§4 both are back where they were', await panes(page), ['K1', 'K2']);
    check('§4 nothing reported a pane', await emits(page, 'session_pane_index'), []);
    check('§4 the background reattach left the connection form alone',
        await page.evaluate(() => window.__closed.includes('connectionModal')), false);
    check('§4 and raised no toast', await page.evaluate(() => window.__toasts), []);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §5 already_live is no error and the queue goes on
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => { __offer('A1', { pane_index: 0 }); __offer('A2', { pane_index: 1 }); });
    await settle(page);
    let c = await claims(page);
    await page.evaluate(([req]) => __send('ssh_error', {
        error: 'This session has already been reconnected', code: 'already_live',
        client_request_id: req }), [c[0].req]);
    await settle(page);
    c = await claims(page);
    check('§5 already_live raises no error toast', await page.evaluate(() => window.__toasts), []);
    check('§5 the claim is released', await page.evaluate(() =>
        !!(SessionManager.reconnectingSessions && SessionManager.reconnectingSessions.A1)), false);
    check('§5 and the queue goes on to the next offer', c.map(x => x.id), ['A1', 'A2']);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §6 another page's announcement of the same id promotes the offer here
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => {
        __offer('X', { pane_index: 0, auth_type: 'password' });
        document.getElementById('tab-X').dataset.mark = 'orig';
        __restored('X', { live: true, replaces_session_id: null, pane_index: 0, account_has_panes: true });
    });
    await settle(page, 300);
    check('§6 the announced session is the offer, promoted in place', await page.evaluate(() => ({
        chip: document.getElementById('tab-X').dataset.mark || 'NEW',
        chips: document.querySelectorAll('#tab-X').length,
        live: SessionManager.sessions.X.connected === true,
        pane: SessionManager.paneAssignments.indexOf('X'),
    })), { chip: 'orig', chips: 1, live: true, pane: 0 });
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §7 another page's pane change; §9 a user's act
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => {
        __restored('RA', { pane_index: 0, account_has_panes: true });
        __restored('RB', { pane_index: 1, account_has_panes: true });
    });
    await settle(page, 200);
    await page.evaluate(() => { window.__emits.length = 0; __send('session_pane_index', { session_id: 'RB', pane_index: 0 }); });
    await settle(page);
    check('§7 a session moved on another page moves here, displacing what this page showed',
        await panes(page), ['RB', null]);
    await page.evaluate(() => __send('session_pane_index', { session_id: 'RA', pane_index: 1 }));
    await page.evaluate(() => __send('session_pane_index', { session_id: 'RB', pane_index: null }));
    await settle(page);
    check('§7 and every later change follows', await panes(page), [null, 'RA']);
    check('§7 nothing is echoed back', await emits(page, 'session_pane_index'), []);
    await page.evaluate(() => { window.__emits.length = 0; SessionManager.applyPaneAssignments(2, ['RB', 'RA']); });
    await settle(page);
    check('§9 a user\'s act reports exactly the sessions it moved',
        await emits(page, 'session_pane_index'), [{ session_id: 'RB', pane_index: 0 }]);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §8 a one-pane page never erases a remembered pane
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open({ layout: 1 });
    await page.evaluate(() => {
        __restored('M0', { pane_index: 0, account_has_panes: true });
        __restored('M1', { pane_index: 1, account_has_panes: true });
    });
    await settle(page, 200);
    check('§8 a one-pane page shows the session that remembers pane 1', await panes(page), ['M0']);
    check('§8 and reports nothing for the one it cannot place', await emits(page, 'session_pane_index'), []);
    await page.evaluate(() => SessionManager.setSplitLayout(2));
    await settle(page, 200);
    check('§8 a second pane coming back into view gets back the session that remembers it',
        await panes(page), ['M0', 'M1']);
    await page.evaluate(() => SessionManager.setSplitLayout(1));
    await settle(page, 200);
    check('§8 a layout change reports nothing either way', await emits(page, 'session_pane_index'), []);
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §10 a preserved page: a live session turned offer is not re-attached until
// it is promoted, and then it is
// ---------------------------------------------------------------------------
{
    const { ctx, page } = await open();
    await page.evaluate(() => __restored('S', { pane_index: 0, account_has_panes: true }));
    await settle(page, 300);
    await page.evaluate(() => {
        __offer('S', { pane_index: 0, auth_type: 'password' });
        window.__emits.length = 0;
        TerminalManager.resetSocketEpoch();
    });
    await settle(page, 300);
    check('§10 a socket cycle does not attach a view for a live session now an offer',
        (await emits(page, 'view_attach')).map(v => v.session_id), []);
    await page.evaluate(() => {
        __restored('S', { live: true, pane_index: 0, account_has_panes: true });
    });
    await settle(page, 300);
    check('§10 once promoted, its view is attached', (await emits(page, 'view_attach')).map(v => v.session_id), ['S']);
    await ctx.close();
}

check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`\npane_identity_restart: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
