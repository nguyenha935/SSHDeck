#!/usr/bin/env node
/*
 * Part G item-6 follow-up — transcript-key OWNERSHIP.
 *
 * The forensics probe (w5_partG_item6_forensics.mjs) proved one real
 * application leak behind the "+1 transcript key per reload cycle" signal:
 * destroyTerminal deletes transcripts[sessionId], and then a LATE ssh_output
 * frame for that dead session re-creates the key, because writeOutputNow
 * called appendTranscript BEFORE its own "no terminal for this session"
 * early return, and appendTranscript creates state unconditionally. The
 * resurrected key is never freed again for the document's lifetime and can
 * grow to maxTranscriptSize (200 000 chars) per closed session.
 *
 * This suite is both the PREREQUISITE PROOF for the fix and the regression
 * that pins it:
 *
 *  §1 Ordering: in a REAL restore (ssh_session_restored -> ssh_replay_chunk),
 *     terminal ownership (sessionTerminals[sessionId]) is established by
 *     createTerminal BEFORE any writeOutputNow can run, so a guard that skips
 *     transcript bookkeeping for a session with no terminal keys can never
 *     see legitimate restore output.
 *  §2 No loss: every replay byte reaches the transcript, whether the chunk
 *     arrives before or after terminalReady, on both replay shapes
 *     (sequenced chunks and an inline buffered_output blob).
 *  §3 The race: a late ssh_output arriving AFTER destroyTerminal must not
 *     resurrect transcripts / transcriptSizes.
 *  §4 Repeated close/reconnect cycles leave transcript keys at baseline.
 *  §5 Controls: a live session still records, and the no-terminal path still
 *     reports the error it always reported.
 *
 * Runs the REAL production files (real xterm, real TerminalManager, real
 * SessionManager restore path) served over HTTP; only socket.io transport is
 * stubbed, preserving its ordered multi-handler semantics.
 *
 * Run: node tests/browser/w5_partG_transcript_ownership.mjs   (from source/)
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
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
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
    '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon',
};

// The real template, with Jinja stripped the same way the other W5 suites do.
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
/*
 * Socket.IO stub. Two properties of the real client matter here and are
 * preserved: handlers per event are an ORDERED ARRAY (all of them fire, in
 * registration order), and emit() is observable so the test can see the
 * ssh_disconnect that closeSession sends. Everything else in the page is the
 * real production file.
 */
const SOCKET_STUB = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.__emitted = [];
    window.__io = () => ({
        connected: true,
        on: (name, fn) => {
            if (!window.__socketHandlers[name]) window.__socketHandlers[name] = [];
            window.__socketHandlers[name].push(fn);
        },
        off: noop, once: noop,
        emit: (name, payload) => {
            window.__emitted.push({ name, payload });
            /*
             * S28 -- ANSWER EVERY SIZE PROPOSAL, as the real server does.
             *
             * handle_ssh_resize replies with a pty_geometry convergence frame to
             * EVERY proposal, absorbed ones included (socket_events.py). A stub
             * that stays silent leaves the client's geometry hold armed
             * (terminal-manager.js: geometryHold) -- the S28 gate that stops a
             * full-window tmux repaint reaching an engine that has not adopted
             * the new row count yet (11 rows of artificial scrollback per early
             * paint, /tmp/s26reg/diag20_s27.out). Live ssh_output frames then sit
             * held and the engine renders nothing, which is what these rows
             * caught. The assertions were right; the stub was incomplete.
             *
             * Echoing the proposal back is the honest reply for a single-client
             * session: the server resolves one visible client to its own fit
             * (rule 1, ssh_manager._resolve_authority), so this names the same
             * grid a real server would, and resizes nothing.
             */
            if (name === 'ssh_resize' && payload
                && payload.cols && payload.rows) {
                (window.__socketHandlers['pty_geometry'] || []).forEach(
                    (cb) => cb({
                        session_id: payload.session_id,
                        cols: payload.cols, rows: payload.rows, applied: true,
                    }));
            }
        },
        io: { on: noop },
    });
    window.io = window.__io;
    window.socket = window.__io();
    // Fire every handler for an event, in registration order — this is the
    // server speaking to the page.
    window.__server = (name, payload) => {
        const cbs = window.__socketHandlers[name] || [];
        cbs.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
        return cbs.length;
    };
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
        getLanguages: () => [], getLanguage: () => 'en', setLanguage: noop,
        updatePageText: noop,
    };
