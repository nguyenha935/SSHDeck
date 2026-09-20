/*
 * S14 R3(alpha) -- VIEWPORT SCROLL AUTHORITY under a non-cancelable move.
 *
 * WHAT THIS FILE MEASURES, AND WHY IT IS NOT THE SAME GATE AS
 * p1_tmux_vertical_gesture.mjs.
 *
 * The S14 audit measured a SECOND, native vertical scroller inside the
 * terminal (/tmp/s14work/native_summary.txt, identical on Chromium and WebKit):
 *   .xterm-viewport has `overflow-y: scroll !important` (style.css:5605) and a
 *   real range on the normal buffer -- nativeRange 1022 (scrollHeight 1713 vs
 *   clientHeight 691). Writing `scrollTop -200`, which is exactly what a
 *   browser-owned pan performs, moves `buffer.viewportY 73 -> 59` while the
 *   remote receives 0 bytes. The rendered text slides and neither the app nor
 *   tmux knows it happened.
 *
 * The app's ONLY defence today is `if (event.cancelable) event.preventDefault()`
 * on the first touchmove. The plan's own measurement records that
 * cancelability survives only when the cancel lands on the FIRST move
 * (pdFrom=1 -> 27/27 cancelable; pdFrom>=2 -> 1/27). On a real phone a first
 * move arrives non-cancelable routinely (a gesture started during momentum, a
 * fling handed to the compositor), and then the whole gesture belongs to the
 * native scroller.
 *
 * MEASURED REALITY OF THE HARNESS (probes /tmp/s15work/probe_attr*.mjs): under
 * CDP-dispatched touches, headless Chromium delivers every move cancelable, and
 * even with `cancelable` forced false at the prototype the compositor does NOT
 * claim the gesture -- the app keeps receiving moves and the native scroller
 * contributes ZERO pixels of its own (end-state scrollTop is always exactly the
 * app ledger's). The device condition this gate must therefore reproduce is the
 * one the audit MEASURED (/tmp/s14work/native_summary.txt): while the app's
 * preventDefault is suppressed by a non-cancelable move, a browser-owned pan
 * performs a RAW scrollTop WRITE on `.xterm-viewport` -- measured
 * `scrollTop -200 => viewportY -14` on both engines, 0 bytes. That write IS the
 * browser's pan; there is no other mechanism.
 *
 * So each run below does BOTH halves of the device condition:
 *   1. the LIE: `TouchEvent.prototype.cancelable` reports false for touchmove,
 *      so the app's guarded `if (event.cancelable) preventDefault()` never runs;
 *   2. the PAN: mid-gesture, `.xterm-viewport.scrollTop -= 200` -- exactly the
 *      state change an un-cancelable gesture hands to the native scroller, at
 *      exactly the moment it would happen (between two delivered moves).
 *
 * No CSS declaration changes anywhere; D-3 (iv) stands. The gate only removes
 * the cancel the app already treats as optional and injects the pan the browser
 * then owns.
 *
 * THE METRIC. "Nothing moved without the app's knowledge" is measured at the
 * seam that separates the two owners:
 *
 *   window.__appSeq   -- every call to the PUBLIC `terminal.scrollLines(n)`,
 *       tagged with whether a touchmove was being dispatched at the moment of
 *       the call (`__inTouch`, set at document capture, cleared on microtask).
 *       TerminalManager's gesture path is the only thing in the app that calls
 *       it DURING a move. xterm's own native path does NOT go through it: a raw
 *       scrollTop delta reaches `Viewport._handleScroll`, which fires
 *       `onRequestScrollLines` and lands on the CORE terminal's
 *       `scrollLines(amount, suppressScrollEvent, source)` -- a different
 *       function object, invisible to a wrapper on the public API (verified
 *       against the vendored engine: static/vendor/xterm/xterm.js, Viewport
 *       ._handleScroll -> `this.viewport.onRequestScrollLines((e =>
 *       this.scrollLines(e.amount, e.suppressScrollEvent, 1)))`).
 *
 *   The sequence splits into:
 *     gestureLines     -- sum of n over calls made during touchmove dispatch
 *                         (the gesture's own decisions);
 *     correctionLines  -- sum of n over all other calls (the R3 authority
 *                         machinery restoring a decided row against the pan).
 *
 *   dViewportY         -- what actually moved on screen.
 *
 * ATTRIBUTION CONTRACT: dViewportY === gestureLines AND correctionLines === 0
 * in CONTROL / !== 0 in NONCANCELABLE. Every rendered line of vertical movement
 * was requested by the gesture, and no line arrived from anywhere else; the
 * correction channel must be exercised exactly where a pan exists. Today the
 * injected pan drifts viewportY by -14 rows' worth of raw pixels that no
 * scrollLines call accounts for, so the identity breaks -- that is the red.
 * After fix (alpha) -- JS writes scrollTop back authoritatively after each
 * move -- the pan is reconciled within the same gesture and the identity holds
 * in BOTH runs.
 *
 * Companions that stop this from passing for the wrong reason:
 *   * the CONTROL case runs the identical swipe with cancelable intact; the
 *     identity must hold there today, which proves the metric is not simply
 *     always-false;
 *   * `gestureLines !== 0` -- a gesture that moved nothing satisfies any identity;
 *   * zero `ssh_input` frames -- row A must still cost no bytes, and a "fix"
 *     that reached the identity by forwarding the gesture to the remote would
 *     be caught here.
 *
 * `movesSeen` is reported (not asserted) because it is the diagnostic that
 * separates (alpha) from (beta): if the compositor claims the gesture and stops
 * delivering touchmove, no amount of JS write-back can repair it and the
 * review asked for the declaration-by-declaration (beta) diff instead.
 *
 * Run: node tests/browser/viewport_scroll_authority.mjs   (from source/)
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

const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, id: 'authority_socket', io: { on() {}, off() {} },
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

/*
 * Two runs of the SAME swipe on the SAME state. Only one thing differs: whether
 * touchmove reports itself cancelable. CONTROL is the world CDP gives us by
 * default (and the world the existing T14 gate measures); NONCANCELABLE is the
 * world the phone gives us after a fling.
 *
 * The lie is installed on TouchEvent.prototype, which is the narrowest place
 * that reproduces the device condition: `event.cancelable` reads false, so the
 * app's guarded `preventDefault()` never runs, and the browser keeps the default
 * action for the gesture. Nothing else is patched -- not the app, not a CSS
 * declaration, not xterm.
 */
