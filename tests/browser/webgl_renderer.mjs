#!/usr/bin/env node
/*
 * THE WebGL RENDERER TRIAL (terminal-manager.js useWebglRenderer,
 * `?renderer=webgl`) -- audit 2026-10-04: the owner's Windows laptop draws
 * frames at ~600 ms on its Intel GPU, and its NVIDIA GPU cannot be given to
 * the browser. The trial puts the terminal on xterm's WebGL renderer for a
 * device that asks for it, and nobody else.
 *
 * Headless Chromium runs WebGL2 on SwiftShader, so this drives the real
 * addon, not a stand-in.
 *
 * Sections:
 *   §1  off unless asked: the DOM renderer, and the addon is never fetched
 *   §2  `?renderer=webgl`: fetched once at its pinned URL, the terminal is a
 *       canvas, the device remembers, the timeline and the screen diagnostic
 *       say which renderer drew
 *   §3  the grid fills the pane by the cell WebGL draws (whole device
 *       pixels), not the font's advance -- at four pixel ratios, each set up
 *       the way a real screen reports it (chromiumAt)
 *   §4  a window smaller than the pane is zoomed into it without overflow
 *   §5  a later visit stays on WebGL; `?renderer=dom` goes back and forgets
 *   §6  the GPU drops the context: back to the DOM renderer in place, still
 *       writing, refitted
 *   §7  a freeze cover on a WebGL pane is the background alone
 *   §8  the addon fails to load: the DOM renderer, and the reason recorded
 *   §9  WebKit: whatever it can do, it ends on a working renderer
 *   §10 the probe reports the renderer in use
 *   §11 the canvas really shows the text, as much of it as the DOM renderer
 *       does, at DPR 1 and 1.75
 *   §Z  no page errors
 *
 * Run: node tests/browser/webgl_renderer.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
}
function between(label, actual, low, high) {
    const ok = actual >= low && actual <= high;
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (${actual} in [${low}, ${high}])`);
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
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
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
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


/*
 * A socket.io stand-in with what the perf probe listens on (onAny, onAnyOutgoing,
 * the engine's transport) and acks. Attach and resize are answered the way
 * the real server does, so the session's terminal is drawn.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {}; window.__any = []; window.__anyOut = [];
    window.__ackDelay = 30;
    const geometry = (p) => setTimeout(() => window.__server('tmux_window_geometry',
        { session_id: p.session_id, cols: p.cols, rows: p.rows }), 10);
    window.socket = {
        connected: true, connect: noop, off: noop,
        io: { on: noop, engine: { transport: { name: 'websocket' } } },
        on: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        once: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        onAny: (fn) => window.__any.push(fn),
        onAnyOutgoing: (fn) => window.__anyOut.push(fn),
        emit: (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            window.__anyOut.forEach(fn => fn(ev, payload));
            if (ev === 'view_attach') {
                setTimeout(() => window.__server('view_attached', { session_id: payload.session_id }), 10);
                geometry(payload);
            }
            if (ev === 'ssh_resize') geometry(payload);
            if (typeof ack === 'function') setTimeout(() => ack({ ok: true }), window.__ackDelay);
        },
    };
    window.io = () => window.socket;
    window.__server = (ev, payload) => {
        window.__any.forEach(fn => fn(ev, payload));
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.ModalManager = { open: noop, close: noop, trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'aaaa1111-perf-4aaa-8aaa-000000000001';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'tiny.example', port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 'one', display_name: 'tiny',
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};


const browser = await chromium.launch();
const pageErrors = [];
const ADDON = /xterm-addon-webgl\.js/;

async function openPage(ctx, query = '', engine = 'chromium') {
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => pageErrors.push(`${engine}: ${e}`));
    page.addonRequests = [];
    page.on('request', r => { if (ADDON.test(r.url())) page.addonRequests.push(r.url().replace(base, '')); });
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(`${base}/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    return page;
}
async function withContext(engine, label, fn, options = {}) {
    const ctx = await engine.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, options));
    try {
        await fn(ctx);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${label}: stopped\n        ${String(e.message).split('\n')[0]}`);
    } finally {
        await ctx.close();
    }
}
const fire = (page, ev, payload) => page.evaluate(([e, p]) => window.__server(e, p), [ev, payload]);
async function restore(page) {
    await fire(page, 'ssh_session_restored', snapshot);
    await fire(page, 'connect', null);
    await page.waitForTimeout(1200);
}
// The addon loads asynchronously: wait for the renderer asked for, then for
// the refit that follows it.
async function settle(page, renderer) {
    await page.waitForFunction(r => TerminalManager.rendererInUse() === r, renderer);
    await page.waitForTimeout(400);
}
const state = (page) => page.evaluate((id) => {
    const t = TerminalManager.terminals[(TerminalManager.sessionTerminals[id] || [])[0]];
    const box = TerminalManager.paneCellBox(t);
    const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    const cell = t._core._renderService.dimensions.css.cell;
    const char = t._core._charSizeService;
    return {
        inUse: TerminalManager.rendererInUse(),
        canvas: !!t.element.querySelector('.xterm-screen canvas'),
        rows: !!t.element.querySelector('.xterm-rows'),
        grid: [t.cols, t.rows],
        text: [t.options.fontSize, t.options.letterSpacing, t.options.lineHeight],
        box: [box.width, box.height],
        screen: [screen.width, screen.height],
        cell: [cell.width, cell.height],
        char: [char.width, char.height],
        stored: localStorage.getItem('sshdeck.renderer'),
        timeline: TerminalManager.timeline.filter(e => e.e === 'renderer').map(e => [e.to, e.why || '']),
        paint: TerminalManager.paintEvidence(id)?.renderer,
    };
}, S1);
async function bufferHas(page, text) {
    await page.waitForTimeout(200);
    return page.evaluate(([id, wanted]) => {
        const t = TerminalManager.terminals[(TerminalManager.sessionTerminals[id] || [])[0]];
        const buf = t.buffer.active;
        let all = '';
        for (let y = 0; y < buf.length; y++) all += buf.getLine(y)?.translateToString(true) || '';
        return all.includes(wanted);
    }, [S1, text]);
}
const round = (list, digits = 3) => list.map(n => +n.toFixed(digits));

/*
 * A PIXEL RATIO THE WAY A REAL SCREEN HAS ONE. Headless Chromium is not
 * self-consistent at a ratio other than 1 unless the scale is both forced and
 * emulated. Measured 2026-10-04 at 1.75: emulated alone reports
 * devicePixelRatio 1.75 while ResizeObserver's device-pixel-content-box stays
 * unscaled, so xterm sizes the WebGL canvas in CSS pixels against a viewport
 * computed in device pixels and nothing it draws lands on screen; forced alone
 * is the reverse (ratio 1.0000000447, box x1.75). A browser on a 175 % display
 * reports both, and so does this.
 */
