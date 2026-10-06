#!/usr/bin/env node
/*
 * A SHRINK MUST NOT SHOW THE LEFT HALF OF THE OLD FRAME.
 *
 * Owner,: "dù giật 1 2 giây thì nó vẫn là giật nhìn khá khó chịu.
 * TUI của Claude code cli có bị giật như thế đâu?"
 *
 * Measured before this gate existed (three screen diagnostics from his own
 * session, plus a bare engine):
 *
 *   - an attached tmux client draws on the ALTERNATE buffer -- tmux's own
 *     smcup at attach -- so this is the ordinary case, not a corner;
 *   - xterm's resize does NOT trim the alternate buffer's lines. 118-cell
 *     lines were still 118 cells after resize(59, 20); the same content on
 *     the normal buffer became 59. The pane therefore renders the LEFT 59
 *     COLUMNS OF THE OLD 118-COLUMN FRAME;
 *   - and nothing overwrites those cells until a repaint. A full-screen TUI
 *     repaints on SIGWINCH within a frame or two (which is why claude code
 *     looks clean); an idle prompt writes nothing, so the only repaint is the
 *     server's own refresh-client, ~700 ms away.
 *
 * §0 pins the mechanism itself, so nobody has to take the paragraph above on
 * trust, and the rest pins the fix: the pane is covered with its last good
 * frame until the repaint has FINISHED.
 *
 * 2026-09-24, omp: a program like omp (oh-my-pi) answers a width change --
 * a grow as much as a shrink -- with a blank alternate screen and then, after
 * a 120 ms settle, a replay of its whole transcript
 * (tests/fixtures/fake_omp_resize.py). The first repaint is therefore not the
 * end: §3 now pins that a repaint keeps the cover for FREEZE_QUIET_MS and that
 * a second one inside that window keeps it longer, and §4 that a grow is
 * covered too. Both replace assertions of the earlier contract ("the first
 * repaint takes the cover off", "a grow freezes nothing").
 *
 * 2026-10-06, omp 18.4.4: the owner still saw omp "giật liên tục lên xuống" on
 * every size change, the keyboard included. Measured on a copy of his session:
 * omp now replays its whole transcript on EVERY size change, rows too -- 1.7-1.9
 * MB through the tmux client, from ~300 ms to 1.0-1.25 s, after writes at once
 * and at ~120 ms -- and this cover started on a change of columns only. §8-§13
 * pin the cover that replaced it, each red on the tree before it: a change of
 * rows is covered and the snapshot keeps the prompt (§8, §13); a replay with a
 * pause in it is never seen (§9); a session that replayed keeps its next,
 * smaller change covered to the end (§10); output already flowing does not
 * hold the cover to the belt (§11); a replay longer than FREEZE_MAX_MS is
 * covered to its end (§12). §14 pins what was already true and still must
 * be: a spinner ticking under the cover does not hold it. "What is seen" is read per animation frame from
 * what is painted -- the cover when there is one, the terminal's rows when not
 * -- and a frame that is neither the one before the change nor the settled one
 * is a frame the person saw the screen jump through.
 *
 * Run: node tests/browser/resize_freeze.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{%\s*include\s*'([^']+)'\s*%\}/g,
        (_, f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}
const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return;
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

const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        connect: noop,
    };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
// Rows of the engine's visible screen that are wider than its grid: what a
// shrink of the alternate buffer leaves behind (§0).
await page.evaluate(() => {
    window.__staleWideRows = (term) => {
        const buffer = term.buffer.active;
        let stale = 0;
        for (let y = 0; y < term.rows; y += 1) {
            const line = buffer.getLine(buffer.viewportY + y);
            if (line && line.translateToString(true).length > term.cols) stale += 1;
        }
        return stale;
    };
});

/* ------------------------------------------------- §0 the defect itself */
const mechanism = await page.evaluate(async () => {
    const t = new Terminal({ cols: 118, rows: 20, allowProposedApi: true });
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;width:1200px;height:400px';
    document.body.appendChild(host);
    t.open(host);
    let data = '\x1b[?1049h';
    for (let i = 0; i < 20; i++) data += `\x1b[${i + 1};1H` + `row${i}-`.padEnd(118, 'x');
    await new Promise(r => t.write(data, r));
    const width = () => t.buffer.active.getLine(t.buffer.active.viewportY)
        .translateToString(true).length;
    const before = { type: t.buffer.active.type, width: width() };
    t.resize(59, 20);
    const after = { cols: t.cols, width: width() };
    t.dispose(); host.remove();
    return { before, after };
});
check('§0 an attached tmux client is on the alternate buffer',
    mechanism.before.type, 'alternate');
