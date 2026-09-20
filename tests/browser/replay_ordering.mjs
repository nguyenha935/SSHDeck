/*
 * W3 — client replay ordering contract.
 *
 * Drives the REAL static/js/terminal-manager.js against REAL xterm instances and
 * reads the resulting buffer text. Nothing about the ordering logic is
 * reimplemented here: the test feeds the same events the server sends
 * (ssh_session_restored -> ssh_replay_chunk... -> ssh_output) and then asks the
 * terminal what it actually shows.
 *
 * The defects this pins, all of which the old restore path had:
 *
 *  §1 Replay used to be handed over on a setTimeout(200) and hoped to win a race
 *     against live output. When it lost, restored history appeared BELOW newer
 *     output, or interleaved with it mid-escape-sequence -- which corrupts the
 *     screen rather than merely reordering lines. Live output must queue behind
 *     an open replay and drain, in arrival order, only once it closes.
 *  §2 Chunks must be written strictly in seq order even when they arrive out of
 *     order, and an early chunk must be parked rather than written.
 *  §3 The gate must always be released: an empty terminator (seq 0) closes a
 *     replay with nothing in it, otherwise live output queues forever.
 *  §4 Truncation is announced exactly once, and never silently.
 *  §5 Nothing is lost: reassembled chunk data equals what the server sent, and
 *     the transcript sees replay and live output exactly once each.
 *
 * Run: node tests/browser/replay_ordering.mjs   (from source/)
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
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

/*
 * The harness page is SERVED over http rather than injected with setContent,
 * because terminal-manager.js touches localStorage at load. setContent leaves
 * the document on an opaque origin, where localStorage access throws a
 * SecurityError and the module never finishes initialising.
 */
const HARNESS_HTML = `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="/static/vendor/xterm/xterm.css">
    <style>#host { width: 900px; height: 480px; }</style>
</head><body>
    <div id="terminalsContainer"></div>
    <div id="host" class="terminal-wrapper"></div>
</body></html>`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/harness.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(HARNESS_HTML);
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
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

// A minimal document: real xterm + the real terminal-manager. No stub stands in
// for anything under test.
await page.goto(`${base}/harness.html`, { waitUntil: 'load' });

await page.addScriptTag({ url: `${base}/static/vendor/xterm/xterm.js` });
await page.addScriptTag({ url: `${base}/static/vendor/xterm/xterm-addon-fit.js` });
await page.addScriptTag({ url: `${base}/static/js/terminal-manager.js` });

check('harness loaded the real TerminalManager',
    await page.evaluate(() => typeof window.TerminalManager === 'object'), true);
check('harness loaded real xterm',
    await page.evaluate(() => typeof window.Terminal === 'function'), true);

/*
 * Attach a real terminal for a session id through the production code path, then
 * wait for terminalReady. attachTerminal deliberately clears the screen and
 * discards pre-ready output inside a nested rAF + 50ms timeout, so a test that
 * wrote before that fired would have its writes erased and would be measuring
 * the wrong thing.
 */
async function attachSession(sessionId) {
    await page.evaluate((sid) => {
        const holder = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = `term-${sid}`;
        el.className = 'terminal-wrapper';
        el.style.width = '900px';
        el.style.height = '480px';
        holder.appendChild(el);
        window.TerminalManager.createTerminal(sid);
        window.TerminalManager.attachTerminal(sid, `term-${sid}`);
    }, sessionId);
    await page.waitForFunction((sid) => {
        const keys = window.TerminalManager.sessionTerminals[sid] || [];
        return keys.length > 0 && keys.every(k => window.TerminalManager.terminalReady[k]);
    }, sessionId, { timeout: 5000 });
}

// Read the visible buffer as text, trailing blank lines stripped.
async function bufferText(sessionId) {
    return await page.evaluate((sid) => {
        const key = (window.TerminalManager.sessionTerminals[sid] || [])[0];
        const term = window.TerminalManager.terminals[key];
        if (!term) return null;
        const buf = term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
            lines.push(buf.getLine(i).translateToString(true));
        }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines.join('\n');
    }, sessionId);
}

// xterm's write() is asynchronous (it queues into its parser), so every
// assertion waits for the queue to flush rather than guessing a timeout.
async function flush(sessionId) {
    await page.evaluate((sid) => new Promise(resolve => {
        const key = (window.TerminalManager.sessionTerminals[sid] || [])[0];
        const term = window.TerminalManager.terminals[key];
        if (!term) { resolve(); return; }
        term.write('', () => resolve());
    }), sessionId);
}

