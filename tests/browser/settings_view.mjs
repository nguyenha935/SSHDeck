#!/usr/bin/env node
/*
 * SETTINGS (settings-view.js, #settingsView) -- owner ruling 2026-10-05: every
 * setting in one place. It replaced the Settings dialog, the theme and
 * language pickers of the account menu and the change-password page; the
 * renderer and the diagnostics in it replaced ?renderer=, ?perf= and
 * ?kbdebug= (administrators only for the diagnostics, the keyboard log off
 * again after an hour).
 *
 * Sections:
 *   §1  the way in and out on a desktop: the account menu, the address
 *       (#settings/<section>), Escape, the close button, Back; focus
 *   §2  on a phone: the whole screen, a list of sections with their values,
 *       a section replaces it, Back goes up one level at a time
 *   §3  a reload or a link at #settings/<section> opens there
 *   §4  nothing under it moves: opening and closing resize no terminal and
 *       send no ssh_resize; what it covers takes no focus
 *   §5  Appearance: a theme applies at once (page, server, cookie, the
 *       radio state), arrows move through the themes; the language select
 *       changes the language and what Settings says
 *   §6  Terminal: defaults and stored values; scrollback and the renderer,
 *       live
 *   §7  Account: the password form checks before sending, words the
 *       server's refusals by field, and clears itself on success
 *   §8  Diagnostics: the probe starts and stops, the attach report is sent
 *       only when on, the keyboard log shows its panel and its deadline and
 *       turns itself off an hour later
 *   §9  a page that is not an administrator's: no Administration group, and
 *       a stored switch does nothing
 *   §10 the old queries in the address do nothing
 *   §11 another tab of this device changes a setting: this one follows
 *   §12 touch: every control a 44 px target, fields 16 px, rows not
 *       squeezed; the keyboard log's panel steps aside
 *   §Z  no page errors
 *
 * Run: node tests/browser/settings_view.mjs   (from source/)
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

/*
 * A socket.io stand-in with what the page and the probe use; attach and
 * resize are answered the way the real server does, so a restored session's
 * terminal is drawn. ModalManager is the app's own.
 */
