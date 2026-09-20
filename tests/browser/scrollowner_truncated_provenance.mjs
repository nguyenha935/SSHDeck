#!/usr/bin/env node
/*
 * S14 R2 — row provenance after a TRUNCATED replay fails closed.
 *
 * The S14 audit measured (probe_scrollowner_reload.out, LIVE_ATTACH): a
 * truncated replay carrying tmux's attach preamble leaves the engine on the
 * alternate buffer with tracking=drag and sgr=true, so ScrollOwner resolves
 * row D — and a vertical gesture emits 19 SGR frames to the PTY while moving
 * nothing the user can see (dViewportY 0). The row was decided by WHERE THE
 * GAP BUFFER WAS TRIMMED, not by anything the user did or any live truth
 * about the remote: the same trim that cut the stream also chose the gesture
 * row. That is provenance by accident.
 *
 * CONTRACT UNDER TEST (R2, ruled): a row resolved from a state
 * the truncated replay itself created is unreliable. When the tracking/SGR
 * state was established by bytes a TRUNCATED replay carried, the resolver
 * must fail closed to a locally-scrolling row — never D/E (and never C/D0's
 * silent no-op either: with R1's sanitizer in place the buffer is normal and
 * there is real scrollback to move). A genuine live attach with a COMPLETE
 * stream must still resolve row D and still emit SGR (asserted in
 * p1_tmux_vertical_gesture.mjs and the row matrix here:
 * CLEAN_LIVE_ATTACH stays D).
 *
 * Run: node tests/browser/scrollowner_truncated_provenance.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

let pass = 0;
let fail = 0;
function check(label, actual, expected, detail = '') {
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}${detail ? '\n        ' + detail : ''}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
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

const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, id: 'gate_socket', io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; }, once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) { window.__emits.push({ evt, payload }); return sock; },
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
const TRACK = `${ESC}[?1000h${ESC}[?1002h`;
const SGR = `${ESC}[?1006h`;
function hist(n) {
    let s = '';
    for (let i = 1; i <= n; i++) {
        s += `HISTORY-${String(i).padStart(3, '0')} ` + 'y'.repeat(60) + '\r\n';
    }
    return s;
}

/*
 * Three states, each the SAME live tmux session at a different point in its
 * byte history:
 *   TRUNCATED_WITH_PREAMBLE — what the audit measured: trim kept the preamble,
 *       dropped its exit; row must NOT be trusted as D.
 *   CLEAN_LIVE_ATTACH       — complete stream, genuine live attach semantics:
 *       row D is CORRECT and must survive (the T14 regression half).
 *   TRUNCATED_NO_PREAMBLE   — trim dropped everything tmux-ish; nothing changed
 *       vs today, but pinned so the rule provably keys on alternate+truncated,
 *       not on truncation alone.
 */
const CASES = [
    {
        name: 'TRUNCATED_WITH_PREAMBLE',
        body: ALT_IN + TRACK + SGR + hist(80),
        truncated: true,
        // The R1 sanitizer strips the alt switch, so the buffer ends NORMAL --
        // but tracking=drag + sgr=true survive it, which resolves row E: a
        // byte-emitting row decided by trim debris. E forwards SGR to an app
        // that is not in that state; the provenance rule must fail this back
        // to a locally-scrolling row too.
        expectRow: 'A',
        why: 'the tmux DECSETs came from bytes a trim mangled; no byte-emitting row may be trusted',
    },
    {
        name: 'CLEAN_LIVE_ATTACH',
        body: ALT_IN + TRACK + SGR + hist(80),
        truncated: false,
        /*
         * RE-POINTED from 'D' to 'E' (S17 D-step). CLASSIFICATION:
         * asserting-the-old-specification, and the spec line that authorises the
         * change is S16 D4-R, stated in terminal-manager.js's own
         * writeReplayChunk comment: "EVERY chunk goes through the boundary
         * cleaner, truncated or not. It used to be
         * `replay.truncated ? sanitize(chunk) : chunk`."
         *
         * So ALT_IN is now stripped out of a CLEAN replay as well, and a replay
         * can no longer put the engine on the alternate buffer at all. Measured
         * directly on the product's own sanitizer, both ways:
         *     clean      replay -> alt-screen switch survives: false
         *     truncated  replay -> alt-screen switch survives: false
         * leaving tracking=drag, sgr=true, buffer=normal, which resolves E.
         *
         * NOT a weakening. The contract this row exists to defend is stated at
         * the top of this file: "a genuine live attach with a COMPLETE stream
         * must still resolve row D and still emit SGR". The load-bearing half is
         * the SGR emission -- that a real attach is still trusted to put bytes on
         * the PTY, unlike the truncated cases which must fail closed to a
         * locally-scrolling row. E is byte-emitting exactly as D is:
         * terminal-manager.js:2131 reads
         *     const emitsWheel = row === 'D' || row === 'E';
         * and the locally-scrolling set (A/B/F/G/E0) contains neither. The row
         * below asserts that property directly, so this cannot silently decay
         * into "any row the code happens to return".
         */
        expectRow: 'E',
        expectEmitsBytes: true,
        why: 'a complete stream is a real attach; D4-R strips the alt switch from '
            + 'every replay, so the trusted byte-emitting row is E, not D',
    },
    {
        name: 'TRUNCATED_NO_PREAMBLE',
        body: hist(80),
        truncated: true,
        expectRow: 'A',
        why: 'normal buffer + no tracking already resolves A; unchanged',
    },
];