check('§0 a shrink leaves the alternate buffer\'s lines at their OLD width',
    [mechanism.before.width, mechanism.after.cols, mechanism.after.width],
    [118, 59, 118]);

/* ------------------------------------------------------ the pane itself */
const S = 'freeze-a';
await page.evaluate(id => {
    const host = document.getElementById('terminalsContainer');
    const el = document.createElement('div');
    el.id = `term-${id}`;
    el.className = 'terminal-wrapper';
    el.style.width = '1100px';
    el.style.height = '440px';
    host.appendChild(el);
    SessionManager.activeSessionId = id;
    TerminalManager.createTerminal(id);
    TerminalManager.attachTerminal(id, `term-${id}`);
    TerminalManager.views[id] = 'attached';
}, S);
await page.waitForTimeout(600);

const key = await page.evaluate(id => (TerminalManager.sessionTerminals[id] || [])[0], S);
// A repaint as the SERVER sends one -- through the app's write path, which is
// where a freeze is released.
const paint = async (cols, marker) => {
    await page.evaluate(({ id, cols, marker }) => {
        const k = (TerminalManager.sessionTerminals[id] || [])[0];
        const term = TerminalManager.terminals[k];
        let data = '';
        for (let i = 0; i < term.rows; i++) {
            data += `\x1b[${i + 1};1H\x1b[2K` + `${marker}${i}-`.padEnd(cols, 'x');
        }
        TerminalManager.writeOutput(id, data);
    }, { id: S, cols, marker });
    await page.waitForTimeout(160);
};

// A wide frame on the alternate buffer, the way an attached client looks.
await page.evaluate(id => {
    TerminalManager.noteWindowGeometry(id, 118, 20);
    TerminalManager.writeOutput(id, '\x1b[?1049h');
}, S);
await paint(118, 'old');
// The first geometry is a change too, and is covered until its repaint is
// quiet: the shrink below starts from a settled pane.
await page.waitForFunction(() => !document.querySelector('.sshdeck-frozen-pane'),
    null, { timeout: 3000 });

/* ------------------------------------------------------- §1 the freeze */
const frozen = await page.evaluate(({ id, key }) => {
    TerminalManager.noteWindowGeometry(id, 59, 20);
    const term = TerminalManager.terminals[key];
    const cover = document.querySelector('.sshdeck-frozen-pane');
    // The cover is placed where the pane WAS, so it is measured against the
    // wrapper, not against the screen that has just been resized under it.
    const r = document.getElementById(`term-${id}`).getBoundingClientRect();
    const c = cover && cover.getBoundingClientRect();
    return {
        covered: !!cover,
        stale: window.__staleWideRows(term),
        cols: term.cols,
        showsOldFrame: !!cover && cover.textContent.includes('old3-'),
        overPane: !!c && c.left >= r.left - 2 && c.top >= r.top - 2
            && c.width > 100 && c.right <= r.right + 2,
        aria: cover && cover.getAttribute('aria-hidden'),
        clicks: !!cover && getComputedStyle(cover).pointerEvents === 'none',
    };
}, { id: S, key });
check('§1 a shrink covers the pane with its last good frame',
    [frozen.covered, frozen.showsOldFrame, frozen.cols],
    [true, true, 59]);
check('§1 the engine underneath really is carrying the stale wide rows',
    frozen.stale > 0, true);