const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {}; window.__any = []; window.__anyOut = [];
    const geometry = (p) => setTimeout(() => window.__server('tmux_window_geometry',
        { session_id: p.session_id, cols: p.cols, rows: p.rows }), 10);
    window.socket = {
        connected: true, connect: noop, off: noop,
        io: { on: noop, engine: { transport: { name: 'websocket' } } },
        on: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        once: (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); },
        onAny: (fn) => window.__any.push(fn),
        onAnyOutgoing: (fn) => window.__anyOut.push(fn),
        offAny: (fn) => { window.__any = window.__any.filter(f => f !== fn); },
        offAnyOutgoing: (fn) => { window.__anyOut = window.__anyOut.filter(f => f !== fn); },
        emit: (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            window.__anyOut.forEach(fn => fn(ev, payload));
            if (ev === 'view_attach') {
                setTimeout(() => window.__server('view_attached', { session_id: payload.session_id }), 10);
                geometry(payload);
            }
            if (ev === 'ssh_resize') geometry(payload);
            if (typeof ack === 'function') setTimeout(() => ack({ ok: true }), 30);
        },
    };
    window.io = () => window.socket;
    window.__server = (ev, payload) => {
        window.__any.forEach(fn => fn(ev, payload));
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const S1 = 'aaaa1111-sets-4aaa-8aaa-000000000001';
const snapshot = {
    snapshot_version: 1, session_id: S1, host: 'tiny.example', port: 22, username: 'u',
    connected: true, auth_type: 'password', key_id: null, via_jump: null,
    use_tmux: true, tmux_session_name: 'one', display_name: 'tiny',
    pane_index: null, replay_total_chunks: 0, replay_truncated: false,
    replay_dropped_bytes: 0, replay_history_lines: 0, legacy_tmux_locale: null,
};

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const pageErrors = [];
// `stored` is what this device's localStorage held before the page loaded.
async function openPage(ctx, { query = '', hash = '', stored = {}, clock = false } = {}) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.route('**/socket.io.min.js*',
        r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.addInitScript((values) => {
        if (sessionStorage.getItem('__seeded')) return;
        sessionStorage.setItem('__seeded', '1');
        Object.entries(values).forEach(([k, v]) => localStorage.setItem(k, v));
    }, stored);
    if (clock) await page.clock.install();
    await page.goto(`${base}/${query}${hash}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && typeof SettingsView !== 'undefined',
    null, { timeout: 15000 });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
    return page;
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
const fire = (page, ev, payload) => page.evaluate(([e, p]) => window.__server(e, p), [ev, payload]);
async function restore(page) {
    await fire(page, 'ssh_session_restored', snapshot);
    await fire(page, 'connect', null);
    await page.waitForTimeout(1200);
}
const state = (page) => page.evaluate(() => {
    const view = document.getElementById('settingsView');
    const current = view.querySelector('.sv-nav-item[aria-current="page"]');
    const shown = [...view.querySelectorAll('.sv-section')].filter(s => !s.hidden).map(s => s.dataset.section);
    return {
        open: !view.hidden && getComputedStyle(view).display !== 'none',
        hash: location.hash,
        section: current ? current.dataset.section : null,
        shown,
        inSection: view.classList.contains('sv-in-section'),
        title: document.getElementById('settingsSectionTitle').textContent,
    };
});
const focusInView = (page) => page.evaluate(() =>
    document.getElementById('settingsView').contains(document.activeElement));
async function openFromMenu(page) {
    await page.click('#accountBtnHeader');
    await page.click('#settingsBtn');
}
async function openSection(page, section) {
    await page.evaluate((s) => SettingsView.open(s), section);
}
// Whether Settings is what is painted on top at each point. An inert element
// drops out of hit testing, so a header painted OVER the view would be looked
// straight through: inert is lifted for the reading only, then put back.
const onTop = (page, points) => page.evaluate((pts) => {
    const inert = [...document.querySelectorAll('[inert]')];
    inert.forEach(el => el.removeAttribute('inert'));
    const hits = pts.map(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#settingsView'));
    inert.forEach(el => el.setAttribute('inert', ''));
    return hits;
}, points);

// ── §1 desktop ──────────────────────────────────────────────────────────────
await withContext('§1', async (ctx) => {
    const page = await openPage(ctx, { stored: { 'sshdeck.settings.section': 'terminal' } });
    check('§1 closed at load', (await state(page)).open, false);
    await page.click('#accountBtnHeader');
    check('§1 the account menu has Settings and no theme, language or password rows',
        await page.evaluate(() => [!!document.getElementById('settingsBtn'),
            ['themeExpanderHeader', 'langExpanderHeader', 'changePasswordBtn']
                .filter(id => document.getElementById(id))]), [true, []]);
    await page.click('#settingsBtn');
    let s = await state(page);
    check('§1 Settings opens at the section used last, and says so in the address and the title',
        [s.open, s.section, s.shown, s.hash, s.title], [true, 'terminal', ['terminal'], '#settings/terminal', 'Terminal']);
    check('§1 ...the menu closed behind it, and focus is in the view', [await page.evaluate(() =>
        document.getElementById('accountDropdownHeader').classList.contains('show')), await focusInView(page)],
    [false, true]);
    check('§1 ...it covers the workspace and leaves the header on top',
        await onTop(page, [[720, 500], [720, 20]]), [true, false]);
    await page.click('.sv-nav-item[data-section="account"]');
    s = await state(page);
    check('§1 a section from the list replaces the one shown, address included',
        [s.section, s.shown, s.hash], ['account', ['account'], '#settings/account']);
    await page.keyboard.press('Escape');
    s = await state(page);
    check('§1 Escape closes it and takes the address back',
        [s.open, s.hash, await page.evaluate(() => document.activeElement?.id)], [false, '', 'accountBtnHeader']);
    await openFromMenu(page);
    check('§1 opened again, it is where it was left', (await state(page)).section, 'account');
    await page.click('.sv-main .sv-close');
    check('§1 the close button closes it', (await state(page)).open, false);
    await openFromMenu(page);
    await page.goBack();
    await page.waitForTimeout(150);
    s = await state(page);
    check('§1 Back closes it, and stays on the page', [s.open, s.hash, page.url().startsWith(base)], [false, '', true]);
});

// ── §2 phone ────────────────────────────────────────────────────────────────
await withContext('§2', async (ctx) => {
    const page = await openPage(ctx);
    await page.tap('#mobileMoreBtn');
    await page.waitForTimeout(200);
    await page.tap('#settingsBtn');
    await page.waitForTimeout(200);
    let s = await state(page);
    const geo = await page.evaluate(() => {
        const r = document.getElementById('settingsView').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });
    check('§2 on a phone it takes the whole screen and opens on the list',
        [s.open, s.inSection, s.hash, geo], [true, false, '#settings', [0, 0, 390, 844]]);
    check('§2 ...the list says what each section is set to', await page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll('.sv-nav-value')].map(v => [v.dataset.value, v.textContent]))),
    { appearance: 'Glass Ops · English', terminal: '5000 lines · Standard', account: 'pwuser', diagnostics: 'Off' });
    check('§2 ...and covers the header and the dock',
        await onTop(page, [[20, 20], [200, 830]]), [true, true]);
    await page.tap('.sv-nav-item[data-section="terminal"]');
    s = await state(page);
    check('§2 a section replaces the list', [s.inSection, s.shown, s.hash, s.title],
        [true, ['terminal'], '#settings/terminal', 'Terminal']);
    await page.goBack();
    await page.waitForTimeout(150);
    s = await state(page);
    check('§2 Back goes up to the list, not out', [s.open, s.inSection, s.hash], [true, false, '#settings']);
    await page.tap('.sv-nav-item[data-section="account"]');
    await page.tap('.sv-main .sv-back');
    s = await state(page);
    check('§2 the back button does the same', [s.open, s.inSection], [true, false]);
    await page.goBack();
    await page.waitForTimeout(150);
    check('§2 Back from the list closes it', [(await state(page)).open, page.url().startsWith(base)], [false, true]);
}, PHONE);

// ── §3 arriving at an address ───────────────────────────────────────────────
await withContext('§3', async (ctx) => {
    const page = await openPage(ctx, { hash: '#settings/account' });
    let s = await state(page);
    check('§3 a page loaded at #settings/account opens there', [s.open, s.section, s.hash], [true, 'account', '#settings/account']);
    await page.goBack();
    await page.waitForTimeout(150);
    s = await state(page);
    check('§3 ...and Back closes it on the same page', [s.open, s.hash, page.url().startsWith(base)], [false, '', true]);
    const other = await openPage(ctx, { hash: '#settings/nowhere' });
    s = await state(other);
    check('§3 an unknown section opens where Settings was left (account, above)', [s.open, s.section],
        [true, 'account']);
});

// ── §4 nothing under it moves ───────────────────────────────────────────────
for (const [label, options] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await withContext(`§4 ${label}`, async (ctx) => {
        const page = await openPage(ctx);
        await restore(page);
        const before = await page.evaluate((id) => {
            const t = TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]];
            window.__emits.length = 0;
            return [t.cols, t.rows];
        }, S1);
        await openSection(page, 'terminal');
        await page.waitForTimeout(400);
        const covered = await page.evaluate(() => {
            const t = document.querySelector('.xterm-helper-textarea');
            t?.focus();
            return document.activeElement === t;
        });
        await page.evaluate(() => SettingsView.close());
        await page.waitForTimeout(400);
        const after = await page.evaluate((id) => {
            const t = TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]];
            return { grid: [t.cols, t.rows], resizes: window.__emits.filter(e => e.ev === 'ssh_resize').length };
        }, S1);
        check(`§4 ${label}: opening and closing leave the terminal's grid and send no ssh_resize`,
            [after.grid, after.resizes], [before, 0]);
        check(`§4 ${label}: while open, the terminal under it takes no focus`, covered, false);
    }, options);
}

