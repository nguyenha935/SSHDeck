/*
 * Visual acceptance harness (AGENTS section 2).
 *
 * This file RENDERS; it does not assert. Its only job is to produce real PNGs
 * of the shipped templates so a human (or the model) can look at them against
 * docs/spec/sshdeck-ui-plan-v5.html. Every measurable contract already
 * has an assertion suite (desktop_shell, mobile_shell_layout, session_actions,
 * layout_variants, auth_pages_v5, theme_bridge_tokens); duplicating those as
 * pixel comparisons would only add a second, weaker copy.
 *
 * It reuses the same renderTemplate / http-server / STUBS plumbing the
 * assertion suites use, so what is photographed is production markup, not a
 * fixture. Real xterm is vendored and served, so panes contain real terminals.
 *
 * Output: /tmp/v5-shots/<name>.png
 * Run:    node tests/browser/visual_acceptance_v5.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = '/tmp/v5-shots';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json', '.png': 'image/png',
    '.ico': 'image/x-icon',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(/\{%\s*include\s+'([^']+)'\s*%\}/g,
        (_, file) => fs.readFileSync(path.join(ROOT, 'templates', file), 'utf8'));
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

// Exact production response shape from app/__init__.py:320-343. These three
// states make both desktop-table and phone-card screenshots meaningful: current
// admin, active regular user, and locked regular user.
const ADMIN_USERS = [
    {
        id: 1, username: 'nguyenha', is_admin: true, is_locked: false,
        created_at: '2026-06-01T08:00:00Z', last_login: '2026-08-09T09:30:00Z',
    },
    {
        id: 2, username: 'operator', is_admin: false, is_locked: false,
        created_at: '2026-07-11T10:15:00Z', last_login: '2026-08-08T13:45:00Z',
    },
    {
        id: 3, username: 'locked-user', is_admin: false, is_locked: true,
        created_at: '2026-07-20T14:00:00Z', last_login: null,
    },
];

/*
 * The visual server has no Socket.IO transport. Serve the production client
 * asset path with an in-memory implementation instead of letting the real
 * client poll a deliberately absent /socket.io endpoint. This is a fixture for
 * the transport boundary only: production app.js still calls io() and every
 * application module still receives the same socket method surface.
 */
const ADMIN_USERS_DELAY_MS = 500;

const SOCKET_IO_FIXTURE = `
(() => {
    const manager = {
        on() { return manager; },
        off() { return manager; },
    };
    window.io = () => {
        const listeners = new Map();
        const socket = {
            connected: true,
            io: manager,
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
                return socket;
            },
            off(event, handler) {
                if (!handler) listeners.delete(event);
                else listeners.get(event)?.delete(handler);
                return socket;
            },
            once(event, handler) {
                const wrapped = (...args) => {
                    socket.off(event, wrapped);
                    handler(...args);
                };
                return socket.on(event, wrapped);
            },
            emit(event, payload, acknowledgement) {
                // Production answers every ssh_resize with pty_geometry; the
                // visual fixture must release S27's geometry hold so seeded
                // output can paint before the screenshot gate.
                if (event === 'ssh_resize' && payload) {
                    const listenersForGeometry = listeners.get('pty_geometry');
                    listenersForGeometry?.forEach(handler => handler({
                        session_id: payload.session_id,
                        cols: payload.cols, rows: payload.rows, applied: true,
                    }));
                }
                if (typeof acknowledgement === 'function') {
                    acknowledgement({ success: true });
                }
                return socket;
            },
            connect() { socket.connected = true; return socket; },
            disconnect() { socket.connected = false; return socket; },
        };
        return socket;
    };
})();
`;

/*
 * Favicon contact sheet (approved shot 28). Harness-only PAGE, production-only
 * ASSETS: every tile loads the shipped /static/icons/* URL over HTTP through the
 * browser, so what is photographed is the real file at the real size. No icon is
 * read from disk and re-encoded, which would prove only that a file exists.
 */
const FAVICON_SHEET_TILES = [
    ['favicon.svg', '/static/icons/favicon.svg', 16],
    ['favicon.svg', '/static/icons/favicon.svg', 32],
    ['favicon.ico', '/static/icons/favicon.ico', 16],
    ['favicon.ico', '/static/icons/favicon.ico', 32],
    ['apple-touch-icon.png', '/static/icons/apple-touch-icon.png', 180],
];
const FAVICON_SHEET_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Favicon contact sheet</title>
<style>
  body { margin:0; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .band { padding:20px 24px; }
  .light { background:#ffffff; color:#111111; }
  .dark  { background:#0f172a; color:#f1f5f9; }
  h2 { margin:0 0 14px; font-size:13px; font-weight:600; }
  .row { display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap; }
  figure { margin:0; display:grid; justify-items:center; gap:6px; }
  figcaption { white-space:nowrap; opacity:.75; }
</style></head><body>
${['light', 'dark'].map(mode => `
  <section class="band ${mode}">
    <h2>${mode === 'light' ? 'Light surface' : 'Dark surface'}</h2>
    <div class="row">
      ${FAVICON_SHEET_TILES.map(([name, url, size]) => `
        <figure>
          <img class="tile" data-tile="${mode}-${name}-${size}"
               src="${url}?v=1" width="${size}" height="${size}"
               alt="${name} at ${size}px">
          <figcaption>${name} · ${size}px</figcaption>
        </figure>`).join('')}
    </div>
  </section>`).join('')}
</body></html>`;

// One server, routing by path so every template is reachable with its own theme
// via ?theme=.
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const rel = decodeURIComponent(url.pathname);
        const theme = url.searchParams.get('theme') || 'glass';
        // Harness-only host page for shot 28. It serves NO icon bytes itself --
        // each <img> resolves through the ordinary /static/icons/* path below.
        if (req.method === 'GET' && rel === '/__acceptance/favicon-sheet') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(FAVICON_SHEET_HTML);
            return;
        }
        // Exact production asset path, so no other script or failed request can
        // be hidden by the transport fixture.
        if (req.method === 'GET'
            && rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
            return;
        }
        // GET-only and exact-path on purpose. POST and unknown admin APIs must
        // continue into the ordinary 404 path rather than receiving wildcard
        // fixture success that production would reject.
        if (req.method === 'GET' && rel === '/admin/api/users') {
            setTimeout(() => {
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                });
                res.end(JSON.stringify({ users: ADMIN_USERS }));
            }, ADMIN_USERS_DELAY_MS);
            return;
        }
        const PAGES = {
            '/': 'templates/index.html',
            '/index.html': 'templates/index.html',
            '/login': 'templates/login.html',
            '/register': 'templates/register.html',
            '/admin': 'templates/admin.html',
            '/change_password': 'templates/change_password.html',
        };
        if (PAGES[rel]) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate(PAGES[rel], theme));
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

// Socket stub only. TerminalManager is NOT stubbed: real xterm is vendored, so
// panes render real terminals and the screenshots show real text.
const STUBS = `
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop,
                      connected: true, io: { on: noop } };
`;

const shots = [];
const pageDiagnostics = new WeakMap();
async function open(w, h, {
    touch = false, page: pagePath = '/', theme = 'glass', init = null,
} = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    const requestFailures = [];
    const httpErrors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('requestfailed', request => {
        requestFailures.push(`${request.method()} ${request.url()}`
            + `: ${request.failure()?.errorText || 'unknown failure'}`);
    });
    page.on('response', response => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.request().method()}`
                + ` ${response.url()}`);
        }
    });
    pageDiagnostics.set(page, { requestFailures, httpErrors });
    await page.addInitScript(STUBS);
    if (init) await page.addInitScript(init);
    const q = theme === 'glass' ? '' : `?theme=${theme}`;
    await page.goto(base + pagePath + q, { waitUntil: 'load' });
    /*
     * Two cursors blink independently of CSS animation. The xterm cursor layer is
     * pinned visible; the NATIVE text caret in an autofocused input cannot be
     * pinned visible portably, and its blink is not a CSS animation, so
     * animation:none does not stop it. Left alone it makes /login render
     * differently run to run -- measured as a 21-pixel, 6x49 diff at x=919,y=368
     * over #username -- which both adds noise to a human eye read and makes the
     * distinctness gate below flip between 60 and 61 distinct renders for reasons
     * that have nothing to do with the UI. Pinned transparent for determinism;
     * focus itself is still visible through the focus ring.
     */
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}'
            + '.xterm-cursor-layer{opacity:1!important}'
            + '*{caret-color:transparent!important}',
    });
    /*
     * A fixed delay is a guess about script-evaluation time, and when it loses
     * the race the failure surfaces far away as a bare
     * "SessionManager is not defined" from inside seed(), with the captured
     * request/HTTP diagnostics never printed because snap() was never reached.
     * Wait on the production globals themselves, and if they never arrive,
     * report what the page actually did instead of the downstream symptom.
     */
    const isShellPage = pagePath === '/' || pagePath === '/index.html';
    if (isShellPage) {
        try {
            await page.waitForFunction(
                () => typeof SessionManager !== 'undefined'
                    && typeof TerminalManager !== 'undefined'
                    && typeof TerminalManager.isTouchShell === 'function',
                undefined, { timeout: 10000 });
        } catch (error) {
            const loaded = await page.evaluate(() => [...document.scripts]
                .map(s => s.src.split('/').pop()).filter(Boolean)).catch(() => []);
            throw new Error('shell globals never became available: '
                + `${error}\n  page errors: ${JSON.stringify(errors)}`
                + `\n  request failures: ${JSON.stringify(requestFailures)}`
                + `\n  HTTP >= 400: ${JSON.stringify(httpErrors)}`
                + `\n  scripts in document: ${JSON.stringify(loaded)}`);
        }
    }
    await page.waitForTimeout(350);
    return { ctx, page, errors };
}

/*
 * A rendering harness can silently photograph the wrong thing: an opener that
 * no longer exists, or a panel whose parent is display:none, both produce a
 * perfectly valid PNG of the closed shell. These two guards make that fail
 * loudly instead. Not assertions about the design -- assertions that the state
 * this shot claims to show is actually on screen.
 */
const problems = [];
async function expectBox(page, selector) {
    const r = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const b = el.getBoundingClientRect();
        return {
            found: true, w: Math.round(b.width), h: Math.round(b.height),
            display: getComputedStyle(el).display, hidden: el.hidden,
        };
    }, selector);
    if (!r.found || r.w < 8 || r.h < 8) {
        problems.push(`${selector} has no painted box: ${JSON.stringify(r)}`);
    }
    return r;
}
async function expectCollapsed(page, selector) {
    const collapsed = await page.evaluate(sel =>
        !!document.querySelector(sel)?.classList.contains('collapsed'), selector);
    if (!collapsed) problems.push(`${selector} was expected collapsed before the open click`);
}

async function expectAdminUsersReady(page, shotName) {
    try {
        await page.waitForFunction(expected =>
            document.querySelectorAll('#adminUsersBody > tr').length === expected,
        ADMIN_USERS.length, { timeout: 3000 });
    } catch {
        const actual = await page.locator('#adminUsersBody > tr').count();
        problems.push(`${shotName}: admin users readiness failed: expected `
            + `${ADMIN_USERS.length}, found ${actual}`);
    }
}

/*
 * ── Per-shot measured eye-gate audit ────────────────────────────────────────
 *
 * Measured INSIDE snap(), immediately before the screenshot, so every row
 * describes the same frame the PNG shows. A separately reconstructed run could
 * drift from the image and would be worth less than no measurement.
 *
 * Mockup values are quoted from docs/spec/sshdeck-ui-plan-v5.html with
 * the line number in `ref`. `null` mockup means the authority is silent on that
 * property for that surface -- reported for the record, never scored, so silence
 * is never dressed up as agreement. Intentional, ruled deviations carry the
 * ruling instead of a FAIL.
 */
