#!/usr/bin/env node
/*
 * THE NOTE MUST KEEP EVERY CHARACTER, at typing speed, over a slow link.
 *
 * Owner,: "Note khi gõ nhanh 1 chút hoặc hơi lag bị giật mất chữ,
 * nhảy xuống dòng,... cho chức năng lưu hoạt động có vấn đề."
 *
 * The save path is a revisioned, serialized, conditional write, and every step
 * of it can write the box: the ACK of a refused save, a foreign device's
 * broadcast, and the reply to the connect-time fetch. This suite drives all
 * three WHILE the user types, with the ACK deliberately slowed past the 300 ms
 * debounce, and asserts the only thing that matters: the box holds exactly
 * what was typed, the caret stays where the typist left it, and the last save
 * carries the full text.
 *
 * Run: node tests/browser/notepad_fast_typing.mjs   (from source/)
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
    '.woff2': 'font/woff2', '.png': 'image/png' };
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

/*
 * A SLOW, REVISIONED notepad server, in the page. It answers `save_notepad`
 * the way socket_events.handle_save_notepad does -- an ack carrying
 * applied/notepad/revision -- after a delay that outlasts the 300 ms debounce,
 * which is the "hơi lag" in the report.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    window.__ackDelay = 700;
    window.__server_rev = 0;
    window.__server_text = '';
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            if (ev !== 'save_notepad' || typeof ack !== 'function') return;
            const req = payload;
            setTimeout(() => {
                const stale = req.base_revision !== undefined
                    && req.base_revision !== null
                    && req.base_revision !== window.__server_rev;
                if (!stale) {
                    window.__server_text = req.text;
                    window.__server_rev += 1;
                }
                ack({
                    applied: !stale,
                    notepad: window.__server_text,
                    revision: window.__server_rev,
                    mode: req.mode, target_id: req.target_id,
                });
            }, window.__ackDelay);
        },
    };
    window.io = () => window.socket;
    window.showNotification = noop;
    window.ModalManager = { open: m => m && m.classList.add('show'),
        close: m => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 20000 });
await page.evaluate(() => {
    document.getElementById('notepadPanel')?.classList.remove('collapsed', 'mobile-open');
    document.getElementById('notepadPanel')?.removeAttribute('hidden');
});

const TEXT = 'ghi chu nhanh 1234567890 abcdefghij';
const note = '#sessionNotepad';

// ── §1 fast typing over a slow link ─────────────────────────────────────────
await page.focus(note);
await page.evaluate(() => { window.__emits = []; });
await page.keyboard.type(TEXT, { delay: 12 });
await page.waitForTimeout(1800);
check('§1 the box holds exactly what was typed', await page.inputValue(note), TEXT);
check('§1 the caret is still at the end', await page.evaluate(() =>
    document.getElementById('sessionNotepad').selectionStart), TEXT.length);
check('§1 the newest save carries the whole text', await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad');
    return saves.length ? saves[saves.length - 1].payload.text : null;
}), TEXT);
check('§1 the server ended up with it too',
    await page.evaluate(() => window.__server_text), TEXT);

// ── §2 a foreign device saves WHILE the user is typing ──────────────────────
await page.evaluate(() => { window.__emits = []; });
await page.focus(note);
const TAIL = ' them chu';
const typing = page.keyboard.type(TAIL, { delay: 30 });
await page.waitForTimeout(60);
await page.evaluate(() => {
    window.__server_rev += 1;
    window.__server_text = 'FOREIGN DEVICE TEXT';
    window.__server('notepad_updated', {
        notepad: window.__server_text, revision: window.__server_rev,
        mode: 'global', target_id: null,
    });
});
await typing;
await page.waitForTimeout(300);
check('§2 the foreign frame does not touch the box while it is focused',
    await page.inputValue(note), TEXT + TAIL);
check('§2 and the caret did not jump', await page.evaluate(() =>
    document.getElementById('sessionNotepad').selectionStart), (TEXT + TAIL).length);

// ── §3 the refused save (a real conflict) still converges, on blur ──────────
await page.waitForTimeout(1600);
check('§3 while focused the box is still the typist\'s',
    await page.inputValue(note), TEXT + TAIL);
/*
 * The typist's text WINS the conflict: their save is re-based and written
 * again, so blur has nothing to converge to but their own words. The idle
 * device gets them through the broadcast. Losing them here -- which is what
 * adopting the foreign text on blur did -- is the owner's "mất chữ".
 */
await page.evaluate(() => document.getElementById('sessionNotepad').blur());
await page.waitForTimeout(1600);
check('§3 blur keeps the typist\'s text, not the foreign one',
    await page.inputValue(note), TEXT + TAIL);
check('§3 and the server has it', await page.evaluate(() => window.__server_text),
    TEXT + TAIL);

// ── §4 typing fast with a 2 s link ──────────────────────────────────────────
await page.evaluate(() => {
    window.__ackDelay = 2000;
    window.__server_rev = 0; window.__server_text = '';
    const n = document.getElementById('sessionNotepad');
    n.value = ''; n.focus();
    window.__emits = [];
});
const LONG = 'mot hai ba bon nam sau bay tam chin muoi';
await page.keyboard.type(LONG, { delay: 8 });
await page.waitForTimeout(400);
check('§4 nothing is lost while the first save is still in flight',
    await page.inputValue(note), LONG);
await page.waitForTimeout(5000);
check('§4 the box still holds it after every ack landed',
    await page.inputValue(note), LONG);
check('§4 and the server converged on it',
    await page.evaluate(() => window.__server_text), LONG);

check('§Z no page errors', errors, []);
await ctx.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