// ── §5 appearance ───────────────────────────────────────────────────────────
await withContext('§5', async (ctx) => {
    const page = await openPage(ctx);
    await openSection(page, 'appearance');
    check('§5 ten themes, the page\'s own checked', await page.evaluate(() => {
        const options = [...document.querySelectorAll('#themeOptions .sv-theme')];
        return [options.length, options.filter(o => o.getAttribute('aria-checked') === 'true').map(o => o.dataset.themeId)];
    }), [10, ['glass']]);
    // A light swatch on a light card vanishes without its outline, and the
    // outline comes from the theme's border token, not a fixed grey.
    check('§5 a light theme\'s swatch is outlined, a dark one is not, and both carry their colour',
        await page.evaluate(() => {
            const read = id => getComputedStyle(
                document.querySelector(`.sv-theme[data-theme-id="${id}"] .sv-swatch`));
            const paper = read('paper');
            const noir = read('noir');
            return [paper.boxShadow !== 'none', noir.boxShadow,
                paper.backgroundColor !== noir.backgroundColor,
                [paper.backgroundColor, noir.backgroundColor].every(c => c !== 'rgba(0, 0, 0, 0)')];
        }), [true, 'none', true, true]);
    // The palette reaches xterm only through applyThemeToAll, which reads
    // --term-* out of CSS; without it the page themes and the terminals do not.
    await page.evaluate(() => {
        window.__repaints = 0;
        const repaint = TerminalManager.applyThemeToAll.bind(TerminalManager);
        TerminalManager.applyThemeToAll = () => { window.__repaints += 1; return repaint(); };
    });
    await page.click('.sv-theme[data-theme-id="paper"]');
    check('§5 a theme applies at once: page, terminals, server, cookie, the radio state',
        await page.evaluate(() => [
            document.body.dataset.theme,
            window.__repaints,
            window.__emits.filter(e => e.ev === 'set_theme').map(e => e.payload.theme),
            document.cookie.includes('theme=paper'),
            document.querySelector('.sv-theme[aria-checked="true"]').dataset.themeId,
            document.activeElement?.dataset.themeId,
        ]), ['paper', 1, ['paper'], true, 'paper', 'paper']);
    await page.keyboard.press('ArrowRight');
    check('§5 an arrow key moves to the next theme', await page.evaluate(() =>
        [document.body.dataset.theme, document.activeElement?.dataset.themeId]), ['noir', 'noir']);
    await page.selectOption('#languageSelect', 'vi');
    await page.waitForFunction(() => window.i18n.getLanguage() === 'vi');
    await page.waitForTimeout(300);
    // The theme group is not named like the section that holds it.
    check('§5 the language select changes the language and what Settings says', await page.evaluate(() => [
        document.getElementById('settingsViewTitle').textContent,
        document.getElementById('settingsSectionTitle').textContent,
        document.querySelector('.sv-nav-value[data-value="appearance"]').textContent,
        document.getElementById('themeOptionsLabel').textContent,
    ]), ['Cài đặt', 'Giao diện', 'Noir Terminal · Tiếng Việt', 'Chủ đề']);
});

