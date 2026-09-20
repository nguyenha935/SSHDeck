#!/usr/bin/env node
/*
 * S14 R1 — replay PAINTEDNESS after a restore.
 *
 * The existing replay gates (test_replay_bounds.py, test_replay_delivery.py and
 * the browser ordering probes) all assert TRANSPORT properties: sequencing,
 * held chunks, the live queue, the truncation notice. Every one of them feeds
 * clean, self-consistent content. None asserts what the user actually sees.
 *
 * Production never sends clean content. `build_replay_chunks`
 * (app/ssh_manager.py) keeps the MOST RECENT output and trims from the FRONT,
 * and the deployed container's own logs show `replay_chunks 8,
 * replay_truncated true` on every restore. A front trim of a live tmux stream
 * cuts wherever the byte budget landed, so the replayed bytes can begin in the
 * middle of a CSI and can carry an alternate-screen ENTER whose matching EXIT
 * was in the discarded prefix.
 *
 * On RESTORE nothing reattaches (app/socket_events.py: "the SSH channel and its
 * tmux session are untouched -- nothing reattaches, so tmux emits no repaint"),
 * so those bytes are the only thing that ever paints the new heap's terminal.
 * Two measured consequences, both reported by the Owner as "history is missing
 * or blank after a mobile reload":
 *
 *   - an unpaired ?1049h leaves xterm on the ALTERNATE buffer, which has no
 *     scrollback, so the replayed history is written where it can never be
 *     scrolled to;
 *   - a truncated prefix can begin mid-CSI, so the first bytes xterm sees are
 *     the tail of a sequence it must not act on.
 *
 * CONTRACT ASSERTED HERE (client side, zero bytes to the remote):
 *   1. after a TRUNCATED replay the terminal is on the NORMAL buffer, whatever
 *      the trim left behind;
 *   2. the replayed history is REACHABLE -- it is in the scrollback, not on a
 *      buffer that cannot scroll;
 *   3. a clean (untruncated) replay is unchanged, and a replay whose prefix
 *      begins mid-CSI still paints its history.
 *
 * What this gate deliberately does NOT assert: that a tail ending in CUP+ED
 * shows text. Those bytes are tmux's own repaint prologue and the redraw that
 * followed them was in the trimmed prefix; only a real repaint can restore it,
 * which is R1b's server-side `refresh-client` and is asserted in pytest. A
 * browser gate cannot invent content the stream does not contain, and claiming
 * otherwise here would be a test asserting a fiction.
 *
 * Both viewports are exercised: mobile is the primary target of this product,
 * and the desktop row is the regression half.
 *
 * Run: node tests/browser/replay_paintedness.mjs   (from source/)
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
function checkAtLeast(label, actual, floor) {
    if (typeof actual === 'number' && actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual} >= ${floor})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

function renderTemplate(name) {
    let html = fs.readFileSync(path.join(ROOT, `templates/${name}.html`), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

/*
 * The socket fixture. app.js runs `window.socket = io(...)` at load, so `io`
 * must exist before it; every frame below is delivered through the app's OWN
 * handlers via __fire, never by calling TerminalManager directly -- the point
 * is to exercise the production restore path, not a shortcut into it.
 */
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, id: 'gate_socket', io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; }, once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) {
            window.__emits.push({ evt, payload });
            // Production answers each local ssh_resize with pty_geometry. The
            // replay gate must model that acknowledgement so live frames after
            // restore are not retained by S27's geometry hold in this fixture.
            if (evt === 'ssh_resize' && payload) {
                (handlers.pty_geometry || []).forEach(fn => fn({
                    session_id: payload.session_id,
                    cols: payload.cols, rows: payload.rows, applied: true,
                }));
            }
            return sock;
        },
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
            res.end(renderTemplate('index'));
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
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const ESC = '\u001b';
const ALT_IN = `${ESC}[?1049h`;
const MOUSE = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
const HIST_LINES = 120;
function hist(from, to) {
    let s = '';
    for (let i = from; i <= to; i++) {
        s += `HISTORY-${String(i).padStart(3, '0')}\r\n`;
    }
    return s;
}

