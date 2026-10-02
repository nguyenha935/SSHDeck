#!/usr/bin/env node
/*
 * THE FILES BROWSER (#filesBrowser): the Files panel, expanded -- owner ruling
 * 2026-10-02 (docs/DECISIONS.md). One pane, two views: the panel and this
 * browser read and drive SFTPFileManager's 'inline' pane.
 *
 * Sections:
 *   §0  wiring: the Expand control, load order, every glyph a sprite symbol
 *   §1  geometry at five tiers: over the workspace on a desktop and an iPad,
 *       the whole screen on a phone, in short landscape and in a narrow
 *       window; what it covers is inert; expanding and collapsing move no
 *       terminal pixel and send no ssh_resize (a window resize still does);
 *       rows, columns and touch targets per tier; nothing scrolls sideways
 *   §2  sort (folders first, numeric names, kept across a reload), filter,
 *       hidden files (shown by default, kept)
 *   §3  the selection is kept by NAME across a re-list -- in the browser and
 *       in the panel -- and carried between the two views
 *   §4  keyboard: arrows, Shift, Ctrl+A, Space, type-ahead, Enter, Backspace,
 *       Ctrl+F, Ctrl+L; Escape in order (menu, filter, selection, collapse)
 *       and focus goes back to the Expand control
 *   §5  rename and create in place: the emitted payloads carry a request_id,
 *       a refusal is shown on the row, an invalid or taken name never reaches
 *       the server, a success re-lists and keeps the new name selected
 *   §6  delete: the themed dialog, Cancel first, delete_items with the paths,
 *       what failed stays selected, ONE toast
 *   §7  a socket `error` is one toast whether the panel is open or not
 *   §8  history, breadcrumbs, the path field
 *   §9  symlinks: a badge with the target, a link to a folder sorts and opens
 *       as one, a broken link says so
 *   §10 virtualization: 2000 entries are a few dozen rows of DOM; a refresh
 *       keeps the scroll position
 *   §11 phone: a hold starts selection, the bar follows it, a move cancels the
 *       hold, a tap opens, the row's sheet acts on this browser, the ⋮ menu;
 *       Back takes the same steps as Escape
 *   §12 no raw i18n keys; a language change re-renders the browser
 *   §13 another session's chip moves the browser to that host
 *   §14 the header's Files button closes it, and opens the panel again
 *   §15 a narrow window with a mouse: the bar follows the selection
 *   §Z  no page errors
 *
 * Run: node tests/browser/files_browser.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
function atLeast(label, actual, floor, unit = '') {
    if (actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} >= ${floor}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}${unit}\n        actual   ${actual}${unit}`);
    }
}
function atMost(label, actual, ceiling, unit = '') {
    if (actual <= ceiling) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} <= ${ceiling}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected <= ${ceiling}${unit}\n        actual   ${actual}${unit}`);
    }
}
function near(label, actual, expected, tolerance = 1) {
    const ok = Math.abs(actual - expected) <= tolerance;
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (${actual} vs ${expected} ±${tolerance})`);
}
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
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

/*
 * The socket is a recorder; __server runs the app's own handlers. It answers
 * an attach and a resize the way the real server does (chrome_grid_hold.mjs):
 * without that the pane is never attached, never reports its fit, and "no
 * ssh_resize" would hold for a page that cannot send one.
 */
const INIT = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    const geometry = (p) => setTimeout(() => window.__server('tmux_window_geometry',
        { session_id: p.session_id, cols: p.cols, rows: p.rows }), 10);
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop }, connect: noop,
        emit: (ev, payload) => {
            window.__emits.push({ ev, payload });
            if (ev === 'view_attach') {
                setTimeout(() => window.__server('view_attached', { session_id: payload.session_id }), 10);
                geometry(payload);
            }
            if (ev === 'ssh_resize') geometry(payload);
        },
    };
    window.io = () => window.socket;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SPRITE = new Set([...fs.readFileSync(path.join(ROOT, 'static/icons/icons.svg'), 'utf8')
    .matchAll(/<symbol id="icon-([a-z0-9-]+)"/g)].map(m => m[1]));

const S1 = 'aaaa1111-file-4aaa-8aaa-000000000001';
const S2 = 'bbbb2222-file-4bbb-8bbb-000000000002';
const HERE = '/opt/sshdeck';
const snapshot = (session_id, tmux, name) => ({
    snapshot_version: 1, session_id, host: `${name}.example`, port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: tmux, display_name: name,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
});

const FILE = (name, size = 1000, extra = {}) => ({
    name, is_dir: false, size, mode: 0o100644, modified: 1759390000,
    owner: 'deploy', group: 'deploy', ...extra });
const DIR = (name) => ({
    name, is_dir: true, size: 4096, mode: 0o40755, modified: 1759390000,
    owner: 'root', group: 'root' });
const LISTING = [
    DIR('static'), FILE('app.py', 2048), FILE('deploy.sh', 300), FILE('README.md', 900),
    FILE('file10.txt', 10), FILE('file2.txt', 20), DIR('docs'), FILE('.bashrc', 50),
];

const pageErrors = [];
async function openPage(viewport, touch = false) {
    const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
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
    // The toasts a person would see, whichever code path raised them.
    await page.evaluate(() => {
        window.__toasts = [];
        new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(n => {
            if (n.classList?.contains('notification')) window.__toasts.push(n.textContent);
        }))).observe(document.getElementById('notificationContainer'), { childList: true });
        window.__previews = [];
        window.FilePreview.open = (sid, p, name) => window.__previews.push(p);
    });
    return page;
}

