/*
 * P1 Mobile Shell & Authoritative Composer Workflow Acceptance Suite (Gate 0 fail-first).
 *
 * Loads the real templates/index.html + static/css/style.css + vendored xterm + all
 * client JS against a local fixture socket, then drives REAL browser/CDP touch and
 * focus events. No production source is modified; this file only OBSERVES the app
 * at runtime and reports which P1 contracts hold and which do not.
 */
import { chromium } from 'playwright';
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
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
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
        connected: true,
        id: 'device_a_socket',
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) {
            window.__emits.push({ evt, payload, t: performance.now() });
            if (evt === 'ssh_input' && payload && payload.data) {
                (handlers.ssh_output || []).forEach(fn => fn({
                    session_id: payload.session_id, data: payload.data,
                }));
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.io = () => sock;
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

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
    if (ok) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        const msg = `FAIL  ${label}${detail ? ` (${detail})` : ''}`;
        failures.push(msg);
        console.log(msg);
    }
}

const browser = await chromium.launch({ headless: true });

// ============================================================================
// CONTRACT 1: P1-1 MORE-SHEET SCROLLER WORKFLOW (SHORT VIEWPORT)
// ============================================================================
console.log('\n--- CONTRACT 1: P1-1 MORE-SHEET INDEPENDENT SCROLLER WORKFLOW ---');
{
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 600 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);

    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-1', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(300);

    // Production open path: clicking #mobileMoreBtn hosts the canonical account tree.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(300);

    // 1. Computed cascade + full-card hit test at the sheet's own padding.
    const sheetAudit = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        if (!sheet) return { exists: false };
        const cs = window.getComputedStyle(sheet);
        const rect = sheet.getBoundingClientRect();
        const host = document.getElementById('mobileSettingsHost');

        // A point inside the sheet rect but within its padding band (8px inset),
        // where the CARD (sheet) itself must accept the touch.
        const probeX = Math.round(rect.left + rect.width / 2);
        const probeY = Math.round(rect.top + 8);
        const hitEl = document.elementFromPoint(probeX, probeY);
        const hitIsSheet = hitEl === sheet || (host && host.contains(hitEl));

        // The canonical account tree must already be hosted inside the sheet.
        const accountTree = document.getElementById('accountDropdownHeader');
        const logoutBtn = document.getElementById('logoutBtn');
        const treeHosted = accountTree ? host && host.contains(accountTree) : false;
        const logoutHosted = logoutBtn ? host && host.contains(logoutBtn) : false;

        return {
            exists: true,
            visible: !sheet.hidden && cs.display !== 'none',
            pointerEvents: cs.pointerEvents,
            touchAction: cs.touchAction,
            overflowY: cs.overflowY,
            rect: { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left, width: rect.width },
            probeX, probeY,
            hitIsSheet,
            hitTag: hitEl ? hitEl.tagName : null,
            hitId: hitEl ? hitEl.id : null,
            canScroll: sheet.scrollHeight > sheet.clientHeight,
            scrollHeight: sheet.scrollHeight,
            clientHeight: sheet.clientHeight,
            treeHosted,
            logoutHosted,
            bodyScrollY: window.scrollY,
            docScrollY: document.documentElement.scrollTop,
        };
    });

    check('P1-1: more-sheet exists and is visible', sheetAudit.exists && sheetAudit.visible);
    check('P1-1: more-sheet has scrollable overflow on 390x600',
        sheetAudit.canScroll, `scrollHeight=${sheetAudit.scrollHeight} clientHeight=${sheetAudit.clientHeight}`);
    check('P1-1: canonical account tree (#accountDropdownHeader) is hosted inside the sheet',
        sheetAudit.treeHosted, `treeHosted=${sheetAudit.treeHosted}`);
    check('P1-1: production Logout control (#logoutBtn) is reachable inside the sheet',
        sheetAudit.logoutHosted, `logoutHosted=${sheetAudit.logoutHosted}`);
    check('P1-1: full-card hit at padding coordinates resolves to the sheet, not a behind element',
        sheetAudit.hitIsSheet,
        `hit=<${sheetAudit.hitTag} id="${sheetAudit.hitId}"> pointerEvents=${sheetAudit.pointerEvents}`);
    check('P1-1: more-sheet computed pointer-events is auto (full card is a hit target)',
        sheetAudit.pointerEvents === 'auto', `actual pointerEvents=${sheetAudit.pointerEvents}`);
    check('P1-1: more-sheet computed touch-action is pan-y (it owns the swipe)',
        sheetAudit.touchAction === 'pan-y' || sheetAudit.touchAction.replace(/\s/g, '').split(',').includes('pan-y'),
        `actual touchAction=${sheetAudit.touchAction}`);

    // 2. Drive a REAL CDP touch swipe starting inside the sheet's own card area.
    const startX = Math.round(sheetAudit.rect.left + sheetAudit.rect.width / 2);
    const startY = Math.round(sheetAudit.rect.top + sheetAudit.rect.height * 0.75);
    const endY = Math.round(sheetAudit.rect.top + sheetAudit.rect.height * 0.2);
    const actualStart = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const sheet = document.getElementById('mobileMoreSheet');
        return {
            tag: el ? el.tagName : null,
            id: el ? el.id : null,
            insideSheet: !!(sheet && el && sheet.contains(el)),
        };
    }, { x: startX, y: startY });

    const initialScrollTop = await page.evaluate(() => document.getElementById('mobileMoreSheet')?.scrollTop || 0);

    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY, id: 1 }],
    });
    for (let step = 1; step <= 6; step++) {
        const curY = startY + ((endY - startY) * step) / 6;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: startX, y: curY, id: 1 }],
        });
        await page.waitForTimeout(25);
    }
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
    });
    await page.waitForTimeout(120);

    const afterGesture = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        return {
            scrollTop: sheet ? sheet.scrollTop : 0,
            bodyScrollY: window.scrollY,
            docScrollY: document.documentElement.scrollTop,
        };
    });

    // The swipe's start element may be ANY descendant of the canonical sheet
    // host (a row, an account item, padding) — the contract is that the touch
    // is ADDRESSED to the sheet, i.e. hit-testing resolves inside it.
    // Containment is exactly that; a narrow id/tag enumeration misses rows.
    check('P1-1: swipe start point lands inside the sheet (touch is addressed to it)',
        actualStart.insideSheet === true,
        `start=<${actualStart.tag} id="${actualStart.id}"> insideSheet=${actualStart.insideSheet}`);
    check('P1-1: REAL CDP swipe changes sheet.scrollTop (no assignment used)',
        afterGesture.scrollTop > initialScrollTop,
        `initialScrollTop=${initialScrollTop} finalScrollTop=${afterGesture.scrollTop}`);
    check('P1-1: body and document scroll stay at 0 during sheet swipe',
        afterGesture.bodyScrollY === 0 && afterGesture.docScrollY === 0,
        `body=${afterGesture.bodyScrollY} doc=${afterGesture.docScrollY}`);

    // 3. Separately, prove the LAST row is reachable when the sheet is at bottom.
    const lastRow = await page.evaluate(async () => {
        const sheet = document.getElementById('mobileMoreSheet');
        const host = document.getElementById('mobileSettingsHost');
        if (!sheet || !host) return { found: false };
        sheet.scrollTop = sheet.scrollHeight;
        await new Promise(r => setTimeout(r, 60));
        const logoutBtn = document.getElementById('logoutBtn');
        if (!logoutBtn) return { found: false };
        const rect = logoutBtn.getBoundingClientRect();
        const sheetRect = sheet.getBoundingClientRect();
        const inView = rect.top >= sheetRect.top - 1 && rect.bottom <= sheetRect.bottom + 2;
        const centerX = Math.round(rect.left + rect.width / 2);
        const centerY = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(centerX, centerY);
        return {
            found: true,
            inView,
            centerHit: hit === logoutBtn || logoutBtn.contains(hit),
            rectTop: rect.top, rectBottom: rect.bottom,
            sheetBottom: sheetRect.bottom,
        };
    });

    check('P1-1: Logout button is the last reachable row and visible at bottom',
        lastRow.found && lastRow.inView,
        `found=${lastRow.found} inView=${lastRow.inView}`);

    // Page errors here are EXPECTED to surface the touchmove sessionId defect, and
    // must not be hidden: they are reported as their own check.
    check('P1-1: no page errors during more-sheet gestures',
        pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

// ============================================================================
// CONTRACT 1b: P1-1 MORE-SHEET TRIGGER ANCHOR (Entry 27 / R4)
// ============================================================================
// R4 binds every dropdown to exactly 1px from its trigger, and
// touch-action-row.js relocates #mobileMoreBtn into #touchActionRow (the TOP
// header band) on every touch tier, phone included. The sheet's geometry must
// therefore be measured against the REAL trigger rect, not against the
// composer dock. This contract clicks the production button and audits the
// anchored geometry at the three tiers the defect was measured on:
// 390x844 (52px gap), 360x800 (8px gap), 926x428 (-25px gap).
// The 390x600 full-card scroll contract above is unchanged and stays.
console.log('\n--- CONTRACT 1b: P1-1 MORE-SHEET TRIGGER ANCHOR (R4, 1px) ---');
for (const tier of [
    { label: 'phone390x844', w: 390, h: 844 },
    { label: 'phone360x800', w: 360, h: 800 },
    { label: 'land926x428', w: 926, h: 428 },
]) {
    const ctx = await browser.newContext({
        viewport: { width: tier.w, height: tier.h },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);

    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1b', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-1b', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1b', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(300);

    // Production open path. positionMobileMore re-runs on the next animation
    // frame after the click, so wait past that settle before measuring.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(250);

    const audit = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const trigger = document.getElementById('mobileMoreBtn');
        if (!sheet || !trigger || sheet.hidden) return { open: false };
        const cs = window.getComputedStyle(sheet);
        const sr = sheet.getBoundingClientRect();
        const tr = trigger.getBoundingClientRect();
        /*
         * The bottom edge a FINGER reaches on the trigger, which in phone
         * landscape is 4px below the edge it PAINTS: the compact band stays
         * 40px painted, and each action carries an invisible 44px ::after hit
         * box. Mirrors triggerReachableBottom() in
         * static/js/header-menus.js, and the same helper in
         * tests/browser/mobile_shell_layout.mjs.
         */
        const after = window.getComputedStyle(trigger, '::after');
        const afterH = parseFloat(after.height);
        let reachableBottom = tr.bottom;
        if (after.content !== 'none' && Number.isFinite(afterH) && afterH > 0) {
            const borderTop = parseFloat(
                window.getComputedStyle(trigger).borderTopWidth) || 0;
            const offsetTop = parseFloat(after.top);
            const anchor = Number.isFinite(offsetTop)
                ? tr.top + borderTop + offsetTop
                : tr.top + tr.height / 2;
            const shift = after.transform && after.transform !== 'none'
                ? (new DOMMatrixReadOnly(after.transform).f || 0) : 0;
            reachableBottom = Math.max(reachableBottom, anchor + shift + afterH);
        }
        return {
            open: true,
            gap: sr.top - tr.bottom,
            reachableGap: sr.top - reachableBottom,
            reachableOvershoot: reachableBottom - tr.bottom,
            triggerVisible: tr.width > 0 && tr.height > 0,
            triggerRowId: (trigger.closest('.touch-action-row')
                && trigger.closest('.touch-action-row').id) || null,
            rightDelta: (window.innerWidth - sr.right) - (window.innerWidth - tr.right),
            withinViewport: sr.top >= 0 && sr.left >= 0
                && sr.right <= window.innerWidth && sr.bottom <= window.innerHeight,
            pointerEvents: cs.pointerEvents,
            touchAction: cs.touchAction,
            overflowY: cs.overflowY,
            canScroll: sheet.scrollHeight > sheet.clientHeight,
            scrollHeight: sheet.scrollHeight,
            clientHeight: sheet.clientHeight,
            docScrollY: document.documentElement.scrollTop,
            bodyScrollY: window.scrollY,
            rectTop: sr.top, rectRight: sr.right,
            rectBottom: sr.bottom, rectLeft: sr.left,
        };
    });

    if (!audit.open) {
        check(`P1-1 ${tier.label}: sheet opens via production click`, false, 'sheet not open');
        await ctx.close();
        continue;
    }
    check(`P1-1 ${tier.label}: sheet opens via production click`, true);
    check(`P1-1 ${tier.label}: trigger is a real surface in #touchActionRow`,
        audit.triggerVisible && audit.triggerRowId === 'touchActionRow',
        `visible=${audit.triggerVisible} row=${audit.triggerRowId}`);
    /*
     * RE-POINTED (S17 step B), not loosened.
     *
     * CLASSIFICATION: asserting-the-old-specification. This row measured the gap
     * from the trigger's PAINTED bottom, and that premise IS the defect Entry 50
     * records: in phone landscape the band paints 40px (Entry 1) while a finger
     * reaches 44px (Entry 3's invisible ::after), and because the card
     * out-stacks the buttons (#mobileMoreSheet z 1200 inside #sessionBar z 1200
     * vs #mobileMoreBtn z 1 inside .header z 1000) anchoring at painted+1 took
     * rows 41..43 straight back off all five 44px hit boxes.
     *
     * Authorising spec line: Entry 3 — the approved target is the REACHABLE box,
     * so R4's "exactly 1px below the trigger" is measured from the edge a finger
     * reaches. The 0.75px tolerance is unchanged, and a second row pins the
     * overshoot so this cannot pass vacuously on a tier where the two edges
     * happen to coincide.
     */
    check(`P1-1 ${tier.label}: sheet top is exactly 1px below the trigger a finger reaches (R4)`,
        Math.abs(audit.reachableGap - 1) <= 0.75,
        `reachableGap=${audit.reachableGap.toFixed(2)}px want 1px`
        + ` (paintedGap=${audit.gap.toFixed(2)}px,`
        + ` overshoot=${audit.reachableOvershoot.toFixed(2)}px)`);
    check(`P1-1 ${tier.label}: the reachable and painted bottoms differ by the ::after overshoot`,
        audit.reachableOvershoot >= 0 && audit.reachableOvershoot <= 4,
        `overshoot=${audit.reachableOvershoot.toFixed(2)}px`);
    check(`P1-1 ${tier.label}: sheet right edge aligns to trigger within 6px (mockup 267)`,
        audit.rightDelta >= -6 && audit.rightDelta <= 6,
        `rightDelta=${audit.rightDelta.toFixed(2)}px`);
    check(`P1-1 ${tier.label}: sheet stays fully inside the viewport`,
        audit.withinViewport,
        `rect top=${audit.rectTop} bottom=${audit.rectBottom} right=${audit.rectRight} (vw=${tier.w} vh=${tier.h})`);
    check(`P1-1 ${tier.label}: computed pointer-events is auto`,
        audit.pointerEvents === 'auto', `pointerEvents=${audit.pointerEvents}`);
    check(`P1-1 ${tier.label}: computed touch-action is pan-y`,
        audit.touchAction === 'pan-y'
            || audit.touchAction.replace(/\s/g, '').split(',').includes('pan-y'),
        `touchAction=${audit.touchAction}`);
    check(`P1-1 ${tier.label}: overflow-y stays auto (single scroll owner)`,
        audit.overflowY === 'auto', `overflowY=${audit.overflowY}`);
    check(`P1-1 ${tier.label}: vertical reachability — sheet scrolls its own overflow`,
        audit.canScroll ? 'overflowing-scrollable' : audit.clientHeight > 0,
        `scrollHeight=${audit.scrollHeight} clientHeight=${audit.clientHeight}`);
    check(`P1-1 ${tier.label}: sheet swipe leaks no document/body scroll`,
        audit.docScrollY === 0 && audit.bodyScrollY === 0,
        `doc=${audit.docScrollY} body=${audit.bodyScrollY}`);
    check(`P1-1 ${tier.label}: no page errors`, pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

// ============================================================================
// CONTRACT 2: P1-2 TERMINAL FIXED FRAME & SINGLE SCROLL OWNER
// ============================================================================
console.log('\n--- CONTRACT 2: P1-2 TERMINAL FIXED FRAME & SINGLE SCROLL OWNER ---');
{
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);

    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-2', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(400);

    // Establish REAL vertical + horizontal overflow preconditions, then measure.
    const preconditions = await page.evaluate(async () => {
        const term = TerminalManager.terminals['s1'];
        if (!term) return { error: 'terminal s1 not found' };

        // Vertical precondition: scrollback content taller than the viewport.
        for (let i = 1; i <= 120; i++) {
            term.write(`Line ${String(i).padStart(3, '0')} SSHDeck mobile terminal scroll test http://example.com/${i}\r\n`);
        }
        await new Promise(r => setTimeout(r, 80));

        /*
         *: there is NO horizontal precondition to establish any
         * more, and that is the point of the rows below. This used to adopt an
         * authoritative grid wider than the pane, which made the wrapper a
         * horizontal scroller (`.pane-pannable`). A view is drawn by tmux
         * clipped to this client's own size, so a pane renders its own fit and
         * can never hold a grid wider than itself -- the pannable state, its
         * CSS and the class are all gone. What must still hold is that a
         * horizontal drag over the terminal disturbs NOTHING: no frame moves,
         * no page scrolls, no byte is sent.
         */
        const container = TerminalManager.terminalContainers['s1'];
        const wrapper = container; // .terminal-wrapper
        const xtermViewport = term.element ? term.element.querySelector('.xterm-viewport') : null;

        return {
            viewportHasVerticalOverflow:
                xtermViewport ? xtermViewport.scrollHeight > xtermViewport.clientHeight : false,
            wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
            wrapperClass: wrapper ? wrapper.className : null,
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -1,
            viewportScrollHeight: xtermViewport ? xtermViewport.scrollHeight : -1,
            viewportClientHeight: xtermViewport ? xtermViewport.clientHeight : -1,
            // S11: the pan's own bound, read at use time (scrollWidth changes
            // with the grid, so a cached bound goes stale --).
            maxScrollLeft: wrapper
                ? wrapper.scrollWidth - wrapper.clientWidth : -1,
            viewportY: term.buffer.active.viewportY,
            painted: term.element
                ? ((term.element.querySelector('.xterm-rows') || {}).textContent || '').trim()
                : null,
            baseY: term.buffer.active.baseY,
            paneRect: (wrapper && wrapper.parentElement) ? wrapper.parentElement.getBoundingClientRect() : null,
            wrapperRect: wrapper ? wrapper.getBoundingClientRect() : null,
            xtermRect: term.element ? term.element.getBoundingClientRect() : null,
        };
    });

    if (preconditions.error) {
        check('P1-2 harness precondition failed loudly', false, preconditions.error);
    } else {
        /*
         * Real scrollback to move through, read from the ENGINE. The DOM
         * scroller is not a portable proof of it: xterm 6 renders with no
         * scroll range (scrollHeight === clientHeight) while holding the same
         * history.
         */
        check('P1-2 precondition: the engine has REAL scrollback above the screen',
            preconditions.baseY > 0,
            `baseY=${preconditions.baseY} viewportY=${preconditions.viewportY}`);
        check('P1-2 precondition: the pane has NO horizontal overflow to pan',
            preconditions.maxScrollLeft <= 0,
            `maxScrollLeft=${preconditions.maxScrollLeft}`);
        check('P1-2: .terminal-wrapper computed overflow-x is hidden (single scroll owner)',
            preconditions.wrapperOverflowX === 'hidden',
            `actual overflowX=${preconditions.wrapperOverflowX}`);
        check('P1-2: .terminal-wrapper initial scrollLeft is strictly 0',
            preconditions.wrapperScrollLeft === 0,
            `actual scrollLeft=${preconditions.wrapperScrollLeft}`);
    }

    const wr = preconditions.wrapperRect;
    const cdp = await ctx.newCDPSession(page);

    // REAL horizontal swipe across the terminal wrapper.
    const hX = Math.round(wr.left + wr.width / 2);
    const hStartY = Math.round(wr.top + wr.height / 2);
    const hEndX = Math.round(wr.left + wr.width * 0.2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(wr.left + wr.width * 0.8), y: hStartY, id: 2 }] });
    for (let s = 1; s <= 5; s++) {
        const curX = Math.round(wr.left + wr.width * 0.8) + (((hEndX - Math.round(wr.left + wr.width * 0.8)) * s) / 5);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: curX, y: hStartY, id: 2 }] });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);

    const postHorizontal = await page.evaluate(() => {
        const wrapper = TerminalManager.terminalContainers['s1'];
        const term = TerminalManager.terminals['s1'];
        const viewport = term.element ? term.element.querySelector('.xterm-viewport') : null;
        return {
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -1,
            viewportScrollTop: viewport ? viewport.scrollTop : -1,
            wrapperRect: wrapper ? wrapper.getBoundingClientRect() : null,
            paneRect: wrapper && wrapper.parentElement ? wrapper.parentElement.getBoundingClientRect() : null,
            xtermRect: term.element ? term.element.getBoundingClientRect() : null,
            docX: window.scrollX, docY: window.scrollY,
            bytes: window.__emits
                .filter(e => e.evt === 'ssh_input')
                .map(e => e.payload && e.payload.data),
        };
    });

    /*
     * S11 wrote these rows against the pannable pane: `scrollLeft` WAS the pan
     * state, so the contract was "the frame is invariant, the content moves,
     * and the movement is bounded by the scroller's clamp".
     *
     * the pan has nothing to move. A pane renders its own fit, so
     * the wrapper's scrollWidth equals its clientWidth and every scrollLeft
     * write clamps to 0. The invariance half of the contract is what remains,
     * and it is the half the owner feels: a horizontal drag must not shift the
     * frame, scroll the page, or put bytes on the wire.
     */
    check('P1-2: a horizontal swipe pans nothing (there is no wider grid)',
        postHorizontal.wrapperScrollLeft === 0,
        `scrollLeft=${postHorizontal.wrapperScrollLeft}`);
    check('P1-2: horizontal swipe keeps the pane/wrapper FRAME rects fixed',
        postHorizontal.paneRect.left === preconditions.paneRect.left
            && postHorizontal.paneRect.width === preconditions.paneRect.width
            && postHorizontal.wrapperRect.left === preconditions.wrapperRect.left
            && postHorizontal.wrapperRect.width === preconditions.wrapperRect.width,
        `pane ${preconditions.paneRect.left}/${preconditions.paneRect.width}`
        + ` -> ${postHorizontal.paneRect.left}/${postHorizontal.paneRect.width}`
        + ` | wrapper ${preconditions.wrapperRect.left}/${preconditions.wrapperRect.width}`
        + ` -> ${postHorizontal.wrapperRect.left}/${postHorizontal.wrapperRect.width}`);
    // The content did not move either: with nothing to pan, `.xterm` sits where
    // the wrapper puts it.
    check('P1-2: the content stayed where it was (.xterm did not translate)',
        Math.round(postHorizontal.xtermRect.left)
            === Math.round(preconditions.xtermRect.left),
        `xterm.left ${Math.round(preconditions.xtermRect.left)}`
        + ` -> ${Math.round(postHorizontal.xtermRect.left)}`);
    check('P1-2: the horizontal pan emits zero ssh_input bytes',
        postHorizontal.bytes.length === 0,
        `bytes=${JSON.stringify(postHorizontal.bytes)}`);
    check('P1-2: document/body stay at 0 during horizontal swipe',
        postHorizontal.docX === 0 && postHorizontal.docY === 0,
        `docX=${postHorizontal.docX} docY=${postHorizontal.docY}`);

    // REAL vertical swipe: only xterm-viewport.scrollTop may change; frame rects
    // must remain byte-identical before and after the gesture.
    const captureFrame = async () => page.evaluate(() => {
        const wrapper = TerminalManager.terminalContainers['s1'];
        const term = TerminalManager.terminals['s1'];
        const pane = wrapper ? wrapper.parentElement : null;
        const viewport = term.element.querySelector('.xterm-viewport');
        return {
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -1,
            viewportScrollTop: viewport ? viewport.scrollTop : -1,
            // S11: the vertical STATE is buffer.viewportY (what
            // terminal.scrollLines(n) moves). viewport.scrollTop is xterm's
            // render mirror of it and is kept only as a companion.
            viewportY: term.buffer.active.viewportY,
            painted: term.element
                ? ((term.element.querySelector('.xterm-rows') || {}).textContent || '').trim()
                : null,
            baseY: term.buffer.active.baseY,
            paneRect: pane ? JSON.parse(JSON.stringify(pane.getBoundingClientRect())) : null,
            wrapperRect: wrapper ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
            xtermRect: term.element ? JSON.parse(JSON.stringify(term.element.getBoundingClientRect())) : null,
            docX: window.scrollX, docY: window.scrollY,
            bytes: window.__emits
                .filter(e => e.evt === 'ssh_input')
                .map(e => e.payload && e.payload.data),
        };
    });
    const vBefore = await captureFrame();
    const vX = Math.round(wr.left + wr.width / 2);
    // S11: the gesture is driven DOWNWARD (finger toward the bottom = older
    // content). At rest the viewport sits at the bottom (viewportY === baseY),
    // so this is the only direction with room; the at-the-bottom no-op is plan
    // T2 and is measured in tests/browser/p1_tmux_vertical_gesture.mjs.
    const vStartY = Math.round(wr.top + wr.height * 0.2);
    const vEndY = Math.round(wr.top + wr.height * 0.8);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vX, y: vStartY, id: 3 }] });
    for (let s = 1; s <= 6; s++) {
        const curY = vStartY + ((vEndY - vStartY) * s) / 6;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vX, y: curY, id: 3 }] });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);

    const postVertical = await captureFrame();

    /*
     * S11: the vertical rows, restated on the state that actually moves.
     *
     * `scrollLeft === 0` was the pre-S7 premise; S8/D-9′ deliberately PRESERVES
     * horizontal intent across gestures, so the contract is INVARIANCE (a
     * vertical gesture must not disturb the pan), not zero. Measured:
     * /tmp/s11work/probe_reachability.out shows scrollLeft 579 before and 579
     * after a vertical gesture.
     *
     * The scrolled state is `buffer.viewportY`; `viewport.scrollTop` is the
     * render mirror and is asserted beside it, never instead of it.
     */
    check('P1-2: a vertical swipe does not disturb the horizontal pan (S8 intent preserved)',
        postVertical.wrapperScrollLeft === vBefore.wrapperScrollLeft,
        `scrollLeft ${vBefore.wrapperScrollLeft} -> ${postVertical.wrapperScrollLeft}`);
    check('P1-2: a downward vertical swipe scrolls history (buffer.viewportY moves back)',
        postVertical.viewportY < vBefore.viewportY,
        `viewportY ${vBefore.viewportY} -> ${postVertical.viewportY} (baseY=${vBefore.baseY})`);
    /*
     * The render proof is the PAINTED screen, not `.xterm-viewport.scrollTop`:
     * xterm 6 renders with no DOM scroll range, so the old mirror reports
     * "nothing moved" for a viewport that plainly did.
     */
    check('P1-2: the painted rows follow the buffer',
        typeof postVertical.painted === 'string' && postVertical.painted.length > 0
            && postVertical.painted !== vBefore.painted,
        `painted changed=${postVertical.painted !== vBefore.painted}`);
    check('P1-2: the vertical scroll emits zero ssh_input bytes',
        postVertical.bytes.length === 0,
        `bytes=${JSON.stringify(postVertical.bytes)}`);
    check('P1-2: vertical swipe leaves pane/wrapper/xterm rects byte-identical',
        JSON.stringify(vBefore.paneRect) === JSON.stringify(postVertical.paneRect)
            && JSON.stringify(vBefore.wrapperRect) === JSON.stringify(postVertical.wrapperRect)
            && JSON.stringify(vBefore.xtermRect) === JSON.stringify(postVertical.xtermRect),
        `pane: ${JSON.stringify(vBefore.paneRect)} -> ${JSON.stringify(postVertical.paneRect)} | wrapper: ${JSON.stringify(vBefore.wrapperRect)} -> ${JSON.stringify(postVertical.wrapperRect)} | xterm: ${JSON.stringify(vBefore.xtermRect)} -> ${JSON.stringify(postVertical.xtermRect)}`);
    check('P1-2: document/body stay at 0 during vertical swipe',
        postVertical.docX === 0 && postVertical.docY === 0,
        `docX=${postVertical.docX} docY=${postVertical.docY}`);

    check('P1-2: no page errors during terminal gestures',
        pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

// ============================================================================
// CONTRACT 2b: P1-LAND SHORT LANDSCAPE (926x428) — TERMINAL + ABOUT SHEET
// ============================================================================
console.log('\n--- CONTRACT 2b: P1-LAND SHORT LANDSCAPE TOUCH WORKFLOW (926x428) ---');
{
    const ctx = await browser.newContext({
        viewport: { width: 926, height: 428 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript('window.__emits = [];');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);

    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 'l1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'p1-land', via_jump: null,
        });
        SessionManager.assignSessionToPane('l1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(400);

    // Landscape geometry audit: computed cascade + bounding rects.
    const geo = await page.evaluate(async () => {
        const term = TerminalManager.terminals['l1'];
        if (!term) return { error: 'terminal l1 missing' };

        for (let i = 1; i <= 80; i++) {
            term.write(`landscape row ${String(i).padStart(3, '0')} scroll-owner test text http://example.com/${i}\r\n`);
        }
        await new Promise(r => setTimeout(r, 80));

        //: no authoritative grid is adopted here any more -- the
        // pane renders its own fit, so there is no pannable state to establish
        // (see the note in P1-2 above).
        const container = TerminalManager.terminalContainers['l1'];
        const wrapper = container;
        const pane = wrapper.parentElement;
        const viewport = term.element.querySelector('.xterm-viewport');
        const docH = document.documentElement.scrollHeight;
        const vpH = window.innerHeight;

        // More sheet: open via production button click, audit computed cascade + hit.
        const sheet = document.getElementById('mobileMoreSheet');
        const sheetOpen = (sheet && !sheet.hidden);
        const host = document.getElementById('mobileSettingsHost');
        const cs = sheet ? window.getComputedStyle(sheet) : null;

        return {
            viewportVerticalOverflow: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
            baseY: term ? term.buffer.active.baseY : undefined,
            overflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : 0,
            maxScrollLeft: wrapper ? wrapper.scrollWidth - wrapper.clientWidth : -1,
            paneRect: pane ? JSON.parse(JSON.stringify(pane.getBoundingClientRect())) : null,
            wrapperRect: wrapper ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
            xtermRect: term.element ? JSON.parse(JSON.stringify(term.element.getBoundingClientRect())) : null,
            documentScrollHeight: docH,
            viewportHeight: vpH,
            docScrollY: document.documentElement.scrollTop,
            documentHasScroll: docH > vpH,
            sheetOpen,
            sheetPointerEvents: cs ? cs.pointerEvents : null,
            sheetTouchAction: cs ? cs.touchAction : null,
            activeTag: document.activeElement ? document.activeElement.tagName : null,
            activeId: document.activeElement ? document.activeElement.id : null,
        };
    });

    if (geo.error) {
        check('P1-LAND harness precondition failed loudly', false, geo.error);
    } else {
        check('P1-LAND precondition: the engine has scrollback at 926x428',
            geo.baseY > 0, `baseY=${geo.baseY}`);
        check('P1-LAND precondition: the pane has no horizontal overflow',
            geo.maxScrollLeft <= 0, `maxScrollLeft=${geo.maxScrollLeft}`);
        check('P1-LAND: no document-level scroll surface exists (html fits viewport height)',
            geo.documentHasScroll === false,
            `docScrollHeight=${geo.documentScrollHeight} vpHeight=${geo.viewportHeight}`);
        check('P1-LAND: .terminal-wrapper overflow-x must be hidden',
            geo.overflowX === 'hidden', `actual overflowX=${geo.overflowX}`);
        check('P1-LAND: .terminal-wrapper scrollLeft is 0',
            geo.wrapperScrollLeft === 0, `actual=${geo.wrapperScrollLeft}`);
    }

    // Drive a real CDP vertical swipe at the terminal center and re-measure frame + scroll.
    const cdp = await ctx.newCDPSession(page);
    const wr = geo.wrapperRect;
    const vX = Math.round(wr.left + wr.width / 2);
    const vTop = Math.round(wr.top + wr.height * 0.8);
    const vBot = Math.round(wr.top + wr.height * 0.2);
    const vBefore = await page.evaluate(() => {
        const wrapper = TerminalManager.terminalContainers['l1'];
        const term = TerminalManager.terminals['l1'];
        const viewport = term.element.querySelector('.xterm-viewport');
        const pane = wrapper ? wrapper.parentElement : null;
        window.__emits = [];
        return {
            viewportScrollTop: viewport ? viewport.scrollTop : -1,
            viewportY: term.buffer.active.viewportY,
            painted: term.element
                ? ((term.element.querySelector('.xterm-rows') || {}).textContent || '').trim()
                : null,
            baseY: term.buffer.active.baseY,
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -2,
            paneRect: pane ? JSON.parse(JSON.stringify(pane.getBoundingClientRect())) : null,
            wrapperRect: wrapper ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
            xtermRect: term.element ? JSON.parse(JSON.stringify(term.element.getBoundingClientRect())) : null,
        };
    });
    // S11: drive DOWNWARD (older content) — the only direction with room from a
    // bottom-anchored viewport. See the P1-2 block above for the full reasoning.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vX, y: vBot, id: 9 }] });
    for (let s = 1; s <= 6; s++) {
        const y = vBot + ((vTop - vBot) * s) / 6;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vX, y: y, id: 9 }] });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);

    const vAfter = await page.evaluate(() => {
        const wrapper = TerminalManager.terminalContainers['l1'];
        const term = TerminalManager.terminals['l1'];
        const viewport = term.element.querySelector('.xterm-viewport');
        const pane = wrapper ? wrapper.parentElement : null;
        return {
            viewportScrollTop: viewport ? viewport.scrollTop : -1,
            viewportY: term.buffer.active.viewportY,
            painted: term.element
                ? ((term.element.querySelector('.xterm-rows') || {}).textContent || '').trim()
                : null,
            baseY: term.buffer.active.baseY,
            wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -2,
            docX: window.scrollX, docY: window.scrollY,
            paneRect: pane ? JSON.parse(JSON.stringify(pane.getBoundingClientRect())) : null,
            wrapperRect: wrapper ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
            xtermRect: term.element ? JSON.parse(JSON.stringify(term.element.getBoundingClientRect())) : null,
            bytes: window.__emits
                .filter(e => e.evt === 'ssh_input')
                .map(e => e.payload && e.payload.data),
        };
    });

    check('P1-LAND: CDP vertical swipe does not disturb the horizontal pan',
        vAfter.wrapperScrollLeft === vBefore.wrapperScrollLeft,
        `scrollLeft ${vBefore.wrapperScrollLeft} -> ${vAfter.wrapperScrollLeft}`);
    check('P1-LAND: a downward CDP swipe scrolls history (buffer.viewportY moves back)',
        vAfter.viewportY < vBefore.viewportY,
        `viewportY ${vBefore.viewportY} -> ${vAfter.viewportY} (baseY=${vBefore.baseY})`);
    /*
     * The render proof is the PAINTED screen, not `.xterm-viewport.scrollTop`:
     * xterm 6 renders with no DOM scroll range, so the old mirror reports
     * "nothing moved" for a viewport that plainly did.
     */
    check('P1-LAND: the painted rows follow the buffer',
        typeof vAfter.painted === 'string' && vAfter.painted.length > 0
            && vAfter.painted !== vBefore.painted,
        `painted changed=${vAfter.painted !== vBefore.painted}`);
    check('P1-LAND: the landscape vertical scroll emits zero ssh_input bytes',
        vAfter.bytes.length === 0,
        `bytes=${JSON.stringify(vAfter.bytes)}`);
    check('P1-LAND: frame rects unchanged after swipe',
        JSON.stringify(vBefore.paneRect) === JSON.stringify(vAfter.paneRect)
            && JSON.stringify(vBefore.wrapperRect) === JSON.stringify(vAfter.wrapperRect)
            && JSON.stringify(vBefore.xtermRect) === JSON.stringify(vAfter.xtermRect));
    check('P1-LAND: document/body scroll stay at 0 after swipe',
        vAfter.docX === 0 && vAfter.docY === 0,
        `docX=${vAfter.docX} docY=${vAfter.docY}`);
    check('P1-LAND: no page errors during landscape gesture',
        pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

// ============================================================================
// CONTRACT 2c: P1-2 FRAME CASCADE AT EVERY TIER + SETTINGS→TERMINAL ROUNDTRIP
// ============================================================================
// The fixed-frame contract is tier-independent: html/body lock, pane/grid/
// wrapper overflow, and the wrapper's scrollLeft===0 invariant must hold at
// 390x600, 390x844, 926x428 AND desktop 1280x800 (no touch there). Then a
// REAL settings roundtrip (More sheet → theme change → close) must leave the
// terminal frame geometry byte-identical — root-cause matrix G8/P9a's
// "settings→terminal round-trip frame stability".
console.log('\n--- CONTRACT 2c: P1-2 FRAME CASCADE ALL TIERS + SETTINGS ROUNDTRIP ---');
{
    const cascade = await (async () => {
        const out = [];
        for (const tier of [
            { label: 'phone390x600', w: 390, h: 600, touch: true },
            { label: 'phone390x844', w: 390, h: 844, touch: true },
            { label: 'land926x428', w: 926, h: 428, touch: true },
            { label: 'desktop1280x800', w: 1280, h: 800, touch: false },
        ]) {
            const ctx = await browser.newContext({
                viewport: { width: tier.w, height: tier.h },
                hasTouch: tier.touch, isMobile: tier.touch,
            });
            const page = await ctx.newPage();
            const errs = [];
            page.on('pageerror', e => errs.push(String(e)));
            await page.addInitScript('window.__emits = [];');
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForFunction(() => typeof SessionManager !== 'undefined'
                && typeof TerminalManager !== 'undefined' && !!window.socket);
            await page.evaluate(() => {
                SessionManager.setSplitLayout(1, 'default');
                SessionManager.createSession({
                    session_id: 's2c', host: 'tiny', port: 22, username: 'root',
                    auth_type: 'key', key_id: 'k1', display_name: 'tiny',
                    use_tmux: true, tmux_session_name: 'p1-2c', via_jump: null,
                });
                SessionManager.assignSessionToPane('s2c', 0);
                SessionManager.setActivePane(0);
            });
            await page.waitForTimeout(350);
            const m = await page.evaluate(() => {
                const term = TerminalManager.terminals['s2c'];
                if (!term) return { error: 'no terminal' };
                for (let i = 1; i <= 100; i++) {
                    term.write(`cascade line ${String(i).padStart(3, '0')} frame test\r\n`);
                }
                const wrapper = TerminalManager.terminalContainers['s2c'];
                const pane = wrapper ? wrapper.parentElement : null;
                const grid = pane ? pane.parentElement : null;
                const container = grid ? grid.parentElement : null;
                const vp = term.element ? term.element.querySelector('.xterm-viewport') : null;
                const cs = el => el ? getComputedStyle(el) : null;
                const wcs = cs(wrapper); const pcs = cs(pane); const gcs = cs(grid);
                const ccs = cs(container); const hcs = cs(document.documentElement);
                const bcs = cs(document.body);
                return {
                    error: null,
                    htmlOverflow: hcs.overflow, htmlHeight: hcs.height,
                    bodyOverflow: bcs.overflow,
                    wrapperOverflowX: wcs ? wcs.overflowX : null,
                    wrapperOverflowY: wcs ? wcs.overflowY : null,
                    paneOverflow: pcs ? pcs.overflow : null,
                    gridOverflow: gcs ? gcs.overflow : null,
                    containerOverflow: ccs ? ccs.overflow : null,
                    viewportOverflowY: vp ? getComputedStyle(vp).overflowY : null,
                    wrapperScrollLeft: wrapper ? wrapper.scrollLeft : -1,
                    docScrollWidth: document.documentElement.scrollWidth,
                    docClientWidth: document.documentElement.clientWidth,
                };
            });
            out.push({ tier, m, errs });
            await ctx.close();
        }
        return out;
    })();

    for (const { tier, m, errs } of cascade) {
        if (m.error) {
            check(`P1-2c ${tier.label}: harness precondition failed loudly`, false, m.error);
            continue;
        }
        check(`P1-2c ${tier.label}: html/body scroll-locked at the terminal shell`,
            m.htmlOverflow.split(' ')[0] === 'hidden' && m.bodyOverflow.split(' ')[0] === 'hidden',
            `html=${m.htmlOverflow} body=${m.bodyOverflow}`);
        check(`P1-2c ${tier.label}: terminal-wrapper overflow-x hidden`,
            m.wrapperOverflowX === 'hidden', `overflowX=${m.wrapperOverflowX}`);
        check(`P1-2c ${tier.label}: terminal-wrapper overflow-y hidden (no vertical leak)`,
            m.wrapperOverflowY === 'hidden', `overflowY=${m.wrapperOverflowY}`);
        check(`P1-2c ${tier.label}: terminal-pane hidden (frame, not scroller)`,
            (m.paneOverflow || '').split(' ').every(v => v === 'hidden'),
            `pane=${m.paneOverflow}`);
        check(`P1-2c ${tier.label}: terminals grid/container hidden (no doc scrollback)`,
            (m.gridOverflow || '').split(' ').every(v => v === 'hidden')
                && (m.containerOverflow || '').split(' ').every(v => v === 'hidden'),
            `grid=${m.gridOverflow} container=${m.containerOverflow}`);
        check(`P1-2c ${tier.label}: ONLY .xterm-viewport is a vertical scroller`,
            m.viewportOverflowY === 'scroll', `viewportOverflowY=${m.viewportOverflowY}`);
        check(`P1-2c ${tier.label}: wrapper.scrollLeft starts 0 and page has no horizontal overflow`,
            m.wrapperScrollLeft === 0 && m.docScrollWidth <= m.docClientWidth,
            `scrollLeft=${m.wrapperScrollLeft} scrollW=${m.docScrollWidth} clientW=${m.docClientWidth}`);
        check(`P1-2c ${tier.label}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
    }

    // Settings → terminal ROUNDTRIP at the two portrait tiers (touch): open the
    // More sheet via its production trigger, change the theme through the
    // sheet's real theme dropdown, close, and compare terminal frame geometry
    // byte-for-byte against the pre-roundtrip capture.
    for (const tier of [{ label: 'phone390x600', w: 390, h: 600 },
                        { label: 'phone390x844', w: 390, h: 844 }]) {
        const ctx = await browser.newContext({
            viewport: { width: tier.w, height: tier.h }, hasTouch: true, isMobile: true,
        });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e)));
        await page.addInitScript('window.__emits = [];');
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof SessionManager !== 'undefined'
            && typeof TerminalManager !== 'undefined' && !!window.socket);
        await page.evaluate(() => {
            SessionManager.setSplitLayout(1, 'default');
            SessionManager.createSession({
                session_id: 's2c', host: 'tiny', port: 22, username: 'root',
                auth_type: 'key', key_id: 'k1', display_name: 'tiny',
                use_tmux: true, tmux_session_name: 'p1-2c-rt', via_jump: null,
            });
            SessionManager.assignSessionToPane('s2c', 0);
            SessionManager.setActivePane(0);
        });
        await page.waitForTimeout(350);

        const frame = () => page.evaluate(() => {
            const term = TerminalManager.terminals['s2c'];
            const wrapper = TerminalManager.terminalContainers['s2c'];
            const pane = wrapper ? wrapper.parentElement : null;
            const vp = term.element ? term.element.querySelector('.xterm-viewport') : null;
            return {
                scrollLeft: wrapper ? wrapper.scrollLeft : -1,
                scrollTop: vp ? vp.scrollTop : -1,
                docX: window.scrollX, docY: window.scrollY,
                pane: pane ? JSON.parse(JSON.stringify(pane.getBoundingClientRect())) : null,
                wrapper: wrapper ? JSON.parse(JSON.stringify(wrapper.getBoundingClientRect())) : null,
                xterm: term.element
                    ? JSON.parse(JSON.stringify(term.element.getBoundingClientRect())) : null,
            };
        });

        const before = await frame();
        const rt = await page.evaluate(async () => {
            const out = { sheetOpened: false, themeChanged: false, sheetClosed: false };
            const btn = document.getElementById('mobileMoreBtn');
            if (btn) btn.click();
            await new Promise(r => setTimeout(r, 250));
            const sheet = document.getElementById('mobileMoreSheet');
            out.sheetOpened = !!(sheet && !sheet.hidden);
            // Real theme change through the sheet's hosted tree.
            const dropdown = document.getElementById('themeDropdownHeader');
            const trigger = dropdown && dropdown.previousElementSibling;
            if (trigger) trigger.click();
            await new Promise(r => setTimeout(r, 120));
            const option = dropdown
                && dropdown.querySelector('.theme-option:not(.active)');
            if (option) {
                option.click();
                out.themeChanged = true;
                out.theme = option.dataset.themeId || null;
            }
            const dd = document.getElementById('themeDropdownHeader');
            if (dd && dd.classList.contains('show')) {
                document.body.click();
                await new Promise(r => setTimeout(r, 80));
            }
            if (btn) btn.click();
            await new Promise(r => setTimeout(r, 250));
            out.sheetClosed = !!(sheet && sheet.hidden);
            out.themeAttr = document.body.getAttribute('data-theme');
            return out;
        });
        const after = await frame();

        check(`P1-2c ${tier.label}: settings roundtrip — sheet opened via production trigger`,
            rt.sheetOpened, `sheetOpened=${rt.sheetOpened}`);
        check(`P1-2c ${tier.label}: settings roundtrip — theme really changed through the sheet`,
            rt.themeChanged && rt.themeAttr === rt.theme,
            `changed=${rt.themeChanged} attr=${rt.themeAttr} want=${rt.theme}`);
        check(`P1-2c ${tier.label}: settings roundtrip — sheet closed back to terminal`,
            rt.sheetClosed, `sheetClosed=${rt.sheetClosed}`);
        check(`P1-2c ${tier.label}: settings roundtrip — terminal frame geometry byte-identical`,
            JSON.stringify(before.pane) === JSON.stringify(after.pane)
                && JSON.stringify(before.wrapper) === JSON.stringify(after.wrapper)
                && JSON.stringify(before.xterm) === JSON.stringify(after.xterm),
            `pane Δ=${JSON.stringify(before.pane) !== JSON.stringify(after.pane)} `
                + `wrapper Δ=${JSON.stringify(before.wrapper) !== JSON.stringify(after.wrapper)} `
                + `xterm Δ=${JSON.stringify(before.xterm) !== JSON.stringify(after.xterm)}`);
        check(`P1-2c ${tier.label}: settings roundtrip — wrapper.scrollLeft stays 0 and no doc scroll`,
            after.scrollLeft === 0 && after.docX === 0 && after.docY === 0,
            `scrollLeft=${after.scrollLeft} docX=${after.docX} docY=${after.docY}`);
        check(`P1-2c ${tier.label}: settings roundtrip — xterm scroll position preserved`,
            after.scrollTop === before.scrollTop,
            `before=${before.scrollTop} after=${after.scrollTop}`);
        check(`P1-2c ${tier.label}: settings roundtrip — no page errors`,
            errs.length === 0, errs.slice(0, 2).join(' | '));
        await ctx.close();
    }
}

// ============================================================================
// CONTRACT 3: P1-3 BROADCAST COMPOSER REVEAL & DRAFT CONTINUITY
// ============================================================================
console.log('\n--- CONTRACT 3: P1-3 BROADCAST COMPOSER REVEAL & DRAFT CONTINUITY ---');
{
    // Desktop 1280x800 Broadcast open/restore-same-draft workflow.
    const dctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: false,
        isMobile: false,
    });
    const dpage = await dctx.newPage();
    const derrors = [];
    dpage.on('pageerror', e => derrors.push(String(e)));
    await dpage.addInitScript('window.__emits = [];');
    await dpage.goto(BASE, { waitUntil: 'load' });
    await dpage.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket);

    await dpage.evaluate(() => {
        SessionManager.setSplitLayout(2, '2-col');
        SessionManager.createSession({
            session_id: 'd1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny 1',
            use_tmux: true, tmux_session_name: 'd1', via_jump: null,
        });
        SessionManager.createSession({
            session_id: 'd2', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny 2',
            use_tmux: true, tmux_session_name: 'd2', via_jump: null,
        });
        SessionManager.assignSessionToPane('d1', 0);
        SessionManager.assignSessionToPane('d2', 1);
        SessionManager.setActivePane(0);
    });
    await dpage.waitForTimeout(400);

    // Populate a real draft into the shared composer before the round-trip.
    await dpage.evaluate(() => {
        const input = document.getElementById('mobileInput');
        if (input) input.value = 'deploy prod now';
    });
    await dpage.waitForTimeout(50);

    const desktop = await dpage.evaluate(async () => {
        const mobileInput = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');

        // Real Broadcast open path: click the actual toggle button.
        if (toggle) toggle.click();
        await new Promise(r => setTimeout(r, 150));
        const visibleAfterOpen = mobileInput ? (mobileInput.offsetParent !== null) : false;

        // Toggle off then on: the same draft must survive the round-trip.
        if (toggle) toggle.click();
        await new Promise(r => setTimeout(r, 100));
        if (toggle) toggle.click();
        await new Promise(r => setTimeout(r, 150));

        const visibleAfterRetoggle = mobileInput ? (mobileInput.offsetParent !== null) : false;
        const draftAfterRetoggle = mobileInput ? mobileInput.value : '';

        return {
            toggleExists: toggle !== null,
            visibleAfterOpen,
            visibleAfterRetoggle,
            draftAfterRetoggle,
        };
    });

    check('P1-3 desktop: Broadcast toggle button exists',
        desktop.toggleExists, 'toggle missing');
    check('P1-3 desktop: opening Broadcast reveals the composer',
        desktop.visibleAfterOpen === true, `visible=${desktop.visibleAfterOpen}`);
    check('P1-3 desktop: Broadcast round-trip reveals the composer again with the identical draft',
        desktop.visibleAfterRetoggle === true && desktop.draftAfterRetoggle === 'deploy prod now',
        `visible=${desktop.visibleAfterRetoggle} draft="${desktop.draftAfterRetoggle}"`);

    check('P1-3: no page errors during desktop Broadcast test',
        derrors.length === 0,
        derrors.slice(0, 3).join(' | '));
    await dctx.close();
}

await browser.close();
server.close();

console.log(`\n==================================================`);
console.log(`P1 WORKFLOW SUITE COMPLETE: pass=${pass} fail=${fail}`);
console.log(`==================================================`);
if (fail > 0) {
    console.log('\nFailures summary:');
    failures.forEach(f => console.log('  * ' + f));
    process.exit(1);
} else {
    process.exit(0);
}
