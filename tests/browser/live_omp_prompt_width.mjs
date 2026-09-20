#!/usr/bin/env node
/*
 * FULL-WIDTH EMOJI ROWS READ THE SAME IN THE ENGINE AS ON THE HOST -- against the deployed build.
 *
 * Reported with a screenshot: after the reconnect, the omp session's
 * prompt row was painted over every transcript row above it, fifty times; the
 * host pane (tmux capture-pane) held exactly one, and so did its scrollback.
 * The one inconsistency measured is the width table (unicode_width_tmux.mjs):
 * xterm's Unicode 6 drew that row a cell narrower than tmux. This gate holds
 * the row-exact contract on the real server with a stand-in for omp's screen
 * (tests/fixtures/fake_omp_prompt.py: full-width rows with the same emoji, a
 * box of the same shape, a transcript streaming under it).
 *
 * HONESTLY: on the build before the addon this gate PASSED -- neither the
 * attach repaint nor two viewport resize cycles under the stream reproduced
 * the owner's screen, and a 20s recording of what tmux sent a 167x48 client
 * replayed into a bare engine with zero drift on both width tables. So it
 * guards the contract; it is not the proof of the cause. The cause is still
 * open until the client stream of a real occurrence is captured -- which is
 * what the screen diagnostic (?kbdebug=1) now records.
 *
 *   §1 steady: every fixture row reads in the engine EXACTLY as on the host
 *      pane -- a count alone once passed a corrupted screen, and the host
 *      pane is the only honest reference (a fixture can dirty both sides
 *      alike);
 *   §2 the same after two viewport resize cycles while the fixture streams,
 *      which is the state the owner's screen broke in (a reconnect resized
 *      the pane 63 -> 61 -> 63 rows while omp was answering).
 *
 * Run (on the deploy host, from source/): node tests/browser/live_omp_prompt_width.mjs
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { launch, login, connectSSH, settle } from './harness_live.mjs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}
// The fixture is run BY THE REMOTE SHELL, so this is a path on the host
// this gate is run from -- resolved from the gate's own location rather
// than hard-coded to one deployment directory.
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/fake_omp_prompt.py');
const { browser, page } = await launch({ width: 1440, height: 900 });
let sid = null;
try {
    await login(page);
    sid = await connectSSH(page);
    await settle(page, sid);
    await page.waitForTimeout(1500);
    const tmux = await page.evaluate(s => SessionManager.sessions[s]?.tmuxSessionName, sid);
    await page.evaluate(({ s, f }) => window.socket.emit('ssh_input',
        { session_id: s, data: `python3 ${f}\n` }), { s: sid, f: FIXTURE });
    await page.waitForTimeout(5000);

    /*
     * BOTH SIDES MUST DESCRIBE THE SAME INSTANT. The fixture prints a
     * transcript line every 0.3s, and the engine snapshot and the host
     * capture are two calls: measured, a line landing between them read as
     * "the engine is one row behind" -- a replay of the recorded client
     * stream into a bare engine showed zero drift. So the fixture is stopped
     * (Ctrl-C) and the screen left to settle before either side is read.
     */
    const freeze = async () => {
        await page.evaluate(s => window.socket.emit('ssh_input', { session_id: s, data: '\x03' }), sid);
        await page.waitForTimeout(1500);
    };
    const restart = async () => {
        await page.evaluate(({ s, f }) => window.socket.emit('ssh_input',
            { session_id: s, data: `python3 ${f}\n` }), { s: sid, f: FIXTURE });
        await page.waitForTimeout(3000);
    };
    // The spinner is static once frozen, but masking it costs nothing and
    // keeps the comparison about rows, not ticks.
    const mask = l => l.replace(/[\u25d0-\u25d3]/g, '\u25cc');
    const own = l => /^row \d\d /.test(l) || /^transcript line \d+/.test(l)
        || l.startsWith('\u256d') || l.startsWith('\u2570');
    const compare = async (label) => {
        const engine = await page.evaluate(s => {
            const key = (TerminalManager.sessionTerminals[s] || [])[0];
            const t = TerminalManager.terminals[key];
            const b = t.buffer.active;
            const lines = [];
            for (let y = 0; y < t.rows; y++) lines.push((b.getLine(y)?.translateToString(true) || '').trimEnd());
            return { cols: t.cols, rows: t.rows, lines };
        }, sid);
        const host = execSync(`tmux capture-pane -p -t "=${tmux}:"`).toString().split('\n').map(l => l.trimEnd());
        const hostRows = host.filter(own).map(mask);
        const engineRows = engine.lines.filter(own).map(mask);
        const mismatches = hostRows.map((h, i) => [h, engineRows[i]])
            .filter(([h, e]) => h !== e)
            .map(([h, e]) => ({ host: h.slice(0, 44), engine: (e ?? null)?.slice(0, 44) ?? null }));
        console.log(`      [${label}] engine ${engine.cols}x${engine.rows}: ${engineRows.length} fixture rows; host ${hostRows.length}`);
        check(`${label}: the host pane holds fixture rows`, hostRows.length > 20, true);
        check(`${label}: the engine holds as many fixture rows as the host`, engineRows.length, hostRows.length);
        check(`${label}: every fixture row reads in the engine exactly as on the host`, mismatches.slice(0, 4), []);
    };
    await freeze();
    await compare('§1 steady');

    // The owner's screen broke right after a reconnect, while omp was
    // streaming: the log shows the pane resized 63 -> 61 -> 63 rows across
    // it. Same thing here, twice, with the fixture streaming underneath.
    await restart();
    for (let i = 0; i < 2; i++) {
        await page.setViewportSize({ width: 1440, height: 840 });
        await page.waitForTimeout(1500);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(2500);
    }
    await freeze();
    await compare('§2 after two resize cycles under a stream');
} finally {
    if (sid) {
        await page.evaluate(s => window.socket.emit('ssh_input', { session_id: s, data: '\x03' }), sid);
        await page.waitForTimeout(600);
        // Every session this page holds is the harness user's: leave no tmux garbage.
        const all = await page.evaluate(() => Object.keys(SessionManager.sessions || {}));
        for (const s of all) {
            await page.evaluate(x => window.socket.emit('ssh_disconnect', { session_id: x }), s);
            await page.waitForTimeout(700);
        }
    }
    await browser.close();
}
console.log(`live_omp_prompt_width: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
