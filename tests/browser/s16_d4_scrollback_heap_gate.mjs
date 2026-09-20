/*
 * S16 / S5 HEAP GATE — the measurement required BEFORE the
 * scrollback default may be raised.
 *
 * Directive (item 3, D4 H1): the default is derived from the server's replay
 * cap, "with a hard heap gate (~120MB ceiling)... come back with the
 * measurement instead of shipping; do not silently pick a smaller number."
 *
 * This file measures, it does not assume. It builds the WORST realistic mobile
 * case and reads the real JS heap through CDP `Runtime.getHeapUsage`:
 *
 *   * 4 panes, each a live xterm on a 390x844 touch shell (the split limit);
 *   * every pane filled to its FULL scrollback capacity, so the CircularList is
 *     not merely allocated but populated -- xterm grows scrollback lazily, so a
 *     measurement on an empty terminal proves nothing;
 *   * a WIDE grid: the lines are 200 columns of real text, because a buffer line
 *     costs per CELL, not per line, and a narrow line would understate it;
 *   * measured twice -- at the CURRENT default (150) and at the DERIVED default
 *     (the server's replay line cap, 5000) -- so the number reported is the
 *     DELTA the change would actually add, not the absolute heap of the page.
 *
 * Method notes that decide whether the number means anything:
 *   * `Runtime.getHeapUsage` is read after an explicit `HeapProfiler
 *     .collectGarbage`, so what is reported is retained, not garbage awaiting a
 *     collection.
 *   * The baseline is taken with the panes already built and EMPTY, so the delta
 *     isolates buffer content from page and renderer overhead.
 *   * Each sample is the median of three reads, because V8's used-size wobbles.
 *
 * TWO INDEPENDENT MEASURES, and the verdict takes the LARGER. `Runtime
 * .getHeapUsage` reports V8's JS heap, which does not account for typed-array
 * backing stores -- and an xterm buffer line IS a `Uint32Array` (three uint32 per
 * cell). Reported alone it could understate the very thing being measured, which
 * is the kind of comfortable number this gate exists to avoid producing. So the
 * retained buffer cost is ALSO computed deterministically: walk every retained
 * line of every pane and sum `_data.byteLength` from the engine's own arrays. No
 * sampling, no GC timing. VENDOR COUPLING: that walk reads
 * `terminal._core.buffer.lines`, private API in xterm.js 5.3.0; it is asserted
 * reachable rather than assumed, so a vendor bump fails the gate loudly instead
 * of quietly reporting zero.
 *
 * It writes /tmp/s16work/s5_heap_measurement.json and prints a verdict line.
 * Exit 0 means the measured delta is within the 120MB ceiling; exit 1 means it
 * is not, and then the number is the deliverable -- not a smaller default.
 *
 * Run: node tests/browser/s16_d4_scrollback_heap_gate.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = '/tmp/s16work/s5_heap_measurement.json';
const CEILING_MB = 120;
const PANES = 4;
const WIDE_COLS = 200;

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
        connected: true, id: 'sock-heap',
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SEED = `(sid) => {
    SessionManager.sessions[sid] = { id: sid, session_id: sid, host: 'heap.example',
        port: 22, username: 'heap', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: sid, connected: true, isPersistentCandidate: false,
        tmuxSessionName: null, terminalId: 'term-' + sid, useTmux: false,
        viaJump: null, latencyMs: null };
    const el = document.createElement('div');
    el.id = 'term-' + sid;
    el.className = 'terminal-wrapper';
    document.getElementById('terminalsContainer').appendChild(el);
    TerminalManager.createTerminal(sid);
    TerminalManager.attachTerminal(sid, 'term-' + sid);
}`;

/*
 * Fill every pane to its full scrollback. Written straight through
 * writeOutputNow (the shipped unconditional write path) rather than the replay
 * sequencer: the subject here is the RETAINED BUFFER, and going through the
 * sequencer would add a transcript copy that is separately bounded and would
 * confound the number.
 */
