/*
 * P2 — Session strip & lifecycle toolbar contract (Batch 2 redesign).
 *
 * The connections-bar lifecycle toolbar: three DIRECT Rename/Reconnect/Reset
 * controls beside the horizontal session strip in .session-tabs-row. The old
 * role=menu action sheet (#sessionActionsBtn/#sessionActionsSheet and its
 * role=menuitem rows) is gone; one delegated click listener on
 * #sessionActionsControl dispatches through dispatchLifecycleAction ->
 * startRenameSession / requestReconnect / requestResetSession.
 *
 * The displayed activeSessionId stays separate from lifecycleActionTargetId:
 * tapping a live chip selects it and activates its pane; tapping an
 * inactive/disconnected/persistent-candidate chip selects that exact lifecycle
 * target only — no auto-reconnect, no pane eviction, no composer/xterm focus,
 * no modal autofocus, no keyboard.
 *
 *  §1  Toolbar geometry across seven touch contexts: control is
 *      capability-visible (display:flex), every button is a real 44x44 target,
 *      toolbar footprint is 140px (3x44 + 2x4 gap), the toolbar never consumes
 *      composer space, and the uncovered strip stays >=120px (at 359px the
 *      invariant is 359 - 144 = 215px). Fine-pointer desktop keeps display:none.
 *  §2  Reset direct path (key target + key jump): confirm first; exactly one
 *      ssh_connect with use_tmux:false, reconnect_tmux_name:null, fresh
 *      reset_* client_request_id, seven non-secret fields preserved, no
 *      password property anywhere; zero ssh_input throughout.
 *  §3  Reset modal path (password target): confirm → zero emits + modal open
 *      with non-secret prefill + jumpHostSelect change fired + tmux unchecked
 *      + no autofocus; form submit → exactly one ssh_connect with reset_* id,
 *      use_tmux:false, reconnect_tmux_name:null, original session closed once.
 *      Cancel → original session intact, no emit.
 *  §4  Rail lock at 834×1194 + 1194×834 + 428×926: computed overflow-y:hidden,
 *      overscroll-behavior-x:contain, touch-action:pan-x; real gesture proving
 *      no vertical scroll leakage.
 *  §4b Orientation round trip (portrait <-> phone landscape): #sessionTabs
 *      stays in .session-tabs-row and #sessionActionsControl stays the root
 *      overlay host -- the SAME DOM nodes, no clone, no duplicate ids -- both
 *      usable in both orientations, focus preserved for either owner. (The
 *      dock relocation this section used to pin was retired.)
 *  §5  Target model + 3x3 matrix: (live L / ordinary-disconnected D /
 *      persistent-candidate C) x (Rename / Reconnect / Reset), plus focus spies
 *      and the zero-action selection clause. D-Reconnect is the J9 else branch:
 *      no confirm, modal opens for D, zero emit before submit, and explicit
 *      submit emits exactly one ssh_connect for D.
 *  §6  Static sole-setter invariants: lifecycleActionTargetId is assigned only
 *      in the object-literal init and inside setLifecycleActionTarget, which is
 *      called only from switchSession, setActivePane and removeSessionUI.
 *  §7  Dead-code checks: the removed sheet selectors and ids are absent from
 *      style.css, index.html and session-manager.js, and no removed node
 *      resolves in a live page.
 *
 * Uses the same renderTemplate / http-server / STUBS infrastructure as the
 * existing browser suites. No production source is modified by this test.
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

const STUBS = `
    const noop = () => {};
    window.socket = { connected: false, on: noop, off: noop, once: noop, emit: noop, io: { on: noop } };
    // NOTE ON LOAD ORDER: addInitScript runs BEFORE static/js/terminal-manager.js,
    // which ends with 'window.TerminalManager = TerminalManager' (line 1139) and
    // replaces this whole object. So nothing here can seed the terminal registry
    // or override isTouchShell — the real capability query decides touch-ness
    // (satisfied by hasTouch:true contexts). Focus sentinels are therefore
    // installed AFTER load, into the production registry, by
    // installFocusSentinels(). This stub only stands in for pre-load globals
    // that terminal-manager.js does not define.
    //
    // focusTerminal is deliberately absent: production has no such method.
    window.TerminalManager = {
        createTerminal: noop, disposeTerminal: noop, fitAllTerminals: noop,
        fitTerminal: noop, applyThemeToAll: noop,
        requestFit: noop, cancelPendingFit: noop,
        getTerminal: () => null, writeToTerminal: noop, destroyTerminal: noop,
        isTouchShell: () => true, isDesktopShell: () => false,
    };
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
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
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    return { ctx, page, errors };
}

// Seed a real session through SessionManager so the seven-field store and tab
// wiring are exercised. Returns the seeded session object. `connected`,
// `isPersistentCandidate` and `tmuxSessionName` are explicit so the §5 matrix
// can seed live (L), ordinary-disconnected (D) and candidate (C) targets.
async function seedSession(page, id, opts = {}) {
    return await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = {
            id, session_id: id,
            host: opts.host || 'host.example',
            port: opts.port || 22,
            username: opts.username || 'sshdeck',
            authType: opts.authType || 'key',
            keyId: opts.keyId !== undefined ? opts.keyId : 'k1',
            jumpHostId: opts.jumpHostId || null,
            displayName: opts.displayName || 'Prod DB',
            connected: opts.connected !== undefined ? opts.connected : true,
            isPersistentCandidate: opts.isPersistentCandidate || false,
            tmuxSessionName: opts.tmuxSessionName || null,
            terminalId: `term-${id}`,
            useTmux: opts.useTmux || false,
            viaJump: opts.viaJump || null,
            latencyMs: typeof opts.latencyMs === 'number' ? opts.latencyMs : null,
        };
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, opts.host || 'host.example', opts.username || 'sshdeck');
        }
        if (opts.activate !== false) {
            SessionManager.activeSessionId = id;
        }
        return SessionManager.sessions[id];
    }, { id, opts });
}

// Make a chip the lifecycle target the way a user does: click the tab, which
// routes through switchSession -> setLifecycleActionTarget (live chips also
// activate a pane; inactive/candidate chips return early and set the target
// only).
//
// Side-effect spies: activeElement alone is too weak a proof — a focus that
// lands and moves away would slip through. So this records real focus EVENTS on
// the composer and both password inputs, and wraps the real .focus of every
// entry in the production TerminalManager.terminals registry (the path
// focusActivePane() takes at session-manager.js:1491 -> 1523). There is no
// TerminalManager.focusTerminal in production, so no such method is wrapped.
// All of these must stay silent for a pure selection across every lifecycle
// target state on the tested touch/coarse shell. Desktop fine-pointer selection
// may focus the terminal by contract.
async function selectChip(page, id) {
    return await page.evaluate((id) => {
        const focusLog = [];
        const handlers = [];
        const wraps = [];
        const map = (window.TerminalManager && window.TerminalManager.terminals) || {};
        window.__termFocusCalls = [];
        try {
            ['mobileInput', 'passwordInput', 'jumpHostPasswordInput'].forEach(sid => {
                const el = document.getElementById(sid);
                if (!el) return;
                const handler = () => focusLog.push(sid);
                el.addEventListener('focus', handler);
                handlers.push({ el, handler });
            });
            // Wrap the real .focus of every production registry entry.
            Object.keys(map).forEach(tid => {
                const term = map[tid];
                if (!term || typeof term.focus !== 'function') return;
                const original = term.focus;
                wraps.push({ tid, term, original });
                term.focus = function (...args) {
                    focusLog.push(`terminal:${tid}`);
                    window.__termFocusCalls.push(tid);
                    return original.apply(this, args);
                };
            });

            document.getElementById(`tab-${id}`).click();

            return {
                target: SessionManager.lifecycleActionTargetId,
                activeId: document.activeElement ? document.activeElement.id : null,
                focusLog: focusLog.slice(),
                terminalFocusCalls: window.__termFocusCalls.length,
                terminalFocusIds: window.__termFocusCalls.join(','),
                registrySize: Object.keys(map).length,
                targetClassOnChip: !!document.querySelector(`#tab-${id}.lifecycle-target`),
                buttonsEnabled: ['sessionActionRename', 'sessionActionReconnect',
                    'sessionActionReset'].every(bid => {
                        const b = document.getElementById(bid);
                        return b && !b.disabled;
                    }),
            };
        } finally {
            handlers.forEach(({ el, handler }) => el.removeEventListener('focus', handler));
            wraps.forEach(({ term, original }) => { term.focus = original; });
        }
    }, id);
}

// Open the lifecycle action sheet the way amendment v5 section 3 specifies:
// "Session disconnected/candidate vẫn bấm được để chọn; chạm lại hoặc nhấn giữ
// mới mở action sheet." The first tap selects (selectChip), a SECOND tap on the
// already-selected chip opens the sheet. There is no in-row trigger to click --
// section 3 forbids a second menu button in the session row -- so this gesture
// is the touch entry point, and the test must drive it rather than reaching
// past it into a hidden sheet.
async function openSheet(page, id) {
    // Idempotent by necessity: the gesture is a TOGGLE, so a caller that has
    // already re-tapped this chip (selectChip on an already-selected chip is
    // itself the second tap) would be closing the sheet again, not opening it.
    // Only tap when it is actually closed.
    const already = await page.evaluate(() => {
        const s = document.getElementById('sessionActionsSheet');
        return !!s && !s.hidden;
    });
    if (already) return { open: true };
    await page.click(`#tab-${id}`);
    await page.waitForTimeout(30);
    return await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        return { open: !!sheet && !sheet.hidden };
    });
}

// Invoke one lifecycle action through the full real path: re-tap to open the
// sheet, then click the action row. Replaces a bare click on the action button,
// which cannot work while the sheet is correctly closed.
/*
 * S5: Reset's gate is the in-app confirm dialog (#sessionConfirm), not
 * window.confirm(). Every `window.confirm = () => ...` stub in this suite used
 * to override a global the app still called; the app now renders its own
 * themed, testable dialog, so a stub would silently no-op and let an
 * unconfirmed Reset pass. These helpers drive the real dialog with real clicks
 * -- the same two buttons a user presses -- which is strictly stronger than a
 * stubbed return value: they fail if the dialog stops rendering, stops gating,
 * or stops being reachable.
 *
 * answerConfirm returns whether a dialog was actually present, so a caller can
 * assert the gate fired rather than assume it.
 */
async function confirmVisible(page) {
    return await page.evaluate(() => {
        const d = document.getElementById('sessionConfirm');
        return !!d && !d.hidden;
    });
}

async function answerConfirm(page, accept) {
    if (!await confirmVisible(page)) return false;
    await page.click(accept ? '#sessionConfirmAccept' : '#sessionConfirmCancel');
    await page.waitForTimeout(60);
    return true;
}

async function invokeAction(page, id, action) {
    const opened = await openSheet(page, id);
    if (!opened.open) throw new Error(`sheet did not open for ${id}`);
    await page.click(`#sessionActionsSheet [data-lifecycle-action="${action}"]`);
}

// Snapshot every session's lifecycle-relevant state, plus a per-session id ->
// pane index map and the raw pane array. The id->index map is what the
// isolation proof uses: raw array equality would be a false failure for the
// documented Reconnect/Reset effect, which closes the SELECTED target and
// empties (or replaces) only that target's slot.
async function snapshotSessions(page) {
    return await page.evaluate(() => {
        const out = {};
        for (const [id, s] of Object.entries(SessionManager.sessions)) {
            out[id] = JSON.stringify({
                host: s.host, port: s.port, username: s.username,
                authType: s.authType, keyId: s.keyId, jumpHostId: s.jumpHostId,
                displayName: s.displayName, connected: s.connected,
                isPersistentCandidate: s.isPersistentCandidate,
                useTmux: s.useTmux, tmuxSessionName: s.tmuxSessionName,
                tabExists: !!document.getElementById(`tab-${id}`),
                hasTargetClass: !!document.querySelector(`#tab-${id}.lifecycle-target`),
            });
        }
        // id -> pane index for every assigned session (unassigned => -1).
        const paneIndexById = {};
        for (const id of Object.keys(SessionManager.sessions)) {
            paneIndexById[id] = SessionManager.paneAssignments
                .findIndex(assigned => assigned === id);
        }
        return {
            sessions: out,
            paneIndexById,
            panes: JSON.stringify(SessionManager.paneAssignments),
            ids: Object.keys(SessionManager.sessions).sort().join(','),
        };
    });
}

// Isolation proof. Every NON-TARGET session must be byte-identical AND stay at
// the exact same pane index; only slots that held the selected target may
// change (to null, or to its replacement). Non-target isolation is never
// weakened — the allowance is scoped strictly to the target's own slot.
//
// paneMode:
//   'target-slot-only' (default) — Reconnect/Reset: the target's slot may
//       change; every other slot must still hold the same session it held.
//   'strict' — Rename: nothing about panes may change at all, so the full
//       array is compared as well.
function checkOnlyTargetChanged(label, before, after, allowedId, paneMode = 'target-slot-only') {
    // 1. Non-target session records are byte-identical.
    for (const id of Object.keys(before.sessions)) {
        if (id === allowedId) continue;
        check(`${label}: non-target session ${id} is untouched`,
            after.sessions[id], before.sessions[id]);
    }

    // 2. No unexpected session appeared.
    const appeared = Object.keys(after.sessions)
        .filter(id => id !== allowedId && !(id in before.sessions));
    check(`${label}: no unexpected session appeared`, appeared.join(','), '');

    // 3. Every surviving non-target session sits at the same pane index it did
    //    before. This is the real isolation claim: a target action must not
    //    shuffle, evict, or re-home any other session's pane.
    for (const id of Object.keys(before.paneIndexById)) {
        if (id === allowedId) continue;
        if (!(id in after.paneIndexById)) {
            check(`${label}: non-target session ${id} still exists`, true, false);
            continue;
        }
        check(`${label}: non-target session ${id} keeps pane index `
            + `${before.paneIndexById[id]}`,
            after.paneIndexById[id], before.paneIndexById[id]);
    }

    // 4. Rename changes nothing about panes at all.
    if (paneMode === 'strict') {
        check(`${label}: pane assignments completely unchanged`,
            after.panes, before.panes);
    }
}

// Install focus sentinels AFTER page load, into the REAL production
// TerminalManager.terminals — the registry focusActivePane() reads at
// session-manager.js:1491. This cannot be done from STUBS: terminal-manager.js
// loads afterwards and replaces window.TerminalManager wholesale (line 1139).
//
// Production destroyTerminal() semantics are untouched: it iterates
// sessionTerminals[sessionId] and delegates to destroyTerminalKey(), never
// deleting terminals[sessionId] itself, so a session-id-keyed sentinel survives
// a session removal and remains observable.
//
// Returns the installed ids plus the registry count, so callers can prove the
// spy is non-vacuous rather than assuming it.
async function installFocusSentinels(page, ids) {
    return await page.evaluate((ids) => {
        const TM = window.TerminalManager;
        if (!TM || !TM.terminals) {
            return { installed: [], registrySize: 0, registryPresent: false,
                registryIds: '', sentinelIds: '' };
        }
        window.__termFocusCalls = window.__termFocusCalls || [];
        window.__sentinelIds = window.__sentinelIds || [];
        const installed = [];
        ids.forEach(id => {
            if (TM.terminals[id]) return;        // never clobber a real terminal
            TM.terminals[id] = {
                id,
                // updateFontSize() (terminal-manager.js:1115) writes
                // terminal.options.fontSize for EVERY registry entry behind only
                // an if(terminal) guard, so a sentinel without options throws on
                // any resize. Real xterm instances always have it. fitAddons is
                // deliberately left without an entry, so the fitAddon && guard
                // at line 1117 short-circuits safely.
                options: { fontSize: 14 },
                focus: function () { window.__termFocusCalls.push(id); },
                blur: () => {}, scrollToBottom: () => {}, refresh: () => {},
                write: () => {}, clear: () => {}, dispose: () => {},
                textarea: null, element: null,
            };
            window.__sentinelIds.push(id);
            installed.push(id);
        });
        return {
            installed,
            registryPresent: true,
            registrySize: Object.keys(TM.terminals).length,
            registryIds: Object.keys(TM.terminals).sort().join(','),
            sentinelIds: window.__sentinelIds.slice().sort().join(','),
        };
    }, ids);
}

// Assert the sentinels really landed in the production registry.
function checkSentinels(label, res, expectedIds) {
    check(`${label}: the production terminal registry is reachable`,
        res.registryPresent, true);
    check(`${label}: the registry is non-empty (focus spy is non-vacuous)`,
        res.registrySize > 0, true);
    for (const id of expectedIds) {
        check(`${label}: sentinel registered for ${id}`,
            res.sentinelIds.split(',').includes(id), true);
    }
}

// Remove every sentinel this suite added, restoring the registry. Called at the
// end of each page's block so sentinels cannot leak between contexts.
async function removeFocusSentinels(page) {
    return await page.evaluate(() => {
        const TM = window.TerminalManager;
        const ids = (window.__sentinelIds || []).slice();
        try {
            ids.forEach(id => {
                if (TM && TM.terminals) delete TM.terminals[id];
            });
            return { removed: ids.length };
        } finally {
            window.__sentinelIds = [];
            window.__termFocusCalls = [];
        }
    });
}

// Arm side-effect spies that survive across page.click boundaries.
//
// Watched production surfaces:
//  1. focus EVENTS on #mobileInput, #passwordInput, #jumpHostPasswordInput.
//  2. the real .focus method of every entry in the production
//     TerminalManager.terminals registry — the path focusActivePane() takes
//     (session-manager.js:1491 -> 1523). No phantom method is invented.
//
// On a coarse/touch shell focusActivePane() returns at its isTouchShell() guard
// before line 1523, so zero terminal focus calls is the only correct
// expectation for every touch action. No exceptions.
async function armSpies(page) {
    return await page.evaluate(() => {
        const TM = window.TerminalManager;
        window.__spyFocus = [];
        window.__termFocusCalls = [];
        window.__spyHandlers = [];
        window.__spyTermWraps = [];
        ['mobileInput', 'passwordInput', 'jumpHostPasswordInput'].forEach(sid => {
            const el = document.getElementById(sid);
            if (!el) return;
            const handler = () => window.__spyFocus.push(sid);
            el.addEventListener('focus', handler);
            window.__spyHandlers.push({ el, handler });
        });
        const map = (TM && TM.terminals) || {};
        Object.keys(map).forEach(id => {
            const term = map[id];
            if (!term || typeof term.focus !== 'function') return;
            const original = term.focus;
            window.__spyTermWraps.push({ id, term, original });
            term.focus = function (...args) {
                window.__spyFocus.push(`terminal:${id}`);
                window.__termFocusCalls.push(id);
                return original.apply(this, args);
            };
        });
        return {
            registrySize: Object.keys(map).length,
            wrapped: window.__spyTermWraps.length,
        };
    });
}

// Read the tally and restore EVERYTHING in a finally block: every wrapped
// .focus is put back and every focus listener removed, even if an assertion
// throws upstream, so nothing leaks into the next cell.
async function readSpies(page) {
    return await page.evaluate(() => {
        try {
            return {
                focusEvents: (window.__spyFocus || []).join(','),
                composerFocused: (window.__spyFocus || []).includes('mobileInput'),
                passwordFocused: (window.__spyFocus || []).includes('passwordInput'),
                jumpPasswordFocused: (window.__spyFocus || [])
                    .includes('jumpHostPasswordInput'),
                terminalFocusCalls: (window.__termFocusCalls || []).length,
                terminalFocusIds: (window.__termFocusCalls || []).join(','),
                registrySize: Object.keys(
                    (window.TerminalManager && window.TerminalManager.terminals) || {}).length,
                activeId: document.activeElement ? document.activeElement.id : null,
            };
        } finally {
            (window.__spyTermWraps || []).forEach(({ term, original }) => {
                term.focus = original;
            });
            (window.__spyHandlers || []).forEach(({ el, handler }) =>
                el.removeEventListener('focus', handler));
            window.__spyTermWraps = [];
            window.__spyHandlers = [];
        }
    });
}

// Full spy assertion for one cell. No escape hatch: focusActivePane() is a
// no-op on touch by contract, so zero is correct for every action.
function checkCellSpies(label, spies) {
    check(`${label}: the terminal registry is non-empty (spy is non-vacuous)`,
        spies.registrySize > 0, true);
    check(`${label}: no focus event on the composer`, spies.composerFocused, false);
    check(`${label}: no focus event on the password input`,
        spies.passwordFocused, false);
    check(`${label}: no focus event on the jump-host password input`,
        spies.jumpPasswordFocused, false);
    check(`${label}: activeElement is not the composer`,
        spies.activeId !== 'mobileInput', true);
    check(`${label}: activeElement is neither password input`,
        spies.activeId !== 'passwordInput'
            && spies.activeId !== 'jumpHostPasswordInput', true);
    check(`${label}: no terminal instance was focused on a touch shell`,
        spies.terminalFocusCalls, 0);
}

// Assert a selectChip() result BEFORE any action spies are armed: selection
// itself must never focus the composer, a password field, or a terminal.
function checkSelectionClean(label, sel, expectedId) {
    check(`${label}: the terminal registry is non-empty (spy is non-vacuous)`,
        sel.registrySize > 0, true);
    check(`${label}: selection set the target to ${expectedId}`,
        sel.target, expectedId);
    check(`${label}: selection focusLog is empty`, sel.focusLog.join(','), '');
    check(`${label}: selection focused no terminal instance`,
        sel.terminalFocusCalls, 0);
    check(`${label}: selection left focus off the composer`,
        sel.activeId !== 'mobileInput', true);
    check(`${label}: selection left focus off both password inputs`,
        sel.activeId !== 'passwordInput'
            && sel.activeId !== 'jumpHostPasswordInput', true);
}

// Force the lifecycle target directly through the sole setter. Used only where
// the pane path is irrelevant to the assertion under test (the real chip-click
// route is exercised by selectChip above and asserted in §5).
async function setTarget(page, id) {
    return await page.evaluate((id) => {
        SessionManager.setLifecycleActionTarget(id);
        return SessionManager.lifecycleActionTargetId;
    }, id);
}

// Wrap socket.emit to record every ssh_connect and ssh_input.
async function spyEmits(page) {
    await page.evaluate(() => {
        window.__connectEmits = [];
        window.__inputEmits = [];
        // W2: a live Reconnect is a transport SWAP, not a connect. It emits
        // ssh_reconnect and nothing else, so the swap route has to be observable
        // separately from ssh_connect -- otherwise "emitted no ssh_connect"
        // could not tell a working swap from a button that does nothing.
        window.__reconnectEmits = [];
        // W13: a CANDIDATE Reset must emit NO ssh_disconnect at all before its
        // replacement exists -- the persisted offer is the only record that the
        // remote tmux belongs to this user, so retiring it first destroys it for
        // good on a failed or cancelled connect. Recorded under its own name
        // because §9 installs a second, independently-reset disconnect spy on
        // top of this wrapper; sharing an array would double-count there.
        window.__allDisconnectEmits = [];
        const real = window.socket.emit.bind(window.socket);
        window.socket.emit = (ev, payload) => {
            if (ev === 'ssh_connect') window.__connectEmits.push(payload);
            if (ev === 'ssh_input') window.__inputEmits.push(payload);
            if (ev === 'ssh_reconnect') window.__reconnectEmits.push(payload);
            if (ev === 'ssh_disconnect') window.__allDisconnectEmits.push(payload);
            return real(ev, payload);
        };
    });
}

/*
 * Let the status bar settle before reading it.
 *
 * D1 batching: the bar's listeners register a rAF-coalescing scheduler
 * (app.js StatusBar.scheduleRefresh), so a burst of events costs ONE
 * recomputation on the next frame instead of one per event. Every read of
 * #statusBar / #statusBarDims / #statusBarLatency therefore has to be one frame
 * behind the event that caused it. Two frames, because the write happens inside
 * the first callback and the assertion wants the result of it.
 *
 * This is not a weaker assertion: the value asserted is unchanged, and a bar
 * that never refreshes still fails. It is the same wait a user's eye makes.
 */
async function settleStatusBar(page) {
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
}

