/*
 * v5 spec fidelity contract for four owner-ruled values.
 *
 * Each assertion measures the REAL computed/painted value in the live shell and
 * pins it to the mockup line that governs it. Written BEFORE the fixes, so each
 * one is proven to bite (AGENTS section 2).
 *
 * Owner rulings recorded here so nobody re-litigates them from the numbers alone:
 *
 *  R1  Desktop header buttons: mockup 234 min-height:32px is the authority.
 *      Desktop is a FINE-POINTER surface with no 44px touch obligation, so INF-4
 *      (which raised form controls to 44px on touch) does not apply. Scoped to
 *      fine pointer only; the touch-tier 44px floor is untouched.
 *  R2  .keypad-key min-height: KEEP 44px. Mockup 347 says 39px, which is BELOW
 *      the project's 44px touch floor, and the floor wins on a touch surface.
 *      This suite therefore asserts 44 and NOT 39 -- see Entry 29.
 *  R3  .keypad-key border-radius: mockup 347 says 7px. A token value, not noise.
 *  R4  Dropdowns hang exactly 1px below their trigger (mockup 265-268
 *      `top: calc(100% + 1px)`), measured trigger-relative.
 *
 * Run: node tests/browser/spec_fidelity_v5.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    if (typeof actual === 'object' && actual !== null
        || typeof expected === 'object' && expected !== null) {
        actual = JSON.stringify(actual);
        expected = JSON.stringify(expected);
    }
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}  => got ${JSON.stringify(actual)}`);
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
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const SOCKET_IO_FIXTURE = `
(() => {
    const manager = { on() { return manager; }, off() { return manager; } };
    window.io = () => {
        const socket = {
            connected: true, io: manager,
            on() { return socket; }, off() { return socket; }, once() { return socket; },
            emit(e, p, ack) { if (typeof ack === 'function') ack({ success: true }); return socket; },
            connect() { return socket; }, disconnect() { return socket; },
        };
        return socket;
    };
})();
`;

const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
            return;
        }
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

const STUBS = `
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop,
                      connected: true, io: { on: noop } };
`;

async function openShell(w, h, touch) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(320);
    await page.evaluate(() => {
        SessionManager.setSplitLayout(2, 'default');
        [['s1', 'tiny', 'root'], ['s2', 'goclaw', 'root']]
            .forEach(([id, host, username]) => SessionManager.createSession({
                session_id: id, host, port: 22, username, auth_type: 'key',
                key_id: 'k1', display_name: host, use_tmux: false,
                tmux_session_name: null, via_jump: null,
            }));
        ['s1', 's2'].forEach((id, i) => SessionManager.assignSessionToPane(id, i));
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(160);
    return { ctx, page, errors };
}

const px = v => Math.round(parseFloat(v) * 100) / 100 || 0;

// ── R1: desktop header button height is the mockup's 32px ────────────────────
// Mockup 234: .tw5-control/.tw5-account { min-height:32px; padding:5px 8px }.
// Fine pointer only. The touch tiers keep their own 44px floor, asserted below.
// newConnectionBtn is NOT in this list since W14 item 7: it lives on the
// session strip (first child, icon-only) and the strip tier owns its height --
// asserted as the R1-STRIP contract right after this loop.
for (const [label, w, h] of [
    ['desktop 1440x900', 1440, 900],
    ['desktop-compact 1024x768', 1024, 768],
]) {
    const { ctx, page, errors } = await openShell(w, h, false);
    const m = await page.evaluate(() => {
        const out = {};
        for (const id of ['fileTransferBtn',
            'commandLibraryBtn', 'accountBtnHeader']) {
            const el = document.getElementById(id);
            const cs = getComputedStyle(el);
            out[id] = {
                painted: Math.round(el.getBoundingClientRect().height * 100) / 100,
                declaredMin: cs.minHeight,
                declaredHeight: cs.height,
                iconH: Math.round((el.querySelector('svg')
                    ?.getBoundingClientRect().height || 0) * 100) / 100,
            };
        }
        return out;
    });
    for (const [id, v] of Object.entries(m)) {
        check(`R1 ${label}: #${id} painted height is the mockup's 32px`,
            v.painted, 32);
        check(`R1 ${label}: #${id} declares min-height 32px`,
            px(v.declaredMin), 32);
    }

    // R1-STRIP (W14 item 7): the permanent '+' is the first child of the
    // session strip, icon-only at every tier, and fits the fine-pointer 40px
    // strip tier at 30px (the same fit the header buttons get in their 44px
    // tier). The 44px coarse floor is pinned by the touch-tier blocks below.
    const strip = await page.evaluate(() => {
        const btn = document.getElementById('newConnectionBtn');
        return {
            stripHome: !!btn?.parentElement
                ?.classList.contains('session-tabs-row'),
            firstChild: btn?.parentElement?.firstElementChild === btn,
            painted: Math.round(btn.getBoundingClientRect().height * 100) / 100,
            declaredMin: getComputedStyle(btn).minHeight,
            labelHidden: btn
                && getComputedStyle(btn.querySelector('.btn-label'))
                    .display === 'none',
        };
    });
    check(`R1-STRIP ${label}: New Connection is the strip's first child`,
        [strip.stripHome, strip.firstChild], [true, true]);
    check(`R1-STRIP ${label}: the strip '+' fits the 40px tier at 30px`,
        strip.painted, 30);
    check(`R1-STRIP ${label}: the strip '+' declares min-height 30px`,
        px(strip.declaredMin), 30);
    check(`R1-STRIP ${label}: the strip '+' is icon-only`,
        strip.labelHidden, true);
    check(`R1 ${label}: no page errors`, errors.length, 0);
    await ctx.close();
}

/*
 * The complement that guards R1: raising desktop fidelity must NOT shrink any
 * touch target.
 *
 * The four header buttons are NOT the thing to measure here -- v5 section 3
 * relocates them, so on a coarse pointer they are display:none inside a hidden
 * header (measured: painted height 0 at both iPad portrait and phone390). A
 * "44px floor" assertion on an invisible control is vacuous, which is what the
 * first version of this guard did. Measure the controls that are actually the
 * touch surface instead: the six relocated action buttons and the dock controls.
 */
