/*
 * Part G item-6 FORENSICS. Three signals from w5_partG_perf_measure.mjs need a
 * cause before item 6 can be called clean or dirty:
 *
 *   (i)   transcript keys        2 -> 3   across the 5 cycles
 *   (ii)  live setInterval       3 -> 4   across the 5 cycles
 *   (iii) DOM element nodes  3241 -> 3275 (+34) with xterm instances flat at 2
 *
 * Each is measured HERE against the live deployment, in ONE document where
 * possible, and named by identity rather than by count: an orphan is reported
 * with the key that owns it, a timer with the interval that created it, a node
 * with the selector that matches it. Counting alone cannot distinguish a leak
 * from a start-up transient, which is the whole point of this file.
 *
 * No source file is modified. Run: node tests/browser/w5_partG_item6_forensics.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

const LOCK = '/tmp/w5_partG_forensics.lock';
try {
    fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: 'wx' });
} catch (err) {
    if (err.code === 'EEXIST') {
        console.error(`already running (pid ${fs.readFileSync(LOCK, 'utf8').trim()})`);
        process.exit(2);
    }
    throw err;
}
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } });

const BASE = liveConfig().LIVE_BASE;
const creds = liveCreds();
const SSH_HOST = creds.ssh_target || creds.tailnet_host;
const SSH_USER = creds.host_ssh_user;
const SSH_PASS = creds.host_ssh_password;
const PASS = creds.sshdeck_password;
const USER = `${creds.sshdeck_user}f6${Date.now().toString(36)}`;

const out = [];
const say = (label, value, note = '') => {
    out.push({ label, value, note });
    console.log(`  ${label.padEnd(46)} ${String(value).padStart(22)}`
        + `${note ? `  — ${note}` : ''}`);
};
/*
 * Timers are recorded with a STACK, so a surviving interval can be named by the
 * code that created it rather than counted. Same for the DOM: a snapshot of
 * element counts by tag+class lets a +34 node delta be resolved into which
 * elements those are.
 */
const INIT = () => {
    window.__f = { intervals: new Map(), cleared: [] };
    const rsi = window.setInterval.bind(window);
    const rci = window.clearInterval.bind(window);
    window.setInterval = function (fn, ms, ...rest) {
        const id = rsi(fn, ms, ...rest);
        /*
         * Skip this wrapper's OWN frame. The first frame after "Error" is
         * always `window.setInterval` (this function), so reporting it names the
         * probe instead of the code under test -- which is what the first run
         * printed for all four timers.
         */
        const frames = (new Error().stack || '').split('\n')
            .map(s => s.trim())
            .filter(s => s.startsWith('at '))
            .filter(s => !s.includes('window.setInterval'));
        window.__f.intervals.set(id, { ms, frames: frames.slice(0, 4) });
        return id;
    };
    window.clearInterval = function (id) {
        const rec = window.__f.intervals.get(id);
        if (rec) window.__f.cleared.push({ id, ms: rec.ms, frames: rec.frames });
        window.__f.intervals.delete(id);
        return rci(id);
    };
    window.__f.liveIntervals = () => [...window.__f.intervals.entries()]
        .map(([id, r]) => ({ id, ms: r.ms, frames: r.frames }));
    window.__f.domProfile = () => {
        const counts = {};
        for (const el of document.querySelectorAll('*')) {
            const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
            const k = cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
            counts[k] = (counts[k] || 0) + 1;
        }
        return counts;
    };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(INIT);

const appReady = () => page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined' && !!window.socket && window.socket.connected,
null, { timeout: 45000 });
// Guarded with typeof: after reload({waitUntil:'commit'}) the predicate starts
// polling before the bundles have evaluated, and a bare reference throws
// ReferenceError instead of returning false, which aborts the whole run.
const termReady = () => page.waitForFunction(() => {
    if (typeof TerminalManager === 'undefined') return false;
    const keys = Object.keys(TerminalManager.terminalReady || {})
        .filter(k => TerminalManager.terminalReady[k] === true);
    return keys.some(k => {
        const r = TerminalManager.terminals[k]?.element?.getBoundingClientRect();
        return !!r && r.width >= 1 && r.height >= 1;
    });
}, null, { timeout: 45000 });

