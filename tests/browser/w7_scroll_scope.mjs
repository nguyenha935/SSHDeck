#!/usr/bin/env node
/*
 * W7 focused test — scroll scope limited to the terminal shell.
 *
 * Contract:
 *   - ONE scroll-lock owner: html/body:has(.main-content). index.html is the
 *     only template with .main-content, so ONLY the terminal shell locks the
 *     document scroller, at every width.
 *   - Login and register keep NORMAL page scroll:
 *     mouse wheel, keyboard, and touch drag all reach the last element of
 *     long content — proven BEHAVIORALLY (repeated real input until the last
 *     element is visible), never via window.scrollTo, which is used only to
 *     reset setup state between probes.
 *   - The base body/html must NOT carry overflow:hidden, a fixed height, or
 *     overscroll-behavior:none — that global lock was the pre-W7 defect that
 *     leaked overscroll-behavior:none onto non-terminal pages and killed
 *     wheel/touch scroll even where overflow was unlocked.
 *   - Terminal isolation stays intact BEHAVIORALLY: with stray tall content
 *     in the terminal page, wheel and touch drag over the shell do NOT move
 *     the document scroller; xterm's production-created viewport scrolls
 *     independently.
 *   - Real in-app scrollers work: the touch More sheet and the shortcuts
 *     modal (opened through its production Ctrl+Shift+/ binding) scroll their
 *     own content while the page behind stays put.
 *   - Keyboard-open geometry: --app-height pins the shell height and the
 *     document still never scrolls.
 *
 * Interactions are genuine: page.mouse.wheel, page.keyboard, CDP
 * Input.dispatchTouchEvent, page.click. No force, no evaluate().click, no
 * synthetic dispatch for the contract paths.
 *
 * Run: node tests/browser/w7_scroll_scope.mjs   (from source/)
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
function checkAtLeast(label, actual, floor) {
    if (typeof actual === 'number' && actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual} >= ${floor})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
};

function renderTemplate(name) {
    let html = fs.readFileSync(path.join(ROOT, `templates/${name}.html`), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const PAGES = {
    '': renderTemplate('index'),
    'index': renderTemplate('index'),
    'login': renderTemplate('login'),
    'register': renderTemplate('register'),
};

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        if (PAGES[rel] !== undefined) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(PAGES[rel]);
            return;
        }
        const fp = path.join(ROOT, rel);
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

/* Socket stub for the terminal page only (app.js runs `window.socket = io()`).
 * Does NOT touch localStorage, ModalManager, or scroll state. */
const INIT_SCRIPT = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.io = () => ({
        connected: true,
        on: (name, fn) => {
            if (!window.__socketHandlers[name]) window.__socketHandlers[name] = [];
            window.__socketHandlers[name].push(fn);
        },
        off: noop, once: noop, emit: noop,
        io: { on: noop },
    });
    window.socket = window.io();
    window.showNotification = noop;
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function newPage(w, h, { touch = false, route = '' } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch, isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    if (route === '' || route === 'index') {
        await page.addInitScript(INIT_SCRIPT);
    }
    await page.goto(`${base}/${route}`, { waitUntil: 'load' });
    // The terminal page loads vendor xterm + app.js, which take longer to
    // initialize than the static auth pages. Wait for the production
    // globals the terminal sections below depend on.
    if (route === '' || route === 'index') {
        await page.waitForFunction(
            () => window.TerminalManager && typeof SessionManager !== 'undefined' && !!window.socket,
            null, { timeout: 10000 });
    } else {
        await page.waitForTimeout(150);
    }
    return { ctx, page, errors };
}

/* A real touch drag through CDP (the established pattern in
 * mobile_session_switch / mobile_shell_layout). */
async function touchDrag(page, ctx, x, y0, y1, steps = 8) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y: y0 }],
    });
    for (let i = 1; i <= steps; i++) {
        const y = Math.round(y0 + (y1 - y0) * (i / steps));
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y }],
        });
        await page.waitForTimeout(24);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(50);
}

const docScrollY = (page) => page.evaluate(() => window.scrollY
    || document.scrollingElement?.scrollTop || 0);
const docMetrics = (page) => page.evaluate(() => ({
    scrollH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    vp: window.innerHeight,
    bodyOvY: getComputedStyle(document.body).overflowY,
    htmlOvY: getComputedStyle(document.documentElement).overflowY,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehavior,
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
}));

// Makes a non-terminal page taller than any viewport, as a long form would be.
const addSpacer = (page, height = 1400) => page.evaluate((h) => {
    const spacer = document.createElement('div');
    spacer.style.height = `${h}px`;
    document.body.appendChild(spacer);
}, height);

/* Repeated REAL wheel input until the predicate holds. Never programmatic
 * scrolling: this is exactly what a user does at a mouse/trackpad. */
async function wheelUntil(page, predicate, { x, y, dy = 300, max = 20 } = {}) {
    await page.mouse.move(x, y);
    for (let i = 0; i < max; i++) {
        if (await page.evaluate(predicate)) return true;
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(120);
    }
    return page.evaluate(predicate);
}

/* Wait for document scrollY to settle: poll across consecutive animation
 * frames until scrollY stops changing, with a bounded timeout. Returns the
 * settled scrollY. */
