/*
 * W14 item 7 — strip '+' gate (owner instruction).
 *
 * The SAME #newConnectionBtn node is the permanent FIRST CHILD of
 * .session-tabs-row in ALL viewports, icon-only, 44px on touch. It is no
 * longer relocated into #mobileMoreSheet, and the strip stays anchored with
 * ZERO sessions because the button is inside it. This suite pins:
 *
 *   §A  with zero sessions the strip row paints on every tier and the
 *       icon-only first child is visible and reachable;
 *   §B  one tap opens the connection modal exactly once (desktop, tablet,
 *       phone);
 *   §C  the node carries its accessible name (title + aria-label) at every
 *       tier, with the text label hidden everywhere;
 *   §D  the sheet never hosts the button on touch;
 *   §Z  zero page errors per tier.
 *
 * Tiers: desktop 1440x900 (fine pointer), tablet 834x1194 (coarse),
 * phone 390x844 (coarse).
 *
 * Run: node tests/browser/strip_new_connection.mjs   (from source/)
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
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (typeof actual === 'object' && actual !== null
        || typeof expected === 'object' && expected !== null) {
        actual = JSON.stringify(actual);
        expected = JSON.stringify(expected);
    }
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
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

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
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
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

const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = {
        connected: false,
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket,
        configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const TIERS = [
    { tag: 'D', label: 'desktop 1440x900', w: 1440, h: 900, touch: false },
    { tag: 'T', label: 'tablet 834x1194', w: 834, h: 1194, touch: true },
    { tag: 'P', label: 'phone 390x844', w: 390, h: 844, touch: true },
];

for (const tier of TIERS) {
    const ctx = await browser.newContext({
        viewport: { width: tier.w, height: tier.h },
        hasTouch: tier.touch, isMobile: tier.touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && !!window.TouchActionRow, null, { timeout: 15000 });
    await page.waitForTimeout(150);

    // §A zero sessions: the strip row paints and the icon-only first child is
    // visible. On phone the row itself is display:contents, so visibility is
    // asserted on the button's own box.
    const home = await page.evaluate(() => {
        const btn = document.getElementById('newConnectionBtn');
        if (!btn) return { missing: true };
        const row = btn.closest('.session-tabs-row');
        const cs = getComputedStyle(btn);
        const boxless = btn.offsetParent === null
            && btn.getClientRects().length === 0;
        return {
            nodes: document.querySelectorAll('#newConnectionBtn').length,
            rowPaints: !!row && getComputedStyle(row).display !== 'none',
            firstChild: btn.parentElement?.firstElementChild === btn,
            nextIsStrip: btn.nextElementSibling?.id === 'sessionTabs',
            visible: !boxless && cs.display !== 'none'
                && cs.visibility !== 'hidden',
            height: Math.round(btn.getBoundingClientRect().height),
            labelHidden: getComputedStyle(
                btn.querySelector('.btn-label')).display === 'none',
            title: btn.getAttribute('title'),
            aria: btn.getAttribute('aria-label'),
            inSheet: !!btn.closest('#mobileMoreSheet'),
        };
    });
    check(`§A ${tier.label}: the strip row paints with zero sessions`,
        [!!home.rowPaints, home.nodes], [true, 1]);
    check(`§A ${tier.label}: the '+' is the strip's first child`,
        [home.firstChild, home.nextIsStrip], [true, true]);
    check(`§A ${tier.label}: the '+' is visible`, home.visible, true);
    check(`§A ${tier.label}: the '+' is icon-only with its name intact`,
        [home.labelHidden, home.title, home.aria],
        [true, 'New Connection', 'New Connection']);
    check(`§A ${tier.label}: tier-appropriate target height`,
        tier.touch ? (home.height >= 44) : (home.height >= 28), true);

    // §B one tap opens the connection modal exactly once.
    await page.evaluate(() => {
        window.__plusHits = 0;
        document.getElementById('newConnectionBtn').addEventListener('click',
            () => { window.__plusHits += 1; });
    });
    if (tier.touch) {
        await page.locator('#newConnectionBtn').tap();
    } else {
        await page.click('#newConnectionBtn');
    }
    await page.waitForTimeout(120);
    check(`§B ${tier.label}: one tap fires exactly once and opens the modal`,
        await page.evaluate(() => ({
            hits: window.__plusHits,
            modalShown: document.getElementById('connectionModal')
                ?.classList.contains('show') === true,
        })), { hits: 1, modalShown: true });
    await page.evaluate(() => {
        document.querySelectorAll('.modal.show').forEach(modal => {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        });
    });

    // §D on touch, open the More sheet and prove the button was never taken in.
    if (tier.touch) {
        // The sheet's trigger lives in the (hidden-at-rest) session bar.
        await page.evaluate(() => document.getElementById('sessionBar')
            ?.classList.remove('hidden'));
        await page.click('#mobileMoreBtn');
        await page.waitForTimeout(120);
        check(`§D ${tier.label}: the More sheet never hosts the strip '+'`,
            await page.evaluate(() => {
                const btn = document.getElementById('newConnectionBtn');
                return {
                    sheetOpen: !document.getElementById('mobileMoreSheet').hidden,
                    inSheet: !!btn.closest('#mobileMoreSheet'),
                    stillFirstChild: btn.parentElement?.firstElementChild === btn,
                };
            }), { sheetOpen: true, inSheet: false, stillFirstChild: true });
        // Close the sheet again.
        await page.click('#mobileMoreBtn');
        await page.waitForTimeout(80);
    }

    check(`§Z ${tier.label}: no page errors`, errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
