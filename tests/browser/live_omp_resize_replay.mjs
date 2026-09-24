#!/usr/bin/env node
/*
 * A WIDTH CHANGE UNDER omp IS NOT SEEN RUNNING FROM THE TOP -- against a running build.
 *
 * Owner, 2026-09-24: "cứ chuyển đổi kích thước màn hình là vẫn bị nhảy giật
 * từ trên xuống khu sử dụng phiên OMP ... lúc bị lúc không nhưng tỷ lệ bị
 * nhảy giật giật 1 lúc mới trở lại bình thường khá là cao."
 *
 * omp (oh-my-pi) answers a width change by blanking to the alternate screen,
 * waiting out a 120 ms settle and replaying its WHOLE transcript at the new
 * width (tests/fixtures/fake_omp_resize.py stands in for it). Measured on the
 * tree before the fix, three runs each: a 13-step drag sent 1-3 ssh_resize and
 * cost 1-3 replays of 59-66 KB; the pane showed up to 7 different top rows
 * and up to 3 frames of transcript with no prompt on screen -- the replay
 * running past. After it: 0 such frames and 2 top rows (old frame, new frame)
 * in all six scenarios.
 *
 * Every frame is read from what is PAINTED: the cover when there is one,
 * otherwise the terminal's own rows.
 *
 *   §1 a drag: a replay really happened (floor), and no painted frame shows
 *      the transcript without the prompt (ceiling);
 *   §2 a single grow: the same;
 *   both: the settled pane is uncovered and shows the prompt.
 *
 * Run (from source/): node tests/browser/live_omp_resize_replay.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, login, connectSSH, settle } from './harness_live.mjs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}
// Run BY THE REMOTE SHELL: paths on the host this gate runs from.
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/fake_omp_resize.py');
const LOG = `/tmp/fake_omp_resize.${process.pid}.log`;
const transactions = () => {
    try {
        return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch { return []; }
};

const { browser, page } = await launch({ width: 1440, height: 900 });
let sid = null;
try {
    await login(page);
    sid = await connectSSH(page);
    await settle(page, sid);
    await page.waitForTimeout(1500);
    await page.evaluate(({ s, f, l }) => window.socket.emit('ssh_input',
        { session_id: s, data: `clear; FAKE_OMP_LOG=${l} python3 ${f}\n` }), { s: sid, f: FIXTURE, l: LOG });
    await page.waitForTimeout(5000);

    await page.evaluate((s) => {
        const rec = window.__rec = { frames: [] };
        const key = TerminalManager.sessionTerminals[s][0];
        const term = TerminalManager.terminals[key];
        const tick = () => {
            const cover = document.querySelector('.sshdeck-frozen-pane .xterm-rows');
            const rows = cover || term.element.querySelector('.xterm-rows');
            const lines = [...rows.children].map(r => r.textContent);
            const nums = lines.map(l => /transcript (\d{4})/.exec(l)).filter(Boolean).map(m => +m[1]);
            rec.frames.push({ covered: !!cover,
                top: nums.length ? Math.min(...nums) : null,
                prompt: lines.some(l => l.includes('omp-live prompt')) });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, sid);

    const scenario = async (label, widths) => {
        const before = transactions().length;
        await page.evaluate(() => { window.__rec.frames = []; });
        for (const w of widths) {
            await page.setViewportSize({ width: w, height: 900 });
            await page.waitForTimeout(40);
        }
        await page.waitForTimeout(6000);
        const frames = await page.evaluate(() => window.__rec.frames);
        const replays = transactions().slice(before).filter(t => t.replayed_rows > 0).length;
        const shown = frames.filter(f => !f.covered && f.top !== null);
        const last = frames[frames.length - 1];
        console.log(`      [${label}] ${frames.length} frames, ${replays} replay(s), `
            + `${new Set(shown.map(f => f.top)).size} painted top rows`);
        check(`${label}: omp really replayed its transcript`, replays > 0, true);
        check(`${label}: no painted frame shows the transcript without the prompt`,
            shown.filter(f => !f.prompt).length, 0);
        check(`${label}: the settled pane is uncovered and shows the prompt`,
            { covered: last.covered, prompt: last.prompt }, { covered: false, prompt: true });
    };
    const drag = [];
    for (let w = 1440; w >= 1080; w -= 30) drag.push(w);
    await scenario('§1 a drag', drag);
    await scenario('§2 a single grow', [1440]);
} finally {
    if (sid) {
        await page.evaluate(s => window.socket.emit('ssh_input', { session_id: s, data: '\x03' }), sid);
        await page.waitForTimeout(500);
        // Every session this page holds is the harness user's: leave no tmux garbage.
        const all = await page.evaluate(() => Object.keys(SessionManager.sessions || {}));
        for (const s of all) {
            await page.evaluate(x => window.socket.emit('ssh_disconnect', { session_id: x }), s);
            await page.waitForTimeout(700);
        }
    }
    try { fs.unlinkSync(LOG); } catch {}
    await browser.close();
}
console.log(`live_omp_resize_replay: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