async function connect() {
    return page.evaluate(async ({ host, user, pass }) => {
        const before = Object.keys(SessionManager.sessions);
        let iv = null; let to = null; let onErr = null;
        const res = await new Promise(resolve => {
            iv = setInterval(() => {
                const fresh = Object.keys(SessionManager.sessions)
                    .find(x => !before.includes(x));
                if (fresh && TerminalManager.terminalReady[fresh]) resolve({ id: fresh });
            }, 20);
            onErr = d => resolve({ error: (d && d.error) || 'ssh_error' });
            window.socket.on('ssh_error', onErr);
            to = setTimeout(() => resolve({ error: 'timeout' }), 35000);
            window.socket.emit('ssh_connect', {
                host, port: 22, username: user, password: pass,
                auth_type: 'password', use_tmux: true,
                client_request_id: `f6_${Date.now().toString(36)}`,
            });
        });
        clearInterval(iv); clearTimeout(to);
        window.socket.off('ssh_error', onErr);
        return res;
    }, { host: SSH_HOST, user: SSH_USER, pass: SSH_PASS });
}

const mapsOf = () => page.evaluate(() => ({
    sessions: Object.keys(SessionManager.sessions),
    terminals: Object.keys(TerminalManager.terminals),
    sessionTerminals: Object.keys(TerminalManager.sessionTerminals),
    transcripts: Object.keys(TerminalManager.transcripts),
    transcriptSizes: Object.keys(TerminalManager.transcriptSizes),
    replayState: Object.keys(TerminalManager.replayState),
    disposables: Object.keys(TerminalManager.disposables),
    resizeObservers: Object.keys(TerminalManager.resizeObservers),
    scrollbarCleanups: Object.keys(TerminalManager.scrollbarCleanups),
    pendingOutput: Object.keys(TerminalManager.pendingOutput),
    scrollState: Object.keys(TerminalManager.scrollStateBySession || {}),
}));
console.log(`\n═══ Part G item-6 forensics — ${BASE} ═══\n`);

// Register and mount two sessions.
await page.goto(`${BASE}/register`, { waitUntil: 'load' });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.locator('#confirm_password').fill(PASS);
await page.locator('#submitBtn').click();
await appReady();
const c1 = await connect();
const c2 = await connect();
if (c1.error || c2.error) {
    console.error(`setup failed: ${c1.error || c2.error}`);
    await browser.close();
    process.exit(1);
}
await page.waitForTimeout(1500);

// ── (ii) TIMERS, named by creating stack ────────────────────────────────────
console.log('(ii) live intervals, named by creation site');
{
    const live = await page.evaluate(() => window.__f.liveIntervals());
    for (const t of live) {
        const site = (t.frames[0] || 'unknown').replace(/^at\s+/, '');
        say(`interval id=${t.id} period=${t.ms}ms`, site.slice(0, 70));
    }
    say('live interval count at rest (2 sessions)', live.length,
        `periods ${live.map(t => `${t.ms}ms`).join(',')}`);
}

// ── (i) TRANSCRIPT KEYS vs SESSIONS, in ONE document ───────────────────────
console.log('\n(i) transcript-key ownership through close + reconnect');
{
    const m0 = await mapsOf();
    say('sessions / transcripts at rest', `${m0.sessions.length} / ${m0.transcripts.length}`,
        m0.transcripts.every(k => m0.sessions.includes(k))
            ? 'every transcript key owned by a live session'
            : `ORPHANS: ${m0.transcripts.filter(k => !m0.sessions.includes(k)).join(',')}`);

    // closeSession is the only path that runs destroyTerminal, which is where
    // delete this.transcripts[sessionId] lives (terminal-manager.js:1245).
    await page.evaluate(id => SessionManager.closeSession(id), m0.sessions[1]);
    await page.waitForTimeout(1500);
    const m1 = await mapsOf();
    const orphans1 = m1.transcripts.filter(k => !m1.sessions.includes(k));
    say('after closeSession: sessions / transcripts',
        `${m1.sessions.length} / ${m1.transcripts.length}`,
        orphans1.length ? `ORPHANS: ${orphans1.join(',')}` : 'no orphan transcript key');

    // Now the path the cycles actually took: a RELOAD, which restores sessions
    // from the server. Any transcript key that outlives its session id here is
    // the +1 seen in the item-6 census.
    await page.reload({ waitUntil: 'commit' });
    await appReady();
    await termReady();
    await page.waitForTimeout(1500);
    const m2 = await mapsOf();
    const orphans2 = m2.transcripts.filter(k => !m2.sessions.includes(k));
    say('after reload: sessions / transcripts',
        `${m2.sessions.length} / ${m2.transcripts.length}`,
        orphans2.length ? `ORPHANS: ${orphans2.join(',')}` : 'no orphan transcript key');

    // Full per-map orphan sweep: any key in a TerminalManager map that no live
    // session owns.
    const sweep = await page.evaluate(() => {
        const live = new Set(Object.keys(SessionManager.sessions));
        const perSession = ['sessionTerminals', 'transcripts', 'transcriptSizes',
            'replayState', 'disposables', 'scrollStateBySession'];
        const bad = {};
        for (const name of perSession) {
            const map = TerminalManager[name] || {};
            const o = Object.keys(map).filter(k => !live.has(k));
            if (o.length) bad[name] = o;
        }
        return bad;
    });
    say('per-session map orphan sweep',
        Object.keys(sweep).length ? 'ORPHANS FOUND' : 'clean',
        Object.keys(sweep).length ? JSON.stringify(sweep) : 'all keys owned by a live session');
}