// One page per block. A block that throws is one FAIL row and the run goes on.
async function withPage(label, viewport, touch, fn) {
    const page = await openPage(viewport, touch);
    try {
        await fn(page);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${label}: stopped\n        ${String(e.message).split('\n')[0]}`);
    } finally {
        await page.context().close();
    }
}

const fire = (page, ev, payload) => page.evaluate(
    ([e, p]) => window.__server(e, p), [ev, payload ?? null]);
const clear = (page) => page.evaluate(() => { window.__emits.length = 0; });
const emitted = (page, ev) => page.evaluate((e) => window.__emits
    .filter(x => x.ev === e).map(x => x.payload), ev);
const toasts = (page) => page.evaluate(() => window.__toasts.slice());

async function openFiles(page, files = LISTING) {
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
    await fire(page, 'connect');
    await page.waitForTimeout(1200);          // attached, its fit reported
    await page.evaluate(() => window.openFileManager());
    await page.waitForTimeout(150);
    await seed(page, files);
}
// A listing as the reply would leave it (no server answers the stand-in).
const seed = (page, files, where = HERE) => page.evaluate(([list, p]) => {
    const fm = window.sftpFileManager;
    const s = fm.panes.inline;
    if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
    s.loading = false;
    s.error = null;
    s.path = p;
    s.pendingPath = p;
    s.files = list;
    fm.updatePaneBadge('inline');
    fm.renderPane('inline');
}, [files, where]);
// The server's reply to the listing the page asked for last.
const reply = (page, files, where, session_id = S1) => fire(page, 'directory_listing',
    { session_id, path: where, files });

async function expand(page) {
    await page.click('#sftpPanelExpand');
    await page.waitForTimeout(100);
}

const rect = (page, selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
             width: r.width, height: r.height };
}, selector);

// The rows as drawn: name, selected, focused -- in view order.
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#fbList .fb-row')]
    .sort((a, b) => a.dataset.i - b.dataset.i)
    .map(row => ({
        name: row.classList.contains('fb-parent') ? '..'
            : row.querySelector('.fb-name')?.textContent ?? (row.querySelector('.fb-edit') ? '<edit>' : '?'),
        sel: row.classList.contains('is-sel'),
        focus: row.classList.contains('is-focus'),
    })));
const names = async (page) => (await rows(page)).map(r => r.name);
const selectedNames = async (page) => (await rows(page)).filter(r => r.sel).map(r => r.name);
// A Playwright selector (page.click / page.tap), not a CSS one.
const rowSel = (name) => `#fbList .fb-row:has(.fb-name:text-is("${name}"))`;
const rowBox = (page, name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('#fbList .fb-row')]
        .find(r => r.querySelector('.fb-name')?.textContent === n);
    const r = row?.getBoundingClientRect();
    return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}, name);
