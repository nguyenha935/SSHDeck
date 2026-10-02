#!/usr/bin/env node
/*
 * A TAP MUST NOT LEAVE A HOVER LOOK BEHIND.
 *
 * Reported on an iPhone (2026-10-02): a button showed its pressed look after a
 * tap and kept it until something else was tapped. Mobile browsers set :hover
 * on the element a finger lifts from and keep it there; every one of the 85
 * :hover rules in the shipped stylesheets applied on a touch screen. Measured
 * before the fix: in WebKit at 390x844 with touch (which answers
 * (hover: none) like an iPhone), opening and closing the More sheet left
 * #mobileMoreBtn with :hover true and its hover background and accent colour;
 * in Chromium phone emulation 9 of the 13 controls on screen changed look
 * under :hover.
 *
 * The contract:
 *   * a :hover look exists only under @media (hover: hover) -- a mouse;
 *   * a touch press shows the same look while the finger is down, through
 *     each rule's :active twin (iOS needs a touchstart listener for :active,
 *     registered by app.js and auth.js);
 *   * a mouse sees nothing new: :active only happens under the pointer, where
 *     :hover already applies.
 *
 * One :hover stays unguarded on purpose: `.info-tooltip-trigger:hover +
 * .info-tooltip`. On a touch screen the sticky hover IS how the tooltip opens
 * (tap the (i)) and closes (tap elsewhere); gating it would hide the tooltip
 * from every phone.
 *
 * Run: node tests/browser/touch_hover_release.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
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

// ---------------------------------------------------------------------------
// §0 Every :hover selector in every stylesheet a template links sits under
//    @media (hover: hover).
// ---------------------------------------------------------------------------
const ALLOWED = ['.info-tooltip-trigger:hover + .info-tooltip'];

function hoverSelectors(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = [];
    const out = [];
    let prelude = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '{') {
            const p = prelude.trim();
            prelude = '';
            if (p.startsWith('@')) {
                stack.push(p);
                continue;
            }
            const close = src.indexOf('}', i);
            let depth = 0;
            let cur = '';
            const sels = [];
            for (const ch of p) {
                if (ch === '(' || ch === '[') depth++;
                if (ch === ')' || ch === ']') depth--;
                if (ch === ',' && depth === 0) { sels.push(cur); cur = ''; } else cur += ch;
            }
            sels.push(cur);
            for (const s of sels.map(x => x.replace(/\s+/g, ' ').trim())) {
                if (s.includes(':hover')) {
                    out.push({ sel: s, guarded: stack.some(m => m.includes('(hover: hover)')) });
                }
            }
            i = close;
        } else if (c === '}') {
            stack.pop();
            prelude = '';
        } else if (c === ';') {
            prelude = '';
        } else {
            prelude += c;
        }
    }
    return out;
}

const linked = new Set();
for (const tpl of fs.readdirSync(path.join(ROOT, 'templates')).filter(f => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(ROOT, 'templates', tpl), 'utf8');
    for (const m of src.matchAll(/filename='(css\/[^']+\.css)'/g)) linked.add(m[1]);
}
let total = 0;
const loose = [];
const allowedSeen = new Set();
for (const rel of [...linked].sort()) {
    for (const h of hoverSelectors(fs.readFileSync(path.join(ROOT, 'static', rel), 'utf8'))) {
        total++;
        if (h.guarded) continue;
        if (ALLOWED.includes(h.sel)) allowedSeen.add(h.sel);
        else loose.push(`${rel}: ${h.sel}`);
    }
}
console.log(`      §0 ${linked.size} linked stylesheets, ${total} :hover selectors`);
check('§0 the stylesheets the templates link were all read', linked.size >= 5, true);
check('§0 every :hover selector sits under @media (hover: hover)', loose, []);
check('§0 the tooltip exception still exists (else drop it from ALLOWED)',
    [...allowedSeen], ALLOWED);

// §5 (static) iOS applies :active only with a touchstart listener in place.
const LISTENER = "document.addEventListener('touchstart', () => {}, { passive: true });";
for (const js of ['static/js/app.js', 'static/js/auth.js']) {
    check(`§5 ${js} registers the passive touchstart listener :active needs on iOS`,
        fs.readFileSync(path.join(ROOT, js), 'utf8').includes(LISTENER), true);
}

// ---------------------------------------------------------------------------
// Pages: the shipped index and login templates, Jinja collapsed.
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function renderTemplate(rel) {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(/\{%\s*include\s+'([^']+)'\s*%\}/g,
        (m, f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}
const PAGES = { '/': renderTemplate('templates/index.html'), '/login': renderTemplate('templates/login.html') };
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (PAGES[rel]) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(PAGES[rel]);
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

const STUBS = `
    const noop = () => {};
    window.socket = { connected: true, id: 'sock-thr', on: noop, off: noop, once: noop,
        emit: noop, io: { on: noop } };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1 };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const CONTROLS = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], '
    + '[role="menuitemradio"], [role="option"], .session-tab';
const errors = [];

async function open(engine, opts, url) {
    const browser = await engine.launch();
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${engine.name()} ${url}: ${e}`));
    await page.addInitScript(STUBS);
    await page.goto(base + url, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // Tag the controls on screen, so each one can be addressed by CDP.
    const count = await page.evaluate(sel => {
        let n = 0;
        document.querySelectorAll(sel).forEach(el => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
                && cs.visibility !== 'hidden') {
                el.dataset.thr = String(n++);
            }
        });
        return n;
    }, CONTROLS);
    return { browser, page, count };
}

const PROPS = ['background-color', 'background-image', 'color', 'border-top-color',
    'box-shadow', 'transform', 'filter', 'opacity', 'text-decoration-thickness'];
const look = (page, sel) => page.evaluate(([s, props]) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return props.map(p => cs.getPropertyValue(p)).join('|')
        + '|before:' + before.getPropertyValue('background-color');
}, [sel, PROPS]);
const name = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    return el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
}, sel);

/* Under each forced pseudo-class state, the controls whose look changes. */
async function changedUnder(page, count, state) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const changed = [];
    for (let i = 0; i < count; i++) {
        const sel = `[data-thr="${i}"]`;
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
        const rest = await look(page, sel);
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state });
        const forced = await look(page, sel);
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        if (forced !== rest) changed.push(await name(page, sel));
    }
    await cdp.detach();
    return changed;
}