check('§1 the cover sits over the pane, takes no input and is hidden from readers',
    [frozen.overPane, frozen.clicks, frozen.aria], [true, true, 'true']);

// The renderer's CSS is scoped by an owner class; a copy of it must not
// match the live terminal, or the snapshot would restyle what it covers.
const scoping = await page.evaluate((key) => {
    const term = TerminalManager.terminals[key];
    const owner = (term.element.className.match(/xterm-dom-renderer-owner-\d+/) || [])[0];
    const cover = document.querySelector('.sshdeck-frozen-pane');
    return {
        owner: !!owner,
        leaked: [...cover.querySelectorAll('style')]
            .some(s => owner && s.textContent.includes(owner)),
        // Not every style block is owner-scoped (the scrollbar rules are
        // not), so what is pinned is that the owner's are, and none is left.
        scoped: [...cover.querySelectorAll('style')]
            .some(s => /sshdeck-frozen-\d+/.test(s.textContent)),
    };
}, key);
check('§2 the snapshot\'s copy of the renderer CSS is re-scoped to itself',
    scoping, { owner: true, leaked: false, scoped: true });

/* ---------------------------------- §2b the cover is the pane, and follows it */
// Seen in a screenshot of a grow, not in any number: a cover the size of the
// OLD frame left the strip the pane had just gained showing omp's replay.
const follows = await page.evaluate(({ id, key }) => {
    const wrapper = document.getElementById(`term-${id}`);
    const pane = () => TerminalManager.terminals[key].element.getBoundingClientRect();
    const cover = () => document.querySelector('.sshdeck-frozen-pane').getBoundingClientRect();
    const fits = () => {
        const p = pane(), c = cover();
        return Math.abs(c.left - p.left) < 1 && Math.abs(c.top - p.top) < 1
            && Math.abs(c.right - p.right) < 1 && Math.abs(c.bottom - p.bottom) < 1;
    };
    const out = {};
    wrapper.style.width = '600px';
    TerminalManager.fitFrozenPane(key);
    out.shrunk = { fits: fits(), wide: cover().width > 100 };
    wrapper.style.width = '1300px';
    TerminalManager.fitFrozenPane(key);
    out.grown = { fits: fits(), gained: cover().width > 1200 };
    wrapper.style.width = '1100px';
    TerminalManager.fitFrozenPane(key);
    return out;
}, { id: S, key });
check('§2b the cover covers exactly the pane as it shrinks and as it grows',
    follows, { shrunk: { fits: true, wide: true }, grown: { fits: true, gained: true } });

/* ------------------------------- §3 the repaint ends it, once it has ended */
const held = () => page.evaluate(({ key }) => ({
    covered: !!document.querySelector('.sshdeck-frozen-pane'),
    held: !!TerminalManager.frozenPanes[key],
}), { key });
await paint(59, 'new');
check('§3 the first repaint does not end the freeze (omp blanks first, replays after)',
    await held(), { covered: true, held: true });
await paint(59, 'new');
check('§3 a second repaint inside the quiet window keeps the cover',
    await held(), { covered: true, held: true });
await page.waitForTimeout(await page.evaluate(() => TerminalManager.FREEZE_QUIET_MS) + 150);
check('§3 once the repaint has been quiet for FREEZE_QUIET_MS the cover comes off', await page.evaluate(({ key }) => ({
    covered: !!document.querySelector('.sshdeck-frozen-pane'),
    held: !!TerminalManager.frozenPanes[key],
    // Measured, and the reason the release signal is the repaint's SIZE: the
    // stale cells are never trimmed. Every row was repainted here, over its
    // first 59 columns, and all 20 lines are still 118 cells long -- what the
    // renderer draws is the grid, so those cells are invisible, but "the
    // screen went clean" would have been a signal that never fires.
    stale: window.__staleWideRows(TerminalManager.terminals[key]),
    rows: TerminalManager.terminals[key].rows,
}), { key }), { covered: false, held: false, stale: 20, rows: 20 });

