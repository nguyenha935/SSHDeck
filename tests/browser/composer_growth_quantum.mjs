/*
 * W14 item 4 — composer growth quantization gate.
 *
 * The defect: every pixel of composer growth below the cap rewrote
 * --composer-content-height, the dock changed height, the terminal
 * ResizeObserver fired, fitTerminal ran and a resize proposal went to the
 * server -- PER KEYSTROKE. The fix quantizes the publish to LINE-COUNT
 * changes, so filling the box changes the dock height at most
 * COMPOSER_CAP_LINES times total, and once the cap holds, internal
 * overflow-y:auto absorbs further typing with zero dock movement.
 *
 * This suite types six newlines into the real composer on a phone shell and
 * pins:
 *   §Q1 at most four distinct published --composer-content-height values;
 *   §Q2 the box scrolls internally once the cap holds (scrollHeight exceeds
 *       the rendered box, overflow-y auto);
 *   §Q3 terminal fit requests stay bounded (one per line change, never per
 *       keystroke);
 *   §Q4 ssh_resize proposals stay bounded and equal the real proposal path
 *       (reportLocalFit), never duplicated per pixel.
 *
 * Run: node tests/browser/composer_growth_quantum.mjs   (from source/)
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
    // The real socket.io client would assign window.io after the stub; the
    // gate scripts no server traffic at all, so the library is not wanted.
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

const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(STUBS);
await page.goto(base, { waitUntil: 'load' });
await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
});

await page.evaluate(() => {
    // Record every ssh_resize proposal and every fit request.
    window.__emits = [];
    window.socket.emit = (name, payload) => window.__emits.push({ name, payload });
    window.__fits = [];
    const realFit = TerminalManager.requestFit.bind(TerminalManager);
    TerminalManager.requestFit = (sid, delay) => {
        window.__fits.push(sid);
        return realFit(sid, delay);
    };
    // Record every --composer-content-height publish.
    window.__published = [];
    const root = document.documentElement;
    const origSet = root.style.setProperty.bind(root.style);
    root.style.setProperty = (name, value) => {
        if (name === '--composer-content-height') {
            window.__published.push(value);
        }
        return origSet(name, value);
    };
    document.getElementById('sessionBar')?.classList.remove('hidden');
});

// Seed one real session and attach a terminal to it, so the dock-height
// chain (ResizeObserver -> requestFit -> proposal) has something to act on.
const SID = 'GROWTH-1';
await page.evaluate((sid) => {
    SessionManager.createSession({
        session_id: sid, host: 'grow.example', port: 22, username: 'growU',
        display_name: 'Grow', auth_type: 'key', key_id: 'k1',
        use_tmux: false, tmux_session_name: null,
    });
    SessionManager.assignSessionToPane(sid, 0);
}, SID);
await page.waitForTimeout(300);
await page.evaluate(() => {
    window.__fits.length = 0;
    window.__emits.length = 0;
});

// Type six newlines, one keystroke event at a time, letting each rAF flush.
for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.value += '\n';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(120);
}

const result = await page.evaluate(() => {
    const el = document.getElementById('mobileInput');
    const distinct = [...new Set(window.__published)];
    return {
        published: window.__published,
        distinct,
        renderedHeight: Math.round(el.getBoundingClientRect().height),
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
        fits: window.__fits.length,
        proposals: window.__emits.filter(x => x.name === 'ssh_resize').length,
    };
});

check('§Q1 at most four distinct published composer heights for six newlines',
    result.distinct.length <= 4, true);
check('§Q1 every publish is a whole-pixel value',
    result.distinct.every(v => /^\d+px$/.test(v)), true);
check('§Q2 the capped box scrolls its draft internally',
    result.overflowY, 'auto');
check('§Q2 the draft now exceeds the rendered box (internal scroll engaged)',
    result.scrollHeight > result.renderedHeight, true);
check('§Q3 terminal fit requests stay bounded by line changes (<=6)',
    result.fits <= 6, true);
check('§Q4 resize proposals stay bounded (<=4, one per real change)',
    result.proposals <= 4, true);
check('§Q4 proposals carry the session id',
    await page.evaluate((sid) =>
        window.__emits.filter(x => x.name === 'ssh_resize')
            .every(x => x.payload.session_id === sid), SID), true);
/*
 * §Q5 — THE COMPOSER FRAME HOLDS EXACTLY TWO BUTTONS, AND NOTHING IS PAID FOR
 * OUT OF THE TEXT BOX.
 *
 * Owner batch, verbatim: "Trên khung composer chỉ có duy nhất 2 nút
 * là bàn phím chức năng ảo và phím gửi", and on the first attempt's dock line:
 * "Bản chất có thêm các nút như vậy ở dưới dòng composer đã là sai hoàn toàn."
 *
 * This section has been rewritten twice, and both earlier shapes are recorded
 * because each failed in a way the new assertions now catch:
 *
 *   1. The pair stood INSIDE the composer row. `.mobile-composer` is the only
 *      flexible child there, so two 44px controls were charged entirely to the
 *      text box -- measured 182 -> 86px at this viewport (151 -> 55 at 359,
 *      220 -> 124 at 428).
 *   2. The pair got its own contextual DOCK LINE (#mobileComposerActions,
 *      charging a --composer-conflict-line height term). That fixed the width
 *      but made the dock grow and shrink under the user's thumb (measured 65px
 *      -> 114px, one row -> two) and still put extra controls below the
 *      composer, which the owner rejected at the root.
 *
 * A conflict is a QUESTION, so it is now asked the way the dock already asks
 * one: #composerConflictSheet, an absolutely-positioned popover anchored above
 * the bar (the #broadcastTargetMenu pattern). Out of flow means it adds no flex
 * line, charges no height term and costs the box no width.
 *
 * The assertions are therefore about what the popover must NOT do to the dock.
 * Two are load-bearing: a future change that puts a contextual control back
 * into the bar's FLOW fails on the inventory or the dock height, rather than
 * silently collapsing the text box or shoving the terminal up again.
 */
