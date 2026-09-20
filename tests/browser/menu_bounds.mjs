/*
 * W14 item 2 — bounded menus gate (session-actions sheet + layout menu).
 *
 * The defect: .session-actions-sheet and .touch-layout-menu had NO max-height
 * and NO internal overflow. When the canonical tree outgrew a short viewport,
 * the tail rows were clipped -- indistinguishable from the reported
 * "scroll-locked" symptom, even though the document scroll-lock itself was
 * correctly scoped to the terminal shell.
 *
 * The fix bounds both surfaces with the same contract the More sheet already
 * carried (the "reaches the last row" contract): a viewport-derived finite
 * max-height, overflow-y:auto, overscroll-behavior:contain. This suite pins,
 * on a SHORT phone (390x600), a tablet (834x1194) and a short desktop
 * (1280x700):
 *   §B  computed max-height is finite (a px number) on both menus;
 *   §O  overflow-y is auto and overscroll-behavior contains contain;
 *   §L  the LAST row is reachable by scrolling: with extra rows injected,
 *       scrollHeight > clientHeight, scrollTop moves, and after scrolling to
 *       the end the last row's box sits inside the menu's own box;
 *   §F  the menu's own box fits inside the viewport (no tail clipping by the
 *       page edge);
 *   §Z  zero page errors per tier.
 *
 * The menus are opened through their REAL production paths:
 * TouchActionRow.openLayoutMenu() for #layoutMenu and
 * SessionManager.setLifecycleActionTarget() + openLifecycleSheet() for the
 * session-actions sheet.
 *
 * Run: node tests/browser/menu_bounds.mjs   (from source/)
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
    // The real socket.io client is unwanted: this gate scripts no server
    // traffic, and its UMD tail would overwrite the stub's io factory.
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

async function newPage(w, h, touch) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(150);
    return { ctx, page, errors };
}

// Seed one session so the lifecycle sheet has a real target.
async function seedSession(page, sid) {
    await page.evaluate((sid) => {
        const SM = SessionManager;
        SM.sessions[sid] = { id: sid, session_id: sid, host: 'mb.example', port: 22,
            username: 'mb', authType: 'key', keyId: 'k1', jumpHostId: null,
            displayName: 'Menu', connected: true, isPersistentCandidate: false,
            tmuxSessionName: null, terminalId: null, useTmux: false, viaJump: null };
        SM.activeSessionId = sid;
        if (!document.getElementById('tab-' + sid)) {
            SM.createSessionTab(sid, 'mb.example', 'mb');
        }
    }, sid);
    await page.waitForTimeout(80);
}

// The shared assertion block for one open menu.
async function auditMenu(page, tier, menuId, openFn) {
    await openFn();
    await page.waitForTimeout(200);
    const info = await page.evaluate((menuId) => {
        const menu = document.getElementById(menuId);
        const cs = getComputedStyle(menu);
        return {
            hidden: menu.hidden,
            maxHeightPx: parseFloat(cs.maxHeight),
            overflowY: cs.overflowY,
            overscroll: cs.overscrollBehavior,
            rect: {
                top: menu.getBoundingClientRect().top,
                bottom: menu.getBoundingClientRect().bottom,
                height: menu.getBoundingClientRect().height,
            },
            viewportH: window.innerHeight,
        };
    }, menuId);
    check(`§${tier} ${menuId}: the menu opens`, info.hidden, false);
    check(`§${tier} ${menuId}: max-height is a finite pixel value`,
        Number.isFinite(info.maxHeightPx) && info.maxHeightPx > 0, true);
    check(`§${tier} ${menuId}: overflow-y is auto`, info.overflowY, 'auto');
    check(`§${tier} ${menuId}: overscroll-behavior contains contain`,
        info.overscroll.includes('contain'), true);
    check(`§${tier} ${menuId}: the menu box fits inside the viewport`,
        info.rect.bottom <= info.viewportH + 1 && info.rect.top >= -1, true);

    // Reachability of the last row: inject tall clones so the menu MUST scroll,
    // scroll to the end, and prove the final row sits inside the menu's box.
    // Clones are forced to full-width 44px rows: the layout menu's own rows are
    // narrow grid chips (measured: inline-block clones lined up several per row
    // and 18 of them never crossed the bound), so only full-height rows make the
    // overflow assertion real for BOTH menu shapes.
    const reach = await page.evaluate((menuId) => {
        const menu = document.getElementById(menuId);
        const proto = menu.querySelector(
            '.session-action-item, .touch-layout-option, button, a') || menu.firstElementChild;
        const clones = [];
        for (let i = 0; i < 18; i++) {
            const c = proto.cloneNode(true);
            c.setAttribute('data-bounds-clone', '1');
            c.removeAttribute('id');
            c.style.display = 'block';
            c.style.width = '100%';
            c.style.minHeight = '44px';
            c.style.boxSizing = 'border-box';
            menu.appendChild(c);
            clones.push(c);
        }
        const natural = menu.scrollHeight;
        const client = menu.clientHeight;
        menu.scrollTop = menu.scrollHeight;
        const last = clones[clones.length - 1].getBoundingClientRect();
        const box = menu.getBoundingClientRect();
        const result = {
            scrolls: natural > client,
            scrollTop: menu.scrollTop,
            lastInside: last.bottom <= box.bottom + 1 && last.top >= box.top - 1,
        };
        clones.forEach(c => c.remove());
        return result;
    }, menuId);
    check(`§${tier} ${menuId}: injected rows force internal scrolling`, reach.scrolls, true);
    check(`§${tier} ${menuId}: scrollTop actually moves`, reach.scrollTop > 0, true);
    check(`§${tier} ${menuId}: the last row is reachable by scrolling`,
        reach.lastInside, true);
}

const openLayoutMenu = (page) => () => page.evaluate(() => {
    TouchActionRow.openLayoutMenu();
});
const openActionsSheet = (page, sid) => () => page.evaluate((sid) => {
    SessionManager.setLifecycleActionTarget(sid);
    SessionManager.openLifecycleSheet();
}, sid);

// ── phone 390x600: the defect viewport ──────────────────────────────────────
{
    const { ctx, page, errors } = await newPage(390, 600, true);
    const SID = 'MB-PHONE';
    await seedSession(page, SID);
    await auditMenu(page, 'P', 'layoutMenu', openLayoutMenu(page));
    await page.evaluate(() => TouchActionRow.closeLayoutMenu());
    await auditMenu(page, 'P', 'sessionActionsSheet', openActionsSheet(page, SID));
    check('§P phone: no page errors', errors, []);
    await ctx.close();
}

// ── tablet 834x1194: coarse pointer, tall ────────────────────────────────────
{
    const { ctx, page, errors } = await newPage(834, 1194, true);
    const SID = 'MB-TAB';
    await seedSession(page, SID);
    await auditMenu(page, 'T', 'layoutMenu', openLayoutMenu(page));
    await page.evaluate(() => TouchActionRow.closeLayoutMenu());
    await auditMenu(page, 'T', 'sessionActionsSheet', openActionsSheet(page, SID));
    check('§T tablet: no page errors', errors, []);
    await ctx.close();
}

// ── desktop 1280x700: fine pointer, short ────────────────────────────────────
{
    const { ctx, page, errors } = await newPage(1280, 700, false);
    const SID = 'MB-DESK';
    await seedSession(page, SID);
    await auditMenu(page, 'D', 'layoutMenu', openLayoutMenu(page));
    await page.evaluate(() => TouchActionRow.closeLayoutMenu());
    await auditMenu(page, 'D', 'sessionActionsSheet', openActionsSheet(page, SID));
    check('§D desktop: no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
