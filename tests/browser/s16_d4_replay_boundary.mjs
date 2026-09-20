/*
 * S16 D4-R — THE REPLAY BOUNDARY. A history transcript must land on the NORMAL
 * buffer, where xterm's scrollback can hold it.
 *
 * Owner report, repeatedly: "Tải lại mobile vẫn mất lịch sử" — a reload loses
 * the history, and nothing is scrollable afterwards. Measured on the deployed
 * S16 build (/tmp/s16work/b_c_diag5.out, b_c_diag6.out):
 *   before the reload   bufferLength 48, nonEmpty 48, first "BGDIAG-355"
 *   after  the reload   bufferLength 48, nonEmpty 0   — blank for 11.5s straight
 *
 * WHY. A real tmux attach replay ENTERS the alternate screen at BYTE 0. The
 * verbatim first 180 bytes of a live restore chunk, captured off the websocket
 * (/tmp/s16work/live_replay_chunk.txt, 7336 B / 462 lines, truncated: false):
 *     \x1b[?1049h \x1b[22;0;0t \x1b[?1h \x1b= \x1b[H \x1b[2J … \x1b[1;1H
 * so tmux paints every line of history INSIDE the alternate buffer, which by
 * definition has no scrollback. The S16/S4 belt then emits `\x1b[?1049l` after
 * the replay and hands the user back the NORMAL buffer, which nothing ever wrote
 * to — 47 rows of nothing.
 *
 * The S16/S4 sanitizer could not prevent it: it ran only when the server declared
 * the replay TRUNCATED (writeReplayChunk chose `sanitizeTruncatedReplayChunk`
 * only on that flag), and a normal restore is not truncated. So the one path that
 * strips `?1049h` was unreachable for the case the Owner actually hits.
 *
 * The fix under test is at the BOUNDARY: a replay is a transcript being
 * reinjected, not a live terminal feed, so screen-SWITCHING and
 * transcript-ERASING control sequences must not survive into the engine —
 * whether or not the server trimmed the stream.
 *
 * ROWS
 *   §R1  the real captured live tmux replay, verbatim: normal buffer, more than
 *        one screenful reachable, and the oldest transcript line reachable in
 *        scrollback. This is the Owner's case and the row that must be RED
 *        before the fix.
 *   §R2  a synthetic clean replay: 400 numbered lines wrapped in a tmux-shaped
 *        preamble. Same three assertions, plus the newest line.
 *   §R3  legacy and combined alternate-screen forms (?47h, ?1047h, and
 *        ?1000;1006;1049h — xterm's DECSET loop iterates every parameter, so the
 *        combined form switches buffers exactly as the bare one does).
 *   §R4  a TRUNCATED replay of the same bytes keeps working (the pre-existing
 *        S14 guarantee must not regress).
 *   §R5  the transcript is not merely present but SCROLLABLE: baseY > 0, i.e.
 *        rows really went into the scrollback rather than filling the viewport.
 *   §R6  cosmetics survive: SGR colour and cursor addressing are NOT stripped.
 *        A boundary cleaner that ate those would "pass" §R1 while destroying the
 *        rendering, so this row is what keeps the fix minimal.
 *   §R7  a LIVE frame after the replay may still enter the alternate screen. It
 *        is a genuine application statement, not replay residue, and must be
 *        obeyed — this is the row that decides the belt question.
 *   §R8  the engine is ALREADY on the alternate screen when the replay window
 *        opens. This is the real live ordering: `ssh_output` arrives BEFORE
 *        `ssh_session_restored` (measured +0ms / +0ms / +5ms,
 *        /tmp/s16work/b_c_diag6.out), so a live frame that entered a TUI is
 *        written straight to the engine and the restore begins from there. The
 *        cleaner alone cannot fix this — it strips switches in BOTH directions,
 *        so the replay can no longer leave a screen either — which is why
 *        writeReplayChunk claims the screen before its first byte.
 *   §R9  a live frame that arrives DURING the replay is queued, drained after the
 *        transcript, and its full-screen entry is NOT undone afterwards.
 *
 * Run: node tests/browser/s16_d4_replay_boundary.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
// The verbatim bytes of one real live restore, captured off the websocket by
// tests/fixtures/capture_live_replay.mjs. IN THE REPO since: the
// original lived in /tmp, a reboot took it, and §R1 -- the owner's own case --
// had been red on a missing file ever since. When absent it is still reported
// as SKIPPED-LOUDLY (a failure), never silently dropped.
const LIVE_CAPTURE = path.join(ROOT, 'tests/fixtures/live_replay_chunk.txt');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        failures.push(label);
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
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

const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = {
        connected: true, id: 'sock-s16d4r',
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, io: { on: noop },
        emit: (name, payload) => {
            /*
             * S28 -- ANSWER EVERY SIZE PROPOSAL, as the real server does.
             * handle_ssh_resize replies with pty_geometry to EVERY proposal
             * (socket_events.py). Silence leaves the geometry hold armed
             * (terminal-manager.js: geometryHold), so live ssh_output frames sit
             * held and the engine renders nothing -- which is what the R7/R8
             * alternate-screen rows caught. Echoing the proposal back is the
             * honest single-client reply (rule 1, _resolve_authority) and
             * resizes nothing.
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
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SID = 'S16-D4R-1';

// Delivered through the app's OWN handlers, so this is a restore and not a
// direct write: ssh_session_restored opens the replay window, ssh_replay_chunk
// is sequenced through acceptReplayChunk.
const RESTORE = `([sid, chunks, truncated]) => {
    (window.__socketHandlers['ssh_session_restored'] || []).forEach(cb => cb({
        session_id: sid, host: 'd4r.example', port: 22, username: 'd4r',
        auth_type: 'key', key_id: 'k1', jump_host_id: null,
        display_name: 'D4R', connected: true, is_persistent_candidate: true,
        tmux_session_name: 'sshdeck_d4r', use_tmux: true, pane_index: 0,
        replay_total_chunks: chunks.length,
        replay_truncated: truncated, replay_dropped_bytes: truncated ? 4096 : 0,
        pty_cols: 49, pty_rows: 47, replay_max_lines: 5000,
    }));
    chunks.forEach((data, i) => {
        (window.__socketHandlers['ssh_replay_chunk'] || []).forEach(cb => cb({
            session_id: sid, seq: i + 1, total: chunks.length, data,
            final: i + 1 === chunks.length,
            truncated, dropped_bytes: truncated ? 4096 : 0,
        }));
    });
}`;

const LIVE_FRAME = `([sid, data]) => {
    (window.__socketHandlers['ssh_output'] || []).forEach(cb => cb({
        session_id: sid, data,
    }));
}`;

const INSPECT = `([sid, needles]) => {
    const key = TerminalManager.sessionTerminals[sid][0];
    const terminal = TerminalManager.terminals[key];
    const buf = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
        const t = (buf.getLine(i)?.translateToString(true) || '').trim();
        if (t !== '') lines.push(t);
    }
    const found = {};
    (needles || []).forEach(n => {
        found[n] = lines.some(l => l.includes(n));
    });
    return {
        bufferType: buf.type, baseY: buf.baseY, bufferLength: buf.length,
        rows: terminal.rows, scrollbackCapacity: terminal.options.scrollback,
        reachableLines: lines.length,
        firstLine: lines[0] || null,
        lastLine: lines[lines.length - 1] || null,
        found,
    };
}`;

// Colour + cursor addressing, read back off the cell attributes rather than the
// text, so §R6 measures what the engine really applied.
const CELL_STYLE = `([sid, needle]) => {
    const key = TerminalManager.sessionTerminals[sid][0];
    const terminal = TerminalManager.terminals[key];
    const buf = terminal.buffer.active;
    for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        const text = line ? line.translateToString(true) : '';
        if (!text.includes(needle)) continue;
        const col = text.indexOf(needle);
        const cell = line.getCell(col);
        return { row: i, fg: cell ? cell.getFgColor() : null,
                 bold: cell ? !!cell.isBold() : null,
                 chars: cell ? cell.getChars() : null };
    }
    return null;
}`;

async function openPage() {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')
        ?.classList.remove('hidden'));
    await page.waitForTimeout(150);
    return { ctx, page, errors };
}

async function restoreAndInspect(chunks, truncated, needles) {
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, chunks, truncated]);
    await page.waitForTimeout(1700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, needles]);
    return { ctx, page, errors, m };
}

// tmux's real attach preamble, verbatim in shape from the live capture.
const TMUX_PREAMBLE = '\x1b[?1049h\x1b[22;0;0t\x1b[?1h\x1b=\x1b[H\x1b[2J'
    + '\x1b[?12l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'
    + '\x1b[?1005l\x1b[?2004h\x1b(B\x1b[m\x1b[1;1H';
const TRANSCRIPT = Array.from({ length: 400 },
    (_, i) => `XCRIPT-${String(i + 1).padStart(4, '0')} line\r\n`).join('');

// ── §R1 the real captured live tmux replay, verbatim ────────────────────────
{
    console.log('\n--- §R1 the real captured live tmux restore, verbatim');
    if (!fs.existsSync(LIVE_CAPTURE)) {
        check(`§R1 the live capture ${LIVE_CAPTURE} is present (this row is the`
            + ' Owner\'s real case and must never be silently skipped)',
            false, true);
    } else {
        const chunk = fs.readFileSync(LIVE_CAPTURE, 'utf8');
        const { ctx, errors, m } = await restoreAndInspect([chunk], false,
            ['CAPLINE-356', 'CAPLINE-400']);
        console.log('    ' + JSON.stringify(m));
        check('§R1 the real live replay lands on the NORMAL buffer',
            m.bufferType, 'normal');
        check(`§R1 more than one screenful is reachable `
            + `(${m.reachableLines} lines vs ${m.rows} rows)`,
            m.reachableLines > m.rows, true);
        check('§R1 an OLD transcript line is reachable in scrollback '
            + '(CAPLINE-356)', m.found['CAPLINE-356'], true);
        check('§R1 the newest transcript line is reachable (CAPLINE-400)',
            m.found['CAPLINE-400'], true);
        check('§R1 no page errors', errors.slice(0, 2), []);
        await ctx.close();
    }
}

// ── §R2 a synthetic clean replay in the same shape ──────────────────────────
{
    console.log('\n--- §R2 a synthetic clean tmux-shaped replay');
    const { ctx, errors, m } = await restoreAndInspect(
        [TMUX_PREAMBLE + TRANSCRIPT], false, ['XCRIPT-0001', 'XCRIPT-0400']);
    console.log('    ' + JSON.stringify(m));
    check('§R2 the transcript lands on the NORMAL buffer', m.bufferType, 'normal');
    check(`§R2 more than one screenful is reachable (${m.reachableLines} vs `
        + `${m.rows})`, m.reachableLines > m.rows, true);
    check('§R2 the OLDEST transcript line is reachable (XCRIPT-0001)',
        m.found['XCRIPT-0001'], true);
    check('§R2 the newest transcript line is reachable (XCRIPT-0400)',
        m.found['XCRIPT-0400'], true);
    check('§R2 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R3 legacy and combined alternate-screen forms ──────────────────────────
for (const [form, label] of [
    ['\x1b[?47h', '?47h (the oldest form)'],
    ['\x1b[?1047h', '?1047h'],
    ['\x1b[?1000;1006;1049h', '?1000;1006;1049h (combined DECSET)'],
]) {
    const chunk = form + '\x1b[H\x1b[2J' + TRANSCRIPT;
    const { ctx, errors, m } = await restoreAndInspect([chunk], false,
        ['XCRIPT-0001', 'XCRIPT-0400']);
    console.log(`\n--- §R3 ${label}\n    ` + JSON.stringify(m));
    check(`§R3 ${label}: normal buffer`, m.bufferType, 'normal');
    check(`§R3 ${label}: the oldest transcript line is reachable`,
        m.found['XCRIPT-0001'], true);
    check(`§R3 ${label}: no page errors`, errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R4 a TRUNCATED replay of the same bytes still works ────────────────────
{
    console.log('\n--- §R4 the same replay declared TRUNCATED (S14 guarantee)');
    const { ctx, errors, m } = await restoreAndInspect(
        [TMUX_PREAMBLE + TRANSCRIPT], true, ['XCRIPT-0400']);
    console.log('    ' + JSON.stringify(m));
    check('§R4 a truncated replay also lands on the NORMAL buffer',
        m.bufferType, 'normal');
    check('§R4 the newest transcript line is reachable',
        m.found['XCRIPT-0400'], true);
    check('§R4 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R5 the transcript is SCROLLABLE, not just present ──────────────────────
{
    console.log('\n--- §R5 rows really entered the scrollback');
    const { ctx, errors, m } = await restoreAndInspect(
        [TMUX_PREAMBLE + TRANSCRIPT], false, []);
    console.log('    ' + JSON.stringify(m));
    check(`§R5 baseY > 0, i.e. the buffer scrolled (baseY ${m.baseY})`,
        m.baseY > 0, true);
    check(`§R5 the buffer is longer than the viewport `
        + `(${m.bufferLength} > ${m.rows})`, m.bufferLength > m.rows, true);
    check('§R5 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R6 cosmetics survive: this is what keeps the cleaner minimal ───────────
{
    console.log('\n--- §R6 SGR colour and cursor addressing are NOT stripped');
    // Bright-red bold at an explicitly addressed cursor position, inside a
    // replay that also carries an alternate-screen switch.
    const chunk = TMUX_PREAMBLE + TRANSCRIPT
        + '\x1b[10;1H\x1b[1m\x1b[31mSGRMARK\x1b[0m\r\n';
    const { ctx, page, errors, m } = await restoreAndInspect([chunk], false,
        ['SGRMARK']);
    const style = await page.evaluate(new Function('return ' + CELL_STYLE)(),
        [SID, 'SGRMARK']);
    console.log('    ' + JSON.stringify(m) + '\n    cell ' + JSON.stringify(style));
    check('§R6 the SGR-marked text survives the boundary', m.found['SGRMARK'], true);
    check('§R6 its BOLD attribute survives', style && style.bold, true);
    check('§R6 its foreground colour survives (red = 1)',
        style && style.fg, 1);
    check('§R6 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R7 a LIVE frame after the replay may still enter the alternate screen ──
{
    console.log('\n--- §R7 a live frame owns the screen: alt entry is obeyed');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [TMUX_PREAMBLE + TRANSCRIPT], false]);
    await page.waitForTimeout(1700);
    const before = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, []]);
    // A genuine application statement AFTER the restore: vim/less/tmux
    // copy-mode taking the screen.
    await page.evaluate(new Function('return ' + LIVE_FRAME)(),
        [SID, '\x1b[?1049h\x1b[H\x1b[2J~ live TUI ~\r\n']);
    await page.waitForTimeout(900);
    const after = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['live TUI']]);
    console.log('    before ' + JSON.stringify(before));
    console.log('    after  ' + JSON.stringify(after));
    check('§R7 the replay itself left the terminal on the normal buffer',
        before.bufferType, 'normal');
    check('§R7 a LIVE alternate-screen entry is obeyed, not neutralised',
        after.bufferType, 'alternate');
    check('§R7 the live TUI text is on that screen', after.found['live TUI'], true);
    check('§R7 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// A session whose terminal exists BEFORE the restore, so a live frame delivered
// ahead of the replay window has somewhere to land. This is the live ordering.
const SEED = `(sid) => {
    SessionManager.sessions[sid] = { id: sid, session_id: sid,
        host: 'd4r.example', port: 22, username: 'd4r', authType: 'key',
        keyId: 'k1', jumpHostId: null, displayName: 'D4R', connected: true,
        isPersistentCandidate: false, tmuxSessionName: 'sshdeck_d4r',
        terminalId: 'term-' + sid, useTmux: true, viaJump: null,
        latencyMs: null };
    SessionManager.activeSessionId = sid;
    const el = document.createElement('div');
    el.id = 'term-' + sid;
    el.className = 'terminal-wrapper';
    document.getElementById('terminalsContainer').appendChild(el);
    TerminalManager.createTerminal(sid);
    TerminalManager.attachTerminal(sid, 'term-' + sid);
}`;

// Drive the replay through the manager directly, so a live frame can be
// interleaved at a chosen point relative to the window.
const DRIVE = `([sid, chunk, queuedLive]) => {
    TerminalManager.beginReplay(sid, queuedLive ? 2 : 1);
    TerminalManager.acceptReplayChunk(sid, { seq: 1, total: queuedLive ? 2 : 1,
        data: chunk, final: !queuedLive, truncated: false, dropped_bytes: 0 });
    if (queuedLive) {
        // Arrives while the window is open: writeOutput must queue it, and the
        // drain must write it AFTER the transcript.
        TerminalManager.writeOutput(sid, queuedLive);
        TerminalManager.acceptReplayChunk(sid, { seq: 2, total: 2, data: '',
            final: true, truncated: false, dropped_bytes: 0 });
    }
}`;

// ── §R8 the engine is already on the alternate screen when the replay opens ──
{
    console.log('\n--- §R8 a pre-window live frame left the engine on alt');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + SEED)(), SID);
    await page.waitForTimeout(800);
    await page.evaluate(([sid, data]) => TerminalManager.writeOutput(sid, data),
        [SID, '\x1b[?1049h\x1b[H\x1b[2J~ pre-window TUI ~\r\n']);
    await page.waitForTimeout(500);
    const onAlt = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, []]);
    await page.evaluate(new Function('return ' + DRIVE)(),
        [SID, TMUX_PREAMBLE + TRANSCRIPT, null]);
    await page.waitForTimeout(1700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['XCRIPT-0001', 'XCRIPT-0400']]);
    console.log('    precondition ' + JSON.stringify(onAlt));
    console.log('    after replay ' + JSON.stringify(m));
    check('§R8 precondition: the pre-window live frame really took the '
        + 'alternate screen', onAlt.bufferType, 'alternate');
    check('§R8 the replay claims the screen and lands on the NORMAL buffer',
        m.bufferType, 'normal');
    check(`§R8 the whole transcript is reachable (${m.reachableLines} lines vs `
        + `${m.rows} rows)`, m.reachableLines > m.rows, true);
    check('§R8 the OLDEST transcript line is reachable', m.found['XCRIPT-0001'],
        true);
    check('§R8 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §R9 a live frame queued DURING the replay keeps its screen ──────────────
{
    console.log('\n--- §R9 a live frame queued during the replay is not undone');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + SEED)(), SID);
    await page.waitForTimeout(800);
    await page.evaluate(new Function('return ' + DRIVE)(),
        [SID, TMUX_PREAMBLE + TRANSCRIPT,
            '\x1b[?1049h\x1b[H\x1b[2J~ QUEUED TUI ~\r\n']);
    await page.waitForTimeout(1700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['QUEUED TUI']]);
    console.log('    ' + JSON.stringify(m));
    check('§R9 the queued live frame\'s full-screen entry survives the replay '
        + 'housekeeping', m.bufferType, 'alternate');
    check('§R9 its text is on that screen', m.found['QUEUED TUI'], true);
    check('§R9 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) console.log(`FAILED: ${failures.join(' | ')}`);
process.exit(fail === 0 ? 0 : 1);