// ── §6 terminal ─────────────────────────────────────────────────────────────
const controls = (page) => page.evaluate(() => {
    const value = (id, prop = 'value') => {
        const el = document.getElementById(id);
        return el ? el[prop] : null;
    };
    return {
        scrollback: value('scrollbackInput'),
        renderer: value('rendererSelect'),
        perf: value('perfProbeToggle', 'checked'),
        attach: value('attachReportToggle', 'checked'),
        keyboard: value('keyboardLogToggle', 'checked'),
        keyboardState: value('keyboardLogState', 'textContent'),
    };
});
await withContext('§6', async (ctx) => {
    let page = await openPage(ctx);
    check('§6 defaults: 5000 lines, Standard, every diagnostic off', await controls(page),
        { scrollback: '5000', renderer: 'dom', perf: false, attach: false, keyboard: false, keyboardState: '' });
    await page.close();
    const until = Date.now() + 30 * 60 * 1000;
    page = await openPage(ctx, { stored: {
        terminalScrollback: '2000', 'sshdeck.renderer': 'webgl', 'sshdeck.perf': '1',
        'sshdeck.attachReport': '1', 'sshdeck.keyboardLogUntil': String(until),
    } });
    const shown = await controls(page);
    const hhmm = await page.evaluate((t) => new Date(t).toLocaleTimeString(window.i18n.currentLang,
        { hour: '2-digit', minute: '2-digit' }), until);
    check('§6 what the device stored is what Settings shows, before it is opened',
        [shown.scrollback, shown.renderer, shown.perf, shown.attach, shown.keyboard], ['2000', 'webgl', true, true, true]);
    check('§6 ...with the time the keyboard log turns itself off', shown.keyboardState.includes(hhmm), true);
    await page.close();
    page = await openPage(ctx, { stored: { 'sshdeck.renderer': 'dom', terminalScrollback: '5000' } });
    await page.evaluate(() => localStorage.removeItem('sshdeck.renderer'));
    await restore(page);
    await openSection(page, 'terminal');
    await page.fill('#scrollbackInput', '3000');
    await page.press('#scrollbackInput', 'Tab');
    check('§6 a new scrollback reaches the open terminal and is stored', await page.evaluate((id) =>
        [TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]].options.scrollback,
            localStorage.getItem('terminalScrollback')], S1), [3000, '3000']);
    await page.selectOption('#rendererSelect', 'webgl');
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'webgl');
    check('§6 choosing WebGL switches the open terminal and is stored', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), localStorage.getItem('sshdeck.renderer')]), ['webgl', 'webgl']);
    await page.selectOption('#rendererSelect', 'dom');
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'dom');
    check('§6 choosing Standard switches it back and forgets', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), localStorage.getItem('sshdeck.renderer')]), ['dom', null]);
});

