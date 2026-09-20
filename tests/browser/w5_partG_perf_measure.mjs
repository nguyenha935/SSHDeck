/*
 * Part G — PERFORMANCE / RESOURCE measurement against the LIVE DEPLOYMENT.
 *
 * This file REPORTS NUMBERS. It is not a threshold gate: every row prints the
 * value actually measured, because Bug 9 (lag) is the reason bugs 1-4 were
 * reworked and the objective is not satisfiable without real data.
 *
 * It changes NO source file. Everything is measured by OBSERVING the shipped
 * build from the test's own scope, installed before any app script runs:
 *   - PerformanceObserver('longtask') for item 4
 *   - FitAddon.prototype.fit wrapped to count real fit() calls for item 5
 *   - setInterval/setTimeout/addEventListener/ResizeObserver/MutationObserver
 *     wrapped to keep NET live counts for item 6
 *   - in-page performance.now() pairing (keydown -> onWriteParsed) for item 3,
 *     so the CDP round trip is never charged to the product
 *   - CDP Runtime.queryObjects(HTMLElement.prototype) for a true detached-node
 *     count, HeapProfiler.collectGarbage + Runtime.getHeapUsage for heap
 *   - cgroup memory.current and summed /proc VmRSS for container memory
 *
 * Session hygiene: config.MAX_SESSIONS is 10 GLOBALLY (config.py:23), so every
 * session this probe opens is disconnected (kill_tmux) before the next block.
 * If the server refuses at capacity the row reports the refusal instead of
 * silently printing a wrong number.
 *
 * Run: node tests/browser/w5_partG_perf_measure.mjs
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

const LOCK = '/tmp/w5_partG_perf.lock';
try {
    fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: 'wx' });
} catch (err) {
    if (err.code === 'EEXIST') {
        console.error(`already running (pid ${fs.readFileSync(LOCK, 'utf8').trim()}); `
            + `remove ${LOCK} if that pid is gone.`);
        process.exit(2);
    }
    throw err;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { releaseLock(); process.exit(1); });
}
const BASE = liveConfig().LIVE_BASE;
const NOTES = 'the live credentials file';
const creds = liveCreds();
const SSH_HOST = creds.ssh_target || creds.tailnet_host;
const SSH_USER = creds.host_ssh_user;
const SSH_PASS = creds.host_ssh_password;
const SSHDECK_PASS = creds.sshdeck_password;
const RUN = Date.now().toString(36);
if (!SSH_HOST || !SSH_USER || !SSH_PASS || !SSHDECK_PASS) {
    throw new Error(`incomplete credentials in ${CREDS_FILE}`);
}

// Real Vietnamese typed the Telex way: ASCII keystrokes only, which is exactly
// what a Telex user's keyboard emits before the IME composes.
const TELEX = 'tieengs Vieejt Nam xin chaof cacs banj dodngf nghieejp than mesnwx ';

// ── reporting ───────────────────────────────────────────────────────────────
const rows = [];
function row(id, metric, value, unit, source, note = '') {
    rows.push({ id, metric, value, unit, source, note });
    const v = typeof value === 'number' && Number.isFinite(value)
        ? (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1))
        : String(value);
    console.log(`  ${id.padEnd(5)}${metric.padEnd(48)}${v.padStart(14)}  `
        + `${unit.padEnd(6)}${source}${note ? `  — ${note}` : ''}`);
}
const num = a => a.filter(v => typeof v === 'number' && Number.isFinite(v));
const median = a => {
    const s = num(a).sort((x, y) => x - y);
    if (!s.length) return NaN;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
    const s = num(a).sort((x, y) => x - y);
    if (!s.length) return NaN;
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const list = a => num(a).map(v => v.toFixed(0)).join(',');
const notes = [];
const browser = await chromium.launch();

/*
 * Every probe below is installed as an init script, so it is in place before
 * the app's own bundles evaluate. Nothing here is written back to any source
 * file; it lives for the lifetime of the tab only.
 */
