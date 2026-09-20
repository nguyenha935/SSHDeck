/*
 * Item 1: mobile New Connection — visual weight.
 *
 * The owner's repro: on touch the '+' looks BIGGER and heavier than intended,
 * with an extra framed pill. Root cause: the strip rules
 * (style.css #newConnectionBtn.strip-new-connection) never declare a border,
 * so deck.css's `.header .btn.btn-primary { border: 1px solid var(--tw-accent) }`
 * survives on the touch shell and draws a frame around the 40px ::before pill
 * inside the 44px box.
 *
 * This suite pins the owner's ruling on every coarse tier:
 *   §B  computed border on the strip '+' is 0 — no framed pill;
 *   §V  the painted visual (the ::before pill) is <= 40px and INSIDE the box;
 *   §H  the hit target stays >= 44px — the fix must never shrink the touch
 *       target (that floor is pinned by strip_new_connection.mjs).
 *
 * Run: node tests/browser/owner_batch_strip_visual.mjs   (from source/)
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
    window.socket = { connected: false, on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop } };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const TIERS = [
    { label: 'phone-portrait', w: 390, h: 844 },
    { label: 'phone-landscape', w: 844, h: 390 },
    { label: 'tablet-portrait', w: 834, h: 1194 },
];
for (const tier of TIERS) {
    const ctx = await browser.newContext({ viewport: { width: tier.w, height: tier.h }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
        const btn = document.getElementById('newConnectionBtn');
        if (!btn) return null;
        const cs = getComputedStyle(btn);
        const box = btn.getBoundingClientRect();
        // The visual pill is the ::before the coarse rules paint.
        const pill = getComputedStyle(btn, '::before');
        const pillRect = (() => {
            // ::before has no direct rect API; measure via the button box
            // minus the declared inset (2px) when positioned absolute.
            if (pill.position !== 'absolute') return null;
            const top = parseFloat(pill.top) || 0;
            const right = parseFloat(pill.right) || 0;
            return { w: box.width - top - right, h: box.height - top - right };
        })();
        return {
            borderTop: cs.borderTopWidth, borderRight: cs.borderRightWidth,
            borderBottom: cs.borderBottomWidth, borderLeft: cs.borderLeftWidth,
            boxW: Math.round(box.width), boxH: Math.round(box.height),
            pillW: pillRect ? Math.round(pillRect.w) : null,
            pillH: pillRect ? Math.round(pillRect.h) : null,
            pillPosition: pill.position,
            visible: !!(box.width && box.height),
        };
    });
    if (!m) {
        check(`§B ${tier.label}: newConnectionBtn exists`, null, 'element');
        await ctx.close();
        continue;
    }
    check(`§B ${tier.label}: no border-top (no framed pill)`, m.borderTop, '0px');
    check(`§B ${tier.label}: no border-right`, m.borderRight, '0px');
    check(`§B ${tier.label}: no border-bottom`, m.borderBottom, '0px');
    check(`§B ${tier.label}: no border-left`, m.borderLeft, '0px');
    check(`§V ${tier.label}: pill visual painted via positioned ::before`, m.pillPosition, 'absolute');
    check(`§V ${tier.label}: pill width <= 40px (visual not oversized)`, m.pillW !== null && m.pillW <= 40, true);
    check(`§V ${tier.label}: pill height <= 40px`, m.pillH !== null && m.pillH <= 40, true);
    check(`§H ${tier.label}: hit target width >= 44px`, m.boxW >= 44, true);
    check(`§H ${tier.label}: hit target height >= 44px`, m.boxH >= 44, true);
    check(`§Z ${tier.label}: no page errors`, errors, []);
    await ctx.close();
}
await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