// Every visible button under a selector that is smaller than 44x44.
const underTarget = (page, scope) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(el => { const r = el.getBoundingClientRect();
        return { act: el.dataset.act || el.className, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(b => b.w < 44 || b.h < 44), scope);
const clickRow = (page, name, modifiers = []) => page.click(`${rowSel(name)} .fb-c-size`, { modifiers });
const visible = (page, selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}, selector);

// ── §0 wiring ───────────────────────────────────────────────────────────────
{
    const index = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    check('§0 files-browser.js loads before sftp-file-manager.js (which constructs it)',
        index.indexOf("js/files-browser.js") > 0
            && index.indexOf("js/files-browser.js") < index.indexOf("js/sftp-file-manager.js"), true);
    check('§0 files-browser.css loads after sftp-file-manager.css',
        index.indexOf("css/files-browser.css") > index.indexOf("css/sftp-file-manager.css"), true);
    const source = fs.readFileSync(path.join(ROOT, 'static/js/files-browser.js'), 'utf8');
    // icon('x') / i('x'), and the glyph argument of the two button helpers.
    const glyphs = new Set([
        ...[...source.matchAll(/\b(?:icon|i)\('([a-z0-9-]+)'/g)].map(m => m[1]),
        ...[...source.matchAll(/\b(?:iconButton|labelButton)\('[^']+', '([a-z0-9-]+)'/g)].map(m => m[1]),
    ]);
    atLeast('§0 glyphs named by the browser (the extraction found them)', glyphs.size, 20);
    check('§0 every glyph the browser names is a sprite symbol',
        [...glyphs].filter(name => !SPRITE.has(name)), []);
    check('§0 the Expand glyph is a sprite symbol', SPRITE.has('maximize-2'), true);
}

// ── §1 geometry ─────────────────────────────────────────────────────────────
/*
 * `rows` are floors measured on this build (2026-10-02), not numbers from the
 * design, which names none: they catch a change that takes room from the list.
 * `cells` are the cells a file row shows; the column header is shown only
 * where there is room for a table. A window narrower than 768px takes the
 * phone layout whatever its pointer ([INF-FILES-1]).
 */
const TIERS = [
    { label: 'desktop 1440x900', viewport: { width: 1440, height: 900 }, touch: false, cover: 'workspace',
      rowH: 36, rows: 15, header: true, cells: ['check', 'name', 'size', 'mod', 'perm', 'owner', 'more'] },
    { label: 'iPad 834x1194', viewport: { width: 834, height: 1194 }, touch: true, cover: 'workspace',
      rowH: 46, rows: 16, header: true, cells: ['check', 'name', 'size', 'mod', 'more'] },
    { label: 'phone 390x844', viewport: { width: 390, height: 844 }, touch: true, cover: 'screen',
      rowH: 56, rows: 12, header: false, cells: ['name', 'more'] },
    { label: 'phone landscape 844x390', viewport: { width: 844, height: 390 }, touch: true, cover: 'screen',
      rowH: 44, rows: 6, header: false, cells: ['name', 'size', 'mod', 'more'] },
    { label: 'narrow window 700x900', viewport: { width: 700, height: 900 }, touch: false, cover: 'screen',
      rowH: 56, rows: 13, header: false, cells: ['name', 'more'] },
];
const MANY = Array.from({ length: 60 }, (_, k) => FILE(`log-${String(k).padStart(2, '0')}.txt`, k * 10));
for (const tier of TIERS) {
    await withPage(`§1 ${tier.label}`, tier.viewport, tier.touch, async (page) => {
        const L = `§1 ${tier.label}`;
        await openFiles(page, MANY);
        await page.waitForTimeout(400);
        if (tier.cover === 'screen') {
            // The compact panel lays its head out as grid row 1 (the head is
            // display:contents). Measured on main ac0d423: 54px, 46px in a
            // narrow window. Expand joins Close there and takes 44px from the
            // title, which keeps at least this much (390px: 144, was 188).
            const head = await page.evaluate(() => {
                const pane = document.getElementById('fmInlinePane').getBoundingClientRect();
                const nav = document.querySelector('#fmInlinePane > .fm-pane-nav').getBoundingClientRect();
                const title = document.querySelector('#fmInlinePane > .fm-panel-head > div').getBoundingClientRect();
                const expand = document.getElementById('sftpPanelExpand').getBoundingClientRect();
                const close = document.getElementById('sftpPanelClose').getBoundingClientRect();
                return { row: Math.round(nav.top - pane.top), title: Math.round(title.width),
                    together: Math.round(expand.top) === Math.round(close.top) && expand.right <= close.left + 0.5,
                    inside: close.right <= pane.right + 0.5 };
            });
            check(`${L}: the panel head row is as tall as on main, Expand beside Close`,
                [head.row, head.together, head.inside], [tier.touch ? 54 : 46, true, true]);
            atLeast(`${L}: ...and the title keeps room`, head.title, 90);
        }
        const inertBefore = await page.evaluate(() => document.querySelectorAll('[inert]').length);
        const terminalBefore = await rect(page, '.terminal-area');
        await clear(page);
        await expand(page);
        await page.waitForTimeout(400);
        const fb = await rect(page, '#filesBrowser');
        const target = tier.cover === 'workspace'
            ? await rect(page, '#workspace')
            : { left: 0, top: 0, width: tier.viewport.width, height: tier.viewport.height };
        check(`${L}: covers the ${tier.cover}`,
            [Math.round(fb.left), Math.round(fb.top), Math.round(fb.width), Math.round(fb.height)],
            [Math.round(target.left), Math.round(target.top), Math.round(target.width), Math.round(target.height)]);
        // What is on top at the header's centre: the header over a workspace,
        // the browser on a full screen. An inert element is skipped by hit
        // testing, so the header (inert under a full-screen browser) would
        // read as "below" even when it is painted over it: inert is lifted
        // for the one measurement.
        const top = await page.evaluate(() => {
            const inert = [...document.querySelectorAll('[inert]')];
            inert.forEach(el => el.removeAttribute('inert'));
            const header = document.querySelector('.header').getBoundingClientRect();
            const hit = document.elementFromPoint(header.left + header.width / 2, header.top + header.height / 2);
            inert.forEach(el => el.setAttribute('inert', ''));
            return hit?.closest('#filesBrowser') ? 'browser' : hit?.closest('.header') ? 'header' : String(hit?.className);
        });
        check(`${L}: on top at the header's centre`, top, tier.cover === 'workspace' ? 'header' : 'browser');
        const inert = await page.evaluate(() => ({
            panel: !!document.getElementById('sftpPanel').closest('[inert]'),
            terminal: !!document.querySelector('.terminal-area').closest('[inert]'),
            header: !!document.querySelector('.header').closest('[inert]'),
            browser: !!document.getElementById('filesBrowser').closest('[inert]'),
        }));
        check(`${L}: what it covers is inert, the browser is not`, inert, {
            panel: true, terminal: true, header: tier.cover === 'screen', browser: false });
        const terminalOpen = await rect(page, '.terminal-area');
        check(`${L}: expanding moved no terminal pixel`, terminalOpen, terminalBefore);
        check(`${L}: expanding sent no ssh_resize`, (await emitted(page, 'ssh_resize')).length, 0);

        const rowBox = await rect(page, '#fbList .fb-row');
        near(`${L}: row height`, Math.round(rowBox.height), tier.rowH, 1);
        const list = await rect(page, '#fbList');
        atLeast(`${L}: rows the list shows`, Math.floor(list.height / rowBox.height * 10) / 10, tier.rows);
        const cells = await page.evaluate(() => [...document.querySelectorAll(
            '#fbList .fb-row:not(.fb-parent) > [role="gridcell"]')].slice(0, 7)
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => el.className.replace('fb-c-', '')));
        check(`${L}: the cells a row shows`, cells, tier.cells);
        check(`${L}: the phone's search and ⋮ controls are shown only on a full screen`, [
            await visible(page, '.fb-head [data-act="toggle-filter"]'),
            await visible(page, '.fb-head [data-act="menu"]')],
            [tier.cover === 'screen', tier.cover === 'screen']);
        check(`${L}: the column header is shown`, await visible(page, '.fb-cols'), tier.header);
        const overflow = await page.evaluate(() => {
            const fb = document.getElementById('filesBrowser');
            const list = document.getElementById('fbList');
            return { browser: fb.scrollWidth - fb.clientWidth, list: list.scrollWidth - list.clientWidth,
                     page: document.documentElement.scrollWidth - window.innerWidth };
        });
        check(`${L}: nothing scrolls sideways`, overflow, { browser: 0, list: 0, page: 0 });
        check(`${L}: every visible toolbar button can say what it does`, await page.evaluate(() =>
            [...document.querySelectorAll('#filesBrowser .fb-toolbar button, #filesBrowser .fb-nav button')]
                .filter(b => b.getBoundingClientRect().width > 0 && !b.closest('#fbCrumbs'))
                .filter(b => !b.title || !b.getAttribute('aria-label')).map(b => b.dataset.act)), []);
        if (tier.touch) {
            check(`${L}: every visible control is at least 44x44`, await underTarget(page, '#filesBrowser'), []);
            const list = await rect(page, '#fbList');
            const header = await rect(page, '.fb-cols');
            const buttons = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll(
                '.fb-cols button, .fb-top button')].map(b => b.getBoundingClientRect().bottom)));
            check(`${L}: no control above the list reaches over its first row`,
                Math.round(buttons) <= Math.round(list.top), true);
            if (tier.header) near(`${L}: the header is as tall as its buttons`, Math.round(header.height), 44, 0);
        }

        await clear(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        check(`${L}: Escape collapsed it`, await page.evaluate(() =>
            document.getElementById('filesBrowser').hidden), true);
        check(`${L}: collapsing moved no terminal pixel`, await rect(page, '.terminal-area'), terminalBefore);
        check(`${L}: collapsing sent no ssh_resize`, (await emitted(page, 'ssh_resize')).length, 0);
        check(`${L}: everything it made inert is released`,
            await page.evaluate(() => document.querySelectorAll('[inert]').length), inertBefore);
    });
}
// The floor under "no ssh_resize": the same page DOES report a resize.
await withPage('§1 floor', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    await page.waitForTimeout(400);
    await clear(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(900);
    atLeast('§1 floor: a window resize under the browser does send ssh_resize',
        (await emitted(page, 'ssh_resize')).length, 1);
});

// ── §2 sort, filter, hidden ─────────────────────────────────────────────────
await withPage('§2', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    check('§2 by name: "..", folders first, numbers in numeric order, hidden shown',
        await names(page), ['..', 'docs', 'static', '.bashrc', 'app.py', 'deploy.sh',
            'file2.txt', 'file10.txt', 'README.md']);
    await page.click('.fb-sort[data-key="size"]');
    check('§2 by size: folders still first',
        await names(page), ['..', 'docs', 'static', 'file10.txt', 'file2.txt', '.bashrc',
            'deploy.sh', 'README.md', 'app.py']);
    await page.click('.fb-sort[data-key="size"]');
    check('§2 by size, descending: folders still first',
        await names(page), ['..', 'static', 'docs', 'app.py', 'README.md', 'deploy.sh',
            '.bashrc', 'file2.txt', 'file10.txt']);
    check('§2 the column says how it is sorted', await page.evaluate(() =>
        document.querySelector('.fb-sort[data-key="size"]').getAttribute('aria-sort')), 'descending');

    await page.click('#fbHidden');
    check('§2 hidden files off: .bashrc goes', (await names(page)).includes('.bashrc'), false);
    check('§2 the count says how many are hidden', await page.textContent('#fbCount'), '8 items · 1 hidden');

    await page.keyboard.press('Control+f');
    check('§2 Ctrl+F focuses the filter', await page.evaluate(() => document.activeElement.id), 'fbFilter');
    await page.keyboard.type('FILE');
    check('§2 the filter matches regardless of case, keeps the sort, drops ".."',
        await names(page), ['file2.txt', 'file10.txt']);
    check('§2 the count says how many match', await page.textContent('#fbCount'), '8 items · 1 hidden · 2 match');
    await page.fill('#fbFilter', 'zzz');
    check('§2 nothing matching says so', (await page.textContent('#fbState')).trim(), 'Nothing matches “zzz”');

    // Kept across a reload.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined', null, { timeout: 15000 });
    await openFiles(page);
    await expand(page);
    check('§2 sort and hidden-files survive a reload', await names(page),
        ['..', 'static', 'docs', 'app.py', 'README.md', 'deploy.sh', 'file2.txt', 'file10.txt']);
});

