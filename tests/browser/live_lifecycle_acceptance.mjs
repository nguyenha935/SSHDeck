/*
 * GAP 2B — Reset vs Reconnect through the REAL deployed UI and the REAL backend.
 *
 * lifecycle_entry_matrix.mjs proves the FRONTEND contract with a stubbed socket
 * (which dialog arms which emit). /tmp/telexprobe/lifecycle_backend.py proves
 * what ssh_manager does when those emits arrive. Neither drives the two ends
 * together, which is what this suite does: a real browser, a real login against
 * the deployment, a real tmux session, Reconnect and Reset taken through their
 * real entry points — and after each, the HOST's own tmux state read out of band
 * rather than inferred from the page.
 *
 * The target is the password account from the live credentials file, so:
 *   * Reconnect on a password session is routed by the SERVER to the credential
 *     form ('password_required') — designed behaviour, because the server holds
 *     no replayable secret. The reconnect INTENT must survive that routing: the
 *     resulting ssh_connect must carry the SAME reconnect_tmux_name and the pane
 *     must come back with its scrollback.
 *   * Reset must emit ssh_disconnect + ssh_connect{use_tmux:false,
 *     reconnect_tmux_name:null}, kill the old tmux ON THE HOST, and produce a
 *     session with no tmux identity.
 *
 * CLEANUP DISCIPLINE
 * Everything this run creates is recorded in LEDGER as an EXACT id or name at
 * the moment it is created. Cleanup runs in a top-level `finally`, so it happens
 * on a failed assertion and on a thrown exception alike, and it may only act on
 * those exact values — never a regex, prefix, wildcard, or "all sessions".
 * Anything it cannot remove is REPORTED for supervision instead of guessed at.
 * The SSHDeck account is never deleted here: the app's only delete path is
 * admin-authenticated, so the account identity is written to a ledger file and
 * removal is a separate, explicitly-approved step.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

const BASE = liveConfig().LIVE_BASE;
const NOTES = 'the live credentials file';
const LEDGER_FILE = '/tmp/live-lifecycle-ledger.json';
const creds = liveCreds();
const SSH_HOST = creds.ssh_target || creds.tailnet_host;
const SSH_USER = creds.host_ssh_user;
const SSH_PASS = creds.host_ssh_password;
const SSHDECK_PASS = creds.sshdeck_password;
const RUN = Date.now().toString(36);
const SSHDECK_USER = `${creds.sshdeck_user}lc${RUN}`;
if (!SSH_HOST || !SSH_USER || !SSH_PASS || !SSHDECK_PASS) {
    throw new Error(`incomplete credentials in ${CREDS_FILE}`);
}
const MARK = `LC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/*
 * THE LEDGER — the only thing cleanup is allowed to act on.
 *
 * Every entry is an EXACT identifier recorded the moment the resource is
 * observed to exist. Cleanup iterates this list and nothing else, so a resource
 * that predates the run cannot be reached even by accident.
 */
const LEDGER = {
    account: { username: SSHDECK_USER, id: null },
    sessionIds: [],        // exact SessionManager/DB session ids
    tmuxNames: [],         // exact host-side tmux session names
};
const noteSession = (id) => {
    if (id && !LEDGER.sessionIds.includes(id)) LEDGER.sessionIds.push(id);
};
const noteTmux = (name) => {
    if (name && !LEDGER.tmuxNames.includes(name)) LEDGER.tmuxNames.push(name);
};

const results = [];
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ label, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) {
        console.log(`        got=${JSON.stringify(got)} `
            + `want=${JSON.stringify(want)}`);
    }
    return ok;
};

/*
 * Host-side tmux truth for the TARGET user, read out of band.
 *
 * The suite's SSH target is this same machine, so the sessions the product
 * creates are visible here. `su -s /bin/sh <user> -c 'tmux ... ls'` is read-only:
 * it lists, never attaches, kills, renames or resizes. The socket path is given
 * explicitly because tmux resolves $TMUX_TMPDIR per-uid and `su` does not carry
 * it.
 */
