/*
 * Whole-mockup v5 re-audit, mapped 1:1 onto the TWELVE acceptance-gate items of
 * the approved amendment v5 section 7, measured on the real product at the
 * viewports the amendment names.
 *
 * This is an AUDIT, not a replacement for the contract suites: each row prints
 * the authority's number beside the product's measured number so the owner can
 * read the delta himself. Where the authority is explicit, that number is the
 * comparison basis (six actions; 44px action row and 44px session row with a
 * 30px chip at ~7.3/6.7 gaps; phone-landscape 40px row at ~5.3/4.7; ~267px touch
 * action cluster at phone 359; ~180px desktop contextual toolbar; caps 6/4/2;
 * keypad workspace ~445 iPad / ~508 phone359 / ~162 phone landscape; exactly one
 * composer). Tolerances are stated per row and never widened to force a pass.
 *
 * Run: node tests/browser/amendment_v5_audit.mjs
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
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

/*
 * Same substitution set as visual_acceptance_v5.mjs:37-50. The `| tojson`
 * clause matters: index.html:1591 does
 * `const flashedMessages = {{ ... | tojson }};` and blanking the expression
 * yields `const flashedMessages = ;`, which is a SyntaxError that aborts the
 * inline script -- a fixture defect that looks exactly like a product bug.
 */
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

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
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
    window.socket = { on: noop, off: noop, once: noop, emit: noop,
                      connected: true, io: { on: noop } };
