/*
 * P3 — Note & exit-scroll affordances contract.
 *
 *  §1  Desktop #notepadOpenBtn in .tab-row-actions: present at >=1024px,
 *      hidden below; real click opens the notepad panel (removes collapsed
 *      class, updates arrow + aria-expanded); a11y title/aria-label from
 *      terminal.notepad.
 *  §2  Contextual #exitScrollBtn: hidden and boxless at rest; visible in an
 *      explicit tmux scroll state at every touch tier. Phone portrait and iPad
 *      portrait are icon-only; wider touch layouts, including iPad and phone
 *      landscape, show one short, non-wrapping label. A trusted click emits
 *      tmux_exit_copy_mode once,
 *      disables the control in flight, and the real registered completion
 *      handler restores the hidden rest state.
 *  §3  Capability/density complements: touch owns the contextual control state,
 *      while phone shape and iPad portrait stay icon-only regardless of raw width.
 *
 * Uses the same renderTemplate / http-server / STUBS infrastructure as the
 * existing browser suites. No production source is modified by this test.
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
        // Serve an inert body for the socket.io client library so it does not
        // overwrite the test's window.io stub. app.js calls io() at load.
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            res.end('// inert: socket.io stub provided by test harness');
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

// Socket stub that RECORDS every socket.on(event, handler) callback so the
// real app.js handler for tmux_copy_mode_exited is actually registered.
// app.js calls io() at load to get the socket. The real socket.io client
// library is loaded via a <script> tag, so this test's HTTP server
// special-cases that URL and returns an inert body, keeping our stub's
// window.io intact. The test-only fire helper invokes the real registered
// handler with a payload.
const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.__emitLog = [];
    window.__fireSocket = (ev, data) => {
        if (window.__socketHandlers[ev]) window.__socketHandlers[ev](data);
    };
    window.io = () => ({
        on: (ev, fn) => { window.__socketHandlers[ev] = fn; },
        off: noop, once: noop,
        emit: (ev, payload) => { window.__emitLog.push({ ev, payload }); },
        io: { on: noop },
    });
    window.TerminalManager = {
        createTerminal: noop, disposeTerminal: noop, fitAllTerminals: noop,
        fitTerminal: noop, focusTerminal: noop, applyThemeToAll: noop,
        requestFit: noop, cancelPendingFit: noop,
        getTerminal: () => null, writeToTerminal: noop, destroyTerminal: noop,
        isTouchShell: () => true, isDesktopShell: () => false,
        appOwnsMouse: () => false,
    };
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function newPage(w, h, touch = true) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch,
        isMobile: touch,
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
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    return { ctx, page, errors };
}

async function seedSession(page, id, opts = {}) {
    return await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = {
            id, session_id: id,
            host: opts.host || 'host.example',
            port: opts.port || 22,
            username: opts.username || 'sshdeck',
            authType: opts.authType || 'key',
            keyId: opts.keyId || 'k1',
            jumpHostId: opts.jumpHostId || null,
            displayName: opts.displayName || 'Prod DB',
            connected: true,
            terminalId: `term-${id}`,
            useTmux: opts.useTmux !== false,
            viaJump: opts.viaJump || null,
        };
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, opts.host || 'host.example', opts.username || 'sshdeck');
        }
        SessionManager.activeSessionId = id;
        return SessionManager.sessions[id];
    }, { id, opts });
}

// ============================================================================
// §1 — Desktop #notepadOpenBtn in .tab-row-actions
// ============================================================================
for (const [label, w, h, touch] of [
    ['desktop 1440x900', 1440, 900, false],
    ['laptop 1024x768', 1024, 768, false],
    ['tablet 768x1024 (below icon threshold)', 768, 1024, true],
]) {
    const { ctx, page, errors } = await newPage(w, h, touch);
    await seedSession(page, 'n1', { useTmux: true });

    const state = await page.evaluate(() => {
        const btn = document.getElementById('notepadOpenBtn');
        if (!btn) return null;
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        return {
            exists: !!btn,
            display: cs.display,
            visible: cs.display !== 'none' && r.width > 0,
            w: Math.round(r.width),
            h: Math.round(r.height),
            i18nTitle: btn.dataset.i18nTitle,
            i18nAriaLabel: btn.dataset.i18nAriaLabel,
            iconHref: btn.querySelector('use')?.getAttribute('href') || null,
            target: Math.round(r.width) >= 44 && Math.round(r.height) >= 44,
            ariaControls: btn.getAttribute('aria-controls'),
        };
    });

    check(`${label}: notepadOpenBtn exists`, state?.exists, true);
    /*
     * The two-control era is over, and with it the "hidden on touch" rule.
     * v5 section 3 lines 35-40 list Ghi chú among the six touch header actions,
     * so the docked #mobileNotepadBtn was REMOVED and #notepadOpenBtn is "The
     * ONE Notes control" (index.html:243-252), relocating into the touch action
     * row / More sheet rather than a second dock button existing. Line 45
     * forbids a second trigger outright, and the aria-controls/aria-expanded
     * pair moved onto this node because it is what opens the touch sheet now.
     *
     * The old block hid this control on touch and pointed at a CSS rule
     * (`.tab-row-actions #notepadOpenBtn`) that no longer exists -- so on a
     * touch shell it asserted that the only Notes affordance must be invisible.
     * On touch it must instead be present AND a real 44x44 target, which is the
     * assertion the removed dock button used to carry: coverage moves here
     * rather than being dropped.
     */
    if (touch) {
        check(`${label}: notepadOpenBtn visible on touch (the ONE Notes control)`,
            state?.visible, true);
        check(`${label}: it is a real 44x44 target on touch`, state?.target, true);
        check(`${label}: it carries the touch sheet aria-controls`,
            state?.ariaControls, 'notepadPanel');
    } else if (w >= 1024) {
        check(`${label}: notepadOpenBtn visible`, state?.visible, true);
        check(`${label}: notepadOpenBtn title is terminal.notepad`, state?.i18nTitle, 'terminal.notepad');
        check(`${label}: notepadOpenBtn aria-label is terminal.notepad`, state?.i18nAriaLabel, 'terminal.notepad');
        // Lucide notebook-pen replaced the Ant "form" glyph in the sprite
        // migration; v5 line 96/124 names it as the Notes icon.
        check(`${label}: notepadOpenBtn uses icon-notebook-pen`, state?.iconHref?.includes('icon-notebook-pen'), true);
    } else {
        check(`${label}: notepadOpenBtn hidden on narrow fine pointers`, state?.visible, false);
    }

    // Real click opens notepad panel (only at desktop width where visible).
    if (w >= 1024) {
        await page.evaluate(() => {
            const panel = document.getElementById('notepadPanel');
            if (panel) panel.classList.add('collapsed');
        });
        const beforeOpen = await page.evaluate(() =>
            document.getElementById('notepadPanel')?.classList.contains('collapsed'));
        check(`${label}: notepad starts collapsed`, beforeOpen, true);

        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(50);
        const afterOpen = await page.evaluate(() => ({
            collapsed: document.getElementById('notepadPanel')?.classList.contains('collapsed'),
            ariaExpanded: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
        }));
        check(`${label}: notepadOpenBtn opens panel`, afterOpen.collapsed, false);
        check(`${label}: notepadOpenBtn aria-expanded true`, afterOpen.ariaExpanded, 'true');

        // W6: the same button toggles. Click again when open = closes.
        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(350);
        const afterClose = await page.evaluate(() => ({
            collapsed: document.getElementById('notepadPanel')?.classList.contains('collapsed'),
            ariaExpanded: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
        }));
        check(`${label}: notepadOpenBtn second click collapses`, afterClose.collapsed, true);
        check(`${label}: notepadOpenBtn aria-expanded false`, afterClose.ariaExpanded, 'false');
    }

    /*
     * The dock Note path, asserted POSITIVELY. The locked outcome hides
     * .notepad-toggle-btn on coarse shells, so absence-of-toggle alone is not
     * evidence of anything: if #mobileNotepadBtn were also unreachable the
     * Notepad would have NO touch entry point and every assertion in this
     * suite would still pass. elementFromPoint is the reachability proof --
     * geometry alone missed exactly this class of defect four tiers over.
     */
    if (touch) {
        const dock = await page.evaluate(() => {
            // v5 section 3 lines 35-40 make Notes one of the six global/action
            // -row controls, so the docked #mobileNotepadBtn was removed and
            // #notepadOpenBtn is the ONE Notes control at every tier (line 45
            // forbids a second trigger). Same retarget as mobile_shell_trusted
            // and header_menus.
            const btn = document.getElementById('notepadOpenBtn');
            if (!btn) return { missing: true };
            const r = btn.getBoundingClientRect();
            const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return {
                visible: getComputedStyle(btn).display !== 'none' && r.width > 0,
                target: Math.round(r.width) >= 44 && Math.round(r.height) >= 44,
                ownsHit: !!(hit && (hit === btn || btn.contains(hit))),
                // W6: the withdrawn in-terminal chevron (#notepadToggle) is
                // gone from the template, not merely hidden.
                toggleNodes: document.querySelectorAll('#notepadToggle').length,
                // The superseded dock control must not return as a second Notes
                // surface (v5 line 45).
                legacyNodes: document.querySelectorAll('#mobileNotepadBtn').length,
            };
        });
        check(`${label}: the Notes control still exists`, dock.missing !== true, true);
        check(`${label}: the superseded dock Note button is gone`, dock.legacyNodes, 0);
        check(`${label}: the Note button is available`, dock.visible, true);
        check(`${label}: it is a real 44x44 target`, dock.target, true);
        check(`${label}: it wins its own hit test`, dock.ownsHit, true);
        check(`${label}: the withdrawn desktop toggle is absent`, dock.toggleNodes, 0);
        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(120);
        check(`${label}: the Note button opens the sheet`,
            await page.evaluate(() => document.querySelector('.notepad-panel')
                .classList.contains('mobile-open')), true);
    }

    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §2 — Contextual #exitScrollBtn: rest/open/closed state + one emit