const scaled = new Map();
async function chromiumAt(dpr) {
    if (dpr === 1) return browser;
    if (!scaled.has(dpr)) {
        scaled.set(dpr, await chromium.launch({ args: [`--force-device-scale-factor=${dpr}`] }));
    }
    return scaled.get(dpr);
}

// The share of a PNG's pixels lit like text on the dark theme (8-bit RGB or
// RGBA, as Playwright writes them).
function inked(png) {
    let at = 8;
    let width = 0;
    let height = 0;
    let bpp = 3;
    const idat = [];
    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString('ascii', at + 4, at + 8);
        const body = png.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            bpp = body[9] === 6 ? 4 : 3;
        }
        if (type === 'IDAT') idat.push(body);
        at += 12 + length;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    let prev = Buffer.alloc(stride);
    let lit = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
            }
            cur[x] = v & 255;
        }
        for (let x = 0; x < width; x++) if (cur[x * bpp] > 120) lit++;
        prev = cur;
    }
    return lit / (width * height);
}

// ── §1 off unless asked ─────────────────────────────────────────────────────
await withContext(browser, '§1', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    const s = await state(page);
    check('§1 without ?renderer the DOM renderer draws', [s.inUse, s.rows, s.canvas], ['dom', true, false]);
    check('§1 ...the addon is never fetched', page.addonRequests, []);
    check('§1 ...nor defined', await page.evaluate(() => typeof window.WebglAddon), 'undefined');
});

// ── §2 asked for ────────────────────────────────────────────────────────────
await withContext(browser, '§2', async (ctx) => {
    const page = await openPage(ctx, '?renderer=webgl');
    await restore(page);
    await settle(page, 'webgl');
    const s = await state(page);
    check('§2 ?renderer=webgl: the terminal is a canvas', [s.inUse, s.canvas, s.rows], ['webgl', true, false]);
    check('§2 ...the addon fetched once, at its pinned URL', page.addonRequests,
        ['/static/vendor/xterm/xterm-addon-webgl.js?v=1']);
    check('§2 ...the device remembers', s.stored, 'webgl');
    check('§2 ...the timeline records the switch', s.timeline, [['webgl', '']]);
    check('§2 ...and the screen diagnostic names the renderer', s.paint, 'webgl');
    await fire(page, 'ssh_output', { session_id: S1, data: 'drawn-by-webgl' });
    check('§2 output still reaches the engine', await bufferHas(page, 'drawn-by-webgl'), true);
});