const RUNS = [
    { label: 'CONTROL_cancelable', lie: false },
    { label: 'NONCANCELABLE_first_move', lie: true },
];

const VP = { label: 'phone390x844', width: 390, height: 844 };
const results = {};

for (const run of RUNS) {
    const ctx = await browser.newContext({
        viewport: { width: VP.width, height: VP.height },
        hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    if (run.lie) {
        await page.addInitScript(() => {
            /*
             * Report every touchmove as non-cancelable, at the prototype --
             * the one place a getter can intercept BOTH the CDP-dispatched
             * trusted events and the app's reads of `event.cancelable`.
             *
             * This reproduces the DEVICE condition and only that condition:
             * the browser's internal cancelability is untouched (the default
             * action stays live), while the app's guarded
             * `if (event.cancelable) preventDefault()` never fires. A real
             * non-cancelable first move -- a gesture started during momentum,
             * a fling handed to the compositor -- is exactly this state.
             */
            const proto = window.TouchEvent && window.TouchEvent.prototype;
            if (proto) {
                Object.defineProperty(proto, 'cancelable', {
                    configurable: true,
                    get() { return this.type === 'touchmove' ? false : true; },
                });
            }
        });
    }
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);
    // AGENTS.md §2: geometry is read only from a frozen layout.
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });

    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 'va1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-s14-r3', via_jump: null,
        });
        SessionManager.assignSessionToPane('va1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(400);

    const pre = await page.evaluate(async () => {
        const term = TerminalManager.terminals['va1'];
        if (!term) return { error: 'terminal va1 not found' };
        for (let i = 1; i <= 200; i++) {
            term.write(`tmux history line ${String(i).padStart(3, '0')} `
                + `SSHDeck viewport authority contract\r\n`);
        }
        await new Promise(r => setTimeout(r, 150));
        /*
         * The app-attributable ledger. `terminal.scrollLines` is the PUBLIC API
         * the gesture path calls; xterm's native scroller reaches the core
         * terminal's own scrollLines instead (Viewport._handleScroll ->
         * onRequestScrollLines -> Terminal.scrollLines(amount, suppress, 1)),
         * which this wrapper cannot see. That asymmetry is what makes the
         * wrapper an attribution instrument rather than a counter.
         *
         * Each call is CLASSIFIED BY DISPATCH CONTEXT, not by guesswork:
         * `__inTouch` is true exactly while a touchmove event is being
         * dispatched (set at document capture -- root-down, so ahead of every
         * wrapper handler -- and cleared on a microtask, which runs the moment
         * the dispatch stack empties). Calls made in that window are the
         * GESTURE's own decisions; calls made outside it are the R3 authority
         * machinery restoring a decided row against a browser-owned pan. The
         * contract splits accordingly: rendered movement must equal
         * gestureLines alone (zero native contribution), and correctionLines
         * must be 0 where no pan exists (CONTROL) and non-zero where the pan
         * was real (NONCANCELABLE -- otherwise the pass would be vacuous).
         */
        window.__appLines = 0;
        window.__appCalls = 0;
        window.__appSeq = [];
        const original = term.scrollLines.bind(term);
        term.scrollLines = (n) => {
            window.__appLines += n;
            window.__appCalls += 1;
            window.__appSeq.push({ n, inMove: !!window.__inTouch });
            return original(n);
        };
        window.__moves = 0;
        window.__cancelableSeen = [];
        window.__panInjected = null;
        window.__panSkippedBecauseCancelable = false;
        window.__recLog = [];
        /*
         * Dispatch-context flag for the ledger above: true exactly while a
         * touchmove is being dispatched. Set at document CAPTURE (runs before
         * any wrapper handler); cleared by a wrapper-capture listener
         * registered LAST in the wrapper's capture group (same-node listeners
         * run in registration order even past the app's stopPropagation), so
         * the flag falls the moment the dispatch leaves the wrapper -- before
         * the default action and before the rendering update that delivers
         * scroll events. A microtask clear was measured firing between
         * listeners of the SAME event, and a plain setTimeout(0) clear was
         * measured firing AFTER the rendering phase (scroll events ride the
         * rendering steps, ahead of the timer task), misclassifying the
         * reconciler's correction as a gesture call -- hence this
         * synchronous, position-based clear, with the timer kept only as a
         * backstop for moves that never reach the wrapper.
         */
        window.__inTouch = false;
        document.addEventListener('touchmove', () => {
            window.__inTouch = true;
            setTimeout(() => { window.__inTouch = false; }, 0);
        }, { capture: true, passive: true });
        // Count moves that actually arrive, at the same wrapper the app binds
        // to. A compositor-claimed gesture shows up HERE as missing moves --
        // the (alpha)/(beta) discriminator the review asked about.
        const wrapper = TerminalManager.terminalContainers['va1'];
        wrapper.addEventListener('touchmove', (e) => {
            window.__moves += 1;
            window.__cancelableSeen.push(e.cancelable);
        }, { capture: true, passive: true });
        // Document-level counter: stopPropagation at the wrapper cannot hide
        // moves from a document CAPTURE listener (capture runs root-down), so
        // this is the honest "how many moves did the browser deliver" meter.
        window.__docMoves = 0;
        document.addEventListener('touchmove', () => {
            window.__docMoves += 1;
        }, { capture: true, passive: true });
        const vpEl = term.element.querySelector('.xterm-viewport');
        /*
         * THE PAN INJECTOR. Wrapper CAPTURE, registered before the tracer:
         * within this capture group it runs AFTER the app's own gesture handler
         * (registered first, at session creation) -- exactly where the browser's
         * default action would perform its pan relative to the app. A bubble
         * listener cannot be used: the app's stopPropagation() ends the event
         * before the bubble leg ever reaches anyone.
         *
         * It performs the browser-owned pan the audit measured: a raw scrollTop
         * write of -200 on `.xterm-viewport`. With the LIE active the app could
         * not cancel the gesture, so this is the state an un-cancelable move
         * hands to the native scroller. It fires ONLY in the NONCANCELABLE run:
         * when preventDefault lands (CONTROL), the default action -- and
         * therefore the pan -- does not exist.
         */
        wrapper.addEventListener('touchmove', (ev) => {
            if (ev.cancelable !== false) {
                window.__panSkippedBecauseCancelable = true;
                return;
            }
            if (window.__panInjected === null && window.__docMoves >= 1) {
                window.__panBeforeScroll = vpEl.scrollTop;
                vpEl.scrollTop -= 200;   // the measured browser-owned pan
                window.__panAfterScroll = vpEl.scrollTop;
                window.__panInjected = true;
            }
        }, { capture: true, passive: true });

        // Per-move TRANSIENT trace: kept for diagnostics only. It samples
        // mid-frame (before the browser's default action and the app's scroll
        // reconciler have run), so it shows the transient the reconciler has to
        // survive -- it asserts nothing. Registered LAST so it also CLOSES the
        // __inTouch dispatch window (see above): it is the last touchmove
        // listener in this capture group that will run.
        window.__scrollTopTrace = [];
        wrapper.addEventListener('touchmove', () => {
            window.__inTouch = false;
            window.__scrollTopTrace.push(vpEl.scrollTop);
        }, { capture: true, passive: true });
        const viewport = term.element.querySelector('.xterm-viewport');
        const sess = SessionManager.getSession('va1');
        return {
            useTmux: !!(sess && sess.useTmux),
            ownerRow: TerminalManager.ScrollOwner.resolve(term),
            bufferType: term.buffer.active.type,
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            nativeRange: viewport.scrollHeight - viewport.clientHeight,
            touchAction: getComputedStyle(viewport).touchAction,
            overflowY: getComputedStyle(viewport).overflowY,
            wrapperRect: JSON.parse(JSON.stringify(
                TerminalManager.terminalContainers['va1'].getBoundingClientRect())),
        };
    });

    if (pre.error) {
        check(`${run.label}: harness precondition failed loudly`, false, pre.error);
        await ctx.close();
        continue;
    }

    check(`${run.label} precondition: row A (local scroll, zero bytes)`,
        pre.ownerRow === 'A' && pre.bufferType === 'normal',
        `row=${pre.ownerRow} buffer=${pre.bufferType}`);
    /*
     * WHICH WORLD IS THIS ENGINE IN?
     *
     * This whole suite is about a scroller the BROWSER can pan out from under
     * the gesture. xterm 5.3.0 has one: `.xterm-viewport` carries a real range
     * and a raw `scrollTop` write moves the buffer (measured `scrollTop -200`
     * => `viewportY -14`). xterm 6 renders no scroll area at all -- the
     * viewport never gains a range -- so there is nothing for the browser to
     * pan, nothing to correct, and no scrollTop mirror to compare against.
     *
     * The rows that measure the pan are therefore asked only of an engine that
     * HAS one. Everything that is about the APP -- its branch ran, the
     * movement is fully attributable to it, zero bytes, the painted line
     * matches its ledger -- is asked of both, because those are the properties
     * the suite exists to protect.
     */
    const hasNativeScroller = pre.nativeRange > 0;
    if (hasNativeScroller) {
        check(`${run.label} precondition: the NATIVE scroller has a real range`,
            pre.nativeRange > 0,
            `nativeRange=${pre.nativeRange} overflowY=${pre.overflowY} `
            + `touchAction=${pre.touchAction}`);
    } else {
        check(`${run.label} precondition: the engine exposes no pannable scroller`,
            pre.nativeRange === 0 && pre.baseY > 0,
            `nativeRange=${pre.nativeRange} baseY=${pre.baseY} `
            + `(xterm 6 renders without a DOM scroll area)`);
    }
    check(`${run.label} precondition: the viewport starts at the bottom`,
        pre.viewportY === pre.baseY,
        `viewportY=${pre.viewportY} baseY=${pre.baseY}`);

    const cdp = await ctx.newCDPSession(page);
    const wr = pre.wrapperRect;
    const vx = Math.round(wr.left + wr.width / 2);
    const yHigh = Math.round(wr.top + wr.height * 0.2);
    const yLow = Math.round(wr.top + wr.height * 0.8);

    const snapshot = () => page.evaluate(() => {
        const term = TerminalManager.terminals['va1'];
        const viewport = term.element.querySelector('.xterm-viewport');
        /*
         * The rendered top line's IDENTITY, wrap-proof (the T14 lesson: at 390px
         * every history line wraps, so its TEXT reads identically at many
         * positions). If scrollTop moved but the painted top line did not, the
         * "movement" was invisible -- which is its own contract break, caught
         * here instead of asserted away.
         */
        const buf = term.buffer.active;
        let topOrdinal = null;
        for (let r = 0; r < term.rows; r++) {
            const line = buf.getLine(buf.viewportY + r);
            if (!line) break;
            const m = /tmux history line (\d+)/.exec(line.translateToString(true));
            if (m) { topOrdinal = Number(m[1]); break; }
        }
        return {
            viewportY: buf.viewportY,
            baseY: buf.baseY,
            scrollTop: viewport.scrollTop,
            topOrdinal,
            appLines: window.__appLines,
            appCalls: window.__appCalls,
            appSeq: window.__appSeq.slice(-8),
            moves: window.__moves,
            docMoves: window.__docMoves,
            cancelableSeen: window.__cancelableSeen.slice(0, 3),
            scrollTopTrace: window.__scrollTopTrace || [],
            bytes: window.__emits.filter(e => e.evt === 'ssh_input')
                .map(e => e.payload && e.payload.data),
        };
    });

    await page.evaluate(() => {
        window.__emits = [];
        window.__appLines = 0;
        window.__appCalls = 0;
        window.__appSeq = [];
        window.__moves = 0;
        window.__cancelableSeen = [];
        window.__scrollTopTrace = [];
    });

    const before = await snapshot();

    // Finger DOWN = ask for OLDER content: the only direction with room at rest.
    await cdp.send('Input.dispatchTouchEvent',
        { type: 'touchStart', touchPoints: [{ x: vx, y: yHigh, id: 91 }] });
    for (let s = 1; s <= 8; s++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: vx, y: Math.round(yHigh + ((yLow - yHigh) * s) / 8), id: 91 }],
        });
        await page.waitForTimeout(18);
    }
    await cdp.send('Input.dispatchTouchEvent',
        { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(250);
    const after = await snapshot();
    const panState = await page.evaluate(() => ({
        injected: window.__panInjected,
        before: window.__panBeforeScroll,
        afterWrite: window.__panAfterScroll,
    }));
    const recLog = await page.evaluate(() => window.__recLog || []);
    console.log(`      [${run.label}] moves=${after.moves} `
        + `rec=${JSON.stringify(recLog)} `
        + `cancelable=${JSON.stringify(after.cancelableSeen)} `
        + `transients=${JSON.stringify(after.scrollTopTrace)} `
        + `appCalls=${after.appCalls} `
        + `dScrollTop=${after.scrollTop - before.scrollTop} `
        + `pan=${JSON.stringify(panState)}`);

    const dViewportY = after.viewportY - before.viewportY;
    /*
     * Split the ledger by dispatch context: calls made while a touchmove was
     * being dispatched are the GESTURE's decisions; calls made outside it are
     * the R3 authority machinery restoring those decisions against a
     * browser-owned pan. Rendered movement must equal gestureLines ALONE --
     * corrections exist precisely to cancel the native delta, so they must
     * never appear as net movement.
     */
    const gestureLines = after.appSeq.filter(c => c.inMove)
        .reduce((a, c) => a + c.n, 0);
    const correctionLines = after.appSeq.filter(c => !c.inMove)
        .reduce((a, c) => a + c.n, 0);
    results[run.label] = {
        dViewportY, gestureLines, correctionLines,
        appCalls: after.appCalls,
        dScrollTop: after.scrollTop - before.scrollTop,
        moves: after.moves, cancelableSeen: after.cancelableSeen,
        bytes: after.bytes.length,
    };

    // Cell height, measured the way the app measures it (screen height / rows)
    // -- a whole-cell scrollTop step is the app's signature; anything else is
    // raw pixels from the native scroller.
    const cellHeightPx = await page.evaluate(() => {
        const term = TerminalManager.terminals['va1'];
        const screen = term.element.querySelector('.xterm-screen') || term.element;
        return screen.getBoundingClientRect().height / term.rows;
    });
    if (run.lie && !hasNativeScroller) {
        check(`${run.label}: the pan cannot be injected without a scroller`,
            panState.afterWrite === panState.before,
            `pan=${JSON.stringify(panState)}`);
    } else if (run.lie) {
        check(`${run.label}: the browser-owned pan was actually injected`,
            panState.injected === true
            && panState.afterWrite === panState.before - 200,
            `pan=${JSON.stringify(panState)}`);
    } else {
        check(`${run.label}: no pan occurs while the cancel works`,
            panState.injected !== true,
            `pan=${JSON.stringify(panState)}`);
    }
    check(`${run.label}: the app's own gesture branch really ran`,
        gestureLines !== 0 && after.appCalls > 0,
        `gestureLines=${gestureLines} appCalls=${after.appCalls} `
        + `appSeq=${JSON.stringify(after.appSeq)}`);
    /*
     * THE CONTRACT. Every rendered line of vertical movement is one the app's
     * GESTURE path asked for, and no line came from anywhere else. With the
     * app's cancel suppressed the browser pans the same gesture; the R3
     * authority machinery must cancel that pan through correction calls, so
     * the settled dViewportY still equals the gesture's own ledger -- the
     * native delta must never survive to paint.
     */
    check(`${run.label}: rendered movement is fully attributable to the app`,
        dViewportY === gestureLines,
        `dViewportY=${dViewportY} gestureLines=${gestureLines} `
        + `correctionLines=${correctionLines} appSeq=${JSON.stringify(after.appSeq)} `
        + `dScrollTop=${results[run.label].dScrollTop} moves=${after.moves} `
        + `cancelableSeen=${JSON.stringify(after.cancelableSeen)}`);
    /*
     * The correction channel must be exercised exactly where a pan exists and
     * exactly where it does not. CONTROL: preventDefault lands, there is no
     * browser-owned pan, so any correction call would mean the machinery is
     * fighting legitimate movement. NONCANCELABLE: the pan was injected for
     * real, so a pass with zero corrections would be vacuous -- the contract
     * above could hold because nothing ever drifted.
     */
    if (run.lie && !hasNativeScroller) {
        // Nothing drifted, so nothing may be corrected: a correction here
        // would be the reconciler fighting the gesture's own movement, which
        // is the feedback loop measured when it was hung off the engine's
        // scroll event instead of the DOM scroller's.
        check(`${run.label}: no correction fires when there is nothing to pan`,
            correctionLines === 0,
            `correctionLines=${correctionLines} appSeq=${JSON.stringify(after.appSeq)}`);
    } else if (run.lie) {
        check(`${run.label}: the authority machinery actually corrected the pan`,
            correctionLines !== 0,
            `correctionLines=${correctionLines} appSeq=${JSON.stringify(after.appSeq)}`);
    } else {
        check(`${run.label}: no correction fires when the cancel works`,
            correctionLines === 0,
            `correctionLines=${correctionLines} appSeq=${JSON.stringify(after.appSeq)}`);
    }
    /*
     * The scrollTop mirror must agree with the buffer the app drove. A pan that
     * survives to paint shows up here as scrollTop sitting at a raw-pixel
     * offset no whole-cell position explains (measured fail-first:
     * scrollTop 1904 vs the authoritative 2044). Sampling DURING the move would
     * race the browser's default action, which executes after every listener of
     * that move -- the measured transient (scrollTop 1844 inside the frame,
     * restored before paint) is NOT a violation, so the assertion reads the
     * SETTLED state after the gesture instead.
     */
    if (hasNativeScroller) {
        check(`${run.label}: the settled scrollTop equals the app-decided position`,
            after.scrollTop === Math.round(after.viewportY * cellHeightPx),
            `scrollTop=${after.scrollTop} `
            + `expected=${Math.round(after.viewportY * cellHeightPx)} `
            + `(viewportY=${after.viewportY} rowPx=${cellHeightPx} `
            + `transients=${JSON.stringify(after.scrollTopTrace.slice(0, 12))})`);
    } else {
        // No mirror to agree with: the buffer IS the rendered position, and
        // the scroller must stay inert for the whole gesture.
        check(`${run.label}: the inert scroller never moved`,
            after.scrollTop === 0
            && after.scrollTopTrace.every(v => v === 0),
            `scrollTop=${after.scrollTop} `
            + `transients=${JSON.stringify(after.scrollTopTrace.slice(0, 12))}`);
    }

    check(`${run.label}: the gesture still emits ZERO ssh_input bytes`,
        after.bytes.length === 0,
        `bytes=${JSON.stringify(after.bytes)}`);
    /*
     * What the user SEES follows the app's ledger, not the native scroller's
     * raw scrollTop. The painted top line must be exactly the line the app's
     * own scrollLines count predicts: one ordinal per line moved.
     */
    check(`${run.label}: the painted top line matches the app's ledger`,
        typeof before.topOrdinal === 'number'
        && typeof after.topOrdinal === 'number'
        && (before.topOrdinal - after.topOrdinal) === Math.round((-dViewportY) / 2),
        `topOrdinal ${before.topOrdinal} -> ${after.topOrdinal} `
        + `(gestureLines=${gestureLines})`);
    check(`${run.label}: no page errors`,
        pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    await ctx.close();
}

await browser.close();
server.close();
console.log('\n--- MEASURED ---');
console.log(JSON.stringify(results, null, 2));
if (failures.length) {
    console.log('\n--- FAILURES ---');
    failures.forEach(f => console.log(f));
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