// ============================================================================
// §1 — Lifecycle SHEET geometry across seven touch contexts, then the
// fine-pointer desktop hidden case.
//
// RE-TARGETED from an always-visible three-button in-row toolbar to the sheet
// the spec actually describes. Amendment v5 section 3: the session row "Không
// chứa action, spacer hay menu" and "session strip dùng toàn bộ chiều ngang còn
// lại sau padding hai bên" — so the old 144px reserved action band inside the
// strip was itself the violation, and the strip must now yield NO space at any
// tier. The actions live in a popover (mockup line 184, .tw5-session-actions)
// opened by the section 3 gesture: "chạm lại hoặc nhấn giữ mới mở action sheet".
//
// The invariants are therefore about the SHEET, and they are measured, not
// assumed: closed it must consume no layout and intercept nothing; open it must
// be fully on-screen with every action a real, unobstructed 44px-tall target.
// The strip proof is now the same at every tier — the full content box is
// usable chip region, because nothing is allowed to overlay or displace it.
// ============================================================================
for (const [label, w, h] of [
    ['359×780 phone', 359, 780],
    ['390×844 phone', 390, 844],
    ['428×926 phone', 428, 926],
    ['926×428 short-landscape', 926, 428],
    ['768×1024 tablet', 768, 1024],
    ['834×1194 iPad portrait', 834, 1194],
    ['1194×834 iPad landscape', 1194, 834],
]) {
    const { ctx, page, errors } = await newPage(w, h);
    await seedSession(page, 's1');

    // ---- Closed state: costs nothing, blocks nothing ----
    const closed = await page.evaluate(() => {
        const control = document.getElementById('sessionActionsControl');
        const sheet = document.getElementById('sessionActionsSheet');
        const strip = document.getElementById('sessionTabs');
        const stripCS = strip ? getComputedStyle(strip) : null;
        const sr = strip ? strip.getBoundingClientRect() : null;
        const composer = document.getElementById('mobileInput');
        // Does the closed overlay intercept anything over the strip? Sample the
        // strip's own band; nothing there may resolve into the control.
        let intercepts = 0;
        if (sr) {
            const y = Math.round(sr.top + sr.height / 2);
            for (let x = Math.round(sr.left); x < Math.round(sr.right); x += 8) {
                const el = document.elementFromPoint(x, y);
                if (el && control && control.contains(el)) intercepts++;
            }
        }
        return {
            controlExists: !!control,
            controlConnected: control ? control.isConnected : false,
            controlDisplay: control ? getComputedStyle(control).display : null,
            sheetHidden: sheet ? sheet.hidden : null,
            sheetBoxW: sheet ? Math.round(sheet.getBoundingClientRect().width) : null,
            sheetBoxH: sheet ? Math.round(sheet.getBoundingClientRect().height) : null,
            intercepts,
            stripExists: !!strip,
            stripClientW: strip ? strip.clientWidth : null,
            stripPadRight: stripCS ? Math.round(parseFloat(stripCS.paddingRight)) : null,
            stripPadLeft: stripCS ? Math.round(parseFloat(stripCS.paddingLeft)) : null,
            /*
             * The EFFECTIVE inset, i.e. the gap between the strip's content box
             * and the shell's inner border edge on each side, whichever box
             * happens to pay for it. deck.css L2c made the ROW the
             * single inline-inset owner on desktop, so the strip's own padding
             * is 0 there while the visible inset is unchanged -- reading only
             * the strip's padding would report "no inset" for a shell that has
             * one, and would go blind to a re-introduced action band on the row.
             */
            ...(() => {
                /*
                 * The inline inset has exactly ONE owner per row, but WHICH box
                 * owns it differs by tier -- deck.css L2c moved it
                 * from the strip to the row on the fine-pointer shell to stop
                 * three boxes stacking it. So read the declaring box rather than
                 * one fixed longhand: the strip's own padding where it still
                 * declares it (touch), otherwise the host row's. Reading only
                 * the strip's padding reported this correct desktop shell as
                 * un-inset; measuring a rect gap instead reported 0 where a
                 * host shrink-wraps the strip exactly.
                 *
                 * Either way the defect this guards against still fails it: a
                 * 144px band reserved on one side lands far outside the <=12px
                 * ceiling and breaks symmetry, whichever box declares it.
                 */
                if (!strip) return { effInsetLeft: null, effInsetRight: null };
                const own = {
                    l: Math.round(parseFloat(stripCS.paddingLeft)) || 0,
                    r: Math.round(parseFloat(stripCS.paddingRight)) || 0,
                };
                if (own.l > 0 || own.r > 0) {
                    return { effInsetLeft: own.l, effInsetRight: own.r };
                }
                // display:contents generates no box, so climb to the nearest
                // ancestor that actually lays out and declares the inset.
                let host = strip.parentElement;
                while (host && getComputedStyle(host).display === 'contents') {
                    host = host.parentElement;
                }
                if (!host) return { effInsetLeft: null, effInsetRight: null };
                const hcs = getComputedStyle(host);
                return {
                    effInsetLeft: Math.round(parseFloat(hcs.paddingLeft)) || 0,
                    effInsetRight: Math.round(parseFloat(hcs.paddingRight)) || 0,
                };
            })(),
            composerW: composer ? Math.round(composer.getBoundingClientRect().width) : null,
            composerVisible: composer
                ? composer.getBoundingClientRect().width > 0 : null,
        };
    });

    check(`${label}: control exists`, closed.controlExists, true);
    check(`${label}: control is connected`, closed.controlConnected, true);
    check(`${label}: closed control generates no box (display:contents)`,
        closed.controlDisplay, 'contents');
    check(`${label}: the sheet is hidden at rest`, closed.sheetHidden, true);
    check(`${label}: the hidden sheet has a zero painted box`,
        `${closed.sheetBoxW}x${closed.sheetBoxH}`, '0x0');
    check(`${label}: the closed overlay intercepts nothing over the strip`,
        closed.intercepts, 0);
    check(`${label}: the strip exists`, closed.stripExists, true);
    // v5 section 3 reads "session strip dùng toàn bộ chiều ngang còn lại sau
    // padding hai bên" -- the strip takes all remaining width AFTER symmetric
    // padding. The defect this assertion was written against was a 144px band
    // reserved on ONE side for the old in-row toolbar, so `paddingRight === 0`
    // was only ever a proxy for it. S6's 8px inline padding (chips must not sit
    // flush against the border) satisfies the same clause. Tested directly and
    // more strictly than before: the inset must be SYMMETRIC (no side reserves
    // anything for a control) and nowhere near band-sized.
    //
    //: asserted against the EFFECTIVE inset rather than the strip's
    // own padding longhand. deck.css L2c collapsed three stacked inline insets
    // (.header 12px + row 8px + strip 8px) into one owner -- the row -- so the
    // strip's padding is now 0 on desktop while the shell-edge gap it stands
    // for is unchanged at 8px. Reading the longhand would have reported this
    // correct shell as un-inset, and would equally miss a band re-added to the
    // row. The band defect is still what fails this: a reserved 144px side
    // lands far outside the <=12px ceiling regardless of which box declares it.
    check(`${label}: the strip inset is symmetric — no side reserves a band`,
        closed.effInsetLeft, closed.effInsetRight);
    check(`${label}: the strip inset is S6-sized, not an action band`,
        closed.effInsetRight > 0 && closed.effInsetRight <= 12, true);
    check(`${label}: the whole strip content box is usable chip region`,
        closed.stripClientW >= 120, true);
    check(`${label}: composer is present and not crushed`,
        closed.composerVisible && closed.composerW >= 80, true);

    // ---- Open state: reached by the real section 3 gesture ----
    await selectChip(page, 's1');
    const opened = await openSheet(page, 's1');
    check(`${label}: the re-tap gesture opens the sheet`, opened.open, true);

    const open = await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        const r = sheet.getBoundingClientRect();
        const btns = [...sheet.querySelectorAll('[data-lifecycle-action]')];
        // Every action must be a REAL target: 44px tall and actually the topmost
        // element at its own centre. A rect check alone cannot see an obstruction.
        const targets = btns.map((b) => {
            const q = b.getBoundingClientRect();
            const cx = Math.round(q.left + q.width / 2);
            const cy = Math.round(q.top + q.height / 2);
            const hit = document.elementFromPoint(cx, cy);
            return {
                action: b.dataset.lifecycleAction,
                h: Math.round(q.height),
                named: !!(b.textContent || '').trim() || !!b.getAttribute('aria-label'),
                owned: !!(hit && (hit === b || b.contains(hit))),
                onScreen: q.left >= 0 && q.top >= 0
                    && q.right <= innerWidth && q.bottom <= innerHeight,
            };
        });
        return {
            role: sheet.getAttribute('role'),
            inert: sheet.hasAttribute('inert'),
            ariaHidden: sheet.getAttribute('aria-hidden'),
            labelled: !!sheet.getAttribute('aria-labelledby'),
            positioned: getComputedStyle(sheet).position,
            onScreen: r.left >= 0 && r.top >= 0
                && r.right <= innerWidth && r.bottom <= innerHeight,
            count: btns.length,
            actions: targets.map(t => t.action).join(','),
            allTall: targets.every(t => t.h >= 44),
            allNamed: targets.every(t => t.named),
            allOwned: targets.every(t => t.owned),
            allOnScreen: targets.every(t => t.onScreen),
            minH: Math.min(...targets.map(t => t.h)),
        };
    });

    check(`${label}: the open sheet is a labelled dialog`,
        `${open.role}:${open.labelled}`, 'dialog:true');
    check(`${label}: the open sheet is not inert`, open.inert, false);
    check(`${label}: the open sheet is not aria-hidden`, open.ariaHidden, 'false');
    check(`${label}: the open sheet is out of flow`,
        open.positioned === 'fixed' || open.positioned === 'absolute', true);
    check(`${label}: the open sheet is fully on-screen`, open.onScreen, true);
    // Six since: "Assign to a pane…" (item D) and "Clean up
    // orphaned tmux…" (item B) joined the four original actions.
    check(`${label}: six lifecycle actions`, open.count, 6);
    check(`${label}: the actions are rename/reconnect/reset/assign/orphans/close`,
        open.actions, 'rename,reconnect,reset,assign,orphans,close');
    check(`${label}: every action is at least 44px tall`,
        `${open.allTall}:${open.minH}`, `true:${open.minH}`);
    check(`${label}: every action clears the 44px floor`, open.minH >= 44, true);
    check(`${label}: every action has an accessible name`, open.allNamed, true);
    check(`${label}: every action owns its own centre`, open.allOwned, true);
    check(`${label}: every action is fully on-screen`, open.allOnScreen, true);

    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// Fine-pointer desktop keeps no extra trigger, but the body-level shared sheet
