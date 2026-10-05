#!/usr/bin/env node
/*
 * SETTINGS → ADMINISTRATION (settings-admin.js) -- owner ruling 2026-10-05:
 * one Settings in the app; the /admin page is gone. Users, Running sessions,
 * Audit log and System are sections of Settings, on an administrator's page
 * only. The /admin/api/* answers are this gate's own fixtures.
 *
 * Sections:
 *   §1  Users: fetched as Settings opens, once; a row per account with its
 *       dates in the reader's zone (the API names UTC), its role and status;
 *       the ⋮ of every row on one vertical line, none on one's own row; the
 *       menu's items follow the account's state and post to the right address
 *   §2  a destructive action asks with the app's own dialog, naming the
 *       account: Cancel and Escape send nothing and leave Settings open,
 *       the browser's confirm() is never used
 *   §3  the ⋮ menu by keyboard: arrows move, Escape closes the menu before
 *       Settings and gives focus back to its ⋮, the same ⋮ closes it, Tab
 *       leaves it
 *   §4  Add user: checked before sending, the server's refusal shown in the
 *       form, success closes it and lists the account
 *   §5  Running sessions: totals, rows newest activity first, no polling;
 *       Refresh and showing the section again fetch; disconnecting keeps
 *       tmux without asking, ending tmux asks; a session without tmux offers
 *       only Close
 *   §6  Audit log: a page of 50, the reader's time and level words, the
 *       fields of the line; paging, the level filter, a search sent once
 *       typing stops
 *   §7  System: switches and limits from the table; "= 24 hours" beside the
 *       timeout; "changed" on what differs from the deployment; Save only
 *       when something changed and only what changed; checked before
 *       sending; the server's reasons by field; unsaved edits kept; Reset asks
 *   §8  the reader's language: changing it rewords the rows and their dates
 *   §9  a phone: the ⋮ opens a sheet named after the row, over a backdrop;
 *       every control a 44 px target, fields 16 px, nothing wider than the
 *       screen; a tablet keeps the ⋮ column aligned at 44 px
 *   §10 a page that is not an administrator's: no administration, no fetch
 *   §Z  no page errors
 *
 * Run: node tests/browser/settings_admin.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
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

// An administrator's page keeps what `{% if current_user.is_admin %}` wraps;
// anyone else's loses it, as Jinja would render it.
function renderTemplate(admin) {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    if (!admin) {
        html = html.replace(/\{%\s*if current_user\.is_admin\s*%\}[\s\S]*?\{%\s*endif\s*%\}/g, '');
    }
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'pwuser');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const pages = { admin: renderTemplate(true), user: renderTemplate(false) };
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(req.url.includes('role=user') ? pages.user : pages.admin);
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

// The page needs a socket to boot; nothing here talks over it. window.confirm
// is counted: no confirmation of this module may use it.
const INIT = `
    const noop = () => {};
    window.__handlers = {};
    window.socket = {
        connected: true, connect: noop, off: noop, emit: noop,
        io: { on: noop, engine: { transport: { name: 'websocket' } } },
        on: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        once: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        onAny: noop, onAnyOutgoing: noop, offAny: noop, offAnyOutgoing: noop,
    };
    window.io = () => window.socket;
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    window.__confirms = 0;
    window.confirm = () => { window.__confirms++; return true; };
    window.__toasts = [];
`;

// ── the server's answers ────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-05T09:00:00Z');
const TZ = 'Asia/Ho_Chi_Minh';
const USERS = [
    { id: 1, username: 'pwuser', is_admin: true, is_locked: false,
        created_at: '2026-08-09T03:00:00+00:00', last_login: '2026-10-05T08:50:25+00:00' },
    { id: 2, username: 'alice', is_admin: false, is_locked: false,
        created_at: '2026-09-01T10:00:00+00:00', last_login: null },
    { id: 3, username: 'operator_with_a_rather_long_name', is_admin: true, is_locked: true,
        created_at: '2026-09-20T23:30:00+00:00', last_login: '2026-10-01T01:02:03+00:00' },
];
const SESSIONS = [
    { session_id: 's-1', user_id: 1, user_username: 'pwuser', host: 'tiny.example', port: 22,
        username: 'root', use_tmux: true, tmux_session_name: 'sshdeck_root_tiny_22_0001',
        display_name: 'tiny', last_activity: NOW / 1000 - 120 },
    { session_id: 's-2', user_id: 2, user_username: 'alice', host: 'goclaw.example', port: 2222,
        username: 'ubuntu', use_tmux: false, tmux_session_name: null,
        display_name: null, last_activity: NOW / 1000 - 30 },
    { session_id: 's-3', user_id: 1, user_username: 'pwuser', host: 'build.example', port: 22,
        username: 'ci', use_tmux: true, tmux_session_name: 'sshdeck_ci_build_22_0002',
        display_name: 'build', last_activity: NOW / 1000 - 3600 },
];
const CAPACITY = {
    max_sessions: 100, max_sessions_per_user: 50, pending: 1, total_live: 3,
    by_user: [{ user_id: 1, username: 'pwuser', live: 2 }, { user_id: 2, username: 'alice', live: 1 }],
    sessions: SESSIONS,
};
const AUDIT = Array.from({ length: 120 }, (_, i) => (i % 10 === 0
    ? { timestamp: new Date(NOW - i * 60000).toISOString(), level: 'WARNING', logger: 'audit',
        message: 'Login failed', username: 'eve', ip: '10.0.0.7' }
    : { timestamp: new Date(NOW - i * 60000).toISOString(), level: 'INFO', logger: 'audit',
        message: 'View attached', user: 'pwuser', session_id: 's-1' }));
const SETTINGS = [
    { key: 'registration_enabled', type: 'bool', value: true, default: true, overridden: false },
    { key: 'ratelimit_enabled', type: 'bool', value: true, default: true, overridden: false },
    { key: 'max_sessions', type: 'int', value: 100, default: 100, overridden: false, min: 1, max: 1000 },
    { key: 'max_sessions_per_user', type: 'int', value: 50, default: 50, overridden: false, min: 1, max: 1000 },
    { key: 'max_views_per_session', type: 'int', value: 8, default: 8, overridden: false, min: 1, max: 64 },
    { key: 'session_timeout', type: 'int', value: 86400, default: 86400, overridden: false,
        min: 120, max: 604800, unit: 'seconds' },
    { key: 'ssh_connect_ratelimit', type: 'rate', value: '60 per minute', default: '10 per minute', overridden: true },
    { key: 'login_ratelimit', type: 'rate', value: '5 per minute', default: '5 per minute', overridden: false },
];

function answer(call) {
    const { method, path: p, query, body } = call;
    if (p === '/admin/api/users') return method === 'GET' ? { users: USERS } : { success: true };
    if (p.startsWith('/admin/api/users/')) return { success: true };
    if (p === '/admin/api/capacity') return CAPACITY;
    if (p.startsWith('/admin/api/sessions/')) return { ok: true };
    if (p === '/admin/api/audit') {
        const q = (query.q || '').toLowerCase();
        const rows = AUDIT.filter(e => (!query.level || e.level === query.level)
            && (!q || e.message.toLowerCase().includes(q)));
        const offset = Number(query.offset || 0);
        const limit = Number(query.limit || 100);
        return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
    }
    if (p === '/admin/api/settings') {
        if (method === 'GET') return { settings: SETTINGS };
        if (body?.reset) return { settings: SETTINGS.map(row => ({ ...row, value: row.default, overridden: false })) };
        return { settings: SETTINGS.map(row => (row.key in body
            ? { ...row, value: row.type === 'int' ? Number(body[row.key]) : body[row.key], overridden: true }
            : row)) };
    }
    return {};
}

// Every call is logged; `refuse` makes the next matching call answer with a
// status and body of the test's choosing.
async function fakeApi(page) {
    const api = {
        calls: [],
        refusals: [],
        refuse(method, p, status, body) { this.refusals.push({ method, p, status, body }); },
        count(method, p) { return this.calls.filter(c => c.method === method && c.path === p).length; },
        posts() { return this.calls.filter(c => c.method === 'POST'); },
    };
    await page.route('**/admin/api/**', route => {
        const request = route.request();
        const url = new URL(request.url());
        let body = null;
        try { body = request.postDataJSON(); } catch { /* none */ }
        const call = { method: request.method(), path: url.pathname,
            query: Object.fromEntries(url.searchParams), body,
            csrf: 'x-csrftoken' in request.headers() };
        api.calls.push(call);
        const at = api.refusals.findIndex(r => r.method === call.method && r.p === call.path);
        const refusal = at >= 0 ? api.refusals.splice(at, 1)[0] : null;
        route.fulfill({ status: refusal ? refusal.status : 200, contentType: 'application/json',
            body: JSON.stringify(refusal ? refusal.body : answer(call)) });
    });
    return api;
}

