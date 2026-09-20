#!/usr/bin/env node
/*
 * The two client halves of the owner report, as gates:
 *
 *   "Màn hình được co lại không ra giữa trên cùng mà vẫn co về góc trái trên
 *    cùng."  -- tmux draws a window smaller than the client in the top-left
 *   corner with filler. The server now holds every view's PTY at the minimum
 *   over the views' TRUE fits and announces it (`tmux_window_geometry`); the
 *   client renders that size, centred, while still REPORTING its true fit.
 *
 *   "Các nút connect không đồng bộ ngay trên điện thoại"  -- a connect on one
 *   socket is announced to the user's others as a `live` restore snapshot;
 *   the receiver lists it without displaying it, and a `replaces_session_id`
 *   retires the stale offer in place. `ssh_session_removed` retires a row
 *   another device deleted.
 *
 * Sections:
 *   §A  geometry below the fit: engine takes the window's size, grid centred,
 *       the true fit is still what was reported (no ssh_resize follows);
 *       geometry above the fit: engine returns to the fit
 *   §B  a live snapshot joins the list and takes no pane, no activation, no
 *       view
 *   §C  a live snapshot replacing a session this page shows takes that
 *       session's pane
 *   §D  ssh_session_removed retires a session
 *   §F  a rotation whose HEIGHT arrives one event late (both directions, both
 *       engines) leaves the shell exactly as a clean rotation would
 *   §Z  zero page errors
 *
 * Run: node tests/browser/phone_rotation.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
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
const checkTrue = (label, actual) => check(label, actual === true, true);
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);

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
    window.showNotification = (m, t) => {};
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    /*
     * A lever on the visual viewport's HEIGHT, so a test can hand the page the
     * event a phone really sends on rotation: the new width with the old
     * height, then the height. Null means "the real value".
     */
    const vvHeight = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
    window.__vvLagH = null;
    Object.defineProperty(VisualViewport.prototype, 'height', {
        configurable: true,
        get() { return window.__vvLagH ?? vvHeight.get.call(this); },
    });