// ============================================================================
// §0 — W14-A: output that lands BEFORE terminal readiness is DRAINED, not
// discarded. This is the exact desktop-restore race: the server pushes the
// replay immediately on socket connect, while attachTerminal waits double-rAF
// + 50ms before declaring the xterm ready. The old code cleared pendingOutput
// at that point and silently lost the entire restored history.
//
// Unlike attachSession(), this deliberately DOES NOT wait for terminalReady
// before writing. It proves the real attach path buffers the two chunks, then
// drains them in order once ready; no test-side write bypasses production.
// ============================================================================
{
    const sid = 'ordering-preready';
    await page.evaluate((sid) => {
        const holder = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = `term-${sid}`;
        el.className = 'terminal-wrapper';
        el.style.width = '900px';
        el.style.height = '480px';
        holder.appendChild(el);
        window.TerminalManager.createTerminal(sid);
        window.TerminalManager.attachTerminal(sid, `term-${sid}`);
        // These writes happen synchronously after attach, before the nested rAF
        // + 50ms readiness callback can possibly fire.
        window.TerminalManager.writeOutput(sid, 'PRE-READY-ONE\r\n');
        window.TerminalManager.writeOutput(sid, 'PRE-READY-TWO\r\n');
    }, sid);
    const bufferedBeforeReady = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        return {
            ready: TM.terminalReady[key],
            buffered: (TM.pendingOutput[key] || []).slice(),
        };
    }, sid);
    check('§0 pre-ready: terminal is genuinely not ready yet',
        bufferedBeforeReady.ready, false);
    check('§0 pre-ready: both restore chunks are buffered in arrival order',
        bufferedBeforeReady.buffered,
        ['PRE-READY-ONE\r\n', 'PRE-READY-TWO\r\n']);

    await page.waitForFunction((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        return !!TM.terminalReady[key];
    }, sid, { timeout: 5000 });
    await flush(sid);
    check('§0 pre-ready: readiness drains history instead of discarding it',
        await bufferText(sid), 'PRE-READY-ONE\nPRE-READY-TWO');
    check('§0 pre-ready: pending buffer is empty after the ordered drain',
        await page.evaluate((sid) => {
            const TM = window.TerminalManager;
            const key = (TM.sessionTerminals[sid] || [])[0];
            return (TM.pendingOutput[key] || []).length;
        }, sid), 0);
}

// ============================================================================
// §1 — live output arriving mid-replay lands AFTER the replay, in order.
// ============================================================================
{
    const sid = 'ordering-1';
    await attachSession(sid);

    // The server's sequence: snapshot opens the window, then chunks, with a live
    // frame arriving between chunk 1 and chunk 2 -- exactly the race the old
    // setTimeout lost.
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 2);
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 2, data: 'HIST-ONE\r\n', final: false,
            truncated: false, dropped_bytes: 0,
        });
        // Live output while the replay is still open.
        TM.writeOutput(sid, 'LIVE-A\r\n');
        TM.acceptReplayChunk(sid, {
            seq: 2, total: 2, data: 'HIST-TWO\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);

    const text = await bufferText(sid);
    check('§1 replayed history precedes live output',
        text, 'HIST-ONE\nHIST-TWO\nLIVE-A');
    check('§1 the replay window is closed afterwards',
        await page.evaluate((sid) => !window.TerminalManager.replayState[sid], sid), true);
}

// ============================================================================
// §1b — several live frames queued mid-replay keep their own arrival order.
// ============================================================================
{
    const sid = 'ordering-1b';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 1);
        TM.writeOutput(sid, 'LIVE-1\r\n');
        TM.writeOutput(sid, 'LIVE-2\r\n');
        TM.writeOutput(sid, 'LIVE-3\r\n');
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 1, data: 'HIST\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§1b queued live frames drain in arrival order',
        await bufferText(sid), 'HIST\nLIVE-1\nLIVE-2\nLIVE-3');
}

// ============================================================================
// §1c — after the replay closes, live output is written immediately.
// ============================================================================
{
    const sid = 'ordering-1c';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 1);
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 1, data: 'HIST\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
        TM.writeOutput(sid, 'AFTER\r\n');
    }, sid);
    await flush(sid);
    check('§1c post-replay live output is not queued',
        await bufferText(sid), 'HIST\nAFTER');
}

// ============================================================================
// §2 — out-of-order chunks are parked and written by seq.
// ============================================================================
{
    const sid = 'ordering-2';
    await attachSession(sid);

    // Deliver 2 BEFORE 1. Socket.IO ordering is not something to bet a corrupted
    // screen on, so the early chunk must be held, not written.
    const heldAfterEarly = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 3);
        TM.acceptReplayChunk(sid, {
            seq: 2, total: 3, data: 'SECOND\r\n', final: false,
            truncated: false, dropped_bytes: 0,
        });
        return {
            held: Object.keys(TM.replayState[sid].held).map(Number),
            nextSeq: TM.replayState[sid].nextSeq,
        };
    }, sid);
    check('§2 an early chunk is parked, not written', heldAfterEarly.held, [2]);
    check('§2 the writer still waits for seq 1', heldAfterEarly.nextSeq, 1);
    await flush(sid);
    check('§2 nothing was written while seq 1 was missing',
        await bufferText(sid), '');

    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 3, data: 'FIRST\r\n', final: false,
            truncated: false, dropped_bytes: 0,
        });
        TM.acceptReplayChunk(sid, {
            seq: 3, total: 3, data: 'THIRD\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§2 chunks are written in seq order once the gap fills',
        await bufferText(sid), 'FIRST\nSECOND\nTHIRD');
}