/*
 * The five shapes a front trim can leave. Each is what the server would emit
 * for the SAME live tmux session cut at a different byte offset -- not five
 * hypotheses, five offsets.
 */
const SHAPES = [
    {
        name: 'ALT_PREAMBLE_KEPT',
        why: 'the trim kept ?1049h; its ?1049l was in the discarded prefix',
        truncated: true,
        body: ALT_IN + MOUSE + hist(1, HIST_LINES),
        expectHistoryInScrollback: 20,
    },
    {
        name: 'ALT_PREAMBLE_CUT',
        why: 'the trim removed ?1049h, so the bytes paint on the normal buffer',
        truncated: true,
        body: MOUSE + hist(1, HIST_LINES),
        expectHistoryInScrollback: 20,
    },
    {
        name: 'TRIM_MID_CSI',
        why: 'the cut landed inside a CSI, so the stream opens on its tail',
        truncated: true,
        body: `?1002h${MOUSE}${hist(1, HIST_LINES)}`,
        expectHistoryInScrollback: 20,
    },
    {
        name: 'ALT_ENTER_LAST',
        why: 'tmux re-entered the alternate screen near the end of the window',
        truncated: true,
        // No repaint follows on RESTORE, so the visible screen legitimately has
        // nothing on it; what must hold is that the history is still REACHABLE
        // rather than stranded on a buffer with no scrollback.
        body: hist(1, HIST_LINES) + ALT_IN + MOUSE,
        expectHistoryInScrollback: 20,
    },
    {
        name: 'ALT_COMBINED_DECSET_LAST',
        why: 'a COMBINED DECSET carries 1049 alongside other parameters '
           + '(?1000;1006;1049h), which the sanitizer\'s exact-match regex '
           + 'cannot see; only the finishReplay belt reads the engine\'s '
           + 'actual buffer, so this shape is the belt\'s own coverage',
        truncated: true,
        // Same geometry as ALT_ENTER_LAST -- history paints first, the switch
        // trails -- so the reachability floor still holds once the belt has
        // returned the engine to the normal buffer.
        body: hist(1, HIST_LINES) + `${ESC}[?1000;1006;1049h`,
        expectHistoryInScrollback: 20,
    },
    {
        name: 'CLEAN_UNTRUNCATED',
        why: 'regression half: an untruncated replay must be untouched',
        truncated: false,
        body: hist(1, HIST_LINES),
        expectHistoryInScrollback: 20,
    },
];

const VIEWPORTS = [
    { label: 'phone390', width: 390, height: 844, touch: true },
    { label: 'desktop1440', width: 1440, height: 900, touch: false },
];