/*
 * (iv) MECHANISM for the orphan transcript key.
 *
 * destroyTerminal DOES delete transcripts[sessionId] (terminal-manager.js:1245),
 * yet a key belonging to a closed session was still present a moment later. The
 * only writer is appendTranscript, and it creates its own state unconditionally:
 *
 *     appendTranscript(sessionId, data) {
 *         if (!this.transcripts[sessionId]) {
 *             this.transcripts[sessionId] = [];      // <- resurrects the key
 *             this.transcriptSizes[sessionId] = 0;
 *         }
 *
 * and writeOutputNow calls it BEFORE it checks that the session still owns a
 * terminal (terminal-manager.js:818-824). So any ssh_output frame already in
 * flight when the user closes a session re-creates that session's transcript
 * after the teardown has finished. Nothing deletes it afterwards, because
 * deletion only happens in destroyTerminal, which has already run.
 *
 * This block times the sequence exactly: it records every appendTranscript call
 * with the wall clock and whether SessionManager still knew the session, then
 * closes a session and waits.
 */
console.log('\n(iv) mechanism: does a late frame resurrect a deleted transcript key?');
{
    // Make sure two sessions exist again after the (i) block closed one.
    if ((await page.evaluate(() => Object.keys(SessionManager.sessions).length)) < 2) {
        const add = await connect();
        if (add.error) say('setup for (iv)', `connect failed: ${add.error}`);
        await page.waitForTimeout(1200);
    }

    await page.evaluate(() => {
        window.__t = { calls: [], destroyed: [] };
        const realAppend = TerminalManager.appendTranscript.bind(TerminalManager);
        TerminalManager.appendTranscript = function (sessionId, data) {
            window.__t.calls.push({
                t: Date.now(),
                sessionId,
                len: (data || '').length,
                sessionLive: Object.prototype.hasOwnProperty
                    .call(SessionManager.sessions, sessionId),
                keyExisted: Object.prototype.hasOwnProperty
                    .call(TerminalManager.transcripts, sessionId),
            });
            return realAppend(sessionId, data);
        };
        const realDestroy = TerminalManager.destroyTerminal.bind(TerminalManager);
        TerminalManager.destroyTerminal = function (sessionId) {
            window.__t.destroyed.push({ t: Date.now(), sessionId });
            return realDestroy(sessionId);
        };
    });

    // Generate output, then close the session while frames are still in flight.
    const victim = await page.evaluate(() => Object.keys(SessionManager.sessions)
        .find(id => SessionManager.sessions[id].connected));
    await page.evaluate(id => SessionManager.switchSession(id), victim);
    await page.waitForTimeout(500);
    await page.evaluate(id => {
        const t = TerminalManager.terminals[id];
        if (t) t.focus();
    }, victim);
    await page.keyboard.type('seq 1 4000');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    await page.evaluate(id => SessionManager.closeSession(id), victim);
    await page.waitForTimeout(4000);

    const ev = await page.evaluate(v => {
        const d = window.__t.destroyed.find(x => x.sessionId === v);
        const after = window.__t.calls.filter(c => c.sessionId === v && d && c.t >= d.t);
        return {
            destroyedAt: d ? d.t : null,
            totalCalls: window.__t.calls.filter(c => c.sessionId === v).length,
            callsAfterDestroy: after.length,
            firstAfter: after[0] || null,
            keyPresentNow: Object.prototype.hasOwnProperty
                .call(TerminalManager.transcripts, v),
            sizePresentNow: Object.prototype.hasOwnProperty
                .call(TerminalManager.transcriptSizes, v),
            bytesHeld: (TerminalManager.transcripts[v] || [])
                .reduce((n, s) => n + s.length, 0),
            sessionLive: Object.prototype.hasOwnProperty.call(SessionManager.sessions, v),
        };
    }, victim);
    say('appendTranscript calls for the closed session', ev.totalCalls,
        `${ev.callsAfterDestroy} of them arrived AFTER destroyTerminal`);
    say('transcript key present after teardown',
        ev.keyPresentNow ? 'YES — RESURRECTED' : 'no',
        `transcriptSizes ${ev.sizePresentNow ? 'also present' : 'absent'}; session live: `
        + `${ev.sessionLive}; bytes held ${ev.bytesHeld}`);
    if (ev.firstAfter) {
        say('first post-teardown write', `${ev.firstAfter.len} bytes`,
            `sessionLive=${ev.firstAfter.sessionLive} keyExisted=`
            + `${ev.firstAfter.keyExisted} (keyExisted=false proves it was re-created)`);
    }
}
/*
 * (vi) DECISIVE TRIAL for the orphan transcript key.
 *
 * Block (i) saw an orphan immediately after closeSession; block (iv) did not.
 * Two blocks disagreeing is not a finding, so this repeats the close under
 * controlled conditions and samples the key on a timeline, with destroyTerminal
 * itself instrumented to record whether the delete actually ran.
 *
 * The two candidate causes produce different signatures:
 *   - delete never ran            -> presentBefore=true, deletedByDestroy=false
 *   - a late frame re-created it  -> deletedByDestroy=true, then present again
 *                                    at a later sample, with an appendTranscript
 *                                    call in between
 */
