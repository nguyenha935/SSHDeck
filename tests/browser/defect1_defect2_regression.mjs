/*
 * DEFECT 1 + DEFECT 2 REGRESSION — action semantics and reconnect intent.
 *
 * Both defects were reported on the deployed build and reproduced with probes
 * before anything was edited (tests/browser/defect2_action_semantics_probe.mjs,
 * tests/browser/defect1_pane_locale_ime_probe.py). This suite is the standing
 * regression for the fixes, and every assertion below is one the PRE-FIX source
 * fails -- see tests/browser/defect1_defect2_mutation_proof.sh, which puts each
 * defect back one at a time and names the assertion that must go red.
 *
 * WHAT WAS WRONG
 *
 * Defect 2, layer 1 -- the confirmation dialog was shared but not parameterized.
 * openSessionConfirm wrote ONLY the title; body, accept label, icon and danger
 * class were static markup fixed to Reset's copy. Measured on the deployed
 * build: Reconnect, Reset and Close all displayed "The current connection closes
 * and a fresh session starts without reattaching tmux", all offered "Start
 * fresh" in danger red under a rotate-ccw icon. Reconnect therefore promised to
 * destroy the tmux session it exists to preserve.
 *
 * Defect 2, layer 2 -- a password Reconnect behaved like a Reset. The server
 * refuses a prepare-and-swap for a password session (no stored secret,
 * socket_events.py:687 -> 'password_required'), the client opened the connection
 * modal, and the submit built an ORDINARY connect: the reconnect intent, the
 * tmux name and the transcript were carried only by whatever globals happened to
 * survive. That is now an explicit non-secret record (pendingReconnectMeta) that
 * the submit consumes.
 *
 * SECTIONS
 *   §1 dialog copy is DISTINCT per action, and each field is what that action
 *      actually does (body, accept label, icon, danger)
 *   §2 no stale state: every field is rewritten on each open, in both
 *      directions, so no action can inherit another's dialog
 *   §3 password reconnect emits ONE ssh_connect carrying reconnect_tmux_name,
 *      never use_tmux:false, and never ssh_disconnect
 *   §4 the transcript survives the reconnect (adoptTranscript), and the old
 *      session is retired without killing its tmux
 *   §5 key and Tailscale keep the genuine ssh_reconnect transport swap
 *   §6 Reset alone discards tmux intent, after its destructive confirmation
 *   §7 all three surfaces (per-row sheet, toolbar touch proxy, direct dispatch)
 *      route through the same semantic actions; disconnected-row targeting
 *      stays atomic
 *   §8 cancelling either modal leaves NO intent behind for a later Connect
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

function checkNot(label, actual, forbidden) {
    if (actual !== forbidden) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        must NOT be ${JSON.stringify(forbidden)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const SOCKET_STUB = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.__emitted = [];
    window.__io = () => ({
        connected: true,
        on: (n, f) => { (window.__socketHandlers[n] = window.__socketHandlers[n] || []).push(f); },
        off: (n, f) => {
            const list = window.__socketHandlers[n] || [];
            const i = list.indexOf(f);
            if (i >= 0) list.splice(i, 1);
        },
        once: noop,
        emit: (n, p) => {
            window.__emitted.push({ name: n, payload: p });
            // Model the production resize acknowledgement so S27's geometry
            // hold cannot hide ordinary ssh_output in this lifecycle fixture.
            if (n === 'ssh_resize' && p) {
                (window.__socketHandlers.pty_geometry || []).forEach(f => f({
                    session_id: p.session_id, cols: p.cols, rows: p.rows,
                    applied: true,
                }));
            }
        },
        io: { on: noop },
    });
    window.io = window.__io;
    window.socket = window.__io();
    window.__server = (n, p) => {
        (window.__socketHandlers[n] || []).forEach(f => { try { f(p); } catch (e) { console.error(e); } });
    };
    window.__notes = [];
    window.showNotification = (m, k) => { window.__notes.push({ m, k }); };
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const pageErrors = [];

async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(SOCKET_STUB);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => window.__server('connect', {}));
    await page.waitForTimeout(150);
    return { ctx, page };
}

// Seed one live session the way ssh_connected does, then make it the lifecycle
// target -- the state every per-row action starts from.
async function seedLive(page, sid, opts = {}) {
    await page.evaluate(({ sid, opts }) => {
        window.__server('ssh_connected', {
            session_id: sid,
            host: opts.host || 'live.example',
            port: 22,
            username: 'u',
            auth_type: opts.authType || 'password',
            use_tmux: opts.useTmux !== false,
            tmux_session_name: opts.tmux === null ? null : (opts.tmux || `tmux_${sid}`),
            key_id: opts.keyId || null,
            display_name: null,
        });
    }, { sid, opts });
    await page.waitForTimeout(120);
    await page.evaluate((sid) => SessionManager.setLifecycleActionTarget(sid), sid);
    await page.waitForTimeout(60);
}

// Everything the confirmation dialog is showing right now.
const dialogState = (page) => page.evaluate(() => {
    const dlg = document.getElementById('sessionConfirm');
    const accept = document.getElementById('sessionConfirmAccept');
    const icon = document.getElementById('sessionConfirmIcon');
    return {
        open: !!dlg && dlg.hidden === false,
        title: (document.getElementById('sessionConfirmTitle')?.textContent || '').trim(),
        body: (document.getElementById('sessionConfirmBody')?.textContent || '').trim(),
        bodyKey: document.getElementById('sessionConfirmBody')?.getAttribute('data-i18n') || null,
        acceptLabel: (accept?.textContent || '').trim(),
        acceptKey: accept?.getAttribute('data-i18n') || null,
        acceptDanger: !!accept && accept.classList.contains('session-confirm-danger'),
        iconSymbol: icon ? (icon.getAttribute('href') || '').split('#')[1] : null,
    };
});

const emitted = (page) => page.evaluate(() => window.__emitted.map(e => ({
    name: e.name,
    session_id: e.payload?.session_id ?? null,
    use_tmux: e.payload?.use_tmux ?? null,
    reconnect_tmux_name: e.payload?.reconnect_tmux_name ?? null,
    client_request_id: e.payload?.client_request_id ?? null,
    has_password: e.payload ? Object.prototype.hasOwnProperty.call(e.payload, 'password') : false,
})));
const clearEmitted = (page) => page.evaluate(() => { window.__emitted.length = 0; });

/* ═══ §1 the three dialogs are DISTINCT and each says what its action does ═══ */
{
    const { ctx, page } = await newPage();

    /*
     * The Reconnect dialog has TWO honest variants, and the difference is not a
     * weakening -- it is the point of layer 2.
     *
     *   key / Tailscale : the server can rebuild the transport from material it
     *                     already holds, so accepting reconnects immediately.
     *                     Icon plug-zap, the Reconnect action's own glyph.
     *   password        : the server stores no secret (socket_events.py:687),
     *                     so accepting opens the credential form. The dialog
     *                     says so and shows the key glyph, because promising an
     *                     immediate reconnect and then producing a form is how
     *                     this action came to feel like a Reset.
     *
     * §1 measures the KEY variant against Reset and Close; §3 measures the
     * password variant end to end. Both are asserted; neither is assumed.
     */
    await seedLive(page, 'S-key', { authType: 'key', keyId: 'k1' });
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    const rec = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    await seedLive(page, 'S-rec');
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    const recPw = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reset'));
    await page.waitForTimeout(120);
    const res = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    await page.evaluate(() => SessionManager.dispatchLifecycleAction('close'));
    await page.waitForTimeout(120);
    const clo = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    // The collapse itself, stated as inequality. These four comparisons were
    // ALL true on the deployed build.
    checkNot('§1 Reconnect body differs from Reset body', rec.body, res.body);
    checkNot('§1 Reconnect accept differs from Reset accept',
        rec.acceptLabel, res.acceptLabel);
    checkNot('§1 Reconnect icon differs from Reset icon', rec.iconSymbol, res.iconSymbol);
    checkNot('§1 Close body differs from Reset body', clo.body, res.body);
    checkNot('§1 Close accept differs from Reset accept',
        clo.acceptLabel, res.acceptLabel);
    checkNot('§1 Close icon differs from Reset icon', clo.iconSymbol, res.iconSymbol);
    checkNot('§1 Close body differs from Reconnect body', clo.body, rec.body);

    // Reconnect: preserves, so it must not be dressed as destruction and must
    // not claim tmux is dropped.
    check('§1 Reconnect body does not say tmux is not reattached',
        /without reattaching tmux/i.test(rec.body), false);
    check('§1 Reconnect body says the session is reattached',
        /reattach/i.test(rec.body), true);
    check('§1 Reconnect accept is NOT the danger button', rec.acceptDanger, false);
    check('§1 Reconnect (key) icon is the Reconnect glyph',
        rec.iconSymbol, 'icon-plug-zap');
    check('§1 Reconnect body is non-empty', rec.body.length > 20, true);

    // The password variant: still a reconnect, still not destructive, and still
    // distinct from Reset -- but honest that a credential comes first.
    check('§1 Reconnect (password) icon is the key glyph',
        recPw.iconSymbol, 'icon-key-round');
    check('§1 Reconnect (password) is NOT the danger button',
        recPw.acceptDanger, false);
    checkNot('§1 Reconnect (password) body differs from Reset body',
        recPw.body, res.body);
    check('§1 Reconnect (password) body still promises reattach',
        /reattach/i.test(recPw.body), true);
    check('§1 Reconnect (password) body does not say tmux is dropped',
        /without reattaching tmux/i.test(recPw.body), false);
    checkNot('§1 the two Reconnect variants are distinguishable',
        recPw.iconSymbol, rec.iconSymbol);

    // Reset: the one destructive action, and the only one that drops tmux.
    check('§1 Reset body says tmux is not reattached',
        /without reattaching tmux/i.test(res.body), true);
    check('§1 Reset accept IS the danger button', res.acceptDanger, true);
    check('§1 Reset icon is rotate-ccw', res.iconSymbol, 'icon-rotate-ccw');

    // Close: destructive, but it starts nothing.
    check('§1 Close body does not promise a fresh session',
        /fresh session/i.test(clo.body), false);
    check('§1 Close body says the tmux session is closed',
        /tmux/i.test(clo.body), true);
    check('§1 Close accept IS the danger button', clo.acceptDanger, true);
    check('§1 Close icon is x', clo.iconSymbol, 'icon-x');

    // A stale data-i18n key on either element would let the next language
    // change silently retranslate this dialog into a DIFFERENT action's words.
    check('§1 body carries no stale i18n key', res.bodyKey, null);
    check('§1 accept carries no stale i18n key', res.acceptKey, null);

    await ctx.close();
}

