#!/usr/bin/env node
/*
 * Lifecycle entry-point matrix — Reconnect vs Reset vs Close, end to end.
 *
 * WHY THIS SUITE EXISTS. The owner tested the deployed build and reported that
 * "every Reset entry point still opens the same warning/modal wording and
 * behaviour as reconnect that loses tmux". Driving the LIVE frontend tree
 * (extracted from the running container) and the current SOURCE tree through the
 * same probe showed the difference:
 *
 *   each action alone, on BOTH trees: correct wording, correct emits
 *   Reconnect opened, then Reset opened, ONE Accept click:
 *     live   -> ['ssh_reconnect', 'ssh_disconnect', 'ssh_connect']
 *     source -> ['ssh_disconnect', 'ssh_connect']
 *
 * Live ran BOTH actions from one click on the Reset-labelled button, because
 * openSessionConfirm attached a fresh accept handler per open without detaching
 * the previous one while rewriting the shared title/body/label. So the user read
 * Reset's "without reattaching tmux" copy and got a reconnect as well. Current
 * source retires the pending confirmation first (closeSessionConfirm /
 * pendingSessionConfirmClose).
 *
 * WHAT IS PINNED, per entry point, as a full chain:
 *
 *   entry point -> handler -> socket event -> use_tmux / reconnect_tmux_name
 *               -> the tmux semantics that follow
 *
 * Every row is driven through the REAL production path — a real click on the
 * real control, the real confirm dialog, the real socket emit — never by calling
 * an internal directly. The emitted PAYLOAD is what decides tmux semantics
 * server-side (ssh_manager._build_transport reattaches iff reconnect_tmux_name
 * is present and use_tmux is true), so the payload is what is asserted rather
 * than a UI label.
 *
 * Surfaces covered: desktop contextual toolbar (#sessionActionsBtn), the chip
 * re-tap sheet (touch), the disconnected-candidate route, the touch action row
 * proxy (#touchReconnectBtn), and the per-session overlay Reconnect/Retry
 * button.
 *
 * Run: node tests/browser/lifecycle_entry_matrix.mjs   (from source/)
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
     * socket.on RECORDS its handlers instead of discarding them, and __server
     * invokes them. §7 needs real server replies (ssh_connected / ssh_error) to
     * arrive in a chosen ORDER, and the only honest way to test that is to drive
     * the app's own registered handlers rather than a copy of their bodies.
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
    // No real xterm in this harness: the subject is the lifecycle chain, and a
    // real terminal per seeded session would add nothing but startup cost.
    await page.evaluate(() => {
        TerminalManager.destroyTerminal = () => {};
        TerminalManager.createTerminal = () => {};
        TerminalManager.attachTerminal = () => {};
        TerminalManager.setupInputHandler = () => {};
        document.getElementById('sessionBar')?.classList.remove('hidden');
        /*
         * Record notifications, AFTER load.
         *
         * The init script's window.showNotification is replaced by app.js's real
         * one during load (app.js:24), so a recorder installed before load never
         * sees a call. This wraps the REAL function rather than replacing it, so
         * the production toast still renders and its behaviour is unchanged --
         * the recorder only observes.
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

/*
 * Seed one session through the real store + chip builder.
 *
 * Defaults describe a LIVE, tmux-attached, key-auth session: the case in which
 * Reconnect can swap the transport server-side, so a duplicate action would
 * reach the wire instead of being diverted to a credential form.
 */
async function seed(page, id, opts = {}) {
    await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = Object.assign({
            id, session_id: id, host: 'tiny.example', port: 22,
            username: 'sshdtest', authType: 'key', keyId: 'k1',
            jumpHostId: null, displayName: id, connected: true,
            // The tmux name uses the SERVER'S whitelist alphabet
            // (^[A-Za-z0-9_]{1,190}$, socket_events.handle_ssh_connect). A name
            // with a hyphen is one the server would reject outright, so a
            // fixture carrying one would assert a payload that could never work
            // — and the client now refuses it locally for the same reason.
            isPersistentCandidate: false, tmuxSessionName: `tmx_${id}`,
            terminalId: `term-${id}`, useTmux: true, viaJump: null,
            latencyMs: null,
        }, opts);
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, 'tiny.example', 'sshdtest');
        }
        // The wrapper removeSessionUI expects to find and drop.
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

// The dialog as the USER sees it: every field openSessionConfirm writes.
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

/*
 * Everything the emitted frames say about tmux. This is the semantic layer:
 * ssh_manager._build_transport reattaches the SAME tmux session iff use_tmux is
 * true AND reconnect_tmux_name is present; a fresh session is one with use_tmux
 * true and no name; a raw shell is use_tmux false.
 */
const readEmits = (page) => page.evaluate(() => window.__emits.map(e => ({
    ev: e.ev,
    session_id: e.payload?.session_id,
    use_tmux: e.payload?.use_tmux,
    reconnect_tmux_name: e.payload?.reconnect_tmux_name,
    hasPassword: Object.prototype.hasOwnProperty.call(e.payload || {}, 'password'),
})));

// Select a chip the way a user does: one tap routes through switchSession ->
// setLifecycleActionTarget, which is the sole writer of the action target.
async function selectChip(page, id) {
    await page.click(`#tab-${id}`);
    await page.waitForTimeout(60);
    return page.evaluate(() => SessionManager.lifecycleActionTargetId);
}

// Open the sheet: a SECOND tap on the already-selected chip (amendment v5 §3 —
// there is no separate in-row trigger on touch).
async function openSheetByRetap(page, id) {
    const already = await page.evaluate(() =>
        !document.getElementById('sessionActionsSheet')?.hidden);
    if (already) return true;
    await page.click(`#tab-${id}`);
    await page.waitForTimeout(60);
    return page.evaluate(() =>
        !document.getElementById('sessionActionsSheet')?.hidden);
}

/*
 * The DESKTOP route to the same sheet.
 *
 * MEASURED: #sessionActionsBtn computes display:none at BOTH tiers — style.css
 * :1791 sets it and only the touch block at :7909 repeats it, with no rule
 * anywhere turning it back on. So the ellipsis trigger is not a live entry point
 * on either shell; the chip gesture is the entry point at every tier, and
 * clicking a 0x0 node would only hang the suite. §0 pins that as a measurement
 * so this helper's choice is evidence, not convenience.
 */
async function openSheetOnDesktop(page, id) {
    return openSheetByRetap(page, id);
}

async function clickAction(page, action) {
    await page.click(`#sessionActionsSheet [data-lifecycle-action="${action}"]`);
    await page.waitForTimeout(80);
}

async function acceptDialog(page) {
    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(150);
}

// ============================================================================
// §0 Which lifecycle triggers actually exist, per tier. Every row in §1 drives
//    one of these, so the set is measured rather than assumed.
// ============================================================================
for (const [tier, w, h, touch] of [
    ['desktop 1280x800', 1280, 800, false],
    ['phone 390x844', 390, 844, true],
]) {
    const { ctx, page, errors } = await newPage({ touch, w, h });
    await seed(page, 'T1');
    await selectChip(page, 'T1');
    const trig = await page.evaluate(() => {
        const shape = (el) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { display: getComputedStyle(el).display,
                box: `${Math.round(b.width)}x${Math.round(b.height)}`,
                disabled: !!el.disabled };
        };
        return {
            isTouch: TerminalManager.isTouchShell(),
            ellipsis: shape(document.getElementById('sessionActionsBtn')),
            proxy: shape(document.getElementById('touchReconnectBtn')),
            canonical: shape(document.getElementById('sessionActionReconnect')),
        };
    });
    check(`§0 ${tier}: shell tier detected as expected`, trig.isTouch, touch);
    check(`§0 ${tier}: the ellipsis trigger is painted on neither shell`,
        trig.ellipsis.display, 'none');
    check(`§0 ${tier}: the Reconnect proxy IS painted`,
        trig.proxy.display !== 'none' && trig.proxy.box !== '0x0', true);
    check(`§0 ${tier}: the proxy mirrors the canonical control's enabled state`,
        trig.proxy.disabled, trig.canonical.disabled);
    check(`§0 ${tier}: a selected target enables the lifecycle actions`,
        trig.canonical.disabled, false);
    check(`§0 ${tier}: the chip gesture opens the sheet`,
        await openSheetByRetap(page, 'T1'), true);
    check(`§0 ${tier}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §1 The matrix. One row per (surface, action, session state), each driven
//    through the real control and asserted on the full chain.
//
//    The expected payloads state the tmux semantics:
//      RECONNECT  ssh_reconnect{session_id}  -> server rebuilds the transport
//                 under the SAME logical session and reattaches the SAME tmux
//                 name (handle_ssh_reconnect derives it server-side, so the
//                 frame carries no tmux field at all)
//      RESET      ssh_disconnect + ssh_connect{use_tmux:false} -> new session,
//                 NO reattach: the destructive route
//      CLOSE      ssh_disconnect only -> nothing replaces it
//      CANDIDATE RECONNECT
//                 ssh_connect{use_tmux:true, reconnect_tmux_name:<name>} ->
//                 fresh transport, SAME tmux reattached
// ============================================================================
const MATRIX = [
    {
        label: 'desktop shell · Reconnect · live',
        surface: 'desktop', action: 'reconnect', state: {},
        dialog: {
            accept: 'Reconnect', danger: false, icon: 'icon-plug-zap',
            titleHas: 'Reconnect session', bodyHas: 'reattached',
            bodyLacks: 'without reattaching',
        },
        emits: [{ ev: 'ssh_reconnect', tmuxName: undefined, useTmux: undefined }],
    },
    {
        label: 'desktop shell · Reset · live',
        surface: 'desktop', action: 'reset', state: {},
        dialog: {
            accept: 'End session and start fresh', danger: true,
            icon: 'icon-rotate-ccw',
            titleHas: 'End', bodyHas: 'terminated',
            bodyLacks: 'stay as they are',
        },
        // reconnect_tmux_name is EXPLICITLY null, not merely absent: Reset
        // asserts "do not reattach" on the payload rather than leaving the
        // server to infer it from a missing field.
        emits: [{ ev: 'ssh_disconnect' },
            { ev: 'ssh_connect', useTmux: false, tmuxName: null }],
    },
    {
        label: 'desktop shell · Close · live',
        surface: 'desktop', action: 'close', state: {},
        dialog: {
            accept: 'Close session', danger: true, icon: 'icon-x',
            titleHas: 'Close session', bodyHas: 'tmux session is closed',
            bodyLacks: 'fresh session starts',
        },
        emits: [{ ev: 'ssh_disconnect' }],
    },
    {
        label: 'chip re-tap sheet · Reconnect · live',
        surface: 'retap', action: 'reconnect', state: {},
        dialog: {
            accept: 'Reconnect', danger: false, icon: 'icon-plug-zap',
            titleHas: 'Reconnect session', bodyHas: 'reattached',
            bodyLacks: 'without reattaching',
        },
        emits: [{ ev: 'ssh_reconnect' }],
    },
    {
        label: 'chip re-tap sheet · Reset · live',
        surface: 'retap', action: 'reset', state: {},
        dialog: {
            accept: 'End session and start fresh', danger: true,
            icon: 'icon-rotate-ccw',
            titleHas: 'End', bodyHas: 'terminated',
            bodyLacks: 'stay as they are',
        },
        // reconnect_tmux_name is EXPLICITLY null, not merely absent: Reset
        // asserts "do not reattach" on the payload rather than leaving the
        // server to infer it from a missing field.
        emits: [{ ev: 'ssh_disconnect' },
            { ev: 'ssh_connect', useTmux: false, tmuxName: null }],
    },
    {
        label: 'chip re-tap sheet · Close · live',
        surface: 'retap', action: 'close', state: {},
        dialog: {
            accept: 'Close session', danger: true, icon: 'icon-x',
            titleHas: 'Close session', bodyHas: 'tmux session is closed',
            bodyLacks: 'fresh session starts',
        },
        emits: [{ ev: 'ssh_disconnect' }],
    },
    {
        // A PASSWORD session cannot be swapped server-side (no stored secret),
        // so Reconnect routes to the credential form CARRYING the reconnect
        // intent. No frame is emitted at all — and crucially, no ssh_connect
        // with a fresh tmux, which would be a silent Reset.
        label: 'chip re-tap sheet · Reconnect · live password session',
        surface: 'retap', action: 'reconnect',
        state: { authType: 'password', keyId: null },
        dialog: {
            accept: 'Enter password', danger: false, icon: 'icon-key-round',
            titleHas: 'Reconnect session', bodyHas: 'never stored',
            bodyLacks: 'without reattaching',
        },
        emits: [],
        thenModal: 'connectionModal',
    },
    {
        // A DISCONNECTED persistent candidate: Reconnect is a fresh connect that
        // reattaches the same tmux. No confirm dialog — there is nothing live to
        // lose, so the action runs directly.
        label: 'disconnected candidate · Reconnect',
        surface: 'retap', action: 'reconnect',
        state: { connected: false, isPersistentCandidate: true },
        dialog: null,
        emits: [{ ev: 'ssh_connect', useTmux: true, tmuxNameFromSession: true }],
    },
    {
        // A CANDIDATE Reset gets its OWN copy, because the live copy would be
        // wrong twice: nothing is connected to close, and the remote tmux
        // session is NOT closed (killing it needs a transport, and a candidate
        // has none -- close_session returns False after the row is deleted). The
        // copy must therefore promise neither closure nor a later return.
        label: 'disconnected candidate · Reset',
        surface: 'retap', action: 'reset',
        state: { connected: false, isPersistentCandidate: true },
        dialog: {
            accept: 'Drop and start fresh', danger: true,
            icon: 'icon-rotate-ccw',
            titleHas: 'drop the saved one',
            bodyHas: 'Nothing running on the remote host is affected',
            bodyLacks: 'terminated',
        },
        // A CANDIDATE Reset emits ONLY the fresh connect. It must NOT retire the
        // saved offer first: the row is the sole record that the tmux on the
        // host belongs to this user, so deleting it before the replacement
        // exists destroys the offer for good when the connect fails or is
        // cancelled. The retirement happens strictly on the MATCHING
        // ssh_connected -- asserted with exact ids and event ORDER in §11/§12,
        // and against the database in tests/test_candidate_reset_lifecycle.py.
        //
        // reconnect_tmux_name is EXPLICITLY null, not merely absent: Reset
        // asserts "do not reattach" on the payload rather than leaving the
        // server to infer it from a missing field.
        emits: [{ ev: 'ssh_connect', useTmux: false, tmuxName: null }],
    },
];

let row = 0;
for (const spec of MATRIX) {
    row += 1;
    const id = `M${row}`;
    // The desktop rows run on a FINE-POINTER shell, so each action is proven on
    // both shells rather than only on the touch one.
    const { ctx, page, errors } = spec.surface === 'desktop'
        ? await newPage({ touch: false, w: 1280, h: 800 })
        : await newPage();
    await seed(page, id, spec.state);
    const target = await selectChip(page, id);
    check(`§1 ${spec.label}: the chip becomes the action target`, target, id);

    const opened = spec.surface === 'desktop'
        ? await openSheetOnDesktop(page, id)
        : await openSheetByRetap(page, id);
    check(`§1 ${spec.label}: its sheet opens`, opened, true);

    await resetEmits(page);
    await clickAction(page, spec.action);

    if (spec.dialog) {
        const d = await readDialog(page);
        check(`§1 ${spec.label}: a confirmation opens`, d.open, true);
        check(`§1 ${spec.label}: accept label`, d.accept, spec.dialog.accept);
        check(`§1 ${spec.label}: danger styling`, d.danger, spec.dialog.danger);
        check(`§1 ${spec.label}: icon`, d.icon, spec.dialog.icon);
        check(`§1 ${spec.label}: title names the action`,
            d.title.includes(spec.dialog.titleHas), true);
        check(`§1 ${spec.label}: body says what happens to tmux`,
            d.body.includes(spec.dialog.bodyHas), true);
        // The owner's report in one assertion: this action's copy must NOT be
        // another action's copy.
        check(`§1 ${spec.label}: body is NOT the other action's copy`,
            d.body.includes(spec.dialog.bodyLacks), false);
        await acceptDialog(page);
    } else {
        const d = await readDialog(page);
        check(`§1 ${spec.label}: runs without a confirmation`, d.open, false);
    }

    const emits = await readEmits(page);
    check(`§1 ${spec.label}: emitted event sequence`,
        emits.map(e => e.ev), spec.emits.map(e => e.ev));
    for (let i = 0; i < spec.emits.length; i += 1) {
        const want = spec.emits[i];
        const got = emits[i] || {};
        if (Object.prototype.hasOwnProperty.call(want, 'useTmux')) {
            check(`§1 ${spec.label}: ${want.ev} use_tmux`,
                got.use_tmux, want.useTmux);
        }
        if (want.tmuxNameFromSession) {
            check(`§1 ${spec.label}: ${want.ev} reattaches the SAME tmux name`,
                got.reconnect_tmux_name, `tmx_${id}`);
        } else if (Object.prototype.hasOwnProperty.call(want, 'tmuxName')) {
            check(`§1 ${spec.label}: ${want.ev} reconnect_tmux_name`,
                got.reconnect_tmux_name, want.tmuxName);
        }
        check(`§1 ${spec.label}: ${want.ev} carries no password`,
            got.hasPassword, false);
    }
    if (spec.thenModal) {
        check(`§1 ${spec.label}: routes to #${spec.thenModal}`,
            await page.evaluate((m) =>
                !!document.getElementById(m)?.classList.contains('show'),
            spec.thenModal), true);
        // The reconnect INTENT must be recorded, or the form's submit would
        // build an ordinary connect and silently start a fresh tmux.
        // The intent lives in the request-keyed registry; the one owning the
        // credential modal is the one this action just armed.
        const meta = await page.evaluate(() => {
            const m = SessionManager.activeReconnectIntent();
            return m ? { sessionId: m.sessionId, tmux: m.tmuxSessionName,
                hasPassword: Object.prototype.hasOwnProperty.call(m, 'password') } : null;
        });
        check(`§1 ${spec.label}: reconnect intent recorded for this session`,
            meta && meta.sessionId, id);
        check(`§1 ${spec.label}: intent carries the tmux name to reattach`,
            meta && meta.tmux, `tmx_${id}`);
        check(`§1 ${spec.label}: intent holds no secret`,
            meta && meta.hasPassword, false);
        check(`§1 ${spec.label}: Reset's meta is NOT set`,
            await page.evaluate(() => SessionManager.pendingResetMeta), null);
    }
    check(`§1 ${spec.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 The reported defect itself: opening one confirmation then another must
//    leave EXACTLY ONE armed action — the one whose copy is on screen.
//
//    Measured on the LIVE tree (extracted from the running container) vs current
//    SOURCE, driving requestReconnect then requestResetSession and clicking
//    Accept once:
//      live   -> ['ssh_reconnect', 'ssh_disconnect', 'ssh_connect']
//      source -> ['ssh_disconnect', 'ssh_connect']
//    So live ran BOTH actions from one click on the Reset-labelled button. That
//    is what "Reset behaves like a reconnect that loses tmux" looked like from
//    the outside: Reset's copy, Reconnect's effect, both at once.
//
//    HOW THE SECOND ACTION IS REACHED, and why not with a pointer. Measured:
//    while the confirmation is open, #sessionConfirmBackdrop (z-index 2200)
//    covers the whole viewport and the sheet (2000) is `hidden` + `inert`, so a
//    real click on the second row or on the chip is intercepted by the backdrop
//    — elementFromPoint at both returns sessionConfirmBackdrop, and the row is
//    not even focusable. That interception is CORRECT modal behaviour and is
//    itself asserted below. The second action is therefore invoked the way any
//    non-pointer route would reach it (row.click(), which skips hit-testing) —
//    which is also exactly how the two openSessionConfirm calls stack in the
//    live defect. What is under test is the DIALOG's ownership of its armed
//    action, not the backdrop.
// ============================================================================
const PAIRS = [
    {
        label: 'Reconnect then Reset',
        first: 'reconnect', second: 'reset',
        shows: 'End session and start fresh',
        emits: ['ssh_disconnect', 'ssh_connect'],
        // The stale action's frame must be absent, named so a failure says why.
        forbidden: 'ssh_reconnect',
    },
    {
        label: 'Reset then Reconnect',
        first: 'reset', second: 'reconnect',
        shows: 'Reconnect',
        emits: ['ssh_reconnect'],
        forbidden: 'ssh_connect',
    },
    {
        label: 'Reset then Close',
        first: 'reset', second: 'close',
        shows: 'Close session',
        emits: ['ssh_disconnect'],
        forbidden: 'ssh_connect',
    },
    {
        label: 'Close then Reset',
        first: 'close', second: 'reset',
        shows: 'End session and start fresh',
        emits: ['ssh_disconnect', 'ssh_connect'],
        forbidden: null,
    },
    {
        label: 'Reconnect then Close',
        first: 'reconnect', second: 'close',
        shows: 'Close session',
        emits: ['ssh_disconnect'],
        forbidden: 'ssh_reconnect',
    },
];

// Invoke a sheet row while a confirmation is already open. Real pointer input
// cannot reach it (the backdrop intercepts, by design), so this uses the
// element's own activation — the same route the stacked openSessionConfirm calls
// take in the live defect.
const invokeRowBehindDialog = (page, action) => page.evaluate((a) => {
    document.querySelector(
        `#sessionActionsSheet [data-lifecycle-action="${a}"]`).click();
}, action);