// ── §3 selection kept by name ───────────────────────────────────────────────
await withPage('§3', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    // In the panel: select deploy.sh, then the same folder is re-listed with a
    // file in front of it -- the index now points at another file.
    const index = await page.evaluate(() => window.sftpFileManager.panes.inline.files
        .findIndex(f => f.name === 'deploy.sh'));
    await page.click(`#fmInlineList .fm-file-item[data-index="${index}"] .fm-file-name`);
    await reply(page, [FILE('aaa-new.txt'), ...LISTING], HERE);
    const panelSel = await page.evaluate(() => {
        const s = window.sftpFileManager.panes.inline;
        return [...s.selected].map(i => s.files[i].name);
    });
    check('§3 panel: a re-list keeps the selection on the same file', panelSel, ['deploy.sh']);
    await expand(page);
    check('§3 expanding carries the panel selection', await selectedNames(page), ['deploy.sh']);
    await clickRow(page, 'app.py', ['Control']);
    await reply(page, [FILE('zzz-new.txt'), ...LISTING.filter(f => f.name !== 'README.md')], HERE);
    check('§3 browser: a re-list keeps the selection by name',
        await selectedNames(page), ['app.py', 'deploy.sh']);
    await reply(page, LISTING.filter(f => f.name !== 'app.py'), HERE);
    check('§3 browser: a file that went is dropped from the selection',
        await selectedNames(page), ['deploy.sh']);
    await page.click('[data-act="collapse"]');
    const back = await page.evaluate(() => {
        const s = window.sftpFileManager.panes.inline;
        return [...s.selected].map(i => s.files[i].name);
    });
    check('§3 collapsing hands the selection back to the panel', back, ['deploy.sh']);
});

// ── §4 keyboard ─────────────────────────────────────────────────────────────
await withPage('§4', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    check('§4 the list has focus on expand', await page.evaluate(() => document.activeElement.id), 'fbList');
    await page.keyboard.press('ArrowDown');
    check('§4 ArrowDown: focus and select the next row', await selectedNames(page), ['docs']);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    check('§4 Shift+ArrowDown extends', await selectedNames(page), ['docs', 'static', '.bashrc']);
    await page.keyboard.press('Space');
    check('§4 Space toggles the focused row', await selectedNames(page), ['docs', 'static']);
    await page.keyboard.press('Control+a');
    check('§4 Ctrl+A selects every entry, not ".."', (await selectedNames(page)).length, LISTING.length);
    await page.keyboard.press('r');
    check('§4 type-ahead focuses the next name that starts so',
        (await rows(page)).filter(r => r.focus).map(r => r.name), ['README.md']);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await clear(page);
    await page.keyboard.press('Enter');
    check('§4 Enter on a folder lists it', (await emitted(page, 'list_directory')).map(p => p.remote_path),
        [`${HERE}/docs`]);
    await seed(page, LISTING);
    await clickRow(page, 'app.py');
    await clear(page);
    await page.keyboard.press('Enter');
    check('§4 Enter on a file previews it', await page.evaluate(() => window.__previews), [`${HERE}/app.py`]);
    await page.keyboard.press('Backspace');
    check('§4 Backspace goes up', (await emitted(page, 'list_directory')).map(p => p.remote_path), ['/opt']);
    await reply(page, [DIR('containerd'), DIR('sshdeck'), DIR('zz')], '/opt');
    check('§4 ...and focuses the folder it came out of', (await rows(page)).filter(r => r.focus).map(r => r.name),
        ['sshdeck']);
    await seed(page, LISTING);
    await page.keyboard.press('Control+l');
    check('§4 Ctrl+L edits the path', await page.evaluate(() =>
        [document.activeElement.id, document.activeElement.value]), ['fbPath', HERE]);
    await page.keyboard.press('Escape');
    check('§4 Escape in the path field returns to the list, still expanded',
        await page.evaluate(() => [document.activeElement.id, document.getElementById('filesBrowser').hidden]),
        ['fbList', false]);

    // Escape, in order: a menu, the filter, the selection, then the browser.
    await seed(page, LISTING, '/a/b/c/d/e/f');
    await clickRow(page, 'app.py');
    await page.click('[data-act="crumbs-more"]');
    check('§4 a menu is open', await visible(page, '.fb-menu'), true);
    await page.keyboard.press('Escape');
    const step1 = await page.evaluate(() => ({ menu: !!document.querySelector('.fb-menu'),
        open: !document.getElementById('filesBrowser').hidden }));
    check('§4 Escape 1 closes the menu only', step1, { menu: false, open: true });
    await page.keyboard.press('Control+f');
    await page.keyboard.type('app');
    await page.focus('#fbList');
    await page.keyboard.press('Escape');
    check('§4 Escape 2 clears the filter', await page.inputValue('#fbFilter'), '');
    check('§4 ...and keeps the selection', await selectedNames(page), ['app.py']);
    await page.keyboard.press('Escape');
    check('§4 Escape 3 clears the selection', await selectedNames(page), []);
    await page.keyboard.press('Escape');
    check('§4 Escape 4 collapses, and focus returns to the Expand control',
        await page.evaluate(() => [document.getElementById('filesBrowser').hidden, document.activeElement.id]),
        [true, 'sftpPanelExpand']);
});