console.log('\n(vi) decisive trial: orphan transcript key, idle vs output-in-flight');
{
    await page.evaluate(() => {
        window.__d = { trials: [] };
        const realDestroy = TerminalManager.destroyTerminal.bind(TerminalManager);
        TerminalManager.destroyTerminal = function (sessionId) {
            const presentBefore = Object.prototype.hasOwnProperty
                .call(TerminalManager.transcripts, sessionId);
            const r = realDestroy(sessionId);
            const presentAfter = Object.prototype.hasOwnProperty
                .call(TerminalManager.transcripts, sessionId);
            window.__d.lastDestroy = {
                sessionId, presentBefore, presentAfter, t: Date.now(),
            };
            return r;
        };
        const realAppend = TerminalManager.appendTranscript.bind(TerminalManager);
        TerminalManager.appendTranscript = function (sessionId, data) {
            window.__d.appends = window.__d.appends || [];
            window.__d.appends.push({
                t: Date.now(),
                sessionId,
                created: !Object.prototype.hasOwnProperty
                    .call(TerminalManager.transcripts, sessionId),
                sessionLive: Object.prototype.hasOwnProperty
                    .call(SessionManager.sessions, sessionId),
            });
            return realAppend(sessionId, data);
        };
    });

    const trial = async withOutput => {
        // Ensure two sessions so one can be closed.
        while ((await page.evaluate(() =>
            Object.keys(SessionManager.sessions).length)) < 2) {
            const add = await connect();
            if (add.error) return { error: add.error };
            await page.waitForTimeout(1000);
        }
        const victim = await page.evaluate(() => Object.keys(SessionManager.sessions)
            .find(id => SessionManager.sessions[id].connected
                && TerminalManager.terminalReady[id]));
        if (!victim) return { error: 'no ready session' };
        await page.evaluate(() => { window.__d.appends = []; });
        if (withOutput) {
            await page.evaluate(id => SessionManager.switchSession(id), victim);
            await page.waitForTimeout(400);
            await page.evaluate(id => TerminalManager.terminals[id]?.focus(), victim);
            await page.keyboard.type('seq 1 20000');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(150);
        }
        await page.evaluate(id => SessionManager.closeSession(id), victim);
        const timeline = [];
        for (const wait of [0, 200, 800, 3000]) {
            if (wait) await page.waitForTimeout(wait);
            timeline.push(await page.evaluate(id => ({
                present: Object.prototype.hasOwnProperty
                    .call(TerminalManager.transcripts, id),
                sizes: Object.prototype.hasOwnProperty
                    .call(TerminalManager.transcriptSizes, id),
            }), victim));
        }
        const d = await page.evaluate(id => ({
            destroy: window.__d.lastDestroy,
            appendsAfterDestroy: (window.__d.appends || []).filter(a =>
                a.sessionId === id && window.__d.lastDestroy
                && a.t >= window.__d.lastDestroy.t),
        }), victim);
        return { victim, timeline, destroy: d.destroy, after: d.appendsAfterDestroy };
    };

    for (const mode of [false, true, true]) {
        const r = await trial(mode);
        const tag = mode ? 'output in flight' : 'idle';
        if (r.error) { say(`trial (${tag})`, `skipped: ${r.error}`); continue; }
        const marks = r.timeline.map((x, i) =>
            `${[0, 200, 1000, 4000][i]}ms:${x.present ? 'PRESENT' : 'gone'}`).join(' ');
        say(`trial (${tag}): key on timeline`, r.timeline.some(x => x.present)
            ? 'ORPHAN SEEN' : 'clean', marks);
        say(`trial (${tag}): destroyTerminal delete`,
            r.destroy ? `${r.destroy.presentBefore} -> ${r.destroy.presentAfter}`
                : 'destroy not observed',
            `${r.after.length} appendTranscript call(s) after destroy`
            + `${r.after.length ? ` (first created=${r.after[0].created}, `
                + `sessionLive=${r.after[0].sessionLive})` : ''}`);
        await page.waitForTimeout(7000);
    }
}