const shotRows = [];
const MOCKUP = {
    frameBorder: 1, frameRadius: 12,            // 220
    headerControlMinH: 32, headerControlRadius: 7, headerControlGap: 5, // 234, 227
    desktopGlobalRow: 44, desktopWorkspaceRow: 40, rowDivider: 1,       // 224, 229
    touchGlobalRow: 44, touchSessionRow: 44, // 323-325 (358's 40px band retired 2026-09-19)
    chipH: 30, chipRadius: 7, chipGap: 3, chipMinW: 92, chipMinWTouch: 86, // 241-243, 325
    dropdownGap: 1, dropdownRadius: 10,         // 264-268
    keypadPadding: 5, keypadBorderTop: 1, keyMinH: 39, keyRadius: 7,     // 342-347
    composerMinH: 42, composerRadius: 7,        // 371-372
    logo: 32, logoRadius: 0,                    // 232 size; radius 0 since
    //: the mark the owner delivered IS a rounded square and carries
    // its own corner radius, so the 7px accent-soft tile the sprite glyph sat
    // on would be a second plate behind it. The SIZE is still the mockup's.
};
/*
 * A computed colour is not always `rgb()`. Anything derived with color-mix()
 * serializes as `color(srgb r g b)` with 0..1 CHANNELS --
 * on the auth canvas, where `color(srgb 0.861 0.844 0.814)` (a light beige) was
 * read as 0.0003 by a parser that assumed 0..255 and reported the light theme
 * as dark. The channel scale is taken from the notation, not assumed.
 */
const lum = rgb => {
    const text = String(rgb);
    const m = text.match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return null;
    const srgb = /^color\(\s*srgb/i.test(text);
    const scale = srgb ? 1 : 255;
    const f = c => (c /= scale) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]);
};
// Alpha channel of a computed rgb()/rgba() colour; opaque rgb() reads as 1.
const alphaOf = rgb => {
    const m = String(rgb).match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return null;
    return m.length > 3 ? +m[3] : 1;
};
// Every theme except paper is a dark palette (measured from --bg-primary in
// style.css); paper is the one deliberately light theme.
const LIGHT_THEMES = new Set(['paper']);
const MOCKUP_PALETTE = {
    glass: { shell: 'rgb(9, 11, 14)', text: 'rgb(230, 237, 243)',
        border: 'rgba(230, 237, 243, 0.12)', terminal: 'rgb(27, 34, 42)' },
    paper: { shell: 'rgb(247, 241, 231)', text: 'rgb(44, 39, 34)',
        border: 'rgb(207, 193, 175)', terminal: 'rgb(237, 229, 217)' },
    'cyberpunk-neon': { shell: 'rgb(12, 7, 19)', text: 'rgb(255, 242, 255)',
        border: 'rgb(76, 42, 103)', terminal: 'rgb(23, 14, 36)' },
    obsidian: { shell: 'rgb(0, 0, 0)', text: 'rgb(255, 255, 255)',
        border: 'rgb(44, 44, 44)', terminal: 'rgb(0, 0, 0)' },
};
const MOCKUP_TERMINAL_TOP_REL = {
    desktop: 86, 'phone-landscape': 86, ipad: 90,
    'ipad-landscape': 90, phone390: 90, phone359: 90,
};

function shotRow(shot, property, mockup, product, ref, ruling = null) {
    let delta = '';
    let verdict;
    const num = v => typeof v === 'number' && Number.isFinite(v);
    if (mockup === null) {
        delta = 'spec silent';
        verdict = 'REPORT';
    } else if (num(mockup) && num(product)) {
        const d = Math.round((product - mockup) * 100) / 100;
        delta = d === 0 ? '0' : `${d > 0 ? '+' : ''}${d}px`;
        verdict = d === 0 ? 'PASS' : 'FAIL';
    } else {
        delta = String(mockup) === String(product) ? '0' : 'differs';
        verdict = String(mockup) === String(product) ? 'PASS' : 'FAIL';
    }
    if (verdict === 'FAIL' && ruling) verdict = ruling;
    shotRows.push({ shot, property, mockup: mockup === null ? '(silent)' : mockup,
        product, delta, verdict, ref });
}