const DESKTOP = { viewport: { width: 1440, height: 900 }, timezoneId: TZ, locale: 'en-US' };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: TZ, locale: 'en-US' };
const TABLET = { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, timezoneId: TZ, locale: 'en-US' };

const pageErrors = [];
async function openPage(ctx, { role = 'admin' } = {}) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    const api = await fakeApi(page);
    await page.addInitScript(INIT);
    await page.clock.install({ time: NOW });
    await page.goto(`${base}/${role === 'user' ? '?role=user' : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof SettingsView !== 'undefined' && typeof i18n !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => {
        const original = window.showNotification;
        window.showNotification = (text, type) => { window.__toasts.push([text, type]); return original?.(text, type); };
    });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
    return { page, api };
}
async function withContext(label, fn, options = DESKTOP) {
    const ctx = await browser.newContext(options);
    try {
        await fn(ctx);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${label}: stopped\n        ${String(e.message).split('\n')[0]}`);
    } finally {
        await ctx.close();
    }
}

// A string as the module words it, in the page's language.
const say = (page, key, values = {}) => page.evaluate(([k, v]) =>
    i18n.t(k).replace(/\{(\w+)\}/g, (all, name) => (name in v ? v[name] : all)), [key, values]);
// How the page writes an instant given with its zone, in the page's zone.
const local = (page, iso, options) => page.evaluate(([i, o, lang]) =>
    new Date(i).toLocaleString(lang, o), [iso, options, 'en']);
const DAY = { day: '2-digit', month: '2-digit', year: 'numeric' };
const MINUTE = { ...DAY, hour: '2-digit', minute: '2-digit' };
const settle = (page, ms = 120) => page.waitForTimeout(ms);
const visible = (page, sel) => page.evaluate(s => {
    const node = document.querySelector(s);
    return Boolean(node && !node.closest('[hidden]') && node.getClientRects().length);
}, sel);
const menuState = (page) => page.evaluate(() => {
    const node = document.querySelector('#settingsView .sv-menu');
    if (!node || node.hidden) return null;
    return {
        sheet: node.classList.contains('is-sheet'),
        title: node.querySelector('.sv-menu-title')?.textContent ?? null,
        items: [...node.querySelectorAll('.sv-menu-item')].map(b => [b.textContent, b.classList.contains('is-danger')]),
        backdrop: !document.querySelector('#settingsView .sv-menu-backdrop').hidden,
    };
});
const confirmState = (page) => page.evaluate(() => {
    const dialog = document.getElementById('sessionConfirm');
    return dialog.hidden ? null : {
        title: document.getElementById('sessionConfirmTitle').textContent,
        body: document.getElementById('sessionConfirmBody').textContent,
        accept: document.getElementById('sessionConfirmAccept').textContent,
    };
});
const settingsOpen = (page) => page.evaluate(() => SettingsView.isOpen);
// The ⋮ column of a list: where the last cell of every row sits, whether it
// is a ⋮ or the empty slot of one's own row, and whether it is on the row's
// line at the row's right end (a grid that wrapped would still line up).
const menuColumn = (page, list) => page.evaluate(sel => [...document.querySelectorAll(`${sel} > .sv-arow`)]
    .map(row => {
        const last = row.lastElementChild;
        const r = last.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), menu: last.matches('.sv-row-menu'),
            chipsRight: Math.round(row.querySelector('.sv-arow-chips').getBoundingClientRect().right),
            rightGap: Math.round(box.right - r.right),
            inline: Math.abs((r.top + r.bottom) / 2 - (box.top + box.bottom) / 2) <= 1 };
    }), list);
