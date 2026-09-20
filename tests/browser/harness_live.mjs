/*
 * THE LIVE HARNESS -- what every live gate is built on.
 *
 * Three faults of the harness this replaces, fixed here by construction rather
 * than by convention:
 *
 *  1. `window.SessionManager` IS ALWAYS UNDEFINED. session-manager.js declares
 *     `const SessionManager = {...}` at the top level of a classic script, so
 *     the binding lives in the global declarative record and is NOT a property
 *     of `window`. Probes that read `(window.SessionManager && ...) || {}`
 *     therefore got `{}`, waited for something that could never arrive, timed
 *     out, and were filed as harmless -- which is why six defects never had a
 *     single live measurement behind them. Everything here uses the bare name.
 *
 *  2. READING buffer.active WITHOUT RECORDING bufferType. On the alternate
 *     screen -- a full-screen program holding the pane -- `buffer.active` IS
 *     the alternate buffer, which has no scrollback: baseY is always 0 and
 *     length always equals rows. Those numbers were read as "the history
 *     vanished". `measure()` below reads BOTH buffers and throws when the type
 *     is missing, so that mistake cannot be repeated.
 *
 *  3. TESTING ONE ENGINE ONLY. A defect that stops typing on Safari for macOS
 *     cannot be seen on Chromium. `launch()` takes the engine, and WebKit is
 *     the engine Safari runs.
 *
 * Configuration comes from tests/live.env (see tests/live.env.example); the
 * values are never printed.
 */
import { chromium, webkit } from 'playwright';
import { liveConfig, CREDS_FILE } from './live_creds.mjs';

export const C = liveConfig();
export const BASE = C.LIVE_BASE;
export const CONFIG_FILE = CREDS_FILE;

const ENGINES = { chromium, webkit };

export async function launch({ engine = 'chromium', width = 1440, height = 900,
                              touch = false } = {}) {
    const type = ENGINES[engine];
    if (!type) throw new Error(`unknown engine: ${engine}`);
    const browser = await type.launch();
    const ctx = await browser.newContext({
        viewport: { width, height },
        hasTouch: !!touch, isMobile: engine === 'chromium' ? !!touch : false,
        deviceScaleFactor: 1, ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('console', m => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    return { browser, ctx, page, pageErrors, consoleErrors, engine };
}

/* Log in. Throws when /login is still on screen afterwards, so no suite can
 * quietly measure the login page and report green. */
export async function login(page) {
    await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 45000 });
    await page.fill('#username', C.LIVE_USER);
    await page.fill('#password', C.LIVE_PASS);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }),
        page.click('button[type="submit"]'),
    ]);
    if (/\/login/.test(page.url())) {
        const flash = await page.evaluate(() => {
            const el = document.querySelector('.flash, .alert, [role="alert"]');
            return el ? el.textContent.trim().slice(0, 160) : '(no flash message)';
        });
        throw new Error(`login did not leave /login -- the page says: ${flash}`);
    }
    // The BARE name, not window.* (fault 1 at the top of this file)
    await page.waitForFunction(
        () => typeof SessionManager !== 'undefined'
            && typeof TerminalManager !== 'undefined'
            && document.readyState === 'complete',
        null, { timeout: 30000 });
}

/* The sessions that exist now. Bare name. */
export const sessionIds = (page) => page.evaluate(
    () => Object.keys(SessionManager.sessions || {}));

/* GATE: the harness must be able to SEE the app's state, or stop loudly. */
export async function assertMeasurable(page) {
    const ok = await page.evaluate(() => ({
        sm: typeof SessionManager !== 'undefined',
        tm: typeof TerminalManager !== 'undefined',
        smOnWindow: typeof window.SessionManager !== 'undefined',
        sessions: typeof SessionManager !== 'undefined'
            ? Object.keys(SessionManager.sessions || {}).length : -1,
    }));
    if (!ok.sm || !ok.tm) {
        throw new Error(`GATE FAIL: SessionManager/TerminalManager not visible: ${JSON.stringify(ok)}`);
    }
    return ok;
}