async function waitForScrollSettle(page, timeoutMs = 800) {
    const deadline = Date.now() + timeoutMs;
    let prev = -1;
    while (Date.now() < deadline) {
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        const now = await docScrollY(page);
        if (now === prev) return now;
        prev = now;
    }
    return docScrollY(page);
}

/* Repeated REAL touch drags until the predicate holds. After each drag, wait
 * for scrollY to settle across consecutive animation frames, confirm monotonic
 * progress, and continue bounded drags. If a drag makes no progress, retry
 * only within a bounded count and fail rather than weakening visibility. */
async function dragUntil(page, ctx, predicate, { x, y0, y1, max = 30, steps = 12 } = {}) {
    if (await page.evaluate(predicate)) return true;
    let lastScroll = await docScrollY(page);
    let stalls = 0;
    const maxStalls = 3;
    for (let i = 0; i < max; i++) {
        await touchDrag(page, ctx, x, y0, y1, steps);
        const settled = await waitForScrollSettle(page);
        if (await page.evaluate(predicate)) return true;
        if (settled > lastScroll) {
            lastScroll = settled;
            stalls = 0;
        } else {
            stalls++;
            if (stalls >= maxStalls) break;
        }
    }
    return page.evaluate(predicate);
}

const pageAtBottom = () => window.scrollY + window.innerHeight
    >= Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - 2;