const aligned = (column) => [same(column, 'left'), same(column, 'width'), same(column, 'chipsRight'),
    same(column, 'rightGap'), column.every(c => c.inline)];
const same = (rows, key) => new Set(rows.map(r => r[key])).size === 1;
const openMenuOf = (page, rowSelector) => page.click(`${rowSelector} .sv-row-menu`);
const clickItem = (page, index) => page.click(`#settingsView .sv-menu .sv-menu-item >> nth=${index}`);

// ── §1 Users ────────────────────────────────────────────────────────────────
await withContext('§1', async (ctx) => {
    const { page, api } = await openPage(ctx);
    check('§1 nothing is fetched before Settings opens', api.calls.length, 0);
    await page.evaluate(() => SettingsView.open('users'));
    await page.waitForSelector('#usersList > .sv-arow');
    check('§1 opening Settings at Users fetches the users and the sessions once each',
        [api.count('GET', '/admin/api/users'), api.count('GET', '/admin/api/capacity')], [1, 1]);
    check('§1 the head says how many accounts and administrators',
        await page.textContent('#usersSummary'), await say(page, 'admin.usersSummary', { n: 3, a: 2 }));
    check('§1 the list of sections says the counts',
        await page.evaluate(() => ['users', 'sessions'].map(s =>
            document.querySelector(`.sv-nav-value[data-value="${s}"]`).textContent)), ['3', '3 / 100']);

    const rows = await page.evaluate(() => [...document.querySelectorAll('#usersList > .sv-arow')].map(row => ({
        id: row.dataset.userId,
        name: row.querySelector('.sv-arow-title').textContent,
        you: Boolean(row.querySelector('.sv-chip.is-you')),
        meta: row.querySelector('.sv-arow-meta').textContent,
        chips: [...row.querySelectorAll('.sv-arow-chips .sv-chip')].map(c => c.textContent),
    })));
    const words = await page.evaluate(() => ['admin.roleAdmin', 'admin.roleUser', 'admin.statusActive',
        'admin.statusLocked'].map(k => i18n.t(k)));
    check('§1 a row per account, own row marked, role and status in words',
        rows.map(r => [r.id, r.name, r.you, r.chips]),
        [['1', 'pwuser', true, [words[0], words[2]]], ['2', 'alice', false, [words[1], words[2]]],
            ['3', 'operator_with_a_rather_long_name', false, [words[0], words[3]]]]);
    const created = await local(page, '2026-08-09T03:00:00Z', DAY);
    const signedIn = await local(page, '2026-10-05T08:50:25Z', MINUTE);
    check('§1 the dates are the reader\'s: created, signed in (UTC 08:50 is 15:50 in Vietnam)',
        [rows[0].meta, signedIn.includes('03:50'), rows[0].meta.includes('08:50')],
        [`${await say(page, 'admin.created', { when: created })} · ${await say(page, 'admin.signedIn', { when: signedIn })}`,
            true, false]);
    check('§1 an account that never signed in says so',
        rows[1].meta.endsWith(await say(page, 'admin.neverSignedIn')), true);

    const column = await menuColumn(page, '#usersList');
    check('§1 own row has no ⋮, every other row has one',
        column.map(c => c.menu), [false, true, true]);
    check('§1 ...and the ⋮ of every row sits on one line at the row\'s end, 32 px wide, chips ending at one edge',
        [column[0].width, column[0].rightGap, ...aligned(column)], [32, 10, true, true, true, true, true]);
    check('§1 the ⋮ names the account it acts on', await page.getAttribute(
        '#usersList .sv-arow[data-user-id="2"] .sv-row-menu', 'aria-label'),
    await say(page, 'admin.actionsFor', { name: 'alice' }));

    await openMenuOf(page, '#usersList .sv-arow[data-user-id="2"]');
    check('§1 an active user\'s menu: make administrator, lock, delete',
        await menuState(page), { sheet: false, title: null, items: [
            [await say(page, 'admin.promote'), false], [await say(page, 'admin.lock'), false],
            [await say(page, 'admin.deleteUser'), true]], backdrop: false });
    const placed = await page.evaluate(() => {
        const button = document.querySelector('#usersList .sv-arow[data-user-id="2"] .sv-row-menu').getBoundingClientRect();
        const menu = document.querySelector('#settingsView .sv-menu').getBoundingClientRect();
        return [Math.round(menu.top - button.bottom), Math.round(menu.right - button.right)];
    });
    check('§1 ...under its ⋮, right edges aligned', placed, [4, 0]);
    await clickItem(page, 1);
    await settle(page);
    const lock = api.posts().at(-1);
    check('§1 Lock posts to the account\'s lock address with the CSRF header, then lists again',
        [lock.path, lock.csrf, api.count('GET', '/admin/api/users')], ['/admin/api/users/2/lock', true, 2]);
    check('§1 ...and says it was done', await page.evaluate(() => window.__toasts.at(-1)),
        [await say(page, 'admin.done_lock', { name: 'alice' }), 'success']);

    await openMenuOf(page, '#usersList .sv-arow[data-user-id="3"]');
    check('§1 a locked administrator\'s menu: remove administrator, unlock, delete',
        (await menuState(page)).items.map(i => i[0]),
        [await say(page, 'admin.demote'), await say(page, 'admin.unlock'), await say(page, 'admin.deleteUser')]);
    await page.click('#usersSummary');
    check('§1 a press elsewhere closes the menu', await menuState(page), null);

    // ── §2 confirmations ──
    await openMenuOf(page, '#usersList .sv-arow[data-user-id="2"]');
    await clickItem(page, 2);
    check('§2 Delete asks in the app\'s dialog, naming the account, and sends nothing yet',
        [await confirmState(page), api.posts().length],
        [{ title: await say(page, 'admin.deleteTitle', { name: 'alice' }),
            body: await say(page, 'admin.deleteBody', { name: 'alice' }),
            accept: await say(page, 'admin.deleteAccept') }, 1]);
    check('§2 ...the dialog is on top of Settings', await page.evaluate(() => {
        const r = document.getElementById('sessionConfirmAccept').getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id;
    }), 'sessionConfirmAccept');
    await page.click('#sessionConfirmCancel');
    check('§2 Cancel sends nothing and Settings stays open',
        [await confirmState(page), api.posts().length, await settingsOpen(page)], [null, 1, true]);
    await openMenuOf(page, '#usersList .sv-arow[data-user-id="2"]');
    await clickItem(page, 2);
    await page.keyboard.press('Escape');
    check('§2 Escape closes the dialog alone: nothing sent, Settings open',
        [await confirmState(page), api.posts().length, await settingsOpen(page)], [null, 1, true]);
    await openMenuOf(page, '#usersList .sv-arow[data-user-id="2"]');
    await clickItem(page, 2);
    await page.click('#sessionConfirmAccept');
    await settle(page);
    check('§2 Accept deletes that account and lists again',
        [api.posts().at(-1).path, api.count('GET', '/admin/api/users')], ['/admin/api/users/2/delete', 3]);
    check('§2 the browser\'s confirm() was never used', await page.evaluate(() => window.__confirms), 0);

    // ── §3 the menu by keyboard ──
    await page.focus('#usersList .sv-arow[data-user-id="3"] .sv-row-menu');
    await page.keyboard.press('Enter');
    const focused = () => page.evaluate(() => document.activeElement?.textContent);
    const items = (await menuState(page)).items.map(i => i[0]);
    check('§3 Enter on a ⋮ opens it with the first item focused, expanded said',
        [await focused(), await page.getAttribute('#usersList .sv-arow[data-user-id="3"] .sv-row-menu', 'aria-expanded')],
        [items[0], 'true']);
    await page.keyboard.press('ArrowDown');
    const second = await focused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    check('§3 arrows move through the items and wrap', [second, await focused()], [items[1], items[2]]);
    await page.keyboard.press('Escape');
    check('§3 Escape closes the menu, not Settings, and focus goes back to the ⋮', [await menuState(page),
        await settingsOpen(page), await page.evaluate(() => document.activeElement?.closest('.sv-arow')?.dataset.userId),
        await page.getAttribute('#usersList .sv-arow[data-user-id="3"] .sv-row-menu', 'aria-expanded')],
    [null, true, '3', 'false']);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    check('§3 Tab leaves the menu closed', await menuState(page), null);
    await openMenuOf(page, '#usersList .sv-arow[data-user-id="3"]');
    await openMenuOf(page, '#usersList .sv-arow[data-user-id="3"]');
    check('§3 the same ⋮ closes it again', await menuState(page), null);
    await page.keyboard.press('Escape');
    check('§3 with no menu open, Escape closes Settings', await settingsOpen(page), false);
});