/* ═══ §2 no stale state: every field is rewritten on EVERY open ═══════════ */
{
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-stale');

    // Reset FIRST, then Reconnect. If any field were left to the markup or to
    // whatever the previous open wrote, Reconnect would now be showing Reset's
    // copy -- which is exactly the shape of the original defect.
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reset'));
    await page.waitForTimeout(100);
    const first = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(100);
    const second = await dialogState(page);

    check('§2 reset→reconnect: body was rewritten', second.body === first.body, false);
    check('§2 reset→reconnect: danger class was cleared', second.acceptDanger, false);
    check('§2 reset→reconnect: icon was rewritten',
        second.iconSymbol === first.iconSymbol, false);
    check('§2 reset→reconnect: accept label was rewritten',
        second.acceptLabel === first.acceptLabel, false);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    // And the other direction: reconnect leaves no non-danger state behind that
    // would make Reset look harmless.
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reset'));
    await page.waitForTimeout(100);
    const third = await dialogState(page);
    check('§2 reconnect→reset: danger class was re-applied', third.acceptDanger, true);
    check('§2 reconnect→reset: body is Reset copy again', third.body, first.body);
    check('§2 reconnect→reset: icon is Reset icon again',
        third.iconSymbol, first.iconSymbol);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());

    // Closed-state hygiene is unchanged by the parameterization.
    await page.waitForTimeout(80);
    const closed = await page.evaluate(() => {
        const d = document.getElementById('sessionConfirm');
        return { hidden: d.hidden, inert: d.hasAttribute('inert'),
                 display: getComputedStyle(d).display };
    });
    check('§2 dialog is hidden after Cancel', closed.hidden, true);
    check('§2 dialog is inert after Cancel', closed.inert, true);
    check('§2 dialog computes display:none after Cancel', closed.display, 'none');

    await ctx.close();
}

