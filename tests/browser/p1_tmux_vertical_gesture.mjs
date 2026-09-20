/*
 * P1 / S11 — behavioural replacement for the tmux vertical-gesture contract.
 *
 * WHY THIS FILE EXISTS. `tests/test_mobile_geometry.py` used to assert the
 * literal source string `'!isMouseTrackingOn() && !isTmuxSession'`. That string
 * WAS the P8 defect: `useTmux` is an app-level flag that xterm knows nothing
 * about, so gating the local-scroll branch on it made a tmux session forward
 * bytes instead of scrolling its own history. S5 replaced the guard with
 * `ScrollOwner.resolve()` (plan §6.1, decision D-2), which reads the four things
 * that actually decide ownership: mouse tracking mode, buffer type, scrollback
 * capacity, and the SGR-encoding flag. A string-presence test cannot see any of
 * that -- it stays green whatever the runtime does, and it pinned exactly the
 * wrong guard.
 *
 * The replacement is behavioural, per plan §8.8: a REAL CDP touch gesture on a
 * REAL tmux session, measured against the state that actually moves.
 *
 * WHAT IS MEASURED, AND WHY EACH ROW HAS A COMPANION (AGENTS.md §2).
 *
 *   ownership     ScrollOwner.resolve() must answer A -- a plain tmux shell in
 *                 the normal buffer with scrollback and no mouse tracking. This
 *                 is the row whose whole contract is "scroll locally, emit
 *                 nothing". Asserted so the two gesture rows below cannot pass
 *                 vacuously on some other row.
 *   the state     `buffer.active.viewportY` -- what `terminal.scrollLines(n)`
 *                 moves. `.xterm-viewport.scrollTop` is xterm's RENDER MIRROR of
 *                 that state, not the state: it is asserted too, but as a
 *                 companion, never alone.
 *   direction     At rest the viewport sits at the bottom (viewportY === baseY),
 *                 so the only direction with room is BACK into history. Both
 *                 directions are driven: back-into-history must move, and
 *                 already-at-the-bottom must be a NO-OP (plan T2, §3.5:
 *                 "ở đáy phải no-op"). A suite that only drove the moving
 *                 direction could not tell a working gesture from one that
 *                 scrolls on every input.
 *   zero bytes    `ssh_input` frames must be exactly 0 across every gesture.
 *                 The companion is the ownership row: bytes-zero on a row that
 *                 was never supposed to emit proves nothing on its own.
 *
 * Run: node tests/browser/p1_tmux_vertical_gesture.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
    if (ok) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        const msg = `FAIL  ${label}${detail ? ` (${detail})` : ''}`;
        failures.push(msg);
        console.log(msg);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

// The fixture socket must install `window.io`, not `window.socket`: app.js's
// first statement is `window.socket = io(...)`, so an injected socket object is
// silently overwritten at startup and every emit would land nowhere.
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, id: 'device_a_socket', io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; }, once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) { window.__emits.push({ evt, payload }); return sock; },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.io = () => sock;
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

// Both viewports the plan names for the touch shell: the portrait phone and the
// short landscape, where P1-LAND measured the compositor claiming the gesture.
const VIEWPORTS = [
    { label: 'phone390x844', width: 390, height: 844 },
    { label: 'land926x428', width: 926, height: 428 },
];

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);
    // Geometry reads must not race an animation (AGENTS.md §2).
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });

    // A REAL tmux session: use_tmux true and a tmux session name, which is what
    // SessionManager stores as `useTmux` / `tmuxSessionName`.
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 't1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-s11', via_jump: null,
        });
        SessionManager.assignSessionToPane('t1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(400);

    // Real scrollback: without content taller than the viewport there is
    // nothing to scroll and every row below would pass vacuously.
    const pre = await page.evaluate(async () => {
        const term = TerminalManager.terminals['t1'];
        if (!term) return { error: 'terminal t1 not found' };
        for (let i = 1; i <= 200; i++) {
            term.write(`tmux history line ${String(i).padStart(3, '0')} `
                + `SSHDeck vertical gesture contract\r\n`);
        }
        await new Promise(r => setTimeout(r, 120));
        /*
         * Count every wheel event that reaches the terminal element.
         *
         * This is the MECHANISM row, and it is the one that separates a locally
         * scrolling gesture from a forwarded one. Measured
         * (/tmp/s11work/probe_m5_equivalence.out): on row A the gesture produces
         * ZERO wheel events and moves viewportY directly via scrollLines(); on a
         * byte-emitting row the same gesture synthesizes 4 line-mode wheels, and
         * xterm -- with no application actually attached to this fixture -- then
         * scrolls its own viewport by the same amount and emits no bytes. So the
         * observable end state is IDENTICAL and "viewportY moved, zero bytes"
         * cannot tell the two apart. The wheel count can, and it is the thing
         * that would put SGR reports on a real PTY.
         */
        window.__wheels = [];
        term.element.addEventListener('wheel', (e) => {
            window.__wheels.push({ deltaY: e.deltaY, deltaMode: e.deltaMode });
        }, true);
        const wrapper = TerminalManager.terminalContainers['t1'];
        const viewport = term.element
            ? term.element.querySelector('.xterm-viewport') : null;
        const sess = SessionManager.getSession('t1');
        return {
            useTmux: !!(sess && sess.useTmux),
            tmuxName: sess ? sess.tmuxSessionName : null,
            ownerRow: TerminalManager.ScrollOwner.resolve(term),
            mouseTrackingMode: term.modes ? term.modes.mouseTrackingMode : 'MISSING',
            bufferType: term.buffer.active.type,
            scrollback: term.options.scrollback,
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
            scrollTop: viewport ? viewport.scrollTop : -1,
            scrollHeight: viewport ? viewport.scrollHeight : -1,
            clientHeight: viewport ? viewport.clientHeight : -1,
            wrapperRect: wrapper
                ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
        };
    });

    if (pre.error) {
        check(`${vp.label}: harness precondition failed loudly`, false, pre.error);
        await ctx.close();
        continue;
    }

    check(`${vp.label} precondition: the session really is tmux`,
        pre.useTmux === true && pre.tmuxName === 'p1-s11',
        `useTmux=${pre.useTmux} name=${pre.tmuxName}`);
    // Real scrollback to move through, asserted on the ENGINE's buffer. The
    // DOM scroller is not a portable proof of it: xterm 6 has no scroll range.
    check(`${vp.label} precondition: scrollback has real vertical overflow`,
        pre.baseY > 0,
        `baseY=${pre.baseY} scrollback=${pre.scrollback}`);
    check(`${vp.label} precondition: the viewport starts AT THE BOTTOM`,
        pre.viewportY === pre.baseY,
        `viewportY=${pre.viewportY} baseY=${pre.baseY}`);
    // The ownership row is the companion that stops the two gesture rows below
    // from passing on some unrelated row (e.g. an explicit no-op row, where
    // "zero bytes" is true for the wrong reason).
    check(`${vp.label}: ScrollOwner resolves the tmux shell to row A (local scroll, no bytes)`,
        pre.ownerRow === 'A',
        `row=${pre.ownerRow} tracking=${pre.mouseTrackingMode} `
        + `buffer=${pre.bufferType} scrollback=${pre.scrollback}`);

    const cdp = await ctx.newCDPSession(page);
    const wr = pre.wrapperRect;
    const vx = Math.round(wr.left + wr.width / 2);
    const yLow = Math.round(wr.top + wr.height * 0.8);
    const yHigh = Math.round(wr.top + wr.height * 0.2);

    const snapshot = () => page.evaluate(() => {
        const term = TerminalManager.terminals['t1'];
        const viewport = term.element.querySelector('.xterm-viewport');
        const wrapper = TerminalManager.terminalContainers['t1'];
        /*
         * The visible line's IDENTITY, not its text. At 390px every history line
         * WRAPS, so the topmost row is usually a continuation fragment
         * ("ntract") that reads identically at many scroll positions --
         * comparing that string cannot tell a scrolled viewport from a still
         * one. Each written line carries its own ordinal, so the first ordinal
         * visible in the viewport is a wrap-proof identity for "where am I in
         * history".
         */
        const buf = term.buffer.active;
        let topOrdinal = null;
        for (let r = 0; r < term.rows; r++) {
            const line = buf.getLine(buf.viewportY + r);
            if (!line) break;
            const m = /tmux history line (\d+)/.exec(line.translateToString(true));
            if (m) { topOrdinal = Number(m[1]); break; }
        }
        // The first row the user can actually SEE, read from the rendered
        // rows. It replaces `.xterm-viewport.scrollTop` as the render proof:
        // xterm 6 renders without a DOM scroll range at all (scrollHeight ===
        // clientHeight, scrollTop pinned at 0), so the old mirror reports
        // "nothing moved" for a viewport that plainly did.
        const rowsEl = term.element
            ? term.element.querySelector('.xterm-rows') : null;
        // The whole painted screen, not its first row: xterm 6 keeps a row
        // element per screen line and rewrites their text in place, so the
        // first child is not reliably the topmost visible line.
        const paintedTop = rowsEl ? (rowsEl.textContent || '').trim() : null;
        return {
            viewportY: buf.viewportY,
            baseY: buf.baseY,
            scrollTop: viewport ? viewport.scrollTop : -1,
            paintedTop,
            topOrdinal,
            scrollLeft: wrapper ? wrapper.scrollLeft : -1,
            wheelCount: (window.__wheels || []).length,
            bytes: window.__emits
                .filter(e => e.evt === 'ssh_input')
                .map(e => e.payload && e.payload.data),
        };
    });

    // A trusted CDP swipe. `steps` moves must each be a separate dispatch: the
    // gesture path decides its axis from cumulative distance and needs more than
    // one move to cross MOVE_THRESHOLD.
    const swipe = async (fromY, toY, id) => {
        await cdp.send('Input.dispatchTouchEvent',
            { type: 'touchStart', touchPoints: [{ x: vx, y: fromY, id }] });
        for (let s = 1; s <= 8; s++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x: vx, y: Math.round(fromY + ((toY - fromY) * s) / 8), id }],
            });
            await page.waitForTimeout(18);
        }
        await cdp.send('Input.dispatchTouchEvent',
            { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(150);
    };

    // ---- 1) BACK INTO HISTORY: the direction that has room --------------
    await page.evaluate(() => { window.__emits = []; window.__wheels = []; });
    const backBefore = await snapshot();
    await swipe(yHigh, yLow, 71);          // finger DOWN = show OLDER content
    const backAfter = await snapshot();

    check(`${vp.label}: a downward gesture scrolls tmux history (buffer.viewportY moves back)`,
        backAfter.viewportY < backBefore.viewportY,
        `viewportY ${backBefore.viewportY} -> ${backAfter.viewportY}`);
    // Companion, never asserted alone: what is PAINTED must follow the state
    // it mirrors. A moving viewportY with an unchanged top row would mean the
    // user sees nothing move. (This used to read `.xterm-viewport.scrollTop`;
    // xterm 6 renders with no DOM scroll range, so that mirror is gone while
    // the property it stood for is not.)
    check(`${vp.label}: the painted rows follow the buffer`,
        typeof backAfter.paintedTop === 'string'
        && backAfter.paintedTop.length > 0
        && backAfter.paintedTop !== backBefore.paintedTop,
        `painted length ${(backBefore.paintedTop || '').length} -> `
        + `${(backAfter.paintedTop || '').length}`);
    check(`${vp.label}: the visible top line really is older text`,
        typeof backAfter.topOrdinal === 'number'
        && typeof backBefore.topOrdinal === 'number'
        && backAfter.topOrdinal < backBefore.topOrdinal,
        `top history ordinal ${backBefore.topOrdinal} -> ${backAfter.topOrdinal}`);
    check(`${vp.label}: scrolling history emits ZERO ssh_input bytes`,
        backAfter.bytes.length === 0,
        `bytes=${JSON.stringify(backAfter.bytes)}`);
    /*
     * The mechanism, not just the outcome. On row A the scroll goes through
     * terminal.scrollLines() and NO wheel is synthesized. A gesture that reached
     * the same viewportY by dispatching wheels would be forwarding to the
     * application -- harmless against this fixture (no app is attached, so xterm
     * scrolls its own viewport and emits nothing) but SGR reports on a real PTY.
     * Without this row, misrouting row A onto the byte-emitting branch is
     * indistinguishable from correct behaviour: measured in
     * /tmp/s11work/probe_m5_equivalence.out, both end at viewportY 146.
     */
    check(`${vp.label}: the scroll is LOCAL — no synthesized wheel reaches xterm`,
        backAfter.wheelCount === 0,
        `wheel events=${backAfter.wheelCount}`);

    // ---- 2) ALREADY AT THE BOTTOM: the contract is a NO-OP --------------
    // Plan T2 (§3.5): "ở đáy phải no-op". Return to the bottom first, then push
    // further toward newer content and require stillness. Without this row a
    // suite cannot distinguish a correct gesture from one that scrolls always.
    await page.evaluate(() => {
        const term = TerminalManager.terminals['t1'];
        term.scrollToBottom();
        window.__emits = [];
        window.__wheels = [];
    });
    await page.waitForTimeout(80);
    const atBottomBefore = await snapshot();
    check(`${vp.label} precondition: back at the bottom before the no-op probe`,
        atBottomBefore.viewportY === atBottomBefore.baseY,
        `viewportY=${atBottomBefore.viewportY} baseY=${atBottomBefore.baseY}`);
    await swipe(yLow, yHigh, 72);          // finger UP = ask for NEWER content
    const atBottomAfter = await snapshot();
    check(`${vp.label}: at the bottom, an upward gesture is a NO-OP (T2)`,
        atBottomAfter.viewportY === atBottomBefore.viewportY
        && atBottomAfter.paintedTop === atBottomBefore.paintedTop,
        `viewportY ${atBottomBefore.viewportY} -> ${atBottomAfter.viewportY} `
        + `painted changed=${atBottomAfter.paintedTop !== atBottomBefore.paintedTop}`);
    check(`${vp.label}: the no-op gesture also emits ZERO bytes`,
        atBottomAfter.bytes.length === 0,
        `bytes=${JSON.stringify(atBottomAfter.bytes)}`);
    check(`${vp.label}: the no-op gesture synthesizes no wheel either`,
        atBottomAfter.wheelCount === 0,
        `wheel events=${atBottomAfter.wheelCount}`);

    // ---- 3) ROUND TRIP: history is reachable AND returnable -------------
    await page.evaluate(() => { window.__emits = []; window.__wheels = []; });
    await swipe(yHigh, yLow, 73);
    const deep = await snapshot();
    await swipe(yLow, yHigh, 74);
    const returned = await snapshot();
    check(`${vp.label}: the gesture round-trips (down into history, up returns)`,
        deep.viewportY < atBottomAfter.viewportY
        && returned.viewportY > deep.viewportY,
        `bottom=${atBottomAfter.viewportY} deep=${deep.viewportY} back=${returned.viewportY}`);
    check(`${vp.label}: the whole round trip emits ZERO bytes`,
        returned.bytes.length === 0,
        `bytes=${JSON.stringify(returned.bytes)}`);
    check(`${vp.label}: the whole round trip stays wheel-free`,
        returned.wheelCount === 0,
        `wheel events=${returned.wheelCount}`);

    check(`${vp.label}: no page errors during the tmux gesture contract`,
        pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));

    await ctx.close();
}

await browser.close();
server.close();
if (failures.length) {
    console.log('\n--- FAILURES ---');
    failures.forEach(f => console.log(f));
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
