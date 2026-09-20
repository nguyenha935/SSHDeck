#!/usr/bin/env node
/*
 * W13-B2 — Real-browser PREDICATE integration tests for the B5-B8
 * lifecycle/restore contract.
 *
 * lifecycle_entry_matrix.mjs pins the lifecycle CHAINS (which click reaches
 * which emit with which payload). This suite pins the PREDICATES that make
 * those chains honest, driven through the REAL production path in a real
 * browser — never by calling an internal with a fabricated argument:
 *
 *   §R1 RELOAD/RESTORE. The two restore events a post-reload socket delivers
 *       are exercised through the app's own registered handlers (window
 *       .__server invokes them; nothing else is mocked). Candidates offered by
 *       persistent_session_available must be honest records — useTmux mirrors
 *       the tmux IDENTITY the row carries (never a hardcoded true), they are
 *       an offer not a session (never pane-assigned, never sendable, never a
 *       target), duplicates are dropped, and a live ssh_session_restored
 *       honours its persisted pane_index without disturbing anyone else's pane.
 *   §R2 RECONNECT. The gate predicates — hasValidTmuxIdentity,
 *       refuseReconnectWithoutTmuxIdentity, reconnectNeedsCredentials, the
 *       beginReconnectIntent one-owner rule and isSendableSession — decide the
 *       route for candidate AND live sessions, and the predicate's verdict is
 *       what the wire carries: refuse means zero frames and zero state change;
 *       proceed means exactly the reattach payload (use_tmux:true + the exact
 *       name) or exactly the ssh_reconnect of a live swap, with the same-id,
 *       zero-disconnect completion contract.
 *   §R3 RESET. The B7 guard predicate hasInFlightCandidateReset is read
 *       directly and driven through every surface (sheet action, direct call,
 *       desktop tier); one in-flight Reset yields exactly ONE request id and
 *       ONE retirement record end to end. The B8 copy predicates are asserted
 *       as the dialog and the credential-form banner paint them: live copy
 *       states termination + kill on the target server, candidate copy states
 *       fresh connection + the remote host untouched, and the two are never
 *       crossed.
 *   §R4 SELECTION TARGETING. setLifecycleActionTarget is the sole writer:
 *       candidate arrivals never steal the target, the target survives an
 *       unrelated removal, it clears to null when its own session retires,
 *       and a bogus target id is coerced to null.
 *
 * Scope note: tests-only. No production file is touched by this suite.
 *
 * ONE REAL DEFECT WAS FOUND WHILE WRITING IT and was fixed under owner
 * approval (session-manager.js directReconnect now carries the W13-B5 source
 * session id on its reattach claim — pin v42). §R2's direct-route block pins
 * the fixed frame; see the block comment there for the evidence chain.
 *
 * Run: node tests/browser/predicate_lifecycle_restore.mjs   (from source/)
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
    window.__notes = [];
    /*
     * socket.on RECORDS its handlers and __server invokes them. The whole point
     * of §R1 is that the restore events run through the app's OWN registered
     * handlers (SessionManager.showPersistentSessionTab / restoreSession), so a
     * harness that discarded handlers could not exercise the contract at all.
     * Sections that never call __server are unaffected: nothing fires on its own.
     */
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
    // §R0 duplicates-observer: count how many times each observed entry point
    // actually runs. Wrap AFTER app load, not here — app.js replaces
    // window.showNotification during load. Sections that never call __server
    // are unaffected: nothing fires on its own.
    window.__obs = {};
    window.__observe = (name, obj, key) => {
        const orig = obj[key];
        if (typeof orig !== 'function') return false;
        window.__obs[name] = 0;
        obj[key] = function (...args) {
            window.__obs[name] = (window.__obs[name] || 0) + 1;
            return orig.apply(this, args);
        };
        return true;
    };
    window.showNotification = (m, t) => { window.__notes.push({ m, t }); };
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function newPage({ touch = true, w = 390, h = 844 } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(
        () => typeof SessionManager !== 'undefined' && !!window.socket
            && !!window.TerminalManager, null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // No real xterm in this harness: the subject is the predicate contract,
    // and a real terminal per seeded session would add nothing but startup cost.
    await page.evaluate(() => {
        TerminalManager.destroyTerminal = () => {};
        TerminalManager.createTerminal = () => {};
        TerminalManager.attachTerminal = () => {};
        TerminalManager.setupInputHandler = () => {};
        document.getElementById('sessionBar')?.classList.remove('hidden');
        /*
         * Record notifications, AFTER load. The init script's stub is replaced
         * by app.js's real showNotification during load, so this wraps the REAL
         * function — the production toast still renders, the recorder observes.
         */
        const real = window.showNotification;
        window.__notes = [];
        window.showNotification = (m, t, d) => {
            window.__notes.push({ m, t });
            if (typeof real === 'function') return real(m, t, d);
            return undefined;
        };
    });
    return { ctx, page, errors };
}

// The restore frame exactly as socket_events.py emits it for a persisted row
// (snapshot_version 1, is_persistent=True, connected=False).
const restoreFrame = (id, extra = {}) => Object.assign({
    snapshot_version: 1,
    session_id: id,
    host: 'tiny.example',
    port: 22,
    username: 'sshdtest',
    key_id: null,
    auth_type: 'password',
    tmux_session_name: `tmx_${id}`,
    display_name: `Saved ${id}`,
    pane_index: null,
}, extra);

/*
 * Deliver ONE candidate offer exactly as a post-reload socket does: through the
 * app's own registered persistent_session_available handler. The frame is built
 * on the Node side and passed in, so the page never sees a helper the product
 * does not have.
 */
async function offerCandidate(page, id, extra = {}) {
    await page.evaluate((frame) => {
        window.__server('persistent_session_available', frame);
    }, restoreFrame(id, extra));
}

/*
 * Seed one session through the real store + chip builder.
 *
 * Defaults describe a LIVE, tmux-attached, key-auth session — same fixture
 * shape lifecycle_entry_matrix.mjs uses, so the two suites assert one contract.
 */
async function seed(page, id, opts = {}) {
    await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = Object.assign({
            id, session_id: id, host: 'tiny.example', port: 22,
            username: 'sshdtest', authType: 'key', keyId: 'k1',
            jumpHostId: null, displayName: id, connected: true,
            // The server's whitelist alphabet (^[A-Za-z0-9_]{1,190}$). A name
            // outside it is one the server would reject, so a valid fixture
            // must live inside it — invalid shapes are injected separately
            // where a refusal is the asserted outcome.
            isPersistentCandidate: false, tmuxSessionName: `tmx_${id}`,
            terminalId: `term-${id}`, useTmux: true, viaJump: null,
            latencyMs: null,
        }, opts);
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, 'tiny.example', 'sshdtest');
        }
        if (!document.getElementById(`term-${id}`)) {
            const wrap = document.createElement('div');
            wrap.id = `term-${id}`;
            wrap.className = 'terminal-wrapper unassigned';
            document.getElementById('terminalsContainer').appendChild(wrap);
        }
        SessionManager.updateSessionStatus(
            id, SessionManager.sessions[id].connected ? 'connected' : 'disconnected');
    }, { id, opts });
}

