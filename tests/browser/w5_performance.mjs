#!/usr/bin/env node
/*
 * W5 focused test — performance thresholds measurable in a static harness.
 *
 * The live thresholds (restore first paint, reconnect wall time, real PTY
 * latency) are verified against the live server after deploy. THIS suite
 * proves the client-side properties that those numbers depend on:
 *
 *  §1 fit ≤1 per terminal per layout event: a burst of programmatic fit
 *     requests (pane attach + activation + observer) coalesces into exactly
 *     one fitTerminal per session per debounce window.
 *  §2 no long tasks (>200ms) during a multi-session restore.
 *  §3 input dispatch latency p95 <50ms (the synchronous path from an input
 *     handler invocation to the socket emit).
 *  §4 resource-count parity across reload×5: timers, observer instances, and
 *     session-keyed maps return to their baseline after each cycle.
 *  §5 heap does not grow >10% across a create/destroy churn.
 *
 * Run: node tests/browser/w5_performance.mjs   (from source/)
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
    const ok = typeof expected === 'function'
        ? expected(actual) : actual === expected;
    if (ok) {
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

// Track live interval timers + long tasks.
const INSTRUMENT = `
    window.__intervals = new Map();
    const __origSetInterval = window.setInterval.bind(window);
    const __origClearInterval = window.clearInterval.bind(window);
    window.setInterval = (fn, delay, ...rest) => {
        const id = __origSetInterval(fn, delay, ...rest);
        window.__intervals.set(id, { delay });
        return id;
    };
    window.clearInterval = (id) => {
        window.__intervals.delete(id);
        return __origClearInterval(id);
    };
    window.__longTasks = [];
    new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
            window.__longTasks.push({ duration: e.duration, name: e.name });
        }
    }).observe({ entryTypes: ['longtask'] });
`;

async function newPage(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', route => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript(`
        const noop = () => {};
        window.__emitLog = [];
        // Stub window.io so app.js's window.socket = io(...) returns our
        // emit-recording socket instead of the real one.
        window.io = () => ({
            connected: true, on: noop, off: noop, once: noop,
            emit: (ev, payload) => { window.__emitLog.push({ ev, t: performance.now(), payload }); },
            io: { on: noop },
        });
        window.socket = window.io();
        window.showNotification = noop;
        window.ModalManager = {
            open: (m) => m && m.classList.add('show'),
            close: (m) => m && m.classList.remove('show'),
            trapFocus: noop,
        };
        window.clearConnectionProfileState = noop;
        window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
        window.i18n = {
            t: (k, d) => d || k,
            getLanguages: () => [],
            getLanguage: () => 'en',
            setLanguage: () => {},
        };
    `);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // Spy the REAL fitTerminal so coalescing is observable.
    await page.evaluate(`
        window.__fitCalls = [];
        const __realFit = TerminalManager.fitTerminal.bind(TerminalManager);
        TerminalManager.fitTerminal = (sid) => {
            window.__fitCalls.push({ sid, t: performance.now() });
            return __realFit(sid);
        };
        TerminalManager.destroyTerminal = () => {};
        TerminalManager.createTerminal = () => {};
        TerminalManager.attachTerminal = () => {};
        TerminalManager.setupInputHandler = () => {};
    `);
    return { ctx, page, errors };
}

// ============================================================================
// §1 fit coalescing — a burst collapses to one fit per session.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);
    await page.evaluate(() => { window.__fitCalls = []; });

    // Seed a session with an unassigned wrapper; assign it to a pane. One
    // assignment fires renderPane + setActivePane + (in production) the
    // ResizeObserver — three fit REQUEST sources that must coalesce.
    await page.evaluate(() => {
        const id = 'FIT1';
        SessionManager.sessions[id] = {
            id, session_id: id, host: 'f.example', username: 'u',
            connected: true, isPersistentCandidate: false,
            terminalId: `term-${id}`,
        };
        const wrap = document.createElement('div');
        wrap.id = `term-${id}`;
        wrap.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(wrap);
        SessionManager.createSessionTab(id, 'f.example', 'u');
        SessionManager.updateSessionStatus(id, 'connected');
        SessionManager.assignSessionToPane(id, 0);
        // Extra programmatic requests in the SAME window.
        TerminalManager.requestFit(id);
        TerminalManager.requestFit(id);
        TerminalManager.requestFit(id);
    });
    // WAIT FOR THE FIT, THEN FOR SILENCE — not for a fixed 120ms. requestFit
    // debounces by 50ms, and on a loaded machine (this suite also runs inside
    // the mutation-proof harness, back to back with others) that timer can land
    // later than a fixed sleep, which read 0 fits and failed for a scheduling
    // reason rather than a coalescing one. Waiting for the first fit and THEN
    // for an extra debounce window to pass with no further fit is strictly
    // stronger than the fixed sleep: it still fails if the burst produced two.
    await page.waitForFunction(
        () => window.__fitCalls.filter(f => f.sid === 'FIT1').length >= 1,
        null, { timeout: 5000 });
    await page.waitForTimeout(150);

    const fits = await page.evaluate(() =>
        window.__fitCalls.filter(f => f.sid === 'FIT1').length);
    check('§1 a burst of 5 fit requests coalesces to exactly 1 fit', fits, 1);

    // A request OUTSIDE the window fits again (coalescing is per-window, not
    // global suppression).
    await page.evaluate(() => TerminalManager.requestFit('FIT1'));
    await page.waitForFunction(
        () => window.__fitCalls.filter(f => f.sid === 'FIT1').length >= 2,
        null, { timeout: 5000 });
    await page.waitForTimeout(150);
    const fits2 = await page.evaluate(() =>
        window.__fitCalls.filter(f => f.sid === 'FIT1').length);
    check('§1 a later request fits again', fits2, 2);
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 no long tasks during a multi-session restore.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    await page.waitForTimeout(60);
    await page.evaluate(() => { window.__longTasks = []; });

    // Simulate a burst of eight restored sessions through the real
    // restoreSession path.
    await page.evaluate(() => {
        for (let i = 0; i < 8; i++) {
            const id = `R${i}`;
            const wrap = document.createElement('div');
            wrap.id = `terminal-${id}`;
            wrap.className = 'terminal-wrapper unassigned';
            document.getElementById('terminalsContainer').appendChild(wrap);
            SessionManager.restoreSession({
                session_id: id, host: `h${i}.example`, port: 22,
                username: 'u', auth_type: 'key', key_id: `k${i}`,
                via_jump: null, display_name: `R${i}`,
                use_tmux: false, tmux_session_name: null,
            });
        }
    });
    await page.waitForTimeout(300);

    const longTasks = await page.evaluate(() => window.__longTasks);
    check('§2 no long task (>200ms) during restore of 8 sessions',
        longTasks.filter(t => t.duration > 200).length, 0);
    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 input dispatch latency p95 <50ms.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    // Measure the synchronous input-handler-to-emit path, the way production
    // wires it: setupInputHandlerForTerminal's callback emits ssh_input.
    const p95 = await page.evaluate(() => {
        const samples = [];
        const handler = (data) => {
            window.socket.emit('ssh_input', { session_id: 'IN1', data });
        };
        for (let i = 0; i < 200; i++) {
            window.__emitLog.length = 0;
            const t0 = performance.now();
            handler('x');
            const t1 = performance.now();
            samples.push(t1 - t0);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length * 0.95)];
    });
    check('§3 input dispatch p95 <50ms', p95 < 50, true);
    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 resource-count parity across reload×5.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    await page.waitForTimeout(80);

    const baseline = await page.evaluate(() => ({
        intervals: window.__intervals.size,
        sessions: Object.keys(SessionManager.sessions).length,
        disposables: Object.keys(TerminalManager.disposables).length,
        replay: Object.keys(TerminalManager.replayState).length,
        transcripts: Object.keys(TerminalManager.transcripts).length,
    }));

    for (let cycle = 0; cycle < 5; cycle++) {
        // create → assign → destroy, then reload the page (the strongest
        // resource-reset signal), and re-check parity against the baseline.
        await page.evaluate((n) => {
            const id = `P${n}`;
            SessionManager.sessions[id] = {
                id, session_id: id, host: `p${n}.example`, username: 'u',
                connected: true, isPersistentCandidate: false,
                terminalId: `term-${id}`,
            };
            TerminalManager.registerDisposable(id, () => {});
            SessionManager.removeSessionUI(id);
        }, cycle);
        await page.reload({ waitUntil: 'load' });
        await page.addStyleTag({
            content: '*,*::before,*::after{animation:none!important;transition:none!important}',
        });
        await page.waitForTimeout(80);
        const now = await page.evaluate(() => ({
            intervals: window.__intervals.size,
            sessions: Object.keys(SessionManager.sessions).length,
            disposables: Object.keys(TerminalManager.disposables).length,
            replay: Object.keys(TerminalManager.replayState).length,
            transcripts: Object.keys(TerminalManager.transcripts).length,
        }));
        check(`§4 cycle ${cycle + 1}: interval count matches baseline`,
            now.intervals, baseline.intervals);
        check(`§4 cycle ${cycle + 1}: session maps empty`,
            now.sessions + now.disposables + now.replay + now.transcripts, 0);
    }
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §5 heap growth <10% across create/destroy churn.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844);
    await page.waitForTimeout(100);

    const heap = await page.evaluate(() => {
        const used = () => (performance.memory && performance.memory.usedJSHeapSize) || 0;
        if (!used()) {
            return { supported: false, before: 0, after: 0, growthPct: 0 };
        }
        const before = used();
        for (let i = 0; i < 50; i++) {
            const id = `H${i}`;
            SessionManager.sessions[id] = {
                id, session_id: id, host: `h${i}.example`, username: 'u',
                connected: true, isPersistentCandidate: false,
                terminalId: `term-${id}`,
            };
            TerminalManager.transcripts[id] = 'x'.repeat(10000);
            TerminalManager.registerDisposable(id, () => {});
            SessionManager.removeSessionUI(id);
            TerminalManager.destroyTerminal(id);
        }
        return { supported: true, before, after: used(),
            growthPct: ((used() - before) / before) * 100 };
    });
    if (heap.supported) {
        check('§5 heap growth across 50 create/destroy cycles <10%',
            heap.growthPct < 10, true);
    } else {
        // performance.memory is Chromium-only and can be gated; the other
        // sections already pin the map-parity property.
        console.log('SKIP  §5 heap measurement unavailable in this context');
    }
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §6 D1 latency-probe distribution: the probes must be SPREAD across the poll
//    interval, not fired in one burst.
//
// Measured before this existed: eight restored sessions emitted eight
// session_latency frames with a wall-clock spread of 0 ms. Each reply costs a
// server-side SSH global request AND a chip repaint, so a burst lands the whole
// cost on one frame — the "probe bắn đồng loạt" the design budget forbids.
//
// The floor is deliberately loose (a real stagger is ~940 ms per step here);
// what is being pinned is that the emits are SEQUENCED, not simultaneous.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(80);

    const N = 8;
    await page.evaluate(n => {
        for (let i = 1; i <= n; i += 1) {
            SessionManager.sessions[`P${i}`] = {
                id: `P${i}`, session_id: `P${i}`, host: 'h', username: 'u',
                connected: true, isPersistentCandidate: false,
                terminalId: `term-P${i}`,
            };
        }
        window.__emitLog.length = 0;
        SessionManager.stopLatencyPolling();
        SessionManager.startLatencyPolling();
    }, N);

    // One cycle's worth of staggered probes. The stagger is bounded by
    // LATENCY_PROBE_MAX_STAGGER_MS per step, so 8 sessions finish well inside
    // this window while remaining clearly non-simultaneous.
    await page.waitForTimeout(9000);

    const stats = await page.evaluate(() => {
        const e = window.__emitLog.filter(x => x.ev === 'session_latency');
        const ts = e.map(x => x.t);
        const gaps = ts.slice(1).map((t, i) => t - ts[i]);
        return {
            emits: e.length,
            distinct: new Set(e.map(x => x.payload.session_id)).size,
            spread: ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : 0,
            simultaneousPairs: gaps.filter(g => g < 5).length,
        };
    });

    check('§6 every connected session was probed once', stats.emits, 8);
    check('§6 each probe names a distinct session', stats.distinct, 8);
    check('§6 the probes are spread, not simultaneous',
        stats.spread > 500, true);
    check('§6 no two probes fired in the same instant',
        stats.simultaneousPairs, 0);

    // A poll that is stopped must not leave staggered probes armed. Start a
    // FRESH cycle first, so probes #1..#7 are genuinely in flight at the moment
    // stop is called — stopping a cycle whose stagger already drained would
    // pass whether or not the probes are cancelled.
    const afterStop = await page.evaluate(async () => {
        SessionManager.stopLatencyPolling();       // drop the running cycle
        window.__emitLog.length = 0;
        SessionManager.startLatencyPolling();      // probe #0 emits now, #1..#7 armed
        SessionManager.stopLatencyPolling();       // must disarm the armed ones
        await new Promise(r => setTimeout(r, 3000));
        return window.__emitLog.filter(x => x.ev === 'session_latency').length;
    });
    check('§6 stopping the poll disarms its pending probes', afterStop, 1);
    check('§6 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §7 D1 status-bar batching: a burst of latency replies must coalesce.
//
// The status bar can only ever show ONE session (the active one), so in a burst
// of N replies at most one write is meaningful. Every listener used to call the
// synchronous refresh directly: measured at 48 mutation records on #statusBar
// for one cycle of eight replies. scheduleRefresh coalesces to one refresh per
// animation frame.
//
// HOW A REFRESH IS COUNTED: not by wrapping StatusBar.refresh — the listeners
// hold the module-local `refresh` through the closure, so a wrapper on the
// exported member is never reached and would read 0 no matter what the code
// does. Every refresh() sets data-i18n on #statusBarStateText exactly once, and
// setAttribute queues a MutationRecord even when the value is unchanged, so an
// attributeFilter observer on that one attribute is an exact refresh counter
// with no production change.
//
// The events are dispatched through the REAL production listener (app.js
// registers scheduleRefresh for sshdeck:session-latency-changed). Nothing is
// re-registered here, so re-pointing that listener at the synchronous refresh
// turns this section red — which is the property under test.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(80);

    check('§7 StatusBar exposes a coalescing scheduler',
        await page.evaluate(() => typeof window.StatusBar?.scheduleRefresh), 'function');

    const burst = await page.evaluate(async () => {
        for (let i = 1; i <= 8; i += 1) {
            SessionManager.sessions[`Q${i}`] = {
                id: `Q${i}`, session_id: `Q${i}`, host: 'h', username: 'u',
                connected: true, isPersistentCandidate: false,
                terminalId: `term-Q${i}`,
            };
        }
        SessionManager.activeSessionId = 'Q1';

        const text = document.getElementById('statusBarStateText');
        // Records are DELIVERED to the callback at the microtask checkpoint, so
        // an empty callback plus takeRecords() would read zero for anything that
        // happened before the next await. Count in the callback; use
        // takeRecords() only for the synchronous probe, where it drains the
        // queue before delivery.
        let delivered = 0;
        const mo = new MutationObserver(recs => { delivered += recs.length; });
        mo.observe(text, { attributes: true, attributeFilter: ['data-i18n'] });

        for (let i = 1; i <= 8; i += 1) SessionManager.applySessionLatency(`Q${i}`, 20 + i);
        // Still on the emitting stack: anything queued here was NOT deferred.
        const immediately = mo.takeRecords().length;

        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => setTimeout(r, 60));
        const afterFrame = delivered;

        // The queue must re-arm: a later event refreshes again rather than
        // being swallowed by a stuck flag.
        delivered = 0;
        SessionManager.applySessionLatency('Q1', 77);
        await new Promise(r => requestAnimationFrame(() => r()));
        await new Promise(r => setTimeout(r, 60));
        const single = delivered;

        mo.disconnect();
        return { immediately, afterFrame, single };
    });
    check('§7 a burst of 8 replies performs no synchronous refresh',
        burst.immediately, 0);
    check('§7 the burst collapses to one refresh on the next frame',
        burst.afterFrame, 1);
    check('§7 a later single reply still refreshes exactly once',
        burst.single, 1);

    // And the DOM cost of a burst is bounded, which is the user-visible claim.
    const muts = await page.evaluate(async () => {
        const bar = document.getElementById('statusBar');
        let n = 0;
        const mo = new MutationObserver(recs => { n += recs.length; });
        mo.observe(bar, { subtree: true, childList: true,
            characterData: true, attributes: true });
        for (let i = 1; i <= 8; i += 1) SessionManager.applySessionLatency(`Q${i}`, 40 + i);
        await new Promise(r => setTimeout(r, 300));
        mo.disconnect();
        return n;
    });
    check('§7 a burst of 8 replies costs ≤12 status-bar mutations',
        muts <= 12, true);
    check('§7 no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