/*
 * OPEN A REAL SSH CONNECTION, told apart from an AUTO-RESTORE.
 *
 * What the earlier harness got wrong: the app reconnects saved sessions by
 * itself when the page loads, and waiting for "the session count went up"
 * matches that restored session rather than the one the click opened. The
 * evidence was an EMPTY form (host="" user="") reporting a connected session
 * against a host nobody had typed.
 *
 * This version differs in four places, each of them a way it was fooled once:
 *   1. wait for auto-restore to SETTLE, then record a baseline by id;
 *   2. VERIFY the form really took the values, rather than trusting fill();
 *   3. wait for a session with EXACTLY the host and user that were typed, not
 *      for "one more session";
 *   4. settle() requires the modal to be closed -- a modal still open means
 *      the connect has not finished.
 */
export async function connectSSH(page, opts = {}) {
    const host = opts.host || C.SSH_HOST || '127.0.0.1';
    const port = String(opts.port || C.SSH_PORT || 22);
    const user = opts.user || C.SSH_USER;
    const pass = opts.pass || C.SSH_PASS;

    // (1) auto-restore settles: the session count holds for 2.5s
    await page.waitForFunction(() => {
        const n = Object.keys(SessionManager.sessions || {}).length;
        if (window.__stableN !== n) {
            window.__stableN = n; window.__stableAt = Date.now(); return false;
        }
        return Date.now() - (window.__stableAt || 0) > 2500;
    }, null, { timeout: 60000, polling: 200 });
    const baseline = await page.evaluate(() => {
        const out = {};
        for (const [id, s] of Object.entries(SessionManager.sessions || {})) {
            out[id] = `${s.username}@${s.host}:${s.port}`;
        }
        return out;
    });
    console.log(`      [harness] baseline auto-restore = ${JSON.stringify(baseline)}`);

    // (2) open the modal, fill it, then VERIFY the values landed
    await page.click('#newConnectionBtn');
    await page.waitForSelector('#hostInput', { state: 'visible', timeout: 15000 });
    await page.fill('#hostInput', host);
    await page.fill('#portInput', port);
    await page.fill('#usernameInput', user);

    /*
     * THE AUTHENTICATION METHOD IS CHOSEN EXPLICITLY, from SSH_AUTH_TYPE.
     * Letting the form's own default stand is a trap in some deployments.
     *
     * Measured in one of them: the target answered with a Tailscale SSH
     * banner rather than OpenSSH, because the container shares a Tailscale
     * gateway's network namespace, so every tailnet address reaches
     * Tailscale's own SSH server -- which does no password authentication.
     * The consequence was silent: the ssh_connect handler logged nothing and
     * emitted nothing, not even ssh_error, because it was still inside the
     * handshake, while the socket itself was healthy. Choosing the method
     * explicitly is what keeps a gate from waiting on that.
     */
    const authType = opts.authType || C.SSH_AUTH_TYPE;
    await page.selectOption('#authTypeSelect', authType);
    if (authType === 'password') {
        await page.fill('#passwordInput', pass);
    }

    const filled = await page.evaluate(() => {
        const g = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
        return { host: g('hostInput'), port: g('portInput'), user: g('usernameInput'),
            authType: g('authTypeSelect'),
            passLen: (g('passwordInput') || '').length };
    });
    if (filled.host !== host || filled.user !== user) {
        throw new Error('GATE: the form did not take the values -- '
            + JSON.stringify(filled) + ` (wanted host=${host} user=${user})`);
    }
    if (filled.authType !== authType) {
        throw new Error(`GATE: authType not accepted -- the form holds`
            + ` ${filled.authType}, wanted ${authType}`);
    }
    if (authType === 'password' && filled.passLen === 0) {
        throw new Error('GATE: the password did not reach the form');
    }
    console.log(`      [harness] authType=${filled.authType} host=${host} user=${user}`);

    // (3) connect, then wait for the session with OUR target
    await page.click('#connectBtn');
    let sid = null;
    try {
        const h = await page.waitForFunction(({ hh, uu, base }) => {
            for (const [id, s] of Object.entries(SessionManager.sessions || {})) {
                if (base[id]) continue;                 // auto-restored, skip
                if (s.host === hh && s.username === uu) return id;
            }
            return null;
        }, { hh: host, uu: user, base: baseline }, { timeout: 60000, polling: 250 });
        sid = await h.jsonValue();
    } catch (e) {
        const why = await page.evaluate(() => {
            const msgs = [...document.querySelectorAll(
                '.flash, .alert, [role="alert"], .toast, .error, .form-error')]
                .filter(el => el.getBoundingClientRect().height > 0)
                .map(el => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 150));
            const now = {};
            for (const [id, s] of Object.entries(SessionManager.sessions || {})) {
                now[id] = `${s.username}@${s.host} connected=${!!s.connected}`;
            }
            return { msgs, now };
        });
        throw new Error(`connect produced no session for ${user}@${host}.`
            + ` The app reports: ${JSON.stringify(why)}`);
    }
    console.log(`      [harness] OUR session = ${sid.slice(0, 8)} (${user}@${host})`);

    // (4) the terminal carries real bytes before this counts as done
    await page.waitForFunction((s) => {
        const keys = (TerminalManager.sessionTerminals || {})[s] || [];
        const t = TerminalManager.terminals[keys[0]];
        return !!(t && t.buffer.active.length > 1);
    }, sid, { timeout: 60000 });
    await settle(page, sid);
    return sid;
}