// ── §7 account ──────────────────────────────────────────────────────────────
await withContext('§7', async (ctx) => {
    const page = await openPage(ctx);
    const sent = [];
    let reply = { status: 400, body: { field: 'current_password', error: 'incorrect' } };
    await page.route('**/api/account/password', async (route) => {
        sent.push({ body: route.request().postDataJSON(), csrf: route.request().headers()['x-csrftoken'] !== undefined });
        await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    });
    await openSection(page, 'account');
    const errors = () => page.evaluate(() => ['currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput']
        .map(id => [document.getElementById(`${id}Error`).textContent,
            document.getElementById(id).getAttribute('aria-invalid')]));
    await page.click('#changePasswordSubmit');
    check('§7 empty: the current password is required and the new one too short, nothing sent',
        [await errors(), sent.length],
        [[['Required', 'true'], ['At least 8 characters', 'true'], ['', 'false']], 0]);
    await page.fill('#currentPasswordInput', 'old-password');
    await page.fill('#newPasswordInput', 'new-password-1');
    await page.fill('#confirmPasswordInput', 'new-password-2');
    await page.click('#changePasswordSubmit');
    check('§7 two different new passwords: refused before sending',
        [(await errors())[2], sent.length], [['The two new passwords are not the same', 'true'], 0]);
    await page.fill('#confirmPasswordInput', 'new-password-1');
    await page.click('#changePasswordSubmit');
    await page.waitForTimeout(200);
    check('§7 the server\'s refusal lands on its field', [(await errors())[0], sent.length, sent[0]?.csrf,
        await page.evaluate(() => document.activeElement?.id)],
    [['The current password is not right', 'true'], 1, true, 'currentPasswordInput']);
    reply = { status: 429, body: { error: 'rate_limited' } };
    await page.click('#changePasswordSubmit');
    await page.waitForTimeout(200);
    check('§7 too many attempts is said under the form', await page.evaluate(() =>
        document.getElementById('changePasswordStatus').textContent),
    'Too many attempts. Wait a minute and try again.');
    reply = { status: 200, body: { ok: true } };
    await page.click('#changePasswordSubmit');
    await page.waitForTimeout(200);
    check('§7 changed: the fields are cleared and it says so', await page.evaluate(() => [
        ['currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput'].map(id => document.getElementById(id).value),
        document.getElementById('changePasswordStatus').textContent,
        document.getElementById('changePasswordStatus').classList.contains('is-ok'),
    ]), [['', '', ''], 'Password changed.', true]);
    check('§7 what was sent', sent[sent.length - 1].body,
        { current_password: 'old-password', new_password: 'new-password-1', confirm_password: 'new-password-1' });
    await page.click('.sv-reveal[data-reveal="newPasswordInput"]');
    check('§7 the eye shows the password', await page.evaluate(() =>
        [document.getElementById('newPasswordInput').type,
            document.querySelector('.sv-reveal[data-reveal="newPasswordInput"]').getAttribute('aria-pressed')]),
    ['text', 'true']);
});

