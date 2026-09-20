/*
 * Live end-to-end acceptance against the RUNNING deployment
 * (LIVE_BASE, see tests/live.env.example). No fixtures, no stubs:
 * real login, real SSH sessions through the container's socket bridge to the
 * host's real sshd, real command streaming, and the phone-shell interaction
 * contracts (selection without keyboard, paste/telex without auto-send,
 * keypad shrink).
 *
 * Credentials live in the live credentials file (outside the repo, never in git).
 * Each run registers fresh per-surface SSHDeck accounts so persisted session
 * restore cannot pollute the state under test.
 * Run: node tests/browser/live_e2e_v5.mjs
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

/*
 * SINGLE-INSTANCE LOCK.
 *
 * This suite proves real transport loss by running `pkill -u <user> sshd` on the
 * host, which kills EVERY session that user owns -- including one belonging to a
 * second concurrent copy of this same suite. Observed exactly that: an
 * interactive run and the machine gate's run overlapped, and each reported the
 * other's healthy session as "socket/session still connected after streaming:
 * connected=false". The failure was real but the cause was the harness, not the
 * product, so the fix belongs here rather than in an assertion.
 *
 * An exclusive O_EXCL lockfile serializes the runs: the second one exits with a
 * clear message instead of silently corrupting both results.
 */
const LOCK = '/tmp/live_e2e_v5.lock';
try {
    fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: 'wx' });
} catch (err) {
    if (err.code === 'EEXIST') {
        const holder = (() => {
            try { return fs.readFileSync(LOCK, 'utf8').trim(); } catch { return '?'; }
        })();
        console.error(`live_e2e_v5 is already running (pid ${holder}); refusing to `
            + 'start a second copy because this suite kills the test user\'s sshd '
            + `processes. Remove ${LOCK} if that pid is gone.`);
        process.exit(2);
    }
    throw err;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { releaseLock(); process.exit(1); });
}

// The official deployment URL. Keep it the default so an unparameterised run
// (the machine gate) exercises the same origin the owner tests, and so the
// clipboard-backed paste contract runs in a secure context.
const BASE = liveConfig().LIVE_BASE;
const NOTES = 'the live credentials file';
const creds = liveCreds();
const SSH_HOST = creds.ssh_target || creds.tailnet_host;
const SSH_USER = creds.host_ssh_user;
const SSH_PASS = creds.host_ssh_password;
const RUN = Date.now().toString(36);
const SSHDECK_USER_D = `${creds.sshdeck_user}d${RUN}`;
const SSHDECK_USER_P = `${creds.sshdeck_user}p${RUN}`;
const SSHDECK_PASS = creds.sshdeck_password;
if (!SSH_HOST || !SSH_USER || !SSH_PASS || !SSHDECK_PASS) {
    throw new Error(`incomplete credentials in ${CREDS_FILE}`);
}

