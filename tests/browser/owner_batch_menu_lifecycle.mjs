/*
 * Item 3: short-screen mobile menu reachability.
 *
 * The More sheet is positioned by header-menus.js positionMobileMore() with
 * an inline `top`. On a SHORT viewport the sheet's content can extend below
 * the visible area, hiding its lower actions behind the composer dock. The
 * owner's ruling: assigning scrollTop is not proof of reachability; the test
 * must prove the LAST real row is reachable by scrolling the sheet. The
 * contract pinned here: after opening on a short viewport, scrolling the
 * sheet makes the last action row's bottom land at or above the sheet's
 * visible bottom (and the visible bottom stays above the composer dock), and
 * every row is hit-testable once scrolled. The BFCache half of the original
 * audit (item 4) lives in owner_batch_bfcache_lifecycle.mjs.
 *
 * Run: node tests/browser/owner_batch_menu_lifecycle.mjs   (from source/)
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
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

// SHORT phone portrait: 390x600 — the owner's low-screen repro.
{
    const ctx = await browser.newContext({ viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.waitForTimeout(200);

    // Open the More sheet.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(350);

    const before = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const rows = [...sheet.querySelectorAll('.account-action, .account-item, button, a[href]')];
        const last = rows.filter(r => r.getClientRects().length).pop() || null;
        const sheetRect = sheet.getBoundingClientRect();
        return {
            open: !sheet.hidden,
            scrollHeight: sheet.scrollHeight,
            clientHeight: sheet.clientHeight,
            sheetBottom: Math.round(sheetRect.bottom),
            scrollTop0: sheet.scrollTop,
            lastLabel: last ? (last.textContent || '').trim().slice(0, 40) : null,
            lastBottomBefore: last ? Math.round(last.getBoundingClientRect().bottom) : null,
            viewportH: window.innerHeight,
        };
    });
    check('§M sheet opens on the short viewport', before.open, true);
    check('§M content overflows on a 600px viewport (scroll needed)', before.scrollHeight > before.clientHeight, true);

    // The FIX (owner batch item 3): positionMobileMore() now clamps the
    // inline maxHeight to the real space above the composer dock. Assert the
    // clamp itself first: the sheet's painted bottom sits at or above the
    // dock's top, so NOTHING of the menu renders behind the composer.
    const clamp = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const dock = document.getElementById('sessionBar');
        return {
            inlineMaxHeight: sheet.style.maxHeight || null,
            sheetBottom: sheet.getBoundingClientRect().bottom,
            dockTop: dock.getBoundingClientRect().top,
        };
    });
    check('§M positionMobileMore clamps the sheet with an inline maxHeight',
        clamp.inlineMaxHeight !== null, true);
    check('§M the clamped sheet ends at or above the composer dock',
        clamp.sheetBottom <= clamp.dockTop + 1, true);

    // Touch-scroll contract for the real device: the sheet must be a native
    // overflow scroller with iOS momentum — the swipe gesture then belongs to
    // it. Headless Chromium cannot drive native overflow-scrolling through a
    // synthetic touch drag (a real-device limitation of this harness, the same
    // one documented for bfcache), so the swipe itself is asserted by
    // contract here and driven below by a REAL scroll event (wheel), never by
    // assigning scrollTop — which is exactly the false proof the owner ruled
    // out.
    const touchContract = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const cs = getComputedStyle(sheet);
        return {
            overflowY: cs.overflowY,
            momentum: cs.webkitOverflowScrolling,
        };
    });
    // Headless Chromium computes -webkit-overflow-scrolling as undefined and
    // its CSSOM iteration skips cross-origin sheets, so the WebKit-only
    // momentum is asserted against the SERVED css text -- the exact cascade
    // the phone loads.
    const cssText = await page.evaluate(() =>
        fetch('/static/css/style.css').then(r => r.text()));
    // Find the sheet's open-state rule and check the momentum declaration
    // appears within its block (the rule sits deep in the same block as the
    // selector, so match from the last sheet selector before the declaration).
    const momentumAt = cssText.indexOf('-webkit-overflow-scrolling: touch;');
    const lastSheetSelectorBefore = cssText.lastIndexOf('.mobile-more-sheet', momentumAt);
    touchContract.momentumDeclared = momentumAt !== -1
        && lastSheetSelectorBefore !== -1
        && cssText.slice(lastSheetSelectorBefore, momentumAt).includes('{');
    check('§M the sheet is a native vertical scroller', touchContract.overflowY, 'auto');
    // -webkit-overflow-scrolling is WebKit-only; headless Chromium does not
    // compute it. Assert the declaration is present in the cascade instead of
    // a computed value the harness cannot produce.
    check('§M the sheet keeps iOS momentum scrolling (declared)',
        touchContract.momentum === 'touch' || touchContract.momentumDeclared, true);

    // Real scroll: a genuine wheel event over the sheet (fires the scroll
    // event natively) until the last row is fully inside.
    await page.evaluate(() => {
        window.__sheetScrolled = 0;
        document.getElementById('mobileMoreSheet')
            .addEventListener('scroll', () => { window.__sheetScrolled++; }, { passive: true });
    });
    const sheetBox = await page.evaluate(() => {
        const r = document.getElementById('mobileMoreSheet').getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width / 2),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            height: Math.round(r.height),
        };
    });
    let reachable = false;
    for (let i = 0; i < 8 && !reachable; i++) {
        await page.mouse.move(sheetBox.x, sheetBox.top + sheetBox.height / 2);
        await page.mouse.wheel(0, sheetBox.height);
        await page.waitForTimeout(250);
        reachable = await page.evaluate(() => {
            const sheet = document.getElementById('mobileMoreSheet');
            const rows = [...sheet.querySelectorAll('.account-action, .account-item, button, a[href]')];
            const last = rows.filter(r => r.getClientRects().length).pop();
            if (!last) return false;
            return last.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().bottom + 1;
        });
    }
    check('§M the last action row becomes reachable by scrolling the sheet', reachable, true);

    const after = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const dock = document.getElementById('sessionBar');
        const rows = [...sheet.querySelectorAll('.account-action, .account-item, button, a[href]')];
        const last = rows.filter(r => r.getClientRects().length).pop();
        const lastRect = last ? last.getBoundingClientRect() : null;
        const dockRect = dock.getBoundingClientRect();
        const hit = lastRect && lastRect.height
            ? document.elementFromPoint(lastRect.left + lastRect.width / 2,
                Math.min(lastRect.top + lastRect.height / 2, window.innerHeight - 2)) : null;
        return {
            scrollEvents: window.__sheetScrolled,
            scrollTop: sheet.scrollTop,
            lastBottom: lastRect ? Math.round(lastRect.bottom) : null,
            dockTop: Math.round(dockRect.top),
            lastWithinDock: lastRect ? lastRect.bottom <= dockRect.top + 1 : null,
            hitIsRow: !!(hit && last && (hit === last || last.contains(hit))),
        };
    });
    check('§M scrolling happened through a real scroll event', after.scrollEvents > 0, true);
    check('§M the last row ends above the composer dock band', after.lastWithinDock, true);
    check('§M the last row is hit-testable at its painted position', after.hitIsRow, true);
    check('§Z phone: no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
