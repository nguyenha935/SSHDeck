#!/usr/bin/env node
/*
 * W5 focused test — header-menus.js sessionBar MutationObserver ownership.
 *
 * Runs against the REAL files served over HTTP (never a copy, never a
 * reimplementation). MutationObserver is instrumented with per-instance
 * counters; instances are filtered to those observing #sessionBar.
 *
 * Part A (standalone header-menus.js):
 *   §1 init 1 → exactly 1 sessionBar observer, observeCount 1,
 *      disconnectCount 0, anchor === inst0.
 *   §2 init 2 (re-evaluation of the same source) → 2 instances,
 *      inst0.disconnectCount === 1, inst1.disconnectCount === 0,
 *      anchor === inst1.
 *   §3 HeaderMenus.cleanup() → inst1.disconnectCount === 1, anchor deleted;
 *      repeated cleanup leaves disconnectCount at exactly 1 (idempotent).
 *   §4 init 3 → inst1.disconnectCount STILL 1 (proof that cleanup cleared the
 *      anchor — otherwise init 3 would have disconnected it again),
 *      inst2.disconnectCount === 0, anchor === inst2.
 *
 * Part B (real full app page — app.js registers the pagehide listener):
 *   §5 dispatching `pagehide` on window calls HeaderMenus.cleanup() exactly
 *      once and deletes the element anchor.
 *
 * Run: node tests/browser/header_observer_cleanup.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
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
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
            return;
        }
        if (rel === '/part-a') {
            // Minimal standalone page for Part A.
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><div id="sessionBar"></div></body></html>`);
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

// Instrumentation installed BEFORE any app script runs. Every instance records
// observe/disconnect counts and its observed target.
const INSTRUMENT = `
    window.__obsInstances = [];
    const __OriginalMutationObserver = window.MutationObserver;
    window.MutationObserver = class extends __OriginalMutationObserver {
        constructor(callback) {
            super(callback);
            this.observeCount = 0;
            this.disconnectCount = 0;
            this.target = null;
            window.__obsInstances.push(this);
        }
        observe(target, options) {
            this.observeCount++;
            this.target = target;
            return super.observe(target, options);
        }
        disconnect() {
            this.disconnectCount++;
            return super.disconnect();
        }
    };
    // Snapshot helper: only instances that observed the sessionBar element.
    window.__barObservers = () => window.__obsInstances.filter(
        o => o.target && o.target.id === 'sessionBar');
    window.__anchorIs = (inst) => {
        const bar = document.getElementById('sessionBar');
        return !!bar && bar.__sshdeckClassObserver === inst;
    };
    window.__anchorPresent = () => {
        const bar = document.getElementById('sessionBar');
        return !!bar && '__sshdeckClassObserver' in bar
            && bar.__sshdeckClassObserver != null;
    };
`;

// ============================================================================
// Part A — standalone header-menus.js, real source re-evaluated for re-init.
// ============================================================================
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript(`
        window.i18n = {
            t: (k, d) => d || k,
            getLanguages: () => [],
            getLanguage: () => 'en',
            setLanguage: () => {},
        };
        window.ModalManager = { open() {}, close() {} };
    `);
    await page.goto(`${base}/part-a`, { waitUntil: 'load' });

    // init 1 — load the real file.
    await page.addScriptTag({ url: `${base}/static/js/header-menus.js` });
    await page.waitForTimeout(20);

    let obs = await page.evaluate(() => window.__barObservers());
    check('§1 init 1 creates exactly one sessionBar observer', obs.length, 1);
    check('§1 that observer has observeCount 1', obs[0] && obs[0].observeCount, 1);
    check('§1 that observer has disconnectCount 0', obs[0] && obs[0].disconnectCount, 0);
    check('§1 the element anchor references that observer',
        await page.evaluate(() => window.__anchorIs(window.__barObservers()[0])), true);
    check('§1 HeaderMenus.cleanup is exposed',
        await page.evaluate(() => typeof window.HeaderMenus?.cleanup), 'function');

    // init 2 — re-evaluate the SAME real source (fresh IIFE scope).
    const src = fs.readFileSync(path.join(ROOT, 'static/js/header-menus.js'), 'utf8');
    await page.addScriptTag({ content: src });
    await page.waitForTimeout(20);

    obs = await page.evaluate(() => window.__barObservers());
    check('§2 re-init creates a second sessionBar observer', obs.length, 2);
    check('§2 re-init disconnects the FIRST observer exactly once',
        obs[0] && obs[0].disconnectCount, 1);
    check('§2 the second observer is not disconnected by re-init',
        obs[1] && obs[1].disconnectCount, 0);
    check('§2 the second observer has observeCount 1', obs[1] && obs[1].observeCount, 1);
    check('§2 the element anchor now references the second observer',
        await page.evaluate(() => window.__anchorIs(window.__barObservers()[1])), true);

    // cleanup() — disconnects the current (second) observer, clears the anchor.
    await page.evaluate(() => window.HeaderMenus.cleanup());
    obs = await page.evaluate(() => window.__barObservers());
    check('§3 cleanup() disconnects the current observer exactly once',
        obs[1] && obs[1].disconnectCount, 1);
    check('§3 cleanup() does NOT touch the first observer again',
        obs[0] && obs[0].disconnectCount, 1);
    check('§3 cleanup() deletes the element anchor',
        await page.evaluate(() => window.__anchorPresent()), false);

    // Idempotency — repeated cleanup must not disconnect again.
    await page.evaluate(() => {
        window.HeaderMenus.cleanup();
        window.HeaderMenus.cleanup();
        window.HeaderMenus.cleanup();
    });
    obs = await page.evaluate(() => window.__barObservers());
    check('§3 repeated cleanup() leaves disconnectCount at exactly 1',
        obs[1] && obs[1].disconnectCount, 1);

    // init 3 — anchor was cleared, so the first-two observers are untouched.
    await page.addScriptTag({ content: src });
    await page.waitForTimeout(20);

    obs = await page.evaluate(() => window.__barObservers());
    check('§4 init 3 creates a third sessionBar observer', obs.length, 3);
    check('§4 init 3 does NOT re-disconnect observer 2 (anchor was cleared)',
        obs[1] && obs[1].disconnectCount, 1);
    check('§4 the third observer has disconnectCount 0',
        obs[2] && obs[2].disconnectCount, 0);
    check('§4 the third observer has observeCount 1', obs[2] && obs[2].observeCount, 1);
    check('§4 the element anchor references the third observer',
        await page.evaluate(() => window.__anchorIs(window.__barObservers()[2])), true);
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// Part B — real full app page: app.js registers the pagehide listener that
//          calls HeaderMenus.cleanup().
// ============================================================================
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript(`
        const noop = () => {};
        window.socket = {
            connected: true, on: noop, off: noop, once: noop, emit: noop,
            io: { on: noop },
        };
        window.showNotification = noop;
        window.ModalManager = {
            open: (m) => m && m.classList.add('show'),
            close: (m) => m && m.classList.remove('show'),
            trapFocus: noop,
        };
        window.clearConnectionProfileState = noop;
        window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
        window.i18n = {
            t: (k, d) => d || k,
            getLanguages: () => [],
            getLanguage: () => 'en',
            setLanguage: () => {},
        };
    `);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(80);

    check('§5 real page exposes HeaderMenus.cleanup',
        await page.evaluate(() => typeof window.HeaderMenus?.cleanup), 'function');
    check('§5 real page anchored one sessionBar observer',
        await page.evaluate(() => window.__barObservers().length), 1);

    // Spy on cleanup, then dispatch the real pagehide event that app.js listens
    // for. The listener resolves window.HeaderMenus.cleanup at call time.
    await page.evaluate(() => {
        window.__cleanupCalls = 0;
        const orig = window.HeaderMenus.cleanup.bind(window.HeaderMenus);
        window.HeaderMenus.cleanup = function () {
            window.__cleanupCalls++;
            return orig();
        };
    });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(20);

    check('§5 pagehide dispatch calls HeaderMenus.cleanup() exactly once',
        await page.evaluate(() => window.__cleanupCalls), 1);
    check('§5 pagehide disconnected the anchored observer',
        await page.evaluate(() => window.__barObservers()[0].disconnectCount), 1);
    check('§5 pagehide deleted the element anchor',
        await page.evaluate(() => window.__anchorPresent()), false);
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