async function measureShot(page, name) {
    const m = await page.evaluate(() => {
        const px = v => Math.round(parseFloat(v) * 100) / 100 || 0;
        const rect = sel => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return { w: Math.round(r.width), h: Math.round(r.height),
                top: Math.round(r.top), bottom: Math.round(r.bottom),
                left: Math.round(r.left), right: Math.round(r.right),
                display: cs.display, visible: cs.display !== 'none'
                    && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
                radius: px(cs.borderTopLeftRadius), borderTop: px(cs.borderTopWidth),
                borderBottom: px(cs.borderBottomWidth), minH: px(cs.minHeight),
                minW: px(cs.minWidth), gap: px(cs.gap), padding: cs.padding,
                bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight,
                family: cs.fontFamily, shadow: cs.boxShadow === 'none' ? 'none' : 'present',
                borderColor: cs.borderTopColor };
        };
        /*
         * THE CARD ON TOUCH IS THE SHEET, NOT THE TREE. Correction A
         * hosts #accountDropdownHeader INSIDE #mobileMoreSheet: the sheet owns the
         * card surface (1px border, radius, shadow, the 312px outer width of
         * referenceOuter below) while the hosted tree is plain content (radius 0,
         * border 0, inset by the sheet padding). On desktop the tree is still its
         * own card. The candidate order therefore checks the sheet BEFORE the
         * tree: on touch both are visible and the tree used to win the .find(),
         * scoring the inner content box as if it were the card (radius 0 / width
         * 294 instead of the card's 10px / 312px). On desktop the sheet is
         * [hidden], so the order is a no-op there.
         */
        const openPanel = ['#layoutMenu', '#mobileMoreSheet', '#accountDropdownHeader']
            .map(sel => ({ sel, r: rect(sel) }))
            .find(x => x.r && x.r.visible);
        const trigger = { '#layoutMenu': '#layoutMenuBtn',
            '#accountDropdownHeader': '#accountBtnHeader',
            '#mobileMoreSheet': '#mobileMoreBtn' }[openPanel?.sel];
        const pane = document.querySelector('.terminal-pane.active')
            || document.querySelector('.terminal-pane');
        const kp = rect('#mobileKeypad');
        const paneR = pane ? pane.getBoundingClientRect() : null;
        const rows = document.querySelector('#terminal-s1 .xterm-rows');
        return {
            theme: document.body.dataset.theme || '',
            deckBorderToken: document.getElementById('deckWindow')
                ? getComputedStyle(
                    document.getElementById('deckWindow')).borderTopColor : null,
            isTouch: typeof TerminalManager !== 'undefined'
                && TerminalManager.isTouchShell ? TerminalManager.isTouchShell() : null,
            landscape: window.matchMedia('(orientation: landscape)').matches,
            deck: rect('#deckWindow'), body: rect('body'),
            header: rect('.header'), tabRow: rect('.session-tabs-row'),
            actionRow: rect('#touchActionRow'), strip: rect('#sessionTabs'),
            chip: rect('#tab-s1'),
            chipPill: (() => {
                const tab = document.getElementById('tab-s1');
                if (!tab) return null;
                const b = getComputedStyle(tab, '::before');
                if (!b || b.content === 'none') return null;
                return { h: Math.round(parseFloat(b.height)) || 0,
                    radius: px(b.borderTopLeftRadius) };
            })(),
            chipHit: (() => {
                const tab = document.getElementById('tab-s1');
                if (!tab) return null;
                const a = getComputedStyle(tab, '::after');
                if (!a || a.content === 'none') return null;
                return { h: Math.round(parseFloat(a.height)) || 0 };
            })(),
            pane: paneR
                ? { top: Math.round(paneR.top), h: Math.round(paneR.height),
                    bg: getComputedStyle(pane).backgroundColor } : null,
            termRows: rows ? { n: rows.children.length,
                family: getComputedStyle(rows).fontFamily } : null,
            headerBtn: rect('#newConnectionBtn'),
            logo: rect('.brand-logo'),
            keypad: kp, keyEl: rect('.keypad-key'),
            keypadOverlap: kp && kp.visible && paneR
                ? Math.max(0, Math.min(kp.bottom, paneR.bottom)
                    - Math.max(kp.top, paneR.top)) : 0,
            composer: rect('#mobileInput'),
            target: (() => {
                const t = document.getElementById('composerTarget');
                if (!t) return null;
                const r = rect('#composerTarget');
                return { ...r, hidden: t.hidden,
                    text: t.querySelector('.composer-target-label')
                        ?.textContent.trim() || '' };
            })(),
            exitScroll: (() => {
                const b = document.getElementById('exitScrollBtn');
                if (!b) return null;
                return { ...rect('#exitScrollBtn'), hidden: b.hidden };
            })(),
            notesHead: rect('.notepad-header'), notesTa: rect('#sessionNotepad'),
            // A closed Notes panel is translated offscreen, not display:none, so
            // "visible" is not enough -- require it to intersect the viewport.
            notesOnScreen: (() => {
                const p = document.getElementById('notepadPanel');
                if (!p) return false;
                const cs = getComputedStyle(p);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                if (p.classList.contains('collapsed')) return false;
                const r = p.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.right > 0
                    && r.left < window.innerWidth && r.bottom > 0
                    && r.top < window.innerHeight;
            })(),
            shortLandscape: window.matchMedia(
                '(max-height: 500px) and (orientation: landscape)').matches,
            panel: openPanel ? { sel: openPanel.sel, ...openPanel.r,
                gap: trigger && document.querySelector(trigger)
                    ? Math.round((openPanel.r.top - document.querySelector(trigger)
                        .getBoundingClientRect().bottom) * 100) / 100 : null } : null,
            authLogo: rect('.a5-logo'), authTitle: rect('.a5-title'),
            head: {
                icon: document.querySelector('link[rel="icon"]')
                    ?.getAttribute('href') || 'ABSENT',
                ico: document.querySelector('link[rel="alternate icon"]')
                    ?.getAttribute('href') || 'ABSENT',
                logoGlyph: document.querySelector('.a5-logo use, .brand-logo use')
                    ?.getAttribute('href')?.split('#')[1] || 'ABSENT',
            },
        };
    });

    const R = (p, mk, pr, ref, ruling) => shotRow(name, p, mk, pr, ref, ruling);

    // ── outer frame + hairline (mockup 220, 224, 229) ───────────────────────
    /*
     * Frame: mockup 220 states border 1px / radius 12px / a real shadow, and it
     * does NOT vary them by viewport -- the only per-viewport `.tw5-window` rules
     * (mockup 321) set aspect-ratio. So `null` on touch was my extractor
     * suppressing a value the authority does supply. The app deliberately
     * flattens the frame edge-to-edge on touch ([INF-B9-1], Entry 25),
     * which is a ruled deviation, not spec silence -- score it and cite the entry.
     */
    if (m.deck) {
        R('frame border-width', MOCKUP.frameBorder, m.deck.borderTop,
            'mockup 220', m.isTouch ? 'RULED 25 (touch edge-to-edge)' : null);
        R('frame border-radius', MOCKUP.frameRadius, m.deck.radius,
            'mockup 220', m.isTouch ? 'RULED 25 (touch edge-to-edge)' : null);
        R('frame box-shadow', 'present', m.deck.shadow,
            'mockup 220 0 18px 42px',
            m.isTouch ? 'RULED 25 (touch edge-to-edge)' : null);
        /*
         * Colour genuinely cannot be compared: mockup 220 paints
         * var(--tw-border), a token the mockup declares only for its own four
         * preview palettes (212-219), while the app has ten themes on its own
         * token bridge. Amendment 109 forbids re-hardcoding either side, so
         * there is no single hex the app should equal. Reported, not scored.
         */
        /*
         * `var(--tw-border)` resolves to a concrete colour once rendered, so this
         * IS comparable for the four palettes the mockup ships. The app's own ten
         * themes own their border token (amendment 109), so a difference is the
         * ruling, not a defect; themes with no mockup counterpart stay reported.
         */
        const frameRef = MOCKUP_PALETTE[m.theme || 'glass'];
        if (frameRef) {
            R('frame border-color', frameRef.border, m.deck.borderColor,
                'mockup 220 var(--tw-border) rendered',
                'RULED amendment 109 (app owns its palette)');
        } else {
            /*
             * The mockup ships exactly four palettes (213-219), so shots running
             * one of them have a hex to differ from (37 ruled rows); the six app
             * themes with no counterpart do not. The authority is NOT silent
             * about the border itself though: mockup 220 requires a painted
             * hairline. Score it objectively -- the computed colour must resolve
             * from the theme token with alpha > 0 and contrast its own shell,
             * i.e. a visible, never fully transparent hairline.
             */
            const a = alphaOf(m.deck.borderColor);
            const shellLum = lum(m.deck.bg);
            const borderLum = lum(m.deck.borderColor);
            const contrast = a !== null && shellLum !== null && borderLum !== null
                ? Math.round(Math.abs(borderLum - shellLum)
                    * Math.max(a, 0.05) * 10000) / 10000 : null;
            const CRITERION = 'visible hairline (alpha>0, contrast>0.001)';
            R('frame border-color', CRITERION,
                a !== null && a > 0 && contrast !== null && contrast > 0.001
                    ? CRITERION : `broken (alpha=${a}, contrast=${contrast})`,
                'mockup 220 hairline must paint; six app themes own their palette');
        }
    }
    /*
     * The hairline's OWNER moves by tier, so scoring a fixed pair of elements
     * measures the wrong thing. At >=768px `.header` sets border-bottom:none
     * (style.css:4647) and `.session-tabs-row` owns it; on phones BOTH of those
     * are `display: contents` (style.css:874) and generate no box at all, and
     * the line is painted by `#touchActionRow`'s border-bottom (measured 1px at
     * 390x844). Collect every candidate and assert exactly one hairline exists
     * between the tiers, whichever element carries it.
     */
    const hairlineCandidates = [
        m.header && m.header.display !== 'contents' ? m.header.borderBottom : 0,
        m.tabRow && m.tabRow.display !== 'contents' ? m.tabRow.borderTop : 0,
        m.actionRow ? m.actionRow.borderBottom : 0,
    ].filter(v => v >= 1);
    if (m.header || m.actionRow) {
        R('header/toolbar hairline count', 1, hairlineCandidates.length,
            'mockup 224+229 one line between tiers, owner varies by tier');
        R('header/toolbar hairline width', MOCKUP.rowDivider,
            hairlineCandidates.length ? Math.max(...hairlineCandidates) : 0,
            'mockup 229');
    }

    // ── header controls (mockup 234) ────────────────────────────────────────
    if (m.headerBtn && m.headerBtn.visible) {
        /*
         * W14 item 7: #newConnectionBtn is NOT a header control any more and it
         * is never relocated into the global menu. It is the permanent icon-only
         * FIRST CHILD of .session-tabs-row at every tier, and the strip's tier
         * owns its metrics: the fine-pointer 40px desktop tier fits it at 30px
         * (the mockup's 32px control number belongs to the header tier the node
         * has left), the coarse touch tier makes it a true 44px target -- the
         * INF-4 ruling (44px touch floor) the owner already applied to the keypad
         * key (R2) and the composer (Entry 26). Phone landscape is a coarse
         * tier like any other since the dock relocation was retired (owner
         * ruling).
         */
        const expectedH = m.isTouch ? 44 : 30;
        R('strip "+" height', expectedH, m.headerBtn.h,
            'W14 item 7: coarse strip tier 44px, fine-pointer tier 30px',
            m.isTouch ? 'RULED INF-4 (44px touch floor)' : null);
        R('strip "+" radius', MOCKUP.headerControlRadius, m.headerBtn.radius,
            'mockup 234 radius carried onto the strip control');
    }
    if (m.logo && m.logo.visible) {
        R('logo size', MOCKUP.logo, m.logo.w, 'shell-balance amendment: 32px brand');
        R('logo radius', MOCKUP.logoRadius, m.logo.radius, 'mockup 232');
    }

    // ── toolbar/session rows + chips (mockup 241-243, 323-325, 358) ─────────
    if (m.actionRow && m.actionRow.visible) {
        // One touch row height at every touch tier: the phone-landscape 40px
        // band (mockup 358, Entry 1) was retired.
        R('touch action row height', MOCKUP.touchGlobalRow, m.actionRow.h,
            'mockup 323');
    }
    /*
     * The desktop bar IS specified: mockup 228 global row height:44px and 229
     * workspace row height:40px, i.e. 84px of stacked tiers. The app ships a 48px
     * global tier (style.css:879) + 40px session tier = 88px, so this is a real
     * +4px deviation that my extractor was hiding behind `null`. Scored, and the
     * two tiers are reported separately so the source of the difference is visible
     * rather than buried in a total.
     */
    if (m.header && m.header.visible && !m.isTouch) {
        R('desktop header total height', 84, m.header.h,
            'mockup 228 (44) + 229 (40) stacked tiers');
        if (m.tabRow && m.tabRow.h > 0) {
            R('desktop global tier height', 44, m.header.h - m.tabRow.h,
                'mockup 228 global row height:44px');
        }
    }
    if (m.tabRow && m.tabRow.display !== 'none' && m.tabRow.display !== 'contents') {
        R('session row height', m.isTouch
            ? MOCKUP.touchSessionRow
            : MOCKUP.desktopWorkspaceRow, m.tabRow.h, 'mockup 229/324');
    }
    /*
     * The 30px pill is painted by `.session-tab::before` (style.css:2013), which
     * is pointer-events:none, while the ELEMENT is deliberately 44px so the tap
     * target meets the touch floor (amendment 54, Entry 7 Part A).
     * Scoring the element rect measured the hit box against a paint number and
     * reported +14px on every touch shot. Radius and min-width live on the pill
     * for the same reason. Measure the painted pseudo-element.
     */
    if (m.chip && m.chip.visible) {
        R('session chip painted pill height', MOCKUP.chipH,
            m.chipPill ? m.chipPill.h : m.chip.h,
            'mockup 243/325 30px, painted by ::before');
        R('session chip radius', MOCKUP.chipRadius,
            m.chipPill ? m.chipPill.radius : m.chip.radius, 'mockup 243');
        R('session chip min-width', MOCKUP.chipMinW, m.chip.minW,
            'mockup 243 min-width:92px (deck.css:935/949 on both surfaces)');
        /*
         * The hit rect is not silent either. Mockup 325 places the 30px chip in a
         * 44px touch row and gives it `::before { inset-block:-7px }`, i.e. a 44px
         * interaction band. On desktop the real outer chip itself measures 30px.
         * The app uses a 44px element and 30px `::before` pill on touch -- same
         * outer interaction geometry through the inverse implementation.
         */
        R('session chip interaction height', m.isTouch ? 44 : 30,
            m.isTouch && m.chipHit ? m.chipHit.h : m.chip.h,
            m.isTouch ? 'mockup 325: 30px pill + 7px each side = 44px hit band'
                : 'mockup 243 rendered outer chip height 30px',
            !m.isTouch ? 'RULED 21/23 (app desktop border-box pill is 32px)'
                : null);
        R('session chip element rect height', null, m.chip.h,
            'implementation box; painted pill and interaction band scored separately');
    }
    if (m.strip && m.strip.visible) {
        R('session strip gap', MOCKUP.chipGap, m.strip.gap, 'mockup 241 gap:3px');
    }

    // ── terminal region (mockup 252-253) ───────────────────────────────────
    if (m.pane) {
        /*
         * The mockup DOES pin this, once measured DECK-RELATIVE rather than as a
         * viewport y (which is what made it look unspecifiable): rendering the
         * authority gives terminal.top - window.top = 86px on desktop and phone
         * landscape, 90px on iPad and phone portrait.
         *
         * The app's own tiers are 48+40=88 on desktop (style.css:879) against the
         * mockup's 44+40=84, so the +4 recorded in Entry 33 propagates here. That
         * is the same ruled tier height, cited rather than re-litigated.
         */
        const shotKey = name.includes('phone-landscape') ? 'phone-landscape'
            : name.includes('ipad-landscape') ? 'ipad-landscape'
                : name.includes('ipad') ? 'ipad'
                    : name.includes('phone359') ? 'phone359'
                        : name.includes('phone390') ? 'phone390' : 'desktop';
        const refTop = MOCKUP_TERMINAL_TOP_REL[shotKey];
        const deckTop = m.deck ? m.deck.top : 0;
        R('terminal top offset (deck-relative)', refTop,
            Math.round(m.pane.top - deckTop),
            `mockup 252 rendered: ${refTop}px below the window's top edge`,
            'RULED 33 (48px global tier vs mockup 44px)');
        R('terminal height positive', 'yes', m.pane.h > 0 ? 'yes' : 'no',
            'amendment 94 workspace keeps positive height');
    }
    if (m.termRows) {
        R('terminal visible rows', null, m.termRows.n, 'mockup 162-168');
        R('terminal font is monospace', 'monospace',
            /mono|Menlo|Consolas|Courier/i.test(m.termRows.family)
                ? 'monospace' : m.termRows.family, 'mockup 253');
    }

    // ── dropdown anchoring (mockup 264-268) ────────────────────────────────
    if (m.panel) {
        R(`dropdown gap below trigger (${m.panel.sel})`,
            m.panel.gap !== null && m.panel.gap < 0 ? null : MOCKUP.dropdownGap,
            m.panel.gap, 'mockup 265-268 top:calc(100% + 1px)',
            'RULED 5B');
        R(`dropdown radius (${m.panel.sel})`, MOCKUP.dropdownRadius, m.panel.radius,
            'mockup 264 border-radius:10px');
        /*
         * Widths ARE specified (mockup 265-268) as min(<cap>, 100% - <inset>), so
         * the expected value is computable rather than silent -- another value my
         * extractor was suppressing. Caps: desktop global 310 / layout 390 with a
         * 16px inset; touch global 300 / layout 360 with 12px.
         */
        /*
         * BOX MODEL, measured the hard way. The mockup declares
         * `box-sizing: border-box` on exactly four ROW elements (228, 229, 324,
         * 325) and nowhere else, so its menu panels are CONTENT-BOX: mockup 265's
         * `width:310px` is a CONTENT width, and the painted box adds the 1px
         * border on each side (264) plus the panel's own `padding:5px` where it
         * has one. The app is border-box globally (style.css:5), so its painted
         * width equals the mockup's PAINTED width, not its declared number.
         * Comparing 310 against a painted 322 was my arithmetic error, not a
         * product deviation -- the +12 is exactly 2x1px border + 2x5px padding.
         */
        /*
         * EXACT REFERENCE OUTER WIDTHS, measured by rendering the authority itself
         * at the same viewport/state and reading getBoundingClientRect().width.
         * This captures its REAL content-box arithmetic, padding and 1px borders;
         * no tolerance and no one-sided cap that a zero-width panel could satisfy.
         *
         * Reference measurements:
         * desktop layout 392; iPad/phone layout 362;
         * desktop global 322; touch global 312.
         */
        const referenceOuter = {
            '#accountDropdownHeader': 322,
            '#layoutMenu': m.isTouch ? 362 : 392,
            '#mobileMoreSheet': 312,
        }[m.panel.sel];
        if (referenceOuter) {
            R(`dropdown exact outer width (${m.panel.sel})`, referenceOuter,
                m.panel.w, 'mockup 264-268 rendered getBoundingClientRect().width');
        } else {
            R(`dropdown width (${m.panel.sel})`, null, m.panel.w, 'mockup 265-268');
        }
        const panelContained = m.panel.left >= 0
            && m.panel.right <= (m.body ? m.body.w + 1 : 1e9);
        R(`dropdown inside viewport (${m.panel.sel})`, 'yes',
            panelContained ? 'yes'
                : `no (${m.panel.left}..${m.panel.right} / ${m.body?.w})`,
            'amendment 92');
    }

    // ── keypad / composer (mockup 341-347, 368-372) ────────────────────────
    if (m.keypad && m.keypad.visible) {
        R('keypad padding', `${MOCKUP.keypadPadding}px`, m.keypad.padding,
            'mockup 342 padding:5px');
        R('keypad border-top', MOCKUP.keypadBorderTop, m.keypad.borderTop,
            'mockup 342');
        R('keypad overlaps terminal', 0, Math.round(m.keypadOverlap),
            'amendment 94 keypad must not overlay the terminal');
        if (m.keyEl) {
            R('keypad key min-height', MOCKUP.keyMinH, m.keyEl.minH,
                'mockup 347 min-height:39px', 'RULED 29 (R2: 44px floor)');
            R('keypad key radius', MOCKUP.keyRadius, m.keyEl.radius, 'mockup 347');
        }
    }
    /*
     * INF-4 (ruled and APPROVED): on a touch surface the 44px target
     * floor outranks the mockup's smaller control numbers -- the same rule the
     * owner applied to the keypad key in R2. The composer is a touch control, so
     * 44 against mockup 42 is the ruled floor winning, not a drift.
     */
    if (m.composer && m.composer.visible) {
        R('composer min-height', MOCKUP.composerMinH, m.composer.minH,
            'mockup 371 min-height:42px vs INF-4 44px touch floor',
            'RULED INF-4 (44px floor)');
        R('composer radius', MOCKUP.composerRadius, m.composer.radius, 'mockup 371');
    }

    // ── broadcast counter (mockup 191, 372; amendment 83) ──────────────────
    /*
     * The target chip is REQUIRED to be hidden outside Broadcast (amendment 74:
     * desktop normal has no target). Asserting "present === true" on every shot
     * scored the correct hidden state as a failure on all 40 non-Broadcast shots.
     * The contract is conditional: present-and-hidden off, visible-with-N on.
     */
    if (m.target) {
        const broadcastShot = name.includes('broadcast-on')
            || name === '03-desktop-broadcast';
        R('broadcast counter exists in DOM', true, true, 'mockup 191 target chip');
        R('broadcast counter visible', broadcastShot, !m.target.hidden,
            broadcastShot ? 'mockup 191 visible in Broadcast'
                : 'amendment 74 hidden outside Broadcast');
        if (!m.target.hidden) {
            R('broadcast counter text', 'All 2', m.target.text,
                'amendment 83: s3 disconnected excluded, N=2');
            /*
             * Same INF-4 ruling as the composer row above, applied twice now:
             * the chip is a touch control -- since W14 item 6 literally the
             * picker trigger button -- so the 44px floor outranks the
             * mockup's 42px control metric. Ruled, not a drift.
             */
            R('broadcast counter min-height', MOCKUP.composerMinH, m.target.minH,
                'mockup 372 vs INF-4 44px touch floor',
                'RULED INF-4 (44px floor)');
            R('broadcast counter radius', MOCKUP.composerRadius, m.target.radius,
                'mockup 372');
        }
    }

    // ── exit-scroll (mockup 336-339) ──────────────────────────────────────
    if (m.exitScroll && !m.exitScroll.hidden) {
        R('exit-scroll height', 44, m.exitScroll.h, 'touch 44px floor');
        R('exit-scroll reachable', 'yes', m.exitScroll.visible ? 'yes' : 'no',
            'mockup 336-337 revealed in scroll state');
    }

    // ── notes (mockup 292, 295) ───────────────────────────────────────────
    /*
     * Only measure Notes on the shots that actually open it. A closed panel is a
     * translated-offscreen sheet, not display:none, so it still reports a rect
     * and a computed padding -- which is how the phone-landscape 5px override
     * (deck.css:1933, a ruled short-landscape adaptation) got scored against the
     * mockup's 9px on shots where Notes is not even on screen.
     */
    if (m.notesOnScreen && m.notesHead && m.notesHead.visible) {
        R('notes header padding', m.shortLandscape ? null : '9px',
            m.notesHead.padding,
            m.shortLandscape ? 'deck.css:1933 short-landscape 5px' : 'mockup 292');
        R('notes header border-bottom', 1, m.notesHead.borderBottom, 'mockup 292');
    }
    if (m.notesOnScreen && m.notesTa && m.notesTa.visible) {
        R('notes textarea radius', 7, m.notesTa.radius, 'mockup 295');
        R('notes textarea monospace', 'monospace',
            /mono|Menlo|Consolas/i.test(m.notesTa.family)
                ? 'monospace' : m.notesTa.family, 'mockup 295');
    }

    // ── auth pages + favicon wiring ───────────────────────────────────────
    if (m.authLogo && m.authLogo.visible) {
        R('auth logo present', 'yes', 'yes', 'mockup 232 scaled [INF-3]');
        /* [INF-B3]: the delivered mark fills its box and draws its
           own rounded corners, so the tile radius is 0 and the mark, not the
           CSS, carries the shape. */
        R('auth logo radius', 0, m.authLogo.radius,
            'the mark carries its own corner radius');
        R('auth logo glyph', 'icon-brand', m.head.logoGlyph,
            'the mark the owner delivered, inline so it takes the theme ink');
    }
    if (m.authTitle && m.authTitle.visible) {
        R('auth title font-weight', 500, Number(m.authTitle.weight),
            'mockup 221 rendered brand/title weight 500');
    }
    if (m.head.icon !== 'ABSENT' || m.authLogo) {
        /* v3: the tab icon is the ROUTES on a transparent ground, not the
           filled plate -- v2 shipped the plate and read as a black square in a
           tab strip, so a browser holding it must be made to refetch. */
        R('favicon svg wired', '/static/icons/favicon.svg?v=3', m.head.icon,
            'H6 primary icon');
        R('favicon ico fallback', '/static/icons/favicon.ico?v=3', m.head.ico,
            'H6 legacy fallback');
    }

    // ── theme palette: no light background in a dark theme ────────────────
    if (m.theme) {
        const surface = m.deck ? m.deck.bg : (m.body ? m.body.bg : null);
        const L = lum(surface);
        const isLight = L !== null && L > 0.5;
        const shouldBeLight = LIGHT_THEMES.has(m.theme);
        /*
         * The mockup DOES carry exact hex for the four palettes it ships (212-219,
         * measured by rendering it: glass/paper/cyberpunk/obsidian). Those four are
         * therefore comparable and are scored against the rendered reference.
         *
         * Where the app's shipped palette differs from the mockup's preview value,
         * that is amendment 109 (the app's ten themes own their tokens; the mockup
         * must not be re-hardcoded into them) -- cited as the ruling, not relaxed.
         * The six app themes with no mockup counterpart stay reported.
         */
        const ref = MOCKUP_PALETTE[m.theme];
        R(`theme "${m.theme}" shell background`, ref ? ref.shell : null, surface,
            ref ? 'mockup 212-219 rendered palette' : 'no mockup counterpart theme',
            'RULED amendment 109 (app owns its palette)');
        R(`theme "${m.theme}" shell background luminance`, null,
            L === null ? 'n/a' : L.toFixed(4), 'measured, for the dark/light rule');
        R(`theme "${m.theme}" light bg only if light theme`,
            shouldBeLight ? 'light' : 'dark', isLight ? 'light' : 'dark',
            'no dark theme may render a light shell');
        if (m.body) R(`theme "${m.theme}" text colour`, ref ? ref.text : null,
            m.body.color, ref ? 'mockup 213/217-219 rendered palette'
                : 'no mockup counterpart theme',
            'RULED amendment 109 (app owns its palette)');
        if (m.deck) R(`theme "${m.theme}" border colour`, ref ? ref.border : null,
            m.deck.borderColor, ref ? 'mockup 213/217-219 rendered palette'
                : 'no mockup counterpart theme',
            'RULED amendment 109 (app owns its palette)');
        if (m.deck) R(`theme "${m.theme}" border colour resolves from theme token`,
            'yes',
            m.deckBorderToken === m.deck.borderColor ? 'yes'
                : `no (${m.deckBorderToken})`,
            'computed border must equal the theme token, never a fallback');
        if (m.pane) R(`theme "${m.theme}" terminal surface`,
            ref ? ref.terminal : null, m.pane.bg,
            ref ? 'mockup 212/217-219 rendered palette'
                : 'no mockup counterpart theme',
            'RULED amendment 109 (app owns its palette)');
    }
}
async function snap(page, errors, name) {
    await page.waitForTimeout(220);
    /*
     * Chromium rasterizes the static 3px translucent focus shadow on an
     * autofocused auth field into two stable byte patterns depending on which
     * point in the native autofocus lifecycle the screenshot catches. Measured
     * pair delta: 47 pixels, bbox 515..924 x 367..416, max channel delta 11,
     * entirely at the four rounded focus-ring corners. Native caret is already
     * transparent above; GPU disable was tested and did NOT eliminate this.
     *
     * Normalize the real focus lifecycle rather than hiding the ring or adding
     * a fuzzy comparison: blur, wait a frame, refocus the same element without
     * scrolling, wait two frames. The screenshot still contains the product's
     * real focus state and exact byte equality remains the hard gate.
     */
    if (name.startsWith('21-') || name.startsWith('22-')
            || name.startsWith('23-') || name.startsWith('24-')
            || name.startsWith('27-') || name.startsWith('31-theme-')) {
        await page.evaluate(async () => {
            const target = document.activeElement instanceof HTMLElement
                ? document.activeElement : document.querySelector('[autofocus]');
            if (!target) return;
            target.blur();
            await new Promise(resolve => requestAnimationFrame(resolve));
            target.focus({ preventScroll: true });
            await new Promise(resolve => requestAnimationFrame(() =>
                requestAnimationFrame(resolve)));
        });
    }
    try {
        await measureShot(page, name);
    } catch (error) {
        problems.push(`${name}: per-shot audit measurement failed: ${error}`);
    }
    const diagnostics = pageDiagnostics.get(page)
        || { requestFailures: [], httpErrors: [] };
    const errorToasts = await page.locator('.notification-error').count();
    errors.forEach(error => problems.push(`${name}: page error: ${error}`));
    diagnostics.requestFailures.forEach(error =>
        problems.push(`${name}: request failed: ${error}`));
    diagnostics.httpErrors.forEach(error =>
        problems.push(`${name}: HTTP error: ${error}`));
    if (errorToasts) {
        problems.push(`${name}: ${errorToasts} notification-error toast(s) rendered`);
    }
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push({ name, file, errors: errors.slice() });
    console.log(`SHOT  ${name}${errors.length ? `  [pageerror: ${errors[0]}]` : ''}`);
}