/*
 * WAIT FOR A SETTLED STATE -- without this a gate measures mid-transition.
 *
 * Measured: immediately after #connectBtn succeeds, #connectionModal still
 * carries `show` at z-index 9000 over the whole viewport and the terminal
 * wrapper is at opacity 0. Inside that window the grid reads 80x24 -- the
 * PTY default -- and only then jumps to the browser's fit. Anything concluded
 * from that window is an illusion.
 *
 * So "settled" means: no modal showing, the wrapper no longer transparent,
 * and xterm's helper textarea present to take focus.
 */
export async function settle(page, sid, timeout = 30000) {
    await page.waitForFunction((s) => {
        // offsetParent LA PHEP THU SAI: theo spec, phan tu position:fixed luon
        // tra offsetParent === null. #connectionModal la fixed, nen phep thu cu
        // luon bao "khong co modal" du modal dang phu kin 1440x900 voi
        // pointer-events:auto o z-index 9000 -- do duoc o probe8. Thay bang
        // phep thu CHE PHU THAT: co ve ra, co nhan chuot, va co dien tich.
        const anyModal = [...document.querySelectorAll('.modal')].filter(m => { const st = getComputedStyle(m); const q = m.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) >= 0.01 && st.pointerEvents !== 'none' && q.width > 1 && q.height > 1; }).length > 0;

        if (anyModal) return false;
        const w = TerminalManager.terminalContainers[s];
        if (!w) return false;
        const st = getComputedStyle(w);
        if (parseFloat(st.opacity) < 0.99) return false;
        if (st.visibility === 'hidden') return false;
        return !!w.querySelector('textarea.xterm-helper-textarea');
    }, sid, { timeout });
    // one more frame, so the geometry has been applied
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/*
 * ATTACH TO A LIVE SESSION, named explicitly.
 *
 * Why it exists: opening a new connection is not always reliable in a given
 * deployment -- inside a container that shares another container's network
 * namespace, 127.0.0.1 is not the host a reader means by it. And for geometry,
 * caret or IME measurements a NEW session is not needed anyway: a real, live
 * one is. The app restores one by itself. What was missing was certainty about
 * WHICH session was being measured, so this returns the id together with its
 * host and user and throws when nothing is connected.
 */