/* ═══ §3 password reconnect: ONE ssh_connect that REATTACHES ══════════════ */
{
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-pw', { authType: 'password', tmux: 'tmux_keepme' });

    await clearEmitted(page);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);

    // The dialog says up front that a password will be asked for, so the modal
    // is not a surprise that reads as "Reconnect did a Reset".
    const dlg = await dialogState(page);
    check('§3 password reconnect dialog names the password step',
        /password/i.test(dlg.body), true);
    check('§3 password reconnect accept says Enter password',
        dlg.acceptLabel, 'Enter password');
    check('§3 password reconnect accept is not danger', dlg.acceptDanger, false);
    check('§3 password reconnect icon is the key glyph', dlg.iconSymbol, 'icon-key-round');

    await page.evaluate(() => document.getElementById('sessionConfirmAccept').click());
    await page.waitForTimeout(200);

    // Accepting must NOT emit a doomed ssh_reconnect (the server would answer
    // password_required and spend a rate-limit slot), and must NOT disconnect.
    const afterAccept = await emitted(page);
    check('§3 accept emits nothing on the wire yet', afterAccept.length, 0);
    // PLACEHOLDER-S3

    const state = await page.evaluate(() => ({
        modal: !!document.getElementById('connectionModal')?.classList.contains('show'),
        host: document.getElementById('hostInput')?.value || null,
        user: document.getElementById('usernameInput')?.value || null,
        tmuxChecked: !!document.getElementById('useTmuxCheck')?.checked,
        // The intent lives in the request-keyed registry now; the one serving
        // the credential modal is the one this action just armed.
        meta: (() => {
            const m = SessionManager.activeReconnectIntent();
            return m ? { sessionId: m.sessionId, tmux: m.tmuxSessionName,
                hasPassword: Object.prototype.hasOwnProperty.call(m, 'password') }
                : null;
        })(),
        sessionStillThere: !!SessionManager.sessions['S-pw'],
        resetMeta: SessionManager.pendingResetMeta,
    }));
    check('§3 credential form opened', state.modal, true);
    check('§3 target host preserved', state.host, 'live.example');
    check('§3 target user preserved', state.user, 'u');
    check('§3 tmux stays checked', state.tmuxChecked, true);
    check('§3 reconnect intent recorded', !!state.meta, true);
    check('§3 intent names the SAME session', state.meta?.sessionId, 'S-pw');
    check('§3 intent carries the EXISTING tmux name', state.meta?.tmux, 'tmux_keepme');
    check('§3 intent holds no password field', state.meta?.hasPassword, false);
    check('§3 the live session is untouched while the form is open',
        state.sessionStillThere, true);
    check('§3 reset intent was NOT set', state.resetMeta, null);

    // Submit the form the way the user would.
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(250);

    const wire = await emitted(page);
    const connects = wire.filter(e => e.name === 'ssh_connect');
    const disconnects = wire.filter(e => e.name === 'ssh_disconnect');
    const reconnects = wire.filter(e => e.name === 'ssh_reconnect');
    check('§3 exactly ONE ssh_connect', connects.length, 1);
    check('§3 no ssh_disconnect (that would kill the tmux session)',
        disconnects.length, 0);
    check('§3 no ssh_reconnect (the server cannot swap a password session)',
        reconnects.length, 0);
    check('§3 payload REATTACHES by name',
        connects[0]?.reconnect_tmux_name, 'tmux_keepme');
    check('§3 payload keeps tmux enabled', connects[0]?.use_tmux, true);
    checkNot('§3 payload does NOT disable tmux', connects[0]?.use_tmux, false);
    check('§3 payload carries the reconnect request id',
        /^reconnect_/.test(connects[0]?.client_request_id || ''), true);
    // W13-B5 gate 3: the SOURCE session id travels with the claim, so the
    // server binds the reattach to the exact row and refuses a name that
    // belongs to any other session. A payload without it is refused.
    check('§3 payload BINDS to the source session id',
        connects[0]?.session_id, 'S-pw');

    await ctx.close();
}