/*
 * Seed real sessions with real xterm terminals, mirroring mockup lines 87-89
 * (tiny / a second host / staging, the third disconnected) so the strip and panes hold
 * the same content the mockup draws.
 */
const SEED_SESSION_IDS = ['s1', 's2', 's3'];
const SEED_OUTPUT_MARKERS = {
    s1: { text: 'root@tiny:~#', cursorOffset: 0 },
    s2: { text: 'root@goclaw:~#', cursorOffset: 0 },
    s3: { text: 'Started terminal service.', cursorOffset: -1 },
};

function requireSeedInvariant(condition, label, actual) {
    if (!condition) {
        throw new Error(`Seed invariant failed: ${label}: ${JSON.stringify(actual)}`);
    }
}

async function seed(page, {
    layout = 1, variant = 'default', useTmux = false, scrollLines = 0,
} = {}) {
    /*
     * Every shell() call owns a fresh browser context. Prove that production
     * state really starts empty rather than silently layering this fixture over
     * a restored or duplicated session/terminal set.
     */
    const before = await page.evaluate(() => ({
        sessions: Object.keys(SessionManager.sessions).sort(),
        pending: Object.keys(SessionManager.pendingConnections || {}).sort(),
        tabs: [...document.querySelectorAll('#sessionTabs > .session-tab')]
            .map(tab => tab.id).sort(),
        terminals: Object.keys(TerminalManager.terminals).sort(),
        terminalOwners: Object.keys(TerminalManager.sessionTerminals).sort(),
        active: SessionManager.getActiveSession(),
    }));
    requireSeedInvariant(
        before.sessions.length === 0
            && before.pending.length === 0
            && before.tabs.length === 0
            && before.terminals.length === 0
            && before.terminalOwners.length === 0
            && before.active === null,
        'fresh context must start with zero sessions and terminals',
        before
    );

    await page.evaluate(({ layout, variant, useTmux, scrollLines }) => {
        const SEEDS = [
            ['s1', 'tiny', 'root', true],
            ['s2', 'goclaw', 'root', true],
            ['s3', 'staging', 'deploy', false],
        ];
        SessionManager.setSplitLayout(layout, variant);
        SEEDS.forEach(([id, host, user]) => {
            SessionManager.createSession({
                session_id: id,
                host,
                port: 22,
                username: user,
                auth_type: 'key',
                key_id: 'k1',
                display_name: host,
                use_tmux: id === 's1' && useTmux,
                tmux_session_name: id === 's1' && useTmux ? 'visual-s1' : null,
                via_jump: null,
            });
        });
        const paneCount = SessionManager.layout;
        ['s1', 's2', 's3'].slice(0, paneCount).forEach((id, i) => {
            SessionManager.assignSessionToPane(id, i);
        });
        // assignSessionToPane activates each assigned pane in turn. Normalize the
        // final fixture through the production pane owner so s1 is always active.
        SessionManager.setActivePane(0);
    }, { layout, variant, useTmux, scrollLines });

    /*
     * attachTerminal owns the readiness transition. Do not write before all
     * three production terminalReady flags have become true: attachTerminal
     * deliberately clears each xterm immediately before publishing that signal.
     */
    await page.waitForFunction(expectedIds =>
        expectedIds.every(id =>
            TerminalManager.terminalReady[id] === true
        ),
    SEED_SESSION_IDS, { timeout: 3000 });

    const readyBeforeWrite = await page.evaluate(expectedIds =>
        Object.fromEntries(expectedIds.map(id => [
            id, TerminalManager.terminalReady[id] === true
        ])),
    SEED_SESSION_IDS);
    requireSeedInvariant(
        SEED_SESSION_IDS.every(id => readyBeforeWrite[id] === true),
        'every production terminalReady signal must precede output',
        readyBeforeWrite
    );

    await page.evaluate(({ scrollLines }) => {
        // Mockup lines 162-168: real terminal output, so a pane is not an empty box.
        const LINES = {
            s1: 'Last login: Tue Aug 04 09:18:22 from 100.99.0.12\r\n'
                + '\x1b[32mroot@tiny\x1b[0m\x1b[36m:~#\x1b[0m docker ps --filter name=sshdeck\r\n'
                + 'CONTAINER ID  IMAGE            STATUS\r\n'
                + 'c2cc53c2db71  sshdeck:preview  Up 2 hours\r\n'
                + '\x1b[32mroot@tiny\x1b[0m\x1b[36m:~#\x1b[0m systemctl is-active docker\r\nactive\r\n'
                + '\x1b[32mroot@tiny\x1b[0m\x1b[36m:~#\x1b[0m ',
            s2: '\x1b[32mroot@goclaw\x1b[0m\x1b[36m:~#\x1b[0m uptime\r\n'
                + ' up 18 days, load average: 0.08\r\n'
                + '\x1b[32mroot@goclaw\x1b[0m\x1b[36m:~#\x1b[0m ',
            s3: '\x1b[32mdeploy@staging\x1b[0m\x1b[36m:~$\x1b[0m journalctl -u sshdeck -f\r\n'
                + 'Started terminal service.\r\n',
        };
        if (scrollLines > 0) {
            LINES.s1 += Array.from({ length: scrollLines }, (_, index) =>
                `scrollback line ${String(index + 1).padStart(3, '0')}\r\n`).join('');
            LINES.s1 += '\x1b[32mroot@tiny\x1b[0m\x1b[36m:~#\x1b[0m ';
        }

        TerminalManager.fitAllTerminals();
        Object.entries(LINES).forEach(([id, text]) => {
            // Production output owner: transcript bookkeeping, session-to-terminal
            // routing and terminalReady enforcement remain in TerminalManager.
            TerminalManager.writeOutput(id, text);
        });
    }, { scrollLines });

    /*
     * Await painted semantic output in each real xterm buffer. The marker is at
     * the final cursor line (or the preceding line for staging's trailing CRLF),
     * so this cannot pass merely because writeOutput accepted the string.
     */
    await page.waitForFunction(markers =>
        Object.entries(markers).every(([id, marker]) => {
            const terminal = TerminalManager.terminals[id];
            const buffer = terminal?.buffer?.active;
            if (!buffer) return false;
            const absoluteCursor = buffer.baseY + buffer.cursorY;
            const line = buffer.getLine(
                absoluteCursor + marker.cursorOffset);
            return line?.translateToString(true).includes(marker.text) === true;
        }),
    SEED_OUTPUT_MARKERS, { timeout: 3000 });

    /*
     * Apply measured latency only through its production owner. Disconnecting s3
     * through updateSessionStatus owns both the status repaint and stale-latency
     * clearing. Reassert pane 0 afterward so every screenshot starts on s1.
     *
     * Then wait one animation frame: the status bar coalesces its repaint into a
     * rAF (D1 batching, app.js StatusBar.scheduleRefresh), so #statusBarLatency
     * is one frame behind applySessionLatency. Every screenshot below is taken
     * after this point, so the painted bar is what the invariant reads.
     */
    await page.evaluate(async () => {
        SessionManager.applySessionLatency('s1', 34);
        SessionManager.applySessionLatency('s2', 52);
        SessionManager.updateSessionStatus('s3', 'disconnected');
        SessionManager.setActivePane(0);
        await new Promise(resolve => requestAnimationFrame(() =>
            requestAnimationFrame(resolve)));
    });

    const after = await page.evaluate(expectedIds => {
        const xterms = {};
        expectedIds.forEach(id => {
            const terminal = TerminalManager.terminals[id];
            xterms[id] = {
                keys: [...(TerminalManager.sessionTerminals[id] || [])],
                registered: !!terminal,
                real: typeof Terminal === 'function'
                    && terminal instanceof Terminal,
                ready: TerminalManager.terminalReady[id] === true,
                elementConnected: terminal?.element?.isConnected === true,
                screenCount: terminal?.element
                    ?.querySelectorAll('.xterm-screen').length || 0,
            };
        });
        return {
            sessions: Object.keys(SessionManager.sessions).sort(),
            pending: Object.keys(SessionManager.pendingConnections || {}).sort(),
            tabs: [...document.querySelectorAll('#sessionTabs > .session-tab')]
                .map(tab => tab.id.replace(/^tab-/, '')).sort(),
            terminals: Object.keys(TerminalManager.terminals).sort(),
            terminalOwners:
                Object.keys(TerminalManager.sessionTerminals).sort(),
            xterms,
            active: SessionManager.getActiveSession(),
            layout: SessionManager.layout,
            variant: SessionManager.layoutVariant,
            paneAssignments: SessionManager.paneAssignments.slice(),
            sessionsById: Object.fromEntries(expectedIds.map(id => {
                const session = SessionManager.getSession(id);
                return [id, {
                    connected: session?.connected,
                    latencyMs: session?.latencyMs ?? null,
                    chipSecondary: document.querySelector(
                        `#tab-${id} .tab-user-name`)?.textContent.trim() || '',
                }];
            })),
            touchShell: TerminalManager.isTouchShell(),
            statusLatency: document.getElementById('statusBarLatency')
                ?.textContent.trim() || '',
        };
    }, SEED_SESSION_IDS);

    requireSeedInvariant(
        JSON.stringify(after.sessions) === JSON.stringify(SEED_SESSION_IDS)
            && after.pending.length === 0
            && JSON.stringify(after.tabs) === JSON.stringify(SEED_SESSION_IDS),
        'production seed must create exactly s1, s2 and s3',
        after
    );
    requireSeedInvariant(
        after.active === 's1',
        's1 must be the active session',
        after.active
    );
    requireSeedInvariant(
        after.layout === layout && after.variant === variant,
        'rendered layout and variant must equal the requested state',
        { requested: { layout, variant },
            actual: { layout: after.layout, variant: after.variant } }
    );
    requireSeedInvariant(
        JSON.stringify(after.terminals) === JSON.stringify(SEED_SESSION_IDS)
            && JSON.stringify(after.terminalOwners)
                === JSON.stringify(SEED_SESSION_IDS)
            && SEED_SESSION_IDS.every(id =>
                after.xterms[id].registered
                && after.xterms[id].real
                && after.xterms[id].ready
                && after.xterms[id].elementConnected
                && after.xterms[id].screenCount === 1
                && after.xterms[id].keys.length === 1
                && after.xterms[id].keys[0] === id
            ),
        'each session must own exactly one ready real xterm',
        { terminals: after.terminals,
            terminalOwners: after.terminalOwners, xterms: after.xterms }
    );
    requireSeedInvariant(
        after.sessionsById.s1.connected === true
            && after.sessionsById.s1.latencyMs === 34
            && after.sessionsById.s2.connected === true
            && after.sessionsById.s2.latencyMs === 52
            && after.sessionsById.s3.connected === false
            && after.sessionsById.s3.latencyMs === null
            && !after.sessionsById.s3.chipSecondary.includes('ms')
            && after.statusLatency === '34 ms',
        'production status and latency owners must render 34/52/disconnected',
        { sessions: after.sessionsById,
            statusLatency: after.statusLatency }
    );
    requireSeedInvariant(
        after.touchShell
            ? after.sessionsById.s1.chipSecondary === 'root'
                && after.sessionsById.s2.chipSecondary === 'root'
            : after.sessionsById.s1.chipSecondary === 'root · 34 ms'
                && after.sessionsById.s2.chipSecondary === 'root · 52 ms',
        'chip latency rendering must follow the production device policy',
        { touchShell: after.touchShell, sessions: after.sessionsById }
    );
}