// ── §5 rename and create in place ───────────────────────────────────────────
await withPage('§5', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    await clickRow(page, 'deploy.sh');
    await page.keyboard.press('F2');
    await page.waitForTimeout(50);
    const editor = await page.evaluate(() => {
        const input = document.querySelector('#fbList .fb-edit');
        return input && [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input];
    });
    check('§5 F2 edits the name in place, the stem selected', editor, ['deploy.sh', 0, 6, true]);
    await clear(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('..');
    await page.keyboard.press('Enter');
    check('§5 ".." is refused on the row', (await page.textContent('#fbList .fb-edit-error')).trim(),
        'A name cannot contain “/” or be “.” or “..”');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('app.py');
    await page.keyboard.press('Enter');
    check('§5 a taken name is refused on the row', (await page.textContent('#fbList .fb-edit-error')).trim(),
        '“app.py” already exists here');
    check('§5 neither reached the server', (await emitted(page, 'rename_file')).length, 0);

    await page.keyboard.press('Control+a');
    await page.keyboard.type('run.sh');
    await page.keyboard.press('Enter');
    const [rename] = await emitted(page, 'rename_file');
    check('§5 rename_file carries the paths and a request_id',
        rename && [rename.session_id, rename.old_path, rename.new_path, /^fb-/.test(rename.request_id)],
        [S1, `${HERE}/deploy.sh`, `${HERE}/run.sh`, true]);
    await fire(page, 'fm_result', { request_id: rename.request_id, op: 'rename', session_id: S1,
        results: [{ path: `${HERE}/deploy.sh`, ok: false, error: 'Permission denied' }] });
    check('§5 a refusal is shown on the row, the editor stays',
        await page.evaluate(() => [document.querySelector('#fbList .fb-edit-error')?.textContent,
            document.querySelector('#fbList .fb-edit')?.value]), ['Permission denied', 'run.sh']);
    await clear(page);
    await page.keyboard.press('Enter');
    const [again] = await emitted(page, 'rename_file');
    await fire(page, 'fm_result', { request_id: again.request_id, op: 'rename', session_id: S1,
        results: [{ path: `${HERE}/deploy.sh`, ok: true, error: null }] });
    check('§5 a success re-lists', (await emitted(page, 'list_directory')).map(p => p.remote_path), [HERE]);
    check('§5 ...and says so', await page.textContent('#fbLive'), 'Renamed to run.sh');
    await reply(page, LISTING.map(f => f.name === 'deploy.sh' ? { ...f, name: 'run.sh' } : f), HERE);
    check('§5 the new name is selected and focused', (await rows(page)).filter(r => r.sel || r.focus),
        [{ name: 'run.sh', sel: true, focus: true }]);
    check('§5 no request is left waiting', await page.evaluate(() =>
        window.sftpFileManager.browser.pending.size), 0);

    for (const [act, event, name] of [['new-dir', 'create_directory', 'newdir'], ['new-file', 'create_file', 'notes.txt']]) {
        await clear(page);
        await page.click(`.fb-toolbar [data-act="${act}"]`);
        await page.waitForTimeout(50);
        check(`§5 ${act}: a named row at the top, focused`, await page.evaluate(() => {
            const row = document.querySelector('#fbList .fb-draft');
            return [Number(row?.dataset.i), document.activeElement?.classList.contains('fb-edit')];
        }), [1, true]);
        await page.keyboard.type(name);
        await page.keyboard.press('Enter');
        const [payload] = await emitted(page, event);
        check(`§5 ${act}: ${event} with the path and a request_id`,
            payload && [payload.session_id, payload.remote_path, /^fb-/.test(payload.request_id)],
            [S1, `${HERE}/${name}`, true]);
        await fire(page, 'fm_result', { request_id: payload.request_id, op: act, session_id: S1,
            results: [{ path: `${HERE}/${name}`, ok: true, error: null }] });
        check(`§5 ${act}: says so`, await page.textContent('#fbLive'), `Created ${name}`);
        await seed(page, LISTING);
    }
    await page.click('.fb-toolbar [data-act="new-dir"]');
    await page.keyboard.press('Escape');
    check('§5 Escape drops the draft row', await page.evaluate(() =>
        !!document.querySelector('#fbList .fb-draft')), false);
    check('§5 ...and the browser stays open', await page.evaluate(() =>
        document.getElementById('filesBrowser').hidden), false);

    // Escape while the server is still creating: the row goes, the browser
    // stays, and the reply that lands afterwards still shows the folder.
    await page.click('.fb-toolbar [data-act="new-dir"]');
    await page.waitForTimeout(50);
    await page.keyboard.type('late');
    await clear(page);
    await page.keyboard.press('Enter');
    await page.focus('#fbList');
    await page.keyboard.press('Escape');
    check('§5 Escape while the server works: the row goes, the browser stays', await page.evaluate(() => [
        !!document.querySelector('#fbList .fb-draft'), document.getElementById('filesBrowser').hidden]),
        [false, false]);
    const [late] = await emitted(page, 'create_directory');
    await clear(page);
    await fire(page, 'fm_result', { request_id: late.request_id, op: 'new-dir', session_id: S1,
        results: [{ path: `${HERE}/late`, ok: true, error: null }] });
    check('§5 ...and its reply still re-lists', (await emitted(page, 'list_directory')).map(p => p.remote_path), [HERE]);
});

// ── §6 delete ───────────────────────────────────────────────────────────────
await withPage('§6', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    await clickRow(page, 'static');
    await clickRow(page, 'app.py', ['Control']);
    await clear(page);
    await page.click('.fb-toolbar [data-act="delete"]');
    const dialog = await page.evaluate(() => {
        const d = document.querySelector('.fb-dialog');
        return d && {
            title: d.querySelector('.fb-dialog-title').textContent,
            items: [...d.querySelectorAll('.fb-dlg-list li')].map(li => li.textContent.trim()),
            warn: d.querySelector('.fb-dlg-warn').textContent.trim(),
            focus: document.activeElement.dataset.dialog,
            confirm: d.querySelector('[data-dialog="delete"]').textContent.trim(),
        };
    });
    check('§6 the dialog names what goes, warns about folders, focuses Cancel', dialog, {
        title: 'Delete 2 items?', items: ['static', 'app.py'],
        warn: 'Folders are deleted with everything inside. This cannot be undone.',
        focus: 'cancel', confirm: 'Delete 2 items' });
    await page.keyboard.press('Escape');
    check('§6 Escape cancels: no dialog, nothing sent, still expanded', await page.evaluate(() => [
        !!document.querySelector('.fb-dialog'), window.__emits.filter(e => e.ev === 'delete_items').length,
        document.getElementById('filesBrowser').hidden]), [false, 0, false]);
    check('§6 ...and the selection is untouched', await selectedNames(page), ['static', 'app.py']);

    const toastsBefore = (await toasts(page)).length;
    await page.click('.fb-toolbar [data-act="delete"]');
    await page.click('[data-dialog="delete"]');
    const [del] = await emitted(page, 'delete_items');
    check('§6 delete_items carries the paths and a request_id',
        del && [del.session_id, del.paths, /^fb-/.test(del.request_id)],
        [S1, [`${HERE}/static`, `${HERE}/app.py`], true]);
    await fire(page, 'fm_result', { request_id: del.request_id, op: 'delete', session_id: S1, results: [
        { path: `${HERE}/static`, ok: false, error: 'Permission denied' },
        { path: `${HERE}/app.py`, ok: true, error: null }] });
    await reply(page, LISTING.filter(f => f.name !== 'app.py'), HERE);
    const after = (await toasts(page)).slice(toastsBefore);
    check('§6 one toast for the batch', after, ['Deleted 1 · 1 failed: Permission denied']);
    check('§6 what failed stays selected', await selectedNames(page), ['static']);

    await clickRow(page, 'deploy.sh');
    await page.focus('#fbList');
    await page.keyboard.press('Delete');
    check('§6 the Delete key asks too; one file is named, no folder warning', await page.evaluate(() => {
        const d = document.querySelector('.fb-dialog');
        return d && [d.querySelector('.fb-dialog-title').textContent, d.querySelector('.fb-dlg-warn').textContent.trim()];
    }), ['Delete “deploy.sh”?', 'This cannot be undone.']);
    await page.click('[data-dialog="cancel"]');
    // A long batch lists five and counts the rest.
    await seed(page, MANY);
    await page.focus('#fbList');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    check('§6 a long batch lists five and counts the rest', await page.evaluate(() =>
        [...document.querySelectorAll('.fb-dlg-list li')].map(li => li.textContent.trim()).slice(-2)),
        ['log-04.txt', '… and 55 more']);
});