`;

/*
 * The ORDERING RECORDER (§1). Pure observation: it wraps three TerminalManager
 * methods to log a timeline, then calls straight through. It records, at the
 * instant of each writeOutputNow, whether ownership already exists — which is
 * the fact the fix depends on.
 */
const RECORDER = `
    window.__installRecorder = () => {
        const TM = window.TerminalManager;
        if (!TM || TM.__recorderInstalled) return false;
        TM.__recorderInstalled = true;
        window.__timeline = [];
        const origCreate = TM.createTerminal.bind(TM);
        const origAttach = TM.attachTerminal.bind(TM);
        const origWrite = TM.writeOutputNow.bind(TM);
        const origAppend = TM.appendTranscript.bind(TM);
        const origDestroy = TM.destroyTerminal.bind(TM);
        TM.createTerminal = (sessionId, key) => {
            const r = origCreate(sessionId, key);
            window.__timeline.push({
                op: 'createTerminal', sessionId,
                owns: ((TM.sessionTerminals[sessionId] || []).length > 0),
            });
            return r;
        };
        TM.attachTerminal = (sessionId, containerId, key) => {
            window.__timeline.push({ op: 'attachTerminal', sessionId });
            return origAttach(sessionId, containerId, key);
        };
        TM.writeOutputNow = (sessionId, data) => {
            window.__timeline.push({
                op: 'writeOutputNow', sessionId,
                bytes: (data || '').length,
                owns: ((TM.sessionTerminals[sessionId] || []).length > 0),
                keyed: !!TM.transcripts[sessionId],
            });
            return origWrite(sessionId, data);
        };
        TM.appendTranscript = (sessionId, data) => {
            window.__timeline.push({
                op: 'appendTranscript', sessionId,
                created: !TM.transcripts[sessionId],
                owns: ((TM.sessionTerminals[sessionId] || []).length > 0),
            });
            return origAppend(sessionId, data);
        };
        TM.destroyTerminal = (sessionId) => {
            window.__timeline.push({ op: 'destroyTerminal', sessionId });
            return origDestroy(sessionId);
        };
        return true;
    };