export async function attachExisting(page,
        { host = C.SSH_HOST || null, user = null } = {}) {
    // Mac dinh theo cred file: moi truong nay co ca offer CHET (tmux da bi kill)
    // lan offer song, va loc "offer dau tien" se bam vao cai chet roi cho 60s
    // pointless. Measured: an offer can point at a tmux session that no
    // con ton tai, server dung dan tu choi reattach.
    // auto-restore settles: the session count holds for 2.5s
    await page.waitForFunction(() => {
        const n = Object.keys(SessionManager.sessions || {}).length;
        if (window.__aeN !== n) { window.__aeN = n; window.__aeAt = Date.now(); return false; }
        return Date.now() - (window.__aeAt || 0) > 2500;
    }, null, { timeout: 60000, polling: 200 });

    const all = await page.evaluate(() => Object.fromEntries(
        Object.entries(SessionManager.sessions || {}).map(([id, s]) => [id, {
            host: s.host, user: s.username, port: s.port,
            connected: !!s.connected, tmux: s.tmuxSessionName || null,
            useTmux: !!s.useTmux,
        }])));

    /*
     * AN OFFER HAS TO BE ACCEPTED; waiting for it to connect itself hangs.
     *
     * A candidate session does not reconnect on its own: it stays an offer
     * with connected=false until someone chooses it, which is the contract
     * mobile_reconnect_list pins. So the harness behaves like a person --
     * accept the offer through the app's own path, then wait for connected.
     */
    let picked = Object.entries(all).find(([, s]) => s.connected
        && (!host || s.host === host) && (!user || s.user === user));

    if (!picked) {
        const offer = Object.entries(all).find(([, s]) => !s.connected && s.tmux
            && (!host || s.host === host) && (!user || s.user === user));
        if (!offer) {
            throw new Error('GATE: no connected session and no offer'
                + (host ? ` for host=${host}` : '') + `. Present: ${JSON.stringify(all)}`);
        }
        const offerId = offer[0];
        console.log(`      [harness] accepting offer ${offerId.slice(0, 8)}`
            + ` = ${offer[1].user}@${offer[1].host} (the user's own path)`);
        await page.evaluate((s) => SessionManager.directReconnect(s), offerId);
        // Wait for A session connected to that target. Reconnecting can
        // return a NEW session id -- the server issues one when it reattaches
        // by tmux name -- so match on host and user, not on the old id.
        await page.waitForFunction(({ h, u }) => {
            for (const s of Object.values(SessionManager.sessions || {})) {
                if (s.connected && (!h || s.host === h) && (!u || s.user === u
                        || s.username === u)) return true;
            }
            return false;
        }, { h: offer[1].host, u: offer[1].user }, { timeout: 60000, polling: 250 });
        const again = await page.evaluate(() => Object.fromEntries(
            Object.entries(SessionManager.sessions || {}).map(([id, s]) => [id, {
                host: s.host, user: s.username, port: s.port,
                connected: !!s.connected, tmux: s.tmuxSessionName || null,
                useTmux: !!s.useTmux,
            }])));
        picked = Object.entries(again).find(([, s]) => s.connected
            && s.host === offer[1].host);
        if (!picked) {
            throw new Error(`GATE: the offer was accepted but never connected: `
                + JSON.stringify(again));
        }
    }
    const [sid, info] = picked;
    console.log(`      [harness] measuring session ${sid.slice(0, 8)} = ${info.user}@${info.host}:${info.port}`
        + ` tmux=${info.tmux || 'none'} useTmux=${info.useTmux}`);

    // a terminal carrying real bytes is required
    await page.waitForFunction((s) => {
        const keys = (TerminalManager.sessionTerminals || {})[s] || [];
        const t = TerminalManager.terminals[keys[0]];
        return !!(t && t.buffer.active.length > 1);
    }, sid, { timeout: 60000 });

    // make this session the active pane, then wait for it to settle
    await page.evaluate((s) => {
        if (typeof SessionManager.switchSession === 'function'
            && SessionManager.activeSessionId !== s) {
            SessionManager.switchSession(s);
        }
    }, sid);
    await settle(page, sid);
    return { sid, info };
}

/* Focus the terminal through the app's own API and return what ended up
 * focused. Clicking coordinates is unreliable while an overlay is up. */
