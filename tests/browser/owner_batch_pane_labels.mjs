/*
 * Item 7 (owner batch, NEW OWNER RULING — supersedes mockup
 * 255-256): split-pane name/number labels are too large and cover terminal
 * content. The pane badge was 19px filled-accent with an unbounded name
 * span; on a phone split it reads heavy and hides text.
 *
 * The owner's replacement ruling: the label must be compact — a small badge
 * (<= 16px), a name that ellipsizes instead of running wide, low visual
 * weight, and it must keep sitting out of the way: pointer-events none, top
 * band only, never reaching into the terminal's content area.
 *
 * Pinned on a real 2-pane split with a named session:
 *   §B badge box <= 16px both dimensions, font-size <= 12px;
 *   §N the name span has a max-width and ellipsis (never runs off the pane);
 *   §W the whole label stays in the top band (bottom <= 30% of pane height)
 *      and keeps pointer-events: none;
 *   §V a long session name does not widen the label past the pane width.
 *
 * Run: node tests/browser/owner_batch_pane_labels.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = Array.isArray(actual) ? actual.join(', ') : actual;
    const e = Array.isArray(expected) ? expected.join(', ') : expected;
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${JSON.stringify(e)}\n        actual   ${JSON.stringify(a)}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png' };
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}
const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return; }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = { connected: true, on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop } };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(STUBS);
await page.goto(base, { waitUntil: 'load' });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 15000 });
await page.waitForTimeout(200);

// Two panes with one long-named session so labels render.
await page.evaluate(() => {
    SessionManager.setSplitLayout(2);
    const longName = 'production-db-primary-very-long-endpoint-name.internal.example.com';
    SessionManager.sessions.LONG = { id: 'LONG', session_id: 'LONG', host: 'h', port: 22,
        username: 'u', authType: 'key', keyId: 'k', jumpHostId: null, displayName: longName,
        connected: true, isPersistentCandidate: false, tmuxSessionName: 't_L',
        terminalId: 'term-long', useTmux: true, viaJump: null, latencyMs: null };
    SessionManager.createSessionTab('LONG', 'h', 'u');
});
await page.waitForTimeout(300);

const m = await page.evaluate(() => {
    const label = document.querySelector('.terminal-pane .pane-label');
    if (!label) return null;
    const pane = label.closest('.terminal-pane');
    const paneRect = pane.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const badge = label.querySelector('.pane-number-badge');
    const name = label.querySelector('.pane-name, span:not(.pane-number-badge)');
    const lcs = getComputedStyle(label);
    const bcs = badge ? getComputedStyle(badge) : null;
    const ncs = name ? getComputedStyle(name) : null;
    const badgeRect = badge ? badge.getBoundingClientRect() : null;
    return {
        labelPointerEvents: lcs.pointerEvents,
        labelBottomFrac: (labelRect.bottom - paneRect.top) / paneRect.height,
        labelFits: labelRect.right <= paneRect.right + 1,
        badgeW: badgeRect ? Math.round(badgeRect.width) : null,
        badgeH: badgeRect ? Math.round(badgeRect.height) : null,
        badgeFont: bcs ? parseFloat(bcs.fontSize) : null,
        nameMaxWidth: ncs ? ncs.maxWidth : null,
        nameEllipsis: ncs ? ncs.textOverflow : null,
        nameOverflow: ncs ? ncs.overflow : null,
    };
});
check('§0 pane label renders on the split pane', !!m, true);
if (m) {
    check('§B badge width <= 16px', m.badgeW !== null && m.badgeW <= 16, true);
    check('§B badge height <= 16px', m.badgeH !== null && m.badgeH <= 16, true);
    check('§B badge font-size <= 12px', m.badgeFont !== null && m.badgeFont <= 12, true);
    check('§N name span caps width (max-width set)', m.nameMaxWidth !== 'none' && m.nameMaxWidth !== null, true);
    check('§N name span ellipsizes', m.nameEllipsis, 'ellipsis');
    check('§N name span hides overflow', m.nameOverflow, 'hidden');
    check('§W label stays in the top band (<= 30% of pane)', m.labelBottomFrac <= 0.3, true);
    check('§W label keeps pointer-events: none', m.labelPointerEvents, 'none');
    check('§V a long session name never widens past the pane', m.labelFits, true);
}
check('§Z no page errors', errors, []);
await ctx.close();
await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