// ── §8 diagnostics ──────────────────────────────────────────────────────────
const attachReports = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'kbdebug_log' && e.payload.lines.some(l => l.startsWith('attach-report'))).length);
await withContext('§8 probe', async (ctx) => {
    const page = await openPage(ctx);
    await openSection(page, 'diagnostics');
    await page.check('#perfProbeToggle');
    check('§8 the performance probe starts when switched on, and is stored', await page.evaluate(() =>
        [typeof window.SSHDeckPerf?.flush, window.__any.length, localStorage.getItem('sshdeck.perf'),
            document.querySelector('.sv-nav-value[data-value="diagnostics"]').textContent]),
    ['function', 1, '1', '1 on']);
    await page.uncheck('#perfProbeToggle');
    check('§8 ...and stops when switched off', await page.evaluate(() =>
        [typeof window.SSHDeckPerf, window.__any.length, localStorage.getItem('sshdeck.perf')]),
    ['undefined', 0, null]);
});
await withContext('§8 attach off', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await page.waitForTimeout(2800);
    check('§8 with the attach report off, attaching a session sends none', await attachReports(page), 0);
});
await withContext('§8 attach on', async (ctx) => {
    const page = await openPage(ctx);
    await openSection(page, 'diagnostics');
    await page.check('#attachReportToggle');
    await page.evaluate(() => SettingsView.close());
    await restore(page);
    await page.waitForTimeout(2800);
    check('§8 with it on, the first attach sends one report', await attachReports(page), 1);
});
await withContext('§8 keyboard', async (ctx) => {
    const page = await openPage(ctx, { clock: true });
    await restore(page);
    await openSection(page, 'diagnostics');
    await page.check('#keyboardLogToggle');
    const on = await page.evaluate(() => ({
        until: Number(localStorage.getItem('sshdeck.keyboardLogUntil')) - Date.now(),
        text: document.getElementById('keyboardLogState').textContent,
    }));
    check('§8 the keyboard log is stored with a deadline an hour away, and Settings says when it ends',
        [on.until > 59 * 60 * 1000 && on.until <= 60 * 60 * 1000, /\d/.test(on.text)], [true, true]);
    await page.evaluate(() => SettingsView.close());
    check('§8 closed, the panel and the screen-diagnostic button are there', await page.evaluate(() =>
        [!!document.getElementById('kbdebugPanel'), !!document.getElementById('screenDiagnosticBtn')]),
    [true, true]);
    await page.clock.fastForward(59 * 60 * 1000);
    check('§8 59 minutes later it is still on', await page.evaluate(() => DeviceSettings.keyboardLog()), true);
    await page.clock.fastForward(2 * 60 * 1000);
    check('§8 an hour later it is off: panel, button, switch and storage', await page.evaluate(() =>
        [DeviceSettings.keyboardLog(), !!document.getElementById('kbdebugPanel'),
            !!document.getElementById('screenDiagnosticBtn'),
            document.getElementById('keyboardLogToggle').checked,
            localStorage.getItem('sshdeck.keyboardLogUntil')]), [false, false, false, false, null]);
});

