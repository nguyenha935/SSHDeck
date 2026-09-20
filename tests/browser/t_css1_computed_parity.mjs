/*
 * T-CSS1 (plan §8.7) — computed-style equality across S12.
 *
 * S12 rewrites three CSS COMMENT blocks in style.css and changes no declaration.
 * D-3 (iv) is decided: zero `touch-action` declarations are added, removed or
 * changed on any element that exists. The only way to prove a comment rewrite is
 * behaviour-free is to read the COMPUTED style before and after and require
 * exact equality -- grepping the declaration text cannot distinguish "written
 * correctly" from "resolving in the wrong scope" (AGENTS.md §3, step 4).
 *
 * VIEWS,: the three `.pane-pannable` selectors are GONE from this
 * comparison because the state itself is gone. A view is drawn by tmux clipped
 * to this client's own size, so no pane ever renders a grid wider than itself
 * and nothing is ever added to that class; a selector that can no longer match
 * contributes an empty column to both sides of the equality and proves nothing.
 * The base `.xterm-viewport` rule is now read by EVERY viewport, which is why
 * the ":not(.pane-pannable)" qualifier went with them -- with no competing
 * specificity there is nothing left to mask it.
 *
 * Selectors (plan §8.7):
 *   .terminal-wrapper.unassigned
 *   .xterm
 *   .xterm-screen
 *   .xterm-viewport   (base, style.css:5563-5571)
 *
 * Properties: touch-action, overflow-x, overflow-y, overscroll-behavior-x,
 * width, min-width, max-width, display.
 *
 * Animations are frozen before any geometry read (AGENTS.md §2: a rect measured
 * mid-animation is a different rect).
 *
 * Usage:
 *   node tests/browser/t_css1_computed_parity.mjs --emit  > baseline.json
 *   node tests/browser/t_css1_computed_parity.mjs --against baseline.json
 * The second form exits non-zero on any difference and names the property.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const EMIT = args.includes('--emit');
const againstIdx = args.indexOf('--against');
const AGAINST = againstIdx >= 0 ? args[againstIdx + 1] : null;

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail = '') {
    if (ok) { pass++; if (!EMIT) console.log(`PASS  ${label}`); }
    else {
        fail++;
        const m = `FAIL  ${label}${detail ? ` (${detail})` : ''}`;
        failures.push(m);
        if (!EMIT) console.log(m);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
function renderTemplate(rel) {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, id: 'device_a_socket', io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; }, once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) { window.__emits.push({ evt, payload }); return sock; },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.io = () => sock;
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html')); return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE); return;
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
const BASE = `http://127.0.0.1:${server.address().port}`;

const PROPS = ['touch-action', 'overflow-x', 'overflow-y',
    'overscroll-behavior-x', 'width', 'min-width', 'max-width', 'display'];

// Two viewports: the touch shell where every touch-action decision lives, and a
// desktop where the pannable state must never appear.
const VIEWPORTS = [
    { label: 'phone390x844', width: 390, height: 844, touch: true },
    { label: 'desktop1440x900', width: 1440, height: 900, touch: false },
];

const browser = await chromium.launch({ headless: true });
const snapshot = {};

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.touch, isMobile: vp.touch,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);
    // Freeze animations BEFORE any computed/geometry read.
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });

    await page.evaluate(() => {
        SessionManager.setSplitLayout(2, '2-col');
        SessionManager.createSession({
            session_id: 'c1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 't-css1', via_jump: null,
        });
        SessionManager.assignSessionToPane('c1', 0);
        SessionManager.setActivePane(0);
        // A SECOND session in pane 1, so the page carries more than one live
        // viewport and a rule that resolves for one pane only would show up.
        SessionManager.createSession({
            session_id: 'c2', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny fits',
            use_tmux: false, tmux_session_name: null, via_jump: null,
        });
        SessionManager.assignSessionToPane('c2', 1);
        /*
         * A THIRD session, never put in a pane. createSession builds its wrapper
         * as `terminal-wrapper unassigned` (session-manager.js:253/354) and only
         * assignSessionToPane strips the class, so this is the production path
         * that makes `.terminal-wrapper.unassigned` a real element. Without it
         * that selector resolves to null and its eight property comparisons
         * would be vacuous on both sides of the S12 edit — an equality that
         * proves nothing.
         */
        SessionManager.createSession({
            session_id: 'c3', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny idle',
            use_tmux: false, tmux_session_name: null, via_jump: null,
        });
    });
    await page.waitForTimeout(400);

    // Paint real content, so the viewport has a scroller and the properties
    // being compared are resolved against a live box rather than an empty one.
    const built = await page.evaluate(async () => {
        const term = TerminalManager.terminals['c1'];
        if (!term) return { error: 'terminal c1 missing' };
        for (let i = 1; i <= 60; i++) term.write(`t-css1 line ${i}\r\n`);
        await new Promise(r => setTimeout(r, 150));
        return {
            unassignedCount: document.querySelectorAll('.terminal-wrapper.unassigned').length,
            viewportCount: document.querySelectorAll(
                '.terminal-wrapper .xterm-viewport').length,
        };
    });

    if (built.error) {
        check(`${vp.label}: harness precondition failed loudly`, false, built.error);
        await ctx.close();
        continue;
    }

    // Preconditions: an absent element cannot prove equality, so every selector
    // below must resolve to a real element before its properties are compared.
    check(`${vp.label} precondition: the terminal built without a page error`,
        pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check(`${vp.label} precondition: an unassigned wrapper really exists`,
        built.unassignedCount > 0, `count=${built.unassignedCount}`);
    check(`${vp.label} precondition: a viewport exists (reads the base rule)`,
        built.viewportCount > 0, `count=${built.viewportCount}`);
    const readAll = await page.evaluate((props) => {
        const SELECTORS = [
            '.terminal-wrapper.unassigned',
            '.xterm',
            '.xterm-screen',
            // The BASE .xterm-viewport rule. No more specific rule competes
            // with it now, so any viewport reads it.
            '.terminal-wrapper .xterm-viewport',
        ];
        const out = {};
        for (const sel of SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) { out[sel] = null; continue; }
            const cs = getComputedStyle(el);
            const rec = {};
            for (const p of props) rec[p] = cs.getPropertyValue(p);
            out[sel] = rec;
        }
        return out;
    }, PROPS);

    snapshot[vp.label] = readAll;
    await ctx.close();
}