const FILL = `(args) => {
    const [sids, lines, cols] = args;
    const body = 'x'.repeat(cols - 12);
    return new Promise((resolve) => {
        let n = 0;
        const step = () => {
            const batch = [];
            for (let i = 0; i < 250 && n < lines; i++, n++) {
                batch.push('L' + String(n).padStart(6, '0') + ' ' + body + '\\r\\n');
            }
            const text = batch.join('');
            sids.forEach(sid => TerminalManager.writeOutputNow(sid, text));
            if (n >= lines) {
                // Let the parser drain before anything is measured.
                const key = TerminalManager.sessionTerminals[sids[0]][0];
                TerminalManager.terminals[key].write('', () => resolve(n));
                return;
            }
            setTimeout(step, 0);
        };
        step();
    });
}`;

const BUFFER_STATE = `(sids) => sids.map(sid => {
    const key = TerminalManager.sessionTerminals[sid][0];
    const t = TerminalManager.terminals[key];
    // Deterministic retained-bytes walk over the engine's own line arrays.
    // Private API (xterm.js 5.3.0): reported as reachable:false rather than 0 if
    // a vendor bump moves it, so the gate can fail instead of understating.
    let reachable = false;
    let bytes = 0;
    let walked = 0;
    try {
        const lines = t._core && t._core.buffer && t._core.buffer.lines;
        if (lines && typeof lines.length === 'number'
            && typeof lines.get === 'function') {
            reachable = true;
            for (let i = 0; i < lines.length; i++) {
                const line = lines.get(i);
                const data = line && line._data;
                if (data && typeof data.byteLength === 'number') {
                    bytes += data.byteLength;
                    walked++;
                }
            }
        }
    } catch (e) {
        reachable = false;
    }
    return { sid, cols: t.cols, capacity: t.options.scrollback,
             length: t.buffer.active.length, baseY: t.buffer.active.baseY,
             lineArraysReachable: reachable, linesWalked: walked,
             retainedBufferBytes: bytes };
})`;

async function heapMB(cdp) {
    const reads = [];
    for (let i = 0; i < 3; i++) {
        await cdp.send('HeapProfiler.collectGarbage');
        const { usedSize } = await cdp.send('Runtime.getHeapUsage');
        reads.push(usedSize / (1024 * 1024));
        await new Promise(r => setTimeout(r, 120));
    }
    reads.sort((a, b) => a - b);
    return Math.round(reads[1] * 100) / 100;
}

async function measure(scrollback) {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.addInitScript(`localStorage.setItem('terminalScrollback', '${scrollback}');`);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));

    const sids = Array.from({ length: PANES }, (_, i) => `HEAP-${i + 1}`);
    for (const sid of sids) {
        await page.evaluate(new Function('return ' + SEED)(), sid);
    }
    await page.waitForTimeout(900);

    const cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Runtime.enable');
    const baseline = await heapMB(cdp);

    /*
     * The panes must hold a WIDE grid while they are filled: a buffer line
     * costs per CELL, so the heap answer this gate exists for is cols x lines.
     *
     *: the engines are resized DIRECTLY, immediately before the
     * fill, and any pending debounced fit is cancelled first. Until today the
     * grid came from `adoptPtyAuthority` -- a phone pane rendered whatever the
     * shared PTY was running at, so a 390px device really did carry 200-column
     * buffer lines. That cannot happen any more (a view is drawn by tmux
     * clipped to this client's own size, so a phone pane renders ~49 columns),
     * which makes 200 columns a deliberately PESSIMISTIC grid here rather than
     * a device state: the gate keeps measuring the worse case so a scrollback
     * raise cannot be approved on a flattering one.
     */
    await page.evaluate(([list, cols]) => {
        list.forEach(sid => {
            TerminalManager.cancelPendingFit(sid);
            const key = (TerminalManager.sessionTerminals[sid] || [])[0];
            const terminal = TerminalManager.terminals[key];
            if (terminal) terminal.resize(cols, 40);
        });
    }, [sids, WIDE_COLS]);

    const written = await page.evaluate(new Function('return ' + FILL)(),
        [sids, scrollback + 200, WIDE_COLS]);
    await page.waitForTimeout(600);
    const filled = await heapMB(cdp);
    const buffers = await page.evaluate(new Function('return ' + BUFFER_STATE)(), sids);

    await ctx.close();
    const retainedMB = Math.round(
        (buffers.reduce((sum, b) => sum + b.retainedBufferBytes, 0)
            / (1024 * 1024)) * 100) / 100;
    return {
        scrollback, baselineMB: baseline, filledMB: filled,
        deltaMB: Math.round((filled - baseline) * 100) / 100,
        retainedBufferMB: retainedMB,
        linesWrittenPerPane: written, panes: PANES, gridCols: WIDE_COLS,
        buffers, errors,
    };
}