`;
async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
        if (m.type() === 'error') consoleErrors.push(m.text());
    });
    // Block the real vendor socket.io so it cannot overwrite the stub io().
    await page.route('**/socket.io.min.js*', route => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.addInitScript(SOCKET_STUB);
    await page.addInitScript(RECORDER);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // Real Socket.IO fires every 'connect' callback in order.
    await page.evaluate(() => window.__server('connect', {}));
    await page.waitForTimeout(80);
    const installed = await page.evaluate(() => window.__installRecorder());
    check('harness installed the ordering recorder', installed, true);
    check('harness loaded the real TerminalManager',
        await page.evaluate(() => typeof window.TerminalManager === 'object'), true);
    check('harness loaded the real SessionManager restore handler',
        await page.evaluate(() =>
            (window.__socketHandlers.ssh_session_restored || []).length >= 1), true);
    return { ctx, page, errors, consoleErrors };
}

// Deliver a server restore for `sid`: the snapshot, then the replay chunks,
// exactly as restore_user_sessions emits them (socket_events.py:332-362).
async function serverRestore(page, sid, chunks, opts = {}) {
    await page.evaluate(({ sid, chunks, opts }) => {
        const snapshot = {
            session_id: sid, host: `${sid}.example`, port: 22, username: 'u',
            auth_type: 'password', via_jump: null, display_name: null,
            use_tmux: true, tmux_session_name: `t-${sid}`, key_id: null,
            pane_index: 0,
        };
        if (opts.inline) {
            snapshot.buffered_output = chunks.join('');
        } else {
            snapshot.replay_total_chunks = chunks.length;
            snapshot.replay_truncated = false;
            snapshot.replay_dropped_bytes = 0;
        }
        window.__server('ssh_session_restored', snapshot);
        if (opts.inline) return;
        if (!chunks.length) {
            window.__server('ssh_replay_chunk', {
                session_id: sid, seq: 0, total: 0, data: '',
                final: true, truncated: false, dropped_bytes: 0,
            });
            return;
        }
        chunks.forEach((data, i) => {
            window.__server('ssh_replay_chunk', {
                session_id: sid, seq: i + 1, total: chunks.length, data,
                final: i + 1 === chunks.length, truncated: false, dropped_bytes: 0,
            });
        });
    }, { sid, chunks, opts });
}

// Wait until every terminal key for the session reports ready (attachTerminal
// finishes inside a nested rAF + 50ms timeout).
async function awaitReady(page, sid) {
    await page.waitForFunction((s) => {
        const keys = window.TerminalManager.sessionTerminals[s] || [];
        return keys.length > 0 && keys.every(k => window.TerminalManager.terminalReady[k]);
    }, sid, { timeout: 8000 });
}

const transcriptState = (page, sid) => page.evaluate((s) => ({
    hasKey: Object.prototype.hasOwnProperty.call(window.TerminalManager.transcripts, s),
    hasSize: Object.prototype.hasOwnProperty.call(window.TerminalManager.transcriptSizes, s),
    text: window.TerminalManager.getTranscript(s),
    size: window.TerminalManager.transcriptSizes[s],
    keyCount: Object.keys(window.TerminalManager.transcripts).length,
    sizeCount: Object.keys(window.TerminalManager.transcriptSizes).length,
}), sid);
// ============================================================================
// §1 ORDERING PROOF — createTerminal establishes ownership before any
//     writeOutputNow can run, on the REAL restore path.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();
    const sid = 'own-1';
    const chunks = ['HIST-A\r\n', 'HIST-B\r\n', 'HIST-C\r\n'];
    await serverRestore(page, sid, chunks);

    const tl = await page.evaluate((s) =>
        window.__timeline.filter(e => e.sessionId === s), sid);

    const ops = tl.map(e => e.op);
    check('§1 restore ran createTerminal', ops.includes('createTerminal'), true);
    check('§1 restore ran writeOutputNow for the replay',
        ops.filter(o => o === 'writeOutputNow').length, 3);

    const firstCreate = ops.indexOf('createTerminal');
    const firstAttach = ops.indexOf('attachTerminal');
    const firstWrite = ops.indexOf('writeOutputNow');
    check('§1 createTerminal precedes the first writeOutputNow',
        firstCreate >= 0 && firstCreate < firstWrite, true);
    check('§1 attachTerminal precedes the first writeOutputNow',
        firstAttach >= 0 && firstAttach < firstWrite, true);
    check('§1 createTerminal already owns a terminal key when it returns',
        tl.filter(e => e.op === 'createTerminal').every(e => e.owns === true), true);
    check('§1 EVERY writeOutputNow during restore sees ownership',
        tl.filter(e => e.op === 'writeOutputNow').every(e => e.owns === true), true);
    check('§1 EVERY appendTranscript during restore sees ownership',
        tl.filter(e => e.op === 'appendTranscript').every(e => e.owns === true), true);
    // attachTerminal (terminal-manager.js:351) seeds the transcript key, so the
    // replay never has to create it — the key already exists at the first write.
    check('§1 the transcript key exists before the first replay write',
        tl.filter(e => e.op === 'writeOutputNow').every(e => e.keyed === true), true);
    check('§1 no appendTranscript during restore had to create the key',
        tl.filter(e => e.op === 'appendTranscript').every(e => e.created === false), true);
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 NO-LOSS PROOF — every replay byte reaches the transcript, for chunks that
//     arrive before terminalReady, chunks that arrive after it, and the inline
//     buffered_output shape. This is what makes "skip bookkeeping when the
//     session owns no terminal" safe.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();

    // (a) sequenced chunks, all delivered pre-ready (the production timing:
    //     restore_user_sessions emits them immediately after the snapshot).
    const a = 'pre-ready';
    const chunksA = ['A1-\r\n', 'A2-\r\n', 'A3-\r\n', 'A4-tail\r\n'];
    await serverRestore(page, a, chunksA);
    let st = await transcriptState(page, a);
    check('§2a transcript holds every pre-ready replay byte', st.text, chunksA.join(''));
    check('§2a transcriptSizes agrees with the bytes held',
        st.size, chunksA.join('').length);
    await awaitReady(page, a);
    st = await transcriptState(page, a);
    check('§2a nothing is dropped once the terminal turns ready',
        st.text, chunksA.join(''));

    // (b) sequenced chunks that arrive AFTER the terminal is ready (a slow
    //     server, or a large replay still streaming).
    const b = 'post-ready';
    await serverRestore(page, b, []);          // snapshot + empty terminator
    await awaitReady(page, b);
    await page.evaluate((s) => {
        window.TerminalManager.beginReplay(s, 2);
        window.__server('ssh_replay_chunk', {
            session_id: s, seq: 1, total: 2, data: 'B1-\r\n',
            final: false, truncated: false, dropped_bytes: 0,
        });
        window.__server('ssh_replay_chunk', {
            session_id: s, seq: 2, total: 2, data: 'B2-\r\n',
            final: true, truncated: false, dropped_bytes: 0,
        });
    }, b);
    st = await transcriptState(page, b);
    check('§2b transcript holds every post-ready replay byte',
        st.text, 'B1-\r\nB2-\r\n');

    // (c) the inline buffered_output shape (older server payload) routes through
    //     queueReplay -> acceptReplayChunk -> writeOutputNow.
    const c = 'inline-blob';
    await serverRestore(page, c, ['INLINE-1\r\n', 'INLINE-2\r\n'], { inline: true });
    st = await transcriptState(page, c);
    check('§2c transcript holds the whole inline buffered_output',
        st.text, 'INLINE-1\r\nINLINE-2\r\n');

    // (d) live output arriving mid-replay is queued and still recorded once.
    const d = 'live-mid-replay';
    await page.evaluate((s) => {
        const snapshot = {
            session_id: s, host: `${s}.example`, port: 22, username: 'u',
            auth_type: 'password', use_tmux: false, tmux_session_name: null,
            key_id: null, pane_index: 0, replay_total_chunks: 2,
            replay_truncated: false, replay_dropped_bytes: 0,
        };
        window.__server('ssh_session_restored', snapshot);
        window.__server('ssh_replay_chunk', {
            session_id: s, seq: 1, total: 2, data: 'D-HIST1\r\n',
            final: false, truncated: false, dropped_bytes: 0,
        });
        window.__server('ssh_output', { session_id: s, data: 'D-LIVE\r\n' });
        window.__server('ssh_replay_chunk', {
            session_id: s, seq: 2, total: 2, data: 'D-HIST2\r\n',
            final: true, truncated: false, dropped_bytes: 0,
        });
    }, d);
    st = await transcriptState(page, d);
    check('§2d history precedes queued live output, each recorded once',
        st.text, 'D-HIST1\r\nD-HIST2\r\nD-LIVE\r\n');
    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}
// ============================================================================
// §3 THE RACE — a late ssh_output for a session that was already destroyed
//     must not resurrect transcripts / transcriptSizes.
//
//     This is the defect the forensics probe caught live: destroyTerminal
//     deletes the key, then one straggler frame re-creates it, and nothing
//     ever deletes it again.
// ============================================================================
{
    const { ctx, page, errors, consoleErrors } = await newPage();
    const sid = 'race-late-output';
    await serverRestore(page, sid, ['SEED\r\n']);
    await awaitReady(page, sid);

    let st = await transcriptState(page, sid);
    check('§3 the live session has a transcript key', st.hasKey, true);
    check('§3 the live session recorded its replay', st.text, 'SEED\r\n');

    // Close it the way the user does: SessionManager.closeSession emits
    // ssh_disconnect and tears the UI down through destroyTerminal.
    const emitted = await page.evaluate((s) => {
        SessionManager.closeSession(s);
        return window.__emitted.filter(e => e.name === 'ssh_disconnect'
            && e.payload && e.payload.session_id === s).length;
    }, sid);
    check('§3 closeSession emitted ssh_disconnect once', emitted, 1);

    st = await transcriptState(page, sid);
    check('§3 destroyTerminal removed transcripts[sessionId]', st.hasKey, false);
    check('§3 destroyTerminal removed transcriptSizes[sessionId]', st.hasSize, false);
    check('§3 ownership is gone after destroy',
        await page.evaluate((s) =>
            Object.prototype.hasOwnProperty.call(
                window.TerminalManager.sessionTerminals, s), sid), false);

    // THE LATE FRAME. Exactly what app.js:997 does when a straggler arrives.
    await page.evaluate((s) => {
        window.__server('ssh_output', { session_id: s, data: 'LATE-STRAGGLER\r\n' });
    }, sid);

    st = await transcriptState(page, sid);
    check('§3 a late ssh_output does NOT resurrect transcripts', st.hasKey, false);
    check('§3 a late ssh_output does NOT resurrect transcriptSizes', st.hasSize, false);
    check('§3 no bytes were accumulated for the dead session', st.text, '');

    // Several stragglers, and a burst, must all be refused — and the key must
    // still be absent after the microtask/timeout turns the app uses.
    await page.evaluate((s) => {
        for (let i = 0; i < 25; i++) {
            window.__server('ssh_output', { session_id: s, data: `BURST-${i}\r\n` });
        }
    }, sid);
    await page.waitForTimeout(300);
    st = await transcriptState(page, sid);
    check('§3 a burst of late frames still cannot create the key', st.hasKey, false);
    check('§3 a burst of late frames still cannot create the size counter',
        st.hasSize, false);

    // A late frame for a session id the page has NEVER seen must not create
    // state either (the same guard covers it).
    await page.evaluate(() => {
        window.__server('ssh_output', { session_id: 'never-existed', data: 'X' });
    });
    check('§3 an unknown session id creates no transcript key',
        await page.evaluate(() =>
            Object.prototype.hasOwnProperty.call(
                window.TerminalManager.transcripts, 'never-existed')), false);

    // The refusal must stay LOUD, not silent: writeOutputNow has always logged
    // "Terminal not found for writeOutput". That diagnostic is part of the
    // contract, so the fix must not swallow it.
    check('§3 the no-terminal write is still reported to the console',
        consoleErrors.some(t => t.includes('Terminal not found for writeOutput')), true);
    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 REPEATED CLOSE / RECONNECT CYCLES — transcript keys return to baseline.
//
//     The leak was one orphan key PER closed session, so it only shows as
//     growth across cycles. Each cycle restores a session, writes to it,
//     closes it, and lets a straggler frame arrive afterwards.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();

    const baseline = await page.evaluate(() => ({
        transcripts: Object.keys(window.TerminalManager.transcripts).length,
        sizes: Object.keys(window.TerminalManager.transcriptSizes).length,
        sessionTerminals: Object.keys(window.TerminalManager.sessionTerminals).length,
        replay: Object.keys(window.TerminalManager.replayState).length,
        sessions: Object.keys(SessionManager.sessions).length,
    }));
    check('§4 baseline has no transcript keys', baseline.transcripts, 0);

    const series = [];
    for (let i = 0; i < 5; i++) {
        const sid = `cycle-${i}`;
        await serverRestore(page, sid, [`C${i}-HIST\r\n`]);
        await awaitReady(page, sid);
        await page.evaluate((s) => {
            window.__server('ssh_output', { session_id: s, data: 'C-LIVE\r\n' });
        }, sid);
        const live = await transcriptState(page, sid);
        if (live.text !== `C${i}-HIST\r\nC-LIVE\r\n`) {
            check(`§4 cycle ${i} recorded its own output`, live.text,
                `C${i}-HIST\r\nC-LIVE\r\n`);
        }
        await page.evaluate((s) => SessionManager.closeSession(s), sid);
        // Stragglers after teardown — the leak's trigger.
        await page.evaluate((s) => {
            window.__server('ssh_output', { session_id: s, data: 'STRAGGLER-1\r\n' });
            window.__server('ssh_output', { session_id: s, data: 'STRAGGLER-2\r\n' });
        }, sid);
        await page.waitForTimeout(120);
        series.push(await page.evaluate(() =>
            Object.keys(window.TerminalManager.transcripts).length));
    }
    check('§4 transcript key count after each of 5 cycles',
        series.join(','), '0,0,0,0,0');

    const after = await page.evaluate(() => ({
        transcripts: Object.keys(window.TerminalManager.transcripts).length,
        sizes: Object.keys(window.TerminalManager.transcriptSizes).length,
        sessionTerminals: Object.keys(window.TerminalManager.sessionTerminals).length,
        replay: Object.keys(window.TerminalManager.replayState).length,
        sessions: Object.keys(SessionManager.sessions).length,
        disposables: Object.keys(window.TerminalManager.disposables).length,
        pending: Object.keys(window.TerminalManager.pendingOutput).length,
        ready: Object.keys(window.TerminalManager.terminalReady).length,
    }));
    check('§4 transcripts back to baseline', after.transcripts, baseline.transcripts);
    check('§4 transcriptSizes back to baseline', after.sizes, baseline.sizes);
    check('§4 sessionTerminals back to baseline',
        after.sessionTerminals, baseline.sessionTerminals);
    check('§4 replayState back to baseline', after.replay, baseline.replay);
    check('§4 sessions back to baseline', after.sessions, baseline.sessions);
    check('§4 no disposable keys survive', after.disposables, 0);
    check('§4 no pendingOutput keys survive', after.pending, 0);
    check('§4 no terminalReady keys survive', after.ready, 0);
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}
// ============================================================================
// §5 CONTROLS — the guard must be narrow. A LIVE session still records
//     everything, a re-created session starts a fresh transcript, and the
//     download surface (getCleanTranscript) still sees the bytes.
// ============================================================================
{
    const { ctx, page, errors } = await newPage();

    // (a) a live session records live output after replay closes.
    const sid = 'control-live';
    await serverRestore(page, sid, ['HIST\r\n']);
    await awaitReady(page, sid);
    await page.evaluate((s) => {
        window.__server('ssh_output', { session_id: s, data: 'LIVE-1\r\n' });
        window.__server('ssh_output', { session_id: s, data: 'LIVE-2\r\n' });
    }, sid);
    let st = await transcriptState(page, sid);
    check('§5a a live session records replay + live output',
        st.text, 'HIST\r\nLIVE-1\r\nLIVE-2\r\n');
    check('§5a transcriptSizes tracks the live bytes',
        st.size, 'HIST\r\nLIVE-1\r\nLIVE-2\r\n'.length);
    check('§5a the download surface sees the transcript',
        await page.evaluate((s) => {
            // getCleanTranscript runs normalizeControlChars, where a CR means
            // "erase this line" (lineStart only advances on LF). So the marker
            // is written LF-terminated: a CRLF marker is correctly erased by
            // its own CR and would say nothing about the transcript path.
            window.__server('ssh_output', { session_id: s, data: 'DL-MARKER\n' });
            return window.TerminalManager.getCleanTranscript(s).includes('DL-MARKER');
        }, sid), true);

    // (b) closing then RE-restoring the same session id starts a clean
    //     transcript — no carry-over from the dead one.
    await page.evaluate((s) => SessionManager.closeSession(s), sid);
    await page.evaluate((s) => {
        window.__server('ssh_output', { session_id: s, data: 'GHOST\r\n' });
    }, sid);
    await serverRestore(page, sid, ['SECOND-LIFE\r\n']);
    await awaitReady(page, sid);
    st = await transcriptState(page, sid);
    check('§5b a re-restored session starts a clean transcript',
        st.text, 'SECOND-LIFE\r\n');
    check('§5b the ghost frame left nothing behind',
        st.text.includes('GHOST'), false);

    // (c) transcript trimming still works (the guard is above the size logic).
    await page.evaluate((s) => {
        const block = 'z'.repeat(50000);
        for (let i = 0; i < 6; i++) {
            window.__server('ssh_output', { session_id: s, data: block });
        }
    }, sid);
    st = await transcriptState(page, sid);
    const cap = await page.evaluate(() => window.TerminalManager.maxTranscriptSize);
    check('§5c the transcript is still trimmed to maxTranscriptSize',
        st.size <= cap, true);
    check('§5c the trimmed transcript is not empty', st.size > 0, true);
    check('§5c transcriptSizes agrees with the joined text length',
        st.size, st.text.length);

    await page.evaluate((s) => new Promise(resolve => {
        // Flush xterm's OWN write queue before tearing the terminal down.
        // terminal.write() is asynchronous (it queues into xterm's parser), and
        // disposing mid-drain makes vendor xterm 5.3.0 throw from
        // Viewport._innerRefresh ("Cannot read properties of undefined (reading
        // 'dimensions')") because its queued refresh outlives the renderer.
        // Reproduced 6/6 with the 300 KB burst above and 0/6 with this flush,
        // with appendTranscript untouched in both — a vendor dispose race, not a
        // transcript-ownership effect, and not something this suite should race.
        const key = (window.TerminalManager.sessionTerminals[s] || [])[0];
        const term = window.TerminalManager.terminals[key];
        if (!term) { resolve(); return; }
        term.write('', () => resolve());
    }), sid);
    await page.evaluate((s) => SessionManager.closeSession(s), sid);
    check('§5 nothing survives the final close',
        await page.evaluate(() =>
            Object.keys(window.TerminalManager.transcripts).length
            + Object.keys(window.TerminalManager.transcriptSizes).length), 0);
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