/* ------------------------------------------------ §4 a grow is covered too */
await page.evaluate(id => TerminalManager.noteWindowGeometry(id, 118, 20), S);
check('§4 growing the window covers the pane (omp replays on a grow as well)',
    await held(), { covered: true, held: true });
await paint(118, 'grown');
await page.waitForTimeout(await page.evaluate(() => TerminalManager.FREEZE_QUIET_MS) + 150);
check('§4 and the grow\'s cover comes off once its repaint is quiet',
    await held(), { covered: false, held: false });

/* ------------------------------------------------ §5 the belt, and only */
await paint(118, 'old');
const timeout = await page.evaluate(async ({ id, key }) => {
    TerminalManager.noteWindowGeometry(id, 59, 20);
    const held = !!TerminalManager.frozenPanes[key];
    // No repaint at all: this is the case where tmux never answers.
    await new Promise(r => setTimeout(r, TerminalManager.FREEZE_MAX_MS + 200));
    return { held, after: !!document.querySelector('.sshdeck-frozen-pane') };
}, { id: S, key });
check('§5 with no repaint the cover still comes off on its own',
    timeout, { held: true, after: false });

/* ----------------------------------------------- §6 released with the pane */
await page.evaluate(id => TerminalManager.noteWindowGeometry(id, 118, 20), S);
await paint(118, 'old');
const teardown = await page.evaluate(({ id, key }) => {
    TerminalManager.noteWindowGeometry(id, 59, 20);
    const held = !!TerminalManager.frozenPanes[key];
    TerminalManager.destroyTerminal(id);
    return { held, covers: document.querySelectorAll('.sshdeck-frozen-pane').length,
             tracked: Object.keys(TerminalManager.frozenPanes).length };
}, { id: S, key });
check('§6 destroying the terminal takes its cover with it',
    teardown, { held: true, covers: 0, tracked: 0 });

/* ------------------------------------------ one pane per scenario from here */
const makePane = async (id, size, marker) => {
    await page.evaluate(({ id }) => {
        const host = document.getElementById('terminalsContainer');
        host.querySelectorAll('.terminal-wrapper').forEach(el => el.remove());
        const el = document.createElement('div');
        el.id = `term-${id}`;
        el.className = 'terminal-wrapper';
        // Pinned to the container's top: once the first session is gone the
        // container lays out an empty state above it, and a pane outside the
        // viewport is one xterm stops rendering (its IntersectionObserver
        // pauses it) -- a replay nobody paints would pass every assertion
        // below. Absolute, not fixed: a fixed box has no offsetParent, which
        // the app reads as a hidden pane.
        el.style.cssText = 'position:absolute;left:0;top:0;width:1100px;height:440px;z-index:3';
        host.appendChild(el);
        SessionManager.activeSessionId = id;
        TerminalManager.createTerminal(id);
        TerminalManager.attachTerminal(id, `term-${id}`);
        TerminalManager.views[id] = 'attached';
    }, { id });
    await page.waitForTimeout(300);
    await page.evaluate(({ id, size }) => {
        TerminalManager.noteWindowGeometry(id, size[0], size[1]);
        TerminalManager.writeOutput(id, '\x1b[?1049h');
    }, { id, size });
    await page.evaluate(({ id, size, marker }) => TerminalManager.writeOutput(id,
        window.__screen(size[0], size[1], marker)), { id, size, marker });
    // Settled: the cover of the first geometry is off before the scenario.
    await page.waitForFunction(() => !document.querySelector('.sshdeck-frozen-pane'),
        null, { timeout: 5000 });
    await page.waitForTimeout(300);
};
await page.evaluate(() => {
    // A full-screen repaint the way tmux sends one: every row addressed.
    window.__screen = (cols, rows, marker) => {
        let data = '';
        for (let i = 0; i < rows; i++) {
            data += `\x1b[${i + 1};1H\x1b[2K` + `${marker}${i}-`.padEnd(cols, 'x');
        }
        return data;
    };
    // omp's rebuild through the tmux client: clear, then the transcript as
    // lines scrolling past, in pieces, the prompt last.
    window.__replay = (cols, lines, prompt) => {
        let data = '\x1b[2J\x1b[3J\x1b[H';
        for (let i = 0; i < lines; i++) {
            data += `replay ${String(i).padStart(5, '0')} `.padEnd(cols - 1, 'r') + '\r\n';
        }
        return data + prompt;
    };
});
const split = (data, size) => {
    const out = [];
    for (let at = 0; at < data.length; at += size) out.push(data.slice(at, at + size));
    return out;
};
/*
 * Run a plan of geometries and writes against the clock, and record what is
 * PAINTED every animation frame. `strangers` counts the distinct frames that
 * were neither the one before the change nor the one it settled on.
 */