export async function focusTerminal(page, sid) {
    return await page.evaluate((s) => {
        const tm = TerminalManager;
        const keys = tm.sessionTerminals[s] || [];
        const t = tm.terminals[keys[0]];
        if (t && typeof t.focus === 'function') t.focus();
        const a = document.activeElement;
        return {
            cls: a ? String(a.className) : null,
            isHelper: !!(a && a.classList && a.classList.contains('xterm-helper-textarea')),
        };
    }, sid);
}

/*
 * THE MEASUREMENT. Reads BOTH buffers and always records the type.
 * Throws when the type is missing, so "baseY=0 means the history is gone"
 * cannot be concluded again.
 */
export async function measure(page, sid) {
    const m = await page.evaluate((s) => {
        const tm = TerminalManager;
        const wrapper = tm.terminalContainers[s];
        const keys = tm.sessionTerminals[s] || [];
        const t = tm.terminals[keys[0]];
        if (!t) return { missing: 'terminal' };
        const snap = (b) => b ? {
            type: b.type, baseY: b.baseY, length: b.length,
            viewportY: b.viewportY, cursorX: b.cursorX, cursorY: b.cursorY,
        } : null;
        const vp = t.element ? t.element.querySelector('.xterm-viewport') : null;
        const a = t.buffer.active;
        const caret = a.getLine(a.baseY + a.cursorY);
        const tail = [];
        for (let i = Math.max(0, a.length - 3); i < a.length; i++) {
            const ln = a.getLine(i);
            if (ln) tail.push(ln.translateToString(true).trimEnd().slice(0, 60));
        }
        return {
            grid: `${t.cols}x${t.rows}`, cols: t.cols, rows: t.rows,
            active: snap(a),
            normal: snap(t.buffer.normal),
            onAltScreen: a.type === 'alternate',
            caretRow: caret ? caret.translateToString(true).trimEnd() : null,
            tail,
            vpScrollTop: vp ? Math.round(vp.scrollTop) : -1,
            vpScrollHeight: vp ? Math.round(vp.scrollHeight) : -1,
            vpClientHeight: vp ? Math.round(vp.clientHeight) : -1,
            canScroll: vp ? vp.scrollHeight > vp.clientHeight + 1 : null,
            wrapperVisible: !!(wrapper && wrapper.offsetParent !== null),
            // offsetParent alone is not enough: it was measured non-null
            // while opacity was 0 -- the app believed the terminal was
            // showing while a reader saw nothing. Record both.
            wrapperOpacity: wrapper ? getComputedStyle(wrapper).opacity : null,
            wrapperReallyVisible: !!(wrapper && wrapper.offsetParent !== null
                && parseFloat(getComputedStyle(wrapper).opacity) >= 0.99
                && getComputedStyle(wrapper).visibility !== 'hidden'),
            // cung ly do nhu trong settle(): KHONG dung offsetParent cho phan tu
            // fixed. Bao ca class `show` va trang thai che phu that.
            modalsCovering: [...document.querySelectorAll('.modal')].filter(m => { const st = getComputedStyle(m); const q = m.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) >= 0.01 && st.pointerEvents !== 'none' && q.width > 1 && q.height > 1; }).map(m => `${m.id || 'modal'}[show=${m.classList.contains('show')},z=${getComputedStyle(m).zIndex}]`),

            pannable: !!(wrapper && wrapper.classList.contains('pane-pannable')),
            docScrollY: document.documentElement.scrollTop,
            docScrollX: document.documentElement.scrollLeft,
        };
    }, sid);
    if (m.missing) throw new Error(`measure: no ${m.missing} for ${sid}`);
    if (!m.active || !m.active.type) {
        throw new Error('measure: bufferType MISSING -- refusing to return a blind measurement');
    }
    return m;
}

export const check = (state) => (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { state.pass++; console.log(`PASS  ${label}`); }
    else {
        state.fail++; state.failures.push(label);
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
};
export const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);
export const summary = (name, state) => {
    console.log(`\n${name}: ${state.pass} pass, ${state.fail} fail`);
    if (state.failures.length) {
        console.log('FAILED:');
        state.failures.forEach(f => console.log('  - ' + f));
    }
};