let pairRow = 0;
for (const pair of PAIRS) {
    pairRow += 1;
    const id = `P${pairRow}`;
    const { ctx, page, errors } = await newPage();
    await seed(page, id);
    await selectChip(page, id);
    await resetEmits(page);

    // Open the first action's confirmation through its real row...
    await openSheetByRetap(page, id);
    await clickAction(page, pair.first);
    const firstDialog = await readDialog(page);
    check(`§2 ${pair.label}: the first action opens a confirmation`,
        firstDialog.open, true);

    // The modal really is modal: prove the backdrop intercepts pointer input and
    // the sheet is inert, so nothing below can be clicked by a user.
    const guarded = await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        const row = document.querySelector(
            '#sessionActionsSheet [data-lifecycle-action="reset"]');
        const r = row.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return { sheetHidden: sheet.hidden, sheetInert: sheet.hasAttribute('inert'),
            hitId: hit ? (hit.id || hit.className) : null };
    });
    check(`§2 ${pair.label}: the sheet is hidden and inert behind the dialog`,
        guarded.sheetHidden && guarded.sheetInert, true);
    check(`§2 ${pair.label}: the backdrop intercepts pointer input`,
        guarded.hitId, 'sessionConfirmBackdrop');

    // ...then the second, on top of it, without answering the first.
    await invokeRowBehindDialog(page, pair.second);
    await page.waitForTimeout(100);
    const secondDialog = await readDialog(page);
    check(`§2 ${pair.label}: still exactly one dialog, showing the second action`,
        secondDialog.accept, pair.shows);
    check(`§2 ${pair.label}: exactly one confirm element in the document`,
        await page.evaluate(() =>
            document.querySelectorAll('#sessionConfirm').length), 1);

    // ONE click. Whatever runs, runs from this.
    await acceptDialog(page);
    const emits = await readEmits(page);
    check(`§2 ${pair.label}: one click runs ONLY the second action`,
        emits.map(e => e.ev), pair.emits);
    if (pair.forbidden) {
        check(`§2 ${pair.label}: the retired action's ${pair.forbidden} never fires`,
            emits.some(e => e.ev === pair.forbidden), false);
    }
    // Nothing may stay armed afterwards, or a later unrelated Accept would fire
    // a stale action.
    check(`§2 ${pair.label}: no confirmation left pending`,
        await page.evaluate(() => !!SessionManager.pendingSessionConfirmClose),
        false);
    check(`§2 ${pair.label}: the dialog closed and re-armed inert`,
        await page.evaluate(() => {
            const d = document.getElementById('sessionConfirm');
            return d.hidden && d.hasAttribute('inert');
        }), true);
    check(`§2 ${pair.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 Rapid repeated presses of the SAME action. D3's "chặn hành động trùng khi
//    bấm nhanh nhiều lần" — a double tap on a touch shell must not run the
//    action twice, and must not reach the wire twice.
// ============================================================================
for (const action of ['reconnect', 'reset', 'close']) {
    const id = `R${action[0].toUpperCase()}`;
    const { ctx, page, errors } = await newPage();
    await seed(page, id);
    await selectChip(page, id);
    await resetEmits(page);

    // Two opens of the same action, then ONE accept.
    await openSheetByRetap(page, id);
    await clickAction(page, action);
    await invokeRowBehindDialog(page, action);
    await page.waitForTimeout(100);
    check(`§3 ${action}×2: one dialog is showing`,
        (await readDialog(page)).open, true);
    await acceptDialog(page);

    const expected = { reconnect: ['ssh_reconnect'],
        reset: ['ssh_disconnect', 'ssh_connect'],
        close: ['ssh_disconnect'] }[action];
    check(`§3 ${action}×2: one accept produces one action's frames`,
        (await readEmits(page)).map(e => e.ev), expected);

    // And a SECOND click on the accept button — landing after the action has
    // already run — must add nothing, because the handler was detached first.
    await page.evaluate(() => {
        const d = document.getElementById('sessionConfirm');
        // Un-hide without re-arming: this is precisely the stale-listener state
        // the fix prevents, so if a handler survived, this click would fire it.
        d.hidden = false;
        d.removeAttribute('inert');
        document.getElementById('sessionConfirmBackdrop').hidden = true;
    });
    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(120);
    check(`§3 ${action}×2: a late click on a stale dialog fires nothing`,
        (await readEmits(page)).map(e => e.ev), expected);
    check(`§3 ${action}×2: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 Cancel and Escape must run NOTHING, on every action. A confirmation that
//    leaks its action on dismissal is the same class of defect as one that
//    leaks it to the next dialog.
// ============================================================================
for (const action of ['reconnect', 'reset', 'close']) {
    for (const route of ['cancel', 'escape', 'backdrop']) {
        const id = `C-${action}-${route}`;
        const { ctx, page, errors } = await newPage();
        await seed(page, id);
        await selectChip(page, id);
        await resetEmits(page);
        await openSheetByRetap(page, id);
        await clickAction(page, action);
        check(`§4 ${action} / ${route}: a confirmation is open`,
            (await readDialog(page)).open, true);

        if (route === 'cancel') {
            await page.click('#sessionConfirmCancel');
        } else if (route === 'escape') {
            await page.keyboard.press('Escape');
        } else {
            /*
             * A backdrop tap is a click on the backdrop AWAY from the card. The
             * card is centred on top of it, so clicking the backdrop's own
             * centre lands on #sessionConfirmBody instead — Playwright reports
             * exactly that interception. A user taps the exposed area, which is
             * what these coordinates are: just inside the top-left corner,
             * measured to be outside the card's box.
             */
            const spot = await page.evaluate(() => {
                const card = document.getElementById('sessionConfirm')
                    .getBoundingClientRect();
                const x = 8;
                const y = 8;
                return { x, y,
                    outsideCard: x < card.left || y < card.top };
            });
            check(`§4 ${action} / ${route}: the tap point is outside the card`,
                spot.outsideCard, true);
            await page.mouse.click(spot.x, spot.y);
        }
        await page.waitForTimeout(120);

        check(`§4 ${action} / ${route}: emits nothing`,
            (await readEmits(page)).map(e => e.ev), []);
        check(`§4 ${action} / ${route}: the session survives`,
            await page.evaluate((s) => !!SessionManager.sessions[s], id), true);
        check(`§4 ${action} / ${route}: the dialog is closed and inert`,
            await page.evaluate(() => {
                const d = document.getElementById('sessionConfirm');
                return d.hidden && d.hasAttribute('inert');
            }), true);
        check(`§4 ${action} / ${route}: nothing left pending`,
            await page.evaluate(() => !!SessionManager.pendingSessionConfirmClose),
            false);
        check(`§4 ${action} / ${route}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

// ============================================================================
// §5 The PASSWORD PERSISTENT CANDIDATE — the owner's actual route.
//
//    After a container restart the in-RAM registry is empty while the DB still
//    holds persistent rows, so restore_user_sessions emits
//    persistent_session_available for every one of them: EVERY session comes
//    back as a candidate. The key/Tailscale candidate reconnects with no form
//    (§1 covers it); a PASSWORD candidate has to go through the credential
//    modal, and that is the route that behaved like Reset:
//
//      * prefillConnectionForm removed the chip BEFORE the form opened, so
//        cancelling left nothing and a failed connect left nothing at all;
//      * the tmux name lived in a shared global the submit path could blank,
//        and the emit became use_tmux with NO name -- a NEW tmux session;
//      * the modal was identical to the one Reset opens.
//
//    Driven through the real chip gesture and the real sheet row.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();
    await seed(page, 'PC', {
        connected: false, isPersistentCandidate: true,
        authType: 'password', keyId: null,
    });
    await selectChip(page, 'PC');
    await openSheetByRetap(page, 'PC');
    await resetEmits(page);
    await clickAction(page, 'reconnect');

    const state = await page.evaluate(() => {
        const intent = SessionManager.activeReconnectIntent();
        return {
            confirmOpen: !document.getElementById('sessionConfirm').hidden,
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            chipStillThere: !!document.getElementById('tab-PC'),
            offerStillKnown: !!SessionManager.sessions.PC,
            target: SessionManager.lifecycleActionTargetId,
            host: document.getElementById('hostInput')?.value || null,
            tmuxChecked: !!document.getElementById('useTmuxCheck')?.checked,
            intentSession: intent && intent.sessionId,
            intentTmux: intent && intent.tmuxSessionName,
            intentFromCandidate: intent && intent.fromCandidate,
            intentRetires: intent && intent.retireOnSuccess,
            intentHasPassword: intent
                ? Object.prototype.hasOwnProperty.call(intent, 'password') : null,
            resetMeta: SessionManager.pendingResetMeta,
            banner: !document.getElementById('connectionFormIntent')?.hidden,
            bannerTitle: document.getElementById('connectionFormIntentTitle')
                ?.textContent || '',
            bannerDetail: document.getElementById('connectionFormIntentDetail')
                ?.textContent || '',
            bannerIcon: document.getElementById('connectionFormIntentIcon')
                ?.getAttribute('href')?.split('#')[1] || '',
        };
    });
    // A candidate has nothing live to lose, so there is no confirmation step --
    // the form IS the gate, and it must say what it is for.
    check('§5 password candidate: no destructive confirmation is shown',
        state.confirmOpen, false);
    check('§5 password candidate: the credential form opens', state.modal, true);
    check('§5 password candidate: THE CHIP SURVIVES the form opening',
        state.chipStillThere, true);
    check('§5 password candidate: the offer is still on file',
        state.offerStillKnown, true);
    check('§5 password candidate: it is still the lifecycle target',
        state.target, 'PC');
    check('§5 password candidate: the form is prefilled for that host',
        state.host, 'tiny.example');
    check('§5 password candidate: tmux is pre-checked (reattach, not fresh)',
        state.tmuxChecked, true);
    check('§5 password candidate: the intent names THIS session',
        state.intentSession, 'PC');
    check('§5 password candidate: the intent carries the EXACT tmux name',
        state.intentTmux, 'tmx_PC');
    check('§5 password candidate: the intent knows it came from a candidate',
        state.intentFromCandidate, true);
    check('§5 password candidate: success will retire the old chip',
        state.intentRetires, true);
    check('§5 password candidate: the intent holds no secret',
        state.intentHasPassword, false);
    check('§5 password candidate: Reset\'s meta is NOT set', state.resetMeta, null);
    // The form states which action it serves, for as long as it is open. A toast
    // is transient; the modal is not.
    check('§5 password candidate: the form states the RECONNECT intent',
        state.banner, true);
    check('§5 password candidate: the banner says the session is kept',
        state.bannerTitle.includes('kept'), true);
    check('§5 password candidate: the banner names the tmux being reattached',
        state.bannerDetail.includes('tmx_PC'), true);
    check('§5 password candidate: the banner carries the Reconnect icon',
        state.bannerIcon, 'icon-plug-zap');
    check('§5 password candidate: nothing is emitted before submit',
        (await readEmits(page)).map(e => e.ev), []);

    // Cancelling must leave the user exactly where they were, and leave no
    // intent for a later ordinary Connect to inherit.
    await page.click('#cancelConnectionBtn');
    await page.waitForTimeout(100);
    const afterCancel = await page.evaluate(() => ({
        chipStillThere: !!document.getElementById('tab-PC'),
        offerStillKnown: !!SessionManager.sessions.PC,
        activeIntent: SessionManager.activeReconnectIntent(),
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.PC),
        registrySize: Object.keys(SessionManager.reconnectIntents).length,
        banner: !document.getElementById('connectionFormIntent')?.hidden,
        emits: window.__emits.length,
    }));
    check('§5 cancel: the chip is STILL there', afterCancel.chipStillThere, true);
    check('§5 cancel: the offer is still on file',
        afterCancel.offerStillKnown, true);
    check('§5 cancel: no intent is left armed', afterCancel.activeIntent, null);
    check('§5 cancel: the session claim is released', afterCancel.claimed, false);
    check('§5 cancel: the registry is empty', afterCancel.registrySize, 0);
    check('§5 cancel: the intent banner is hidden', afterCancel.banner, false);
    check('§5 cancel: nothing was emitted', afterCancel.emits, 0);

    // And the release must be real: pressing Reconnect again has to work, or the
    // one-owner guard has permanently disabled the session.
    await openSheetByRetap(page, 'PC');
    await clickAction(page, 'reconnect');
    check('§5 cancel: Reconnect can be pressed AGAIN afterwards',
        await page.evaluate(() => !!SessionManager.activeReconnectIntent()), true);
    check('§5 password candidate: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §6 The OVERLAY — the fifth surface, and the one a user meets on a dead
//    terminal. showReconnectOverlay builds it on every 'disconnected' status.
//
//    Its button used to call prefillConnectionForm DIRECTLY, bypassing
//    requestReconnect entirely: no separated dialog copy, none of the candidate
//    decisions (key/Tailscale need no form at all), and the connect modal opened
//    unconditionally. From the outside that is "every control opens the same
//    lose-tmux modal". It must route through the ONE lifecycle owner instead.
// ============================================================================
for (const [label, state, expected] of [
    ['key candidate', { connected: false, isPersistentCandidate: true },
        { emits: ['ssh_connect'], modal: false }],
    ['password candidate',
        { connected: false, isPersistentCandidate: true,
            authType: 'password', keyId: null },
        { emits: [], modal: true }],
]) {
    const { ctx, page, errors } = await newPage();
    await seed(page, 'OV', state);
    // The overlay is built by the REAL production code, from the REAL status
    // transition — not by a synthetic copy of its markup. The wrapper is taken
    // out of `unassigned` first: that class is display:none, and this harness
    // has no real pane assignment (no xterm), so without it the button exists
    // but paints nowhere and a real click cannot reach it.
    const built = await page.evaluate(() => {
        document.getElementById('term-OV')?.classList.remove('unassigned');
        SessionManager.showReconnectOverlay('OV');
        const btn = document.querySelector('#term-OV .session-overlay-card button');
        return { hasOverlay: !!document.querySelector('#term-OV .session-overlay'),
            label: btn ? btn.textContent : null };
    });
    check(`§6 ${label}: the overlay is built for a disconnected session`,
        built.hasOverlay, true);
    check(`§6 ${label}: its button is labelled Reconnect`, built.label, 'Reconnect');

    await resetEmits(page);
    await page.click('#term-OV .session-overlay-card button');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({
        emits: window.__emits.map(e => ({ ev: e.ev,
            useTmux: e.payload?.use_tmux,
            tmux: e.payload?.reconnect_tmux_name })),
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        chipStillThere: !!document.getElementById('tab-OV'),
        intentTmux: (SessionManager.activeReconnectIntent()
            || Object.values(SessionManager.reconnectIntents)[0] || {})
            .tmuxSessionName || null,
    }));
    check(`§6 ${label}: the overlay routes through the lifecycle owner`,
        after.emits.map(e => e.ev), expected.emits);
    if (expected.emits.length) {
        check(`§6 ${label}: it REATTACHES, never a fresh tmux`,
            [after.emits[0].useTmux, after.emits[0].tmux], [true, 'tmx_OV']);
    } else {
        check(`§6 ${label}: it opens the credential form`, after.modal, true);
    }
    check(`§6 ${label}: the chip is not destroyed by pressing it`,
        after.chipStillThere, true);
    check(`§6 ${label}: the intent carries the exact tmux name`,
        after.intentTmux, 'tmx_OV');
    check(`§6 ${label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §7 CONCURRENCY and REQUEST CORRELATION.
//
//    The intent registry is keyed by the client_request_id that travels on the
//    wire. Before that, a single slot held ONE intent, and every one of these
//    cases was broken:
//
//      * two candidates reconnecting -> the second overwrote the first, so the
//        first stayed claimed forever (its session permanently
//        un-reconnectable) while the second's reply retired the wrong chip;
//      * replies arriving B-then-A -> the wrong chip was retired;
//      * an ORDINARY connect completing in between -> it consumed the reconnect
//        intent and adopted a candidate's transcript into an unrelated session.
//
//    Driven through the app's OWN registered socket handlers (window.__server),
//    so the ordering under test is the real ordering.
// ============================================================================
{
    // ---- B then A: reversed response order retires each its own chip --------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'CA', {
        connected: false, isPersistentCandidate: true,
        host: 'a.example', tmuxSessionName: 'tmx_CA',
    });
    await seed(page, 'CB', {
        connected: false, isPersistentCandidate: true,
        host: 'b.example', tmuxSessionName: 'tmx_CB',
    });
    await resetEmits(page);
    // Both are key candidates, so both reconnect directly: two ssh_connects in
    // flight at once, which is the shape a single-slot design could not hold.
    const armed = await page.evaluate(() => {
        SessionManager.directReconnect('CA');
        SessionManager.directReconnect('CB');
        const ids = Object.keys(SessionManager.reconnectIntents);
        return {
            count: ids.length,
            bySession: ids.reduce((acc, id) => {
                acc[SessionManager.reconnectIntents[id].sessionId] = id;
                return acc;
            }, {}),
            emits: window.__emits.map(e => ({
                id: e.payload?.client_request_id,
                tmux: e.payload?.reconnect_tmux_name,
            })),
        };
    });
    check('§7 A/B: BOTH intents are registered, neither overwritten',
        armed.count, 2);
    check('§7 A/B: each carries its OWN tmux name',
        armed.emits.map(e => e.tmux).sort(), ['tmx_CA', 'tmx_CB']);
    check('§7 A/B: each frame carries its own request id',
        armed.emits.every(e => e.id === armed.bySession.CA
            || e.id === armed.bySession.CB), true);

    // B's reply lands FIRST. It must retire B and leave A completely alone.
    const afterB = await page.evaluate((ids) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'NEW_B', host: 'b.example',
            port: 22, username: 'sshdtest', client_request_id: ids.CB,
            use_tmux: true, tmux_session_name: 'tmx_CB', auth_type: 'key',
        });
        return {
            oldBGone: !SessionManager.sessions.CB,
            oldAStillThere: !!SessionManager.sessions.CA,
            chipAStillThere: !!document.getElementById('tab-CA'),
            newBExists: !!SessionManager.sessions.NEW_B,
            remaining: Object.keys(SessionManager.reconnectIntents).length,
            aStillClaimed: !!(SessionManager.reconnectingSessions
                && SessionManager.reconnectingSessions.CA),
        };
    }, armed.bySession);
    check('§7 B first: B\'s own chip is retired', afterB.oldBGone, true);
    check('§7 B first: A is UNTOUCHED in the store', afterB.oldAStillThere, true);
    check('§7 B first: A\'s chip is still painted', afterB.chipAStillThere, true);
    check('§7 B first: B\'s replacement session exists', afterB.newBExists, true);
    check('§7 B first: only A\'s intent remains', afterB.remaining, 1);
    check('§7 B first: A is still claimed (its request is still in flight)',
        afterB.aStillClaimed, true);

    // Then A's reply. It must retire A, and only A.
    const afterA = await page.evaluate((ids) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'NEW_A', host: 'a.example',
            port: 22, username: 'sshdtest', client_request_id: ids.CA,
            use_tmux: true, tmux_session_name: 'tmx_CA', auth_type: 'key',
        });
        return {
            oldAGone: !SessionManager.sessions.CA,
            newAExists: !!SessionManager.sessions.NEW_A,
            newBStillThere: !!SessionManager.sessions.NEW_B,
            registryEmpty: Object.keys(SessionManager.reconnectIntents).length === 0,
            noClaims: Object.keys(SessionManager.reconnectingSessions || {}).length === 0,
        };
    }, armed.bySession);
    check('§7 A second: A\'s chip is retired', afterA.oldAGone, true);
    check('§7 A second: A\'s replacement exists', afterA.newAExists, true);
    check('§7 A second: B\'s replacement is untouched', afterA.newBStillThere, true);
    check('§7 A second: the registry is empty again', afterA.registryEmpty, true);
    check('§7 A second: no session is left claimed', afterA.noClaims, true);
    check('§7 A/B: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- an ORDINARY connect completing between two reconnects -------------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'IA', {
        connected: false, isPersistentCandidate: true,
        host: 'a.example', tmuxSessionName: 'tmx_IA',
    });
    await resetEmits(page);
    const ids = await page.evaluate(() => {
        SessionManager.directReconnect('IA');
        const id = Object.keys(SessionManager.reconnectIntents)[0];
        // An unrelated ordinary connect finishes first, with a request id this
        // client never minted as a reconnect.
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'ORD', host: 'other.example',
            port: 22, username: 'someone', client_request_id: 'req_unrelated',
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
        return { reconnectId: id };
    });
    const afterOrdinary = await page.evaluate(() => ({
        candidateStillThere: !!SessionManager.sessions.IA,
        chipStillThere: !!document.getElementById('tab-IA'),
        ordinaryExists: !!SessionManager.sessions.ORD,
        intentSurvived: Object.keys(SessionManager.reconnectIntents).length,
        // The candidate's transcript must NOT have been adopted by the unrelated
        // session: that was the concrete failure of an unkeyed handoff.
        ordinaryTranscript: (window.TerminalManager
            && TerminalManager.transcripts
            && TerminalManager.transcripts.ORD) || null,
    }));
    check('§7 interleaved: the unrelated connect did NOT retire the candidate',
        afterOrdinary.candidateStillThere, true);
    check('§7 interleaved: its chip is still painted',
        afterOrdinary.chipStillThere, true);
    check('§7 interleaved: the unrelated session was created normally',
        afterOrdinary.ordinaryExists, true);
    check('§7 interleaved: the reconnect intent is still armed',
        afterOrdinary.intentSurvived, 1);
    check('§7 interleaved: no transcript was adopted into the unrelated session',
        afterOrdinary.ordinaryTranscript, null);

    // The reconnect's own reply still works afterwards.
    const afterOwn = await page.evaluate((id) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'NEW_IA', host: 'a.example',
            port: 22, username: 'sshdtest', client_request_id: id,
            use_tmux: true, tmux_session_name: 'tmx_IA', auth_type: 'key',
        });
        return { oldGone: !SessionManager.sessions.IA,
            newExists: !!SessionManager.sessions.NEW_IA,
            registryEmpty: Object.keys(SessionManager.reconnectIntents).length === 0 };
    }, ids.reconnectId);
    check('§7 interleaved: the reconnect still completes correctly after it',
        [afterOwn.oldGone, afterOwn.newExists, afterOwn.registryEmpty],
        [true, true, true]);
    check('§7 interleaved: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- an error for A must not disturb a Reset form B ---------------------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'EA', {
        connected: false, isPersistentCandidate: true,
        host: 'a.example', tmuxSessionName: 'tmx_EA',
    });
    await seed(page, 'EB', { authType: 'password', keyId: null });
    await resetEmits(page);
    const setup = await page.evaluate(() => {
        SessionManager.directReconnect('EA');                 // in flight
        SessionManager.requestResetSession('EB');             // confirm dialog
        document.getElementById('sessionConfirmAccept').click();  // -> Reset form
        return {
            reconnectId: Object.keys(SessionManager.reconnectIntents)[0],
            resetArmed: !!SessionManager.pendingResetMeta,
            banner: !document.getElementById('connectionFormIntent')?.hidden,
        };
    });
    check('§7 error scope: a Reset form is open and armed', setup.resetArmed, true);
    check('§7 error scope: its banner is showing', setup.banner, true);

    const afterError = await page.evaluate((id) => {
        window.__server('ssh_error', {
            error: 'Connection failed', client_request_id: id,
        });
        return {
            resetStillArmed: !!SessionManager.pendingResetMeta,
            bannerStillThere: !document.getElementById('connectionFormIntent')?.hidden,
            bannerTitle: document.getElementById('connectionFormIntentTitle')
                ?.textContent || '',
            reconnectGone: Object.keys(SessionManager.reconnectIntents).length === 0,
            candidateStillThere: !!SessionManager.sessions.EA,
            claimReleased: !(SessionManager.reconnectingSessions
                && SessionManager.reconnectingSessions.EA),
        };
    }, setup.reconnectId);
    check('§7 error scope: the failed reconnect\'s intent is dropped',
        afterError.reconnectGone, true);
    check('§7 error scope: its candidate survives, still reconnectable',
        [afterError.candidateStillThere, afterError.claimReleased], [true, true]);
    check('§7 error scope: the unrelated Reset is STILL armed',
        afterError.resetStillArmed, true);
    check('§7 error scope: the Reset banner is STILL showing',
        afterError.bannerStillThere, true);
    check('§7 error scope: and it still says RESET',
        afterError.bannerTitle.includes('Reset'), true);
    check('§7 error scope: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- one endpoint, SEVERAL tmux candidates -----------------------------
    // The old submit path swept every candidate matching host/port/user, so
    // reconnecting one silently destroyed the offers for the others. The tmux
    // NAME is what distinguishes them, and the sweep ignored it.
    const { ctx, page, errors } = await newPage();
    for (const [id, tmux] of [['MA', 'tmx_MA'], ['MB', 'tmx_MB'],
        ['MC', 'tmx_MC']]) {
        await seed(page, id, {
            connected: false, isPersistentCandidate: true,
            host: 'same.example', port: 22, username: 'sshdtest',
            tmuxSessionName: tmux,
        });
    }
    await resetEmits(page);
    const multi = await page.evaluate(() => {
        SessionManager.directReconnect('MA');
        const id = Object.keys(SessionManager.reconnectIntents)[0];
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'NEW_MA', host: 'same.example',
            port: 22, username: 'sshdtest', client_request_id: id,
            use_tmux: true, tmux_session_name: 'tmx_MA', auth_type: 'key',
        });
        return {
            reconnectedGone: !SessionManager.sessions.MA,
            siblingsAlive: [!!SessionManager.sessions.MB,
                !!SessionManager.sessions.MC],
            siblingChips: [!!document.getElementById('tab-MB'),
                !!document.getElementById('tab-MC')],
            newExists: !!SessionManager.sessions.NEW_MA,
        };
    });
    check('§7 same endpoint: the reconnected candidate retires',
        multi.reconnectedGone, true);
    check('§7 same endpoint: its SIBLINGS at the same endpoint survive',
        multi.siblingsAlive, [true, true]);
    check('§7 same endpoint: and their chips are still painted',
        multi.siblingChips, [true, true]);
    check('§7 same endpoint: the replacement session exists',
        multi.newExists, true);
    check('§7 same endpoint: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- a candidate with NO valid tmux identity ---------------------------
    // A persisted row can carry is_persistent=1 with tmux_session_name NULL.
    // Reconnecting it would emit use_tmux:true with reconnect_tmux_name:null,
    // which the server reads as "create a NEW tmux session" -- Reset's outcome
    // under Reconnect's label. It must REFUSE, and preserve the row.
    for (const [label, tmux] of [['null name', null], ['empty name', ''],
        ['name the server would reject', 'bad-name!']]) {
        const { ctx, page, errors } = await newPage();
        await seed(page, 'NT', {
            connected: false, isPersistentCandidate: true,
            tmuxSessionName: tmux, useTmux: !!tmux,
        });
        await selectChip(page, 'NT');
        await openSheetByRetap(page, 'NT');
        await resetEmits(page);
        await clickAction(page, 'reconnect');
        const refused = await page.evaluate(() => ({
            emits: window.__emits.map(e => e.ev),
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            intents: Object.keys(SessionManager.reconnectIntents).length,
            offerStillKnown: !!SessionManager.sessions.NT,
            chipStillThere: !!document.getElementById('tab-NT'),
            told: window.__notes.some(n => n.t === 'error'),
        }));
        check(`§7 ${label}: NOTHING is emitted`, refused.emits, []);
        check(`§7 ${label}: no credential form is opened`, refused.modal, false);
        check(`§7 ${label}: no intent is armed`, refused.intents, 0);
        check(`§7 ${label}: the offer is PRESERVED`,
            [refused.offerStillKnown, refused.chipStillThere], [true, true]);
        check(`§7 ${label}: the user is told why`, refused.told, true);
        check(`§7 ${label}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

{
    // ---- a cancelled action must not leak into the next New Connection -----
    for (const [label, arm, forbidden] of [
        ['cancelled reconnect', 'reconnect', 'reconnect_tmux_name'],
        ['cancelled reset', 'reset', 'use_tmux'],
    ]) {
        const { ctx, page, errors } = await newPage();
        await seed(page, 'LK', arm === 'reconnect'
            ? { connected: false, isPersistentCandidate: true,
                authType: 'password', keyId: null }
            : { authType: 'password', keyId: null });
        await selectChip(page, 'LK');
        await openSheetByRetap(page, 'LK');
        await clickAction(page, arm);
        // Reset confirms first; the candidate reconnect goes straight to the form.
        if (arm === 'reset') {
            await page.click('#sessionConfirmAccept');
            await page.waitForTimeout(120);
        }
        check(`§7 ${label}: the form is open with an intent`,
            await page.evaluate(() => !!SessionManager.pendingResetMeta
                || !!SessionManager.activeReconnectIntent()), true);

        await page.click('#closeConnectionModal');
        await page.waitForTimeout(100);
        await resetEmits(page);
        // Now an ORDINARY New Connection, filled and submitted by hand.
        const payload = await page.evaluate(() => {
            SessionManager.resetConnectionModalIntent();
            document.getElementById('hostInput').value = 'fresh.example';
            document.getElementById('usernameInput').value = 'freshuser';
            document.getElementById('portInput').value = '22';
            document.getElementById('authTypeSelect').value = 'password';
            document.getElementById('passwordInput').value = 'pw';
            document.getElementById('useTmuxCheck').checked = true;
            document.getElementById('connectionForm')
                .dispatchEvent(new Event('submit', { cancelable: true }));
            const frame = window.__emits.find(e => e.ev === 'ssh_connect');
            return {
                host: frame?.payload?.host,
                useTmux: frame?.payload?.use_tmux,
                tmux: frame?.payload?.reconnect_tmux_name,
                banner: !document.getElementById('connectionFormIntent')?.hidden,
            };
        });
        check(`§7 ${label}: the new connect goes to its OWN host`,
            payload.host, 'fresh.example');
        if (forbidden === 'reconnect_tmux_name') {
            check(`§7 ${label}: it inherits NO reconnect_tmux_name`,
                payload.tmux === undefined || payload.tmux === null, true);
        } else {
            check(`§7 ${label}: it is NOT forced to use_tmux:false`,
                payload.useTmux, true);
        }
        check(`§7 ${label}: the intent banner is hidden`, payload.banner, false);
        check(`§7 ${label}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

// ============================================================================
// §8 OWNERSHIP INVARIANTS — static, because they are about which code is
//    ALLOWED to write a field, and no runtime path can demonstrate the absence
//    of a write.
//
//    Both invariants below were real audit findings, and both are the same class
//    of bug: state that looks scoped but is written blind.
// ============================================================================
{
    const sm = fs.readFileSync(
        path.join(ROOT, 'static/js/session-manager.js'), 'utf8');
    const appjs = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');

    /*
     * `activeReconnectRequestId` may be ASSIGNED in exactly two places: the
     * claim inside beginReconnectIntent, and the exact-equality clear inside
     * releaseReconnectModal. Anywhere else, a write is blind: between reading the
     * owner and nulling it the owner can change (a cancel, a reply landing), and
     * the blind null then frees a modal belonging to a DIFFERENT request -- whose
     * submit finds no intent and emits an ordinary connect with no
     * reconnect_tmux_name. A silent Reset.
     */
    // `this.activeReconnectRequestId = ...` only. The bare
    // `activeReconnectRequestId: null,` property declaration is the field's
    // definition, not a write, and app.js must contain none at all.
    const writes = (sm.match(/this\.activeReconnectRequestId\s*=(?!=)/g) || []).length;
    check('§8 the modal owner is assigned in exactly 2 places (claim + release)',
        writes, 2);
    check('§8 the claim lives in beginReconnectIntent',
        /if \(ownsModal\) this\.activeReconnectRequestId = requestId;/.test(sm), true);
    check('§8 the clear lives behind an exact-equality guard',
        /releaseReconnectModal\(requestId\) \{[\s\S]{0,300}this\.activeReconnectRequestId !== requestId[\s\S]{0,200}this\.activeReconnectRequestId = null;/
            .test(sm), true);
    check('§8 app.js never writes the modal owner directly',
        /SessionManager\.activeReconnectRequestId\s*=(?!=)/.test(appjs), false);
    // Dismissal must capture the owner, then cancel and release THAT id.
    const dismissBody = sm.slice(sm.indexOf('resetConnectionModalIntent() {'),
        sm.indexOf('abandonReconnectRequest(requestId) {'));
    check('§8 dismissal captures the owner id first',
        /const owner = this\.activeReconnectRequestId;/.test(dismissBody), true);
    check('§8 dismissal cancels the captured id',
        /this\.cancelReconnectIntent\(owner\);/.test(dismissBody), true);
    check('§8 dismissal releases through the owner helper, not a raw write',
        /this\.releaseReconnectModal\(owner\);/.test(dismissBody), true);
    check('§8 dismissal contains no raw owner write',
        /activeReconnectRequestId\s*=(?!=)/.test(dismissBody), false);

    /*
     * A server error may cancel a reconnect ONLY under the id the server named.
     * The old fallback to `currentConnectRequestId` tracked whatever the FORM
     * last submitted, which is routinely a different request -- so an
     * uncorrelated error abandoned an unrelated reconnect, dropping the intent
     * its own reply needed and releasing a modal another request owned.
     */
    const errBody = appjs.slice(appjs.indexOf("socket.on('ssh_error'"),
        appjs.indexOf("socket.on('tmux_copy_mode_exited'"));
    check('§8 ssh_error abandons a reconnect only under the echoed id',
        /if \(data\.client_request_id\) \{\s*\n\s*SessionManager\.abandonReconnectRequest\(data\.client_request_id\);/
            .test(errBody), true);
    check('§8 ssh_error never abandons under the lenient fallback id',
        /abandonReconnectRequest\(requestId\)/.test(errBody), false);
    check('§8 the lenient id still clears the pending chip (old servers)',
        /const requestId = data\.client_request_id \|\| currentConnectRequestId;/
            .test(errBody), true);

    /*
     * And the server must actually echo it on EVERY ssh_connect error path,
     * including the outer exception handler -- otherwise the correct client
     * behaviour above (abandon nothing) would silently strand a claim.
     */
    const py = fs.readFileSync(path.join(ROOT, 'app/socket_events.py'), 'utf8');
    const connectBody = py.slice(py.indexOf('def handle_ssh_connect('),
        py.indexOf("@socketio.on('ssh_reconnect')"));
    const bareErrors = (connectBody.match(/emit\('ssh_error',\s*\{[^}]*\}/g) || [])
        .filter(frag => !frag.includes('client_request_id'));
    check('§8 every ssh_error in handle_ssh_connect echoes client_request_id',
        bareErrors, []);
    check('§8 the id is resolved BEFORE the try, so the outer handler has it',
        /client_request_id = None\n\s*if isinstance\(data, dict\):[\s\S]{0,300}try:/
            .test(connectBody), true);
    const outer = connectBody.slice(connectBody.lastIndexOf('except Exception as e:'));
    check('§8 the outer exception handler echoes it too',
        /emit\('ssh_error', \{'error': 'Connection failed',\s*\n\s*'client_request_id': client_request_id\}\)/
            .test(outer), true);
}

// ============================================================================
// §9 The same two invariants, at RUNTIME, so they are not only spelled
//    correctly but behave correctly. A static check cannot see a stale closure
//    or an ordering mistake.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();
    await seed(page, 'OA', {
        connected: false, isPersistentCandidate: true, host: 'a.example',
        tmuxSessionName: 'tmx_OA', authType: 'password', keyId: null,
    });
    await seed(page, 'OB', {
        connected: false, isPersistentCandidate: true, host: 'b.example',
        tmuxSessionName: 'tmx_OB',
    });
    // OA takes the credential modal; OB reconnects directly and is on the wire.
    const owners = await page.evaluate(() => {
        SessionManager.requestCandidateReconnect('OA');
        const modalOwner = SessionManager.activeReconnectRequestId;
        SessionManager.directReconnect('OB');
        const wireIntent = Object.values(SessionManager.reconnectIntents)
            .find(i => i.sessionId === 'OB');
        return { modalOwner, wireId: wireIntent && wireIntent.requestId,
            ownerUnchanged: SessionManager.activeReconnectRequestId === modalOwner };
    });
    check('§9 a direct reconnect does NOT steal the credential modal',
        owners.ownerUnchanged, true);
    check('§9 both requests are registered',
        typeof owners.modalOwner === 'string' && typeof owners.wireId === 'string'
            && owners.modalOwner !== owners.wireId, true);

    // An error naming the WIRE request must not release OA's modal.
    const afterWireError = await page.evaluate((id) => {
        window.__server('ssh_error', { error: 'boom', client_request_id: id });
        return {
            modalOwnerStill: SessionManager.activeReconnectRequestId,
            oaIntentAlive: !!Object.values(SessionManager.reconnectIntents)
                .find(i => i.sessionId === 'OA'),
            obIntentGone: !Object.values(SessionManager.reconnectIntents)
                .find(i => i.sessionId === 'OB'),
            obStillOffered: !!SessionManager.sessions.OB,
            banner: !document.getElementById('connectionFormIntent')?.hidden,
        };
    }, owners.wireId);
    check('§9 the error dropped ONLY its own intent',
        [afterWireError.obIntentGone, afterWireError.oaIntentAlive], [true, true]);
    check('§9 it did not release the other request\'s modal',
        afterWireError.modalOwnerStill, owners.modalOwner);
    check('§9 the other request\'s banner is untouched',
        afterWireError.banner, true);
    check('§9 the failed candidate is still offered',
        afterWireError.obStillOffered, true);

    // An UNCORRELATED error must abandon nothing at all.
    const afterBare = await page.evaluate(() => {
        const before = Object.keys(SessionManager.reconnectIntents).length;
        window.__server('ssh_error', { error: 'no id at all' });
        return { before, after: Object.keys(SessionManager.reconnectIntents).length,
            modalOwner: SessionManager.activeReconnectRequestId };
    });
    check('§9 an uncorrelated error abandons NO reconnect',
        [afterBare.before, afterBare.after], [1, 1]);
    check('§9 an uncorrelated error keeps the modal owner',
        afterBare.modalOwner, owners.modalOwner);

    // Dismissal releases the owner it captured, and only that one.
    const afterDismiss = await page.evaluate(() => {
        document.getElementById('closeConnectionModal').click();
        return { owner: SessionManager.activeReconnectRequestId,
            registry: Object.keys(SessionManager.reconnectIntents).length,
            oaStillOffered: !!SessionManager.sessions.OA,
            banner: !document.getElementById('connectionFormIntent')?.hidden };
    });
    check('§9 dismissal released the modal owner', afterDismiss.owner, null);
    check('§9 dismissal cancelled that one intent', afterDismiss.registry, 0);
    check('§9 dismissal destroyed nothing', afterDismiss.oaStillOffered, true);
    check('§9 dismissal hid the banner', afterDismiss.banner, false);
    check('§9 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §10 THE RETIRED SINGLE-SLOT API IS GONE, everywhere.
//
//     `pendingReconnectMeta` held one intent; `pendingReconnectTmux` and
//     `pendingDisplayName` were shared mutable slots the submit path consumed.
//     Every one of them is replaced by the request-keyed registry. A leftover
//     READ is the dangerous case: it silently returns undefined, so a test goes
//     vacuously green and a product path loses the tmux name — which is the
//     silent Reset this whole workstream exists to remove.
//
//     Historical mentions inside comments are allowed and wanted: they record
//     WHY the shape changed. Only functional references are counted.
// ============================================================================
{
    // Assembled from fragments so this gate is not itself a functional
    // reference to the names it forbids -- otherwise it would always fail on its
    // own source line, which is the least useful possible failure.
    const RETIRED = [
        'pending' + 'ReconnectMeta', 'pending' + 'ReconnectTmux',
        'pending' + 'DisplayName', 'pending' + 'DisplayNames',
        'cancel' + 'PendingReconnect', 'request' + 'OfflineReconnect',
    ];
    const roots = ['static/js', 'templates', 'tests', 'app'];
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
                walk(full);
            } else if (/\.(js|mjs|py|html|sh)$/.test(entry.name)) {
                files.push(full);
            }
        }
    };
    for (const root of roots) walk(path.join(ROOT, root));

    // A line is a COMMENT when it starts with *, //, or # after indentation.
    // Anything else mentioning a retired name is functional.
    const offenders = [];
    for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (/^\s*(\*|\/\/|#)/.test(line)) return;
            for (const name of RETIRED) {
                if (line.includes(name)) {
                    offenders.push(
                        `${path.relative(ROOT, file)}:${i + 1} ${name}`);
                }
            }
        });
    }
    check('§10 zero functional references to the retired single-slot API',
        offenders, []);
    // Would-be-vacuous companion: the gate must really have read the files, and
    // the historical comments it deliberately ignores must still be there.
    check('§10 the gate scanned a realistic file set', files.length > 60, true);
    const smSrc = fs.readFileSync(
        path.join(ROOT, 'static/js/session-manager.js'), 'utf8');
    check('§10 the history of the change is still recorded in comments',
        new RegExp('a single .pending' + 'ReconnectMeta. slot could hold ONE intent')
            .test(smSrc), true);
    check('§10 and the replacement registry exists',
        /reconnectIntents: \{\},/.test(smSrc), true);
}

// ============================================================================
// §11 CANDIDATE RESET — atomic, request-keyed, and destructive only on success.
//
//     THE BLOCKER. Candidate Reset used to run the LIVE path: closeSession ->
//     ssh_disconnect, immediately before the emit. On a candidate that deleted
//     the persisted offer while killing no tmux (close_session returns False with
//     no in-RAM session), so a cancelled or failed Reset destroyed the saved
//     association for good AND left an orphan pane on the host. Strictly worse
//     than doing nothing.
//
//     A live Reset keeps that destructive shape: there IS a connection, and the
//     user asked to replace it. The two lifecycles are deliberately separate.
//
//     What must hold for a CANDIDATE, and is asserted below:
//       * before success: chip, offer, selection, label, transcript and notes all
//         survive the confirm, the form, the submit and any failure;
//       * the payload is still a genuine fresh session (use_tmux:false,
//         reconnect_tmux_name:null);
//       * NO ssh_disconnect until the matching ssh_connected has arrived;
//       * then exactly ONE, for the exact old session id.
//     The database half -- that the offer survives a failure and is really
//     deleted on success, so it cannot reappear on reload -- is proven against
//     the real backend in tests/test_candidate_reset_lifecycle.py.
// ============================================================================

// Seed one candidate carrying every piece of state that must survive.
async function seedCandidateWithState(page, id, opts = {}) {
    await seed(page, id, Object.assign({
        connected: false, isPersistentCandidate: true,
        authType: 'key', keyId: 'kc', displayName: `Label ${id}`,
        tmuxSessionName: `tmx_${id}`,
    }, opts));
    await page.evaluate((sid) => {
        // A transcript and a note, through the real stores.
        TerminalManager.transcripts = TerminalManager.transcripts || {};
        TerminalManager.transcriptSizes = TerminalManager.transcriptSizes || {};
        TerminalManager.transcripts[sid] = ['CANDIDATE-HISTORY\n'];
        TerminalManager.transcriptSizes[sid] = 'CANDIDATE-HISTORY\n'.length;
        SessionManager.sessions[sid].notes = 'a note that must survive';
    }, id);
}

const candidateState = (page, id) => page.evaluate((sid) => ({
    known: !!SessionManager.sessions[sid],
    chip: !!document.getElementById(`tab-${sid}`),
    target: SessionManager.lifecycleActionTargetId,
    label: SessionManager.sessions[sid]?.displayName || null,
    tmux: SessionManager.sessions[sid]?.tmuxSessionName || null,
    notes: SessionManager.sessions[sid]?.notes || null,
    transcript: (window.TerminalManager?.transcripts?.[sid] || []).join(''),
    resetIntents: Object.keys(SessionManager.resetIntents).length,
}), id);

{
    // ---- direct path: key candidate, no credential form -------------------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RD');
    await selectChip(page, 'RD');
    await openSheetByRetap(page, 'RD');
    await resetEmits(page);
    await clickAction(page, 'reset');
    const dlg = await readDialog(page);
    check('§11 direct: the candidate Reset confirmation is destructive',
        [dlg.open, dlg.danger], [true, true]);
    check('§11 direct: it uses the candidate copy, not the live copy',
        dlg.accept, 'Drop and start fresh');
    // W13-B8: the candidate copy states BOTH halves explicitly -- a fresh
    // connection is started, and NOTHING on the remote host is touched -- and
    // carries none of the live copy's destructive language.
    check('§11 direct: the body names the fresh connection intent',
        dlg.body.includes('fresh connection'), true);
    check('§11 direct: the body promises the remote host is untouched',
        dlg.body.includes('Nothing running on the remote host is affected'),
        true);
    check('§11 direct: the body carries no destructive live language',
        /terminated|killed/i.test(dlg.body), false);
    await acceptDialog(page);

    const emits = await readEmits(page);
    check('§11 direct: exactly ONE frame, and it is the fresh connect',
        emits.map(e => e.ev), ['ssh_connect']);
    check('§11 direct: the payload is a genuine fresh session',
        [emits[0].use_tmux, emits[0].reconnect_tmux_name], [false, null]);
    check('§11 direct: NO ssh_disconnect before the replacement exists',
        emits.some(e => e.ev === 'ssh_disconnect'), false);

    const held = await candidateState(page, 'RD');
    check('§11 direct: the candidate is still known', held.known, true);
    check('§11 direct: its chip is still painted', held.chip, true);
    check('§11 direct: it is still the lifecycle target', held.target, 'RD');
    check('§11 direct: its label survives', held.label, 'Label RD');
    check('§11 direct: its tmux identity survives', held.tmux, 'tmx_RD');
    check('§11 direct: its notes survive', held.notes, 'a note that must survive');
    check('§11 direct: its transcript survives', held.transcript,
        'CANDIDATE-HISTORY\n');
    check('§11 direct: one retirement intent is armed', held.resetIntents, 1);

    // The matching reply. NOW the retirement is REQUESTED -- and B6 makes that
    // a correlated ask, not an immediate removal: one candidate_reset for the
    // exact old id, and the chip survives until the ack.
    const requestId = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RD_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, requestId);
    await page.waitForTimeout(120);
    const afterConnected = await page.evaluate(() => ({
        // B6: the replacement exists, but the candidate is NOT removed yet.
        oldStillThere: !!SessionManager.sessions.RD,
        oldChipStillThere: !!document.getElementById('tab-RD'),
        newExists: !!SessionManager.sessions.RD_NEW,
        newHasTmux: SessionManager.sessions.RD_NEW?.tmuxSessionName || null,
        newTranscript: (window.TerminalManager?.transcripts?.RD_NEW || []).join(''),
        resets: window.__emits
            .filter(e => e.ev === 'candidate_reset')
            .map(e => ({ sid: e.payload?.session_id, rid: e.payload?.request_id })),
        disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect').length,
        intents: Object.keys(SessionManager.resetIntents).length,
        retirements: Object.keys(SessionManager.candidateRetirements).length,
    }));
    check('§11 direct: ssh_connected emits ONE correlated candidate_reset',
        afterConnected.resets.length, 1);
    check('§11 direct: it names the exact old session',
        afterConnected.resets[0]?.sid, 'RD');
    check('§11 direct: it carries a retirement request id',
        /^retire_/.test(afterConnected.resets[0]?.rid || ''), true);
    check('§11 direct: NO ssh_disconnect anywhere in the retirement',
        afterConnected.disconnects, 0);
    check('§11 direct: the candidate SURVIVES until the ack (no optimistic removal)',
        [afterConnected.oldStillThere, afterConnected.oldChipStillThere],
        [true, true]);
    check('§11 direct: the fresh session has NO tmux identity',
        afterConnected.newHasTmux, null);
    check('§11 direct: the old transcript is NOT adopted (Reset is not Reconnect)',
        afterConnected.newTranscript, '');
    check('§11 direct: the reset intent is consumed', afterConnected.intents, 0);
    check('§11 direct: one retirement record is in flight',
        afterConnected.retirements, 1);

    // The correlated ack. Only NOW may the UI be purged.
    const afterAck = await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RD', request_id: rid,
        });
        return {
            oldGone: !SessionManager.sessions.RD,
            oldChipGone: !document.getElementById('tab-RD'),
            retirements: Object.keys(SessionManager.candidateRetirements).length,
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect').length,
        };
    }, afterConnected.resets[0].rid);
    check('§11 direct: the ack retires the old association',
        [afterAck.oldGone, afterAck.oldChipGone], [true, true]);
    check('§11 direct: the retirement record is consumed', afterAck.retirements, 0);
    check('§11 direct: the ack path emits no ssh_disconnect either',
        afterAck.disconnects, 0);
    check('§11 direct: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B6: the ERROR ack keeps everything (rollback invariant) -------
    // The correlated contract has two answers. The error must leave the chip,
    // the record's session and the offer untouched, notify the user, and make
    // the candidate resettable again.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RE');
    await selectChip(page, 'RE');
    await openSheetByRetap(page, 'RE');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const rid = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    // Replacement succeeds; the retirement is requested.
    await page.evaluate((id) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RE_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: id,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, rid);
    await page.waitForTimeout(120);
    const retireRid = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    // The server's answer is a correlated ERROR.
    await page.evaluate((id) => {
        window.__server('candidate_reset_error', {
            error: 'Failed to delete the saved session',
            session_id: 'RE', request_id: id,
        });
    }, retireRid);
    await page.waitForTimeout(120);
    const afterErr = await candidateState(page, 'RE');
    check('§11 B6 error: the candidate survives entirely',
        [afterErr.known, afterErr.chip, afterErr.label, afterErr.tmux,
            afterErr.notes, afterErr.transcript],
        [true, true, 'Label RE', 'tmx_RE', 'a note that must survive',
            'CANDIDATE-HISTORY\n']);
    check('§11 B6 error: the retirement record is dropped',
        afterErr.resetIntents !== undefined && Object.keys(
            await page.evaluate(() => SessionManager.candidateRetirements)).length, 0);
    check('§11 B6 error: the user is told, and the offer is named',
        (await page.evaluate(() => window.__notes)).some(n =>
            n.t === 'error' && n.m.includes('Label RE')), true);
    // And the candidate can still be reset again afterwards.
    await openSheetByRetap(page, 'RE');
    await clickAction(page, 'reset');
    check('§11 B6 error: Reset can be pressed again afterwards',
        (await readDialog(page)).open, true);
    check('§11 B6 error: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B6: correlation -- a crossed or unknown ack retires nothing ----
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RX1');
    await seedCandidateWithState(page, 'RY1');
    const rids = await page.evaluate(() => {
        SessionManager.requestResetSession('RX1');
        document.getElementById('sessionConfirmAccept').click();
        SessionManager.requestResetSession('RY1');
        document.getElementById('sessionConfirmAccept').click();
        const map = {};
        for (const [rid, intent] of Object.entries(SessionManager.resetIntents)) {
            map[intent.sessionId] = rid;
        }
        return map;
    });
    // Both replacements succeed, both retirements are requested.
    await page.evaluate((m) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RX1_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: m.RX1,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RY1_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: m.RY1,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return Object.keys(SessionManager.candidateRetirements);
    }, rids);
    await page.waitForTimeout(80);
    const retireMap = await page.evaluate(() => {
        const out = {};
        for (const [rid, rec] of Object.entries(SessionManager.candidateRetirements)) {
            out[rec.sessionId] = rid;
        }
        return out;
    });
    check('§11 B6 crossed: both retirements are in flight',
        Object.keys(retireMap).sort(), ['RX1', 'RY1']);
    // An ack for X1 with Y1's request id: a crossed correlation must retire
    // NOTHING, because no record exists under that id.
    await page.evaluate((m) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RX1', request_id: m.RY1,
        });
    }, retireMap);
    check('§11 B6 crossed: a crossed ack retires nothing',
        [await page.evaluate(() => !!SessionManager.sessions.RX1),
            await page.evaluate(() => !!SessionManager.sessions.RY1)],
        [true, true]);
    check('§11 B6 crossed: both retirement records survive the crossed ack',
        Object.keys(await page.evaluate(() => SessionManager.candidateRetirements)).length, 2);
    // An unknown request id: also nothing.
    await page.evaluate(() => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RX1', request_id: 'retire_bogus',
        });
    });
    check('§11 B6 crossed: an unknown ack retires nothing',
        await page.evaluate(() => !!SessionManager.sessions.RX1), true);
    // The honest acks, one per candidate, in reverse order.
    await page.evaluate((m) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RY1', request_id: m.RY1,
        });
    }, retireMap);
    check('§11 B6 crossed: Y1 retires on its own ack',
        [await page.evaluate(() => !SessionManager.sessions.RY1),
            await page.evaluate(() => !!SessionManager.sessions.RX1)],
        [true, true]);
    await page.evaluate((m) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RX1', request_id: m.RX1,
        });
    }, retireMap);
    check('§11 B6 crossed: X1 retires on its own ack',
        await page.evaluate(() => !SessionManager.sessions.RX1), true);
    check('§11 B6 crossed: all retirement records consumed',
        Object.keys(await page.evaluate(() => SessionManager.candidateRetirements)).length, 0);
    check('§11 B6 crossed: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B6: NETWORK FAILURE -- the socket dies before the ack ---------
    // An emit whose answer never arrives may have deleted server-side or not.
    // The ONLY honest UI move is to keep the candidates and drop the records:
    // no optimistic removal, no orphan record, and the offer stays resettable.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RN');
    await selectChip(page, 'RN');
    await openSheetByRetap(page, 'RN');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const rid = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((id) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RN_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: id,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, rid);
    await page.waitForTimeout(120);
    check('§11 B6 netfail: one retirement is in flight before the drop',
        Object.keys(await page.evaluate(() => SessionManager.candidateRetirements)).length, 1);
    // The socket drops. No ack will ever arrive.
    await page.evaluate(() => { window.__server('disconnect', {}); });
    await page.waitForTimeout(80);
    const afterDrop = await candidateState(page, 'RN');
    check('§11 B6 netfail: the candidate survives the socket loss entirely',
        [afterDrop.known, afterDrop.chip, afterDrop.label, afterDrop.tmux,
            afterDrop.transcript],
        [true, true, 'Label RN', 'tmx_RN', 'CANDIDATE-HISTORY\n']);
    check('§11 B6 netfail: the in-flight retirement record is dropped',
        Object.keys(await page.evaluate(() => SessionManager.candidateRetirements)).length, 0);
    check('§11 B6 netfail: nothing was optimistically removed',
        await page.evaluate(() => !!SessionManager.sessions.RN), true);
    // And the offer is still resettable afterwards.
    await openSheetByRetap(page, 'RN');
    await clickAction(page, 'reset');
    check('§11 B6 netfail: Reset can be pressed again afterwards',
        (await readDialog(page)).open, true);
    check('§11 B6 netfail: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B7: ONE Reset in flight per candidate (double-trigger guard) -
    // A rapid second trigger on the SAME candidate while its Reset is in
    // flight must be a safe no-op: no second confirmation is armed, nothing
    // is emitted, and the user is told. Granularity is per-candidate: the
    // same second trigger on a DIFFERENT candidate must proceed unhindered.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'DA');
    await seedCandidateWithState(page, 'DB');
    await selectChip(page, 'DA');
    await openSheetByRetap(page, 'DA');
    await resetEmits(page);
    await clickAction(page, 'reset');
    const dlgA = await readDialog(page);
    check('§11 B7 double: the first trigger arms the confirmation',
        [dlgA.open, dlgA.accept], [true, 'Drop and start fresh']);
    check('§11 B7 double: the guard is armed for DA only',
        await page.evaluate(() => [
            !!SessionManager.candidateResetsInFlight.DA,
            !!SessionManager.candidateResetsInFlight.DB,
        ]), [true, false]);
    // The second trigger, same candidate: a TRUE no-op.
    const notesBefore = await page.evaluate(() => window.__notes.length);
    await page.evaluate(() => SessionManager.requestResetSession('DA'));
    await page.waitForTimeout(80);
    const dlgA2 = await readDialog(page);
    check('§11 B7 double: the armed dialog is untouched by the second trigger',
        [dlgA2.open, dlgA2.title, dlgA2.accept],
        [dlgA.open, dlgA.title, dlgA.accept]);
    check('§11 B7 double: the second trigger emits NOTHING',
        (await readEmits(page)).length, 0);
    check('§11 B7 double: the user is told, and the offer is named',
        (await page.evaluate(() => window.__notes)).slice(notesBefore)
            .some(n => n.t === 'info' && n.m.includes('Label DA')), true);
    // A third trigger, and a fourth -- still exactly nothing. The guard is not
    // a one-shot latch; every press while in flight is a no-op.
    await page.evaluate(() => {
        SessionManager.requestResetSession('DA');
        SessionManager.requestResetSession('DA');
    });
    check('§11 B7 double: repeated triggers still emit nothing',
        (await readEmits(page)).length, 0);
    // GRANULARITY: candidate B is not blocked by A's in-flight Reset. (B's
    // confirmation displaces A's -- the single-confirmation invariant -- and
    // that displacement is itself an abandonment: A's guard releases. Both
    // facts are asserted on the way through.)
    await page.evaluate(() => SessionManager.requestResetSession('DB'));
    const dlgB = await readDialog(page);
    check('§11 B7 double: candidate B is NOT blocked by A',
        [dlgB.open, dlgB.title.includes('Label DB')], [true, true]);
    check('§11 B7 double: displacing A\'s confirmation released A\'s guard',
        await page.evaluate(() => [
            !!SessionManager.candidateResetsInFlight.DA,
            !!SessionManager.candidateResetsInFlight.DB,
        ]), [false, true]);
    await acceptDialog(page);
    const emitsB = await readEmits(page);
    check('§11 B7 double: B emits exactly ONE fresh connect',
        [emitsB.length, emitsB[0].ev, emitsB[0].use_tmux],
        [1, 'ssh_connect', false]);
    check('§11 B7 double: the one connect names B, not A',
        await page.evaluate(() => window.__emits
            .filter(e => e.ev === 'ssh_connect')
            .map(e => e.payload?.display_name)), ['Label DB']);
    // B's replacement succeeds; its retirement runs to its ack.
    const ridB = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'DB_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, ridB);
    await page.waitForTimeout(120);
    check('§11 B7 double: B\'s guard stays armed while its retirement is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.DB),
        true);
    const retireB = await page.evaluate(() => ({
        resets: window.__emits.filter(e => e.ev === 'candidate_reset')
            .map(e => e.payload?.session_id),
        rid: Object.keys(SessionManager.candidateRetirements)[0] || null,
    }));
    check('§11 B7 double: B\'s retirement names B exactly once',
        retireB.resets, ['DB']);
    // An UNRELATED retirement error (unknown request id) must not touch
    // A's re-armed guard below: release is keyed to the record, not to the
    // event shape.
    await page.evaluate(() => {
        window.__server('candidate_reset_error', {
            error: 'bogus', session_id: 'DA', request_id: 'retire_bogus',
        });
    });
    await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'DB', request_id: rid,
        });
    }, retireB.rid);
    await page.waitForTimeout(80);
    check('§11 B7 double: B retired on its own ack, and its guard released with it',
        await page.evaluate(() => [
            !SessionManager.sessions.DB, !document.getElementById('tab-DB'),
            !!SessionManager.candidateResetsInFlight.DB,
        ]), [true, true, false]);
    // Now A again. Its earlier attempt was abandoned by displacement, so a
    // fresh trigger re-arms cleanly -- and the total for A across this whole
    // block must come out to exactly ONE connect: the refused triggers and
    // the displacement emitted nothing.
    await resetEmits(page);
    await page.evaluate(() => SessionManager.requestResetSession('DA'));
    const dlgA3 = await readDialog(page);
    check('§11 B7 double: A re-arms a fresh confirmation after displacement',
        [dlgA3.open, dlgA3.accept], [true, 'Drop and start fresh']);
    await acceptDialog(page);
    const emitsA = await readEmits(page);
    check('§11 B7 double: A emits exactly ONE frame -- one Reset, one lifecycle',
        [emitsA.length, emitsA[0].ev, emitsA[0].use_tmux],
        [1, 'ssh_connect', false]);
    check('§11 B7 double: that one connect names A, and only A',
        await page.evaluate(() => window.__emits
            .filter(e => e.ev === 'ssh_connect')
            .map(e => e.payload?.display_name)), ['Label DA']);
    // Drive A to its ack: the terminal success releases its guard too.
    const ridA = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'DA_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, ridA);
    await page.waitForTimeout(120);
    const retireA = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    check('§11 B7 double: A\'s guard stays armed while its retirement is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.DA),
        true);
    await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'DA', request_id: rid,
        });
    }, retireA);
    await page.waitForTimeout(80);
    check('§11 B7 double: A retired on its own ack; no guard survives',
        await page.evaluate(() => [
            !SessionManager.sessions.DA,
            Object.keys(SessionManager.candidateResetsInFlight).length,
            Object.keys(SessionManager.candidateRetirements).length,
            Object.keys(SessionManager.resetIntents).length,
        ]), [true, 0, 0, 0]);
    check('§11 B7 double: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B7: error ack releases the guard; retry emits exactly one -----
    // The replacement connect fails server-side. The guard must release with
    // the error (the attempt is over), and the retry must be a fresh, fully
    // working Reset -- one more emit, not two.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'EE');
    await selectChip(page, 'EE');
    await openSheetByRetap(page, 'EE');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const first = await readEmits(page);
    check('§11 B7 retry: the first attempt emits exactly one connect',
        [first.length, first[0].ev], [1, 'ssh_connect']);
    check('§11 B7 retry: the guard is armed while the connect is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.EE),
        true);
    await page.evaluate(() => {
        window.__server('ssh_error', { error: 'Connection failed',
            client_request_id: Object.keys(SessionManager.resetIntents)[0] });
    });
    await page.waitForTimeout(80);
    check('§11 B7 retry: the ssh_error releases the guard',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.EE),
        false);
    // Retry: allowed again, and it is a full Reset.
    await openSheetByRetap(page, 'EE');
    await clickAction(page, 'reset');
    check('§11 B7 retry: the confirmation opens again after the error',
        (await readDialog(page)).open, true);
    await acceptDialog(page);
    const second = await readEmits(page);
    check('§11 B7 retry: exactly ONE more frame -- the retry is not doubled',
        [second.length, second[1]?.ev], [2, 'ssh_connect']);
    // Drive the retry to its ack: the whole lifecycle completes cleanly.
    const rid2 = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'EE_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, rid2);
    await page.waitForTimeout(120);
    check('§11 B7 retry: the guard stays armed while the retirement is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.EE),
        true);
    const retireRid = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'EE', request_id: rid,
        });
    }, retireRid);
    await page.waitForTimeout(80);
    check('§11 B7 retry: the retried Reset retires the candidate completely',
        await page.evaluate(() => [
            !SessionManager.sessions.EE,
            Object.keys(SessionManager.candidateResetsInFlight).length,
            Object.keys(SessionManager.candidateRetirements).length,
        ]), [true, 0, 0]);
    check('§11 B7 retry: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B7: modal path -- the guard covers the credential form -------
    // A password candidate's Reset holds the form open between confirm and
    // submit. The whole window is "in flight": a second trigger is a no-op,
    // cancelling the form releases the guard, and a retry after cancel is a
    // fresh Reset.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'MP', {
        authType: 'password', keyId: null,
    });
    await selectChip(page, 'MP');
    await openSheetByRetap(page, 'MP');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    check('§11 B7 modal: the form opens and the guard is armed',
        await page.evaluate(() => [
            !!document.getElementById('connectionModal')?.classList.contains('show'),
            !!SessionManager.pendingResetMeta,
            !!SessionManager.candidateResetsInFlight.MP,
        ]), [true, true, true]);
    // Second trigger while the form is open: refused, nothing emitted, the
    // pending meta of the armed attempt is untouched.
    const metaBefore = await page.evaluate(() =>
        SessionManager.pendingResetMeta?.requestId);
    const notesBefore = await page.evaluate(() => window.__notes.length);
    await page.evaluate(() => SessionManager.requestResetSession('MP'));
    await page.waitForTimeout(80);
    check('§11 B7 modal: the second trigger emits nothing',
        (await readEmits(page)).length, 0);
    check('§11 B7 modal: the armed attempt keeps its own meta',
        await page.evaluate(() => SessionManager.pendingResetMeta?.requestId),
        metaBefore);
    check('§11 B7 modal: the refusal is told to the user',
        (await page.evaluate(() => window.__notes)).slice(notesBefore)
            .some(n => n.m.includes('Label MP')), true);
    // Cancel the form: the attempt ends, the guard releases.
    await page.click('#cancelConnectionBtn');
    await page.waitForTimeout(80);
    check('§11 B7 modal: cancelling the form releases the guard',
        await page.evaluate(() => [
            !!SessionManager.candidateResetsInFlight.MP,
            SessionManager.pendingResetMeta,
        ]), [false, null]);
    // Retry: a fresh Reset, one emit, driven to its ack.
    await page.evaluate(() => SessionManager.requestResetSession('MP'));
    await acceptDialog(page);
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await page.waitForTimeout(80);
    const retryEmits = await readEmits(page);
    check('§11 B7 modal: the retry emits exactly one fresh connect',
        [retryEmits.length, retryEmits[0].ev, retryEmits[0].use_tmux],
        [1, 'ssh_connect', false]);
    const rid = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((id) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'MP_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: id,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
    }, rid);
    await page.waitForTimeout(120);
    check('§11 B7 modal: the guard stays armed while the retirement is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.MP),
        true);
    const retireRid = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    await page.evaluate((id) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'MP', request_id: id,
        });
    }, retireRid);
    await page.waitForTimeout(80);
    check('§11 B7 modal: the retried Reset retires the candidate completely',
        await page.evaluate(() => [
            !SessionManager.sessions.MP,
            Object.keys(SessionManager.candidateResetsInFlight).length,
        ]), [true, 0]);
    check('§11 B7 modal: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B7: the socket dying releases EVERY armed guard ---------------
    // A connect in flight and a confirmation open are both "in flight"; a
    // socket death ends both attempts, so both candidates become resettable
    // again the moment the connection returns.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'ND');
    await seedCandidateWithState(page, 'NC');
    // ND: accepted, connect in flight.
    await selectChip(page, 'ND');
    await openSheetByRetap(page, 'ND');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    // NC: confirmation armed, nothing accepted yet.
    await page.evaluate(() => SessionManager.requestResetSession('NC'));
    check('§11 B7 netdie: both guards are armed (connect + confirm)',
        await page.evaluate(() => [
            !!SessionManager.candidateResetsInFlight.ND,
            !!SessionManager.candidateResetsInFlight.NC,
        ]), [true, true]);
    await page.evaluate(() => { window.__server('disconnect', {}); });
    await page.waitForTimeout(80);
    check('§11 B7 netdie: the socket death releases both guards',
        await page.evaluate(() =>
            Object.keys(SessionManager.candidateResetsInFlight).length), 0);
    check('§11 B7 netdie: both candidates survive entirely',
        await page.evaluate(() => [
            !!SessionManager.sessions.ND, !!document.getElementById('tab-ND'),
            !!SessionManager.sessions.NC, !!document.getElementById('tab-NC'),
        ]), [true, true, true, true]);
    check('§11 B7 netdie: the in-flight connect\'s retirement record is dropped',
        Object.keys(await page.evaluate(() =>
            SessionManager.candidateRetirements)).length, 0);
    // NC's confirmation is still on screen (a socket death does not close
    // dialogs). The user cancels it, then both candidates are resettable again.
    await page.click('#sessionConfirmCancel');
    await page.waitForTimeout(80);
    await openSheetByRetap(page, 'ND');
    await clickAction(page, 'reset');
    check('§11 B7 netdie: ND is resettable again',
        (await readDialog(page)).open, true);
    // ND's confirmation is still on screen; cancel it before NC can be
    // triggered (its backdrop intercepts every pointer event while it is up).
    await page.click('#sessionConfirmCancel');
    await page.waitForTimeout(80);
    await page.evaluate(() => SessionManager.requestResetSession('NC'));
    check('§11 B7 netdie: NC is resettable again too',
        (await readDialog(page)).title.includes('Label NC'), true);
    check('§11 B7 netdie: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B7: an attempt that emits NOTHING still releases the guard ----
    // Constraint C: a candidate whose saved jump host is gone aborts its Reset
    // with a notification and no emit. The guard must release with that abort,
    // or the candidate would be permanently un-resettable.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'JG', { jumpHostId: 'jh-gone' });
    await selectChip(page, 'JG');
    await openSheetByRetap(page, 'JG');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    await page.waitForTimeout(80);
    check('§11 B7 abort: the jump-not-found attempt emits nothing',
        (await readEmits(page)).length, 0);
    check('§11 B7 abort: the guard is released by the abort',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.JG),
        false);
    check('§11 B7 abort: the user is told the jump host is gone',
        (await page.evaluate(() => window.__notes)).some(n =>
            n.t === 'error' && /jump host/i.test(n.m)), true);
    check('§11 B7 abort: the candidate survives entirely',
        await page.evaluate(() => [
            !!SessionManager.sessions.JG, !!document.getElementById('tab-JG'),
        ]), [true, true]);
    check('§11 B7 abort: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- failure: everything survives, and it can be retried --------------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RF');
    await selectChip(page, 'RF');
    await openSheetByRetap(page, 'RF');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const rid = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await page.evaluate((id) => {
        window.__emits.length = 0;
        window.__server('ssh_error', { error: 'Connection failed',
            client_request_id: id });
    }, rid);
    await page.waitForTimeout(120);
    const afterFail = await candidateState(page, 'RF');
    const failEmits = await readEmits(page);
    check('§11 failure: NOTHING is sent to the server', failEmits.map(e => e.ev), []);
    check('§11 failure: the candidate survives entirely',
        [afterFail.known, afterFail.chip, afterFail.label, afterFail.tmux,
            afterFail.notes, afterFail.transcript],
        [true, true, 'Label RF', 'tmx_RF', 'a note that must survive',
            'CANDIDATE-HISTORY\n']);
    check('§11 failure: the retirement intent is dropped',
        afterFail.resetIntents, 0);
    // And a later unrelated success must not retire it retroactively.
    await page.evaluate(() => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'UNREL', host: 'other.example',
            port: 22, username: 'x', client_request_id: 'req_unrelated',
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
    });
    check('§11 failure: an unrelated later success cannot retire it',
        await page.evaluate(() => !!SessionManager.sessions.RF), true);
    // Retry works: the offer is still resettable.
    await openSheetByRetap(page, 'RF');
    await clickAction(page, 'reset');
    check('§11 failure: Reset can be pressed again afterwards',
        (await readDialog(page)).open, true);
    check('§11 failure: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- cancel / X / backdrop on the CREDENTIAL form ---------------------
    // A password candidate's Reset needs the form, which is the window in which
    // the old code had already destroyed the offer.
    for (const route of ['cancelConnectionBtn', 'closeConnectionModal',
        'backdrop']) {
        const { ctx, page, errors } = await newPage();
        await seedCandidateWithState(page, 'RC', {
            authType: 'password', keyId: null,
        });
        await selectChip(page, 'RC');
        await openSheetByRetap(page, 'RC');
        await resetEmits(page);
        await clickAction(page, 'reset');
        await acceptDialog(page);

        const onForm = await page.evaluate(() => ({
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            resetArmed: !!SessionManager.pendingResetMeta,
            fromCandidate: SessionManager.pendingResetMeta?.fromCandidate,
            tmuxBox: !!document.getElementById('useTmuxCheck')?.checked,
            banner: !document.getElementById('connectionFormIntent')?.hidden,
            bannerTitle: document.getElementById('connectionFormIntentTitle')
                ?.textContent || '',
        }));
        check(`§11 ${route}: the Reset form opened with RESET intent`,
            [onForm.modal, onForm.resetArmed, onForm.fromCandidate],
            [true, true, true]);
        check(`§11 ${route}: tmux is OFF on the Reset form`, onForm.tmuxBox, false);
        check(`§11 ${route}: the form says it is a Reset`,
            onForm.bannerTitle.includes('Reset'), true);
        check(`§11 ${route}: nothing emitted while the form is open`,
            (await readEmits(page)).map(e => e.ev), []);
        // The offer is intact WHILE the form is open — the old code had already
        // destroyed it by now.
        const during = await candidateState(page, 'RC');
        check(`§11 ${route}: the candidate is intact while the form is open`,
            [during.known, during.chip, during.transcript],
            [true, true, 'CANDIDATE-HISTORY\n']);

        if (route === 'backdrop') {
            await page.evaluate(() => {
                const modal = document.getElementById('connectionModal');
                modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
        } else {
            await page.click(`#${route}`);
        }
        await page.waitForTimeout(120);

        const after = await candidateState(page, 'RC');
        check(`§11 ${route}: dismissal emits nothing`,
            (await readEmits(page)).map(e => e.ev), []);
        check(`§11 ${route}: the candidate survives the dismissal in full`,
            [after.known, after.chip, after.label, after.tmux, after.notes,
                after.transcript],
            [true, true, 'Label RC', 'tmx_RC', 'a note that must survive',
                'CANDIDATE-HISTORY\n']);
        check(`§11 ${route}: the retirement intent is dropped`,
            after.resetIntents, 0);
        check(`§11 ${route}: Reset's meta is cleared`,
            await page.evaluate(() => SessionManager.pendingResetMeta), null);
        check(`§11 ${route}: the banner is hidden`,
            await page.evaluate(() =>
                !document.getElementById('connectionFormIntent')?.hidden), false);
        check(`§11 ${route}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

{
    // ---- credential-modal SUCCESS -----------------------------------------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RM', { authType: 'password', keyId: null });
    await selectChip(page, 'RM');
    await openSheetByRetap(page, 'RM');
    await resetEmits(page);
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const submitted = await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return {
            emits: window.__emits.map(e => e.ev),
            useTmux: frame?.payload?.use_tmux,
            tmux: frame?.payload?.reconnect_tmux_name,
            rid: frame?.payload?.client_request_id,
            intents: Object.keys(SessionManager.resetIntents).length,
            stillThere: !!SessionManager.sessions.RM,
        };
    });
    check('§11 modal: exactly one fresh connect, no disconnect',
        submitted.emits, ['ssh_connect']);
    check('§11 modal: the payload is a genuine fresh session',
        [submitted.useTmux, submitted.tmux], [false, null]);
    check('§11 modal: the request id is a reset_* id',
        /^reset_/.test(submitted.rid || ''), true);
    check('§11 modal: a retirement intent is armed for it', submitted.intents, 1);
    check('§11 modal: the candidate survives the submit', submitted.stillThere, true);

    const done = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RM_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
        const resets = window.__emits.filter(e => e.ev === 'candidate_reset');
        return {
            // B6: the candidate survives ssh_connected; it is only ASKED to retire.
            oldStillThere: !!SessionManager.sessions.RM,
            resets: resets.map(e => e.payload?.session_id),
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect').length,
            intents: Object.keys(SessionManager.resetIntents).length,
            retirements: Object.keys(SessionManager.candidateRetirements).length,
            retireRid: Object.keys(SessionManager.candidateRetirements)[0] || null,
        };
    }, submitted.rid);
    check('§11 modal: on success the retirement is REQUESTED, not executed',
        done.oldStillThere, true);
    check('§11 modal: exactly one candidate_reset, for the exact old id',
        done.resets, ['RM']);
    check('§11 modal: no ssh_disconnect anywhere', done.disconnects, 0);
    check('§11 modal: the intent is consumed', done.intents, 0);
    check('§11 modal: one retirement record is in flight', done.retirements, 1);
    // The ack retires it.
    const doneAck = await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RM', request_id: rid,
        });
        return {
            oldGone: !SessionManager.sessions.RM,
            retirements: Object.keys(SessionManager.candidateRetirements).length,
        };
    }, done.retireRid);
    check('§11 modal: the ack retires the candidate', doneAck.oldGone, true);
    check('§11 modal: the retirement record is consumed', doneAck.retirements, 0);
    check('§11 modal: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- W13-B8: the credential-form banner states WHICH Reset it serves ---
    // The confirmation copy is live/candidate-distinct; the credential form's
    // intent banner must be too, since it is what the user reads while typing
    // the secret that decides the outcome. Live: terminate + kill. Candidate:
    // fresh connection, host untouched.
    const { ctx, page, errors } = await newPage();
    await seed(page, 'BL', { authType: 'password', displayName: 'Label BL' });
    await seed(page, 'BC', {
        authType: 'password', connected: false, isPersistentCandidate: true,
        displayName: 'Label BC',
    });
    await selectChip(page, 'BL');
    await openSheetByRetap(page, 'BL');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const liveBanner = await page.evaluate(() => ({
        title: document.getElementById('connectionFormIntentTitle')
            ?.textContent || '',
        detail: document.getElementById('connectionFormIntentDetail')
            ?.textContent || '',
    }));
    check('§11 B8 banner: the live form names the session it serves',
        liveBanner.title.includes('Label BL'), true);
    check('§11 B8 banner: the live form states terminate and kill',
        liveBanner.detail.includes('terminated')
            && liveBanner.detail.includes('killed'), true);
    check('§11 B8 banner: the live form carries no candidate reassurance',
        /Nothing running on the remote host/.test(liveBanner.detail), false);
    // Leave the live form without submitting.
    await page.click('#cancelConnectionBtn');
    await page.waitForTimeout(80);
    // The candidate side.
    await selectChip(page, 'BC');
    await openSheetByRetap(page, 'BC');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const candBanner = await page.evaluate(() => ({
        title: document.getElementById('connectionFormIntentTitle')
            ?.textContent || '',
        detail: document.getElementById('connectionFormIntentDetail')
            ?.textContent || '',
    }));
    check('§11 B8 banner: the candidate form names the session it serves',
        candBanner.title.includes('Label BC'), true);
    check('§11 B8 banner: the candidate form states the host is untouched',
        candBanner.detail.includes('Nothing running on the remote host'),
        true);
    check('§11 B8 banner: the candidate form carries no destructive language',
        /terminated|killed/i.test(candBanner.detail), false);
    check('§11 B8 banner: the two banners differ',
        liveBanner.detail !== candBanner.detail, true);
    check('§11 B8 banner: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- A/B reversed replies, and an unrelated response between them ------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RA', { host: 'a.example' });
    await seedCandidateWithState(page, 'RB', { host: 'b.example' });
    await resetEmits(page);
    const ids = await page.evaluate(() => {
        SessionManager.requestResetSession('RA');
        document.getElementById('sessionConfirmAccept').click();
        SessionManager.requestResetSession('RB');
        document.getElementById('sessionConfirmAccept').click();
        const map = {};
        for (const [rid, intent] of Object.entries(SessionManager.resetIntents)) {
            map[intent.sessionId] = rid;
        }
        return map;
    });
    check('§11 A/B: both retirement intents coexist',
        [typeof ids.RA, typeof ids.RB, ids.RA !== ids.RB],
        ['string', 'string', true]);

    // An UNRELATED ordinary connect completes first: it must retire neither.
    const afterUnrelated = await page.evaluate(() => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'ORD2', host: 'z.example',
            port: 22, username: 'z', client_request_id: 'req_nothing',
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
        return { a: !!SessionManager.sessions.RA, b: !!SessionManager.sessions.RB,
            intents: Object.keys(SessionManager.resetIntents).length };
    });
    check('§11 A/B: an unrelated connect retires neither candidate',
        [afterUnrelated.a, afterUnrelated.b, afterUnrelated.intents],
        [true, true, 2]);

    // B's reply lands FIRST. It must REQUEST only B's retirement and leave A
    // completely alone -- both candidates then wait for their own acks (B6).
    const afterB = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RB_NEW', host: 'b.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return { resets: window.__emits
                .filter(e => e.ev === 'candidate_reset')
                .map(e => e.payload?.session_id),
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect').length,
            bStillThere: !!SessionManager.sessions.RB,
            aStillThere: !!SessionManager.sessions.RA,
            aChip: !!document.getElementById('tab-RA'),
            intents: Object.keys(SessionManager.resetIntents).length,
            retirements: Object.entries(SessionManager.candidateRetirements)
                .map(([, r]) => r.sessionId) };
    }, ids.RB);
    check('§11 A/B: B first requests only B\'s retirement',
        afterB.resets, ['RB']);
    check('§11 A/B: and emits no ssh_disconnect', afterB.disconnects, 0);
    check('§11 A/B: B still waits for its ack', afterB.bStillThere, true);
    check('§11 A/B: A is untouched', afterB.aStillThere, true);
    check('§11 A/B: A\'s chip is untouched', afterB.aChip, true);
    check('§11 A/B: only A\'s reset intent remains', afterB.intents, 1);
    check('§11 A/B: only B\'s retirement record is in flight',
        afterB.retirements, ['RB']);
    const ridB = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    // B's ack retires B, and only B.
    const afterBAck = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RB', request_id: rid,
        });
        return { bGone: !SessionManager.sessions.RB,
            aStillThere: !!SessionManager.sessions.RA,
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect').length,
            retirements: Object.keys(SessionManager.candidateRetirements).length };
    }, ridB);
    check('§11 A/B: B\'s ack retires only B',
        [afterBAck.bGone, afterBAck.aStillThere], [true, true]);
    check('§11 A/B: the ack path emits no ssh_disconnect',
        afterBAck.disconnects, 0);

    const afterA = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RA_NEW', host: 'a.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return { resets: window.__emits
                .filter(e => e.ev === 'candidate_reset')
                .map(e => e.payload?.session_id),
            intents: Object.keys(SessionManager.resetIntents).length };
    }, ids.RA);
    check('§11 A/B: A second requests A\'s retirement, by its own id',
        [afterA.resets, afterA.intents], [['RA'], 0]);
    const ridA = await page.evaluate(() =>
        Object.keys(SessionManager.candidateRetirements)[0]);
    const afterAAck = await page.evaluate((rid) => {
        window.__server('candidate_reset_ack', {
            ok: true, session_id: 'RA', request_id: rid,
        });
        return { aGone: !SessionManager.sessions.RA,
            retirements: Object.keys(SessionManager.candidateRetirements).length };
    }, ridA);
    check('§11 A/B: A\'s ack retires A', [afterAAck.aGone, afterAAck.retirements],
        [true, 0]);
    check('§11 A/B: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- a RECONNECT reply must not consume a reset intent, and vice versa -
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'RX', { host: 'x.example' });
    await seedCandidateWithState(page, 'RY', { host: 'y.example' });
    const mixed = await page.evaluate(() => {
        SessionManager.requestResetSession('RX');
        document.getElementById('sessionConfirmAccept').click();
        SessionManager.directReconnect('RY');
        return {
            resetId: Object.keys(SessionManager.resetIntents)[0],
            reconnectId: Object.keys(SessionManager.reconnectIntents)[0],
        };
    });
    const crossed = await page.evaluate((m) => {
        // The RECONNECT's reply arrives. It must complete the reconnect and leave
        // the reset intent alone.
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'RY_NEW', host: 'y.example',
            port: 22, username: 'sshdtest', client_request_id: m.reconnectId,
            use_tmux: true, tmux_session_name: 'tmx_RY', auth_type: 'key',
        });
        return {
            reconnectDone: Object.keys(SessionManager.reconnectIntents).length,
            resetIntact: Object.keys(SessionManager.resetIntents).length,
            resetCandidateAlive: !!SessionManager.sessions.RX,
            reconnectedGone: !SessionManager.sessions.RY,
        };
    }, mixed);
    check('§11 crossed: the reconnect completed on its own id',
        [crossed.reconnectDone, crossed.reconnectedGone], [0, true]);
    check('§11 crossed: it did NOT consume the reset intent',
        [crossed.resetIntact, crossed.resetCandidateAlive], [1, true]);
    check('§11 crossed: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- stacked modals: Reset and a reconnect intent cannot coexist -------
    // Both end in the same form, and the submit gate reads both with Reset's
    // branch winning -- so a coexisting reconnect would be silently converted
    // into a Reset, its session left claimed and its tmux name dropped. Opening
    // Reset therefore CANCELS the reconnect that owns the modal, explicitly.
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'SA', {
        authType: 'password', keyId: null, host: 'a.example',
    });
    await seedCandidateWithState(page, 'SB', {
        authType: 'password', keyId: null, host: 'b.example',
    });
    const stacked = await page.evaluate(() => {
        SessionManager.requestCandidateReconnect('SA');   // owns the modal
        const before = {
            owner: SessionManager.activeReconnectRequestId,
            reconnectIntents: Object.keys(SessionManager.reconnectIntents).length,
        };
        SessionManager.requestResetSession('SB');          // displaces it
        document.getElementById('sessionConfirmAccept').click();
        return {
            before,
            after: {
                owner: SessionManager.activeReconnectRequestId,
                reconnectIntents: Object.keys(SessionManager.reconnectIntents).length,
                resetArmed: !!SessionManager.pendingResetMeta,
                resetTarget: SessionManager.pendingResetMeta?.sessionId,
                bothCoexist: !!SessionManager.pendingResetMeta
                    && !!SessionManager.activeReconnectIntent(),
                saStillOffered: !!SessionManager.sessions.SA,
                saClaimed: !!(SessionManager.reconnectingSessions
                    && SessionManager.reconnectingSessions.SA),
            },
        };
    });
    check('§11 stacked: the reconnect owned the modal first',
        [typeof stacked.before.owner, stacked.before.reconnectIntents],
        ['string', 1]);
    check('§11 stacked: Reset cancelled the displaced reconnect intent',
        stacked.after.reconnectIntents, 0);
    check('§11 stacked: and released its modal ownership',
        stacked.after.owner, null);
    check('§11 stacked: Reset is armed for ITS OWN session',
        [stacked.after.resetArmed, stacked.after.resetTarget], [true, 'SB']);
    check('§11 stacked: the two intents can NEVER coexist',
        stacked.after.bothCoexist, false);
    check('§11 stacked: the displaced candidate is not destroyed',
        stacked.after.saStillOffered, true);
    check('§11 stacked: and its claim is released, so it stays reconnectable',
        stacked.after.saClaimed, false);
    // Proof the release is real: SA can be reconnected again.
    check('§11 stacked: the displaced candidate can be reconnected again',
        await page.evaluate(() => {
            SessionManager.resetConnectionModalIntent();
            SessionManager.requestCandidateReconnect('SA');
            return !!SessionManager.activeReconnectIntent();
        }), true);
    check('§11 stacked: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- a LIVE Reset keeps its separate destructive lifecycle -------------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'LV');                        // live, connected, tmux
    await selectChip(page, 'LV');
    await openSheetByRetap(page, 'LV');
    await resetEmits(page);
    await clickAction(page, 'reset');
    const liveDlg = await readDialog(page);
    check('§11 live: the LIVE Reset copy is used, not the candidate copy',
        liveDlg.accept, 'End session and start fresh');
    // W13-B8: the live copy names the destructive act explicitly -- terminate
    // and kill -- and must carry none of the candidate's reassurance.
    check('§11 live: the body names the destructive act explicitly',
        liveDlg.body.includes('terminated')
            && liveDlg.body.includes('killed on the target server'), true);
    check('§11 live: the body carries no candidate reassurance',
        /Nothing running on the remote host is affected/.test(liveDlg.body),
        false);
    await acceptDialog(page);
    const live = await page.evaluate(() => ({
        emits: window.__emits.map(e => e.ev),
        gone: !SessionManager.sessions.LV,
        // A live Reset closes at emit time, so it registers no retirement.
        resetIntents: Object.keys(SessionManager.resetIntents).length,
    }));
    check('§11 live: it disconnects FIRST, then connects',
        live.emits, ['ssh_disconnect', 'ssh_connect']);
    check('§11 live: the live session is retired at emit time', live.gone, true);
    check('§11 live: it arms no candidate-retirement intent',
        live.resetIntents, 0);
    check('§11 live: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §12 THE FRONTEND TRIGGER AND ITS ORDER.
//
//     tests/test_candidate_reset_lifecycle.py proves what the BACKEND does once
//     `ssh_disconnect` arrives: the persisted row is deleted, a reload no longer
//     offers it, no remote tmux is killed, and siblings are spared. What it
//     cannot prove is WHO sends that frame and WHEN — and both were the blocker:
//     the old code sent it at emit time, before any replacement existed.
//
//     So this section pins the trigger and the ordering, driving the app's OWN
//     registered ssh_connected / ssh_error handlers (window.__server invokes the
//     real handler list) rather than calling an internal:
//
//       * an UNRELATED ssh_connected emits no ssh_disconnect for the candidate;
//       * an ssh_error naming the reset request emits none either;
//       * only the MATCHING ssh_connected emits exactly one, carrying the exact
//         old session id, and it happens AFTER the replacement session exists and
//         BEFORE the old chip is removed.
//
//     The order is recorded as a single interleaved timeline: the frame and the
//     session-registry transitions land in one array, so "after creation" is a
//     measured position rather than an inference.
// ============================================================================

// Record every emit AND every relevant DOM/store transition into one ordered
// timeline, by wrapping the real functions rather than replacing them.
const armTimeline = (page, oldId, newId) => page.evaluate(({ oldId, newId }) => {
    window.__timeline = [];
    const realEmit = window.socket.emit;
    window.socket.emit = (ev, payload) => {
        window.__timeline.push(`emit:${ev}:${payload?.session_id ?? ''}`);
        return realEmit.call(window.socket, ev, payload);
    };
    const realCreate = SessionManager.createSession.bind(SessionManager);
    SessionManager.createSession = (data, pending) => {
        const id = realCreate(data, pending);
        window.__timeline.push(`created:${id}`);
        return id;
    };
    const realRemove = SessionManager.removeSessionUI.bind(SessionManager);
    SessionManager.removeSessionUI = (id) => {
        window.__timeline.push(`removedUI:${id}`);
        return realRemove(id);
    };
    // Sanity: the ids this timeline is about must be distinguishable.
    return { oldId, newId, distinct: oldId !== newId };
}, { oldId, newId });

const readTimeline = (page) => page.evaluate(() => window.__timeline.slice());

{
    // ---- an UNRELATED success must not trigger the retirement --------------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'TU');
    await selectChip(page, 'TU');
    await openSheetByRetap(page, 'TU');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    await armTimeline(page, 'TU', 'TU_NEW');
    const unrelated = await page.evaluate(() => {
        // A DIFFERENT request completes. The real ssh_connected handler runs.
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'SOMEONE_ELSE',
            host: 'other.example', port: 22, username: 'other',
            client_request_id: 'req_not_ours', use_tmux: false,
            tmux_session_name: null, auth_type: 'password',
        });
        return {
            timeline: window.__timeline.slice(),
            candidateAlive: !!SessionManager.sessions.TU,
            chip: !!document.getElementById('tab-TU'),
            intents: Object.keys(SessionManager.resetIntents).length,
        };
    });
    check('§12 unrelated success: the unrelated session WAS created (non-vacuous)',
        unrelated.timeline.includes('created:SOMEONE_ELSE'), true);
    check('§12 unrelated success: NO ssh_disconnect is emitted at all',
        unrelated.timeline.filter(e => e.startsWith('emit:ssh_disconnect')), []);
    check('§12 unrelated success: the candidate and its chip survive',
        [unrelated.candidateAlive, unrelated.chip], [true, true]);
    check('§12 unrelated success: the retirement intent is still armed',
        unrelated.intents, 1);
    check('§12 unrelated success: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- an ssh_error naming the reset request must not trigger it ---------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'TE');
    await selectChip(page, 'TE');
    await openSheetByRetap(page, 'TE');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const rid = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    await armTimeline(page, 'TE', 'TE_NEW');
    const errored = await page.evaluate((id) => {
        window.__server('ssh_error', { error: 'Connection failed',
            client_request_id: id });
        return {
            timeline: window.__timeline.slice(),
            candidateAlive: !!SessionManager.sessions.TE,
            chip: !!document.getElementById('tab-TE'),
            transcript: (window.TerminalManager?.transcripts?.TE || []).join(''),
            intents: Object.keys(SessionManager.resetIntents).length,
        };
    }, rid);
    check('§12 exact error: NO ssh_disconnect for the old candidate',
        errored.timeline.filter(e => e.startsWith('emit:ssh_disconnect')), []);
    check('§12 exact error: no UI was removed',
        errored.timeline.filter(e => e.startsWith('removedUI:')), []);
    check('§12 exact error: the candidate, its chip and its history survive',
        [errored.candidateAlive, errored.chip, errored.transcript],
        [true, true, 'CANDIDATE-HISTORY\n']);
    check('§12 exact error: the retirement intent is dropped',
        errored.intents, 0);
    check('§12 exact error: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- the MATCHING success: one frame, exact id, correct ORDER ----------
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'TM');
    await selectChip(page, 'TM');
    await openSheetByRetap(page, 'TM');
    await clickAction(page, 'reset');
    await acceptDialog(page);
    const matchId = await page.evaluate(() =>
        Object.keys(SessionManager.resetIntents)[0]);
    const ids = await armTimeline(page, 'TM', 'TM_NEW');
    check('§12 matching success: the old and new ids are distinct',
        ids.distinct, true);
    await page.evaluate((rid) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'TM_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
    }, matchId);
    await page.waitForTimeout(120);
    const timeline = await readTimeline(page);
    const iCreated = timeline.indexOf('created:TM_NEW');
    const iReset = timeline.indexOf('emit:candidate_reset:TM');
    const iRemoved = timeline.indexOf('removedUI:TM');

    check('§12 matching success: the replacement session really was created',
        iCreated >= 0, true);
    // B6: the retirement is a CORRELATED ASK, not a disconnect. Exactly one
    // candidate_reset for the exact old id, and it comes AFTER the replacement
    // exists -- the pre-B5 disconnect ordering lived and died here.
    check('§12 matching success: exactly ONE candidate_reset, for the exact old id',
        timeline.filter(e => e.startsWith('emit:candidate_reset')),
        ['emit:candidate_reset:TM']);
    check('§12 matching success: the ask comes AFTER the replacement exists',
        iCreated >= 0 && iReset > iCreated, true);
    check('§12 matching success: NO ssh_disconnect anywhere',
        timeline.filter(e => e.startsWith('emit:ssh_disconnect')), []);
    check('§12 matching success: NO UI removal before the ack (chip survives)',
        iRemoved, -1);
    check('§12 matching success: the old chip is still painted pre-ack',
        await page.evaluate(() => !!document.getElementById('tab-TM')), true);
    check('§12 matching success: the new session remains',
        await page.evaluate(() => !!SessionManager.sessions.TM_NEW), true);
    check('§12 matching success: the intent is consumed',
        await page.evaluate(() =>
            Object.keys(SessionManager.resetIntents).length), 0);
    check('§12 matching success: one retirement record is in flight',
        await page.evaluate(() =>
            Object.keys(SessionManager.candidateRetirements).length), 1);
    // The ack is what authorizes the removal -- and it lands AFTER the ask.
    const afterAck = await page.evaluate(() => {
        const rid = Object.keys(SessionManager.candidateRetirements)[0];
        const rec = SessionManager.candidateRetirements[rid];
        window.__server('candidate_reset_ack', {
            ok: true, session_id: rec.sessionId, request_id: rid,
        });
        return {
            timeline: window.__timeline.slice(),
            chipGone: !document.getElementById('tab-TM'),
            retirements: Object.keys(SessionManager.candidateRetirements).length,
        };
    });
    const iRemovedAck = afterAck.timeline.indexOf('removedUI:TM');
    check('§12 matching success: the ack removes the UI of the exact old id',
        afterAck.timeline.filter(e => e.startsWith('removedUI:')),
        ['removedUI:TM']);
    check('§12 matching success: the removal comes AFTER the ask',
        iRemovedAck > afterAck.timeline.indexOf('emit:candidate_reset:TM'), true);
    check('§12 matching success: the old chip is gone post-ack',
        afterAck.chipGone, true);
    check('§12 matching success: the ack path adds no ssh_disconnect',
        afterAck.timeline.filter(e => e.startsWith('emit:ssh_disconnect')), []);
    check('§12 matching success: the retirement record is consumed',
        afterAck.retirements, 0);
    // A REPLAY of the same reply must do nothing a second time.
    const replay = await page.evaluate((rid) => {
        window.__timeline.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'TM_NEW2', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return window.__timeline.filter(e =>
            e.startsWith('emit:candidate_reset') || e.startsWith('removedUI:'));
    }, matchId);
    check('§12 matching success: a replayed reply asks nothing and removes nothing',
        replay, []);
    check('§12 matching success: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- A/B reversed replies: each retires its OWN old id, exactly once ---
    const { ctx, page, errors } = await newPage();
    await seedCandidateWithState(page, 'TA', { host: 'a.example' });
    await seedCandidateWithState(page, 'TB', { host: 'b.example' });
    const pair = await page.evaluate(() => {
        SessionManager.requestResetSession('TA');
        document.getElementById('sessionConfirmAccept').click();
        SessionManager.requestResetSession('TB');
        document.getElementById('sessionConfirmAccept').click();
        const map = {};
        for (const [rid, intent] of Object.entries(SessionManager.resetIntents)) {
            map[intent.sessionId] = rid;
        }
        return map;
    });
    await armTimeline(page, 'TA', 'TB');
    const reversed = await page.evaluate((m) => {
        // B replies FIRST, then A.
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'TB_NEW', host: 'b.example',
            port: 22, username: 'sshdtest', client_request_id: m.TB,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        const mid = window.__timeline.slice();
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'TA_NEW', host: 'a.example',
            port: 22, username: 'sshdtest', client_request_id: m.TA,
            use_tmux: false, tmux_session_name: null, auth_type: 'key',
        });
        return { mid, full: window.__timeline.slice(),
            intents: Object.keys(SessionManager.resetIntents).length };
    }, pair);

    check('§12 A/B reversed: after B only B is asked to retire',
        reversed.mid.filter(e => e.startsWith('emit:candidate_reset')),
        ['emit:candidate_reset:TB']);
    check('§12 A/B reversed: B\'s ask follows B\'s creation',
        reversed.mid.indexOf('emit:candidate_reset:TB')
            > reversed.mid.indexOf('created:TB_NEW'), true);
    check('§12 A/B reversed: each old id is asked exactly once, no disconnects',
        [reversed.full.filter(e => e.startsWith('emit:candidate_reset')).sort(),
            reversed.full.filter(e => e.startsWith('emit:ssh_disconnect'))],
        [['emit:candidate_reset:TA', 'emit:candidate_reset:TB'], []]);
    check('§12 A/B reversed: A\'s ask follows A\'s creation',
        reversed.full.indexOf('emit:candidate_reset:TA')
            > reversed.full.indexOf('created:TA_NEW'), true);
    // The acks retire each on its OWN id -- and the UI removal only happens
    // here, after the ask, exactly once per candidate.
    const acked = await page.evaluate(() => {
        const recs = Object.entries(SessionManager.candidateRetirements)
            .map(([rid, r]) => ({ rid, sid: r.sessionId }));
        for (const { rid, sid } of recs) {
            window.__server('candidate_reset_ack', {
                ok: true, session_id: sid, request_id: rid,
            });
        }
        return window.__timeline.slice();
    });
    check('§12 A/B reversed: each old UI is removed exactly once, after the ask',
        acked.filter(e => e.startsWith('removedUI:')).sort(),
        ['removedUI:TA', 'removedUI:TB']);
    check('§12 A/B reversed: both intents are consumed', reversed.intents, 0);
    check('§12 A/B reversed: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §13 D2a — the TRANSPORT-LOSS promotion and its retirement contract.
//
//     Phase 0 live diagnostic (run msruuq45, owner-approved fix)
//     captured the divergence live: a LIVE session that loses its transport
//     while still owning a valid tmux identity read "Session disconnected /
//     Retry", armed its reconnect intent with retireOnSuccess:false, and on a
//     successful retry the new session id was created NEXT TO the dead one —
//     two chips for one logical session, with the wrong copy.
//
//     The fix (session-manager.js): such a session IS a persistent candidate
//     from the instant its transport dies — exactly as one restored from the
//     DB after a restart — promoted in updateSessionStatus, which is the real
//     transition the app's ssh_disconnected handler makes. The overlay, the
//     reconnect route, the intent and the retirement then all come from the
//     EXISTING candidate machinery, so the assertions here pin the promotion
//     and, in the following blocks, what it inherits:
//
//       * transport loss promotes a valid-tmux session to a persistent
//         candidate and its overlay/action says Reconnect, never Retry;
//       * success retires the old chip and carries its transcript across —
//         only after the replacement exists;
//       * failure changes nothing — the candidate chip and its state survive;
//       * an ordinary non-tmux Retry retires its dead chip on success only;
//       * a rapid double click cannot create two replacements.
// ============================================================================

{
    // ---- transport loss promotes a valid-tmux session to a candidate ------
    const { ctx, page, errors } = await newPage();
    // A LIVE password+tmux session, the shape Phase 0 captured diverging.
    await seed(page, 'D2', { authType: 'password', keyId: null });
    const before = await page.evaluate(() => ({
        connected: SessionManager.sessions.D2.connected,
        candidate: SessionManager.sessions.D2.isPersistentCandidate,
        tmux: SessionManager.sessions.D2.tmuxSessionName,
    }));
    check('§13 promotion: seeded LIVE, non-candidate, valid tmux identity',
        [before.connected, before.candidate, before.tmux],
        [true, false, 'tmx_D2']);

    // The real transport-loss transition: the exact call the app's own
    // ssh_disconnected handler makes. It runs the promotion, repaints the
    // chip and builds the overlay — all through production code, never a
    // synthetic copy of any of it.
    await page.evaluate(() =>
        SessionManager.updateSessionStatus('D2', 'disconnected'));

    const after = await page.evaluate(() => {
        // unassigned is display:none; lifting it paints nothing new, it only
        // makes the already-built overlay inspectable (same step as §6).
        document.getElementById('term-D2')?.classList.remove('unassigned');
        const overlay = document.querySelector('#term-D2 .session-overlay');
        const heading = overlay?.querySelector('.session-overlay-card h3');
        const btn = overlay?.querySelector('.session-overlay-card button');
        return {
            connected: SessionManager.sessions.D2.connected,
            candidate: SessionManager.sessions.D2.isPersistentCandidate,
            tmuxKept: SessionManager.sessions.D2.tmuxSessionName,
            chipStillThere: !!document.getElementById('tab-D2'),
            hasOverlay: !!overlay,
            heading: heading ? heading.textContent : null,
            headingI18n: heading?.dataset.i18n || null,
            buttonLabel: btn ? btn.textContent : null,
            buttonI18n: btn?.dataset.i18n || null,
        };
    });
    check('§13 promotion: the session is marked disconnected',
        after.connected, false);
    check('§13 promotion: transport loss PROMOTES it to a persistent candidate',
        after.candidate, true);
    check('§13 promotion: the tmux identity survives the promotion',
        after.tmuxKept, 'tmx_D2');
    check('§13 promotion: the chip is not destroyed by the loss',
        after.chipStillThere, true);
    check('§13 promotion: the overlay is shown for the dead transport',
        after.hasOverlay, true);
    check('§13 promotion: the overlay says Persistent session, not disconnected',
        [after.headingI18n, after.heading],
        ['session.persistent', 'Persistent session']);
    check('§13 promotion: the overlay action is Reconnect, NEVER Retry',
        [after.buttonI18n, after.buttonLabel],
        ['session.reconnect', 'Reconnect']);
    check('§13 promotion: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- successful replacement: ONE chip, exact tmux, retire ONLY now ----
    const { ctx, page, errors } = await newPage();
    // The promoted candidate: dead transport, valid tmux identity, its chip
    // still on offer — the exact shape the promotion block produced.
    await seed(page, 'D2S', {
        connected: false, isPersistentCandidate: true,
        authType: 'password', keyId: null, tmuxSessionName: 'tmx_D2S',
    });
    // Arm the APPROVED intent exactly as the candidate route does: the exact
    // tmux name and retireOnSuccess:true, keyed by its own request id.
    const armed = await page.evaluate(() => {
        const intent = SessionManager.beginReconnectIntent('D2S',
            { ownsModal: true });
        return intent ? {
            requestId: intent.requestId,
            sessionId: intent.sessionId,
            tmuxSessionName: intent.tmuxSessionName,
            retireOnSuccess: intent.retireOnSuccess,
            hasPassword: Object.prototype.hasOwnProperty.call(intent, 'password'),
        } : null;
    });
    check('§13 success retirement: the intent is armed for THIS session',
        armed && armed.sessionId, 'D2S');
    check('§13 success retirement: the intent carries the EXACT tmux name',
        armed && armed.tmuxSessionName, 'tmx_D2S');
    check('§13 success retirement: the intent retires on success',
        armed && armed.retireOnSuccess, true);
    check('§13 success retirement: the intent holds no secret',
        armed && armed.hasPassword, false);

    // Seed the replacement the server would create for this request: a LIVE
    // session reattached to the SAME tmux name. The old chip is still on
    // screen at this instant — two chips for one logical session, the exact
    // divergence Phase 0 captured live — until the retirement runs.
    await seed(page, 'D2S_NEW', {
        connected: true, isPersistentCandidate: false,
        authType: 'password', keyId: null, tmuxSessionName: 'tmx_D2S',
    });
    const bothChips = await page.evaluate(() => [
        !!document.getElementById('tab-D2S'),
        !!document.getElementById('tab-D2S_NEW'),
    ]);
    check('§13 success retirement: before completion BOTH chips exist (the defect shape)',
        bothChips, [true, true]);

    const completed = await page.evaluate((rid) =>
        SessionManager.completePendingReconnect('D2S_NEW', rid),
        armed.requestId);
    await page.waitForTimeout(80);
    const finalState = await page.evaluate(() => ({
        oldSession: !!SessionManager.sessions.D2S,
        oldChip: !!document.getElementById('tab-D2S'),
        newSession: !!SessionManager.sessions.D2S_NEW,
        newChip: !!document.getElementById('tab-D2S_NEW'),
        newTmux: SessionManager.sessions.D2S_NEW?.tmuxSessionName || null,
        intents: Object.keys(SessionManager.reconnectIntents).length,
        claim: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.D2S),
    }));
    check('§13 success retirement: the reply completes the pending reconnect',
        completed, true);
    check('§13 success retirement: the OLD session is gone',
        finalState.oldSession, false);
    check('§13 success retirement: the OLD chip is retired',
        finalState.oldChip, false);
    check('§13 success retirement: the REPLACEMENT session remains',
        finalState.newSession, true);
    check('§13 success retirement: the REPLACEMENT chip remains',
        finalState.newChip, true);
    check('§13 success retirement: EXACTLY ONE of the two chips exists',
        [finalState.oldChip, finalState.newChip], [false, true]);
    check('§13 success retirement: the replacement keeps the EXACT tmux name',
        finalState.newTmux, 'tmx_D2S');
    check('§13 success retirement: the intent is consumed exactly once',
        finalState.intents, 0);
    check('§13 success retirement: the session claim is released',
        finalState.claim, false);
    check('§13 success retirement: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- failed replacement: NOTHING is destroyed, candidate stays offerable
    const { ctx, page, errors } = await newPage();
    // The promoted candidate, carrying the history a failure must keep.
    await seed(page, 'D2F', {
        connected: false, isPersistentCandidate: true,
        authType: 'password', keyId: null, tmuxSessionName: 'tmx_D2F',
    });
    await page.evaluate((sid) => {
        TerminalManager.transcripts = TerminalManager.transcripts || {};
        TerminalManager.transcriptSizes = TerminalManager.transcriptSizes || {};
        TerminalManager.transcripts[sid] = ['FAILED-ROUTE-HISTORY\n'];
        TerminalManager.transcriptSizes[sid] = 'FAILED-ROUTE-HISTORY\n'.length;
    }, 'D2F');

    // Arm the approved intent: exact tmux name, retireOnSuccess:true.
    const armed = await page.evaluate(() => {
        const intent = SessionManager.beginReconnectIntent('D2F',
            { ownsModal: true });
        return intent ? { requestId: intent.requestId,
            tmux: intent.tmuxSessionName,
            retireOnSuccess: intent.retireOnSuccess } : null;
    });
    check('§13 failure: the intent is armed with the exact tmux and retirement rule',
        armed && [armed.tmux, armed.retireOnSuccess], ['tmx_D2F', true]);

    // The PRODUCTION failure shape: the server answers THIS request with
    // ssh_error and no ssh_connected ever arrives for it — there is no other
    // form a failed replacement takes. Drive the app's own registered handler
    // through __server, never a copy of its body.
    await page.evaluate((rid) => {
        window.__server('ssh_error', {
            error: 'Connection failed', client_request_id: rid });
    }, armed.requestId);
    await page.waitForTimeout(80);

    const afterFail = await page.evaluate(() => ({
        sessionKnown: !!SessionManager.sessions.D2F,
        chip: !!document.getElementById('tab-D2F'),
        candidate: SessionManager.sessions.D2F?.isPersistentCandidate,
        tmux: SessionManager.sessions.D2F?.tmuxSessionName,
        transcript: (window.TerminalManager?.transcripts?.D2F || []).join(''),
        sessionsCount: Object.keys(SessionManager.sessions).length,
        chips: [...document.querySelectorAll('.session-tab')].map(t => t.id),
        intents: Object.keys(SessionManager.reconnectIntents).length,
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.D2F),
    }));
    check('§13 failure: the old SESSION survives the failed replacement',
        afterFail.sessionKnown, true);
    check('§13 failure: the old CHIP survives the failed replacement',
        afterFail.chip, true);
    check('§13 failure: it is STILL a persistent candidate with its exact tmux',
        [afterFail.candidate, afterFail.tmux], [true, 'tmx_D2F']);
    check('§13 failure: its history survives',
        afterFail.transcript, 'FAILED-ROUTE-HISTORY\n');
    check('§13 failure: NO replacement is adopted — exactly one session, its own chip',
        [afterFail.sessionsCount, afterFail.chips], [1, ['tab-D2F']]);
    // The failed request's per-request record is dropped and its claim is
    // released — the session itself is untouched, which is exactly what keeps
    // it reconnectable. A claim left behind would make the candidate
    // permanently un-reconnectable (beginReconnectIntent refuses a second arm).
    check('§13 failure: the failed request\'s intent is dropped',
        afterFail.intents, 0);
    check('§13 failure: the session claim is released', afterFail.claimed, false);

    // Retryability is the point of keeping everything: a FRESH intent arms for
    // the same candidate. Had the failure left its state behind, this would
    // return null and the offer would be dead.
    const rearmed = await page.evaluate(() => {
        const intent = SessionManager.beginReconnectIntent('D2F',
            { ownsModal: true });
        return intent ? { sessionId: intent.sessionId,
            tmux: intent.tmuxSessionName } : null;
    });
    check('§13 failure: the candidate can arm a FRESH reconnect (retryable)',
        rearmed && [rearmed.sessionId, rearmed.tmux], ['D2F', 'tmx_D2F']);
    check('§13 failure: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- D2a: the ORDINARY non-tmux Retry — payload and success retirement -
    //
    // The shape Phase 0 captured diverging: connected:false, NOT a candidate,
    // no tmux identity at all. Its overlay honestly says Retry, its payload
    // must stay a PLAIN restore — use_tmux:false asserted EXPLICITLY (the
    // shape Reset uses; never a bare true, which would make the server create
    // a NEW tmux session) and reconnect_tmux_name ABSENT — and its dead chip
    // must retire ONLY after the replacement exists.
    const { ctx, page, errors } = await newPage();
    await seed(page, 'D2N', {
        connected: false, isPersistentCandidate: false,
        authType: 'password', keyId: null,
        useTmux: false, tmuxSessionName: null,
    });
    const overlay = await page.evaluate(() => {
        document.getElementById('term-D2N')?.classList.remove('unassigned');
        SessionManager.showReconnectOverlay('D2N');
        const btn = document.querySelector('#term-D2N .session-overlay-card button');
        return {
            hasOverlay: !!document.querySelector('#term-D2N .session-overlay'),
            label: btn ? btn.textContent : null,
            candidate: SessionManager.sessions.D2N.isPersistentCandidate,
        };
    });
    check('§13 non-tmux Retry: the overlay is shown with honest Retry copy',
        [overlay.hasOverlay, overlay.label], [true, 'Retry']);
    check('§13 non-tmux Retry: no promotion without a tmux identity',
        overlay.candidate, false);

    // The REAL Retry click through the production handler.
    await page.click('#term-D2N .session-overlay-card button');
    await page.waitForTimeout(80);
    const armed = await page.evaluate(() => {
        const intent = SessionManager.activeReconnectIntent()
            || Object.values(SessionManager.reconnectIntents)[0];
        return intent ? {
            requestId: intent.requestId,
            sessionId: intent.sessionId,
            tmux: intent.tmuxSessionName,
            retireOnSuccess: intent.retireOnSuccess,
        } : null;
    });
    check('§13 non-tmux Retry: the intent names THIS session',
        armed && armed.sessionId, 'D2N');
    check('§13 non-tmux Retry: the intent carries NO tmux name',
        armed && armed.tmux, null);
    check('§13 non-tmux Retry: the intent retires the dead chip on success',
        armed && armed.retireOnSuccess, true);

    // Submit the REAL form exactly as a user does.
    await resetEmits(page);
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await page.waitForTimeout(80);
    const frameInfo = await page.evaluate(() => {
        const frames = window.__emits.filter(e => e.ev === 'ssh_connect');
        const f = frames[0];
        return {
            count: frames.length,
            useTmux: f ? f.payload.use_tmux : null,
            hasUseTmux: f ? ('use_tmux' in f.payload) : false,
            tmux: f ? f.payload.reconnect_tmux_name : null,
            rid: f ? f.payload.client_request_id : null,
        };
    });
    check('§13 non-tmux Retry: exactly one ssh_connect is emitted',
        frameInfo.count, 1);
    check('§13 non-tmux Retry: the frame carries THIS request\'s id',
        frameInfo.rid, armed.requestId);
    // The approved D2a contract: a reconnect intent WITHOUT a tmux name keeps
    // non-tmux semantics by ASSERTING use_tmux:false explicitly (the shape
    // Reset already uses), never by leaving the flag to a server default, and
    // never by pairing true with no name — the "fresh tmux session" defect
    // class. reconnect_tmux_name must be absent either way.
    check('§13 non-tmux Retry: the frame asserts use_tmux:false explicitly',
        [frameInfo.hasUseTmux, frameInfo.useTmux], [true, false]);
    check('§13 non-tmux Retry: the frame has NO reconnect_tmux_name',
        frameInfo.tmux, undefined);

    // Success: the replacement must exist BEFORE the old chip retires.
    await armTimeline(page, 'D2N', 'D2N_NEW');
    await page.evaluate((rid) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'D2N_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
    }, armed.requestId);
    await page.waitForTimeout(120);
    const timeline = await readTimeline(page);
    const iCreated = timeline.indexOf('created:D2N_NEW');
    const iRemoved = timeline.indexOf('removedUI:D2N');
    check('§13 non-tmux Retry success: the replacement session is created',
        iCreated >= 0, true);
    check('§13 non-tmux Retry success: the old chip retires ONLY after it exists',
        iCreated >= 0 && iRemoved > iCreated, true);
    check('§13 non-tmux Retry success: exactly one UI removal, of the exact old id',
        timeline.filter(e => e.startsWith('removedUI:')), ['removedUI:D2N']);
    const afterSuccess = await page.evaluate(() => ({
        oldSession: !!SessionManager.sessions.D2N,
        oldChip: !!document.getElementById('tab-D2N'),
        newSession: !!SessionManager.sessions.D2N_NEW,
        newChip: !!document.getElementById('tab-D2N_NEW'),
        intents: Object.keys(SessionManager.reconnectIntents).length,
    }));
    check('§13 non-tmux Retry success: EXACTLY ONE chip remains — the replacement',
        [afterSuccess.oldSession, afterSuccess.oldChip,
            afterSuccess.newSession, afterSuccess.newChip],
        [false, false, true, true]);
    check('§13 non-tmux Retry success: the intent is consumed exactly once',
        afterSuccess.intents, 0);
    check('§13 non-tmux Retry success: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- D2a: the SAME non-tmux Retry, failed — nothing is destroyed -------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'D2R', {
        connected: false, isPersistentCandidate: false,
        authType: 'password', keyId: null,
        useTmux: false, tmuxSessionName: null,
    });
    await page.evaluate(() => {
        document.getElementById('term-D2R')?.classList.remove('unassigned');
        SessionManager.showReconnectOverlay('D2R');
    });
    await page.click('#term-D2R .session-overlay-card button');
    await page.waitForTimeout(80);
    const armed = await page.evaluate(() => {
        const intent = SessionManager.activeReconnectIntent()
            || Object.values(SessionManager.reconnectIntents)[0];
        return intent ? { requestId: intent.requestId,
            retireOnSuccess: intent.retireOnSuccess } : null;
    });
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await page.waitForTimeout(80);
    // The production failure shape: ssh_error naming THIS request, and no
    // ssh_connected ever arrives for it.
    await page.evaluate((rid) => {
        window.__server('ssh_error', {
            error: 'Connection failed', client_request_id: rid });
    }, armed.requestId);
    await page.waitForTimeout(80);
    const afterFail = await page.evaluate(() => ({
        sessionKnown: !!SessionManager.sessions.D2R,
        chip: !!document.getElementById('tab-D2R'),
        chips: [...document.querySelectorAll('.session-tab')].map(t => t.id),
        intents: Object.keys(SessionManager.reconnectIntents).length,
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.D2R),
    }));
    check('§13 non-tmux Retry failure: the old session and chip survive',
        [afterFail.sessionKnown, afterFail.chip], [true, true]);
    check('§13 non-tmux Retry failure: NO replacement is adopted',
        afterFail.chips, ['tab-D2R']);
    check('§13 non-tmux Retry failure: the intent is cleared',
        afterFail.intents, 0);
    check('§13 non-tmux Retry failure: the session claim is released',
        afterFail.claimed, false);
    check('§13 non-tmux Retry failure: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- D2a: RAPID DOUBLE-ACTIVATION — one press's worth of work ----------
    //
    // Two fast taps on the same dead session's Retry action must not arm two
    // intents, open two forms, or emit two requests. The one-owner guard lives
    // in beginReconnectIntent's claim; this drives the REAL overlay click and
    // the REAL submit, then proves the reply path retires the old chip exactly
    // once — and that a replayed success cannot retire it a second time.
    const { ctx, page, errors } = await newPage();
    await seed(page, 'D2D', {
        connected: false, isPersistentCandidate: false,
        authType: 'password', keyId: null,
        useTmux: false, tmuxSessionName: null,
    });
    await page.evaluate(() => {
        document.getElementById('term-D2D')?.classList.remove('unassigned');
        SessionManager.showReconnectOverlay('D2D');
    });
    // Two real clicks, back to back, before any reply — dispatched
    // synchronously on the SAME button so both reach the production listener
    // before the form the first click opens can occlude the second pointer.
    await page.evaluate(() => {
        const btn = document.querySelector('#term-D2D .session-overlay-card button');
        btn.click();
        btn.click();
    });
    await page.waitForTimeout(80);

    const guard = await page.evaluate(() => ({
        intents: Object.keys(SessionManager.reconnectIntents).length,
        intentSession: (Object.values(SessionManager.reconnectIntents)[0]
            || {}).sessionId || null,
        intentTmux: (Object.values(SessionManager.reconnectIntents)[0]
            || {}).tmuxSessionName,
        claimed: !!(SessionManager.reconnectingSessions
            && SessionManager.reconnectingSessions.D2D),
        owner: SessionManager.activeReconnectRequestId,
        modalOpen: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
    }));
    check('§13 double activation: EXACTLY ONE intent for the double tap',
        guard.intents, 1);
    check('§13 double activation: the single intent names THIS session, no tmux',
        [guard.intentSession, guard.intentTmux], ['D2D', null]);
    check('§13 double activation: the session has EXACTLY ONE claim',
        guard.claimed, true);
    check('§13 double activation: EXACTLY ONE credential-modal owner',
        typeof guard.owner, 'string');
    check('§13 double activation: one credential form is open',
        guard.modalOpen, true);

    const ownerRid = guard.owner;
    await resetEmits(page);
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await page.waitForTimeout(80);
    const frames = await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_connect')
        .map(e => e.payload.client_request_id));
    check('§13 double activation: EXACTLY ONE ssh_connect from the double tap',
        frames, [ownerRid]);

    // One matching success.
    await armTimeline(page, 'D2D', 'D2D_NEW');
    await page.evaluate((rid) => {
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'D2D_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
    }, ownerRid);
    await page.waitForTimeout(120);
    const timeline = await readTimeline(page);
    check('§13 double activation: exactly ONE replacement is created',
        timeline.filter(e => e.startsWith('created:')), ['created:D2D_NEW']);
    check('§13 double activation: EXACTLY ONE old-chip retirement',
        timeline.filter(e => e.startsWith('removedUI:')), ['removedUI:D2D']);
    const once = await page.evaluate(() => ({
        oldGone: !SessionManager.sessions.D2D,
        oldChipGone: !document.getElementById('tab-D2D'),
        newThere: !!SessionManager.sessions.D2D_NEW,
        newChip: !!document.getElementById('tab-D2D_NEW'),
        intents: Object.keys(SessionManager.reconnectIntents).length,
    }));
    check('§13 double activation: one logical session remains — the replacement',
        [once.oldGone, once.oldChipGone, once.newThere, once.newChip],
        [true, true, true, true]);
    check('§13 double activation: the intent is consumed', once.intents, 0);

    // A replayed copy of the SAME success must retire NOTHING a second time.
    await page.evaluate((rid) => {
        window.__timeline.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'D2D_NEW2', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
    }, ownerRid);
    await page.waitForTimeout(120);
    const replay = await readTimeline(page);
    check('§13 double activation: a replayed success retires NOTHING',
        replay.filter(e => e.startsWith('removedUI:')), []);
    check('§13 double activation: no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §14 W13-B5 — ORDINARY-DISCONNECTED RECONNECT MUST BE TRUTHFUL.
//
//    requestReconnect used to fall through to prefillConnectionForm for every
//    disconnected non-candidate session, with no gate and no copy. For a
//    session with no tmux identity the form opened bare under the Reconnect
//    label — indistinguishable from Reset's modal — and the payload then
//    performed a fresh raw connection. For a session that still owns a valid
//    tmux name but is not flagged a candidate, nothing said it reattaches the
//    retained session before the form opened.
//
//    The truthful contract pinned here, one block per shape, all driven
//    through requestReconnect (the one lifecycle owner) exactly as the sheet,
//    toolbar proxy, chip gesture and overlay all do:
//
//      A. valid tmux identity, not a candidate  -> confirm gate whose copy
//         says the retained tmux session is reattached (NOT Reset's copy),
//         then the form with a reconnect intent armed WITH the exact name;
//         submit reattaches — never a fresh tmux session;
//      B. useTmux/candidate shape but identity lost -> REFUSE with the honest
//         message; nothing opens, nothing emits, the chip survives;
//      C. never had tmux -> the credential form opens with the reconnect
//         intent banner visible, and submit is a BARE restore (use_tmux:false,
//         no name) — truthful, not Reset-shaped; on success the old chip is
//         retired exactly once.
// ============================================================================

{
    // ---- A: valid tmux identity, disconnected, not a candidate ------------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'B5A', {
        connected: false, isPersistentCandidate: false,
        authType: 'password', keyId: null,
    });
    // seed's updateSessionStatus('disconnected') runs D2a's transport-loss
    // promotion, which promotes a valid-tmux session to a candidate (its
    // covered route lives in §5/§6). This block pins the OTHER shape the
    // reconnect owner must handle truthfully: a disconnected record that owns
    // a valid tmux name but is NOT flagged a candidate (a record whose flag
    // was lost across a restore, a future caller). Reset the flag AFTER the
    // seed so requestReconnect is exercised against exactly that shape.
    await page.evaluate(() => {
        SessionManager.sessions.B5A.isPersistentCandidate = false;
    });
    await resetEmits(page);
    await page.evaluate(() => SessionManager.requestReconnect('B5A'));
    const d = await readDialog(page);
    check('§14A: a confirm gate opens (no silent form)', d.open, true);
    check('§14A: the gate is NOT dressed as destructive', d.danger, false);
    check('§14A: icon is Reconnect\'s plug-zap', d.icon, 'icon-plug-zap');
    check('§14A: body promises the RETAINED tmux session is reattached',
        d.body.includes('reattaches the retained tmux session'), true);
    check('§14A: body is NOT Reset\'s fresh-session copy',
        d.body.includes('without reattaching tmux'), false);
    check('§14A: nothing is emitted before the gate is accepted',
        (await readEmits(page)).length, 0);

    await acceptDialog(page);
    const afterAccept = await page.evaluate(() => {
        const meta = SessionManager.activeReconnectIntent();
        return {
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            banner: !!document.getElementById('connectionFormIntent')
                && !document.getElementById('connectionFormIntent').hidden,
            bannerTitle: document.getElementById('connectionFormIntentTitle')
                ?.textContent || '',
            intentTmux: meta ? meta.tmuxSessionName : null,
            intentSession: meta ? meta.sessionId : null,
            emits: window.__emits.map(e => e.ev),
        };
    });
    check('§14A: accept opens the credential form', afterAccept.modal, true);
    check('§14A: the form carries the reconnect intent banner',
        afterAccept.banner, true);
    check('§14A: the intent is armed WITH the exact tmux name',
        [afterAccept.intentSession, afterAccept.intentTmux],
        ['B5A', 'tmx_B5A']);
    check('§14A: nothing is emitted until submit', afterAccept.emits.length, 0);

    const submitted = await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return {
            emits: window.__emits.map(e => e.ev),
            useTmux: frame?.payload?.use_tmux,
            tmux: frame?.payload?.reconnect_tmux_name,
            hasPassword: Object.prototype.hasOwnProperty.call(
                frame?.payload || {}, 'password'),
        };
    });
    check('§14A: submit emits exactly one ssh_connect',
        submitted.emits, ['ssh_connect']);
    check('§14A: the payload REATTACHES the retained tmux session',
        [submitted.useTmux, submitted.tmux], [true, 'tmx_B5A']);
    check('§14A: the typed password rides on the frame',
        submitted.hasPassword, true);

    // Success: the replacement arrives and the old chip retires exactly once.
    // Retirement is UI-only by contract (§13): the old session is already
    // DISCONNECTED, so there is nothing to ssh_disconnect — removeSessionUI
    // drops the chip and the replacement takes its place. A disconnect here
    // would be wrong, and would kill the retained tmux session on the host.
    const rid = await page.evaluate(() => {
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return frame?.payload?.client_request_id;
    });
    const done = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'B5A_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: true, tmux_session_name: 'tmx_B5A', auth_type: 'password',
        });
        return {
            oldGone: !SessionManager.sessions.B5A,
            oldChip: !!document.getElementById('tab-B5A'),
            newThere: !!SessionManager.sessions.B5A_NEW,
            emits: window.__emits.map(e => e.ev),
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect')
                .map(e => e.payload?.session_id),
        };
    }, rid);
    check('§14A: on success the dead chip retires', done.oldGone, true);
    check('§14A: the old chip element is removed', done.oldChip, false);
    check('§14A: the replacement exists under the retained tmux name',
        done.newThere, true);
    check('§14A: NO disconnect is emitted for an already-disconnected session',
        done.disconnects, []);
    check('§14A: the success round trip emits nothing at all',
        done.emits.filter(e => e === 'ssh_disconnect').length, 0);
    check('§14A: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- B: tmux shape but the identity is lost — refuse, truthfully -----
    const { ctx, page, errors } = await newPage();
    await seed(page, 'B5B', {
        connected: false, isPersistentCandidate: false, useTmux: true,
        tmuxSessionName: null, authType: 'password', keyId: null,
    });
    await resetEmits(page);
    await page.evaluate(() => SessionManager.requestReconnect('B5B'));
    const after = await page.evaluate(() => ({
        dialog: !document.getElementById('sessionConfirm').hidden,
        modal: !!document.getElementById('connectionModal')
            ?.classList.contains('show'),
        emits: window.__emits.map(e => e.ev),
        note: (window.__notes[window.__notes.length - 1] || {}),
        chipStillThere: !!document.getElementById('tab-B5B'),
        intents: Object.keys(SessionManager.reconnectIntents).length,
    }));
    check('§14B: no dialog opens', after.dialog, false);
    check('§14B: no credential form opens under a false promise',
        after.modal, false);
    check('§14B: nothing is emitted', after.emits, []);
    check('§14B: the user is told reattaching is impossible',
        after.note.t, 'error');
    check('§14B: the refusal names Reset as the explicit fresh route',
        after.note.m.includes('Reset'), true);
    check('§14B: the chip survives the refusal', after.chipStillThere, true);
    check('§14B: no intent is armed', after.intents, 0);
    check('§14B: no page errors', errors.join(' | '), '');
    await ctx.close();
}

{
    // ---- C: never had tmux — the bare RESTORE, labelled truthfully -------
    const { ctx, page, errors } = await newPage();
    await seed(page, 'B5C', {
        connected: false, isPersistentCandidate: false, useTmux: false,
        tmuxSessionName: null, authType: 'password', keyId: null,
    });
    await resetEmits(page);
    await page.evaluate(() => SessionManager.requestReconnect('B5C'));
    const opened = await page.evaluate(() => {
        const meta = SessionManager.activeReconnectIntent();
        return {
            modal: !!document.getElementById('connectionModal')
                ?.classList.contains('show'),
            banner: !!document.getElementById('connectionFormIntent')
                && !document.getElementById('connectionFormIntent').hidden,
            bannerTitle: document.getElementById('connectionFormIntentTitle')
                ?.textContent || '',
            dialog: !document.getElementById('sessionConfirm').hidden,
            intentTmux: meta ? meta.tmuxSessionName : null,
            intentSession: meta ? meta.sessionId : null,
            emits: window.__emits.map(e => e.ev),
        };
    });
    check('§14C: the form opens directly (this is the restore route)',
        opened.modal, true);
    check('§14C: no confirm gate on the restore route', opened.dialog, false);
    check('§14C: the reconnect intent banner is visible on the modal',
        opened.banner, true);
    check('§14C: the banner says Reconnect, never Reset',
        opened.bannerTitle.includes('Reconnect'), true);
    check('§14C: the intent is armed without any tmux name',
        [opened.intentSession, opened.intentTmux], ['B5C', null]);
    check('§14C: nothing is emitted before submit', opened.emits.length, 0);

    const submitted = await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true }));
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return {
            emits: window.__emits.map(e => e.ev),
            useTmux: frame?.payload?.use_tmux,
            tmux: frame?.payload?.reconnect_tmux_name,
        };
    });
    check('§14C: submit emits exactly one ssh_connect',
        submitted.emits, ['ssh_connect']);
    check('§14C: the payload is the BARE restore — no tmux promise',
        [submitted.useTmux, submitted.tmux], [false, null]);

    const rid = await page.evaluate(() => {
        const frame = window.__emits.find(e => e.ev === 'ssh_connect');
        return frame?.payload?.client_request_id;
    });
    const done = await page.evaluate((rid) => {
        window.__emits.length = 0;
        window.__server('ssh_connected', {
            snapshot_version: 1, session_id: 'B5C_NEW', host: 'tiny.example',
            port: 22, username: 'sshdtest', client_request_id: rid,
            use_tmux: false, tmux_session_name: null, auth_type: 'password',
        });
        return {
            oldGone: !SessionManager.sessions.B5C,
            oldChip: !!document.getElementById('tab-B5C'),
            newThere: !!SessionManager.sessions.B5C_NEW,
            disconnects: window.__emits.filter(e => e.ev === 'ssh_disconnect')
                .map(e => e.payload?.session_id),
        };
    }, rid);
    check('§14C: on success the dead chip retires', done.oldGone, true);
    check('§14C: the old chip element is removed', done.oldChip, false);
    check('§14C: the logical session is restored', done.newThere, true);
    check('§14C: NO disconnect is emitted for an already-disconnected session',
        done.disconnects, []);
    check('§14C: no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