// ── §4 Add user ─────────────────────────────────────────────────────────────
await withContext('§4', async (ctx) => {
    const { page, api } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('users'));
    await page.waitForSelector('#usersList > .sv-arow');
    check('§4 the form is closed until asked for', await visible(page, '#addUserForm'), false);
    await page.click('#addUserBtn');
    check('§4 Add user opens the form in place, focused on the name',
        [await visible(page, '#addUserForm'), await page.getAttribute('#addUserBtn', 'aria-expanded'),
            await page.evaluate(() => document.activeElement?.id)], [true, 'true', 'newUsername']);
    await page.fill('#newUsername', 'a!');
    await page.fill('#newPassword', '123');
    await page.click('#addUserSubmit');
    check('§4 a bad name turns its rule red (said once), a short password is said, focus on the first, nothing sent',
        [await page.evaluate(() => [...document.querySelectorAll('#addUserForm *')]
            .filter(n => !n.children.length && n.textContent === i18n.t('admin.usernameRule')).length),
        await page.evaluate(() => document.getElementById('newUsernameHint').classList.contains('is-error')),
        await page.textContent('#newPasswordError'),
        await page.getAttribute('#newUsername', 'aria-invalid'), await page.evaluate(() => document.activeElement?.id),
        api.count('POST', '/admin/api/users')],
        [1, true, await say(page, 'settings.pwTooShort', { n: 8 }), 'true', 'newUsername', 0]);
    api.refuse('POST', '/admin/api/users', 400, { error: 'Username already exists' });
    await page.fill('#newUsername', 'alice');
    await page.fill('#newPassword', 'longpassword1');
    await page.click('#addUserSubmit');
    await settle(page);
    check('§4 the server\'s refusal is shown in the form, which stays open',
        [await page.textContent('#addUserStatus'), await page.getAttribute('#addUserStatus', 'class'),
            await visible(page, '#addUserForm'),
            await page.evaluate(() => document.getElementById('newUsernameHint').classList.contains('is-error'))],
        ['Username already exists', 'sv-status is-error', true, false]);
    await page.fill('#newUsername', 'carol');
    await page.click('label:has(#newIsAdmin)');
    await page.click('#addUserSubmit');
    await settle(page);
    check('§4 a good account is sent as one body, the form closes and the list is fetched again',
        [api.posts().at(-1).body, await visible(page, '#addUserForm'), api.count('GET', '/admin/api/users'),
            await page.evaluate(() => document.activeElement?.id)],
        [{ username: 'carol', password: 'longpassword1', is_admin: true }, false, 2, 'addUserBtn']);
    check('§4 ...and it says so', await page.evaluate(() => window.__toasts.at(-1)),
        [await say(page, 'admin.userCreated', { name: 'carol' }), 'success']);
    await page.click('#addUserBtn');
    check('§4 opened again, the form is empty',
        await page.evaluate(() => ['newUsername', 'newPassword'].map(id => document.getElementById(id).value)
            .concat(document.getElementById('newIsAdmin').checked, document.getElementById('addUserStatus').textContent)),
        ['', '', false, '']);
    await page.click('#addUserCancel');
    check('§4 Cancel closes it', await visible(page, '#addUserForm'), false);
});

