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
        stale: TerminalManager.staleWideRows(term),
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
    stale: TerminalManager.staleWideRows(TerminalManager.terminals[key]),
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

check('§7 no page errors', errors, []);
await browser.close();
server.close();
console.log(`resize_freeze: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
