/*
 * S16 defect D4 — scrollback must survive a reload.
 *
 * Owner report (deployed S15): the pre-S15 "scrollback lost on reload" bug is
 * back. Answers Q-D4: BOTH affected sessions are tmux-backed
 * (TMUX_ENABLED/TMUX_DEFAULT true, history-limit 50000), and ONE of them sits
 * in an ALTERNATE-SCREEN TUI at reload time (alternate_on=1) -- so the restore
 * matrix must cover the alt-screen case as well as truncated replay and the
 * gesture-authority lifecycle (addition D).
 *
 * What the restore path really does (read from source):
 *   - `build_replay_chunks` replays the server's GAP BUFFER, newest-first
 *     trimmed to REPLAY_MAX_BYTES=256KB / REPLAY_MAX_LINES=5000, and flags
 *     `truncated`;
 *   - the client sanitizes ONLY a truncated replay: it strips alt-screen
 *     switches, and `finishReplay` writes an explicit `\x1b[?1049l` belt and
 *     marks provenance untrusted -- all inside `if (replay.truncated)`;
 *   - a CLEAN replay is written byte-for-byte with NO belt at all;
 *   - for a tmux session one `refresh-client` follows the terminator, which
 *     repaints ONE SCREEN -- it is not history.
 *
 * Sections:
 *   §A1 ALT-SCREEN RESTORE, clean replay: a replay whose bytes leave the engine
 *       on the alternate buffer must not strand the restored history where it
 *       cannot be scrolled to. The alternate buffer has NO scrollback by
 *       definition, so every restored line is unreachable.
 *   §A2 the same replay declared TRUNCATED: the sanitizer + `?1049l` belt
 *       already handle it. Control row -- it shows the gap is the CLEAN path.
 *   §H1 TRUNCATED replay of a tmux session: the trimmed history is gone and no
 *       repaint brings it back (the repaint is one screen). Measures how many
 *       of the session's lines are actually reachable after restore.
 *   §G1 after a local-scroll touch gesture ENDS, the viewport must be free: a
 *       later programmatic scroll must not be snapped back by the permanently
 *       armed reconciler (gestureAuthRow lifecycle, audit candidate G2).
 *   §Z  zero page errors.
 *
 * Evidence is written to /tmp/s16work/d4_restore_matrix.json.
 *
 * Run: node tests/browser/s16_d4_scrollback_restore.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = '/tmp/s16work';
let pass = 0;
let fail = 0;
const evidence = {};

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
    window.__wire = [];
    window.socket = {
        connected: true, id: 'sock-s16d4-1',
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop,
        emit: (name, payload) => { window.__wire.push({ name, payload }); },
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SID = 'S16-D4-1';

/*
 * The RESTORE path exactly as production runs it: the early app.js listeners
 * buffer `ssh_session_restored` / `ssh_replay_chunk` until SessionManager is
 * initialized, then `restoreSession` opens the replay window and
 * `acceptReplayChunk` sequences the chunks. Delivering through those same
 * handlers is what makes this a restore rather than a plain write.
 */
const RESTORE = `(args) => {
    const [sid, chunks, truncated, droppedBytes, ptyCols, ptyRows,
           replayMaxLines] = args;
    (window.__socketHandlers['ssh_session_restored'] || []).forEach(cb => cb({
        session_id: sid, host: 'd4.example', port: 22, username: 'd4',
        auth_type: 'key', key_id: 'k1', jump_host_id: null,
        display_name: 'D4', connected: true, is_persistent_candidate: true,
        tmux_session_name: 'sshdeck_d4', use_tmux: true, pane_index: 0,
        replay_total_chunks: chunks.length,
        replay_truncated: truncated, replay_dropped_bytes: droppedBytes,
        pty_cols: ptyCols, pty_rows: ptyRows,
        // S16 D4-H1: the server's replay LINE cap. The client derives its
        // scrollback default from it, so it is part of the snapshot contract.
        replay_max_lines: replayMaxLines === undefined ? 5000 : replayMaxLines,
    }));
    chunks.forEach((data, i) => {
        (window.__socketHandlers['ssh_replay_chunk'] || []).forEach(cb => cb({
            session_id: sid, seq: i + 1, total: chunks.length, data,
            final: i + 1 === chunks.length,
            truncated, dropped_bytes: droppedBytes,
        }));
    });
}`;

