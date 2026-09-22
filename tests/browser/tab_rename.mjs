#!/usr/bin/env node
/*
 * RENAMING A CONNECTION CHIP -- two owner reports, pinned.
 *
 *   "Khi đổi tên chip connect thì đang gõ đã bị lưu, chưa gõ xong cũng đã lưu."
 *   The input committed on ANY blur, and this app takes focus back by itself:
 *   focusActiveTerminal calls terminal.focus (session-manager.js:4511) and the
 *   tap paths focus the composer. So the app, not the person, decided when a
 *   half-typed name was final.
 *
 *   "Tạo connect mới tên chip bị đặt theo tên chip được đổi tên cuối cùng."
 *   The name was stored under `host:port:username` as well as under the
 *   session id, and every pane on one server shares that key -- so a new
 *   connection to that server inherited whichever chip was renamed last.
 *
 * Sections:
 *   §A  a rename stays with ITS session: a new session on the same
 *       host/port/user gets no name at all
 *   §B  focus taken by the app (terminal, its hidden textarea, the composer)
 *       does not commit and does not close the input
 *   §C  focus going to something the person clicked still commits
 *   §D  Enter commits, Escape cancels (the existing contract, unchanged)
 *   §Z  no page errors
 *
 * Run: node tests/browser/tab_rename.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
const browser = await chromium.launch();

const INIT = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.io = () => ({
        connected: true, on: record, off: noop, once: record,
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        io: { on: noop },
    });
    window.socket = window.io();
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'aaaa1111-name-4aaa-8aaa-000000000001';
const S2 = 'bbbb2222-name-4bbb-8bbb-000000000002';
const snapshot = (id) => ({
    snapshot_version: 1, session_id: id, host: 'h1', port: 22, username: 'root',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: `t-${id.slice(0, 4)}`, display_name: null,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
});

const pageErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*',
    r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(
    () => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined',
    null, { timeout: 15000 });
await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

const fire = (ev, payload) => page.evaluate(
    ([e, p]) => window.__server(e, p), [ev, payload ?? null]);

// The app's own route into the rename: pick the chip, then the sheet action.
const openRename = (id) => page.evaluate((s) => {
    SessionManager.setLifecycleActionTarget(s);
    SessionManager.dispatchLifecycleAction('rename');
    return !!document.querySelector('.tab-rename-input');
}, id);
/*
 * Typing must not THROW when the input is gone: an input that vanished is the
 * defect this suite is about, and a gate that crashes there prints no rows at
 * all. It reports the row and carries on.
 */
const typeName = async (text) => {
    const got = await page.evaluate((t) => {
        const input = document.querySelector('.tab-rename-input');
        if (!input) return null;
        input.value = t;
        return input.value;
    }, text);
    if (got === null) {
        fail++;
        console.log(`FAIL  the rename input was gone when "${text}" should have been typed`);
    }
    return got;
};
const state = (id) => page.evaluate((s) => ({
    displayName: SessionManager.sessions[s] ? SessionManager.sessions[s].displayName : '(gone)',
    inputOpen: !!document.querySelector('.tab-rename-input'),
    stored: (() => {
        try { return JSON.parse(localStorage.getItem('sessionDisplayNames') || '{}'); }
        catch (e) { return {}; }
    })(),
}), id);

await fire('ssh_session_restored', snapshot(S1));
await page.waitForTimeout(400);

// ── §D first: it establishes the baseline contract the others build on ──────
check('§D the rename input opens from the sheet action', await openRename(S1), true);
await typeName('ALPHA');
await page.evaluate(() => document.querySelector('.tab-rename-input')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
await page.waitForTimeout(200);
let s = await state(S1);
check('§D Enter commits the name', s.displayName, 'ALPHA');
check('§D and closes the input', s.inputOpen, false);

check('§D the rename input reopens after a commit', await openRename(S1), true);
await typeName('THROWN AWAY');
await page.evaluate(() => document.querySelector('.tab-rename-input')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
await page.waitForTimeout(200);
check('§D Escape keeps the previous name', (await state(S1)).displayName, 'ALPHA');

/*
 * §B THE APP TAKING FOCUS IS NOT A DECISION. terminal.focus() moves focus to
 * xterm's hidden textarea; the old handler read that blur as "done" and
 * committed whatever was typed so far.
 */
check('§B the rename input reopens', await openRename(S1), true);
await typeName('HALF TYP');
await page.evaluate((sid) => {
    const keys = TerminalManager.sessionTerminals[sid] || [];
    const term = TerminalManager.terminals[keys[0]];
    term.focus();
}, S1);
await page.waitForTimeout(300);
s = await state(S1);
check('§B the terminal taking focus does not commit', s.displayName, 'ALPHA');
check('§B and the input stays open', s.inputOpen, true);
const backOnInput = await page.evaluate(() => document.activeElement
    && document.activeElement.classList.contains('tab-rename-input'));
check('§B focus is handed back to the input', backOnInput, true);

// ── §C a person clicking elsewhere still commits ────────────────────────────
await typeName('BETA');
await page.evaluate(() => {
    const target = document.getElementById('newConnectionBtn')
        || document.querySelector('header button');
    target.focus();
});
await page.waitForTimeout(300);
s = await state(S1);
check('§C focus to a control the person clicked commits', s.displayName, 'BETA');
check('§C and closes the input', s.inputOpen, false);

/*
 * §A A NAME BELONGS TO ITS SESSION. S2 is a different session on the SAME
 * host/port/user -- the case the owner hit with three panes on one server.
 */
await fire('ssh_session_restored', snapshot(S2));
await page.waitForTimeout(400);
const s2 = await state(S2);
check('§A a new session on the same endpoint has no name', s2.displayName, null);
check('§A and nothing is stored under host:port:user',
    Object.keys(s2.stored).filter(k => k.includes('h1:22:root')), []);
check('§A while the renamed session keeps its own name',
    (await state(S1)).displayName, 'BETA');

check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\ntab_rename: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
