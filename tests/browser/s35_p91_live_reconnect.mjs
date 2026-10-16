/*
 * S35 P91 -- LIVE reload, on a REAL SSH session.
 *
 * The owner's reports are about what the SCREEN and the CARET do after a
 * reload. Every suite so far measured stubs, so this one measures a running
 * server through a real login and a real SSH connect, and asserts:
 *
 *   A  reload:  the pane shows the same screen, the wheel scrolls the tmux
 *               history, and the DOCUMENT does not scroll (the "whole frame
 *               drags" report)
 *   B  reload:  the caret sits on a real row, the composer exists and is not
 *               covered
 *
 * The history is tmux's, not xterm's: the pane is a tmux client on xterm's
 * alternate buffer (measured 2026-10-16: baseY 0 before and after the reload,
 * and xterm 6 has no DOM scroller -- .xterm-viewport scrollHeight equals its
 * clientHeight). So history is read from the SCREEN: the painted lines carry
 * their number, and scrolling up shows smaller numbers.
 *
 * It connects to the throwaway world's SSH target (live_world.mjs), sends no
 * input to any pane it did not open, and closes what it opened.
 */
import { launch, login, C, check as mkCheck, num } from './s35_live_login.mjs';

const state = { pass: 0, fail: 0, failures: [] };
const check = mkCheck(state);

const THOST = C.SSH_HOST;
const TPORT = C.SSH_PORT;
const SSH_USER = C.SSH_USER;
const SSH_PASS = C.SSH_PASS;

const TAG = 'P91A';
const LINES = 60;

const frame = (page, sid) => page.evaluate(({ s, tag }) => {
    const tm = window.TerminalManager;
    const wrapper = tm.terminalContainers[s];
    const keys = tm.sessionTerminals[s] || [];
    const t = tm.terminals[keys[0]];
    if (!t) return null;
    const b = t.buffer.active;
    const caret = b.getLine(b.baseY + b.cursorY);
    // tmux repaints a row with trailing blanks, so trim before matching.
    const tagged = [];
    for (let i = b.viewportY; i < b.viewportY + t.rows; i++) {
        const m = (b.getLine(i)?.translateToString(true) || '').trim()
            .match(new RegExp(`^${tag}-(\\d+)$`));
        if (m) tagged.push(Number(m[1]));
    }
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
        bufferType: b.type, baseY: b.baseY, cols: t.cols, termRows: t.rows,
        first: tagged.length ? Math.min(...tagged) : null,
        last: tagged.length ? Math.max(...tagged) : null,
        caretRow: caret ? caret.translateToString(true).trimEnd() : null,
        wrapperRect: R(wrapper),
        docScrollY: document.documentElement.scrollTop,
        docScrollX: document.documentElement.scrollLeft,
        winScrollY: window.scrollY,
        composerDisplay: bar ? getComputedStyle(bar).display : null,
        composerHit: topmost(box),
    };
}, { s: sid, tag: TAG });

// The screen has settled on the painted lines: the last one is on it.
const showsLast = (page, sid) => page.waitForFunction(({ s, tag, lines }) => {
    const tm = window.TerminalManager;
    const t = tm && tm.terminals[((tm.sessionTerminals || {})[s] || [])[0]];
    if (!t) return false;
    const b = t.buffer.active;
    for (let i = b.viewportY; i < b.viewportY + t.rows; i++) {
        if ((b.getLine(i)?.translateToString(true) || '').trim() === `${tag}-${lines}`) return true;
    }
    return false;
}, { s: sid, tag: TAG, lines: LINES }, { timeout: 45000 });

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

// Paint numbered lines into the pane THIS suite opened, by typing into the
// terminal it owns. No other pane is touched.
async function paintHistory(page, sid) {
    await page.evaluate(({ s, tag, lines }) => {
        window.socket.emit('ssh_input', {
            session_id: s,
            data: `for i in $(seq 1 ${lines}); do echo ${tag}-$i; done\n`,
        });
    }, { s: sid, tag: TAG, lines: LINES });
    await showsLast(page, sid);
}

const { browser, page, pageErrors } = await launch({ width: 1440, height: 900 });
let sid1 = null;
try {
    console.log('=== S35 P91: LIVE reload (desktop 1440x900) ===');
    await login(page);
    sid1 = await connectOne(page, 'connect #1');
    await paintHistory(page, sid1);

    const pre = await frame(page, sid1);
    num('BEFORE reload', {
        first: pre.first, last: pre.last, bufferType: pre.bufferType,
        baseY: pre.baseY, grid: `${pre.cols}x${pre.termRows}`,
    });
    check('GUARD the screen ends on the last painted line', pre.last, LINES);
    check('GUARD there is history above the screen to scroll to', pre.first > 1, true);

    // ---- A: RELOAD ---------------------------------------------------------
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined'
        && document.readyState === 'complete', null, { timeout: 30000 });
    await showsLast(page, sid1);
    // The attach replays history onto the normal buffer before tmux's own
    // screen arrives; read once the screen holds still.
    await page.waitForTimeout(1500);
    const post = await frame(page, sid1);
    num('AFTER reload', {
        first: post.first, last: post.last, bufferType: post.bufferType,
        baseY: post.baseY, caretRow: (post.caretRow || '').slice(0, 32),
        docScrollY: post.docScrollY,
    });
    check('A1 the reloaded pane shows the same screen',
        `${post.first}..${post.last}`, `${pre.first}..${pre.last}`);
    check('A3 the DOCUMENT is not scrolled after reload',
        `${post.docScrollY}/${post.docScrollX}/${post.winScrollY}`, '0/0/0');

    // Wheel over the pane must scroll the tmux history, not the page.
    const r = post.wrapperRect;
    await page.mouse.move(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    let afterWheel = post;
    for (let i = 0; i < 14 && !(afterWheel.first < post.first); i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(150);
        afterWheel = await frame(page, sid1);
    }
    num('after wheel-up', { first: afterWheel.first, last: afterWheel.last,
        docScrollY: afterWheel.docScrollY });
    check('A4 THE OWNER\'S REPORT: the wheel scrolls tmux history after reload',
        afterWheel.first < post.first, true);
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
    if (sid1) {
        await page.evaluate(s => window.socket.emit('ssh_disconnect', { session_id: s }), sid1)
            .catch(() => {});
        await page.waitForTimeout(1500);
    }
    console.log(`\ns35_p91_live_reconnect: ${state.pass} passed, ${state.fail} failed`);
    if (state.failures.length) { console.log('FAILURES:'); state.failures.forEach(f => console.log('  - ' + f)); }
    await browser.close();
}
process.exit(state.fail ? 1 : 0);