`;

/*
 * phone_rotation.mjs -- rotating a phone must not look like a keyboard.
 *
 * A phone delivers the visualViewport resize for a rotation BEFORE
 * window.innerWidth/innerHeight swap. Every reader of those two therefore saw
 * the OLD orientation at the one moment that mattered: the keyboard test
 * compared a 390px landscape height against an 844px portrait baseline, read
 * 0.46 as "keyboard open", hid the header, pinned --app-height, and the
 * orientation rebase then refused to run because it declines while the
 * keyboard is open. The shell stayed broken for the rest of the landscape
 * session -- the owner's "quay ngang thì vỡ toàn bộ giao diện, logo và thanh
 * connect bị đẩy xuống dưới".
 *
 * The signal is the WIDTH: a soft keyboard never changes it.
 */
const READ = (page) => page.evaluate(() => ({
    kb: document.body.classList.contains('keyboard-open'),
    appH: document.documentElement.style.getPropertyValue('--app-height') || '',
    headerH: Math.round(document.querySelector('.header').getBoundingClientRect().height),
    termTop: Math.round(document.querySelector('.terminal-area').getBoundingClientRect().top),
    // Where the strip and the brand live: one home each, at every viewport
    // (owner, -- the phone-landscape dock relocation is retired).
    strip: document.getElementById('sessionTabs').parentElement.className,
    brand: document.getElementById('headerBrand').parentElement.className,
}));
const open = async (w, h, engine = browser) => {
    const ctx = await engine.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    return { ctx, page, errors };
};
// A rotation as a phone delivers it: the visual viewport moves first and
// window.innerWidth/innerHeight report the old orientation until later.
const rotateLagged = async (page, w, h) => {
    await page.evaluate(() => {
        window.__lagW = window.innerWidth; window.__lagH = window.innerHeight;
        Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => window.__lagW });
        Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => window.__lagH });
    });
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    const lagged = await READ(page);
    await page.evaluate(({ w2, h2 }) => {
        window.__lagW = w2; window.__lagH = h2;
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
    }, { w2: w, h2: h });
    await page.waitForTimeout(600);
    return { lagged, settled: await READ(page) };
};
/*
 * A rotation whose height is LATE: the first visualViewport resize carries
 * the new width with the previous orientation's height, and only a second
 * event brings the height. Reproduces what the owner's phone did on
 * (no header at all in landscape; header still hidden after
 * rotating back until the keyboard was opened and closed).
 */
const rotateLaggedHeight = async (page, w, h, staleH) => {
    await page.evaluate(stale => { window.__vvLagH = stale; }, staleH);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const lagged = await READ(page);
    await page.evaluate(() => {
        window.__vvLagH = null;
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(600);
    return { lagged, settled: await READ(page) };
};
// A soft keyboard: the height shrinks, the width does not move.
const keyboard = async (page, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    return READ(page);
};

for (const [pw, ph, lw, lh] of [[390, 844, 844, 390], [428, 926, 926, 428]]) {
    const tag = `${pw}x${ph}`;
    const { ctx, page, errors } = await open(pw, ph);
    const portrait = await READ(page);
    num(`${tag} portrait`, portrait);
    check(`${tag} §A portrait has the tall header`, portrait.headerH, 88);
    check(`${tag} §A and no keyboard`, [portrait.kb, portrait.appH], [false, '']);

    const rot = await rotateLagged(page, lw, lh);
    num(`${tag} landscape (lagged / settled)`, rot);
    check(`${tag} §B a rotation is not read as a keyboard`, rot.lagged.kb, false);
    check(`${tag} §B nothing is pinned`, rot.lagged.appH, '');
    // RESTATED (owner ruling): phone landscape keeps the same
    // two-row touch header as portrait -- the 40px compact band and the
    // dock relocation of the strip and the brand are retired -- so the
    // header is 88 here too and nothing moves out of it.
    check(`${tag} §B the two-row touch header is drawn`, rot.lagged.headerH, 88);
    check(`${tag} §B the terminal starts below it`, rot.lagged.termTop, 88);
    check(`${tag} §B the strip and the brand stay in the header`,
        [rot.lagged.strip, rot.lagged.brand], ['session-tabs-row', 'header-content']);
    check(`${tag} §B and it stays that way once window.inner* catches up`,
        [rot.settled.kb, rot.settled.headerH], [false, 88]);

    const kbLandscape = await keyboard(page, lw, Math.round(lh * 0.55));
    num(`${tag} keyboard in landscape`, kbLandscape);
    check(`${tag} §C a real keyboard in landscape is still detected`, kbLandscape.kb, true);
    checkTrue(`${tag} §C and pins the shell`, kbLandscape.appH !== '');

    const back = await keyboard(page, lw, lh);
    check(`${tag} §C closing it releases the pin`, [back.kb, back.appH, back.headerH],
        [false, '', 88]);

    const home = await rotateLagged(page, pw, ph);
    num(`${tag} back to portrait`, home.settled);
    check(`${tag} §D rotating back restores the tall header`,
        [home.settled.kb, home.settled.headerH], [false, 88]);
    check(`${tag} §D with the strip and the brand where they always were`,
        [home.settled.strip, home.settled.brand], ['session-tabs-row', 'header-content']);
    check(`${tag} §Z no page errors`, errors, []);
    await ctx.close();
}

/* §E rotating WHILE the keyboard is up keeps it up: the new orientation's
 * closed height is estimated from the previous orientation's width. */
{
    const { ctx, page, errors } = await open(390, 844);
    const kbPortrait = await keyboard(page, 390, 460);
    check('§E precondition: the keyboard is open in portrait', kbPortrait.kb, true);
    const rot = await rotateLagged(page, 844, 230);
    num('§E rotated with the keyboard up', rot);
    check('§E the keyboard is still open after the rotation', rot.settled.kb, true);
    checkTrue('§E the shell is still pinned', rot.settled.appH !== '');
    const closed = await keyboard(page, 844, 390);
    num('§E keyboard closed in landscape', closed);
    check('§E closing it in the new orientation releases the shell',
        [closed.kb, closed.appH, closed.headerH], [false, '', 88]);
    check('§E no page errors', errors, []);
    await ctx.close();
}

/* §F the late height, in both directions and both engines. The lagged
 * reading is allowed to be wrong for the one event it lasts; the settled
 * reading is what a person sees, and it must equal a clean rotation's. */
for (const [engineName, engineType] of [['chromium', chromium], ['webkit', webkit]]) {
    const engine = engineName === 'chromium' ? browser : await webkit.launch();
    const { ctx, page, errors } = await open(428, 926, engine);
    const portrait = await READ(page);
    check(`§F ${engineName}: precondition, portrait closed`, [portrait.kb, portrait.headerH], [false, 88]);

    const toLandscape = await rotateLaggedHeight(page, 926, 428, 926);
    num(`§F ${engineName} to landscape, height late`, toLandscape);
    check(`§F ${engineName}: landscape settles closed, unpinned, header drawn`,
        [toLandscape.settled.kb, toLandscape.settled.appH, toLandscape.settled.headerH],
        [false, '', 88]);
    check(`§F ${engineName}: landscape keeps the strip and the brand at home`,
        [toLandscape.settled.strip, toLandscape.settled.brand], ['session-tabs-row', 'header-content']);

    // 390, not 428: a real landscape height is the 428px short side minus the
    // browser's own chrome, so the lagged event still READS as landscape
    // (428 > 390). At exactly 428 the reading would flip at once and the
    // trap this row exists for would never be entered.
    const toPortrait = await rotateLaggedHeight(page, 428, 926, 390);
    num(`§F ${engineName} back to portrait, height late`, toPortrait);
    check(`§F ${engineName}: portrait settles closed, unpinned, header drawn -- no keyboard cycle needed`,
        [toPortrait.settled.kb, toPortrait.settled.appH, toPortrait.settled.headerH],
        [false, '', 88]);
    check(`§F ${engineName}: portrait keeps the strip and the brand at home`,
        [toPortrait.settled.strip, toPortrait.settled.brand], ['session-tabs-row', 'header-content']);

    // A real keyboard is still a keyboard after all that.
    const kb = await keyboard(page, 428, 460);
    check(`§F ${engineName}: a keyboard after the lagged rotations is still detected`, kb.kb, true);
    const closed = await keyboard(page, 428, 926);
    check(`§F ${engineName}: and released`, [closed.kb, closed.appH], [false, '']);
    check(`§F ${engineName}: no page errors`, errors, []);
    await ctx.close();
    if (engine !== browser) await engine.close();
}

await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