for (const [label, w, h] of [
    ['iPad portrait 834x1194', 834, 1194],
    ['phone390 390x844', 390, 844],
]) {
    const { ctx, page, errors } = await openShell(w, h, true);
    const m = await page.evaluate(() => {
        const visible = el => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden'
                && r.width > 0 && r.height > 0;
        };
        const row = document.getElementById('touchActionRow');
        const actions = [...row.querySelectorAll('button')].filter(visible);
        const dock = ['mobileMoreBtn', 'mobileKeypadBtn', 'mobileSendBtn']
            .map(id => document.getElementById(id)).filter(visible);
        const reach = el => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return !!hit && (hit === el || el.contains(hit));
        };
        return {
            actionCount: actions.length,
            dockCount: dock.length,
            // The band that receives the tap, which Entry 3/7 implement as an
            // invisible centred ::after rather than by growing the painted box.
            minActionHit: Math.min(...actions.map(el => {
                const after = getComputedStyle(el, '::after');
                const h = parseFloat(after.height);
                return Number.isFinite(h) && h > 0
                    ? Math.round(h)
                    : Math.round(el.getBoundingClientRect().height);
            })),
            minDockPainted: Math.min(...dock.map(el =>
                Math.round(el.getBoundingClientRect().height))),
            allActionsReachable: actions.every(reach),
        };
    });
    check(`R1 guard ${label}: six touch actions are present`, m.actionCount, 6);
    check(`R1 guard ${label}: touch action hit band stays >= 44px`,
        m.minActionHit >= 44, true);
    check(`R1 guard ${label}: every touch action wins its own hit test`,
        m.allActionsReachable, true);
    check(`R1 guard ${label}: dock controls stay >= 44px`,
        m.minDockPainted >= 44, true);
    check(`R1 guard ${label}: no page errors`, errors.length, 0);
    await ctx.close();
}