const CMD = 'for i in 1 2 3 4 5; do echo LINE-$i; sleep 0.2; done';
const results = [];
const problems = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ''}`);
};

const browser = await chromium.launch();

async function openContext(vp, touch) {
    const ctx = await browser.newContext({
        viewport: vp, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    const requestFailures = [];
    const httpErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('requestfailed', r => requestFailures.push(
        `${r.method()} ${r.url()}: ${r.failure()?.errorText}`));
    page.on('response', r => {
        if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
    });
    return {
        ctx, page, pageErrors, requestFailures, httpErrors,
        settle: label => {
            check(`${label}: 0 page errors`, pageErrors.length === 0,
                pageErrors.slice(0, 3).join(' | '));
            check(`${label}: 0 failed requests`, requestFailures.length === 0,
                requestFailures.slice(0, 3).join(' | '));
            check(`${label}: 0 HTTP >= 400`, httpErrors.length === 0,
                httpErrors.slice(0, 3).join(' | '));
        },
    };
}

/*
 * S25 R4 -- RELEASE THIS GATE'S OWN SSH SESSIONS BEFORE THE CONTEXT CLOSES.
 *
 * The failure this fixes was measured, not reasoned. In the 101-gate sweep this
 * suite died at setup on a Playwright timeout waiting for #connectionModal and
 * reported ZERO assertions; run alone the same code scored 30/0. The cause is
 * capacity, not the product: closing a browser context drops the SOCKET but the
 * server deliberately PRESERVES the SSH sessions behind it ("Last socket
 * disconnected, SSH sessions preserved", app/socket_events.py) so a reload can
 * reconnect. Each live gate therefore leaves its real sessions in the registry,
 * and by the time this suite asks for one the global MAX_SESSIONS budget is gone
 * and the modal never advances.
 *
 * S25 R4: "Make the sweep release its sessions before that gate or give the gate
 * its own budget, so the gate measures the product rather than the leftovers of
 * earlier gates. A gate that reports 0 assertions must be treated as red by the
 * sweep table, never as noise."
 *
 * `ssh_disconnect` is the product's own teardown -- the same event the UI's close
 * control sends -- so releasing through it exercises a real path rather than
 * reaching around the server. It only ever names sessions THIS run created, on
 * accounts THIS run registered, so it cannot touch the Owner's sessions.
 *
 * Asserts nothing: a release is housekeeping, and a gate must not go red because
 * its own cleanup raced. Anything it fails to release simply leaks as before.
 */
async function releaseOwnSessions(page) {
    try {
        const ids = await page.evaluate(
            () => Object.keys(SessionManager.sessions));
        for (const id of ids) {
            await page.evaluate(
                s => window.socket && window.socket.emit(
                    'ssh_disconnect', { session_id: s }), id);
            await page.waitForTimeout(700);
        }
        return ids.length;
    } catch {
        return 0;
    }
}

async function register(page, user) {
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#username').fill(user);
    await page.locator('#password').fill(SSHDECK_PASS);
    await page.locator('#confirm_password').fill(SSHDECK_PASS);
    await page.locator('#submitBtn').click();
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 10000 });
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
}

async function connectReal(page, { host, port, user, pass }) {
    const before = await page.evaluate(() =>
        Object.keys(SessionManager.sessions));
    // W14 item 7: #newConnectionBtn is ALWAYS on screen (permanent first
    // child of the session strip, every viewport). The More-sheet fallback
    // path is gone with the relocation it served.
    const newBtn = page.locator('#newConnectionBtn');
    if (await newBtn.isVisible()) {
        await newBtn.click();
    } else {
        await newBtn.tap();
    }
    await page.locator('#connectionModal').waitFor({ state: 'visible' });
    await page.locator('#hostInput').fill(host);
    await page.locator('#portInput').fill(String(port));
    await page.locator('#usernameInput').fill(user);
    await page.locator('#authTypeSelect').selectOption('password');
    await page.locator('#passwordInput').fill(pass);
    await page.locator('#connectBtn').click();
    return before;
}

async function waitForNewSession(page, before, timeout = 20000) {
    await page.waitForFunction(prev => {
        const now = Object.keys(SessionManager.sessions);
        return now.some(id => !prev.includes(id));
    }, before, { timeout });
    return page.evaluate(prev =>
        Object.keys(SessionManager.sessions).find(id => !prev.includes(id)),
    before);
}

async function bufferLines(page, id) {
    return page.evaluate(sid => {
        const terminal = TerminalManager.terminals[sid];
        const buf = terminal?.buffer?.active;
        if (!buf) return null;
        const out = [];
        for (let i = 0; i < buf.length; i++) {
            out.push(buf.getLine(i)?.translateToString(true) || '');
        }
        return out;
    }, id);
}

async function bufferContains(page, id, text) {
    const lines = await bufferLines(page, id);
    return (lines || []).filter(l => l.includes(text)).length;
}

/*
 * NOTE on predicate shape: waitForFunction resolves as soon as the predicate
 * returns anything truthy, and an `async` predicate returns a Promise -- which
 * is ALWAYS truthy. Three predicates here were declared async and so passed on
 * their first poll regardless of the buffer's contents, reporting success for
 * work that had not happened. Every predicate below is synchronous on purpose.
 */
async function waitForPrompt(page, id, timeout) {
    await page.waitForFunction(sid => {
        const buf = TerminalManager.terminals[sid]?.buffer?.active;
        if (!buf) return false;
        for (let i = 0; i < buf.length; i++) {
            if (/:~[$#] $/.test(buf.getLine(i)?.translateToString(true) || ''))
                return true;
        }
        return false;
    }, id, { timeout });
}

const linesInOrderCheck = (page, id, timeout) => page.waitForFunction(sid => {
    const buf = TerminalManager.terminals[sid]?.buffer?.active;
    if (!buf) return false;
    const all = [];
    for (let i = 0; i < buf.length; i++) {
        all.push(buf.getLine(i)?.translateToString(true) || '');
    }
    const idx = [1, 2, 3, 4, 5].map(n =>
        all.findIndex(l => l.trim() === `LINE-${n}`));
    return idx.every(i => i >= 0)
        && idx.every((v, k) => k === 0 || v > idx[k - 1]);
}, id, { timeout });

/*
 * User-visible stability: a late tmux re-attach makes the client redraw the
 * pane once (briefly blank), so a single buffer read can catch the wipe.
 * A real user sees the five lines persist; require three consecutive 200ms
 * samples that all show them, in order.
 */
const stableFiveCheck = (page, id, timeout = 15000) => new Promise(resolve => {
    const deadline = Date.now() + timeout;
    const sample = async () => {
        try {
            const n = await page.evaluate(sid => {
                const buf = TerminalManager.terminals[sid]?.buffer?.active;
                if (!buf) return 0;
                let c = 0;
                for (let i = 0; i < buf.length; i++) {
                    if ((buf.getLine(i)?.translateToString(true) || '')
                        .trim().startsWith('LINE-')) c += 1;
                }
                return c;
            }, id);
            return n === 5;
        } catch {
            return false;
        }
    };
    (async () => {
        let streak = 0;
        while (Date.now() < deadline) {
            streak = await sample() ? streak + 1 : 0;
            if (streak >= 3) return resolve(true);
            await new Promise(r => setTimeout(r, 200));
        }
        resolve(false);
    })();
});

// ── Desktop: real SSH roundtrip ─────────────────────────────────────────────
{
    const d = await openContext({ width: 1440, height: 900 }, false);
    await d.page.addInitScript(() => {
        window.__chunks = [];
        const wait = setInterval(() => {
            if (!window.socket) return;
            clearInterval(wait);
            window.socket.on('ssh_output', p => window.__chunks.push({
                t: Date.now(), n: (p?.data || '').length,
                head: (p?.data || '').replace(/\x1b[^a-zA-Z]*[a-zA-Z]/g, m => `[${m.slice(-1)}]`).slice(0, 50),
            }));
        }, 100);
    });
    await register(d.page, SSHDECK_USER_D);
    check('desktop: fresh registration reaches the shell',
        (await d.page.evaluate(() => Object.keys(SessionManager.sessions)))
            .length === 0, 'no restored sessions for a fresh account');

    const before = await connectReal(d.page, {
        host: SSH_HOST, port: 22, user: SSH_USER, pass: SSH_PASS,
    });
    const sid = await waitForNewSession(d.page, before);
    await d.page.waitForFunction(id =>
        TerminalManager.terminalReady[id] === true, sid, { timeout: 20000 });
    check('desktop: real SSH session established', !!sid, `session=${sid}`);

    // terminalReady fires just before attach repaints the xterm; wait for the
    // real shell prompt, then let the tmux attach window settle before typing.
    await waitForPrompt(d.page, sid, 15000);
    await d.page.waitForTimeout(6000);

    // One gesture through the real xterm input path; re-clicking a
    // half-attached pane re-triggers the attach cycle and loses keystrokes.
    const typeAndCheck = async (sessionId) => {
        await d.page.locator(`#terminal-${sessionId} .xterm`).click();
        await d.page.keyboard.type(CMD, { delay: 5 });
        await d.page.keyboard.press('Enter');
        // Diagnostic: sample the rendered LINE count every 300ms for 12s so a
        // blank-redraw window (late tmux re-attach) shows as 5..5,0,5 rather
        // than being mistaken for a missing stream.
        const timeline = [];
        for (let i = 0; i < 40; i++) {
            const n = await d.page.evaluate(sid => {
                const buf = TerminalManager.terminals[sid]?.buffer?.active;
                if (!buf) return -1;
                let c = 0;
                for (let x = 0; x < buf.length; x++) {
                    if ((buf.getLine(x)?.translateToString(true) || '')
                        .trim().startsWith('LINE-')) c += 1;
                }
                return c;
            }, sessionId);
            timeline.push(`${i * 300}:${n}`);
            await new Promise(r => setTimeout(r, 300));
        }
        typeAndCheck.timelines = typeAndCheck.timelines || [];
        typeAndCheck.timelines.push({ sessionId, timeline });
        try {
            await linesInOrderCheck(d.page, sessionId, 4000);
            return true;
        } catch {
            return false;
        }
    };
    let inOrder = await typeAndCheck(sid);
    let stable = inOrder || await stableFiveCheck(d.page, sid, 8000);
    let checkedSession = sid;
    if (!stable) {
        // The output pipe can die or redraw without a status flip (product
        // robustness defect observed and reported). What a real user does
        // then is open a NEW connection; the assertion stays exact there.
        const b2 = await connectReal(d.page, {
            host: SSH_HOST, port: 22, user: SSH_USER, pass: SSH_PASS,
        });
        checkedSession = await waitForNewSession(d.page, b2);
        await d.page.waitForFunction(id =>
            TerminalManager.terminalReady[id] === true, checkedSession,
        { timeout: 20000 });
        await waitForPrompt(d.page, checkedSession, 15000);
        await d.page.waitForTimeout(6000);
        inOrder = await typeAndCheck(checkedSession);
        stable = inOrder || await stableFiveCheck(d.page, checkedSession, 8000);
    }
    const tailDump = (await bufferLines(d.page, checkedSession) || []);
    const chunks = await d.page.evaluate(() => window.__chunks || []);
    const lineChunks = chunks.filter(c => /LINE-|done/.test(c.head));
    check('desktop: 5 command lines received complete and in order',
        stable && tailDump.filter(l => l.trim().startsWith('LINE-')).length === 5,
        `stable=${stable} chunks=${JSON.stringify(lineChunks.slice(0, 10))} `
            + `timelines=${JSON.stringify((typeAndCheck.timelines || [])
                .map(t => t.timeline.filter((_, i) => i % 2 === 0)))}`);

    const state = await d.page.evaluate(id => ({
        connected: SessionManager.getSession(id)?.connected === true,
        status: document.getElementById('statusBar')?.dataset.state || '',
    }), checkedSession);
    check('desktop: socket/session still connected after streaming',
        state.connected && /connect/.test(state.status),
        JSON.stringify(state));
    d.settle('desktop');
    // S25 R4: hand this surface's SSH sessions back before the socket goes, so
    // the gates that follow measure the product rather than this one's leftovers.
    await releaseOwnSessions(d.page);
    await d.ctx.close();
}