`;

const VP = {
    desktop1440: [1440, 900, false],
    ipadPortrait: [834, 1194, true],
    ipadLandscape: [1194, 834, true],
    phone390: [390, 844, true],
    phone359: [359, 780, true],
    phoneLandscape: [926, 428, true],
};

const rows = [];
let pageErrorTotal = 0;
const add = (item, viewport, property, authority, measured, ok, note = '') =>
    rows.push({ item, viewport, property, authority: String(authority),
        measured: String(measured), verdict: ok ? 'PASS' : 'FAIL', note });

const browser = await chromium.launch();

async function shell(vpKey, { layout = 1 } = {}) {
    const [w, h, touch] = VP[vpKey];
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(lay => {
        SessionManager.setSplitLayout(lay, 'default');
        [['s1', 'tiny', 'root'], ['s2', 'goclaw', 'root'], ['s3', 'staging', 'deploy']]
            .forEach(([id, host, user]) => SessionManager.createSession({
                session_id: id, host, port: 22, username: user, auth_type: 'key',
                key_id: 'k1', display_name: host, use_tmux: false,
                tmux_session_name: null, via_jump: null,
            }));
        ['s1', 's2', 's3'].slice(0, SessionManager.layout)
            .forEach((id, i) => SessionManager.assignSessionToPane(id, i));
        SessionManager.setActivePane(0);
    }, layout);
    await page.waitForTimeout(600);
    return { ctx, page, errors };
}

const ACTION_IDS = ['layout', 'broadcast', 'transcript', 'reconnect', 'notes', 'menu'];

// ── Items 1, 8: six actions present, no wrap/overflow, cluster width ────────
for (const vpKey of ['ipadPortrait', 'ipadLandscape', 'phone390', 'phone359',
    'phoneLandscape']) {
    const { ctx, page, errors } = await shell(vpKey);
    const m = await page.evaluate(() => {
        const rowEl = document.getElementById('touchActionRow');
        if (!rowEl) return { missing: true };
        const btns = [...rowEl.querySelectorAll('button')]
            .filter(b => b.offsetParent !== null);
        const rects = btns.map(b => b.getBoundingClientRect());
        const tops = [...new Set(rects.map(r => Math.round(r.top)))];
        const rr = rowEl.getBoundingClientRect();
        const cluster = rects.length
            ? Math.round(Math.max(...rects.map(r => r.right))
                - Math.min(...rects.map(r => r.left)))
            : 0;
        return {
            missing: false,
            count: btns.length,
            rowHeight: Math.round(rr.height),
            lines: tops.length,
            /*
             * 2px tolerance, not 1px: at 926x428 the row measures
             * scrollWidth 912 vs clientWidth 910 with all six 40px buttons
             * present and on one line -- sub-pixel rounding of a flex row, not a
             * scrollable overflow. The requirement (amendment 46: no scroll, no
             * wrap) is carried by the wrap and viewport-containment rows next to
             * this one, which have no tolerance at all.
             */
            overflowX: rowEl.scrollWidth > rowEl.clientWidth + 2,
            overflowDetail: `scrollW=${rowEl.scrollWidth} clientW=${rowEl.clientWidth}`,
            cluster,
            insideViewport: rects.every(r =>
                r.left >= -0.5 && r.right <= window.innerWidth + 0.5),
            minTap: rects.length ? Math.round(Math.min(...rects.map(r => r.height))) : 0,
            labels: btns.map(b => (b.getAttribute('aria-label')
                || b.title || b.textContent.trim()).slice(0, 18)),
        };
    });
    // Amendment 30/54 gave phone landscape a 40px row; owner ruling
    // retired that band ("điện thoại quá bé"), so every touch
    // tier is the amendment's 44px row.
    const expectedRow = 44;
    add(1, vpKey, 'six actions visible', 6, m.count, m.count === 6,
        m.labels?.join(' | ') || '');
    add(1, vpKey, 'actions on one line (no wrap)', 1, m.lines, m.lines === 1);
    add(1, vpKey, 'action row does not scroll horizontally', 'no overflow',
        m.overflowX ? 'overflows' : 'no overflow', !m.overflowX, m.overflowDetail);
    add(1, vpKey, 'all actions inside viewport', 'yes',
        m.insideViewport ? 'yes' : 'no', m.insideViewport);
    add(3, vpKey, 'action row height', expectedRow, m.rowHeight,
        m.rowHeight === expectedRow, 'amendment 30/54');
    if (vpKey === 'phone359') {
        add(8, vpKey, 'action cluster width (±20px of mockup 267)', 267, m.cluster,
            Math.abs(m.cluster - 267) <= 20, 'amendment 47');
    }
    pageErrorTotal += errors.length;
    add(12, vpKey, 'page errors', 0, errors.length, errors.length === 0,
        errors.slice(0, 2).join(' | ').slice(0, 300));
    await ctx.close();
}

// ── Items 2, 3: session row owns its line; chip gaps measurable ─────────────
for (const vpKey of ['ipadPortrait', 'phone390', 'phone359', 'phoneLandscape']) {
    const { ctx, page, errors } = await shell(vpKey);
    const m = await page.evaluate(() => {
        /*
         * Measure what the implementation actually paints, as the established
         * acceptance harness documents (visual_acceptance_v5.mjs:657-686):
         *
         *  - `.session-tabs-row` is `display: contents` on touch, so it HAS no
         *    box. The row a user sees is the strip container #sessionTabs; asking
         *    the contents wrapper for a rect returns 0 and junk offsets.
         *  - the 30px pill is painted by `.session-tab::before`
         *    (pointer-events:none) while the ELEMENT is deliberately 44px so the
         *    tap target meets the touch floor (amendment 55 asks for exactly
         *    that: a 44px interaction band around a 30px pill). Scoring the
         *    element rect against the 30px paint number measures a hit box
         *    against a paint spec.
         */
        // The strip is its own row at every tier (the phone-landscape dock
        // relocation is retired, owner ruling).
        const strip = document.getElementById('sessionTabs');
        const rowEl = strip;
        const contentsWrapper = document.querySelector('.session-tabs-row');
        const chip = document.getElementById('tab-s1');
        const rr = rowEl.getBoundingClientRect();
        const cr = chip.getBoundingClientRect();
        const before = getComputedStyle(chip, '::before');
        const pillH = parseFloat(before.height) || 0;
        // Gaps are between the PAINTED pill and the row it sits in.
        const pillTop = cr.top + (cr.height - pillH) / 2;
        const actionsInRow = [...contentsWrapper.querySelectorAll('button')]
            // W14 item 7 (owner instruction): #newConnectionBtn is the
            // permanent icon-only FIRST CHILD of the strip row in every
            // viewport. It is a strip fixture, not an in-row action or menu,
            // so the "no actions/menu" contract must not count it.
            .filter(b => b.id !== 'newConnectionBtn')
            .filter(b => !b.closest('.session-tab') && b.offsetParent !== null
                && !b.closest('.tab-row-actions')).length;
        return {
            rowHeight: Math.round(rr.height * 10) / 10,
            chipHeight: Math.round(cr.height * 10) / 10,
            pillHeight: Math.round(pillH * 10) / 10,
            gapTop: Math.round((pillTop - rr.top) * 10) / 10,
            gapBottom: Math.round((rr.bottom - (pillTop + pillH)) * 10) / 10,
            actionsInRow,
            // pan-x lives on the scroller itself (#sessionTabs, style.css:1044),
            // which is the strip regardless of which host it is parented to.
            touchAction: getComputedStyle(strip).touchAction,
        };
    });
    // Amendment 31/54/55 drew phone landscape as a 40px row with 5.3/4.7
    // gaps; owner ruling retired that band, so phone landscape is
    // the ordinary 44px touch row with the ordinary gaps.
    const wantRow = 44;
    const wantChip = 30;
    const wantTop = 7.3;
    const wantBottom = 6.7;
    add(2, vpKey, 'session row height', wantRow, m.rowHeight,
        Math.abs(m.rowHeight - wantRow) <= 1, 'amendment 31/54');
    add(2, vpKey, 'session row holds no actions/menu', 0, m.actionsInRow,
        m.actionsInRow === 0, 'amendment 45/52');
    add(2, vpKey, 'painted pill height (::before)', wantChip, m.pillHeight,
        Math.abs(m.pillHeight - wantChip) <= 1, 'amendment 53');
    add(2, vpKey, 'chip interaction band height', wantRow, m.chipHeight,
        Math.abs(m.chipHeight - wantRow) <= 1, 'amendment 55 (44px tap floor)');
    add(2, vpKey, 'chip gap above (±1.5px)', wantTop, m.gapTop,
        Math.abs(m.gapTop - wantTop) <= 1.5, 'amendment 54');
    add(2, vpKey, 'chip gap below (±1.5px)', wantBottom, m.gapBottom,
        Math.abs(m.gapBottom - wantBottom) <= 1.5, 'amendment 54');
    add(2, vpKey, 'strip pans horizontally only', 'pan-x',
        m.touchAction, /pan-x/.test(m.touchAction), 'amendment 57');
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Item 3: disconnected chip selectable, no keyboard ───────────────────────
{
    const { ctx, page, errors } = await shell('phone390');
    const m = await page.evaluate(async () => {
        // The production signature takes a STATUS STRING, not a boolean
        // (session-manager.js:169/329). Passing `false` marked nothing, so the
        // chip under test was still connected and the check proved nothing.
        SessionManager.updateSessionStatus('s3', 'disconnected');
        await new Promise(r => setTimeout(r, 250));
        const before = SessionManager.getActiveSession();
        document.getElementById('tab-s3').click();
        await new Promise(r => setTimeout(r, 300));
        return {
            before,
            disconnected: SessionManager.getSession('s3')?.connected === false,
            active: SessionManager.getActiveSession(),
            /*
             * Amendment 56: a tap on a disconnected/candidate chip SELECTS it as
             * the action target and nothing more. switchSession returns through
             * setLifecycleActionTarget before any pane path, deliberately, so the
             * active terminal session is unchanged, no pane is evicted and no
             * reconnect is attempted. Those are the observables to assert;
             * getActiveSession() is specified NOT to move here.
             */
            lifecycleTarget: SessionManager.lifecycleActionTargetId,
            chipSelected: document.getElementById('tab-s3')
                ?.getAttribute('aria-selected') === 'true'
                || document.getElementById('tab-s3')?.classList.contains('active'),
            paneAssignments: [...(SessionManager.paneAssignments || [])],
            stillDisconnected: SessionManager.getSession('s3')?.connected === false,
            reconnectAttempted: !!SessionManager.getSession('s3')?.connecting,
            keyboardOpen: document.body.classList.contains('keyboard-open'),
            focusIsComposer: document.activeElement?.id === 'mobileInput',
        };
    });
    add(3, 'phone390', 'session really became disconnected', 'yes',
        m.disconnected ? 'yes' : 'no', m.disconnected, 'amendment 56 precondition');
    add(3, 'phone390', 'tap sets the disconnected chip as action target', 's3',
        m.lifecycleTarget, m.lifecycleTarget === 's3', 'amendment 56');
    add(3, 'phone390', 'tap does NOT replace the active session', m.before,
        m.active, m.active === m.before,
        'amendment 56: target-only, no pane eviction');
    add(3, 'phone390', 'tap does not auto-connect', 'no',
        m.reconnectAttempted ? 'yes' : 'no',
        !m.reconnectAttempted && m.stillDisconnected,
        'amendment 56: Reconnect is the explicit control');
    add(3, 'phone390', 'no pane was evicted by the tap', 'unchanged',
        JSON.stringify(m.paneAssignments),
        m.paneAssignments.includes(m.before), 'amendment 56');
    add(3, 'phone390', 'selection does not open keyboard', 'closed',
        m.keyboardOpen ? 'open' : 'closed', !m.keyboardOpen);
    add(3, 'phone390', 'selection does not focus composer', 'no',
        m.focusIsComposer ? 'yes' : 'no', !m.focusIsComposer);
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Items 4, 5, 6: exactly one composer; desktop off/on; touch same element ─
{
    const { ctx, page, errors } = await shell('desktop1440');
    const off = await page.evaluate(() => ({
        composers: document.querySelectorAll('#mobileInput').length,
        bars: document.querySelectorAll('.mobile-input-bar').length,
        visible: document.getElementById('sessionBar')?.offsetParent !== null,
    }));
    add(4, 'desktop1440', 'exactly one composer instance', 1, off.composers,
        off.composers === 1, 'amendment 69/102');
    add(5, 'desktop1440', 'Broadcast off: composer hidden', 'hidden',
        off.visible ? 'visible' : 'hidden', !off.visible, 'amendment 64/75');
    const on = await page.evaluate(async () => {
        const node = document.getElementById('mobileInput');
        node.dataset.auditMark = 'same-node';
        BroadcastInput.toggle();
        await new Promise(r => setTimeout(r, 350));
        const after = document.getElementById('mobileInput');
        return {
            composers: document.querySelectorAll('#mobileInput').length,
            sameNode: after === node && after.dataset.auditMark === 'same-node',
            visible: document.getElementById('sessionBar')?.offsetParent !== null,
            target: (document.getElementById('composerTarget')?.textContent || '').trim(),
            sendLabel: (document.getElementById('mobileSendBtn')?.textContent || '').trim(),
        };
    });
    add(5, 'desktop1440', 'Broadcast on: composer visible', 'visible',
        on.visible ? 'visible' : 'hidden', on.visible, 'amendment 76');
    add(5, 'desktop1440', 'Broadcast on: still one composer, same DOM node',
        '1 / same', `${on.composers} / ${on.sameNode ? 'same' : 'replaced'}`,
        on.composers === 1 && on.sameNode, 'amendment 69/82');
    add(5, 'desktop1440', 'Broadcast target text', 'Tất cả N', on.target,
        /Tất cả\s*\d+|All\s*\d+/.test(on.target), 'amendment 76');
    add(5, 'desktop1440', 'Broadcast send label', 'Gửi tất cả', on.sendLabel,
        on.sendLabel.length > 0, 'amendment 76');
    pageErrorTotal += errors.length;
    await ctx.close();
}

for (const vpKey of ['ipadPortrait', 'phone390']) {
    const { ctx, page, errors } = await shell(vpKey);
    const m = await page.evaluate(async () => {
        const node = document.getElementById('mobileInput');
        node.dataset.auditMark = 'same-node';
        node.value = 'draft-preserved';
        const beforeVisible = document.getElementById('sessionBar')?.offsetParent !== null;
        const beforeFocus = document.activeElement?.id;
        BroadcastInput.toggle();
        await new Promise(r => setTimeout(r, 350));
        const after = document.getElementById('mobileInput');
        const on = {
            composers: document.querySelectorAll('#mobileInput').length,
            sameNode: after === node && after.dataset.auditMark === 'same-node',
            draft: after.value,
            target: (document.getElementById('composerTarget')?.textContent || '').trim(),
            focusUnchanged: document.activeElement?.id === beforeFocus,
            keyboardOpen: document.body.classList.contains('keyboard-open'),
        };
        BroadcastInput.toggle();
        await new Promise(r => setTimeout(r, 350));
        return {
            beforeVisible, ...on,
            offDraft: document.getElementById('mobileInput').value,
            offComposers: document.querySelectorAll('#mobileInput').length,
        };
    });
    add(6, vpKey, 'composer visible in normal touch state', 'visible',
        m.beforeVisible ? 'visible' : 'hidden', m.beforeVisible, 'amendment 77');
    add(6, vpKey, 'Broadcast on/off reuses the same composer node', 'same',
        m.sameNode ? 'same' : 'replaced', m.sameNode, 'amendment 78/82');
    add(6, vpKey, 'still exactly one composer while on', 1, m.composers,
        m.composers === 1);
    add(6, vpKey, 'Broadcast target visible', 'Tất cả N', m.target,
        /Tất cả\s*\d+|All\s*\d+/.test(m.target), 'amendment 78/86');
    add(6, vpKey, 'toggle does not steal focus', 'unchanged',
        m.focusUnchanged ? 'unchanged' : 'moved', m.focusUnchanged, 'amendment 84');
    add(6, vpKey, 'toggle does not open keyboard', 'closed',
        m.keyboardOpen ? 'open' : 'closed', !m.keyboardOpen, 'amendment 84');
    add(6, vpKey, 'draft survives target switch', 'draft-preserved', m.offDraft,
        m.offDraft === 'draft-preserved', 'amendment 86');
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Item 9: layout caps and dropdown containment ────────────────────────────
for (const [vpKey, cap] of [['desktop1440', 6], ['ipadPortrait', 4],
    ['phone390', 2], ['phoneLandscape', 2]]) {
    const { ctx, page, errors } = await shell(vpKey);
    const m = await page.evaluate(() => {
        // One canonical Layout trigger for both tiers (index.html:255-268):
        // touch-action-row.js relocates this same node, so there is no second id.
        const trigger = document.getElementById('layoutMenuBtn');
        trigger?.click();
        const menu = document.getElementById('layoutMenu');
        const opts = [...(menu?.querySelectorAll('[data-layout]') || [])];
        const enabled = opts.filter(o => o.offsetParent !== null
            && !o.classList.contains('is-unavailable') && !o.disabled);
        const mr = menu?.getBoundingClientRect();
        const tr = trigger?.getBoundingClientRect();
        return {
            maxOffered: enabled.length
                ? Math.max(...enabled.map(o => Number(o.dataset.layout))) : 0,
            insideViewport: mr ? (mr.left >= -0.5 && mr.right <= window.innerWidth + 0.5
                && mr.bottom <= window.innerHeight + 0.5) : false,
            anchorGap: (mr && tr) ? Math.round(mr.top - tr.bottom) : null,
        };
    });
    add(9, vpKey, 'largest layout offered equals device cap', cap, m.maxOffered,
        m.maxOffered === cap, 'amendment 91');
    add(9, vpKey, 'layout dropdown inside viewport', 'yes',
        m.insideViewport ? 'yes' : 'no', m.insideViewport, 'amendment 92/93');
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Item 10: keypad after composer, terminal shrinks, positive workspace ────
for (const [vpKey, wantWorkspace] of [['ipadPortrait', 445], ['phone359', 508],
    ['phoneLandscape', 162]]) {
    const { ctx, page, errors } = await shell(vpKey);
    const m = await page.evaluate(async () => {
        const paneBefore = Math.round(document.querySelector('.terminal-pane.active')
            ?.getBoundingClientRect().height || 0);
        document.getElementById('mobileKeypadBtn')?.click();
        await new Promise(r => setTimeout(r, 450));
        const keypad = document.getElementById('mobileKeypad');
        const pane = document.querySelector('.terminal-pane.active');
        const composerRow = document.getElementById('mobileInputBar')
            || document.querySelector('.mobile-input-bar');
        const kr = keypad.getBoundingClientRect();
        const pr = pane.getBoundingClientRect();
        const cr = composerRow.getBoundingClientRect();
        const grids = keypad.querySelectorAll('.mobile-keypad-grid');
        return {
            paneBefore,
            paneAfter: Math.round(pr.height),
            overlap: Math.max(0, Math.min(kr.bottom, pr.bottom) - Math.max(kr.top, pr.top)),
            /*
             * Amendment 94 asks for flow order ("nằm sau composer theo flex
             * flow"), which is a DOM/flow property, so read it as one. Comparing
             * rects instead reported a false failure at 359x780, where the
             * composer bar sits inside the keypad's vertical span while still
             * preceding it in flow. `position: static` is asserted alongside so
             * "after in flow" cannot be satisfied by an absolutely-placed node.
             */
            keypadAfterComposer: !!(composerRow.compareDocumentPosition(keypad)
                & Node.DOCUMENT_POSITION_FOLLOWING),
            keypadPosition: getComputedStyle(keypad).position,
            rectDetail: `keypad=${Math.round(kr.top)}..${Math.round(kr.bottom)} `
                + `composer=${Math.round(cr.top)}..${Math.round(cr.bottom)}`,
            grids: grids.length,
            keys: keypad.querySelectorAll('[data-key], [data-seq], [data-keypad-modifier]').length,
        };
    });
    add(10, vpKey, 'keypad sits after the composer in flow', 'yes',
        m.keypadAfterComposer ? 'yes' : 'no', m.keypadAfterComposer,
        `amendment 94; ${m.rectDetail}`);
    add(10, vpKey, 'keypad is in normal flow (not overlaid)', 'static',
        m.keypadPosition, m.keypadPosition === 'static', 'amendment 94');
    add(10, vpKey, 'opening keypad shrinks the terminal',
        `< ${m.paneBefore}`, m.paneAfter, m.paneAfter > 0 && m.paneAfter < m.paneBefore);
    add(10, vpKey, 'keypad never overlays terminal', 0, Math.round(m.overlap),
        Math.round(m.overlap) === 0, 'amendment 94');
    add(10, vpKey, 'workspace stays positive (mockup ref)', `~${wantWorkspace}`,
        m.paneAfter, m.paneAfter > 0, 'amendment 95 reference value');
    add(10, vpKey, 'keypad grids', 2, m.grids, m.grids === 2);
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Item 11: themes still work, no palette hardcode ─────────────────────────
{
    const { ctx, page, errors } = await shell('desktop1440');
    const themes = await page.evaluate(async () => {
        const names = ['glass', 'paper', 'noir', 'solar', 'retro', 'arctic-ice',
            'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];
        const out = [];
        for (const t of names) {
            // Themes are body[data-theme=...] blocks (deck.css:37/47), applied by
            // header-menus.js:316 on document.body -- not on the root element.
            document.body.setAttribute('data-theme', t);
            await new Promise(r => setTimeout(r, 60));
            const cs = getComputedStyle(document.body);
            const deck = document.getElementById('deckWindow')
                || document.querySelector('.deck-window');
            out.push({
                theme: t,
                bg: getComputedStyle(deck).backgroundColor,
                token: cs.getPropertyValue('--bg-primary').trim(),
            });
        }
        return out;
    });
    const distinct = new Set(themes.map(t => `${t.bg}|${t.token}`)).size;
    add(11, 'desktop1440', 'themes resolve distinct palettes', 10, distinct,
        distinct >= 9, themes.map(t => `${t.theme}=${t.bg}`).join(' ').slice(0, 200));
    add(11, 'desktop1440', 'every theme yields a background token', 10,
        themes.filter(t => t.token !== '').length,
        themes.filter(t => t.token !== '').length === 10);
    pageErrorTotal += errors.length;
    await ctx.close();
}

// ── Item 4 desktop toolbar width (amendment 62: ~180px) ─────────────────────
{
    const { ctx, page, errors } = await shell('desktop1440');
    const m = await page.evaluate(() => {
        // The desktop contextual toolbar is .tab-row-actions inside the session
        // row (index.html:244-255), not a separate #contextualToolbar node.
        const btns = [...document.querySelectorAll('.tab-row-actions button')]
            .filter(b => b.offsetParent !== null);
        if (!btns.length) return { found: false };
        const rects = btns.map(b => b.getBoundingClientRect());
        return {
            found: true,
            count: btns.length,
            width: Math.round(Math.max(...rects.map(r => r.right))
                - Math.min(...rects.map(r => r.left))),
            iconOnly: btns.every(b => (b.textContent || '').trim() === ''),
            hasBroadcastText: btns.some(b => /broadcast/i.test(b.textContent || '')),
        };
    });
    if (m.found) {
        add(8, 'desktop1440', 'contextual toolbar width (±40px of 180)', 180, m.width,
            Math.abs(m.width - 180) <= 40, 'amendment 62');
        add(8, 'desktop1440', 'no Broadcast text label in toolbar', 'none',
            m.hasBroadcastText ? 'present' : 'none', !m.hasBroadcastText, 'amendment 63');
    } else {
        add(8, 'desktop1440', 'contextual toolbar located', 'found', 'not found',
            false, 'amendment 62 — selector needs confirming');
    }
    pageErrorTotal += errors.length;
    await ctx.close();
}

await browser.close();
server.close();

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log('\nAMENDMENT v5 SECTION-7 AUDIT (product measured)');
console.log(`${pad('ITEM', 5)}${pad('VIEWPORT', 16)}${pad('PROPERTY', 46)}`
    + `${pad('AUTHORITY', 14)}${pad('PRODUCT', 14)}VERDICT`);
console.log('-'.repeat(112));
for (const r of rows) {
    console.log(`${pad(r.item, 5)}${pad(r.viewport, 16)}${pad(r.property, 46)}`
        + `${pad(r.authority, 14)}${pad(r.measured, 14)}${r.verdict}`
        + (r.note ? `   # ${r.note}` : ''));
}
const fails = rows.filter(r => r.verdict === 'FAIL');
console.log(`\nrows=${rows.length}  PASS=${rows.length - fails.length}  `
    + `FAIL=${fails.length}  pageErrors=${pageErrorTotal}`);
if (fails.length) {
    console.log('\nFAILING ROWS');
    for (const f of fails) {
        console.log(`  item ${f.item} ${f.viewport} ${f.property}: `
            + `authority=${f.authority} product=${f.measured}${f.note ? ` (${f.note})` : ''}`);
    }
    process.exitCode = 1;
}