await browser.close();
server.close();

if (EMIT) {
    console.log(JSON.stringify(snapshot, null, 2));
    // Preconditions still have to hold when a baseline is taken: a snapshot of a
    // page that failed to build is not a baseline. They go to stderr so stdout
    // stays pure JSON.
    if (failures.length) {
        failures.forEach(f => console.error(f));
        console.error(`baseline preconditions: ${pass} passed, ${fail} failed.`);
    }
    process.exit(fail === 0 ? 0 : 1);
}

if (!AGAINST) {
    console.log('usage: --emit  |  --against <baseline.json>');
    process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(AGAINST, 'utf8'));

for (const label of Object.keys(baseline)) {
    const before = baseline[label];
    const after = snapshot[label];
    check(`${label}: the viewport was measured in both runs`, !!after,
        after ? '' : 'missing from this run');
    if (!after) continue;
    for (const sel of Object.keys(before)) {
        // A selector that resolved before must still resolve, and one that did
        // not must still not: appearing or vanishing is itself a change.
        check(`${label} ${sel}: element presence unchanged`,
            (before[sel] === null) === (after[sel] === null),
            `before=${before[sel] === null ? 'absent' : 'present'} `
            + `after=${after[sel] === null ? 'absent' : 'present'}`);
        if (before[sel] === null || after[sel] === null) continue;
        for (const p of PROPS) {
            check(`${label} ${sel} { ${p} }`,
                before[sel][p] === after[sel][p],
                `before="${before[sel][p]}" after="${after[sel][p]}"`);
        }
    }
}

if (failures.length) {
    console.log('\n--- FAILURES ---');
    failures.forEach(f => console.log(f));
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