const VP = {
    desktop: [1440, 900, false],
    ipadPortrait: [834, 1194, true],
    ipadLandscape: [1194, 834, true],
    phone390: [390, 844, true],
    phone359: [359, 780, true],
    phoneLandscape: [926, 428, true],
};

async function shell(name, vpKey, fn, {
    layout = 1, variant = 'default', theme = 'glass', init = null,
    useTmux = false, scrollLines = 0,
} = {}) {
    const [w, h, touch] = VP[vpKey];
    const { ctx, page, errors } = await open(w, h, { touch, theme, init });
    await seed(page, { layout, variant, useTmux, scrollLines });
    if (fn) await fn(page, name);
    await snap(page, errors, name);
    await ctx.close();
}

async function requireVisible(page, selector, label) {
    const result = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, why: 'absent' };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
            ok: cs.display !== 'none' && cs.visibility !== 'hidden'
                && r.width > 0 && r.height > 0,
            why: `${cs.display}, ${Math.round(r.width)}x${Math.round(r.height)}`,
        };
    }, selector);
    if (!result.ok) throw new Error(`${label} did not open: ${result.why}`);
}

async function trustedAction(page, selector, shotName, action) {
    const locator = page.locator(selector);
    let count = 0;
    let visible = false;
    let enabled = false;
    try {
        count = await locator.count();
        if (count === 1) {
            visible = await locator.isVisible();
            enabled = await locator.isEnabled();
        }
    } catch (error) {
        problems.push(`${shotName}: ${selector} precondition failed: ${error}`);
        return false;
    }
    if (count !== 1 || !visible || !enabled) {
        problems.push(`${shotName}: ${selector} is not one visible enabled control: `
            + `count=${count}, visible=${visible}, enabled=${enabled}`);
        return false;
    }
    try {
        await locator[action]();
        return true;
    } catch (error) {
        problems.push(`${shotName}: trusted ${action} on ${selector} failed: ${error}`);
        return false;
    }
}

const trustedTap = (page, selector, shotName) =>
    trustedAction(page, selector, shotName, 'tap');