// must be renderable from the selected chip.
{
    const { ctx, page, errors } = await newPage(1440, 900, { touch: false });
    await seedSession(page, 'fine1');
    await selectChip(page, 'fine1');
    const opened = await openSheet(page, 'fine1');
    const fine = await page.evaluate(() => {
        const control = document.getElementById('sessionActionsControl');
        const trigger = document.getElementById('sessionActionsBtn');
        const sheet = document.getElementById('sessionActionsSheet');
        const r = sheet.getBoundingClientRect();
        return {
            exists: !!control,
            display: control ? getComputedStyle(control).display : null,
            triggerVisible: trigger.getBoundingClientRect().width > 0,
            sheetPositive: r.width > 0 && r.height > 0,
            bodyHost: control.parentElement === document.body,
        };
    });
    check('fine desktop: the shared control still exists', fine.exists, true);
    check('fine desktop: the wrapper does not suppress its sheet', fine.display, 'contents');
    check('fine desktop: no extra lifecycle trigger is painted', fine.triggerVisible, false);
    check('fine desktop: selected-chip reactivation renders the shared sheet',
        opened.open && fine.sheetPositive, true);
    check('fine desktop: the shared sheet keeps its body-level host', fine.bodyHost, true);
    check('fine desktop: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §1b — Lifecycle sheet anchors to the selected chip at touch and desktop tiers.
// ============================================================================
for (const [label, w, h, touch] of [
    ['anchor phone', 390, 844, true],
    ['anchor iPad', 834, 1194, true],
    ['anchor landscape', 926, 428, true],
    ['anchor desktop', 1440, 900, false],
]) {
    const { ctx, page, errors } = await newPage(w, h, { touch });
    await seedSession(page, 'anchor1', {
        host: 'anchor.example', username: 'anchorU', connected: false,
        displayName: 'Anchor One', activate: false,
    });
    const beforeFocus = await page.evaluate(() => document.activeElement?.id || '');
    await selectChip(page, 'anchor1');
    await openSheet(page, 'anchor1');
    const anchor = await page.evaluate(() => {
        const chip = document.getElementById('tab-anchor1');
        const sheet = document.getElementById('sessionActionsSheet');
        const control = document.getElementById('sessionActionsControl');
        const cr = chip.getBoundingClientRect();
        const sr = sheet.getBoundingClientRect();
        const belowGap = sr.top - cr.bottom;
        const aboveGap = cr.top - sr.bottom;
        const below = belowGap >= -1;
        const above = aboveGap >= -1;
        const side = below ? 'below' : above ? 'above' : 'overlap';
        const gap = below ? Math.abs(belowGap)
            : above ? Math.abs(aboveGap) : Number.POSITIVE_INFINITY;
        const inlineDelta = Math.min(
            Math.abs(sr.left - cr.left), Math.abs(sr.right - cr.right));
        return {
            positive: sr.width > 0 && sr.height > 0,
            side, gap, inlineDelta,
            contained: sr.left >= 0 && sr.top >= 0
                && sr.right <= innerWidth && sr.bottom <= innerHeight,
            bodyHost: control.parentElement === document.body,
            actionCount: sheet.querySelectorAll('[data-lifecycle-action]').length,
            target: SessionManager.lifecycleActionTargetId,
            heading: document.getElementById('sessionActionsHeadingName').textContent,
            activeId: document.activeElement?.id || '',
            keyboardOpen: document.body.classList.contains('keyboard-open'),
        };
    });
    check(`${label}: opened sheet has a positive box`, anchor.positive, true);
    check(`${label}: sheet is strictly above or below the selected chip`,
        anchor.side === 'above' || anchor.side === 'below', true);
    check(`${label}: sheet anchor gap is at most 8px (gap=${anchor.gap})`,
        anchor.gap <= 8, true);
    check(`${label}: sheet inline-edge delta is at most 8px (delta=${anchor.inlineDelta})`,
        anchor.inlineDelta <= 8, true);
    check(`${label}: sheet stays inside the viewport`, anchor.contained, true);
    check(`${label}: body-level overlay host identity is preserved`, anchor.bodyHost, true);
    check(`${label}: the one sheet contains exactly six actions`, anchor.actionCount, 6);
    check(`${label}: heading and target identify the selected chip`,
        `${anchor.target}|${anchor.heading}`, 'anchor1|Anchor One');
    check(`${label}: opening never focuses the composer`, anchor.activeId !== 'mobileInput', true);
    check(`${label}: opening never raises the keyboard`, anchor.keyboardOpen, false);

    await page.keyboard.press('Escape');
    check(`${label}: Escape restores focus to the activating chip`,
        await page.evaluate(() => document.activeElement?.id), 'tab-anchor1');
    void beforeFocus;
    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §2 — Reset direct path (key target + key jump)
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);

    // Provide a resolvable jump host via JumpHostManager.getById.
    await page.evaluate(() => {
        window.JumpHostManager.getById = (id) =>
            id === 'jh1' ? { id: 'jh1', host: 'bastion', port: 22, username: 'relay', auth_type: 'key', key_id: 'jk1' } : null;
    });

    await seedSession(page, 's2', {
        host: 'prod.example', username: 'admin', authType: 'key', keyId: 'k2',
        jumpHostId: 'jh1', displayName: 'Prod DB',
    });
    await spyEmits(page);

    const before = await page.evaluate(() => {
        const s = SessionManager.sessions['s2'];
        return {
            host: s.host, port: s.port, username: s.username,
            authType: s.authType, keyId: s.keyId, jumpHostId: s.jumpHostId,
            displayName: s.displayName,
        };
    });

    // Select the chip the real way (tab click -> switchSession), then Reset via
    // the direct toolbar button. This is the whole trigger path now: no sheet
    // to open, and the delegated listener on #sessionActionsControl dispatches.
    const sel = await selectChip(page, 's2');
    check('§2 select: lifecycle target is s2', sel.target, 's2');
    check('§2 select: chip carries .lifecycle-target', sel.targetClassOnChip, true);
    check('§2 select: all three controls enabled for a valid target',
        sel.buttonsEnabled, true);
    check('§2 select: selection never focuses the composer',
        sel.activeId !== 'mobileInput' && sel.focusLog.length === 0, true);

    await invokeAction(page, 's2', 'reset');
    // The S5 dialog is the gate. Asserting it appeared is stronger than the old
    // `window.confirm = () => true` stub, which proved only that a stub existed.
    check('§2 direct: Reset opens the confirm dialog before any emit',
        await confirmVisible(page), true);
    check('§2 direct: nothing is emitted while the dialog is still open',
        await page.evaluate(() => window.__connectEmits.length), 0);
    check('§2 direct: the dialog was answered', await answerConfirm(page, true), true);
    await page.waitForTimeout(100);

    const emits = await page.evaluate(() => window.__connectEmits);
    const inputEmits = await page.evaluate(() => window.__inputEmits);
    const sessionGone = await page.evaluate(() => !SessionManager.sessions['s2']);
    const pendingMetaCleared = await page.evaluate(() => SessionManager.pendingResetMeta);

    check('§2 direct: exactly one ssh_connect', emits.length, 1);
    check('§2 direct: use_tmux false', emits[0]?.use_tmux, false);
    check('§2 direct: reconnect_tmux_name null', emits[0]?.reconnect_tmux_name, null);
    check('§2 direct: client_request_id starts reset_',
        (emits[0]?.client_request_id || '').startsWith('reset_'), true);
    check('§2 direct: host preserved', emits[0]?.host, before.host);
    check('§2 direct: port preserved', emits[0]?.port, before.port);
    check('§2 direct: username preserved', emits[0]?.username, before.username);
    check('§2 direct: auth_type preserved', emits[0]?.auth_type, before.authType);
    check('§2 direct: key_id preserved', emits[0]?.key_id, before.keyId);
    check('§2 direct: display_name preserved', emits[0]?.display_name, before.displayName);
    check('§2 direct: proxy_jump host preserved', emits[0]?.proxy_jump?.host, 'bastion');
    check('§2 direct: proxy_jump auth_type is key', emits[0]?.proxy_jump?.auth_type, 'key');
    check('§2 direct: no password on payload',
        Object.prototype.hasOwnProperty.call(emits[0] || {}, 'password'), false);
    check('§2 direct: no password on proxy_jump',
        Object.prototype.hasOwnProperty.call(emits[0]?.proxy_jump || {}, 'password'), false);
    check('§2 direct: zero ssh_input', inputEmits.length, 0);
    check('§2 direct: old session closed', sessionGone, true);
    check('§2 direct: pendingResetMeta cleared', pendingMetaCleared, null);

    // The direct reset must register a request-keyed pending record (consumed
    // by ssh_connected via takePendingConnection). Verify it was created under
    // the emitted reset_* id with all seven non-secret fields and no password.
    // The pending record is consumed by ssh_connected in production, but here
    // no ssh_connected event fires (stubbed socket), so it survives for
    // inspection — proving the direct path registered it.
    const pendingRec = await page.evaluate((rid) =>
        SessionManager.pendingConnections[rid],
        emits[0]?.client_request_id);
    check('§2 direct: pending record exists under reset_* id',
        !!pendingRec, true);
    check('§2 direct: pending host', pendingRec?.host, before.host);
    check('§2 direct: pending port', pendingRec?.port, before.port);
    check('§2 direct: pending username', pendingRec?.username, before.username);
    check('§2 direct: pending authType', pendingRec?.authType, before.authType);
    check('§2 direct: pending keyId', pendingRec?.keyId, before.keyId);
    check('§2 direct: pending jumpHostId', pendingRec?.jumpHostId, before.jumpHostId);
    check('§2 direct: pending displayName', pendingRec?.displayName, before.displayName);
    check('§2 direct: no password in pending record',
        Object.prototype.hasOwnProperty.call(pendingRec || {}, 'password'), false);

    // Confirm-cancel: zero additional emits, old session intact.
    await seedSession(page, 's3', { host: 'cancel.example', authType: 'key', keyId: 'k3' });
    await selectChip(page, 's3');
    await invokeAction(page, 's3', 'reset');
    check('§2 cancel: the confirm dialog opened', await confirmVisible(page), true);
    check('§2 cancel: the dialog was answered', await answerConfirm(page, false), true);
    check('§2 cancel: cancelling closes the dialog',
        await confirmVisible(page), false);
    await page.waitForTimeout(100);
    const afterCancel = await page.evaluate(() => ({
        emits: window.__connectEmits.length,
        sessionExists: !!SessionManager.sessions['s3'],
    }));
    check('§2 cancel: declining the dialog → no additional emit',
        afterCancel.emits, 1);   // still just the first one
    check('§2 cancel: session intact after cancel', afterCancel.sessionExists, true);

    check('§2: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2r — The neutral resize signal must come from the real xterm producer, and
// the size PROPOSAL is decoupled from it (W14-B).
//
// This deliberately creates an xterm through TerminalManager.createTerminal()
// and calls that terminal's public resize() API. It never dispatches
// sshdeck:terminal-resized itself: the only way the event count, payload and
// status dimensions can change is through the callback registered by the
// production terminal.onResize path.
//
// W14-B split: terminal.onResize owns ONLY the neutral UI event. The
// ssh_resize proposal belongs to TerminalManager.reportLocalFit, which
// measures the pane's true capacity (fitAddon.proposeDimensions) -- under the
// largest-live-client authority the terminal RENDERS the authoritative grid,
// which is NOT this client's local fit, so a rendered-size report would lie
// about the client's real capacity and the server registry could not recompute
// to the survivor max on disconnect. §2r2 pins the proposal channel with a
// real attached pane.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1440, 900, { touch: false });
    await seedSession(page, 'resize-prod', {
        host: 'resize.example', username: 'resizeU', connected: true,
    });

    const producer = await page.evaluate(async () => {
        const emitted = [];
        const events = [];
        window.socket.emit = (name, payload) => emitted.push({ name, payload });
        document.addEventListener('sshdeck:terminal-resized', (event) => {
            events.push(event.detail);
        });

        SessionManager.activeSessionId = 'resize-prod';
        const terminal = TerminalManager.createTerminal('resize-prod');
        const before = {
            cols: terminal.cols,
            rows: terminal.rows,
            dims: document.getElementById('statusBarDims').textContent,
        };
        terminal.resize(132, 46);
        // The status bar coalesces its refresh into the next animation frame
        // (D1 batching), so the read-out is one frame behind the resize event.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = {
            cols: terminal.cols,
            rows: terminal.rows,
            dims: document.getElementById('statusBarDims').textContent,
        };
        TerminalManager.destroyTerminal('resize-prod');
        return { before, after, emitted, events };
    });

    check('§2r producer: real xterm starts at a different size (non-vacuous)',
        `${producer.before.cols}x${producer.before.rows}` !== '132x46', true);
    check('§2r producer: terminal.resize changes the real xterm dimensions',
        `${producer.after.cols}x${producer.after.rows}`, '132x46');
    check('§2r producer: terminal.onResize emits exactly one neutral event',
        producer.events.length, 1);
    check('§2r producer: neutral event carries active session/key/size',
        JSON.stringify(producer.events[0]),
        JSON.stringify({
            sessionId: 'resize-prod', terminalKey: 'resize-prod', cols: 132, rows: 46,
        }));
    check('§2r producer: terminal.onResize never emits ssh_resize directly',
        producer.emitted.filter(x => x.name === 'ssh_resize').length, 0);
    check('§2r producer: StatusBar refreshed from the active real terminal',
        producer.after.dims, '132 × 46');
    check('§2r producer: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2r2 — W14-B proposal channel: reportLocalFit owns ssh_resize, measures the
// pane (not the rendered grid), dedupes, and reports anew when the pane moves.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1440, 900, { touch: false });
    await seedSession(page, 'resize-prop', {
        host: 'prop.example', username: 'propU', connected: true,
    });

    const proposal = await page.evaluate(async () => {
        const emitted = [];
        window.socket.emit = (name, payload) => emitted.push({ name, payload });
        SessionManager.activeSessionId = 'resize-prop';

        // A real attached pane with a known box, so proposeDimensions measures
        // a real capacity.
        const host = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = 'term-resize-prop';
        el.className = 'terminal-wrapper';
        el.style.width = '640px';
        el.style.height = '320px';
        host.appendChild(el);

        TerminalManager.createTerminal('resize-prop');
        TerminalManager.attachTerminal('resize-prop', 'term-resize-prop');
        // Readiness: nested rAF + 50ms inside attachTerminal.
        await new Promise(r => setTimeout(r, 400));
        emitted.length = 0;   // drop the attach-time proposal, measure ours
        delete TerminalManager.reportedSizes['resize-prop'];
        /*
         *: a pane's FIRST report is the attach (`view_attach`
         * carries the size, because there is no tmux client to resize yet).
         * This section's subject is the resize frame, so the fixture stands the
         * view up as already attached rather than driving the handshake.
         */
        TerminalManager.views['resize-prop'] = 'attached';

        const resizes = () => emitted.filter(x => x.name === 'ssh_resize');
        TerminalManager.reportLocalFit('resize-prop');
        const first = resizes().map(x => x.payload);
        TerminalManager.reportLocalFit('resize-prop');
        const afterDup = resizes().length;

        /*
         *: the rendered grid and the reported size are the SAME
         * number now. A view is this socket's own tmux client, drawn clipped to
         * this socket's size, so the pane renders exactly what it reports --
         * there is no authority to adopt and nothing to keep a grid at.
         *
         * The property that replaces "renders the adopted grid" is therefore
         * the opposite one, and it is the reason the whole arbitration is gone:
         * shrink the pane, fit again, and BOTH the engine and the frame follow
         * the pane.
         */
        el.style.width = '500px';
        el.style.height = '280px';
        emitted.length = 0;
        TerminalManager.fitTerminal('resize-prop');
        /*
         * The proposal is COALESCED since: a fit presents the grid
         * at once and schedules one `ssh_resize` PROPOSAL_SETTLE_MS later, so
         * a drag costs one round trip instead of one per frame (the owner's
         * "codex/omp nhay len xuong lien tuc" while resizing). The property
         * below is unchanged -- one frame, and it equals the rendered grid --
         * it simply is not readable in the same tick any more.
         */
        await new Promise(r => setTimeout(r, TerminalManager.PROPOSAL_SETTLE_MS + 120));
        const shrunkGrid = (() => {
            const key = (TerminalManager.sessionTerminals['resize-prop'] || [])[0];
            const term = TerminalManager.terminals[key];
            return { cols: term.cols, rows: term.rows };
        })();
        const afterShrink = resizes().map(x => x.payload);
        const follows = afterShrink[0]
            && afterShrink[0].cols === shrunkGrid.cols
            && afterShrink[0].rows === shrunkGrid.rows;
        const smaller = afterShrink[0] && first[0]
            && afterShrink[0].cols < first[0].cols;

        TerminalManager.destroyTerminal('resize-prop');
        el.remove();
        return { first, afterDup, shrunkGrid, afterShrink, follows, smaller };
    });

    check('§2r2 proposal: reportLocalFit emits exactly one ssh_resize',
        proposal.first.length, 1);
    check('§2r2 proposal: the frame names the session with positive rows/cols',
        proposal.first[0] && proposal.first[0].session_id === 'resize-prop'
            && proposal.first[0].rows > 0 && proposal.first[0].cols > 0, true);
    check('§2r2 proposal: an unchanged fit is deduped (no second frame)',
        proposal.afterDup, 1);
    check('§2r2 proposal: the shrunk pane reports exactly one frame',
        proposal.afterShrink.length, 1);
    check('§2r2 proposal: the frame IS the grid the engine renders',
        proposal.follows, true);
    check('§2r2 proposal: and shrinking the pane really shrank it (non-vacuous)',
        proposal.smaller, true);
    check('§2r2 proposal: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2c2 — S1/S2: the chip's secondary line is composed, translated text.
//
// The <small> is not a data-i18n node -- it is built from the username, the
// live latency, and a translated "disconnected" word -- so nothing repaints it
// automatically. A language switch used to leave every disconnected chip
// reading the previous language until its status happened to change, which a
// screenshot at one locale can never show.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1440, 900, { touch: false });
    await seedSession(page, 'i1', {
        host: 'live.example', username: 'liveU', connected: true, latencyMs: null,
    });
    await seedSession(page, 'i2', {
        host: 'down.example', username: 'downU', connected: false,
    });
    await page.waitForTimeout(80);

    const read = (id) => page.evaluate((x) =>
        document.querySelector(`#tab-${x} small`)?.textContent, id);
    const setLang = (l) => page.evaluate((x) => window.i18n.setLanguage(x), l);

    await setLang('en');
    await page.waitForTimeout(80);
    check('§2c2 en: a disconnected chip reads the English word',
        await read('i2'), 'Disconnected');

    // S1: latency is rendered on a fine pointer, and only for a live session.
    check('§2c2: a live chip starts without a latency measurement',
        await read('i1'), 'liveU');
    await page.evaluate(() => SessionManager.applySessionLatency('i1', 34));
    await page.waitForTimeout(60);
    check('§2c2: a live chip repaints null → 34 ms on a fine pointer',
        await read('i1'), 'liveU · 34 ms');
    check('§2c2: the stored latency is the measured value after repaint',
        await page.evaluate(() => SessionManager.sessions.i1.latencyMs), 34);

    // Cross-surface coherence: active chip, selected-target heading and status
    // bar all derive from the same session record and latency.
    await page.evaluate(() => {
        SessionManager.activeSessionId = 'i1';
        SessionManager.setLifecycleActionTarget('i1');
        window.StatusBar.refresh();
    });
    const connectedSurfaces = await page.evaluate(() => ({
        chipDot: document.querySelector('#tab-i1 .status-dot').className,
        headingDot: document.getElementById('sessionActionsHeadingDot').className,
        statusState: document.getElementById('statusBar').dataset.state,
        statusDot: document.getElementById('statusBarDot').className,
        statusLatency: document.getElementById('statusBarLatency').textContent,
        socketConnected: window.socket.connected,
        sessionConnected: SessionManager.sessions.i1.connected,
        legacyControls: document.querySelectorAll(
            '#tab-i1 .tab-edit, #tab-i1 .tab-reconnect, #tab-i1 .tab-close').length,
    }));
    check('§2c2 coherent: connected chip and heading dots agree',
        `${connectedSurfaces.chipDot}|${connectedSurfaces.headingDot}`,
        'status-dot connected|status-dot connected');
    check('§2c2 coherent: status bar reports the active SSH session connected',
        `${connectedSurfaces.statusState}|${connectedSurfaces.statusDot}`,
        'connected|status-dot connected');
    check('§2c2 coherent: status bar uses active SSH latency',
        connectedSurfaces.statusLatency, '34 ms');
    check('§2c2 coherent: socket is false while active SSH remains connected',
        `${connectedSurfaces.socketConnected}|${connectedSurfaces.sessionConnected}`,
        'false|true');
    check('§2c2 coherent: socket false does not override active SSH status',
        connectedSurfaces.statusState, 'connected');
    check('§2c2 coherent: desktop chip has zero inline legacy actions',
        connectedSurfaces.legacyControls, 0);

    await page.evaluate(() => SessionManager.updateSessionStatus('i1', 'disconnected'));
    await settleStatusBar(page);
    const disconnectedSurfaces = await page.evaluate(() => ({
        chipDot: document.querySelector('#tab-i1 .status-dot').className,
        headingDot: document.getElementById('sessionActionsHeadingDot').className,
        statusState: document.getElementById('statusBar').dataset.state,
        statusDot: document.getElementById('statusBarDot').className,
        statusLatency: document.getElementById('statusBarLatency').textContent,
        sessionLatency: SessionManager.sessions.i1.latencyMs,
    }));
    check('§2c2 coherent: disconnect updates chip and heading dots together',
        `${disconnectedSurfaces.chipDot}|${disconnectedSurfaces.headingDot}`,
        'status-dot disconnected|status-dot disconnected');
    check('§2c2 coherent: status bar follows active SSH disconnect',
        `${disconnectedSurfaces.statusState}|${disconnectedSurfaces.statusDot}`,
        'disconnected|status-dot disconnected');
    check('§2c2 coherent: disconnect clears visible and stored latency',
        `${disconnectedSurfaces.statusLatency}|${disconnectedSurfaces.sessionLatency}`,
        '|null');

    // Active-session switching selects that record's latency; background events
    // repaint their own chips without changing active status output.
    await page.evaluate(() => {
        SessionManager.applySessionLatency('i2', 52);
        SessionManager.updateSessionStatus('i2', 'connected');
        SessionManager.applySessionLatency('i2', 52);
        SessionManager.activeSessionId = 'i2';
        document.dispatchEvent(new CustomEvent('sshdeck:active-session-changed', {
            detail: { previousSessionId: 'i1', currentSessionId: 'i2' },
        }));
    });
    await settleStatusBar(page);
    check('§2c2 coherent: switching active session switches visible latency',
        await page.evaluate(() => document.getElementById('statusBarLatency').textContent),
        '52 ms');
    const beforeBackground = await page.evaluate(() => ({
        state: document.getElementById('statusBar').dataset.state,
        latency: document.getElementById('statusBarLatency').textContent,
        dims: document.getElementById('statusBarDims').textContent,
    }));
    await page.evaluate(() => {
        SessionManager.updateSessionStatus('i1', 'connected');
        SessionManager.applySessionLatency('i1', 91);
    });
    // Settle first: a bar that never repaints would pass this trivially. The
    // claim is that a repaint HAPPENED and still showed the active session.
    await settleStatusBar(page);
    const afterBackground = await page.evaluate(() => ({
        state: document.getElementById('statusBar').dataset.state,
        latency: document.getElementById('statusBarLatency').textContent,
        dims: document.getElementById('statusBarDims').textContent,
    }));
    check('§2c2 coherent: background session events do not change active output',
        JSON.stringify(afterBackground), JSON.stringify(beforeBackground));

    // Canonical terminal resize events refresh active dimensions. A background
    // terminal resize is observable but must leave the active read-out unchanged.
    const resizeMatrix = await page.evaluate(async () => {
        const frame = () => new Promise(r =>
            requestAnimationFrame(() => requestAnimationFrame(r)));
        TerminalManager.terminals.i2 = { cols: 132, rows: 46 };
        TerminalManager.terminals.i1 = { cols: 91, rows: 33 };
        document.dispatchEvent(new CustomEvent('sshdeck:terminal-resized', {
            detail: { sessionId: 'i2', terminalKey: 'i2', cols: 132, rows: 46 },
        }));
        await frame();
        const active = document.getElementById('statusBarDims').textContent;
        TerminalManager.terminals.i1.cols = 99;
        TerminalManager.terminals.i1.rows = 39;
        document.dispatchEvent(new CustomEvent('sshdeck:terminal-resized', {
            detail: { sessionId: 'i1', terminalKey: 'i1', cols: 99, rows: 39 },
        }));
        await frame();
        const background = document.getElementById('statusBarDims').textContent;
        TerminalManager.terminals.i2.cols = 140;
        TerminalManager.terminals.i2.rows = 50;
        document.dispatchEvent(new CustomEvent('sshdeck:terminal-resized', {
            detail: { sessionId: 'i2', terminalKey: 'i2', cols: 140, rows: 50 },
        }));
        await frame();
        const activeAgain = document.getElementById('statusBarDims').textContent;
        return { active, background, activeAgain };
    });
    check('§2c2 resize: active terminal event refreshes dimensions',
        resizeMatrix.active, '132 × 46');
    check('§2c2 resize: background terminal event leaves active dimensions unchanged',
        resizeMatrix.background, '132 × 46');
    check('§2c2 resize: later active resize refreshes again',
        resizeMatrix.activeAgain, '140 × 50');

    await page.evaluate(() => {
        SessionManager.activeSessionId = 'i1';
        SessionManager.updateSessionStatus('i1', 'connected');
        SessionManager.applySessionLatency('i1', 34);
        SessionManager.updateSessionStatus('i2', 'disconnected');
        window.StatusBar.refresh();
    });

    // S2 + the repaint: switching language must restyle EXISTING chips.
    await setLang('vi');
    await page.waitForTimeout(120);
    check('§2c2 vi: the disconnected chip repaints to "Đã ngắt"',
        await read('i2'), 'Đã ngắt');
    check('§2c2 vi: the live chip keeps its measured latency',
        await read('i1'), 'liveU · 34 ms');

    // And back, so the repaint is not one-directional.
    await setLang('en');
    await page.waitForTimeout(120);
    check('§2c2: switching back repaints to English again',
        await read('i2'), 'Disconnected');

    // S1/S2 continued -- the DOT and the chip outline must agree with the copy.
    // Found by rendering the strip and looking at it: a chip built for an
    // already-disconnected session painted a GREEN dot and no outline next to
    // the words "Đã ngắt", because createSessionTab hardcoded the class. Every
    // text assertion above passed while the picture was plainly wrong.
    const chipState = await page.evaluate(() => {
        const out = {};
        for (const id of ['i1', 'i2']) {
            const el = document.getElementById(`tab-${id}`);
            const d = el.querySelector('.status-dot');
            out[id] = {
                dot: d.className,
                chipHasDown: el.classList.contains('disconnected'),
                dotBg: getComputedStyle(d).backgroundColor,
            };
        }
        return out;
    });
    check('§2c2: a live chip carries the connected dot',
        chipState.i1.dot, 'status-dot connected');
    check('§2c2: a live chip is not marked disconnected',
        chipState.i1.chipHasDown, false);
    check('§2c2: a disconnected chip carries the disconnected dot',
        chipState.i2.dot, 'status-dot disconnected');
    check('§2c2: a disconnected chip is marked on the chip itself',
        chipState.i2.chipHasDown, true);
    check('§2c2: the two dots are not the same colour',
        chipState.i1.dotBg !== chipState.i2.dotBg, true);

    check('§2c2: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2d — [INF-19] pending requests use the shared lifecycle sheet.
//
// A pending chip has the same dot + two-line label inventory as a real session.
// First activation selects only; second activation or long-press opens the one
// shared sheet, where Cancel is the sole enabled operation. No inline X exists.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    const cdp = await page.context().newCDPSession(page);
    await seedSession(page, 'live-p', {
        host: 'live.example', username: 'liveU', connected: true,
        viaJump: 'jump-a', useTmux: true, tmuxSessionName: 'ops-live',
    });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1);
        SessionManager.assignSessionToPane('live-p', 0);
        SessionManager.createPendingConnection('req_s4', 'pend.example', 'pu', 22,
            { authType: 'key', keyId: 'ks4', displayName: 'Pending One' });
    });
    await page.waitForTimeout(60);

    const chipSel = '.session-tab[data-pending-id="req_s4"]';
    const classifyCentre = (sel) => page.evaluate((selector) => {
        const el = document.querySelector(selector);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (!hit) return 'none';
        if (hit === el) return 'self';
        if (!el.contains(hit)) return 'outside';
        const control = hit.closest(
            '.tab-edit, .tab-reconnect, .tab-close, button, a, input, select, '
            + 'textarea, [role="button"], [data-lifecycle-action]');
        return control
            ? `control:${control.className || control.tagName}` : 'inert-child';
    }, sel);

    const baseline = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return {
            role: el?.getAttribute('role'),
            tabindex: el?.getAttribute('tabindex'),
            strong: el?.querySelector('strong')?.textContent,
            small: el?.querySelector('small')?.textContent,
            childCount: el?.children.length,
            inlineActions: el?.querySelectorAll(
                '.tab-edit, .tab-reconnect, .tab-close').length,
            active: SessionManager.activeSessionId,
            panes: JSON.stringify(SessionManager.paneAssignments),
        };
    }, chipSel);
    check('§2d: pending uses tab semantics', baseline.role, 'tab');
    check('§2d: pending is focusable', baseline.tabindex, '0');
    check('§2d: pending primary line uses display name',
        baseline.strong, 'Pending One');
    check('§2d: pending secondary line reports Connecting',
        baseline.small, 'Connecting');
    check('§2d: pending contains exactly dot + label', baseline.childCount, 2);
    check('§2d: pending contains no inline action/X', baseline.inlineActions, 0);
    const pendingHit = await classifyCentre(chipSel);
    check(`§2d: pending centre belongs to chip/label (hit=${pendingHit})`,
        pendingHit === 'self' || pendingHit === 'inert-child', true);

    // Real lifecycle metadata keeps non-secret endpoint/jump/tmux details out of
    // the chip and rebuilds translated fragments while the sheet stays open.
    await page.evaluate(() => window.i18n.setLanguage('en'));
    await selectChip(page, 'live-p');
    await openSheet(page, 'live-p');
    const realEnglish = await page.evaluate(() => ({
        open: !document.getElementById('sessionActionsSheet').hidden,
        target: SessionManager.lifecycleActionTargetId,
        heading: document.getElementById('sessionActionsHeadingName').textContent,
        detail: document.getElementById('sessionActionsHeadingDetail').textContent,
        owner: document.getElementById('sessionActionsHeadingDetail')
            .getAttribute('data-i18n'),
        jumpBadges: document.querySelectorAll('.session-tab .tab-jump-badge').length,
        tmuxBadges: document.querySelectorAll('.session-tab .tab-tmux-badge').length,
    }));
    check('§2d real metadata: sheet opens on the real target',
        `${realEnglish.open}|${realEnglish.target}`, 'true|live-p');
    check('§2d real metadata: target name survives outside the chip metadata',
        realEnglish.heading, 'Prod DB');
    check('§2d real metadata: endpoint + jump + tmux render in English',
        realEnglish.detail,
        'liveU@live.example:22 · via jump-a · Persistent session · tmux: ops-live');
    check('§2d real metadata: dynamic detail has no data-i18n owner',
        realEnglish.owner, null);
    check('§2d real metadata: production chips contain zero jump badges',
        realEnglish.jumpBadges, 0);
    check('§2d real metadata: production chips contain zero tmux badges',
        realEnglish.tmuxBadges, 0);

    await page.evaluate(() => window.i18n.setLanguage('vi'));
    await page.waitForTimeout(80);
    const realVietnamese = await page.evaluate(() => ({
        open: !document.getElementById('sessionActionsSheet').hidden,
        target: SessionManager.lifecycleActionTargetId,
        heading: document.getElementById('sessionActionsHeadingName').textContent,
        detail: document.getElementById('sessionActionsHeadingDetail').textContent,
        owner: document.getElementById('sessionActionsHeadingDetail')
            .getAttribute('data-i18n'),
    }));
    check('§2d real i18n: sheet and target stay open/selected',
        `${realVietnamese.open}|${realVietnamese.target}`, 'true|live-p');
    check('§2d real i18n: target name survives locale repaint',
        realVietnamese.heading, 'Prod DB');
    check('§2d real i18n: endpoint survives and metadata fragments translate',
        realVietnamese.detail,
        'liveU@live.example:22 · qua jump-a · Phiên duy trì · tmux: ops-live');
    check('§2d real i18n: rebuilt detail remains dynamically owned',
        realVietnamese.owner, null);
    await page.evaluate(() => window.i18n.setLanguage('en'));
    await page.waitForTimeout(80);

    // Real target -> pending: first click closes the open real sheet and selects
    // only. It may not cancel, change panes, focus composer or raise keyboard.
    await page.click(chipSel);
    const selected = await page.evaluate(() => ({
        pendingTarget: SessionManager.lifecyclePendingTargetId,
        realTarget: SessionManager.lifecycleActionTargetId,
        sheetClosed: document.getElementById('sessionActionsSheet').hidden,
        active: SessionManager.activeSessionId,
        panes: JSON.stringify(SessionManager.paneAssignments),
        record: !!SessionManager.pendingConnections.req_s4,
        focused: document.activeElement?.id || '',
        keyboard: document.body.classList.contains('keyboard-open'),
    }));
    check('§2d real→pending: first click selects pending',
        selected.pendingTarget, 'req_s4');
    check('§2d real→pending: real target clears via setter',
        selected.realTarget, null);
    check('§2d real→pending: stale sheet closes', selected.sheetClosed, true);
    check('§2d real→pending: request remains', selected.record, true);
    check('§2d real→pending: active session unchanged',
        selected.active, 'live-p');
    check('§2d real→pending: panes unchanged', selected.panes, baseline.panes);
    check('§2d real→pending: composer not focused',
        selected.focused === 'mobileInput', false);
    check('§2d real→pending: keyboard stays closed', selected.keyboard, false);

    await page.click(chipSel);
    const sheet = await page.evaluate(() => {
        const chip = document.getElementById('pending-req_s4')
            .getBoundingClientRect();
        const box = document.getElementById('sessionActionsSheet')
            .getBoundingClientRect();
        return {
            open: !document.getElementById('sessionActionsSheet').hidden,
            heading: document.getElementById('sessionActionsHeadingName').textContent,
            detail: document.getElementById('sessionActionsHeadingDetail').textContent,
            detailOwner: document.getElementById('sessionActionsHeadingDetail')
                .getAttribute('data-i18n'),
            disabled: ['sessionActionRename', 'sessionActionReconnect',
                'sessionActionReset', 'sessionActionClose'].map(id =>
                    document.getElementById(id).disabled).join(','),
            cancel: document.querySelector('#sessionActionClose span').textContent,
            count: document.querySelectorAll(
                '#sessionActionsSheet [data-lifecycle-action]').length,
            side: box.top >= chip.bottom - 1 ? 'below'
                : box.bottom <= chip.top + 1 ? 'above' : 'overlap',
            gap: box.top >= chip.bottom - 1
                ? Math.abs(box.top - chip.bottom)
                : box.bottom <= chip.top + 1
                    ? Math.abs(chip.top - box.bottom) : Number.POSITIVE_INFINITY,
            inlineDelta: Math.min(
                Math.abs(box.left - chip.left), Math.abs(box.right - chip.right)),
            chipInline: `${Math.round(chip.left)}..${Math.round(chip.right)}`,
            sheetInline: `${Math.round(box.left)}..${Math.round(box.right)}`,
            contained: box.left >= 0 && box.top >= 0
                && box.right <= innerWidth && box.bottom <= innerHeight,
        };
    });
    check('§2d: second click opens shared sheet', sheet.open, true);
    check('§2d: pending sheet is strictly above or below its chip',
        sheet.side === 'above' || sheet.side === 'below', true);
    check(`§2d: pending sheet anchor gap is at most 8px (gap=${sheet.gap})`,
        sheet.gap <= 8, true);
    check(`§2d: pending sheet inline delta is at most 8px (delta=${sheet.inlineDelta}; chip=${sheet.chipInline}; sheet=${sheet.sheetInline})`,
        sheet.inlineDelta <= 8, true);
    check('§2d: pending sheet is viewport-contained', sheet.contained, true);
    check('§2d: heading names pending target', sheet.heading, 'Pending One');
    check('§2d: detail contains endpoint + Cancel', sheet.detail,
        'pu@pend.example:22 · Cancel connection');
    check('§2d: dynamic detail removes data-i18n owner',
        sheet.detailOwner, null);
    check('§2d: only Cancel is enabled',
        sheet.disabled, 'true,true,true,false');
    check('§2d: fourth row relabelled Cancel connection',
        sheet.cancel, 'Cancel connection');
    check('§2d: shared sheet still has six rows', sheet.count, 6);

    await page.focus('#sessionActionClose');
    check('§2d Escape: Cancel owns focus before closing',
        await page.evaluate(() => document.activeElement?.id), 'sessionActionClose');
    await page.keyboard.press('Escape');
    const escapedPending = await page.evaluate(() => ({
        closed: document.getElementById('sessionActionsSheet').hidden,
        target: SessionManager.lifecyclePendingTargetId,
        record: !!SessionManager.pendingConnections.req_s4,
        focused: document.activeElement?.id || '',
    }));
    check('§2d Escape: pending sheet closes', escapedPending.closed, true);
    check('§2d Escape: pending target and record remain selected',
        `${escapedPending.target}|${escapedPending.record}`, 'req_s4|true');
    check('§2d Escape: focus returns to the pending chip',
        escapedPending.focused, 'pending-req_s4');
    await page.keyboard.press('Enter');
    check('§2d Escape: Enter reopens the selected pending sheet',
        await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet').hidden), true);

    await page.evaluate(() => window.i18n.setLanguage('vi'));
    await page.waitForTimeout(80);
    const translated = await page.evaluate(() => ({
        open: !document.getElementById('sessionActionsSheet').hidden,
        target: SessionManager.lifecyclePendingTargetId,
        chipState: document.querySelector('#pending-req_s4 small').textContent,
        heading: document.getElementById('sessionActionsHeadingName').textContent,
        detail: document.getElementById('sessionActionsHeadingDetail').textContent,
        detailOwner: document.getElementById('sessionActionsHeadingDetail')
            .getAttribute('data-i18n'),
        cancel: document.querySelector('#sessionActionClose span').textContent,
    }));
    check('§2d i18n: sheet keeps same target',
        `${translated.open}|${translated.target}`, 'true|req_s4');
    check('§2d i18n: pending chip repaints status.connecting',
        translated.chipState, 'Đang kết nối');
    check('§2d i18n: target name survives', translated.heading, 'Pending One');
    check('§2d i18n: detail rebuilds translated fragment',
        translated.detail, 'pu@pend.example:22 · Hủy kết nối');
    check('§2d i18n: detail remains outside data-i18n ownership',
        translated.detailOwner, null);
    check('§2d i18n: Cancel action label translates',
        translated.cancel, 'Hủy kết nối');

    // Keyboard parity: first Enter selects only; second Enter opens.
    await page.evaluate(() => SessionManager.createPendingConnection(
        'req_key', 'key.example', 'keyU', 2200, { authType: 'key' }));
    await page.focus('#pending-req_key');
    await page.keyboard.press('Enter');
    const keyFirst = await page.evaluate(() => ({
        target: SessionManager.lifecyclePendingTargetId,
        closed: document.getElementById('sessionActionsSheet').hidden,
        exists: !!SessionManager.pendingConnections.req_key,
    }));
    check('§2d keyboard: first Enter selects only',
        `${keyFirst.target}|${keyFirst.closed}|${keyFirst.exists}`,
        'req_key|true|true');
    await page.keyboard.press('Enter');
    check('§2d keyboard: second Enter opens sheet',
        await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet').hidden), true);
    await page.evaluate(() => SessionManager.clearPendingConnection('req_key'));

    // ssh_connected consumes a selected pending request through the production
    // takePendingConnection path. It must clear selected UI/sheet safely while
    // returning that request's metadata and preserving unrelated pending work.
    await page.evaluate(() => SessionManager.createPendingConnection(
        'req_success', 'success.example', 'successU', 2222,
        { authType: 'key', keyId: 'success-key', displayName: 'Success Pending' }));
    await page.focus('#pending-req_success');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const successOpen = await page.evaluate(() => ({
        target: SessionManager.lifecyclePendingTargetId,
        open: !document.getElementById('sessionActionsSheet').hidden,
    }));
    check('§2d success consume: selected pending sheet is open',
        `${successOpen.target}|${successOpen.open}`, 'req_success|true');
    const consumed = await page.evaluate(() => {
        const record = SessionManager.takePendingConnection('req_success');
        return {
            record,
            chipGone: !document.getElementById('pending-req_success'),
            storeGone: SessionManager.pendingConnections.req_success === undefined,
            target: SessionManager.lifecyclePendingTargetId,
            sheetClosed: document.getElementById('sessionActionsSheet').hidden,
            hintOwner: document.getElementById('sessionActionsHeadingDetail')
                .getAttribute('data-i18n'),
            unrelatedPending: !!SessionManager.pendingConnections.req_s4,
        };
    });
    check('§2d success consume: returns the request metadata',
        `${consumed.record?.username}@${consumed.record?.host}:${consumed.record?.port}`,
        'successU@success.example:2222');
    check('§2d success consume: removes chip and pending record',
        `${consumed.chipGone}|${consumed.storeGone}`, 'true|true');
    check('§2d success consume: clears target and closes sheet',
        `${consumed.target}|${consumed.sheetClosed}`, 'null|true');
    check('§2d success consume: restores the selected-hint owner',
        consumed.hintOwner, 'session.selectedHint');
    check('§2d success consume: preserves unrelated pending request',
        consumed.unrelatedPending, true);

    // Pending -> real clears pending target and stale sheet, not the request.
    await page.click(chipSel);
    await page.click('#tab-live-p');
    const realSelected = await page.evaluate(() => ({
        pending: SessionManager.lifecyclePendingTargetId,
        real: SessionManager.lifecycleActionTargetId,
        sheetClosed: document.getElementById('sessionActionsSheet').hidden,
        requestExists: !!SessionManager.pendingConnections.req_s4,
    }));
    check('§2d pending→real: pending target clears', realSelected.pending, null);
    check('§2d pending→real: real target selected', realSelected.real, 'live-p');
    check('§2d pending→real: stale sheet closes',
        realSelected.sheetClosed, true);
    check('§2d pending→real: request is not cancelled',
        realSelected.requestExists, true);

    // Real trusted long-press opens a new pending sheet directly.
    await page.evaluate(() => SessionManager.createPendingConnection(
        'req_long', 'hold.example', 'holdU', undefined,
        { authType: 'key', displayName: 'Hold Pending' }));
    const hold = await page.locator('#pending-req_long').boundingBox();
    const hx = Math.round(hold.x + hold.width / 2);
    const hy = Math.round(hold.y + hold.height / 2);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: hx, y: hy }],
    });
    await page.waitForTimeout(620);
    const heldOpen = await page.evaluate(() => ({
        target: SessionManager.lifecyclePendingTargetId,
        open: !document.getElementById('sessionActionsSheet').hidden,
        detail: document.getElementById('sessionActionsHeadingDetail').textContent,
        active: SessionManager.activeSessionId,
        panes: JSON.stringify(SessionManager.paneAssignments),
        composer: document.activeElement?.id === 'mobileInput',
        keyboard: document.body.classList.contains('keyboard-open'),
    }));
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd', touchPoints: [],
    });
    await page.waitForTimeout(80);
    check('§2d long-press: selects pending target',
        heldOpen.target, 'req_long');
    check('§2d long-press: opens sheet directly', heldOpen.open, true);
    check('§2d long-press: missing port omits :undefined',
        heldOpen.detail, 'holdU@hold.example · Hủy kết nối');
    check('§2d long-press: active session unchanged', heldOpen.active, 'live-p');
    check('§2d long-press: panes unchanged', heldOpen.panes, baseline.panes);
    check('§2d long-press: composer stays unfocused', heldOpen.composer, false);
    check('§2d long-press: keyboard stays closed', heldOpen.keyboard, false);
    check('§2d long-press: synthetic click does not close sheet',
        await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet').hidden), true);

    // Removing an unrelated real session preserves selected pending state.
    await page.evaluate(() => {
        SessionManager.sessions.unrelated = {
            id: 'unrelated', host: 'other.example', port: 22,
            username: 'other', connected: false,
            terminalId: 'missing-unrelated', isPersistentCandidate: false,
            useTmux: false,
        };
        SessionManager.createSessionTab('unrelated', 'other.example', 'other');
        SessionManager.removeSessionUI('unrelated');
    });
    const afterUnrelated = await page.evaluate(() => ({
        pending: SessionManager.lifecyclePendingTargetId,
        open: !document.getElementById('sessionActionsSheet').hidden,
        decorated: document.querySelectorAll(
            '.session-tab.lifecycle-target').length,
    }));
    check('§2d unrelated removal: pending target preserved',
        afterUnrelated.pending, 'req_long');
    check('§2d unrelated removal: pending sheet remains open',
        afterUnrelated.open, true);
    check('§2d unrelated removal: one target decoration remains',
        afterUnrelated.decorated, 1);

    await page.click('#sessionActionClose');
    const cancelled = await page.evaluate(() => ({
        chipGone: !document.getElementById('pending-req_long'),
        recordGone: SessionManager.pendingConnections.req_long === undefined,
        pending: SessionManager.lifecyclePendingTargetId,
        real: SessionManager.lifecycleActionTargetId,
        sheetClosed: document.getElementById('sessionActionsSheet').hidden,
        hintOwner: document.getElementById('sessionActionsHeadingDetail')
            .getAttribute('data-i18n'),
        hint: document.getElementById('sessionActionsHeadingDetail').textContent,
        active: SessionManager.activeSessionId,
        panes: JSON.stringify(SessionManager.paneAssignments),
        composer: document.activeElement?.id === 'mobileInput',
        keyboard: document.body.classList.contains('keyboard-open'),
    }));
    check('§2d cancel: removes chip + record',
        `${cancelled.chipGone}|${cancelled.recordGone}`, 'true|true');
    check('§2d cancel: clears both target kinds',
        `${cancelled.pending}|${cancelled.real}`, 'null|null');
    check('§2d cancel: closes sheet', cancelled.sheetClosed, true);
    check('§2d cancel: restores hint ownership',
        cancelled.hintOwner, 'session.selectedHint');
    check('§2d cancel: restores translated hint',
        cancelled.hint, 'Đã chọn · chạm lại hoặc nhấn giữ');
    check('§2d cancel: active session unchanged', cancelled.active, 'live-p');
    check('§2d cancel: panes unchanged', cancelled.panes, baseline.panes);
    check('§2d cancel: composer stays unfocused', cancelled.composer, false);
    check('§2d cancel: keyboard stays closed', cancelled.keyboard, false);

    // Strong neutral connected-chip centre guard on the new dot+label DOM.
    const liveHit = await classifyCentre('#tab-live-p');
    check(`§2d connected centre has no overlapping action (hit=${liveHit})`,
        liveHit === 'self' || liveHit === 'inert-child', true);

    check('§2d: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2e — Fine-pointer desktop chip ownership.
//
// Production chips are dot + label only on every tier. The centre guard rejects
// any legacy or generic interactive descendant rather than treating it as inert
// label content, so an overlapping action cannot silently steal selection.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1440, 900, { touch: false });
    await seedSession(page, 'fp1', { host: 'fine.example', username: 'fu' });
    await seedSession(page, 'fp2', {
        host: 'fine2.example', username: 'fu2', displayName: 'Fine Two',
    });
    await page.waitForTimeout(80);

    const classifyDesktopCentre = id => page.evaluate((sessionId) => {
        const el = document.getElementById(`tab-${sessionId}`);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (!hit) return 'none';
        if (hit === el) return 'self';
        if (!el.contains(hit)) return 'outside';
        const control = hit.closest(
            '.tab-edit, .tab-reconnect, .tab-close, button, a, input, select, '
            + 'textarea, [role="button"], [data-lifecycle-action]');
        return control
            ? `control:${control.className || control.tagName}` : 'inert-child';
    }, id);
    const probe = {};
    for (const id of ['fp1', 'fp2']) {
        probe[id] = {
            legacyControls: await page.locator(`#tab-${id}`).locator(
                '.tab-edit, .tab-reconnect, .tab-close').count(),
            hit: await classifyDesktopCentre(id),
        };
    }

    check('§2e: production desktop chips contain zero legacy inline controls',
        probe.fp1.legacyControls + probe.fp2.legacyControls, 0);
    check(`§2e: fp1 centre is not covered by a control (hit=${probe.fp1.hit})`,
        probe.fp1.hit === 'self' || probe.fp1.hit === 'inert-child', true);
    check(`§2e: fp2 centre is not covered by a control (hit=${probe.fp2.hit})`,
        probe.fp2.hit === 'self' || probe.fp2.hit === 'inert-child', true);

    // Mutation proof in the live DOM: insert a generic action over fp1's centre.
    // The SAME classifier must turn red, then return green after unconditional
    // cleanup, so neither mutation nor restoration can drift from the guard.
    await page.evaluate(() => {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'centre-mutation-action';
        action.dataset.centreMutation = 'true';
        Object.assign(action.style, {
            position: 'absolute', inset: '0', zIndex: '20', opacity: '0.01',
        });
        document.getElementById('tab-fp1').appendChild(action);
    });
    let mutatedHit;
    try {
        mutatedHit = await classifyDesktopCentre('fp1');
    } finally {
        await page.locator('[data-centre-mutation="true"]').evaluate(action => action.remove());
    }
    check('§2e mutation: centre overlay is classified as a control',
        mutatedHit.startsWith('control:'), true);
    const restoredHit = await classifyDesktopCentre('fp1');
    check(`§2e mutation restore: fp1 centre is clean again (hit=${restoredHit})`,
        restoredHit === 'self' || restoredHit === 'inert-child', true);

    // End-to-end: a real centred click selects the chip. This is the user-visible
    // symptom from the report -- the chip simply did not respond.
    await page.click('#tab-fp2');
    await page.waitForTimeout(100);
    check('§2e: a real centred click on a fine pointer selects that chip',
        await page.evaluate(() => SessionManager.lifecycleActionTargetId), 'fp2');

    // [INF-19] is capability-neutral: desktop pending chips use the same first
    // activation → select, second activation → shared Cancel sheet grammar.
    await page.evaluate(() => SessionManager.createPendingConnection(
        'req_fp_click', 'desktop-pending.example', 'deskU', 2201,
        { authType: 'key', displayName: 'Desktop Pending' }));
    const desktopActiveBefore = await page.evaluate(() => SessionManager.activeSessionId);
    await page.click('#pending-req_fp_click');
    const desktopPendingFirst = await page.evaluate(() => ({
        target: SessionManager.lifecyclePendingTargetId,
        real: SessionManager.lifecycleActionTargetId,
        closed: document.getElementById('sessionActionsSheet').hidden,
        active: SessionManager.activeSessionId,
        record: !!SessionManager.pendingConnections.req_fp_click,
    }));
    check('§2e pending click: first click selects only',
        `${desktopPendingFirst.target}|${desktopPendingFirst.real}`,
        'req_fp_click|null');
    check('§2e pending click: first click keeps sheet closed and record alive',
        `${desktopPendingFirst.closed}|${desktopPendingFirst.record}`, 'true|true');
    check('§2e pending click: first click leaves active session unchanged',
        desktopPendingFirst.active, desktopActiveBefore);
    await page.click('#pending-req_fp_click');
    const desktopPendingSecond = await page.evaluate(() => ({
        open: !document.getElementById('sessionActionsSheet').hidden,
        disabled: ['sessionActionRename', 'sessionActionReconnect',
            'sessionActionReset', 'sessionActionClose'].map(id =>
                document.getElementById(id).disabled).join(','),
        cancel: document.querySelector('#sessionActionClose span').textContent,
    }));
    check('§2e pending click: second click opens shared sheet',
        desktopPendingSecond.open, true);
    check('§2e pending click: only Cancel is enabled',
        desktopPendingSecond.disabled, 'true,true,true,false');
    check('§2e pending click: fourth row is Cancel connection',
        desktopPendingSecond.cancel, 'Cancel connection');
    await page.evaluate(() => SessionManager.clearPendingConnection('req_fp_click'));

    await page.evaluate(() => SessionManager.createPendingConnection(
        'req_fp_key', 'desktop-key.example', 'deskKey', 2202, { authType: 'key' }));
    await page.focus('#pending-req_fp_key');
    await page.keyboard.press('Enter');
    const desktopKeyFirst = await page.evaluate(() => ({
        target: SessionManager.lifecyclePendingTargetId,
        closed: document.getElementById('sessionActionsSheet').hidden,
    }));
    check('§2e pending keyboard: first Enter selects only',
        `${desktopKeyFirst.target}|${desktopKeyFirst.closed}`, 'req_fp_key|true');
    await page.keyboard.press('Enter');
    check('§2e pending keyboard: second Enter opens shared sheet',
        await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet').hidden), true);
    await page.evaluate(() => SessionManager.clearPendingConnection('req_fp_key'));

    check('§2e: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2b — Two out-of-order pending ssh_connected preserve their own jumpHostId
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);
    await spyEmits(page);

    // Seed two pending connections with different jumpHostId via the real API.
    await page.evaluate(() => {
        SessionManager.createPendingConnection('req_aaa', 'hostA', 'userA', 22,
            { authType: 'key', keyId: 'ka', jumpHostId: 'jhA', displayName: 'A' });
        SessionManager.createPendingConnection('req_bbb', 'hostB', 'userB', 22,
            { authType: 'key', keyId: 'kb', jumpHostId: 'jhB', displayName: 'B' });
    });

    // Fire takePendingConnection for the SECOND one first, then the first —
    // proving it matches by requestId with no cross-talk.
    const store = await page.evaluate(() => {
        const b = SessionManager.takePendingConnection('req_bbb');
        const a = SessionManager.takePendingConnection('req_aaa');
        return { a, b };
    });
    check('§2b: out-of-order b has jhB', store.b?.jumpHostId, 'jhB');
    check('§2b: out-of-order a has jhA', store.a?.jumpHostId, 'jhA');
    check('§2b: a has no jhB cross-talk', store.a?.jumpHostId === 'jhB', false);
    check('§2b: b has no jhA cross-talk', store.b?.jumpHostId === 'jhA', false);
    check('§2b: no password in pending record a',
        Object.prototype.hasOwnProperty.call(store.a || {}, 'password'), false);
    check('§2b: no password in pending record b',
        Object.prototype.hasOwnProperty.call(store.b || {}, 'password'), false);

    const cleared = await page.evaluate(() => ({
        a: SessionManager.pendingConnections['req_aaa'],
        b: SessionManager.pendingConnections['req_bbb'],
    }));
    check('§2b: both pending records cleared',
        cleared.a === undefined && cleared.b === undefined, true);

    check('§2b: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §2c — createSession pending-fallback: metadata survives when ssh_connected
// response omits them. Proves the seven-field store falls back to the
// request-keyed pending record (response-precedence, pending-fallback).
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);

    // Register a pending connection with full non-secret metadata.
    await page.evaluate(() => {
        SessionManager.createPendingConnection('req_fb1', 'fbhost', 'fbuser', 2222,
            { authType: 'key', keyId: 'fbk', jumpHostId: 'fbjh', displayName: 'Fallback Name' });
    });

    // Simulate ssh_connected with a response that OMITS display_name, key_id,
    // auth_type — createSession must fall back to the pending record.
    const stored = await page.evaluate(() => {
        const pending = SessionManager.takePendingConnection('req_fb1');
        SessionManager.createSession({
            session_id: 'fb-sess',
            host: 'fbhost',
            port: 2222,
            username: 'fbuser',
            // display_name, key_id, auth_type intentionally absent
        }, pending);
        const s = SessionManager.sessions['fb-sess'];
        return {
            displayName: s?.displayName,
            keyId: s?.keyId,
            authType: s?.authType,
            jumpHostId: s?.jumpHostId,
        };
    });
    check('§2c fallback: displayName from pending', stored.displayName, 'Fallback Name');
    check('§2c fallback: keyId from pending', stored.keyId, 'fbk');
    check('§2c fallback: authType from pending', stored.authType, 'key');
    check('§2c fallback: jumpHostId from pending', stored.jumpHostId, 'fbjh');

    // Response precedence: when ssh_connected DOES include a field, it wins.
    const overridden = await page.evaluate(() => {
        SessionManager.createPendingConnection('req_ov1', 'ovhost', 'ovuser', 22,
            { authType: 'key', keyId: 'ovk', jumpHostId: 'ovjh', displayName: 'Pending' });
        const pending = SessionManager.takePendingConnection('req_ov1');
        SessionManager.createSession({
            session_id: 'ov-sess',
            host: 'ovhost',
            port: 22,
            username: 'ovuser',
            display_name: 'Server Name',
            key_id: 'srvk',
            auth_type: 'password',
        }, pending);
        const s = SessionManager.sessions['ov-sess'];
        return {
            displayName: s?.displayName,
            keyId: s?.keyId,
            authType: s?.authType,
            jumpHostId: s?.jumpHostId,
        };
    });
    check('§2c precedence: server display_name wins', overridden.displayName, 'Server Name');
    check('§2c precedence: server key_id wins', overridden.keyId, 'srvk');
    check('§2c precedence: server auth_type wins', overridden.authType, 'password');
    check('§2c precedence: jumpHostId from pending (server never sends it)',
        overridden.jumpHostId, 'ovjh');

    check('§2c: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §3 — Reset modal path (password target)
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);
    await spyEmits(page);

    await seedSession(page, 's4', {
        host: 'pw.example', username: 'pwuser', authType: 'password',
        displayName: 'PW Session',
    });

    // Select the chip, then trigger Reset -> modal path (password target).
    await selectChip(page, 's4');
    await invokeAction(page, 's4', 'reset');
    check('§3 modal: Reset is gated by the confirm dialog on the modal path too',
        await answerConfirm(page, true), true);
    await page.waitForTimeout(200);

    const modalState = await page.evaluate(() => {
        const modal = document.getElementById('connectionModal');
        const hostInput = document.getElementById('hostInput');
        const userInput = document.getElementById('usernameInput');
        const authTypeSelect = document.getElementById('authTypeSelect');
        const tmuxCheck = document.getElementById('useTmuxCheck');
        return {
            modalOpen: modal ? modal.classList.contains('show') : false,
            host: hostInput ? hostInput.value : null,
            user: userInput ? userInput.value : null,
            authType: authTypeSelect ? authTypeSelect.value : null,
            tmuxChecked: tmuxCheck ? tmuxCheck.checked : null,
            activeId: document.activeElement ? document.activeElement.id : null,
            pendingMeta: SessionManager.pendingResetMeta,
            emits: window.__connectEmits.length,
        };
    });

    check('§3 modal: zero ssh_connect on open', modalState.emits, 0);
    check('§3 modal: modal opened', modalState.modalOpen, true);
    check('§3 modal: host prefilled', modalState.host, 'pw.example');
    check('§3 modal: username prefilled', modalState.user, 'pwuser');
    check('§3 modal: authType prefilled', modalState.authType, 'password');
    check('§3 modal: tmux unchecked', modalState.tmuxChecked, false);
    check('§3 modal: no autofocus on composer',
        modalState.activeId !== 'mobileInput', true);
    check('§3 modal: no autofocus on password input',
        modalState.activeId !== 'passwordInput', true);
    check('§3 modal: pendingResetMeta requestId is reset_',
        (modalState.pendingMeta?.requestId || '').startsWith('reset_'), true);
    check('§3 modal: pendingResetMeta has original sessionId',
        modalState.pendingMeta?.sessionId, 's4');
    check('§3 modal: no password in pendingResetMeta',
        Object.prototype.hasOwnProperty.call(modalState.pendingMeta || {}, 'password'), false);

    // Cancel the modal → original session intact, no emit, meta cleared.
    await page.click('#cancelConnectionBtn');
    await page.waitForTimeout(100);
    const afterCancel = await page.evaluate(() => ({
        emits: window.__connectEmits.length,
        sessionExists: !!SessionManager.sessions['s4'],
        metaCleared: SessionManager.pendingResetMeta,
    }));
    check('§3 cancel: zero emits after cancel', afterCancel.emits, 0);
    check('§3 cancel: original session intact', afterCancel.sessionExists, true);
    check('§3 cancel: pendingResetMeta cleared', afterCancel.metaCleared, null);

    // Now do a full modal reset: open, type password, submit form.
    await selectChip(page, 's4');
    await invokeAction(page, 's4', 'reset');
    check('§3 submit: the confirm dialog gates the second Reset as well',
        await answerConfirm(page, true), true);
    await page.waitForTimeout(200);

    await page.fill('#passwordInput', 'secret123');
    await page.click('#connectBtn');
    await page.waitForTimeout(200);

    const emits = await page.evaluate(() => window.__connectEmits);
    const sessionClosed = await page.evaluate(() => !SessionManager.sessions['s4']);
    const sessionsNoPassword = await page.evaluate(() =>
        Object.values(SessionManager.sessions).every(s =>
            !Object.prototype.hasOwnProperty.call(s, 'password')));

    check('§3 submit: exactly one ssh_connect', emits.length, 1);
    check('§3 submit: client_request_id starts reset_',
        (emits[0]?.client_request_id || '').startsWith('reset_'), true);
    check('§3 submit: use_tmux false', emits[0]?.use_tmux, false);
    check('§3 submit: reconnect_tmux_name null', emits[0]?.reconnect_tmux_name, null);
    check('§3 submit: display_name preserved', emits[0]?.display_name, 'PW Session');
    check('§3 submit: original session closed once', sessionClosed, true);
    check('§3 submit: no password in SessionManager.sessions values',
        sessionsNoPassword, true);

    // The modal-submit createPendingConnection must carry the PW Session
    // displayName (from resetMeta) so ssh_connected can preserve it.
    const modalPending = await page.evaluate((rid) =>
        SessionManager.pendingConnections[rid],
        emits[0]?.client_request_id);
    check('§3 submit: pending record exists under reset_* id',
        !!modalPending, true);
    check('§3 submit: pending displayName is PW Session',
        modalPending?.displayName, 'PW Session');
    check('§3 submit: no password in modal pending record',
        Object.prototype.hasOwnProperty.call(modalPending || {}, 'password'), false);

    check('§3: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §4 — Rail lock at iPad portrait + landscape + phone
// ============================================================================
for (const [label, w, h] of [
    ['834×1194 iPad portrait', 834, 1194],
    ['1194×834 iPad landscape', 1194, 834],
    ['428×926 phone', 428, 926],
]) {
    const { ctx, page, errors } = await newPage(w, h);
    await seedSession(page, 'r1');

    const rail = await page.evaluate(() => {
        const tabs = document.getElementById('sessionTabs');
        const cs = tabs ? getComputedStyle(tabs) : null;
        return cs ? {
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
            overscrollX: cs.overscrollBehaviorX,
            touchAction: cs.touchAction,
        } : null;
    });
    check(`${label}: rail overflow-x auto`, rail?.overflowX, 'auto');
    check(`${label}: rail overflow-y hidden`, rail?.overflowY, 'hidden');
    check(`${label}: rail overscroll-behavior-x contain`, rail?.overscrollX, 'contain');
    check(`${label}: rail touch-action pan-x`, rail?.touchAction, 'pan-x');

    // Real gesture: a vertical drag on the strip must not scroll it vertically.
    const box = await page.evaluate(() => {
        const tabs = document.getElementById('sessionTabs');
        const r = tabs.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const cx = box.x + 40;
    const cy = box.y + Math.round(box.h / 2);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 60, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const afterScroll = await page.evaluate(() =>
        document.getElementById('sessionTabs').scrollTop);
    check(`${label}: vertical drag → scrollTop stays 0`, afterScroll, 0);

    check(`${label}: rail no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §4b — Orientation round trip: nothing relocates, and nothing breaks.
//
// RESTATED (owner ruling). This section used to pin that the strip
// relocates into a dock slot in phone landscape while the overlay host stays a
// body child. The relocation is retired -- a phone is too small for a
// dock-shared strip, that layout belongs to wide screens -- so phone landscape
// keeps the same two-row header as portrait. What still matters, and is pinned
// below, is that a rotation changes NOTHING about node identity: the strip is
// the same node in the same row, the control is the same root overlay host (a
// direct body child, see templates/index.html), no
// id is duplicated, focus is not dropped, and the sheet stays openable and
// usable in BOTH orientations. All identity comparisons are performed INSIDE
// the page so DOM node references are never serialized.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);
    await seedSession(page, 'loc1');
    const sentLoc = await installFocusSentinels(page, ['loc1']);
    checkSentinels('§4b sentinels', sentLoc, ['loc1']);
    await spyEmits(page);

    // Store real in-page DOM references for the strip, the control and each of
    // the three buttons. Identity comparisons happen inside page.evaluate.
    await page.evaluate(() => {
        window.__p2Nodes = {
            strip: document.getElementById('sessionTabs'),
            control: document.getElementById('sessionActionsControl'),
            rename: document.getElementById('sessionActionRename'),
            reconnect: document.getElementById('sessionActionReconnect'),
            reset: document.getElementById('sessionActionReset'),
        };
    });

    const snapshot = () => page.evaluate(() => {
        const n = window.__p2Nodes;
        const strip = document.getElementById('sessionTabs');
        const control = document.getElementById('sessionActionsControl');
        const inTabsRow = el =>
            !!(el && el.parentElement
                && el.parentElement.classList.contains('session-tabs-row'));
        return {
            sameStrip: n.strip === strip,
            sameControl: n.control === control,
            sameRename: n.rename === document.getElementById('sessionActionRename'),
            sameReconnect: n.reconnect === document.getElementById('sessionActionReconnect'),
            sameReset: n.reset === document.getElementById('sessionActionReset'),
            stripInTabsRow: inTabsRow(strip),
            controlInTabsRow: inTabsRow(control),
            stripConnected: strip ? strip.isConnected : false,
            controlConnected: control ? control.isConnected : false,
            stripCount: document.querySelectorAll('#sessionTabs').length,
            controlCount: document.querySelectorAll('#sessionActionsControl').length,
            renameCount: document.querySelectorAll('#sessionActionRename').length,
            reconnectCount: document.querySelectorAll('#sessionActionReconnect').length,
            resetCount: document.querySelectorAll('#sessionActionReset').length,
            controlIsBodyChild: control ? control.parentElement === document.body : false,
        };
    });

    // Dispatch proof: with a target selected and confirm declining, a real
    // click on Reset must reach dispatchLifecycleAction (target survives, no
    // emit). Proves the delegated listener works in the current parent.
    const dispatchWorks = async () => {
        await invokeAction(page, 'loc1', 'reset');
        await answerConfirm(page, false);
        await page.waitForTimeout(80);
        return await page.evaluate(() => ({
            target: SessionManager.lifecycleActionTargetId,
            emits: window.__connectEmits.length,
        }));
    };

    // ---- Portrait baseline ----
    const portraitBefore = await snapshot();
    check('relocate portrait: strip in .session-tabs-row',
        portraitBefore.stripInTabsRow, true);
    check('relocate portrait: control is NOT in the session row (v5 section 3)',
        portraitBefore.controlInTabsRow, false);
    check('relocate portrait: control is the root overlay host (body child)',
        portraitBefore.controlIsBodyChild, true);
    check('relocate portrait: strip connected', portraitBefore.stripConnected, true);
    check('relocate portrait: control connected', portraitBefore.controlConnected, true);
    check('relocate portrait: exactly one #sessionTabs', portraitBefore.stripCount, 1);
    check('relocate portrait: exactly one #sessionActionsControl',
        portraitBefore.controlCount, 1);
    check('relocate portrait: no duplicate lifecycle button ids',
        `${portraitBefore.renameCount}:${portraitBefore.reconnectCount}:${portraitBefore.resetCount}`,
        '1:1:1');

    const selPortrait = await selectChip(page, 'loc1');
    check('relocate portrait: chip selection sets the target', selPortrait.target, 'loc1');
    const portraitDispatch = await dispatchWorks();
    check('relocate portrait: Reset dispatches (target intact, no emit)',
        `${portraitDispatch.target}:${portraitDispatch.emits}`, 'loc1:0');

    // ---- Rotate to phone landscape: every node stays where it was ----
    await page.setViewportSize({ width: 926, height: 428 });
    await page.waitForTimeout(300);

    const landscape = await snapshot();
    check('relocate landscape: strip is the same DOM node', landscape.sameStrip, true);
    check('relocate landscape: control is the same DOM node', landscape.sameControl, true);
    check('relocate landscape: Rename is the same DOM node', landscape.sameRename, true);
    check('relocate landscape: Reconnect is the same DOM node', landscape.sameReconnect, true);
    check('relocate landscape: Reset is the same DOM node', landscape.sameReset, true);
    check('relocate landscape: strip stays in .session-tabs-row',
        landscape.stripInTabsRow, true);
    check('relocate landscape: control still not in the session row',
        landscape.controlInTabsRow, false);
    check('relocate landscape: control stayed the root overlay host',
        landscape.controlIsBodyChild, true);
    check('relocate landscape: strip connected', landscape.stripConnected, true);
    check('relocate landscape: control connected', landscape.controlConnected, true);
    check('relocate landscape: still exactly one #sessionTabs',
        landscape.stripCount, 1);
    check('relocate landscape: still exactly one #sessionActionsControl',
        landscape.controlCount, 1);
    check('relocate landscape: still no duplicate lifecycle button ids',
        `${landscape.renameCount}:${landscape.reconnectCount}:${landscape.resetCount}`,
        '1:1:1');

    const landscapeDispatch = await dispatchWorks();
    check('relocate landscape: Reset still dispatches after the move',
        `${landscapeDispatch.target}:${landscapeDispatch.emits}`, 'loc1:0');

    // dispatchWorks() above closed the sheet. Reopen through the real gesture:
    // a closed sheet measures 0x0, which would pass the on-screen check
    // vacuously and report a 0px action height as a layout failure.
    const lsOpen = await openSheet(page, 'loc1');
    check('relocate landscape: the gesture still opens the sheet after the move',
        lsOpen.open, true);

    // The sheet stays a usable target in phone landscape, the tier with the
    // least height. Every action is checked for a 44px height AND for owning
    // its own centre, because a rect alone cannot see an obstruction.
    const landscapeSheet = await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        const r = sheet.getBoundingClientRect();
        const btns = [...sheet.querySelectorAll('[data-lifecycle-action]')];
        const t = btns.map((b) => {
            const q = b.getBoundingClientRect();
            const hit = document.elementFromPoint(
                Math.round(q.left + q.width / 2), Math.round(q.top + q.height / 2));
            return { h: Math.round(q.height), owned: !!(hit && (hit === b || b.contains(hit))) };
        });
        return {
            onScreen: r.left >= 0 && r.top >= 0
                && r.right <= innerWidth && r.bottom <= innerHeight,
            count: btns.length,
            minH: Math.min(...t.map(x => x.h)),
            allOwned: t.every(x => x.owned),
        };
    });
    check('relocate landscape: the sheet is still fully on-screen',
        landscapeSheet.onScreen, true);
    check('relocate landscape: all six actions survive the move',
        landscapeSheet.count, 6);
    check('relocate landscape: actions keep the 44px floor in landscape',
        landscapeSheet.minH >= 44, true);
    check('relocate landscape: every action still owns its own centre',
        landscapeSheet.allOwned, true);

    // ---- Focus preservation: a sheet action owns focus across the move ----
    // The sheet must be OPEN for this to be meaningful: closed it is [inert]
    // and .focus() is a no-op, which would make the assertion vacuous rather
    // than failing. dispatchWorks() above closes it, so reopen via the real
    // section 3 gesture first.
    await openSheet(page, 'loc1');
    await page.evaluate(() => {
        document.getElementById('sessionActionReset').focus();
    });
    const focusBeforeRestore = await page.evaluate(() =>
        document.activeElement ? document.activeElement.id : null);
    check('relocate focus: Reset owns focus before the restore',
        focusBeforeRestore, 'sessionActionReset');

    await page.setViewportSize({ width: 428, height: 926 });
    /*
     * Bounded poll, not a longer sleep. Layout after a viewport change settles
     * on CPU-dependent time: this assertion passed 3/3 standalone but failed
     * once in an 18-suite batch where 17 other browsers competed for cores.
     * Polling for the settled condition removes the timing dependency without
     * changing what is asserted.
     *
     * The poll RETURNS rather than throwing on timeout, so a genuine
     * regression still reaches the original assertion below and reports as a
     * normal FAIL with its measured value -- a waitForFunction that threw
     * would convert a readable assertion failure into a stack trace, and
     * catching it would suppress the failure outright.
     */
    const settled = await page.evaluate(async () => {
        const done = () => {
            const control = document.getElementById('sessionActionsControl');
            // "Settled" means the strip is in its row, the control is still
            // the body child, and focus was never dropped by the rotation.
            const strip = document.getElementById('sessionTabs');
            return !!control
                && control.parentElement === document.body
                && !!strip && !!strip.closest('.session-tabs-row')
                && window.__p2Nodes.reset === document.activeElement;
        };
        const deadline = Date.now() + 2000;
        while (!done() && Date.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return done();
    });
    check('relocate focus: the restore settles without a timing race', settled, true);

    const focusAfterRestore = await page.evaluate(() => ({
        activeId: document.activeElement ? document.activeElement.id : null,
        sameNode: window.__p2Nodes.reset === document.activeElement,
    }));
    check('relocate focus: the same Reset node still owns focus after restore',
        focusAfterRestore.sameNode, true);

    // ---- Portrait restored ----
    const portraitAfter = await snapshot();
    check('relocate portrait restored: strip is the same DOM node',
        portraitAfter.sameStrip, true);
    check('relocate portrait restored: control is the same DOM node',
        portraitAfter.sameControl, true);
    check('relocate portrait restored: strip still in .session-tabs-row',
        portraitAfter.stripInTabsRow, true);
    check('relocate portrait restored: control still not in the session row',
        portraitAfter.controlInTabsRow, false);
    check('relocate portrait restored: control is still the root overlay host',
        portraitAfter.controlIsBodyChild, true);
    check('relocate portrait restored: still exactly one #sessionTabs',
        portraitAfter.stripCount, 1);
    check('relocate portrait restored: still exactly one #sessionActionsControl',
        portraitAfter.controlCount, 1);
    check('relocate portrait restored: still no duplicate lifecycle button ids',
        `${portraitAfter.renameCount}:${portraitAfter.reconnectCount}:${portraitAfter.resetCount}`,
        '1:1:1');

    const restoredDispatch = await dispatchWorks();
    check('relocate portrait restored: Reset dispatches after the round-trip',
        `${restoredDispatch.target}:${restoredDispatch.emits}`, 'loc1:0');

    // ---- Focus preservation for the other owner: a tab inside the strip ----
    await page.evaluate(() => {
        const tab = document.getElementById('tab-loc1');
        tab.setAttribute('tabindex', '-1');
        tab.focus();
    });
    const tabFocusBefore = await page.evaluate(() =>
        document.activeElement ? document.activeElement.id : null);
    check('relocate focus: the tab owns focus before the landscape move',
        tabFocusBefore, 'tab-loc1');

    await page.setViewportSize({ width: 926, height: 428 });
    /*
     * Same bounded poll as the portrait restore above, for the same reason:
     * the inverse rotation (portrait -> landscape) carries the identical
     * CPU-timing exposure. The settled condition is the landscape layout
     * (the viewport is wide) with the strip in its row and the tab focused.
     * Returns instead of throwing, so a genuine regression still reaches the
     * two original assertions below and reports as a normal FAIL with its
     * measured value.
     */
    const tabSettled = await page.evaluate(async () => {
        const done = () => {
            const strip = document.getElementById('sessionTabs');
            const tab = document.getElementById('tab-loc1');
            return !!strip && !!tab
                && window.innerWidth > window.innerHeight
                && !!strip.closest('.session-tabs-row')
                && document.activeElement === tab;
        };
        const deadline = Date.now() + 2000;
        while (!done() && Date.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return done();
    });
    check('relocate focus: the landscape rotation settles without a timing race',
        tabSettled, true);

    const tabFocusAfter = await page.evaluate(() => ({
        activeId: document.activeElement ? document.activeElement.id : null,
        insideSameStrip: window.__p2Nodes.strip.contains(document.activeElement),
    }));
    check('relocate focus: focus stays on the same tab after the rotation',
        tabFocusAfter.activeId, 'tab-loc1');
    check('relocate focus: that tab is still inside the same strip node',
        tabFocusAfter.insideSameStrip, true);

    check('relocate: no page errors', errors, []);
    await removeFocusSentinels(page);
    await ctx.close();
}

// ============================================================================
// §5 — Target model + the 3x3 lifecycle matrix.
//
// (live L / ordinary-disconnected D / persistent-candidate C)
//   x (Rename / Reconnect / Reset)
//
// Plus the zero-action selection clause and focus spies: selecting ANY chip
// sets the lifecycle target and does nothing else — no emit, no modal, no
// composer focus, no pane eviction. D-Reconnect is the J9 else branch: no
// confirm, the prefilled modal opens, nothing is emitted until an explicit
// submit, and that submit emits exactly one ssh_connect.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);
    await spyEmits(page);

    // L is live/connected. D is an ordinary disconnected session (not a
    // candidate). C is a persistent tmux candidate with a key, so its
    // Reconnect arm resolves through directReconnect.
    await seedSession(page, 'L', {
        host: 'live.example', username: 'liveU', authType: 'key', keyId: 'kL',
        displayName: 'Live One', connected: true,
    });
    await seedSession(page, 'D', {
        host: 'disc.example', username: 'discU', authType: 'key', keyId: 'kD',
        displayName: 'Disc One', connected: false, activate: false,
    });
    await seedSession(page, 'C', {
        host: 'cand.example', username: 'candU', authType: 'key', keyId: 'kC',
        displayName: 'Cand One', connected: false, isPersistentCandidate: true,
        useTmux: true, tmuxSessionName: 'cand_tmux', activate: false,
    });

    // Sentinels go into the REAL production registry, after load.
    const sentMatrix = await installFocusSentinels(page, ['L', 'D', 'C']);
    checkSentinels('§5 sentinels', sentMatrix, ['L', 'D', 'C']);

    // ---- Zero-action selection clause, for all three states ----
    for (const id of ['L', 'D', 'C']) {
        const paneBefore = await page.evaluate(() =>
            JSON.stringify(SessionManager.paneAssignments));
        const sel = await selectChip(page, id);
        const after = await page.evaluate(() => ({
            emits: window.__connectEmits.length,
            inputs: window.__inputEmits.length,
            modalOpen: document.getElementById('connectionModal')
                .classList.contains('show'),
            panes: JSON.stringify(SessionManager.paneAssignments),
        }));
        check(`§5 zero-action ${id}: target set to ${id}`, sel.target, id);
        check(`§5 zero-action ${id}: chip carries .lifecycle-target`,
            sel.targetClassOnChip, true);
        check(`§5 zero-action ${id}: all three controls enabled`,
            sel.buttonsEnabled, true);
        check(`§5 zero-action ${id}: zero ssh_connect from selection`,
            after.emits, 0);
        check(`§5 zero-action ${id}: zero ssh_input from selection`,
            after.inputs, 0);
        check(`§5 zero-action ${id}: selection opens no modal`,
            after.modalOpen, false);
        // Side-effect spies, not just activeElement: real focus events on the
        // composer and both password inputs, plus real terminal-instance focus
        // calls via the production TerminalManager.terminals registry. All must
        // be silent for a pure selection.
        check(`§5 zero-action ${id}: no focus event on composer or password inputs`,
            sel.focusLog.join(','), '');
        check(`§5 zero-action ${id}: activeElement is not the composer`,
            sel.activeId !== 'mobileInput', true);
        check(`§5 zero-action ${id}: activeElement is neither password input`,
            sel.activeId !== 'passwordInput'
                && sel.activeId !== 'jumpHostPasswordInput', true);
        // Zero terminal focus for EVERY state including live: focusActivePane()
        // returns at its isTouchShell() guard on a coarse shell, so activating a
        // pane must not focus a terminal here either.
        check(`§5 zero-action ${id}: no terminal instance focused on touch`,
            sel.terminalFocusCalls, 0);
        check(`§5 zero-action ${id}: registry non-empty (spy non-vacuous)`,
            sel.registrySize > 0, true);
        // Inactive and candidate chips must return before any pane path, so
        // they can never evict or reassign a pane.
        if (id !== 'L') {
            check(`§5 zero-action ${id}: pane assignments untouched`,
                after.panes, paneBefore);
        }
    }

    // ------------------------------------------------------------------------
    // Gap 2 — a persistent candidate arriving in the BACKGROUND, after a
    // deliberate selection, must not steal the lifecycle target or its
    // decoration. This drives the real arrival path, showPersistentSessionTab:
    // it builds the candidate, creates its tab, sets disconnected status and
    // re-renders the reconnect list — and must never touch the target. The
    // creation-time invariant is the point of J1's comment: only explicit chip
    // or pane selection writes the target.
    // ------------------------------------------------------------------------
    for (const selectedId of ['D', 'C']) {
        const sel = await selectChip(page, selectedId);
        check(`§5 background-arrival: ${selectedId} is the deliberate selection`,
            sel.target, selectedId);

        const before = await snapshotSessions(page);
        const emitsBefore = await page.evaluate(() => window.__connectEmits.length);

        // Two candidates arrive asynchronously while the user is looking at
        // their selected chip. Both go through the production entry point.
        const arrival = await page.evaluate((selectedId) => {
            const arrivedIds = [];
            const spyFocus = [];
            ['mobileInput', 'passwordInput', 'jumpHostPasswordInput'].forEach(sid => {
                const el = document.getElementById(sid);
                if (el) el.addEventListener('focus', () => spyFocus.push(sid), { once: true });
            });
            for (const n of [1, 2]) {
                const id = `bg-cand-${selectedId}-${n}`;
                SessionManager.showPersistentSessionTab({
                    session_id: id,
                    host: `bg${n}.example`,
                    port: 22,
                    username: `bgU${n}`,
                    key_id: `bgK${n}`,
                    auth_type: 'key',
                    tmux_session_name: `bg_tmux_${n}`,
                    display_name: `Background ${n}`,
                });
                arrivedIds.push(id);
            }
            return {
                arrivedIds,
                arrivedExist: arrivedIds.every(id => !!SessionManager.sessions[id]),
                arrivedTabsExist: arrivedIds.every(id =>
                    !!document.getElementById(`tab-${id}`)),
                arrivedAreCandidates: arrivedIds.every(id =>
                    SessionManager.sessions[id].isPersistentCandidate === true),
                target: SessionManager.lifecycleActionTargetId,
                decorated: [...document.querySelectorAll('.session-tab.lifecycle-target')]
                    .map(t => t.id).join(','),
                decoratedCount: document.querySelectorAll('.session-tab.lifecycle-target').length,
                arrivedDecorated: arrivedIds.some(id =>
                    !!document.querySelector(`#tab-${id}.lifecycle-target`)),
                arrivedInPane: arrivedIds.some(id =>
                    SessionManager.paneAssignments.includes(id)),
                buttonsStillEnabled: ['sessionActionRename', 'sessionActionReconnect',
                    'sessionActionReset'].every(bid =>
                        !document.getElementById(bid).disabled),
                focusEvents: spyFocus.join(','),
            };
        }, selectedId);

        // The arrivals really happened — otherwise the invariant is vacuous.
        check(`§5 background-arrival (${selectedId}): both candidates were created`,
            arrival.arrivedExist, true);
        check(`§5 background-arrival (${selectedId}): both candidate tabs exist`,
            arrival.arrivedTabsExist, true);
        check(`§5 background-arrival (${selectedId}): both arrived as candidates`,
            arrival.arrivedAreCandidates, true);

        // The invariant: the target and its decoration did not move.
        check(`§5 background-arrival (${selectedId}): target still ${selectedId}`,
            arrival.target, selectedId);
        check(`§5 background-arrival (${selectedId}): decoration still on tab-${selectedId}`,
            arrival.decorated, `tab-${selectedId}`);
        check(`§5 background-arrival (${selectedId}): exactly one decorated chip`,
            arrival.decoratedCount, 1);
        check(`§5 background-arrival (${selectedId}): no arriving candidate is decorated`,
            arrival.arrivedDecorated, false);
        check(`§5 background-arrival (${selectedId}): controls remain enabled`,
            arrival.buttonsStillEnabled, true);

        // A candidate is an offer, not a session: it must not take a pane, and
        // it must not focus anything.
        check(`§5 background-arrival (${selectedId}): no arriving candidate took a pane`,
            arrival.arrivedInPane, false);
        check(`§5 background-arrival (${selectedId}): arrival focuses nothing`,
            arrival.focusEvents, '');
        check(`§5 background-arrival (${selectedId}): arrival emits nothing`,
            await page.evaluate(() => window.__connectEmits.length), emitsBefore);

        // Pre-existing sessions are untouched, and each keeps its pane index.
        // The two arrivals are new ids, so they are excluded from the
        // byte-identical comparison by construction (checked above instead).
        const after = await snapshotSessions(page);
        for (const id of Object.keys(before.sessions)) {
            check(`§5 background-arrival (${selectedId}): pre-existing ${id} untouched`,
                after.sessions[id], before.sessions[id]);
            check(`§5 background-arrival (${selectedId}): ${id} keeps pane index`,
                after.paneIndexById[id], before.paneIndexById[id]);
        }

        // Clean up the arrivals so later matrix cells see a known session set.
        await page.evaluate((ids) => {
            ids.forEach(id => SessionManager.removeSessionUI(id));
        }, arrival.arrivedIds);
    }

    // Re-establish a known target after the arrival probes.
    await selectChip(page, 'C');

    // Exactly one chip carries the target decoration at a time.
    const singleTarget = await page.evaluate(() =>
        document.querySelectorAll('.session-tab.lifecycle-target').length);
    check('§5 target model: exactly one chip is the lifecycle target',
        singleTarget, 1);

    // The active terminal chip and the lifecycle target are separate concepts:
    // selecting C (a candidate) leaves activeSessionId on the live pane.
    const separation = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        active: SessionManager.activeSessionId,
    }));
    check('§5 target model: target is the selected candidate',
        separation.target, 'C');
    check('§5 target model: activeSessionId did not follow the candidate',
        separation.active !== 'C', true);

    // ------------------------------------------------------------------------
    // Gap 4 — active-live L and disconnected target D must be visually
    // distinguishable, and a live chip that is BOTH must carry both classes.
    //
    // The two states are expressed through disjoint CSS properties, so the
    // proof is a computed-style comparison rather than a class-name assertion:
    //   .session-tab.active          -> background / border-bottom / color
    //   .session-tab.lifecycle-target -> outline (capability-scoped to touch)
    // Non-vacuity: the test first asserts the two chips really are in the two
    // different states, then asserts the computed values actually DIFFER on the
    // properties each state owns. A stylesheet that dropped either rule, or
    // collapsed both to the same treatment, fails here.
    // ------------------------------------------------------------------------

    // Put L in a pane so it is the active chip, then deliberately target D
    // (unassigned, disconnected) so the two roles sit on two different chips.
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1);
        SessionManager.assignSessionToPane('L', 0);
        // Real status classes, the way ssh_connected / disconnect would set them.
        SessionManager.updateSessionStatus('L', 'connected');
        SessionManager.updateSessionStatus('D', 'disconnected');
    });
    const selD = await selectChip(page, 'D');
    check('§5 visual: D is the lifecycle target', selD.target, 'D');

    const roles = await page.evaluate(() => {
        const l = document.getElementById('tab-L');
        const d = document.getElementById('tab-D');
        return {
            lActive: l.classList.contains('active'),
            lTarget: l.classList.contains('lifecycle-target'),
            dActive: d.classList.contains('active'),
            dTarget: d.classList.contains('lifecycle-target'),
            activeSessionId: SessionManager.activeSessionId,
            target: SessionManager.lifecycleActionTargetId,
        };
    });
    // Non-vacuity: the two roles really are on two different chips.
    check('§5 visual: L is the active chip', roles.lActive, true);
    check('§5 visual: L is NOT the lifecycle target', roles.lTarget, false);
    check('§5 visual: D is the lifecycle target chip', roles.dTarget, true);
    check('§5 visual: D is NOT the active chip', roles.dActive, false);
    check('§5 visual: the two roles are on different sessions',
        roles.activeSessionId !== roles.target, true);

    const treatment = await page.evaluate(() => {
        const cs = id => {
            const el = document.getElementById(id);
            const s = getComputedStyle(el);
            /* The ring moved from the full-height native tap target onto the
               30px ::before pill (amendment line 55 forbids chip paint touching
               either row edge; Entry 21). Read BOTH owners and prefer
               the pill when it paints, so this measures the ring wherever it
               legitimately lives rather than pinning one implementation. */
            const pseudo = getComputedStyle(el, '::before');
            const pillPaints = pseudo.content && pseudo.content !== 'none';
            const ring = (pillPaints && pseudo.outlineStyle !== 'none')
                ? pseudo : s;
            return {
                ringStyle: ring.outlineStyle,
                ringWidth: ring.outlineWidth,
                ringOwner: (pillPaints && pseudo.outlineStyle !== 'none')
                    ? 'pill' : 'element',
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                outlineColor: s.outlineColor,
                borderBottomWidth: s.borderBottomWidth,
                borderBottomStyle: s.borderBottomStyle,
                background: s.backgroundColor,
                color: s.color,
            };
        };
        // A third chip in neither role is the baseline: it proves each state's
        // treatment is an actual deviation rather than the default look.
        SessionManager.createSessionTab('BASE', 'base.example', 'baseU');
        SessionManager.sessions['BASE'] = {
            id: 'BASE', session_id: 'BASE', host: 'base.example', port: 22,
            username: 'baseU', authType: 'key', keyId: 'kBASE',
            connected: false, isPersistentCandidate: false,
            terminalId: 'term-BASE', useTmux: false, displayName: 'Base',
        };
        const out = { L: cs('tab-L'), D: cs('tab-D'), BASE: cs('tab-BASE') };
        delete SessionManager.sessions['BASE'];
        document.getElementById('tab-BASE').remove();
        return out;
    });

    // The lifecycle target owns the outline; the active chip must not paint one.
    check('§5 visual: the target chip paints a real outline',
        treatment.D.ringStyle === 'solid'
            && parseFloat(treatment.D.ringWidth) >= 2, true);
    check('§5 visual: the active chip paints no outline',
        treatment.L.outlineStyle === 'none'
            || parseFloat(treatment.L.outlineWidth) === 0, true);
    check('§5 visual: a chip in neither role paints no outline',
        treatment.BASE.outlineStyle === 'none'
            || parseFloat(treatment.BASE.outlineWidth) === 0, true);
    check('§5 visual: target outline differs from the baseline chip',
        treatment.D.ringStyle !== treatment.BASE.ringStyle
            || treatment.D.ringWidth !== treatment.BASE.ringWidth, true);

    // The active chip owns the border-bottom/background/colour treatment, and
    // that treatment is NOT what the target decoration does.
    check('§5 visual: the active chip deviates from the baseline chip',
        treatment.L.borderBottomWidth !== treatment.BASE.borderBottomWidth
            || treatment.L.background !== treatment.BASE.background
            || treatment.L.color !== treatment.BASE.color, true);
    check('§5 visual: the target chip does not borrow the active border',
        treatment.D.borderBottomWidth, treatment.BASE.borderBottomWidth);

    // The headline claim: the two states are not the same paint.
    check('§5 visual: active and target treatments are distinguishable',
        JSON.stringify(treatment.L) !== JSON.stringify(treatment.D), true);

    // ---- Same chip in BOTH roles: selecting the live, active chip ----
    const selL = await selectChip(page, 'L');
    check('§5 visual: selecting the live chip makes it the target',
        selL.target, 'L');
    const both = await page.evaluate(() => {
        const l = document.getElementById('tab-L');
        const s = getComputedStyle(l);
        /* Same ring ownership as the cs() helper above: the target ring lives on
           the 30px ::before pill on touch (Entry 21), so read whichever
           owner actually paints it instead of pinning the element. */
        const pseudo = getComputedStyle(l, '::before');
        const pillPaints = pseudo.content && pseudo.content !== 'none';
        const ring = (pillPaints && pseudo.outlineStyle !== 'none') ? pseudo : s;
        return {
            hasActive: l.classList.contains('active'),
            hasTarget: l.classList.contains('lifecycle-target'),
            activeSessionId: SessionManager.activeSessionId,
            target: SessionManager.lifecycleActionTargetId,
            ringStyle: ring.outlineStyle,
            ringWidth: ring.outlineWidth,
            outlineStyle: s.outlineStyle,
            outlineWidth: s.outlineWidth,
            borderBottomWidth: s.borderBottomWidth,
            background: s.backgroundColor,
            decoratedCount: document.querySelectorAll('.session-tab.lifecycle-target').length,
            dLostTarget: !document.querySelector('#tab-D.lifecycle-target'),
        };
    });
    check('§5 visual (same chip): carries .active', both.hasActive, true);
    check('§5 visual (same chip): carries .lifecycle-target', both.hasTarget, true);
    check('§5 visual (same chip): both ids point at L',
        `${both.activeSessionId}:${both.target}`, 'L:L');
    // Both treatments coexist: the outline (target) AND the active border.
    check('§5 visual (same chip): still paints the target outline',
        both.ringStyle === 'solid' && parseFloat(both.ringWidth) >= 2, true);
    check('§5 visual (same chip): still paints the active border treatment',
        both.borderBottomWidth, treatment.L.borderBottomWidth);
    check('§5 visual (same chip): keeps the active background',
        both.background, treatment.L.background);
    // The target moved rather than duplicating.
    check('§5 visual (same chip): exactly one decorated chip',
        both.decoratedCount, 1);
    check('§5 visual (same chip): D no longer carries the decoration',
        both.dLostTarget, true);

    // Restore D as the target so the matrix cells below start where they did.
    await selectChip(page, 'D');

    // With no valid target the three controls are disabled — the only gate.
    const cleared = await page.evaluate(() => {
        SessionManager.setLifecycleActionTarget(null);
        return {
            target: SessionManager.lifecycleActionTargetId,
            disabled: ['sessionActionRename', 'sessionActionReconnect',
                'sessionActionReset'].every(id =>
                    document.getElementById(id).disabled),
            decorated: document.querySelectorAll('.session-tab.lifecycle-target').length,
        };
    });
    check('§5 target model: clearing the target nulls it', cleared.target, null);
    check('§5 target model: no target disables all three controls',
        cleared.disabled, true);
    check('§5 target model: no target leaves no decorated chip',
        cleared.decorated, 0);

    // An unknown id is not a valid target either.
    const invalid = await page.evaluate(() => {
        SessionManager.setLifecycleActionTarget('does-not-exist');
        return {
            target: SessionManager.lifecycleActionTargetId,
            disabled: document.getElementById('sessionActionReset').disabled,
        };
    });
    check('§5 target model: an unknown id resolves to null', invalid.target, null);
    check('§5 target model: an unknown id keeps controls disabled',
        invalid.disabled, true);

    // ---- L row ----
    // L-Rename
    const selLRename = await selectChip(page, 'L');
    checkSelectionClean('§5 L-Rename selection', selLRename, 'L');
    const beforeLRename = await snapshotSessions(page);
    const emitsBeforeLRename = await page.evaluate(() => window.__connectEmits.length);
    await armSpies(page);
    await invokeAction(page, 'L', 'rename');
    await page.waitForTimeout(60);
    const lRenameSpies = await readSpies(page);
    const lRename = await page.evaluate(() => ({
        input: !!document.querySelector('#tab-L .tab-rename-input'),
        emits: window.__connectEmits.length,
        inputs: window.__inputEmits.length,
    }));
    check('§5 L-Rename: the rename input opens on the L chip', lRename.input, true);
    check('§5 L-Rename: rename emits no ssh_connect',
        lRename.emits, emitsBeforeLRename);
    check('§5 L-Rename: rename emits no ssh_input', lRename.inputs, 0);
    checkCellSpies('§5 L-Rename', lRenameSpies);
    checkOnlyTargetChanged('§5 L-Rename', beforeLRename,
        await snapshotSessions(page), 'L', 'strict');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);

    // L-Reconnect declines: the live arm confirms first, so cancel emits zero.
    const selLRecCancel = await selectChip(page, 'L');
    checkSelectionClean('§5 L-Reconnect declined selection', selLRecCancel, 'L');
    const beforeLRecCancel = await snapshotSessions(page);
    await armSpies(page);
    await invokeAction(page, 'L', 'reconnect');
    // Was `window.__confirmCalls === 1`. The live arm now raises the in-app
    // dialog, so presence of that dialog IS the "asks for confirmation" proof,
    // and answering it with a real click is what a user does.
    const lRecCancelAsked = await confirmVisible(page);
    const lRecCancelAnswered = await answerConfirm(page, false);
    await page.waitForTimeout(120);
    const lRecCancelSpies = await readSpies(page);
    const lReconnectCancel = await page.evaluate(() => ({
        emits: window.__connectEmits.length,
        stillThere: !!SessionManager.sessions['L'],
    }));
    check('§5 L-Reconnect: the live arm asks for confirmation',
        lRecCancelAsked, true);
    check('§5 L-Reconnect: the dialog was answered by a real click',
        lRecCancelAnswered, true);
    check('§5 L-Reconnect: declining emits nothing', lReconnectCancel.emits, 0);
    check('§5 L-Reconnect: declining leaves the session intact',
        lReconnectCancel.stillThere, true);
    checkCellSpies('§5 L-Reconnect declined', lRecCancelSpies);
    // A declined action changes nothing at all, so panes are strict here.
    checkOnlyTargetChanged('§5 L-Reconnect declined', beforeLRecCancel,
        await snapshotSessions(page), 'L', 'strict');

    /*
     * L-Reconnect accepts — RE-TARGETED to the W2 prepare-and-swap contract.
     *
     * This cell previously asserted the destroy-then-recreate lifecycle: one
     * ssh_connect with a fresh reconnect_* request id, emitted 500 ms after the
     * client had already closed the session. That sequence WAS the defect. It
     * minted a new session_id, so the xterm, its scrollback, its pane and the
     * chip identity were all discarded, the tmux session was killed before the
     * reattach, and a failed connect left the user with nothing.
     *
     * The live arm now asks the server to swap the transport underneath the
     * SAME logical session (ssh_reconnect -> handle_ssh_reconnect). So the
     * assertions here are strictly stronger, not relaxed: exactly one
     * ssh_reconnect naming this session, ZERO ssh_connect, and the session plus
     * its chip and pane still present afterwards.
     */
    const selLRecAccept = await selectChip(page, 'L');
    checkSelectionClean('§5 L-Reconnect accepted selection', selLRecAccept, 'L');
    const beforeLRecAccept = await snapshotSessions(page);
    const connectsBeforeLRec = await page.evaluate(() => window.__connectEmits.length);
    await armSpies(page);
    await invokeAction(page, 'L', 'reconnect');
    check('§5 L-Reconnect: accepting goes through the confirm dialog',
        await answerConfirm(page, true), true);
    await page.waitForTimeout(900);
    const lRecAcceptSpies = await readSpies(page);
    const lReconnect = await page.evaluate(() => ({
        reconnects: window.__reconnectEmits,
        connects: window.__connectEmits.length,
        stillThere: !!SessionManager.sessions['L'],
        stillConnected: !!(SessionManager.sessions['L']
            && SessionManager.sessions['L'].connected),
        chipThere: !!document.getElementById('tab-L'),
        paneIndex: SessionManager.paneAssignments.findIndex(a => a === 'L'),
    }));
    check('§5 L-Reconnect: accepting emits exactly one ssh_reconnect',
        lReconnect.reconnects.length, 1);
    check('§5 L-Reconnect: the swap names the L session',
        lReconnect.reconnects[0]?.session_id, 'L');
    check('§5 L-Reconnect: a swap emits NO ssh_connect',
        lReconnect.connects, connectsBeforeLRec);
    check('§5 L-Reconnect: no password on the payload',
        Object.prototype.hasOwnProperty.call(lReconnect.reconnects[0] || {}, 'password'),
        false);
    // The whole point of prepare-and-swap: the session the user asked to
    // reconnect is still there while the server works, so a failure costs
    // nothing and success keeps the same terminal.
    check('§5 L-Reconnect: the session survives the request',
        lReconnect.stillThere, true);
    check('§5 L-Reconnect: it is still marked connected',
        lReconnect.stillConnected, true);
    check('§5 L-Reconnect: its chip is not destroyed', lReconnect.chipThere, true);
    check('§5 L-Reconnect: it keeps its pane',
        lReconnect.paneIndex, beforeLRecAccept.paneIndexById['L']);
    checkCellSpies('§5 L-Reconnect accepted', lRecAcceptSpies);
    checkOnlyTargetChanged('§5 L-Reconnect accepted', beforeLRecAccept,
        await snapshotSessions(page), 'L');

    // L-Reset: a separate live session (Reset is the destructive route and DOES
    // replace the session) — one more ssh_connect, reset_* id, tmux off.
    await seedSession(page, 'L2', {
        host: 'live2.example', username: 'liveU2', authType: 'key', keyId: 'kL2',
        displayName: 'Live Two', connected: true,
    });
    const sentL2 = await installFocusSentinels(page, ['L2']);
    checkSentinels('§5 L-Reset sentinels', sentL2, ['L2']);
    const selLReset = await selectChip(page, 'L2');
    checkSelectionClean('§5 L-Reset selection', selLReset, 'L2');
    const beforeLReset = await snapshotSessions(page);
    const connectsBeforeLReset = await page.evaluate(() => window.__connectEmits.length);
    await armSpies(page);
    await invokeAction(page, 'L2', 'reset');
    check('§5 L-Reset: the confirm dialog gates a live Reset',
        await answerConfirm(page, true), true);
    await page.waitForTimeout(150);
    const lResetSpies = await readSpies(page);
    // Indexed from the count taken before this cell rather than hard-coded:
    // the L-Reconnect cell above no longer contributes an ssh_connect (it is a
    // transport swap now), so a fixed index would silently read the wrong emit.
    const lReset = await page.evaluate((base) => ({
        all: window.__connectEmits,
        mine: window.__connectEmits.slice(base),
    }), connectsBeforeLReset);
    check('§5 L-Reset: Reset adds exactly one more ssh_connect',
        lReset.mine.length, 1);
    check('§5 L-Reset: client_request_id starts reset_',
        (lReset.mine[0]?.client_request_id || '').startsWith('reset_'), true);
    check('§5 L-Reset: use_tmux false', lReset.mine[0]?.use_tmux, false);
    check('§5 L-Reset: reconnect_tmux_name null',
        lReset.mine[0]?.reconnect_tmux_name, null);
    checkCellSpies('§5 L-Reset', lResetSpies);
    checkOnlyTargetChanged('§5 L-Reset', beforeLReset,
        await snapshotSessions(page), 'L2');

    // ---- D row (ordinary disconnected) ----
    // D-Rename
    const selDRename = await selectChip(page, 'D');
    checkSelectionClean('§5 D-Rename selection', selDRename, 'D');
    const beforeDRename = await snapshotSessions(page);
    const emitsBeforeDRename = await page.evaluate(() => window.__connectEmits.length);
    await armSpies(page);
    await invokeAction(page, 'D', 'rename');
    await page.waitForTimeout(60);
    const dRenameSpies = await readSpies(page);
    const dRename = await page.evaluate(() => ({
        input: !!document.querySelector('#tab-D .tab-rename-input'),
        emits: window.__connectEmits.length,
        inputs: window.__inputEmits.length,
    }));
    check('§5 D-Rename: the rename input opens on the disconnected chip',
        dRename.input, true);
    check('§5 D-Rename: rename emits no ssh_connect',
        dRename.emits, emitsBeforeDRename);
    check('§5 D-Rename: rename emits no ssh_input', dRename.inputs, 0);
    checkCellSpies('§5 D-Rename', dRenameSpies);
    checkOnlyTargetChanged('§5 D-Rename', beforeDRename,
        await snapshotSessions(page), 'D', 'strict');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);

    // D-Reconnect (J9): no confirm, modal opens prefilled, nothing emitted.
    const selDRec = await selectChip(page, 'D');
    checkSelectionClean('§5 D-Reconnect selection', selDRec, 'D');
    const beforeDRec = await snapshotSessions(page);
    const emitsBeforeD = await page.evaluate(() => window.__connectEmits.length);
    // Spies stay armed across BOTH the button click and the explicit submit, so
    // a focus that only happens at submit time cannot slip through.
    await armSpies(page);
    await invokeAction(page, 'D', 'reconnect');
    await page.waitForTimeout(250);
    // Was `__confirmCalls === 0`. The equivalent, and stricter, statement is
    // that the in-app dialog never appears for an already-disconnected session.
    const dRecConfirmShown = await confirmVisible(page);
    const dReconnectModal = await page.evaluate(() => ({
        modalOpen: document.getElementById('connectionModal')
            .classList.contains('show'),
        emits: window.__connectEmits.length,
        host: document.getElementById('hostInput').value,
        username: document.getElementById('usernameInput').value,
        authType: document.getElementById('authTypeSelect').value,
        activeId: document.activeElement ? document.activeElement.id : null,
        stillThere: !!SessionManager.sessions['D'],
    }));
    check('§5 D-Reconnect: NO confirmation dialog for an already-disconnected session',
        dRecConfirmShown, false);
    check('§5 D-Reconnect: the prefilled modal opens',
        dReconnectModal.modalOpen, true);
    check('§5 D-Reconnect: zero emit before an explicit submit',
        dReconnectModal.emits, emitsBeforeD);
    check('§5 D-Reconnect: host prefilled from the D session',
        dReconnectModal.host, 'disc.example');
    check('§5 D-Reconnect: username prefilled from the D session',
        dReconnectModal.username, 'discU');
    check('§5 D-Reconnect: auth type prefilled from the D session',
        dReconnectModal.authType, 'key');
    // Provenance guard: connectionModal is shared across cells, so prove these
    // values came from D's own prefill and are not residue from an earlier cell
    // (L-Reset prefilled live2.example on this same page).
    check('§5 D-Reconnect: modal does not hold a stale host from an earlier cell',
        dReconnectModal.host !== 'live2.example'
            && dReconnectModal.host !== 'live.example', true);
    check('§5 D-Reconnect: modal does not hold a stale username',
        dReconnectModal.username !== 'liveU2', true);
    check('§5 D-Reconnect: no autofocus on the composer',
        dReconnectModal.activeId !== 'mobileInput', true);
    check('§5 D-Reconnect: no autofocus on the password input',
        dReconnectModal.activeId !== 'passwordInput', true);
    check('§5 D-Reconnect: the session is not closed by opening the form',
        dReconnectModal.stillThere, true);

    // Explicit submit emits exactly one ssh_connect for D. The submit gate
    // (app.js:2459+) rejects key auth with no #keySelect value via
    // showNotification('SSH key is required') + return, leaving the modal OPEN —
    // so without seeding the key this would assert a validation refusal rather
    // than the J9 submit path, and the open .modal-body would then intercept the
    // next cell's toolbar click.
    await page.evaluate(() => {
        const ks = document.getElementById('keySelect');
        if (ks && !ks.value) {
            const opt = document.createElement('option');
            opt.value = 'kD'; opt.textContent = 'kD';
            ks.appendChild(opt); ks.value = 'kD';
        }
    });
    await page.click('#connectBtn');
    await page.waitForTimeout(250);
    const dRecSpies = await readSpies(page);
    const dReconnectSubmitEmits = await page.evaluate(() => window.__connectEmits);
    check('§5 D-Reconnect: explicit submit emits exactly one more ssh_connect',
        dReconnectSubmitEmits.length, emitsBeforeD + 1);
    check('§5 D-Reconnect: the submitted payload targets the D host',
        dReconnectSubmitEmits[dReconnectSubmitEmits.length - 1]?.host, 'disc.example');
    check('§5 D-Reconnect: no password property on the submitted payload',
        Object.prototype.hasOwnProperty.call(
            dReconnectSubmitEmits[dReconnectSubmitEmits.length - 1] || {}, 'password'), false);
    checkCellSpies('§5 D-Reconnect', dRecSpies);
    checkOnlyTargetChanged('§5 D-Reconnect', beforeDRec,
        await snapshotSessions(page), 'D');

    // Leave no open modal behind: an open .modal-body intercepts pointer events
    // and the next cell's toolbar click would time out.
    await page.evaluate(() => {
        const m = document.getElementById('connectionModal');
        if (m && m.classList.contains('show')) m.classList.remove('show');
    });
    check('§5 D-Reconnect: no modal left open for the next cell',
        await page.evaluate(() =>
            document.getElementById('connectionModal').classList.contains('show')),
        false);

    // D-Reset: a disconnected key session resets through the direct path.
    await seedSession(page, 'D2', {
        host: 'disc2.example', username: 'discU2', authType: 'key', keyId: 'kD2',
        displayName: 'Disc Two', connected: false, activate: false,
    });
    const sentD2 = await installFocusSentinels(page, ['D2']);
    checkSentinels('§5 D-Reset sentinels', sentD2, ['D2']);
    const emitsBeforeDReset = await page.evaluate(() => window.__connectEmits.length);
    const selDReset = await selectChip(page, 'D2');
    checkSelectionClean('§5 D-Reset selection', selDReset, 'D2');
    const beforeDReset = await snapshotSessions(page);
    await armSpies(page);
    await invokeAction(page, 'D2', 'reset');
    check('§5 D-Reset: the confirm dialog gates a disconnected Reset',
        await answerConfirm(page, true), true);
    await page.waitForTimeout(150);
    const dResetSpies = await readSpies(page);
    const dReset = await page.evaluate(() => window.__connectEmits);
    check('§5 D-Reset: a disconnected target still resets (one more emit)',
        dReset.length, emitsBeforeDReset + 1);
    check('§5 D-Reset: client_request_id starts reset_',
        (dReset[dReset.length - 1]?.client_request_id || '').startsWith('reset_'), true);
    check('§5 D-Reset: use_tmux false',
        dReset[dReset.length - 1]?.use_tmux, false);
    checkCellSpies('§5 D-Reset', dResetSpies);
    checkOnlyTargetChanged('§5 D-Reset', beforeDReset,
        await snapshotSessions(page), 'D2');

    // ---- C row (persistent candidate) ----
    // C-Rename
    const selCRename = await selectChip(page, 'C');
    checkSelectionClean('§5 C-Rename selection', selCRename, 'C');
    const beforeCRename = await snapshotSessions(page);
    const emitsBeforeCRename = await page.evaluate(() => window.__connectEmits.length);
    await armSpies(page);
    await invokeAction(page, 'C', 'rename');
    await page.waitForTimeout(60);
    const cRenameSpies = await readSpies(page);
    const cRename = await page.evaluate(() => ({
        input: !!document.querySelector('#tab-C .tab-rename-input'),
        emits: window.__connectEmits.length,
        inputs: window.__inputEmits.length,
    }));
    check('§5 C-Rename: the rename input opens on the candidate chip',
        cRename.input, true);
    check('§5 C-Rename: rename emits no ssh_connect',
        cRename.emits, emitsBeforeCRename);
    check('§5 C-Rename: rename emits no ssh_input', cRename.inputs, 0);
    checkCellSpies('§5 C-Rename', cRenameSpies);
    checkOnlyTargetChanged('§5 C-Rename', beforeCRename,
        await snapshotSessions(page), 'C', 'strict');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);

    // C-Reconnect: a key-backed tmux candidate reconnects directly — exactly
    // one ssh_connect carrying use_tmux:true and the recorded tmux name.
    const emitsBeforeC = await page.evaluate(() => window.__connectEmits.length);
    const selCRec = await selectChip(page, 'C');
    checkSelectionClean('§5 C-Reconnect selection', selCRec, 'C');
    const beforeCRec = await snapshotSessions(page);
    await armSpies(page);
    await invokeAction(page, 'C', 'reconnect');
    await page.waitForTimeout(200);
    const cRecSpies = await readSpies(page);
    const cReconnect = await page.evaluate(() => window.__connectEmits);
    check('§5 C-Reconnect: the candidate reconnects with exactly one emit',
        cReconnect.length, emitsBeforeC + 1);
    check('§5 C-Reconnect: client_request_id starts reconnect_',
        (cReconnect[cReconnect.length - 1]?.client_request_id || '')
            .startsWith('reconnect_'), true);
    check('§5 C-Reconnect: use_tmux true for a persistent candidate',
        cReconnect[cReconnect.length - 1]?.use_tmux, true);
    check('§5 C-Reconnect: it reattaches the recorded tmux name',
        cReconnect[cReconnect.length - 1]?.reconnect_tmux_name, 'cand_tmux');
    checkCellSpies('§5 C-Reconnect', cRecSpies);
    checkOnlyTargetChanged('§5 C-Reconnect', beforeCRec,
        await snapshotSessions(page), 'C');

    // C-Reset: a fresh candidate resets with tmux explicitly off — that is the
    // whole point of Reset versus Reconnect for a persistent session.
    //
    // W13: and it must be ATOMIC. A candidate's persisted row is the only record
    // that the tmux still running on the host belongs to this user, so the old
    // shape -- ssh_disconnect first, then the fresh ssh_connect -- destroyed
    // that record before the replacement existed: a failed or cancelled connect
    // left the user with no way back to a session that was still running. So the
    // pre-success wire must carry the fresh connect and NOTHING else, and the
    // chip, label, tmux identity and DB offer must all still be there
    // afterwards. The retirement is proven below, on the matching reply only.
    await seedSession(page, 'C2', {
        host: 'cand2.example', username: 'candU2', authType: 'key', keyId: 'kC2',
        displayName: 'Cand Two', connected: false, isPersistentCandidate: true,
        useTmux: true, tmuxSessionName: 'cand2_tmux', activate: false,
    });
    const sentC2 = await installFocusSentinels(page, ['C2']);
    checkSentinels('§5 C-Reset sentinels', sentC2, ['C2']);
    const emitsBeforeCReset = await page.evaluate(() => window.__connectEmits.length);
    const discBeforeCReset = await page.evaluate(() =>
        window.__allDisconnectEmits.length);
    const selCReset = await selectChip(page, 'C2');
    checkSelectionClean('§5 C-Reset selection', selCReset, 'C2');
    const beforeCReset = await snapshotSessions(page);
    await armSpies(page);
    await invokeAction(page, 'C2', 'reset');
    check('§5 C-Reset: the confirm dialog gates a candidate Reset',
        await answerConfirm(page, true), true);
    // W13-B7: arming the confirmation arms the per-candidate double-trigger
    // guard; while it holds, a second trigger must be a no-op.
    check('§5 C-Reset B7: the guard is armed with the confirmation',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.C2),
        true);
    const emitsAtArm = await page.evaluate(() => window.__connectEmits.length);
    const refused = await page.evaluate(() => {
        SessionManager.requestResetSession('C2');
        return window.__connectEmits.length;
    });
    check('§5 C-Reset B7: a second trigger while in flight emits nothing',
        refused, emitsAtArm);
    await page.waitForTimeout(150);
    const cResetSpies = await readSpies(page);
    const cReset = await page.evaluate(() => window.__connectEmits);
    check('§5 C-Reset: the candidate resets with exactly one more emit',
        cReset.length, emitsBeforeCReset + 1);
    check('§5 C-Reset: client_request_id starts reset_',
        (cReset[cReset.length - 1]?.client_request_id || '').startsWith('reset_'), true);
    check('§5 C-Reset: use_tmux false (fresh, no reattach)',
        cReset[cReset.length - 1]?.use_tmux, false);
    check('§5 C-Reset: reconnect_tmux_name null (no reattach)',
        cReset[cReset.length - 1]?.reconnect_tmux_name, null);
    check('§5 C-Reset: no password on the wire',
        Object.prototype.hasOwnProperty.call(cReset[cReset.length - 1] || {},
            'password'), false);
    // The atomicity claim, on the wire and in the store.
    const cResetPre = await page.evaluate(() => ({
        disconnects: window.__allDisconnectEmits.length,
        stillThere: !!SessionManager.sessions.C2,
        chipThere: !!document.getElementById('tab-C2'),
        stillCandidate: SessionManager.sessions.C2?.isPersistentCandidate === true,
        label: SessionManager.sessions.C2?.displayName || null,
        tmux: SessionManager.sessions.C2?.tmuxSessionName || null,
        intents: Object.keys(SessionManager.resetIntents || {}).length,
    }));
    check('§5 C-Reset: NO ssh_disconnect before the replacement exists',
        cResetPre.disconnects, discBeforeCReset);
    check('§5 C-Reset: the candidate and its chip survive the submit',
        [cResetPre.stillThere, cResetPre.chipThere], [true, true]);
    check('§5 C-Reset: it is still a candidate (the offer is intact)',
        cResetPre.stillCandidate, true);
    check('§5 C-Reset: its label survives', cResetPre.label, 'Cand Two');
    check('§5 C-Reset: its tmux identity survives', cResetPre.tmux, 'cand2_tmux');
    check('§5 C-Reset: exactly one retirement intent is armed',
        cResetPre.intents, 1);
    checkCellSpies('§5 C-Reset', cResetSpies);
    checkOnlyTargetChanged('§5 C-Reset', beforeCReset,
        await snapshotSessions(page), 'C2');

    // ---- C-Reset, post-success: the retirement, and only then ----
    // Driven through the REAL handler registry: this is the product's own
    // ssh_connected path, not a direct call to completePendingReset.
    // W13-B6: completePendingReset now emits candidate_reset (correlated) and
    // the chip is removed only on the matching candidate_reset_ack.
    const cResetDone = await page.evaluate((rid) => {
        const before = window.__allDisconnectEmits.length;
        SessionManager.createSession({
            session_id: 'C2_NEW', host: 'cand2.example', port: 22,
            username: 'candU2', auth_type: 'key', key_id: 'kC2',
            use_tmux: false, tmux_session_name: null,
        }, null);
        const requested = SessionManager.completePendingReset('C2_NEW', rid);
        const disconnectsSent = window.__allDisconnectEmits.slice(before);
        return {
            requested,
            // B6: the chip is NOT removed yet -- it waits for the ack.
            oldStillThere: !!SessionManager.sessions.C2,
            oldChipStillThere: !!document.getElementById('tab-C2'),
            newExists: !!SessionManager.sessions.C2_NEW,
            newHasTmux: SessionManager.sessions.C2_NEW?.tmuxSessionName || null,
            disconnects: disconnectsSent.map(p => p.session_id),
            intents: Object.keys(SessionManager.resetIntents || {}).length,
            retirements: Object.keys(SessionManager.candidateRetirements || {}).length,
        };
    }, cReset[cReset.length - 1].client_request_id);
    check('§5 C-Reset success: the retirement request was sent', cResetDone.requested, true);
    check('§5 C-Reset success: NO ssh_disconnect (B6 uses candidate_reset)',
        cResetDone.disconnects, []);
    check('§5 C-Reset success: the candidate survives until the ack',
        [cResetDone.oldStillThere, cResetDone.oldChipStillThere], [true, true]);
    check('§5 C-Reset success: the replacement exists',
        cResetDone.newExists, true);
    check('§5 C-Reset success: the replacement has NO tmux identity',
        cResetDone.newHasTmux, null);
    check('§5 C-Reset success: the reset intent is consumed', cResetDone.intents, 0);
    check('§5 C-Reset success: one retirement record is in flight',
        cResetDone.retirements, 1);
    // W13-B7: while the retirement is in flight, the guard stays armed -- the
    // replacement EXISTS but the candidate is still mid-Reset until its ack.
    check('§5 C-Reset B7: the guard stays armed while the retirement is in flight',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.C2),
        true);

    // Now deliver the correlated ack. The chip is removed only here.
    const cResetAck = await page.evaluate(() => {
        const rid = Object.keys(SessionManager.candidateRetirements || {})[0];
        const sid = SessionManager.candidateRetirements[rid]?.sessionId;
        SessionManager.completeCandidateRetirement(sid, rid);
        return {
            oldGone: !SessionManager.sessions.C2,
            oldChipGone: !document.getElementById('tab-C2'),
            retirementsLeft: Object.keys(SessionManager.candidateRetirements || {}).length,
        };
    });
    check('§5 C-Reset success: the ack removes the candidate and chip',
        [cResetAck.oldGone, cResetAck.oldChipGone], [true, true]);
    check('§5 C-Reset success: the retirement record is consumed',
        cResetAck.retirementsLeft, 0);
    // W13-B7: the ack is the Reset's terminal success event -- only NOW is the
    // per-candidate guard released.
    check('§5 C-Reset B7: the ack releases the per-candidate guard',
        await page.evaluate(() => !!SessionManager.candidateResetsInFlight.C2),
        false);

    // A replayed ack must not double-remove.
    const cResetReplay = await page.evaluate(() => {
        const result = SessionManager.completeCandidateRetirement('C2', 'fake_rid');
        return result;
    });
    check('§5 C-Reset success: a replayed/fake ack retires nothing',
        cResetReplay, false);

    // Every cell above asserted its own spy set; this is the end-state backstop.
    const endState = await page.evaluate(() => ({
        activeId: document.activeElement ? document.activeElement.id : null,
        target: SessionManager.lifecycleActionTargetId,
        targetIsLiveOrNull: SessionManager.lifecycleActionTargetId === null
            || !!SessionManager.sessions[SessionManager.lifecycleActionTargetId],
    }));
    check('§5 matrix: focus never ended on the composer',
        endState.activeId !== 'mobileInput', true);
    check('§5 matrix: focus never ended on a password input',
        endState.activeId !== 'passwordInput'
            && endState.activeId !== 'jumpHostPasswordInput', true);
    check('§5 matrix: the target is never a dead session key',
        endState.targetIsLiveOrNull, true);

    await removeFocusSentinels(page);
    check('§5: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §5b — Removal of the selected target through the REAL removeSessionUI path.
//
// Contract (session-manager.js:695-697, the J5 comment): "the target is always
// a live session key. Removing the target session clears it (sole writer
// re-syncs class + buttons); removing any other session leaves the selection
// untouched."
//
// This section drives removeSessionUI directly — the test never calls
// setLifecycleActionTarget — and asserts that documented contract.
//
// KNOWN SOURCE-BUG GATE. removeSessionUI clears the target at line 698-700, but
// its tail (line 729-736) does:
//     const assignedIndex = this.paneAssignments.findIndex(id => id);
//     if (assignedIndex !== -1) this.setActivePane(assignedIndex);
// and setActivePane (J3, line 1457) calls
//     this.setLifecycleActionTarget(this.paneAssignments[paneIndex])
// so the clear is undone and the target lands on whichever session occupies the
// first still-assigned pane. Both cases below are constructed so that a
// surviving ASSIGNED session exists at removal time — otherwise findIndex
// returns -1, setActivePane resolves null, and the gate would pass vacuously.
//
// Expected RED until the source is fixed:
//   - '§5b remove-target: target is null after removing the selected target'
//   - '§5b remove-other: target is unchanged after removing a NON-target'
// Left failing deliberately rather than relaxed to match the bug.
// ============================================================================
{
    // ---- Case 1: remove the session that IS the selected target ----
    // Two real panes, one live session in each. rm-a is the deliberate target
    // AND is assigned to pane 0; rm-b survives in pane 1. After removing rm-a,
    // findIndex(id => id) resolves pane 1 -> setActivePane(1) -> J3 retargets
    // rm-b, which is precisely the bug this gate pins.
    const { ctx, page, errors } = await newPage(428, 926);
    await spyEmits(page);

    await seedSession(page, 'rm-a', {
        host: 'rma.example', username: 'rmaU', authType: 'key', keyId: 'kA',
        displayName: 'RM A', connected: true,
    });
    await seedSession(page, 'rm-b', {
        host: 'rmb.example', username: 'rmbU', authType: 'key', keyId: 'kB',
        displayName: 'RM B', connected: true, activate: false,
    });

    const sentRm = await installFocusSentinels(page, ['rm-a', 'rm-b']);
    checkSentinels('§5b case1 sentinels', sentRm, ['rm-a', 'rm-b']);

    // Real 2-pane layout, then real per-pane assignment.
    const layout = await page.evaluate(() => {
        SessionManager.setSplitLayout(2);
        SessionManager.assignSessionToPane('rm-a', 0);
        SessionManager.assignSessionToPane('rm-b', 1);
        return {
            paneCount: SessionManager.paneAssignments.length,
            panes: SessionManager.paneAssignments.slice(),
            aIndex: SessionManager.paneAssignments.indexOf('rm-a'),
            bIndex: SessionManager.paneAssignments.indexOf('rm-b'),
        };
    });
    check('§5b case1 setup: two real panes exist', layout.paneCount, 2);
    check('§5b case1 setup: rm-a is assigned to pane 0', layout.aIndex, 0);
    check('§5b case1 setup: rm-b is assigned to pane 1', layout.bIndex, 1);

    // Deliberately target rm-a (assignSessionToPane's setActivePane last ran for
    // rm-b, so this click is what makes rm-a the target).
    const selA = await selectChip(page, 'rm-a');
    check('§5b case1 setup: rm-a is the selected target', selA.target, 'rm-a');
    check('§5b case1 setup: rm-a carries the decoration',
        selA.targetClassOnChip, true);
    check('§5b case1 setup: controls are enabled for the target',
        selA.buttonsEnabled, true);
    // Non-vacuity guard: a surviving ASSIGNED session must exist, or the
    // retarget branch is never reached and the gate proves nothing.
    const survivorAssigned = await page.evaluate(() =>
        SessionManager.paneAssignments.some(id => id && id !== 'rm-a'));
    check('§5b case1 setup: a surviving assigned session exists (non-vacuous)',
        survivorAssigned, true);

    // Real production removal path.
    const afterRemoveTarget = await page.evaluate(() => {
        SessionManager.removeSessionUI('rm-a');
        return {
            target: SessionManager.lifecycleActionTargetId,
            sessionGone: !SessionManager.sessions['rm-a'],
            tabGone: !document.getElementById('tab-rm-a'),
            survivorStillThere: !!SessionManager.sessions['rm-b'],
            survivorPaneIndex: SessionManager.paneAssignments.indexOf('rm-b'),
            decoratedCount: document.querySelectorAll('.session-tab.lifecycle-target').length,
            decoratedIds: [...document.querySelectorAll('.session-tab.lifecycle-target')]
                .map(t => t.id).join(','),
            removedStillDecorated: !!document.querySelector('#tab-rm-a.lifecycle-target'),
            buttons: ['sessionActionRename', 'sessionActionReconnect',
                'sessionActionReset'].map(id => document.getElementById(id).disabled),
        };
    });

    // The removal really happened, and the survivor really is still assigned.
    check('§5b remove-target: the session record is gone',
        afterRemoveTarget.sessionGone, true);
    check('§5b remove-target: the chip is gone from the strip',
        afterRemoveTarget.tabGone, true);
    check('§5b remove-target: the removed chip carries no stale decoration',
        afterRemoveTarget.removedStillDecorated, false);
    check('§5b remove-target: the survivor is still assigned to pane 1',
        afterRemoveTarget.survivorPaneIndex, 1);

    // Documented contract — EXPECTED RED: the current source retargets rm-b.
    check('§5b remove-target: target is null after removing the selected target',
        afterRemoveTarget.target, null);
    check('§5b remove-target: no chip carries the decoration',
        afterRemoveTarget.decoratedCount, 0);
    check('§5b remove-target: all three controls are disabled with no target',
        afterRemoveTarget.buttons.join(','), 'true,true,true');

    // These two hold even under the bug, so they are real regression guards
    // rather than duplicates of the gate above: the target may never be a dead
    // key, and decoration/buttons must always agree with whatever it is.
    const consistency = await page.evaluate(() => {
        const t = SessionManager.lifecycleActionTargetId;
        const decorated = [...document.querySelectorAll('.session-tab.lifecycle-target')]
            .map(el => el.id.replace(/^tab-/, ''));
        return {
            liveOrNull: t === null || !!SessionManager.sessions[t],
            decorationMatches: t === null
                ? decorated.length === 0
                : (decorated.length === 1 && decorated[0] === t),
            disabledMatches:
                document.getElementById('sessionActionReset').disabled === (t === null),
        };
    });
    check('§5b remove-target: the target is never a dead session key',
        consistency.liveOrNull, true);
    check('§5b remove-target: decoration agrees with the target id',
        consistency.decorationMatches, true);
    check('§5b remove-target: button disabled state agrees with the target id',
        consistency.disabledMatches, true);

    check('§5b case1: no page errors', errors, []);
    await removeFocusSentinels(page);
    await ctx.close();
}

{
    // ---- Case 2: remove an UNRELATED session; the selection must not move ----
    // 'live-pane' is live and holds pane 0. 'keep-target' is an ordinary
    // disconnected session that is deliberately UNASSIGNED and is the selected
    // target (switchSession's target-only arm returns before any pane path, so
    // selecting it cannot assign it). 'drop' is a third unrelated session.
    // Removing 'drop' runs the tail: findIndex resolves pane 0 -> setActivePane(0)
    // -> J3 retargets 'live-pane', stealing the selection from 'keep-target'.
    const { ctx, page, errors } = await newPage(428, 926);
    await spyEmits(page);

    await seedSession(page, 'live-pane', {
        host: 'livepane.example', username: 'lpU', authType: 'key', keyId: 'kLP',
        displayName: 'Live Pane', connected: true,
    });
    await seedSession(page, 'keep-target', {
        host: 'keeptarget.example', username: 'ktU', authType: 'key', keyId: 'kKT',
        displayName: 'Keep Target', connected: false, activate: false,
    });
    await seedSession(page, 'drop', {
        host: 'drop.example', username: 'dropU', authType: 'key', keyId: 'kDR',
        displayName: 'Drop', connected: true, activate: false,
    });

    const sentKeep = await installFocusSentinels(page,
        ['live-pane', 'keep-target', 'drop']);
    checkSentinels('§5b case2 sentinels', sentKeep,
        ['live-pane', 'keep-target', 'drop']);

    const setup = await page.evaluate(() => {
        SessionManager.setSplitLayout(1);
        SessionManager.assignSessionToPane('live-pane', 0);
        return {
            panes: SessionManager.paneAssignments.slice(),
            livePaneIndex: SessionManager.paneAssignments.indexOf('live-pane'),
            keepTargetIndex: SessionManager.paneAssignments.indexOf('keep-target'),
            dropIndex: SessionManager.paneAssignments.indexOf('drop'),
        };
    });
    check('§5b case2 setup: live-pane holds pane 0', setup.livePaneIndex, 0);
    check('§5b case2 setup: keep-target is unassigned', setup.keepTargetIndex, -1);
    check('§5b case2 setup: drop is unassigned', setup.dropIndex, -1);

    // Deliberately target the UNASSIGNED disconnected session.
    const selKeep = await selectChip(page, 'keep-target');
    check('§5b case2 setup: keep-target is the selected target',
        selKeep.target, 'keep-target');
    check('§5b case2 setup: keep-target carries the decoration',
        selKeep.targetClassOnChip, true);
    // Selecting it must not have assigned it — that is what makes the target
    // differ from the pane's session and lets the theft be observable.
    const stillUnassigned = await page.evaluate(() => ({
        keepTargetIndex: SessionManager.paneAssignments.indexOf('keep-target'),
        activeSessionId: SessionManager.activeSessionId,
    }));
    check('§5b case2 setup: selection did not assign keep-target to a pane',
        stillUnassigned.keepTargetIndex, -1);
    check('§5b case2 setup: target and active session genuinely differ',
        stillUnassigned.activeSessionId !== 'keep-target', true);
    // Non-vacuity guard: an assigned survivor must exist at removal time.
    check('§5b case2 setup: an assigned survivor exists (non-vacuous)',
        setup.livePaneIndex !== -1, true);

    const beforeOther = await snapshotSessions(page);
    const afterRemoveOther = await page.evaluate(() => {
        SessionManager.removeSessionUI('drop');
        return {
            target: SessionManager.lifecycleActionTargetId,
            droppedGone: !SessionManager.sessions['drop'],
            keepTargetStillThere: !!SessionManager.sessions['keep-target'],
            livePaneStillThere: !!SessionManager.sessions['live-pane'],
            decoratedIds: [...document.querySelectorAll('.session-tab.lifecycle-target')]
                .map(t => t.id).join(','),
            buttons: ['sessionActionRename', 'sessionActionReconnect',
                'sessionActionReset'].map(id => document.getElementById(id).disabled),
        };
    });

    check('§5b remove-other: the unrelated session is gone',
        afterRemoveOther.droppedGone, true);
    check('§5b remove-other: the selected target survives',
        afterRemoveOther.keepTargetStillThere, true);
    check('§5b remove-other: the live pane session survives',
        afterRemoveOther.livePaneStillThere, true);

    // Documented contract — "removing any other session leaves the selection
    // untouched." EXPECTED RED: the tail's setActivePane steals the target to
    // 'live-pane'.
    check('§5b remove-other: target is unchanged after removing a NON-target',
        afterRemoveOther.target, 'keep-target');
    check('§5b remove-other: decoration stays on the selected chip',
        afterRemoveOther.decoratedIds, 'tab-keep-target');
    check('§5b remove-other: controls stay enabled for the surviving target',
        afterRemoveOther.buttons.join(','), 'false,false,false');

    // Non-target isolation: both survivors byte-identical, same pane indices.
    // Only the removed session's slot may have changed.
    const afterSnap = await snapshotSessions(page);
    for (const id of ['keep-target', 'live-pane']) {
        check(`§5b remove-other: ${id} record is untouched`,
            afterSnap.sessions[id], beforeOther.sessions[id]);
        check(`§5b remove-other: ${id} keeps its pane index`,
            afterSnap.paneIndexById[id], beforeOther.paneIndexById[id]);
    }

    check('§5b case2: no page errors', errors, []);
    await removeFocusSentinels(page);
    await ctx.close();
}
// ============================================================================
// §6 — Static sole-setter invariants (source text, no browser).
//
// lifecycleActionTargetId must be written in exactly two places: the
// object-literal init and the one assignment inside setLifecycleActionTarget.
// setLifecycleActionTarget must be called only from the approved selection,
// removal, pane-maintenance, and pending-transition paths. A mutation that
// assigns the field raw at a call site (bypassing the class/button sync) fails here.
// ============================================================================
{
    const smSrc = fs.readFileSync(
        path.join(ROOT, 'static/js/session-manager.js'), 'utf8');

    // The object-literal init, colon form.
    const initCount = (smSrc.match(/^\s*lifecycleActionTargetId:\s*null,\s*$/gm) || []).length;
    check('§6 static: exactly one object-literal init of lifecycleActionTargetId',
        initCount, 1);

    // Assignments only — '=(?!=)' so the '===' comparison in removeSessionUI
    // is not miscounted as a write. Only the one inside the sole setter is
    // allowed; a mutation assigning the field raw at a call site fails here.
    const assigns = smSrc.match(/lifecycleActionTargetId\s*=(?!=)/g) || [];
    check('§6 static: exactly one assignment to lifecycleActionTargetId',
        assigns.length, 1);
    check('§6 static: that assignment is this.lifecycleActionTargetId = id',
        /this\.lifecycleActionTargetId = id;/.test(smSrc), true);

    // The single assignment must live inside setLifecycleActionTarget's body.
    const setterStart = smSrc.indexOf('setLifecycleActionTarget(sessionId) {');
    const setterEnd = smSrc.indexOf('dispatchLifecycleAction(action) {');
    check('§6 static: the sole setter is defined', setterStart > -1, true);
    check('§6 static: dispatchLifecycleAction follows it', setterEnd > setterStart, true);
    const setterBody = smSrc.slice(setterStart, setterEnd);
    check('§6 static: the assignment lives inside the sole setter',
        /this\.lifecycleActionTargetId = id;/.test(setterBody), true);
    check('§6 static: the setter validates the id against live sessions',
        /const id = \(sessionId && this\.sessions\[sessionId\]\) \? sessionId : null;/
            .test(setterBody), true);
    check('§6 static: the setter clears every stale .lifecycle-target',
        /\.session-tab\.lifecycle-target/.test(setterBody), true);
    // Five ids, not three: v5 section 3 keeps the actions in a sheet, so the
    // sheet's own trigger and the Close action are gated by the same valid
    // target as Rename/Reconnect/Reset. Asserting only three would let a
    // regression leave the trigger or Close live with no target selected.
    check('§6 static: the setter syncs the trigger and all four actions',
        /'sessionActionsBtn', 'sessionActionRename',\s*\n\s*'sessionActionReconnect', 'sessionActionReset', 'sessionActionClose'/
            .test(setterBody), true);
    check('§6 static: the setter closes the sheet when the target is cleared',
        /if \(!id\) this\.closeLifecycleSheet\(\);/.test(setterBody), true);

    // Call sites: exactly five this.setLifecycleActionTarget( calls —
    // switchSession; guarded setActivePane; TWO in removeSessionUI (clear +
    // guarded reassert); and setPendingLifecycleTarget, which must clear a real
    // target through the sole writer rather than assigning its field raw.
    const calls = smSrc.match(/this\.setLifecycleActionTarget\(/g) || [];
    check('§6 static: exactly five setLifecycleActionTarget call sites',
        calls.length, 5);
    // The reassert must stay GUARDED: an unconditional write here would clobber
    // the target on every removal and re-open the bug from the other side.
    check('§6 static: the removal reassert is guarded by an inequality check',
        /if \(this\.lifecycleActionTargetId !== intendedTargetId\) \{/.test(smSrc),
        true);
    check('§6 static: removal captures the intended target before the tail',
        /const intendedTargetId = targetWasRemoved \? null : this\.lifecycleActionTargetId;/
            .test(smSrc), true);

    const inFn = (name, endMarker) => {
        const s = smSrc.indexOf(name);
        if (s === -1) return false;
        const e = smSrc.indexOf(endMarker, s);
        return /this\.setLifecycleActionTarget\(/.test(smSrc.slice(s, e));
    };
    check('§6 static: switchSession calls the sole setter',
        inFn('switchSession(sessionId) {', 'closeSession(sessionId) {'), true);
    check('§6 static: removeSessionUI calls the sole setter',
        inFn('removeSessionUI(sessionId) {', 'notifyActiveSessionChanged('), true);
    // The locator is the FUNCTION NAME, not its full signature: S17 FIX 6 added a
    // second destructured option (declareInteraction) and a signature-shaped
    // locator silently stopped matching, slicing an empty body and failing four
    // assertions that are all still true in the source. A locator is harness
    // plumbing with no product meaning; the assertions below are the contract.
    const paneStart = smSrc.indexOf('setActivePane(paneIndex, {');
    check('§6 static: the setActivePane locator still finds the function',
        paneStart !== -1, true);
    const paneEnd = smSrc.indexOf('getActiveTerminal() {', paneStart);
    const paneBody = smSrc.slice(paneStart, paneEnd);
    check('§6 static: setActivePane calls the sole setter',
        /if \(!preserveLifecycleTarget\) \{\s*\n\s*this\.setLifecycleActionTarget\(sessionId\);/
            .test(paneBody), true);
    check('§6 static: removal pane maintenance preserves lifecycle selection',
        (smSrc.match(/setActivePane\([^;]+preserveLifecycleTarget: true/g) || []).length,
        3);
    const pendingStart = smSrc.indexOf('setPendingLifecycleTarget(requestId) {');
    const pendingEnd = smSrc.indexOf('dispatchLifecycleAction(action) {', pendingStart);
    const pendingBody = smSrc.slice(pendingStart, pendingEnd);
    check('§6 static: pending transition clears real target through sole setter',
        /if \(this\.lifecycleActionTargetId !== null\) \{\s*\n\s*this\.setLifecycleActionTarget\(null\);/
            .test(pendingBody), true);
    check('§6 static: pending setter never raw-writes the real target id',
        /lifecycleActionTargetId\s*=(?!=)/.test(pendingBody), false);

    // The candidate/disconnected selection arm must return before any pane
    // path, so a tap can never evict or reassign a pane.
    const swStart = smSrc.indexOf('switchSession(sessionId) {');
    const swEnd = smSrc.indexOf('closeSession(sessionId) {');
    const swBody = smSrc.slice(swStart, swEnd);
    check('§6 static: switchSession keeps the exact locked target-only condition',
        /if \(!session\.connected \|\| session\.isPersistentCandidate\) \{/.test(swBody),
        true);
    check('§6 static: the target-only arm returns before assignedIndex',
        swBody.indexOf('this.setLifecycleActionTarget(sessionId);')
            < swBody.indexOf('const assignedIndex'), true);
    check('§6 static: the target-only arm returns before assignSessionToPane',
        swBody.indexOf('return;') < swBody.indexOf('assignSessionToPane'), true);

    // The toolbar binds exactly once, by delegation on the container.
    check('§6 static: the toolbar binds once behind a guard',
        /if \(this\.lifecycleToolbarBound\) return;/.test(smSrc), true);
    check('§6 static: the delegated listener resolves [data-lifecycle-action]',
        /closest\('\[data-lifecycle-action\]'\)/.test(smSrc), true);
    check('§6 static: the delegated listener honours the disabled state',
        /if \(!btn \|\| btn\.disabled\) return;/.test(smSrc), true);

    // J9: neither disconnected route duplicates payload/emission logic.
    //
    // The shape changed with the request-keyed reconnect intent, so this now
    // pins BOTH arms by name instead of one `} else {` block:
    //   * a persistent CANDIDATE with no server-held credential goes to
    //     requestCandidateReconnect, which registers the intent (keeping the
    //     chip, the offer and the exact tmux name) and then delegates the field
    //     filling to prefillConnectionForm;
    //   * an ordinary DISCONNECTED session keeps the original tail call,
    //     unchanged, because its behaviour is deliberately untouched.
    // Both still end at prefillConnectionForm, which is what J9 exists to say.
    const rrStart = smSrc.indexOf('requestReconnect(sessionId) {');
    const rrEnd = smSrc.indexOf('requestResetSession(sessionId) {');
    const rrBody = smSrc.slice(rrStart, rrEnd > rrStart ? rrEnd : undefined);
    check('§6 static: the candidate arm routes through the candidate owner',
        /\} else \{\s*\n\s*this\.requestCandidateReconnect\(sessionId\);\s*\n\s*\}/
            .test(rrBody), true);
    // W13-B5: the ordinary-disconnected tail is no longer a bare prefill. It
    // is the three-case truthful contract: a valid tmux identity is confirmed
    // as a REATTACH before the form opens; a tmux shape with a lost/invalid
    // identity is REFUSED with the honest message; a never-tmux session gets
    // the bare restore form with the reconnect intent banner painted. Pin all
    // three arms of the tail, each by name.
    check('§6 static: a valid-identity reconnect confirms the reattach copy',
        /session\.reconnectRetainBody/.test(rrBody)
            && /danger: false,\s*\n\s*onAccept: \(\) => \{\s*\n\s*this\.prefillConnectionForm\(sessionId\);/
                .test(rrBody), true);
    check('§6 static: the confirmed route paints the reconnect intent banner',
        /this\.setConnectionFormIntent\('reconnect', \{\s*\n\s*label,\s*\n\s*tmuxSessionName: session\.tmuxSessionName \|\| null,\s*\n\s*\}\);\s*\n\s*\},/
            .test(rrBody), true);
    check('§6 static: a lost tmux identity is refused, never silently fresh',
        /this\.refuseReconnectWithoutTmuxIdentity\(sessionId\);/.test(rrBody), true);
    check('§6 static: the bare restore tail paints its reconnect intent too',
        /this\.prefillConnectionForm\(sessionId\);\s*\n\s*this\.setConnectionFormIntent\('reconnect', \{ label, tmuxSessionName: null \}\);\s*\n\s*\},/
            .test(rrBody), true);
    check('§6 static: the candidate owner delegates field filling, not payloads',
        /requestCandidateReconnect\(sessionId\) \{[\s\S]{0,1200}this\.prefillConnectionForm\(sessionId\);/
            .test(smSrc), true);
}

// ============================================================================
// §7 — Sheet contract + dead-code checks.
//
// RE-TARGETED. This section previously asserted the sheet had been DELETED and
// replaced by an always-visible three-button in-row toolbar. Amendment v5
// section 3 forbids that toolbar outright — "Session row: Không chứa action,
// spacer hay menu" and "Không tạo nút menu thứ hai ở session row hoặc composer"
// — and the mockup (sshdeck-ui-plan-v5.html line 184, .tw5-session-actions)
// shows the actions as a popover sheet whose own heading reads "Đã chọn · chạm
// lại hoặc nhấn giữ". The sheet IS the v5 design, so the checks now pin its
// contract instead of its absence.
//
// What stays genuinely dead: role=menuitem. Section 3's sheet is a dialog, and
// the old menu semantics would impose roving-tabindex keyboard behaviour the
// re-tap gesture does not implement.
// ============================================================================
{
    const DEAD = [
        'role="menuitem"',
        "role: 'menuitem'",
    ];
    for (const rel of ['static/css/style.css', 'templates/index.html',
        'static/js/session-manager.js']) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const needle of DEAD) {
            check(`§7 dead code: ${rel} has no ${needle}`,
                src.includes(needle), false);
        }
    }

    // No second menu button in the session row or the composer dock — the
    // section 3 prohibition, checked structurally rather than by name so a
    // renamed control cannot slip through.
    const { ctx, page, errors } = await newPage(428, 926);
    await seedSession(page, 'd1');
    const probe = await page.evaluate(() => {
        const row = document.querySelector('.session-tabs-row');
        const dock = document.getElementById('mobileInputBar');
        const sheet = document.getElementById('sessionActionsSheet');
        const control = document.getElementById('sessionActionsControl');
        return {
            sheetExists: !!sheet,
            sheetRole: sheet ? sheet.getAttribute('role') : null,
            sheetHiddenAtRest: sheet ? sheet.hidden : null,
            sheetInertAtRest: sheet ? sheet.hasAttribute('inert') : null,
            sheetAriaHiddenAtRest: sheet ? sheet.getAttribute('aria-hidden') : null,
            menuItems: document.querySelectorAll('[role="menuitem"]').length,
            // Exactly one lifecycle control set, all of it inside the sheet.
            actionCount: document.querySelectorAll('[data-lifecycle-action]').length,
            actionsAllInSheet: sheet
                ? [...document.querySelectorAll('[data-lifecycle-action]')]
                    .every(b => sheet.contains(b)) : false,
            actionNames: [...document.querySelectorAll('[data-lifecycle-action]')]
                .map(b => b.dataset.lifecycleAction).join(','),
            // Section 3: the session row carries the strip and nothing else.
            // W14 item 7 (owner instruction) makes ONE button a permanent
            // fixture of the row — the icon-only New Connection '+' that leads
            // the strip. Session ACTION buttons (rename/reconnect/reset/close)
            // must still be zero; the '+' is counted separately below so the
            // contract is narrowed, not weakened.
            rowActionButtons: row
                ? [...row.querySelectorAll('button')]
                    .filter(b => b.id !== 'newConnectionBtn')
                    .filter(b => b.getBoundingClientRect().width > 0).length : -1,
            rowNewConnectionVisible: row
                ? (() => {
                    const btn = row.querySelector('#newConnectionBtn');
                    return !!btn && btn.getBoundingClientRect().width > 0
                        && row.firstElementChild === btn;
                })() : false,
            // Section 3: no second menu in the composer dock either.
            dockMenuTriggers: dock
                ? [...dock.querySelectorAll('[aria-haspopup]')]
                    .filter(b => (b.getAttribute('aria-controls') || '')
                        .includes('sessionActions')).length : -1,
            // The overlay host consumes no layout while closed.
            controlDisplay: control ? getComputedStyle(control).display : null,
        };
    });
    check('§7 probe: the action sheet exists', probe.sheetExists, true);
    check('§7 probe: the sheet is a dialog, not a menu', probe.sheetRole, 'dialog');
    check('§7 probe: the sheet is hidden at rest', probe.sheetHiddenAtRest, true);
    check('§7 probe: the sheet is inert at rest', probe.sheetInertAtRest, true);
    check('§7 probe: the sheet is aria-hidden at rest',
        probe.sheetAriaHiddenAtRest, 'true');
    check('§7 probe: no role=menuitem nodes remain', probe.menuItems, 0);
    check('§7 probe: exactly six lifecycle actions', probe.actionCount, 6);
    check('§7 probe: the six actions are rename/reconnect/reset/assign/orphans/close',
        probe.actionNames, 'rename,reconnect,reset,assign,orphans,close');
    check('§7 probe: every lifecycle action lives inside the sheet',
        probe.actionsAllInSheet, true);
    check('§7 probe: the session row shows no session-action buttons (v5 section 3)',
        probe.rowActionButtons, 0);
    check('§7 probe: the strip leads with the permanent icon-only "+" (W14 item 7)',
        probe.rowNewConnectionVisible, true);
    check('§7 probe: no second session menu in the composer dock',
        probe.dockMenuTriggers, 0);
    check('§7 probe: the closed overlay host generates no box',
        probe.controlDisplay, 'contents');
    check('§7 probe: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §8 — The confirm dialog's PAINTED state, not just its `hidden` attribute.
//
// Every confirm check above asked `!dialog.hidden` -- a question about an
// ATTRIBUTE. `.session-confirm` (deck.css) declares `display: grid`, and an
// author declaration outranks the UA rule that hides `[hidden]`, so the dialog
// painted its opaque card over the terminal at initial load while `hidden` and
// `inert` were both set: measured 350x183 at 1440x900 and 350x195 at iPad,
// phone 390 and phone landscape. `inert` kept it out of hit testing, which is
// why 785 green assertions could not see a purely VISUAL occlusion.
//
// Each state is pinned on BOTH axes, attribute AND painted box, and the OPEN
// state carries the companion floor: without it `.session-confirm{display:none}`
// would satisfy every closed check while making the dialog unopenable, i.e. the
// ceiling would pass by rendering nothing (AGENTS §2). The backdrop is measured
// too -- it carries its own [hidden] guard and stayed correctly hidden while the
// card painted, so measuring only the card would miss which half is wrong.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    await seedSession(page, 'c1');
    const read = () => page.evaluate(() => {
        const shape = (el) => {
            const b = el.getBoundingClientRect();
            const [mx, my] = [window.innerWidth / 2, window.innerHeight / 2];
            return {
                hiddenAttr: el.hasAttribute('hidden'),
                display: getComputedStyle(el).display,
                box: `${Math.round(b.width)}x${Math.round(b.height)}`,
                positive: b.width > 0 && b.height > 0,
                coversViewportCentre: b.width > 0 && b.height > 0 && b.left <= mx
                    && b.right >= mx && b.top <= my && b.bottom >= my,
            };
        };
        return {
            dialog: shape(document.getElementById('sessionConfirm')),
            backdrop: shape(document.getElementById('sessionConfirmBackdrop')),
        };
    });
    const assertClosed = (s, when) => {
        check(`§8 ${when}: dialog keeps its hidden attribute`, s.dialog.hiddenAttr, true);
        check(`§8 ${when}: dialog computes display:none`, s.dialog.display, 'none');
        check(`§8 ${when}: dialog paints no box`, s.dialog.box, '0x0');
        check(`§8 ${when}: backdrop computes display:none`, s.backdrop.display, 'none');
        check(`§8 ${when}: backdrop paints no box`, s.backdrop.box, '0x0');
    };

    // 1) Closed at rest: nothing opened it, so nothing may paint.
    assertClosed(await read(), 'at rest');

    // 2) Open through the real product path -- re-tap opens the sheet, the Reset
    // row calls requestResetSession -> openSessionConfirm. No attribute is set
    // from the test, so this is the same route a user takes.
    await selectChip(page, 'c1');
    await invokeAction(page, 'c1', 'reset');
    await page.waitForTimeout(80);
    const open = await read();
    check('§8 open: dialog drops its hidden attribute', open.dialog.hiddenAttr, false);
    check('§8 open: dialog computes display:grid', open.dialog.display, 'grid');
    check(`§8 open: dialog paints a positive box (${open.dialog.box})`,
        open.dialog.positive, true);
    check('§8 open: backdrop drops its hidden attribute', open.backdrop.hiddenAttr, false);
    check(`§8 open: backdrop covers the viewport (${open.backdrop.box})`,
        open.backdrop.coversViewportCentre, true);

    // 3) Closed again after a real Cancel click, same bar as step 1.
    await page.click('#sessionConfirmCancel');
    await page.waitForTimeout(80);
    assertClosed(await read(), 'after Cancel');

    check('§8 no page errors', errors, []);
    await ctx.close();
}
// ============================================================================
// §9 — D3 "chặn hành động trùng khi bấm nhanh nhiều lần": exactly ONE armed
//      action per confirmation, driven through the real dialog with real clicks.
//
// The dialog is SHARED by Reconnect, Reset and Close, and each open used to
// attach a fresh accept/cancel handler pair without detaching the previous one,
// while rewriting the title/body/label the previous action had written. So a
// second open left a dialog showing ONE action with TWO armed. Measured before
// the fix, on this exact harness:
//
//   requestReconnect('B') then requestResetSession('B'), one Accept click
//     -> ssh_reconnect AND ssh_disconnect + ssh_connect
//        (the user read "Start a fresh session?" and got a reconnect too)
//   requestResetSession('C') then requestCloseSession('C'), one Accept click
//     -> closeSession ran TWICE
//   requestReconnect('A') twice, one Accept click
//     -> performLiveReconnect ran twice (saved from two transports only by the
//        in-flight guard inside it, which is a second line of defence, not this
//        one)
//
// Every case below clicks Accept exactly once, the way a user does, and counts
// what the WIRE saw — not what a stub was asked to do.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    await spyEmits(page);

    // A key-auth live session: the reconnect route the server CAN swap, so a
    // duplicate would reach the wire rather than being diverted to a form.
    const armAndClickOnce = async (open) => {
        await page.evaluate(() => {
            window.__disconnectEmits = [];
            window.__connectEmits.length = 0;
            window.__reconnectEmits.length = 0;
            const real = window.socket.emit.bind(window.socket);
            if (!window.__disconnectSpyArmed) {
                window.__disconnectSpyArmed = true;
                window.socket.emit = (ev, payload) => {
                    if (ev === 'ssh_disconnect') window.__disconnectEmits.push(payload);
                    return real(ev, payload);
                };
            }
        });
        await page.evaluate(open);
        const visible = await confirmVisible(page);
        await page.click('#sessionConfirmAccept');
        await page.waitForTimeout(120);
        return { visible, ...(await page.evaluate(() => ({
            reconnects: window.__reconnectEmits.length,
            connects: window.__connectEmits.length,
            disconnects: (window.__disconnectEmits || []).length,
        }))) };
    };

    await seedSession(page, 'dup1', { authType: 'key', keyId: 'k1', useTmux: true,
        tmuxSessionName: 'tdup1' });
    const twice = await armAndClickOnce(() => {
        SessionManager.requestReconnect('dup1');
        SessionManager.requestReconnect('dup1');
    });
    check('§9 two Reconnect presses still show one dialog', twice.visible, true);
    check('§9 one Accept after two Reconnect presses emits ONE ssh_reconnect',
        twice.reconnects, 1);
    check('§9 ...and no connect/disconnect at all',
        twice.connects + twice.disconnects, 0);

    // Reconnect armed, then Reset opened on top: only Reset may run, because
    // Reset's copy is what the dialog is showing.
    await seedSession(page, 'dup2', { authType: 'key', keyId: 'k2', useTmux: true,
        tmuxSessionName: 'tdup2' });
    const mixed = await armAndClickOnce(() => {
        SessionManager.requestReconnect('dup2');
        SessionManager.requestResetSession('dup2');
    });
    check('§9 Reconnect-then-Reset shows a dialog', mixed.visible, true);
    check('§9 accepting runs Reset only — no stale ssh_reconnect',
        mixed.reconnects, 0);
    check('§9 accepting runs Reset — one fresh ssh_connect', mixed.connects, 1);

    // Reset armed, then Close opened on top: Close only, exactly once.
    await seedSession(page, 'dup3', { authType: 'key', keyId: 'k3', useTmux: true,
        tmuxSessionName: 'tdup3' });
    const stacked = await armAndClickOnce(() => {
        SessionManager.requestResetSession('dup3');
        SessionManager.requestCloseSession('dup3');
    });
    check('§9 Reset-then-Close shows a dialog', stacked.visible, true);
    check('§9 accepting runs Close exactly once', stacked.disconnects, 1);
    check('§9 accepting runs Close only — no Reset ssh_connect',
        stacked.connects, 0);

    // Re-opening must not leave a second dialog behind, and Cancel must still
    // close everything: a stale handler pair would keep the card armed.
    const afterCancel = await page.evaluate(async () => {
        SessionManager.requestResetSession('dup1');
        SessionManager.requestCloseSession('dup1');
        document.getElementById('sessionConfirmCancel').click();
        await new Promise(r => setTimeout(r, 60));
        const d = document.getElementById('sessionConfirm');
        const b = document.getElementById('sessionConfirmBackdrop');
        return { hidden: d.hidden, inert: d.hasAttribute('inert'),
            backdropHidden: b.hidden, pending: !!SessionManager.pendingSessionConfirmClose };
    });
    check('§9 Cancel closes a re-opened dialog', afterCancel.hidden, true);
    check('§9 ...and re-arms inert', afterCancel.inert, true);
    check('§9 ...and hides the backdrop', afterCancel.backdropHidden, true);
    check('§9 ...and leaves nothing pending', afterCancel.pending, false);

    check('§9 no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