// ── §5 Running sessions ─────────────────────────────────────────────────────
await withContext('§5', async (ctx) => {
    const { page, api } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('sessions'));
    await page.waitForSelector('#sessionsList > .sv-arow');
    check('§5 opening at Running sessions fetches them once',
        api.count('GET', '/admin/api/capacity'), 1);
    check('§5 when the numbers were read, in the reader\'s time',
        await page.textContent('#sessionsUpdated'), await say(page, 'admin.updatedAt', {
            time: await page.evaluate(() => new Date('2026-10-05T09:00:00Z')
                .toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })) }));
    check('§5 the totals beside their limits', await page.evaluate(() =>
        [...document.querySelectorAll('#sessionsStats .sv-stat')].map(s =>
            [s.querySelector('.sv-stat-value').textContent, s.querySelector('.sv-stat-label').textContent])),
    [['3 / 100', await say(page, 'admin.statOpen')],
        ['2 / 50', await say(page, 'admin.statTopUser', { name: 'pwuser' })],
        ['1', await say(page, 'admin.statPending')]]);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#sessionsList > .sv-arow')].map(row => [
        row.dataset.sessionId, row.querySelector('.sv-arow-name').textContent,
        row.querySelector('.sv-arow-meta').textContent, row.querySelector('.sv-chip').textContent]));
    const active = (n, unit) => page.evaluate(([v, u]) => new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
        .format(v, u), [n, unit]);
    check('§5 a row per session, most recently active first: owner, name, target, tmux, activity',
        rows, [
            ['s-2', 'alice · goclaw.example',
                `ubuntu@goclaw.example:2222 · ${await say(page, 'admin.activeAgo', { when: await active(-30, 'second') })}`,
                await say(page, 'admin.withoutTmux')],
            ['s-1', 'pwuser · tiny',
                `root@tiny.example · tmux …_22_0001 · ${await say(page, 'admin.activeAgo', { when: await active(-2, 'minute') })}`,
                await say(page, 'admin.withTmux')],
            ['s-3', 'pwuser · build',
                `ci@build.example · tmux …_22_0002 · ${await say(page, 'admin.activeAgo', { when: await active(-1, 'hour') })}`,
                await say(page, 'admin.withTmux')]]);
    const column = await menuColumn(page, '#sessionsList');
    check('§5 every row has its ⋮, on one line', [column.every(c => c.menu), ...aligned(column)],
        [true, true, true, true, true, true]);

    await page.clock.fastForward('10:00');
    check('§5 nothing polls: ten minutes later, still one fetch', api.count('GET', '/admin/api/capacity'), 1);
    await page.click('#sessionsRefresh');
    await settle(page);
    check('§5 Refresh fetches', api.count('GET', '/admin/api/capacity'), 2);
    await page.click('.sv-nav-item[data-section="users"]');
    await page.click('.sv-nav-item[data-section="sessions"]');
    await settle(page);
    check('§5 showing the section again fetches', api.count('GET', '/admin/api/capacity'), 3);

    await openMenuOf(page, '#sessionsList .sv-arow[data-session-id="s-1"]');
    check('§5 a tmux session offers: disconnect and keep tmux, or end tmux',
        (await menuState(page)).items, [[await say(page, 'admin.detachKeepTmux'), false],
            [await say(page, 'admin.endTmux'), true]]);
    await clickItem(page, 0);
    await settle(page);
    check('§5 disconnecting asks nothing, keeps tmux, and fetches again',
        [await confirmState(page), api.posts().at(-1).path, api.posts().at(-1).body, api.count('GET', '/admin/api/capacity')],
        [null, '/admin/api/sessions/s-1/close', { kill_tmux: false }, 4]);
    check('§5 ...and says the session was disconnected', await page.evaluate(() => window.__toasts.at(-1)),
        [await say(page, 'admin.sessionDetached', { name: 'tiny' }), 'success']);
    await openMenuOf(page, '#sessionsList .sv-arow[data-session-id="s-1"]');
    await clickItem(page, 1);
    check('§5 ending tmux asks first, naming the session and its host',
        [await confirmState(page), api.posts().length],
        [{ title: await say(page, 'admin.endTitle', { name: 'tiny' }),
            body: await say(page, 'admin.endBody', { host: 'tiny.example' }),
            accept: await say(page, 'admin.endAccept') }, 1]);
    await page.click('#sessionConfirmAccept');
    await settle(page);
    check('§5 ...and accepted, kills tmux', [api.posts().at(-1).path, api.posts().at(-1).body],
        ['/admin/api/sessions/s-1/close', { kill_tmux: true }]);
    await openMenuOf(page, '#sessionsList .sv-arow[data-session-id="s-2"]');
    check('§5 a session without tmux offers Close only', (await menuState(page)).items,
        [[await say(page, 'admin.closeSession'), true]]);
    await clickItem(page, 0);
    check('§5 ...which asks', (await confirmState(page))?.title, await say(page, 'admin.closeTitle', { name: 'goclaw.example' }));
    await page.click('#sessionConfirmAccept');
    await settle(page);
    check('§5 ...and closes it', [api.posts().at(-1).path, api.posts().at(-1).body],
        ['/admin/api/sessions/s-2/close', { kill_tmux: false }]);
    check('§5 every POST carries the CSRF header', api.posts().every(c => c.csrf), true);
});