// ============================================================================
// §1 Login (desktop 1280x800), made taller than the window: wheel, keyboard
//    and drag all reach the bottom. NEGATIVE proof: a non-terminal page
//    scrolls. (The admin page this used to measure is part of Settings now.)
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { route: 'login' });
    await addSpacer(page);
    const m = await docMetrics(page);
    check('§1 login: content exceeds the viewport', m.scrollH > m.vp, true);
    check('§1 login: body is NOT overflow-hidden', m.bodyOvY === 'hidden', false);
    check('§1 login: body overscroll-behavior is not none', m.bodyOverscroll, 'auto');

    const wheelBefore = await docScrollY(page);
    check('§1 login: mouse wheel reaches the bottom',
        await wheelUntil(page, pageAtBottom, { x: 640, y: 500, dy: 400 }), true);
    check('§1 login: wheel moved the scroller', (await docScrollY(page)) > wheelBefore, true);

    await page.evaluate(() => window.scrollTo(0, 0)); // setup reset only
    await page.mouse.click(5, 5);                     // focus the page, not a field
    let kd = false;
    for (let i = 0; i < 15; i++) {
        await page.keyboard.press('PageDown');
        await page.waitForTimeout(100);
        if (await page.evaluate(pageAtBottom)) { kd = true; break; }
    }
    check('§1 login: keyboard PageDown reaches the bottom', kd, true);

    await page.evaluate(() => window.scrollTo(0, 0)); // setup reset only
    check('§1 login: drag reaches the bottom',
        await dragUntil(page, ctx, pageAtBottom, { x: 640, y0: 600, y1: 150 }), true);
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 Login on iPad tiers: portrait 768x1024 and landscape 1024x768 both
//    wheel-scroll to the bottom. (§2, the admin page on a phone, went with it;
//    a phone is §5's.)
// ============================================================================
for (const [label, w, h] of [['ipad portrait 768x1024', 768, 1024],
                             ['ipad landscape 1024x768', 1024, 768]]) {
    const { ctx, page, errors } = await newPage(w, h, { touch: true, route: 'login' });
    await addSpacer(page);
    const m = await docMetrics(page);
    check(`§3 ${label}: content exceeds the viewport`, m.scrollH > m.vp, true);
    check(`§3 ${label}: body overscroll-behavior is not none`, m.bodyOverscroll, 'auto');
    check(`§3 ${label}: wheel reaches the bottom`,
        await wheelUntil(page, pageAtBottom,
            { x: Math.round(w / 2), y: Math.round(h * 0.6), dy: 500 }), true);
    check(`§3 ${label} no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 Login at phone LANDSCAPE 926x428 — the historically severe case where
//    the global lock made the submit button unreachable. Wheel + touch drag
//    must bring it fully into view.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(926, 428, { touch: true, route: 'login' });
    // Guarantee scrollable content whatever the fixture paints: a document-flow
    // spacer belongs to the page exactly like any long form would.
    await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '300px';
        document.body.appendChild(spacer);
    });
    const m = await docMetrics(page);
    check('§4 login landscape: content exceeds the viewport', m.scrollH > m.vp, true);
    check('§4 login landscape: body overscroll-behavior is not none',
        m.bodyOverscroll, 'auto');

    const submitVisible = () => {
        const b = document.querySelector('button[type="submit"]');
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.bottom <= window.innerHeight && r.top >= 0;
    };
    check('§4 login landscape: wheel brings the submit button into view',
        await wheelUntil(page, submitVisible, { x: 460, y: 200, dy: 300 }), true);
    checkAtLeast('§4 login landscape: wheel moved the scroller',
        await docScrollY(page), 50);

    await page.evaluate(() => window.scrollTo(0, 0)); // setup reset only
    // Use smaller drag increments so the strict predicate (entire button in
    // viewport) is satisfiable: a single 360px gesture overshoots and pushes
    // the button above the viewport. Multiple short drags let each settle and
    // the predicate be checked between them.
    check('§4 login landscape: touch drag brings the submit button into view',
        await dragUntil(page, ctx, submitVisible,
            { x: 460, y0: 400, y1: 300, max: 20, steps: 6 }), true);
    check('§4 login landscape no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §5 Auth pages at phone portrait 390x844: login and register both scroll by
//    touch drag to their very bottom (behavioral).
// ============================================================================
for (const route of ['login', 'register']) {
    const { ctx, page, errors } = await newPage(390, 844, { touch: true, route });
    await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '400px';
        document.body.appendChild(spacer);
    });
    const m = await docMetrics(page);
    check(`§5 ${route}: content exceeds the viewport`, m.scrollH > m.vp, true);

    check(`§5 ${route}: touch drag scrolls the page`,
        await dragUntil(page, ctx, pageAtBottom, { x: 195, y0: 750, y1: 200 }), true);
    check(`§5 ${route}: the drag reached the very bottom`,
        await page.evaluate(pageAtBottom), true);
    check(`§5 ${route} no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §6 Terminal shell (desktop 1280x800): POSITIVE isolation, behavioral. A
//    production-created xterm scrolls its own history, while stray tall
//    content in the shell does NOT move the document scroller under wheel.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { route: 'index' });
    const m = await docMetrics(page);
    check('§6 index: body overflow is hidden (terminal owner)', m.bodyOvY, 'hidden');
    check('§6 index: html overflow is hidden (terminal owner)', m.htmlOvY, 'hidden');
    check('§6 index: body overscroll-behavior is none', m.bodyOverscroll, 'none');

    // Stray tall content directly under body — a REAL non-shrinking overflow
    // fixture. flex-basis + min-height pin it at 3000px: without them the
    // flex-column body shrinks the child to fit and hides the overflow. Both
    // its own geometry and the document scrollHeight must prove the overflow
    // exists, otherwise the behavioral lock proof below would be vacuous.
    await page.evaluate(() => {
        const s = document.createElement('div');
        s.id = 'w7Stray';
        s.style.cssText = 'flex: 0 0 3000px; min-height: 3000px;';
        document.body.appendChild(s);
    });
    const stray = await page.evaluate(() => {
        const s = document.getElementById('w7Stray');
        return {
            ownH: Math.round(s.getBoundingClientRect().height),
            docScrollH: Math.max(document.documentElement.scrollHeight,
                document.body.scrollHeight),
            vp: window.innerHeight,
        };
    });
    check('§6 index: stray fixture keeps its full 3000px (no flex shrink)',
        stray.ownH, 3000);
    check('§6 index: document scrollHeight exceeds the viewport',
        stray.docScrollH > stray.vp, true);

    // A REAL xterm through the production attach path. The terminal is hosted
    // inside a fixed-positioned wrapper rather than making the container itself
    // fixed, so it keeps a stable viewport position above the stray content.
    //
    // S35 P36: this used to be REQUIRED because setupScrollbar wrote
    // container.style.position = 'relative' (it needed a positioned box for its
    // scrollbar thumb) and that inline style would have overridden
    // position:fixed on the container. That control was retired and the write is
    // gone, so the separate host is no longer forced -- it is kept because the
    // geometry it produces is what every row below was measured against, and
    // real wrappers get position:relative from style.css:3600 regardless.
    await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'term-w7-host';
        host.style.cssText = 'position:fixed;left:60px;top:120px;width:560px;height:340px;z-index:5000;';
        const c = document.createElement('div');
        c.id = 'term-w7';
        c.style.cssText = 'width:100%;height:100%;';
        host.appendChild(c);
        document.body.appendChild(host);
        TerminalManager.createTerminal('w7', 'w7');
        TerminalManager.attachTerminal('w7', 'term-w7', 'w7');
    });

    // Deterministic attach-settled guard: terminalReady is the production
    // signal that the startup clear has run, AND fitRequests['w7'] must be
    // absent (no pending coalesced fit), AND the viewport must have non-zero
    // geometry, AND rows/cols must be set. Then confirm stability across at
    // least two animation frames with no pending fit re-appearing. Only then
    // is the terminal quiescent enough to write history deterministically.
    await page.waitForFunction(() => {
        const tm = window.TerminalManager;
        if (!tm || tm.terminalReady['w7'] !== true) return false;
        if (tm.fitRequests && tm.fitRequests['w7']) return false;
        const vp = document.querySelector('#term-w7 .xterm-viewport');
        if (!vp || vp.clientHeight === 0 || vp.scrollHeight === 0) return false;
        const t = tm.terminals['w7'];
        if (!t || t.rows === 0 || t.cols === 0) return false;
        return true;
    }, null, { timeout: 10000 });
    const stable0 = await page.evaluate(() => {
        const vp = document.querySelector('#term-w7 .xterm-viewport');
        const t = TerminalManager.terminals['w7'];
        return { vpH: vp.clientHeight, vpW: vp.clientWidth,
                 rows: t.rows, cols: t.cols,
                 pendingFit: !!TerminalManager.fitRequests['w7'] };
    });
    await page.evaluate(() => new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(r))));
    const stable1 = await page.evaluate(() => {
        const vp = document.querySelector('#term-w7 .xterm-viewport');
        const t = TerminalManager.terminals['w7'];
        return { vpH: vp.clientHeight, vpW: vp.clientWidth,
                 rows: t.rows, cols: t.cols,
                 pendingFit: !!TerminalManager.fitRequests['w7'] };
    });
    check('§6 index: xterm geometry is stable across two frames (no pending fit)',
        stable0.vpH === stable1.vpH && stable0.rows === stable1.rows
            && stable0.cols === stable1.cols && !stable1.pendingFit, true);

    // Write ONE large history buffer and await xterm's own write callback as
    // the parser-completion proof (a timeout is never the proof). The write
    // callback fires when the PARSER has consumed the data; xterm's DOM
    // renderer updates on the next frame, so wait for the ENGINE to report
    // scrollback above the screen as the proof that the write landed.
    // (This used to wait for `.xterm-viewport.scrollHeight > clientHeight`;
    // xterm 6 renders with no DOM scroll range at all, so that wait could
    // only time out while the scrollback it stood for was there.)
    await page.evaluate(() => new Promise((resolve, reject) => {
        const t = TerminalManager.terminals['w7'];
        if (!t) { reject(new Error('xterm terminal w7 missing')); return; }
        let buf = '';
        for (let i = 0; i < 300; i++) buf += `history line ${i}\r\n`;
        t.write(buf, () => resolve());
    }));
    await page.waitForFunction(() => {
        const t = TerminalManager.terminals['w7'];
        return !!t && t.buffer.active.baseY > 0;
    }, null, { timeout: 5000 });

    const vpHasHistory = () => {
        const t = TerminalManager.terminals['w7'];
        return !!t && t.buffer.active.baseY > 0;
    };
    check('§6 index: production xterm viewport has scrollback',
        await page.evaluate(vpHasHistory), true);

    // Start at the bottom (production API) so an upward wheel has somewhere
    // to go. Then wheel UP over the xterm screen and require the viewport to
    // move UPWARD specifically: viewportY must decrease or scrollTop must
    // decrease by a meaningful margin. Movement in the wrong direction is a
    // failure, not a pass. After the same wheel sequence, assert the document
    // scroller is unchanged.
    await page.evaluate(() => TerminalManager.terminals['w7'].scrollToBottom());
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    await page.mouse.move(340, 290);
    const before = await page.evaluate(() => {
        const vp = document.querySelector('#term-w7 .xterm-viewport');
        const t = TerminalManager.terminals['w7'];
        return {
            scrollTop: vp ? vp.scrollTop : 0,
            viewportY: t ? t.buffer.active.viewportY : 0,
            docScrollY: window.scrollY,
        };
    });
    let scrolledUp = false;
    for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(100);
        const now = await page.evaluate(() => {
            const vp = document.querySelector('#term-w7 .xterm-viewport');
            const t = TerminalManager.terminals['w7'];
            return {
                scrollTop: vp ? vp.scrollTop : 0,
                viewportY: t ? t.buffer.active.viewportY : 0,
            };
        });
        if (now.viewportY < before.viewportY - 5
            || now.scrollTop < before.scrollTop - 10) {
            scrolledUp = true;
            break;
        }
    }
    check('§6 index: wheel scrolls xterm scrollback upward inside its viewport',
        scrolledUp, true);
    check('§6 index: xterm wheel did not move the document scroller',
        await docScrollY(page), before.docScrollY);

    // Deck interception invariant: wheel over a bare shell area (inside
    // .deck-window, outside xterm) is intercepted by the deck's own
    // overflow:hidden and never reaches the document scroller. This is a
    // shell-container property, NOT the decisive document-owner proof — the
    // wheel-surface assertion below is the decisive one.
    await page.mouse.move(1100, 700);
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(100);
    }
    check('§6 index: deck window intercepts wheel over bare shell area',
        await docScrollY(page), 0);

    // The DECISIVE behavioral document-isolation proof. A small fixed-position
    // surface directly under body, at a viewport coordinate OUTSIDE the fixed
    // xterm host, with pointer-events:auto and a high z-index but no wheel
    // handler and no scrollable overflow of its own. A wheel over its center
    // hits the surface, bubbles to the document scroller, and — with both
    // terminal document owners present (html:has(.main-content) AND
    // body:has(.main-content) both overflow:hidden) — the document scroller
    // cannot move. Removing BOTH owners makes html/body fall back to the base
    // overflow-x:hidden (computed overflow-y:auto) and the same real wheel
    // input at the same confirmed hit-target scrolls the document — RED.
    // Either owner alone is NOT sufficient: the other still locks. Both must
    // be removed for the assertion to fail.
    const WHEEL_X = 1200, WHEEL_Y = 60;
    await page.evaluate(([x, y]) => {
        const el = document.createElement('div');
        el.id = 'w7WheelSurface';
        el.style.cssText =
            `position:fixed;left:${x - 20}px;top:${y - 20}px;width:40px;height:40px;`
            + 'z-index:9999;pointer-events:auto;background:transparent;';
        document.body.appendChild(el);
    }, [WHEEL_X, WHEEL_Y]);
    check('§6 index: wheel surface is the hit target at its center',
        await page.evaluate(([x, y]) =>
            document.elementFromPoint(x, y)?.id === 'w7WheelSurface',
            [WHEEL_X, WHEEL_Y]), true);
    const wheelBefore = await docScrollY(page);
    await page.mouse.move(WHEEL_X, WHEEL_Y);
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(100);
    }
    check('§6 index: wheel over surface does not scroll the document',
        await docScrollY(page), wheelBefore);
    check('§6 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §7 Terminal shell (phone 390x844, touch): behavioral isolation. With stray
//    tall content present, a touch drag over the shell must NOT move the
//    document scroller.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true, route: 'index' });
    const m = await docMetrics(page);
    check('§7 index phone: body overflow is hidden', m.bodyOvY, 'hidden');
    check('§7 index phone: overscroll-behavior is none', m.bodyOverscroll, 'none');

    await page.evaluate(() => {
        const s = document.createElement('div');
        s.style.height = '3000px';
        document.body.appendChild(s);
    });

    await touchDrag(page, ctx, 195, 600, 150);
    await touchDrag(page, ctx, 195, 600, 150);
    check('§7 index phone: stray tall content does not scroll the document under drag',
        await docScrollY(page), 0);
    check('§7 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §8 REAL touch More sheet (phone landscape 844x390): the canonical menu is
//    taller than the viewport and must scroll its own rows — opened through
//    its real trigger, scrolled by real drag, page behind stays put.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(844, 390, { touch: true, route: 'index' });
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(300);

    const sheetOpen = await page.evaluate(() =>
        !document.getElementById('mobileMoreSheet').hidden);
    check('§8 more sheet: opens through its real trigger', sheetOpen, true);

    const over = await page.evaluate(() => {
        const sh = document.getElementById('mobileMoreSheet');
        return sh.scrollHeight > sh.clientHeight;
    });
    check('§8 more sheet: content overflows its bounded height', over, true);

    const lastItemVisible = () => {
        const items = [...document.querySelectorAll('#mobileMoreSheet .account-item')];
        const last = items[items.length - 1];
        const sh = document.getElementById('mobileMoreSheet').getBoundingClientRect();
        return !!last && last.getBoundingClientRect().bottom <= sh.bottom + 1;
    };
    const sheetRect = await page.evaluate(() => {
        const r = document.getElementById('mobileMoreSheet').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2),
                 y0: Math.round(r.top + r.height * 0.8),
                 y1: Math.round(r.top + r.height * 0.2) };
    });
    check('§8 more sheet: drag reaches the last menu row',
        await dragUntil(page, ctx, lastItemVisible, sheetRect), true);
    checkAtLeast('§8 more sheet: its own scroller moved',
        await page.evaluate(() =>
            document.getElementById('mobileMoreSheet').scrollTop), 50);
    check('§8 more sheet: the page behind did NOT move', await docScrollY(page), 0);
    check('§8 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §9 REAL shortcuts modal (desktop 1280x420): opened through the production
//    Ctrl+Shift+/ binding. Its body overflows and must wheel-scroll to the
//    last shortcut row; the page behind stays put.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 420, { route: 'index' });
    await page.keyboard.down('Control');
    await page.keyboard.press('Shift+Slash');
    await page.keyboard.up('Control');
    await page.waitForTimeout(400);

    check('§9 shortcuts modal: opens through its production key binding',
        await page.evaluate(() =>
            document.getElementById('shortcutsModal').classList.contains('show')), true);

    const over = await page.evaluate(() => {
        const b = document.querySelector('#shortcutsModal .modal-body');
        return b.scrollHeight > b.clientHeight;
    });
    check('§9 shortcuts modal: body overflows at this height', over, true);

    const lastRowVisible = () => {
        const rows = [...document.querySelectorAll('#shortcutsModal .shortcut-row')];
        const last = rows[rows.length - 1];
        return !!last && last.getBoundingClientRect().bottom <= window.innerHeight;
    };
    const bodyRect = await page.evaluate(() => {
        const r = document.querySelector('#shortcutsModal .modal-body').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2),
                 y: Math.round(r.top + r.height / 2) };
    });
    check('§9 shortcuts modal: wheel reaches the last shortcut row',
        await wheelUntil(page, lastRowVisible,
            { x: bodyRect.x, y: bodyRect.y, dy: 200 }), true);
    checkAtLeast('§9 shortcuts modal: the modal body scrolled',
        await page.evaluate(() =>
            document.querySelector('#shortcutsModal .modal-body').scrollTop), 50);
    check('§9 shortcuts modal: the page behind did NOT move', await docScrollY(page), 0);
    check('§9 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §10 Keyboard-open geometry (phone index): --app-height pins the shell, and
//     the document still never scrolls.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true, route: 'index' });
    // terminal-manager.js sets --app-height to the visual-viewport height
    // while the soft keyboard is open; emulate the pinned state exactly.
    await page.evaluate(() => {
        document.body.classList.add('keyboard-open');
        document.documentElement.style.setProperty('--app-height', '500px');
    });
    await page.waitForTimeout(120);
    const geo = await page.evaluate(() => ({
        bodyH: Math.round(document.body.getBoundingClientRect().height),
        htmlH: Math.round(document.documentElement.getBoundingClientRect().height),
        scrollY: window.scrollY,
        ovY: getComputedStyle(document.body).overflowY,
        overscroll: getComputedStyle(document.body).overscrollBehavior,
    }));
    check('§10 keyboard-open: body height follows --app-height', geo.bodyH, 500);
    check('§10 keyboard-open: html height follows --app-height', geo.htmlH, 500);
    check('§10 keyboard-open: body stays overflow-hidden', geo.ovY, 'hidden');
    check('§10 keyboard-open: overscroll-behavior stays none', geo.overscroll, 'none');
    check('§10 keyboard-open: document does not scroll', geo.scrollY, 0);

    await touchDrag(page, ctx, 195, 450, 100);
    check('§10 keyboard-open: drag does not scroll the document',
        await docScrollY(page), 0);
    check('§10 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §11 Runtime base-contract audit on a non-terminal page: the base body must
//     grow with its content (not pinned) and carry no hidden overflow or
//     overscroll lock. Guard against re-introducing a GLOBAL lock.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { route: 'login' });
    const m = await docMetrics(page);
    check('§11 base body overflow-y is not hidden', m.bodyOvY === 'hidden', false);
    check('§11 base html overflow-y is not hidden', m.htmlOvY === 'hidden', false);
    check('§11 base html overscroll-behavior is not none', m.htmlOverscroll, 'auto');
    check('§11 base body overscroll-behavior is not none', m.bodyOverscroll, 'auto');

    const before = await page.evaluate(() => document.body.getBoundingClientRect().height);
    await page.evaluate(() => {
        const s = document.createElement('div');
        s.style.height = '1200px';
        document.body.appendChild(s);
    });
    const after = await page.evaluate(() => ({
        bodyH: document.body.getBoundingClientRect().height,
        vp: window.innerHeight,
    }));
    check('§11 body grows past the viewport with content (not pinned)',
        after.bodyH > after.vp && after.bodyH > before, true);
    check('§11 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §12 REAL desktop account dropdown (short viewports): the canonical global
//     menu is a floating card on a fine pointer, and it is the scroller —
//     `.account-dropdown-header` carries max-height:80vh + overflow-y:auto in
//     style.css. §8 proves the TOUCH home of this same node (relocated into
//     #mobileMoreSheet, where the sheet is the scroller and the node is reset to
//     max-height:none). Its DESKTOP home was never proven behaviorally, and the
//     two homes have opposite scroll owners, so a pass on one says nothing about
//     the other.
//
//     Measured before writing this: at 1280x420 the last row's natural bottom
//     is 566px against a 420px viewport, i.e. it starts out of view and MUST be
//     reached by scrolling the dropdown itself, with the page behind fixed.
//     420px is a real desktop case (a short window, or a browser with several
//     toolbars), and 360px is the same shape one tier worse.
//
//     500px left the list on 2026-10-05: Theme, Language and Change password
//     moved to Settings, the menu is 8 rows (404px), and at 500 its last row
//     already sits inside the card. Its 6px "overflow" there was the bottom
//     padding, which the old scrollHeight precondition counted as overflow.
//
//     The Admin panel row left too (Settings part B): 7 rows, 364px. At 420
//     the card clips the last row by 30px while that row is still inside the
//     viewport, so "the wheel reaches it" has to mean inside the CARD: read
//     against the viewport it was reached before a single wheel step.
// ============================================================================
for (const h of [420, 360]) {
    const { ctx, page, errors } = await newPage(1280, h, { route: 'index' });
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(250);

    const open = await page.evaluate(() => {
        const d = document.getElementById('accountDropdownHeader');
        return !!d && !d.hidden && getComputedStyle(d).display !== 'none';
    });
    check(`§12 account dropdown @${h}: opens through its real trigger`, open, true);

    // The precondition that makes the rest meaningful: the last row really
    // starts below the card, not just its padding.
    const over = await page.evaluate(() => {
        const d = document.getElementById('accountDropdownHeader');
        const rows = [...d.querySelectorAll(':scope > .account-item')];
        return rows[rows.length - 1].getBoundingClientRect().bottom
            > d.getBoundingClientRect().bottom + 20;
    });
    check(`§12 account dropdown @${h}: content exceeds its bounded height`, over, true);

    // It must own its scrolling rather than delegating to a page that is
    // deliberately pinned on this shell.
    const scroller = await page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById('accountDropdownHeader'));
        return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
    });
    check(`§12 account dropdown @${h}: is its own scroller`,
        scroller.overflowY === 'auto' || scroller.overflowY === 'scroll', true);
    check(`§12 account dropdown @${h}: has a viewport-relative clamp`,
        scroller.maxHeight !== 'none' && scroller.maxHeight !== '', true);

    const lastRowVisible = () => {
        const rows = [...document.querySelectorAll(
            '#accountDropdownHeader > .account-item')];
        const last = rows[rows.length - 1];
        if (!last) return false;
        const r = last.getBoundingClientRect();
        const card = document.getElementById('accountDropdownHeader').getBoundingClientRect();
        return r.bottom <= Math.min(card.bottom + 1, window.innerHeight) && r.top >= Math.max(card.top - 1, 0);
    };
    const box = await page.evaluate(() => {
        const r = document.getElementById('accountDropdownHeader').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2),
                 y: Math.round(r.top + r.height / 2) };
    });
    check(`§12 account dropdown @${h}: wheel reaches the last menu row`,
        await wheelUntil(page, lastRowVisible, { x: box.x, y: box.y, dy: 200 }), true);
    checkAtLeast(`§12 account dropdown @${h}: its own scroller moved`,
        await page.evaluate(() =>
            document.getElementById('accountDropdownHeader').scrollTop), 20);
    // The reached row must be inside the dropdown's own box, not spilling past
    // its clamp — a row visible only because the card overflowed its bounds
    // would satisfy a naive viewport check while still being unreachable once
    // the card is clipped.
    check(`§12 account dropdown @${h}: the last row sits inside the card`,
        await page.evaluate(() => {
            const d = document.getElementById('accountDropdownHeader');
            const rows = [...d.querySelectorAll(':scope > .account-item')];
            const last = rows[rows.length - 1].getBoundingClientRect();
            const dr = d.getBoundingClientRect();
            return last.bottom <= dr.bottom + 1 && last.top >= dr.top - 1;
        }), true);
    check(`§12 account dropdown @${h}: the page behind did NOT move`,
        await docScrollY(page), 0);
    check(`§12 account dropdown @${h}: it stays open throughout`,
        await page.evaluate(() =>
            !document.getElementById('accountDropdownHeader').hidden), true);
    check(`§12 no page errors @${h}`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §13 D6 "settings, admin, menu, MODAL, form … cuộn được và tới phần tử cuối".
//
// §9 proves ONE modal (shortcuts) at ONE viewport. That modal has no form
// controls, so it says nothing about the ones that do — and the modal family is
// where D6's "form" clause actually lives: the connection form, key upload, jump
// host, command form and the transfer forms are all inside modals, on a shell
// whose DOCUMENT scroll is deliberately locked. If a modal body stops being its
// own scroller there, the content below the fold becomes unreachable with no
// fallback, unlike on login where the page itself can scroll.
//
// Every modal is opened through its real production trigger (a click, or the
// production key binding for the two that have one), then, for the ones that
// overflow at that viewport, the LAST focusable control is reached by real wheel
// input over the body and asserted to sit inside the body's own box. Modals that
// do not overflow at a viewport are asserted to have their last control already
// visible — that is the same guarantee, satisfied without scrolling, and it
// keeps the check non-vacuous either way.
//
// Measured while writing this (desktop 1280x420 / phone 390x844 / phone
// landscape 844x390): overflow is real and viewport-dependent, e.g.
// #connectionModal scrolls 698 / 568 / 756 px and #keyManagementModal overflows
// on both desktop-short and phone landscape but fits on phone portrait. Hence
// the per-viewport branch rather than one hard-coded expectation.
// ============================================================================
const MODAL_CASES = [
    // [modal id, trigger selector, needs the account dropdown open first,
    //  needs the inline Files inspector opened first]
    ['connectionModal', '#newConnectionBtn', false, false],
    ['keyManagementModal', '#manageKeysBtn', true, false],
    ['jumpHostManagementModal', '#manageJumpHostsBtn', true, false],
    ['profileManagementModal', '#manageProfilesBtn', true, false],
    // #fmUploadDownloadBtn does not exist at load: it is rendered by the inline
    // SFTP inspector (sftp-file-manager.js openInline), which #fileTransferBtn
    // opens. Measured: absent before, present after. Reaching it through that
    // route is the real path, and it also proves the delegated document-level
    // click binding in file-transfer.js still finds a lazily created opener.
    ['fileTransferModal', '#fmUploadDownloadBtn', false, true],
];
for (const [vpLabel, w, h] of [
    ['desktop 1280x420', 1280, 420],
    ['phone 390x844', 390, 844],
    ['phone landscape 844x390', 844, 390],
]) {
    const { ctx, page, errors } = await newPage(w, h, {
        touch: w < 900, route: 'index',
    });
    // One live session, so the per-session Files inspector has a host to show.
    await page.evaluate(() => {
        SessionManager.sessions['W7'] = {
            id: 'W7', session_id: 'W7', host: 'w7.example', port: 22,
            username: 'u', authType: 'key', keyId: 'k1', jumpHostId: null,
            displayName: 'W7', connected: true, isPersistentCandidate: false,
            tmuxSessionName: null, terminalId: 'term-W7', useTmux: false,
            viaJump: null, latencyMs: null,
        };
        SessionManager.activeSessionId = 'W7';
    });

    for (const [modalId, trigger, viaDropdown, viaInline] of MODAL_CASES) {
        const opened = await page.evaluate(async ({ modalId, trigger, viaDropdown, viaInline }) => {
            if (viaDropdown) {
                document.getElementById('accountDropdownHeader')?.removeAttribute('hidden');
                document.getElementById('accountBtnHeader').click();
                await new Promise(r => setTimeout(r, 150));
            }
            if (viaInline) {
                document.getElementById('fileTransferBtn')?.click();
                await new Promise(r => setTimeout(r, 400));
            }
            const btn = document.querySelector(trigger);
            if (!btn) return { noTrigger: true, shown: false };
            btn.click();
            await new Promise(r => setTimeout(r, 300));
            const m = document.getElementById(modalId);
            return { shown: !!m && m.classList.contains('show') };
        }, { modalId, trigger, viaDropdown, viaInline });
        check(`§13 ${vpLabel} ${modalId}: opens through its real trigger`,
            opened.shown, true);
        if (!opened.shown) continue;

        const geom = await page.evaluate((modalId) => {
            const m = document.getElementById(modalId);
            const body = m.querySelector('.modal-body');
            const content = m.querySelector('.modal-content');
            const cs = getComputedStyle(body);
            const cb = content.getBoundingClientRect();
            const bb = body.getBoundingClientRect();
            return {
                overflowY: cs.overflowY,
                overflows: body.scrollHeight > body.clientHeight + 1,
                contentFits: cb.top >= -1 && cb.bottom <= window.innerHeight + 1,
                bodyBox: { x: Math.round(bb.left + bb.width / 2),
                    y: Math.round(bb.top + bb.height / 2) },
            };
        }, modalId);

        check(`§13 ${vpLabel} ${modalId}: the body owns its scrolling`,
            geom.overflowY === 'auto' || geom.overflowY === 'scroll', true);
        check(`§13 ${vpLabel} ${modalId}: the card fits the viewport`,
            geom.contentFits, true);

        // The last VISIBLE control inside the body must be reachable and must
        // sit inside the body's own box — a control visible only because the
        // body overflowed its clamp is not reachable once the card is clipped.
        // Built as a source STRING, not a closure: page.evaluate serializes the
        // function and drops the surrounding scope, so `() => reached(modalId)`
        // would throw "reached is not defined" in the page. wheelUntil hands its
        // predicate straight to page.evaluate, which accepts an expression.
        const predicate = `(() => {
            const body = document.getElementById('${modalId}')
                .querySelector('.modal-body');
            const controls = [...body.querySelectorAll(
                'input, select, textarea, button, a[href]')]
                .filter(el => el.offsetParent !== null);
            const last = controls[controls.length - 1];
            if (!last) return false;
            const r = last.getBoundingClientRect();
            const br = body.getBoundingClientRect();
            return r.bottom <= br.bottom + 1 && r.top >= br.top - 1
                && r.bottom <= window.innerHeight + 1;
        })()`;
        const alreadyVisible = await page.evaluate(predicate);
        if (geom.overflows && !alreadyVisible) {
            check(`§13 ${vpLabel} ${modalId}: wheel reaches the last control`,
                await wheelUntil(page, predicate,
                    { x: geom.bodyBox.x, y: geom.bodyBox.y, dy: 200 }), true);
            // Only meaningful when scrolling was actually required. A body that
            // overflows by a few pixels below its last control (measured:
            // #jumpHostManagementModal at 390x844) is already satisfying the
            // clause at rest, and demanding a scroll there would be asserting
            // the harness rather than the product.
            checkAtLeast(`§13 ${vpLabel} ${modalId}: the body itself scrolled`,
                await page.evaluate((id) => document.getElementById(id)
                    .querySelector('.modal-body').scrollTop, modalId), 20);
        } else {
            check(`§13 ${vpLabel} ${modalId}: last control reachable without `
                + `scrolling (overflows=${geom.overflows})`, alreadyVisible, true);
        }
        check(`§13 ${vpLabel} ${modalId}: the page behind did NOT move`,
            await docScrollY(page), 0);

        // Close it the way a user does, so the next case starts clean.
        await page.evaluate((modalId) => {
            const m = document.getElementById(modalId);
            const close = m.querySelector('.close, [id^="close"]');
            if (close) close.click(); else m.classList.remove('show');
            document.getElementById('accountDropdownHeader')?.setAttribute('hidden', '');
        }, modalId);
        await page.waitForTimeout(150);
    }

    // Settings is a view over the workspace, not a dialog, so it is not in the
    // table above. The same clause holds for it: its longest section (Account)
    // must reach its last control by real wheel input inside its own scroller,
    // with the locked document behind it unmoved.
    {
        const shown = await page.evaluate(async () => {
            window.SettingsView.open('account');
            await new Promise(r => setTimeout(r, 200));
            return window.SettingsView.isOpen && window.SettingsView.section === 'account';
        });
        check(`§13 ${vpLabel} settings view: opens on Account`, shown, true);
        if (shown) {
            const predicate = `(() => {
                const scroller = document.querySelector('#settingsView .sv-scroll');
                const last = document.getElementById('changePasswordSubmit');
                const r = last.getBoundingClientRect();
                const sr = scroller.getBoundingClientRect();
                return r.height > 0 && r.bottom <= sr.bottom + 1 && r.top >= sr.top - 1
                    && r.bottom <= window.innerHeight + 1;
            })()`;
            const geom = await page.evaluate(() => {
                const scroller = document.querySelector('#settingsView .sv-scroll');
                const r = scroller.getBoundingClientRect();
                return {
                    overflowY: getComputedStyle(scroller).overflowY,
                    overflows: scroller.scrollHeight > scroller.clientHeight + 1,
                    fits: r.top >= -1 && r.bottom <= window.innerHeight + 1,
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                };
            });
            check(`§13 ${vpLabel} settings view: the section owns its scrolling`,
                geom.overflowY === 'auto' || geom.overflowY === 'scroll', true);
            check(`§13 ${vpLabel} settings view: the scroller fits the viewport`,
                geom.fits, true);
            const alreadyVisible = await page.evaluate(predicate);
            if (geom.overflows && !alreadyVisible) {
                check(`§13 ${vpLabel} settings view: wheel reaches the last control`,
                    await wheelUntil(page, predicate, { x: geom.x, y: geom.y, dy: 200 }), true);
                checkAtLeast(`§13 ${vpLabel} settings view: the section itself scrolled`,
                    await page.evaluate(() => document
                        .querySelector('#settingsView .sv-scroll').scrollTop), 20);
            } else {
                check(`§13 ${vpLabel} settings view: last control reachable without `
                    + `scrolling (overflows=${geom.overflows})`, alreadyVisible, true);
            }
            check(`§13 ${vpLabel} settings view: the page behind did NOT move`,
                await docScrollY(page), 0);
            await page.evaluate(() => window.SettingsView.close());
        }
    }

    check(`§13 no page errors @${vpLabel}`, errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
