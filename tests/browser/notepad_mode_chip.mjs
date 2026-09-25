#!/usr/bin/env node
/*
 * THE NOTEPAD MODE CHIPS, AS PAINTED ON A PHONE.
 *
 * Owner, 2026-09-25: the Global / Per-server chips "phình rộng to tướng khi
 * active". The 44px touch target is meant to be invisible -- only the
 * fine-pointer chip's 16px pill is painted inside it -- and the box
 * measurements said so while the screen did not: the accent filled the whole
 * 56x44 / 67x44 target. `.notepad-mode-btn.active { background: ... }` is a
 * shorthand at higher specificity, and it reset the coarse rule's
 * background-clip to border-box on exactly the chip that paints.
 *
 * So every row here reads PIXELS of a real screenshot, not a rect:
 *   §A  the active chip's accent is 16px tall, on each theme and engine,
 *       with a floor (it IS painted) and the 44px target beside it
 *   §B  it is the desktop chip: same height and width as the fine-pointer
 *       chip's own box
 *   §C  its label takes --accent-on-text, the colour every theme defines
 *       for text on its accent (obsidian's accent is white)
 *   §Z  no page errors
 *
 * Run: node tests/browser/notepad_mode_chip.mjs   (from source/)
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
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
};

function renderTemplate(theme) {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate(url.searchParams.get('theme') || 'glass'));
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

/* The PNG reader from brand_mark_theme.mjs: WebKit writes RGBA, Chromium RGB. */
function readPng(buffer) {
    let pos = 8, width = 0, height = 0, colourType = 6;
    const idat = [];
    while (pos < buffer.length) {
        const len = buffer.readUInt32BE(pos);
        const type = buffer.toString('ascii', pos + 4, pos + 8);
        const data = buffer.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            colourType = data[9];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (colourType !== 2 && colourType !== 6) {
        throw new Error(`unsupported PNG colour type ${colourType}`);
    }
    const bpp = colourType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i],
                c = i >= bpp ? prev[i - bpp] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 0xff;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { width, height, stride, bpp, data: out };
}

const INIT = `
    const noop = () => {};
    window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.io = () => ({ connected: true, on: record, off: noop, once: record, emit: noop, io: { on: noop } });
    window.socket = window.io();
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.showNotification = noop;
    window.ModalManager = { open: m => m && m.classList.add('show'), close: m => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    try { localStorage.setItem('notepadCollapsed', 'false'); } catch (e) {}
`;
const S1 = 'eeee5555-chip-4eee-8eee-000000000005';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'tiny', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 't-chip', display_name: null, pane_index: null,
    replay_total_chunks: 0, replay_truncated: false, replay_dropped_bytes: 0,
    replay_history_lines: 0, legacy_tmux_locale: null,
};
const DPR = 2;
const pageErrors = [];

async function openPage(browser, engineName, theme, coarse) {
    const ctx = await browser.newContext(coarse
        ? { viewport: { width: 390, height: 844 }, hasTouch: true,
            isMobile: engineName === 'chromium', deviceScaleFactor: DPR }
        : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
    await ctx.addCookies([{ name: 'lang', value: 'vi', url: base }]);
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(`${engineName}/${theme}: ${e}`));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate(([e, p]) => window.__server(e, p), ['ssh_session_restored', snapshot]);
    await page.waitForTimeout(400);
    // On touch the notes are a sheet and `mobile-open` is what shows it -- a
    // chip in a closed sheet still has a box, under the workspace.
    const open = await page.evaluate((c) => {
        if (c) return document.getElementById('notepadPanel').classList.contains('mobile-open');
        const r = document.getElementById('notepadModeGlobalBtn').getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }, coarse);
    if (!open) {
        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(300);
    }
    return { ctx, page };
}

// The theme's own colours, read through the tokens on a throwaway element.
const tokenColours = (page) => page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'background:var(--accent-primary);color:var(--accent-on-text)';
    document.getElementById('notepadPanel').appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = { accent: cs.backgroundColor, onAccent: cs.color };
    probe.remove();
    return out;
});

const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const near = (px, want) => Math.abs(px[0] - want[0]) <= 6
    && Math.abs(px[1] - want[1]) <= 6 && Math.abs(px[2] - want[2]) <= 6;