// ---------------------------------------------------------------------------
// §1 WebKit with touch, the engine that showed the defect: tap More open, tap
//    it closed. The sheet is gone and the button looks as it did before.
// ---------------------------------------------------------------------------
{
    const { browser, page } = await open(webkit, PHONE, '/');
    const media = await page.evaluate(() => [matchMedia('(hover: hover)').matches,
        matchMedia('(pointer: coarse)').matches]);
    check('§1 WebKit with touch answers like a phone: (hover: hover) false, coarse true',
        media, [false, true]);
    const rest = await look(page, '#mobileMoreBtn');
    await page.tap('#mobileMoreBtn');
    await page.waitForTimeout(300);
    const opened = await page.getAttribute('#mobileMoreBtn', 'aria-expanded');
    await page.tap('#mobileMoreBtn');
    await page.waitForTimeout(600);
    const closed = await page.getAttribute('#mobileMoreBtn', 'aria-expanded');
    check('§1 the taps really opened and closed the More sheet', [opened, closed], ['true', 'false']);
    check('§1 after the taps More looks exactly as it did before them',
        await look(page, '#mobileMoreBtn'), rest);
    await browser.close();
}

// ---------------------------------------------------------------------------
// §2 Chromium phone: :hover changes nothing on any control on screen, on the
//    app and on the login page.
// §3 ...while a press does show: :active gives the controls that had a hover
//    look their look back. The state is forced: headless Chromium never sets
//    :active for a touch held through CDP (measured on a bare page with only a
//    `button:active` rule: false at 0/100/300/700 ms, with or without a
//    touchstart listener; a mouse press sets it). Setting :active under a
//    finger is the browser's part; this gate holds the rules (§3) and the
//    listener iOS needs (§5).
// ---------------------------------------------------------------------------
const PHONE_CR = { ...PHONE, isMobile: true };
{
    const { browser, page, count } = await open(chromium, PHONE_CR, '/');
    const hovered = await changedUnder(page, count, ['hover']);
    console.log(`      §2 app: ${count} controls on screen`);
    check('§2 app: the controls on screen are the phone shell (dock and action row)',
        count >= 10, true);
    check('§2 app: no control changes look under :hover', hovered, []);
    const pressed = await changedUnder(page, count, ['active']);
    const DOCK = ['#mobileKeypadBtn', '#mobileSendBtn', '#mobileMoreBtn', '#broadcastToggleBtn',
        '#saveTranscriptBtn', '#touchReconnectBtn', '#notepadOpenBtn'];
    check('§3 app: the dock and the action row show a look under :active',
        DOCK.filter(id => !pressed.includes(id)), []);
    await browser.close();
}
{
    const { browser, page, count } = await open(chromium, PHONE_CR, '/login');
    console.log(`      §2 login: ${count} controls on screen`);
    check('§2 login: the page has its controls (language, show password, submit)', count >= 3, true);
    check('§2 login: no control changes look under :hover',
        await changedUnder(page, count, ['hover']), []);
    check('§3 login: the submit button shows a look under :active',
        (await changedUnder(page, count, ['active'])).some(n => n.includes('a5-submit')), true);
    await browser.close();
}

// ---------------------------------------------------------------------------
// §4 Desktop keeps its hover.
// ---------------------------------------------------------------------------
{
    const { browser, page, count } = await open(chromium, DESKTOP, '/');
    const hovered = await changedUnder(page, count, ['hover']);
    console.log(`      §4 desktop: ${hovered.length} of ${count} controls change under :hover`);
    check('§4 desktop: the layout menu and the action-row buttons still hover',
        ['#layoutMenuBtn', '#broadcastToggleBtn'].filter(id => !hovered.includes(id)), []);
    await browser.close();
}
{
    const { browser, page, count } = await open(chromium, DESKTOP, '/login');
    check('§4 desktop login: the submit button still hovers',
        (await changedUnder(page, count, ['hover'])).some(n => n.includes('a5-submit')), true);
    await browser.close();
}

check('§Z no page errors', errors, []);
server.close();
console.log(`\ntouch_hover_release: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