for (const vp of VIEWPORTS) {
    for (const shape of SHAPES) {
        const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            hasTouch: vp.touch, isMobile: vp.touch,
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.addInitScript('window.__emits = [];');
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => window.TerminalManager
            && typeof SessionManager !== 'undefined' && !!window.socket,
            null, { timeout: 15000 });

        const sid = `rp-${vp.label}-${shape.name}`;
        const result = await page.evaluate(
            async ({ sid, body, truncated }) => {
            window.socket.__fire('ssh_session_restored', {
                session_id: sid, host: 'tiny', port: 22, username: 'root',
                auth_type: 'key', key_id: 'k1', display_name: 'tiny',
                use_tmux: true, tmux_session_name: 'rp', via_jump: null,
                pty_cols: null, pty_rows: null,
                replay_total_chunks: 8,
                replay_truncated: truncated,
                replay_dropped_bytes: truncated ? 4096 : 0,
            });
            // Eight sequenced chunks split at even byte offsets, one every
            // 12ms, so the arrival pattern straddles attachTerminal's
            // double-rAF + 50ms readiness window exactly as production does.
            const per = Math.ceil(body.length / 8);
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 12));
                window.socket.__fire('ssh_replay_chunk', {
                    session_id: sid, seq: i + 1, total: 8,
                    data: body.slice(i * per, (i + 1) * per),
                    final: i === 7,
                    truncated,
                    dropped_bytes: truncated ? 4096 : 0,
                });
            }
            await new Promise(r => setTimeout(r, 900));

            const term = window.TerminalManager.terminals[sid];
            if (!term) return { MISSING: true };
            const buf = term.buffer.active;
            let lowest = null;
            let highest = null;
            // A CSI tail the trim failed to remove is painted as LITERAL text
            // at offset zero -- "?1002h" on line 0, ahead of HISTORY-001.
            // Reading line 0 (the first buffer row that carries any content)
            // makes the trim observable: with the trim it starts at
            // HISTORY-001; without it the junk precedes it.
            let firstPainted = null;
            for (let i = 0; i < buf.length; i++) {
                const line = buf.getLine(i);
                if (!line) continue;
                const text = line.translateToString(true);
                if (!text.trim()) continue;
                firstPainted = text;
                break;
            }
            for (let i = 0; i < buf.length; i++) {
                const line = buf.getLine(i);
                if (!line) continue;
                const m = /HISTORY-(\d+)/.exec(line.translateToString(true));
                if (!m) continue;
                const n = Number(m[1]);
                if (lowest === null || n < lowest) lowest = n;
                if (highest === null || n > highest) highest = n;
            }
            return {
                bufferType: buf.type,
                baseY: buf.baseY,
                bufferLength: buf.length,
                firstPainted,
                survivedCount: (lowest !== null && highest !== null)
                    ? highest - lowest + 1 : 0,
                // Zero bytes may reach the remote from a replay, ever.
                inputEmits: (window.__emits || [])
                    .filter(e => e.evt === 'ssh_input').length,
            };
        }, { sid, body: shape.body, truncated: shape.truncated });

        const tag = `§R1 ${vp.label} ${shape.name}`;
        check(`${tag} terminal exists`, !result.MISSING, true);
        if (!result.MISSING) {
            // (1) A truncated replay may not strand the terminal on the
            // alternate buffer -- that buffer has no scrollback, so anything
            // written there is unreachable (${shape.why}).
            check(`${tag} normal buffer`, result.bufferType, 'normal');
            // (1b) The leading partial-escape rule: a stream cut mid-CSI opens
            // on its TAIL (`?1002h`), and painting it as literal text puts
            // engine-visible junk in front of the history. Only TRIM_MID_CSI
            // exercises this boundary.
            if (shape.name === 'TRIM_MID_CSI') {
                check(`${tag} no CSI-tail junk painted`,
                    /^HISTORY-001/.test(result.firstPainted || ''), true);
            }
            // (2) The replayed history is reachable: it is in the scrollback.
            checkAtLeast(`${tag} history reachable (baseY)`,
                result.baseY, shape.expectHistoryInScrollback);
            checkAtLeast(`${tag} history lines present`,
                result.survivedCount, 100);
            // (3) A replay never writes to the remote.
            check(`${tag} zero bytes to remote`, result.inputEmits, 0);
        }
        check(`${tag} no page errors`, errors.length, 0);
        if (errors.length) console.log(`        ${errors.join('\n        ')}`);
        await ctx.close();
    }
}

/*
 * §R1-BELT — the one shape the sanitizer provably cannot cover.
 *
 * The sanitizer only ever sees bytes that arrive INSIDE the replay stream, and
 * a live frame that arrives while the window is open is QUEUED, not written
 * (writeOutput -> replay.liveQueue), so it cannot strand the engine mid-window
 * either. That leaves exactly one reachable way for finishReplay to find the
 * terminal on the alternate buffer, and it is a production shape:
 *
 *   the session is already LIVE and already inside a full-screen app (vim,
 *   less, htop -- the engine is on the alternate buffer from a live frame),
 *   and a TRUNCATED replay chunk then arrives for it. acceptReplayChunk opens
 *   a window implicitly rather than dropping history (:1917-1923), the
 *   sanitizer strips the switches inside the chunk -- and the engine was
 *   already stranded before the first replay byte, so nothing in the stream
 *   can bring it back.
 *
 * What must hold is NOT that the replayed history survives: it was written to
 * the alternate buffer, which has no scrollback, and no client-side filter can
 * retroactively move it. What must hold is that the user is returned to their
 * own normal buffer with the scrollback they had before the app opened. That
 * is the belt's entire job, and only the belt can do it.
 */
