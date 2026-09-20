/*
 * S15 defect 1 — the terminal FRAME's real geometry, measured.
 *
 * The Owner's report: "the frame sits slightly LEFT of centre and the RIGHT-hand
 * edge/border looks visibly thicker than the left; on phones the frame does not
 * follow the real screen width, so terminal content is clipped at the right."
 *
 * Two candidate CSS causes were named and both were REFUTED by measurement
 * before this gate was written (evidence /tmp/s15work/probe_verify_s15.mjs):
 *   - `.xterm { padding: var(--sp-8) }` is SYMMETRIC: computed padding-left and
 *     padding-right are both exactly 8px at 390x844 and at 1440x900.
 *   - `.xterm-viewport { scrollbar-gutter: stable }` reserves nothing here:
 *     switching it to `auto` and re-fitting moved no band by a single pixel.
 *
 * The real cause is arithmetic, in the vendored fit path, and it has two parts:
 *
 *   1. PHANTOM SCROLLBAR COST. xterm.js 5.3.0's Viewport constructor computes
 *      `scrollBarWidth = viewportEl.offsetWidth - scrollArea.offsetWidth || 15`
 *      ONCE, at construction. On an overlay-scrollbar platform (every phone) the
 *      real delta is 0, so `|| 15` reserves a phantom 15px that no scrollbar
 *      will ever occupy. FitAddon.proposeDimensions subtracts that number before
 *      flooring to whole columns, so the grid is narrower than the pane can
 *      hold -- which is precisely "does not follow the real screen width" and
 *      "clipped at the right". On desktop the thin classic scrollbar is REAL
 *      (10px measured), so nothing there is phantom and nothing may be
 *      reclaimed.
 *
 *   2. THE COLUMN FLOOR SLACK LANDS WHOLLY ON THE RIGHT. `.xterm-screen` is an
 *      explicitly-sized, left-aligned block child of `.xterm`'s padding box
 *      (vendored xterm.css gives it `position: relative` and nothing else), so
 *      whatever `floor(avail / cellWidth)` leaves over is dead space on the
 *      right and nowhere else.
 *
 * Measured before the fix (DOM rects, not a screenshot):
 *
 *   tier      pane   .xterm  screen  leftBand  rightBand  cols  sbw  slack
 *   phone     390    390     354     8         28         49    15   5
 *   desktop   1426   1426    1392    8         26         165   10   8
 *
 * and the ledger `rightBand - leftBand === sbwReserved + floorSlack` holds at
 * both tiers (20 and 18). Every ancestor box measured flush -- pane, wrapper and
 * `.xterm` are the same width, all gaps zero -- so the whole visible asymmetry
 * is INSIDE `.xterm` and no shell rule is implicated.
 *
 * What this gate pins, at BOTH tiers:
 *   §G  the frame follows the real pane width (pane == wrapper == .xterm, no
 *       gap anywhere in the chain)
 *   §B  the two bands differ by exactly the REAL scrollbar cost and nothing
 *       more: 0 on an overlay platform, the measured scrollbar width on a
 *       classic one. This is the row the phantom 15 turns red.
 *   §S  the width fit consumed is the LIVE measured scrollbar delta, never the
 *       `|| 15` fallback
 *   §V  the vendored internal this fix depends on still exists. The correction
 *       wrote `terminal._core.viewport.scrollBarWidth` (removed:
 *       xterm 6 has no such internal), which is xterm 5.3.0
 *       private API; if a vendor bump removes or renames it the write becomes a
 *       silent no-op and §B would drift back without anything explaining why.
 *       This row fails LOUDLY in that case.
 *   §O  the recentring margin can never create horizontal overflow: the
 *       wrapper's scrollWidth equals its clientWidth.
 *
 * §P is GONE,. It pinned the pannable wide-PTY contract: a grid
 * wider than the pane, the recentring margin cleared, the wrapper scrolling.
 * There is no wide-PTY case any more -- a view is drawn by tmux clipped to this
 * client's own size, so the grid a pane renders is always its own fit -- and
 * with the state gone the class, its CSS and this row went with it. §O is what
 * still has teeth: it proves the margin the fit DOES apply never overflows.
 *
 * Run: node tests/browser/terminal_frame_geometry.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
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
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SID = 'GEOM-FRAME-1';

// The terminal is built through the SHIPPED path -- createTerminal, then
// attachTerminal, which is what performs the initial fit -- so the geometry
// measured here is the geometry production produces.
const SEED = `(sid) => {
    SessionManager.sessions[sid] = { id: sid, session_id: sid, host: 'geo.example',
        port: 22, username: 'geo', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: 'Geo', connected: true, isPersistentCandidate: false,
        tmuxSessionName: null, terminalId: 'term-' + sid, useTmux: false,
        viaJump: null, latencyMs: null };
    SessionManager.activeSessionId = sid;
    const el = document.createElement('div');
    el.id = 'term-' + sid;
    el.className = 'terminal-wrapper';
    document.getElementById('terminalsContainer').appendChild(el);
    TerminalManager.createTerminal(sid);
    TerminalManager.attachTerminal(sid, 'term-' + sid);
}`;

// Everything measured in ONE browser-side pass, from real rects. `trueSbw` is
// the LIVE viewport delta -- what a scrollbar actually costs on this platform
// right now -- which is the number the fix must feed to fit.
const MEASURE = `(sid) => {
    const key = TerminalManager.sessionTerminals[sid][0];
    const terminal = TerminalManager.terminals[key];
    const xterm = terminal.element;
    const screen = xterm.querySelector('.xterm-screen');
    const viewportEl = xterm.querySelector('.xterm-viewport');
    const scrollArea = xterm.querySelector('.xterm-scroll-area');
    const wrapper = TerminalManager.terminalContainers[sid];
    const pane = wrapper.closest('.terminal-pane') || wrapper;
    const xb = xterm.getBoundingClientRect();
    const sb = screen.getBoundingClientRect();
    const round = (n) => Math.round(n * 10) / 10;
    return {
        paneW: round(pane.getBoundingClientRect().width),
        wrapperW: round(wrapper.getBoundingClientRect().width),
        xtermW: round(xb.width),
        screenW: round(sb.width),
        leftBand: round(sb.left - xb.left),
        rightBand: round(xb.right - sb.right),
        // xterm 6 renders no scroll area at all, so there is no scrollbar to
        // cost and nothing for the correction to write; both are reported as
        // absent rather than measured against a missing node.
        hasScrollArea: !!scrollArea,
        trueSbw: scrollArea
            ? Math.max(0, viewportEl.offsetWidth - scrollArea.offsetWidth) : 0,
        fitSbw: terminal._core && terminal._core.viewport
            ? terminal._core.viewport.scrollBarWidth : null,
        hasVendoredSbw: !!(terminal._core && terminal._core.viewport
            && typeof terminal._core.viewport.scrollBarWidth === 'number'),
        cols: terminal.cols,
        wrapperScrollW: wrapper.scrollWidth,
        wrapperClientW: wrapper.clientWidth,
        screenMarginLeft: getComputedStyle(screen).marginLeft,
    };
}`;

for (const [w, h, touch, label] of [
    [390, 844, true, 'phone 390x844'],
    [1440, 900, false, 'desktop 1440x900'],
]) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.evaluate(new Function('return ' + SEED)(), SID);
    // attachTerminal fits inside a nested rAF and the renderer settles one frame
    // later; measuring before that reads the pre-fit grid.
    await page.waitForTimeout(600);
    const m = await page.evaluate(new Function('return ' + MEASURE)(), SID);

    /*
     * ── §V the correction still has something to write through, OR there is
     *    nothing left to correct ────────────────────────────────────────────
     *
     * The phantom-scrollbar fix writes `terminal._core.viewport.scrollBarWidth`,
     * a private xterm 5.3.0 internal, and this row existed to fail LOUDLY if a
     * vendor bump renamed it -- because then the correction would silently
     * become a no-op and the geometry would drift back.
     *
     * xterm 6 removed the DOM scroll area entirely: there is no `.xterm-scroll-area`,
     * no viewport scrollbar cost, and therefore no phantom to reclaim. So the
     * row now requires ONE of the two consistent worlds, and still fails on the
     * dangerous middle: an engine that HAS a scroll area but no internal to
     * correct.
     */
    check(`§V the scrollbar cost is either correctable or absent (${label})`,
        m.hasScrollArea ? m.hasVendoredSbw : m.trueSbw === 0, true);

    // ── §G the frame follows the real pane width ─────────────────────────────
    check(`§G the wrapper fills the pane (${label})`, m.wrapperW, m.paneW);
    check(`§G .xterm fills the wrapper (${label})`, m.xtermW, m.wrapperW);

    // ── §S fit consumed the LIVE scrollbar cost, not the `|| 15` fallback ────
    // Only meaningful where the engine keeps such a number at all.
    if (m.hasVendoredSbw) {
        check(`§S fit used the measured scrollbar cost (${label})`,
            m.fitSbw, m.trueSbw);
    } else {
        check(`§S the engine reserves no scrollbar to mis-measure (${label})`,
            m.trueSbw, 0);
    }

    // ── §B the bands differ by the REAL scrollbar cost and nothing more ──────
    // A classic scrollbar legitimately paints over the right padding, because
    // `.xterm-viewport` spans the full `.xterm` width (left:0; right:0). An
    // overlay platform costs zero, so there the two bands must be equal. One
    // pixel of tolerance covers an odd number of slack pixels, which cannot be
    // split evenly.
    const bandExcess = Math.round(m.rightBand - m.leftBand);
    check(`§B the band asymmetry is exactly the real scrollbar cost (${label})`,
        Math.abs(bandExcess - m.trueSbw) <= 1, true);

    // ── §O the recentring margin never creates horizontal overflow ───────────
    check(`§O the wrapper does not scroll horizontally (${label})`,
        m.wrapperScrollW, m.wrapperClientW);

    check(`§Z no page errors (${label})`, errors.join(', '), '');
    console.log(`      measured (${label}): ${JSON.stringify(m)}`);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