const beforeConflict = await page.evaluate(() => {
    const dock = document.getElementById('sessionBar');
    const bar = document.getElementById('mobileInputBar');
    const visible = (el) => !el.hidden && el.offsetParent !== null;
    // In the bar's own FLOW: neither the control nor any ancestor up to the bar
    // is taken out of flow. Checking only the button and its immediate parent
    // is not enough -- the popover nests its pair one row deep.
    window.__inBarFlow = (btn) => {
        for (let el = btn; el && el !== bar; el = el.parentElement) {
            if (getComputedStyle(el).position === 'absolute') return false;
        }
        return true;
    };
    return {
        boxW: Math.round(
            document.getElementById('mobileInput').getBoundingClientRect().width),
        dockH: Math.round(dock.getBoundingClientRect().height),
        // Everything standing in the bar's own flow, which is the inventory the
        // owner counts when he looks at the composer frame.
        inBar: [...bar.querySelectorAll('button')].filter(visible)
            .filter(window.__inBarFlow).map(b => b.id).sort(),
    };
});
check('§Q5 at rest the composer frame holds exactly keypad + send',
    beforeConflict.inBar, ['mobileKeypadBtn', 'mobileSendBtn']);

/*
 * The draft-CONFLICT half of this section is gone with the sheet it measured:
 * Phase 2 deleted the cross-device draft sync, so there is no
 * conflict to ask about and no popover to ask it in. What the owner's contract
 * still fixes -- the composer frame holding exactly keypad + Send, with
 * nothing charged out of the text box -- is asserted above and re-asserted
 * here with a full draft in the box.
 */
await page.evaluate(() => {
    const el = document.getElementById('mobileInput');
    el.value = 'a draft that wraps the box onto a second line of text';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const withDraft = await page.evaluate(() => {
    const dock = document.getElementById('sessionBar');
    const bar = document.getElementById('mobileInputBar');
    const visible = (el) => !el.hidden && el.offsetParent !== null;
    return {
        boxW: Math.round(
            document.getElementById('mobileInput').getBoundingClientRect().width),
        dockH: Math.round(dock.getBoundingClientRect().height),
        inBar: [...bar.querySelectorAll('button')].filter(visible)
            .filter(window.__inBarFlow).map(b => b.id).sort(),
        legacyLine: getComputedStyle(document.documentElement)
            .getPropertyValue('--composer-conflict-line').trim(),
        legacySheet: !!document.getElementById('composerConflictSheet'),
        legacyResync: !!document.getElementById('composerResyncSheet'),
    };
});
check('§Q5 a full draft still leaves exactly keypad + send in the frame',
    withDraft.inBar, ['mobileKeypadBtn', 'mobileSendBtn']);
check('§Q5 the text box width never moved', withDraft.boxW, beforeConflict.boxW);
/*
 * The dock's HEIGHT is not compared across the two snapshots: it legitimately
 * follows the box's line count (that is §Q1's whole subject), and the two
 * snapshots hold different drafts. What mattered about it here was that a
 * CONTEXTUAL SURFACE must not add a line of its own -- and the assertions
 * below prove there is no such surface left to add one.
 */
check('§Q5 the conflict sheet is gone from the DOM', withDraft.legacySheet, false);
check('§Q5 so is the resync sheet', withDraft.legacyResync, false);
check('§Q5 and the rejected dock line has no height term',
    withDraft.legacyLine, '');

check('§Z no page errors', errors, []);

await ctx.close();
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