// ── §6 Audit log ────────────────────────────────────────────────────────────
await withContext('§6', async (ctx) => {
    const { page, api } = await openPage(ctx);
    const audits = () => api.calls.filter(c => c.path === '/admin/api/audit').map(c => c.query);
    await page.evaluate(() => SettingsView.open('audit'));
    await page.waitForSelector('#auditList > .sv-lrow');
    check('§6 showing the log fetches its first page of 50', audits(), [{ offset: '0', limit: '50' }]);
    const first = await page.evaluate(() => {
        const row = document.querySelector('#auditList > .sv-lrow');
        return { count: document.querySelectorAll('#auditList > .sv-lrow').length,
            time: row.querySelector('time').textContent, datetime: row.querySelector('time').dateTime,
            chip: row.querySelector('.sv-level').textContent, warning: row.querySelector('.sv-level').classList.contains('is-warning'),
            message: row.querySelector('.sv-lrow-message').textContent,
            details: row.querySelector('.sv-lrow-details').textContent };
    });
    check('§6 a row: the reader\'s time to the second, the level in words, the message, the fields it was logged with',
        first, { count: 50, time: await local(page, AUDIT[0].timestamp, { ...MINUTE, second: '2-digit' }),
            datetime: AUDIT[0].timestamp, chip: await say(page, 'admin.levelWarning'), warning: true,
            message: 'Login failed', details: 'username=eve · ip=10.0.0.7' });
    check('§6 the message starts at one x in every row, whatever the level\'s word', await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#auditList > .sv-lrow')];
        const x = sel => new Set(rows.map(r => Math.round(r.querySelector(sel).getBoundingClientRect().left)));
        const widths = new Set(rows.map(r => Math.round(r.querySelector('.sv-level').getBoundingClientRect().width)));
        return [widths.size > 1, x('.sv-level').size, x('.sv-lrow-main').size];
    }), [true, 1, 1]);
    const pager = () => page.evaluate(() => [document.getElementById('auditPageInfo').textContent,
        document.getElementById('auditPrev').disabled, document.getElementById('auditNext').disabled]);
    check('§6 the pager: where this page is, no previous', await pager(), ['1–50 / 120', true, false]);
    await page.click('#auditNext');
    await settle(page);
    check('§6 Next', [audits().at(-1).offset, await pager()], ['50', ['51–100 / 120', false, false]]);
    await page.click('#auditNext');
    await settle(page);
    check('§6 the last page, no next', await pager(), ['101–120 / 120', false, true]);
    await page.click('#auditPrev');
    await settle(page);
    check('§6 Previous', await pager(), ['51–100 / 120', false, false]);
    await page.selectOption('#auditLevel', 'WARNING');
    await settle(page);
    check('§6 a level filters from the first page', [audits().at(-1), await pager()],
        [{ offset: '0', limit: '50', level: 'WARNING' }, ['1–12 / 12', true, true]]);
    await page.selectOption('#auditLevel', '');
    await settle(page);
    const before = audits().length;
    await page.type('#auditSearch', 'fail', { delay: 40 });
    await settle(page, 500);
    check('§6 a search is sent once, when typing stops', audits().slice(before),
        [{ offset: '0', limit: '50', q: 'fail' }]);
    check('§6 ...and lists what matches', await page.evaluate(() =>
        [...new Set([...document.querySelectorAll('#auditList .sv-lrow-message')].map(m => m.textContent))]),
    ['Login failed']);
    await page.fill('#auditSearch', 'nothing like it');
    await settle(page, 500);
    check('§6 no match says so', await page.textContent('#auditList'), await say(page, 'admin.noLogs'));
});

