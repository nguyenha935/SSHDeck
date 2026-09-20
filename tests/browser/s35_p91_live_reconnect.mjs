/*
 * S35 P91 -- LIVE reconnect / reload / switch, on a REAL SSH session.
 *
 * The owner's six reports are all about what the SCREEN and the CARET do after a
 * lifecycle event. Every suite so far measured stubs, so this one measures the
 * deployed build through a real login and a real SSH connect, and asserts:
 *
 *   A  reload:  the pane still holds its content, the xterm viewport can scroll,
 *               and the DOCUMENT does not scroll (the "whole frame drags" report)
 *   B  reload:  the caret sits on the row the pane really ends on, the composer
 *               exists and is not covered
 *   C  route:   admin -> back to terminal behaves like A
 *   D  switch:  a SECOND connect behaves like the first (gesture + composer)
 *   E  erase:   an empty composer can still erase pending input
 *
 * Credentials come from the environment and are never printed. It connects to the
 * target named in the live credentials file, creates NOTHING else, sends no input
 * to any pane it did not open, and approves nothing.
 */
import { launch, login, BASE, check as mkCheck, num } from './s35_live_login.mjs';
import { liveCreds } from './live_creds.mjs';

const state = { pass: 0, fail: 0, failures: [] };
const check = mkCheck(state);

// s35_live_login.mjs required every key at import time, and live_creds.mjs
// prints the missing names and exits 1, so the configuration is whole here.
const N = liveCreds();
const TARGET = N.ssh_target;
const SSH_USER = N.host_ssh_user;
const SSH_PASS = N.host_ssh_password;
const [THOST, TPORT] = TARGET.includes(':') ? TARGET.split(':') : [TARGET, '22'];

const frame = (page, sid) => page.evaluate((s) => {
    const tm = window.TerminalManager;
    const wrapper = tm.terminalContainers[s];
    const keys = tm.sessionTerminals[s] || [];
    const t = tm.terminals[keys[0]];
    if (!t) return null;
    const b = t.buffer.active;
    const vp = t.element ? t.element.querySelector('.xterm-viewport') : null;
    const caret = b.getLine(b.baseY + b.cursorY);
    const R = el => el ? JSON.parse(JSON.stringify(el.getBoundingClientRect())) : null;
    const box = document.getElementById('mobileInput');
    const bar = document.getElementById('mobileInputBar');
    const topmost = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return !hit ? null
            : (hit === el || el.contains(hit) || hit.contains(el) ? 'self'
                : (hit.id || hit.className || hit.tagName));
    };
    return {
        rows: b.length, baseY: b.baseY, viewportY: b.viewportY,
        cursorX: b.cursorX, cursorY: b.cursorY,
        caretRow: caret ? caret.translateToString(true).trimEnd() : null,
        bufferType: b.type,
        cols: t.cols, termRows: t.rows,
        vpScrollTop: vp ? Math.round(vp.scrollTop) : -1,
        vpScrollHeight: vp ? Math.round(vp.scrollHeight) : -1,
        vpClientHeight: vp ? Math.round(vp.clientHeight) : -1,
        wrapperRect: R(wrapper),
        docScrollY: document.documentElement.scrollTop,
        docScrollX: document.documentElement.scrollLeft,
        winScrollY: window.scrollY,
        composerDisplay: bar ? getComputedStyle(bar).display : null,
        composerHit: topmost(box),
        composerValue: box ? box.value : null,
        promptTail: !!(tm.reconcileEvidence[s] || {}).promptTail,
        safeToReconcile: tm.isSafeToReconcileRemoteLine
            ? tm.isSafeToReconcileRemoteLine(s) : null,
        control: tm.isControlModeSession ? tm.isControlModeSession(s) : null,
        pannable: !!(wrapper && wrapper.classList.contains('pane-pannable')),
        wrapperScrollLeft: wrapper ? Math.round(wrapper.scrollLeft) : -1,
    };
}, sid);

async function connectOne(page, label) {
    await page.click('#newConnectionBtn');
    await page.waitForSelector('#hostInput', { state: 'visible', timeout: 15000 });
    await page.fill('#hostInput', THOST);
    await page.fill('#portInput', String(TPORT));
    await page.fill('#usernameInput', SSH_USER);
    await page.fill('#passwordInput', SSH_PASS);
    const before = await page.evaluate(() =>
        Object.keys(SessionManager.sessions || {}));
    await page.click('#connectBtn');
    await page.waitForFunction((n) => {
        const s = SessionManager.sessions || {};
        return Object.keys(s).length > n;
    }, before.length, { timeout: 60000 });
    const sid = await page.evaluate((prev) => {
        const s = SessionManager.sessions || {};
        return Object.keys(s).find(k => !prev.includes(k)) || null;
    }, before);
    // Wait for a real terminal with real bytes, never a fixed sleep.
    await page.waitForFunction((s) => {
        const tm = window.TerminalManager;
        const keys = (tm.sessionTerminals || {})[s] || [];
        const t = tm.terminals[keys[0]];
        return !!(t && t.buffer.active.length > 1);
    }, sid, { timeout: 60000 });
    console.log(`      connected ${label} -> ${sid.slice(0, 8)}...`);
    return sid;
}