const resetEmits = (page) => page.evaluate(() => { window.__emits.length = 0; });
const resetNotes = (page) => page.evaluate(() => { window.__notes.length = 0; });

const readDialog = (page) => page.evaluate(() => {
    const d = document.getElementById('sessionConfirm');
    const accept = document.getElementById('sessionConfirmAccept');
    return {
        open: !d.hidden,
        title: document.getElementById('sessionConfirmTitle')?.textContent || '',
        body: document.getElementById('sessionConfirmBody')?.textContent || '',
        accept: accept?.textContent || '',
        danger: !!accept?.classList.contains('session-confirm-danger'),
        icon: document.getElementById('sessionConfirmIcon')
            ?.getAttribute('href')?.split('#')[1] || '',
    };
});

const readEmits = (page) => page.evaluate(() => window.__emits.map(e => ({
    ev: e.ev,
    session_id: e.payload?.session_id,
    use_tmux: e.payload?.use_tmux,
    reconnect_tmux_name: e.payload?.reconnect_tmux_name,
    client_request_id: e.payload?.client_request_id,
    hasPassword: Object.prototype.hasOwnProperty.call(e.payload || {}, 'password'),
})));

// Select a chip the way a user does: one tap routes through switchSession ->
// setLifecycleActionTarget, which is the sole writer of the action target.
async function selectChip(page, id) {
    await page.click(`#tab-${id}`);
    await page.waitForTimeout(60);
    return page.evaluate(() => SessionManager.lifecycleActionTargetId);
}

async function openSheetByRetap(page, id) {
    const already = await page.evaluate(() =>
        !document.getElementById('sessionActionsSheet')?.hidden);
    if (already) return true;
    await page.click(`#tab-${id}`);
    await page.waitForTimeout(60);
    return page.evaluate(() =>
        !document.getElementById('sessionActionsSheet')?.hidden);
}

async function clickAction(page, action) {
    await page.click(`#sessionActionsSheet [data-lifecycle-action="${action}"]`);
    await page.waitForTimeout(80);
}

async function acceptDialog(page) {
    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(150);
}

async function cancelDialog(page) {
    await page.click('#sessionConfirmCancel');
    await page.waitForTimeout(80);
}

// ============================================================================
// §R1 RELOAD/RESTORE — the two post-reload events, through the app's own
//    handlers, asserting the honest-record predicate of the candidate store.
// ============================================================================

