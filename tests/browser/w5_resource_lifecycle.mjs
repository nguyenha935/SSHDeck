#!/usr/bin/env node
/*
 * W5 focused test — resource ownership: timers, latency poll, disposables,
 * replayState cleanup, and the single keep-alive timer.
 *
 * Runs against the REAL production files served over HTTP. Instruments
 * setInterval/clearInterval to count live interval timers.
 *
 * Proves:
 *  §1 Exactly ONE keep-alive interval is live after page load (was two).
 *  §2 startLatencyPolling creates one 15s timer; stopLatencyPolling clears it
 *     and is idempotent (a second call clears nothing extra).
 *  §3 The disposable registry: registerDisposable accumulates cleanups per
 *     session; cleanupSessionDisposables drains them in order, exactly once,
 *     and removes the key (a second drain runs nothing).
 *  §4 destroyTerminal deletes replayState for a session killed mid-replay
 *     (previously leaked until the replay window finished by itself).
 *  §5 Session lifecycle resource parity: create→attach→destroy leaves no
 *     session-keyed maps holding the dead id.
 *
 * Run: node tests/browser/w5_resource_lifecycle.mjs   (from source/)
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
    if (actual === expected) {
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

// Instrument setInterval/clearInterval BEFORE app scripts load. Every live
// interval is tracked by id with its delay.
const INSTRUMENT = `
    window.__intervals = new Map();   // id -> { delay, stack }
    window.__nextIntervalId = 1;
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
    window.__intervalDelays = () => [...window.__intervals.values()].map(v => v.delay);
`;

async function newPage(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    // Block the real socket.io vendor script so it cannot overwrite the io()
    // stub installed below. Without this, socket.io.min.js redefines window.io
    // and app.js's socket.on('connect', ...) never reaches our handler map.
    await page.route('**/socket.io.min.js*', route => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript(`
        const noop = () => {};
        // Socket.IO stores an ordered array of callbacks per event. A stub
        // that keeps only the LAST registration silently drops earlier ones —
        // which is how the W5 keep-alive connect handler (app.js ~line 894)
        // was hidden behind a later status-bar refresh handler (~line 4156).
        // Preserve real semantics: push into an array, fire all in order.
        window.__socketHandlers = {};
        window.__io = () => ({
            connected: true,
            on: (name, fn) => {
                if (!window.__socketHandlers[name]) {
                    window.__socketHandlers[name] = [];
                }
                window.__socketHandlers[name].push(fn);
            },
            off: noop, once: noop, emit: noop,
            io: { on: noop },
        });
        window.io = window.__io;
        window.socket = window.__io();
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
    // Fire EVERY 'connect' callback in registration order, the way real
    // Socket.IO does. Without this, only the last-registered handler runs and
    // the keep-alive starter is silently skipped.
    await page.evaluate(() => {
        const cbs = window.__socketHandlers && window.__socketHandlers.connect;
        if (Array.isArray(cbs)) {
            cbs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
        }
    });
    await page.waitForTimeout(80);
    return { ctx, page, errors };
}

