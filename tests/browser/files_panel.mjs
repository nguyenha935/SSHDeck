#!/usr/bin/env node
/*
 * THE FILES PANEL (#sftpPanel): what a row draws, how much room the list has,
 * and what a touch screen can do with a row.
 *
 * Measured 2026-10-02 on main, with this listing at four tiers:
 *   - 5 of the 12 files drew an empty box: getFileIcon returned Ant Design
 *     names (code, picture, key, file-text) that are not symbols in the
 *     sprite; video, audio, archive and spreadsheet all drew the plain `file`;
 *     and 5 of the 7 entries of a file's menu asked for names that are not
 *     symbols either (swap, edit, folder-add, reload, delete);
 *   - the pane was sized by its content: at 834x1194 an 837px pane in a 1019px
 *     panel, at 390x844 a 178px list, at 844x390 a 44px list -- one row;
 *   - on an iPad opening the panel shrank the terminal 834 -> 550px for an
 *     empty grid track under the overlay: an ssh_resize to 65 columns from 98,
 *     for every device on the session;
 *   - on a phone there was no way to rename, delete, download or preview: those
 *     lived only in a right-click menu that is display:none under 768px.
 *
 * Sections:
 *   §1  each kind of file gets its glyph, every glyph is a sprite symbol, and
 *       every one actually draws (a non-empty box)
 *   §2  the pane fills the panel at five tiers; the phone sheet is 54% whatever
 *       the listing; the list holds rows; the iPad terminal keeps its width
 *   §3  the row's actions control: a menu anchored to it on a desktop (the row
 *       no taller for it), a bottom sheet naming the file on a phone, and the
 *       actions in it work from there
 *   §4  behaviour: opens at $HOME, a session switched while closed is listed on
 *       open, a create refreshes the panel, an error shows at once, a phone row
 *       click keeps the panel the active pane, Shift ranges follow the rows as
 *       drawn, the path reads left to right, a lost session says so
 *   §Z  no page errors
 *
 * Run: node tests/browser/files_panel.mjs   (from source/)
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
function near(label, actual, expected, tolerance = 2) {
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

// The socket is a recorder; __server runs the app's own handlers.
const INIT = `
    const noop = () => {};
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.io = () => ({
        connected: true, on: record, off: noop, once: record,
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
        io: { on: noop },
    });
    window.socket = window.io();
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.showNotification = noop;
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
const snapshot = (session_id, tmux, name) => ({
    snapshot_version: 1, session_id, host: `${name}.example`, port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: tmux, display_name: name,
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
});

const FILE = (name, size = 1000) => ({ name, is_dir: false, size, mode: 0o100644, modified: 1759390000 });
const DIR = (name) => ({ name, is_dir: true, size: 4096, mode: 0o40755, modified: 1759390000 });
const LISTING = [
    DIR('static'), FILE('app.py'), FILE('deploy.sh'), FILE('logo.png'), FILE('clip.mp4'),
    FILE('song.mp3'), FILE('backup.tar.gz'), FILE('data.csv'), FILE('id_ed25519.pem'),
    FILE('README.md'), FILE('yarn.lock'), FILE('Makefile'), FILE('.bashrc'),
];

const pageErrors = [];
async function openPage(viewport, touch = false) {
    const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'renamed.py' : undefined));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(
        () => typeof SessionManager !== 'undefined' && typeof TerminalManager !== 'undefined',
        null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate(() => {
        window.__copied = [];
        TerminalManager.reportCopyResult = (text) => window.__copied.push(text);
    });
    return page;
}

// One page per block. A block that throws (a control that is not there) is one
// FAIL row and the run goes on, so every section is graded on any build.
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

// The panel opened through its production entry point, with a listing seeded
// as the reply would leave it (no server answers the stand-in socket).
async function openFiles(page, files = LISTING) {
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
    await fire(page, 'connect');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.openFileManager());
    await page.waitForTimeout(150);
    await seed(page, files);
}
const seed = (page, files) => page.evaluate((list) => {
    const fm = window.sftpFileManager;
    const s = fm.panes.inline;
    if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
    s.loading = false;
    s.error = null;
    s.path = '/opt/sshdeck';
    s.files = list;
    fm.updatePaneBadge('inline');
    fm.renderPane('inline');
}, files);

const rect = (page, selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
             width: r.width, height: r.height };
}, selector);

// ── §1 icons ────────────────────────────────────────────────────────────────
await withPage('§1 icons', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    await page.waitForTimeout(400);           // the sprite is fetched once
    const rows = await page.evaluate(() => [...document.querySelectorAll(
        '#fmInlineList .fm-file-item:not([data-type="parent"])')].map(row => {
        const use = row.querySelector('.fm-file-icon use');
        const box = use.getBBox();
        return {
            name: row.querySelector('.fm-file-name').textContent,
            icon: use.getAttribute('href').split('#icon-')[1],
            drawn: box.width > 0 && box.height > 0,
        };
    }));
    // Sorted: the rows come in drawing order, the expectation in reading order.
    const byName = Object.fromEntries(rows.map(r => [r.name, r.icon])
        .sort(([a], [b]) => a.localeCompare(b)));
    check('§1 each kind of file gets its own glyph', byName, Object.fromEntries(Object.entries({
        'static': 'folder', 'app.py': 'file-code', 'deploy.sh': 'file-terminal',
        'logo.png': 'file-image', 'clip.mp4': 'file-video-camera', 'song.mp3': 'file-music',
        'backup.tar.gz': 'file-archive', 'data.csv': 'file-spreadsheet',
        'id_ed25519.pem': 'file-key', 'README.md': 'file-text', 'yarn.lock': 'lock',
        'Makefile': 'file', '.bashrc': 'file',
    }).sort(([a], [b]) => a.localeCompare(b))));
    check('§1 every glyph is a sprite symbol',
        rows.filter(r => !SPRITE.has(r.icon)).map(r => r.icon), []);
    atLeast('§1 rows measured', rows.length, LISTING.length);
    check('§1 every glyph draws (non-empty box)',
        rows.filter(r => !r.drawn).map(r => r.name), []);
});

// ── §2 room ─────────────────────────────────────────────────────────────────
const TIERS = [
    { label: 'desktop 1440x900', viewport: { width: 1440, height: 900 }, touch: false, kind: 'rail' },
    { label: 'iPad 834x1194', viewport: { width: 834, height: 1194 }, touch: true, kind: 'overlay' },
    { label: 'phone 390x844', viewport: { width: 390, height: 844 }, touch: true, kind: 'sheet' },
    { label: 'phone landscape 844x390', viewport: { width: 844, height: 390 }, touch: true, kind: 'short' },
    { label: 'narrow window 700x900', viewport: { width: 700, height: 900 }, touch: false, kind: 'sheet' },
];
for (const tier of TIERS) {
    await withPage(`§2 ${tier.label}`, tier.viewport, tier.touch, async (page) => {
        await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
        await fire(page, 'connect');
        await page.waitForTimeout(300);
        const before = await rect(page, '.terminal-area');
        await page.evaluate(() => window.openFileManager());
        await page.waitForTimeout(150);
        // A SHORT listing first: a pane sized by its content shows here.
        await seed(page, [FILE('only.txt')]);
        await page.waitForTimeout(150);
        const panel = await rect(page, '#sftpPanel');
        const pane = await rect(page, '#fmInlinePane');
        const workspace = await rect(page, '#workspace');
        const terminal = await rect(page, '.terminal-area');
        const inside = panel && panel.left >= 0 && panel.right <= tier.viewport.width + 0.5
            && panel.top >= 0 && panel.bottom <= tier.viewport.height + 0.5 && panel.height > 0;
        check(`§2 ${tier.label}: the panel is on screen`, inside, true);
        near(`§2 ${tier.label}: the pane fills the panel`, Math.round(pane.height), Math.round(panel.height), 3);
        if (tier.kind === 'sheet') {
            near(`§2 ${tier.label}: the sheet is 54% of the workspace, whatever the listing`,
                Math.round(panel.height), Math.round(workspace.height * 0.54), 2);
        }
        if (tier.kind === 'overlay' || tier.kind === 'short') {
            near(`§2 ${tier.label}: the terminal keeps its width under the overlay`,
                Math.round(terminal.width), Math.round(before.width), 1);
        }
        // Then a full listing: how many rows the list really shows.
        await seed(page, LISTING);
        await page.waitForTimeout(150);
        const list = await rect(page, '#fmInlineList');
        const row = await rect(page, '#fmInlineList .fm-file-item:not([data-type="parent"])');
        const shown = Math.floor(list.height / row.height * 10) / 10;
        const floor = { rail: 10, overlay: 10, sheet: 4.5, short: 3 }[tier.kind];
        atLeast(`§2 ${tier.label}: rows the list shows`, shown, floor);
    });
}

// ── §3 the row's actions control ────────────────────────────────────────────
await withPage('§3 desktop', { width: 1440, height: 900 }, false, async (page) => {
    await openFiles(page);
    const counts = await page.evaluate(() => ({
        rows: document.querySelectorAll('#fmInlineList .fm-file-item:not([data-type="parent"])').length,
        controls: document.querySelectorAll('#fmInlineList .fm-row-more').length,
        onParent: document.querySelectorAll('#fmInlineList [data-type="parent"] .fm-row-more').length,
    }));
    check('§3 desktop: one actions control per row, none on ".."',
        [counts.controls, counts.onParent], [counts.rows, 0]);
    // The ".." row has no control: a row that has one is no taller.
    near('§3 desktop: the control does not make a row taller',
        Math.round((await rect(page, '#fmInlineList .fm-file-item[data-index="1"]')).height),
        Math.round((await rect(page, '#fmInlineList [data-type="parent"]')).height), 1);
    const button = '#fmInlineList .fm-file-item[data-index="1"] .fm-row-more';
    const name = await page.evaluate(() => window.sftpFileManager.panes.inline.files[1].name);
    await page.click(button);
    const at = await rect(page, button);
    const menu = await rect(page, '.fm-context-menu');
    const items = await page.evaluate(() => [...document.querySelectorAll('.fm-context-menu .fm-context-item')]
        .map(i => ({ action: i.dataset.action, icon: i.querySelector('use').getAttribute('href').split('#icon-')[1] })));
    check('§3 desktop: the menu hangs off the control',
        menu !== null && menu.top >= at.bottom - 1 && menu.right <= at.right + 1, true);
    check('§3 desktop: a file row offers these actions',
        items.map(i => i.action), ['preview', 'download', 'copypath', 'rename', 'newfolder', 'refresh', 'delete']);
    check('§3 desktop: every menu glyph is a sprite symbol',
        items.length > 0 && items.every(i => SPRITE.has(i.icon)), true);
    await page.click('.fm-context-menu [data-action="copypath"]');
    check('§3 desktop: Copy path copies the full path',
        await page.evaluate(() => window.__copied), [`/opt/sshdeck/${name}`]);
});
await withPage('§3 phone', { width: 390, height: 844 }, true, async (page) => {
    await openFiles(page);
    const button = '#fmInlineList .fm-file-item[data-index="1"] .fm-row-more';
    const name = await page.evaluate(() => window.sftpFileManager.panes.inline.files[1].name);
    const size = await rect(page, button);
    atLeast('§3 phone: the control is a touch target (width)', Math.round(size.width), 44, 'px');
    atLeast('§3 phone: the control is a touch target (height)', Math.round(size.height), 44, 'px');
    await page.click(button);
    const sheet = await page.evaluate(() => {
        const m = document.querySelector('.fm-context-menu');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { sheet: m.classList.contains('fm-context-sheet'), display: getComputedStyle(m).display,
                 bottom: Math.round(r.bottom), width: Math.round(r.width),
                 title: m.querySelector('.fm-context-title')?.textContent.trim() ?? null };
    });
    check('§3 phone: the menu is a bottom sheet, shown',
        sheet && [sheet.sheet, sheet.display], [true, 'block']);
    near('§3 phone: the sheet sits on the bottom edge', sheet.bottom, 844, 1);
    near('§3 phone: the sheet spans the width', sheet.width, 390, 1);
    // It covers the row it was opened from, so it says which file it acts on.
    check('§3 phone: the sheet names the file', sheet.title, name);
    await clear(page);
    await page.click('.fm-context-menu [data-action="rename"]');   // prompt answers renamed.py
    check('§3 phone: Rename from the sheet renames the row in the Files panel',
        await emitted(page, 'rename_file'),
        [{ session_id: S1, old_path: `/opt/sshdeck/${name}`, new_path: '/opt/sshdeck/renamed.py' }]);
});

// ── §4 behaviour ────────────────────────────────────────────────────────────
await withPage('§4 desktop', { width: 1440, height: 900 }, false, async (page) => {
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
    await fire(page, 'connect');
    await page.waitForTimeout(300);
    await clear(page);
    await page.evaluate(() => window.openFileManager());
    check('§4 opening asks for $HOME', await emitted(page, 'get_home_directory'), [{ session_id: S1 }]);
    check('§4 and lists / meanwhile', await emitted(page, 'list_directory'),
        [{ session_id: S1, remote_path: '/' }]);
    await clear(page);
    await fire(page, 'home_directory', { session_id: S1, path: '/home/u' });
    check('§4 the $HOME reply moves the panel there', await emitted(page, 'list_directory'),
        [{ session_id: S1, remote_path: '/home/u' }]);
    await clear(page);
    await page.click('#fmInlineHome');
    check('§4 Home goes to $HOME, not /', await emitted(page, 'list_directory'),
        [{ session_id: S1, remote_path: '/home/u' }]);

    await seed(page, LISTING);
    await clear(page);
    await fire(page, 'directory_created', { path: '/opt/sshdeck/new' });
    check('§4 a folder created is listed: the panel refreshes', await emitted(page, 'list_directory'),
        [{ session_id: S1, remote_path: '/opt/sshdeck' }]);

    // An error while the panel is loading shows at once, not after 10s.
    await page.click('#fmInlineRefresh');
    await fire(page, 'error', { error: 'Permission denied' });
    check('§4 an error shows in the panel at once',
        await page.evaluate(() => document.querySelector('#fmInlineList .fm-error-text')?.textContent),
        'Permission denied');

    // Shift ranges follow the rows as drawn, not the server's order.
    await seed(page, [FILE('b.txt'), DIR('zdir'), FILE('a.txt'), FILE('c.txt')]);
    const index = (n) => page.evaluate((x) => window.sftpFileManager.panes.inline.files
        .findIndex(f => f.name === x), n);
    await page.click(`#fmInlineList .fm-file-item[data-index="${await index('a.txt')}"] .fm-file-name`);
    await page.click(`#fmInlineList .fm-file-item[data-index="${await index('c.txt')}"] .fm-file-name`,
        { modifiers: ['Shift'] });
    check('§4 a Shift range is the rows between the two clicks, as drawn',
        await page.evaluate(() => {
            const s = window.sftpFileManager.panes.inline;
            return [...s.selected].map(i => s.files[i].name).sort();
        }), ['a.txt', 'b.txt', 'c.txt']);

    // The path read-out runs left to right: its '/' is drawn first.
    const order = await page.evaluate(() => {
        const host = document.getElementById('fmInlineHeadPath');
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        const at = (i) => { const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1);
                            return r.getBoundingClientRect().left; };
        return { text: host.textContent, slashFirst: at(0) < at(text.length - 1) };
    });
    check('§4 the path read-out is the path', order.text, '/opt/sshdeck');
    check('§4 and reads left to right (its leading "/" is drawn first)', order.slashFirst, true);

    // A lost session says so, with Retry.
    await page.evaluate((s) => window.sftpFileManager.handleSessionDisconnected(s), S1);
    check('§4 a lost session says why the panel is empty, with Retry',
        await page.evaluate(() => [
            document.querySelector('#fmInlineList .fm-error-text')?.textContent,
            !!document.querySelector('#fmInlineList .fm-error-retry')]),
        ['No active connection', true]);
});
// A session switched while the panel was CLOSED is listed when it opens.
await withPage('§4 session switched while closed', { width: 1440, height: 900 }, false, async (page) => {
    await fire(page, 'ssh_session_restored', snapshot(S1, 'one', 'tiny'));
    await fire(page, 'ssh_session_restored', snapshot(S2, 'two', 'box'));
    await fire(page, 'connect');
    await page.waitForTimeout(300);
    await page.evaluate((s) => SessionManager.switchSession(s), S1);
    await page.evaluate(() => window.openFileManager());
    await seed(page, LISTING);
    await page.evaluate(() => window.sftpFileManager.closeInline());
    await page.evaluate((s) => SessionManager.switchSession(s), S2);
    await page.waitForTimeout(100);
    await clear(page);
    await page.evaluate(() => window.openFileManager());
    await page.waitForTimeout(100);
    check('§4 a session switched while closed is listed on open',
        await emitted(page, 'list_directory'), [{ session_id: S2, remote_path: '/' }]);
    check('§4 and its $HOME asked for, not the old one kept',
        [await emitted(page, 'get_home_directory'),
         await page.evaluate(() => window.sftpFileManager.panes.inline.homePath)],
        [[{ session_id: S2 }], null]);
    check('§4 and the head names the new host',
        await page.evaluate(() => document.getElementById('fmInlineTitle').textContent.includes('box')), true);
});
// A phone row click keeps the panel the active pane.
await withPage('§4 phone', { width: 390, height: 844 }, true, async (page) => {
    await openFiles(page);
    await page.click('#fmInlineList .fm-file-item[data-index="1"] .fm-file-name');
    check('§4 phone: a row click keeps the Files panel the active pane',
        await page.evaluate(() => window.sftpFileManager.activePane), 'inline');
});

check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\nfiles_panel: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
