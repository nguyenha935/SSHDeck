/*
 * ROOT WIDTH UNIT CONTRACT — the gate for S26 R1.
 *
 * WHAT DEFECT THIS GUARDS. `html, body { width: 100vw; max-width: 100vw }`
 * (style.css, base block) sized the two outermost boxes in viewport units. `vw`
 * is defined against the viewport INCLUDING a classic, space-reserving scrollbar
 * gutter; those boxes live inside documentElement's CONTENT box, which EXCLUDES
 * it. On any engine that reserves space for its scrollbars the two differ by the
 * gutter, so html and body were laid out gutter-px wider than the room they had
 * and `documentElement.scrollWidth - clientWidth` equalled the gutter — real
 * horizontal overflow, on every page, at every breakpoint. That is the Owner's
 * report at ipad-landscape: "khung terminal lech sang ben trai, vien ben phai
 * day hon, chu bi cat chieu ngang, phai keo sang 2 ben".
 *
 * WHY IT NEEDS ITS OWN GATE, IN A SECOND ENGINE. The rest of the browser suite
 * runs on the bundled Chromium, which on this box draws OVERLAY scrollbars: the
 * gutter measures 0, `100vw` and `100%` are the same number, and the defect is
 * invisible — it is LATENT in CI and LIVE on the Owner's device. Measured, not
 * assumed: element scrollbar thickness 0px and `documentElement.clientWidth`
 * never below `window.innerWidth` across six launch-flag sets. So a gate that
 * only ever asks Chromium cannot fail on this defect no matter what it asserts.
 *
 * WebKit is the engine of the reported device (ipad-landscape 1112x834 is an
 * iPad; iPadOS Safari is WebKit) and it honours `::-webkit-scrollbar` on the
 * root, giving a genuinely space-reserving gutter. This gate therefore forces a
 * 13px root scrollbar in WebKit and requires the document not to scroll
 * horizontally at any shipped tier.
 *
 * EVERY ROW HAS ITS COMPANION (AGENTS.md §2):
 *   - a would-be-vacuous guard: the gutter really was reserved (gutter > 0 and
 *     clientWidth < innerWidth). Without it, "docScrollX is 0" passes trivially
 *     on an engine that reserves nothing — which is exactly how this defect
 *     survived 101 gates.
 *   - a NEGATIVE CONTROL in the same run: `100vw` is injected back over the
 *     shipped rule and the same measurement must then show overflow equal to the
 *     gutter. An assertion that cannot distinguish the fix from the defect is
 *     not an assertion.
 *   - a source guard: the shipped base rules must not use `vw` for html/body
 *     width, so a future edit that reintroduces the unit is named here even if
 *     no engine in CI can feel it.
 *
 * Run: node tests/browser/root_width_unit_contract.mjs
 */
import { webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true, io: { on() {}, off() {} },
        on(e, f) { (handlers[e] = handlers[e] || []).push(f); return sock; },
        off() { return sock; }, once(e, f) { return sock.on(e, f); },
        emit() { return sock; }, disconnect() { return sock; },
        __fire(e, p) { (handlers[e] || []).forEach(f => f(p)); },
    };
    window.__socketFixture = sock; window.io = () => sock;
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/change-password') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/change_password.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (label, ok, detail = '') => results.push({ label, ok: !!ok, detail });
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ label, ok,
        detail: ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}` });
};

const TIERS = [
    { name: 'desktop1440', width: 1440, height: 900, touch: false },
    { name: 'ipad-portrait', width: 834, height: 1112, touch: true },
    { name: 'ipad-landscape', width: 1112, height: 834, touch: true },
    { name: 'phone390', width: 390, height: 844, touch: true },
    { name: 'phone-landscape', width: 844, height: 390, touch: true },
];

const BAR = 13;
/*
 * A space-reserving ROOT scrollbar, forced. `overflow-y: scroll` guarantees the
 * bar exists whatever the content height, and the explicit ::-webkit-scrollbar
 * width is what makes WebKit reserve layout space for it. This is injected at
 * runtime and never written to the stylesheet: the product must not ship a
 * forced scrollbar, the gate only needs the Owner's condition to exist while it
 * measures.
 */
const FORCE_BAR = `
  html { overflow-y: scroll !important; }
  html::-webkit-scrollbar { width: ${BAR}px; height: ${BAR}px; }
  html::-webkit-scrollbar-thumb { background: #888; }
  html::-webkit-scrollbar-track { background: #222; }
  ::-webkit-scrollbar { width: ${BAR}px; height: ${BAR}px; }
`;
/*
 * THE NEGATIVE CONTROL: the pre-S26 declaration, put back. If the rows below
 * cannot tell this apart from the shipped rule, they are not measuring anything.
 */
const REINTRODUCE_VW = `
  html { width: 100vw !important; max-width: 100vw !important; }
  body { width: 100vw !important; max-width: 100vw !important; }
`;

const READ = () => {
    const de = document.documentElement;
    return {
        iw: window.innerWidth, ih: window.innerHeight,
        cw: de.clientWidth, ch: de.clientHeight,
        sw: de.scrollWidth, sh: de.scrollHeight,
        htmlW: getComputedStyle(de).width,
        bodyW: getComputedStyle(document.body).width,
        bodyBox: Math.round(document.body.getBoundingClientRect().width),
        htmlBox: Math.round(de.getBoundingClientRect().width),
    };
};

const diagnostics = [];
const browser = await webkit.launch();

async function measure(tier, route, extraCss) {
    const ctx = await browser.newContext({
        viewport: { width: tier.width, height: tier.height },
        hasTouch: tier.touch, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`${BASE}${route}`, { waitUntil: 'load' });
    if (route === '/') {
        await page.waitForFunction(() => typeof SessionManager !== 'undefined'
            && typeof TerminalManager !== 'undefined' && !!window.socket,
        null, { timeout: 25000 }).catch(() => {});
    }
    await page.addStyleTag({ content: FORCE_BAR + (extraCss || '') });
    /*
     * Poll for the reserved gutter instead of sleeping a fixed time: the style
     * tag lands asynchronously and a fixed wait either flakes or wastes time.
     * It WAITS BUT DOES NOT THROW — a gate that dies inside setup reports zero
     * assertions, and a 0-assertion gate is red by ruling with no diagnosis.
     */
    let m = null;
    for (let i = 0; i < 40; i++) {
        m = await page.evaluate(READ);
        if (m.iw - m.cw === BAR) break;
        await page.waitForTimeout(100);
    }
    await ctx.close();
    return { ...m, pageErrors };
}

for (const tier of TIERS) {
    const T = tier.name;

    // ── the shipped stylesheet ──────────────────────────────────────────────
    const m = await measure(tier, '/', '');
    diagnostics.push(`${T}: shipped   inner=${m.iw}x${m.ih} client=${m.cw}x${m.ch} `
        + `gutter=${m.iw - m.cw} scrollW=${m.sw} docScrollX=${m.sw - m.cw} `
        + `htmlW=${m.htmlW} bodyBox=${m.bodyBox} pageErrors=${m.pageErrors.length}`);

    /*
     * WOULD-BE-VACUOUS GUARD, FIRST. Everything below is meaningless if the
     * engine reserved no space, so the reservation is asserted by name before
     * the overflow rows are read.
     */
    eq(`${T}: the engine reserved a classic scrollbar gutter`, m.iw - m.cw, BAR);
    check(`${T}: the layout viewport is narrower than the window, as a gutter requires`,
        m.cw < m.iw, JSON.stringify({ innerWidth: m.iw, clientWidth: m.cw }));

    // ── the contract ────────────────────────────────────────────────────────
    eq(`${T}: the document does not scroll horizontally under a reserved gutter`,
        m.sw - m.cw, 0);
    eq(`${T}: scrollWidth equals the layout viewport width`, m.sw, m.cw);
    check(`${T}: the body box fits inside the layout viewport`,
        m.bodyBox <= m.cw,
        JSON.stringify({ bodyBox: m.bodyBox, clientWidth: m.cw }));
    check(`${T}: the html box fits inside the layout viewport`,
        m.htmlBox <= m.cw,
        JSON.stringify({ htmlBox: m.htmlBox, clientWidth: m.cw }));
    eq(`${T}: no page errors while measuring the shipped rule`, m.pageErrors, []);

    // ── the negative control, same run ──────────────────────────────────────
    const n = await measure(tier, '/', REINTRODUCE_VW);
    diagnostics.push(`${T}: negctl-vw inner=${n.iw}x${n.ih} client=${n.cw}x${n.ch} `
        + `gutter=${n.iw - n.cw} scrollW=${n.sw} docScrollX=${n.sw - n.cw} `
        + `htmlW=${n.htmlW} bodyBox=${n.bodyBox}`);
    eq(`${T}: NEGATIVE CONTROL -- reintroducing 100vw overflows by exactly the gutter`,
        n.sw - n.cw, BAR);
    check(`${T}: NEGATIVE CONTROL -- the rows above can tell the fix from the defect`,
        (m.sw - m.cw) !== (n.sw - n.cw),
        JSON.stringify({ shipped: m.sw - m.cw, withVw: n.sw - n.cw }));
}

/*
 * The defect was never terminal-specific: the base html/body rules are shared by
 * every template, so a non-terminal page must be measured too. change_password
 * carries no .main-content, so it keeps the normal document scroller — the
 * configuration in which a horizontal overflow is not merely invisible but
 * actually pannable by the user.
 */
{
    const tier = TIERS[2]; // ipad-landscape, the reported breakpoint
    const m = await measure(tier, '/change-password', '');
    diagnostics.push(`change-password@${tier.name}: inner=${m.iw}x${m.ih} `
        + `client=${m.cw}x${m.ch} gutter=${m.iw - m.cw} scrollW=${m.sw} `
        + `docScrollX=${m.sw - m.cw} bodyBox=${m.bodyBox}`);
    eq('change-password: the engine reserved a gutter here too', m.iw - m.cw, BAR);
    eq('change-password: a non-terminal page does not scroll horizontally either',
        m.sw - m.cw, 0);
    const n = await measure(tier, '/change-password', REINTRODUCE_VW);
    eq('change-password: NEGATIVE CONTROL -- 100vw overflows a non-terminal page too',
        n.sw - n.cw, BAR);
}

await browser.close();
server.close();

/*
 * THE SOURCE GUARD. The measurements above only bite in an engine that reserves
 * space; this row bites everywhere, so a future edit that puts `vw` back on the
 * html/body width is named even by a run that cannot feel it.
 */
{
    const css = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');
    const lines = css.split('\n');
    let sel = '';
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        if (/^[^\s}].*\{\s*$/.test(L)) sel = L.trim();
        if (!/^\s*(width|max-width)\s*:/.test(L)) continue;
        if (!/^(html|body)\s*\{/.test(sel) && !/^html\s*,\s*body\s*\{/.test(sel)) continue;
        if (/\bvw\b|\d+vw/.test(L)) offenders.push(`${i + 1}: ${sel} ${L.trim()}`);
    }
    eq('style.css: no html/body width or max-width is expressed in vw', offenders, []);
    const baseHtmlPct = /html\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s.test(css);
    const baseBodyPct = /body\s*\{[^}]*width:\s*100%;\s*\n\s*max-width:\s*100%/s.test(css);
    check('style.css: the html base rule sizes itself in %', baseHtmlPct, '');
    check('style.css: the body base rule sizes itself in %', baseBodyPct, '');
}

for (const d of diagnostics) console.log(`  ${d}`);
console.log('');
let failed = 0;
for (const r of results) {
    if (r.ok) { console.log(`PASS ${r.label}`); continue; }
    failed++;
    console.log(`FAIL ${r.label}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(`\ntotal=${results.length} passed=${results.length - failed} failed=${failed}`);
if (results.length === 0) {
    console.log('FAIL root_width_unit_contract: zero assertions ran');
    process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
