/*
 * Owner defect round — acceptance for defects 1, 3, 4, 5, 7, 9.
 *
 * Real browser, production template and production JS. No product code is
 * stubbed; only the Socket.IO transport is replaced by a recorder so every byte
 * the app would have sent is observable and assertable.
 *
 * The two input modes of defect 1 are both covered, including the case the owner
 * reported: CLICK THE TERMINAL, THEN TYPE.
 *   - composer visible  -> the composer owns the keyboard, typing lands in it,
 *                          streams live to the terminal, and Send runs once
 *   - composer hidden   -> xterm keeps direct native input (no composer focus,
 *                          no interception), which is what keeps desktop fast
 *
 * Run: node tests/browser/composer_ownership.mjs
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

/*
 * Socket.IO client fixture, served at the vendored path the production template
 * actually loads (templates/index.html:1565).
 *
 * It has to define io() rather than assign window.socket: app.js:15 runs
 * `window.socket = io(...)` at startup, so a socket injected by addInitScript is
 * overwritten and captures nothing. That failure is silent -- it looks exactly
 * like the app not emitting -- which is why the fixture lives at the real path.
 *
 * ssh_input is echoed back as ssh_output so the terminal renders what was
 * transmitted, closing the same loop a remote shell would.
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
        emit(evt, payload) {
            window.__emits.push({ evt, payload, t: performance.now() });
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
    window.io = () => sock;
})();
`;

const EMIT_PRELUDE = 'window.__emits = [];';

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
};

const browser = await chromium.launch();

async function shell({ width, height, touch }) {
    const ctx = await browser.newContext({
        viewport: { width, height }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(EMIT_PRELUDE);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'visual-s1', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(600);
    return { ctx, page, pageErrors };
}

const bufferText = (page, id = 's1') => page.evaluate(sid => {
    const buf = TerminalManager.terminals[sid]?.buffer?.active;
    if (!buf) return '';
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        out.push(buf.getLine(i)?.translateToString(true) || '');
    }
    return out.join('\n');
}, id);

// ── Mode A: composer VISIBLE owns the keyboard ──────────────────────────────
{
    /*
     * Mode A runs on a TOUCH shell, where the composer is natively visible and
     * live streaming is the production path.
     *
     * Two rejected alternatives, recorded so this choice is not re-litigated:
     *  - desktop + Broadcast on: Broadcast deliberately SUPPRESSES live streaming
     *    (streamTarget() returns null while BroadcastInput.open), because a
     *    broadcast draft is held and fanned out on Send. Asserting live preview
     *    there measures the documented broadcast hold, not defect 1.
     *  - desktop + forcing #sessionBar visible: its desktop visibility is gated
     *    by body.broadcast-composer, so faking it leaves the inner dock controls
     *    (#mobileSendBtn) still hidden -- the Send assertion cannot even run.
     *
     * Desktop's own contract -- hidden composer, direct native xterm input -- is
     * exactly what mode B asserts below, at 1440x900.
     */
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
    await page.waitForTimeout(350);
    const visible = await page.evaluate(() =>
        document.getElementById('sessionBar')?.offsetParent !== null);
    check('mode A: composer is visible', visible);

    const owns = await page.evaluate(() => SessionManager.composerOwnsInput());
    check('mode A: composer reports input ownership', owns);

    /*
     * THE OWNER'S CASE, exactly as reported: tap the TERMINAL, then type
     * immediately. No second composer tap is allowed -- the whole complaint was
     * that a terminal tap silently moved the keyboard away from the visible
     * composer, so requiring the user to tap the box again would be testing the
     * workaround instead of the fix.
     *
     * An intentional terminal tap MAY focus the visible composer, keyboard
     * included. The no-keyboard rule governs
     * connection-chip taps, which is why focusActivePane stays a no-op on touch;
     * defect 5's own checks below still assert a chip tap opens no keyboard.
     */
    await page.locator('#terminal-s1 .xterm-screen').tap();
    await page.waitForTimeout(250);
    const afterTerminalTap = await page.evaluate(() => document.activeElement?.id);
    check('mode A: tapping the terminal gives input to the composer',
        afterTerminalTap === 'mobileInput', `activeElement=${afterTerminalTap}`);

    // Type immediately, with no intervening tap on the composer.
    await page.keyboard.type('echo OWNED', { delay: 12 });
    await page.waitForTimeout(200);
    const afterType = await page.evaluate(() => ({
        composer: document.getElementById('mobileInput').value,
        emits: window.__emits.filter(e => e.evt === 'ssh_input').length,
    }));
    check('mode A: typed text lands in the composer',
        afterType.composer === 'echo OWNED', `value=${afterType.composer}`);
    check('mode A: typing live-streams to the session before Send',
        afterType.emits > 0, `ssh_input emits=${afterType.emits}`);

    const streamed = await bufferText(page);
    check('mode A: streamed text is visible in the terminal before Send',
        streamed.includes('echo OWNED'), '');

    // Backspace coherence: the box shrinks and a DEL is transmitted.
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    const afterBs = await page.evaluate(() => ({
        composer: document.getElementById('mobileInput').value,
        last: window.__emits.filter(e => e.evt === 'ssh_input').slice(-1)[0]?.payload?.data,
    }));
    check('mode A: backspace stays coherent in the composer',
        afterBs.composer === 'echo OWNE', `value=${afterBs.composer}`);
    check('mode A: backspace transmits a delete, not a character',
        afterBs.last === '\x7f' || afterBs.last === '\b',
        `last=${JSON.stringify(afterBs.last)}`);

    // Send executes exactly once: exactly one payload carrying a carriage return.
    const before = await page.evaluate(() =>
        window.__emits.filter(e => e.evt === 'ssh_input').length);
    await page.locator('#mobileSendBtn').click();
    await page.waitForTimeout(350);
    const sent = await page.evaluate(prev => {
        const inputs = window.__emits.filter(e => e.evt === 'ssh_input');
        const after = inputs.slice(prev);
        return {
            newPayloads: after.map(e => e.payload.data),
            crCount: after.filter(e => (e.payload.data || '').includes('\r')).length,
            composer: document.getElementById('mobileInput').value,
        };
    }, before);
    check('mode A: Send executes the command exactly once',
        sent.crCount === 1, `carriage returns=${sent.crCount} `
            + `payloads=${JSON.stringify(sent.newPayloads)}`);
    check('mode A: composer is empty after Send',
        sent.composer === '', `value=${sent.composer}`);

    check('mode A: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

// ── Mode B: composer HIDDEN leaves native xterm input direct ────────────────
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });

    const hidden = await page.evaluate(() => ({
        barHidden: document.getElementById('sessionBar')?.offsetParent === null,
        owns: SessionManager.composerOwnsInput(),
    }));
    check('mode B: composer is hidden on ordinary desktop', hidden.barHidden);
    check('mode B: composer claims no ownership while hidden', !hidden.owns);

    await page.locator('#terminal-s1 .xterm-screen').click();
    await page.waitForTimeout(200);
    const focus = await page.evaluate(() => ({
        id: document.activeElement?.id,
        insideTerminal: !!document.activeElement?.closest('#terminal-s1'),
        isComposer: document.activeElement?.id === 'mobileInput',
    }));
    check('mode B: clicking the terminal keeps focus in the terminal',
        focus.insideTerminal && !focus.isComposer, JSON.stringify(focus));

    await page.keyboard.type('whoami', { delay: 10 });
    await page.waitForTimeout(200);
    const direct = await page.evaluate(() => ({
        emitted: window.__emits.filter(e => e.evt === 'ssh_input')
            .map(e => e.payload.data).join(''),
        composer: document.getElementById('mobileInput').value,
    }));
    check('mode B: keystrokes go straight to the session',
        direct.emitted.includes('whoami'), `emitted=${direct.emitted}`);
    check('mode B: the hidden composer receives nothing',
        direct.composer === '', `value=${direct.composer}`);

    /*
     * S17 FIX 4d completion -- raw xterm onData is the MOST used write path and
     * it was bypassing the funnel.
     *
     * tmux DISCARDS every byte written to the attached client's channel while
     * the pane is in copy mode (measured on a scratch tmux 3.4 server: text +
     * CR, \x7f, \x15 and a printable byte all vanished without moving
     * copy_cursor_y), and a DESKTOP wheel scroll with tmux `mouse on` -- the
     * product default -- enters copy mode exactly as a touch swipe does. So
     * typing into the terminal after scrolling back was silently eaten. This is
     * the same funnel the composer uses, reached from session-manager.js's
     * setupInputHandler callback.
     */
    await page.evaluate(() => {
        window.__emits.length = 0;
        TerminalManager.setScrollState('s1', false);
    });
    await page.keyboard.type('a', { delay: 10 });
    await page.waitForTimeout(150);
    const unscrolled = await page.evaluate(() => {
        const w = window.__emits.filter(e => e.evt === 'ssh_input');
        return {
            count: w.length,
            anyFlag: w.some(e => Object.prototype.hasOwnProperty.call(
                e.payload || {}, 'leave_scroll')),
        };
    });
    check('mode B/S17: a raw keystroke at a normal prompt still goes out',
        unscrolled.count >= 1, `count=${unscrolled.count}`);
    check('mode B/S17: and carries no leave_scroll field',
        !unscrolled.anyFlag, '');

    await page.evaluate(() => {
        window.__emits.length = 0;
        TerminalManager.setScrollState('s1', true);
    });
    await page.keyboard.type('b', { delay: 10 });
    await page.waitForTimeout(150);
    const scrolled = await page.evaluate(() => {
        const w = window.__emits.filter(e => e.evt === 'ssh_input');
        return {
            count: w.length,
            flag: w[0]?.payload?.leave_scroll ?? null,
            data: w[0]?.payload?.data ?? null,
            stateCleared: TerminalManager.isSessionScrolled('s1') === false,
        };
    });
    check('mode B/S17: a raw keystroke on a scrolled tmux pane is still emitted',
        scrolled.count >= 1, `count=${scrolled.count}`);
    check('mode B/S17: it carries leave_scroll: true',
        scrolled.flag === true, `flag=${scrolled.flag}`);
    check('mode B/S17: the byte itself is unchanged',
        scrolled.data === 'b', `data=${JSON.stringify(scrolled.data)}`);
    check('mode B/S17: the local scroll state is reconciled after the write',
        scrolled.stateCleared, '');

    check('mode B: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

/* ── Defect 3, CORRECTED by owner ruling (Entry 40) ───────────────
 *
 * The version of this block asserted that the global menu item opens
 * #fileTransferModal, and it passed -- against the wrong product. That modal is
 * browser<->server upload/download: one session picker per direction, an
 * <input type=file>, a remote path. It has no second host, so it cannot express
 * "copy from server A to server B", which is what the owner means by File
 * Transfer. The assertions below are therefore replaced, not relaxed: each one
 * is strictly harder than what it supersedes, because it now demands the
 * DESTINATION half that the old surface did not have at all.
 *
 * Three distinct features, three distinct openers:
 *   #fileTransferOpenBtn  (global menu)   -> dual-pane server-to-server
 *   #fileTransferBtn      (session tool)  -> inline single-host SFTP panel
 *   #fmUploadDownloadBtn  (inside panel)  -> browser<->server Upload/Download
 */
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });

    const menuItem = await page.evaluate(() => {
        document.getElementById('fileTransferOpenBtn')?.click();
        const modal = document.getElementById('sftpFileManager');
        const sourceOptions = id => [...(document.getElementById(id)?.options || [])]
            .map(o => o.value);
        return {
            transferSurfaceOpen: !!modal?.classList.contains('show'),
            transferMode: !!modal?.classList.contains('fm-transfer-mode'),
            // The two INDEPENDENT connection selectors: this is the assertion the
            // old upload/download modal could never have satisfied.
            hasSourceSelect: !!document.getElementById('fmLeftSource'),
            hasDestSelect: !!document.getElementById('fmRightSource'),
            distinctSelects: document.getElementById('fmLeftSource')
                !== document.getElementById('fmRightSource'),
            // Two independent path inputs, one per end of the transfer.
            hasSourcePath: !!document.getElementById('fmLeftPath'),
            hasDestPath: !!document.getElementById('fmRightPath'),
            // Each selector offers SSH sessions, so either end can be any host.
            sourceHasSessionGroup: !!document.getElementById('fmLeftSessions'),
            destHasSessionGroup: !!document.getElementById('fmRightSessions'),
            sourceQuickConnect: sourceOptions('fmLeftSource').includes('quick-connect'),
            destQuickConnect: sourceOptions('fmRightSource').includes('quick-connect'),
            // The action that actually performs a server-to-server copy.
            hasTransferAction: !!document.getElementById('fmTransfer'),
            // And it must NOT be the browser<->server modal, nor the panel.
            uploadModalOpen: !!document.getElementById('fileTransferModal')
                ?.classList.contains('show'),
            sftpPanelOpen: !!document.getElementById('sftpPanel')
                ?.classList.contains('sftp-panel-open'),
        };
    });
    check('Entry 40: menu item opens the dual-pane transfer surface',
        menuItem.transferSurfaceOpen && menuItem.transferMode,
        JSON.stringify(menuItem));
    check('Entry 40: the surface has two INDEPENDENT connection selectors',
        menuItem.hasSourceSelect && menuItem.hasDestSelect
            && menuItem.distinctSelects, JSON.stringify(menuItem));
    check('Entry 40: the surface has an independent path per end',
        menuItem.hasSourcePath && menuItem.hasDestPath, '');
    check('Entry 40: either end can select any SSH session or a new connection',
        menuItem.sourceHasSessionGroup && menuItem.destHasSessionGroup
            && menuItem.sourceQuickConnect && menuItem.destQuickConnect,
        JSON.stringify(menuItem));
    check('Entry 40: the surface carries the server-to-server Transfer action',
        menuItem.hasTransferAction, '');
    check('Entry 40: menu item does NOT open the browser<->server modal',
        !menuItem.uploadModalOpen, '');
    check('Entry 40: menu item does NOT open the per-session SFTP panel',
        !menuItem.sftpPanelOpen, '');

    const toggled = await page.evaluate(() => {
        document.getElementById('fileTransferOpenBtn')?.click();
        return !!document.getElementById('sftpFileManager')
            ?.classList.contains('show');
    });
    check('defect 9: the File Transfer opener is a toggle', !toggled, '');

    const sessionTool = await page.evaluate(() => {
        document.getElementById('fileTransferBtn')?.click();
        return {
            sftpOpen: !!document.getElementById('sftpPanel')
                ?.classList.contains('sftp-panel-open'),
            transferSurfaceOpen: !!document.getElementById('sftpFileManager')
                ?.classList.contains('show'),
            uploadModalOpen: !!document.getElementById('fileTransferModal')
                ?.classList.contains('show'),
            // The per-session panel is single-host by definition: it must not
            // grow a destination selector.
            hasDestSelectInPanel: !!document.querySelector('#sftpPanel #fmRightSource'),
        };
    });
    check('Entry 40: the session tool opens the per-session SFTP panel',
        sessionTool.sftpOpen, JSON.stringify(sessionTool));
    check('Entry 40: the session tool does not open the transfer surface',
        !sessionTool.transferSurfaceOpen && !sessionTool.uploadModalOpen, '');
    check('Entry 40: the per-session panel has no destination selector',
        !sessionTool.hasDestSelectInPanel, '');

    // The third feature: browser<->server Upload/Download, reached from inside
    // the per-session file tooling and labelled for what it does.
    const uploadRoute = await page.evaluate(() => {
        const opener = document.getElementById('fmUploadDownloadBtn');
        const inPanel = !!document.querySelector('#sftpPanel #fmUploadDownloadBtn');
        opener?.click();
        const modal = document.getElementById('fileTransferModal');
        return {
            openerExists: !!opener,
            openerInsidePanel: inPanel,
            openerCount: document.querySelectorAll('#fmUploadDownloadBtn').length,
            modalOpen: !!modal?.classList.contains('show'),
            hasUploadForm: !!document.getElementById('uploadForm'),
            hasDownloadForm: !!document.getElementById('downloadForm'),
            hasUploadSessionSelect: !!document.getElementById('uploadSessionSelect'),
            title: document.getElementById('fileTransferTitle')?.textContent.trim(),
        };
    });
    check('Entry 40: Upload/Download opener lives inside the per-session tooling',
        uploadRoute.openerExists && uploadRoute.openerInsidePanel
            && uploadRoute.openerCount === 1, JSON.stringify(uploadRoute));
    check('Entry 40: it opens the browser<->server modal with both forms',
        uploadRoute.modalOpen && uploadRoute.hasUploadForm
            && uploadRoute.hasDownloadForm && uploadRoute.hasUploadSessionSelect,
        JSON.stringify(uploadRoute));

    // No duplication: exactly one node per opener, and the global menu hosts
    // exactly ONE file-transfer entry.
    const uniqueness = await page.evaluate(() => ({
        globalOpeners: document.querySelectorAll('#fileTransferOpenBtn').length,
        sessionOpeners: document.querySelectorAll('#fileTransferBtn').length,
        uploadOpeners: document.querySelectorAll('#fmUploadDownloadBtn').length,
        transferSurfaces: document.querySelectorAll('#sftpFileManager').length,
        uploadModals: document.querySelectorAll('#fileTransferModal').length,
        sftpPanels: document.querySelectorAll('#sftpPanel').length,
        /*
         * The global menu must host exactly ONE file-transfer entry. Scoped to
         * the real dropdown container id (#accountDropdownHeader); an earlier
         * draft used a container that does not exist, which silently counted 0
         * and would have passed even if the menu had grown a duplicate.
         */
        menuFileEntries: [...document.querySelectorAll(
            '#accountDropdownHeader .account-action')]
            .filter(b => /^files\./
                .test(b.querySelector('[data-i18n]')?.dataset.i18n || '')).length,
        menuTransferEntries: [...document.querySelectorAll(
            '#accountDropdownHeader .account-action')]
            .filter(b => (b.querySelector('[data-i18n]')?.dataset.i18n || '')
                === 'files.fileTransfer').length,
        // The browser<->server route must NOT appear in the global menu at all.
        menuUploadEntries: [...document.querySelectorAll(
            '#accountDropdownHeader .account-action')]
            .filter(b => (b.querySelector('[data-i18n]')?.dataset.i18n || '')
                === 'files.uploadDownload').length,
    }));
    check('Entry 40: no duplicated openers, surfaces or menu entries',
        uniqueness.globalOpeners === 1 && uniqueness.sessionOpeners === 1
            && uniqueness.uploadOpeners === 1 && uniqueness.transferSurfaces === 1
            && uniqueness.uploadModals === 1 && uniqueness.sftpPanels === 1
            && uniqueness.menuFileEntries === 1, JSON.stringify(uniqueness));
    check('Entry 40: the one menu entry is File Transfer, and Upload/Download '
        + 'is not a second global item',
        uniqueness.menuTransferEntries === 1 && uniqueness.menuUploadEntries === 0,
        JSON.stringify(uniqueness));

    check('Entry 40: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

// ── Defect 5: one gesture selects a disconnected chip AND opens its menu ────
{
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
    await page.evaluate(() => {
        SessionManager.createSession({
            session_id: 's3', host: 'staging', port: 22, username: 'deploy',
            auth_type: 'key', key_id: 'k1', display_name: 'staging',
            use_tmux: false, tmux_session_name: null, via_jump: null,
        });
        SessionManager.updateSessionStatus('s3', 'disconnected');
    });
    await page.waitForTimeout(300);

    const activeBefore = await page.evaluate(() => SessionManager.getActiveSession());
    // Start from a genuinely closed sheet so "the same tap opened it" cannot be
    // satisfied by a sheet that was already open, and is not defeated by one that
    // an earlier interaction in this context left open.
    await page.evaluate(() => SessionManager.closeLifecycleSheet());
    await page.waitForTimeout(150);
    const sheetBefore = await page.evaluate(() =>
        document.getElementById('sessionActionsSheet')?.hidden !== false);
    check('defect 5: the action sheet starts closed', sheetBefore, '');
    await page.locator('#tab-s3').tap();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        sheetOpen: document.getElementById('sessionActionsSheet')?.hidden === false,
        active: SessionManager.getActiveSession(),
        connected: SessionManager.getSession('s3')?.connected,
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        focusIsInput: document.activeElement?.id === 'mobileInput',
        actions: document.querySelectorAll(
            '#sessionActionsSheet [data-lifecycle-action]').length,
    }));
    check('defect 5: one tap selects the disconnected chip',
        after.target === 's3', `target=${after.target}`);
    check('defect 5: the SAME tap opens its action menu',
        after.sheetOpen, `sheetOpen=${after.sheetOpen}`);
    // Six since: rename / reconnect / reset / close are the original
    // four, joined by `assign` (put this session in a specific split pane) and
    // `orphans` (sweep tmux sessions no row owns any more). The count is pinned
    // so an action cannot disappear unnoticed, not to cap the menu.
    check('defect 5: six lifecycle actions are offered',
        after.actions === 6, `actions=${after.actions}`);
    check('defect 5: the active terminal session is unchanged',
        after.active === activeBefore, `${activeBefore} -> ${after.active}`);
    check('defect 5: it does not auto-connect',
        after.connected === false, `connected=${after.connected}`);
    check('defect 5: it does not open the keyboard', !after.keyboardOpen, '');
    check('defect 5: it does not focus a text input', !after.focusIsInput, '');

    check('defect 5: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

// ── Defect 7: no heavy reconnect overview; saved connections survive ────────
{
    const { ctx, page, pageErrors } = await shell({ width: 1440, height: 900, touch: false });
    const overview = await page.evaluate(() => {
        // A restored persistent candidate is exactly the state that used to
        // render the overview screen.
        SessionManager.sessions.s9 = {
            id: 's9', host: 'restored', port: 22, username: 'root',
            connected: false, isPersistentCandidate: true,
            tmuxSessionName: 'sshdeck_restored', useTmux: true,
            terminalId: 'terminal-s9', authType: 'key', keyId: 'k1',
        };
        SessionManager.renderReconnectList();
        return {
            list: document.querySelectorAll('[data-reconnect-list]').length,
            rows: document.querySelectorAll('[data-reconnect-row]').length,
            candidateKept: !!SessionManager.sessions.s9,
            reconnectable: SessionManager.sessions.s9?.isPersistentCandidate === true,
        };
    });
    check('defect 7: the reconnect overview screen is gone',
        overview.list === 0 && overview.rows === 0, JSON.stringify(overview));
    check('defect 7: the saved connection itself is NOT deleted',
        overview.candidateKept && overview.reconnectable, '');

    check('defect 7: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

// ── Defect 9: Notes is the sole Notes control; one button opens and closes ──
{
    const { ctx, page, pageErrors } = await shell({ width: 390, height: 844, touch: true });
    // W6: genuine Playwright clicks only — no evaluate().click, no force.
    // 1. Open via #notepadOpenBtn.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(50);
    check('defect 9: the toolbar Notes button opens Notes',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('mobile-open')));

    // 2. Toggle close via the same button.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(60);
    const toggleClosed = await page.evaluate(() => ({
        mobileOpen: document.getElementById('notepadPanel').classList.contains('mobile-open'),
        aria: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
        focus: document.activeElement?.id,
    }));
    check('defect 9: pressing Notes again closes it (W6 toggle)',
        !toggleClosed.mobileOpen);
    check('defect 9: toggle close sets aria-expanded false',
        toggleClosed.aria === 'false');
    check('defect 9: toggle close returns focus to the opener',
        toggleClosed.focus === 'notepadOpenBtn');

    // 3. Re-open, then close via X.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(50);
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(60);
    check('defect 9: Notes closes through its own close control',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('mobile-open')));

    // 4. The withdrawn in-terminal chevron is absent from the template.
    check('defect 9: the redundant in-terminal Notes toggle is absent',
        await page.evaluate(() =>
            document.querySelectorAll('#notepadToggle').length === 0));

    check('defect 9: no page errors', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));
    await ctx.close();
}