const watch = (id, plan) => page.evaluate(async ({ id, plan }) => {
    const key = TerminalManager.sessionTerminals[id][0];
    const term = TerminalManager.terminals[key];
    const text = (rows) => [...rows.children]
        .map(r => r.textContent.replace(/ /g, ' ').trimEnd()).join('\n');
    const painted = () => {
        const cover = document.querySelector('.sshdeck-frozen-pane');
        return { covered: !!cover, text: text(cover
            ? cover.querySelector('.xterm-rows') : term.element.querySelector('.xterm-rows')) };
    };
    const frames = [];
    let on = true;
    const t0 = performance.now();
    const tick = () => {
        if (!on) return;
        frames.push({ t: performance.now() - t0, ...painted() });
        requestAnimationFrame(tick);
    };
    const before = painted().text;
    const rendering = () => term._core._renderService._isPaused === false;
    const renderedBefore = rendering();
    requestAnimationFrame(tick);
    for (const step of plan.steps) {
        const wait = step.at - (performance.now() - t0);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (step.geometry) TerminalManager.noteWindowGeometry(id, ...step.geometry);
        if (step.data) TerminalManager.writeOutput(id, step.data);
    }
    const left = plan.until - (performance.now() - t0);
    if (left > 0) await new Promise(r => setTimeout(r, left));
    on = false;
    const after = painted();
    const covered = frames.filter(f => f.covered);
    return {
        rendering: renderedBefore && rendering(),
        strangers: [...new Set(frames.map(f => f.text))]
            .filter(t => t !== before && t !== after.text).length,
        coveredAtEnd: after.covered,
        settled: after.text.split('\n').filter(Boolean).slice(-1)[0] || '',
        coveredFrom: covered.length ? Math.round(covered[0].t) : null,
        coveredTo: covered.length ? Math.round(covered[covered.length - 1].t) : null,
    };
}, { id, plan });
const drop = (id) => page.evaluate(id => TerminalManager.destroyTerminal(id), id);

/* ------------------------- §8 a change of ROWS alone is covered (the keyboard) */
const R = 'freeze-rows';
await makePane(R, [100, 24], 'old');
const rowsCover = await page.evaluate(({ id }) => {
    TerminalManager.noteWindowGeometry(id, 100, 18);
    const cover = document.querySelector('.sshdeck-frozen-pane');
    return { covered: !!cover, showsOldFrame: !!cover && cover.textContent.includes('old23-') };
}, { id: R });
check('§8 a change of rows alone covers the pane with its last good frame',
    rowsCover, { covered: true, showsOldFrame: true });
await page.evaluate(({ id }) => TerminalManager.writeOutput(id, window.__screen(100, 18, 'new')), { id: R });
await page.waitForFunction(() => !document.querySelector('.sshdeck-frozen-pane'), null, { timeout: 3000 });

