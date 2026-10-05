#!/usr/bin/env node
/*
 * SETTINGS (device-settings.js, #settingsModal) -- owner, 2026-10-05: the
 * renderer and the diagnostics were switched on by a query in the address
 * (?renderer=webgl, ?perf=1, ?kbdebug=1), with nothing on screen saying they
 * existed or were on. They are chosen in Settings now, per device; the
 * diagnostics are an administrator's, and the keyboard log -- it records what
 * is typed -- turns itself off after an hour.
 *
 * Sections:
 *   §1  the way in: the account menu on a desktop, the More sheet on a phone;
 *       Settings is an action (the menu closes) and the dialog opens
 *   §2  the dialog shows what is set: defaults, and what the device stored
 *   §3  the renderer: the select switches the open terminal, both ways
 *   §4  the diagnostics: the performance probe starts and stops, the first
 *       attach report is sent only when on, the keyboard log shows its panel
 *       and its deadline
 *   §5  the keyboard log turns itself off an hour later, on screen and in
 *       storage, with nothing typed
 *   §6  a page that is not an administrator's: no Diagnostics, and a stored
 *       switch does nothing
 *   §7  the old queries in the address do nothing
 *   §8  scrollback: what the terminals use, set from the dialog
 *   §9  another tab of this device changes a setting: this one follows
 *   §10 a phone, upright and on its side: every control is a 44 px target,
 *       each checkbox has its text beside it, the number field does not make
 *       iOS zoom, the dialog fits and stays above the keyboard log's panel
 *   §Z  no page errors
 *
 * Run: node tests/browser/settings_panel.mjs   (from source/)
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

const pageErrors = [];
// `stored` is what this device's localStorage held before the page loaded.
async function openPage(ctx, { query = '', stored = {}, clock = false } = {}) {
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
    await page.goto(`${base}/${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && typeof DeviceSettings !== 'undefined',
    null, { timeout: 15000 });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
    return page;
}
async function withContext(label, fn, options = {}) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, options));
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
const dialogOpen = (page) => page.evaluate(() => {
    const m = document.getElementById('settingsModal');
    return m.classList.contains('show') && m.getAttribute('aria-hidden') === 'false'
        && getComputedStyle(m).display !== 'none';
});
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
async function openSettingsFromMenu(page) {
    await page.click('#accountBtnHeader');
    await page.click('#settingsBtn');
}

// ── §1 the way in ───────────────────────────────────────────────────────────
await withContext('§1 desktop', async (ctx) => {
    const page = await openPage(ctx);
    check('§1 the dialog is closed at load', await dialogOpen(page), false);
    await page.click('#accountBtnHeader');
    check('§1 the account menu lists Settings', await page.isVisible('#settingsBtn'), true);
    await page.click('#settingsBtn');
    check('§1 Settings opens the dialog and closes the menu', [await dialogOpen(page),
        await page.evaluate(() => document.getElementById('accountDropdownHeader').classList.contains('show'))],
    [true, false]);
    check('§1 focus moves into the dialog', await page.evaluate(() =>
        document.getElementById('settingsModal').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    check('§1 Escape closes it', await dialogOpen(page), false);
    await openSettingsFromMenu(page);
    await page.click('#closeSettingsModal');
    check('§1 ...and so does its close button', await dialogOpen(page), false);
});
await withContext('§1 phone', async (ctx) => {
    const page = await openPage(ctx);
    await page.tap('#mobileMoreBtn');
    await page.waitForTimeout(200);
    check('§1 phone: Settings is in the More sheet', await page.isVisible('#settingsBtn'), true);
    await page.tap('#settingsBtn');
    await page.waitForTimeout(200);
    check('§1 phone: it opens the dialog', await dialogOpen(page), true);
}, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// ── §2 what is set ──────────────────────────────────────────────────────────
await withContext('§2', async (ctx) => {
    let page = await openPage(ctx);
    check('§2 defaults: 5000 lines, Standard renderer, every diagnostic off', await controls(page),
        { scrollback: '5000', renderer: 'dom', perf: false, attach: false, keyboard: false, keyboardState: '' });
    await page.close();
    const until = Date.now() + 30 * 60 * 1000;
    page = await openPage(ctx, { stored: {
        terminalScrollback: '2000', 'sshdeck.renderer': 'webgl', 'sshdeck.perf': '1',
        'sshdeck.attachReport': '1', 'sshdeck.keyboardLogUntil': String(until),
    } });
    const shown = await controls(page);
    const hhmm = await page.evaluate((t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), until);
    check('§2 what this device stored is what the dialog shows',
        [shown.scrollback, shown.renderer, shown.perf, shown.attach, shown.keyboard],
        ['2000', 'webgl', true, true, true]);
    check('§2 ...with the time the keyboard log turns itself off', shown.keyboardState.includes(hhmm), true);
});

// ── §3 the renderer ─────────────────────────────────────────────────────────
await withContext('§3', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await openSettingsFromMenu(page);
    await page.selectOption('#rendererSelect', 'webgl');
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'webgl');
    check('§3 choosing WebGL switches the open terminal and is stored', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), localStorage.getItem('sshdeck.renderer'),
            !!document.querySelector('.xterm-screen canvas')]), ['webgl', 'webgl', true]);
    await page.selectOption('#rendererSelect', 'dom');
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'dom');
    check('§3 choosing Standard switches it back and forgets', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), localStorage.getItem('sshdeck.renderer'),
            !!document.querySelector('.xterm-rows')]), ['dom', null, true]);
});

// ── §4 the diagnostics ──────────────────────────────────────────────────────
const attachReports = (page) => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'kbdebug_log' && e.payload.lines.some(l => l.startsWith('attach-report'))).length);
await withContext('§4 probe', async (ctx) => {
    const page = await openPage(ctx);
    await openSettingsFromMenu(page);
    await page.check('#perfProbeToggle');
    check('§4 the performance probe starts when ticked, and is stored', await page.evaluate(() =>
        [typeof window.SSHDeckPerf?.flush, window.__any.length, localStorage.getItem('sshdeck.perf')]),
    ['function', 1, '1']);
    await page.uncheck('#perfProbeToggle');
    check('§4 ...and stops when unticked, listening to nothing', await page.evaluate(() =>
        [typeof window.SSHDeckPerf, window.__any.length, localStorage.getItem('sshdeck.perf')]),
    ['undefined', 0, null]);
});
await withContext('§4 attach off', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await page.waitForTimeout(2800);
    check('§4 with the attach report off, attaching a session sends none', await attachReports(page), 0);
});
await withContext('§4 attach on', async (ctx) => {
    const page = await openPage(ctx);
    await openSettingsFromMenu(page);
    await page.check('#attachReportToggle');
    await page.click('#closeSettingsModal');
    await restore(page);
    await page.waitForTimeout(2800);
    check('§4 with it on, the first attach sends one report', await attachReports(page), 1);
});
await withContext('§4 keyboard', async (ctx) => {
    const page = await openPage(ctx);
    await openSettingsFromMenu(page);
    await page.check('#keyboardLogToggle');
    const state = await page.evaluate(() => ({
        panel: !!document.getElementById('kbdebugPanel'),
        until: Number(localStorage.getItem('sshdeck.keyboardLogUntil')) - Date.now(),
        text: document.getElementById('keyboardLogState').textContent,
    }));
    check('§4 the keyboard log shows its panel at once', state.panel, true);
    check('§4 ...stored with a deadline an hour away',
        state.until > 59 * 60 * 1000 && state.until <= 60 * 60 * 1000, true);
    check('§4 ...and the dialog says when it ends', /\d/.test(state.text), true);
    await page.uncheck('#keyboardLogToggle');
    check('§4 unticked, the panel goes and the deadline is forgotten', await page.evaluate(() =>
        [!!document.getElementById('kbdebugPanel'), localStorage.getItem('sshdeck.keyboardLogUntil'),
            document.getElementById('keyboardLogState').textContent]), [false, null, '']);
});

// ── §5 the keyboard log turns itself off ────────────────────────────────────
await withContext('§5', async (ctx) => {
    const page = await openPage(ctx, { clock: true });
    await restore(page);
    await page.evaluate(() => DeviceSettings.setKeyboardLog(true));
    check('§5 on: the panel and the screen-diagnostic button are there', await page.evaluate(() =>
        [!!document.getElementById('kbdebugPanel'), !!document.getElementById('screenDiagnosticBtn')]),
    [true, true]);
    await page.clock.fastForward(59 * 60 * 1000);
    check('§5 59 minutes later it is still on', await page.evaluate(() => DeviceSettings.keyboardLog()), true);
    await page.clock.fastForward(2 * 60 * 1000);
    check('§5 an hour later it is off: panel, button, switch and storage', await page.evaluate(() =>
        [DeviceSettings.keyboardLog(), !!document.getElementById('kbdebugPanel'),
            !!document.getElementById('screenDiagnosticBtn'),
            document.getElementById('keyboardLogToggle').checked,
            localStorage.getItem('sshdeck.keyboardLogUntil')]), [false, false, false, false, null]);
    await page.close();
    const later = await openPage(ctx, { stored: { 'sshdeck.keyboardLogUntil': String(Date.now() - 1000) } });
    check('§5 a deadline that passed while the page was closed leaves it off', await later.evaluate(() =>
        [DeviceSettings.keyboardLog(), document.getElementById('keyboardLogToggle').checked]), [false, false]);
});

// ── §6 not an administrator ─────────────────────────────────────────────────
await withContext('§6', async (ctx) => {
    const page = await openPage(ctx, { query: '?role=user', stored: {
        'sshdeck.perf': '1', 'sshdeck.attachReport': '1',
        'sshdeck.keyboardLogUntil': String(Date.now() + 30 * 60 * 1000),
    } });
    await restore(page);
    await page.waitForTimeout(2800);
    check('§6 no Diagnostics section, no admin link', await page.evaluate(() =>
        ['perfProbeToggle', 'attachReportToggle', 'keyboardLogToggle', 'settingsDiagnosticsTitle',
            'adminPanelBtn'].filter(id => document.getElementById(id))), []);
    check('§6 what is stored on the device switches nothing on', await page.evaluate(() =>
        [DeviceSettings.isAdmin(), DeviceSettings.perf(), DeviceSettings.attachReport(),
            DeviceSettings.keyboardLog(), typeof window.SSHDeckPerf,
            !!document.getElementById('kbdebugPanel'), !!document.getElementById('screenDiagnosticBtn')]),
    [false, false, false, false, 'undefined', false, false]);
    check('§6 ...and sends nothing', await page.evaluate(() => window.__emits
        .filter(e => ['kbdebug_log', 'perf_report'].includes(e.ev)).length), 0);
    await openSettingsFromMenu(page);
    check('§6 the Terminal settings are still there', await page.evaluate(() =>
        [!!document.getElementById('scrollbackInput'), !!document.getElementById('rendererSelect')]),
    [true, true]);
});

// ── §7 the old queries ──────────────────────────────────────────────────────
await withContext('§7', async (ctx) => {
    const page = await openPage(ctx, { query: '?renderer=webgl&perf=1&kbdebug=1' });
    await restore(page);
    check('§7 ?renderer=webgl&perf=1&kbdebug=1 switches nothing on and stores nothing', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), typeof window.SSHDeckPerf, !!document.getElementById('kbdebugPanel'),
            ['sshdeck.renderer', 'sshdeck.perf', 'sshdeck.keyboardLogUntil']
                .filter(k => localStorage.getItem(k) !== null)]), ['dom', 'undefined', false, []]);
});

// ── §8 scrollback ───────────────────────────────────────────────────────────
await withContext('§8', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    await openSettingsFromMenu(page);
    await page.fill('#scrollbackInput', '2000');
    await page.press('#scrollbackInput', 'Tab');
    check('§8 a new scrollback reaches the open terminal and is stored', await page.evaluate((id) =>
        [TerminalManager.terminals[TerminalManager.sessionTerminals[id][0]].options.scrollback,
            localStorage.getItem('terminalScrollback')], S1), [2000, '2000']);
});

// ── §9 another tab ──────────────────────────────────────────────────────────
await withContext('§9', async (ctx) => {
    const page = await openPage(ctx);
    await restore(page);
    const other = await openPage(ctx);
    await other.evaluate(() => DeviceSettings.setRenderer('webgl'));
    await page.waitForFunction(() => TerminalManager.rendererInUse() === 'webgl');
    check('§9 a renderer chosen in another tab applies here, and the dialog shows it', await page.evaluate(() =>
        [TerminalManager.rendererInUse(), document.getElementById('rendererSelect').value]), ['webgl', 'webgl']);
    await other.evaluate(() => DeviceSettings.setKeyboardLog(true));
    await page.waitForFunction(() => !!document.getElementById('kbdebugPanel'));
    check('§9 ...and so does the keyboard log', await page.evaluate(() =>
        document.getElementById('keyboardLogToggle').checked), true);
});

// ── §10 a phone ─────────────────────────────────────────────────────────────
// Upright and on its side: a phone held landscape is wider than the 768 px
// below which the app's own inputs grow to 44 px and 16 px.
for (const [w, h] of [[390, 844], [844, 390]]) {
    await withContext(`§10 ${w}x${h}`, async (ctx) => {
        const page = await openPage(ctx);
        await page.evaluate(() => {
            DeviceSettings.setKeyboardLog(true);
            // Enough lines that the panel reaches its full height.
            for (let n = 0; n < 40; n++) TerminalManager.noteKeyboardDebug('line', { n });
            ModalManager.open(document.getElementById('settingsModal'));
        });
        const at = await page.evaluate(() => {
            const box = (el) => el.getBoundingClientRect();
            const m = document.getElementById('settingsModal');
            const card = box(m.querySelector('.modal-content'));
            const close = box(m.querySelector('#closeSettingsModal'));
            const labels = [...m.querySelectorAll('.checkbox-label')];
            const input = m.querySelector('#scrollbackInput');
            return {
                targets: Object.fromEntries([
                    ['close', m.querySelector('#closeSettingsModal')],
                    ['scrollback', input],
                    ['renderer', m.querySelector('#rendererSelect')],
                    ...labels.map(l => [l.querySelector('input').id, l]),
                ].map(([k, el]) => [k, box(el).height >= 44])),
                // The text starts beside its box and is centred on it, not
                // dropped to the bottom of a 44 px box (or the line below).
                oneLine: labels.map((l) => {
                    const b = box(l.querySelector('input'));
                    const t = box(l.querySelector('span'));
                    return t.left > b.right
                        && Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2) <= 4;
                }),
                fontSize: getComputedStyle(input).fontSize,
                fits: card.top >= 0 && card.bottom <= innerHeight + 1 && card.left >= 0 && card.right <= innerWidth,
                ...(() => {
                    // The keyboard log's panel spans the top. It takes no
                    // pointer, so hit-testing goes through it: it is made
                    // hittable for the measurement, which then says what is
                    // drawn on top at the close button's centre.
                    const panel = document.getElementById('kbdebugPanel');
                    const x = close.left + close.width / 2;
                    const y = close.top + close.height / 2;
                    const p = box(panel);
                    panel.style.pointerEvents = 'auto';
                    const top = document.elementFromPoint(x, y);
                    panel.style.pointerEvents = '';
                    return {
                        panelCovers: x >= p.left && x <= p.right && y >= p.top && y <= p.bottom,
                        closeOnTop: !!top?.closest('#closeSettingsModal'),
                    };
                })(),
            };
        });
        const label = `§10 ${w}x${h}`;
        check(`${label} every control is at least 44 px tall`, at.targets, {
            close: true, scrollback: true, renderer: true,
            perfProbeToggle: true, attachReportToggle: true, keyboardLogToggle: true,
        });
        check(`${label} each checkbox has its text beside it`, at.oneLine, [true, true, true]);
        check(`${label} the number field is 16 px (iOS zooms in on smaller)`, at.fontSize, '16px');
        check(`${label} the dialog fits the screen`, at.fits, true);
        check(`${label} with the keyboard log on, the dialog stays above its panel`,
            [at.panelCovers, at.closeOnTop], [true, true]);
    }, { viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
}

// ── §Z ──────────────────────────────────────────────────────────────────────
check('§Z no page errors', pageErrors, []);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