// ── R2 + R3: keypad key floor kept at 44, radius corrected to 7 ─────────────
for (const [label, w, h] of [
    ['iPad portrait', 834, 1194],
    ['phone390', 390, 844],
    ['phone landscape', 926, 428],
]) {
    const { ctx, page, errors } = await openShell(w, h, true);
    await page.locator('#mobileKeypadBtn').tap();
    await page.locator('#mobileKeypad').waitFor({ state: 'visible' });
    await page.waitForTimeout(140);
    const m = await page.evaluate(() => {
        const keys = [...document.querySelectorAll('.keypad-key')];
        const cs = getComputedStyle(keys[0]);
        return {
            count: keys.length,
            minHeight: cs.minHeight,
            radius: cs.borderTopLeftRadius,
            radii: [...new Set(keys.map(k =>
                getComputedStyle(k).borderTopLeftRadius))],
            minPainted: Math.min(...keys.map(k =>
                Math.round(k.getBoundingClientRect().height))),
        };
    });
    // R2: the floor WINS over mockup 347's 39px on a touch surface (owner ruling,
    // Entry 29). Asserted so a later "fidelity" pass cannot silently
    // drop it to 39.
    check(`R2 keypad (${label}): min-height stays at the 44px touch floor`,
        px(m.minHeight), 44);
    check(`R2 keypad (${label}): every key paints at least 44px`,
        m.minPainted >= 44, true);
    // R3: mockup 347 border-radius:7px.
    check(`R3 keypad (${label}): key border-radius is the mockup's 7px`,
        px(m.radius), 7);
    check(`R3 keypad (${label}): all keys share one radius`, m.radii.length, 1);
    // Would-be-vacuous guard: a hidden or empty keypad must not satisfy the above.
    check(`R2/R3 keypad (${label}): the full 16-key inventory is present`,
        m.count, 16);
    check(`R2/R3 keypad (${label}): no page errors`, errors.length, 0);
    await ctx.close();
}

// ── R4: dropdowns hang exactly 1px below their trigger ──────────────────────
// Mockup 265-268: top: calc(100% + 1px). Measured trigger-relative, because that
// is the relationship the mockup expresses; the offset parent is an
// implementation detail and a percentage against the wrong box is exactly the
// bug this pins.
for (const [label, w, h, triggerId, panelId] of [
    ['iPad layout menu', 834, 1194, 'layoutMenuBtn', 'layoutMenu'],
    ['phone390 More sheet', 390, 844, 'mobileMoreBtn', 'mobileMoreSheet'],
]) {
    const { ctx, page, errors } = await openShell(w, h, true);
    await page.locator(`#${triggerId}`).tap();
    await page.waitForTimeout(240);
    const m = await page.evaluate(({ triggerId, panelId }) => {
        const t = document.getElementById(triggerId).getBoundingClientRect();
        const p = document.getElementById(panelId).getBoundingClientRect();
        return {
            gapBelow: Math.round((p.top - t.bottom) * 100) / 100,
            gapAbove: Math.round((t.top - p.bottom) * 100) / 100,
            opensDownward: p.top >= t.bottom,
            panelH: Math.round(p.height),
            insideRight: Math.round(window.innerWidth - p.right),
            insideLeft: Math.round(p.left),
            insideBottom: Math.round(window.innerHeight - p.bottom),
            insideTop: Math.round(p.top),
        };
    }, { triggerId, panelId });
    /*
     * Phone390's More sheet opens UPWARD by the ruled Entry 5 Part B adaptation
     * (the phone header sits at the bottom of the shell), so the 1px is measured
     * on the side it actually opens. The requirement is the SAME: exactly 1px of
     * separation from the trigger.
     */
    const gap = m.opensDownward ? m.gapBelow : m.gapAbove;
    const side = m.opensDownward ? 'below' : 'above';
    check(`R4 ${label}: hangs exactly 1px ${side} its trigger`, gap, 1);
    // Guards, so a panel that collapsed or left the viewport cannot pass.
    check(`R4 ${label}: panel has real height`, m.panelH > 40, true);
    check(`R4 ${label}: right edge inside viewport`, m.insideRight >= 0, true);
    check(`R4 ${label}: left edge inside viewport`, m.insideLeft >= 0, true);
    check(`R4 ${label}: bottom inside viewport`, m.insideBottom >= 0, true);
    check(`R4 ${label}: top inside viewport`, m.insideTop >= 0, true);
    check(`R4 ${label}: no page errors`, errors.length, 0);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