const trustedClick = (page, selector, shotName) =>
    trustedAction(page, selector, shotName, 'click');

async function waitForVisibleState(page, selector, shotName) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count !== 1) {
        problems.push(`${shotName}: ${selector} visible-state owner count=${count}`);
        return false;
    }
    try {
        await locator.waitFor({ state: 'visible', timeout: 2000 });
        return true;
    } catch (error) {
        problems.push(`${shotName}: ${selector} did not reach visible state: ${error}`);
        return false;
    }
}

/*
 * Select-then-open, by two trusted taps at DISTINCT points inside the ONE chip.
 *
 * Production deliberately ignores a double-tap burst: the chip's click handler
 * returns early on `e.detail > 1` (session-manager.js:496). Two taps at the same
 * coordinate are delivered as detail 1 then detail 2, so the second one is
 * correctly discarded and the sheet never opens. Distinct points inside the same
 * chip are two separate activations (detail 1 twice), which is what a real finger
 * produces. No artificial delay, no forced click, no product change.
 *
 * ONE-TAP CONTRACT (owner ruling, defect 5) -- this SUPERSEDES
 * amendment line 55.
 *
 * Line 55 says "chạm lại hoặc nhấn giữ mới mở action sheet" (a re-tap or
 * long-press opens the action sheet), and this helper used to fail the gate when a
 * single tap opened it. The owner has since ruled the opposite: one tap on a
 * disconnected chip must BOTH select it as the lifecycle target and open that
 * connection's action menu, because the only useful next step after selecting a
 * dead connection is choosing one of its actions. Owner instruction outranks the
 * mockup/amendment constant, so the assertion is inverted rather than deleted.
 *
 * Everything line 55 protects ALONGSIDE that ordering is still asserted, and is
 * what makes this non-vacuous: the tap must select s3, the sheet must actually
 * paint, and it must not focus the composer, raise the keyboard, auto-connect,
 * evict a pane or move the active session (checked by the caller and by
 * tests/browser/composer_ownership.mjs).
 */
async function openLifecycleByTab(page, shotName) {
    const chip = page.locator('#tab-s3');
    let box = null;
    try {
        if (await chip.count() !== 1) {
            problems.push(`${shotName}: #tab-s3 is not exactly one chip`);
            return false;
        }
        box = await chip.boundingBox();
    } catch (error) {
        problems.push(`${shotName}: #tab-s3 precondition failed: ${error}`);
        return false;
    }
    if (!box || box.width < 24 || box.height < 24) {
        problems.push(`${shotName}: #tab-s3 has no tappable box: `
            + JSON.stringify(box));
        return false;
    }
    const tapAt = fraction => page.touchscreen.tap(
        Math.round(box.x + box.width * fraction),
        Math.round(box.y + box.height / 2));

    try {
        await tapAt(0.3);
    } catch (error) {
        problems.push(`${shotName}: first trusted tap on #tab-s3 failed: ${error}`);
        return false;
    }
    try {
        await page.waitForFunction(() =>
            SessionManager.lifecycleActionTargetId === 's3', null,
        { timeout: 2000 });
    } catch (error) {
        problems.push(`${shotName}: #tab-s3 did not become lifecycle target: ${error}`);
        return false;
    }
    // Non-self-satisfying proof: selection happened and the sheet is still shut.
    const afterFirstTap = await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        const rect = sheet?.getBoundingClientRect();
        return {
            target: SessionManager.lifecycleActionTargetId,
            hidden: sheet?.hidden,
            painted: !!rect && rect.width > 0 && rect.height > 0,
        };
    });
    if (afterFirstTap.target !== 's3') {
        problems.push(`${shotName}: first tap did not select s3: `
            + JSON.stringify(afterFirstTap));
        return false;
    }
    // One tap must have opened AND painted the sheet (owner ruling, defect 5).
    // A still-hidden or zero-box sheet is now the failure, not the pass.
    if (afterFirstTap.hidden !== false || !afterFirstTap.painted) {
        problems.push(`${shotName}: PRODUCT DEFECT: one tap did not open the `
            + `lifecycle sheet; the owner's one-gesture contract (2026-08-09) `
            + `requires select + open in the same tap: `
            + JSON.stringify(afterFirstTap));
        return false;
    }
    // Selecting a connection must still never summon the keyboard or steal focus
    // into a text box -- the half of amendment line 55 that the ruling preserves.
    const focusAfterTap = await page.evaluate(() => ({
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        activeIsInput: document.activeElement?.id === 'mobileInput',
    }));
    if (focusAfterTap.keyboardOpen || focusAfterTap.activeIsInput) {
        problems.push(`${shotName}: PRODUCT DEFECT: selecting a session focused `
            + `the composer or opened the keyboard: `
            + JSON.stringify(focusAfterTap));
        return false;
    }
    return true;
}

/*
 * Retained for the surfaces that still reach the sheet by a second activation
 * (the connected-chip re-tap and long-press paths). Kept separate so the one-tap
 * contract above cannot silently absorb a regression in those routes.
 */
async function openLifecycleByRetap(page, shotName) {
    const chip = page.locator('#tab-s3');
    let box = null;
    try {
        if (await chip.count() !== 1) {
            problems.push(`${shotName}: #tab-s3 is not exactly one chip`);
            return false;
        }
        box = await chip.boundingBox();
    } catch (error) {
        problems.push(`${shotName}: #tab-s3 precondition failed: ${error}`);
        return false;
    }
    if (!box || box.width < 24 || box.height < 24) {
        problems.push(`${shotName}: #tab-s3 has no tappable box: `
            + JSON.stringify(box));
        return false;
    }
    const tapAt = fraction => page.touchscreen.tap(
        Math.round(box.x + box.width * fraction),
        Math.round(box.y + box.height / 2));
    try {
        await tapAt(0.3);
    } catch (error) {
        problems.push(`${shotName}: first trusted tap on #tab-s3 failed: ${error}`);
        return false;
    }

    try {
        await tapAt(0.75);
    } catch (error) {
        problems.push(`${shotName}: second trusted tap on #tab-s3 failed: ${error}`);
        return false;
    }
    return waitForVisibleState(page, '#sessionActionsSheet', shotName);
}

async function openTouchMenu(page, shotName) {
    if (!await trustedTap(page, '#mobileMoreBtn', shotName)) return false;
    return waitForVisibleState(page, '#mobileMoreSheet', shotName);
}

async function openKeypad(page, shotName) {
    if (!await trustedTap(page, '#mobileKeypadBtn', shotName)) return false;
    return waitForVisibleState(page, '#mobileKeypad', shotName);
}

/*
 * Keypad page 2 (mockup line 49 / line 198: two pages of eight keys). Reached by
 * the production "Next" key, which is the only user route; showKeypadPage is its
 * internal implementation and is deliberately not called here. Page 1 must be the
 * live page first, or "advanced to page 2" would be unfalsifiable.
 */
async function openKeypadPage2(page, shotName) {
    if (!await openKeypad(page, shotName)) return false;
    const before = await page.evaluate(() => {
        const pages = document.getElementById('mobileKeypadPages');
        return {
            scrollLeft: Math.round(pages.scrollLeft),
            label: document.getElementById('keypadPageLabel')?.textContent.trim() || '',
            grids: document.querySelectorAll('.mobile-keypad-grid').length,
            keys: document.querySelectorAll('.keypad-key').length,
        };
    });
    if (before.scrollLeft !== 0 || before.grids !== 2 || before.keys !== 16) {
        problems.push(`${shotName}: keypad did not open on page 1 with 2x8 keys: `
            + JSON.stringify(before));
        return false;
    }
    if (!await trustedTap(page, '[data-keypad-page="2"]', shotName)) return false;
    try {
        await page.waitForFunction(() => {
            const pages = document.getElementById('mobileKeypadPages');
            return pages.clientWidth > 0
                && Math.round(pages.scrollLeft) >= Math.round(pages.clientWidth) - 2;
        }, null, { timeout: 2000 });
    } catch (error) {
        problems.push(`${shotName}: keypad did not advance to page 2: ${error}`);
        return false;
    }
    /*
     * The dot track is repainted by the keypad's own `scroll` listener, which is
     * passive and therefore runs a frame or two AFTER scrollLeft lands. Measured:
     * scrollLeft and the label are already correct at t+0 while the active dot is
     * still index 0, and it becomes index 1 by t+120ms. Waiting for production's
     * own repaint is the correct measurement point -- reading immediately asserted
     * a state the product had not finished publishing.
     */
    try {
        await page.waitForFunction(() =>
            [...document.querySelectorAll('.keypad-dot')]
                .findIndex(dot => dot.classList.contains('is-active')) === 1,
        null, { timeout: 2000 });
    } catch (error) {
        problems.push(`${shotName}: keypad dot track never marked page 2: ${error}`);
        return false;
    }
    const after = await page.evaluate(() => ({
        label: document.getElementById('keypadPageLabel')?.textContent.trim() || '',
        activeDot: [...document.querySelectorAll('.keypad-dot')]
            .findIndex(dot => dot.classList.contains('is-active')),
        previousVisible: !!document.querySelector('[data-keypad-page="1"]'),
        inputCount: document.querySelectorAll('#mobileInput').length,
    }));
    if (!after.label.includes('2') || after.activeDot !== 1
        || !after.previousVisible || after.inputCount !== 1) {
        problems.push(`${shotName}: page 2 state is wrong: ${JSON.stringify(after)}`);
        return false;
    }
    return true;
}

/*
 * Exit-scroll ON (mockup lines 336-337, 423). The state owner is the real xterm's
 * own scroll event -> TerminalManager.syncTerminalScrollState -> setScrollState ->
 * sshdeck:terminal-scroll-state -> app.js renderExitScrollState. So this scrolls
 * the terminal with a trusted wheel over the live xterm viewport and waits for
 * production to publish the state. setScrollState is never called directly: doing
 * so would photograph a state the product never entered.
 */
async function openExitScroll(page, shotName) {
    const rest = await page.evaluate(() => {
        const btn = document.getElementById('exitScrollBtn');
        return {
            hidden: btn?.hidden,
            scrolled: TerminalManager.isSessionScrolled('s1'),
            useTmux: SessionManager.getSession('s1')?.useTmux === true,
            active: SessionManager.getActiveSession(),
        };
    });
    if (rest.hidden !== true || rest.scrolled !== false
        || rest.useTmux !== true || rest.active !== 's1') {
        problems.push(`${shotName}: Exit-scroll rest state is not usable as a `
            + `baseline: ${JSON.stringify(rest)}`);
        return false;
    }
    const viewport = page.locator('#terminal-s1 .xterm-viewport');
    let box = null;
    try {
        if (await viewport.count() !== 1) {
            problems.push(`${shotName}: expected exactly one live xterm viewport`);
            return false;
        }
        box = await viewport.boundingBox();
    } catch (error) {
        problems.push(`${shotName}: xterm viewport precondition failed: ${error}`);
        return false;
    }
    if (!box || box.height < 40) {
        problems.push(`${shotName}: xterm viewport has no scrollable box: `
            + JSON.stringify(box));
        return false;
    }
    await page.mouse.move(
        Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    for (let attempt = 0; attempt < 6; attempt++) {
        await page.mouse.wheel(0, -240);
        const scrolled = await page.evaluate(() =>
            TerminalManager.isSessionScrolled('s1'));
        if (scrolled) break;
    }
    try {
        await page.waitForFunction(() =>
            TerminalManager.isSessionScrolled('s1') === true
            && document.getElementById('exitScrollBtn').hidden === false,
        null, { timeout: 2000 });
    } catch (error) {
        problems.push(`${shotName}: trusted wheel did not reach the production `
            + `scroll state: ${error}`);
        return false;
    }
    const open = await page.evaluate(() => {
        const btn = document.getElementById('exitScrollBtn');
        const send = document.getElementById('mobileSendBtn');
        const label = btn.querySelector('.btn-label');
        const rect = btn.getBoundingClientRect();
        const labelRange = document.createRange();
        labelRange.selectNodeContents(label);
        const hit = document.elementFromPoint(
            Math.round(rect.left + rect.width / 2),
            Math.round(rect.top + rect.height / 2));
        return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            ariaHidden: btn.getAttribute('aria-hidden'),
            beforeSend: !!(btn.compareDocumentPosition(send)
                & Node.DOCUMENT_POSITION_FOLLOWING),
            labelVisible: getComputedStyle(label).display !== 'none',
            labelLines: labelRange.getClientRects().length,
            ownsHit: !!hit && (hit === btn || btn.contains(hit)),
            landscape: window.matchMedia('(orientation: landscape)').matches,
            draft: document.getElementById('mobileInput').value,
        };
    });
    const labelExpected = open.landscape;
    if (open.height < 44 || open.ariaHidden !== 'false' || !open.beforeSend
        || !open.ownsHit || open.labelVisible !== labelExpected
        || (!labelExpected && open.width !== 44)
        || (labelExpected && open.labelLines !== 1)) {
        problems.push(`${shotName}: revealed Exit-scroll violates the tier `
            + `contract: ${JSON.stringify(open)}`);
        return false;
    }
    return true;
}