const uid = execFileSync('id', ['-u', SSH_USER]).toString().trim();
const SOCKET = `/tmp/tmux-${uid}/default`;
const hostTmux = () => {
    try {
        const out = execFileSync('su', ['-s', '/bin/sh', SSH_USER, '-c',
            `tmux -S ${SOCKET} ls -F '#{session_name} #{session_created}'`],
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const map = {};
        for (const line of out.split('\n')) {
            const p = line.trim().split(/\s+/);
            if (p.length === 2) map[p[0]] = p[1];
        }
        return map;
    } catch {
        return {};
    }
};

/*
 * Kill ONE tmux session, addressed by its exact name with `=` (tmux's
 * exact-match prefix, so a name is never treated as a pattern). Refuses any
 * name not in the ledger and any name present in the pre-run snapshot.
 */
const killExactTmux = (name, preRun) => {
    if (!LEDGER.tmuxNames.includes(name)) {
        console.log(`  REFUSED (not in ledger): ${name}`);
        return false;
    }
    if (Object.prototype.hasOwnProperty.call(preRun, name)) {
        console.log(`  REFUSED (existed before this run): ${name}`);
        return false;
    }
    try {
        execFileSync('su', ['-s', '/bin/sh', SSH_USER, '-c',
            `tmux -S ${SOCKET} kill-session -t '=${name}'`],
        { stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(`  killed exact tmux session: ${name}`);
        return true;
    } catch (err) {
        console.log(`  could not kill ${name}: `
            + `${String(err.message || err).slice(0, 80)}`);
        return false;
    }
};

const tmuxBefore = hostTmux();
console.log('=== GAP 2B — Reset vs Reconnect, real UI + real backend ===');
console.log(`target: ${BASE}   marker: ${MARK}`);
console.log(`account this run will create: ${SSHDECK_USER}`);
console.log(`host tmux sessions for the target user BEFORE: `
    + `${Object.keys(tmuxBefore).length}`);
console.log();

let browser = null;
let ctx = null;
let page = null;
const pageErrors = [];

try {
    browser = await chromium.launch();
    ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    });
    page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));

    // Record every lifecycle emit the page makes, so the assertions are about
    // what the product actually sent -- not about what the UI looked like.
    await page.addInitScript(() => {
        window.__emits = [];
        const wait = setInterval(() => {
            if (!window.socket) return;
            clearInterval(wait);
            const real = window.socket.emit.bind(window.socket);
            window.socket.emit = (ev, payload, ...rest) => {
                if (['ssh_connect', 'ssh_disconnect', 'ssh_reconnect']
                    .includes(ev)) {
                    window.__emits.push({
                        ev,
                        session_id: payload?.session_id,
                        use_tmux: payload?.use_tmux,
                        reconnect_tmux_name: payload?.reconnect_tmux_name,
                        hasPassword: Object.prototype.hasOwnProperty.call(
                            payload || {}, 'password'),
                    });
                }
                return real(ev, payload, ...rest);
            };
        }, 50);
    });

    const emits = () => page.evaluate(() => window.__emits.slice());
    const clearEmits = () => page.evaluate(() => { window.__emits.length = 0; });

    const paneLines = sid => page.evaluate(id => {
        const buf = window.TerminalManager?.terminals?.[id]?.buffer?.active;
        if (!buf) return [];
        const out = [];
        for (let i = 0; i < buf.length; i++) {
            out.push(buf.getLine(i)?.translateToString(true) || '');
        }
        return out;
    }, sid);

    const paneHas = async (sid, needle) =>
        (await paneLines(sid)).some(l => l.includes(needle));

    const waitPaneHas = (sid, needle, timeout = 20000) => page.waitForFunction(
        ({ id, text }) => {
            const buf = window.TerminalManager?.terminals?.[id]?.buffer?.active;
            if (!buf) return false;
            for (let i = 0; i < buf.length; i++) {
                if ((buf.getLine(i)?.translateToString(true) || '')
                    .includes(text)) return true;
            }
            return false;
        }, { id: sid, text: needle }, { timeout }).then(() => true, () => false);
    // ── §0 register a fresh account, connect one tmux session ───────────────
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#username').fill(SSHDECK_USER);
    await page.locator('#password').fill(SSHDECK_PASS);
    await page.locator('#confirm_password').fill(SSHDECK_PASS);
    await page.locator('#submitBtn').click();
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    /*
     * S25 R4 -- WAIT FOR THE WHOLE SCRIPT SET, NOT JUST TWO GLOBALS.
     *
     * Measured, not reasoned (/tmp/s16work/s23_pinrace.out): at the
     * `SessionManager && TerminalManager` gate the document can still be
     * `readyState: "loading"` with only 15 of 17 script pins parsed and
     * `hasModalManager: false`. `app.js` is the LAST script tag
     * (templates/index.html:1704) while both of those globals live in EARLIER
     * scripts, so the condition is satisfiable before the page is finished.
     * Clicking #newConnectionBtn then reaches a button whose opener does not
     * exist yet: the modal stays hidden and the gate dies at setup with a
     * 30s locator timeout and near-zero assertions -- exactly what this gate
     * did in the sweep while passing when run alone on an idle box.
     *
     * Waiting for `readyState === 'complete'` is sound rather than a sleep in
     * disguise: every script tag here is a classic script, so they execute in
     * document order and `complete` proves all of them ran.
     */
    await page.waitForFunction(() => document.readyState === 'complete',
        null, { timeout: 30000 });
    check('§0 a fresh account starts with no restored sessions',
        (await page.evaluate(
            () => Object.keys(SessionManager.sessions))).length, 0);

    const connect = async ({ tmux }) => {
        const before = await page.evaluate(
            () => Object.keys(SessionManager.sessions));
        await page.locator('#newConnectionBtn').click();
        await page.locator('#connectionModal').waitFor({ state: 'visible' });
        await page.locator('#hostInput').fill(SSH_HOST);
        await page.locator('#portInput').fill('22');
        await page.locator('#usernameInput').fill(SSH_USER);
        await page.locator('#authTypeSelect').selectOption('password');
        await page.locator('#passwordInput').fill(SSH_PASS);
        const box = page.locator('#useTmuxCheck');
        if (await box.isChecked() !== tmux) await box.setChecked(tmux);
        await page.locator('#connectBtn').click();
        await page.waitForFunction(prev => Object.keys(SessionManager.sessions)
            .some(id => !prev.includes(id)), before, { timeout: 30000 });
        const sid = await page.evaluate(
            prev => Object.keys(SessionManager.sessions)
                .find(id => !prev.includes(id)), before);
        noteSession(sid);
        await page.waitForFunction(
            id => TerminalManager.terminalReady[id] === true, sid,
            { timeout: 30000 });
        const name = await page.evaluate(
            id => SessionManager.sessions[id]?.tmuxSessionName || null, sid);
        noteTmux(name);
        return sid;
    };

    const sid1 = await connect({ tmux: true });
    const tmuxName1 = await page.evaluate(
        id => SessionManager.sessions[id]?.tmuxSessionName, sid1);
    console.log(`  session   : ${sid1}`);
    console.log(`  tmux name : ${tmuxName1}`);
    check('§0 the session carries a tmux identity', typeof tmuxName1, 'string');

    const tmuxAfterConnect = hostTmux();
    check('§0 the HOST really has that tmux session',
        Object.prototype.hasOwnProperty.call(tmuxAfterConnect, tmuxName1), true);
    const created1 = tmuxAfterConnect[tmuxName1];

    // Real work on the pane: Reconnect must preserve it, Reset must not carry
    // it over.
    await page.locator(`#terminal-${sid1} .xterm`).click();
    await page.keyboard.type(`echo ${MARK}-BEFORE`, { delay: 15 });
    await page.keyboard.press('Enter');
    check(`§0 the marker ${MARK}-BEFORE is painted on the pane`,
        await waitPaneHas(sid1, `${MARK}-BEFORE`, 25000), true);
    console.log();

    /*
     * The real entry point at every tier is the chip gesture: tap to select,
     * re-tap to open the action sheet. (#sessionActionsBtn computes
     * display:none on BOTH shells — measured in lifecycle_entry_matrix §0 — so
     * it is not a live trigger.) These helpers take the same route a user does.
     */
    const openSheet = async (id) => {
        const already = await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet')?.hidden);
        if (already) return true;
        await page.click(`#tab-${id}`);
        await page.waitForTimeout(80);
        if (await page.evaluate(() =>
            !document.getElementById('sessionActionsSheet')?.hidden)) return true;
        await page.click(`#tab-${id}`);
        await page.waitForTimeout(80);
        return page.evaluate(() =>
            !document.getElementById('sessionActionsSheet')?.hidden);
    };
    const clickAction = async (action) => {
        await page.click(
            `#sessionActionsSheet [data-lifecycle-action="${action}"]`);
        await page.waitForTimeout(120);
    };
    const readDialog = () => page.evaluate(() => {
        const el = document.getElementById('sessionConfirm');
        const accept = document.getElementById('sessionConfirmAccept');
        return {
            open: !el?.hidden,
            title: document.getElementById('sessionConfirmTitle')
                ?.textContent || '',
            body: document.getElementById('sessionConfirmBody')
                ?.textContent || '',
            accept: accept?.textContent || '',
            // The real class is `session-confirm-danger` (deck.css:1489), which
            // is what lifecycle_entry_matrix.mjs:193 also reads.
            danger: !!accept?.classList.contains('session-confirm-danger'),
            icon: (document.getElementById('sessionConfirmIcon')
                ?.getAttribute('href') || '').split('#').pop(),
        };
    });
    // ── §1 RECONNECT on a live tmux session ─────────────────────────────────
    console.log('--- §1 RECONNECT through the real chip gesture ---');
    await clearEmits();
    check('§1 the sheet opens from the chip', await openSheet(sid1), true);
    await clickAction('reconnect');
    const rcDialog = await readDialog();
    check('§1 Reconnect opens a confirmation', rcDialog.open, true);
    check('§1 Reconnect is NOT styled destructive', rcDialog.danger, false);
    check('§1 Reconnect body promises tmux is REATTACHED, not discarded',
        /reattach/i.test(rcDialog.body), true);
    check('§1 Reconnect body never claims tmux is discarded',
        /without reattaching|discard/i.test(rcDialog.body), false);
    console.log(`  dialog: accept=${JSON.stringify(rcDialog.accept)} `
        + `icon=${rcDialog.icon}`);

    await page.click('#sessionConfirmAccept');
    /*
     * A password session is routed by the SERVER to the credential form
     * ('password_required', socket_events.py:687) — designed, because the server
     * holds no replayable secret. What must survive is the reconnect INTENT. The
     * old session staying live while the form is open is itself part of the
     * contract.
     */
    await page.locator('#connectionModal')
        .waitFor({ state: 'visible', timeout: 20000 });
    check('§1 the server routed the password reconnect to the credential form',
        await page.locator('#connectionModal').isVisible(), true);
    check('§1 the old session is STILL live while the form is open (nothing was '
        + 'destroyed to open it)',
        await page.evaluate(
            id => !!SessionManager.sessions[id]?.connected, sid1), true);
    // The intent is request-keyed. Reading it through activeReconnectIntent()
    // asserts MORE than the old single slot did: the record must be the one
    // owning the credential modal, and it must carry the requestId the reply
    // will be correlated against -- so a stray reply cannot complete this one.
    check('§1 the form carries the reconnect INTENT, not a bare connect',
        await page.evaluate(() => {
            const intent = SessionManager.activeReconnectIntent();
            return {
                hasMeta: !!intent,
                hasRequestId: typeof intent?.requestId === 'string'
                    && intent.requestId.length > 0,
                tmuxIntent: !!intent && intent.tmuxSessionName
                    === SessionManager.sessions[intent.sessionId]?.tmuxSessionName,
                noSecret: !!intent && !Object.prototype.hasOwnProperty.call(
                    intent, 'password'),
                tmuxBoxChecked: document.getElementById('useTmuxCheck')?.checked,
            };
        }),
        { hasMeta: true, hasRequestId: true, tmuxIntent: true, noSecret: true,
            tmuxBoxChecked: true });

    await page.locator('#passwordInput').fill(SSH_PASS);
    await clearEmits();
    await page.locator('#connectBtn').click();

    await page.waitForFunction(prev => Object.keys(SessionManager.sessions)
        .some(id => !prev.includes(id) && SessionManager.sessions[id]?.connected),
    [sid1], { timeout: 40000 });
    const sid2 = await page.evaluate(prev => Object.keys(SessionManager.sessions)
        .find(id => !prev.includes(id)), [sid1]);
    noteSession(sid2);
    await page.waitForFunction(id => TerminalManager.terminalReady[id] === true,
        sid2, { timeout: 30000 });

    const rcEmits = await emits();
    const rcConnect = rcEmits.filter(e => e.ev === 'ssh_connect');
    console.log(`  emits: ${JSON.stringify(rcEmits.map(e => e.ev))}`);
    check('§1 the reconnect emitted exactly ONE ssh_connect',
        rcConnect.length, 1);
    check('§1 that ssh_connect carries the ORIGINAL tmux name '
        + '(reattach, not a fresh session)',
        rcConnect[0]?.reconnect_tmux_name, tmuxName1);
    check('§1 that ssh_connect asks for tmux', rcConnect[0]?.use_tmux, true);
    check('§1 no ssh_disconnect preceded the replacement connect',
        rcEmits.some(e => e.ev === 'ssh_disconnect')
            && rcEmits.findIndex(e => e.ev === 'ssh_disconnect')
                < rcEmits.findIndex(e => e.ev === 'ssh_connect'), false);

    const tmuxName2 = await page.evaluate(
        id => SessionManager.sessions[id]?.tmuxSessionName, sid2);
    noteTmux(tmuxName2);
    check('§1 the reconnected session reports the SAME tmux name',
        tmuxName2, tmuxName1);

    const tmuxAfterRc = hostTmux();
    check('§1 the HOST-side tmux session was REATTACHED, never recreated '
        + '(session_created identical)', tmuxAfterRc[tmuxName1], created1);
    check('§1 RECONNECT preserved the pane: the pre-reconnect marker is back',
        await waitPaneHas(sid2, `${MARK}-BEFORE`, 30000), true);
    console.log();
    // ── §2 RESET on the same live session ───────────────────────────────────
    console.log('--- §2 RESET through the real chip gesture ---');
    await clearEmits();
    check('§2 the sheet opens from the chip', await openSheet(sid2), true);
    await clickAction('reset');
    const rsDialog = await readDialog();
    check('§2 Reset opens a confirmation', rsDialog.open, true);
    check('§2 Reset IS styled destructive', rsDialog.danger, true);
    check('§2 Reset body says tmux is NOT reattached',
        /without reattaching/i.test(rsDialog.body), true);
    check('§2 Reset copy differs from the Reconnect copy',
        rsDialog.body === rcDialog.body, false);
    check('§2 Reset icon differs from the Reconnect icon',
        rsDialog.icon === rcDialog.icon, false);
    console.log(`  dialog: accept=${JSON.stringify(rsDialog.accept)} `
        + `icon=${rsDialog.icon}`);

    await page.click('#sessionConfirmAccept');
    // A password session's Reset also routes to the form (it must re-supply the
    // secret), and that form must carry RESET intent — tmux OFF — not reconnect.
    await page.locator('#connectionModal')
        .waitFor({ state: 'visible', timeout: 20000 });
    check('§2 the Reset form carries RESET intent, and tmux is OFF',
        await page.evaluate(() => ({
            hasResetMeta: !!SessionManager.pendingResetMeta,
            hasReconnectMeta: !!SessionManager.activeReconnectIntent(),
            // Stronger than the old check: NO reconnect intent may exist at all,
            // not merely none in the single slot the previous design had.
            reconnectRegistryEmpty:
                Object.keys(SessionManager.reconnectIntents).length === 0,
            tmuxBoxChecked: document.getElementById('useTmuxCheck')?.checked,
        })),
        { hasResetMeta: true, hasReconnectMeta: false,
            reconnectRegistryEmpty: true, tmuxBoxChecked: false });

    await page.locator('#passwordInput').fill(SSH_PASS);
    await clearEmits();
    await page.locator('#connectBtn').click();
    await page.waitForFunction(prev => Object.keys(SessionManager.sessions)
        .some(id => !prev.includes(id) && SessionManager.sessions[id]?.connected),
    [sid1, sid2], { timeout: 40000 });
    const sid3 = await page.evaluate(prev => Object.keys(SessionManager.sessions)
        .find(id => !prev.includes(id)), [sid1, sid2]);
    noteSession(sid3);
    await page.waitForFunction(id => TerminalManager.terminalReady[id] === true,
        sid3, { timeout: 30000 });
    noteTmux(await page.evaluate(
        id => SessionManager.sessions[id]?.tmuxSessionName || null, sid3));

    const rsEmits = await emits();
    const rsConnect = rsEmits.filter(e => e.ev === 'ssh_connect');
    console.log(`  emits: ${JSON.stringify(rsEmits.map(e => e.ev))}`);
    check('§2 Reset emitted exactly ONE ssh_connect', rsConnect.length, 1);
    check('§2 that ssh_connect explicitly refuses tmux',
        rsConnect[0]?.use_tmux, false);
    check('§2 that ssh_connect carries reconnect_tmux_name: null explicitly '
        + '(never the old name)', rsConnect[0]?.reconnect_tmux_name, null);
    check('§2 Reset produced a DIFFERENT logical session', sid3 === sid2, false);
    check('§2 the new session has NO tmux identity',
        await page.evaluate(id => SessionManager.sessions[id]?.tmuxSessionName
            || null, sid3), null);

    await page.waitForTimeout(2500);
    const tmuxAfterRs = hostTmux();
    check('§2 RESET killed the old tmux session ON THE HOST '
        + '(nothing survives to reattach to)',
        Object.prototype.hasOwnProperty.call(tmuxAfterRs, tmuxName1), false);
    check('§2 the fresh session did NOT adopt the old transcript',
        await paneHas(sid3, `${MARK}-BEFORE`), false);
    console.log();
    // ── §3 stacked confirmations cannot execute a stale action ──────────────
    console.log('--- §3 stacked confirmations: exactly one armed action ---');
    await clearEmits();
    await openSheet(sid3);
    await clickAction('reconnect');
    const first = await readDialog();
    // Arm the second action while the first dialog is open. The row sits behind
    // the modal backdrop by design, so the element's own click() is used —
    // proving a user cannot click through the backdrop is the matrix's job.
    await page.evaluate(() => document.querySelector(
        '#sessionActionsSheet [data-lifecycle-action="reset"]')?.click());
    await page.waitForTimeout(150);
    const second = await readDialog();
    check('§3 stacking replaces the dialog rather than layering two',
        await page.evaluate(() => document
            .querySelectorAll('#sessionConfirm:not([hidden])').length), 1);
    check('§3 the visible dialog is the SECOND action (Reset: destructive, '
        + 'its own copy)',
        second.danger && /without reattaching/i.test(second.body), true);
    check('§3 it is no longer the first action (Reconnect)',
        second.body === first.body, false);

    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(1200);
    const stackEmits = await emits();
    console.log(`  emits after ONE accept: `
        + `${JSON.stringify(stackEmits.map(e => e.ev))}`);
    const stackConnects = stackEmits.filter(e => e.ev === 'ssh_connect');
    check('§3 one accept ran at most ONE action, never both',
        stackConnects.length <= 1, true);
    /*
     * On a password session BOTH actions end at the credential form, so the emit
     * list alone cannot say which ran — it is empty either way until submit. The
     * intent record distinguishes them, and it is mutually exclusive by
     * construction: Reset sets pendingResetMeta, the live reconnect sets
     * the request-keyed reconnect registry. Reading BOTH is what proves the
     * retired action did not execute.
     */
    check('§3 the accept executed the SECOND action (Reset intent armed, the '
        + 'retired Reconnect intent absent)',
        await page.evaluate(() => ({
            reset: !!SessionManager.pendingResetMeta,
            reconnect: !!SessionManager.activeReconnectIntent(),
            reconnectRegistryEmpty:
                Object.keys(SessionManager.reconnectIntents).length === 0,
            tmuxBox: document.getElementById('useTmuxCheck')?.checked,
        })),
        { reset: true, reconnect: false, reconnectRegistryEmpty: true,
            tmuxBox: false });
    // Cancel the form: nothing is submitted, so no fourth session is created.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    console.log();

    // ── §4 Close is a third, separate action ────────────────────────────────
    console.log('--- §4 Close is separate from both ---');
    await clearEmits();
    const liveIds = await page.evaluate(
        () => Object.keys(SessionManager.sessions)
            .filter(id => SessionManager.sessions[id]?.connected));
    const closeTarget = liveIds[liveIds.length - 1];
    check('§4 a live session is available to close', typeof closeTarget,
        'string');
    await openSheet(closeTarget);
    await clickAction('close');
    const clDialog = await readDialog();
    check('§4 Close opens its own confirmation', clDialog.open, true);
    check('§4 Close copy is neither the Reconnect nor the Reset copy',
        clDialog.body !== rcDialog.body && clDialog.body !== rsDialog.body, true);
    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(1500);
    const clEmits = await emits();
    console.log(`  emits: ${JSON.stringify(clEmits.map(e => e.ev))}`);
    check('§4 Close emits ssh_disconnect and NO ssh_connect',
        { disc: clEmits.filter(e => e.ev === 'ssh_disconnect').length,
            conn: clEmits.filter(e => e.ev === 'ssh_connect').length },
        { disc: 1, conn: 0 });
} catch (err) {
    /*
     * A thrown exception must not skip the summary or, worse, exit 0. It is
     * recorded as a failed check so the suite still prints its ledger and still
     * exits non-zero, and `finally` below still performs cleanup.
     */
    check(`fatal: ${String(err && err.message || err).slice(0, 160)}`,
        'threw', 'completed');
} finally {
    // ---- CLEANUP: exact ids and names only, on success AND on throw --------
    console.log();
    console.log('--- cleanup (top-level finally: runs on failure and on throw) ---');
    console.log(`  ledger sessions: ${JSON.stringify(LEDGER.sessionIds)}`);
    console.log(`  ledger tmux    : ${JSON.stringify(LEDGER.tmuxNames)}`);

    // 1. Close each ledgered session through the product, by exact id.
    if (page && !page.isClosed()) {
        for (const id of LEDGER.sessionIds) {
            try {
                const closed = await page.evaluate((sid) => {
                    if (!window.SessionManager?.sessions?.[sid]) return 'absent';
                    window.SessionManager.closeSession(sid);
                    return 'closed';
                }, id);
                console.log(`  session ${id}: ${closed}`);
            } catch (err) {
                console.log(`  session ${id}: close failed — `
                    + `${String(err.message || err).slice(0, 70)}`);
            }
        }
        await page.waitForTimeout(3000).catch(() => {});
    } else {
        console.log('  page unavailable: sessions could not be closed in-app');
    }

    // 2. Any ledgered tmux name still on the host is killed by EXACT name.
    const nowTmux = hostTmux();
    for (const name of LEDGER.tmuxNames) {
        if (Object.prototype.hasOwnProperty.call(nowTmux, name)) {
            killExactTmux(name, tmuxBefore);
        } else {
            console.log(`  tmux ${name}: already gone`);
        }
    }

    // 3. Report, never guess. Anything unexpected is surfaced for supervision.
    const endTmux = hostTmux();
    const leakedNames = Object.keys(endTmux).filter(
        n => !Object.prototype.hasOwnProperty.call(tmuxBefore, n));
    const removedPreexisting = Object.keys(tmuxBefore).filter(
        n => !Object.prototype.hasOwnProperty.call(endTmux, n));
    check('cleanup: no tmux session created by this run is left behind',
        leakedNames, []);
    check('cleanup: no pre-existing tmux session was removed',
        removedPreexisting, []);
    if (leakedNames.length) {
        console.log('  SUPERVISION NEEDED — unledgered leftovers, not touched:');
        for (const n of leakedNames) console.log(`    ${n}`);
    }

    // 4. The SSHDeck account: identity written out, deletion NOT attempted.
    //    The app's only delete path is admin-authenticated; this suite holds no
    //    admin credential, so removal is a separate approved step.
    try {
        fs.writeFileSync(LEDGER_FILE, `${JSON.stringify({
            run: RUN, base: BASE, account: LEDGER.account,
            sessionIds: LEDGER.sessionIds, tmuxNames: LEDGER.tmuxNames,
            tmuxLeftover: leakedNames, at: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o600 });
        console.log(`  ledger written: ${LEDGER_FILE} (mode 600)`);
    } catch (err) {
        console.log(`  ledger write failed: ${String(err.message || err)}`);
    }
    console.log(`  account ${SSHDECK_USER}: NOT deleted here `
        + '(admin-only delete path; see the ledger file)');

    if (ctx) await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
}

console.log();
check('0 page errors', pageErrors.slice(0, 3), []);
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log();
console.log(`total=${results.length} passed=${passed} failed=${failed}`);
for (const r of results.filter(x => !x.ok)) console.log(`FAIL  ${r.label}`);
process.exit(failed ? 1 : 0);