/*
 * Where the accent is painted around one chip, in CSS px: the SPAN from the
 * first to the last accent pixel down a column inside the chip's 6px side
 * padding, and across the chip's middle row. A span, not a count: the middle
 * row crosses the label, and counting its pixels read the pill 18px narrow.
 * The column reaches 20px above and below the chip, so paint that bleeds out
 * of the target is measured; the row stays within 2px of the chip, because
 * obsidian's accent is the same white as the title beside it.
 */
async function paintedAccent(page, id, accent) {
    const r = await page.evaluate((i) => {
        const b = document.getElementById(i).getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, id);
    const clip = { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: r.w + 40, height: r.h + 40 };
    const img = readPng(await page.screenshot({ clip }));
    const at = (cx, cy) => {
        const o = Math.round(cy * DPR) * img.stride + Math.round(cx * DPR) * img.bpp;
        return [img.data[o], img.data[o + 1], img.data[o + 2]];
    };
    const col = r.x - clip.x + 3;
    const mid = r.y - clip.y + r.h / 2;
    const left = (r.x - clip.x - 2) * DPR;
    const right = (r.x - clip.x + r.w + 2) * DPR;
    const span = (n, hit) => {
        let first = -1, last = -1;
        for (let i = 0; i < n; i++) if (hit(i)) { if (first < 0) first = i; last = i; }
        return first < 0 ? 0 : (last - first + 1) / DPR;
    };
    return {
        height: span(img.height, y => near(at(col, y / DPR), accent)),
        width: span(img.width, x => x >= left && x <= right && near(at(x / DPR, mid), accent)),
        target: [r.w, r.h],
    };
}

const round1 = (v) => Math.round(v * 10) / 10;

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();

    // The desktop chip is the reference, measured the same way: painted
    // pixels against painted pixels, so edge anti-aliasing cancels out.
    const desk = await openPage(browser, engineName, 'glass', false);
    const deskPaint = await paintedAccent(desk.page, 'notepadModeGlobalBtn',
        rgb((await tokenColours(desk.page)).accent));
    const deskBox = [deskPaint.width, deskPaint.height];
    await desk.ctx.close();

    for (const theme of ['glass', 'paper', 'obsidian']) {
        const { ctx, page } = await openPage(browser, engineName, theme, true);
        const colours = await tokenColours(page);
        const accent = rgb(colours.accent);
        for (const [id, other] of [['notepadModeGlobalBtn', null], ['notepadModeServerBtn', 'notepadModeServerBtn']]) {
            if (other) {
                await page.click(`#${other}`);
                await page.waitForTimeout(250);
            }
            const tag = `${engineName} ${theme} ${id === 'notepadModeGlobalBtn' ? 'Global' : 'Per-server'}`;
            const active = await page.evaluate((i) => document.getElementById(i).classList.contains('active'), id);
            check(`§A ${tag}: it is the active chip`, active, true);
            const paint = await paintedAccent(page, id, accent);
            check(`§A ${tag}: the accent is painted at all`, paint.height > 0 && paint.width > 0, true);
            check(`§A ${tag}: the target is still 44px tall`, paint.target[1] >= 44, true);
            check(`§A ${tag}: the painted accent is 16px tall, not the ${round1(paint.target[1])}px target`,
                Math.abs(paint.height - 16) <= 1.5, true);
            if (id === 'notepadModeGlobalBtn') {
                check(`§B ${tag}: painted ${round1(paint.width)}x${round1(paint.height)} is the desktop chip ${deskBox.map(round1).join('x')}`,
                    // 1.5px: the desktop chip's line box is 16px in Chromium and
                    // 17px in WebKit, the phone pill 16px in both.
                    Math.abs(paint.width - deskBox[0]) <= 1.5 && Math.abs(paint.height - deskBox[1]) <= 1.5, true);
            }
            const label = await page.evaluate((i) => getComputedStyle(document.getElementById(i)).color, id);
            check(`§C ${tag}: the label is --accent-on-text`, label, colours.onAccent);
        }
        await ctx.close();
    }
    await browser.close();
}

check('§Z no page errors', pageErrors, []);
server.close();
console.log(`\nnotepad_mode_chip: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