/*
 * (v) the 500 ms scrollbar interval and the "+1 timer".
 *
 * setupScrollbar creates ONE setInterval(updateScrollbar, 500) per terminal key
 * (terminal-manager.js:1309) and stores its clearInterval in
 * scrollbarCleanups[terminalKey], which destroyTerminalKey invokes. Two
 * terminals therefore mean two 500 ms timers, plus the 60 s keep-alive and the
 * 15 s latency poll -- exactly the four seen above. The census's "3 -> 4" is
 * then a question of how many terminals were mounted at each sample, not of a
 * timer that failed to clear. Measured here by identity.
 */
console.log('\n(v) timer ownership across a close+connect pair');
{
    const t0 = await page.evaluate(() => window.__f.liveIntervals()
        .map(x => ({ id: x.id, ms: x.ms })));
    const terms0 = await page.evaluate(() =>
        Object.keys(TerminalManager.terminals).length);
    say('timers / terminals before churn', `${t0.length} / ${terms0}`,
        `periods ${t0.map(x => `${x.ms}ms`).join(',')}`);

    const ids = await page.evaluate(() => Object.keys(SessionManager.sessions));
    if (ids.length) {
        await page.evaluate(id => SessionManager.closeSession(id), ids[0]);
        await page.waitForTimeout(1800);
        const t1 = await page.evaluate(() => window.__f.liveIntervals()
            .map(x => ({ id: x.id, ms: x.ms })));
        const terms1 = await page.evaluate(() =>
            Object.keys(TerminalManager.terminals).length);
        const gone = t0.filter(a => !t1.some(b => b.id === a.id));
        say('timers / terminals after ONE close', `${t1.length} / ${terms1}`,
            `cleared ${gone.map(g => `id=${g.id}(${g.ms}ms)`).join(',') || 'none'}`);

        const add = await connect();
        if (!add.error) {
            await page.waitForTimeout(1500);
            const t2 = await page.evaluate(() => window.__f.liveIntervals()
                .map(x => ({ id: x.id, ms: x.ms })));
            const terms2 = await page.evaluate(() =>
                Object.keys(TerminalManager.terminals).length);
            const added = t2.filter(a => !t1.some(b => b.id === a.id));
            say('timers / terminals after re-connect', `${t2.length} / ${terms2}`,
                `added ${added.map(g => `id=${g.id}(${g.ms}ms)`).join(',') || 'none'}; `
                + `${t2.length === t0.length ? 'RETURNED TO BASELINE'
                    : `NET ${t2.length - t0.length} vs baseline`}`);
        } else {
            say('re-connect for (v)', `failed: ${add.error}`);
        }
    }
}