// ── §9 not an administrator ─────────────────────────────────────────────────
await withContext('§9', async (ctx) => {
    const page = await openPage(ctx, { query: '?role=user', stored: {
        'sshdeck.perf': '1', 'sshdeck.attachReport': '1',
        'sshdeck.keyboardLogUntil': String(Date.now() + 30 * 60 * 1000),
    } });
    await restore(page);
    await page.waitForTimeout(2800);
    await openSection(page, 'diagnostics');
    check('§9 no Administration group: Settings opens on what there is', await page.evaluate(() => [
        [...document.querySelectorAll('.sv-nav-item')].map(i => i.dataset.section || i.getAttribute('href')),
        ['perfProbeToggle', 'attachReportToggle', 'keyboardLogToggle', 'sv-diagnostics', 'adminPanelBtn']
            .filter(id => document.getElementById(id)),
        SettingsView.section,
    ]), [['appearance', 'terminal', 'account'], [], 'appearance']);
    check('§9 what is stored on the device switches nothing on, and sends nothing', await page.evaluate(() =>
        [DeviceSettings.isAdmin(), DeviceSettings.perf(), DeviceSettings.attachReport(),
            DeviceSettings.keyboardLog(), typeof window.SSHDeckPerf,
            !!document.getElementById('kbdebugPanel'),
            window.__emits.filter(e => ['kbdebug_log', 'perf_report'].includes(e.ev)).length]),
    [false, false, false, false, 'undefined', false, 0]);
});

// ── §10 the old queries ─────────────────────────────────────────────────────
await withContext('§10', async (ctx) => {
    const page = await openPage(ctx, { query: '?renderer=webgl&perf=1&kbdebug=1' });
    await restore(page);
    check('§10 ?renderer=webgl&perf=1&kbdebug=1 switches nothing on and stores nothing', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), typeof window.SSHDeckPerf, !!document.getElementById('kbdebugPanel'),
            ['sshdeck.renderer', 'sshdeck.perf', 'sshdeck.keyboardLogUntil']
                .filter(k => localStorage.getItem(k) !== null)]), ['dom', 'undefined', false, []]);
});

// ── §11 another tab ─────────────────────────────────────────────────────────
await withContext('§11', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await openSection(page, 'terminal');
    const other = await openPage(ctx);
    await other.evaluate(() => DeviceSettings.setRenderer('webgl'));
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'webgl');
    check('§11 a renderer chosen in another tab applies here, and Settings shows it', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), document.getElementById('rendererSelect').value]), ['webgl', 'webgl']);
    await other.evaluate(() => DeviceSettings.setKeyboardLog(true));
    await page.waitForFunction(() => document.getElementById('keyboardLogToggle').checked);
    check('§11 ...and so does the keyboard log', await page.evaluate(() =>
        !!document.getElementById('kbdebugPanel')), true);
});