async function openNotes(page, shotName) {
    if (!await trustedTap(page, '#notepadOpenBtn', shotName)) return false;
    return waitForVisibleState(page, '#notepadPanel', shotName);
}

async function expectTouchBroadcastState(page, shotName) {
    const state = await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');
        const toggleRect = toggle?.getBoundingClientRect();
        const toggleStyle = toggle ? getComputedStyle(toggle) : null;
        const target = document.getElementById('composerTarget');
        const sendLabel = document.querySelector('#mobileSendBtn .btn-label');
        const targetRect = target?.getBoundingClientRect();
        return {
            inputCount: document.querySelectorAll('#mobileInput').length,
            composerCount: document.querySelectorAll('.mobile-composer').length,
            toggleCount: document.querySelectorAll('#broadcastToggleBtn').length,
            toggleVisible: !!toggle && toggleStyle?.display !== 'none'
                && toggleStyle?.visibility !== 'hidden'
                && toggleRect.width > 0 && toggleRect.height > 0,
            toggleEnabled: !!toggle && !toggle.disabled,
            toggleAria: toggle?.getAttribute('aria-pressed') || '',
            toggleWidth: toggleRect ? Math.round(toggleRect.width) : 0,
            toggleHeight: toggleRect ? Math.round(toggleRect.height) : 0,
            sameInput: input === window.__acceptanceTouchBroadcast?.input,
            draft: input?.value || '',
            selectionStart: input?.selectionStart ?? null,
            selectionEnd: input?.selectionEnd ?? null,
            sameActive: document.activeElement
                === window.__acceptanceTouchBroadcast?.active,
            originalDraft: window.__acceptanceTouchBroadcast?.draft || '',
            originalSelectionStart:
                window.__acceptanceTouchBroadcast?.selectionStart ?? null,
            originalSelectionEnd:
                window.__acceptanceTouchBroadcast?.selectionEnd ?? null,
            broadcastOpen: window.BroadcastInput?.open === true,
            targetVisible: !!target && !target.hidden
                && getComputedStyle(target).display !== 'none'
                && targetRect.width > 0 && targetRect.height > 0,
            targetText: target?.querySelector('.composer-target-label')
                ?.textContent.trim() || '',
            sendLabelDisplay: sendLabel
                ? getComputedStyle(sendLabel).display : 'absent',
            keyboardOpen: document.body.classList.contains('keyboard-open'),
            inputs: window.__acceptanceTouchBroadcastInputs || [],
            preToggle: {
                activeIsInput:
                    window.__acceptanceTouchBroadcast?.activeIsInput ?? true,
                toggleCount:
                    window.__acceptanceTouchBroadcast?.toggleCount ?? 0,
                toggleVisible:
                    window.__acceptanceTouchBroadcast?.toggleVisible ?? false,
                toggleEnabled:
                    window.__acceptanceTouchBroadcast?.toggleEnabled ?? false,
                toggleAria:
                    window.__acceptanceTouchBroadcast?.toggleAria || '',
                toggleWidth:
                    window.__acceptanceTouchBroadcast?.toggleWidth ?? 0,
                toggleHeight:
                    window.__acceptanceTouchBroadcast?.toggleHeight ?? 0,
            },
        };
    });
    const checks = [
        ['pre-toggle active element is not #mobileInput',
            !state.preToggle.activeIsInput],
        ['pre-toggle has one #broadcastToggleBtn',
            state.preToggle.toggleCount === 1],
        ['pre-toggle Broadcast button visible', state.preToggle.toggleVisible],
        ['pre-toggle Broadcast button enabled', state.preToggle.toggleEnabled],
        ['pre-toggle Broadcast button width >= 44px',
            state.preToggle.toggleWidth >= 44],
        ['pre-toggle Broadcast button height >= 44px',
            state.preToggle.toggleHeight >= 44],
        ['pre-toggle Broadcast button aria-pressed is false',
            state.preToggle.toggleAria === 'false'],
        ['one #mobileInput', state.inputCount === 1],
        ['one .mobile-composer', state.composerCount === 1],
        ['one #broadcastToggleBtn', state.toggleCount === 1],
        ['Broadcast button visible', state.toggleVisible],
        ['Broadcast button enabled', state.toggleEnabled],
        ['Broadcast button width >= 44px', state.toggleWidth >= 44],
        ['Broadcast button height >= 44px', state.toggleHeight >= 44],
        ['Broadcast button aria-pressed is true', state.toggleAria === 'true'],
        ['same input DOM node', state.sameInput],
        ['Broadcast open', state.broadcastOpen],
        ['target visible', state.targetVisible],
        ['target is All 2', state.targetText === 'All 2'],
        ['draft preserved', state.draft === state.originalDraft],
        ['caret start preserved',
            state.selectionStart === state.originalSelectionStart],
        ['caret end preserved', state.selectionEnd === state.originalSelectionEnd],
        ['focus preserved', state.sameActive],
        ['Send remains icon-only', state.sendLabelDisplay === 'none'],
        ['keyboard stays closed', !state.keyboardOpen],
        /*
          * REVISED (Phase 2). The composer mirrors the active
          * session's input line, so opening Broadcast RETRACTS what it put
          * there (DELs) before the box becomes the all-local fan-out draft.
          * The guard therefore forbids the two things that would be wrong --
          * running a line, or sending the draft's text again -- rather than
          * forbidding every byte.
          */
         ['the toggle only retracts: no CR, no text',
             state.inputs.every(item =>
                 /^\x7f*$/.test(item?.payload?.data ?? item?.data ?? ''))],
    ];
    checks.filter(([, ok]) => !ok).forEach(([label]) =>
        problems.push(`${shotName}: touch Broadcast guard failed: ${label}`));
}

const openTouchBroadcast = async (page, shotName) => {
    const preToggle = await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');
        const toggleRect = toggle?.getBoundingClientRect();
        const toggleStyle = toggle ? getComputedStyle(toggle) : null;
        input.value = 'uptime';
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.__acceptanceTouchBroadcast = {
            input,
            draft: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            active: document.activeElement,
            activeIsInput: document.activeElement === input,
            toggleCount: document.querySelectorAll('#broadcastToggleBtn').length,
            toggleVisible: !!toggle && toggleStyle?.display !== 'none'
                && toggleStyle?.visibility !== 'hidden'
                && toggleRect.width > 0 && toggleRect.height > 0,
            toggleEnabled: !!toggle && !toggle.disabled,
            toggleAria: toggle?.getAttribute('aria-pressed') || '',
            toggleWidth: toggleRect ? Math.round(toggleRect.width) : 0,
            toggleHeight: toggleRect ? Math.round(toggleRect.height) : 0,
        };
        window.__acceptanceTouchBroadcastInputs = [];
        const emit = window.socket.emit.bind(window.socket);
        window.socket.emit = (event, payload, acknowledgement) => {
            if (event === 'ssh_input') {
                window.__acceptanceTouchBroadcastInputs.push({ event, payload });
            }
            return emit(event, payload, acknowledgement);
        };
        return {
            count: window.__acceptanceTouchBroadcast.toggleCount,
            visible: window.__acceptanceTouchBroadcast.toggleVisible,
            enabled: window.__acceptanceTouchBroadcast.toggleEnabled,
        };
    });
    if (preToggle.count === 1 && preToggle.visible && preToggle.enabled) {
        try {
            await page.locator('#broadcastToggleBtn').tap();
        } catch (error) {
            problems.push(`${shotName}: trusted Broadcast tap failed: ${error}`);
        }
    } else {
        problems.push(`${shotName}: trusted Broadcast tap skipped: `
            + `count=${preToggle.count}, visible=${preToggle.visible}, `
            + `enabled=${preToggle.enabled}`);
    }
    await page.waitForTimeout(80);
    await expectTouchBroadcastState(page, shotName);
};

// ── Required shell states ────────────────────────────────────────────────────
await shell('01-desktop-normal', 'desktop');
await shell('02-desktop-split4', 'desktop', null, { layout: 4 });
await shell('03-desktop-broadcast', 'desktop', async (page, shotName) => {
    if (await trustedClick(page, '#broadcastToggleBtn', shotName)) {
        await waitForVisibleState(page, '#sessionBar', shotName);
    }
});
await shell('04-ipad-portrait', 'ipadPortrait', null, { layout: 2 });
await shell('04a-ipad-portrait-broadcast-on',
    'ipadPortrait', openTouchBroadcast, { layout: 2 });
await shell('05-ipad-landscape', 'ipadLandscape', null, { layout: 2 });
await shell('06-phone390-portrait', 'phone390');
await shell('06a-phone390-broadcast-on', 'phone390', openTouchBroadcast);
await shell('07-phone359-portrait', 'phone359');
await shell('08-phone-landscape', 'phoneLandscape');
await shell('09-phone390-keypad-open', 'phone390', openKeypad);
await shell('09a-phone390-keypad-page2', 'phone390', openKeypadPage2);
await shell('09b-ipad-portrait-keypad-open', 'ipadPortrait', openKeypad,
    { layout: 2 });
await shell('09c-phone-landscape-keypad-open', 'phoneLandscape', openKeypad);
await shell('09d-ipad-portrait-exit-scroll-on', 'ipadPortrait', openExitScroll,
    { layout: 2, useTmux: true, scrollLines: 120 });
await shell('09e-phone390-exit-scroll-on', 'phone390', openExitScroll,
    { useTmux: true, scrollLines: 120 });
await shell('09f-phone-landscape-exit-scroll-on', 'phoneLandscape',
    openExitScroll, { useTmux: true, scrollLines: 120 });
const openLayout = async (page, shotName) => {
    const touchShell = await page.evaluate(() => TerminalManager.isTouchShell());
    const action = touchShell ? trustedTap : trustedClick;
    if (await action(page, '#layoutMenuBtn', shotName)) {
        await waitForVisibleState(page, '#layoutMenu', shotName);
    }
};
await shell('10-layout-menu-desktop', 'desktop', openLayout);
await shell('11-layout-menu-ipad', 'ipadPortrait', openLayout);
await shell('12-layout-menu-phone390', 'phone390', openLayout);
await shell('13-global-menu-desktop', 'desktop', async (page, shotName) => {
    if (await trustedClick(page, '#accountBtnHeader', shotName)) {
        await waitForVisibleState(page, '#accountDropdownHeader', shotName);
    }
});
await shell('14-global-menu-phone390', 'phone390', openTouchMenu);
await shell('14a-global-menu-ipad-portrait', 'ipadPortrait', openTouchMenu,
    { layout: 2 });