// ── (iii) DOM node growth, resolved to the elements involved ────────────────
console.log('\n(iii) DOM node growth across repeated close+connect in ONE document');
{
    const profile0 = await page.evaluate(() => window.__f.domProfile());
    const total0 = await page.evaluate(() => document.querySelectorAll('*').length);
    const series = [total0];
    let reps = 0;
    for (let r = 0; r < 3; r++) {
        const ids = await page.evaluate(() => Object.keys(SessionManager.sessions));
        if (ids.length < 2) {
            // Keep two sessions available for the churn.
            const add = await connect();
            if (add.error) { say(`rep ${r + 1}: connect failed`, add.error); break; }
            await page.waitForTimeout(800);
        }
        const cur = await page.evaluate(() => Object.keys(SessionManager.sessions));
        if (cur.length < 2) break;
        await page.evaluate(id => SessionManager.closeSession(id), cur[1]);
        await page.waitForTimeout(1500);
        const again = await connect();
        if (again.error) { say(`rep ${r + 1}: reconnect failed`, again.error); break; }
        await page.waitForTimeout(1200);
        series.push(await page.evaluate(() => document.querySelectorAll('*').length));
        reps += 1;
        // Pace against the 10-per-minute ssh_connect bucket.
        await page.waitForTimeout(7000);
    }
    const profile1 = await page.evaluate(() => window.__f.domProfile());
    const perRep = [];
    for (let i = 1; i < series.length; i++) perRep.push(series[i] - series[i - 1]);
    say('DOM element total per repetition', series.join(' -> '),
        `${reps} close+connect reps; per-rep `
        + `${perRep.map(d => (d >= 0 ? `+${d}` : `${d}`)).join(',') || 'n/a'}`);

    const moved = [];
    for (const k of new Set([...Object.keys(profile0), ...Object.keys(profile1)])) {
        const d = (profile1[k] || 0) - (profile0[k] || 0);
        if (d !== 0) moved.push({ k, d });
    }
    moved.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    say('which elements moved', moved.length ? `${moved.length} selectors` : 'none',
        moved.slice(0, 10).map(m => `${m.k} ${m.d >= 0 ? '+' : ''}${m.d}`).join(', ')
            || 'no element-type change');

    // Notifications are the usual explanation for a small transient delta: the
    // container accumulates children and self-empties on a timer, so a census
    // taken while one is on screen counts nodes that are about to disappear.
    const notif = await page.evaluate(() => {
        const el = document.getElementById('notificationContainer');
        return { children: el ? el.children.length : -1 };
    });
    say('notificationContainer children right now', notif.children,
        'self-clearing; a census taken mid-toast counts transient nodes');
    await page.waitForTimeout(9000);
    const settled = await page.evaluate(() => ({
        total: document.querySelectorAll('*').length,
        notif: (document.getElementById('notificationContainer') || {}).children?.length ?? -1,
    }));
    say('DOM element total after toasts expire', settled.total,
        `notificationContainer children now ${settled.notif}; `
        + `net vs start ${settled.total - total0 >= 0 ? '+' : ''}${settled.total - total0}`);
}

// ── detached nodes and heap, same document, after everything above ──────────
{
    const cdp = await ctx.newCDPSession(page);
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
            const byTag = {}; let detached = 0; let total = 0; let skipped = 0;
            for (let i = 0; i < this.length; i++) {
                let c; let tag; let cls;
                try {
                    c = this[i].isConnected;
                    tag = this[i].tagName.toLowerCase();
                    cls = (this[i].getAttribute('class') || '').split(' ')[0];
                } catch (e) { skipped += 1; continue; }
                total += 1;
                if (c === false) {
                    detached += 1;
                    const k = cls ? tag + '.' + cls : tag;
                    byTag[k] = (byTag[k] || 0) + 1;
                }
            }
            return { detached, total, skipped, byTag };
        }`,
    });
    const v = counted.result?.value;
    say('heap after forced GC', `${(usedSize / 1048576).toFixed(1)} MB`,
        'same document as every measurement above');
    say('detached HTMLElements', v ? v.detached : 'unavailable',
        v ? `of ${v.total} reachable (${v.skipped} skipped)`
            + `${v.detached ? `; by type ${JSON.stringify(v.byTag)}` : ''}`
            : 'queryObjects returned no value');
    await cdp.detach().catch(() => {});
}

// Leave nothing running on the host.
{
    const ids = await page.evaluate(() => Object.keys(SessionManager.sessions));
    for (const id of ids) {
        await page.evaluate(i => SessionManager.closeSession(i), id).catch(() => {});
        await page.waitForTimeout(400);
    }
    say('sessions closed on exit', ids.length, 'kill_tmux via ssh_disconnect');
}

await browser.close();
fs.writeFileSync('/tmp/partG-item6-forensics.json', JSON.stringify(out, null, 1));
console.log(`\nwrote /tmp/partG-item6-forensics.json (${out.length} rows)`);
process.exit(0);