// ============================================================================
// §1 Single keep-alive timer after load.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(100);

    // Under W5_MUTATION_CASE=A the harness has mutated app.js on disk. Verify
    // the mutated bytes reach the browser through the HTTP server, not just
    // that they exist on disk. This catches any caching or routing gap that
    // would make the mutation invisible to the test.
    if (process.env.W5_MUTATION_CASE === 'A') {
        const diskHas = fs.readFileSync(
            path.join(ROOT, 'static/js/app.js'), 'utf8')
            .includes('/*MUTATION-A*/');
        check('§1diag mutation marker present on disk', diskHas, true);

        const httpBody = await page.evaluate(async () => {
            const r = await fetch('/static/js/app.js', { cache: 'no-store' });
            return r.ok ? await r.text() : '';
        });
        check('§1diag mutation marker served over HTTP (no-store)',
            httpBody.includes('/*MUTATION-A*/'), true);

        // Durable: production registers at least two 'connect' callbacks
        // (keep-alive starter ~line 894, status-bar refresh ~line 4156).
        // The old single-callback stub kept only the last, silently dropping
        // the keep-alive handler. The array-shaped stub preserves both.
        const connCount = await page.evaluate(() =>
            Array.isArray(window.__socketHandlers?.connect)
                ? window.__socketHandlers.connect.length : 0);
        check('§1diag both connect callbacks registered (≥2)', connCount >= 2, true);
    }

    const intervals = await page.evaluate(() => window.__intervalDelays());
    // Production has the keep-alive (60000). Count how many 60s timers exist.
    const sixtyK = intervals.filter(d => d === 60000).length;
    check('§1 exactly one 60s keep-alive timer after load', sixtyK, 1);
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 startLatencyPolling / stopLatencyPolling.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    const before = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2 no 15s latency timer before start', before, 0);

    // Seed one connected session so the poll has something to probe.
    await page.evaluate(() => {
        SessionManager.sessions['P'] = {
            id: 'P', session_id: 'P', host: 'p.example', username: 'u',
            connected: true, isPersistentCandidate: false,
        };
        SessionManager.startLatencyPolling();
    });
    const running = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2 startLatencyPolling creates one 15s timer', running, 1);

    // Idempotent start: a second call must not stack a second timer.
    await page.evaluate(() => SessionManager.startLatencyPolling());
    const stillOne = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2 a second startLatencyPolling does not stack', stillOne, 1);

    await page.evaluate(() => SessionManager.stopLatencyPolling());
    const stopped = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2 stopLatencyPolling clears the timer', stopped, 0);

    // Idempotent stop: no throw, timer count stays 0.
    await page.evaluate(() => SessionManager.stopLatencyPolling());
    const stillZero = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2 repeated stopLatencyPolling stays at zero', stillZero, 0);
    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2b Removing the LAST session stops the latency poll (the W5 wiring).
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    await page.evaluate(() => {
        SessionManager.sessions['S'] = {
            id: 'S', session_id: 'S', host: 's.example', username: 'u',
            connected: true, isPersistentCandidate: false,
            terminalId: 'term-S',
        };
        SessionManager.startLatencyPolling();
    });
    const running = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2b latency poll running with a session present', running, 1);

    // removeSessionUI on the last session must stop the poll.
    await page.evaluate(() => SessionManager.removeSessionUI('S'));
    const afterLastGone = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2b removing the last session stops the latency poll', afterLastGone, 0);
    check('§2b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2c A RELOAD-RESTORED session starts the latency poll too.
//
// The poll had exactly ONE caller: app.js's `ssh_connected` handler. A reload
// delivers `ssh_session_restored` and never `ssh_connected`, so every restored
// session sat at latencyMs === null and its chip showed a bare username, while
// an identical fresh session next to it showed "user · NN ms". Because the poll
// probes ALL connected sessions once running, a restored session only started
// being measured if the user later opened a NEW connection — which made the
// defect look intermittent rather than deterministic.
//
// Asserted on the real restore handler, and asserted as IDEMPOTENT: several
// restored sessions (a reload restores all of them) must still leave exactly
// one 15s timer.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    const before = await page.evaluate(() =>
        window.__intervalDelays().filter(d => d === 15000).length);
    check('§2c no latency timer before any session exists', before, 0);

    // The ONE event a reload delivers. Driven through the production handler.
    await page.evaluate(() => {
        SessionManager.restoreSession({
            session_id: 'R1', host: 'tiny', port: 22, username: 'sshdtest',
            auth_type: 'password', via_jump: null, display_name: null,
            use_tmux: true, tmux_session_name: 'restored-1', key_id: null,
            pane_index: 0, version: 1,
        });
    });
    await page.waitForTimeout(80);

    const afterRestore = await page.evaluate(() => ({
        timers: window.__intervalDelays().filter(d => d === 15000).length,
        exists: !!SessionManager.sessions.R1,
        connected: SessionManager.sessions.R1?.connected === true,
        pollOwner: !!SessionManager.latencyPollTimer,
    }));
    check('§2c a restored session exists and is connected',
        `${afterRestore.exists}|${afterRestore.connected}`, 'true|true');
    check('§2c restoring a session starts the latency poll', afterRestore.timers, 1);
    check('§2c the poll timer handle is owned by SessionManager',
        afterRestore.pollOwner, true);

    // A reload restores EVERY session; the poll must not stack per session.
    await page.evaluate(() => {
        SessionManager.restoreSession({
            session_id: 'R2', host: 'tiny', port: 22, username: 'sshdtest',
            auth_type: 'password', via_jump: null, display_name: null,
            use_tmux: true, tmux_session_name: 'restored-2', key_id: null,
            pane_index: 1, version: 1,
        });
        SessionManager.restoreSession({
            session_id: 'R3', host: 'tiny', port: 22, username: 'sshdtest',
            auth_type: 'password', via_jump: null, display_name: null,
            use_tmux: true, tmux_session_name: 'restored-3', key_id: null,
            pane_index: 2, version: 1,
        });
    });
    await page.waitForTimeout(80);
    check('§2c three restored sessions still leave exactly one 15s timer',
        await page.evaluate(() =>
            window.__intervalDelays().filter(d => d === 15000).length), 1);

    // And the existing teardown owner still wins: removing them all stops it.
    await page.evaluate(() => {
        ['R1', 'R2', 'R3'].forEach(id => SessionManager.removeSessionUI(id));
    });
    check('§2c removing every restored session stops the poll',
        await page.evaluate(() =>
            window.__intervalDelays().filter(d => d === 15000).length), 0);
    check('§2c no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 Disposable registry.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    const result = await page.evaluate(() => {
        const order = [];
        TerminalManager.registerDisposable('R', () => order.push('a'));
        TerminalManager.registerDisposable('R', () => order.push('b'));
        TerminalManager.registerDisposable('R', () => order.push('c'));
        const registered = (TerminalManager.disposables['R'] || []).length;
        TerminalManager.cleanupSessionDisposables('R');
        const drainedOrder = order.join('');
        const keyGone = !('R' in TerminalManager.disposables);
        // A second drain must run nothing.
        TerminalManager.cleanupSessionDisposables('R');
        const afterSecondDrain = order.join('');
        // A disposable that throws must not stop the rest.
        const order2 = [];
        TerminalManager.registerDisposable('R2', () => order2.push('x'));
        TerminalManager.registerDisposable('R2', () => { throw new Error('boom'); });
        TerminalManager.registerDisposable('R2', () => order2.push('y'));
        let threw = false;
        try {
            TerminalManager.cleanupSessionDisposables('R2');
        } catch (e) {
            threw = true;
        }
        return {
            registered, drainedOrder, keyGone, afterSecondDrain,
            throwingRanAll: order2.join('') === 'xy', threw,
        };
    });
    check('§3 three disposables registered', result.registered, 3);
    check('§3 drain runs cleanups in registration order', result.drainedOrder, 'abc');
    check('§3 drain removes the session key', result.keyGone, true);
    check('§3 second drain runs nothing', result.afterSecondDrain, 'abc');
    check('§3 a throwing disposable does not stop the rest',
        result.throwingRanAll, true);
    check('§3 the throw does not escape cleanupSessionDisposables',
        result.threw, false);
    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 destroyTerminal clears replayState mid-replay.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    const result = await page.evaluate(() => {
        // Open a replay window and abandon it mid-flight, the way a user
        // closing the session would.
        TerminalManager.beginReplay('MID', 3);
        TerminalManager.acceptReplayChunk('MID', { seq: 1, total: 3, data: 'x' });
        const openMid = !!TerminalManager.replayState['MID'];
        TerminalManager.destroyTerminal('MID');
        const gone = !('MID' in TerminalManager.replayState);
        // A session that never replayed must not error on destroy either.
        TerminalManager.destroyTerminal('NONE');
        return { openMid, gone };
    });
    check('§4 replay window is open mid-replay', result.openMid, true);
    check('§4 destroyTerminal deletes replayState mid-replay', result.gone, true);
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §5 Session lifecycle resource parity (reload→create→destroy ×3).
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await page.waitForTimeout(60);

    for (let i = 0; i < 3; i++) {
        await page.evaluate((n) => {
            const id = `CYC${n}`;
            SessionManager.sessions[id] = {
                id, session_id: id, host: `${id}.example`, username: 'u',
                connected: true, isPersistentCandidate: false,
                terminalId: `term-${id}`,
            };
            const wrap = document.createElement('div');
            wrap.id = `term-${id}`;
            wrap.className = 'terminal-wrapper unassigned';
            document.getElementById('terminalsContainer').appendChild(wrap);
            SessionManager.createSessionTab(id, `${id}.example`, 'u');
            TerminalManager.registerDisposable(id, () => {});
            SessionManager.removeSessionUI(id);
        }, i);
    }
    const leftover = await page.evaluate(() => {
        const tm = TerminalManager;
        return {
            disposables: Object.keys(tm.disposables).length,
            replay: Object.keys(tm.replayState).length,
            sessionTerminals: Object.keys(tm.sessionTerminals).length,
            transcripts: Object.keys(tm.transcripts).length,
            sessionsLeft: Object.keys(SessionManager.sessions).length,
        };
    });
    check('§5 no disposable keys survive the cycle', leftover.disposables, 0);
    check('§5 no replayState keys survive the cycle', leftover.replay, 0);
    check('§5 no sessionTerminals keys survive the cycle',
        leftover.sessionTerminals, 0);
    check('§5 no transcripts keys survive the cycle', leftover.transcripts, 0);
    check('§5 no sessions survive the cycle', leftover.sessionsLeft, 0);
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