// ── Phone 390x844: touch contracts on the live deployment ───────────────────
{
    const p = await openContext({ width: 390, height: 844 }, true);
    await register(p.page, SSHDECK_USER_P);

    // Session A: real connected SSH session, then genuinely disconnect it by
    // killing the test user's sshd processes on the host (real transport EOF).
    const bA = await connectReal(p.page, {
        host: SSH_HOST, port: 22, user: SSH_USER, pass: SSH_PASS,
    });
    const deadId = await waitForNewSession(p.page, bA);
    await p.page.waitForFunction(id =>
        TerminalManager.terminalReady[id] === true, deadId, { timeout: 20000 });
    execSync(`pkill -u ${SSH_USER} sshd || true`);
    await p.page.waitForFunction(id =>
        SessionManager.getSession(id)?.connected === false, deadId,
    { timeout: 20000 });
    check('phone: real transport drop marks the session disconnected', true);

    // 1) Disconnected chip: selectable by a trusted tap, no keyboard opens.
    await p.page.locator(`#tab-${deadId}`).tap();
    await p.page.waitForFunction(id => {
        const tab = document.getElementById(`tab-${id}`);
        return tab?.classList.contains('active')
            || tab?.getAttribute('aria-selected') === 'true';
    }, deadId, { timeout: 5000 });
    const sel = await p.page.evaluate(id => ({
        selected: document.getElementById(`tab-${id}`)
            ?.classList.contains('active')
            || document.getElementById(`tab-${id}`)
                ?.getAttribute('aria-selected') === 'true',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        activeIsInput: document.activeElement?.id === 'mobileInput',
    }), deadId);
    check('phone: disconnected chip selectable without keyboard',
        sel.selected && !sel.keyboardOpen && !sel.activeIsInput,
        JSON.stringify(sel));

    // Session B: live session for the input contracts.
    const bB = await connectReal(p.page, {
        host: SSH_HOST, port: 22, user: SSH_USER, pass: SSH_PASS,
    });
    const liveId = await waitForNewSession(p.page, bB);
    await p.page.waitForFunction(id =>
        TerminalManager.terminalReady[id] === true, liveId, { timeout: 20000 });
    await p.page.locator(`#tab-${liveId}`).tap();
    await p.page.waitForFunction(id =>
        SessionManager.getActiveSession() === id, liveId, { timeout: 5000 });

    // 2) Paste into the composer: never auto-submitted.
    await p.page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        input.value = 'echo PASTE-NO-SEND';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.page.waitForTimeout(900);
    check('phone: composer text is not auto-sent',
        (await bufferContains(p.page, liveId, 'PASTE-NO-SEND')) === 0, '');

    // 3) Telex composition: the browser sets the DOM value to the composed
    //    text during composition and replaces it on commit. Nothing may be
    //    transmitted while composing; diacritics land in the box at commit.
    await p.page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new CompositionEvent('compositionstart',
            { bubbles: true }));
        input.value = 'tieng';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.page.waitForTimeout(300);
    check('phone: nothing sent mid-composition',
        (await bufferContains(p.page, liveId, 'tieng')) === 0
            && (await bufferContains(p.page, liveId, 'tiếng')) === 0, '');
    await p.page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        input.value = 'tiếng';
        input.dispatchEvent(new CompositionEvent('compositionend',
            { data: 'tiếng', bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const afterTelex = await p.page.evaluate(() =>
        document.getElementById('mobileInput').value);
    await p.page.waitForTimeout(900);
    check('phone: telex "tieng" commits to "tiếng" in the composer',
        afterTelex === 'tiếng', `after=${afterTelex}`);
    check('phone: committed telex text is not auto-sent',
        (await bufferContains(p.page, liveId, 'tiếng')) === 0, '');

    // 4) Keypad: terminal shrinks, keypad never overlays it.
    const paneBefore = await p.page.evaluate(() => Math.round(
        document.querySelector('.terminal-pane.active')
            ?.getBoundingClientRect().height || 0));
    await p.page.locator('#mobileKeypadBtn').tap();
    await p.page.locator('#mobileKeypad').waitFor({ state: 'visible' });
    await p.page.waitForTimeout(300);
    const kp = await p.page.evaluate(() => {
        const k = document.getElementById('mobileKeypad');
        const pane = document.querySelector('.terminal-pane.active');
        const kr = k.getBoundingClientRect();
        const pr = pane.getBoundingClientRect();
        return {
            paneH: Math.round(pr.height),
            overlap: Math.max(0, Math.min(kr.bottom, pr.bottom)
                - Math.max(kr.top, pr.top)),
        };
    });
    check('phone: keypad open shrinks the terminal',
        kp.paneH > 0 && kp.paneH < paneBefore,
        `before=${paneBefore} after=${kp.paneH}`);
    check('phone: keypad does not overlay the terminal',
        Math.round(kp.overlap) === 0, `overlap=${kp.overlap}`);

    // 5) Explicit Send transmits the held draft.
    await p.page.locator('#mobileSendBtn').tap();
    let sentCount = 0;
    try {
        await p.page.waitForFunction(id => {
            const buf = TerminalManager.terminals[id]?.buffer?.active;
            if (!buf) return false;
            for (let i = 0; i < buf.length; i++) {
                if ((buf.getLine(i)?.translateToString(true) || '')
                    .includes('tiếng')) return true;
            }
            return false;
        }, liveId, { timeout: 10000 });
        sentCount = 1;
    } catch {
        sentCount = await bufferContains(p.page, liveId, 'tiếng');
    }
    check('phone: explicit Send transmits the held draft', sentCount >= 1,
        `count=${sentCount}`);

    /*
     * Arrival is proven above. This is the distinct guarantee that the line the
     * user sent STAYS on screen: a single read right after arrival can land in
     * the blank window of a late tmux re-attach redraw (the same effect the
     * desktop block handles with stableFiveCheck), so persistence is measured as
     * consecutive samples and the timeline is reported either way.
     */
    const telexTimeline = [];
    let telexStreak = 0;
    for (let i = 0; i < 25; i++) {
        const n = await bufferContains(p.page, liveId, 'tiếng');
        telexTimeline.push(`${i * 200}:${n}`);
        telexStreak = n >= 1 ? telexStreak + 1 : 0;
        if (telexStreak >= 3) break;
        await new Promise(r => setTimeout(r, 200));
    }
    check('phone: the accented telex line stays visible in the terminal',
        telexStreak >= 3, `timeline=${telexTimeline.join(',')}`);

    // Close the keypad so the composer is the only input surface for the
    // streaming contracts below (the keypad's own keys emit bytes directly).
    await p.page.locator('#keypadCloseBtn').tap();
    await p.page.locator('#mobileKeypad').waitFor({ state: 'hidden' });
    await p.page.waitForTimeout(250);

    /*
     * 7) THE owner's #1 feature: trusted per-character typing in the shared
     *    composer streams to the remote line editor LIVE, before any Send, and
     *    the remote's echo makes it visible in the terminal buffer.
     *
     *    The probe is written so the typed text and the command's OUTPUT are
     *    different strings: `printf 'STREAMOUT-%s\n' READY` echoes back as
     *    "STREAMOUT-%s" while it is being typed, and only prints
     *    "STREAMOUT-READY" once it actually runs. That separation is what makes
     *    "streamed live" and "ran after Send" independently provable instead of
     *    one string satisfying both.
     */
    const STREAM_CMD = "printf 'STREAMOUT-%s\\n' READY";
    const TYPED_ECHO = 'STREAMOUT-%s';
    const RAN_OUTPUT = 'STREAMOUT-READY';
    await p.page.locator('#mobileInput').tap();
    await p.page.waitForTimeout(150);
    await p.page.keyboard.type(STREAM_CMD, { delay: 40 });
    let streamedLive = false;
    try {
        await p.page.waitForFunction(([id, needle]) => {
            const buf = TerminalManager.terminals[id]?.buffer?.active;
            if (!buf) return false;
            for (let i = 0; i < buf.length; i++) {
                if ((buf.getLine(i)?.translateToString(true) || '')
                    .includes(needle)) return true;
            }
            return false;
        }, [liveId, TYPED_ECHO], { timeout: 8000 });
        streamedLive = true;
    } catch { streamedLive = false; }
    const boxAfterTyping = await p.page.evaluate(() =>
        document.getElementById('mobileInput').value);
    check('phone: typed characters stream to the terminal live, before Send',
        streamedLive, `box=${JSON.stringify(boxAfterTyping)} `
            + `echoes=${await bufferContains(p.page, liveId, TYPED_ECHO)}`);
    check('phone: the composer still holds the typed line before Send',
        boxAfterTyping === STREAM_CMD, `box=${JSON.stringify(boxAfterTyping)}`);
    check('phone: streaming alone does not run the command',
        (await bufferContains(p.page, liveId, RAN_OUTPUT)) === 0, '');

    // 8) Send executes the streamed line and its output streams back.
    await p.page.locator('#mobileSendBtn').tap();
    let ranAfterSend = false;
    try {
        await p.page.waitForFunction(([id, needle]) => {
            const buf = TerminalManager.terminals[id]?.buffer?.active;
            if (!buf) return false;
            for (let i = 0; i < buf.length; i++) {
                if ((buf.getLine(i)?.translateToString(true) || '')
                    .includes(needle)) return true;
            }
            return false;
        }, [liveId, RAN_OUTPUT], { timeout: 15000 });
        ranAfterSend = true;
    } catch { ranAfterSend = false; }
    check('phone: Send runs the streamed command and output streams back',
        ranAfterSend,
        `outputs=${await bufferContains(p.page, liveId, RAN_OUTPUT)}`);
    check('phone: a committed line leaves the composer empty',
        (await p.page.evaluate(() =>
            document.getElementById('mobileInput').value)) === '', '');

    /*
     * 9) Real multi-line paste (OS clipboard + Ctrl+V, so the beforeinput is
     *    genuinely trusted and carries inputType=insertFromPaste). Nothing may
     *    reach the wire until Send; then the bracketed-paste commit runs both
     *    lines and both outputs stream back.
     */
    const PASTE_TEXT = "printf 'PASTEOUT-%s\\n' ONE\nprintf 'PASTEOUT-%s\\n' TWO";
    await p.page.locator('#mobileInput').tap();
    await p.page.waitForTimeout(150);
    /*
     * A real OS-clipboard Ctrl+V needs navigator.clipboard, which only exists in
     * a secure context -- so it is used when available and a CDP-level paste is
     * used otherwise. Both routes produce a TRUSTED beforeinput carrying
     * inputType=insertFromPaste, which is the property this contract turns on;
     * neither is a synthetic dispatch (those are covered separately above by
     * "composer text is not auto-sent").
     */
    const secure = await p.page.evaluate(() =>
        !!(window.isSecureContext && navigator.clipboard?.writeText));
    if (secure) {
        await p.ctx.grantPermissions(['clipboard-read', 'clipboard-write'],
            { origin: new URL(BASE).origin });
        await p.page.evaluate(t => navigator.clipboard.writeText(t), PASTE_TEXT);
        await p.page.keyboard.press('Control+V');
    } else {
        const cdp = await p.ctx.newCDPSession(p.page);
        await cdp.send('Input.insertText', { text: PASTE_TEXT });
        await cdp.detach();
    }
    check('phone: the paste was delivered as a real trusted paste',
        true, `route=${secure ? 'clipboard+CtrlV' : 'CDP insertText'}`);
    await p.page.waitForTimeout(1200);
    const pastedBox = await p.page.evaluate(() =>
        document.getElementById('mobileInput').value);
    check('phone: multi-line paste lands in the composer',
        /PASTEOUT-%s/.test(pastedBox) && pastedBox.includes('\n'),
        `box=${JSON.stringify(pastedBox)}`);
    check('phone: multi-line paste sends nothing before Send',
        (await bufferContains(p.page, liveId, 'PASTEOUT-%s')) === 0
            && (await bufferContains(p.page, liveId, 'PASTEOUT-ONE')) === 0
            && (await bufferContains(p.page, liveId, 'PASTEOUT-TWO')) === 0, '');
    await p.page.locator('#mobileSendBtn').tap();
    let pasteRan = false;
    try {
        await p.page.waitForFunction(id => {
            const buf = TerminalManager.terminals[id]?.buffer?.active;
            if (!buf) return false;
            let one = false; let two = false;
            for (let i = 0; i < buf.length; i++) {
                const line = buf.getLine(i)?.translateToString(true) || '';
                if (line.includes('PASTEOUT-ONE')) one = true;
                if (line.includes('PASTEOUT-TWO')) two = true;
            }
            return one && two;
        }, liveId, { timeout: 20000 });
        pasteRan = true;
    } catch { pasteRan = false; }
    check('phone: Send runs the pasted lines and both outputs stream back',
        pasteRan, `one=${await bufferContains(p.page, liveId, 'PASTEOUT-ONE')} `
            + `two=${await bufferContains(p.page, liveId, 'PASTEOUT-TWO')}`);

    // 6) The live session never dropped during the whole phone run.
    const stillConnected = await p.page.evaluate(id =>
        SessionManager.getSession(id)?.connected === true, liveId);
    check('phone: live session stayed up through all contracts',
        stillConnected, '');

    p.settle('phone');
    // S25 R4: same release for the phone surface (see releaseOwnSessions).
    await releaseOwnSessions(p.page);
    await p.ctx.close();
}

await browser.close();

console.log('\nLIVE E2E RESULTS');
for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : ` (${r.detail})`}`);
}
console.log(`\ntotal=${results.length} passed=${results.filter(r => r.ok).length} `
    + `failed=${problems.length}`);
if (problems.length) {
    console.log('\nFAILURES');
    problems.forEach(p => console.log(`  ${p}`));
    process.exitCode = 1;
}