/* ---------------- §9 omp's rebuild: a replay with a pause in it is never seen */
// Shaped on the measurement: tmux's redraw at once, omp's alternate-screen
// viewport at ~120 ms, then from ~300 ms the replay in pieces -- with a pause
// longer than FREEZE_QUIET_MS in the middle of it, as omp makes when the
// terminal is behind.
const STORM = split(await page.evaluate(() => window.__replay(100, 2400, 'omp final prompt')), 8190);
const stormPlan = (geometry, start) => {
    const steps = [{ at: 0, geometry },
        { at: 5, data: '' }, { at: 120, data: '' }];
    let at = start;
    STORM.forEach((piece, i) => {
        if (i === Math.floor(STORM.length / 2)) at += 450;
        steps.push({ at, data: piece });
        at += 25;
    });
    return { steps, end: at };
};
const keyboard = stormPlan([100, 14], 300);
keyboard.steps[1].data = await page.evaluate(() => window.__screen(100, 14, 'tmux'));
keyboard.steps[2].data = await page.evaluate(() => window.__screen(100, 14, 'altview'));
const replayed = await watch(R, { steps: keyboard.steps, until: keyboard.end + 1400 });
console.log(`      [§9] ${STORM.length} pieces over ${keyboard.end} ms; covered ${replayed.coveredFrom}..${replayed.coveredTo} ms`);
check('§9 the pane is on screen and rendering (else nothing could be seen)', replayed.rendering, true);
check('§9 no frame of the replay is seen: only the frame before and the settled one',
    replayed.strangers, 0);
check('§9 the pane settles uncovered, on the prompt',
    [replayed.coveredAtEnd, replayed.settled], [false, 'omp final prompt']);
check('§9 the cover lasted past the pause and to the end of the replay',
    replayed.coveredTo >= keyboard.end, true);
const remembered = await page.evaluate(({ id }) => ({
    replays: !!(TerminalManager.replaysOnResize || {})[id],
    uncover: TerminalManager.timeline.filter(e => e.e === 'uncover').slice(-1)
        .map(e => ({ storm: e.storm, why: e.why, big: e.bytes > 100000 }))[0],
    cover: TerminalManager.timeline.filter(e => e.e === 'cover').slice(-1)
        .map(e => [e.from, e.to])[0],
}), { id: R });
check('§9 the session is remembered as one that replays, and the timeline says why',
    remembered, { replays: true, uncover: { storm: true, why: 'quiet', big: true },
        cover: ['100x18', '100x14'] });

/* ------- §10 its next change is covered to the end, though small on its own */
// omp's answer to a change of columns, measured: 19-23 KB, with 573 ms between
// tmux's redraw and the frame omp settles on. Too little to look like a replay;
// the session's history says it is one.
const narrower = await watch(R, { steps: [
    { at: 0, geometry: [70, 14] },
    { at: 5, data: await page.evaluate(() => window.__screen(70, 14, 'interim')) },
    { at: 578, data: await page.evaluate(() => window.__screen(70, 14, 'settled')) },
], until: 578 + 1300 });
check('§10 the pane is rendering', narrower.rendering, true);
check('§10 the interim frame of a replaying session is never seen',
    narrower.strangers, 0);
check('§10 and the pane settles uncovered on omp\'s own frame',
    [narrower.coveredAtEnd, narrower.settled.startsWith('settled13-')], [false, true]);
await drop(R);

/* ---------- §11 output already flowing does not hold the cover to the belt */
const F = 'freeze-flow';
await makePane(F, [100, 20], 'old');
const flow = [];
for (let at = 0; at < 2600; at += 40) {
    flow.push({ at, data: `stream ${String(at).padStart(5, '0')} `.padEnd(100, 's') + '\r\n' });
}
const flowing = await watch(F, { steps: [
    ...flow.filter(s => s.at < 1000),
    { at: 1000, geometry: [80, 20] },
    { at: 1005, data: await page.evaluate(() => window.__screen(80, 20, 'repaint')) },
    ...flow.filter(s => s.at > 1000),
].sort((a, b) => a.at - b.at), until: 2700 });
const flowHeld = flowing.coveredTo - flowing.coveredFrom;
console.log(`      [§11] covered ${flowing.coveredFrom}..${flowing.coveredTo} ms`);
check('§11 the pane is rendering', flowing.rendering, true);
check('§11 a stream that was flowing before the change lifts the cover after its repaint',
    flowHeld < await page.evaluate(() => TerminalManager.FREEZE_QUIET_MS + 400), true);
