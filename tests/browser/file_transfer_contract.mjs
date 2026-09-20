/*
 * File Transfer contract — owner correction (Entry 40).
 *
 * "File Transfer" means SSH SERVER -> SSH SERVER. The product previously routed
 * the global menu item to the browser<->server upload/download form, a surface
 * with one session picker per direction and therefore no way to express a
 * destination host at all. This suite pins the corrected contract.
 *
 * Real browser, production template, production JS, production CSS. Nothing in
 * the product is stubbed: only the Socket.IO transport is a recorder, so every
 * byte the app sends is observable and server events can be injected on the
 * exact channel names the backend uses.
 *
 * Covered here:
 *   §1  three distinct features, three distinct openers, zero duplication
 *   §2  independent SOURCE and DESTINATION selection (host + path, either end)
 *   §3  same-source rejection (no transfer emitted, warning shown)
 *   §4  the transfer_server_to_server payload, field by field
 *   §5  started -> progress -> complete, and what the user sees at each step
 *   §6  cancellation: visible control, cancel_transfer emit, ack-gated state,
 *       broadcast path, idempotence, and the completion/cancel race
 *   §7  error is still distinct from cancelled
 *   §8  labels in English AND Vietnamese, on every surface and control
 *   §9  desktop and phone routing; the phone can reach BOTH ends and Transfer
 *   §10 focus/keyboard safety and no panel duplication after every route
 *   §11 the 30px painted chip / 44px touch band is unaffected by all of it
 *
 * Run: node tests/browser/file_transfer_contract.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

/*
 * Socket.IO fixture, served at the vendored path templates/index.html loads.
 * It must define io() rather than assign window.socket, because app.js runs
 * `window.socket = io(...)` at startup and would overwrite an injected socket.
 *
 * Two additions over the composer suite's fixture, both required here:
 *  - emit() records an ACK callback when one is supplied and exposes it, so the
 *    cancel path can be tested exactly as production uses it: the client
 *    terminalizes only after the SERVER acknowledges success.
 *  - __fire() lets the test inject s2s_transfer_* events on the real channels.
 */
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true,
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload, ack) {
            window.__emits.push({ evt, payload, hasAck: typeof ack === 'function' });
            if (typeof ack === 'function') {
                window.__acks = window.__acks || {};
                window.__acks[evt] = ack;
            }
            /*
             * THE SERVER ISSUES THE TRANSFER ID. This fixture answers
             * transfer_server_to_server the way app/socket_events.py does:
             * {success: true, transfer_id: <server id>}. The client must adopt
             * that id; it no longer invents one. window.__ackControl lets a test
             * make the server refuse, so the "no row for a rejected transfer"
             * path is exercised on the real code path rather than described.
             */
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                const control = window.__ackControl || {};
                if (control.mode === 'refuse') {
                    setTimeout(() => ack({ success: false, error: control.error
                        || 'Too many transfers already running' }), 0);
                } else if (control.mode === 'silent') {
                    /* never acks: proves the client does not hang forever */
                } else {
                    window.__serverIdSeq = (window.__serverIdSeq || 0) + 1;
                    const id = 'srv-' + window.__serverIdSeq + '-'
                        + 'abcdefghijklmnopqr';
                    window.__serverIds = window.__serverIds || [];
                    window.__serverIds.push(id);
                    setTimeout(() => ack({ success: true, transfer_id: id }), 0);
                }
            }
            if (evt === 'cancel_transfer' && typeof ack === 'function'
                && window.__cancelAckMode === 'auto') {
                setTimeout(() => ack({ success: true }), 0);
            }
            if (evt === 'ssh_input' && payload && payload.data) {
                (handlers.ssh_output || []).forEach(fn => fn({
                    session_id: payload.session_id, data: payload.data,
                }));
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.__socketFixture = sock;
    window.io = () => sock;
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok: !!ok, detail });
};
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({
        label, ok,
        detail: ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
    });
};

const browser = await chromium.launch();

/*
 * Two connected sessions on two DIFFERENT hosts. A server-to-server contract
 * cannot be tested with one session: the destination selector would have nothing
 * distinct to point at, and the same-source rejection could not be separated
 * from "no second host exists".
 */
async function shell({ width, height, touch, locale = 'en' }) {
    const ctx = await browser.newContext({
        viewport: { width, height }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(loc => {
        window.__emits = [];
        try { localStorage.setItem('language', loc); } catch { /* first run */ }
    }, locale);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
    /*
     * The addInitScript above writes localStorage BEFORE the page has an origin,
     * so on a fresh context that write is lost and i18n booted at 'en' regardless
     * of `locale`. Apply the language through the product's own setter after load,
     * and only then read rendered text -- otherwise every "in locale X" assertion
     * is silently measuring English.
     */
    if (locale !== 'en') {
        await page.evaluate(loc => window.i18n?.setLanguage(loc), locale);
        await page.waitForFunction(loc => window.i18n?.getLanguage() === loc,
            locale, { timeout: 5000 });
    }
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'ft-s1', via_jump: null,
        });
        SessionManager.createSession({
            session_id: 's2', host: 'goclaw', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'goclaw',
            use_tmux: true, tmux_session_name: 'ft-s2', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(500);
    return { ctx, page, pageErrors };
}

const emits = (page, evt) => page.evaluate(
    e => window.__emits.filter(x => x.evt === e), evt);
const clearEmits = page => page.evaluate(() => { window.__emits.length = 0; });

/* Seed both panes with real pane state and a file, through the production
 * methods, so a transfer has something concrete to move. */
async function seedPanes(page) {
    await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.availableSessions = [
            { session_id: 's1', host: 'tiny', username: 'root' },
            { session_id: 's2', host: 'goclaw', username: 'root' },
        ];
        fm.updateSessionLists();
        fm.panes.left.type = 'ssh';
        fm.panes.left.sessionId = 's1';
        fm.panes.left.path = '/opt/sshdeck';
        fm.panes.left.hostInfo = { username: 'root', host: 'tiny' };
        fm.panes.left.files = [
            { name: 'report.log', is_dir: false, size: 4096, permissions: '-rw-r--r--' },
            { name: 'bundle', is_dir: true, size: 0, permissions: 'drwxr-xr-x' },
        ];
        fm.panes.right.type = 'ssh';
        fm.panes.right.sessionId = 's2';
        fm.panes.right.path = '/srv/inbox';
        fm.panes.right.hostInfo = { username: 'root', host: 'goclaw' };
        fm.panes.right.files = [];
        // The visible path INPUT is written only by updatePathInput (the pane
        // state field alone does not reach the DOM), which is the same call the
        // production navigation path makes.
        fm.updatePathInput('left', fm.panes.left.path);
        fm.updatePathInput('right', fm.panes.right.path);
        fm.renderPane('left');
        fm.renderPane('right');
        fm.updatePaneBadge('left');
        fm.updatePaneBadge('right');
    });
    await page.waitForTimeout(120);
}