const low = await measure(150);
const high = await measure(5000);

const heapAdditionalMB = Math.round((high.deltaMB - low.deltaMB) * 100) / 100;
const retainedAdditionalMB = Math.round(
    (high.retainedBufferMB - low.retainedBufferMB) * 100) / 100;
// The larger of the two measures decides. Sampling can understate typed arrays;
// the deterministic walk can miss allocations outside the line arrays. Taking
// the max means neither blind spot can wave the change through.
const additionalMB = Math.max(heapAdditionalMB, retainedAdditionalMB);
const report = {
    measuredAt: new Date().toISOString(),
    ceilingMB: CEILING_MB,
    current: low,
    derived: high,
    heapAdditionalMB,
    retainedAdditionalMB,
    additionalMB,
    verdict: additionalMB <= CEILING_MB ? 'WITHIN_CEILING' : 'OVER_CEILING',
};
fs.mkdirSync('/tmp/s16work', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(`\n--- measurement written to ${OUT}`);
console.log(`    current default 150 : baseline ${low.baselineMB} MB -> filled `
    + `${low.filledMB} MB  (delta ${low.deltaMB} MB)`);
console.log(`    derived default 5000: baseline ${high.baselineMB} MB -> filled `
    + `${high.filledMB} MB  (delta ${high.deltaMB} MB)`);
console.log(`    retained line arrays: ${low.retainedBufferMB} MB -> `
    + `${high.retainedBufferMB} MB  (delta ${retainedAdditionalMB} MB)`);
console.log(`    ADDITIONAL cost the raise adds, ${PANES} panes x ${WIDE_COLS} `
    + `cols, all filled: ${additionalMB} MB `
    + `(sampled heap ${heapAdditionalMB} MB, deterministic `
    + `${retainedAdditionalMB} MB; ceiling ${CEILING_MB} MB)\n`);

// Non-vacuity: a measurement on unfilled buffers would prove nothing, so the
// fill itself is asserted before the verdict is allowed to mean anything.
check('the low case really filled its buffers to capacity',
    low.buffers.every(b => b.capacity === 150 && b.length >= 150), true);
check('the derived case really filled its buffers to capacity',
    high.buffers.every(b => b.capacity === 5000 && b.length >= 5000), true);
check('every pane really rendered the wide grid',
    high.buffers.every(b => b.cols === WIDE_COLS), true);
check('four panes were measured', high.buffers.length, PANES);
check('the engine line arrays were really walked (vendor coupling holds)',
    high.buffers.every(b => b.lineArraysReachable
        && b.linesWalked >= 5000), true);
check('the deterministic walk found real bytes (non-vacuous)',
    high.retainedBufferMB > low.retainedBufferMB, true);
check('no page errors while filling (low)', low.errors, []);
check('no page errors while filling (derived)', high.errors, []);
check(`the additional heap is within the ${CEILING_MB} MB ceiling`,
    report.verdict, 'WITHIN_CEILING');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