// ── §7 one toast per socket error ───────────────────────────────────────────
await withPage('§7', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    const count = async (fn) => {
        const before = (await toasts(page)).length;
        await fn();
        await fire(page, 'error', { error: 'boom' });
        return (await toasts(page)).length - before;
    };
    check('§7 panel open: one toast', await count(async () => {}), 1);
    check('§7 browser expanded: one toast', await count(() => expand(page)), 1);
    check('§7 panel closed: one toast', await count(() => page.evaluate(() =>
        window.sftpFileManager.closeInline())), 1);
});

// ── §8 history, breadcrumbs, path ───────────────────────────────────────────
await withPage('§8', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    const disabled = () => page.evaluate(() => ['back', 'forward'].map(act =>
        document.querySelector(`#filesBrowser [data-act="${act}"]`).disabled));
    check('§8 no history yet', await disabled(), [true, true]);
    await page.dblclick(`${rowSel('docs')} .fb-c-size`);
    await reply(page, [FILE('guide.md')], `${HERE}/docs`);
    check('§8 into docs: Back on', await disabled(), [false, true]);
    await clear(page);
    await page.click('#filesBrowser [data-act="back"]');
    check('§8 Back lists where it came from', (await emitted(page, 'list_directory')).map(p => p.remote_path), [HERE]);
    await reply(page, LISTING, HERE);
    check('§8 ...and Forward is on (nothing is behind the first folder)', await disabled(), [true, false]);
    await clear(page);
    await page.focus('#fbList');
    await page.keyboard.press('Alt+ArrowRight');
    check('§8 Alt+Right goes forward', (await emitted(page, 'list_directory')).map(p => p.remote_path), [`${HERE}/docs`]);

    await seed(page, LISTING, '/a/b/c/d/e/f');
    check('§8 a deep path shows its root, "…" and the last three', await page.evaluate(() =>
        [...document.querySelectorAll('#fbCrumbs .fb-crumb')].map(c => c.textContent.trim())),
        ['/', '…', 'd', 'e', 'f']);
    check('§8 the current folder is marked', await page.evaluate(() =>
        document.querySelector('#fbCrumbs [aria-current="page"]')?.textContent), 'f');
    await page.click('[data-act="crumbs-more"]');
    check('§8 "…" lists what it hides', await page.evaluate(() =>
        [...document.querySelectorAll('.fb-menu-item')].map(i => i.textContent)), ['/a', '/a/b', '/a/b/c']);
    await clear(page);
    await page.click('.fb-menu-item >> nth=1');
    check('§8 picking one lists it', (await emitted(page, 'list_directory')).map(p => p.remote_path), ['/a/b']);
    await clear(page);
    await page.click('#fbCrumbs .fb-crumb[data-path="/a/b/c/d/e"]');
    check('§8 a crumb lists its folder', (await emitted(page, 'list_directory')).map(p => p.remote_path), ['/a/b/c/d/e']);
    await clear(page);
    await page.click('.fb-crumb-edit');
    await page.fill('#fbPath', '/etc');
    await page.keyboard.press('Enter');
    check('§8 a typed path is listed', (await emitted(page, 'list_directory')).map(p => p.remote_path), ['/etc']);
    check('§8 ...and the crumbs come back', await visible(page, '#fbCrumbs'), true);
});

// ── §9 symlinks ─────────────────────────────────────────────────────────────
await withPage('§9', { width: 1440, height: 900 }, false, async (page) => {
    const link = (name, target, extra) => ({ name, is_dir: false, is_symlink: true, size: 9,
        mode: 0o120777, modified: 1759390000, owner: 'u', group: 'u', link_target: target, ...extra });
    await openFiles(page, [FILE('zz.txt'), link('data', '/srv/data', { target_is_dir: true }),
        link('dead', '/nope', { broken: true }), link('cfg', 'conf/app.yml', {})]);
    await expand(page);
    check('§9 a link to a folder sorts with the folders', await names(page), ['..', 'data', 'cfg', 'dead', 'zz.txt']);
    const badges = await page.evaluate(() => [...document.querySelectorAll('#fbList .fb-row')].map(row => {
        const badge = row.querySelector('.fb-symlink');
        return badge && { name: row.querySelector('.fb-name').textContent, target: badge.textContent.trim(),
            broken: badge.classList.contains('is-broken'), title: badge.title,
            glyph: row.querySelector('.fb-glyph use').getAttribute('href').split('#icon-')[1] };
    }).filter(Boolean));
    check('§9 each link names its target; a broken one says so', badges, [
        { name: 'data', target: '/srv/data', broken: false, title: 'Links to /srv/data', glyph: 'folder' },
        { name: 'cfg', target: 'conf/app.yml', broken: false, title: 'Links to conf/app.yml', glyph: 'file' },
        { name: 'dead', target: '/nope', broken: true, title: 'Broken link', glyph: 'file' }]);
    await clear(page);
    await page.dblclick(`${rowSel('data')} .fb-c-size`);
    check('§9 a link to a folder opens as one', (await emitted(page, 'list_directory')).map(p => p.remote_path),
        [`${HERE}/data`]);
});