// ── Defect 4: chip density, measured ───────────────────────────────────────
for (const [name, width, height, touch] of [
    ['desktop1440', 1440, 900, false],
    ['ipad834', 834, 1194, true],
    ['phone390', 390, 844, true],
]) {
    const { ctx, page } = await shell({ width, height, touch });
    const m = await page.evaluate(() => {
        const chip = document.getElementById('tab-s1');
        const strong = chip.querySelector('strong');
        const small = chip.querySelector('small');
        const cr = chip.getBoundingClientRect();
        const before = getComputedStyle(chip, '::before');
        const pillH = parseFloat(before.height) || cr.height;
        const pillTop = cr.top + (cr.height - pillH) / 2;
        const sr = strong.getBoundingClientRect();
        const smr = small.getBoundingClientRect();
        return {
            labelH: Math.round((smr.bottom - sr.top) * 10) / 10,
            airTop: Math.round((sr.top - pillTop) * 10) / 10,
            airBottom: Math.round((pillTop + pillH - smr.bottom) * 10) / 10,
            nameClipped: strong.scrollWidth > strong.clientWidth + 1,
            wrapped: getComputedStyle(strong).whiteSpace !== 'nowrap',
        };
    });
    // >= 3px of real air on each side of the label: the rejected state had 1px.
    check(`defect 4 (${name}): label has real air above`, m.airTop >= 3,
        `airTop=${m.airTop}`);
    check(`defect 4 (${name}): label has real air below`, m.airBottom >= 3,
        `airBottom=${m.airBottom}`);
    check(`defect 4 (${name}): label fits inside the pill`, m.labelH <= 24,
        `labelH=${m.labelH}`);
    check(`defect 4 (${name}): the connection name is not clipped`,
        !m.nameClipped, '');
    check(`defect 4 (${name}): the chip does not wrap`, !m.wrapped, '');
    await ctx.close();
}

await browser.close();
server.close();

console.log('\nCOMPOSER OWNERSHIP / OWNER DEFECT ACCEPTANCE');
for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`
        + `${r.ok || !r.detail ? '' : ` (${r.detail})`}`);
}
const failed = results.filter(r => !r.ok);
console.log(`\ntotal=${results.length} passed=${results.length - failed.length} `
    + `failed=${failed.length}`);
if (failed.length) {
    console.log('\nFAILURES');
    failed.forEach(f => console.log(`  ${f.label}${f.detail ? `: ${f.detail}` : ''}`));
    process.exitCode = 1;
}