// ============================================================================
// §2b — a chunk that never arrives must not swallow the ones after it.
// ============================================================================
{
    const sid = 'ordering-2b';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 3);
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 3, data: 'ONE\r\n', final: false,
            truncated: false, dropped_bytes: 0,
        });
        // seq 2 is lost. seq 3 closes the replay.
        TM.acceptReplayChunk(sid, {
            seq: 3, total: 3, data: 'THREE\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§2b a held chunk is still flushed when the replay closes',
        await bufferText(sid), 'ONE\nTHREE');
    check('§2b the window closes despite the gap',
        await page.evaluate((sid) => !window.TerminalManager.replayState[sid], sid), true);
}

// ============================================================================
// §3 — the empty terminator releases the gate.
// ============================================================================
{
    const sid = 'ordering-3';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 0);
        TM.writeOutput(sid, 'QUEUED\r\n');   // gate is up, so this waits
        TM.acceptReplayChunk(sid, {
            seq: 0, total: 0, data: '', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§3 an empty replay still releases queued live output',
        await bufferText(sid), 'QUEUED');
    check('§3 seq 0 is not written as a chunk',
        (await bufferText(sid)).includes('undefined'), false);
}

// ============================================================================
// §4 — truncation is announced once, and only when truncated.
// ============================================================================
{
    const sid = 'ordering-4';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 2);
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 2, data: 'TAIL-1\r\n', final: false,
            truncated: true, dropped_bytes: 51200,
        });
        TM.acceptReplayChunk(sid, {
            seq: 2, total: 2, data: 'TAIL-2\r\n', final: true,
            truncated: true, dropped_bytes: 51200,
        });
    }, sid);
    await flush(sid);
    const truncText = await bufferText(sid);
    check('§4 the replayed tail is present',
        truncText.includes('TAIL-1') && truncText.includes('TAIL-2'), true);
    check('§4 a truncation notice is shown',
        /---.*---/.test(truncText), true);
    check('§4 the notice reports the dropped size',
        truncText.includes('50 KB'), true);
    check('§4 the notice appears exactly once',
        (truncText.match(/---/g) || []).length, 2);  // one leading + one trailing
    check('§4 the notice comes after the history it describes',
        truncText.indexOf('TAIL-2') < truncText.indexOf('---'), true);
}

{
    const sid = 'ordering-4b';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 1);
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 1, data: 'WHOLE\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§4b a complete replay prints NO truncation notice',
        await bufferText(sid), 'WHOLE');
}

// ============================================================================
// §5 — nothing lost, nothing duplicated.
// ============================================================================
{
    const sid = 'ordering-5';
    await attachSession(sid);
    // 40 chunks, the shape a large buffer actually produces.
    const expected = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 40);
        let all = '';
        for (let i = 1; i <= 40; i++) {
            const data = `chunk-${i}\r\n`;
            all += data;
            TM.acceptReplayChunk(sid, {
                seq: i, total: 40, data, final: i === 40,
                truncated: false, dropped_bytes: 0,
            });
        }
        TM.writeOutput(sid, 'live-tail\r\n');
        return all + 'live-tail\r\n';
    }, sid);
    await flush(sid);

    const text = await bufferText(sid);
    check('§5 every chunk arrived exactly once',
        text.split('\n').filter(l => l === 'chunk-7').length, 1);
    check('§5 the full stream reassembled in order',
        text, expected.replace(/\r\n/g, '\n').replace(/\n$/, ''));

    // The transcript is the download/copy surface: it must agree with the screen.
    const transcript = await page.evaluate((sid) =>
        window.TerminalManager.getTranscript(sid), sid);
    check('§5 the transcript matches what was written', transcript, expected);
    check('§5 no chunk is duplicated in the transcript',
        (transcript.match(/chunk-12\r\n/g) || []).length, 1);
}

// ============================================================================
// §6 — queueReplay (the whole-buffer entry point session-manager still uses for
// an inline payload) routes through the same sequenced writer.
// ============================================================================
{
    const sid = 'ordering-6';
    await attachSession(sid);
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.queueReplay(sid, 'INLINE-HIST\r\n');
        TM.writeOutput(sid, 'INLINE-LIVE\r\n');
    }, sid);
    await flush(sid);
    check('§6 queueReplay writes the buffer then releases live output',
        await bufferText(sid), 'INLINE-HIST\nINLINE-LIVE');
    check('§6 queueReplay leaves no open window',
        await page.evaluate((sid) => !window.TerminalManager.replayState[sid], sid), true);
}