// ── §10 virtualization ──────────────────────────────────────────────────────
await withPage('§10', { width: 1440, height: 900 }, false, async (page) => {
    const big = Array.from({ length: 2000 }, (_, k) => FILE(`f${String(k).padStart(4, '0')}.log`, k));
    await openFiles(page, big);
    await expand(page);
    const dom = await page.evaluate(() => document.querySelectorAll('#fbList .fb-row').length);
    atMost('§10 2000 entries are a few dozen rows of DOM', dom, 60);
    atLeast('§10 ...and enough to fill the list', dom, 20);
    const sizer = await rect(page, '#fbSizer');
    near('§10 the list is as tall as every row', Math.round(sizer.height), 2001 * 36, 1);
    await page.focus('#fbList');
    await page.keyboard.press('End');
    check('§10 End reaches the last entry and draws it', await page.evaluate(() => {
        const focused = document.querySelector('#fbList .fb-row.is-focus');
        const list = document.getElementById('fbList').getBoundingClientRect();
        const r = focused?.getBoundingClientRect();
        return [focused?.querySelector('.fb-name')?.textContent, !!r && r.bottom <= list.bottom + 1 && r.top >= list.top - 1];
    }), ['f1999.log', true]);
    await page.evaluate(() => { document.getElementById('fbList').scrollTop = 30000; });
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => document.getElementById('fbList').scrollTop);
    await clear(page);
    await page.click('#filesBrowser .fb-refresh');
    check('§10 Refresh re-lists', (await emitted(page, 'list_directory')).map(p => p.remote_path), [HERE]);
    const during = await page.evaluate(() => [document.getElementById('fbList').scrollTop,
        document.querySelectorAll('#fbList .fb-row').length > 0,
        document.getElementById('fbList').getAttribute('aria-busy')]);
    check('§10 while it is in flight the rows stay where they were', during, [before, true, 'true']);
    await reply(page, big, HERE);
    check('§10 ...and after it lands', await page.evaluate(() => [document.getElementById('fbList').scrollTop,
        document.getElementById('fbList').getAttribute('aria-busy')]), [before, 'false']);
    // A rename that sorts far away is scrolled to.
    await page.focus('#fbList');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('F2');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('zzzz.log');
    await clear(page);
    await page.keyboard.press('Enter');
    const [far] = await emitted(page, 'rename_file');
    await fire(page, 'fm_result', { request_id: far.request_id, op: 'rename', session_id: S1,
        results: [{ path: far.old_path, ok: true, error: null }] });
    await reply(page, big.map(f => f.name === 'f0000.log' ? { ...f, name: 'zzzz.log' } : f), HERE);
    check('§10 a renamed entry is scrolled to, selected and focused', await page.evaluate(() => {
        const row = document.querySelector('#fbList .fb-row.is-focus');
        const list = document.getElementById('fbList').getBoundingClientRect();
        const r = row?.getBoundingClientRect();
        return [row?.querySelector('.fb-name')?.textContent, row?.classList.contains('is-sel'),
            !!r && r.top >= list.top - 1 && r.bottom <= list.bottom + 1];
    }), ['zzzz.log', true, true]);
    await page.focus('#fbList');
    await page.keyboard.press('Backspace');
    check('§10 a navigation does blank the list and says it is loading', await page.evaluate(() =>
        [document.querySelectorAll('#fbList .fb-row:not(.fb-parent)').length,
         document.getElementById('fbState').hidden,
         !!document.querySelector('#fbState .fm-loading-spinner')]), [0, false, true]);
});

// ── §11 phone ───────────────────────────────────────────────────────────────
await withPage('§11', { width: 390, height: 844 }, true, async (page) => {
    await openFiles(page);
    // An entry of the page's own under the browser's, so a Back the browser
    // fails to hold stays on this page and shows as a wrong state.
    await page.evaluate(() => history.pushState({ sentinel: true }, ''));
    await page.tap('#sftpPanelExpand');
    await page.waitForTimeout(100);
    const cdp = await page.context().newCDPSession(page);
    const hold = async (name, moveBy = 0) => {
        const at = await rowBox(page, name);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
        if (moveBy) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
                touchPoints: [{ x: at.x, y: at.y + moveBy }] });
        }
        await page.waitForTimeout(420);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(80);
    };
    const selecting = () => page.evaluate(() =>
        document.getElementById('filesBrowser').classList.contains('fb-selecting'));

    await hold('app.py', 30);
    check('§11 a hold that moves is a scroll, not a selection', [await selecting(), await selectedNames(page)], [false, []]);
    await clear(page);
    await hold('app.py');
    check('§11 a hold starts selection with that row', [await selecting(), await selectedNames(page)], [true, ['app.py']]);
    check('§11 ...and opened nothing', (await emitted(page, 'list_directory')).length, 0);
    check('§11 the bar shows the selection actions',
        [await visible(page, '.fb-bar-select'), await visible(page, '.fb-bar-normal')], [true, false]);
    check('§11 the head counts it', await page.textContent('#fbSelTitle'), '1 selected');
    check('§11 selecting: every visible control is at least 44x44', await underTarget(page, '#filesBrowser'), []);
    await page.tap(`${rowSel('docs')} .fb-name`);
    check('§11 a tap while selecting toggles, and opens nothing',
        [await selectedNames(page), (await emitted(page, 'list_directory')).length], [['docs', 'app.py'], 0]);
    await page.tap('.fb-selhead [data-act="end-select"]');
    check('§11 Cancel ends selection', [await selecting(), await selectedNames(page)], [false, []]);
    await page.tap(`${rowSel('docs')} .fb-name`);
    check('§11 a tap opens a folder', (await emitted(page, 'list_directory')).map(p => p.remote_path), [`${HERE}/docs`]);
    await seed(page, LISTING);

    await page.tap(`${rowSel('deploy.sh')} .fb-more`);
    const sheet = await page.evaluate(() => {
        const menu = document.querySelector('.fm-context-menu.fm-context-sheet');
        if (!menu) return null;
        const r = menu.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { title: menu.querySelector('.fm-context-title')?.textContent.trim(), onTop: menu.contains(hit) };
    });
    check('§11 the row\'s sheet names the file and is on top', sheet, { title: 'deploy.sh', onTop: true });
    await page.tap('.fm-context-sheet [data-action="rename"]');
    await page.waitForTimeout(50);
    check('§11 Rename from the sheet edits in this browser', await page.evaluate(() =>
        document.querySelector('#fbList .fb-edit')?.value), 'deploy.sh');
    await page.keyboard.press('Escape');

    await page.tap('.fb-head [data-act="menu"]');
    check('§11 the ⋮ menu', await page.evaluate(() =>
        [...document.querySelectorAll('.fb-menu-item')].map(i => [i.textContent, i.getAttribute('aria-checked')])), [
        ['Select', null], ['Refresh', null], ['Hidden files', 'true'], ['Sort by: Name ↑', 'true'],
        ['Sort by: Size', 'false'], ['Sort by: Modified', 'false']]);
    await clear(page);
    await page.tap('.fb-menu-item >> nth=1');
    check('§11 Refresh from the menu re-lists', (await emitted(page, 'list_directory')).map(p => p.remote_path), [HERE]);
    await seed(page, LISTING);
    await page.tap('.fb-head [data-act="menu"]');
    await page.tap('.fb-menu-item >> nth=0');
    check('§11 Select from the menu starts selection', await selecting(), true);
    await page.tap('.fb-selhead [data-act="select-all"]');
    check('§11 Select all', (await selectedNames(page)).length, LISTING.length);
    await page.tap('.fb-selhead [data-act="end-select"]');
    await page.tap('.fb-head [data-act="toggle-filter"]');
    check('§11 the search control opens the filter', [await visible(page, '#fbFilter'),
        await page.evaluate(() => document.activeElement.id)], [true, 'fbFilter']);

    // Back, step by step: the filter bar, the selection, then the browser.
    const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(150); };
    const state = () => page.evaluate(() => {
        const fb = document.getElementById('filesBrowser');
        return { open: !fb.hidden, filter: fb.classList.contains('fb-filter-open'),
                 selecting: fb.classList.contains('fb-selecting'), url: location.href };
    });
    await hold('app.py');
    const url = (await state()).url;
    await back();
    check('§11 Back 1 closes the filter bar', await state(),
        { open: true, filter: false, selecting: true, url });
    await back();
    check('§11 Back 2 ends selection', await state(), { open: true, filter: false, selecting: false, url });
    await back();
    check('§11 Back 3 collapses, and the page stays', await state(),
        { open: false, filter: false, selecting: false, url });
    check('§11 ...leaving no entry of the browser\'s behind', await page.evaluate(() =>
        !!history.state?.filesBrowser), false);
    await page.tap('#sftpPanelExpand');
    await page.tap('[data-act="collapse"]');
    await page.waitForTimeout(150);
    check('§11 collapsed by its control, it gives its entry back', await page.evaluate(() =>
        [!!history.state?.filesBrowser, document.getElementById('filesBrowser').hidden]), [false, true]);
});