await shell('14b-global-menu-phone-landscape', 'phoneLandscape', openTouchMenu);
// Mockup line 184: the disconnected chip is selected, then tapped again to open
// the lifecycle sheet. Two trusted taps, exactly as amendment line 56 specifies.
await shell('15-session-actions-phone390', 'phone390', openLifecycleByTab);
/*
 * The SAME shared sheet on iPad portrait. Production chips use only dot +
 * two-line label on desktop and touch (mockup lines 87-89 / 150-152); both
 * surfaces reach lifecycle actions by selecting then re-activating the chip.
 * This companion shot proves the coarse-pointer geometry while the desktop
 * lifecycle route remains covered by the focused session-actions contract.
 */
await shell('16-session-actions-ipad', 'ipadPortrait', openLifecycleByTab,
    { layout: 2 });
await shell('16a-session-actions-phone-landscape', 'phoneLandscape',
    openLifecycleByTab);
/*
 * The visible Files control owns the production openFileManager route; acceptance
 * reaches it by trusted interaction rather than calling the engine global.
 *
 * Owner correction: it is the SAME control on both shells now.
 * #mobileFilesBtn was a proxy in the removed intermediate menu view -- part of
 * the "two menu entry points" defect -- and touch-action-row.js MOVES the real
 * #fileTransferBtn into the one canonical menu instead. So the only difference
 * between the branches is that touch must open the menu first to reach it.
 */
const openSftp = async (page, shotName) => {
    const touchShell = await page.evaluate(() => TerminalManager.isTouchShell());
    if (touchShell) {
        // Touch must open the one menu first; the control is inside it.
        if (!await openTouchMenu(page, shotName)) return;
        if (!await trustedTap(page, '#fileTransferBtn', shotName)) return;
    } else if (!await trustedClick(page, '#fileTransferBtn', shotName)) {
        // A desktop context has no touch support, so tap() throws there. The
        // control is a header button on this shell and needs no menu.
        return;
    }
    await waitForVisibleState(page, '#sftpPanel', shotName);
};
await shell('17-sftp-panel-desktop', 'desktop', openSftp);
await shell('18-sftp-panel-phone390', 'phone390', openSftp);
/*
 * Notes is OPEN in the default desktop shell, so seed the collapsed state before
 * load through its production storage key, then use the visible canonical control.
 */
await shell('19-notes-desktop', 'desktop', async (page, shotName) => {
    await expectCollapsed(page, '#notepadPanel');
    if (await trustedClick(page, '#notepadOpenBtn', shotName)) {
        await waitForVisibleState(page, '#notepadPanel', shotName);
    }
}, { init: "localStorage.setItem('notepadCollapsed','true')" });
await shell('19a-notes-ipad-portrait', 'ipadPortrait', openNotes, { layout: 2 });
await shell('19b-notes-phone390', 'phone390', openNotes);
await shell('20-command-rail-desktop', 'desktop', async (page, shotName) => {
    // Entry 39: the rail opens from the header Lệnh button; the
    // account-menu Library item was replaced by Transfer Files by ruling.
    if (!await trustedClick(page, '#commandLibraryBtn', shotName)) return;
    await waitForVisibleState(page, '#commandRail', shotName);
});

// ── Auth / admin pages ──────────────────────────────────────────────────────
for (const [name, p, vpKey] of [
    ['21-login-desktop', '/login', 'desktop'],
    ['22-login-phone390', '/login', 'phone390'],
    ['23-register-desktop', '/register', 'desktop'],
    ['24-register-phone390', '/register', 'phone390'],
    ['25-admin-desktop', '/admin', 'desktop'],
    ['26-admin-phone390', '/admin', 'phone390'],
    ['27-change-password-desktop', '/change_password', 'desktop'],
]) {
    const [w, h, touch] = VP[vpKey];
    const { ctx, page, errors } = await open(w, h, { touch, page: p });
    if (p === '/admin') {
        const rowsBeforeReadiness = await page.locator(
            '#adminUsersBody > tr').count();
        if (rowsBeforeReadiness !== 0) {
            problems.push(`${name}: admin readiness was vacuous: expected 0 rows `
                + `before waiting, found ${rowsBeforeReadiness}`);
        }
        await expectAdminUsersReady(page, name);
    }
    await snap(page, errors, name);
    await ctx.close();
}

// ── All 10 themes, index + login ────────────────────────────────────────────

/*
 * Shot 28 -- production favicon assets, rendered by the browser at their real
 * sizes on both a light and a dark surface. Every tile must actually decode: a
 * broken <img> still produces a valid PNG of empty boxes, which would be reviewed
 * as if it were evidence.
 */
{
    const { ctx, page, errors } = await open(1000, 640, {
        page: '/__acceptance/favicon-sheet',
    });
    /*
     * decode() is the real "did the browser rasterise this?" test. naturalWidth is
     * NOT: for an SVG served as image/svg+xml Chromium reports naturalWidth 0 even
     * though the image decodes and paints, because the intrinsic size comes from
     * the viewBox rather than a pixel grid. Measured here: favicon.ico reports
     * 16x16 and apple-touch-icon.png 180x180, while favicon.svg reports 0x0 both
     * immediately and after an awaited decode() that resolves successfully. So the
     * guard asserts decode success plus a painted box, and only demands intrinsic
     * pixels from the raster formats -- which keeps it able to catch a genuinely
     * missing or corrupt asset in every tile.
     */
    const tiles = await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll('img.tile')];
        const decoded = await Promise.all(imgs.map(img =>
            img.decode().then(() => null).catch(error => String(error))));
        return imgs.map((img, index) => {
            const rect = img.getBoundingClientRect();
            return {
                tile: img.dataset.tile,
                raster: !img.currentSrc.includes('.svg'),
                decodeError: decoded[index],
                complete: img.complete,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                renderedWidth: Math.round(rect.width),
                renderedHeight: Math.round(rect.height),
            };
        });
    });
    const expectedTiles = 2 * 5;
    const broken = tiles.filter(tile =>
        tile.decodeError !== null
        || !tile.complete
        || tile.renderedWidth < 8
        || tile.renderedHeight < 8
        || (tile.raster && (tile.naturalWidth === 0 || tile.naturalHeight === 0)));
    if (tiles.length !== expectedTiles) {
        problems.push(`28-favicon-contact-sheet: expected ${expectedTiles} tiles, `
            + `found ${tiles.length}`);
    }
    if (broken.length) {
        problems.push('28-favicon-contact-sheet: tiles failed to decode: '
            + JSON.stringify(broken));
    }
    await snap(page, errors, '28-favicon-contact-sheet');
    await ctx.close();
}

const THEMES = ['glass', 'retro', 'solar', 'paper', 'noir', 'arctic-ice',
    'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];
for (const theme of THEMES) {
    await shell(`30-theme-${theme}-index`, 'desktop', null, { layout: 2, theme });
    const { ctx, page, errors } = await open(1440, 900, { page: '/login', theme });
    await snap(page, errors, `31-theme-${theme}-login`);
    await ctx.close();
}

await browser.close();
server.close();

const withErrors = shots.filter(s => s.errors.length);
console.log(`\n${shots.length} screenshots in ${OUT}`);
console.log(`page errors: ${withErrors.length}`);
withErrors.forEach(s => console.log(`  ${s.name}: ${s.errors[0]}`));

/*
 * Distinctness gate.
 *
 * The first run of this harness shipped four PNGs that were byte-identical to
 * the plain shell: three surfaces never opened (wrong opener name) and one was
 * already open at boot, so "photographed" and "photographed in the required
 * state" looked the same from the outside. A screenshot that silently shows the
 * wrong state is worse than a missing one, because it gets reviewed as if it
 * were evidence. So identical renders are now a hard failure.
 *
 * One pair is identical by definition and is declared, not tolerated silently:
 * 21-login-desktop IS /login at 1440x900 on the default theme, and glass IS the
 * default theme, so 31-theme-glass-login is the same render. Every other
 * collision means a state did not open.
 */
const EXPECTED_IDENTICAL = [['21-login-desktop', '31-theme-glass-login']];
const digest = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const byHash = new Map();
for (const s of shots) {
    const h = digest(s.file);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(s.name);
}
const collisions = [...byHash.values()]
    .filter(names => names.length > 1)
    .filter(names => !EXPECTED_IDENTICAL.some(pair =>
        pair.length === names.length && pair.every(n => names.includes(n))));
/*
 * A declaration PERMITS a collision; it does not require one, so an uncollided
 * declaration is not a failure. But the count must describe what was actually
 * observed: printing "1 declared duplicate pair" when the pair did not collide
 * reports a fact the run never checked.
 *
 * These two shots are the same URL, viewport and theme, yet collide only
 * sometimes. Measured cause: 47 differing pixels at the four rounded corners of
 * the focused #username ring (x 515-520 / 919-924, y 367-376 / 407-416), max
 * channel delta 11 -- antialiasing of a blurred box-shadow, which is not
 * bit-reproducible. That is a renderer artifact, not a UI difference, so it is
 * reported rather than either failed or silently absorbed. (The much larger
 * native-caret nondeterminism at the same input IS fixed, in open().)
 */
const declarationsObserved = EXPECTED_IDENTICAL.filter(pair => {
    const hashes = new Set(pair.map(name => {
        const shot = shots.find(s => s.name === name);
        return shot ? digest(shot.file) : `missing:${name}`;
    }));
    return hashes.size === 1;
});
if (collisions.length) {
    console.log('\nFAIL  identical renders (a required state did not open):');
    collisions.forEach(names => console.log(`  ${names.join(' == ')}`));
    process.exitCode = 1;
} else {
    console.log(`distinctness: OK (${byHash.size} distinct renders,`
        + ` ${declarationsObserved.length} of ${EXPECTED_IDENTICAL.length}`
        + ' declared duplicate pair(s) actually collided this run)');
}

if (problems.length) {
    console.log('\nFAIL  invalid acceptance states:');
    problems.forEach(problem => console.log(`  ${problem}`));
    process.exitCode = 1;
} else {
    console.log('acceptance diagnostics: OK');
}

/*
 * ── Per-shot audit report ───────────────────────────────────────────────────
 * Written to a file as well as summarised here: the full table is long, and a
 * truncated table read as if it were complete is exactly the failure mode this
 * work keeps running into.
 */
{
    const W = [38, 44, 20, 26, 12, 14];
    const pad = (s, n) => String(s).padEnd(n);
    const lines = [[
        pad('SHOT', W[0]), pad('PROPERTY', W[1]), pad('MOCKUP', W[2]),
        pad('PRODUCT', W[3]), pad('DELTA', W[4]), pad('VERDICT', W[5]),
    ].join(' '), '-'.repeat(W.reduce((a, b) => a + b + 1, 0))];
    for (const r of shotRows) {
        lines.push([
            pad(r.shot, W[0]), pad(r.property, W[1]), pad(r.mockup, W[2]),
            pad(r.product, W[3]), pad(r.delta, W[4]), pad(r.verdict, W[5]),
        ].join(' ') + (r.ref ? `  # ${r.ref}` : ''));
    }
    const fails = shotRows.filter(r => r.verdict === 'FAIL');
    const ruled = shotRows.filter(r => r.verdict.startsWith('RULED'));
    const reports = shotRows.filter(r => r.verdict === 'REPORT');
    const passes = shotRows.filter(r => r.verdict === 'PASS');
    lines.push('', `rows: ${shotRows.length}   PASS: ${passes.length}`
        + `   FAIL: ${fails.length}   ruled-intentional: ${ruled.length}`
        + `   spec-silent (reported): ${reports.length}`);
    const out = '/tmp/v5-shots/_audit.txt';
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log(`\nper-shot audit: ${shotRows.length} rows across `
        + `${new Set(shotRows.map(r => r.shot)).size} shots -> ${out}`);
    console.log(`  PASS ${passes.length}   FAIL ${fails.length}`
        + `   ruled-intentional ${ruled.length}   spec-silent ${reports.length}`);
    if (fails.length) {
        console.log('\nAUDIT FAILURES');
        for (const f of fails) {
            console.log(`  ${f.shot} | ${f.property}`);
            console.log(`      mockup=${f.mockup}  product=${f.product}`
                + `  delta=${f.delta}   ref: ${f.ref}`);
        }
        process.exitCode = 1;
    }
}