// ── §7 System ───────────────────────────────────────────────────────────────
await withContext('§7', async (ctx) => {
    const { page, api } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('system'));
    await page.waitForSelector('#systemLimits > .sv-row');
    check('§7 the switches and the limits, from the table', await page.evaluate(() =>
        ['systemSwitches', 'systemLimits'].map(id =>
            [...document.getElementById(id).children].map(row => row.dataset.key))),
    [['registration_enabled', 'ratelimit_enabled'], ['max_sessions', 'max_sessions_per_user',
        'max_views_per_session', 'session_timeout', 'ssh_connect_ratelimit', 'login_ratelimit']]);
    check('§7 a switch sits at the right of its row, after its words', await page.evaluate(() =>
        [...document.querySelectorAll('#systemSwitches > .sv-row')].map(row => {
            const r = row.getBoundingClientRect();
            const sw = row.querySelector('.sv-switch').getBoundingClientRect();
            const text = row.querySelector('.sv-text').getBoundingClientRect();
            return [r.right - sw.right <= 24, text.right <= sw.left];
        })), [[true, true], [true, true]]);
    check('§7 the switches, the limits and the buttons are spaced as the section is (14 px)', await page.evaluate(() => {
        const r = id => document.getElementById(id).getBoundingClientRect();
        const foot = document.getElementById('systemSave').closest('.sv-form-foot').getBoundingClientRect();
        return [Math.round(r('systemLimits').top - r('systemSwitches').bottom), Math.round(foot.top - r('systemLimits').bottom)];
    }), [14, 14]);
    const equals = () => page.textContent('[data-key="session_timeout"] .sv-equals');
    check('§7 the timeout says what its seconds are', await equals(), '= 24 hours');
    check('§7 "changed" marks only what differs from the deployment, and the hint names the default',
        await page.evaluate(() => [...document.querySelectorAll('#systemForm .sv-changed')]
            .map(node => node.closest('[data-key]').dataset.key)
            .concat(document.querySelector('[data-key="ssh_connect_ratelimit"] .sv-hint').textContent)),
        ['ssh_connect_ratelimit', `${await say(page, 'admin.set.ssh_connect_ratelimitHint')} ${
            await say(page, 'admin.defaultValue', { value: `10 ${await say(page, 'admin.per_minute')}` })}`]);
    const saveOff = () => page.evaluate(() => document.getElementById('systemSave').disabled);
    check('§7 Save is off while nothing changed', await saveOff(), true);
    await page.fill('#sys-max_sessions', '120');
    const on = await saveOff();
    await page.fill('#sys-max_sessions', '100');
    check('§7 ...on after an edit, off again when it is put back', [on, await saveOff()], [false, true]);
    await page.fill('#sys-session_timeout', '5400');
    check('§7 the timeout\'s words follow its field', await equals(), '= 1 hour 30 minutes');

    await page.fill('#sys-max_sessions', '0');
    await page.click('#systemSave');
    check('§7 a value out of range is said by its field, nothing is sent',
        [await page.textContent('#sys-max_sessionsError'), await page.textContent('#systemStatus'),
            await page.evaluate(() => document.activeElement?.id), api.count('POST', '/admin/api/settings')],
        [await say(page, 'admin.between', { min: 1, max: 1000 }), await say(page, 'admin.notSaved'),
            'sys-max_sessions', 0]);
    await page.fill('#sys-max_sessions', '120');
    await page.fill('#sys-session_timeout', '3600');
    await page.selectOption('#sys-ssh_connect_ratelimit-unit', 'hour');
    await page.click('#systemSave');
    await settle(page);
    check('§7 Save sends only what changed, in the API\'s shape',
        api.posts().at(-1).body, { max_sessions: '120', session_timeout: '3600', ssh_connect_ratelimit: '60 per hour' });
    check('§7 ...the answer redraws: saved, Save off, the changed rows marked, no error left',
        [await page.textContent('#systemStatus'), await saveOff(), await page.evaluate(() =>
            [...document.querySelectorAll('#systemForm .sv-changed')].map(n => n.closest('[data-key]').dataset.key)),
        await page.textContent('#sys-max_sessionsError')],
        [await say(page, 'admin.settingsSaved'), true,
            ['max_sessions', 'session_timeout', 'ssh_connect_ratelimit'], '']);

    api.refuse('POST', '/admin/api/settings', 400, { errors: { login_ratelimit: 'expected "<count> per second|minute|hour"' },
        settings: SETTINGS });
    await page.fill('#sys-login_ratelimit', '7');
    await page.click('#systemSave');
    await settle(page);
    check('§7 the server\'s reason is shown by its field, the edit kept, Save still on',
        [await page.textContent('#sys-login_ratelimitError'), await page.getAttribute('#sys-login_ratelimit', 'aria-invalid'),
            await page.textContent('#systemStatus'), await page.inputValue('#sys-login_ratelimit'), await saveOff()],
        ['expected "<count> per second|minute|hour"', 'true', await say(page, 'admin.notSaved'), '7', false]);
    const reads = api.count('GET', '/admin/api/settings');
    await page.click('.sv-nav-item[data-section="users"]');
    await page.click('.sv-nav-item[data-section="system"]');
    await settle(page);
    check('§7 an unsaved edit survives leaving the section, and is not fetched over',
        [await page.inputValue('#sys-login_ratelimit'), api.count('GET', '/admin/api/settings')], ['7', reads]);

    await page.click('#systemReset');
    check('§7 Reset asks first, in the app\'s dialog', [await confirmState(page), api.posts().length],
        [{ title: await say(page, 'admin.resetTitle'), body: await say(page, 'admin.resetBody'),
            accept: await say(page, 'admin.resetAccept') }, 2]);
    await page.click('#sessionConfirmAccept');
    await settle(page);
    check('§7 ...and accepted, resets everything and redraws from the answer',
        [api.posts().at(-1).body, await page.inputValue('#sys-login_ratelimit'),
            await page.inputValue('#sys-ssh_connect_ratelimit'), await page.evaluate(() =>
                document.querySelectorAll('#systemForm .sv-changed').length), await saveOff()],
        [{ reset: 'all' }, '5', '10', 0, true]);
    check('§7 the browser\'s confirm() was never used', await page.evaluate(() => window.__confirms), 0);
});

