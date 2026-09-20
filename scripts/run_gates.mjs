#!/usr/bin/env node
/*
 * Run the browser gates with a worker pool instead of one after another.
 *
 * WHY. The gates are 134 independent node processes, each driving its own
 * Chromium; running them serially is what made a full sweep a ~25 minute wait,
 * and a sweep nobody runs is a sweep that hides red rows (:
 * three gates had been red for days because the serial sweep was read in
 * fragments). Four workers is the machine's core count and holds well inside
 * memory -- a headless Chromium is ~200-300 MB and the host has 15 GB.
 *
 * The LIVE gates are excluded by default: they open real SSH sessions against
 * the owner's own hosts, trip the login rate limit when run together, and can
 * leave tmux sessions behind. Pass --live to include them (they then run one at
 * a time, after the rest).
 *
 * Usage:
 *   node scripts/run_gates.mjs                 every headless gate, 4 workers
 *   node scripts/run_gates.mjs -j 2            two workers
 *   node scripts/run_gates.mjs split_ orphans  only gates whose name matches
 *   node scripts/run_gates.mjs --live          include the live gates, serially
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'tests/browser');
const args = process.argv.slice(2);
const wantLive = args.includes('--live');
const jIndex = args.indexOf('-j');
const workers = jIndex !== -1 ? Math.max(1, parseInt(args[jIndex + 1], 10) || 1)
    : Math.min(4, Math.max(1, os.cpus().length));
// `-j N` takes the next argument; everything else that is not a flag is a
// name filter. (jIndex is -1 when -j is absent, so the guard matters: the
// bare index arithmetic swallowed the first filter.)
const filters = args.filter((a, i) => !a.startsWith('-')
    && !(jIndex !== -1 && i === jIndex + 1));

// A gate is a .mjs file that RUNS. The shared modules the gates import are not
// gates: harness_live.mjs, s35_live_login.mjs, live_creds.mjs export helpers,
// and a file named *_head/helpers is a fragment.
const SHARED = /^(harness_live|s35_live_login|live_creds)\.mjs$/;
/*
 * A gate is LIVE when it opens a real SSH session, or needs one to already be
 * open. Those are excluded by default and run one at a time with --live: they
 * share one account (which rate-limits at about five logins a minute), they
 * touch the owner's own hosts, and some of them can only reattach a session
 * that a person left behind. `two_device_live` is the clearest case -- it
 * refuses outright with "khong co session connected va cung khong co offer"
 * when nothing is attached, which is an environment fact, not a red build.
 * The `probe*` files are one-off investigation scripts kept for provenance,
 * not gates; they take arguments and are never part of a sweep.
 */
const LIVE = /^(live_|s35_p91_|w5_partG_|probe\d+|two_device_live|typing_order_live)/;
// Not a gate on its own: it EMITS a computed-style baseline (--emit) and
// compares a later run against it (--against FILE). With neither flag it has
// nothing to compare and exits non-zero by design, so a sweep that included it
// would report a red build on every run. Name it explicitly to run it.
const NEEDS_ARGS = /^t_css1_computed_parity\.mjs$/;
const all = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.mjs') && !SHARED.test(f))
    .filter(f => filters.length > 0 || !NEEDS_ARGS.test(f))
    .filter(f => filters.length === 0 || filters.some(x => f.includes(x)))
    .sort();
const headless = all.filter(f => !LIVE.test(f));
const live = all.filter(f => LIVE.test(f));
const queue = wantLive ? [...headless, ...live] : headless;

if (queue.length === 0) {
    console.log('no gate matched');
    process.exit(1);
}
console.log(`${queue.length} gate, ${workers} worker`
    + (wantLive ? `, live: ${live.length} (chạy lần lượt ở cuối)` : `, bỏ qua ${live.length} gate live (--live để chạy)`));

const started = Date.now();
const results = [];
let next = 0;

function runOne(file) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const child = spawn('node', [path.join('tests/browser', file)], {
            cwd: ROOT, env: process.env,
        });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', code => {
            // Gates end in three house styles: "N passed, M failed",
            // "total=N passed=N failed=M" and "pass=N fail=M".
            const summary = (out.match(/^.*(?:\d+ (?:passed|pass)|pass=\d+).*$/gm) || []).pop() || '';
            const fails = (out.match(/^FAIL .*/gm) || []).slice(0, 3);
            resolve({ file, code, seconds: Math.round((Date.now() - t0) / 1000), summary: summary.trim(), fails, out });
        });
    });
}

async function worker(serial = false) {
    while (next < queue.length) {
        const file = queue[next++];
        const r = await runOne(file);
        results.push(r);
        const mark = r.code === 0 ? 'PASS' : 'FAIL';
        console.log(`${mark}  ${file.padEnd(42)} ${String(r.seconds).padStart(3)}s  ${r.summary.slice(0, 60)}`);
        if (r.code !== 0) r.fails.forEach(f => console.log(`        ${f.slice(0, 140)}`));
        if (serial) continue;
    }
}

// The live gates share one account and one host: never two at a time.
const liveStart = queue.length - (wantLive ? live.length : 0);
const headlessQueue = queue.slice(0, liveStart);
const liveQueue = queue.slice(liveStart);
next = 0;
const saved = queue.splice(liveStart, liveQueue.length);
await Promise.all(Array.from({ length: Math.min(workers, headlessQueue.length) }, () => worker()));
if (saved.length) {
    console.log(`--- ${saved.length} gate live, lần lượt`);
    queue.push(...saved);
    await worker(true);
}

/*
 * A gate that went red in the pool is re-run ALONE before it is reported.
 *
 * Measured on the first full parallel sweep: 8 gates red at -j4, and
 * 5 of them (interaction.test, p1_tmux_vertical_gesture, p1_workflow_acceptance,
 * tmux_copy_mode_indicator_row and one composer row) were green the moment they
 * ran on their own. They drive real timing -- gestures, tmux, animation frames
 * -- against a machine four browsers are already using. Reporting that as a
 * red build would train the reader to ignore the list, so the pool's verdict is
 * a SUSPICION and the serial re-run is the verdict.
 */
let failed = results.filter(r => r.code !== 0);
const flaky = [];
if (failed.length) {
    console.log(`\n--- ${failed.length} gate đỏ, chạy lại từng cái một`);
    const suspects = failed.map(r => r.file);
    for (const file of suspects) {
        const again = await runOne(file);
        const i = results.findIndex(r => r.file === file);
        results[i] = again;
        if (again.code === 0) {
            flaky.push(file);
            console.log(`FLAKY ${file.padEnd(42)} ${String(again.seconds).padStart(3)}s  xanh khi chạy riêng`);
        } else {
            console.log(`FAIL  ${file.padEnd(42)} ${String(again.seconds).padStart(3)}s  ${again.summary.slice(0, 60)}`);
            again.fails.forEach(f => console.log(`        ${f.slice(0, 140)}`));
        }
    }
    failed = results.filter(r => r.code !== 0);
}

const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} gate xanh trong ${minutes} phút`);
if (flaky.length) {
    console.log(`XANH KHI CHẠY RIÊNG (${flaky.length}): ${flaky.join(' ')}`);
}
if (failed.length) {
    console.log('ĐỎ:');
    failed.forEach(r => console.log(`  ${r.file}  ${r.summary.slice(0, 80)}`));
}
process.exit(failed.length ? 1 : 0);