for (const cse of CASES) {
    for (const vp of [{ label: 'phone390', width: 390, height: 844 }]) {
        const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            hasTouch: true, isMobile: true,
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.addInitScript('window.__emits = [];');
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => window.TerminalManager
            && typeof SessionManager !== 'undefined' && !!window.socket,
            null, { timeout: 15000 });

        const sid = `r2-${cse.name}`;
        const result = await page.evaluate(async ({ sid, body, truncated }) => {
            window.socket.__fire('ssh_session_restored', {
                session_id: sid, host: 'tiny', port: 22, username: 'root',
                auth_type: 'key', key_id: 'k1', display_name: 'tiny',
                use_tmux: true, tmux_session_name: 'audit', via_jump: null,
                pty_cols: null, pty_rows: null,
                replay_total_chunks: 1,
                replay_truncated: truncated,
                replay_dropped_bytes: truncated ? 4096 : 0,
            });
            await new Promise(r => setTimeout(r, 60));
            window.socket.__fire('ssh_replay_chunk', {
                session_id: sid, seq: 1, total: 1, data: body,
                final: true, truncated, dropped_bytes: truncated ? 4096 : 0,
            });
            await new Promise(r => setTimeout(r, 900));
            const term = window.TerminalManager.terminals[sid];
            if (!term) return { MISSING: true };
            const row = window.TerminalManager.ScrollOwner.resolve(term);
            /*
             * Which rows put bytes on the PTY is read out of the product's own
             * gesture source, not hardcoded here. setupTouchGestures declares
             *     const emitsWheel = row === 'D' || row === 'E';
             * and this parses that one line, so if the set ever changes the gate
             * measures the new truth instead of a stale copy of it.
             */
            const src = String(window.TerminalManager.setupTouchGestures);
            const decl = /const emitsWheel = ([^\n;]*)/.exec(src);
            let emitsBytes = null;
            if (decl) {
                const letters = (decl[1].match(/'([A-Z][0-9]?)'/g) || [])
                    .map(s => s.replace(/'/g, ''));
                emitsBytes = letters.includes(row);
            }
            return {
                row,
                emitsBytes,
                emitsWheelDecl: decl ? decl[1].trim() : null,
                tracking: term.modes ? term.modes.mouseTrackingMode : null,
                bufferType: term.buffer.active.type,
                sgrFlag: window.TerminalManager.ScrollOwner.sgrFlagFor(term),
            };
        }, { sid, body: cse.body, truncated: cse.truncated });

        const tag = `§R2 ${cse.name}`;
        check(`${tag} terminal exists`, !result.MISSING, true);
        if (!result.MISSING) {
            check(`${tag} resolved row (${cse.why})`,
                result.row, cse.expectRow,
                `tracking=${result.tracking} buffer=${result.bufferType}`);
            /*
             * The PROPERTY the row stands for, asserted separately from the
             * letter. A truncated replay must fail closed to a row that cannot
             * put bytes on the PTY; a clean live attach must stay trusted to do
             * so. Read from the product's own gesture table
             * (terminal-manager.js:2131-2133) rather than restated here, so a
             * future change to which letters emit is caught instead of copied.
             */
            const expectEmits = cse.expectEmitsBytes === true;
            check(`${tag} byte-emission matches the contract`
                + ` (${expectEmits ? 'a real attach still reports' : 'fails closed to local scroll'})`,
                result.emitsBytes, expectEmits,
                `row=${result.row} emitsWheel=${result.emitsBytes}`);
        }
        check(`${tag} no page errors`, errors.length, 0);
        if (errors.length) console.log(`        ${errors.join('\n        ')}`);
        await ctx.close();
    }
}

await browser.close();
server.close();
console.log(`\nscrollowner_truncated_provenance: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