/* ═══ §4 the transcript survives, and the old session is retired safely ═══ */
{
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-t', { authType: 'password', tmux: 'tmux_hist' });

    // Give the old session a transcript the way live output would.
    await page.evaluate(() => {
        window.__server('ssh_output', { session_id: 'S-t', data: 'OLD-HISTORY-LINE\n' });
    });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() =>
        TerminalManager.getTranscript('S-t').includes('OLD-HISTORY-LINE'));
    check('§4 the old session has a transcript to lose', before, true);

    await clearEmitted(page);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    await page.evaluate(() => document.getElementById('sessionConfirmAccept').click());
    await page.waitForTimeout(150);
    // The request id is captured BEFORE the submit. Submitting releases the
    // credential MODAL (the form is gone), while the intent itself stays in the
    // registry waiting for its reply -- which is exactly the separation that lets
    // several reconnects be in flight at once.
    const reqId = await page.evaluate(() =>
        SessionManager.activeReconnectIntent()?.requestId || null);
    check('§4 the in-flight reconnect has a request id', typeof reqId, 'string');
    await page.evaluate(() => {
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(200);

    // The old session is STILL there until the replacement actually exists: a
    // failed connect must not leave the user with nothing.
    const midFlight = await page.evaluate(() => ({
        old: !!SessionManager.sessions['S-t'],
        transcript: TerminalManager.getTranscript('S-t').includes('OLD-HISTORY-LINE'),
    }));
    check('§4 old session still alive while the connect is in flight',
        midFlight.old, true);
    check('§4 its transcript is still intact in flight', midFlight.transcript, true);

    // Now the server answers with the NEW session id, reattached to the same
    // tmux name, correlated by the request id captured above.
    await page.evaluate((rid) => {
        window.__server('ssh_connected', {
            session_id: 'S-t2', host: 'live.example', port: 22, username: 'u',
            auth_type: 'password', use_tmux: true, tmux_session_name: 'tmux_hist',
            key_id: null, display_name: null, client_request_id: rid,
        });
    }, reqId);
    await page.waitForTimeout(250);

    const after = await page.evaluate(() => ({
        newHasHistory: TerminalManager.getTranscript('S-t2').includes('OLD-HISTORY-LINE'),
        oldGone: !SessionManager.sessions['S-t'],
        oldTranscriptGone: !TerminalManager.transcripts['S-t'],
        oldSizeGone: TerminalManager.transcriptSizes['S-t'] === undefined,
        newSessionTmux: SessionManager.sessions['S-t2']?.tmuxSessionName || null,
        // Consumed by client_request_id: the registry must be empty and no
        // session left claimed.
        metaCleared: Object.keys(SessionManager.reconnectIntents).length === 0
            && Object.keys(SessionManager.reconnectingSessions || {}).length === 0
            ? null : SessionManager.reconnectIntents,
    }));
    check('§4 the NEW session inherited the transcript', after.newHasHistory, true);
    check('§4 the old session was retired', after.oldGone, true);
    check('§4 the old transcript key is gone (no orphan)', after.oldTranscriptGone, true);
    check('§4 the old size key is gone (no orphan)', after.oldSizeGone, true);
    check('§4 the new session carries the SAME tmux name',
        after.newSessionTmux, 'tmux_hist');
    check('§4 the reconnect intent was consumed', after.metaCleared, null);

    // The retirement must NOT have gone out as ssh_disconnect: that kills the
    // tmux session the new connection has just reattached to.
    const wire = await emitted(page);
    check('§4 no ssh_disconnect anywhere in the handoff',
        wire.filter(e => e.name === 'ssh_disconnect').length, 0);

    await ctx.close();
}

/* ═══ §5 key and Tailscale keep the genuine transport swap ════════════════ */
for (const [label, opts] of [
    ['key', { authType: 'key', keyId: 'k1', tmux: 'tmux_k' }],
    ['tailscale', { authType: 'tailscale', tmux: 'tmux_ts' }],
]) {
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-sw', opts);
    await clearEmitted(page);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    const dlg = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmAccept').click());
    await page.waitForTimeout(200);

    const wire = await emitted(page);
    const state = await page.evaluate(() => ({
        modal: !!document.getElementById('connectionModal')?.classList.contains('show'),
        meta: SessionManager.activeReconnectIntent(),
        sessionAlive: !!SessionManager.sessions['S-sw'],
    }));
    check(`§5 ${label}: accept emits ssh_reconnect`,
        wire.filter(e => e.name === 'ssh_reconnect').length, 1);
    check(`§5 ${label}: it names the SAME session id`,
        wire.find(e => e.name === 'ssh_reconnect')?.session_id, 'S-sw');
    check(`§5 ${label}: no ssh_connect (that would be a new session)`,
        wire.filter(e => e.name === 'ssh_connect').length, 0);
    check(`§5 ${label}: no ssh_disconnect`,
        wire.filter(e => e.name === 'ssh_disconnect').length, 0);
    check(`§5 ${label}: no credential form`, state.modal, false);
    check(`§5 ${label}: no reconnect meta needed`, state.meta, null);
    check(`§5 ${label}: the session is untouched`, state.sessionAlive, true);
    check(`§5 ${label}: dialog offered the immediate Reconnect label`,
        dlg.acceptLabel, 'Reconnect');
    check(`§5 ${label}: dialog was not destructive`, dlg.acceptDanger, false);

    // The swap answer keeps the SAME id, so nothing is adopted or retired.
    await page.evaluate(() => window.__server('ssh_reconnected', {
        session_id: 'S-sw', use_tmux: true, tmux_session_name: 'tmux_after',
    }));
    await page.waitForTimeout(150);
    const post = await page.evaluate(() => ({
        alive: !!SessionManager.sessions['S-sw'],
        tmux: SessionManager.sessions['S-sw']?.tmuxSessionName || null,
        connected: !!SessionManager.sessions['S-sw']?.connected,
    }));
    check(`§5 ${label}: same session survives the swap`, post.alive, true);
    check(`§5 ${label}: it is connected again`, post.connected, true);
    check(`§5 ${label}: the server's tmux name was adopted`, post.tmux, 'tmux_after');

    await ctx.close();
}

/* ═══ §6 Reset alone discards tmux intent, and only after its confirm ═════ */
{
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-rst', { authType: 'key', keyId: 'k1', tmux: 'tmux_gone' });
    await clearEmitted(page);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reset'));
    await page.waitForTimeout(120);

    // Nothing may go out before the destructive confirmation is accepted.
    check('§6 nothing emitted while the confirm is open',
        (await emitted(page)).length, 0);
    check('§6 the session is still alive while the confirm is open',
        await page.evaluate(() => !!SessionManager.sessions['S-rst']), true);

    await page.evaluate(() => document.getElementById('sessionConfirmAccept').click());
    await page.waitForTimeout(250);

    const wire = await emitted(page);
    const connects = wire.filter(e => e.name === 'ssh_connect');
    check('§6 Reset emits exactly one ssh_connect', connects.length, 1);
    check('§6 Reset DISABLES tmux', connects[0]?.use_tmux, false);
    check('§6 Reset drops the tmux name', connects[0]?.reconnect_tmux_name, null);
    check('§6 Reset uses a reset_* request id',
        /^reset_/.test(connects[0]?.client_request_id || ''), true);
    check('§6 Reset carries no password property', connects[0]?.has_password, false);
    // Reset is the destructive route, so it DOES disconnect the old session --
    // the exact opposite of the reconnect path, and the reason the two must
    // never share a confirmation.
    check('§6 Reset disconnects the original session',
        wire.filter(e => e.name === 'ssh_disconnect').length, 1);
    check('§6 no reconnect intent was created',
        await page.evaluate(() => SessionManager.activeReconnectIntent()), null);

    await ctx.close();
}

/* ═══ §7 all three surfaces route through the same semantic actions ═══════ */
{
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-surf', { authType: 'key', keyId: 'k1' });

    // Surface A: the per-row sheet button, clicked as a user would.
    await clearEmitted(page);
    await page.evaluate(() => document.getElementById('sessionActionReconnect').click());
    await page.waitForTimeout(120);
    const viaSheet = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    // Surface B: the touch toolbar proxy, which forwards to the same control.
    await page.evaluate(() => document.getElementById('touchReconnectBtn')?.click());
    await page.waitForTimeout(150);
    const viaProxy = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    // Surface C: the programmatic dispatch the keyboard/menu paths use.
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    const viaDispatch = await dialogState(page);
    await page.evaluate(() => document.getElementById('sessionConfirmCancel').click());
    await page.waitForTimeout(60);

    for (const [label, d] of [['sheet', viaSheet], ['touch proxy', viaProxy],
                              ['dispatch', viaDispatch]]) {
        check(`§7 ${label} opened the confirm`, d.open, true);
        check(`§7 ${label} shows the Reconnect body`, d.body, viaSheet.body);
        check(`§7 ${label} shows the Reconnect accept`,
            d.acceptLabel, viaSheet.acceptLabel);
        check(`§7 ${label} shows the Reconnect icon`, d.iconSymbol, viaSheet.iconSymbol);
        check(`§7 ${label} is not destructive`, d.acceptDanger, false);
    }

    // Disconnected-row targeting stays atomic: acting on the selected row must
    // target THAT row, not the other one.
    //
    // The tmux names use the SERVER'S whitelist alphabet (^[A-Za-z0-9_]{1,190}$,
    // socket_events.handle_ssh_connect). A hyphenated fixture name is one the
    // server would reject outright, so the client's local identity check now
    // refuses to reconnect it (W13-B5: never arm a doomed reattach) -- pinning
    // that shape would assert a form that can never produce a working payload.
    await seedLive(page, 'S-a', { host: 'a.example', authType: 'password',
        tmux: 'tmux_Sa' });
    await seedLive(page, 'S-b', { host: 'b.example', authType: 'password',
        tmux: 'tmux_Sb' });
    await page.evaluate(() => {
        window.__server('ssh_disconnected', { session_id: 'S-a', reason: 'test' });
        window.__server('ssh_disconnected', { session_id: 'S-b', reason: 'test' });
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => SessionManager.setLifecycleActionTarget('S-a'));
    await clearEmitted(page);
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(200);
    const atomic = await page.evaluate(() => ({
        target: SessionManager.lifecycleActionTargetId,
        host: document.getElementById('hostInput')?.value || null,
        modal: !!document.getElementById('connectionModal')?.classList.contains('show'),
        // The tmux name travels in the request-keyed intent, not in a shared
        // global another connection in flight could blank.
        pendingTmux: SessionManager.activeReconnectIntent()?.tmuxSessionName
            || null,
    }));
    check('§7 disconnected row: the selected row is the target', atomic.target, 'S-a');
    check('§7 disconnected row: the form is prefilled for THAT host',
        atomic.host, 'a.example');
    check('§7 disconnected row: the form opened', atomic.modal, true);
    check('§7 disconnected row: its own tmux name is pending',
        atomic.pendingTmux, 'tmux_Sa');
    check('§7 disconnected row: nothing was emitted before submit',
        (await emitted(page)).length, 0);

    await ctx.close();
}

/* ═══ §8 a cancelled modal leaves NO intent for a later Connect ═══════════ */
for (const closer of ['closeConnectionModal', 'cancelConnectionBtn']) {
    const { ctx, page } = await newPage();
    await seedLive(page, 'S-c', { authType: 'password', tmux: 'tmux_c' });
    await page.evaluate(() => SessionManager.dispatchLifecycleAction('reconnect'));
    await page.waitForTimeout(120);
    await page.evaluate(() => document.getElementById('sessionConfirmAccept').click());
    await page.waitForTimeout(150);
    check(`§8 ${closer}: intent exists before cancelling`,
        await page.evaluate(() => !!SessionManager.activeReconnectIntent()), true);

    await page.evaluate((id) => document.getElementById(id).click(), closer);
    await page.waitForTimeout(120);
    const afterCancel = await page.evaluate(() => ({
        reconnectMeta: SessionManager.activeReconnectIntent(),
        resetMeta: SessionManager.pendingResetMeta,
        sessionAlive: !!SessionManager.sessions['S-c'],
    }));
    check(`§8 ${closer}: reconnect intent cleared`, afterCancel.reconnectMeta, null);
    check(`§8 ${closer}: reset intent cleared`, afterCancel.resetMeta, null);
    check(`§8 ${closer}: the live session is still there`,
        afterCancel.sessionAlive, true);

    // A LATER ordinary Connect must not inherit the abandoned intent.
    await clearEmitted(page);
    await page.evaluate(() => {
        document.getElementById('hostInput').value = 'other.example';
        document.getElementById('portInput').value = '22';
        document.getElementById('usernameInput').value = 'someone';
        document.getElementById('authTypeSelect').value = 'password';
        document.getElementById('passwordInput').value = 'typed-by-user';
        document.getElementById('useTmuxCheck').checked = false;
        document.getElementById('connectionForm')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(200);
    const wire = await emitted(page);
    const connect = wire.find(e => e.name === 'ssh_connect');
    check(`§8 ${closer}: the later Connect is an ordinary req_* connect`,
        /^req_/.test(connect?.client_request_id || ''), true);
    check(`§8 ${closer}: it did not inherit a tmux name`,
        connect?.reconnect_tmux_name, null);
    check(`§8 ${closer}: it did not disconnect the old session`,
        wire.filter(e => e.name === 'ssh_disconnect').length, 0);

    await ctx.close();
}

/* ═══ §9 DEFECT 1 static contract: the tmux command, per measurement ══════ */
{
    const mgr = fs.readFileSync(path.join(ROOT, 'app/ssh_manager.py'), 'utf8');

    /*
     * The defect was that auth_type decided how a pane handles multi-byte
     * input: Tailscale sessions got `env LANG=C.UTF-8 LC_ALL=C.UTF-8` and
     * password sessions got nothing. Measured on the live target
     * (tests/browser/defect1_pane_locale_ime_probe.py, tmux 3.4): a pane with no
     * locale resolves charmap ANSI_X3.4-1968, readline runs `convert-meta on`,
     * and composed Vietnamese typed one character at a time -- the shape an IME
     * commit has -- comes back as "ting Vit xin cho". The same bytes in one bulk
     * write, and the same per-character delivery into `cat`, are byte-exact, so
     * the loss is readline+locale and every auth type is equally exposed.
     */
    const tmuxStart = mgr.indexOf('def build_tmux_command');
    // Bounded by the NEXT top-level def, not by a byte count: the docstring
    // records what W13-B5 removed and why, so it grew past any fixed window and
    // a fixed window silently stopped covering the code it was asserting on.
    const tmuxEnd = mgr.indexOf('\ndef ', tmuxStart + 1);
    const tmuxRegion = mgr.slice(tmuxStart, tmuxEnd);
    check('§9 the tmux command builder exists',
        /def build_tmux_command\(/.test(mgr), true);
    // S34 parameterised the verb with `{control_flag}` (empty string on the
    // legacy path, ' -CC' under the control-mode transport), so the literal
    // `tmux -u` became `tmux{control_flag} -u`. The property is unchanged: the
    // slice must reach the RETURN, not stop inside the docstring.
    check('§9 the region really reaches the builder body',
        tmuxEnd > tmuxStart
            && /return \(?f'\{prefix\}tmux(\{control_flag\})?/.test(tmuxRegion),
        true);
    check('§9 the builder takes NO auth_type argument',
        /def build_tmux_command\([^)]*auth_type/.test(mgr), false);
    check('§9 no auth_type branch decides the tmux command',
        /auth_type\s*==\s*'tailscale'/.test(tmuxRegion), false);

    /*
     * LC_CTYPE, not LC_ALL. LC_CTYPE is the only category that decides
     * multi-byte handling; LC_ALL would also override the target's own
     * messages, collation and time formats -- a user-visible change nobody
     * asked for.
     *
     * RETARGETED from the literal pair `('LANG', 'C.UTF-8')` to the
     * declarations that now produce it. The value became HOST-ADAPTIVE: measured
     * on tmux 3.4, `-e LC_CTYPE=<a locale the host lacks>` is silently ignored by
     * setlocale and the pane falls back to ANSI_X3.4-1968, i.e. no better than no
     * locale at all -- and this very host lists `C.utf8` and NOT `C.UTF-8`. So the
     * spelling sent is resolved from the target's own `locale -a`, and the pair is
     * composed rather than written literally. The PROPERTIES asserted are
     * unchanged and are still four: which two variables are set, that C.UTF-8
     * remains the fallback when a host tells us nothing, that the candidate list
     * is UTF-8 only, and that LC_ALL is never used.
     */
    check('§9 the UTF-8 env sets LANG and LC_CTYPE, in that order',
        /TMUX_UTF8_ENV_NAMES\s*=\s*\('LANG',\s*'LC_CTYPE'\)/.test(mgr), true);
    check('§9 C.UTF-8 remains the fallback when the host lists nothing',
        /TMUX_UTF8_FALLBACK_LOCALE\s*=\s*'C\.UTF-8'/.test(mgr), true);
    check('§9 the fallback env pair is still built from those two names',
        /TMUX_UTF8_ENV\s*=\s*tuple\(\(name,\s*TMUX_UTF8_FALLBACK_LOCALE\)/.test(mgr),
        true);
    check('§9 every locale candidate is a UTF-8 locale',
        (mgr.match(/TMUX_UTF8_LOCALE_CANDIDATES\s*=\s*\(([^)]*)\)/) || [, ''])[1]
            .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean)
            .every(c => /utf-?8$/i.test(c)), true);
    check('§9 the UTF-8 env does NOT set LC_ALL',
        /'LC_ALL'/.test(mgr.slice(mgr.indexOf('TMUX_UTF8_ENV_NAMES'),
            mgr.indexOf('TMUX_UTF8_ENV_NAMES') + 1200)), false);

    /*
     * `-e` reaches the SESSION, which is why it works where the old prefix did
     * not: a tmux server's environment is fixed by its FIRST client, so
     * `env ... tmux new-session` on a reconnect only set the short-lived
     * client's environment and the pane inherited the server's. Measured:
     * prefix-on-attach left the pane at ANSI_X3.4-1968 with per-char input still
     * broken.
     *
     * RETARGETED (W13-B5): the reattach no longer carries `-e` at all, because
     * it no longer uses `new-session`. `new-session -A` attaches when the
     * session exists and CREATES when it does not, so a session that vanished
     * between validation and execution was silently replaced by an empty pane
     * wearing its identity. The reattach is now attach-only, and the locale
     * belongs to the brand-new launch -- which is the only one that can create.
     *
     * RETARGETED AGAIN (views,): the ATTACH is built by its own
     * function, `build_tmux_attach_command`, because it is now run by each
     * browser socket's view rather than by the transport. `build_tmux_command`
     * is create-only and creates DETACHED (`-d`): an attached client launched
     * by the transport would be permanent and unresized, and `window-size
     * smallest` would pin every real device to its 80x24 default forever.
     */
    check('§9 the env is passed per-session with -e',
        /-e \{name\}=\{value\}/.test(mgr), true);
    // Every invocation still carries -u; it now sits after the optional flag.
    check('§9 -u is asserted on every invocation',
        (mgr.match(/tmux(\{control_flag\})? -u /g) || []).length >= 2, true);
    check('§9 the attach is attach-only with an exact-match target',
        /'tmux -u attach-session -t ' \+ shlex\.quote\(f'=\{tmux_session_name\}'\)/
            .test(mgr.replace(/\s+/g, ' ')), true);
    check('§9 the attach has its own builder, run per view',
        /def build_tmux_attach_command\(tmux_session_name\)/.test(mgr), true);
    // Asserted against the builder's CODE, not its docstring: the docstring
    // names `new-session -A` deliberately, to record what was removed and why.
    const tmuxCode = tmuxRegion.slice(
        tmuxRegion.indexOf('"""', tmuxRegion.indexOf('"""') + 3) + 3);
    check('§9 no attach-or-create verb survives in the builder code',
        /new-session -A/.test(tmuxCode), false);
    check('§9 the create is the only launch the builder emits, and it is detached',
        /return \(f'\{prefix\}tmux -u new-session -d\{env_args\} ' f'-s \{tmux_session_name\}'\)/
            .test(tmuxCode.replace(/\s+/g, ' ')), true);
    check('§9 the builder cannot attach at all (that is the view\'s job)',
        /attach-session/.test(tmuxCode), false);

    // Pre-3.2 has no per-session -e (it is a usage error that kills the
    // channel), so those servers keep the legacy prefix rather than break.
    check('§9 a version floor for -e is declared',
        /TMUX_MIN_VERSION_FOR_SESSION_ENV\s*=\s*\(3,\s*2\)/.test(mgr), true);
    check('§9 old tmux falls back to the client-side prefix',
        /prefix = \('env '/.test(mgr), true);
    /*
     * The probe still answers the tmux question, and it must answer it LAST.
     *
     * RETARGETED: the one round trip now also carries `locale -a`,
     * because the locale name is resolved from the host. `tmux -V` stays at the
     * END so the channel's exit status remains tmux's own availability signal --
     * flipping the order would let `locale -a` decide it and a tmux-less host
     * would look available, taking the tmux path instead of the raw-shell
     * fallback.
     */
    check('§9 the probe still reads the tmux version',
        /TMUX_PROBE_COMMAND\s*=/.test(mgr) && /tmux -V/.test(mgr), true);
    check('§9 the probe command ends with tmux -V',
        /f'tmux -V'\)/.test(mgr), true);
    check('§9 the probe also reads the host locale listing',
        /locale -a 2>\/dev\/null/.test(mgr), true);
    check('§9 the two halves are separated by an explicit sentinel',
        /TMUX_PROBE_SENTINEL\s*=\s*'__SSHDECK_PROBE_BOUNDARY__'/.test(mgr), true);
    check('§9 the resolved locale is wired into the command',
        /utf8_locale=utf8_locale/.test(mgr), true);

    // Every dialog string the fix introduced exists in all six locales, or a
    // language switch would blank a confirmation body.
    // The six languages were split out of i18n.js, so the page
    // carries English plus the reader's own. Joined here, the count per key
    // still has to be one per language.
    const i18nSrc = ['en', 'vi', 'de', 'fr', 'es', 'zh']
        .map(lang => fs.readFileSync(path.join(ROOT, `static/js/i18n/${lang}.js`), 'utf8'))
        .join('\n');
    for (const key of ['session.reconnectBody', 'session.reconnectBodyPassword',
        'session.reconnectAccept', 'session.reconnectAcceptPassword',
        'session.closeBody', 'session.closeAccept',
        'session.reconnectPasswordPrompt']) {
        const n = (i18nSrc.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'g')) || []).length;
        check(`§9 ${key} present in all six locales`, n, 6);
    }

    // The markup must carry NO action-specific copy: a default left there is a
    // default one action inherits from another, which is the whole defect.
    const tpl = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    const dialog = tpl.slice(tpl.indexOf('id="sessionConfirmBackdrop"'),
        tpl.indexOf('</section>', tpl.indexOf('id="sessionConfirm"')));
    check('§9 dialog body carries no baked-in i18n key',
        /id="sessionConfirmBody"[^>]*data-i18n/.test(dialog), false);
    check('§9 dialog accept carries no baked-in i18n key',
        /id="sessionConfirmAccept"[^>]*data-i18n/.test(dialog), false);
    check('§9 dialog accept carries no baked-in danger class',
        /id="sessionConfirmAccept"[^>]*session-confirm-danger/.test(dialog), false);
    check('§9 the icon is addressable by id', /id="sessionConfirmIcon"/.test(dialog), true);

    // openSessionConfirm must accept all six, not just the title. (W13-B7
    // added onDismiss: the dismissal hook that releases the per-candidate
    // double-Reset guard.)
    const sm = fs.readFileSync(path.join(ROOT, 'static/js/session-manager.js'), 'utf8');
    check('§9 openSessionConfirm takes every field',
        /openSessionConfirm\(\{ title, body, acceptLabel, icon, danger, onAccept, onDismiss \}\)/
            .test(sm), true);
    check('§9 the transcript handoff exists',
        /adoptTranscript\(fromSessionId, toSessionId\)/.test(
            fs.readFileSync(path.join(ROOT, 'static/js/terminal-manager.js'), 'utf8')), true);
    check('§9 the reconnect completion retires with removeSessionUI, not closeSession',
        /completePendingReconnect\(newSessionId, requestId\)[\s\S]{0,1600}removeSessionUI\(oldId\)/
            .test(sm), true);
    // And it is CORRELATED: the reply's client_request_id is what selects the
    // intent, so an ordinary connect (or another reconnect) completing in
    // between cannot retire this session or adopt its transcript.
    check('§9 completion consumes the intent by exact request id',
        /completePendingReconnect\(newSessionId, requestId\) \{[\s\S]{0,400}takeReconnectIntent\(requestId\)/
            .test(sm), true);
    check('§9 the ssh_connected handler passes the request id through',
        /completePendingReconnect\(sessionId, data\.client_request_id\)/.test(
            fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8')), true);
}

console.log(`\n${pass} passed, ${fail} failed.`);
check('no page errors', pageErrors.length ? pageErrors.join(' | ') : 'none', 'none');

/*
 * Teardown, and it must be explicit.
 *
 * A Playwright browser and a listening http server are both live handles: with
 * either one open node keeps the event loop alive and the process never exits,
 * so the run LOOKS like a hang after the last line of output. Closing both and
 * exiting on the failure count is what makes this suite usable from a gate
 * script.
 */
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