for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.touch, isMobile: vp.touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => window.TerminalManager
        && typeof SessionManager !== 'undefined' && !!window.socket,
        null, { timeout: 15000 });

    const sid = `rp-${vp.label}-BELT_LIVE_ALT_THEN_LATE_REPLAY`;
    const result = await page.evaluate(async ({ sid, hist }) => {
        // 1. Restore with nothing to replay, and let the explicit empty
        //    terminator close the window -- exactly what the server sends for
        //    a session with an empty gap buffer.
        window.socket.__fire('ssh_session_restored', {
            session_id: sid, host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'rp', via_jump: null,
            pty_cols: null, pty_rows: null,
            replay_total_chunks: 0,
            replay_truncated: false, replay_dropped_bytes: 0,
        });
        window.socket.__fire('ssh_replay_chunk', {
            session_id: sid, seq: 0, total: 0, data: '',
            final: true, truncated: false, dropped_bytes: 0,
        });
        await new Promise(r => setTimeout(r, 300));

        // 2. The session runs normally and builds real scrollback, then the
        //    user opens a full-screen app. Both arrive on the LIVE path, which
        //    is never sanitized -- writeOutput passes them straight through.
        window.socket.__fire('ssh_output', { session_id: sid, data: hist });
        await new Promise(r => setTimeout(r, 200));
        window.socket.__fire('ssh_output', {
            session_id: sid, data: '\u001b[?1049h\u001b[?1002h\u001b[?1006hVIM-SCREEN',
        });
        await new Promise(r => setTimeout(r, 200));
        const strandedBefore = window.TerminalManager.terminals[sid]
            ? window.TerminalManager.terminals[sid].buffer.active.type : null;

        // 3. A truncated replay chunk arrives for this already-live session.
        window.socket.__fire('ssh_replay_chunk', {
            session_id: sid, seq: 1, total: 1,
            data: 'LATE-REPLAY-TAIL\r\n',
            final: true, truncated: true, dropped_bytes: 4096,
        });
        await new Promise(r => setTimeout(r, 900));

        const term = window.TerminalManager.terminals[sid];
        if (!term) return { MISSING: true };
        const buf = term.buffer.active;
        let lowest = null;
        let highest = null;
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (!line) continue;
            const m = /HISTORY-(\d+)/.exec(line.translateToString(true));
            if (!m) continue;
            const n = Number(m[1]);
            if (lowest === null || n < lowest) lowest = n;
            if (highest === null || n > highest) highest = n;
        }
        return {
            strandedBefore,
            bufferType: buf.type,
            baseY: buf.baseY,
            survivedCount: (lowest !== null && highest !== null)
                ? highest - lowest + 1 : 0,
            inputEmits: (window.__emits || [])
                .filter(e => e.evt === 'ssh_input').length,
        };
    }, { sid, hist: hist(1, HIST_LINES) });

    const tag = `§R1-BELT ${vp.label} LIVE_ALT_THEN_LATE_REPLAY`;
    check(`${tag} terminal exists`, !result.MISSING, true);
    if (!result.MISSING) {
        // The premise: the engine really was stranded before the replay byte,
        // so this shape genuinely exercises the belt rather than a no-op.
        check(`${tag} engine was stranded first`, result.strandedBefore, 'alternate');
        // The belt's contract: back on the normal buffer.
        check(`${tag} normal buffer`, result.bufferType, 'normal');
        // And the user's OWN scrollback -- written before the app opened -- is
        // still there to scroll to.
        checkAtLeast(`${tag} pre-app scrollback reachable (baseY)`,
            result.baseY, 20);
        checkAtLeast(`${tag} pre-app history lines present`,
            result.survivedCount, 100);
        check(`${tag} zero bytes to remote`, result.inputEmits, 0);
    }
    check(`${tag} no page errors`, errors.length, 0);
    if (errors.length) console.log(`        ${errors.join('\n        ')}`);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\nreplay_paintedness: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