// ============================================================================
for (const { label, w, h, labeled } of [
    { label: '834×1194 iPad portrait', w: 834, h: 1194, labeled: false },
    { label: '1194×834 iPad landscape', w: 1194, h: 834, labeled: true },
    { label: '926×428 phone landscape', w: 926, h: 428, labeled: true },
    { label: '390×844 phone portrait', w: 390, h: 844, labeled: false },
]) {
    const { ctx, page, errors } = await newPage(w, h);
    await seedSession(page, 'e1', { useTmux: true });

    const read = () => page.evaluate(() => {
        const btn = document.getElementById('exitScrollBtn');
        const send = document.getElementById('mobileSendBtn');
        const label = btn?.querySelector('.btn-label');
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        const labelStyle = label ? getComputedStyle(label) : null;
        const labelRect = label?.getBoundingClientRect();
        const labelRange = label ? document.createRange() : null;
        if (labelRange) labelRange.selectNodeContents(label);
        return {
            hidden: btn.hidden,
            ariaHidden: btn.getAttribute('aria-hidden'),
            display: cs.display,
            width: Math.round(r.width),
            height: Math.round(r.height),
            beforeSend: !!(btn.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING),
            labelText: label?.textContent.trim() || '',
            labelVisible: !!label && labelStyle?.display !== 'none'
                && labelStyle?.visibility !== 'hidden'
                && labelRect.width > 0 && labelRect.height > 0,
            labelLines: labelRange ? labelRange.getClientRects().length : 0,
        };
    });

    const rest = await read();
    check(`${label}: Exit-scroll is hidden at rest`, rest.hidden, true);
    check(`${label}: hidden Exit-scroll has no box`, `${rest.width}x${rest.height}`, '0x0');
    check(`${label}: hidden Exit-scroll is excluded from AT`, rest.ariaHidden, 'true');
    check(`${label}: Exit-scroll precedes Send in DOM`, rest.beforeSend, true);

    await page.evaluate(() => TerminalManager.setScrollState('e1', true));
    await page.waitForTimeout(30);
    const open = await read();
    check(`${label}: explicit scroll state reveals Exit-scroll`, open.hidden, false);
    check(`${label}: revealed Exit-scroll is a 44px target`, open.height >= 44, true);
    check(`${label}: revealed Exit-scroll is exposed to AT`, open.ariaHidden, 'false');
    if (labeled) {
        check(`${label}: wide layout has nonempty Exit-scroll label`,
            open.labelText.length > 0, true);
        check(`${label}: wide layout shows the Exit-scroll label`,
            open.labelVisible, true);
        check(`${label}: wide Exit-scroll label stays on one line`,
            open.labelLines, 1);
        check(`${label}: labeled Exit-scroll is wider than its icon target`,
            open.width > 44, true);
    } else {
        check(`${label}: portrait tier keeps Exit-scroll icon-only`,
            open.labelVisible, false);
        check(`${label}: portrait tier paints no label line`,
            open.labelLines, 0);
        check(`${label}: icon-only Exit-scroll stays exactly 44px wide`,
            open.width, 44);
    }

    await page.click('#exitScrollBtn');
    await page.waitForTimeout(30);
    const flight = await page.evaluate(() => ({
        emits: window.__emitLog.filter(e => e.ev === 'tmux_exit_copy_mode'),
        disabled: document.getElementById('exitScrollBtn').disabled,
    }));
    check(`${label}: Exit-scroll emits once`, flight.emits.length, 1);
    check(`${label}: Exit-scroll targets the active session`,
        flight.emits[0]?.payload?.session_id, 'e1');
    check(`${label}: Exit-scroll disables during flight`, flight.disabled, true);

    await page.evaluate(() => window.__fireSocket('tmux_copy_mode_exited', {
        ok: true, was_in_mode: true, session_id: 'e1'
    }));
    await page.waitForTimeout(30);
    const closed = await read();
    check(`${label}: successful exit hides the contextual control`, closed.hidden, true);
    check(`${label}: successful exit restores a boxless rest state`,
        `${closed.width}x${closed.height}`, '0x0');
    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §4 — Command/Note cross-state orthogonality.
//
// Regression for the defect visual QA phase 1 measured: openLibrary() collapsed
// the notepad through setNotepadCollapsed(true) (which PERSISTS
// notepadCollapsed), and the mobile toggle then set .mobile-open without the
// sheet ever getting width, because .collapsed carries `width: 0 !important`
// (style.css inside `@media (min-width: 768px)`) and beat the coarse sheet's
// plain `width: auto`. Result: an "open" sheet 0px wide at 768x1024, 1024x768
// and 844x390; 390x844 escaped only because that block does not match below
// 768px.
//
// The fix keeps the two states ORTHOGONAL rather than clearing one from the
// other: touch owns .mobile-open + its aria-expanded on #notepadOpenBtn and
// never touches .collapsed or localStorage, while
// `.collapsed:not(.mobile-open)` lets the sheet have width with the collapsed
// desktop state intact underneath. Clearing .collapsed from the touch path
// would have avoided the write yet still desynced the pair on a hybrid device
// moving coarse -> fine without a reload.
//
// So each touch tier starts from a PERSISTED, COLLAPSED desktop state and
// proves it survives untouched across open and close. Both width sides of the
// 768px gate are covered, and both fine tiers keep the existing persisted
// behaviour asserted separately.
// ============================================================================
for (const [label, w, h, touch] of [
    ['phone portrait 390x844', 390, 844, true],
    ['tablet portrait 768x1024', 768, 1024, true],
    ['phone landscape 844x390', 844, 390, true],
    ['tablet landscape 1024x768', 1024, 768, true],
    ['laptop 1280x800', 1280, 800, false],
    ['desktop 1920x1080', 1920, 1080, false],
]) {
    const { ctx, page, errors } = await newPage(w, h, touch);
    await seedSession(page, 'x1', { useTmux: true });

    await page.evaluate(() => {
        localStorage.setItem('notepadCollapsed', 'true');
        document.getElementById('notepadPanel')?.classList.add('collapsed');
    });
    check(`${label}: preference starts true`,
        await page.evaluate(() => localStorage.getItem('notepadCollapsed')), 'true');
    check(`${label}: panel starts .collapsed`,
        await page.evaluate(() =>
            document.getElementById('notepadPanel')?.classList.contains('collapsed')), true);

    // W6: #notepadOpenBtn is the sole Notes aria-expanded owner. Capture its
    // rest-state aria-expanded so the open/close transitions below prove the
    // ONE owner tracks the sheet, rather than testing a withdrawn second node.
    const openBtnAriaBefore = await page.evaluate(() =>
        document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'));

    const controls = await page.evaluate(() => {
        const vis = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden'
                && Math.round(r.width) > 0 && Math.round(r.height) > 0;
        };
        return ['mobileNotepadBtn', 'notepadOpenBtn']
            .filter(id => vis(document.getElementById(id)));
    });
    check(`${label}: exactly one visible Note control`, controls.length, 1);
    // v5 line 45 forbids a second Notes trigger, so the ONE control is
    // #notepadOpenBtn at EVERY tier now -- the removed dock button is no
    // longer the touch-tier answer.
    check(`${label}: and it is the expected one`, controls[0], 'notepadOpenBtn');

    if (touch) {
        const rest = await page.evaluate(() => {
            // aria-controls/aria-expanded moved off the removed dock button
            // onto #notepadOpenBtn: they describe the touch sheet this node
            // now opens (index.html:243-252).
            const b = document.getElementById('notepadOpenBtn');
            return {
                aria: b?.getAttribute('aria-expanded'),
                controls: b?.getAttribute('aria-controls'),
            };
        });
        check(`${label}: Notes aria-expanded false at rest`, rest.aria, 'false');
        check(`${label}: Notes aria-controls the panel`, rest.controls, 'notepadPanel');
    }

    // ACTION 1 — open Command.
    await page.evaluate(() => CommandLibrary.openLibrary({ invoker: null }));
    await page.waitForTimeout(120);
    const afterCommand = await page.evaluate(() => ({
        railOpen: document.getElementById('commandRail')?.classList.contains('aux-open'),
        mobileOpen: document.getElementById('notepadPanel')?.classList.contains('mobile-open'),
        collapsed: document.getElementById('notepadPanel')?.classList.contains('collapsed'),
        dockAria: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
        pref: localStorage.getItem('notepadCollapsed'),
    }));
    check(`${label}: Command rail open`, afterCommand.railOpen, true);
    check(`${label}: Note sheet closed by exclusion`, afterCommand.mobileOpen, false);
    check(`${label}: preference after Command open`, afterCommand.pref, 'true');
    check(`${label}: .collapsed after Command open`, afterCommand.collapsed, true);
    if (touch) {
        check(`${label}: dock aria false after exclusion`, afterCommand.dockAria, 'false');
    }

    // ACTION 2 — open Note via this tier's own control.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(200);
    const afterNote = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        return {
            width: Math.round(r.width), height: Math.round(r.height),
            collapsed: p.classList.contains('collapsed'),
            mobileOpen: p.classList.contains('mobile-open'),
            visible: cs.display !== 'none' && cs.visibility !== 'hidden',
            dockAria: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
            railOpen: document.getElementById('commandRail')?.classList.contains('aux-open'),
            pref: localStorage.getItem('notepadCollapsed'),
        };
    });
    check(`${label}: open notepad has non-zero width`, afterNote.width > 0, true);
    check(`${label}: open notepad has real height`, afterNote.height > 0, true);
    check(`${label}: open notepad is visible`, afterNote.visible, true);
    check(`${label}: opening Note closed Command`, afterNote.railOpen, false);

    if (touch) {
        check(`${label}: sheet open`, afterNote.mobileOpen, true);
        check(`${label}: .collapsed PRESERVED under the open sheet`,
            afterNote.collapsed, true);
        check(`${label}: preference PRESERVED true`, afterNote.pref, 'true');
        check(`${label}: dock aria true when open`, afterNote.dockAria, 'true');
        check(`${label}: sole aria owner tracks the sheet (was ${openBtnAriaBefore})`,
            afterNote.dockAria, 'true');
    } else {
        check(`${label}: desktop open clears .collapsed`, afterNote.collapsed, false);
        check(`${label}: desktop notepadOpenBtn aria-expanded true`, afterNote.dockAria, 'true');
        check(`${label}: desktop persists open`, afterNote.pref, 'false');
    }

    /*
     * ACTION 3 — closing the sheet (touch only).
     *
     * W6: the Notes button toggles. Pressing it while the sheet is open
     * closes it, returns focus, and refits — the same path as #notepadCloseBtn.
     * The close control is then tested independently to prove both close paths
     * agree and hand focus back.
     */
    if (touch) {
        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(150);
        const afterToggleClose = await page.evaluate(() => ({
            mobileOpen: document.getElementById('notepadPanel')?.classList.contains('mobile-open'),
            dockAria: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
            focused: document.activeElement?.id,
        }));
        check(`${label}: re-pressing Notes closes the sheet (W6 toggle)`,
            afterToggleClose.mobileOpen, false);
        check(`${label}: dock aria false on toggle close`,
            afterToggleClose.dockAria, 'false');
        check(`${label}: toggle close returns focus to the opener`,
            afterToggleClose.focused, 'notepadOpenBtn');

        // Re-open via the button, then close via X to prove the second path.
        await page.click('#notepadOpenBtn');
        await page.waitForTimeout(150);
        await page.click('#notepadCloseBtn');
        await page.waitForTimeout(150);
        const afterClose = await page.evaluate(() => ({
            mobileOpen: document.getElementById('notepadPanel')?.classList.contains('mobile-open'),
            collapsed: document.getElementById('notepadPanel')?.classList.contains('collapsed'),
            dockAria: document.getElementById('notepadOpenBtn')?.getAttribute('aria-expanded'),
            pref: localStorage.getItem('notepadCollapsed'),
            focused: document.activeElement?.id,
        }));
        check(`${label}: the close control closes the sheet`, afterClose.mobileOpen, false);
        check(`${label}: .collapsed STILL true after close`, afterClose.collapsed, true);
        check(`${label}: preference STILL true after close`, afterClose.pref, 'true');
        check(`${label}: dock aria false after close`, afterClose.dockAria, 'false');
        check(`${label}: closing returns focus to the Notes opener`,
            afterClose.focused, 'notepadOpenBtn');
    }

    check(`${label}: no page errors`, errors.length, 0);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