console.log('== §1-§8, §10-§11 desktop ==');
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });

    // ── §11 baseline BEFORE anything opens: the chip geometry ruling ─────────
    const chipBefore = await page.evaluate(() => {
        const tab = document.getElementById('tab-s1');
        const r = tab.getBoundingClientRect();
        const cs = getComputedStyle(tab, '::before');
        return {
            painted: Math.round(r.height),
            band: Math.round(parseFloat(cs.height) || 0) || Math.round(r.height),
        };
    });

    // ── §1 three distinct openers ───────────────────────────────────────────
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    const menuEntry = await page.evaluate(() => {
        const btn = document.getElementById('fileTransferOpenBtn');
        const label = btn?.querySelector('[data-i18n]');
        const r = btn.getBoundingClientRect();
        return {
            key: label?.dataset.i18n,
            text: label?.textContent.trim(),
            title: btn.getAttribute('title'),
            aria: btn.getAttribute('aria-label'),
            operable: r.width > 1 && r.height > 1
                && getComputedStyle(btn).visibility !== 'hidden',
        };
    });
    eq('§1 menu entry is keyed files.fileTransfer', menuEntry.key, 'files.fileTransfer');
    eq('§8 EN menu entry reads "File Transfer"', menuEntry.text, 'File Transfer');
    eq('§8 EN menu entry title/aria agree', [menuEntry.title, menuEntry.aria],
        ['File Transfer', 'File Transfer']);
    check('§1 menu entry is operable', menuEntry.operable, JSON.stringify(menuEntry));

    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(200);

    const surface = await page.evaluate(() => {
        const m = document.getElementById('sftpFileManager');
        return {
            open: m.classList.contains('show'),
            transferMode: m.classList.contains('fm-transfer-mode'),
            leftSelect: !!document.getElementById('fmLeftSource'),
            rightSelect: !!document.getElementById('fmRightSource'),
            leftPath: !!document.getElementById('fmLeftPath'),
            rightPath: !!document.getElementById('fmRightPath'),
            transferBtn: !!document.getElementById('fmTransfer'),
            uploadModalOpen: document.getElementById('fileTransferModal')
                .classList.contains('show'),
            panelOpen: document.getElementById('sftpPanel')
                .classList.contains('sftp-panel-open'),
        };
    });
    check('§1 menu item opens the dual-pane transfer surface in transfer mode',
        surface.open && surface.transferMode, JSON.stringify(surface));
    check('§2 the surface exposes an independent selector AND path per end',
        surface.leftSelect && surface.rightSelect
            && surface.leftPath && surface.rightPath, JSON.stringify(surface));
    check('§1 it is NOT the browser<->server modal and NOT the session panel',
        !surface.uploadModalOpen && !surface.panelOpen, JSON.stringify(surface));

    await seedPanes(page);

    // ── §2 either end can be independently pointed at either host ───────────
    const selection = await page.evaluate(() => {
        const opts = id => [...document.getElementById(id).options].map(o => o.value);
        return {
            leftOptions: opts('fmLeftSource'),
            rightOptions: opts('fmRightSource'),
            leftHost: document.getElementById('fmLeftBadge')?.textContent.trim(),
            rightHost: document.getElementById('fmRightBadge')?.textContent.trim(),
            leftPathValue: document.getElementById('fmLeftPath').value,
            rightPathValue: document.getElementById('fmRightPath').value,
        };
    });
    check('§2 both selectors offer both SSH sessions and a new connection',
        ['ssh:s1', 'ssh:s2', 'quick-connect'].every(v =>
            selection.leftOptions.includes(v) && selection.rightOptions.includes(v)),
        JSON.stringify(selection));
    check('§2 the two ends resolve to DIFFERENT hosts',
        /tiny/.test(selection.leftHost) && /goclaw/.test(selection.rightHost),
        JSON.stringify(selection));
    eq('§2 the two ends carry independent, different paths',
        [selection.leftPathValue, selection.rightPathValue],
        ['/opt/sshdeck', '/srv/inbox']);

    // ── §3 same-source rejection ────────────────────────────────────────────
    await clearEmits(page);
    const same = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox', { sessionId: 's1' },
            { name: 'report.log', is_dir: false, size: 4096 });
        return {
            emitted: window.__emits.filter(e => e.evt === 'transfer_server_to_server').length,
            queue: fm.transferQueue.length,
            notice: document.querySelector('.notification-warning, .notification.warning')
                ?.textContent.trim() || '',
        };
    });
    eq('§3 same-source transfer emits nothing', same.emitted, 0);
    eq('§3 same-source transfer queues nothing', same.queue, 0);
    check('§3 same-source transfer warns the user', same.notice.length > 0,
        JSON.stringify(same));

    /* ── §4 the payload and the SERVER-ISSUED id ─────────────────────────────
     *
     * The superseded version of this section asserted the payload carried a
     * client-generated id matching /^s2s_/. That tested the wrong protocol: a
     * client-named transfer can be cancelled by a tab that does not own it, and
     * two tabs can collide on one id. The contract is now the opposite — the
     * payload must carry NO id, and the row must adopt the id from the ack.
     */
    await clearEmits(page);
    const payload = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const returned = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        const e = window.__emits.find(x => x.evt === 'transfer_server_to_server');
        return {
            payload: e?.payload,
            hasAck: e?.hasAck,
            returned,
            serverIds: window.__serverIds || [],
            queue: fm.transferQueue.map(t => ({
                id: t.id, type: t.type, filename: t.filename, status: t.status,
            })),
        };
    });
    const p = payload.payload || {};
    eq('§4 payload source_session_id', p.source_session_id, 's1');
    eq('§4 payload dest_session_id', p.dest_session_id, 's2');
    eq('§4 payload source_path', p.source_path, '/opt/sshdeck/report.log');
    eq('§4 payload dest_path', p.dest_path, '/srv/inbox/report.log');
    eq('§4 payload is_dir', p.is_dir, false);
    check('§4 the client sends NO transfer_id',
        !('transfer_id' in p), JSON.stringify(p));
    check('§4 no client-invented s2s_ id appears anywhere in the payload',
        !JSON.stringify(p).includes('s2s_'), JSON.stringify(p));
    check('§4 the emit supplies an ack callback', payload.hasAck === true,
        JSON.stringify(payload));
    eq('§4 the row adopts the SERVER id',
        payload.queue.map(t => t.id), payload.serverIds);
    eq('§4 transferSSHtoSSH returns the server id',
        payload.returned, payload.serverIds[0]);
    eq('§4 the transfer is queued as type s2s',
        payload.queue.map(t => t.type), ['s2s']);

    const transferId = payload.serverIds[0];

    // A refused ack must leave no row behind: a queue row whose id no server
    // knows would sit at "Waiting..." forever with a Cancel button that cannot
    // work.
    const refused = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const before = fm.transferQueue.length;
        window.__ackControl = { mode: 'refuse', error: 'Too many transfers already running' };
        const returned = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        window.__ackControl = {};
        return {
            returned,
            added: fm.transferQueue.length - before,
            notice: [...document.querySelectorAll('.notification, [class*="notification"]')]
                .map(n => n.textContent.trim()).join(' | '),
        };
    });
    eq('§4 a refused ack returns null', refused.returned, null);
    eq('§4 a refused transfer queues no row', refused.added, 0);
    check('§4 a refused transfer tells the user why',
        /Too many transfers/.test(refused.notice), JSON.stringify(refused));

    // A socket that never acks must not suspend the caller forever.
    const silent = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const before = fm.transferQueue.length;
        window.__ackControl = { mode: 'silent' };
        const started = Date.now();
        const returned = await fm.emitWithAck('transfer_server_to_server', {}, 150);
        window.__ackControl = {};
        return { returned, added: fm.transferQueue.length - before,
                 elapsed: Date.now() - started };
    });
    eq('§4 a missing ack resolves null rather than hanging', silent.returned, null);
    eq('§4 a missing ack queues no row', silent.added, 0);
    check('§4 the ack wait is bounded', silent.elapsed < 5000,
        `elapsed ${silent.elapsed}ms`);

    // ── §5 started -> progress -> complete ──────────────────────────────────
    const progress = await page.evaluate((id) => {
        const fire = (evt, data) => window.__socketFixture.__fire(evt, data);
        fire('s2s_transfer_started', {
            transfer_id: id, source_path: '/opt/sshdeck/report.log',
            dest_path: '/srv/inbox/report.log', is_dir: false,
        });
        fire('s2s_transfer_progress', {
            transfer_id: id, filename: 'report.log',
            transferred: 2048, total: 4096, percent: 50, status: 'transferring',
        });
        const t = window.sftpFileManager.transferQueue.find(x => x.id === id);
        const row = document.querySelector('.fm-transfer-item');
        return {
            status: t?.status,
            progress: t?.progress,
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
            hasBar: !!row?.querySelector('.fm-transfer-progress-fill'),
            barWidth: row?.querySelector('.fm-transfer-progress-fill')?.style.width,
            badge: document.getElementById('fmQueueBadge')?.textContent.trim(),
        };
    }, transferId);
    eq('§5 an in-flight transfer is active', progress.status, 'active');
    eq('§5 progress percent reaches the row', progress.progress, 50);
    eq('§5 the row shows the percentage', progress.statusText, '50%');
    check('§5 the row paints a progress bar at that width',
        progress.hasBar && progress.barWidth === '50%', JSON.stringify(progress));
    eq('§5 the queue badge counts it', progress.badge, '1');

    const done = await page.evaluate((id) => {
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: id, filename: 'report.log',
            source_path: '/opt/sshdeck/report.log', dest_path: '/srv/inbox/report.log',
        });
        const t = window.sftpFileManager.transferQueue.find(x => x.id === id);
        const row = document.querySelector('.fm-transfer-item');
        return {
            status: t?.status, progress: t?.progress,
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
            cancelBtn: !!row?.querySelector('[data-transfer-cancel]'),
            notice: [...document.querySelectorAll('.notification, [class*="notification"]')]
                .map(n => n.textContent.trim()).join(' | '),
        };
    }, transferId);
    eq('§5 completion terminalizes the transfer', done.status, 'complete');
    eq('§5 completion sets 100%', done.progress, 100);
    check('§5 the row reads Done', /Done/.test(done.statusText), JSON.stringify(done));
    check('§5 a completed row offers no cancel control', !done.cancelBtn, '');
    check('§5 completion names the file, not "undefined"',
        /report\.log/.test(done.notice) && !/undefined/.test(done.notice),
        JSON.stringify(done));

    // ── §6 cancellation ─────────────────────────────────────────────────────
    await clearEmits(page);
    const started = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/bundle',
            { sessionId: 's1' }, '/srv/inbox/bundle', { sessionId: 's2' },
            { name: 'bundle', is_dir: true, size: 0 });
        const e = window.__emits.find(x => x.evt === 'transfer_server_to_server');
        const id = (window.__serverIds || []).slice(-1)[0];
        window.__socketFixture.__fire('s2s_transfer_started', { transfer_id: id });
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: id, filename: 'bundle', transferred: 1, total: 100, percent: 1,
        });
        const rows = [...document.querySelectorAll('.fm-transfer-item')];
        const row = rows[rows.length - 1];
        const btn = row?.querySelector('[data-transfer-cancel]');
        const br = btn?.getBoundingClientRect();
        return {
            id,
            isDir: e.payload.is_dir,
            cancelVisible: !!btn && br.width > 1 && br.height > 1
                && getComputedStyle(btn).visibility !== 'hidden',
            cancelLabel: btn?.getAttribute('aria-label'),
            cancelTitle: btn?.getAttribute('title'),
        };
    });
    eq('§4 a directory transfer sets is_dir true', started.isDir, true);
    check('§6 an active transfer shows a VISIBLE cancel control',
        started.cancelVisible, JSON.stringify(started));
    eq('§8 EN cancel control is labelled Cancel',
        [started.cancelLabel, started.cancelTitle], ['Cancel', 'Cancel']);

    await clearEmits(page);
    /*
     * Press the real control the user presses. A guarded click: if the wrong
     * surface is open (or the control never renders) the locator is not visible
     * and this check must be a named FAIL in the tally, not an uncaught timeout
     * that loses every later section's evidence.
     */
    let cancelClicked = false;
    try {
        await page.click(`[data-transfer-cancel="${started.id}"]`, { timeout: 3000 });
        cancelClicked = true;
    } catch { /* visibility is asserted separately below */ }
    check('§6 the cancel control is click-visible on the open surface',
        cancelClicked, 'control absent or not visible on the open surface');
    await page.waitForTimeout(120);
    const cancelEmit = await emits(page, 'cancel_transfer');
    eq('§6 pressing cancel emits exactly one cancel_transfer',
        cancelEmit.length, 1);
    eq('§6 cancel_transfer carries the transfer_id',
        cancelEmit[0]?.payload?.transfer_id, started.id);
    check('§6 cancel_transfer requests a server ACK',
        cancelEmit[0]?.hasAck === true, JSON.stringify(cancelEmit[0]));

    const beforeAck = await page.evaluate(id =>
        window.sftpFileManager.transferQueue.find(t => t.id === id)?.status,
    started.id);
    eq('§6 the row is NOT cancelled before the server acknowledges',
        beforeAck, 'active');

    const afterDeny = await page.evaluate(() => {
        window.__acks?.cancel_transfer?.({ success: false });
        const q = window.sftpFileManager.transferQueue;
        return q[q.length - 1].status;
    });
    eq('§6 a denied cancel leaves the transfer running', afterDeny, 'active');

    const afterAck = await page.evaluate(() => {
        window.__acks?.cancel_transfer?.({ success: true });
        const q = window.sftpFileManager.transferQueue;
        const t = q[q.length - 1];
        const rows = [...document.querySelectorAll('.fm-transfer-item')];
        const row = rows[rows.length - 1];
        return {
            status: t.status,
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
            cancelBtn: !!row?.querySelector('[data-transfer-cancel]'),
            badge: document.getElementById('fmQueueBadge').textContent.trim(),
            isTransferring: window.sftpFileManager.isTransferring,
        };
    });
    eq('§6 an acknowledged cancel terminalizes as cancelled',
        afterAck.status, 'cancelled');
    eq('§8 EN cancelled row reads Cancelled', afterAck.statusText, '✗ Cancelled');
    check('§6 a cancelled row offers no cancel control', !afterAck.cancelBtn, '');
    eq('§6 a cancelled transfer stops counting as active', afterAck.badge, '0');
    check('§6 the queue is free to advance again', afterAck.isTransferring === false,
        JSON.stringify(afterAck));

    const lateError = await page.evaluate((id) => {
        window.__socketFixture.__fire('s2s_transfer_error', {
            transfer_id: id, error: 'Transfer failed',
        });
        return window.sftpFileManager.transferQueue.find(t => t.id === id)?.status;
    }, started.id);
    eq('§6 a late error cannot overwrite a cancelled transfer',
        lateError, 'cancelled');

    /*
     * EVENT path rather than ack path: the row terminalizes from
     * s2s_transfer_cancelled alone, with no ack callback involved.
     *
     * This is NOT "another tab's cancel" any more (review round 6): the server
     * addresses that event to the OWNING socket, so a non-owner tab never receives
     * it -- and a non-owner tab can no longer cancel at all. What is pinned here is
     * the client handler itself: an event-delivered cancellation terminalizes the
     * row, and a repeat is idempotent. Delivery scope and authorization are
     * asserted server-side in tests/test_s2s_socket_protocol.py
     * (TestCancelIsOwnerSocketScoped).
     */
    await clearEmits(page);
    const broadcast = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/r2.log', { sessionId: 's2' },
            { name: 'r2.log', is_dir: false, size: 10 });
        const id = window.__emits
            .find(x => x.evt === 'transfer_server_to_server') && (window.__serverIds || []).slice(-1)[0];
        window.__socketFixture.__fire('s2s_transfer_started', { transfer_id: id });
        window.__socketFixture.__fire('s2s_transfer_cancelled', {
            transfer_id: id, status: 'cancelled',
        });
        const first = fm.transferQueue.find(t => t.id === id)?.status;
        // Idempotence: a repeat must not throw or double-count.
        window.__socketFixture.__fire('s2s_transfer_cancelled', { transfer_id: id });
        return { first, second: fm.transferQueue.find(t => t.id === id)?.status };
    });
    eq('§6 a broadcast cancellation terminalizes the row', broadcast.first, 'cancelled');
    eq('§6 repeat cancellation is idempotent', broadcast.second, 'cancelled');

    // The race: a transfer that COMPLETED must not be repainted as cancelled.
    const race = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/r3.log', { sessionId: 's2' },
            { name: 'r3.log', is_dir: false, size: 10 });
        const id = window.__emits
            .filter(x => x.evt === 'transfer_server_to_server').pop() && (window.__serverIds || []).slice(-1)[0];
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: id, filename: 'r3.log',
        });
        window.__socketFixture.__fire('s2s_transfer_cancelled', { transfer_id: id });
        return fm.transferQueue.find(t => t.id === id)?.status;
    });
    eq('§6 a completed transfer wins the cancel race', race, 'complete');

    // ── §7 error still distinct ─────────────────────────────────────────────
    const failed = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/r4.log', { sessionId: 's2' },
            { name: 'r4.log', is_dir: false, size: 10 });
        const id = window.__emits
            .filter(x => x.evt === 'transfer_server_to_server').pop() && (window.__serverIds || []).slice(-1)[0];
        window.__socketFixture.__fire('s2s_transfer_started', { transfer_id: id });
        window.__socketFixture.__fire('s2s_transfer_error', {
            transfer_id: id, error: 'Transfer failed',
        });
        const t = fm.transferQueue.find(x => x.id === id);
        const row = [...document.querySelectorAll('.fm-transfer-item')].pop();
        return {
            status: t?.status,
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
        };
    });
    eq('§7 a failing transfer terminalizes as error', failed.status, 'error');
    check('§7 error and cancelled are different words',
        /Failed/.test(failed.statusText) && !/Cancel/.test(failed.statusText),
        JSON.stringify(failed));

    // ── §10 focus / keyboard safety and no duplication ──────────────────────
    const safety = await page.evaluate(() => ({
        activeIsComposer: document.activeElement?.id === 'mobileInput',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        surfaces: document.querySelectorAll('#sftpFileManager').length,
        panels: document.querySelectorAll('#sftpPanel').length,
        uploadModals: document.querySelectorAll('#fileTransferModal').length,
        composers: document.querySelectorAll('#mobileInput').length,
        openerNodes: document.querySelectorAll('#fileTransferOpenBtn').length,
    }));
    check('§10 opening the transfer surface never focuses the composer',
        !safety.activeIsComposer && !safety.keyboardOpen, JSON.stringify(safety));
    eq('§10 exactly one of each surface, panel, modal, composer and opener',
        [safety.surfaces, safety.panels, safety.uploadModals,
            safety.composers, safety.openerNodes], [1, 1, 1, 1, 1]);

    // ── §11 chip geometry unchanged by all of the above ─────────────────────
    const chipAfter = await page.evaluate(() => {
        const tab = document.getElementById('tab-s1');
        const r = tab.getBoundingClientRect();
        const cs = getComputedStyle(tab, '::before');
        return {
            painted: Math.round(r.height),
            band: Math.round(parseFloat(cs.height) || 0) || Math.round(r.height),
        };
    });
    /*
     * The chip ruling is per-tier, not one number: 30px painted on a fine
     * pointer (deck.css @media (pointer: fine) -> height/min-height 30px), and a
     * 44px touch band on coarse pointers, where the band IS the chip box. This
     * asserts the desktop figure here and the touch figure in the phone block,
     * plus that nothing in the transfer work moved either.
     */
    eq('§11 the painted chip height is unchanged by the transfer work',
        chipAfter.painted, chipBefore.painted);
    eq('§11 the desktop chip is painted 30px', chipAfter.painted, 30);

    check('§1-§11 no page errors on desktop', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §8 Vietnamese labels ==');
{
    const { ctx, page, pageErrors } = await shell({
        width: 1440, height: 900, touch: false, locale: 'vi',
    });
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    const viMenu = await page.evaluate(() => {
        const btn = document.getElementById('fileTransferOpenBtn');
        return {
            text: btn?.querySelector('[data-i18n]')?.textContent.trim(),
            title: btn?.getAttribute('title'),
        };
    });
    eq('§8 VI menu entry reads "Truyền tệp"', viMenu.text, 'Truyền tệp');
    eq('§8 VI menu title reads "Truyền tệp"', viMenu.title, 'Truyền tệp');

    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(250);
    await seedPanes(page);

    /* The MODAL heading is a separate string from the menu entry, and it was the
     * one still reading "Trình quản lý tệp" / "File Manager" — the name of a
     * different feature. The contextual per-session control must keep the SHORT
     * mockup form, so the two cannot be conflated. Read AFTER the open, because
     * the modal is built by createModal at first open. */
    const viNames = await page.evaluate(() => ({
        modalTitle: document.querySelector('#fmModalTitle [data-i18n]')?.textContent.trim(),
        contextual: document.querySelector('#fileTransferBtn .btn-label')?.textContent.trim(),
        contextualTitle: document.getElementById('fileTransferBtn')?.getAttribute('title'),
    }));
    eq('§8 VI global modal title reads "Truyền tệp"', viNames.modalTitle, 'Truyền tệp');
    eq('§8 VI contextual control reads the short "Tệp"', viNames.contextual, 'Tệp');
    eq('§8 VI contextual title reads "Tệp"', viNames.contextualTitle, 'Tệp');

    const viSurface = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 10 });
        const id = window.__emits
            .filter(x => x.evt === 'transfer_server_to_server').pop() && (window.__serverIds || []).slice(-1)[0];
        window.__socketFixture.__fire('s2s_transfer_started', { transfer_id: id });
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: id, filename: 'report.log', transferred: 1, total: 10, percent: 10,
        });
        const row = [...document.querySelectorAll('.fm-transfer-item')].pop();
        const cancel = row?.querySelector('[data-transfer-cancel]');
        const out = {
            transferBtn: document.querySelector('#fmTransfer .btn-text')?.textContent.trim(),
            sourceTab: document.querySelector('.fm-pane-tab[data-pane="left"] span')
                ?.textContent.trim(),
            destTab: document.querySelector('.fm-pane-tab[data-pane="right"] span')
                ?.textContent.trim(),
            queueTitle: document.querySelector('#fmQueueHeader [data-i18n]')
                ?.textContent.trim(),
            cancelLabel: cancel?.getAttribute('aria-label'),
        };
        window.__socketFixture.__fire('s2s_transfer_cancelled', { transfer_id: id });
        out.cancelledText = [...document.querySelectorAll('.fm-transfer-item')].pop()
            ?.querySelector('.fm-transfer-status')?.textContent.trim();
        return out;
    });
    eq('§8 VI Transfer action reads "Truyền"', viSurface.transferBtn, 'Truyền');
    eq('§8 VI pane switcher reads Nguồn / Đích',
        [viSurface.sourceTab, viSurface.destTab], ['Nguồn', 'Đích']);
    eq('§8 VI queue header reads "Tiến trình truyền"',
        viSurface.queueTitle, 'Tiến trình truyền');
    eq('§8 VI cancel control is labelled "Hủy"', viSurface.cancelLabel, 'Hủy');
    eq('§8 VI cancelled row reads "Đã hủy"', viSurface.cancelledText, '✗ Đã hủy');

    const viUpload = await page.evaluate(() => {
        document.getElementById('fileTransferBtn')?.click();
        const btn = document.getElementById('fmUploadDownloadBtn');
        return { title: btn?.getAttribute('title'), aria: btn?.getAttribute('aria-label') };
    });
    eq('§8 VI Upload/Download control reads "Tải lên / Tải xuống"',
        [viUpload.title, viUpload.aria],
        ['Tải lên / Tải xuống', 'Tải lên / Tải xuống']);

    /*
     * THE DIRECT OPEN ASSERTION.
     *
     * Blocker B1 demands the heading as seen THROUGH the opener:
     * press #fmUploadDownloadBtn, then the modal's heading must read the
     * locale's files.uploadDownload — not files.fileTransfer, and not whatever
     * a previous surface left behind. §22 reads the heading's key without
     * opening anything; this one goes through the real route.
     */
    const openedByButton = await page.evaluate(async () => {
        document.getElementById('fmUploadDownloadBtn').click();
        await new Promise(r => setTimeout(r, 150));
        const modal = document.getElementById('fileTransferModal');
        const h = document.getElementById('fileTransferTitle');
        const out = {
            open: modal?.classList.contains('show'),
            labelledBy: modal?.getAttribute('aria-labelledby'),
            heading: h?.textContent.trim(),
            wanted: window.i18n?.t('files.uploadDownload'),
            wrongName: window.i18n?.t('files.fileTransfer'),
            headingKey: h?.dataset.i18n,
        };
        document.getElementById('closeFileTransferModal')?.click();
        return out;
    });
    check('§8 VI pressing #fmUploadDownloadBtn opens the modal',
        openedByButton.open, JSON.stringify(openedByButton));
    eq('§8 VI the modal heading is wired via aria-labelledby',
        openedByButton.labelledBy, 'fileTransferTitle');
    eq('§8 VI the opened heading reads this locale\'s Upload / Download',
        openedByButton.heading, openedByButton.wanted);
    check('§8 VI the opened heading is NOT the global File Transfer name',
        openedByButton.heading !== openedByButton.wrongName,
        JSON.stringify(openedByButton));
    eq('§8 VI the opened heading carries the uploadDownload key',
        openedByButton.headingKey, 'files.uploadDownload');

    check('§8 no page errors in Vietnamese', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §12 serial queue, §13 reopen reset, §14 tabs (desktop) ==');
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(250);
    await seedPanes(page);

    /* ── §12 the multi-file queue is SERIAL ──────────────────────────────────
     *
     * Both files are selected and Transfer is pressed once. The contract is that
     * the second transfer is not even requested until the first has reached a
     * terminal state: firing them together made concurrent progress events
     * overwrite each other's rows, and started a directory copy before the
     * previous one had released its SFTP channels.
     */
    await clearEmits(page);
    const serial = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.panes.left.selected = new Set([0, 1]);
        const running = fm.executeTransfer();
        const trace = [];
        const count = () => window.__emits
            .filter(x => x.evt === 'transfer_server_to_server').length;

        // Give the first ack time to land, then look: exactly one request so far.
        await new Promise(r => setTimeout(r, 120));
        trace.push({ stage: 'after first ack', requests: count() });

        // Still one while the first transfer is mid-flight.
        const first = (window.__serverIds || [])[0];
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: first, filename: 'report.log', transferred: 1,
            total: 2, percent: 50,
        });
        await new Promise(r => setTimeout(r, 200));
        trace.push({ stage: 'while first in flight', requests: count() });

        // Terminalize the first; only now may the second be requested.
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: first, filename: 'report.log',
        });
        await new Promise(r => setTimeout(r, 300));
        trace.push({ stage: 'after first completes', requests: count() });

        const second = (window.__serverIds || [])[1];
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: second, filename: 'bundle',
        });
        await running;
        return {
            trace,
            requests: count(),
            paths: window.__emits
                .filter(x => x.evt === 'transfer_server_to_server')
                .map(x => x.payload.source_path),
            ids: fm.transferQueue.map(t => t.id),
            serverIds: window.__serverIds || [],
            statuses: fm.transferQueue.map(t => t.status),
        };
    });
    eq('§12 only one transfer is requested before the first finishes',
        serial.trace[0].requests, 1);
    eq('§12 the second is NOT requested while the first is in flight',
        serial.trace[1].requests, 1);
    eq('§12 the second is requested once the first terminalizes',
        serial.trace[2].requests, 2);
    eq('§12 both selected items are sent, in order', serial.paths,
        ['/opt/sshdeck/report.log', '/opt/sshdeck/bundle']);
    eq('§12 every row is bound to a distinct server id',
        serial.ids, serial.serverIds);
    eq('§12 both rows reach a terminal state',
        serial.statuses, ['complete', 'complete']);

    /* A cancel stops the BATCH: continuing would start the very copies the user
     * just stopped. Progress already made must survive. */
    await clearEmits(page);
    const batchCancel = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        window.__serverIds = [];
        fm.panes.left.selected = new Set([0, 1]);
        const running = fm.executeTransfer();
        await new Promise(r => setTimeout(r, 120));
        const first = (window.__serverIds || [])[0];
        window.__socketFixture.__fire('s2s_transfer_cancelled', { transfer_id: first });
        await new Promise(r => setTimeout(r, 300));
        await running;
        return {
            requests: window.__emits
                .filter(x => x.evt === 'transfer_server_to_server').length,
            statuses: fm.transferQueue.map(t => t.status),
        };
    });
    eq('§12 a cancelled item stops the batch', batchCancel.requests, 1);
    eq('§12 the cancelled row keeps its cancelled state',
        batchCancel.statuses, ['cancelled']);

    /* An item the server refuses must not abort the rest of the selection: one
     * name clash is not a reason to silently drop the remaining files. */
    await clearEmits(page);
    const partialRefusal = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        window.__serverIds = [];
        let seen = 0;
        window.__ackControl = { mode: 'normal' };
        // Refuse only the FIRST request.
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server') {
                seen += 1;
                window.__ackControl = seen === 1
                    ? { mode: 'refuse', error: 'Destination already exists' }
                    : { mode: 'normal' };
            }
            return origEmit.call(this, evt, payload, ack);
        };
        const running = fm.executeTransfer();
        await new Promise(r => setTimeout(r, 200));
        const second = (window.__serverIds || [])[0];
        if (second) {
            window.__socketFixture.__fire('s2s_transfer_complete', { transfer_id: second });
        }
        await new Promise(r => setTimeout(r, 200));
        await running;
        window.socket.emit = origEmit;
        window.__ackControl = {};
        return {
            requests: seen,
            rows: fm.transferQueue.length,
            statuses: fm.transferQueue.map(t => t.status),
        };
    });
    eq('§12 a refused item does not abort the remaining selection',
        partialRefusal.requests, 2);
    eq('§12 only the accepted item has a row', partialRefusal.rows, 1);
    eq('§12 the accepted item still completes',
        partialRefusal.statuses, ['complete']);

    /* ── §13 reopening resets every pane, path, selection and queue row ───────
     *
     * Reopening used to show the PREVIOUS session's host, path and selection, so
     * pressing Transfer copied files the user could not see, possibly involving a
     * session that no longer exists.
     */
    const reopened = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        // Dirty every piece of state a reopen must clear.
        fm.panes.left.selected = new Set([0, 1]);
        fm.panes.left.path = '/tmp/stale';
        fm.panes.right.path = '/tmp/also-stale';
        fm.dragSource = 'left';
        fm.draggedItems = [{ name: 'stale' }];
        fm.isTransferring = true;
        fm.close();
        fm.open();
        return {
            leftType: fm.panes.left.type,
            rightType: fm.panes.right.type,
            leftSession: fm.panes.left.sessionId,
            leftPath: fm.panes.left.path,
            leftSelected: fm.panes.left.selected.size,
            rightSelected: fm.panes.right.selected.size,
            queue: fm.transferQueue.length,
            activeTransfers: fm.activeTransfers.size,
            isTransferring: fm.isTransferring,
            dragSource: fm.dragSource,
            draggedItems: fm.draggedItems.length,
            activePane: fm.activePane,
            leftSelectValue: document.getElementById('fmLeftSource')?.value,
            // The destination is re-seeded from the ACTIVE session, which is the
            // one deliberate exception to "everything empty".
            rightSession: fm.panes.right.sessionId,
        };
    });
    eq('§13 the source pane has no stale host', reopened.leftType, null);
    eq('§13 the source pane has no stale session', reopened.leftSession, null);
    eq('§13 the source path is back to root', reopened.leftPath, '/');
    eq('§13 no stale selection survives',
        [reopened.leftSelected, reopened.rightSelected], [0, 0]);
    eq('§13 the queue is empty', reopened.queue, 0);
    eq('§13 no active transfers are tracked', reopened.activeTransfers, 0);
    eq('§13 the transferring flag is cleared', reopened.isTransferring, false);
    eq('§13 no stale drag state survives',
        [reopened.dragSource, reopened.draggedItems], [null, 0]);
    eq('§13 the Source end is selected on open', reopened.activePane, 'left');
    eq('§13 the source selector shows no stale value',
        reopened.leftSelectValue, '');
    eq('§13 the destination is re-seeded from the active session',
        reopened.rightSession, 's1');

    /* ── §23 DESTINATION-TO-SOURCE DRAG IS REFUSED ──────────────────────────
     *
     * Real interaction, on the real listeners, with real DragEvents carrying a
     * DataTransfer -- not a call into handleDrop.
     *
     * The defect: the drop handler fired whenever `dragSource !== targetPane`, so
     * dragging from Destination onto Source ran executeTransfer -- which ALWAYS
     * copies left->right. The reverse gesture therefore did not reverse anything:
     * it launched the forward copy using whatever stale selection the LEFT pane
     * still held, i.e. files the user never touched. The dragover affordance lit
     * up for that gesture too, advertising a drop the product cannot honour.
     */
    const dragDirection = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        // Both ends real, and a STALE left selection that a reverse drop must not
        // be able to send.
        fm.panes.left.type = 'ssh'; fm.panes.left.sessionId = 's1';
        fm.panes.left.path = '/opt/sshdeck';
        fm.panes.left.files = [
            { name: 'report.log', is_dir: false, size: 4096 },
            { name: 'notes.md', is_dir: false, size: 88 },
        ];
        fm.panes.right.type = 'ssh'; fm.panes.right.sessionId = 's2';
        fm.panes.right.path = '/srv/inbox';
        fm.panes.right.files = [{ name: 'existing.txt', is_dir: false, size: 12 }];
        // §13's reopen re-seeds the destination through onSourceChange, which
        // leaves the pane in `loading` -- renderPane then paints a spinner and no
        // rows, so a drag would have nothing to start from.
        ['left', 'right'].forEach(p => {
            fm.panes[p].loading = false;
            fm.panes[p].error = null;
        });
        fm.renderPane('left'); fm.renderPane('right');
        fm.transferQueue = [];
        fm.panes.left.selected = new Set([0]);   // the stale selection
        window.__emits = [];

        const leftPane = document.getElementById('fmLeftPane');
        const rightPane = document.getElementById('fmRightPane');
        const fire = (el, type) => {
            const ev = new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
            });
            el.dispatchEvent(ev);
            return ev;
        };
        // A real ENTRY row, not the parent ".." row: renderPane emits the parent
        // navigator first with data-index="-1", which is not a draggable file.
        const rowIn = pane => document.querySelector(
            `#fm${pane === 'left' ? 'Left' : 'Right'}List `
            + '.fm-file-item:not([data-type="parent"])');

        // ── REVERSE: start the drag in the DESTINATION pane, drop on SOURCE ──
        fire(rowIn('right'), 'dragstart');
        const reverseSource = fm.dragSource;
        fire(leftPane, 'dragover');
        const reverseHighlight = leftPane.classList.contains('drop-target');
        fire(leftPane, 'drop');
        await new Promise(r => setTimeout(r, 250));
        const reverseEmits = window.__emits.filter(
            e => e.evt === 'transfer_server_to_server').length;
        const reverseRows = fm.transferQueue.length;
        const dragStateAfterReverse = {
            dragSource: fm.dragSource, dragged: fm.draggedItems.length };

        // ── FORWARD: the one gesture that IS a transfer ──────────────────────
        window.__emits = [];
        fm.transferQueue = [];
        fire(rowIn('left'), 'dragstart');
        const forwardSource = fm.dragSource;
        fire(rightPane, 'dragover');
        const forwardHighlight = rightPane.classList.contains('drop-target');
        fire(rightPane, 'drop');
        await new Promise(r => setTimeout(r, 400));
        const forwardEmits = window.__emits.filter(
            e => e.evt === 'transfer_server_to_server');

        return {
            reverseSource, reverseHighlight, reverseEmits, reverseRows,
            dragStateAfterReverse,
            forwardSource, forwardHighlight,
            forwardEmits: forwardEmits.length,
            forwardPayload: forwardEmits[0]?.payload,
        };
    });
    eq('§23 a Destination-pane drag records the right pane as its source',
        dragDirection.reverseSource, 'right');
    check('§23 the Source pane does NOT highlight for a reverse drag',
        dragDirection.reverseHighlight === false,
        JSON.stringify(dragDirection));
    eq('§23 a reverse drop emits NO transfer', dragDirection.reverseEmits, 0);
    eq('§23 a reverse drop queues no row', dragDirection.reverseRows, 0);
    eq('§23 a refused drag clears its own state, so no later drop reuses it',
        [dragDirection.dragStateAfterReverse.dragSource,
         dragDirection.dragStateAfterReverse.dragged], [null, 0]);
    eq('§23 a Source-pane drag records the left pane', dragDirection.forwardSource, 'left');
    check('§23 the Destination pane DOES highlight for a forward drag',
        dragDirection.forwardHighlight === true, JSON.stringify(dragDirection));
    eq('§23 a forward drop emits exactly one transfer',
        dragDirection.forwardEmits, 1);
    eq('§23 the forward drop copies FROM the source session',
        dragDirection.forwardPayload?.source_session_id, 's1');
    eq('§23 the forward drop copies TO the destination session',
        dragDirection.forwardPayload?.dest_session_id, 's2');

    /* ── §24 A REOPEN MUST NOT LEAVE A HIDDEN BATCH RUNNING ─────────────────
     *
     * executeTransfer is an async loop that captured the pane OBJECTS and derived
     * every path from them. resetTransferSurfaceState replaces panes.left/right
     * with FRESH objects, so reopening mid-batch left the loop copying from the
     * OLD source host into the OLD destination path -- while the visible surface
     * showed neither and its rows had been cleared. The user could not see the
     * copies still being made and could not cancel them.
     */
    const batchFence = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.panes.left.type = 'ssh'; fm.panes.left.sessionId = 'sOLD';
        fm.panes.left.path = '/old/src';
        fm.panes.left.files = [
            { name: 'one.txt', is_dir: false, size: 10 },
            { name: 'two.txt', is_dir: false, size: 10 },
            { name: 'three.txt', is_dir: false, size: 10 },
            { name: 'four.txt', is_dir: false, size: 10 },
        ];
        fm.panes.right.type = 'ssh'; fm.panes.right.sessionId = 'sOLDDST';
        fm.panes.right.path = '/old/dst';
        fm.panes.left.selected = new Set([0, 1, 2, 3]);
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();

        // Record every request with the paths it carried, and hold each transfer
        // OPEN (never terminalize) so the batch is genuinely mid-flight.
        const requests = [];
        const origEmit = window.socket.emit;
        let n = 0;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                n += 1;
                requests.push({ src: payload.source_path, dst: payload.dest_path,
                                srcSession: payload.source_session_id,
                                dstSession: payload.dest_session_id });
                setTimeout(() => ack({ success: true, transfer_id: `fence-${n}` }), 0);
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };

        const batch = fm.executeTransfer();
        // Let the FIRST item start, then reopen underneath the running loop.
        await new Promise(r => setTimeout(r, 250));
        const midFlight = {
            requests: requests.length,
            epoch: fm.batchEpoch,
            activeBatch: !!fm.activeBatch,
            rows: fm.transferQueue.length,
            liveRows: fm.transferQueue.filter(
                t => ['pending', 'active'].includes(t.status)).length,
        };

        fm.close();
        fm.open();          // <-- the reopen, mid-batch
        const afterReopen = {
            epoch: fm.batchEpoch,
            activeBatch: !!fm.activeBatch,
            rows: fm.transferQueue.length,
            liveRows: fm.transferQueue.filter(
                t => ['pending', 'active'].includes(t.status)).length,
            leftSession: fm.panes.left.sessionId,
            leftPath: fm.panes.left.path,
            requestsAtReopen: requests.length,
        };

        /*
         * RELEASE THE FIRST ITEM. Without this the loop stays parked inside
         * waitForS2STerminal forever and never reaches its next item, so the test
         * would pass with or without the fence -- it would prove nothing. Landing
         * the terminal event lets the loop advance to exactly the boundary the
         * fence guards, and THAT is where a stale continuation would be issued.
         */
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: 'fence-1', filename: 'one.txt',
        });

        // Give the old loop every chance to continue. If the fence works it stops
        // at its next item boundary and issues nothing further.
        await Promise.race([batch, new Promise(r => setTimeout(r, 1500))]);
        window.socket.emit = origEmit;

        return {
            midFlight, afterReopen,
            requestsAtEnd: requests.length,
            // Anything issued AFTER the reopen would carry the stale paths.
            staleAfterReopen: requests.slice(afterReopen.requestsAtReopen),
            allSrc: requests.map(r => r.src),
        };
    });
    check('§24 the batch was genuinely mid-flight at the reopen',
        batchFence.midFlight.requests >= 1 && batchFence.midFlight.activeBatch,
        JSON.stringify(batchFence.midFlight));
    check('§24 the reopen bumps the batch epoch',
        batchFence.afterReopen.epoch > batchFence.midFlight.epoch,
        JSON.stringify(batchFence));
    eq('§24 NO further transfer is issued after the reopen',
        batchFence.staleAfterReopen, []);
    eq('§24 the request count does not grow after the reopen',
        batchFence.requestsAtEnd, batchFence.afterReopen.requestsAtReopen);
    check('§24 no stale source path was ever used',
        batchFence.allSrc.every(p => p.startsWith('/old/src/')),
        JSON.stringify(batchFence.allSrc));
    check('§24 the in-flight row SURVIVES the reopen, so it stays cancellable',
        batchFence.afterReopen.liveRows >= 1, JSON.stringify(batchFence));
    eq('§24 the reopened surface shows a clean Source end',
        [batchFence.afterReopen.leftSession, batchFence.afterReopen.leftPath],
        [null, '/']);
    eq('§24 the batch marker is cleared by the reopen',
        batchFence.afterReopen.activeBatch, false);

    /* ── §25 ACTIVE-BATCH REOPEN LIFECYCLE (blockers B4/B6) ─────────────────
     *
     * §24 proved the reopen STOPS the loop and keeps the row alive. Blocker
     * B4 goes further into the lifecycle AFTER that row survives:
     *
     *   a. its queue row and its Cancel control must still be ON SCREEN, and
     *      that Cancel must still be operable — a click reaches the server, and
     *      an acknowledged cancel terminalizes the row;
     *   b. a reopen must never silently replace the captured source or
     *      destination host/path: the in-flight transfer continues against the
     *      very hosts it started with (nothing rewrites them), while the VISIBLE
     *      panes are re-seeded and carry no stale host or path;
     *   c. an event for a survivor's id that arrives while the surface is closed
     *      must not be re-buffered and re-drained onto the row — that would apply
     *      an outcome twice (B6's reopen side).
     */
    const lifecycle = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        // Reset the surface to a known baseline first.
        fm.close();
        fm.open();
        fm.panes.left.type = 'ssh'; fm.panes.left.sessionId = 'sA';
        fm.panes.left.path = '/data/src';
        fm.panes.left.files = [{ name: 'alpha.bin', is_dir: false, size: 10 }];
        fm.panes.right.type = 'ssh'; fm.panes.right.sessionId = 'sB';
        fm.panes.right.path = '/data/dst';
        fm.panes.right.files = [];
        fm.panes.left.selected = new Set([0]);
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();

        /*
         * Every wait below is BOUNDED and reports what it was waiting for. A bare
         * poll would turn any product regression into a hung suite instead of a
         * named failure, and a hang is indistinguishable from a pass that never
         * printed.
         */
        const until = async (label, predicate, ms = 3000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                if (predicate()) return null;
                await new Promise(r => setTimeout(r, 20));
            }
            return `TIMEOUT waiting for ${label}`;
        };
        const timeouts = [];
        const record = message => { if (message) timeouts.push(message); };

        // Hold the transfer open; record the hosts the batch actually copied
        // between, so (b) can check nothing replaced them.
        const requests = [];
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                requests.push({ srcSession: payload.source_session_id,
                                dstSession: payload.dest_session_id,
                                src: payload.source_path, dst: payload.dest_path });
                setTimeout(() => ack({ success: true, transfer_id: 'life-1' }), 0);
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };

        /*
         * START the batch and RETAIN the promise -- do not await it here.
         *
         * `await fm.executeTransfer()` was the hang (found): the loop
         * parks inside waitForS2STerminal until 'life-1' reaches a terminal state,
         * and this test deliberately never fires one -- an in-flight transfer is
         * the whole premise of the reopen it is about to perform. Awaiting first
         * meant the await could only return after the thing it was setting up for
         * had already ended, so it never returned at all.
         *
         * The promise is awaited at the END, after the acknowledged cancel
         * terminalizes the row, which is also what proves the loop unwinds and the
         * surface returns to idle rather than leaking a running batch.
         */
        const batch = fm.executeTransfer();
        // The ack is delivered on a timer, so the row does not exist yet. Wait for
        // the real thing this section is about: an ACTIVE row bound to the server
        // id, i.e. the ack landed and processTransferQueue promoted it.
        record(await until('the active row bound to the server ack', () => {
            const row = fm.transferQueue.find(t => String(t.id) === 'life-1');
            return !!row && row.status === 'active';
        }));
        const captured = requests[0];
        const rowAtStart = fm.transferQueue.find(t => String(t.id) === 'life-1');
        const midFlight = {
            requests: requests.length,
            activeBatch: !!fm.activeBatch,
            isTransferring: fm.isTransferring,
            status: rowAtStart?.status,
        };

        // (a) the row and its Cancel must still be visible on screen.
        const onScreen = (() => {
            const row = document.querySelector(
                '.fm-transfer-item[data-transfer-type="s2s"]');
            const rect = row?.getBoundingClientRect();
            const btn = row?.querySelector('[data-transfer-cancel]');
            const btnRect = btn?.getBoundingClientRect();
            const cs = btn ? getComputedStyle(btn) : null;
            return {
                rowExists: !!row,
                rowShown: !!row && rect.width > 0 && rect.height > 0
                    && cs !== null && getComputedStyle(row).display !== 'none',
                cancelExists: !!btn,
                cancelShown: !!btn && btnRect.width > 0 && btnRect.height > 0
                    && cs.display !== 'none' && cs.visibility !== 'hidden',
            };
        })();

        // Reopen underneath the active row.
        fm.close();
        fm.open();
        const afterReopen = {
            rows: fm.transferQueue.length,
            survivorSameObject: fm.transferQueue[0] === rowAtStart,
            survivorId: fm.transferQueue[0]?.id,
            survivorStatus: fm.transferQueue[0]?.status,
            earlyBuffer: fm.earlyS2SEvents.size,
            leftSession: fm.panes.left.sessionId,
            leftPath: fm.panes.left.path,
            rightValue: document.getElementById('fmRightSource')?.value,
        };

        // (a') after the reopen, the Cancel is still on screen AND operable.
        const cancelAfterReopen = (() => {
            const btn = document.querySelector(
                '.fm-transfer-item[data-transfer-type="s2s"] '
                + '[data-transfer-cancel]');
            return {
                exists: !!btn,
                shown: !!btn && btn.getBoundingClientRect().height > 0,
                id: btn?.dataset.transferCancel,
            };
        })();
        /*
         * Click the SURVIVING Cancel, with the fixture acknowledging it, and wait
         * for the ack-gated terminalization. cancelQueuedTransfer paints nothing
         * optimistically -- the row only moves when the server says success -- so
         * this waits for the state the production path actually produces.
         */
        window.__cancelAckMode = 'auto';
        document.querySelector('[data-transfer-cancel="life-1"]')?.click();
        record(await until('the acknowledged cancel to terminalize the row', () =>
            fm.transferQueue.find(t => String(t.id) === 'life-1')?.status
                === 'cancelled'));
        const cancelOutcome = {
            status: fm.transferQueue.find(t => String(t.id) === 'life-1')?.status,
            emittedCancel: window.__emits.filter(
                x => x.evt === 'cancel_transfer'
                    && x.payload?.transfer_id === 'life-1').length,
        };

        /*
         * NOW await the retained promise. waitForS2STerminal resolves on the
         * cancelled status, executeTransfer's cancel branch stops the batch, and
         * the loop unwinds -- so this both proves the real lifecycle and returns
         * the surface to idle. Bounded, so a product regression that leaves the
         * loop parked is a named failure rather than a hung run.
         */
        const batchSettled = await Promise.race([
            batch.then(() => 'SETTLED'),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 4000)),
        ]);
        const idle = {
            batchSettled,
            activeBatch: !!fm.activeBatch,
            isTransferring: fm.isTransferring,
            activeTransfers: fm.activeTransfers.size,
            requestsAtEnd: requests.length,
        };

        // (c) close again, then deliver a completion for the survivor's id while
        // the surface is closed. It must not land in the buffer...
        window.__cancelAckMode = null;
        fm.transferQueue = [];
        fm.queueTransfer({ id: 'life-2', type: 's2s', filename: 'beta.bin' });
        fm.close();
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: 'life-2', filename: 'beta.bin',
        });
        const foreignWhileClosed = {
            buffered: fm.earlyS2SEvents.size,
            bufferedForId: fm.earlyS2SEvents.has('life-2'),
        };
        // ...and a re-queue of the SAME id must not re-drain anything onto it.
        const statusBefore = fm.transferQueue[0].status;
        fm.queueTransfer({ id: 'life-2', type: 's2s', filename: 'beta.bin' });
        const requeueOutcome = {
            bufferedAfter: fm.earlyS2SEvents.has('life-2'),
            statusBefore,
            statusAfter: fm.transferQueue[0].status,
        };

        window.socket.emit = origEmit;
        fm.open();   // leave the surface open for whatever runs next
        return {
            timeouts, midFlight, captured, onScreen, afterReopen,
            cancelAfterReopen, cancelOutcome, idle, foreignWhileClosed,
            requeueOutcome,
        };
    });
    /*
     * Report any bounded wait that expired FIRST. Without this a product
     * regression would surface as a puzzling downstream mismatch instead of as
     * the step that actually failed to happen.
     */
    eq('§25 no lifecycle step timed out', lifecycle.timeouts, []);
    // The premise: the batch really was mid-flight, with one request issued, an
    // active row and a live batch marker, BEFORE the reopen happens.
    eq('§25 the batch is genuinely in flight before the reopen',
        lifecycle.midFlight,
        { requests: 1, activeBatch: true, isTransferring: true, status: 'active' });
    // (b) the batch copied between the hosts it captured — the reopen replaced
    // nothing the in-flight transfer was using.
    eq('§25 the in-flight batch keeps its captured source and destination',
        [lifecycle.captured?.srcSession, lifecycle.captured?.dstSession,
         lifecycle.captured?.src, lifecycle.captured?.dst],
        ['sA', 'sB', '/data/src/alpha.bin', '/data/dst/alpha.bin']);
    // (a) row + Cancel visible before the reopen.
    check('§25 the active row is on screen with its Cancel control',
        lifecycle.onScreen.rowExists && lifecycle.onScreen.rowShown
        && lifecycle.onScreen.cancelExists && lifecycle.onScreen.cancelShown,
        JSON.stringify(lifecycle.onScreen));
    // (a/b) the reopen keeps the SAME row alive and the VISIBLE panes clean.
    eq('§25 the reopen keeps exactly one row, the same object, still active',
        [lifecycle.afterReopen.rows, lifecycle.afterReopen.survivorSameObject,
         lifecycle.afterReopen.survivorId, lifecycle.afterReopen.survivorStatus],
        [1, true, 'life-1', 'active']);
    eq('§25 the reopened Source end shows no stale host or path',
        [lifecycle.afterReopen.leftSession, lifecycle.afterReopen.leftPath],
        [null, '/']);
    eq('§25 the reopened Destination is re-seeded, not stale',
        lifecycle.afterReopen.rightValue.startsWith('ssh:'), true);
    eq('§25 the reopen leaves nothing buffered',
        lifecycle.afterReopen.earlyBuffer, 0);
    // (a') Cancel survives the reopen and still works.
    check('§25 the Cancel control survives the reopen, on screen',
        lifecycle.cancelAfterReopen.exists && lifecycle.cancelAfterReopen.shown,
        JSON.stringify(lifecycle.cancelAfterReopen));
    eq('§25 the surviving Cancel still addresses the right id',
        lifecycle.cancelAfterReopen.id, 'life-1');
    eq('§25 clicking it emits cancel_transfer for that id',
        lifecycle.cancelOutcome.emittedCancel, 1);
    eq('§25 an acknowledged cancel terminalizes the survivor row',
        lifecycle.cancelOutcome.status, 'cancelled');
    /*
     * The retained batch promise resolved after that terminalization, and the
     * surface is idle: no batch marker, not transferring, nothing tracked, and NO
     * further request issued -- the superseded loop stopped at its fence rather
     * than starting another copy.
     */
    eq('§25 the batch promise settles once the row terminalizes, leaving idle state',
        lifecycle.idle,
        { batchSettled: 'SETTLED', activeBatch: false, isTransferring: false,
          activeTransfers: 0, requestsAtEnd: 1 });
    // (c) B6's reopen side.
    eq('§25 an event for a survivor id does not buffer while the surface is closed',
        [lifecycle.foreignWhileClosed.buffered,
         lifecycle.foreignWhileClosed.bufferedForId], [0, false]);
    eq('§25 re-queueing the same id re-drains nothing',
        [lifecycle.requeueOutcome.bufferedAfter,
         lifecycle.requeueOutcome.statusAfter], [false, 'complete']);

    /* ── §14 the pane tabs carry real tablist semantics ──────────────────────
     *
     * ATTRIBUTES ONLY on this tier. The tabs are display:none on a wide surface
     * (both panes are visible, so a switcher has nothing to do), which makes
     * geometry and focus assertions VACUOUS here: two hidden tabs are both 0px
     * wide, so an equal-width check passes whatever the CSS says, and focus() on
     * a display:none element is a no-op. Geometry and keyboard are asserted in
     * §18 on the phone, which is the tier where the tabs actually exist.
     */
    const tabs = await page.evaluate(() => {
        const list = document.getElementById('fmPaneTabs');
        const left = document.querySelector('.fm-pane-tab[data-pane="left"]');
        const right = document.querySelector('.fm-pane-tab[data-pane="right"]');
        return {
            listRole: list?.getAttribute('role'),
            listLabel: list?.getAttribute('aria-label'),
            roles: [left?.getAttribute('role'), right?.getAttribute('role')],
            controls: [left?.getAttribute('aria-controls'),
                       right?.getAttribute('aria-controls')],
            selected: [left?.getAttribute('aria-selected'),
                       right?.getAttribute('aria-selected')],
            tabindex: [left?.getAttribute('tabindex'), right?.getAttribute('tabindex')],
            controlsExist: [!!document.getElementById(left?.getAttribute('aria-controls')),
                            !!document.getElementById(right?.getAttribute('aria-controls'))],
            hiddenOnDesktop: getComputedStyle(list).display === 'none',
            bothPanesVisible: ['fmLeftPane', 'fmRightPane'].every(
                id => getComputedStyle(document.getElementById(id)).display !== 'none'),
        };
    });
    eq('§14 the switcher is a tablist', tabs.listRole, 'tablist');
    check('§14 the tablist is labelled', !!tabs.listLabel, JSON.stringify(tabs));
    eq('§14 both tabs have role=tab', tabs.roles, ['tab', 'tab']);
    eq('§14 aria-controls names the two panes', tabs.controls,
        ['fmLeftPane', 'fmRightPane']);
    eq('§14 aria-controls targets exist', tabs.controlsExist, [true, true]);
    eq('§14 the selected tab is the Source end', tabs.selected, ['true', 'false']);
    eq('§14 a roving tabindex keeps one stop', tabs.tabindex, ['0', '-1']);
    check('§14 the desktop hides the switcher because both panes are visible',
        tabs.hiddenOnDesktop && tabs.bothPanesVisible, JSON.stringify(tabs));

    /* ── §15 only s2s rows carry a working Cancel control ───────────────────*/
    const cancelScope = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.queueTransfer({ id: 'up-1', type: 'upload', filename: 'a.txt' });
        fm.queueTransfer({ id: 'dn-1', type: 'download', filename: 'b.txt' });
        fm.queueTransfer({ id: 's2s-1', type: 's2s', filename: 'c.txt' });
        fm.renderTransferQueue();
        const rows = [...document.querySelectorAll('.fm-transfer-item')];
        return rows.map(r => ({
            type: r.dataset.transferType,
            hasCancel: !!r.querySelector('[data-transfer-cancel]'),
        }));
    });
    eq('§15 upload rows offer no dead Cancel control',
        cancelScope.filter(r => r.type === 'upload').map(r => r.hasCancel), [false]);
    eq('§15 download rows offer no dead Cancel control',
        cancelScope.filter(r => r.type === 'download').map(r => r.hasCancel), [false]);
    eq('§15 s2s rows do offer Cancel',
        cancelScope.filter(r => r.type === 's2s').map(r => r.hasCancel), [true]);

    /* ── §16 terminal states are monotonic in every direction ───────────────*/
    const monotonic = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        const trial = (first, second) => {
            fm.transferQueue = [{ id: 'm1', type: 's2s', filename: 'x',
                                  status: 'active', progress: 10 }];
            first('m1');
            const afterFirst = fm.transferQueue[0].status;
            second('m1');
            return { afterFirst, afterSecond: fm.transferQueue[0].status };
        };
        const complete = id => fm.completeS2STransfer({ transfer_id: id });
        const fail = id => fm.failS2STransfer({ transfer_id: id, error: 'boom' });
        const cancel = id => fm.cancelS2STransfer({ transfer_id: id });
        return {
            cancelThenComplete: trial(cancel, complete),
            cancelThenError: trial(cancel, fail),
            completeThenCancel: trial(complete, cancel),
            completeThenError: trial(complete, fail),
            errorThenComplete: trial(fail, complete),
            errorThenCancel: trial(fail, cancel),
            unknownId: (() => {
                fm.transferQueue = [];
                fm.completeS2STransfer({ transfer_id: 'nope' });
                fm.cancelS2STransfer({ transfer_id: 'nope' });
                fm.failS2STransfer({ transfer_id: 'nope' });
                return fm.transferQueue.length;
            })(),
        };
    });
    eq('§16 a late completion cannot overwrite cancelled',
        monotonic.cancelThenComplete, { afterFirst: 'cancelled', afterSecond: 'cancelled' });
    eq('§16 a late error cannot overwrite cancelled',
        monotonic.cancelThenError, { afterFirst: 'cancelled', afterSecond: 'cancelled' });
    eq('§16 a late cancel cannot overwrite complete',
        monotonic.completeThenCancel, { afterFirst: 'complete', afterSecond: 'complete' });
    eq('§16 a late error cannot overwrite complete',
        monotonic.completeThenError, { afterFirst: 'complete', afterSecond: 'complete' });
    eq('§16 a late completion cannot overwrite error',
        monotonic.errorThenComplete, { afterFirst: 'error', afterSecond: 'error' });
    eq('§16 a late cancel cannot overwrite error',
        monotonic.errorThenCancel, { afterFirst: 'error', afterSecond: 'error' });
    eq('§16 events for an unknown id create no row', monotonic.unknownId, 0);

    /* ── §17 openInline stays a one-session Files surface ───────────────────*/
    const inlineRoute = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.close();
        // Simulate cached markup that predates #sftpPanel.
        document.getElementById('sftpPanel')?.remove();
        fm.openInline();
        const modal = document.getElementById('sftpFileManager');
        return {
            panelExists: !!document.getElementById('sftpPanel'),
            inlinePaneExists: !!document.getElementById('fmInlinePane'),
            globalModalOpen: !!modal?.classList.contains('show'),
            transferMode: !!modal?.classList.contains('fm-transfer-mode'),
            activePane: fm.activePane,
            panelCount: document.querySelectorAll('#sftpPanel').length,
        };
    });
    check('§17 a missing panel host is CREATED, not replaced by the modal',
        inlineRoute.panelExists && inlineRoute.inlinePaneExists,
        JSON.stringify(inlineRoute));
    check('§17 openInline never opens the global dual-pane surface',
        !inlineRoute.globalModalOpen && !inlineRoute.transferMode,
        JSON.stringify(inlineRoute));
    eq('§17 the inline route uses the one-session pane',
        inlineRoute.activePane, 'inline');
    eq('§17 no duplicate panel host is created', inlineRoute.panelCount, 1);

    /* ── §26 S2S LISTING USES EXEC; SINGLE-SESSION FILES STAYS SFTP ──────────
     *
     * The transport choice lives in the production payload builder so every
     * list/home/refresh/navigation emit shares one rule. Left/right are the
     * dual-pane S2S route and must explicitly request exec. Inline is the
     * one-session Files feature and must NOT carry the flag: the backend then
     * keeps its existing SFTP route. A mutation that drops the exec flag or
     * adds it to inline fails these behavioral payload assertions.
     */
    const fsTransport = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        return {
            left: fm.remoteFilesystemPayload('left', 's1',
                { remote_path: '/path with spaces' }),
            right: fm.remoteFilesystemPayload('right', 's2',
                { remote_path: '/destination' }),
            inline: fm.remoteFilesystemPayload('inline', 's1',
                { remote_path: '/files' }),
        };
    });
    eq('§26 Source listing explicitly selects SSH exec', fsTransport.left,
        { session_id: 's1', remote_path: '/path with spaces', transport: 'exec' });
    eq('§26 Destination listing explicitly selects SSH exec', fsTransport.right,
        { session_id: 's2', remote_path: '/destination', transport: 'exec' });
    check('§26 single-session Files carries no exec transport flag',
        !('transport' in fsTransport.inline), JSON.stringify(fsTransport.inline));

    check('§12-§17, §26 no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §20 events that arrive BEFORE the ack ==');
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(250);
    await seedPanes(page);

    /*
     * THE ORDERING DEFECT. The server starts its worker before the ack callback
     * returns to the browser, so for a small file the whole transfer can finish
     * first. Those events used to hit a queue that had no row for the id yet and
     * were dropped, leaving the row stuck at "Waiting..." with
     * waitForS2STerminal never resolving — which stalls the entire serial queue.
     *
     * Made deterministic by having the fixture fire the terminal event INSIDE the
     * emit, strictly before the ack callback runs. No timing assumption.
     */
    const earlyComplete = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        window.__serverIds = [];
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                // The server issues the id, runs the whole transfer, and only
                // then answers. Both events precede the ack.
                const id = 'early-1';
                window.__serverIds.push(id);
                window.__socketFixture.__fire('s2s_transfer_progress', {
                    transfer_id: id, filename: 'report.log',
                    transferred: 4096, total: 4096, percent: 100,
                });
                window.__socketFixture.__fire('s2s_transfer_complete', {
                    transfer_id: id, filename: 'report.log',
                    source_path: '/opt/sshdeck/report.log',
                    dest_path: '/srv/inbox/report.log',
                });
                ack({ success: true, transfer_id: id });
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };
        const returned = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        // The queue must not hang: this resolves only if the row terminalized.
        const outcome = await Promise.race([
            fm.waitForS2STerminal(returned, 20),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 3000)),
        ]);
        window.socket.emit = origEmit;
        const row = fm.transferQueue.find(t => String(t.id) === String(returned));
        return {
            returned, outcome,
            status: row?.status,
            progress: row?.progress,
            rows: fm.transferQueue.length,
            buffered: fm.earlyS2SEvents?.size ?? -1,
            statusText: [...document.querySelectorAll('.fm-transfer-item')].pop()
                ?.querySelector('.fm-transfer-status')?.textContent.trim(),
        };
    });
    eq('§20 the row still adopts the server id', earlyComplete.returned, 'early-1');
    check('§20 an early completion does not hang the queue',
        earlyComplete.outcome !== 'TIMEOUT', JSON.stringify(earlyComplete));
    eq('§20 the early completion reaches the row', earlyComplete.status, 'complete');
    eq('§20 early progress is not lost', earlyComplete.progress, 100);
    check('§20 the row reads Done', /Done/.test(earlyComplete.statusText || ''),
        JSON.stringify(earlyComplete));
    eq('§20 exactly one row exists', earlyComplete.rows, 1);
    eq('§20 the buffer is drained, not left holding events',
        earlyComplete.buffered, 0);

    /* Same for an error arriving before the ack. */
    const earlyError = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                const id = 'early-2';
                window.__socketFixture.__fire('s2s_transfer_error', {
                    transfer_id: id, error: 'Transfer failed',
                });
                ack({ success: true, transfer_id: id });
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };
        const returned = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        const outcome = await Promise.race([
            fm.waitForS2STerminal(returned, 20),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 3000)),
        ]);
        window.socket.emit = origEmit;
        const row = fm.transferQueue.find(t => String(t.id) === String(returned));
        return { outcome, status: row?.status, error: row?.error,
                 buffered: fm.earlyS2SEvents?.size ?? -1 };
    });
    check('§20 an early error does not hang the queue',
        earlyError.outcome !== 'TIMEOUT', JSON.stringify(earlyError));
    eq('§20 the early error reaches the row', earlyError.status, 'error');
    eq('§20 the early error keeps its message', earlyError.error, 'Transfer failed');
    eq('§20 the buffer is drained after an early error', earlyError.buffered, 0);

    /* An early CANCEL must also win, and must not be overwritten by a
     * completion that was buffered behind it. */
    const earlyCancelRace = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                const id = 'early-3';
                window.__socketFixture.__fire('s2s_transfer_cancelled', {
                    transfer_id: id, status: 'cancelled',
                });
                // A late completion, buffered behind the cancel.
                window.__socketFixture.__fire('s2s_transfer_complete', {
                    transfer_id: id, filename: 'report.log',
                });
                ack({ success: true, transfer_id: id });
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };
        const returned = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        const outcome = await Promise.race([
            fm.waitForS2STerminal(returned, 20),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 3000)),
        ]);
        window.socket.emit = origEmit;
        const row = fm.transferQueue.find(t => String(t.id) === String(returned));
        return { outcome, status: row?.status, rows: fm.transferQueue.length };
    });
    check('§20 an early cancel does not hang the queue',
        earlyCancelRace.outcome !== 'TIMEOUT', JSON.stringify(earlyCancelRace));
    eq('§20 the first terminal event still wins when both arrive early',
        earlyCancelRace.status, 'cancelled');
    eq('§20 no duplicate row is created by the buffered pair',
        earlyCancelRace.rows, 1);

    /* Events for an id this client never queues must not accumulate. */
    const strayBuffer = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();
        for (let i = 0; i < 200; i += 1) {
            window.__socketFixture.__fire('s2s_transfer_progress', {
                transfer_id: 'never-queued', filename: 'x',
                transferred: i, total: 200, percent: i / 2,
            });
        }
        return {
            keys: fm.earlyS2SEvents.size,
            depth: fm.earlyS2SEvents.get('never-queued')?.events?.length ?? -1,
            cap: fm.MAX_EARLY_EVENTS_PER_ID,
        };
    });
    eq('§20 stray events buffer under one key', strayBuffer.keys, 1);
    check('§20 the stray buffer is bounded',
        strayBuffer.depth > 0 && strayBuffer.depth <= strayBuffer.cap,
        `depth ${strayBuffer.depth} cap ${strayBuffer.cap}`);

    /*
     * §21 BOUNDED AND EXPIRING EARLY BUFFER (review round 6).
     *
     * The per-id cap alone left the ID dimension unbounded and nothing ever
     * expired. Three properties are asserted against the product's own bounds,
     * not against magic numbers.
     */
    const idCap = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();
        // Twice the cap in DISTINCT ids, none of which this client ever queued.
        const n = fm.MAX_EARLY_IDS * 2;
        for (let i = 0; i < n; i += 1) {
            window.__socketFixture.__fire('s2s_transfer_progress', {
                transfer_id: `stray-${i}`, filename: 'x',
                transferred: 1, total: 2, percent: 50,
            });
        }
        return {
            size: fm.earlyS2SEvents.size,
            cap: fm.MAX_EARLY_IDS,
            fired: n,
            // Oldest must have been evicted, newest retained.
            hasOldest: fm.earlyS2SEvents.has('stray-0'),
            hasNewest: fm.earlyS2SEvents.has(`stray-${n - 1}`),
        };
    });
    check('§21 distinct stray ids are capped globally',
        idCap.size <= idCap.cap,
        `size ${idCap.size} cap ${idCap.cap} after ${idCap.fired} ids`);
    eq('§21 the oldest stray id was evicted', idCap.hasOldest, false);
    eq('§21 the newest stray id was retained', idCap.hasNewest, true);

    const ttl = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();
        const savedTtl = fm.EARLY_TTL_MS;
        fm.EARLY_TTL_MS = 30;   // shrink the product's own knob, do not fake time
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: 'expires-soon', filename: 'x',
            transferred: 1, total: 2, percent: 50,
        });
        const before = fm.earlyS2SEvents.has('expires-soon');
        await new Promise(r => setTimeout(r, 80));
        // The sweep is lazy: it runs on the next buffered event.
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: 'later', filename: 'y',
            transferred: 1, total: 2, percent: 50,
        });
        const after = fm.earlyS2SEvents.has('expires-soon');
        const laterKept = fm.earlyS2SEvents.has('later');
        fm.EARLY_TTL_MS = savedTtl;
        fm.earlyS2SEvents.clear();
        return { before, after, laterKept };
    });
    eq('§21 a stray id is buffered when it first arrives', ttl.before, true);
    eq('§21 a stray id past its TTL is expired', ttl.after, false);
    eq('§21 expiry does not drop a fresh id', ttl.laterKept, true);

    /* The ACK race the buffer exists for must STILL work under the new bounds:
     * an event that arrives before its own ack is replayed onto the row. */
    const raceStillWorks = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                window.__socketFixture.__fire('s2s_transfer_progress', {
                    transfer_id: 'race-ok', filename: 'a.txt',
                    transferred: 50, total: 100, percent: 50,
                });
                ack({ success: true, transfer_id: 'race-ok' });
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };
        await fm.transferSSHtoSSH('/src/a.txt', { sessionId: 's1' },
            '/dst/a.txt', { sessionId: 's2' },
            { name: 'a.txt', is_dir: false, size: 100 });
        window.socket.emit = origEmit;
        const row = fm.transferQueue.find(t => String(t.id) === 'race-ok');
        return { progress: row?.progress ?? -1, leftover: fm.earlyS2SEvents.size };
    });
    eq('§21 the pre-ack progress event still lands on its row',
        raceStillWorks.progress, 50);
    eq('§21 the drained id leaves no buffer entry behind',
        raceStillWorks.leftover, 0);

    /* The serial queue must still advance when the FIRST item terminalizes
     * early — the exact stall the buffer prevents. */
    const serialWithEarly = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        fm.earlyS2SEvents.clear();
        window.__serverIds = [];
        let n = 0;
        const origEmit = window.socket.emit;
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                n += 1;
                const id = `early-serial-${n}`;
                window.__serverIds.push(id);
                // Every item completes before its own ack returns.
                window.__socketFixture.__fire('s2s_transfer_complete', {
                    transfer_id: id, filename: `f${n}`,
                });
                ack({ success: true, transfer_id: id });
                return this;
            }
            return origEmit.call(this, evt, payload, ack);
        };
        fm.panes.left.selected = new Set([0, 1]);
        const done = await Promise.race([
            fm.executeTransfer().then(() => 'FINISHED'),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 5000)),
        ]);
        window.socket.emit = origEmit;
        return { done, requests: n, statuses: fm.transferQueue.map(t => t.status) };
    });
    eq('§20 the serial queue completes when every item terminalizes early',
        serialWithEarly.done, 'FINISHED');
    eq('§20 both items were still sent', serialWithEarly.requests, 2);
    eq('§20 both rows reached complete',
        serialWithEarly.statuses, ['complete', 'complete']);

    check('§20 no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §18 direction is fixed left->right, on a phone ==');
{
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
    await page.evaluate(() => document.getElementById('fileTransferOpenBtn')?.click());
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(250);
    await seedPanes(page);

    /*
     * THE P0 DEFECT, reproduced as the user hits it: select files under Source,
     * tab to Destination to check the target folder, press Transfer.
     *
     * executeTransfer used to read this.activePane as the source, so after that
     * tab the direction inverted — a second host's contents were copied over tiny's.
     * The direction is now fixed: left pane is Source, right pane is Destination,
     * whichever pane happens to be visible.
     */
    await clearEmits(page);
    const direction = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        // 1. Source end, select a real file.
        fm.setActivePane('left');
        fm.panes.left.selected = new Set([0]);
        // 2. Switch to the Destination end, exactly as the tab does.
        document.querySelector('.fm-pane-tab[data-pane="right"]').click();
        const visibleAfterSwitch = {
            activePane: fm.activePane,
            leftShown: document.getElementById('fmLeftPane').classList.contains('active'),
            rightShown: document.getElementById('fmRightPane').classList.contains('active'),
        };
        // 3. Press Transfer.
        const running = fm.executeTransfer();
        await new Promise(r => setTimeout(r, 200));
        const first = (window.__serverIds || [])[0];
        if (first) {
            window.__socketFixture.__fire('s2s_transfer_complete', { transfer_id: first });
        }
        await new Promise(r => setTimeout(r, 150));
        await running;
        const sent = window.__emits
            .find(x => x.evt === 'transfer_server_to_server')?.payload;
        return { visibleAfterSwitch, sent };
    });
    eq('§18 the Destination end is showing when Transfer is pressed',
        [direction.visibleAfterSwitch.activePane,
         direction.visibleAfterSwitch.leftShown,
         direction.visibleAfterSwitch.rightShown], ['right', false, true]);
    check('§18 a transfer was emitted', !!direction.sent,
        JSON.stringify(direction));
    eq('§18 SOURCE is the left pane session (tiny), not the visible pane',
        direction.sent?.source_session_id, 's1');
    eq('§18 DESTINATION is the right pane session (goclaw)',
        direction.sent?.dest_session_id, 's2');
    eq('§18 the payload copies FROM the source path',
        direction.sent?.source_path, '/opt/sshdeck/report.log');
    eq('§18 the payload copies TO the destination path',
        direction.sent?.dest_path, '/srv/inbox/report.log');

    /* The same fixed direction must hold when the SOURCE tab is the visible one,
     * so the assertion above cannot pass by accident of a hard-coded pane. */
    await clearEmits(page);
    const fromSourceTab = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        fm.transferQueue = [];
        window.__serverIds = [];
        document.querySelector('.fm-pane-tab[data-pane="left"]').click();
        fm.panes.left.selected = new Set([0]);
        const running = fm.executeTransfer();
        await new Promise(r => setTimeout(r, 200));
        const first = (window.__serverIds || [])[0];
        if (first) {
            window.__socketFixture.__fire('s2s_transfer_complete', { transfer_id: first });
        }
        await new Promise(r => setTimeout(r, 150));
        await running;
        return window.__emits
            .find(x => x.evt === 'transfer_server_to_server')?.payload;
    });
    eq('§18 direction is unchanged when the Source tab is visible',
        [fromSourceTab?.source_session_id, fromSourceTab?.dest_session_id],
        ['s1', 's2']);

    /* Tabs on the phone: the 44px floor and the ARIA state must both hold on the
     * tier where the tabs are the ONLY way to reach the other end. */
    const phoneTabs = await page.evaluate(() => {
        const left = document.querySelector('.fm-pane-tab[data-pane="left"]');
        const right = document.querySelector('.fm-pane-tab[data-pane="right"]');
        const box = el => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
        };
        const cs = getComputedStyle(left);
        return {
            boxes: [box(left), box(right)],
            selected: [left.getAttribute('aria-selected'),
                       right.getAttribute('aria-selected')],
            listRole: document.getElementById('fmPaneTabs')?.getAttribute('role'),
            visible: getComputedStyle(document.getElementById('fmPaneTabs')).display,
            background: cs.backgroundColor,
        };
    });
    check('§18 both phone tabs meet the 44px touch floor',
        phoneTabs.boxes.every(b => b.h >= 44), JSON.stringify(phoneTabs.boxes));
    check('§18 the phone tabs are equal width',
        Math.abs(phoneTabs.boxes[0].w - phoneTabs.boxes[1].w) <= 1,
        JSON.stringify(phoneTabs.boxes));
    eq('§18 the phone tablist is exposed', phoneTabs.listRole, 'tablist');
    check('§18 the phone tabs are shown', phoneTabs.visible !== 'none',
        JSON.stringify(phoneTabs));
    eq('§18 the visible Source tab is the selected one',
        phoneTabs.selected, ['true', 'false']);
    check('§18 the tabs are painted, not bare buttons',
        phoneTabs.background !== 'rgba(0, 0, 0, 0)', JSON.stringify(phoneTabs));

    /* Keyboard operation, asserted where the tabs are really focusable: on the
     * desktop they are display:none, so focus() there is a no-op and any
     * focus assertion would pass vacuously. */
    const keyboard = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        const left = document.querySelector('.fm-pane-tab[data-pane="left"]');
        const right = document.querySelector('.fm-pane-tab[data-pane="right"]');
        const press = (el, key) => el.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        const snap = () => ({
            active: fm.activePane,
            focused: document.activeElement?.dataset?.pane,
            selected: [left.getAttribute('aria-selected'),
                       right.getAttribute('aria-selected')],
        });
        left.focus();
        const focusable = document.activeElement === left;
        press(left, 'ArrowRight');
        const afterRight = snap();
        press(document.activeElement, 'ArrowLeft');
        const afterLeft = snap();
        press(document.activeElement, 'End');
        const afterEnd = snap();
        press(document.activeElement, 'Home');
        const afterHome = snap();
        const other = new KeyboardEvent('keydown',
            { key: 'a', bubbles: true, cancelable: true });
        left.dispatchEvent(other);
        return { focusable, afterRight, afterLeft, afterEnd, afterHome,
                 unrelatedPrevented: other.defaultPrevented };
    });
    check('§18 a tab can actually take focus', keyboard.focusable,
        JSON.stringify(keyboard));
    eq('§18 ArrowRight selects and focuses the Destination end',
        [keyboard.afterRight.active, keyboard.afterRight.focused], ['right', 'right']);
    eq('§18 ArrowRight moves aria-selected too',
        keyboard.afterRight.selected, ['false', 'true']);
    eq('§18 ArrowLeft returns to the Source end',
        [keyboard.afterLeft.active, keyboard.afterLeft.focused], ['left', 'left']);
    eq('§18 End selects the last tab',
        [keyboard.afterEnd.active, keyboard.afterEnd.focused], ['right', 'right']);
    eq('§18 Home selects the first tab',
        [keyboard.afterHome.active, keyboard.afterHome.focused], ['left', 'left']);
    check('§18 unrelated keys are not swallowed', !keyboard.unrelatedPrevented, '');

    /* Reopen reset must hold on the phone too: this is the tier where a stale
     * hidden pane is invisible to the user by construction. */
    const phoneReopen = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.panes.left.selected = new Set([0]);
        fm.panes.left.path = '/tmp/stale';
        fm.close();
        fm.open();
        return {
            leftType: fm.panes.left.type,
            leftPath: fm.panes.left.path,
            selected: fm.panes.left.selected.size,
            activePane: fm.activePane,
            queue: fm.transferQueue.length,
        };
    });
    eq('§18 the phone reopen clears the source pane',
        [phoneReopen.leftType, phoneReopen.leftPath, phoneReopen.selected],
        [null, '/', 0]);
    eq('§18 the phone reopen selects the Source end', phoneReopen.activePane, 'left');
    eq('§18 the phone reopen clears the queue', phoneReopen.queue, 0);

    /* Focus safety on the tier that has a composer: switching ends must not pull
     * focus into the terminal composer or open the keyboard. */
    const focusSafety = await page.evaluate(() => {
        const before = document.activeElement?.id || document.activeElement?.tagName;
        document.querySelector('.fm-pane-tab[data-pane="right"]').click();
        document.querySelector('.fm-pane-tab[data-pane="left"]').click();
        return {
            before,
            after: document.activeElement?.id || document.activeElement?.tagName,
            composers: document.querySelectorAll('#mobileInput').length,
            composerFocused: document.activeElement?.id === 'mobileInput',
        };
    });
    check('§18 switching ends does not focus the composer',
        !focusSafety.composerFocused, JSON.stringify(focusSafety));
    eq('§18 there is still exactly one composer', focusSafety.composers, 1);

    check('§18 no page errors on phone', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §19 all-locale name parity ==');
for (const locale of ['en', 'vi', 'de', 'fr', 'es', 'zh']) {
    const { ctx, page, pageErrors } = await shell({
        width: 1440, height: 900, touch: false, locale,
    });
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(100);
    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(200);

    /*
     * Every locale must translate all three names AND keep them distinct. An
     * untranslated locale shows English, which the EN run cannot detect; two
     * names collapsing to one string would mean the user cannot tell the global
     * server-to-server surface from the per-session file browser.
     */
    const names = await page.evaluate(() => {
        const text = sel => document.querySelector(sel)?.textContent.trim();
        // Upload/Download lives INSIDE the per-session file tooling by design, so
        // the inline panel has to be opened to observe its label.
        document.getElementById('fileTransferBtn')?.click();
        const sheet = [...document.querySelectorAll('.fm-action-sheet-item span')]
            .map(s => s.textContent.trim());
        return {
            menu: text('#fileTransferOpenBtn [data-i18n]'),
            modal: text('#fmModalTitle [data-i18n]'),
            contextual: text('#fileTransferBtn .btn-label'),
            uploadDownload: document.getElementById('fmUploadDownloadBtn')
                ?.getAttribute('title'),
            sourceTab: text('.fm-pane-tab[data-pane="left"] span'),
            destTab: text('.fm-pane-tab[data-pane="right"] span'),
            sheet,
            untranslated: [...document.querySelectorAll('[data-i18n]')]
                .filter(el => el.textContent.trim().startsWith('fm.')
                    || el.textContent.trim().startsWith('files.'))
                .map(el => el.dataset.i18n),
        };
    });
    check(`§19 ${locale}: the global menu name is present`,
        !!names.menu, JSON.stringify(names));
    check(`§19 ${locale}: the modal title matches the menu name`,
        names.modal === names.menu, JSON.stringify(names));
    check(`§19 ${locale}: the contextual name differs from the global one`,
        !!names.contextual && names.contextual !== names.menu, JSON.stringify(names));
    check(`§19 ${locale}: Upload/Download is its own third name`,
        !!names.uploadDownload && names.uploadDownload !== names.menu
        && names.uploadDownload !== names.contextual, JSON.stringify(names));
    check(`§19 ${locale}: Source and Destination tabs are distinct`,
        !!names.sourceTab && !!names.destTab && names.sourceTab !== names.destTab,
        JSON.stringify(names));
    eq(`§19 ${locale}: the action sheet has all seven rows`, names.sheet.length, 7);
    check(`§19 ${locale}: no action-sheet row is empty`,
        names.sheet.every(s => s.length > 0), JSON.stringify(names.sheet));
    eq(`§19 ${locale}: no raw translation key is rendered`, names.untranslated, []);
    if (locale !== 'en') {
        check(`§19 ${locale}: the action sheet is not left in English`,
            JSON.stringify(names.sheet) !== JSON.stringify(
                ['Open', 'Download', 'Transfer', 'Rename', 'New Folder', 'Delete', 'Cancel']),
            JSON.stringify(names.sheet));
    }
    /*
     * ACTUAL OPTION LABELS, per locale, and after a RUNTIME locale change.
     *
     * Key-parity alone would have passed the defect the review found by eye:
     * both selectors carried a valid, translated key -- the SAME key,
     * fm.selectSource -- so every locale rendered "-- Select Source --" on the
     * DESTINATION end. These assertions read the rendered <option> text, and then
     * switch language at runtime and read it again, because applyTranslations
     * re-walks the DOM and could regress one end without touching the other.
     */
    const placeholders = await page.evaluate(() => ({
        left: document.querySelector('#fmLeftSource option[value=""]')?.textContent.trim(),
        right: document.querySelector('#fmRightSource option[value=""]')?.textContent.trim(),
        leftKey: document.querySelector('#fmLeftSource option[value=""]')?.dataset.i18n,
        rightKey: document.querySelector('#fmRightSource option[value=""]')?.dataset.i18n,
        leftEmpty: document.querySelector('#fmLeftList .fm-empty-text')?.textContent.trim(),
        rightEmpty: document.querySelector('#fmRightList .fm-empty-text')?.textContent.trim(),
    }));
    eq(`§19 ${locale}: the Source selector keeps the Source key`,
        placeholders.leftKey, 'fm.selectSource');
    eq(`§19 ${locale}: the Destination selector uses the Destination key`,
        placeholders.rightKey, 'fm.selectDestination');
    check(`§19 ${locale}: the rendered placeholders are translated and distinct`,
        !!placeholders.left && !!placeholders.right
        && placeholders.left !== placeholders.right
        && !placeholders.left.startsWith('fm.')
        && !placeholders.right.startsWith('fm.'),
        JSON.stringify(placeholders));
    check(`§19 ${locale}: neither end's empty state names the wrong end`,
        placeholders.leftEmpty !== placeholders.rightEmpty,
        JSON.stringify(placeholders));
    if (locale === 'en') {
        eq(`§19 en: the Destination placeholder reads Select Destination`,
            placeholders.right, '-- Select Destination --');
    }
    if (locale === 'vi') {
        eq(`§19 vi: the Destination placeholder reads "-- Chọn đích --"`,
            placeholders.right, '-- Chọn đích --');
    }

    // Switch locale at RUNTIME and re-read: applyTranslations must keep both ends
    // correct, not just the initial render.
    const afterSwitch = await page.evaluate((from) => {
        const to = from === 'vi' ? 'en' : 'vi';
        if (window.i18n?.setLanguage) window.i18n.setLanguage(to);
        else {
            localStorage.setItem('language', to);
            window.dispatchEvent(new Event('languageChanged'));
        }
        return new Promise(resolve => setTimeout(() => resolve({
            to,
            left: document.querySelector('#fmLeftSource option[value=""]')?.textContent.trim(),
            right: document.querySelector('#fmRightSource option[value=""]')?.textContent.trim(),
        }), 300));
    }, locale);
    check(`§19 ${locale}: after switching to ${afterSwitch.to} both ends stay distinct`,
        !!afterSwitch.left && !!afterSwitch.right
        && afterSwitch.left !== afterSwitch.right,
        JSON.stringify(afterSwitch));
    check(`§19 ${locale}: after the switch the Destination still is not "Source"`,
        !/^-- Select Source --$/.test(afterSwitch.right || ''),
        JSON.stringify(afterSwitch));

    /* §19's runtime-switch probe above deliberately leaves the page in the OTHER
     * language. Put it back on this iteration's locale before asserting rendered
     * names, or §22 measures whatever §19 switched to. */
    await page.evaluate(loc => window.i18n?.setLanguage(loc), locale);
    await page.waitForFunction(loc => window.i18n?.getLanguage() === loc,
        locale, { timeout: 5000 });

    /*
     * §22 THE THIRD NAME MUST NOT BE THE FIRST NAME (review round 6).
     *
     * #fileTransferModal is the BROWSER-to-server tooling: upload a local file to
     * one session, download a remote file to the browser. It cannot express a
     * second SSH host. It rendered `files.fileTransfer`, so it announced itself
     * with the name of the global dual-end surface -- two different features, one
     * title, in all six locales. It must render files.uploadDownload, and that
     * string must differ from the global surface's name in EVERY locale.
     */
    const uploadModal = await page.evaluate(() => {
        const h = document.getElementById('fileTransferTitle');
        return {
            key: h?.dataset.i18n,
            title: h?.textContent.trim(),
            globalName: document.querySelector('#fileTransferOpenBtn [data-i18n]')
                ?.textContent.trim(),
            surfaceTitle: document.querySelector('#fmModalTitle [data-i18n]')
                ?.textContent.trim(),
        };
    });
    eq(`§22 ${locale}: the Upload/Download modal uses the uploadDownload key`,
        uploadModal.key, 'files.uploadDownload');

    /*
     * B1, DIRECTLY THROUGH THE OPENER, in every locale: press the real button,
     * read the heading the user actually sees, compare it against this locale's
     * files.uploadDownload and against the global surface's name. The §8 VI block
     * carries the same probe in Vietnamese with its literal strings; this one
     * runs on all six locales through i18n.t(), so no locale can keep the stale
     * files.fileTransfer heading behind a translated key.
     */
    const openedHeading = await page.evaluate(async () => {
        document.getElementById('fmUploadDownloadBtn').click();
        await new Promise(r => setTimeout(r, 150));
        const h = document.getElementById('fileTransferTitle');
        const out = {
            open: document.getElementById('fileTransferModal')
                ?.classList.contains('show'),
            heading: h?.textContent.trim(),
            wanted: window.i18n?.t('files.uploadDownload'),
            globalName: document.querySelector('#fileTransferOpenBtn [data-i18n]')
                ?.textContent.trim(),
        };
        document.getElementById('closeFileTransferModal')?.click();
        return out;
    });
    check(`§22 ${locale}: #fmUploadDownloadBtn really opens the modal`,
        openedHeading.open, JSON.stringify(openedHeading));
    eq(`§22 ${locale}: the opened heading reads files.uploadDownload`,
        openedHeading.heading, openedHeading.wanted);
    check(`§22 ${locale}: the opened heading is not the global transfer name`,
        openedHeading.heading !== openedHeading.globalName,
        JSON.stringify(openedHeading));

    /*
     * The mobile upload dock's caption was a HARD-CODED English literal inside
     * createModal's template, so it stayed "Tap to upload files" in every locale
     * and did not follow a runtime language switch. It must be keyed.
     */
    const tapUpload = await page.evaluate(() => {
        const el = document.querySelector('#fmMobileUpload [data-i18n]');
        // The locale's OWN translation, so the assertion compares rendered text
        // against this locale's string rather than a hard-coded literal.
        return {
            key: el?.dataset.i18n,
            text: el?.textContent.trim(),
            wanted: window.i18n?.t('fm.tapToUpload'),
            lang: window.i18n?.getLanguage(),
        };
    });
    eq(`§22 ${locale}: the mobile upload caption is keyed`,
        tapUpload.key, 'fm.tapToUpload');
    eq(`§22 ${locale}: its caption renders this locale's translation`,
        tapUpload.text, tapUpload.wanted);
    check(`§22 ${locale}: that translation is not the English literal`,
        locale === 'en' || tapUpload.wanted !== 'Tap to upload files',
        JSON.stringify(tapUpload));

    /*
     * B3's RUNTIME HALF. The initial-render
     * assertions above pass even if the caption were repainted once at load and
     * then frozen: switch the language through the product's own setter while the
     * surface stays open, and the caption must follow — same DOM node, new
     * locale's string.
     */
    const tapRuntime = await page.evaluate(() => {
        const el = document.querySelector('#fmMobileUpload [data-i18n]');
        const nodeBefore = el;
        const to = window.i18n.getLanguage() === 'en' ? 'vi' : 'en';
        window.i18n.setLanguage(to);
        return new Promise(resolve => setTimeout(() => resolve({
            to,
            sameNode: document.querySelector('#fmMobileUpload [data-i18n]') === nodeBefore,
            text: document.querySelector('#fmMobileUpload [data-i18n]')
                ?.textContent.trim(),
            wanted: window.i18n?.t('fm.tapToUpload'),
        }), 300));
    });
    check(`§22 ${locale}: the runtime switch keeps the same caption node`,
        tapRuntime.sameNode, JSON.stringify(tapRuntime));
    eq(`§22 ${locale}: the caption follows the runtime switch to ${tapRuntime.to}`,
        tapRuntime.text, tapRuntime.wanted);
    // Put the locale back the way §19's comment above requires.
    await page.evaluate(loc => window.i18n?.setLanguage(loc), locale);
    await page.waitForFunction(loc => window.i18n?.getLanguage() === loc,
        locale, { timeout: 5000 });
    check(`§22 ${locale}: its rendered title is translated and non-empty`,
        !!uploadModal.title && !uploadModal.title.startsWith('files.'),
        JSON.stringify(uploadModal));
    check(`§22 ${locale}: its title is NOT the global File Transfer name`,
        uploadModal.title !== uploadModal.globalName
        && uploadModal.title !== uploadModal.surfaceTitle,
        JSON.stringify(uploadModal));

    /*
     * Shortcut labels named "File Manager" -- a surface name that does not exist
     * in v5 -- while the keys they annotate (F2/F5/F7, Tab, Delete, Ctrl+A) are
     * handled by the global transfer surface. Every locale's label must name that
     * surface, and none may keep the retired name.
     */
    const shortcutLabels = await page.evaluate(() => {
        /*
         * setupShortcutsModal builds each row with i18n.t() into a bare <span>,
         * so there is no data-i18n to key off: the rows are matched by their
         * KEY COLUMN (F2/F5/F7/Delete/Tab/Ctrl+A), which is exactly what the user
         * sees, and the label column is read as RENDERED text.
         */
        const wanted = ['F2', 'F5', 'F7', 'Delete', 'Tab', 'Ctrl+A'];
        const rows = [...document.querySelectorAll('#shortcutsList .shortcut-row')]
            .map(row => ({
                keys: row.querySelector('strong')?.textContent.trim(),
                text: row.querySelector('span')?.textContent.trim(),
            }))
            .filter(r => wanted.includes(r.keys));
        return {
            rows,
            surfaceName: document.querySelector('#fileTransferOpenBtn [data-i18n]')
                ?.textContent.trim(),
        };
    });
    const fmRows = shortcutLabels.rows;
    eq(`§22 ${locale}: all six transfer-surface shortcut rows render`,
        fmRows.length, 6);
    check(`§22 ${locale}: no shortcut label keeps the retired File Manager name`,
        fmRows.every(r => !/File Manager|Trình quản lý tệp|Dateimanager|gestionnaire de fichiers|gestor de archivos|文件管理器/i.test(r.text)),
        JSON.stringify(fmRows));
    check(`§22 ${locale}: each shortcut label names the transfer surface`,
        !!shortcutLabels.surfaceName
        && fmRows.every(r => r.text.includes(shortcutLabels.surfaceName)),
        `surface="${shortcutLabels.surfaceName}" ${JSON.stringify(fmRows)}`);

    check(`§19 ${locale}: no page errors`, pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

console.log('== §9 phone routing ==');
{
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });

    // The phone route to the global menu is the More sheet.
    const route = await page.evaluate(() => {
        document.getElementById('fileTransferOpenBtn')?.click();
        const m = document.getElementById('sftpFileManager');
        return {
            open: m.classList.contains('show'),
            transferMode: m.classList.contains('fm-transfer-mode'),
            mobileMode: m.classList.contains('fm-mobile-mode'),
        };
    });
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(250);
    check('§9 the phone opens the same one transfer surface',
        route.open && route.transferMode, JSON.stringify(route));
    check('§9 the phone uses single-pane sizing', route.mobileMode,
        JSON.stringify(route));

    await seedPanes(page);

    /*
     * The defect this pins: before Entry 40 the phone hid #fmTransfer and pinned
     * itself to the right pane, so on the tier most likely to need it the
     * server-to-server surface could neither choose a source nor transfer.
     */
    const phoneOps = await page.evaluate(() => {
        const vis = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1
                && getComputedStyle(el).display !== 'none'
                && getComputedStyle(el).visibility !== 'hidden';
        };
        const tabs = [...document.querySelectorAll('.fm-pane-tab')];
        const transferBtn = document.getElementById('fmTransfer');
        const tabBoxes = tabs.map(t => Math.round(t.getBoundingClientRect().height));
        return {
            tabsVisible: tabs.every(vis),
            tabCount: tabs.length,
            tabHeights: tabBoxes,
            transferVisible: vis(transferBtn),
            transferHeight: Math.round(transferBtn.getBoundingClientRect().height),
        };
    });
    check('§9 the phone shows the Source/Destination switcher',
        phoneOps.tabsVisible && phoneOps.tabCount === 2, JSON.stringify(phoneOps));
    check('§9 the switcher meets the 44px touch floor',
        phoneOps.tabHeights.every(h => h >= 44), JSON.stringify(phoneOps));
    check('§9 the phone can reach the Transfer action',
        phoneOps.transferVisible && phoneOps.transferHeight >= 44,
        JSON.stringify(phoneOps));

    // Switching ends really swaps which pane is shown, on one surface.
    const swap = await page.evaluate(() => {
        const shown = () => {
            const l = document.getElementById('fmLeftPane');
            const r = document.getElementById('fmRightPane');
            const v = el => getComputedStyle(el).display !== 'none';
            return { left: v(l), right: v(r) };
        };
        window.sftpFileManager.setActivePane('left');
        const atSource = shown();
        window.sftpFileManager.setActivePane('right');
        const atDest = shown();
        return {
            atSource, atDest,
            surfaces: document.querySelectorAll('#sftpFileManager').length,
            intermediaries: document.querySelectorAll('.fm-mobile-intermediary').length,
        };
    });
    check('§9 selecting Source shows the source pane only',
        swap.atSource.left && !swap.atSource.right, JSON.stringify(swap));
    check('§9 selecting Destination shows the destination pane only',
        swap.atDest.right && !swap.atDest.left, JSON.stringify(swap));
    eq('§9 there is still exactly one surface and no intermediary screen',
        [swap.surfaces, swap.intermediaries], [1, 0]);

    // A real phone transfer, through the production emit path.
    await clearEmits(page);
    const phonePayload = await page.evaluate(async () => {
        await window.sftpFileManager.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 10 });
        return window.__emits
            .find(x => x.evt === 'transfer_server_to_server')?.payload;
    });
    eq('§9 the phone emits a real two-host transfer',
        [phonePayload?.source_session_id, phonePayload?.dest_session_id],
        ['s1', 's2']);

    const phoneSafety = await page.evaluate(() => ({
        activeIsComposer: document.activeElement?.id === 'mobileInput',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        composers: document.querySelectorAll('#mobileInput').length,
        chip: Math.round(document.getElementById('tab-s1').getBoundingClientRect().height),
        coarse: matchMedia('(pointer: coarse)').matches,
    }));
    check('§10 the phone route opens no keyboard and steals no focus',
        !phoneSafety.activeIsComposer && !phoneSafety.keyboardOpen,
        JSON.stringify(phoneSafety));
    eq('§10 the phone still has exactly one composer', phoneSafety.composers, 1);
    // Touch tier: the chip box IS the 44px touch band (the 30px figure is the
    // fine-pointer painted height, asserted in the desktop block above).
    eq('§11 the phone chip still fills the 44px touch band',
        [phoneSafety.coarse, phoneSafety.chip], [true, 44]);

    check('§9 no page errors on phone', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

await browser.close();
server.close();

console.log('\nFILE TRANSFER CONTRACT');
for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : `  (${r.detail})`}`);
}
const failed = results.filter(r => !r.ok);
console.log(`\ntotal=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length) {
    console.log('\nFAILURES');
    failed.forEach(r => console.log(`  ${r.label}${r.detail ? `: ${r.detail}` : ''}`));
    process.exitCode = 1;
}
