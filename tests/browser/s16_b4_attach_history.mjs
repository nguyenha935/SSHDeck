/*
 * S16 B4 — TMUX HISTORY REACHES THE CLIENT'S SCROLLBACK.
 *
 * Owner report, on mobile and on desktop: he cannot swipe back through the SSH
 * session history. Measured on the deployed build, with NO reload involved: 400
 * echoed lines leave xterm holding exactly one viewport (bufferLength 47,
 * nonEmpty 47, rows 47) while scrollbackCapacity is 5000 and untouched.
 *
 * WHY, and it is architectural rather than a tuning problem. tmux repaints its
 * window with ABSOLUTE CURSOR ADDRESSING -- the verbatim bytes of one live frame
 * (/tmp/s16work/live_pre_output.txt) are `ESC[?25l ESC[H` then one
 * `<text> ESC[K CR LF` per row -- and keeps the history in ITS OWN buffer.
 * xterm's scrollback is fed only by lines that SCROLL OFF THE TOP, and
 * cursor-addressed painting never scrolls anything off the top. So the client's
 * scrollback cannot fill however large it is set. The history was never lost; it
 * sat in tmux where the client had no way to see it.
 *
 * THE MECHANISM UNDER TEST (option 1 of three, chosen in writing in
 * /tmp/s16work/b4_history_architecture.txt): the server reads tmux's history once
 * per attach with `capture-pane -p -J -S -<N> -E -1` and delivers it as a plain
 * CRLF LINE STREAM through the existing sequenced replay path. A line stream
 * scrolls, so xterm fills its scrollback natively and the pan/gesture code, the
 * ScrollOwner and the D4-R boundary all keep working on their existing terms.
 *
 * ROWS
 *   §B1  THE DEFECT ITSELF, client-side. A tmux-shaped REPAINT of 400 lines --
 *        cursor-addressed, the real byte shape -- leaves one viewport and an
 *        empty scrollback. This row proves the architecture claim rather than
 *        asserting it, and it must keep passing: it is the reason the mechanism
 *        exists, not a bug.
 *   §B2  THE MECHANISM. The same 400 lines delivered as a LINE STREAM fill the
 *        scrollback: baseY > 0, several hundred lines reachable, the oldest line
 *        reachable. RED before the server change, because nothing sent a line
 *        stream at all.
 *   §B3  RESTORE (the reload path): history AHEAD of the gap buffer in one
 *        sequence lands in transcript order, and both ends are reachable.
 *   §B4  ATTACH (the connect path): `ssh_connected` carrying replay_total_chunks
 *        opens the replay window, and the history that follows lands in
 *        scrollback instead of being written as live output.
 *   §B5  ATTACH with no history: no window is opened, and a plain connect is
 *        byte-for-byte unaffected -- live output still paints immediately rather
 *        than queueing behind a replay that never arrives. This is the row that
 *        catches an unbalanced window, which would freeze a fresh session.
 *   §B6  the B4-STRICT floor, on the client: >= 100 non-empty lines reachable
 *        after the whole sequence. The Owner's criterion is "several hundred", so
 *        400 are delivered and the floor is asserted separately.
 *   §B7  the scrollback capacity is DERIVED from the server's cap on the attach
 *        path too, not only on restore -- an attach that delivers 5000 lines into
 *        a 150-line buffer would throw away what it just fetched.
 *
 * Run: node tests/browser/s16_b4_attach_history.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

// The history stream produced by the SHIPPED server normaliser
// (_normalise_history_text, imported by tests/fixtures/gen_history_fixture.py).
// It is generated rather than written here
// on purpose: a hand-written stream measures the browser only, so a server change
// that altered the SHAPE of the injected bytes left every row of this gate green
// -- measured, on mutation b4_m2 (paint the history instead of streaming it),
// which produced 32/0 here while six pytest rows went red. When the fixture is
// absent the gate FAILS LOUDLY; it is never silently skipped and never falls back
// to a locally-built stream.
// In the repo since: the old copy lived in /tmp and a reboot
// left this gate permanently red. tests/test_fixture_freshness.py keeps the
// committed bytes matching the current normaliser.
const HISTORY_FIXTURE = path.join(ROOT, 'tests/fixtures/b4_history_stream.txt');

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
        connected: true, id: 'sock-s16b4',
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, io: { on: noop },
        emit: (name, payload) => {
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
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SID = 'S16-B4-1';

// 400 lines of transcript in the two shapes that matter. The REPAINT is the byte
// shape tmux really emits (absolute home, then one erase-to-EOL per row); the
// LINE STREAM is what the server now injects.
const LINES = Array.from({ length: 400 },
    (_, i) => `HXLINE-${String(i + 1).padStart(4, '0')}`);
const REPAINT = '\x1b[?25l\x1b[H'
    + LINES.slice(-47).map(l => l + '\x1b[K\r\n').join('')
    + '\x1b(B\x1b[m\x1b[?12l\x1b[?25h\x1b[47;1H';

// The line stream comes from the SERVER's own normaliser, not from this file.
// Every row below that measures "the history reached the scrollback" measures the
// real injected bytes, so a change to their shape is caught here and not only in
// pytest.
if (!fs.existsSync(HISTORY_FIXTURE)) {
    check(`the server-shaped history fixture ${HISTORY_FIXTURE} is present`
        + ' (regenerate with .venv/bin/python tests/fixtures/gen_history_fixture.py;'
        + ' this gate must never measure a hand-written stream)', false, true);
    console.log(`\n${pass} passed, ${fail} failed`);
    await browser.close();
    server.close();
    process.exit(1);
}
const LINE_STREAM = fs.readFileSync(HISTORY_FIXTURE, 'utf8');


const CONNECTED = `([sid, totalChunks]) => {
    (window.__socketHandlers['ssh_connected'] || []).forEach(cb => cb({
        snapshot_version: 1, session_id: sid, host: 'b4.example', port: 22,
        username: 'b4', auth_type: 'key', key_id: 'k1', client_request_id: null,
        via_jump: null, use_tmux: true, tmux_session_name: 'sshdeck_b4',
        display_name: 'B4', legacy_tmux_locale: null,
        replay_max_lines: 5000,
        replay_total_chunks: totalChunks,
        replay_truncated: false, replay_dropped_bytes: 0,
        replay_history_lines: 0,
    }));
}`;

const RESTORED = `([sid, chunks]) => {
    (window.__socketHandlers['ssh_session_restored'] || []).forEach(cb => cb({
        snapshot_version: 1, session_id: sid, host: 'b4.example', port: 22,
        username: 'b4', auth_type: 'key', key_id: 'k1', connected: true,
        display_name: 'B4', tmux_session_name: 'sshdeck_b4', use_tmux: true,
        pane_index: 0, replay_total_chunks: chunks.length,
        replay_truncated: false, replay_dropped_bytes: 0,
        replay_history_lines: 400,
        pty_cols: 80, pty_rows: 47, replay_max_lines: 5000,
    }));
}`;

const REPLAY = `([sid, chunks]) => {
    chunks.forEach((data, i) => {
        (window.__socketHandlers['ssh_replay_chunk'] || []).forEach(cb => cb({
            session_id: sid, seq: i + 1, total: chunks.length, data,
            final: i + 1 === chunks.length, truncated: false, dropped_bytes: 0,
        }));
    });
}`;

const LIVE_FRAME = `([sid, data]) => {
    (window.__socketHandlers['ssh_output'] || []).forEach(cb => cb({
        session_id: sid, data,
    }));
}`;

const INSPECT = `([sid, needles]) => {
    const keys = TerminalManager.sessionTerminals[sid] || [];
    if (keys.length === 0) return { missing: true };
    const terminal = TerminalManager.terminals[keys[0]];
    const buf = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
        const t = (buf.getLine(i)?.translateToString(true) || '').trim();
        if (t !== '') lines.push(t);
    }
    const found = {};
    (needles || []).forEach(n => { found[n] = lines.some(l => l.includes(n)); });
    return {
        bufferType: buf.type, baseY: buf.baseY, bufferLength: buf.length,
        rows: terminal.rows, scrollbackCapacity: terminal.options.scrollback,
        nonEmptyLines: lines.length,
        firstLine: lines[0] || null,
        lastLine: lines[lines.length - 1] || null,
        replayOpen: !!(TerminalManager.replayState[sid]
            && TerminalManager.replayState[sid].open),
        found,
    };
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

// ── §B0 the SERVER's stream has the shape the mechanism depends on ──────────
{
    console.log('\n--- §B0 the injected bytes, as the server produces them');
    const lines = LINE_STREAM.split('\r\n').filter(l => l !== '');
    check('§B0 the server\'s history stream contains NO escape bytes',
        LINE_STREAM.includes('\x1b'), false);
    check('§B0 every line is CRLF-terminated (no bare LF survives)',
        LINE_STREAM.replace(/\r\n/g, '').includes('\n'), false);
    check(`§B0 it carries the whole transcript (${lines.length} lines)`,
        lines.length, 400);
    check('§B0 oldest first', lines[0], 'HXLINE-0001');
    check('§B0 newest last', lines[lines.length - 1], 'HXLINE-0400');
}

// ── §B1 the DEFECT: a tmux repaint cannot fill the scrollback ───────────────
{
    console.log('\n--- §B1 a cursor-addressed REPAINT leaves the scrollback empty');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 0]);
    await page.waitForTimeout(400);
    await page.evaluate(new Function('return ' + LIVE_FRAME)(), [SID, REPAINT]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['HXLINE-0001', 'HXLINE-0400']]);
    console.log('    ' + JSON.stringify(m));
    check(`§B1 the repaint fills at most one viewport `
        + `(${m.nonEmptyLines} non-empty vs ${m.rows} rows)`,
        m.nonEmptyLines <= m.rows, true);
    check(`§B1 nothing scrolled off the top (baseY ${m.baseY})`, m.baseY, 0);
    check('§B1 the OLDEST line is NOT reachable — this is the Owner\'s '
        + 'complaint, reproduced', m.found['HXLINE-0001'], false);
    check(`§B1 the capacity is large and unused (${m.scrollbackCapacity})`,
        m.scrollbackCapacity >= 1000, true);
    check('§B1 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B2 the MECHANISM: a line stream does fill the scrollback ───────────────
{
    console.log('\n--- §B2 the same 400 lines as a LINE STREAM');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 1]);
    await page.waitForTimeout(400);
    await page.evaluate(new Function('return ' + REPLAY)(), [SID, [LINE_STREAM]]);
    await page.waitForTimeout(1700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['HXLINE-0001', 'HXLINE-0400']]);
    console.log('    ' + JSON.stringify(m));
    check('§B2 the line stream lands on the NORMAL buffer', m.bufferType, 'normal');
    check(`§B2 lines really scrolled off the top (baseY ${m.baseY})`,
        m.baseY > 0, true);
    check(`§B2 several hundred lines are reachable (${m.nonEmptyLines})`,
        m.nonEmptyLines >= 400, true);
    check('§B2 the OLDEST line is reachable in scrollback',
        m.found['HXLINE-0001'], true);
    check('§B2 the newest line is reachable', m.found['HXLINE-0400'], true);
    check('§B2 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B3 RESTORE: history ahead of the gap buffer, one sequence ──────────────
{
    console.log('\n--- §B3 RESTORE delivers history then the gap buffer');
    const { ctx, page, errors } = await openPage();
    // Exactly the server's composition: history first, then the live tail the
    // old tab missed, chunked as the wire chunks it.
    const combined = LINE_STREAM + 'GAPTAIL-1\r\nGAPTAIL-2\r\n';
    const chunks = [];
    for (let i = 0; i < combined.length; i += 32768) {
        chunks.push(combined.slice(i, i + 32768));
    }
    await page.evaluate(new Function('return ' + RESTORED)(), [SID, chunks]);
    await page.waitForTimeout(400);
    await page.evaluate(new Function('return ' + REPLAY)(), [SID, chunks]);
    await page.waitForTimeout(1700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['HXLINE-0001', 'HXLINE-0400', 'GAPTAIL-2']]);
    console.log('    ' + JSON.stringify(m));
    check('§B3 the restored transcript lands on the NORMAL buffer',
        m.bufferType, 'normal');
    check(`§B3 the oldest HISTORY line is reachable after a reload`,
        m.found['HXLINE-0001'], true);
    check('§B3 the gap-buffer tail is reachable too', m.found['GAPTAIL-2'], true);
    check('§B3 the gap tail is the NEWEST content, i.e. the order is '
        + 'oldest-first', m.lastLine, 'GAPTAIL-2');
    check('§B3 the replay window closed', m.replayOpen, false);
    check('§B3 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B4 ATTACH: ssh_connected opens the window, history lands in scrollback ──
{
    console.log('\n--- §B4 ATTACH: the connect path opens a replay window');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 1]);
    await page.waitForTimeout(300);
    const opened = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, []]);
    await page.evaluate(new Function('return ' + REPLAY)(), [SID, [LINE_STREAM]]);
    await page.waitForTimeout(1700);
    // tmux's reattach repaint arrives as ordinary live output afterwards, and
    // must land on top of the history rather than under it.
    await page.evaluate(new Function('return ' + LIVE_FRAME)(), [SID, REPAINT]);
    await page.waitForTimeout(700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['HXLINE-0001', 'HXLINE-0400']]);
    console.log('    window ' + JSON.stringify(opened));
    console.log('    after  ' + JSON.stringify(m));
    check('§B4 ssh_connected with a chunk count OPENS the replay window',
        opened.replayOpen, true);
    check('§B4 the window closed once the final chunk landed', m.replayOpen, false);
    check('§B4 the attached history lands on the NORMAL buffer',
        m.bufferType, 'normal');
    check(`§B4 the history is in scrollback (baseY ${m.baseY})`,
        m.baseY > 0, true);
    check('§B4 the OLDEST history line is reachable after an ATTACH',
        m.found['HXLINE-0001'], true);
    check('§B4 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B5 ATTACH with no history opens no window at all ───────────────────────
{
    console.log('\n--- §B5 a connect with no history is unchanged');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 0]);
    await page.waitForTimeout(300);
    const opened = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, []]);
    // The row that matters: with no window, live output must paint IMMEDIATELY.
    // An unbalanced window would queue it forever and freeze a fresh session.
    await page.evaluate(new Function('return ' + LIVE_FRAME)(),
        [SID, 'FRESH-PROMPT$ \r\n']);
    await page.waitForTimeout(700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['FRESH-PROMPT']]);
    console.log('    ' + JSON.stringify(m));
    check('§B5 no replay window is opened when there is no history',
        opened.replayOpen, false);
    check('§B5 live output paints at once instead of queueing',
        m.found['FRESH-PROMPT'], true);
    check('§B5 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B6 the B4-STRICT floor, measured on the client ─────────────────────────
{
    console.log('\n--- §B6 B4-STRICT: >= 100 non-empty lines reachable');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 1]);
    await page.waitForTimeout(300);
    await page.evaluate(new Function('return ' + REPLAY)(), [SID, [LINE_STREAM]]);
    await page.waitForTimeout(1700);
    await page.evaluate(new Function('return ' + LIVE_FRAME)(), [SID, REPAINT]);
    await page.waitForTimeout(700);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, ['HXLINE-0100', 'HXLINE-0300']]);
    console.log('    ' + JSON.stringify(m));
    check(`§B6 B4-STRICT floor: >= 100 non-empty lines reachable `
        + `(${m.nonEmptyLines})`, m.nonEmptyLines >= 100, true);
    check('§B6 a line 300 back is reachable (the Owner\'s "several hundred")',
        m.found['HXLINE-0100'], true);
    check('§B6 a line 100 back is reachable', m.found['HXLINE-0300'], true);
    check('§B6 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

// ── §B7 the capacity is derived on the ATTACH path too ──────────────────────
{
    console.log('\n--- §B7 scrollback capacity is derived from the server cap');
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + CONNECTED)(), [SID, 1]);
    await page.waitForTimeout(300);
    const m = await page.evaluate(new Function('return ' + INSPECT)(),
        [SID, []]);
    console.log('    ' + JSON.stringify(m));
    // The number the server announced is 5000; the client's ceiling may be
    // lower, but it must be far above one viewport or the attach would fetch
    // history and immediately evict it.
    check(`§B7 the attached terminal's capacity holds the delivered history `
        + `(${m.scrollbackCapacity})`, m.scrollbackCapacity >= 1000, true);
    check('§B7 no page errors', errors.slice(0, 2), []);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail > 0 ? 1 : 0);