// ============================================================================
// §7 — a chunk for a session with no open window is not dropped.
// ============================================================================
{
    const sid = 'ordering-7';
    await attachSession(sid);
    await page.evaluate((sid) => {
        // No beginReplay: the snapshot was missed or arrived late.
        window.TerminalManager.acceptReplayChunk(sid, {
            seq: 1, total: 1, data: 'ORPHAN\r\n', final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, sid);
    await flush(sid);
    check('§7 an unexpected chunk is still written, not discarded',
        await bufferText(sid), 'ORPHAN');
}

// ============================================================================
// §8 — D2 "không fit sau mỗi chunk": a chunked replay must not re-fit.
//
// A fit is a full measure + reflow of the terminal AND a resize frame to the
// PTY. Doing one per chunk is the single most expensive thing a replay could
// do, and a 256KB buffer at 32KB per chunk is eight of them for one session —
// times every restored session. writeOutputNow deliberately routes only through
// writeOutputToTerminal; nothing on that path measures. This pins it, because
// a fit is exactly the kind of thing that gets added to "make the screen look
// right after history lands".
//
// The initial attach fit is excluded by zeroing the log after attachSession:
// attachTerminal fits once inside a nested rAF, which is correct and is not
// what this asserts.
// ============================================================================
{
    const sid = 'ordering-8';
    await attachSession(sid);
    await page.evaluate(() => {
        const TM = window.TerminalManager;
        window.__fits = [];
        const real = TM.fitTerminal.bind(TM);
        TM.fitTerminal = (sid) => { window.__fits.push(sid); return real(sid); };
    });
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 12);
        for (let i = 1; i <= 12; i++) {
            TM.acceptReplayChunk(sid, {
                seq: i, total: 12, data: `f-chunk-${i}\r\n`, final: i === 12,
                truncated: false, dropped_bytes: 0,
            });
        }
        TM.writeOutput(sid, 'f-live\r\n');
    }, sid);
    await flush(sid);
    // Give any deferred fit (rAF or debounce) a chance to land before counting;
    // a fit that arrives late is still a fit caused by the replay.
    await page.waitForTimeout(250);
    check('§8 a 12-chunk replay causes no fit at all',
        await page.evaluate(() => window.__fits.length), 0);
    check('§8 the replay still landed in full',
        (await bufferText(sid)).split('\n').length, 13);
}

// ============================================================================
// §9 — D2 "phục hồi scrollback cuộn được trong hạn mức đã thiết kế".
//
// Replayed history must be SCROLLBACK, not just the last screen: a restored
// session the user scrolls up in is the whole point of replaying at all. And it
// must be bounded — xterm's own `scrollback` option (terminal-manager.js:162,
// default 150 lines, user-configurable) is the limit, so a replay far larger
// than it must be trimmed by xterm rather than growing the buffer without end.
// ============================================================================
{
    const sid = 'ordering-9';
    await attachSession(sid);
    const limit = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        return TM.terminals[key].options.scrollback;
    }, sid);
    check('§9 the terminal declares a finite scrollback limit',
        Number.isFinite(limit) && limit > 0, true);

    // Replay 3x the limit in lines, sequenced, exactly as a real restore does.
    await page.evaluate(({ sid, n }) => {
        const TM = window.TerminalManager;
        TM.beginReplay(sid, 1);
        let all = '';
        for (let i = 1; i <= n; i++) all += `line-${i}\r\n`;
        TM.acceptReplayChunk(sid, {
            seq: 1, total: 1, data: all, final: true,
            truncated: false, dropped_bytes: 0,
        });
    }, { sid, n: limit * 3 });
    await flush(sid);

    const geom = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        const buf = term.buffer.active;
        return { baseY: buf.baseY, rows: term.rows, length: buf.length,
            viewportY: buf.viewportY, scrollback: term.options.scrollback };
    }, sid);
    check('§9 the replay produced scrollable scrollback, not one screen',
        geom.baseY > 0, true);
    check('§9 the buffer stays within rows + scrollback',
        geom.length <= geom.rows + geom.scrollback, true);
    check('§9 the view is parked at the newest output',
        geom.viewportY, geom.baseY);

    // Scrolling up must actually reach earlier history.
    const scrolled = await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        term.scrollLines(-10);
        return term.buffer.active.viewportY;
    }, sid);
    check('§9 the user can scroll back into the replayed history',
        scrolled < geom.baseY, true);
}

check('§10 no page errors', pageErrors.join(' | '), '');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