check('§11 and not on the belt', flowHeld < await page.evaluate(() => TerminalManager.FREEZE_MAX_MS), true);
await drop(F);

/* ----------- §12 a replay longer than FREEZE_MAX_MS is covered to its end */
const L = 'freeze-long';
await makePane(L, [100, 20], 'old');
const LONG = split(await page.evaluate(() => window.__replay(90, 3000, 'long final prompt')), 4096);
// Long enough that the replay is still running FREEZE_MAX_MS after it was
// recognised as one, which is when the belt is re-armed.
const longSteps = [{ at: 0, geometry: [90, 20] }];
LONG.forEach((piece, i) => longSteps.push({ at: 300 + i * 35, data: piece }));
const longEnd = 300 + LONG.length * 35;
const long = await watch(L, { steps: longSteps, until: longEnd + 1400 });
console.log(`      [§12] ${LONG.length} pieces to ${longEnd} ms; covered ${long.coveredFrom}..${long.coveredTo} ms`);
check('§12 the replay outlasts FREEZE_MAX_MS after it is recognised',
    longEnd - long.coveredFrom > await page.evaluate(() => TerminalManager.FREEZE_MAX_MS + 1000), true);
check('§12 the pane is rendering', long.rendering, true);
check('§12 and none of it is seen', [long.strangers, long.settled], [0, 'long final prompt']);
await drop(L);

/* ----------------------- §13 the snapshot keeps the PROMPT when the pane shrinks */
const A = 'freeze-anchor';
await makePane(A, [100, 24], 'anchor');
const anchored = await page.evaluate(({ id }) => {
    const key = TerminalManager.sessionTerminals[id][0];
    // A change of columns too, so a cover exists on any tree.
    TerminalManager.noteWindowGeometry(id, 90, 12);
    document.getElementById(`term-${id}`).style.height = '240px';
    TerminalManager.fitFrozenPane(key);
    const cover = document.querySelector('.sshdeck-frozen-pane');
    if (!cover) return { lastInside: null, firstClipped: null };
    const c = cover.getBoundingClientRect();
    const rows = [...cover.querySelectorAll('.xterm-rows > div')];
    const at = (needle) => rows.find(r => r.textContent.startsWith(needle))?.getBoundingClientRect();
    const last = at('anchor23-'), first = at('anchor0-');
    if (!last || !first) return { lastInside: null, firstClipped: null };
    return {
        lastInside: last.top >= c.top - 1 && last.bottom <= c.bottom + 1,
        firstClipped: first.bottom <= c.top + 1,
    };
}, { id: A });
check('§13 the shrinking pane keeps the snapshot\'s LAST rows (the prompt), not its first',
    anchored, { lastInside: true, firstClipped: true });
await drop(A);

/* -------------------- §14 a spinner ticking under the cover does not hold it */
// Cursor moves and spinner ticks are smaller than a row and repaint nothing.
const T = 'freeze-tick';
await makePane(T, [100, 20], 'old');
const ticks = [];
for (let at = 10; at < 2000; at += 80) ticks.push({ at, data: `\x1b[16;1H${'|/-\\'[ticks.length % 4]} working` });
const ticking = await watch(T, { steps: [
    { at: 0, geometry: [100, 16] },
    { at: 5, data: await page.evaluate(() => window.__screen(100, 16, 'repaint')) },
    ...ticks,
].sort((a, b) => a.at - b.at), until: 2100 });
console.log(`      [§14] covered ${ticking.coveredFrom}..${ticking.coveredTo} ms`);
check('§14 the pane is rendering', ticking.rendering, true);
check('§14 a spinner ticking under the cover does not hold it past the quiet window',
    ticking.coveredTo - ticking.coveredFrom < await page.evaluate(() => TerminalManager.FREEZE_QUIET_MS + 200), true);
await drop(T);

check('§7 no page errors', errors, []);
await browser.close();
server.close();
console.log(`resize_freeze: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
