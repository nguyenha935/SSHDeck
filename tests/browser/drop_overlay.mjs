#!/usr/bin/env node
/*
 * THE DROP OVERLAY LEAVES WITH THE DRAG -- owner report 2026-10-16:
 *
 *   "kéo file là tự hiện khung mờ Drop file to upload nhưng không thả vào nó
 *    không mất đi mà hiện như vậy mãi luôn."
 *
 * app.js showed #dropOverlay on any dragover carrying files and hid it on
 * drop, on dragend (never fired for a drag that started outside the page) or
 * on a dragleave whose target was <html> (never: dragleave targets the element
 * the pointer left). Measured on main ec083dc through Chromium's own drag
 * pipeline (CDP Input.dispatchDragEvent): a file dragged in and cancelled left
 * the overlay up, and the cancel fired no dragleave at all.
 *
 * The overlay now follows the one thing every drag in progress does: it fires
 * dragover, at least every 350 +/- 200 ms even with the pointer still (HTML
 * drag and drop processing model). Each dragover keeps it up for DROP_IDLE;
 * a dragleave ends it after DROP_LEAVE unless a dragover comes first; pointer
 * movement ends it at once.
 *
 * Sections:
 *   §1  Chromium, real drag pipeline (CDP): shown on enter, kept through a
 *       drag that crosses elements and one that holds still, gone after a
 *       cancel, at once on drop, at once on the first pointer move after it
 *   §2  Chromium and WebKit, dispatched events: the timing contract
 *   §Z  no page errors
 *
 * Run: node tests/browser/drop_overlay.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
// app.js: DROP_IDLE_MS 1000, DROP_LEAVE_MS 100. A dragover can be 550 ms
// apart, so the overlay must outlive that; it must not outlive the drag by
// much more than DROP_IDLE.
const STILL_UP_MS = 600;
const PAST_IDLE_MS = 1200;
const GONE_BY_MS = 2000;

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

const INIT = `
    const noop = () => {};
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.io = () => ({
        connected: true, on: record, off: noop, once: record, emit: noop,
        io: { on: noop },
    });
    window.socket = window.io();
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const errors = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openPage(browserType) {
    const browser = await browserType.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(`${browserType.name()}: ${e.message}`));
    await page.addInitScript(INIT);
    await page.goto(`${base}/`);
    await page.waitForFunction(() => document.getElementById('dropOverlay'));
    await page.waitForTimeout(300);
    return { browser, page };
}

const shown = (page) => page.evaluate(() =>
    !document.getElementById('dropOverlay').classList.contains('hidden'));
const reset = (page) => page.evaluate(() => {
    document.getElementById('dropOverlay').classList.add('hidden');
    document.getElementById('connectionModal')?.classList.remove('show');
});
// Milliseconds until the overlay is hidden, or null if it is still up after
// GONE_BY_MS.
const goneAfter = (page) => page.evaluate(async (limit) => {
    const el = document.getElementById('dropOverlay');
    const t0 = performance.now();
    while (performance.now() - t0 < limit) {
        if (el.classList.contains('hidden')) return Math.round(performance.now() - t0);
        await new Promise(r => setTimeout(r, 20));
    }
    return null;
}, GONE_BY_MS);

// ---------------------------------------------------------------------------
// §1 Chromium's own drag pipeline
// ---------------------------------------------------------------------------
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-overlay-'));
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    const { browser, page } = await openPage(chromium);
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    const drag = (type, x, y) => cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    const terminal = await page.evaluate(() => {
        const r = document.getElementById('terminalsContainer').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    const header = await page.evaluate(() => {
        const r = document.querySelector('.header').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

    await reset(page);
    await drag('dragEnter', terminal.x, terminal.y);
    await drag('dragOver', terminal.x, terminal.y);
    check('§1a a file dragged over the terminal shows the overlay', await shown(page), true);

    // From the header down into the terminal area: every element boundary
    // crossed fires a dragleave on the element left.
    await reset(page);
    const crossing = [];
    await drag('dragEnter', header.x, header.y);
    for (let i = 0; i <= 12; i++) {
        const y = Math.round(header.y + (terminal.y - header.y) * i / 12);
        await drag('dragOver', header.x, y);
        await sleep(60);
        crossing.push(await shown(page));
    }
    check('§1b it stays up at every step of a drag across elements',
        crossing.every(Boolean), true);

    // A pointer held still: the browser repeats dragover every 350 +/- 200 ms.
    const still = [];
    for (let i = 0; i < 5; i++) {
        await sleep(450);
        await drag('dragOver', terminal.x, terminal.y);
        still.push(await shown(page));
    }
    check('§1c it stays up while the pointer holds still', still.every(Boolean), true);

    await drag('dragCancel', terminal.x, terminal.y);
    const cancelled = await goneAfter(page);
    check(`§1d a cancelled drag takes it away within ${GONE_BY_MS} ms`, cancelled !== null, true);
    console.log(`      cancelled drag: gone after ${cancelled} ms`);

    // Chromium delivers a drop only after a dragover whose answer it already
    // holds. Measured through CDP: enter, one dragover, drop reaches the page
    // as nothing at all; a second dragover first makes it a drop.
    await reset(page);
    await page.evaluate(() => {
        window.__drops = 0;
        document.addEventListener('drop', () => { window.__drops += 1; }, { once: true });
    });
    await drag('dragEnter', terminal.x, terminal.y);
    await sleep(80);
    await drag('dragOver', terminal.x, terminal.y);
    await sleep(80);
    await drag('dragOver', terminal.x + 2, terminal.y + 2);
    await sleep(80);
    await drag('drop', terminal.x + 2, terminal.y + 2);
    check('§1e the page received the drop', await page.evaluate(() => window.__drops), 1);
    check('§1e a drop takes it away at once', await shown(page), false);
    check('§1e and is still handled (no session: the connect dialog opens)',
        await page.evaluate(() =>
            document.getElementById('connectionModal').classList.contains('show')), true);

    await reset(page);
    await drag('dragEnter', terminal.x, terminal.y);
    await drag('dragOver', terminal.x, terminal.y);
    await drag('dragCancel', terminal.x, terminal.y);
    await page.mouse.move(terminal.x + 40, terminal.y + 40);
    check('§1f the first pointer move after the drag takes it away at once',
        await shown(page), false);

    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// §2 The timing contract, with dispatched events, in both engines
// ---------------------------------------------------------------------------
for (const browserType of [chromium, webkit]) {
    const name = browserType.name();
    const { browser, page } = await openPage(browserType);
    await page.evaluate(() => {
        const target = () => document.getElementById('terminalsContainer');
        const transfer = (kind) => {
            const dt = new DataTransfer();
            if (kind === 'file') dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
            else dt.setData('text/plain', 'x');
            return dt;
        };
        window.__drag = (type, kind = 'file') => target().dispatchEvent(new DragEvent(type, {
            dataTransfer: transfer(kind), bubbles: true, cancelable: true,
        }));
        window.__shown = () => !document.getElementById('dropOverlay').classList.contains('hidden');
    });
    const fire = (type, kind) => page.evaluate(([t, k]) => window.__drag(t, k), [type, kind]);

    await reset(page);
    await fire('dragover', 'text');
    check(`§2a [${name}] a drag that carries no file does not show it`, await shown(page), false);

    await reset(page);
    await fire('dragover');
    await sleep(STILL_UP_MS);
    check(`§2b [${name}] one dragover keeps it up for ${STILL_UP_MS} ms`, await shown(page), true);
    check(`§2b [${name}] and no more dragover takes it away`, (await goneAfter(page)) !== null, true);

    await reset(page);
    await fire('dragover');
    check(`§2c [${name}] a dragleave alone does not hide it in the same task`,
        await page.evaluate(() => { window.__drag('dragleave'); return window.__shown(); }), true);
    await sleep(300);
    check(`§2c [${name}] but it is gone 300 ms later`, await shown(page), false);

    await reset(page);
    await fire('dragover');
    await fire('dragleave');
    await sleep(30);
    await fire('dragover');
    await sleep(300);
    check(`§2d [${name}] a dragleave followed by a dragover (one element to the next) keeps it up`,
        await shown(page), true);

    check(`§2e [${name}] a pointer move takes it away at once`,
        await page.evaluate(() => {
            document.getElementById('terminalsContainer').dispatchEvent(
                new PointerEvent('pointermove', { bubbles: true }));
            return window.__shown();
        }), false);

    await reset(page);
    await fire('dragover');
    check(`§2f [${name}] a drop takes it away at once`,
        await page.evaluate(() => { window.__drag('drop'); return window.__shown(); }), false);
    await sleep(PAST_IDLE_MS);
    check(`§2f [${name}] and nothing brings it back afterwards`, await shown(page), false);

    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`\ndrop_overlay: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