{
    const { ctx, page, errors } = await newPage();

    // The handlers a real socket connect registered (SessionManager.init).
    const wiring = await page.evaluate(() => ({
        candidate: (window.__handlers['persistent_session_available'] || []).length,
        restored: (window.__handlers['ssh_session_restored'] || []).length,
    }));
    check('§R1: persistent_session_available has a registered app handler',
        wiring.candidate, 1);
    check('§R1: ssh_session_restored has a registered app handler',
        wiring.restored, 1);

    // §R0 — single-owner socket wiring for restore/replay (fail-first).
    // app.js registers EARLY live listeners at parse time; SessionManager.init
    // registers both again. One socket, one owner: exactly one registered
    // handler must exist per event, and a post-init frame must dispatch each
    // observed entry point exactly once.
    {
        const wiringR0 = await page.evaluate(() => ({
            restored: (window.__handlers['ssh_session_restored'] || []).length,
            replay: (window.__handlers['ssh_replay_chunk'] || []).length,
        }));
        check('§R0: exactly ONE registered ssh_session_restored handler',
            wiringR0.restored, 1);
        check('§R0: exactly ONE registered ssh_replay_chunk handler',
            wiringR0.replay, 1);

        // Both listeners are LIVE by now (SessionManager.initialized is true),
        // so a real post-init frame runs restoreSession twice and
        // acceptReplayChunk twice on the current source. The frame targets a
        // DISPOSABLE session id so restoreSession's real work cannot disturb
        // the §R1 candidate rows measured below; "already exists" would skip
        // the second call and hide the duplicate, so a fresh id is required.
        const dispatch = await page.evaluate(() => {
            window.__obs = {};
            const okRestore = window.__observe('restoreSession',
                SessionManager, 'restoreSession');
            const okReplay = window.__observe('acceptReplayChunk',
                TerminalManager, 'acceptReplayChunk');
            if (!okRestore || !okReplay) return { wrapped: false, okRestore, okReplay };
            window.__server('ssh_session_restored', {
                snapshot_version: 1, session_id: 'R0POST',
                host: 'tiny.example', port: 22, username: 'sshdtest',
                key_id: null, auth_type: 'password',
                tmux_session_name: 'tmx_R0POST', display_name: 'Saved R0POST',
                pane_index: null,
            });
            window.__server('ssh_replay_chunk',
                { session_id: 'R0POST', total: 1, seq: 1, data: 'x', final: true });
            // Undo the probe's footprint so §R1's candidate assertions below
            // see exactly the three delivered rows, untouched.
            if (SessionManager.sessions.R0POST) {
                SessionManager.destroySession
                    ? SessionManager.destroySession('R0POST')
                    : delete SessionManager.sessions.R0POST;
                SessionManager.paneAssignments = SessionManager.paneAssignments
                    .map(p => (p === 'R0POST' ? null : p));
                if (SessionManager.lifecycleActionTargetId === 'R0POST') {
                    SessionManager.lifecycleActionTargetId = null;
                }
                const chip = document.getElementById('tab-R0POST');
                if (chip) chip.remove();
            }
            return { wrapped: true, restoreCalls: window.__obs.restoreSession,
                     replayCalls: window.__obs.acceptReplayChunk };
        });
        check('§R0: entry points observable before post-init dispatch',
            dispatch.wrapped, true);
        check('§R0: a post-init restore frame dispatches restoreSession exactly once',
            dispatch.restoreCalls, 1);
        check('§R0: a post-init replay chunk dispatches acceptReplayChunk exactly once',
            dispatch.replayCalls, 1);
    }

    // Three candidate rows arrive exactly as the backend emits them.
    await page.evaluate((frames) => {
        for (const f of frames) window.__server('persistent_session_available', f);
    }, [
        restoreFrame('RC1', { key_id: 'k9', auth_type: 'key' }),
        restoreFrame('RC2', { tmux_session_name: null }),
        restoreFrame('RC3'),
    ]);

    const honest = await page.evaluate(() => ({
        rc1: (() => { const s = SessionManager.sessions.RC1; return s ? {
            known: true, isPersistentCandidate: s.isPersistentCandidate,
            connected: s.connected, useTmux: s.useTmux,
            tmuxSessionName: s.tmuxSessionName, keyId: s.keyId,
            authType: s.authType, displayName: s.displayName,
        } : { known: false }; })(),
        rc2: (() => { const s = SessionManager.sessions.RC2; return s ? {
            known: true, useTmux: s.useTmux, tmuxSessionName: s.tmuxSessionName,
        } : { known: false }; })(),
        rc3Known: !!SessionManager.sessions.RC3,
        chips: ['RC1', 'RC2', 'RC3'].map(id =>
            !!document.getElementById(`tab-${id}`)),
        // The honest-record predicate: useTmux mirrors the IDENTITY, not the
        // offer. RC2 arrived with tmux_session_name:null and must not claim
        // tmux.
        sendable: ['RC1', 'RC2', 'RC3'].map(id =>
            SessionManager.isSendableSession(SessionManager.sessions[id])),
        // An offer is not a session: no pane ever holds one.
        panes: SessionManager.paneAssignments.filter(Boolean),
        hasAny: SessionManager.hasAnySessions(),
        target: SessionManager.lifecycleActionTargetId,
    }));
    check('§R1: all three candidate rows are known to the store',
        [honest.rc1.known, honest.rc2.known, honest.rc3Known],
        [true, true, true]);
    check('§R1: the candidate record is honest (flag, disconnected, key auth)',
        [honest.rc1.isPersistentCandidate, honest.rc1.connected,
            honest.rc1.authType, honest.rc1.keyId],
        [true, false, 'key', 'k9']);
    check('§R1: useTmux mirrors the tmux IDENTITY the row carries',
        [honest.rc1.useTmux, honest.rc1.tmuxSessionName],
        [true, 'tmx_RC1']);
    check('§R1: a row with NO tmux name does not claim tmux',
        [honest.rc2.useTmux, honest.rc2.tmuxSessionName],
        [false, null]);
    check('§R1: every offered row paints its chip', honest.chips,
        [true, true, true]);
    check('§R1: no candidate is sendable (Broadcast/input can never reach one)',
        honest.sendable, [false, false, false]);
    check('§R1: candidates are offers, not sessions — no pane assignment',
        honest.panes, []);
    check('§R1: hasAnySessions still reports a non-empty deck',
        honest.hasAny, true);
    check('§R1: candidate arrivals never steal the lifecycle target',
        honest.target, null);

    // Duplicate restore frame: the second arrival must be a no-op.
    await page.evaluate(() => {
        window.__server('persistent_session_available', {
            snapshot_version: 1, session_id: 'RC1', host: 'tiny.example',
            port: 22, username: 'sshdtest', key_id: 'k9', auth_type: 'key',
            tmux_session_name: 'tmx_RC1', display_name: 'Saved RC1',
            pane_index: null,
        });
    });
    const dupe = await page.evaluate(() => ({
        chips: document.querySelectorAll('#tab-RC1').length,
        wrappers: document.querySelectorAll('#terminal-RC1').length,
    }));
    check('§R1: a duplicate restore frame creates no second chip',
        [dupe.chips, dupe.wrappers], [1, 1]);

    // A LIVE session restores into the deck: pane placement honours the
    // persisted pane_index, and nobody else's pane is disturbed.
    await page.evaluate(() => SessionManager.setSplitLayout(2));
    await seed(page, 'LIVE');
    const occupied = await page.evaluate(() =>
        SessionManager.paneAssignments.indexOf('LIVE'));
    await page.evaluate(() => {
        window.__server('ssh_session_restored', {
            snapshot_version: 1, session_id: 'RS1', host: 'tiny.example',
            port: 22, username: 'sshdtest', auth_type: 'key', key_id: 'k1',
            use_tmux: true, tmux_session_name: 'tmx_RS1',
            display_name: 'Restored RS1', pane_index: 1,
        });
    });
    const restored = await page.evaluate((occupiedIdx) => ({
        known: !!SessionManager.sessions.RS1,
        connected: SessionManager.sessions.RS1?.connected,
        isCandidate: SessionManager.sessions.RS1?.isPersistentCandidate === true,
        paneOfRS1: SessionManager.paneAssignments.indexOf('RS1'),
        paneOfLIVE: SessionManager.paneAssignments.indexOf('LIVE'),
        occupiedIdx,
        sendable: SessionManager.isSendableSession(
            SessionManager.sessions.RS1),
        chip: !!document.getElementById('tab-RS1'),
    }), occupied);
    check('§R1: the restored live session is a connected non-candidate',
        [restored.known, restored.connected, restored.isCandidate],
        [true, true, false]);
    check('§R1: a live restore is sendable (unlike every candidate)',
        restored.sendable, true);
    check('§R1: the restored chip exists', restored.chip, true);
    check('§R1: the persisted pane_index is honoured',
        restored.paneOfRS1, 1);
    check('§R1: the restore disturbs no other pane',
        restored.paneOfLIVE, restored.occupiedIdx);
    check('§R1: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // The tmux-less candidate is the refusal shape itself: offered, honest,
    // and then refused by Reconnect — the record survives for an explicit
    // Reset or a later restore.
    const { ctx, page, errors } = await newPage();
    await offerCandidate(page, 'RX', { tmux_session_name: null });
    await resetEmits(page);
    await resetNotes(page);
    await selectChip(page, 'RX');
    await openSheetByRetap(page, 'RX');
    await clickAction(page, 'reconnect');
    const refused = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        dialog: !document.getElementById('sessionConfirm').hidden,
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        notes: window.__notes.map(n => n.t),
        chip: !!document.getElementById('tab-RX'),
        record: (() => { const s = SessionManager.sessions.RX; return s ? {
            known: true, useTmux: s.useTmux, isPersistentCandidate:
                s.isPersistentCandidate, claimed: !!(SessionManager
                    .reconnectingSessions && SessionManager
                    .reconnectingSessions.RX),
        } : { known: false }; })(),
    }));
    check('§R1: Reconnect of a tmux-less candidate emits nothing',
        refused.emits, []);
    check('§R1: no dialog and no credential form open under a false promise',
        [refused.dialog, refused.modal], [false, false]);
    check('§R1: the refusal is reported as an error notification',
        refused.notes, ['error']);
    check('§R1: the chip survives the refusal', refused.chip, true);
    check('§R1: the record survives untouched (no claim, no flag change)',
        refused.record, { known: true, useTmux: false,
            isPersistentCandidate: true, claimed: false });
    check('§R1: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §R0b PRE-INIT BUFFERING & DRAIN ORDER (fail-first).
//    A frame arriving before DOMContentLoaded must buffer, not dispatch.
//    SessionManager.init must complete its grid/layout prerequisites BEFORE
//    draining, and each buffered frame must dispatch exactly once.
//    Proven on a fresh page by re-running SessionManager.init inside a
//    controlled pre-init state: __earlyRestoreFrames seeded, initialized=false,
//    entry points observed, then init() runs and the drain is counted.
// ============================================================================

{
    const { ctx, page, errors } = await newPage();

    const drained = await page.evaluate(() => {
        // Roll SessionManager back to its pre-init state the way a page that
        // has NOT reached DOMContentLoaded would look.
        SessionManager.initialized = false;
        window.__earlyRestoreFrames = [
            { snapshot_version: 1, session_id: 'EARLY1', host: 'tiny.example',
              port: 22, username: 'sshdtest', auth_type: 'password',
              key_id: null, tmux_session_name: 'tmx_EARLY1',
              display_name: 'Saved EARLY1', pane_index: null },
            { snapshot_version: 1, session_id: 'EARLY2', host: 'tiny.example',
              port: 22, username: 'sshdtest', auth_type: 'password',
              key_id: null, tmux_session_name: 'tmx_EARLY2',
              display_name: 'Saved EARLY2', pane_index: null },
        ];
        window.__earlyReplayChunks = [
            { session_id: 'EARLY1', total: 1, seq: 1, data: 'a', final: true },
        ];

        // Observe BOTH entry points and the prerequisite initializer, in the
        // order the calls actually happen. Only the pair matters for §R0b:
        // grid/layout must precede the first dispatch of a buffered frame.
        const calls = [];
        const origRestore = SessionManager.restoreSession;
        SessionManager.restoreSession = function (...a) {
            calls.push('restore'); return origRestore.apply(this, a);
        };
        const origGrid = SessionManager.ensureTerminalGrid;
        SessionManager.ensureTerminalGrid = function (...a) {
            calls.push('grid'); return origGrid.apply(this, a);
        };
        const origLayout = SessionManager.setSplitLayout;
        SessionManager.setSplitLayout = function (...a) {
            calls.push('layout'); return origLayout.apply(this, a);
        };
        const origReplay = TerminalManager.acceptReplayChunk;
        TerminalManager.acceptReplayChunk = function (...a) {
            calls.push('replay'); return origReplay.apply(this, a);
        };

        // init() must finish ensureTerminalGrid/setSplitLayout BEFORE draining
        // buffered restore/replay frames (D1). Call order is observed above.
        SessionManager.init();

        const firstDispatch = calls.findIndex(c => c === 'restore' || c === 'replay');
        const firstPrereq = calls.findIndex(c => c === 'grid' || c === 'layout');
        return {
            calls,
            restoreCount: calls.filter(c => c === 'restore').length,
            replayCount: calls.filter(c => c === 'replay').length,
            prereqBeforeDispatch: firstDispatch !== -1
                && firstPrereq !== -1 && firstPrereq < firstDispatch,
            drainDone: window.__earlyRestoreFrames.length === 0
                && window.__earlyReplayChunks.length === 0,
            initialized: SessionManager.initialized === true,
            panesBuilt: SessionManager.paneAssignments.length > 0,
            sessions: ['EARLY1', 'EARLY2'].map(id => !!SessionManager.sessions[id]),
        };
    });

    // expected is the boolean predicate; call order is embedded in the label
    // so a failure still shows the observed sequence (was previously the
    // expected field, which made the assert unpassable even when true).
    check(`§R0b: init() completes grid before dispatching any buffered frame (calls=[${drained.calls.slice(0, 8).join(',')}])`,
        drained.prereqBeforeDispatch, true);
    check('§R0b: each buffered restore frame dispatches exactly once',
        drained.restoreCount, 2);
    check('§R0b: each buffered replay chunk dispatches exactly once',
        drained.replayCount, 1);
    check('§R0b: buffered frames drain completely (no residue)',
        drained.drainDone, true);
    check('§R0b: init ends initialized with panes built',
        [drained.initialized, drained.panesBuilt], [true, true]);
    check('§R0b: drained restores create their sessions',
        drained.sessions, [true, true]);
    check('§R0b: no page errors during drain', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §R2 RECONNECT — the gate predicates decide the route, for candidate and
//    live sessions alike, and the verdict is exactly what the wire carries.
// ============================================================================

{
    // Identity-shape predicates against the ONE validator, plus the routing
    // predicate that decides whether a live reconnect asks for a credential.
    const { ctx, page, errors } = await newPage();
    const matrix = await page.evaluate(() => {
        const shapes = [
            { tmuxSessionName: 'tmx_valid' },
            { tmuxSessionName: '' },
            { tmuxSessionName: null },
            { tmuxSessionName: 'has-hyphen' },
            { tmuxSessionName: 'has space' },
            { tmuxSessionName: 'a'.repeat(191) },
            { tmuxSessionName: 'a'.repeat(190) },
            {},
        ].map(s => SessionManager.hasValidTmuxIdentity(s));
        const creds = (opts) => {
            SessionManager.sessions.NEEDS = Object.assign({
                id: 'NEEDS', session_id: 'NEEDS', connected: true,
                viaJump: null, jumpHostId: null,
            }, opts);
            const v = SessionManager.reconnectNeedsCredentials('NEEDS');
            delete SessionManager.sessions.NEEDS;
            return v;
        };
        return {
            shapes,
            keyWithKey: creds({ authType: 'key', keyId: 'k1' }),
            keyNoKey: creds({ authType: 'key', keyId: null }),
            tailscale: creds({ authType: 'tailscale', keyId: null }),
            password: creds({ authType: 'password', keyId: null }),
            jump: creds({ authType: 'key', keyId: 'k1', jumpHostId: 'jh1' }),
        };
    });
    check('§R2: hasValidTmuxIdentity accepts only the server whitelist shape',
        matrix.shapes,
        [true, false, false, false, false, false, true, false]);
    check('§R2: reconnectNeedsCredentials mirrors the server\'s refusals',
        [matrix.keyWithKey, matrix.keyNoKey, matrix.tailscale,
            matrix.password, matrix.jump],
        [false, true, false, true, true]);
    check('§R2: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // A candidate with a MALFORMED identity (the row itself carries a name
    // outside the server whitelist): both candidate routes refuse locally.
    const { ctx, page, errors } = await newPage();
    await offerCandidate(page, 'BAD', {
        key_id: 'k1', auth_type: 'key', tmux_session_name: 'bad-name',
    });
    await offerCandidate(page, 'BAD2', {
        auth_type: 'password', tmux_session_name: 'bad name',
    });

    // Direct route (key candidate).
    await resetEmits(page);
    await resetNotes(page);
    await selectChip(page, 'BAD');
    await openSheetByRetap(page, 'BAD');
    await clickAction(page, 'reconnect');
    const direct = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        notes: window.__notes.map(n => n.t),
        dialog: !document.getElementById('sessionConfirm').hidden,
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.BAD),
        chip: !!document.getElementById('tab-BAD'),
    }));
    check('§R2: a malformed-identity key candidate emits nothing on Reconnect',
        direct.emits, []);
    check('§R2: the refusal says so (error notification)', direct.notes,
        ['error']);
    check('§R2: nothing opens and no claim is armed',
        [direct.dialog, direct.modal, direct.claimed],
        [false, false, false]);
    check('§R2: the chip survives the direct-route refusal', direct.chip, true);

    // Credential route (password candidate) — same boundary, same verdict.
    await resetEmits(page);
    await resetNotes(page);
    await selectChip(page, 'BAD2');
    await openSheetByRetap(page, 'BAD2');
    await clickAction(page, 'reconnect');
    const cred = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        notes: window.__notes.map(n => n.t),
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.BAD2),
        chip: !!document.getElementById('tab-BAD2'),
    }));
    check('§R2: a malformed-identity password candidate emits nothing either',
        cred.emits, []);
    check('§R2: the credential route refuses with the same honesty',
        cred.notes, ['error']);
    check('§R2: no form opens and no claim is armed',
        [cred.modal, cred.claimed], [false, false]);
    check('§R2: the chip survives the credential-route refusal',
        cred.chip, true);
    check('§R2: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // Key candidate: direct route. One tap = one frame, carrying the exact
    // reattach payload; a second tap while in flight is refused by the
    // one-owner predicate; completion retires the offer with zero disconnects.
    const { ctx, page, errors } = await newPage();
    await offerCandidate(page, 'RK', { key_id: 'k1', auth_type: 'key' });
    await selectChip(page, 'RK');
    await openSheetByRetap(page, 'RK');
    await resetEmits(page);
    await clickAction(page, 'reconnect');
    const first = await page.evaluate(() => ({
        emits: window.__emits.map(e => ({
            ev: e.ev,
            use_tmux: e.payload?.use_tmux,
            reconnect_tmux_name: e.payload?.reconnect_tmux_name,
            session_id: e.payload?.session_id ?? null,
            hasRequestId: !!e.payload?.client_request_id,
        })),
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.RK),
    }));
    check('§R2: the direct route emits exactly ONE ssh_connect',
        first.emits.length, 1);
    check('§R2: the frame reattaches the exact retained tmux session',
        [first.emits[0].ev, first.emits[0].use_tmux,
            first.emits[0].reconnect_tmux_name],
        ['ssh_connect', true, 'tmx_RK']);
    check('§R2: the frame is request-keyed', first.emits[0].hasRequestId, true);
    /*
     * W13-B5's reattach claim fails CLOSED server-side: any ssh_connect
     * carrying `reconnect_tmux_name` must also name the SOURCE session, or the
     * handler refuses it outright with "Reconnect requires the source session
     * id" (app/socket_events.py's handle_ssh_connect, pinned by
     * tests/test_b5_reconnect_validation.py:187). The server then binds the
     * name to exactly that persistent row and refuses an endpoint or owner
     * mismatch, rather than silently connecting fresh under Reconnect's label.
     *
     * The direct route (key / tailscale candidates, no credential form) omitted
     * that id, so its frame was refused before any transport was built — found
     * by driving the real handler with exactly this payload during W13-B2 and
     * fixed under owner approval (session-manager.js directReconnect). The id is
     * therefore not decoration: it is what makes the claim honourable, and this
     * assertion is what keeps the two candidate routes agreeing about it.
     */
    check('§R2: the direct route names its exact source session (B5 claim)',
        first.emits[0].session_id, 'RK');
    check('§R2: the session is claimed while in flight', first.claimed, true);

    // The one-owner predicate: the second press is refused, on the wire.
    // The sheet closed behind the first action, so it is re-opened the way a
    // user re-opens it — a tap on the candidate chip, which is still there
    // precisely because a reconnect destroys nothing up front.
    await resetEmits(page);
    await selectChip(page, 'RK');
    await openSheetByRetap(page, 'RK');
    await clickAction(page, 'reconnect');
    const second = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        stillClaimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.RK),
    }));
    check('§R2: a second press while in flight emits nothing',
        second.emits, []);
    check('§R2: the original claim is still armed (not stolen, not doubled)',
        second.stillClaimed, true);

    // Completion: the replacement arrives keyed by the request id; the offer
    // retires exactly once, with NO ssh_disconnect (its tmux must live on).
    const rid = await page.evaluate(() =>
        SessionManager.reconnectingSessions.RK);
    const done = await page.evaluate((requestId) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RK_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: requestId,
            use_tmux: true, tmux_session_name: 'tmx_RK', auth_type: 'key',
        });
        return {
            oldGone: !SessionManager.sessions.RK,
            oldChip: !!document.getElementById('tab-RK'),
            newThere: !!SessionManager.sessions.RK_NEW,
            claimed: !!(SessionManager.reconnectingSessions
                && SessionManager.reconnectingSessions.RK),
            emits: window.__emits.map(e => e.ev),
        };
    }, rid);
    check('§R2: the replacement retires the offer exactly once',
        [done.oldGone, done.oldChip], [true, false]);
    check('§R2: the new session exists under the retained tmux name',
        done.newThere, true);
    check('§R2: the claim is released on completion', done.claimed, false);
    check('§R2: reconnect completion emits ZERO disconnect frames',
        done.emits.filter(e => e === 'ssh_disconnect'), []);
    check('§R2: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // Live sessions: the reconnectNeedsCredentials predicate splits the two
    // routes, and BOTH end in a swap of the SAME logical session.
    const { ctx, page, errors } = await newPage();

    // Shape 1: key auth with a stored key — straight to the server swap.
    await seed(page, 'LV1');
    await selectChip(page, 'LV1');
    await openSheetByRetap(page, 'LV1');
    await resetEmits(page);
    await clickAction(page, 'reconnect');
    const gate = await readDialog(page);
    check('§R2 live: the confirm gate opens, and it is NOT destructive',
        [gate.open, gate.danger], [true, false]);
    await acceptDialog(page);
    const swapped = await page.evaluate(() => ({
        emits: window.__emits.map(e => ({
            ev: e.ev, session_id: e.payload?.session_id,
        })),
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.LV1),
        stillThere: !!SessionManager.sessions.LV1,
    }));
    check('§R2 live: accept emits exactly one ssh_reconnect for the session',
        swapped.emits, [{ ev: 'ssh_reconnect', session_id: 'LV1' }]);
    check('§R2 live: the session stays claimed and alive during the swap',
        [swapped.claimed, swapped.stillThere], [true, true]);

    // The swap reply: same session id, no new chip, no disconnect.
    const afterSwap = await page.evaluate(() => {
        window.__emits.length = 0;
        window.__server('ssh_reconnected', {
            session_id: 'LV1', tmux_session_name: 'tmx_LV1',
        });
        return {
            known: !!SessionManager.sessions.LV1,
            claimed: !!(SessionManager.reconnectingSessions
                && SessionManager.reconnectingSessions.LV1),
            chips: document.querySelectorAll('#tab-LV1').length,
            emits: window.__emits.map(e => e.ev),
        };
    });
    check('§R2 live: the swap keeps the SAME session id',
        afterSwap.known, true);
    check('§R2 live: the claim is released by ssh_reconnected',
        afterSwap.claimed, false);
    check('§R2 live: exactly one chip — no duplicate from the swap',
        afterSwap.chips, 1);
    /*
     * REVISED (Phase 2): the swap round trip emits no LIFECYCLE
     * traffic of its own -- no second ssh_reconnect, no ssh_disconnect, no
     * new connect. The one frame it does produce is the composer's reverse
     * sync: a session that just came back may hold a half-typed line, and an
     * empty box asks for it once (`get_terminal_line`, a read-only
     * capture-pane) so the user can keep editing it. That is the owner's
     * "mở trang khi terminal đã có chữ dở -> ô hiện đúng chữ đó".
     */
    check('§R2 live: the swap round trip emits no lifecycle traffic',
        afterSwap.emits.filter(ev => ev !== 'get_terminal_line'), []);
    check('§R2 live: and the returning session is asked for its pending line',
        afterSwap.emits, ['get_terminal_line']);

    // Shape 2: password auth — the predicate sends the live reconnect to the
    // credential form carrying the intent.
    await seed(page, 'LV2', { authType: 'password', keyId: null });
    await selectChip(page, 'LV2');
    await openSheetByRetap(page, 'LV2');
    await resetEmits(page);
    await clickAction(page, 'reconnect');
    const gate2 = await readDialog(page);
    check('§R2 live: the password gate states the credential will be asked',
        gate2.body.includes('password is asked for again'), true);
    check('§R2 live: the password gate stays non-destructive',
        gate2.danger, false);
    await acceptDialog(page);
    const form = await page.evaluate(() => {
        const meta = SessionManager.activeReconnectIntent();
        return {
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            banner: !!document.getElementById('connectionFormIntent')
                && !document.getElementById('connectionFormIntent').hidden,
            intentSession: meta ? meta.sessionId : null,
            intentTmux: meta ? meta.tmuxSessionName : null,
            fromCandidate: meta ? meta.fromCandidate : null,
            emits: window.__emits.map(e => e.ev),
        };
    });
    check('§R2 live: the credential form opens with the intent banner',
        [form.modal, form.banner], [true, true]);
    check('§R2 live: the intent is armed with the live session\'s identity',
        [form.intentSession, form.intentTmux, form.fromCandidate],
        ['LV2', 'tmx_LV2', false]);
    check('§R2 live: nothing is emitted until submit', form.emits, []);

    const submitted = await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return {
            emits: window.__emits.map(e => e.ev),
            useTmux: frame?.payload?.use_tmux,
            tmux: frame?.payload?.reconnect_tmux_name,
            sessionField: frame?.payload?.session_id ?? null,
            requestId: frame?.payload?.client_request_id,
        };
    });
    check('§R2 live: submit emits exactly one ssh_connect',
        submitted.emits, ['ssh_connect']);
    check('§R2 live: the payload REATTACHES the live session\'s tmux',
        [submitted.useTmux, submitted.tmux], [true, 'tmx_LV2']);
    /*
     * W13-B5: a reattach claim carries the SOURCE session id, and the server
     * binds the claim to exactly that row (socket_events.py:527-549 — a name
     * with no source id, or one belonging to another row/endpoint, is refused
     * rather than silently downgraded to a fresh connection). So the id on this
     * frame is not decoration: it is what makes the claim honourable.
     */
    check('§R2 live: the reattach claim names its exact source session (B5)',
        submitted.sessionField, 'LV2');
    check('§R2 live: the frame is request-keyed', !!submitted.requestId, true);

    // Completion retires the old chip via completePendingReconnect — again
    // with zero disconnects.
    const done2 = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'LV2_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: true, tmux_session_name: 'tmx_LV2',
            auth_type: 'password',
        });
        return {
            oldGone: !SessionManager.sessions.LV2,
            newThere: !!SessionManager.sessions.LV2_NEW,
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect'),
        };
    }, submitted.requestId);
    check('§R2 live: the form route retires the old session on success',
        [done2.oldGone, done2.newThere], [true, true]);
    check('§R2 live: zero ssh_disconnect across the form-route completion',
        done2.disconnects, []);
    check('§R2: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §R3 RESET — the B7 guard predicate under every surface, and the B8 copy
//    predicates exactly as the dialog and the banner paint them.
// ============================================================================

{
    // B7: one candidate, three trigger surfaces, ONE backend request.
    const { ctx, page, errors } = await newPage();
    await offerCandidate(page, 'GA', { key_id: 'k1', auth_type: 'key' });
    await selectChip(page, 'GA');
    await openSheetByRetap(page, 'GA');
    const notYet = await page.evaluate(() =>
        SessionManager.hasInFlightCandidateReset('GA'));
    check('§R3 B7: before any Reset the guard predicate is false', notYet, false);

    await resetEmits(page);
    await clickAction(page, 'reset');
    const armed = await page.evaluate(() => ({
        dialog: !document.getElementById('sessionConfirm').hidden,
        guard: SessionManager.hasInFlightCandidateReset('GA'),
        emits: window.__emits.map(e => e.ev),
    }));
    check('§R3 B7: opening the confirmation arms the guard predicate',
        armed.guard, true);
    check('§R3 B7: nothing is emitted while the dialog is open',
        armed.emits, []);

    // Surface 1: the handler itself, while the confirmation is still open.
    // (The sheet closed behind the accepted action and the confirmation is
    // modal, so this is the only trigger a user can reach at this instant —
    // e.g. a keyboard shortcut or the toolbar proxy resolving to the same
    // owner. Surface 2 below is the full real-UI route.)
    await resetEmits(page);
    await resetNotes(page);
    await page.evaluate(() => SessionManager.requestResetSession('GA'));
    await page.waitForTimeout(80);
    const refusedDirect = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        dialogs: document.querySelectorAll(
            '#sessionConfirm:not([hidden])').length,
        notes: window.__notes.map(n => n.t),
        guard: SessionManager.hasInFlightCandidateReset('GA'),
    }));
    check('§R3 B7: a re-trigger while the dialog is open emits nothing',
        refusedDirect.emits, []);
    check('§R3 B7: the re-trigger opens no second dialog',
        refusedDirect.dialogs, 1);
    check('§R3 B7: the user is told a Reset is already in progress',
        refusedDirect.notes, ['info']);
    check('§R3 B7: the guard survives the refused press',
        refusedDirect.guard, true);

    // Accept: ONE emit, ONE request id, and the guard stays armed across the
    // in-flight connect — the ack is the terminal event, not the emit.
    await resetEmits(page);
    await acceptDialog(page);
    const emitted = await page.evaluate(() => ({
        frames: window.__emits.map(e => ({
            ev: e.ev,
            use_tmux: e.payload?.use_tmux,
            reconnect_tmux_name: e.payload?.reconnect_tmux_name,
            session_id: e.payload?.session_id ?? null,
        })),
        intentIds: Object.keys(SessionManager.resetIntents),
        guard: SessionManager.hasInFlightCandidateReset('GA'),
        stillThere: !!SessionManager.sessions.GA,
        chip: !!document.getElementById('tab-GA'),
    }));
    check('§R3 B7: the accepted Reset emits exactly ONE fresh-connect frame',
        emitted.frames, [{
            ev: 'ssh_connect', use_tmux: false, reconnect_tmux_name: null,
            session_id: null,
        }]);
    check('§R3 B7: exactly one reset intent is armed',
        emitted.intentIds.length, 1);
    check('§R3 B7: the guard stays armed across the in-flight connect',
        emitted.guard, true);
    check('§R3 B7: the candidate and its chip survive until the ack',
        [emitted.stillThere, emitted.chip], [true, true]);

    // Surface 2: the FULL real-UI route while the connect is in flight — the
    // candidate's chip is still there (nothing was destroyed up front), so a
    // user really can re-tap it, re-open the sheet and press Reset again.
    // That press must be a true no-op: no second frame, no second intent.
    await resetEmits(page);
    await resetNotes(page);
    await selectChip(page, 'GA');
    await openSheetByRetap(page, 'GA');
    await clickAction(page, 'reset');
    const refusedUI = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        dialogs: document.querySelectorAll(
            '#sessionConfirm:not([hidden])').length,
        notes: window.__notes.map(n => n.t),
        intents: Object.keys(SessionManager.resetIntents).length,
        guard: SessionManager.hasInFlightCandidateReset('GA'),
    }));
    check('§R3 B7: the real-UI re-trigger in flight emits nothing',
        refusedUI.emits, []);
    check('§R3 B7: it opens no confirmation at all', refusedUI.dialogs, 0);
    check('§R3 B7: it names the offer in an info notification',
        refusedUI.notes, ['info']);
    check('§R3 B7: still exactly ONE reset intent for this candidate',
        refusedUI.intents, 1);
    check('§R3 B7: the guard is still armed after the refused UI press',
        refusedUI.guard, true);

    // Surface 3: the desktop tier applies the same guard to the same route.
    const desktopPage = await newPage({ touch: false, w: 1280, h: 800 });
    await offerCandidate(desktopPage.page, 'GD', {
        key_id: 'k1', auth_type: 'key',
    });
    await selectChip(desktopPage.page, 'GD');
    await openSheetByRetap(desktopPage.page, 'GD');
    await clickAction(desktopPage.page, 'reset');
    await acceptDialog(desktopPage.page);
    await resetEmits(desktopPage.page);
    await resetNotes(desktopPage.page);
    await selectChip(desktopPage.page, 'GD');
    await openSheetByRetap(desktopPage.page, 'GD');
    await clickAction(desktopPage.page, 'reset');
    const desktopRefusal = await desktopPage.page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        notes: window.__notes.map(n => n.t),
        guard: SessionManager.hasInFlightCandidateReset('GD'),
        intents: Object.keys(SessionManager.resetIntents).length,
    }));
    check('§R3 B7: the desktop tier refuses the second Reset just the same',
        [desktopRefusal.emits, desktopRefusal.notes],
        [[], ['info']]);
    check('§R3 B7: the desktop guard stays armed with one intent',
        [desktopRefusal.guard, desktopRefusal.intents], [true, 1]);
    check('§R3 B7: no desktop page errors',
        desktopPage.errors.join(' | '), '');
    await desktopPage.ctx.close();

    const rid = emitted.intentIds[0];
    const correlated = await page.evaluate((requestId) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'GA_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: requestId,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return {
            resets: window.__emits.filter(e => e.ev === 'candidate_reset')
                .map(e => ({ sid: e.payload?.session_id,
                    rid: e.payload?.request_id })),
            retirements: Object.keys(
                SessionManager.candidateRetirements).length,
        };
    }, rid);
    check('§R3 B7: ssh_connected yields exactly ONE correlated candidate_reset',
        correlated.resets.length, 1);
    check('§R3 B7: it names this candidate and its retirement id',
        [correlated.resets[0]?.sid,
            /^retire_/.test(correlated.resets[0]?.rid || '')],
        ['GA', true]);
    check('§R3 B7: exactly one retirement record exists',
        correlated.retirements, 1);

    const afterAck = await page.evaluate((retireRid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'GA', request_id: retireRid,
        });
        return {
            guard: SessionManager.hasInFlightCandidateReset('GA'),
            oldGone: !SessionManager.sessions.GA,
            retirements: Object.keys(
                SessionManager.candidateRetirements).length,
        };
    }, correlated.resets[0].rid);
    check('§R3 B7: the success ack releases the guard predicate',
        afterAck.guard, false);
    check('§R3 B7: the ack retires the candidate and its record',
        [afterAck.oldGone, afterAck.retirements], [true, 0]);

    // Per-candidate granularity: GB resets freely while GA's lifecycle was
    // running, and its own guard arms and releases independently.
    await offerCandidate(page, 'GB', { key_id: 'k1', auth_type: 'key' });
    await selectChip(page, 'GB');
    await openSheetByRetap(page, 'GB');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const gb = await page.evaluate(() => ({
        frames: window.__emits.map(e => e.ev),
        gbGuard: SessionManager.hasInFlightCandidateReset('GB'),
        gaGuard: SessionManager.hasInFlightCandidateReset('GA'),
        gbIntents: Object.keys(SessionManager.resetIntents).length,
    }));
    check('§R3 B7: another candidate resets freely (per-candidate guard)',
        [gb.frames, gb.gbGuard], [['ssh_connect'], true]);
    check('§R3 B7: GA\'s retired guard stays released', gb.gaGuard, false);
    check('§R3 B7: GB arms exactly one intent of its own', gb.gbIntents, 1);
    check('§R3 B7: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // B8: the copy predicates. The dialog paints whichever half of the
    // contract applies to the session it addresses, and the credential-form
    // banner states the same half — never crossed between live and candidate.
    const { ctx, page, errors } = await newPage();
    await seed(page, 'CL');
    await offerCandidate(page, 'CC', { auth_type: 'password' });

    // LIVE copy: termination of the active connection + kill of the remote
    // tmux on the target server.
    await selectChip(page, 'CL');
    await openSheetByRetap(page, 'CL');
    await clickAction(page, 'reset');
    const live = await readDialog(page);
    check('§R3 B8: the live Reset is destructive and confirmed',
        [live.open, live.danger], [true, true]);
    check('§R3 B8: live copy states the active connection is terminated',
        live.body.includes('active connection is terminated'), true);
    check('§R3 B8: live copy states the tmux is killed on the TARGET server',
        live.body.includes('killed on the target server'), true);
    check('§R3 B8: live copy carries no candidate "host untouched" promise',
        live.body.includes('Nothing running on the remote host'), false);
    check('§R3 B8: the live accept button says "end"',
        live.accept, 'End session and start fresh');
    await cancelDialog(page);

    // CANDIDATE copy: fresh connection intent, stored state discarded, the
    // remote host untouched — and none of the destructive language.
    await selectChip(page, 'CC');
    await openSheetByRetap(page, 'CC');
    await clickAction(page, 'reset');
    const cand = await readDialog(page);
    check('§R3 B8: the candidate Reset stays confirmed and destructive-styled',
        [cand.open, cand.danger], [true, true]);
    check('§R3 B8: candidate copy states a fresh connection starts',
        cand.body.includes('starts a fresh connection'), true);
    check('§R3 B8: candidate copy states the remote host is unaffected',
        cand.body.includes('Nothing running on the remote host is affected'),
        true);
    check('§R3 B8: candidate copy carries no termination language',
        cand.body.includes('terminated'), false);
    check('§R3 B8: candidate copy carries no kill language',
        cand.body.includes('killed'), false);
    check('§R3 B8: the candidate accept button says "drop"',
        cand.accept, 'Drop and start fresh');

    // The credential-form banner states the SAME half, per origin.
    await acceptDialog(page);
    const bannerCand = await page.evaluate(() => ({
        visible: !!document.getElementById('connectionFormIntent')
            && !document.getElementById('connectionFormIntent').hidden,
        detail: document.getElementById('connectionFormIntentDetail')
            ?.textContent || '',
    }));
    check('§R3 B8: the candidate Reset form carries the intent banner',
        bannerCand.visible, true);
    check('§R3 B8: the candidate banner promises the host is untouched',
        bannerCand.detail.includes('Nothing running on the remote host'),
        true);
    check('§R3 B8: the candidate banner carries no kill language',
        bannerCand.detail.includes('killed'), false);
    // Dismiss the form the way a user does — Reset's modal path is cancelled
    // by the form's own Cancel button, which also drops the pending intent.
    await page.click('#cancelConnectionBtn');
    await page.waitForTimeout(80);
    const dismissed = await page.evaluate(() => ({
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        guard: SessionManager.hasInFlightCandidateReset('CC'),
        candidateKept: !!SessionManager.sessions.CC,
    }));
    check('§R3 B8: cancelling the candidate Reset form closes it',
        dismissed.modal, false);
    check('§R3 B8: the cancelled Reset releases the B7 guard',
        dismissed.guard, false);
    check('§R3 B8: the cancelled Reset keeps the offer',
        dismissed.candidateKept, true);

    // Live password Reset: the banner states the destructive half.
    await seed(page, 'CB', { authType: 'password', keyId: null });
    await selectChip(page, 'CB');
    await openSheetByRetap(page, 'CB');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const bannerLive = await page.evaluate(() => ({
        visible: !!document.getElementById('connectionFormIntent')
            && !document.getElementById('connectionFormIntent').hidden,
        detail: document.getElementById('connectionFormIntentDetail')
            ?.textContent || '',
    }));
    check('§R3 B8: the live Reset form carries the intent banner',
        bannerLive.visible, true);
    check('§R3 B8: the live banner states termination + kill',
        [bannerLive.detail.includes('terminated'),
            bannerLive.detail.includes('killed')], [true, true]);
    check('§R3 B8: the live banner carries no "host untouched" promise',
        bannerLive.detail.includes('Nothing running on the remote host'),
        false);
    check('§R3 B8: the two banners never say the same thing',
        bannerLive.detail !== bannerCand.detail, true);
    check('§R3 B8: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §R4 SELECTION TARGETING — setLifecycleActionTarget is the sole writer.
// ============================================================================

{
    const { ctx, page, errors } = await newPage();
    await seed(page, 'LIVE');
    await page.evaluate(() => SessionManager.setSplitLayout(2));

    // Candidate arrivals do not steal a deliberate target.
    const target = await selectChip(page, 'LIVE');
    check('§R4: tapping a live chip targets it', target, 'LIVE');
    await offerCandidate(page, 'CA', { key_id: 'k1', auth_type: 'key' });
    await offerCandidate(page, 'CB', { key_id: 'k1', auth_type: 'key' });
    const afterArrivals = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        chipA: !!document.getElementById('tab-CA'),
        chipB: !!document.getElementById('tab-CB'),
    }));
    check('§R4: candidate arrivals do not steal the target',
        afterArrivals.target, 'LIVE');
    check('§R4: both candidate chips still exist',
        [afterArrivals.chipA, afterArrivals.chipB], [true, true]);

    // The candidate tap IS a selection, through the sole writer.
    const candTarget = await selectChip(page, 'CA');
    check('§R4: tapping a candidate chip makes it the target', candTarget, 'CA');

    // An unrelated removal preserves the target; a bogus id coerces to null.
    await page.evaluate(() => {
        SessionManager.removeSessionUI('CB');
    });
    const afterUnrelated = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        pending: SessionManager.lifecyclePendingTargetId,
    }));
    check('§R4: removing an unrelated session preserves the target',
        afterUnrelated.target, 'CA');

    await page.evaluate(() => SessionManager.setLifecycleActionTarget('NOPE'));
    check('§R4: a target id with no session is coerced to null',
        await page.evaluate(() => SessionManager.lifecycleActionTargetId),
        null);

    // Removing the TARGET clears it — the sole writer decides removal, and no
    // surviving session inherits a selection the user never made.
    await offerCandidate(page, 'CT', { key_id: 'k1', auth_type: 'key' });
    check('§R4: the fresh candidate can be targeted',
        await selectChip(page, 'CT'), 'CT');
    await page.evaluate(() => SessionManager.removeSessionUI('CT'));
    const afterTargetRemoved = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        decorated: document.querySelectorAll(
            '.session-tab.lifecycle-target').length,
        stillTargetAria: document.querySelectorAll(
            '.session-tab[aria-current="true"]').length,
    }));
    check('§R4: removing the target clears it to null',
        afterTargetRemoved.target, null);
    check('§R4: no chip keeps the target decoration or its aria-current',
        [afterTargetRemoved.decorated, afterTargetRemoved.stillTargetAria],
        [0, 0]);

    /*
     * A candidate Reset run to completion, watched through the target.
     *
     * The replacement session's arrival is a real connection, and the product
     * selects a newly connected session (setActivePane -> the sole writer). So
     * the target legitimately MOVES to the replacement — and the point of this
     * block is that the subsequent retirement of the old candidate does not
     * disturb it: removeSessionUI of a non-target session preserves the target,
     * exactly as the unrelated-removal case above, even when the session being
     * removed is the one the user originally selected.
     */
    await selectChip(page, 'CA');
    await openSheetByRetap(page, 'CA');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const armedReset = await page.evaluate(() => ({
        intents: Object.keys(SessionManager.resetIntents),
        target: SessionManager.lifecycleActionTargetId,
    }));
    check('§R4: the accepted candidate Reset arms exactly one intent',
        armedReset.intents.length, 1);
    check('§R4: the candidate is still the target while its Reset is in flight',
        armedReset.target, 'CA');

    const afterReplacement = await page.evaluate((rid) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'CA_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return {
            target: SessionManager.lifecycleActionTargetId,
            caStillThere: !!SessionManager.sessions.CA,
            retirements: Object.keys(SessionManager.candidateRetirements),
        };
    }, armedReset.intents[0]);
    check('§R4: the replacement becomes the selection, via the sole writer',
        afterReplacement.target, 'CA_NEW');
    check('§R4: the old candidate survives until its ack',
        afterReplacement.caStillThere, true);
    check('§R4: exactly one retirement is in flight',
        afterReplacement.retirements.length, 1);

    const afterRetire = await page.evaluate((retireRid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'CA', request_id: retireRid,
        });
        return {
            target: SessionManager.lifecycleActionTargetId,
            caGone: !SessionManager.sessions.CA,
            caChipGone: !document.getElementById('tab-CA'),
            decoratedOnNew: !!document.getElementById('tab-CA_NEW')
                ?.classList.contains('lifecycle-target'),
        };
    }, afterReplacement.retirements[0]);
    check('§R4: retiring the old candidate does NOT steal the target',
        afterRetire.target, 'CA_NEW');
    check('§R4: the old candidate and its chip are gone',
        [afterRetire.caGone, afterRetire.caChipGone], [true, true]);
    check('§R4: the surviving target keeps its decoration',
        afterRetire.decoratedOnNew, true);
    check('§R4: no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