const PROBE_INIT = () => {
    /*
     * DOCUMENT GENERATION + CROSS-RELOAD TOTALS.
     *
     * An init script re-runs on every navigation, but it runs in a BRAND NEW
     * window, so every in-page counter it defines starts at zero again. That
     * makes a raw before/after comparison across a reload meaningless: the two
     * numbers describe two different documents, not growth in one. sessionStorage
     * survives the navigation, so the generation number and the carried totals
     * make that fact measurable instead of invisible.
     */
    const gen = parseInt(sessionStorage.getItem('__probeGen') || '0', 10) + 1;
    sessionStorage.setItem('__probeGen', String(gen));
    window.__probe = {
        gen,
        longTasks: [],
        fitCalls: 0,
        navStart: performance.now(),
        appReadyAt: null,
        firstTerminalAt: null,
        // Listener adds/removes attributed to the HARNESS itself, so a census can
        // subtract them and report an app-only figure.
        selfAdds: 0,
        selfRemoves: 0,
        synthLongTask: null,
    };
    try {
        new PerformanceObserver(l => {
            for (const e of l.getEntries()) {
                window.__probe.longTasks.push({ dur: e.duration, start: e.startTime });
            }
        }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unsupported */ }

    // Track a listener the HARNESS adds, so it is never charged to the app.
    window.__probeSelfAdd = (target, type, fn, opts) => {
        window.__probe.selfAdds += 1;
        target.addEventListener(type, fn, opts);
    };

    // xterm-addon-fit exposes FitAddon.FitAddon with a prototype .fit(); wrap it
    // as soon as the vendor bundle has evaluated so every real call is counted.
    let tries = 0;
    const hookFit = () => {
        tries += 1;
        const A = window.FitAddon && window.FitAddon.FitAddon;
        if (A && A.prototype && !A.prototype.__probeWrapped) {
            const real = A.prototype.fit;
            A.prototype.fit = function (...a) {
                window.__probe.fitCalls += 1;
                return real.apply(this, a);
            };
            A.prototype.__probeWrapped = true;
            return;
        }
        if (tries < 600) setTimeout(hookFit, 20);
    };
    hookFit();

    // NET live counts for timers / listeners / observers.
    const T = { intervals: new Set(), timeouts: new Set() };
    window.__probeTimers = T;
    const rsi = window.setInterval.bind(window);
    const rci = window.clearInterval.bind(window);
    window.setInterval = function (...a) {
        const id = rsi(...a); T.intervals.add(id); return id;
    };
    window.clearInterval = function (id) { T.intervals.delete(id); return rci(id); };
    const rst = window.setTimeout.bind(window);
    const rct = window.clearTimeout.bind(window);
    window.setTimeout = function (fn, ms, ...rest) {
        if (typeof fn !== 'function') {
            const id0 = rst(fn, ms, ...rest); T.timeouts.add(id0); return id0;
        }
        let id;
        const wrapped = function (...b) {
            T.timeouts.delete(id); return fn.apply(this, b);
        };
        id = rst(wrapped, ms, ...rest);
        T.timeouts.add(id);
        return id;
    };
    window.clearTimeout = function (id) { T.timeouts.delete(id); return rct(id); };

    window.__probeObs = { resize: 0, mutation: 0 };
    if (window.ResizeObserver) {
        const RO = window.ResizeObserver;
        window.ResizeObserver = class extends RO {
            constructor(...a) { super(...a); window.__probeObs.resize += 1; }
            disconnect() { window.__probeObs.resize -= 1; return super.disconnect(); }
        };
    }
    if (window.MutationObserver) {
        const MO = window.MutationObserver;
        window.MutationObserver = class extends MO {
            constructor(...a) { super(...a); window.__probeObs.mutation += 1; }
            disconnect() { window.__probeObs.mutation -= 1; return super.disconnect(); }
        };
    }
    window.__probeListeners = { add: 0, remove: 0, byType: {} };
    const proto = EventTarget.prototype;
    const rAdd = proto.addEventListener;
    const rRem = proto.removeEventListener;
    /*
     * Per-TYPE tallies, not just a total. A net total can only say "something
     * grew"; the per-type breakdown says WHICH listener grew and therefore
     * whether the growth is the app's or the harness's own wrapping. Also
     * recorded is whether the target is a node still in the document, since a
     * listener on a discarded node is a different finding from one on window.
     */
    const bump = (type, field) => {
        const t = String(type);
        const e = window.__probeListeners.byType[t]
            || (window.__probeListeners.byType[t] = { add: 0, remove: 0 });
        e[field] += 1;
    };
    proto.addEventListener = function (...a) {
        window.__probeListeners.add += 1;
        bump(a[0], 'add');
        return rAdd.apply(this, a);
    };
    proto.removeEventListener = function (...a) {
        window.__probeListeners.remove += 1;
        bump(a[0], 'remove');
        return rRem.apply(this, a);
    };

    /*
     * SYNTHETIC LONG TASK, for validating the observer above.
     *
     * The spin MUST be scheduled as a real page task. A busy-wait executed
     * directly inside a CDP page.evaluate() runs in the debugger's evaluation
     * context, and Chrome does not attribute that as a longtask -- measured
     * directly: an identical 180 ms spin reports nothing from evaluate() and
     * reports 180 ms from inside a setTimeout callback. Burning in evaluate() is
     * exactly how a live observer can be mistaken for a blind one.
     */
    window.__probeBurn = ms => new Promise(resolve => {
        setTimeout(() => {
            const t0 = performance.now();
            // Deliberate busy-wait: a long task is defined by blocking the main
            // thread, which a sleep cannot do.
            while (performance.now() - t0 < ms) { /* spin */ }
            resolve(performance.now() - t0);
        }, 0);
    });
};

async function newPage(vp = { width: 1440, height: 900 }, touch = false) {
    const ctx = await browser.newContext({
        viewport: vp, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.addInitScript(PROBE_INIT);
    page.on('pageerror', () => {});
    return { ctx, page };
}
const appReady = page => page.waitForFunction(() => {
    const ok = typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined'
        && !!window.socket && window.socket.connected;
    if (ok && window.__probe.appReadyAt === null) {
        window.__probe.appReadyAt = performance.now();
    }
    return ok;
}, null, { timeout: 45000 });

// First terminal READY and actually painted (non-zero rect) -- readiness alone
// is not "time to first terminal" if nothing is on screen yet.
//
// EVERY ready key is examined, not just the first one. With several restored
// sessions the first ready key is often a terminal parked in a hidden pane
// (rect 0x0), so testing only that key waits forever even though a visible
// terminal is already painted.
async function firstTerminalReady(page, timeout = 45000) {
    await page.waitForFunction(() => {
        if (typeof TerminalManager === 'undefined') return false;
        const keys = Object.keys(TerminalManager.terminalReady || {})
            .filter(x => TerminalManager.terminalReady[x] === true);
        if (!keys.length) return false;
        const painted = keys.some(k => {
            const el = TerminalManager.terminals[k]?.element;
            const r = el && el.getBoundingClientRect();
            return !!r && r.width >= 1 && r.height >= 1;
        });
        if (!painted) return false;
        if (window.__probe.firstTerminalAt === null) {
            window.__probe.firstTerminalAt = performance.now();
        }
        return true;
    }, null, { timeout });
    return page.evaluate(() => ({
        toReady: window.__probe.firstTerminalAt - window.__probe.navStart,
        toAppReady: window.__probe.appReadyAt === null
            ? null : window.__probe.appReadyAt - window.__probe.navStart,
    }));
}

async function register(page, user) {
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#username').fill(user);
    await page.locator('#password').fill(SSHDECK_PASS);
    await page.locator('#confirm_password').fill(SSHDECK_PASS);
    await page.locator('#submitBtn').click();
    await appReady(page);
}

async function login(page, user) {
    await page.goto(`${BASE}/login`, { waitUntil: 'load' });
    await page.locator('#username').fill(user);
    await page.locator('#password').fill(SSHDECK_PASS);
    await page.locator('button[type="submit"]').click();
    await appReady(page);
}

/*
 * Real SSH connect through the product's own modal. Returns {id} or {error}:
 * MAX_SESSIONS is a GLOBAL cap of 10, so a refusal is a legitimate outcome that
 * must be reported rather than thrown, otherwise a capacity refusal would look
 * like a performance result.
 *
 * The temporary ssh_error listener is REMOVED again on every path. A harness
 * that leaves its own listener attached shows up in the item-6 census as
 * application growth, which is exactly the confound this measurement exists to
 * rule out.
 */
async function connectReal(page, touch = false) {
    const before = await page.evaluate(() => Object.keys(SessionManager.sessions));
    await page.evaluate(() => {
        window.__connErr = null;
        window.__connErrHandler = d => {
            window.__connErr = (d && d.error) || 'ssh_error';
        };
        window.socket.on('ssh_error', window.__connErrHandler);
    });
    const detach = () => page.evaluate(() => {
        if (window.__connErrHandler) {
            window.socket.off('ssh_error', window.__connErrHandler);
            window.__connErrHandler = null;
        }
    }).catch(() => {});
    try {
        // W14 item 7: #newConnectionBtn is ALWAYS on screen (the permanent
        // first child of the session strip at every viewport), so the old
        // More-sheet fallback for the relocated node is gone.
        const newBtn = page.locator('#newConnectionBtn');
        if (await newBtn.isVisible()) {
            await newBtn.click();
        } else {
            if (touch) await newBtn.tap(); else await newBtn.click({ force: true });
        }
        await page.locator('#connectionModal').waitFor({ state: 'visible' });
        await page.locator('#hostInput').fill(SSH_HOST);
        await page.locator('#portInput').fill('22');
        await page.locator('#usernameInput').fill(SSH_USER);
        await page.locator('#authTypeSelect').selectOption('password');
        await page.locator('#passwordInput').fill(SSH_PASS);
        await page.locator('#connectBtn').click();
        try {
            await page.waitForFunction(prev => {
                if (window.__connErr) return true;
                return Object.keys(SessionManager.sessions).some(i => !prev.includes(i));
            }, before, { timeout: 35000 });
        } catch {
            return { error: 'timeout waiting for a new session' };
        }
        const err = await page.evaluate(() => window.__connErr);
        if (err) return { error: err };
        const id = await page.evaluate(prev =>
            Object.keys(SessionManager.sessions).find(i => !prev.includes(i)), before);
        try {
            await page.waitForFunction(i => TerminalManager.terminalReady[i] === true,
                id, { timeout: 30000 });
        } catch {
            // The session exists but its terminal never reported ready. Report
            // that instead of throwing: a stuck terminal is a finding.
            return { id, error: `session ${id} created but terminal never became ready` };
        }
        return { id };
    } finally {
        await detach();
    }
}

/*
 * Run one measurement step in isolation. A step that fails must not abandon the
 * remaining steps on the same tab -- that is how the first run lost items 1c,
 * 2, 3b, 4b, 4c, 5b and 5c to a single timeout.
 */
async function step(id, label, fn) {
    try {
        await fn();
    } catch (e) {
        row(id, label, 'ERROR', '', 'LIVE', String(e).split('\n')[0].slice(0, 150));
    }
}

/*
 * Same real connect, but issued as the socket request the modal would send.
 * Used where a measurement needs terminal CHURN rather than UI coverage: the
 * ssh_connected handler, createTerminal and the restore path are identical, and
 * it cannot be blocked by an open dialog or a covered button.
 */
async function connectViaSocket(page) {
    const r = await page.evaluate(async ({ host, user, pass }) => {
        const before = Object.keys(SessionManager.sessions);
        let onErr = null;
        let iv = null;
        let to = null;
        const cleanup = () => {
            if (iv !== null) clearInterval(iv);
            if (to !== null) clearTimeout(to);
            if (onErr) window.socket.off('ssh_error', onErr);
            onErr = null;
        };
        const res = await new Promise(resolve => {
            iv = setInterval(() => {
                const fresh = Object.keys(SessionManager.sessions)
                    .find(x => !before.includes(x));
                if (fresh && TerminalManager.terminalReady[fresh]) {
                    resolve({ id: fresh });
                }
            }, 20);
            onErr = d => resolve({ error: (d && d.error) || 'ssh_error' });
            window.socket.on('ssh_error', onErr);
            to = setTimeout(() => resolve({ error: 'timeout' }), 35000);
            window.socket.emit('ssh_connect', {
                host, port: 22, username: user, password: pass,
                auth_type: 'password', use_tmux: true,
                client_request_id: `partg_${Date.now().toString(36)}`,
            });
        });
        // Cleanup on EVERY path, including success: a listener or interval the
        // harness leaves behind would be counted as application growth by the
        // item-6 census.
        cleanup();
        return res;
    }, { host: SSH_HOST, user: SSH_USER, pass: SSH_PASS });
    return r;
}

/*
 * config.RATELIMIT_SSH_CONNECT is '10 per minute' PER USER, and ssh_reconnect
 * shares that same bucket (socket_events.py:662). This probe issues far more
 * than ten connect-family requests, so without pacing a measurement can end up
 * timing the RATE LIMITER instead of the product -- which is what the first run
 * of row 2a actually did (it returned code "rate_limited" in 75 ms, a number
 * about Flask-Limiter, not about reconnect). Wait out the window before any
 * block that must measure a real server response.
 */
async function coolDownRateLimit(page, seconds = 65, why = '') {
    console.log(`  … waiting ${seconds}s for the ssh_connect rate-limit window`
        + `${why ? ` (${why})` : ''}`);
    await page.waitForTimeout(seconds * 1000);
}

/*
 * VALIDATE THE LONG-TASK OBSERVER before any 0 ms reading is trusted.
 * Burns the main thread for `ms` and asserts the PerformanceObserver saw a
 * longtask of at least that duration. A 0 ms "longest long task" from an
 * observer that never fires is indistinguishable from a genuinely smooth build,
 * so this converts silence into evidence.
 */
async function validateLongTaskObserver(page, ms = 120) {
    await page.evaluate(() => { window.__probe.longTasks.length = 0; });
    const burned = await page.evaluate(x => window.__probeBurn(x), ms);
    await page.waitForTimeout(600);
    const seen = await page.evaluate(() => window.__probe.longTasks.map(t => t.dur));
    const longest = seen.length ? Math.max(...seen) : 0;
    await page.evaluate(() => { window.__probe.longTasks.length = 0; });
    return { burned, longest, count: seen.length, ok: longest >= ms * 0.5 };
}

// Wait for a real shell prompt so latency samples are not racing the tmux
// attach redraw.
const waitPrompt = (page, id, timeout = 25000) => page.waitForFunction(sid => {
    const buf = TerminalManager.terminals[sid]?.buffer?.active;
    if (!buf) return false;
    for (let i = 0; i < buf.length; i++) {
        if (/[$#] $/.test(buf.getLine(i)?.translateToString(true) || '')) return true;
    }
    return false;
}, id, { timeout });

// Disconnect with kill_tmux so this probe never exhausts the global session cap
// and never leaves tmux garbage behind. closeSession() emits ssh_disconnect AND
// tears the client side down, so nothing is left mounted either.
async function disconnectAll(page) {
    const ids = await page.evaluate(() => Object.keys(SessionManager.sessions))
        .catch(() => []);
    for (const id of ids) {
        await page.evaluate(i => SessionManager.closeSession(i), id).catch(() => {});
        await page.waitForTimeout(350);
    }
    await page.waitForTimeout(500);
    return ids.length;
}
/*
 * Resource census. socket.io v4 is minified: its handler map is a MANGLED
 * property (`this.t["$"+event]`), so the map is found by shape -- an own object
 * property whose every key starts with '$' -- rather than by guessing a name.
 * Inlined rather than passed as a stringified function because the deployment
 * serves a CSP that would reject new Function().
 */
async function census(page) {
    return page.evaluate(() => {
        const sock = window.socket;
        let sEvents = -1; let sHandlers = -1;
        if (sock) {
            sEvents = 0; sHandlers = 0;
            for (const k of Object.keys(sock)) {
                const v = sock[k];
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    const ks = Object.keys(v);
                    if (ks.length && ks.every(x => x.charCodeAt(0) === 36)) {
                        sEvents = ks.length;
                        sHandlers = ks.reduce((n, x) =>
                            n + (Array.isArray(v[x]) ? v[x].length : 0), 0);
                        break;
                    }
                }
            }
        }
        return {
            gen: window.__probe.gen,
            xtermInstances: Object.keys(TerminalManager.terminals || {}).length,
            xtermDomScreens: document.querySelectorAll('.xterm-screen').length,
            fitAddons: Object.keys(TerminalManager.fitAddons || {}).length,
            sessions: Object.keys(SessionManager.sessions || {}).length,
            sessionTerminals: Object.keys(TerminalManager.sessionTerminals || {}).length,
            terminalReadyKeys: Object.keys(TerminalManager.terminalReady || {}).length,
            disposableKeys: Object.keys(TerminalManager.disposables || {}).length,
            replayStateKeys: Object.keys(TerminalManager.replayState || {}).length,
            transcriptKeys: Object.keys(TerminalManager.transcripts || {}).length,
            fitRequestKeys: Object.keys(TerminalManager.fitRequests || {}).length,
            resizeObserverKeys: Object.keys(TerminalManager.resizeObservers || {}).length,
            socketEvents: sEvents,
            socketHandlers: sHandlers,
            domNodes: document.querySelectorAll('*').length,
            liveIntervals: window.__probeTimers.intervals.size,
            pendingTimeouts: window.__probeTimers.timeouts.size,
            resizeObservers: window.__probeObs.resize,
            mutationObservers: window.__probeObs.mutation,
            domListenersNet: window.__probeListeners.add - window.__probeListeners.remove,
            // Same figure with the harness's own listeners removed, so a delta
            // can be attributed to the application rather than to this probe.
            domListenersNetAppOnly: (window.__probeListeners.add
                - window.__probe.selfAdds)
                - (window.__probeListeners.remove - window.__probe.selfRemoves),
            listenerAdds: window.__probeListeners.add,
            listenerRemoves: window.__probeListeners.remove,
            listenersByType: JSON.parse(JSON.stringify(window.__probeListeners.byType)),
        };
    });
}

// Per-type listener growth between two censuses, largest first. A net total can
// only say "something grew"; this says WHICH type grew, which is what decides
// whether the growth is the application's or the harness's.
function listenerDelta(before, after, top = 8) {
    const types = new Set([...Object.keys(before.listenersByType),
        ...Object.keys(after.listenersByType)]);
    const out = [];
    for (const t of types) {
        const b = before.listenersByType[t] || { add: 0, remove: 0 };
        const a = after.listenersByType[t] || { add: 0, remove: 0 };
        const net = (a.add - a.remove) - (b.add - b.remove);
        if (net !== 0) {
            out.push({ type: t, net, adds: a.add - b.add, removes: a.remove - b.remove });
        }
    }
    out.sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
    return out.slice(0, top);
}
const fmtDelta = d => d.length
    ? d.map(x => `${x.type} ${x.net >= 0 ? '+' : ''}${x.net} `
        + `(${x.adds} add/${x.removes} rm)`).join(', ')
    : 'no per-type change';

/*
 * Heap after a FORCED GC, plus a true detached-node count: queryObjects over
 * HTMLElement.prototype enumerates every live HTMLElement including ones only
 * reachable from JS, so `isConnected === false` is a real detached node rather
 * than an approximation over app maps.
 *
 * Two details the naive version got wrong:
 *   - `for (const n of this)` throws "Illegal invocation": the returned array is
 *     a plain Array in the page's realm but iterating it inside callFunctionOn
 *     invokes Symbol.iterator across realms. Index the array instead.
 *   - Some entries are not safely touchable (cross-origin or already-collected
 *     wrappers) and throw on property access. Those are skipped and counted, so
 *     a skip can never masquerade as "not detached".
 */
async function heapAndDetached(page) {
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send('Runtime.enable');
        await cdp.send('HeapProfiler.enable');
        await cdp.send('HeapProfiler.collectGarbage');
        const { usedSize } = await cdp.send('Runtime.getHeapUsage');
        const proto = await cdp.send('Runtime.evaluate',
            { expression: 'HTMLElement.prototype' });
        const objs = await cdp.send('Runtime.queryObjects',
            { prototypeObjectId: proto.result.objectId });
        const counted = await cdp.send('Runtime.callFunctionOn', {
            objectId: objs.objects.objectId,
            returnByValue: true,
            functionDeclaration: `function () {
                let detached = 0; let total = 0; let skipped = 0;
                for (let i = 0; i < this.length; i++) {
                    let connected;
                    try { connected = this[i].isConnected; }
                    catch (e) { skipped += 1; continue; }
                    total += 1;
                    if (connected === false) detached += 1;
                }
                return { detached, total, skipped };
            }`,
        });
        if (counted.exceptionDetails || !counted.result || !counted.result.value) {
            return {
                heapMB: usedSize / (1024 * 1024),
                detached: NaN, liveElements: NaN, skipped: NaN,
            };
        }
        const v = counted.result.value;
        return {
            heapMB: usedSize / (1024 * 1024),
            detached: v.detached,
            liveElements: v.total,
            skipped: v.skipped,
        };
    } finally {
        await cdp.detach().catch(() => {});
    }
}

function containerMem() {
    const out = {};
    try {
        out.cgroupMB = parseInt(execSync(
            "docker exec sshdeck sh -c 'cat /sys/fs/cgroup/memory.current'",
            { encoding: 'utf8' }).trim(), 10) / (1024 * 1024);
    } catch { out.cgroupMB = NaN; }
    try {
        out.rssMB = parseInt(execSync(
            "docker exec sshdeck sh -c \"awk '/VmRSS/{s+=\\$2} END{print s}' "
            + '/proc/*/status"', { encoding: 'utf8' }).trim(), 10) / 1024;
    } catch { out.rssMB = NaN; }
    return out;
}

const U1 = `${creds.sshdeck_user}pg1${RUN}`;
const U2 = `${creds.sshdeck_user}pg2${RUN}`;
const IMAGE = execSync("docker inspect sshdeck --format '{{.Config.Image}}'",
    { encoding: 'utf8' }).trim();

console.log('\n═══ Part G performance / resource measurement ═══');
console.log(`target: ${BASE}   image: ${IMAGE}`);
console.log(`\n  ${'id'.padEnd(5)}${'metric'.padEnd(48)}${'value'.padStart(14)}  `
    + `${'unit'.padEnd(6)}source\n`);
// ══ (1a) cold load ═════════════════════════════════════════════════════════
console.log('(1) TIME-TO-FIRST-TERMINAL');
try {
    const coldApp = []; const coldTerm = [];
    for (let i = 0; i < 5; i++) {
        const { ctx, page } = await newPage();
        try {
            if (i === 0) await register(page, U1); else await login(page, U1);
            coldApp.push(await page.evaluate(() =>
                window.__probe.appReadyAt - window.__probe.navStart));
            // Re-zero the clock at the moment we ask for a terminal, so this
            // measures "connect -> usable terminal", not the login round trip.
            await page.evaluate(() => { window.__probe.navStart = performance.now(); });
            const c = await connectReal(page);
            if (c.error) {
                notes.push(`1a run ${i + 1}: connect refused — ${c.error}`);
            } else {
                coldTerm.push((await firstTerminalReady(page)).toReady);
            }
            await disconnectAll(page);
        } finally { await ctx.close(); }
    }
    row('1a', 'cold: navigation -> app ready (median/5)', median(coldApp), 'ms',
        'LIVE', `runs ${list(coldApp)}`);
    row('1a', 'cold: connect -> 1st terminal painted (med/5)', median(coldTerm),
        'ms', 'LIVE', `runs ${list(coldTerm)}`);
} catch (e) {
    row('1a', 'cold load block', 'ERROR', '', 'LIVE', String(e).slice(0, 140));
}
// ══ (1b/1c) reload-restore, (2) reconnect, (3b) terminal latency, (4) long
//    tasks, (5) fit counts — all on one authenticated tab ═══════════════════
const { ctx: mainCtx, page: main } = await newPage();
let nSess = 0;
try {
    await login(main, U1);
    const c1 = await connectReal(main);
    if (c1.error) throw new Error(`connect refused: ${c1.error}`);

    await step('1b', 'reload, 1 restored session -> 1st term', async () => {
        const one = [];
        for (let i = 0; i < 5; i++) {
            await main.reload({ waitUntil: 'commit' });
            one.push((await firstTerminalReady(main)).toReady);
            await main.waitForTimeout(500);
        }
        row('1b', 'reload, 1 restored session -> 1st term (med/5)', median(one), 'ms',
            'LIVE', `runs ${list(one)}`);
    });

    await step('1c', 'reload, several restored sessions -> 1st term', async () => {
        const c2 = await connectReal(main);
        const c3 = await connectReal(main);
        nSess = await main.evaluate(() => Object.keys(SessionManager.sessions).length);
        if (c2.error || c3.error) {
            notes.push(`1c: reached ${nSess} session(s) — ${c2.error || c3.error}`);
        }
        const many = [];
        for (let i = 0; i < 5; i++) {
            await main.reload({ waitUntil: 'commit' });
            many.push((await firstTerminalReady(main)).toReady);
            await main.waitForTimeout(500);
        }
        row('1c', `reload, ${nSess} restored sessions -> 1st term (med/5)`,
            median(many), 'ms', 'LIVE', `runs ${list(many)}`);
    });

    console.log('\n(4) LONGEST SINGLE LONG TASK  /  (5) fit() CALL COUNTS');
    await step('4v', 'long-task observer self-validation', async () => {
        const v = await validateLongTaskObserver(main, 120);
        row('4v', 'observer self-check: injected 120ms busy task', v.longest, 'ms',
            'LIVE', `burned ${v.burned.toFixed(0)}ms, observer reported `
            + `${v.count} longtask(s) — ${v.ok ? 'OBSERVER LIVE' : 'OBSERVER BLIND'}`);
        if (!v.ok) {
            notes.push('4v: the longtask observer did NOT see an injected 120ms '
                + 'busy task, so every 0ms long-task reading below is unproven.');
        }
    });
    await step('4b', 'longest long task, reload-restore', async () => {
        await main.reload({ waitUntil: 'commit' });
        await firstTerminalReady(main);
        await main.waitForTimeout(2500);
        const ltReload = await main.evaluate(() =>
            window.__probe.longTasks.map(t => t.dur));
        row('4b', `longest long task, reload-restore (${nSess} sess)`,
            ltReload.length ? Math.max(...ltReload) : 0, 'ms', 'LIVE',
            `${ltReload.length} long tasks, sum `
            + `${ltReload.reduce((a, b) => a + b, 0).toFixed(0)}ms`);

        // fit() during that SAME reload-restore, so the two rows describe one
        // navigation rather than two different ones. Note that fitTerminal()
        // gates on isTerminalVisible(), so a terminal parked in a hidden pane is
        // deliberately never fit -- the count tracks VISIBLE terminals.
        const fitReload = await main.evaluate(() => window.__probe.fitCalls);
        const visible = await main.evaluate(() =>
            Object.keys(TerminalManager.terminals)
                .filter(k => TerminalManager.isTerminalVisible(k)).length);
        row('5c', `fit() during reload-restore (${nSess} sessions)`, fitReload,
            'calls', 'LIVE', `${visible} of ${nSess} terminals visible; `
            + `${(fitReload / Math.max(1, visible)).toFixed(1)} per visible terminal`);
    });

    await step('5b', 'fit() for ONE viewport resize', async () => {
        const fb = await main.evaluate(() => window.__probe.fitCalls);
        const vis = await main.evaluate(() => Object.keys(TerminalManager.terminals)
            .filter(k => TerminalManager.isTerminalVisible(k)).length);
        await main.setViewportSize({ width: 1280, height: 780 });
        await main.waitForTimeout(1200);
        const fa = await main.evaluate(() => window.__probe.fitCalls);
        row('5b', 'fit() for ONE viewport resize', fa - fb, 'calls', 'LIVE',
            `${nSess} sessions, ${vis} visible terminals; requestFit + the `
            + 'per-key ResizeObserver debounce coalesce');
    });

    console.log('\n(2) RECONNECT OF AN EXISTING TMUX SESSION');
    await coolDownRateLimit(main, 65, 'ssh_reconnect shares the connect bucket');
    /*
     * ROW 2a -- the reconnect path that is CORRECT FOR THIS AUTH TYPE.
     *
     * What this row used to do, and why it was wrong: it emitted a bare
     * ssh_reconnect for a PASSWORD session and gated on three "reconnected"
     * answers. The server refuses that by design -- it stores no password it
     * could replay (socket_events.py:687 -> 'password_required') -- so the row
     * measured a refusal round trip three times and then failed its own gate.
     * The number was real but it described the refusal, not a reconnect.
     *
     * The gate is NOT relaxed. It is now the STRONGER requirement the product
     * actually owes a password session: the confirmation, the explicit
     * credential prompt, ONE ssh_connect carrying reconnect_tmux_name, and a
     * genuine REATTACH -- proven by a marker printed into the pane BEFORE the
     * reconnect still being on screen afterwards, which a freshly created tmux
     * session could not show. Three consecutive full cycles, or the gate fails.
     *
     * ssh_reconnect's own prepare-and-swap remains the right path for key and
     * Tailscale, and §5 of tests/browser/defect1_defect2_regression.mjs asserts
     * that those two still take it. It is not measured here because provisioning
     * an authorized_key for the test user is a host auth change, and the
     * Tailscale leg needs a tailnet identity this container does not hold --
     * both out of scope without approval, and both reported rather than faked.
     */
    await step('2a', 'password reconnect: confirm -> credential -> reattach',
        async () => {
        /*
         * The emit recorder. This row runs against the LIVE deployment, so
         * there is no socket stub to read: the payloads are captured by wrapping
         * socket.emit for the duration of the row and restoring it afterwards.
         *
         * A wrapper adds no LISTENER, so the item-6 census is unaffected, and it
         * is removed on every exit path below -- a harness that left it in place
         * would be counted as application growth by the very census this file
         * also produces.
         */
        await main.evaluate(() => {
            window.__pgEmits = [];
            window.__pgRealEmit = window.socket.emit.bind(window.socket);
            window.socket.emit = (n, p) => {
                window.__pgEmits.push({ name: n, payload: p });
                return window.__pgRealEmit(n, p);
            };
        });
        const restoreEmit = () => main.evaluate(() => {
            if (window.__pgRealEmit) {
                window.socket.emit = window.__pgRealEmit;
                window.__pgRealEmit = null;
            }
        }).catch(() => {});
        try {
        const cycle = async (i) => {
            const sid = await main.evaluate(() => Object.keys(SessionManager.sessions)
                .find(x => SessionManager.sessions[x].connected
                    && SessionManager.sessions[x].tmuxSessionName
                    && TerminalManager.terminalReady[x]));
            if (!sid) return { code: 'no_session' };
            const tmuxName = await main.evaluate(x =>
                SessionManager.sessions[x].tmuxSessionName, sid);

            // A marker only a REATTACHED pane can still be showing.
            const marker = `PARTG_REATTACH_${RUN}_${i}`;
            await main.evaluate(({ x, m }) => {
                window.socket.emit('ssh_input',
                    { session_id: x, data: `echo ${m}\r` });
            }, { x: sid, m: marker });
            await main.waitForTimeout(1200);
            const markerBefore = await main.evaluate(({ x, m }) =>
                TerminalManager.getTranscript(x).includes(m), { x: sid, m: marker });
            if (!markerBefore) return { code: 'marker_not_echoed' };

            await main.evaluate(() => { window.__pgEmits = []; });
            const t0 = Date.now();
            // The product's own entry point, not a synthesised emit.
            await main.evaluate(x => SessionManager.requestReconnect(x), sid);
            await main.waitForTimeout(200);
            const confirmOpen = await main.evaluate(() =>
                document.getElementById('sessionConfirm')?.hidden === false);
            if (!confirmOpen) return { code: 'no_confirm' };
            await main.evaluate(() =>
                document.getElementById('sessionConfirmAccept').click());
            await main.waitForTimeout(300);

            // The reconnect intent is request-keyed; the one serving the
            // credential modal is the one this action just armed. Its requestId
            // is what the reply will be correlated against, so it is captured
            // here alongside the identity fields.
            const meta = await main.evaluate(() => {
                const intent = SessionManager.activeReconnectIntent();
                return {
                    modal: !!document.getElementById('connectionModal')
                        ?.classList.contains('show'),
                    tmux: intent?.tmuxSessionName || null,
                    target: intent?.sessionId || null,
                    requestId: intent?.requestId || null,
                };
            });
            if (!meta.modal) return { code: 'no_credential_prompt' };
            if (meta.tmux !== tmuxName) return { code: 'intent_lost_tmux_name' };
            if (meta.target !== sid) return { code: 'intent_lost_target' };
            if (!meta.requestId) return { code: 'intent_lost_request_id' };

            const before = await main.evaluate(() =>
                Object.keys(SessionManager.sessions));
            /*
             * S27 — MEASURE THE PRODUCT, NOT THE PER-USER SESSION CAP.
             *
             * This row reported `no_new_session` 3/3 while the reconnect path was
             * in fact healthy. Diagnosed rather than assumed
             * (/tmp/s26reg/diag21_reconnect.out, /tmp/s26reg/diag22_cap.out):
             *
             *   - from a 1-session state the IDENTICAL path succeeds:
             *     new_session_ready, one ssh_connect carrying
             *     reconnect_tmux_name, zero ssh_error frames;
             *   - at 3 live sessions the server answers
             *     ssh_error "Per-user session limit reached"
             *     (MAX_SESSIONS_PER_USER = 3, config.py:27).
             *
             * Rows 1b/1c above create c1+c2+c3 = exactly the cap, and a PASSWORD
             * reconnect is a NEW ssh_connect (it needs a 4th slot while the old
             * session is still registered). So the refusal was CORRECT server
             * behaviour and the old `no_new_session` merely named this row's own
             * 40s timeout, hiding the reason.
             *
             * Two changes, neither of which relaxes the gate: the server's own
             * refusal is captured so it can never again be reported as a
             * mystery timeout, and ONE slot is released first so the cycle has
             * room to run. The reconnect requirement itself -- 1 ssh_connect with
             * reconnect_tmux_name, 0 ssh_disconnect, same tmux name, the
             * pre-reconnect marker still on screen, transcript adopted, old
             * session retired -- is unchanged and still gated three times.
             */
            await main.evaluate(() => {
                window.__pgCapErrors = [];
                if (!window.__pgCapHooked) {
                    window.__pgCapHooked = true;
                    window.socket.on('ssh_error', (d) => {
                        (window.__pgCapErrors = window.__pgCapErrors || []).push(
                            String((d && d.error) || '').slice(0, 200));
                    });
                }
            });
            /*
             * The emit ledger is reset AFTER the slot release below, so the
             * `disconnects === 0` proof keeps measuring only what the RECONNECT
             * PATH did. Without this, the harness's own slot-freeing
             * ssh_disconnect was counted against the product and cycles #1/#2
             * failed on `disconnects=1` while every real proof (sameName, marker,
             * adopted, retired, connects=1) was already true -- the harness
             * contaminating the assertion it exists to enable.
             */
            /*
             * Free a slot by closing a session this row is NOT reconnecting.
             * Scoped explicitly to this probe's own throwaway account, and never
             * the reconnect target, so the marker/transcript/retirement proofs
             * below still describe the session under test.
             */
            const freed = await main.evaluate((keep) => {
                const other = Object.keys(SessionManager.sessions)
                    .find(x => x !== keep && SessionManager.sessions[x].connected);
                if (other) {
                    window.socket.emit('ssh_disconnect', { session_id: other });
                    return other;
                }
                return null;
            }, sid);
            if (freed) await main.waitForTimeout(2500);
            // Only the reconnect's OWN emits are attributable to the product.
            await main.evaluate(() => { window.__pgEmits = []; });
            await main.locator('#passwordInput').fill(SSH_PASS);
            await main.locator('#connectBtn').click();
            let fresh = null;
            try {
                await main.waitForFunction(prev => {
                    const id = Object.keys(SessionManager.sessions)
                        .find(x => !prev.includes(x));
                    return !!id && TerminalManager.terminalReady[id] === true;
                }, before, { timeout: 40000 });
                fresh = await main.evaluate(prev => Object.keys(SessionManager.sessions)
                    .find(x => !prev.includes(x)), before);
            } catch {
                // The refusal, verbatim, instead of a bare timeout name.
                const errs = await main.evaluate(() => window.__pgCapErrors || []);
                return {
                    code: errs.length ? `refused: ${errs[errs.length - 1]}`
                        : 'no_new_session',
                    serverErrors: errs,
                    freedSlot: freed ? freed.slice(0, 8) : null,
                };
            }
            const ms = Date.now() - t0;
            await main.waitForTimeout(1200);

            const proof = await main.evaluate(({ id, old, m, nm }) => ({
                tmux: SessionManager.sessions[id]?.tmuxSessionName || null,
                reattachedSameName: SessionManager.sessions[id]?.tmuxSessionName === nm,
                // The marker on SCREEN, from the reattached pane's own redraw.
                markerOnScreen: (() => {
                    const term = TerminalManager.terminals[
                        (TerminalManager.sessionTerminals[id] || [])[0]];
                    const buf = term?.buffer?.active;
                    if (!buf) return false;
                    for (let r = 0; r < buf.length; r++) {
                        if ((buf.getLine(r)?.translateToString(true) || '').includes(m)) {
                            return true;
                        }
                    }
                    return false;
                })(),
                transcriptAdopted: TerminalManager.getTranscript(id).includes(m),
                oldRetired: !SessionManager.sessions[old],
                oldTranscriptFreed: !TerminalManager.transcripts[old],
                connects: window.__pgEmits.filter(e => e.name === 'ssh_connect').length,
                disconnects: window.__pgEmits
                    .filter(e => e.name === 'ssh_disconnect').length,
                reconnectName: window.__pgEmits
                    .find(e => e.name === 'ssh_connect')?.payload?.reconnect_tmux_name
                    ?? null,
            }), { id: fresh, old: sid, m: marker, nm: tmuxName });

            return { ms, code: 'reattached', ...proof };
        };

        const samples = [];
        const outcomes = [];
        for (let i = 0; i < 3; i++) {
            const r = await cycle(i);
            outcomes.push(r);
            if (r.code === 'reattached') samples.push(r.ms);
            await coolDownRateLimit(main, 65, 'each cycle spends a connect slot');
        }

        const complete = outcomes.filter(o => o.code === 'reattached'
            && o.reattachedSameName === true
            && o.markerOnScreen === true
            && o.transcriptAdopted === true
            && o.oldRetired === true
            && o.connects === 1
            && o.disconnects === 0
            && o.reconnectName);
        row('2a', 'password reconnect: confirm -> credential -> reattach',
            samples.length ? median(samples) : 'GATE-FAIL',
            samples.length ? 'ms' : '', 'LIVE',
            `outcomes ${outcomes.map(o => o.code).join('/')}`
            + `${samples.length ? `; runs ${list(samples)}` : ''}`);
        if (complete.length === 3) {
            row('2a', 'GATE: three complete credential+reattach cycles', 'PASS', '',
                'LIVE', 'each: 1 ssh_connect with reconnect_tmux_name, 0 '
                + 'ssh_disconnect, same tmux name, pre-reconnect marker still on '
                + 'screen, transcript adopted, old session retired');
        } else {
            row('2a', 'GATE: three complete credential+reattach cycles', 'FAIL', '',
                'LIVE', `${complete.length}/3 complete; `
                + outcomes.map((o, i) => `#${i + 1} ${o.code}`
                    + (o.code === 'reattached'
                        ? ` (sameName=${o.reattachedSameName} marker=${o.markerOnScreen}`
                          + ` adopted=${o.transcriptAdopted} retired=${o.oldRetired}`
                          + ` connects=${o.connects} disconnects=${o.disconnects})`
                        : '')).join('; '));
        }
        notes.push('2a measures the path that is correct for a PASSWORD session: '
            + 'the server holds no replayable secret, so a bare ssh_reconnect is '
            + 'a design refusal, not a reconnect. ssh_reconnect prepare-and-swap '
            + 'stays the key/Tailscale path and is asserted by '
            + 'tests/browser/defect1_defect2_regression.mjs §5; measuring it live '
            + 'needs an authorized_key or a tailnet identity, both host/identity '
            + 'changes out of scope here.');
        } finally {
            await restoreEmit();
        }
    });

    // (2b) the real user-facing reconnect: drop the client-side session WITHOUT
    // ssh_disconnect (so tmux survives on the host), then reattach BY NAME --
    // exactly what directReconnect emits.
    await step('2b', 'reattach existing tmux', async () => {
        const reattach = [];
        for (let i = 0; i < 3; i++) {
            const target = await main.evaluate(() =>
                Object.keys(SessionManager.sessions)
                    .find(x => SessionManager.sessions[x].connected));
            if (!target) break;
            const name = await main.evaluate(x =>
                SessionManager.sessions[x]?.tmuxSessionName, target);
            if (!name) break;
            await main.evaluate(x => SessionManager.removeSessionUI(x), target);
            await main.waitForTimeout(500);
            const ms = await main.evaluate(async ({ nm, host, user, pass }) => {
                const before = Object.keys(SessionManager.sessions);
                const t0 = performance.now();
                const done = new Promise(resolve => {
                    const iv = setInterval(() => {
                        const fresh = Object.keys(SessionManager.sessions)
                            .find(x => !before.includes(x));
                        if (fresh && TerminalManager.terminalReady[fresh]) {
                            clearInterval(iv); resolve(performance.now());
                        }
                    }, 15);
                    setTimeout(() => { clearInterval(iv); resolve(NaN); }, 30000);
                });
                window.socket.emit('ssh_connect', {
                    host, port: 22, username: user, password: pass,
                    auth_type: 'password', use_tmux: true, reconnect_tmux_name: nm,
                    client_request_id: `partg_${Date.now().toString(36)}`,
                });
                const t1 = await done;
                return Number.isNaN(t1) ? NaN : t1 - t0;
            }, { nm: name, host: SSH_HOST, user: SSH_USER, pass: SSH_PASS });
            reattach.push(ms);
            await main.waitForTimeout(1200);
        }
        if (num(reattach).length) {
            row('2b', 'reattach existing tmux: emit -> terminal ready',
                median(reattach), 'ms', 'LIVE', `runs ${list(reattach)}`);
        } else {
            row('2b', 'reattach existing tmux', 'n/a', '', 'LIVE',
                'no connected session carrying a tmux name');
        }
    });

    console.log('\n(3) INPUT-TO-RENDER LATENCY (Vietnamese Telex)');
    await step('3b', 'terminal Telex input -> render', async () => {
        const tid = await main.evaluate(() => Object.keys(SessionManager.sessions)
            .find(i => SessionManager.sessions[i].connected
                && TerminalManager.terminalReady[i]));
        if (!tid) {
            row('3b', 'terminal Telex input -> render', 'n/a', '', 'LIVE',
                'no ready connected session');
            return;
        }
        await main.evaluate(i => SessionManager.switchSession(i), tid);
        await main.waitForTimeout(700);
        await waitPrompt(main, tid).catch(() => {});
        /*
         * Pairing happens INSIDE the page: keydown stamps t0, onData stamps when
         * the client finished handling the key, onWriteParsed stamps when the
         * echoed bytes have been parsed into the buffer (the render-eligible
         * moment). In-page pairing keeps the CDP round trip out of the number.
         */
        await main.evaluate(id => {
            const t = TerminalManager.terminals[id];
            window.__lat = { down: null, mark: null, onData: null, keys: 0, datas: 0 };
            /*
             * The keydown stamp MUST be taken on `window` in the capture phase.
             * xterm's own keydown handler is attached to the same textarea and
             * was registered first, so a listener on the textarea -- capture flag
             * or not -- runs AFTER xterm has already emitted onData for that
             * key. Stamping from window's capture phase happens before the event
             * reaches the textarea at all, which is what makes the onData
             * pairing below meaningful instead of always null.
             */
            window.addEventListener('keydown', () => {
                window.__lat.down = performance.now();
                window.__lat.mark = null;
                window.__lat.onData = null;
                window.__lat.keys += 1;
            }, true);
            t.onData(() => {
                window.__lat.datas += 1;
                if (window.__lat.down !== null && window.__lat.onData === null) {
                    window.__lat.onData = performance.now() - window.__lat.down;
                }
            });
            t.onWriteParsed(() => {
                if (window.__lat.down !== null && window.__lat.mark === null) {
                    window.__lat.mark = performance.now() - window.__lat.down;
                }
            });
            t.focus();
        }, tid);
        const echo = []; const local = [];
        for (let i = 0; i < 220; i++) {
            await main.keyboard.type(TELEX[i % TELEX.length]);
            try {
                await main.waitForFunction(() => window.__lat.mark !== null, null,
                    { timeout: 5000 });
            } catch { /* this keystroke produced no echo */ }
            const r = await main.evaluate(() => ({
                mark: window.__lat.mark, od: window.__lat.onData,
            }));
            if (r.mark !== null) echo.push(r.mark);
            if (r.od !== null) local.push(r.od);
        }
        row('3b', 'terminal Telex keydown -> echo parsed (median)', median(echo),
            'ms', 'LIVE', `${echo.length}/220 keystrokes echoed`);
        row('3b', 'terminal Telex keydown -> echo parsed (p95)', pct(echo, 95), 'ms',
            'LIVE', 'includes the SSH + tmux round trip to the host');
        row('3b', 'terminal Telex keydown -> onData handled (med)', median(local),
            'ms', 'LIVE', 'client-side share only, no network');
        row('3b', 'terminal Telex keydown -> onData handled (p95)', pct(local, 95),
            'ms', 'LIVE', `${local.length} samples`);
        const kd = await main.evaluate(() =>
            ({ keys: window.__lat.keys, datas: window.__lat.datas }));
        notes.push(`3b: ${kd.keys} keydowns observed, ${kd.datas} onData emissions, `
            + `${echo.length} echoes parsed, ${local.length} keydown->onData pairs`);
        await main.keyboard.press('Control+C');
        await main.waitForTimeout(500);

        // (4c) longest long task during a burst of terminal output.
        await main.evaluate(() => { window.__probe.longTasks.length = 0; });
        await main.evaluate(i => TerminalManager.terminals[i]?.focus(), tid);
        await main.keyboard.type('seq 1 40000');
        await main.keyboard.press('Enter');
        await main.waitForTimeout(9000);
        const burst = await main.evaluate(() =>
            window.__probe.longTasks.map(t => t.dur));
        row('4c', 'longest long task during output burst',
            burst.length ? Math.max(...burst) : 0, 'ms', 'LIVE',
            `seq 1 40000; ${burst.length} long tasks, sum `
            + `${burst.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
    });
} catch (e) {
    row('--', 'main measurement tab', 'ERROR', '', 'LIVE', String(e).slice(0, 200));
} finally {
    await disconnectAll(main);
    await mainCtx.close();
}
// ══ (4a) longest long task during LOAD, (5a) fit() during LOAD ═════════════
{
    const { ctx, page } = await newPage();
    try {
        await login(page, U1);
        const c = await connectReal(page);
        if (c.error) {
            row('4a', 'longest long task during load', 'n/a', '', 'LIVE', c.error);
        } else {
            // A fresh navigation that restores exactly this one session is the
            // "load" the owner means: app boot plus first terminal.
            await page.reload({ waitUntil: 'commit' });
            await firstTerminalReady(page);
            await page.waitForTimeout(2500);
            const lt = await page.evaluate(() =>
                window.__probe.longTasks.map(t => t.dur));
            row('4a', 'longest long task during load (1 session)',
                lt.length ? Math.max(...lt) : 0, 'ms', 'LIVE',
                `${lt.length} long tasks, sum `
                + `${lt.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
            row('5a', 'fit() during load (1 session restored)',
                await page.evaluate(() => window.__probe.fitCalls), 'calls', 'LIVE',
                `${await page.evaluate(() => Object.keys(TerminalManager.terminals)
        .filter(k => TerminalManager.isTerminalVisible(k)).length)} visible terminal(s)`);
        }
        await disconnectAll(page);
    } catch (e) {
        row('4a', 'load long-task block', 'ERROR', '', 'LIVE', String(e).slice(0, 140));
    } finally { await ctx.close(); }
}

// ══ (3a) composer Telex latency — requires the TOUCH shell (phone 390x844) ══
{
    const { ctx, page } = await newPage({ width: 390, height: 844 }, true);
    try {
        await login(page, U1);
        const c = await connectReal(page, true);
        if (c.error) {
            row('3a', 'composer Telex input -> render', 'n/a', '', 'LIVE', c.error);
        } else {
            await page.waitForTimeout(900);
            const visible = await page.evaluate(() => {
                const el = document.getElementById('mobileInput');
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            if (!visible) {
                row('3a', 'composer Telex input -> render', 'n/a', '', 'LIVE',
                    'composer not rendered on this shell');
            } else {
                await page.evaluate(() => {
                    const el = document.getElementById('mobileInput');
                    window.__clat = { down: null, mark: null };
                    el.addEventListener('keydown', () => {
                        window.__clat.down = performance.now();
                        window.__clat.mark = null;
                    }, true);
                    el.addEventListener('input', () => {
                        const t0 = window.__clat.down;
                        if (t0 === null) return;
                        // Charge the whole frame: handler plus the paint that
                        // actually shows the character.
                        requestAnimationFrame(() => requestAnimationFrame(() => {
                            if (window.__clat.mark === null) {
                                window.__clat.mark = performance.now() - t0;
                            }
                        }));
                    }, true);
                    el.value = '';
                    el.focus();
                });
                const lat = [];
                for (let i = 0; i < 220; i++) {
                    await page.keyboard.type(TELEX[i % TELEX.length]);
                    try {
                        await page.waitForFunction(() => window.__clat.mark !== null,
                            null, { timeout: 4000 });
                        lat.push(await page.evaluate(() => window.__clat.mark));
                    } catch { /* dropped sample */ }
                    if (i % 60 === 59) {
                        // Keep the draft short so the measurement is per-keystroke
                        // cost, not the cost of a 200-char textarea.
                        await page.evaluate(() => {
                            const el = document.getElementById('mobileInput');
                            el.value = '';
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        });
                    }
                }
                row('3a', 'composer Telex keydown -> painted (median)', median(lat),
                    'ms', 'LIVE', `${lat.length}/220 keystrokes, phone 390x844`);
                row('3a', 'composer Telex keydown -> painted (p95)', pct(lat, 95),
                    'ms', 'LIVE', 'client-side only: the composer never '
                    + 'transmits per keystroke');
                // Never leave a draft that a later Send could transmit.
                await page.evaluate(() => {
                    const el = document.getElementById('mobileInput');
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
        }
        await disconnectAll(page);
    } catch (e) {
        row('3a', 'composer latency block', 'ERROR', '', 'LIVE', String(e).slice(0, 140));
    } finally { await ctx.close(); }
}
// ══ (6)(7) BEFORE vs AFTER 5 cycles of reload -> reconnect -> switch ═══════
console.log('\n(6)(7) RESOURCE CENSUS ACROSS 5 CYCLES (reload -> reconnect -> switch)');
{
    const { ctx, page } = await newPage();
    try {
        await register(page, U2);
        // First session through the real modal (UI coverage), second through the
        // socket: with a session already mounted the New-connection button can be
        // covered by the notification stack, and a click timeout there would cost
        // the whole census.
        const a = await connectReal(page);
        const b = await connectViaSocket(page);
        if (a.error || b.error) notes.push(`6 setup: ${a.error || b.error}`);
        await page.waitForTimeout(1500);

        const memBefore = containerMem();
        const hBefore = await heapAndDetached(page);

        /*
         * HARNESS-NEUTRALITY CONTROL.
         *
         * The first run reported "+61 DOM listeners" across the cycles, which is
         * ambiguous on its own: this probe wraps addEventListener/
         * removeEventListener, and the census counts every add the page makes --
         * including ones this harness itself causes. Before attributing growth to
         * the application, take two censuses with NOTHING happening in between
         * except the census calls themselves. Whatever moves here is the probe's
         * own floor and must be subtracted from the judgement.
         */
        await page.waitForTimeout(3000);
        const controlA = await census(page);
        await page.waitForTimeout(3000);
        const controlB = await census(page);
        const idleDrift = controlB.domListenersNet - controlA.domListenersNet;
        row('6c', 'CONTROL: listener drift with NO cycling (6s idle)',
            `${controlA.domListenersNet} -> ${controlB.domListenersNet}`, '', 'LIVE',
            `${idleDrift >= 0 ? '+' : ''}${idleDrift} — the harness/idle floor; `
            + `per-type: ${fmtDelta(listenerDelta(controlA, controlB))}`);

        /*
         * CONTROL: one reload on its own. The listener/timer/observer counters
         * are per DOCUMENT -- an init script runs in a fresh window on every
         * navigation, so those counters restart at zero and a cross-reload
         * "delta" is a comparison of two different documents, not growth inside
         * one. This row states that plainly with the generation numbers.
         */
        const preReload = await census(page);
        await page.reload({ waitUntil: 'commit' });
        await firstTerminalReady(page);
        await page.waitForTimeout(1500);
        const postReload = await census(page);
        row('6c', 'CONTROL: one reload, listener net + generation',
            `${preReload.domListenersNet} -> ${postReload.domListenersNet}`, '', 'LIVE',
            `document generation ${preReload.gen} -> ${postReload.gen}; counters `
            + 'reset per document, so a cross-reload delta is not cumulative growth');

        // Baseline for the cycles is taken AFTER the controls, in the document
        // the cycling starts from.
        const before = await census(page);

        let cycles = 0;
        let realReconnects = 0;
        let churned = 0;
        for (let c = 0; c < 5; c++) {
            await page.reload({ waitUntil: 'commit' });
            await firstTerminalReady(page);
            await page.waitForTimeout(900);
            const ids = await page.evaluate(() => Object.keys(SessionManager.sessions));

            // RECONNECT — the request the user's Reconnect control issues. For a
            // password session the server refuses by design (it holds no
            // secret), so the full client request/response lifecycle runs and
            // onReconnectFailed executes; that is the path being stressed here.
            if (ids.length) {
                const code = await page.evaluate(async id => new Promise(resolve => {
                    const cleanup = () => {
                        window.socket.off('ssh_reconnected', ok);
                        window.socket.off('ssh_reconnect_failed', bad);
                    };
                    function ok() { cleanup(); resolve('reconnected'); }
                    function bad(d) { cleanup(); resolve((d && d.code) || 'failed'); }
                    window.socket.on('ssh_reconnected', ok);
                    window.socket.on('ssh_reconnect_failed', bad);
                    setTimeout(() => { cleanup(); resolve('timeout'); }, 20000);
                    window.socket.emit('ssh_reconnect', { session_id: id });
                }), ids[0]);
                if (code === 'reconnected') realReconnects += 1;
            }

            /*
             * Real terminal CHURN. A reconnect the server refuses never destroys
             * an xterm, so on its own this cycle would not exercise the thing
             * item 6 exists to test.
             *
             * closeSession() is the right call, not a bare ssh_disconnect emit:
             * the server's ssh_disconnected handler only marks the session
             * disconnected (app.js:1070 -> updateSessionStatus), deliberately
             * KEEPING the xterm so its history stays readable. Only
             * closeSession() also runs removeSessionUI -> destroyTerminal. An
             * earlier version of this loop emitted the raw event and so measured
             * three terminals being ADDED, never destroyed.
             */
            if (ids.length > 1) {
                await page.evaluate(id => SessionManager.closeSession(id), ids[1]);
                await page.waitForTimeout(1500);
                const again = await connectViaSocket(page);
                if (!again.error) churned += 1;
                else notes.push(`6 cycle ${c + 1}: re-connect failed — ${again.error}`);
            }

            // SWITCH SESSION, both directions.
            const now = await page.evaluate(() => Object.keys(SessionManager.sessions));
            if (now.length > 1) {
                await page.evaluate(id => SessionManager.switchSession(id), now[1]);
                await page.waitForTimeout(700);
                await page.evaluate(id => SessionManager.switchSession(id), now[0]);
                await page.waitForTimeout(700);
            }
            cycles += 1;
            /*
             * Pace the loop. Each cycle spends one ssh_connect from the user's
             * 10-per-minute bucket; without this the fifth cycle lands inside the
             * same window as the setup connects and is refused, which silently
             * costs the census one churn (observed: "cycle 5: re-connect failed —
             * Too many connection attempts").
             */
            await page.waitForTimeout(7000);
        }
        notes.push(`6: ${cycles} cycles ran — ${realReconnects} server-side transport `
            + `swaps, ${churned} full terminal destroy+create churns, `
            + `${cycles} reloads, ${cycles * 2} session switches`);
        await page.waitForTimeout(2000);
        const after = await census(page);
        const hAfter = await heapAndDetached(page);
        const memAfter = containerMem();

        /*
         * IN-DOCUMENT CHURN — the measurement that can actually prove or clear a
         * listener leak.
         *
         * The five cycles above each cross a reload, which resets every in-page
         * counter, so their before/after listener delta compares two different
         * documents and cannot establish cumulative growth either way. This block
         * stays in ONE document and repeats the churn that allocates and frees
         * terminals (disconnect -> connect -> switch), sampling the census after
         * every repetition. Monotonic per-repetition growth here is an
         * application leak; a flat or oscillating series is not.
         */
        await coolDownRateLimit(page, 65, 'connect churn shares the connect bucket');
        const series = [];
        const churnBase = await census(page);
        series.push(churnBase.domListenersNet);
        let churnReps = 0;
        for (let r = 0; r < 3; r++) {
            const ids = await page.evaluate(() => Object.keys(SessionManager.sessions));
            if (ids.length < 2) break;
            // closeSession(), not a raw ssh_disconnect emit: only this path runs
            // removeSessionUI -> destroyTerminal, which is the allocation being
            // churned. See the comment in the cycle loop above.
            await page.evaluate(id => SessionManager.closeSession(id), ids[1]);
            await page.waitForTimeout(1500);
            const again = await connectViaSocket(page);
            if (again.error) {
                notes.push(`6d rep ${r + 1}: re-connect failed — ${again.error}`);
                break;
            }
            const now = await page.evaluate(() => Object.keys(SessionManager.sessions));
            await page.evaluate(id => SessionManager.switchSession(id), now[1]);
            await page.waitForTimeout(600);
            await page.evaluate(id => SessionManager.switchSession(id), now[0]);
            await page.waitForTimeout(900);
            const s = await census(page);
            series.push(s.domListenersNet);
            churnReps += 1;
        }
        const churnAfter = await census(page);
        const perRep = [];
        for (let i = 1; i < series.length; i++) perRep.push(series[i] - series[i - 1]);
        const monotonic = perRep.length >= 2 && perRep.every(d => d > 0);
        row('6d', 'IN-DOCUMENT churn: listener net per repetition',
            series.join(' -> '), '', 'LIVE',
            `${churnReps} destroy+create reps in ONE document; per-rep `
            + `${perRep.map(d => (d >= 0 ? `+${d}` : `${d}`)).join(',') || 'n/a'} — `
            + `${monotonic ? 'MONOTONIC GROWTH (leak signal)' : 'no monotonic growth'}`);
        row('6d', 'IN-DOCUMENT churn: xterm instances / DOM nodes',
            `${churnBase.xtermInstances}->${churnAfter.xtermInstances} / `
            + `${churnBase.domNodes}->${churnAfter.domNodes}`, '', 'LIVE',
            `${churnReps} reps; per-type listener change: `
            + `${fmtDelta(listenerDelta(churnBase, churnAfter))}`);
        row('6d', 'IN-DOCUMENT churn: xterm/session/observer maps',
            `terms ${churnBase.xtermInstances}->${churnAfter.xtermInstances}, `
            + `sessions ${churnBase.sessions}->${churnAfter.sessions}, `
            + `RO ${churnBase.resizeObservers}->${churnAfter.resizeObservers}, `
            + `MO ${churnBase.mutationObservers}->${churnAfter.mutationObservers}, `
            + `intervals ${churnBase.liveIntervals}->${churnAfter.liveIntervals}`,
            '', 'LIVE', 'a destroy+create pair must return every map to its '
            + 'starting size');

        const KEYS = [
            ['xtermInstances', 'xterm instances (TerminalManager.terminals)'],
            ['xtermDomScreens', '.xterm-screen nodes in the DOM'],
            ['fitAddons', 'fit addons'],
            ['sessions', 'SessionManager.sessions'],
            ['sessionTerminals', 'sessionTerminals keys'],
            ['terminalReadyKeys', 'terminalReady keys'],
            ['disposableKeys', 'disposable-registry keys'],
            ['replayStateKeys', 'replayState keys'],
            ['transcriptKeys', 'transcript keys'],
            ['fitRequestKeys', 'pending fitRequests keys'],
            ['resizeObserverKeys', 'TerminalManager.resizeObservers keys'],
            ['socketEvents', 'socket.io event names bound'],
            ['socketHandlers', 'socket.io handlers total'],
            ['liveIntervals', 'live setInterval timers (net)'],
            ['pendingTimeouts', 'pending setTimeout timers (net)'],
            ['resizeObservers', 'ResizeObserver instances (net)'],
            ['mutationObservers', 'MutationObserver instances (net)'],
            ['domListenersNet', 'DOM listeners, adds - removes (net)'],
            ['domNodes', 'DOM element nodes'],
        ];
        for (const [k, label] of KEYS) {
            const d = after[k] - before[k];
            row('6', label, `${before[k]} -> ${after[k]}`, '', 'LIVE',
                `${d >= 0 ? '+' : ''}${d} over ${cycles} cycles`);
        }
        row('6', 'DOM listeners net, harness adds excluded',
            `${before.domListenersNetAppOnly} -> ${after.domListenersNetAppOnly}`, '',
            'LIVE', `${after.domListenersNetAppOnly - before.domListenersNetAppOnly >= 0
                ? '+' : ''}`
            + `${after.domListenersNetAppOnly - before.domListenersNetAppOnly}; `
            + `document generation ${before.gen} -> ${after.gen} (counters are `
            + 'per-document, so see row 6d for the in-document verdict)');
        row('6', 'DOM listener change BY TYPE across the cycles',
            fmtDelta(listenerDelta(before, after)), '', 'LIVE',
            'largest net movers first');
        row('6', 'detached HTMLElements (forced GC, queryObjects)',
            `${hBefore.detached} -> ${hAfter.detached}`, '', 'LIVE',
            `of ${hBefore.liveElements} -> ${hAfter.liveElements} reachable `
            + `HTMLElements (${hAfter.skipped} unreadable wrappers skipped)`);
        row('7', 'JS heap after forced GC',
            `${hBefore.heapMB.toFixed(1)} -> ${hAfter.heapMB.toFixed(1)}`, 'MB', 'LIVE',
            `${hAfter.heapMB - hBefore.heapMB >= 0 ? '+' : ''}`
            + `${(hAfter.heapMB - hBefore.heapMB).toFixed(1)} MB `
            + `(${((hAfter.heapMB / hBefore.heapMB - 1) * 100).toFixed(1)}%)`);
        row('7', 'container RSS (sum of /proc/*/VmRSS)',
            `${memBefore.rssMB.toFixed(1)} -> ${memAfter.rssMB.toFixed(1)}`, 'MB',
            'LIVE', `${memAfter.rssMB - memBefore.rssMB >= 0 ? '+' : ''}`
            + `${(memAfter.rssMB - memBefore.rssMB).toFixed(1)} MB`);
        row('7', 'container cgroup memory.current',
            `${memBefore.cgroupMB.toFixed(1)} -> ${memAfter.cgroupMB.toFixed(1)}`, 'MB',
            'LIVE', `${memAfter.cgroupMB - memBefore.cgroupMB >= 0 ? '+' : ''}`
            + `${(memAfter.cgroupMB - memBefore.cgroupMB).toFixed(1)} MB, `
            + 'includes page cache');

        // The observer must also be proven live on THIS document before the 0 ms
        // long-task readings above are taken as evidence of a smooth build.
        const v6 = await validateLongTaskObserver(page, 120);
        row('4v', 'observer self-check on the census tab', v6.longest, 'ms', 'LIVE',
            `burned ${v6.burned.toFixed(0)}ms, ${v6.count} longtask(s) — `
            + `${v6.ok ? 'OBSERVER LIVE' : 'OBSERVER BLIND'}`);
        await disconnectAll(page);
    } catch (e) {
        row('6', 'cycle census block', 'ERROR', '', 'LIVE', String(e).slice(0, 200));
    } finally { await ctx.close(); }
}

await browser.close();

if (notes.length) {
    console.log('\nNOTES');
    for (const n of notes) console.log(`  - ${n}`);
}
fs.writeFileSync('/tmp/partG-metrics.json', JSON.stringify(rows, null, 1));
console.log(`\nwrote /tmp/partG-metrics.json (${rows.length} rows)`);
process.exit(0);