// ── §12 i18n ────────────────────────────────────────────────────────────────
await withPage('§12', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    await clickRow(page, 'app.py');
    const raw = () => page.evaluate(() => {
        const KEY = /^(fb|fm|common)\.[A-Za-z.]+$/;
        const root = document.getElementById('filesBrowser');
        const found = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (KEY.test(walker.currentNode.textContent.trim())) found.push(walker.currentNode.textContent.trim());
        }
        root.querySelectorAll('*').forEach(el => ['aria-label', 'title', 'placeholder'].forEach(a => {
            if (KEY.test(el.getAttribute(a) || '')) found.push(`${a}=${el.getAttribute(a)}`);
        }));
        return found;
    });
    check('§12 no raw i18n key in the browser', await raw(), []);
    await page.evaluate(() => window.i18n.setLanguage('vi'));
    await page.waitForFunction(() => document.querySelector('[data-act="collapse"] span')?.textContent === 'Thu gọn',
        null, { timeout: 5000 }).catch(() => {});
    check('§12 a language change re-renders the browser', await page.evaluate(() => [
        document.querySelector('[data-act="collapse"] span').textContent,
        document.querySelector('.fb-sort[data-key="size"] span').textContent,
        document.getElementById('fbSelSum').textContent,
        document.querySelector('#fbList .fb-row:not(.fb-parent) .fb-check').getAttribute('aria-label')]),
        ['Thu gọn', 'Kích thước', '1 đã chọn · 2 KB', 'Chọn docs']);
    check('§12 no raw i18n key in Vietnamese', await raw(), []);
});

// ── §13 another session's chip ──────────────────────────────────────────────
await withPage('§13', { width: 1440, height: 900 }, false, async (page) => {
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
    await fire(page, 'ssh_session_restored', snapshot(S2, 'two', 'other'));
    await fire(page, 'connect');
    await page.waitForTimeout(1200);
    await page.click(`#tab-${S1}`);
    await page.waitForTimeout(200);
    await page.evaluate(() => window.openFileManager());
    await page.waitForTimeout(150);
    await seed(page, LISTING);
    check('§13 the panel starts on the first session', await page.evaluate(() =>
        window.sftpFileManager.panes.inline.sessionId), S1);
    await expand(page);
    await page.dblclick(`${rowSel('docs')} .fb-c-size`);
    await reply(page, [FILE('guide.md')], `${HERE}/docs`);
    await clickRow(page, 'guide.md');
    await clear(page);
    await page.click(`#tab-${S2}`);
    await page.waitForTimeout(200);
    const listed = (await emitted(page, 'list_directory')).map(p => [p.session_id, p.remote_path]);
    check('§13 the browser stays open over the new session', await page.evaluate(() =>
        document.getElementById('filesBrowser').hidden), false);
    check('§13 ...lists that session', listed, [[S2, '/']]);
    check('§13 ...and names its host', await page.textContent('#fbTitle'), 'Files · other');
    await fire(page, 'home_directory', { session_id: S2, path: '/home/u' });
    await reply(page, [FILE('notes.md'), DIR('src')], '/home/u', S2);
    check('§13 it lands at that host\'s home', await names(page), ['..', 'src', 'notes.md']);
    check('§13 nothing carried over: no selection, no history', [await selectedNames(page),
        await page.evaluate(() => document.querySelector('#filesBrowser [data-act="back"]').disabled)], [[], true]);
});

// ── §14 the header's Files button ───────────────────────────────────────────
await withPage('§14', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    await page.click('#fileTransferBtn');
    await page.waitForTimeout(150);
    check('§14 Files while expanded closes the panel and the browser, and frees the terminal',
        await page.evaluate(() => [
            document.getElementById('sftpPanel').classList.contains('sftp-panel-open'),
            document.getElementById('filesBrowser').hidden,
            document.body.classList.contains('files-browser-open'),
            !!document.querySelector('.terminal-area').closest('[inert]')]),
        [false, true, false, false]);
    await page.click('#fileTransferBtn');
    await page.waitForTimeout(150);
    check('§14 Files again opens the panel, not the browser', await page.evaluate(() => [
        document.getElementById('sftpPanel').classList.contains('sftp-panel-open'),
        document.getElementById('filesBrowser').hidden]), [true, true]);
});

// ── §15 a narrow window with a mouse ────────────────────────────────────────
await withPage('§15', { width: 700, height: 900 }, false, async (page) => {
    await openFiles(page);
    await expand(page);
    const bar = () => page.evaluate(() => ['.fb-bar-normal', '.fb-bar-select'].map(sel =>
        document.querySelector(sel).getBoundingClientRect().width > 0));
    check('§15 nothing selected: the bar creates', await bar(), [true, false]);
    await page.click(`${rowSel('app.py')} .fb-name`);
    await page.click(`${rowSel('deploy.sh')} .fb-name`, { modifiers: ['Control'] });
    check('§15 rows picked with a mouse: the bar acts on them', await bar(), [false, true]);
    await page.click('.fb-bar [data-act="delete"]');
    check('§15 ...and its Delete asks about both', await page.evaluate(() =>
        document.querySelector('.fb-dialog-title')?.textContent), 'Delete 2 items?');
    await page.click('[data-dialog="cancel"]');
    await page.keyboard.press('Escape');
    check('§15 cleared: the bar creates again', await bar(), [true, false]);
});

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