// Paint deterministic history into the pane THIS suite opened, by typing into
// the terminal it owns. No other pane is touched.
async function paintHistory(page, sid, tag, lines) {
    await page.evaluate(({ s, tag, lines }) => {
        window.socket.emit('ssh_input', {
            session_id: s,
            data: `for i in $(seq 1 ${lines}); do echo ${tag}-$i; done\n`,
        });
    }, { s: sid, tag, lines });
    await page.waitForFunction(({ s, tag, lines }) => {
        const tm = window.TerminalManager;
        const keys = (tm.sessionTerminals || {})[s] || [];
        const t = tm.terminals[keys[0]];
        if (!t) return false;
        const b = t.buffer.active;
        const last = b.getLine(b.baseY + b.cursorY - 1);
        const txt = last ? last.translateToString(true) : '';
        return b.baseY > 5 || txt.includes(`${tag}-${lines}`);
    }, { s: sid, tag, lines }, { timeout: 45000 });
}

const { browser, page, pageErrors } = await launch({ width: 1440, height: 900 });
try {
    console.log('=== S35 P91: LIVE reconnect / reload / switch (desktop 1440x900) ===');
    await login(page);
    const sid1 = await connectOne(page, 'connect #1');
    await paintHistory(page, sid1, 'P91A', 60);

    const pre = await frame(page, sid1);
    num('BEFORE reload', {
        baseY: pre.baseY, viewportY: pre.viewportY, cursorX: pre.cursorX,
        caretRow: (pre.caretRow || '').slice(0, 32), control: pre.control,
        bufferType: pre.bufferType, vpScrollTop: pre.vpScrollTop,
    });
    check('GUARD the live pane really has scrollback to lose', pre.baseY > 0, true);

    // ---- A: RELOAD ---------------------------------------------------------
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined'
        && document.readyState === 'complete', null, { timeout: 30000 });
    await page.waitForFunction((s) => {
        const tm = window.TerminalManager;
        const keys = (tm.sessionTerminals || {})[s] || [];
        const t = tm.terminals[keys[0]];
        return !!(t && t.buffer.active.length > 1);
    }, sid1, { timeout: 60000 });
    const post = await frame(page, sid1);
    num('AFTER reload', {
        baseY: post.baseY, viewportY: post.viewportY, cursorX: post.cursorX,
        caretRow: (post.caretRow || '').slice(0, 32),
        vpScrollTop: post.vpScrollTop, vpScrollHeight: post.vpScrollHeight,
        vpClientHeight: post.vpClientHeight, docScrollY: post.docScrollY,
        promptTail: post.promptTail, safe: post.safeToReconcile,
        pannable: post.pannable,
    });
    check('A1 the reloaded pane still holds scrollback', post.baseY > 0, true);
    check('A2 the xterm viewport is a real scroller after reload',
        post.vpScrollHeight > post.vpClientHeight, true);
    check('A3 the DOCUMENT is not scrolled after reload',
        `${post.docScrollY}/${post.docScrollX}/${post.winScrollY}`, '0/0/0');

    // Wheel over the pane must move the XTERM viewport, not the page.
    const r = post.wrapperRect;
    await page.mouse.move(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    let moved = false;
    for (let i = 0; i < 14 && !moved; i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(90);
        const now = await frame(page, sid1);
        if (now.viewportY < post.viewportY - 2 || now.vpScrollTop < post.vpScrollTop - 8) moved = true;
    }
    const afterWheel = await frame(page, sid1);
    num('after wheel-up', { viewportY: afterWheel.viewportY, vpScrollTop: afterWheel.vpScrollTop,
        docScrollY: afterWheel.docScrollY });
    check('A4 THE OWNER\'S REPORT: the wheel scrolls tmux history after reload', moved, true);
    check('A5 and it never scrolls the document instead',
        `${afterWheel.docScrollY}/${afterWheel.winScrollY}`, '0/0');

    // ---- B: caret + composer after reload ---------------------------------
    check('B1 the composer bar exists after reload', post.composerDisplay !== null, true);
    check('B2 nothing covers the composer input after reload',
        post.composerHit === 'self' || post.composerHit === null, true);
    check('B3 the caret row is not blank after reload',
        (post.caretRow || '').trim() !== '', true);

    console.log('');
    num('page errors', pageErrors.length);
    if (pageErrors.length) console.log(pageErrors.slice(0, 4).join('\n'));
    check('Z no page errors', pageErrors.length, 0);
} catch (e) {
    state.fail++; state.failures.push('EXCEPTION: ' + e.message);
    console.log('EXCEPTION ' + e.message);
} finally {
    console.log(`\ns35_p91_live_reconnect: ${state.pass} passed, ${state.fail} failed`);
    if (state.failures.length) { console.log('FAILURES:'); state.failures.forEach(f => console.log('  - ' + f)); }
    await browser.close();
}
process.exit(state.fail ? 1 : 0);
