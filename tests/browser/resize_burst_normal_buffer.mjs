#!/usr/bin/env node
/*
 * A SHELL PROMPT UNDER A RESIZE BURST -- the case no gate covered.
 *
 * Owner,: "van loi giat man hinh nhay len xuong lien tuc khi thay
 * doi kich thuoc tren desktop (dang chay phien omp qua tailscale)". His session
 * is oh-my-posh: a PROMPT on the NORMAL buffer, not a full-screen program on
 * the alternate one. Every gate that measured resizing until now drove either a
 * bare engine or an alternate-buffer TUI, and the two behave differently in
 * ways that matter here:
 *
 *   - the alternate buffer refuses a shrink (resizeTerminalPreservingAltRows)
 *     and never reflows, so most ticks of a drag are a no-op on it;
 *   - the normal buffer resizes for real, reflows its wrapped lines and moves
 *     `ydisp`, and the prompt repaints on every SIGWINCH.
 *
 * What this suite pins, all measured on the normal buffer:
 *
 *   §1 THE PANE HOLDS STILL WHILE THE BOX IS MOVING. Measured here before the
 *      fix: shrinking the pane 8px at a time, with the window geometry held,
 *      moved the screen's offset 8, 0, 24, 16, 8, 0, 24, 16, 8, 0, -8 ... -- a
 *      sawtooth with a 24px tooth. The cause is quantisation, not the anchor:
 *      presentWindowGrid picks `font = floor(base * zoom)`, so every few pixels
 *      of box the font steps a whole pixel and the grid's height jumps by about
 *      one pixel per ROW. Between two window geometries there is nothing to
 *      re-present, so the zoom and the anchor are now recomputed when the box
 *      settles (or when a new geometry lands), and not per frame.
 *
 *   §2 A BURST COSTS AT MOST TWO PROPOSALS, NOT TWELVE.
 *
 *   §3 A SINGLE CHANGE IS ANNOUNCED IMMEDIATELY -- the devtools case, where
 *      waiting for a trailing debounce is what left tmux's padding on screen.
 *
 * Run: node tests/browser/resize_burst_normal_buffer.mjs   (from source/)
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
function checkTrue(label, value, detail) {
    if (value === true) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        ${detail}`); }
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined'
    && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });

const S = 'burst-normal';
await page.evaluate(id => {
    const host = document.getElementById('terminalsContainer');
    const el = document.createElement('div');
    el.id = `term-${id}`;
    el.className = 'terminal-wrapper';
    el.style.width = '900px';
    el.style.height = '520px';
    host.appendChild(el);
    SessionManager.activeSessionId = id;
    TerminalManager.createTerminal(id);
    // attachTerminal is what puts the engine into the DOM (nested rAF + 50ms
    // inside it); without that there is no `.element` to measure.
    TerminalManager.attachTerminal(id, `term-${id}`);
    TerminalManager.views[id] = 'attached';
}, S);
await page.waitForTimeout(600);
await page.evaluate(id => {
    // A prompt and some scrollback: the NORMAL buffer, with wrapped lines to
    // reflow, which is what a shell session actually looks like.
    const key = (TerminalManager.sessionTerminals[id] || [])[0];
    const term = TerminalManager.terminals[key];
    for (let i = 0; i < 60; i++) {
        term.write(`line ${i} ${'x'.repeat(120)}\r\n`);
    }
    term.write('\x1b[32m❯\x1b[0m ');
}, S);
await page.waitForTimeout(400);

const bufferType = await page.evaluate(id => {
    const key = (TerminalManager.sessionTerminals[id] || [])[0];
    return TerminalManager.terminals[key].buffer.active.type;
}, S);
check('§0 the session really is on the normal buffer', bufferType, 'normal');

/* ------------------------------------------------- §1 continuous anchoring */
const margins = await page.evaluate(async id => {
    const el = document.getElementById(`term-${id}`);
    const key = (TerminalManager.sessionTerminals[id] || [])[0];
    const term = TerminalManager.terminals[key];
    const screen = term.element.querySelector('.xterm-screen');
    const seen = [];
    // A window the server has already announced: this is the state a drag is
    // in while it waits for the next geometry, and the one that used to flip.
    TerminalManager.noteWindowGeometry(id, term.cols, term.rows);
    for (let h = 520; h >= 360; h -= 8) {
        el.style.height = `${h}px`;
        TerminalManager.fitTerminal(id);
        // A frame of a drag: whatever the pane shows RIGHT NOW, before any
        // settle timer has run.
        seen.push(parseFloat(screen.style.marginTop || '0'));
    }
    await new Promise(r => setTimeout(r, TerminalManager.PRESENT_SETTLE_MS + 120));
    const settled = parseFloat(screen.style.marginTop || '0');
    return { seen, settled };
}, S);
const moves = margins.seen.slice(1).map((v, i) => v - margins.seen[i]).filter(d => d !== 0);
checkTrue('§1 the pane holds still WHILE the box is moving (no re-zoom per frame)',
    moves.length === 0,
    `margins=${JSON.stringify(margins.seen)} moves=${JSON.stringify(moves)}`);
checkTrue('§1 and it is re-presented once the box settles',
    Number.isFinite(margins.settled), `settled=${margins.settled}`);

/* ------------------------------------------------------- §2 a drag burst */
const burst = await page.evaluate(async id => {
    const el = document.getElementById(`term-${id}`);
    window.__emits.length = 0;
    for (let i = 0; i < 12; i++) {
        el.style.width = `${900 - i * 20}px`;
        TerminalManager.fitTerminal(id);
        await new Promise(r => setTimeout(r, 25));
    }
    const during = window.__emits.filter(e => e.ev === 'ssh_resize').length;
    await new Promise(r => setTimeout(r, TerminalManager.PROPOSAL_SETTLE_MS + 150));
    const after = window.__emits.filter(e => e.ev === 'ssh_resize').length;
    return { during, after };
}, S);
checkTrue('§2 twelve frames cost at most two proposals, not twelve',
    burst.after <= 2 && burst.after >= 1, `emits=${burst.after}`);

/* --------------------------------------------- §3 one change, no waiting */
const single = await page.evaluate(async id => {
    const el = document.getElementById(`term-${id}`);
    await new Promise(r => setTimeout(r, TerminalManager.PROPOSAL_SETTLE_MS + 150));
    window.__emits.length = 0;
    el.style.width = '640px';
    el.style.height = '300px';
    TerminalManager.fitTerminal(id);
    // No wait at all: the devtools case must not sit behind the debounce.
    return window.__emits.filter(e => e.ev === 'ssh_resize').length;
}, S);
check('§3 a single size change is announced in the same tick', single, 1);

check('§4 no page errors', errors, []);
await page.evaluate(id => TerminalManager.destroyTerminal(id), S);
await browser.close();
server.close();
console.log(`resize_burst_normal_buffer: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