// ── §8 the reader's language ────────────────────────────────────────────────
await withContext('§8', async (ctx) => {
    const { page } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('users'));
    await page.waitForSelector('#usersList > .sv-arow');
    await page.evaluate(() => i18n.setLanguage('vi'));
    await settle(page);
    const row = await page.evaluate(() => {
        const r = document.querySelector('#usersList .sv-arow[data-user-id="1"]');
        return [r.querySelector('.sv-arow-meta').textContent, r.querySelector('.sv-arow-chips .sv-chip').textContent];
    });
    const viDate = await page.evaluate(() => new Date('2026-10-05T08:50:25Z').toLocaleString('vi',
        { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    check('§8 a new language rewords the rows and writes their dates its way, one separator throughout',
        [row[1], row[0].includes(viDate), viDate.includes('15:50'), /\d-\d/.test(row[0])],
        [await say(page, 'admin.roleAdmin'), true, true, false]);
    check('§8 ...in Vietnamese, not English', row[1] === 'Admin' || row[1] === 'Administrator', false);
});

// ── §9 phone and tablet ─────────────────────────────────────────────────────
await withContext('§9 phone', async (ctx) => {
    const { page, api } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('users'));
    await page.waitForSelector('#usersList > .sv-arow');
    const column = await menuColumn(page, '#usersList');
    check('§9 phone: no avatar, the ⋮ column 44 px and on one line, own row empty',
        [await page.evaluate(() => getComputedStyle(document.querySelector('.sv-avatar')).display),
            column.map(c => c.menu), column[0].width, ...aligned(column)],
        ['none', [false, true, true], 44, true, true, true, true, true]);
    const clipped = (list) => page.evaluate(sel => [...document.querySelectorAll(`${sel} > .sv-arow`)]
        .flatMap(row => [...row.querySelectorAll('.sv-arow-title, .sv-arow-meta')])
        .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent), list);
    check('§9 phone: names and their dates are whole, not cut', await clipped('#usersList'), []);
    await page.tap('#usersList .sv-arow[data-user-id="2"] .sv-row-menu');
    const sheet = await menuState(page);
    const rect = await page.evaluate(() => {
        const r = document.querySelector('#settingsView .sv-menu').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.width), Math.round(r.bottom),
            Math.min(...[...document.querySelectorAll('#settingsView .sv-menu-item')]
                .map(b => Math.round(b.getBoundingClientRect().height)))];
    });
    check('§9 phone: the ⋮ opens a sheet along the bottom, named after the account, over a backdrop',
        [sheet.sheet, sheet.title, sheet.backdrop, rect], [true, 'alice', true, [0, 390, 844, 44]]);
    check('§9 phone: the backdrop covers the list, the sheet is over it', await page.evaluate(() => {
        const item = document.querySelector('#settingsView .sv-menu-item').getBoundingClientRect();
        return [document.elementFromPoint(195, 120)?.className,
            document.elementFromPoint(item.left + 20, item.top + item.height / 2)?.classList.contains('sv-menu-item')];
    }), ['sv-menu-backdrop', true]);
    await page.tap('#settingsView .sv-menu-backdrop', { position: { x: 195, y: 120 } });
    check('§9 phone: a tap on the backdrop closes it, nothing done',
        [await menuState(page), api.posts().length], [null, 0]);

    const targets = {
        users: ['#addUserBtn', '#usersList .sv-row-menu'],
        sessions: ['#sessionsRefresh', '#sessionsList .sv-row-menu'],
        audit: ['#auditSearch', '#auditLevel', '#auditPrev', '#auditNext'],
        system: ['#sys-max_sessions', '#sys-ssh_connect_ratelimit', '#sys-ssh_connect_ratelimit-unit',
            '#systemReset', '#systemSave', '#systemSwitches > .sv-row'],
    };
    const small = [];
    const fields = [];
    const wide = [];
    const switches = [];
    let sessionsClipped = [];
    let logChips = [];
    for (const [section, selectors] of Object.entries(targets)) {
        await page.evaluate(s => SettingsView.open(s), section);
        await settle(page, 200);
        if (section === 'users') await page.tap('#addUserBtn');
        const found = await page.evaluate(sels => sels.flatMap(sel => [...document.querySelectorAll(sel)].map(node => {
            const r = node.getBoundingClientRect();
            return { sel, h: Math.round(r.height), w: Math.round(r.width) };
        })), section === 'users' ? [...selectors, '#newUsername', '#newPassword', '#addUserSubmit'] : selectors);
        small.push(...found.filter(f => f.h < 44 || f.w < 44).map(f => `${section} ${f.sel} ${f.w}x${f.h}`));
        switches.push(...await page.evaluate(() => [...document.querySelectorAll('#settingsView .sv-section:not([hidden]) .sv-switch')]
            .map(sw => [sw.id, Math.round(sw.getBoundingClientRect().width), Math.round(sw.getBoundingClientRect().height),
                Math.round(sw.closest('.sv-row').getBoundingClientRect().height)])
            .filter(([, w, h, row]) => w !== 38 || h !== 22 || row < 44)));
        if (section === 'sessions') sessionsClipped = await clipped('#sessionsList');
        if (section === 'audit') {
            // A stretched box stretches its scrollWidth too: measure the words.
            logChips = await page.evaluate(() => [...document.querySelectorAll('#auditList .sv-level')]
                .filter(chip => {
                    const words = document.createRange();
                    words.selectNodeContents(chip);
                    return chip.getBoundingClientRect().width > words.getBoundingClientRect().width + 24;
                }).map(chip => chip.textContent));
        }
        fields.push(...await page.evaluate(() => [...document.querySelectorAll('#settingsView .sv-section:not([hidden]) :is(input.sv-input, select.sv-select)')]
            .filter(node => parseFloat(getComputedStyle(node).fontSize) < 16).map(node => node.id)));
        wide.push(...await page.evaluate((s) => {
            const scroller = document.querySelector('#settingsView .sv-scroll');
            const out = scroller.scrollWidth > scroller.clientWidth ? [`${s}: scrolls sideways`] : [];
            return out.concat([...document.querySelectorAll('#settingsView .sv-section:not([hidden]) *')]
                .filter(node => node.getBoundingClientRect().right > window.innerWidth + 0.5 && node.getClientRects().length)
                .map(node => `${s}: ${node.id || node.className}`));
        }, section));
    }
    check('§9 phone: every control is a 44 px target', small, []);
    check('§9 phone: a switch keeps its 38x22 track inside a 44 px row', switches, []);
    check('§9 phone: the sessions\' targets and activity are whole, not cut', sessionsClipped, []);
    check('§9 phone: a level chip is as wide as its word', logChips, []);
    check('§9 phone: every field is at least 16 px, so iOS does not zoom', fields, []);
    check('§9 phone: nothing is wider than the screen', wide, []);
}, PHONE);

await withContext('§9 tablet', async (ctx) => {
    const { page } = await openPage(ctx);
    await page.evaluate(() => SettingsView.open('users'));
    await page.waitForSelector('#usersList > .sv-arow');
    const column = await menuColumn(page, '#usersList');
    check('§9 tablet: avatars kept, the ⋮ column 44 px for a finger, on one line',
        [await page.evaluate(() => getComputedStyle(document.querySelector('.sv-avatar')).display),
            column[0].width, ...aligned(column)], ['grid', 44, true, true, true, true, true]);
    await page.tap('#usersList .sv-arow[data-user-id="2"] .sv-row-menu');
    check('§9 tablet: a popover, not a sheet, with 44 px items', [(await menuState(page)).sheet,
        await page.evaluate(() => Math.min(...[...document.querySelectorAll('#settingsView .sv-menu-item')]
            .map(b => Math.round(b.getBoundingClientRect().height))))], [false, 44]);
}, TABLET);

// ── §10 not an administrator ────────────────────────────────────────────────
await withContext('§10', async (ctx) => {
    const { page, api } = await openPage(ctx, { role: 'user' });
    await page.evaluate(() => SettingsView.open());
    await settle(page, 300);
    check('§10 a user\'s page has no administration: no sections, no script, nothing fetched',
        await page.evaluate(() => [['sv-users', 'sv-sessions', 'sv-audit', 'sv-system']
            .filter(id => document.getElementById(id)),
        document.querySelectorAll('script[src*="settings-admin.js"]').length,
        document.querySelectorAll('.sv-nav-item[data-section="users"]').length]).then(r => r.concat(api.calls.length)),
        [[], 0, 0, 0]);
});

check('§Z no page errors', pageErrors, []);
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