// What the restored terminal can actually SHOW the user.
const INSPECT = `(sid) => {
    const key = TerminalManager.sessionTerminals[sid][0];
    const terminal = TerminalManager.terminals[key];
    const buf = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
        const l = buf.getLine(i);
        const t = l ? l.translateToString(true) : '';
        if (t.trim() !== '') lines.push(t.trim());
    }
    return {
        bufferType: buf.type,
        baseY: buf.baseY,
        viewportY: buf.viewportY,
        bufferLength: buf.length,
        rows: terminal.rows,
        scrollbackCapacity: terminal.options.scrollback,
        reachableLines: lines.length,
        firstLine: lines[0] || null,
        lastLine: lines[lines.length - 1] || null,
        hasFirst: lines.some(t => t.includes('HISTORY-0001')),
        hasLast: lines.some(t => t.includes('HISTORY-0400')),
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
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.waitForTimeout(120);
    return { ctx, page, errors };
}

// 400 numbered lines of history, then the TUI takes the screen: the alternate
// switch arrives with the history already behind it, which is what a session
// sitting in vim/less at reload replays.
const HISTORY = Array.from({ length: 400 },
    (_, i) => `HISTORY-${String(i + 1).padStart(4, '0')} output line\r\n`).join('');
const TUI_ENTER = '\x1b[?1049h\x1b[H\x1b[2J~ TUI screen ~\r\n';

// ── §A1 alt-screen restore on a CLEAN replay ────────────────────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [HISTORY + TUI_ENTER], false, 0, 51, 46]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(), SID);
    evidence.a1_clean_altscreen = m;
    console.log('    §A1', JSON.stringify(m));
    check('§A1 a clean replay does not strand the terminal on the alternate buffer',
        m.bufferType, 'normal');
    check('§A1 the restored history is reachable (first line)', m.hasFirst, true);
    check('§Z no page errors (A1)', errors, []);
    await ctx.close();
}

// ── §A2 the same replay declared TRUNCATED: control row ─────────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [HISTORY + TUI_ENTER], true, 4096, 51, 46]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(), SID);
    evidence.a2_truncated_altscreen = m;
    console.log('    §A2', JSON.stringify(m));
    check('§A2 a truncated replay is brought back to the normal buffer',
        m.bufferType, 'normal');
    check('§Z no page errors (A2)', errors, []);
    await ctx.close();
}

// ── §H1 how much of a CLEAN replay the client can actually hold ─────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [HISTORY], false, 0, 51, 46]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(), SID);
    evidence.h1_clean_capacity = { sentLines: 400, ...m };
    console.log('    §H1', JSON.stringify(evidence.h1_clean_capacity));
    /*
     * The client's OWN scrollback cap, not the server's trim, is the second
     * loss. Measured RED before S5: `sanitizeScrollback` defaulted to a hard
     * SCROLLBACK_DEFAULT = 150 lines when nothing is stored in localStorage,
     * while the server is willing to replay REPLAY_MAX_LINES = 5000 and tmux
     * holds history-limit = 50000. A restore carrying 400 lines kept only the
     * last 150 plus one screen (measured: 195 reachable of 400); the rest was
     * dropped by xterm ON WRITE, and no repaint brings it back
     * (refresh-client repaints ONE screen).
     *
     * S16 D4-H1 fixed it by DERIVING the default from the server's cap, which
     * the snapshot now carries as `replay_max_lines` -- so this row also proves
     * the derivation end to end: the capacity in the measurement below comes from
     * the field this very restore delivered, not from a constant. The contract it
     * states is the owner's: what the server was willing to replay must be
     * reachable.
     */
    check('§H1 the capacity came from the snapshot\'s replay cap (derived)',
        m.scrollbackCapacity, 5000);
    // Non-vacuity for the row above: 5000 is also the compile-time fallback, so
    // on its own it cannot tell "read from the snapshot" from "never read it".
    // §H3 below restores with a DIFFERENT cap and must follow it.

    check('§H1 the whole clean replay is reachable, not just the last screenful',
        m.hasFirst, true);
    check('§H1 the newest line is present', m.hasLast, true);
    check('§Z no page errors (H1)', errors, []);
    await ctx.close();
}

// ── §H3 the derived capacity really follows the snapshot ────────────────────
{
    const { ctx, page, errors } = await openPage();
    // A cap that is neither the compile-time fallback (5000), nor the range
    // bounds (50/10000), nor the old hard default (150): only a client that
    // actually read the field can produce it.
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [HISTORY], false, 0, 51, 46, 900]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(), SID);
    evidence.h3_derived_capacity = { announcedCap: 900, ...m };
    console.log('    §H3', JSON.stringify(evidence.h3_derived_capacity));
    check('§H3 the terminal capacity is the cap the snapshot announced',
        m.scrollbackCapacity, 900);
    check('§H3 which is not the compile-time fallback',
        m.scrollbackCapacity !== 5000, true);
    check('§H3 the replay is still fully reachable at that capacity',
        m.hasFirst && m.hasLast, true);
    check('§Z no page errors (H3)', errors, []);
    await ctx.close();
}

// ── §H2 server-trimmed replay: what arrives must survive ────────────────────
{
    const { ctx, page, errors } = await openPage();
    // The server trimmed the front: chunk 1 opens mid-history, exactly what
    // build_replay_chunks produces once the gap buffer passes 256KB. The
    // dropped prefix is legitimately gone; everything the server DID send
    // must be reachable.
    const trimmed = HISTORY.slice(HISTORY.indexOf('HISTORY-0300'));
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [trimmed], true, 262144, 51, 46]);
    await page.waitForTimeout(900);
    const m = await page.evaluate(new Function('return ' + INSPECT)(), SID);
    evidence.h2_truncated_history = { sentLines: 101, ...m };
    console.log('    §H2', JSON.stringify(evidence.h2_truncated_history));
    check('§H2 the first line the server did send is reachable',
        m.firstLine, 'HISTORY-0300 output line');
    check('§H2 the newest line is present', m.hasLast, true);
    check('§Z no page errors (H2)', errors, []);
    await ctx.close();
}

// ── §G1 the gesture authority must not outlive the gesture ──────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + RESTORE)(),
        [SID, [HISTORY], false, 0, 51, 46]);
    await page.waitForTimeout(900);

    // A local-scroll swipe: touchstart, three vertical moves past the 10px
    // threshold, then touchend -- the shipped sequence that arms the
    // reconciler and then must release it.
    const g = await page.evaluate((sid) => {
        const key = TerminalManager.sessionTerminals[sid][0];
        const terminal = TerminalManager.terminals[key];
        const wrapper = TerminalManager.terminalContainers[sid];
        const rect = wrapper.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const mk = (type, y) => {
            const t = new Touch({ identifier: 1, target: wrapper,
                clientX: x, clientY: y });
            return new TouchEvent(type, {
                bubbles: true, cancelable: true,
                touches: type === 'touchend' ? [] : [t],
                targetTouches: type === 'touchend' ? [] : [t],
                changedTouches: [t],
            });
        };
        terminal.scrollToBottom();
        const startY = rect.top + rect.height / 2;
        wrapper.dispatchEvent(mk('touchstart', startY));
        for (const dy of [40, 80, 120]) {
            wrapper.dispatchEvent(mk('touchmove', startY + dy));
        }
        const duringGesture = terminal.buffer.active.viewportY;
        wrapper.dispatchEvent(mk('touchend', startY + 120));
        return { duringGesture, baseY: terminal.buffer.active.baseY };
    }, SID);
    await page.waitForTimeout(200);

    // The gesture is over. A programmatic scroll (the scrollbar drag, the
    // Settings jump, any app-owned move) must be honoured, not snapped back.
    const g2 = await page.evaluate((sid) => {
        const key = TerminalManager.sessionTerminals[sid][0];
        const terminal = TerminalManager.terminals[key];
        const before = terminal.buffer.active.viewportY;
        terminal.scrollToTop();
        return { before, afterTop: terminal.buffer.active.viewportY };
    }, SID);
    await page.waitForTimeout(300);
    const g3 = await page.evaluate((sid) => {
        const key = TerminalManager.sessionTerminals[sid][0];
        return TerminalManager.terminals[key].buffer.active.viewportY;
    }, SID);
    evidence.g1_gesture_lifecycle = { ...g, ...g2, settled: g3 };
    console.log('    §G1', JSON.stringify(evidence.g1_gesture_lifecycle));
    check('§G1 a programmatic scroll after touchend reaches the top',
        g2.afterTop, 0);
    check('§G1 and is not snapped back a frame later', g3, 0);
    check('§Z no page errors (G1)', errors, []);
    await ctx.close();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, 'd4_restore_matrix.json');
fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(`\n--- evidence written to ${file}`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