// ── §3 the grid fills the pane by the cell WebGL draws ──────────────────────
for (const [width, height, dpr] of [[1815, 1200, 1.75], [1440, 900, 2], [1280, 800, 1], [1366, 768, 1.25]]) {
    await withContext(await chromiumAt(dpr), `§3 @${dpr}`, async (ctx) => {
        const page = await openPage(ctx, '?renderer=webgl');
        await restore(page);
        await settle(page, 'webgl');
        const s = await state(page);
        check(`§3 @${dpr} WebGL snaps the cell to whole device pixels`,
            round([s.cell[0]], 3), round([Math.floor(s.char[0] * dpr) / dpr], 3));
        between(`§3 @${dpr} the grid reaches across the pane: spare width under one cell`,
            +(s.box[0] - s.screen[0]).toFixed(2), 0, +s.cell[0].toFixed(2));
        between(`§3 @${dpr} ...spare height under one row`,
            +(s.box[1] - s.screen[1]).toFixed(2), 0, +s.cell[1].toFixed(2));
        check(`§3 @${dpr} ...at the base font, unstretched`, s.text, [14, 0, 1]);
    }, { viewport: { width, height }, deviceScaleFactor: dpr });
}

// ── §4 a smaller window, zoomed in ──────────────────────────────────────────
// At a fractional pixel ratio the zoomed glyph's height is rarely a whole
// number of device pixels, and WebGL rounds each row UP. Measured with the
// zoom computed from the font's own height: a 90x27 window at 1.25 drew 799
// px into a 780 px pane; computed from the drawn cell, 778.
for (const [dpr, cols, rows] of [[1, 80, 24], [1.75, 80, 24], [1.25, 90, 27]]) {
    await withContext(await chromiumAt(dpr), `§4 @${dpr} ${cols}x${rows}`, async (ctx) => {
        const label = `§4 @${dpr} ${cols}x${rows}`;
        const page = await openPage(ctx, '?renderer=webgl');
        await restore(page);
        await settle(page, 'webgl');
        await fire(page, 'tmux_window_geometry', { session_id: S1, cols, rows });
        await page.waitForTimeout(700);
        const s = await state(page);
        check(`${label} a smaller window is drawn at its own grid`, s.grid, [cols, rows]);
        check(`${label} ...with the text zoomed and no letter spacing`, [s.text[0] > 14, s.text[1]], [true, 0]);
        check(`${label} ...and nothing hangs out of the pane`,
            [s.screen[0] <= s.box[0] + 0.5, s.screen[1] <= s.box[1] + 0.5], [true, true]);
        between(`${label} ...while the tighter axis is filled (%)`,
            Math.round(100 * Math.max(s.screen[0] / s.box[0], s.screen[1] / s.box[1])), 95, 100);
    }, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
}

// ── §5 remembered, and forgotten ────────────────────────────────────────────
await withContext(browser, '§5', async (ctx) => {
    let page = await openPage(ctx, '?renderer=webgl');
    await page.close();
    page = await openPage(ctx);
    await restore(page);
    await settle(page, 'webgl');
    check('§5 a later visit without the query stays on WebGL', (await state(page)).inUse, 'webgl');
    await page.close();
    page = await openPage(ctx, '?renderer=dom');
    await restore(page);
    const s = await state(page);
    check('§5 ?renderer=dom goes back to the DOM renderer and forgets', [s.inUse, s.rows, s.stored],
        ['dom', true, null]);
    check('§5 ...without fetching the addon', page.addonRequests, []);
});

// ── §6 the GPU drops the context ────────────────────────────────────────────
await withContext(browser, '§6', async (ctx) => {
    const page = await openPage(ctx, '?renderer=webgl');
    await restore(page);
    await settle(page, 'webgl');
    // The renderer keeps 2D canvases beside its WebGL one; asking a 2D
    // canvas for webgl2 returns null, so the one that answers is the one.
    const dropped = await page.evaluate((id) => {
        const t = TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]];
        const gl = [...t.element.querySelectorAll('.xterm-screen canvas')]
            .map(c => c.getContext('webgl2')).find(Boolean);
        const lose = gl && gl.getExtension('WEBGL_lose_context');
        if (!lose) return false;
        lose.loseContext();
        return true;
    }, S1);
    check('§6 the context can be dropped', dropped, true);
    // xterm waits 3 s for the browser to restore a lost context first.
    await settle(page, 'dom');
    const s = await state(page);
    check('§6 a lost context puts the terminal back on the DOM renderer', [s.inUse, s.rows, s.canvas],
        ['dom', true, false]);
    check('§6 ...recorded with its reason', s.timeline, [['webgl', ''], ['dom', 'context-lost']]);
    between('§6 ...refitted: spare width under one DOM cell',
        +(s.box[0] - s.screen[0]).toFixed(2), 0, +s.cell[0].toFixed(2));
    await fire(page, 'ssh_output', { session_id: S1, data: '\r\nafter-the-loss' });
    await page.waitForTimeout(300);
    check('§6 ...and it draws what arrives next', await page.evaluate(() =>
        document.querySelector('.xterm-rows').textContent.includes('after-the-loss')), true);
});

