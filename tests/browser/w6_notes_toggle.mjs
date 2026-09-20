#!/usr/bin/env node
/*
 * W6 focused test — single Notes state flow.
 *
 * Contract:
 *   - Absent notepadCollapsed in localStorage means collapsed (the production
 *     read at app.js: `storedNotepadCollapsed === null || === 'true'`).
 *   - #notepadOpenBtn is the SOLE aria-expanded owner for Notes across both
 *     tiers. No other element in the document carries aria-expanded for the
 *     notepad panel.
 *   - The button TOGGLES on both touch and desktop: first click opens,
 *     second closes.
 *   - X (#notepadCloseBtn) closes on both tiers, returns focus to
 *     #notepadOpenBtn, and calls requestFit.
 *   - Persistence survives real reloads both ways: 'false'/open remains open,
 *     'true'/collapsed remains collapsed.
 *   - requestFit is called on desktop same-button close, desktop X close,
 *     touch same-button close, touch X close, and touch aux-panel-exclusion
 *     close.
 *
 * Run: node tests/browser/w6_notes_toggle.mjs   (from source/)
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
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
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

// Socket.IO array-callback stub + app stubs. Does NOT touch localStorage —
// each test section sets notepadCollapsed explicitly before navigation.
const INIT_SCRIPT = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.io = () => ({
        connected: true,
        on: (name, fn) => {
            if (!window.__socketHandlers[name]) window.__socketHandlers[name] = [];
            window.__socketHandlers[name].push(fn);
        },
        off: noop, once: noop, emit: noop,
        io: { on: noop },
    });
    window.socket = window.io();
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
        trapFocus: noop,
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
    window.i18n = {
        t: (k, d) => d || k,
        getLanguages: () => [], getLanguage: () => 'en', setLanguage: () => {},
    };
`;

// Reusable session seeding after a reload. Does NOT erase notepadCollapsed.
async function seedSession(page) {
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1);
        SessionManager.sessions['S1'] = {
            id: 'S1', session_id: 'S1', host: 's1.example', username: 'u',
            connected: true, isPersistentCandidate: false, terminalId: 'term-S1',
        };
        const wrap = document.createElement('div');
        wrap.id = 'term-S1';
        wrap.className = 'terminal-wrapper';
        wrap.style.height = '600px';
        document.getElementById('terminalsContainer').appendChild(wrap);
        SessionManager.createSessionTab('S1', 's1.example', 'u');
        SessionManager.updateSessionStatus('S1', 'connected');
        SessionManager.assignSessionToPane('S1', 0);
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    await page.waitForTimeout(40);
    // Spy requestFit / fitAllTerminals.
    await page.evaluate(`
        window.__fitCalls = [];
        const __rf = TerminalManager.requestFit.bind(TerminalManager);
        TerminalManager.requestFit = (sid, ...rest) => {
            window.__fitCalls.push(sid || '__no_sid__');
            return __rf(sid, ...rest);
        };
        TerminalManager.fitAllTerminals = () => {
            window.__fitCalls.push('__all__');
        };
        TerminalManager.destroyTerminal = () => {};
        TerminalManager.createTerminal = () => {};
        TerminalManager.attachTerminal = () => {};
        TerminalManager.setupInputHandler = () => {};
    `);
}

async function newPage(w, h, { touch = true, collapsed = null } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch, isMobile: touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', route => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    // Set notepadCollapsed BEFORE navigation via addInitScript. This runs once
    // per page load; reloads preserve whatever product code wrote.
    let ls = '';
    if (collapsed === true) ls = 'localStorage.setItem("notepadCollapsed","true");';
    else if (collapsed === false) ls = 'localStorage.setItem("notepadCollapsed","false");';
    else ls = 'localStorage.removeItem("notepadCollapsed");';
    await page.addInitScript(INIT_SCRIPT + ls);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // Fire all connect handlers.
    await page.evaluate(() => {
        const cbs = window.__socketHandlers?.connect;
        if (Array.isArray(cbs)) cbs.forEach(fn => { try { fn(); } catch(e) {} });
    });
    await page.waitForTimeout(80);
    await seedSession(page);
    return { ctx, page, errors };
}

function aria(page, id) {
    return page.evaluate((id) =>
        document.getElementById(id)?.getAttribute('aria-expanded'), id);
}

// ============================================================================
// §1 #notepadOpenBtn is the SOLE Notes aria-expanded owner in the document.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false });
    // Query the ENTIRE DOM for elements whose aria-controls points at
    // notepadPanel, or whose id relates to notepad, that carry aria-expanded.
    const owners = await page.evaluate(() => {
        const all = document.querySelectorAll('[aria-expanded]');
        return [...all].filter(el => {
            const ctrls = el.getAttribute('aria-controls');
            const id = el.id || '';
            return ctrls === 'notepadPanel'
                || /notepad/i.test(id);
        }).map(el => ({ id: el.id, tag: el.tagName,
            expanded: el.getAttribute('aria-expanded'),
            hidden: el.hidden,
            display: getComputedStyle(el).display }));
    });
    check('§1 exactly one Notes aria-expanded owner', owners.length, 1);
    check('§1 that owner is #notepadOpenBtn',
        owners[0]?.id, 'notepadOpenBtn');
    check('§1 withdrawn #notepadToggle absent from the document',
        await page.evaluate(() =>
            document.querySelectorAll('#notepadToggle').length), 0);
    check('§1 no .notepad-toggle-btn class in the document',
        await page.evaluate(() =>
            document.querySelectorAll('.notepad-toggle-btn').length), 0);
    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §2 Touch: button toggles .mobile-open (open→close→open).
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });

    // Absent notepadCollapsed → collapsed. On touch the sheet starts closed.
    // First click opens.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    check('§2 touch: first click opens sheet',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('mobile-open')), true);
    check('§2 touch: aria-expanded=true on open',
        await aria(page, 'notepadOpenBtn'), 'true');

    // Second click closes (toggle).
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    check('§2 touch: second click closes sheet',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('mobile-open')), true);
    check('§2 touch: aria-expanded=false on close',
        await aria(page, 'notepadOpenBtn'), 'false');

    // Third click re-opens.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    check('§2 touch: third click re-opens sheet',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('mobile-open')), true);
    check('§2 touch: aria-expanded=true on re-open',
        await aria(page, 'notepadOpenBtn'), 'true');
    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §3 Touch: X close returns focus to #notepadOpenBtn and calls requestFit.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    // Open first.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    await page.evaluate(() => { window.__fitCalls = []; });
    // Close via X.
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(60);
    check('§3 touch: X closes sheet',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('mobile-open')), true);
    check('§3 touch: X aria-expanded=false',
        await aria(page, 'notepadOpenBtn'), 'false');
    check('§3 touch: X returns focus to #notepadOpenBtn',
        await page.evaluate(() => document.activeElement?.id), 'notepadOpenBtn');
    check('§3 touch: X calls requestFit',
        await page.evaluate(() => window.__fitCalls.length > 0), true);
    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §4 Touch: button toggle-close returns focus and calls requestFit.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    await page.evaluate(() => { window.__fitCalls = []; });
    await page.click('#notepadOpenBtn'); // toggle close
    await page.waitForTimeout(60);
    check('§4 touch: toggle close returns focus to #notepadOpenBtn',
        await page.evaluate(() => document.activeElement?.id), 'notepadOpenBtn');
    check('§4 touch: toggle close calls requestFit',
        await page.evaluate(() => window.__fitCalls.length > 0), true);
    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §5 Touch: aux-panel-exclusion close calls requestFit.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    await page.evaluate(() => { window.__fitCalls = []; });
    // Simulate the command rail opening (triggers aux-panel-exclusion).
    await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening', {
            detail: { panel: 'command-rail' },
        }));
    });
    await page.waitForTimeout(60);
    check('§5 touch: aux-exclusion closes sheet',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('mobile-open')), true);
    check('§5 touch: aux-exclusion calls requestFit',
        await page.evaluate(() => window.__fitCalls.length > 0), true);
    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §6 Desktop: button toggles .collapsed (open→close→open).
//    Absent notepadCollapsed → collapsed. First click opens.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false });

    const startsCollapsed = await page.evaluate(() =>
        document.getElementById('notepadPanel').classList.contains('collapsed'));
    check('§6 desktop: starts collapsed (absent localStorage)', startsCollapsed, true);
    check('§6 desktop: aria-expanded=false when collapsed',
        await aria(page, 'notepadOpenBtn'), 'false');

    // First click opens.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    check('§6 desktop: first click opens (un-collapsed)',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('collapsed')), true);
    check('§6 desktop: aria-expanded=true on open',
        await aria(page, 'notepadOpenBtn'), 'true');

    // Second click closes (toggle).
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(40);
    check('§6 desktop: second click closes (collapsed)',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('collapsed')), true);
    check('§6 desktop: aria-expanded=false on close',
        await aria(page, 'notepadOpenBtn'), 'false');
    check('§6 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §7 Desktop: X close collapses, returns focus, calls requestFit.
//    Start from open state (notepadCollapsed=false).
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false, collapsed: false });
    const isOpen = await page.evaluate(() =>
        !document.getElementById('notepadPanel').classList.contains('collapsed'));
    check('§7 desktop: starts open (notepadCollapsed=false)', isOpen, true);

    await page.evaluate(() => { window.__fitCalls = []; });
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(350); // wait for the 300ms setTimeout
    check('§7 desktop: X collapses',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('collapsed')), true);
    check('§7 desktop: X aria-expanded=false',
        await aria(page, 'notepadOpenBtn'), 'false');
    check('§7 desktop: X returns focus to #notepadOpenBtn',
        await page.evaluate(() => document.activeElement?.id), 'notepadOpenBtn');
    check('§7 desktop: X calls requestFit',
        await page.evaluate(() => window.__fitCalls.length > 0), true);
    check('§7 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §8 Desktop: same-button close calls requestFit.
//    Start from open state, toggle close via #notepadOpenBtn.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false, collapsed: false });
    await page.evaluate(() => { window.__fitCalls = []; });
    await page.click('#notepadOpenBtn'); // toggle close
    await page.waitForTimeout(350);
    check('§8 desktop: same-button close calls requestFit',
        await page.evaluate(() => window.__fitCalls.length > 0), true);
    check('§8 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §9 Persistence: false/open remains open across real reload.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false, collapsed: false });
    // Product code should have written 'false' to localStorage on open.
    // (setupResizeHandle reads it at init; collapsed=false sets it.)
    // Reload WITHOUT the initScript erasing it.
    await page.addInitScript(INIT_SCRIPT); // no localStorage manipulation
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => {
        const cbs = window.__socketHandlers?.connect;
        if (Array.isArray(cbs)) cbs.forEach(fn => { try { fn(); } catch(e) {} });
    });
    await page.waitForTimeout(80);
    await seedSession(page);

    const stored = await page.evaluate(() => localStorage.getItem('notepadCollapsed'));
    const isOpen = await page.evaluate(() =>
        !document.getElementById('notepadPanel').classList.contains('collapsed'));
    check('§9 reload preserves notepadCollapsed=false', stored, 'false');
    check('§9 reload starts open', isOpen, true);
    check('§9 reload aria-expanded=true',
        await aria(page, 'notepadOpenBtn'), 'true');
    check('§9 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §10 Persistence: true/collapsed remains collapsed across real reload.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false, collapsed: true });
    // Product code starts collapsed. Reload preserving localStorage.
    await page.addInitScript(INIT_SCRIPT);
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => {
        const cbs = window.__socketHandlers?.connect;
        if (Array.isArray(cbs)) cbs.forEach(fn => { try { fn(); } catch(e) {} });
    });
    await page.waitForTimeout(80);
    await seedSession(page);

    const stored = await page.evaluate(() => localStorage.getItem('notepadCollapsed'));
    const isCollapsed = await page.evaluate(() =>
        document.getElementById('notepadPanel').classList.contains('collapsed'));
    check('§10 reload preserves notepadCollapsed=true', stored, 'true');
    check('§10 reload starts collapsed', isCollapsed, true);
    check('§10 reload aria-expanded=false',
        await aria(page, 'notepadOpenBtn'), 'false');
    check('§10 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §11 D5 PAINTED state across every touch tier — attributes are not enough.
//
// §2-§5 pin the class and the aria attribute. Neither can tell an open sheet
// from one that is "open" while parked off-screen or behind something: the panel
// is position:absolute with z-index 900 and is moved by a transform, so
// .mobile-open plus aria-expanded="true" would still read correct if the
// transform stopped being reset. Measured here, per tier:
//
//   closed — the panel's own centre hit-tests to something OUTSIDE the panel
//            (measured: #sessionBar), i.e. it is genuinely out of the way
//   open   — the centre hit-tests INSIDE the panel, and the panel is fully
//            within the viewport
//   again  — back to the closed state, so the toggle is symmetric when painted
//
// Note the tier asymmetry, which is why width alone is not the measure: at
// iPad and above the closed panel measures 0px wide (the desktop `.collapsed`
// rule applies at >=768 and the sheet is not open yet), while on phone tiers it
// keeps its full width and is translated below the fold. Hit-testing covers both
// without encoding either.
// ============================================================================
for (const [label, w, h] of [
    ['phone 390', 390, 844],
    ['phone 359', 359, 780],
    ['phone landscape', 844, 390],
    ['iPad portrait', 768, 1024],
    ['iPad 834', 834, 1194],
    ['iPad landscape', 1024, 768],
]) {
    const { ctx, page, errors } = await newPage(w, h, { touch: true });
    const read = () => page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        const b = panel.getBoundingClientRect();
        const x = Math.min(Math.max(Math.round(b.left + b.width / 2), 1),
            window.innerWidth - 1);
        const y = Math.min(Math.max(Math.round(b.top + b.height / 2), 1),
            window.innerHeight - 1);
        const hit = document.elementFromPoint(x, y);
        return {
            box: `${Math.round(b.width)}x${Math.round(b.height)}`,
            inPanel: hit ? panel.contains(hit) : false,
            hitId: hit ? (hit.id || hit.className) : null,
            fullyInViewport: b.width > 0 && b.height > 0
                && b.left >= -1 && b.right <= window.innerWidth + 1
                && b.top >= -1 && b.bottom <= window.innerHeight + 1,
            mobileOpen: panel.classList.contains('mobile-open'),
        };
    });

    const closed = await read();
    check(`§11 ${label}: closed sheet does not own its own centre`,
        closed.inPanel, false);
    check(`§11 ${label}: closed sheet is not the paint at that point`,
        closed.mobileOpen, false);

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(360);
    const open = await read();
    check(`§11 ${label}: open sheet carries .mobile-open`, open.mobileOpen, true);
    check(`§11 ${label}: open sheet owns its own centre (${open.hitId})`,
        open.inPanel, true);
    check(`§11 ${label}: open sheet is fully inside the viewport (${open.box})`,
        open.fullyInViewport, true);
    check(`§11 ${label}: open aria-expanded=true`,
        await aria(page, 'notepadOpenBtn'), 'true');

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(360);
    const again = await read();
    check(`§11 ${label}: toggling again releases the centre`, again.inPanel, false);
    check(`§11 ${label}: toggling again drops .mobile-open`, again.mobileOpen, false);
    check(`§11 ${label}: toggling again sets aria-expanded=false`,
        await aria(page, 'notepadOpenBtn'), 'false');
    check(`§11 ${label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ============================================================================
// §12 D5 "terminal resize in sync" on desktop, measured in pixels.
//
// On desktop the panel shares the workspace grid with the terminal, so opening
// Notes must actually TAKE width from the terminal and closing must give it
// back. §6-§8 prove requestFit is called; this proves the geometry moved, which
// is what the user sees. A fit that is requested while the grid never changes
// would satisfy the former and not the latter.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(1280, 800, { touch: false });
    const read = () => page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        const term = document.getElementById('terminalGrid')
            || document.getElementById('terminalsContainer');
        const p = panel.getBoundingClientRect();
        const t = term.getBoundingClientRect();
        return { panelW: Math.round(p.width), termW: Math.round(t.width),
            collapsed: panel.classList.contains('collapsed') };
    });

    const collapsed = await read();
    check('§12 desktop: starts collapsed', collapsed.collapsed, true);
    check('§12 desktop: a collapsed panel takes no width', collapsed.panelW, 0);

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(400);
    const opened = await read();
    check('§12 desktop: opening gives the panel real width',
        opened.panelW > 200, true);
    check('§12 desktop: the terminal gives that width up',
        opened.termW < collapsed.termW, true);
    // The two must account for each other: the panel cannot overlay the
    // terminal, which is what the mockup's split grid means.
    check(`§12 desktop: panel + terminal still fit the row `
        + `(${opened.panelW}+${opened.termW} vs ${collapsed.termW})`,
        opened.panelW + opened.termW <= collapsed.termW + 24, true);

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(400);
    const reclosed = await read();
    check('§12 desktop: closing returns the panel to zero width',
        reclosed.panelW, 0);
    check('§12 desktop: the terminal gets its width back',
        reclosed.termW, collapsed.termW);
    check('§12 desktop: no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
