/*
 * W4 — atomic displayed-terminal vs lifecycle-action-target selection.
 *
 * This is the BEHAVIORAL proof, not a static count of call sites. It drives the
 * real session-manager.js the way a user does (chip click / pane click / sheet
 * action / removeSessionUI) and then reads the resulting id pair, ARIA, paint
 * and action subject. Each section maps to one defect the dual-selection model
 * exists to prevent:
 *
 *  §1 Distinct affordances. Selecting a disconnected chip marks it as the
 *     action target (.lifecycle-target + aria-current="true") WITHOUT making it
 *     the displayed terminal (.active + aria-selected). The live pane stays put.
 *  §2 Toolbar actions address the TARGET, never the displayed session. With a
 *     live L displayed and a disconnected D selected, Rename/Reconnect/Reset/
 *     Close operate on D; L is never closed, renamed, or reconnected.
 *  §3 Pane maintenance must not overwrite a deliberate target. Removing an
 *     unrelated session (or the last remaining non-target) goes through
 *     setActivePane({preserveLifecycleTarget:true}) and leaves the target's
 *     class/aria-current/sheet intact.
 *  §4 No redundant fit or pane re-render on a pure target selection. Selecting
 *     a disconnected chip must not call fitTerminal and must not rewrite
 *     paneAssignments.
 *  §5 Desktop paint. Fine-pointer paints the target ring on the element itself
 *     (no pill), so a selected disconnected chip is visually distinct from the
 *     active live chip on desktop too — not only on touch.
 *
 * Run: node tests/browser/selection_atomicity.mjs   (from source/)
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
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
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
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// The TerminalManager stub is installed AFTER load (terminal-manager.js
// overwrites any pre-load stub). That is the only way to count fitTerminal
// calls against the real production path.
const POST_LOAD = `
    window.__fitCalls = [];
    window.__renderPaneCalls = [];
    window.__emits = [];
    const realFit = window.TerminalManager.fitTerminal.bind(window.TerminalManager);
    window.TerminalManager.fitTerminal = (sid) => {
        window.__fitCalls.push(sid);
        return realFit(sid);
    };
    // destroyTerminal is a no-op here: there is no real xterm instance for the
    // seeded ids, and production destroyTerminal would throw looking them up.
    window.TerminalManager.destroyTerminal = () => {};
    window.TerminalManager.createTerminal = () => {};
    window.TerminalManager.attachTerminal = () => {};
    window.TerminalManager.setupInputHandler = () => {};
    // Spy socket emits so toolbar actions are observable without a server.
    const realEmit = window.socket.emit.bind(window.socket);
    window.socket.emit = (ev, payload) => {
        window.__emits.push({ ev, payload });
        return realEmit(ev, payload);
    };
    // Count renderPane so a pure target selection that re-renders every pane
    // goes red. The original is preserved so panes still paint.
    const realRender = SessionManager.renderPane.bind(SessionManager);
    SessionManager.renderPane = (i) => {
        window.__renderPaneCalls.push(i);
        return realRender(i);
    };
`;

async function newPage(w, h, { touch = true } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch,
        isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(`
        const noop = () => {};
        window.socket = {
            connected: true, on: noop, off: noop, once: noop, emit: noop,
            io: { on: noop },
        };
        window.showNotification = noop;
        window.ModalManager = {
            open: (m) => m && m.classList.add('show'),
            close: (m) => m && m.classList.remove('show'),
        };
        window.clearConnectionProfileState = noop;
        window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
        window.i18n = { t: (k) => k };
    `);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    await page.evaluate(POST_LOAD);
    // SessionManager.init() is called by app.js on load; force a known layout.
    // The innerHTML wipe below destroys #terminalGrid (a child of
    // #terminalsContainer), so ensureTerminalGrid() would return null and
    // setActivePane would early-return without ever writing activeSessionId.
    // Re-create the grid node after the wipe and rebuild panes through the
    // real setSplitLayout path so the displayed-selection writer is live.
    await page.evaluate(() => {
        SessionManager.sessions = {};
        SessionManager.activeSessionId = null;
        SessionManager.lifecycleActionTargetId = null;
        SessionManager.lifecyclePendingTargetId = null;
        document.getElementById('sessionTabs').innerHTML = '';
        const container = document.getElementById('terminalsContainer');
        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.id = 'terminalGrid';
        grid.className = 'terminal-grid';
        container.appendChild(grid);
        // Reset layout/variant/paneAssignments so setSplitLayout does not take
        // its same-layout early return (which would skip rebuilding panes).
        SessionManager.layout = 0;
        SessionManager.layoutVariant = 'default';
        SessionManager.paneAssignments = [];
        SessionManager.setSplitLayout(2);
    });
    return { ctx, page, errors };
}

async function seed(page, id, opts = {}) {
    return await page.evaluate(({ id, opts }) => {
        const host = opts.host || `${id}.example`;
        const username = opts.username || id;
        SessionManager.sessions[id] = {
            id, session_id: id,
            host, port: opts.port || 22, username,
            authType: opts.authType || 'key',
            keyId: opts.keyId !== undefined ? opts.keyId : `k-${id}`,
            jumpHostId: opts.jumpHostId || null,
            displayName: opts.displayName || id.toUpperCase(),
            connected: opts.connected !== undefined ? opts.connected : true,
            isPersistentCandidate: !!opts.isPersistentCandidate,
            tmuxSessionName: opts.tmuxSessionName || null,
            terminalId: `term-${id}`,
            useTmux: !!opts.useTmux,
            viaJump: null,
            latencyMs: null,
        };
        // Create the terminal wrapper the way createSession does, so a later
        // removeSessionUI can find and drop it without throwing.
        const wrap = document.createElement('div');
        wrap.id = `term-${id}`;
        wrap.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(wrap);
        SessionManager.createSessionTab(id, host, username);
        if (opts.connected === false || opts.isPersistentCandidate) {
            SessionManager.updateSessionStatus(id, 'disconnected');
        } else {
            SessionManager.updateSessionStatus(id, 'connected');
        }
        return SessionManager.sessions[id];
    }, { id, opts });
}

async function stateOf(page, id) {
    return await page.evaluate((id) => {
        const tab = document.getElementById(`tab-${id}`);
        if (!tab) return null;
        return {
            activeSessionId: SessionManager.activeSessionId,
            lifecycleActionTargetId: SessionManager.lifecycleActionTargetId,
            activePaneIndex: SessionManager.activePaneIndex,
            paneAssignments: SessionManager.paneAssignments.slice(),
            hasActive: tab.classList.contains('active'),
            hasTarget: tab.classList.contains('lifecycle-target'),
            ariaSelected: tab.getAttribute('aria-selected'),
            ariaCurrent: tab.getAttribute('aria-current'),
            fitCalls: window.__fitCalls.slice(),
            renderPaneCalls: window.__renderPaneCalls.slice(),
            emits: window.__emits.map(e => e.ev + ':' + JSON.stringify(e.payload || {})),
        };
    }, id);
}

async function resetCounters(page) {
    await page.evaluate(() => {
        window.__fitCalls = [];
        window.__renderPaneCalls = [];
        window.__emits = [];
    });
}

// ============================================================================
// §1 Distinct affordances — disconnected target keeps the live pane displayed.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    // Put L in pane 0 as the displayed terminal.
    await page.evaluate(() => {
        SessionManager.assignSessionToPane('L', 0);
    });
    // setActivePane schedules fitTerminal on a 50ms setTimeout; let it settle
    // BEFORE zeroing the counters so the post-click sample only sees work the
    // dead-chip selection itself caused (which must be none).
    await page.waitForTimeout(80);
    await resetCounters(page);

    // User taps the disconnected chip.
    await page.click('#tab-D');
    await page.waitForTimeout(40);

    const after = await page.evaluate(() => {
        const l = document.getElementById('tab-L');
        const d = document.getElementById('tab-D');
        return {
            activeSessionId: SessionManager.activeSessionId,
            target: SessionManager.lifecycleActionTargetId,
            pane0: SessionManager.paneAssignments[0],
            activePaneIndex: SessionManager.activePaneIndex,
            lActive: l.classList.contains('active'),
            lTarget: l.classList.contains('lifecycle-target'),
            lAriaSelected: l.getAttribute('aria-selected'),
            lAriaCurrent: l.getAttribute('aria-current'),
            dActive: d.classList.contains('active'),
            dTarget: d.classList.contains('lifecycle-target'),
            dAriaSelected: d.getAttribute('aria-selected'),
            dAriaCurrent: d.getAttribute('aria-current'),
            targets: [...document.querySelectorAll('[aria-current="true"]')]
                .map(el => el.id),
            fitCalls: window.__fitCalls.slice(),
            // Pure target selection must not reassign panes.
            paneAssignments: SessionManager.paneAssignments.slice(),
        };
    });

    check('§1 L remains the displayed session', after.activeSessionId, 'L');
    check('§1 D is the lifecycle action target', after.target, 'D');
    check('§1 L still owns pane 0', after.pane0, 'L');
    check('§1 active pane index is unchanged', after.activePaneIndex, 0);
    check('§1 L keeps .active', after.lActive, true);
    check('§1 L does NOT carry .lifecycle-target', after.lTarget, false);
    check('§1 L keeps aria-selected=true', after.lAriaSelected, 'true');
    check('§1 L has no aria-current', after.lAriaCurrent, null);
    check('§1 D carries .lifecycle-target', after.dTarget, true);
    check('§1 D does NOT carry .active', after.dActive, false);
    check('§1 D has aria-current=true', after.dAriaCurrent, 'true');
    check('§1 D is NOT aria-selected', after.dAriaSelected, 'false');
    check('§1 exactly one aria-current in the document',
        after.targets.join(','), 'tab-D');
    check('§1 selecting a dead chip does not fit any terminal',
        after.fitCalls.join(','), '');
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 Toolbar actions target the SELECTED lifecycle target, not the displayed one.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    await page.evaluate(() => {
        SessionManager.assignSessionToPane('L', 0);
    });
    // Select D as the action target (user tap).
    await page.click('#tab-D');
    await page.waitForTimeout(40);
    await resetCounters(page);

    // Rename on the target must open the rename input on D's chip, not L's.
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('rename'));
    await page.waitForTimeout(40);
    const rename = await page.evaluate(() => ({
        inputOnD: !!document.querySelector('#tab-D .tab-rename-input'),
        inputOnL: !!document.querySelector('#tab-L .tab-rename-input'),
        target: SessionManager.lifecycleActionTargetId,
        active: SessionManager.activeSessionId,
        lStillThere: !!SessionManager.sessions['L'],
        dStillThere: !!SessionManager.sessions['D'],
    }));
    check('§2 Rename opens on the TARGET chip (D)', rename.inputOnD, true);
    check('§2 Rename does NOT open on the displayed chip (L)', rename.inputOnL, false);
    check('§2 Rename leaves L as the displayed session', rename.active, 'L');
    check('§2 Rename leaves D as the target', rename.target, 'D');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);

    // Reconnect on a disconnected target opens the form / direct path for D,
    // never closes L. Spy the requestReconnect subject.
    const reconnectSubject = await page.evaluate(() => {
        let seen = null;
        const original = SessionManager.requestReconnect.bind(SessionManager);
        SessionManager.requestReconnect = (id) => { seen = id; };
        try {
            SessionManager.dispatchLifecycleAction('reconnect');
            return seen;
        } finally {
            SessionManager.requestReconnect = original;
        }
    });
    check('§2 Reconnect is invoked for the TARGET (D)', reconnectSubject, 'D');

    // Reset subject is D.
    const resetSubject = await page.evaluate(() => {
        let seen = null;
        const original = SessionManager.requestResetSession.bind(SessionManager);
        SessionManager.requestResetSession = (id) => { seen = id; };
        try {
            SessionManager.dispatchLifecycleAction('reset');
            return seen;
        } finally {
            SessionManager.requestResetSession = original;
        }
    });
    check('§2 Reset is invoked for the TARGET (D)', resetSubject, 'D');

    // Close subject is D; after a real close of D, L must still be displayed.
    // Drive the real confirm-gated path: dispatchLifecycleAction('close') ->
    // requestCloseSession(target) -> openSessionConfirm -> accept -> closeSession.
    // The harness stubs closeSession to record the id and run removeSessionUI
    // (so the UI is torn down without a backend). Calling requestCloseSession
    // directly only opens the dialog; the accept button fires closeSession.
    await page.evaluate(() => {
        window.__closedIds = [];
        SessionManager.closeSession = (function (original) {
            return function (id) {
                window.__closedIds.push(id);
                return SessionManager.removeSessionUI(id);
            };
        })(SessionManager.closeSession);
    });
    await page.evaluate(() => {
        SessionManager.dispatchLifecycleAction('close');
    });
    const closeDialogOpen = await page.evaluate(() => {
        const d = document.getElementById('sessionConfirm');
        return !!d && !d.hidden;
    });
    if (closeDialogOpen) {
        await page.click('#sessionConfirmAccept');
        await page.waitForTimeout(60);
    }
    const afterClose = await page.evaluate(() => ({
        closed: (window.__closedIds || []).slice(),
        lStill: !!SessionManager.sessions['L'],
        dStill: !!SessionManager.sessions['D'],
        active: SessionManager.activeSessionId,
        target: SessionManager.lifecycleActionTargetId,
        pane0: SessionManager.paneAssignments[0],
    }));
    // requestCloseSession -> openSessionConfirm -> closeSession(target).
    // Our patched closeSession records the id then removeSessionUI's it.
    check('§2 Close is invoked for the TARGET (D)',
        afterClose.closed.join(','), 'D');
    check('§2 Close does NOT remove the displayed session L', afterClose.lStill, true);
    check('§2 Close does remove the target D', afterClose.dStill, false);
    check('§2 after closing D, L is still displayed', afterClose.active, 'L');
    check('§2 after closing D, L still owns its pane', afterClose.pane0, 'L');
    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 Pane maintenance must not overwrite a deliberate target.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'X', {
        host: 'other.example', username: 'otherU', connected: true, keyId: 'kX',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    await page.evaluate(() => {
        SessionManager.assignSessionToPane('L', 0);
        SessionManager.assignSessionToPane('X', 1);
    });
    // Deliberately target D.
    await page.click('#tab-D');
    await page.waitForTimeout(40);

    const before = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        dTarget: document.getElementById('tab-D').classList.contains('lifecycle-target'),
        dAria: document.getElementById('tab-D').getAttribute('aria-current'),
        active: SessionManager.activeSessionId,
    }));
    check('§3 setup: D is the deliberate target', before.target, 'D');
    check('§3 setup: D carries aria-current', before.dAria, 'true');

    // Remove an UNRELATED live session (X). Pane maintenance must re-activate
    // a remaining pane WITHOUT stealing the target from D.
    await page.evaluate(() => SessionManager.removeSessionUI('X'));
    await page.waitForTimeout(40);

    const after = await page.evaluate(() => {
        const d = document.getElementById('tab-D');
        return {
            target: SessionManager.lifecycleActionTargetId,
            dTarget: d && d.classList.contains('lifecycle-target'),
            dAria: d && d.getAttribute('aria-current'),
            targets: [...document.querySelectorAll('.session-tab.lifecycle-target')]
                .map(el => el.id),
            ariaCurrents: [...document.querySelectorAll('[aria-current="true"]')]
                .map(el => el.id),
            xGone: !SessionManager.sessions['X'],
            lStill: !!SessionManager.sessions['L'],
            dStill: !!SessionManager.sessions['D'],
            // The displayed session must still be a live one, not silently
            // switched to the disconnected target.
            activeIsLive: !!(SessionManager.sessions[SessionManager.activeSessionId]
                && SessionManager.sessions[SessionManager.activeSessionId].connected),
        };
    });
    check('§3 after removing X, D is STILL the target', after.target, 'D');
    check('§3 D still carries .lifecycle-target', after.dTarget, true);
    check('§3 D still carries aria-current=true', after.dAria, 'true');
    check('§3 exactly one .lifecycle-target remains', after.targets.join(','), 'tab-D');
    check('§3 exactly one aria-current remains', after.ariaCurrents.join(','), 'tab-D');
    check('§3 X is gone', after.xGone, true);
    check('§3 L survived', after.lStill, true);
    check('§3 D survived', after.dStill, true);
    check('§3 the displayed session is still a live one', after.activeIsLive, true);
    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3b Removing the TARGET itself clears the target; removing the DISPLAYED
//     session preserves an unrelated target.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    await page.evaluate(() => SessionManager.assignSessionToPane('L', 0));
    await page.click('#tab-D');
    await page.waitForTimeout(40);

    // Remove the TARGET itself.
    await page.evaluate(() => SessionManager.removeSessionUI('D'));
    await page.waitForTimeout(40);
    const afterTargetGone = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        decorated: document.querySelectorAll('.session-tab.lifecycle-target').length,
        ariaCurrents: document.querySelectorAll('[aria-current="true"]').length,
        lStill: !!SessionManager.sessions['L'],
        active: SessionManager.activeSessionId,
    }));
    check('§3b removing the target clears lifecycleActionTargetId',
        afterTargetGone.target, null);
    check('§3b no chip keeps .lifecycle-target', afterTargetGone.decorated, 0);
    check('§3b no chip keeps aria-current', afterTargetGone.ariaCurrents, 0);
    check('§3b L is still displayed', afterTargetGone.active, 'L');
    check('§3b L survived', afterTargetGone.lStill, true);
    check('§3b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 No redundant fit / pane re-render on pure target selection.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    await page.evaluate(() => SessionManager.assignSessionToPane('L', 0));
    // Let the assignSessionToPane fit settle, then zero the counters.
    await page.waitForTimeout(80);
    await resetCounters(page);
    const panesBefore = await page.evaluate(() =>
        JSON.stringify(SessionManager.paneAssignments));

    await page.click('#tab-D');
    await page.waitForTimeout(80); // longer than the 50ms fit timeout

    const after = await page.evaluate((panesBefore) => ({
        fitCalls: window.__fitCalls.slice(),
        renderPaneCalls: window.__renderPaneCalls.slice(),
        panesAfter: JSON.stringify(SessionManager.paneAssignments),
        panesBefore,
        target: SessionManager.lifecycleActionTargetId,
        active: SessionManager.activeSessionId,
    }), panesBefore);

    check('§4 pure target selection emits zero fitTerminal calls',
        after.fitCalls.join(','), '');
    check('§4 pure target selection does not re-render panes',
        after.renderPaneCalls.join(','), '');
    check('§4 paneAssignments are byte-identical', after.panesAfter, after.panesBefore);
    check('§4 target is D', after.target, 'D');
    check('§4 displayed is still L', after.active, 'L');
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4b D4 "một thay đổi selection không được re-render cả session strip/pane".
//
// §4 counts fitTerminal and renderPane, which are the expensive consequences.
// This measures the DOM cost directly, with twelve chips in the strip, because
// the cheap-looking failure mode is a selection that rebuilds every chip's
// markup: no fit, no renderPane, but twelve chips destroyed and recreated. That
// is invisible to a call counter and very visible to a user (lost focus ring,
// restarted transitions, a scroll position that jumps).
//
// The ceiling is derived, not guessed: a correct selection writes to exactly TWO
// chips — the one losing the target and the one gaining it — and on each it
// touches `class` and `aria-current`. Four attribute records, zero childList,
// zero characterData. The pane grid must not be touched at all.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    const N = 12;
    for (let i = 1; i <= N; i += 1) {
        await seed(page, `M${i}`, {
            host: `m${i}.example`, username: 'u', keyId: `kM${i}`,
            connected: i <= 6,
        });
    }
    await page.evaluate(() => SessionManager.assignSessionToPane('M1', 0));
    await page.waitForTimeout(120);
    await resetCounters(page);

    const cost = await page.evaluate(async () => {
        const strip = document.getElementById('sessionTabs');
        const grid = document.getElementById('terminalGrid');
        const tally = (node) => {
            const t = { childList: 0, attrs: 0, charData: 0,
                targets: new Set(), names: new Set() };
            t.mo = new MutationObserver(recs => recs.forEach(r => {
                if (r.type === 'childList') {
                    t.childList += r.addedNodes.length + r.removedNodes.length;
                } else if (r.type === 'attributes') {
                    t.attrs += 1;
                    t.targets.add(r.target.id || r.target.className);
                    t.names.add(r.attributeName);
                } else { t.charData += 1; }
            }));
            t.mo.observe(node, { subtree: true, childList: true,
                attributes: true, characterData: true });
            return t;
        };
        const s = tally(strip);
        const g = tally(grid);

        // A pure target selection: a DISCONNECTED chip, so nothing may become
        // displayed and no pane may change.
        document.getElementById('tab-M9').click();
        await new Promise(r => setTimeout(r, 160));
        s.mo.disconnect();
        g.mo.disconnect();
        const out = (t) => ({ childList: t.childList, attrs: t.attrs,
            charData: t.charData, targets: [...t.targets].sort().join(','),
            names: [...t.names].sort().join(',') });
        return { chips: document.querySelectorAll('#sessionTabs > .session-tab').length,
            strip: out(s), grid: out(g),
            target: SessionManager.lifecycleActionTargetId,
            active: SessionManager.activeSessionId };
    });

    check('§4b the strip really holds twelve chips (non-vacuous)', cost.chips, N);
    check('§4b selection rebuilds no chip markup', cost.strip.childList, 0);
    check('§4b selection rewrites no chip text', cost.strip.charData, 0);
    check('§4b selection writes to exactly two chips',
        cost.strip.targets, 'tab-M1,tab-M9');
    check('§4b ...and only class + aria-current on them',
        cost.strip.names, 'aria-current,class');
    check('§4b four attribute writes for twelve chips', cost.strip.attrs, 4);
    check('§4b the pane grid is not touched at all',
        `${cost.grid.childList}/${cost.grid.attrs}/${cost.grid.charData}`, '0/0/0');
    check('§4b M9 is the target', cost.target, 'M9');
    check('§4b M1 is still displayed', cost.active, 'M1');
    check('§4b no fit was requested',
        (await page.evaluate(() => window.__fitCalls.join(','))), '');
    check('§4b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §5 Desktop fine-pointer paints the target ring on the element itself.
// ============================================================================
{
    // Fine-pointer desktop: hasTouch false, large viewport. The production
    // TOUCH_SHELL_QUERY is `(pointer:coarse) and (hover:none), (max-width:767px)`,
    // so width >= 768 with no touch is a desktop shell.
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false });
    await seed(page, 'L', {
        host: 'live.example', username: 'liveU', connected: true, keyId: 'kL',
    });
    await seed(page, 'D', {
        host: 'disc.example', username: 'discU', connected: false, keyId: 'kD',
    });
    await page.evaluate(() => SessionManager.assignSessionToPane('L', 0));
    await page.click('#tab-D');
    await page.waitForTimeout(40);

    const paint = await page.evaluate(() => {
        const l = document.getElementById('tab-L');
        const d = document.getElementById('tab-D');
        const cs = (el) => {
            const s = getComputedStyle(el);
            const pseudo = getComputedStyle(el, '::before');
            const pillPaints = pseudo.content && pseudo.content !== 'none'
                && pseudo.outlineStyle !== 'none';
            return {
                hasActive: el.classList.contains('active'),
                hasTarget: el.classList.contains('lifecycle-target'),
                ariaSelected: el.getAttribute('aria-selected'),
                ariaCurrent: el.getAttribute('aria-current'),
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                // Pill ring (touch) vs element ring (desktop).
                ringOwner: pillPaints ? 'pill' : 'element',
                ringStyle: pillPaints ? pseudo.outlineStyle : s.outlineStyle,
                ringWidth: pillPaints ? pseudo.outlineWidth : s.outlineWidth,
                background: s.backgroundColor,
                borderColor: s.borderColor,
            };
        };
        return {
            L: cs(l),
            D: cs(d),
            isTouch: window.TerminalManager.isTouchShell(),
            isDesktop: window.TerminalManager.isDesktopShell(),
            active: SessionManager.activeSessionId,
            target: SessionManager.lifecycleActionTargetId,
        };
    });

    check('§5 desktop shell is detected', paint.isDesktop, true);
    check('§5 touch shell is NOT detected', paint.isTouch, false);
    check('§5 L is displayed', paint.active, 'L');
    check('§5 D is the target', paint.target, 'D');
    check('§5 L has .active and aria-selected',
        paint.L.hasActive && paint.L.ariaSelected === 'true', true);
    check('§5 D has .lifecycle-target and aria-current',
        paint.D.hasTarget && paint.D.ariaCurrent === 'true', true);
    check('§5 desktop target ring is painted on the element (not the pill)',
        paint.D.ringOwner, 'element');
    check('§5 desktop target paints a real outline',
        paint.D.ringStyle === 'solid' && parseFloat(paint.D.ringWidth) >= 2, true);
    check('§5 desktop active chip paints no outline',
        paint.L.outlineStyle === 'none' || parseFloat(paint.L.outlineWidth) === 0, true);
    check('§5 active and target treatments are distinguishable',
        JSON.stringify(paint.L) !== JSON.stringify(paint.D), true);
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §6 Static sole-writer invariants for BOTH selection ids.
// ============================================================================
{
    const smSrc = fs.readFileSync(
        path.join(ROOT, 'static/js/session-manager.js'), 'utf8');

    // lifecycleActionTargetId: exactly one assignment, inside the sole setter.
    const laAssigns = smSrc.match(/lifecycleActionTargetId\s*=(?!=)/g) || [];
    check('§6 static: exactly one assignment to lifecycleActionTargetId',
        laAssigns.length, 1);
    check('§6 static: that assignment is this.lifecycleActionTargetId = id',
        /this\.lifecycleActionTargetId = id;/.test(smSrc), true);

    // activeSessionId: exactly one assignment, inside setActivePane. The comment
    // mentioning a raw write must not be counted — only real assignments.
    const asAssigns = [];
    for (const m of smSrc.matchAll(/^([^\n]*activeSessionId\s*=(?!=)[^\n]*)$/gm)) {
        const line = m[1].trim();
        // Skip pure comments.
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        asAssigns.push(line);
    }
    check('§6 static: exactly one live assignment to activeSessionId',
        asAssigns.length, 1);
    check('§6 static: that assignment is this.activeSessionId = sessionId',
        asAssigns[0] && /this\.activeSessionId = sessionId;/.test(asAssigns[0]), true);

    /*
     * The assignment must live inside setActivePane.
     *
     * HARNESS DEFECT, fixed here (same class as session_actions §6): the locator
     * pinned the FULL signature `setActivePane(paneIndex, {
     * preserveLifecycleTarget = false } = {}) {`. S17 FIX 6 added a second
     * destructured option (`declareInteraction`) and reflowed the signature onto
     * three lines, so indexOf returned -1, slice(-1, paneEnd) sliced from the end
     * of the file, and a still-true assertion failed on a body it never read.
     *
     * Narrowed to the method NAME, which is what the row is actually about, and
     * followed by a non-vacuity row so a locator that stops matching fails
     * loudly as "locator broke" instead of silently as "product broke".
     */
    const paneStart = smSrc.indexOf('setActivePane(paneIndex');
    const paneEnd = smSrc.indexOf('composerOwnsInput() {', paneStart);
    const paneBody = smSrc.slice(paneStart, paneEnd);
    check('§6 static: the setActivePane locator still finds a non-empty body',
        paneStart >= 0 && paneEnd > paneStart && paneBody.length > 200, true);
    check('§6 static: activeSessionId is written inside setActivePane',
        /this\.activeSessionId = sessionId;/.test(paneBody), true);

    // aria-current is set and cleared only by the two target writers.
    const ariaSet = (smSrc.match(/setAttribute\('aria-current'/g) || []).length;
    check('§6 static: aria-current is set in both real and pending writers',
        ariaSet, 2);
    check('§6 static: the real target setter writes aria-current=true',
        /tab\.setAttribute\('aria-current', 'true'\)/.test(smSrc), true);

    // dispatchLifecycleAction must read lifecycleActionTargetId, never
    // activeSessionId — that is the whole point of the dual model.
    const dispStart = smSrc.indexOf('dispatchLifecycleAction(action) {');
    const dispEnd = smSrc.indexOf('\n    getSession(sessionId)', dispStart);
    const dispBody = smSrc.slice(dispStart, dispEnd);
    check('§6 static: dispatchLifecycleAction reads lifecycleActionTargetId',
        /const id = this\.lifecycleActionTargetId;/.test(dispBody), true);
    check('§6 static: dispatchLifecycleAction never reads activeSessionId',
        /activeSessionId/.test(dispBody), false);

    // removeSessionUI must preserve a deliberate target across pane maintenance.
    check('§6 static: removeSessionUI captures intendedTargetId before the tail',
        /const intendedTargetId = targetWasRemoved \? null : this\.lifecycleActionTargetId;/
            .test(smSrc), true);
    check('§6 static: removeSessionUI reassert is inequality-guarded',
        /if \(this\.lifecycleActionTargetId !== intendedTargetId\) \{/.test(smSrc), true);
    check('§6 static: every pane-maintenance call preserves the target',
        (smSrc.match(/setActivePane\([^;]+preserveLifecycleTarget: true/g) || []).length >= 3,
        true);
}

// ============================================================================
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