// ── §7 a freeze cover ───────────────────────────────────────────────────────
await withContext(browser, '§7', async (ctx) => {
    for (const [query, renderer, copies] of [['?renderer=webgl', 'webgl', 0], ['?renderer=dom', 'dom', 1]]) {
        const page = await openPage(ctx, query);
        await restore(page);
        await settle(page, renderer);
        const cover = await page.evaluate((id) => {
            const key = TerminalManager.sessionTerminals[id][0];
            const t = TerminalManager.terminals[key];
            TerminalManager.freezePaneForResize(key, t);
            const c = document.querySelector('.sshdeck-frozen-pane');
            const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(); };
            const out = { copies: c.children.length, covers: box(c) === box(t.element) };
            TerminalManager.releaseFrozenPane(key);
            return out;
        }, S1);
        check(`§7 ${renderer}: the cover holds ${copies ? 'a copy of the rows' : 'no copy (a canvas clones blank)'}`,
            cover.copies, copies);
        check(`§7 ${renderer}: ...and covers the pane`, cover.covers, true);
        await page.close();
    }
});

// ── §8 the addon does not load ──────────────────────────────────────────────
await withContext(browser, '§8', async (ctx) => {
    await ctx.route('**/xterm-addon-webgl.js*', r => r.fulfill({ status: 404, body: 'gone' }));
    const page = await openPage(ctx, '?renderer=webgl');
    await restore(page);
    await page.waitForTimeout(500);
    const s = await state(page);
    check('§8 an addon that does not load leaves the DOM renderer drawing', [s.inUse, s.rows], ['dom', true]);
    check('§8 ...with the reason recorded', s.timeline, [['dom', 'load-failed']]);
});

// ── §9 WebKit ───────────────────────────────────────────────────────────────
const engine = await webkit.launch();
await withContext(engine, '§9', async (ctx) => {
    const page = await openPage(ctx, '?renderer=webgl', 'webkit');
    await restore(page);
    await page.waitForTimeout(1500);
    const s = await state(page);
    const working = (s.inUse === 'webgl' && s.canvas) || (s.inUse === 'dom' && s.rows && s.timeline.length === 1);
    check(`§9 WebKit ends on a working renderer (${s.inUse} ${JSON.stringify(s.timeline)})`, working, true);
    await fire(page, 'ssh_output', { session_id: S1, data: 'webkit-text' });
    check('§9 ...that still takes output', await bufferHas(page, 'webkit-text'), true);
});
await engine.close();

// ── §10 the probe ───────────────────────────────────────────────────────────
await withContext(browser, '§10', async (ctx) => {
    const page = await openPage(ctx, '?renderer=webgl&perf=1');
    await restore(page);
    await settle(page, 'webgl');
    await fire(page, 'ssh_output', { session_id: S1, data: 'x' });
    check('§10 the probe reports the renderer in use', await page.evaluate(() =>
        window.SSHDeckPerf.flush().rend), 'webgl');
});

// ── §11 the canvas shows the text ───────────────────────────────────────────
// Every row above checks geometry or the buffer; none looks at the screen,
// and a WebGL canvas can be the right size and empty. This looks: the same
// two rows drawn by each renderer, their lit pixels compared. Chromium only:
// WebKit's headless capture returns a stale frame of a canvas that does not
// preserve its drawing buffer (measured: the frame before the text arrived).
for (const dpr of [1, 1.75]) {
    const ink = {};
    for (const renderer of ['dom', 'webgl']) {
        await withContext(await chromiumAt(dpr), `§11 @${dpr} ${renderer}`, async (ctx) => {
            const page = await openPage(ctx, `?renderer=${renderer}`);
            await restore(page);
            await settle(page, renderer);
            await fire(page, 'ssh_output', { session_id: S1, data: 'HELLO WEBGL '.repeat(30) });
            await page.waitForTimeout(500);
            const clip = await page.evaluate((id) => {
                const t = TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]];
                const r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
                return { x: r.left, y: r.top, width: Math.min(600, r.width), height: Math.round(2 * r.height / t.rows) };
            }, S1);
            ink[renderer] = inked(await page.screenshot({ clip }));
        }, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    }
    between(`§11 @${dpr} WebGL puts the text on screen: its lit pixels against the DOM renderer's (%)`,
        Math.round((100 * ink.webgl) / ink.dom), 70, 130);
}

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z no page errors', pageErrors, []);

for (const scaledBrowser of scaled.values()) {
    await scaledBrowser.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