// ── §13 over the expanded Files browser ─────────────────────────────────────
// Both hold one history entry while open, and both listen for popstate. Opened
// over the browser, Settings' entry sits above the browser's: one Back, or
// Escape (which gives the entry back with history.back()), must close Settings
// and leave the browser as it was.
await withContext('§13', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await page.evaluate(() => {
        window.openFileManager();
        const fm = window.sftpFileManager;
        const s = fm.panes.inline;
        if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
        Object.assign(s, { loading: false, error: null, path: '/root', pendingPath: '/root',
            files: [{ name: 'notes.txt', is_dir: false, size: 10, mode: 0o100644,
                modified: 1759390000, owner: 'root', group: 'root' }] });
        fm.renderPane('inline');
    });
    await page.click('#sftpPanelExpand');
    const expanded = () => page.evaluate(() => window.sftpFileManager.browser.isExpanded());
    check('§13 the Files browser is expanded', await expanded(), true);
    await openFromMenu(page);
    check('§13 Settings opens from the header over it, and is what is on top',
        [(await state(page)).open, ...(await onTop(page, [[720, 500]]))], [true, true]);
    await page.goBack();
    await page.waitForTimeout(200);
    check('§13 one Back closes Settings and leaves the browser expanded',
        [(await state(page)).open, await expanded()], [false, true]);
    await openFromMenu(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('§13 Escape closes Settings and leaves the browser expanded',
        [(await state(page)).open, await expanded()], [false, true]);
    await page.goBack();
    await page.waitForTimeout(200);
    check('§13 ...and the next Back is the browser\'s own again', await expanded(), false);
});

// ── §12 touch ───────────────────────────────────────────────────────────────
for (const [w, h] of [[390, 844], [844, 390], [834, 1194]]) {
    await withContext(`§12 ${w}x${h}`, async (ctx) => {
        const page = await openPage(ctx);
        await page.evaluate(() => DeviceSettings.setKeyboardLog(true));
        const sizes = {};
        let squeezed = [];
        for (const section of ['appearance', 'terminal', 'account', 'diagnostics']) {
            await openSection(page, section);
            const got = await page.evaluate(() => {
                const view = document.getElementById('settingsView');
                const visible = el => el.getClientRects().length > 0;
                const h = el => Math.round(el.getBoundingClientRect().height);
                const out = {};
                const name = el => el.id || el.htmlFor || el.dataset.section || el.dataset.themeId || el.dataset.act
                    || el.dataset.reveal || el.className;
                view.querySelectorAll('button, select, input, label.sv-row').forEach(el => {
                    if (!visible(el) || el.matches('input[type="checkbox"]')) return;
                    out[name(el)] = h(el) >= 44;
                });
                const inputs = [...view.querySelectorAll('select, input:not([type="checkbox"])')].filter(visible);
                const small = inputs.filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(name);
                const tight = [...view.querySelectorAll('.sv-row')].filter(visible).filter(row => {
                    const text = row.querySelector('.sv-text');
                    return text && text.getBoundingClientRect().width < 120;
                }).map(row => row.querySelector('.sv-label')?.textContent);
                return { out, small, tight };
            });
            Object.assign(sizes, got.out);
            squeezed = squeezed.concat(got.small.map(n => `font:${n}`), got.tight.map(n => `row:${n}`));
        }
        const under = Object.entries(sizes).filter(([, ok]) => !ok).map(([k]) => k);
        check(`§12 ${w}x${h} every control is at least 44 px tall`, under, []);
        check(`§12 ${w}x${h} fields are 16 px and no row squeezes its label under 120 px`, squeezed, []);
        check(`§12 ${w}x${h} the keyboard log's panel steps aside while Settings is open`, await page.evaluate(() =>
            getComputedStyle(document.getElementById('kbdebugPanel')).visibility), 'hidden');
        // On touch the app draws a select's arrow as a background image, with
        // room for it on the right. Without it a select reads as a text field.
        check(`§12 ${w}x${h} a select shows its arrow, with room for it`, await page.evaluate(() =>
            ['rendererSelect', 'languageSelect'].map(id => {
                const cs = getComputedStyle(document.getElementById(id));
                return cs.backgroundImage.startsWith('url(') && parseFloat(cs.paddingRight) >= 30;
            })), [true, true]);
    }, { viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
}

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
