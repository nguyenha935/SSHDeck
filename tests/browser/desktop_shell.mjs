/*
 * The one-bar shell, measured.
 *
 * Piece F collapsed two stacked header bars into one. Every claim it makes is a
 * number, so this suite reads the real templates/index.html and measures the
 * tablet and desktop header. Phone ownership now lives in the bottom-dock suites;
 * keeping obsolete phone-header expectations here would test a shell that no
 * longer ships. Two rules from earlier false-greens in this project
 * apply here and are why this file looks the way it does:
 *
 *   1. Geometry tests must read the production markup, never rebuild it. A
 *      hand-written fixture drifts from index.html silently and stays green.
 *   2. Assert on measurements taken after layout, not on the presence of a class
 *      or a variable. `.header { height: 48px }` existing in the stylesheet says
 *      nothing about what the bar measures once six buttons wrap inside it --
 *      the first draft of this shell measured 154px with that rule in place.
 *
 * Both bugs this suite pins were found by measuring, not by reading:
 *   - the phone bar wrapping to three rows because a 16px side padding it had
 *     inherited from the two-bar era ate the width the sixth button needed;
 *   - `.split-controls { display: none }` on phones never applying, because the
 *     rule that shows them is `.tab-row-actions .split-controls` and two classes
 *     beat one whatever the order.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

let pass = 0;
let fail = 0;

// Arrays are never === to each other, so a list assertion has to compare the
// joined string. Passing the array straight in makes the check fail forever,
// which is the same trap already noted in mobile_shell_trusted.mjs.
function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (typeof actual === 'object' && actual !== null
        || typeof expected === 'object' && expected !== null) {
        actual = JSON.stringify(actual);
        expected = JSON.stringify(expected);
    }
    const ok = actual === expected;
    if (ok) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

function atMost(label, actual, limit, unit = '') {
    const ok = typeof actual === 'number' && actual <= limit;
    if (ok) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} <= ${limit}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected <= ${limit}${unit}`
            + `\n        actual   ${actual}${unit}`);
    }
}

function atLeast(label, actual, floor, unit = '') {
    const ok = typeof actual === 'number' && actual >= floor;
    if (ok) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} >= ${floor}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}${unit}`
            + `\n        actual   ${actual}${unit}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
};

/*
 * Minimal Jinja stand-in. Only enough to make the real template parse: the
 * point is to measure production markup, so the substitutions must not change
 * any element, class or attribute that affects layout.
 */
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
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

/*
 * Tablet and desktop header contract. Phones have a different production shell:
 * portrait keeps only the 45px session strip above the terminal and both phone
 * orientations use the functional bottom dock. Those dimensions are measured in
 * mobile_shell_layout.mjs and the moving strip in mobile_session_switch.mjs.
 */
const VIEWPORTS = [
    // v5 section 3: the touch header is 44 (global/action row) + 44 (session
    // row) = 88, not the pre-v5 48 + 44 = 92.
    { label: 'tablet', w: 768, h: 1024, touch: true, bar: 88, rows: 2, tier: 44 },
    { label: 'laptop-1024', w: 1024, h: 768, touch: false, bar: 84, rows: 2, tier: 40 },
    { label: 'laptop', w: 1280, h: 800, touch: false, bar: 84, rows: 2, tier: 40 },
    { label: 'desktop-1440', w: 1440, h: 900, touch: false, bar: 84, rows: 2, tier: 40 },
    { label: 'desktop', w: 1920, h: 1080, touch: false, bar: 84, rows: 2, tier: 40 },
];

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.touch,
        isMobile: vp.touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    // Freeze animation: a transition mid-flight makes every measurement below
    // depend on when the screenshot happened to be taken.
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);

    const m = await page.evaluate(() => {
        const header = document.querySelector('.header');
        const hr = header.getBoundingClientRect();

        /*
         * Walk through display: contents wrappers. .header-content,
         * .header-title-row, .header-buttons, .header-group and
         * .session-tabs-row all still exist as elements (app.js and the phone
         * rules reach for them) but have no boxes, so element.children would
         * report the wrappers rather than what actually lays out.
         */
        const items = [];
        const walk = el => {
            for (const child of el.children) {
                const cs = getComputedStyle(child);
                if (cs.display === 'contents') { walk(child); continue; }
                if (cs.display === 'none') continue;
                const r = child.getBoundingClientRect();
                // #sessionTabs is empty on a freshly loaded page (the chips are
                // built by session-manager.js as sessions open), so it measures
                // 0 tall and, at tablet width, only 7px wide once the actions
                // have taken their space. Skipping on size would drop it from
                // this list at some widths and not others. Anything that is
                // laid out at all counts.
                if (r.width === 0 && r.height === 0
                    && getComputedStyle(child).display === 'none') continue;
                items.push({
                    id: child.id || '',
                    cls: String(child.className),
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom),
                    left: Math.round(r.left),
                    right: Math.round(r.right),
                    h: Math.round(r.height),
                    w: Math.round(r.width),
                });
            }
        };
        walk(header);

        // Distinct row bands, by top edge. Two items on the same line share a
        // top; a wrap makes a new one.
        const tops = [...new Set(items.map(i => i.top))].sort((a, b) => a - b);
        const rows = [];
        for (const t of tops) {
            // Items whose vertical span overlaps this band belong to it: a 44px
            // button and a 48px cluster on one line have different tops.
            const band = items.filter(i => i.top < t + 8 && i.bottom > t);
            if (rows.some(r => r.members.some(x => band.includes(x)))) continue;
            rows.push({ top: t, members: band });
        }

        const grid = document.querySelector('#terminalGrid');
        const gridRect = grid ? grid.getBoundingClientRect() : null;

        const splitBtn = document.querySelector('.split-controls .split-btn');
        const tabs = document.querySelector('#sessionTabs');
        const actions = document.querySelector('.tab-row-actions');

        /*
         * B1: the chip/tier geometry pins need one chip laid out.
         * The app builds chips on connect; on a freshly loaded page the strip
         * is empty, so seed one with the exact production classes -- the same
         * fixture pattern the visual QA used. It is removed after measuring.
         */
        let chip = null;
        if (tabs && !tabs.querySelector('.session-tab')) {
            chip = document.createElement('div');
            chip.className = 'session-tab';
            chip.innerHTML = '<span class="status-dot connected"></span>'
                + '<span class="tab-label"><span class="tab-host-name">host.example</span>'
                + '<span class="tab-user-name">user</span></span>';
            tabs.appendChild(chip);
        }
        const chipR = chip ? chip.getBoundingClientRect() : null;
        // Read alongside chipR, NOT in the return object below: the seeded chip
        // is removed at the end of this block, and a detached element reports an
        // empty border-radius and a zero-height dot -- which is what the first
        // run of these two assertions actually measured.
        const chipCS = chip ? getComputedStyle(chip) : null;
        const chipPillCS = chip ? getComputedStyle(chip, '::before') : null;
        // CSSStyleDeclaration is live: snapshot primitives BEFORE removing the
        // synthetic chip below, or every field reads back as an empty string.
        const hasPill = chipPillCS?.content !== 'none';
        const chipRadiusCS = hasPill
            ? chipPillCS.borderTopLeftRadius : chipCS?.borderTopLeftRadius;
        const chipPillPaintedH = hasPill
            ? parseFloat(chipPillCS.height) : (chipR ? chipR.height : null);
        const chipPaintSnapshot = chipCS ? {
            background: chipCS.backgroundColor,
            borderTop: chipCS.borderTopWidth,
            borderBottom: chipCS.borderBottomWidth,
            boxShadow: chipCS.boxShadow,
        } : null;
        const chipPillBoxSizing = hasPill ? chipPillCS.boxSizing : null;
        const chipDotHR = (() => {
            const d = chip && chip.querySelector('.status-dot');
            return d ? Math.round(d.getBoundingClientRect().height) : null;
        })();
        const splitR = splitBtn ? splitBtn.getBoundingClientRect() : null;
        /*
         * v5 section 4: the user-facing layout control is the single Layout
         * dropdown trigger, and the four numbered .split-btn buttons are a
         * hidden engine source. Measure the trigger, and separately assert the
         * engine source generates no box at all.
         */
        const layoutTrigger = document.getElementById('layoutMenuBtn');
        const layoutTriggerR = layoutTrigger
            ? layoutTrigger.getBoundingClientRect() : null;
        const splitCluster = document.querySelector('.split-controls');
        /*
         * The v5 icons live in #touchActionRow on touch and in the desktop
         * contextual row on a fine pointer. Query both and take whichever is
         * laid out, so the assertion follows the control rather than assuming
         * one home and silently measuring null.
         */
        const iconBtn = document.querySelector('#touchActionRow .tab-row-icon-btn')
            || document.querySelector('.tab-row-actions .tab-row-icon-btn');
        const iconR = iconBtn ? iconBtn.getBoundingClientRect() : null;
        // Measured with the chip present: vertical drift must stay 0 and the
        // scroll policy must stay horizontal-only even when chips are laid out.
        const stripDrift = tabs ? tabs.scrollHeight - tabs.clientHeight : null;
        const stripOverflowX = tabs ? getComputedStyle(tabs).overflowX : null;
        const stripOverflowY = tabs ? getComputedStyle(tabs).overflowY : null;
        /*
         * SESSION-TIER edge insets, measured from the shell's INNER border edge,
         * and captured HERE for the same reason chipCS is: the seeded chip is
         * removed on the next line, and a detached element reports a zero rect --
         * which would make the chip-side assertion vacuously null.
         *
         * Row 1 already had an edge-hold assertion; row 2 had none, and a
         * mutation run proved the gap: re-adding .tab-row-actions' own 6px right
         * padding (a second inline-inset owner on the same row, the exact defect
         * deck.css L2c removed) left this suite fully green at 364/0. The first
         * chip and the row's last visible action are the two boxes that touch the
         * shell edges on that tier, so they are what gets measured.
         */
        const tierInset = (() => {
            const deck = document.getElementById('deckWindow');
            if (!deck) return { leading: null, action: null };
            const db = deck.getBoundingClientRect();
            const dcs = getComputedStyle(deck);
            const innerL = db.left + (parseFloat(dcs.borderLeftWidth) || 0);
            const innerR = db.right - (parseFloat(dcs.borderRightWidth) || 0);
            /*
             * W14 item 7: the permanent #newConnectionBtn is now the FIRST box
             * in the session tier. Before that owner instruction, the first chip
             * was the edge box; continuing to measure it would report the button's
             * real width + gap as an inset regression. Pin the thing that actually
             * owns the left edge now. Chip density/scroll geometry remains covered
             * by the strip assertions below.
             */
            const leading = document.getElementById('newConnectionBtn');
            const actions = document.querySelector('.tab-row-actions');
            const visKids = actions
                ? [...actions.children].filter(
                    el => el.getBoundingClientRect().width > 0)
                : [];
            const lastAction = visKids.length
                ? visKids[visKids.length - 1] : null;
            return {
                leading: leading
                    ? Math.round(leading.getBoundingClientRect().left - innerL)
                    : null,
                action: lastAction
                    ? Math.round(innerR - lastAction.getBoundingClientRect().right)
                    : null,
            };
        })();
        if (chip) chip.remove();

        return {
            headerH: Math.round(hr.height),
            headerRight: Math.round(hr.right),
            tierLeadingInset: tierInset.leading,
            tierActionInset: tierInset.action,
            deckLeft: Math.round(document.getElementById('deckWindow')
                .getBoundingClientRect().left),
            deckTop: Math.round(document.getElementById('deckWindow')
                .getBoundingClientRect().top),
            deckBorderTop: Math.round(parseFloat(getComputedStyle(
                document.getElementById('deckWindow')).borderTopWidth) || 0),
            items,
            rowCount: rows.length,
            rowTops: rows.map(r => r.top),
            gridTop: gridRect ? Math.round(gridRect.top) : null,
            gridH: gridRect ? Math.round(gridRect.height) : null,
            viewportH: window.innerHeight,
            viewportW: window.innerWidth,
            splitDisplay: splitBtn
                ? getComputedStyle(splitBtn.parentElement).display : 'absent',
            tabsW: tabs ? Math.round(tabs.getBoundingClientRect().width) : null,
            tabsTop: tabs ? Math.round(tabs.getBoundingClientRect().top) : null,
            tabsBottom: tabs
                ? Math.round(tabs.getBoundingClientRect().bottom) : null,
            actionsTop: actions
                ? Math.round(actions.getBoundingClientRect().top) : null,
            actionsBottom: actions
                ? Math.round(actions.getBoundingClientRect().bottom) : null,
            /*
             * B1: chip and row-2 control geometry, plus the
             * strip's horizontal-only overflow policy and zero vertical drift.
             */
            chipH: chipR ? Math.round(chipR.height) : null,
            // S3: the touch element owns the native 44px/40px tap band while
            // ::before owns the 30px paint. Fine pointer paints the element.
            chipMinW: chipR ? Math.round(chipR.width) : null,
            chipPaintedH: chipPillPaintedH === null
                ? null : Math.round(chipPillPaintedH),
            chipOwnPaint: chipPaintSnapshot,
            chipPillBoxSizing: chipPillBoxSizing,
            chipRadius: chipRadiusCS,
            chipDotH: chipDotHR,
            splitH: splitR ? Math.round(splitR.height) : null,
            iconH: iconR ? Math.round(iconR.height) : null,
            layoutTriggerH: layoutTriggerR
                ? Math.round(layoutTriggerR.height) : null,
            /*
             * v5 section 3: on touch the function/account actions are reached
             * through the ONE global menu. Reports which are NOT reachable, so
             * the assertion names the missing one rather than just a count.
             *
             * OWNER CORRECTION. The mechanism changed and this had to
             * follow it. The sheet used to PROXY each action with a
             * data-mobile-action-target button, and Profiles/Settings sat in a
             * second view behind a Settings row -- that intermediate surface was
             * the "second menu entry point" the owner reported. Now the sheet
             * HOSTS the real controls: touch-action-row.js moves New Connection,
             * Files and Commands in, and the canonical #accountDropdownHeader
             * tree (which carries Profiles and the whole account surface) is
             * moved in on open.
             *
             * So reachability is now measured as "the one real node is inside the
             * one menu", which is strictly stronger than "a proxy for it exists":
             * it also rules out the duplicate the proxy used to create. The menu
             * must be OPEN for the tree to be hosted, so open it first.
             */
            sheetHostMissing: (() => {
                const sheet = document.getElementById('mobileMoreSheet');
                if (!sheet) return ['mobileMoreSheet absent'];
                document.getElementById('mobileMoreBtn')?.click();
                // W14 item 7: newConnectionBtn is NOT sheet-hosted -- it stays
                // the permanent first child of .session-tabs-row everywhere.
                const missing = ['fileTransferBtn',
                    'commandLibraryBtn', 'manageProfilesBtn', 'accountDropdownHeader']
                    .filter(id => {
                        const nodes = document.querySelectorAll(`#${id}`);
                        return nodes.length !== 1 || !sheet.contains(nodes[0]);
                    });
                document.getElementById('mobileMoreBtn')?.click();
                return missing;
            })(),
            /*
             * v5 section 3: the six primary actions, their layout line, and
             * every menu opener in the document.
             */
            touchActions: (() => {
                const row = document.getElementById('touchActionRow');
                if (!row) return { order: 'absent', lines: 0, scrolls: false,
                    menuOpeners: [] };
                const shown = [...row.children].filter(c => {
                    const cs = getComputedStyle(c);
                    return cs.display !== 'none' && cs.visibility !== 'hidden'
                        && c.getClientRects().length > 0;
                });
                const openers = [...document.querySelectorAll(
                    '[aria-haspopup="menu"], [aria-haspopup="true"], #mobileMoreBtn')]
                    .filter(e => e.getClientRects().length > 0
                        && getComputedStyle(e).visibility !== 'hidden')
                    /*
                     * Amendment line 45 forbids a second GLOBAL menu button,
                     * not every popup trigger. #layoutMenuBtn is the Layout
                     * dropdown (section 6, primary action 1) and is a distinct
                     * control, so it is excluded by id rather than by relaxing
                     * the selector -- a new unnamed opener still fails.
                     */
                    .filter(e => e.id !== 'layoutMenuBtn')
                    .map(e => e.id || String(e.className));
                return {
                    order: shown.map(c => c.id || String(c.className)).join(', '),
                    lines: new Set(shown.map(
                        c => Math.round(c.getBoundingClientRect().top))).size,
                    scrolls: row.scrollWidth > row.clientWidth,
                    menuOpeners: openers,
                };
            })(),
            // hidden + aria-hidden + no generated box: a true non-surface.
            splitClusterBoxless: !!splitCluster
                && splitCluster.hasAttribute('hidden')
                && splitCluster.getAttribute('aria-hidden') === 'true'
                && splitCluster.getClientRects().length === 0,
            stripDrift: stripDrift,
            stripOverflowX: stripOverflowX,
            stripOverflowY: stripOverflowY,
            /*
             * v3 F4 two-tier contract. The global tier (.header-content: title,
             * primary actions, account) and the session tier (.session-tabs-row:
             * #sessionTabs + .tab-row-actions) must each be their own laid-out
             * box, stacked inside .header, instead of both being display:contents
             * wrappers flattened into one row. Before F4 both wrappers have no
             * box, so every rect here measures 0 and the display fields read
             * 'contents' -- which is exactly what makes the checks below fail
             * first.
             */
            twoTier: (() => {
                const content = document.querySelector('.header-content');
                const tabsRow = document.querySelector('.session-tabs-row');
                const cRect = content.getBoundingClientRect();
                const tRect = tabsRow.getBoundingClientRect();
                /*
                 * v3 F4 structural amendment: exact tier membership.
                 * Same descent as the header walk -- display:contents wrappers
                 * are transparent, display:none children are skipped -- so the
                 * lists are what actually lays out inside each tier. A control
                 * promoted out of a tier lands in the bar's own item list; one
                 * moved into the wrong tier lands in the wrong list here. The
                 * hidden restore markers carry display:none and never appear.
                 */
                const laid = tier => {
                    const out = [];
                    const descend = el => {
                        for (const child of el.children) {
                            const cs = getComputedStyle(child);
                            if (cs.display === 'contents') { descend(child); continue; }
                            if (cs.display === 'none') continue;
                            out.push(child.id || String(child.className));
                        }
                    };
                    descend(tier);
                    return out.sort().join(', ');
                };
                const titleRow = document.querySelector('.header-title-row');
                const buttons = document.querySelector('.header-buttons');
                const titleRect = titleRow.getBoundingClientRect();
                const buttonsRect = buttons.getBoundingClientRect();
                /*
                 * v5 section 3: on touch the row-1 box is #touchActionRow, not
                 * .header-content (which is display:contents there). Measured
                 * here so the tier assertions can target the box that actually
                 * exists at each capability instead of asserting 0px against a
                 * pass-through wrapper.
                 */
                const touchRow = document.getElementById('touchActionRow');
                const touchRect = touchRow
                    ? touchRow.getBoundingClientRect() : null;
                return {
                    contentDisplay: getComputedStyle(content).display,
                    tabsRowDisplay: getComputedStyle(tabsRow).display,
                    contentH: Math.round(cRect.height),
                    tabsRowH: Math.round(tRect.height),
                    titleLeft: Math.round(titleRect.left),
                    buttonsRight: Math.round(buttonsRect.right),
                    touchRowDisplay: touchRow
                        ? getComputedStyle(touchRow).display : 'absent',
                    touchRowH: touchRect ? Math.round(touchRect.height) : null,
                    touchRowRight: touchRect ? Math.round(touchRect.right) : null,
                    // Same guard as `stacked`: a zero-height row-1 box must not
                    // let the session tier pass by sitting at 0 >= -1.
                    touchStacked: !!touchRect
                        && tRect.top >= touchRect.bottom - 1
                        && touchRect.height > 0,
                    // Stacked means the session tier starts where the global tier
                    // ends. The cRect.height > 0 guard keeps a display:contents
                    // pair (all-zero rects, 0 >= -1) from passing this by luck.
                    stacked: tRect.top >= cRect.bottom - 1 && cRect.height > 0,
                    contentMembers: laid(content),
                    tabsRowMembers: laid(tabsRow),
                };
            })(),
            /*
             * Buttons whose visible text is hidden but which have no other
             * name. Reads the live DOM rather than grepping the template: a
             * label can be hidden by any rule at any width, and only the
             * computed style knows whether it actually is at this one.
             */
            unnamed: [...document.querySelectorAll('.header .btn')]
                .filter(b => {
                    const label = b.querySelector('.btn-label');
                    const labelHidden = label
                        && getComputedStyle(label).display === 'none';
                    if (!labelHidden) return false;
                    return !(b.getAttribute('aria-label') || '').trim()
                        && !(b.getAttribute('title') || '').trim();
                })
                .map(b => b.id || String(b.className)),

            // Every control that has to stay reachable, and its painted size.
            controls: ['newConnectionBtn', 'fileTransferBtn', 'commandLibraryBtn',
                'manageProfilesBtn', 'accountBtnHeader', 'broadcastToggleBtn',
                'saveTranscriptBtn', 'reloadPageBtn', 'notepadOpenBtn',
                // v5 primary action 4 (Ket noi lai, refresh-cw) -- the touch
                // row's own Reconnect, distinct from #reloadPageBtn.
                'touchReconnectBtn', 'layoutMenuBtn', 'mobileMoreBtn'].map(id => {
                    const el = document.getElementById(id);
                    if (!el) return { id, missing: true };
                    const cs = getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    /*
                     * Ancestor-aware. Reading only the element's own computed
                     * display called six controls "visible" at 0x0 on touch:
                     * .header-buttons is display:none there (and #mobileMoreSheet
                     * is, for #reloadPageBtn), so the children keep their own
                     * inline-flex while generating no box at all. That made the
                     * 44x44 check report six phantom violations. offsetParent is
                     * null inside a display:none subtree, and getClientRects()
                     * is empty, so either alone catches the ancestor case --
                     * both are kept because offsetParent is also null for
                     * position:fixed, which does paint.
                     *
                     * This is stricter, not looser: a control that really is
                     * laid out but undersized still has a box and still fails.
                     */
                    const boxless = el.offsetParent === null
                        && el.getClientRects().length === 0;
                    return {
                        id,
                        hidden: cs.display === 'none' || cs.visibility === 'hidden'
                            || cs.opacity === '0' || boxless,
                        w: Math.round(r.width),
                        h: Math.round(r.height),
                    };
                }),
            mobileShell: (() => {
                const sessionBar = document.getElementById('sessionBar');
                const more = document.getElementById('mobileMoreSheet');
                return {
                    sessionBarVisible: getComputedStyle(sessionBar).display !== 'none'
                        && sessionBar.getBoundingClientRect().height > 0,
                    moreVisible: getComputedStyle(more).display !== 'none'
                        && more.getBoundingClientRect().height > 0,
                    moreHidden: more.hidden,
                    moreInert: more.hasAttribute('inert'),
                    tabCount: document.querySelectorAll('#sessionTabs').length,
                    tabsAfterButton: document.getElementById('newConnectionBtn')
                        .nextElementSibling === document.getElementById('sessionTabs'),
                };
            })(),
        };
    });

    console.log(`\n--- ${vp.label} ${vp.w}x${vp.h} ---`);

    /*
     * v3 F4 structural amendment: the header has exactly two tier
     * wrappers, each holding only its approved members.
     *
     * This replaces the one-row era's "children are the controls, not the
     * wrappers" assertion: F4 deliberately restores .header-content and
     * .session-tabs-row as boxes stacked inside .header, so that old expected
     * string is now the defect shape, not the contract. The mutation escape is
     * preserved in the reverse direction: a control promoted out of a tier
     * shows up in the bar's own laid-out list (first check), and a control
     * moved into the wrong tier lands in the wrong membership list. The
     * controls stay reachable and correctly sized through the visibility,
     * overflow and glyph assertions below; the chips being actual siblings of
     * .tab-row-actions is what lets them be the elastic middle of the session
     * tier rather than a fixed lump beside a nested box.
     */
    const laidOut = m.items.map(i => i.id || i.cls).sort().join(', ');
    /*
     * v5 section 3 (re-derived): the header's laid-out shape is
     * capability-dependent, and the single expected string below hid that.
     *
     * Fine pointer keeps the F4 two-tier stack: .header-content (global) over
     * .session-tabs-row (session).
     *
     * Touch replaces row 1 with the v5 global/action row. .header-content
     * becomes display:contents, so the walk descends through it and the brand
     * (#headerBrand) surfaces as a direct member alongside #touchActionRow --
     * that pair IS row 1 (mockup line 118-127: brand then .tw5-touch-tools).
     * .session-tabs-row stays row 2.
     *
     * Keyed on the measured display rather than on vp.touch so the assertion
     * still fails if a viewport lands in the wrong mode.
     */
    const TIER_SHAPE = vp.touch
        ? 'headerBrand, session-tabs-row, touchActionRow'
        : 'header-content, session-tabs-row';
    check(`${vp.label}: the header has exactly the two tier wrappers`,
        laidOut, TIER_SHAPE);
    /*
     * P2 D1: row 1 is a deliberate two-cluster layout --
     * .header-title-row (brand/context, left) and .header-buttons (the
     * complete function/account action group, right) are real boxes inside
     * the tier instead of display:contents pass-throughs, so the tier's
     * laid-out membership is exactly those two clusters. Per-control
     * reachability/size/a11y checks below are the unchanged enforcement for
     * what sits inside them; the geometry block after the tier checks
     * proves the left/right anchoring with computed rects.
     *
     * Two re-derivations,:
     *  - the brand cluster's id is #headerBrand; laid() prefers id over class,
     *    so the expected token is the id, not the class name it used to carry.
     *  - on touch .header-buttons is display:none (v5 section 3 moves the whole
     *    function/account group into the ONE global menu, mockup line 128-135),
     *    so the tier lays out the brand alone. Asserting that explicitly keeps
     *    both directions enforced: the desktop cluster vanishing, or the
     *    desktop button group leaking onto touch, still fails here.
     */
    check(`${vp.label}: the global tier lays out its two clusters`,
        m.twoTier.contentMembers,
        vp.touch ? 'headerBrand' : 'header-buttons, headerBrand');
    /*
     * v5 section 3, amendment line 52: the session row "chi chua session strip"
     * -- "Khong chua action, spacer hay menu."
     *
     * This assertion was INVERTED before: on touch it REQUIRED
     * sessionActionsControl in the row, i.e. it demanded the exact violation
     * the amendment forbids. Corrected to strip-only at every viewport.
     *
     * Note the fine-pointer side keeps tab-row-actions: that is the DESKTOP
     * contextual row, which v5 section 4 keeps. The strip-only rule is the
     * touch shape.
     *
     * W14 item 7 (owner instruction, supersedes the amendment-line-52 premise):
     * the SAME #newConnectionBtn node is now the permanent icon-only FIRST CHILD
     * of the session row at every viewport. It is not an in-row action or menu
     * in the amendment's sense -- it is the strip's anchor, keeping the row
     * painted even with zero sessions. The row therefore holds [button, strip,
     * (desktop-only actions)]; the button's strip-home contract is asserted
     * separately and positively below.
     */
    check(`${vp.label}: the session tier holds the strip's '+' and strip only`,
        m.twoTier.tabsRowMembers,
        vp.touch
            ? 'newConnectionBtn, sessionTabs'
            : 'newConnectionBtn, sessionTabs, tab-row-actions');

    // The headline number: one bar, and how tall it is.
    atMost(`${vp.label}: the bar is at most ${vp.bar}px`, m.headerH, vp.bar, 'px');
    check(`${vp.label}: the bar lays out in ${vp.rows} row(s)`, m.rowCount, vp.rows);

    /*
     * v3 F4 (failing first): the two tiers must be real boxes, not
     * display:contents wrappers; the session tier must sit below the global
     * tier; both must hold their design heights.
     *
     * Re-derived for v5 section 3. On touch the global tier is NOT
     * .header-content -- that wrapper is deliberately display:contents there so
     * the brand and #touchActionRow share one flex line. The real row-1 box is
     * #touchActionRow, and v5 puts it at 44px (amendment line 30, mockup line
     * 324), not the pre-v5 48px. The assertion is retargeted rather than
     * relaxed: it still pins an exact height on a real box, and it still fails
     * if the wrapper mode flips at the wrong viewport.
     */
    check(`${vp.label}: the global tier is a real box, not a pass-through`,
        vp.touch ? m.twoTier.touchRowDisplay : m.twoTier.contentDisplay, 'flex');
    check(`${vp.label}: .header-content is ${vp.touch ? 'a contents pass-through' : 'its own flex tier'}`,
        m.twoTier.contentDisplay, vp.touch ? 'contents' : 'flex');
    check(`${vp.label}: .session-tabs-row is its own flex tier`,
        m.twoTier.tabsRowDisplay, 'flex');
    check(`${vp.label}: the global tier is 44px tall`,
        vp.touch ? m.twoTier.touchRowH : m.twoTier.contentH, 44);
    check(`${vp.label}: the session tier is ${vp.tier}px tall`,
        m.twoTier.tabsRowH, vp.tier);
    check(`${vp.label}: the session tier sits below the global tier`,
        vp.touch ? m.twoTier.touchStacked : m.twoTier.stacked, true);

    /*
     * B1: the chip and the row-2 controls fill their tier exactly
     * -- 40px on fine pointers, 44px on touch (real non-overlapping targets) --
     * and the strip keeps its horizontal-only scroll policy with zero vertical
     * drift while a chip is laid out.
     *
     * Re-derived. The split-control assertion measured
     * `.split-controls .split-btn`, which v5 section 4 turned into a
     * PROGRAMMATIC engine source: the cluster carries hidden + aria-hidden and
     * generates no box (templates/index.html:205-226 documents this), so the
     * old assertion was measuring 0px against a non-surface and could never
     * have caught a real regression. The user-facing layout control is the
     * single Layout dropdown trigger (#layoutMenuBtn), which is what v5
     * section 4 replaced the four numbered buttons with. Retargeted to it --
     * this is stricter, not looser: it now pins a control a user can actually
     * hit, at a height that differs per capability.
     *
     * The icon control is also capability-scoped: on touch the four v5 icons
     * live in #touchActionRow, on a fine pointer they stay in the desktop
     * contextual row (.tab-row-actions).
     */
    /*
     * S3, re-derived. The chip no longer fills the tier, and the
     * mockup is explicit that it must not. Spec line 243 sizes the chip itself:
     *   .tw5-session { min-width:92px; height:30px; min-height:30px;
     *                  padding:1px 7px; border:1px solid transparent;
     *                  border-radius:7px; }
     * while spec line 229 sizes the ROW that holds it:
     *   .tw5-workspace-row { height:40px; padding-block:3px; }
     * The element box remains the native hit target: 44px on touch (40px in
     * phone landscape), and 30px on fine pointer. On touch, the element itself
     * must be transparent; ::before is the only painted surface and is a
     * border-box 30px pill. Amendment lines 53-55 require that separation.
     *
     * The original 44-to-30 framing was withdrawn in Entry 21: the
     * earlier measurement read the element instead of its pseudo paint and
     * ignored translateY(-50%). These checks therefore keep the 44/40 hit-box
     * assertion and separately pin the actual paint owner.
     */
    check(`${vp.label}: the chip target remains ${vp.touch ? 44 : 30}px`,
        m.chipH, vp.touch ? 44 : 30);
    check(`${vp.label}: the chip paint is 30px (mockup line 243)`,
        m.chipPaintedH, 30);
    if (vp.touch) {
        check(`${vp.label}: touch chip element background is transparent`,
            m.chipOwnPaint.background, 'rgba(0, 0, 0, 0)');
        check(`${vp.label}: touch chip element has no top border`,
            m.chipOwnPaint.borderTop, '0px');
        check(`${vp.label}: touch chip element has no bottom border`,
            m.chipOwnPaint.borderBottom, '0px');
        check(`${vp.label}: touch chip element has no shadow`,
            m.chipOwnPaint.boxShadow, 'none');
        check(`${vp.label}: touch pill uses border-box sizing`,
            m.chipPillBoxSizing, 'border-box');
    }
    check(`${vp.label}: the chip clears the mockup 92px floor`,
        m.chipMinW >= 92, true);
    check(`${vp.label}: the painted chip radius is 7px (spec 243)`,
        m.chipRadius, '7px');
    check(`${vp.label}: the status dot is 7px (spec 249)`, m.chipDotH, 7);
    check(`${vp.label}: the layout trigger matches the tier (${vp.touch ? 44 : 32}px)`,
        m.layoutTriggerH, vp.touch ? 44 : 32);
    check(`${vp.label}: row-2 icon control matches the tier (${vp.touch ? 44 : 32}px)`,
        m.iconH, vp.touch ? 44 : 32);
    /*
     * The engine source must stay a non-surface. Without this, deleting the
     * `hidden` attribute would silently restore a second, invisible layout UI
     * that the retargeted assertion above would no longer notice.
     */
    check(`${vp.label}: the split engine source stays off-surface`,
        m.splitClusterBoxless, true);
    check(`${vp.label}: the strip has zero vertical drift`, m.stripDrift, 0);
    check(`${vp.label}: the strip scrolls horizontally only`,
        m.stripOverflowX, 'auto');
    check(`${vp.label}: the strip never scrolls vertically`,
        m.stripOverflowY, 'hidden');

    /*
     * P2 D1 geometry proof (not class presence): brand/context holds the
     * left edge of the bar and the complete function/account action group
     * holds the right edge, at every desktop width, glyph-only or labelled.
     * The expected offset is the row's own horizontal padding, so both clusters
     * must land within 2px of it; anything else means the space-between
     * anchoring regressed to content-flow packing.
     *
     * Re-derived: on touch the right-edge cluster is #touchActionRow
     * (v5 section 3 puts the six actions there and hides .header-buttons), so
     * the assertion follows the cluster that actually lays out. Same tolerance,
     * same failure mode -- only the element changes.
     *
     *: the expected inset is now per-shell, because the two shells
     * legitimately differ. Mockup line 227 gives every shell row
     * `padding:5px 8px`, and the FINE-POINTER header used to add a third inline
     * inset of its own (12px) on top of the row's 8px and the strip's 8px --
     * 28px of stacked padding that put the first chip 28px inside the shell
     * border. deck.css L2c made the row the single inline-inset owner there, so
     * the desktop figure is the authority's 8px. The COARSE shell never had the
     * stacking defect and keeps its own symmetric 12px header inset (measured
     * 12px on both edges at 768x1024 and 834x1194 coarse), which is a 44px-row
     * touch decision, not a mockup deviation -- so it is asserted at its own
     * value rather than forced to the desktop one.
     *
     * The claim is unchanged either way: each cluster still has to hold its edge
     * within 2px of its own shell's row inset, which is exactly what caught the
     * space-between regression before.
     */
    const ROW_INSET = vp.touch ? 12 : 8;
    check(`${vp.label}: the brand cluster holds the left edge`,
        Math.abs(m.twoTier.titleLeft - (m.deckLeft + ROW_INSET)) <= 2, true);
    check(`${vp.label}: the action cluster holds the right edge`,
        Math.abs((m.headerRight - (vp.touch
            ? m.twoTier.touchRowRight : m.twoTier.buttonsRight)) - ROW_INSET) <= 2,
        true);

    /*
     * Same claim, SESSION tier (row 2). Row 1 was already pinned; row 2 was not,
     * and a mutation proved it: restoring .tab-row-actions' own 6px right
     * padding -- a second inline-inset owner on the row, the defect deck.css L2c
     * removed -- kept this suite at 364/0. Both edges of the tier now have to
     * hold the row inset, so neither a re-stacked header inset nor a
     * re-introduced action-group inset can pass unnoticed.
     *
     * W14 item 7 changes only WHICH box owns the left edge: the permanent '+' is
     * the row's first child, before the strip, so it is now the leading box. The
     * right edge remains the last contextual action. Fine pointer only: on touch
     * the six actions live in #touchActionRow / the dock, which the assertions
     * above already cover, and .tab-row-actions generates no box there.
     */
    if (!vp.touch) {
        check(`${vp.label}: the strip '+' holds the session tier's left edge`,
            Math.abs(m.tierLeadingInset - ROW_INSET) <= 1, true);
        check(`${vp.label}: the last row action holds the session tier's right edge`,
            Math.abs(m.tierActionInset - ROW_INSET) <= 1, true);
    }

    /*
     * The chips must have real room, not just be present.
     *
     * This is the check that makes the glyph-only rule below 1024px matter, and
     * a mutation run proved it was missing: with the labels shown, everything
     * still fitted the bar and nothing overflowed, but #sessionTabs -- the
     * flex: 1 1 auto middle -- was squeezed to 0px at both 768 and 926. A bar
     * where the open sessions have no width is worse than one that overflows,
     * because it looks fine.
     *
     * 120px is one chip at its narrowest useful size (a truncated hostname plus
     * the state dot and close affordance), not a round number.
     */
    atLeast(`${vp.label}: the chips keep usable width`, m.tabsW, 120, 'px');

    // Chrome uses an 11% height budget from the 800px laptop reference upward.
    // Below 800px, the exact two-row minimum is capability-specific: touch keeps
    // 44 + 44 = 88px, while fine-pointer desktop is 44 + 40 = 84px.
    const budget = 0.11;
    const budgetPx = Math.max(budget * vp.h, vp.touch ? 88 : 84);
    atMost(`${vp.label}: bar within the reference-aware budget`,
        m.headerH, budgetPx, 'px');

    // Nothing may overflow the bar horizontally: that is what a third row was
    // hiding before, and an overflowing row scrolls a control off-screen.
    const overflowing = m.items.filter(i => i.right > m.headerRight + 1)
        .map(i => `${i.id || i.cls} right=${i.right} barRight=${m.headerRight}`);
    check(`${vp.label}: no item overflows the bar`, overflowing, []);

    /*
     * The five primary header actions stay visible across tablet and desktop.
     * Lower-width tablet layouts may hide the three secondary tab-row icons to
     * preserve usable width for the real session strip.
     *
     * Re-derived: on touch, v5 section 3 moves the whole
     * function/account group off the header and into the ONE global menu
     * (mockup line 128-135), so .header-buttons is display:none and these five
     * are correctly not in the bar. Asserting their header visibility there
     * demanded the pre-v5 shape. Coverage is not dropped -- it is redirected:
     * on touch each must still be REACHABLE from the global menu, which is the
     * v5 requirement and a stronger statement than "has a box somewhere".
     */
    /*
     * Re-derived (H1/H3): the v5 desktop header is EXACTLY four
     * elements -- brand, Ket noi moi, Tep, Lenh, account (mockup lines 66-72)
     * -- and Profiles is the FIRST entry of the account menu, not a header
     * button (mockup line 76:
     *   <button ...><i data-lucide="contact-round"></i><span>Profiles</span>...)
     * So #manageProfilesBtn having no header box is the specified shape, and
     * asserting its header visibility demanded the pre-v5 header.
     *
     * Coverage is NOT dropped, it is redirected and strengthened: the four that
     * really are header members keep the visibility assertion, and Profiles now
     * has to be reachable through the menu that owns it -- asserted below by a
     * real click, which is a stronger statement than "has a box in the header".
     */
    // W14 item 7: newConnectionBtn left the header -- it is the strip's
    // permanent first child, asserted separately below, at every shell.
    const ALWAYS = ['fileTransferBtn', 'commandLibraryBtn',
        'accountBtnHeader'];
    if (vp.touch) {
        check(`${vp.label}: the canonical actions are hosted in the ONE global menu`,
            m.sheetHostMissing, []);
    } else {
        const hidden = m.controls
            .filter(c => ALWAYS.includes(c.id) && (c.missing || c.hidden))
            .map(c => c.id);
        check(`${vp.label}: the three header actions are visible`, hidden, []);
    }
    /*
     * W14 item 7 companion check for BOTH shells: the SAME #newConnectionBtn
     * node is the visible first child of the session strip -- never in the
     * sheet, never in the header. On touch the strip row is display:contents,
     * so "first child" is a DOM fact, not a painted position.
     */
    {
        const stripBtn = await page.evaluate(() => {
            const btn = document.getElementById('newConnectionBtn');
            if (!btn) return { missing: true };
            const boxless = btn.offsetParent === null
                && btn.getClientRects().length === 0;
            const cs = getComputedStyle(btn);
            return {
                stripHome: btn.parentElement
                    ?.classList.contains('session-tabs-row'),
                firstChild: btn.parentElement?.firstElementChild === btn,
                inSheet: !!btn.closest('#mobileMoreSheet'),
                visible: !boxless && cs.display !== 'none'
                    && cs.visibility !== 'hidden',
                labelHidden: getComputedStyle(
                    btn.querySelector('.btn-label')).display === 'none',
            };
        });
        check(`${vp.label}: the strip '+' is the visible first child everywhere`,
            stripBtn,
            { stripHome: true, firstChild: true, inSheet: false, visible: true,
                labelHidden: true });
    }
    if (!vp.touch) {
        /*
         * The companion that keeps the shrunk list honest. The three controls
         * H2/H3 took OUT of the header (mockup lines 66-72 leave no room for
         * them; line 76 hosts Profiles in the account menu) must each still be
         * operable from their new home. Measured after a REAL click on
         * #accountBtnHeader, not by reading the closed tree: a control that is
         * present but never paints would pass a DOM-only check and fail a user.
         */
        await page.click('#accountBtnHeader');
        await page.waitForTimeout(120);
        const relocated = await page.evaluate(() =>
            ['manageProfilesBtn', 'reloadPageBtn', 'fileTransferOpenBtn']
                .filter((id) => {
                    const e = document.getElementById(id);
                    if (!e || e.disabled) return true;
                    const r = e.getBoundingClientRect();
                    return e.getClientRects().length === 0
                        || getComputedStyle(e).visibility === 'hidden'
                        || r.width < 1 || r.height < 1;
                }));
        check(`${vp.label}: the relocated actions are operable in the account menu`,
            relocated, []);
        // And the capability itself, not merely a painted box: the header
        // Library button really opens the rail (Entry 39).
        await page.click('#commandLibraryBtn');
        await page.waitForTimeout(120);
        check(`${vp.label}: the header Library opener opens the rail`,
            await page.evaluate(() => window.CommandLibrary
                && CommandLibrary.isOpen()), true);
        // Put the shell back as this tier found it: close the rail with its own
        // control (via the menu again), so later assertions in this loop
        // iteration measure a closed auxiliary track, not a 340px one.
        await page.click('#commandLibraryBtn');
        await page.waitForTimeout(120);
        check(`${vp.label}: the rail closed again, restoring the tier`,
            await page.evaluate(() => CommandLibrary.isOpen()), false);
    }

    /*
     * The three tab-row icons appear only at 1024px and up.
     *
     * Below that they cost ~190px (44px each plus dividers, the touch floor) and
     * the measurement is unambiguous: with them in place #sessionTabs was 0px at
     * 768 and 137px at 926. They are the right three to drop because broadcast
     * and reload are per-session at most and save-transcript is once at the end
     * -- DESIGN.md section 3, used less than once per session, no permanent
     * height. Both non-browser actions stay in the command palette.
     */
    /*
     * Hiding the labels removes the accessible name unless something else
     * carries it. Below 1024px these six buttons are glyph-only, so each one
     * needs a title (for a pointer) and an aria-label (for a screen reader) --
     * an emoji alone is not a name. This is the a11y risk the glyph rule
     * introduces, so it is checked at the widths where the rule applies.
     */
    if (vp.w < 1024) {
        check(`${vp.label}: every glyph-only action keeps its name`,
            m.unnamed, []);
    }

    /*
     * v5 section 3, re-derived: which four icons these are is
     * capability-dependent, and the single list was the pre-v5 one.
     *
     * Touch: the row's four icon actions are Broadcast, Luu transcript, Ket noi
     * lai and Ghi chu (mockup lines 121-124).
     *
     * Re-derived again (H2): the DESKTOP contextual row is the same
     * four. Mockup lines 92-96 list it exactly -- panels-top-left (the layout
     * trigger, counted separately), radio-tower, file-down, refresh-cw,
     * notebook-pen. #reloadPageBtn is not in that row on ANY tier; it is a
     * whole-application action and H2 moved it into the account menu, where
     * the assertion above proves it still works. The refresh-cw member is
     * #touchReconnectBtn, which is the node the app actually renders there --
     * its id predates v5 and is misleading, but it is the per-session Reconnect
     * on every tier, not a touch-only control.
     */
    const ICONS = ['broadcastToggleBtn', 'saveTranscriptBtn',
        'touchReconnectBtn', 'notepadOpenBtn'];
    const iconsShown = m.controls
        .filter(c => ICONS.includes(c.id) && !c.missing && !c.hidden)
        .map(c => c.id);
    // Wide touch shells (coarse >=768) keep the row-2 icons visible as real
    // 44x44 targets; only fine-pointer viewports below 1024 hide them.
    //
    // The touch count was 3, excluding #notepadOpenBtn on the grounds that the
    // dock's #mobileNotepadBtn was the touch Note affordance and showing both
    // gave coarse tablets two Note controls with different semantics. That
    // premise has lapsed: #mobileNotepadBtn no longer exists (removed per
    // app.js:2546; its absence is actively asserted by
    // tests/test_header_menus.py:181 and tests/test_responsive_breakpoints.py:400),
    // and #notepadOpenBtn absorbed its aria-controls/aria-expanded. So there is
    // now exactly one Note control and it is this one, which v5 section 3 lists
    // as primary action 5 (Ghi chu, notebook-pen). Expect 4 on touch.
    // exit_scroll_contract.mjs section 1 owns the per-tier visibility contract.
    const iconsExpected = vp.touch ? 4 : (vp.w >= 1024 ? 4 : 0);
    check(`${vp.label}: the tab-row icons are `
        + `${iconsExpected ? 'shown' : 'hidden'}`,
        iconsShown.length, iconsExpected);

    /*
     * v5 section 3 / section 7 gate line 1: "iPad doc/ngang va phone
     * portrait/landscape deu co du sau action; khong action nao bi an hoac
     * wrap." New positive coverage -- the suite previously asserted only what
     * the row must NOT contain, so all six actions could have gone missing
     * without a single failure. Order is the mockup's (lines 120-125).
     */
    if (vp.touch) {
        check(`${vp.label}: the action row holds all six v5 actions in order`,
            m.touchActions.order,
            'touchLayoutControl, broadcastToggleBtn, saveTranscriptBtn, '
            + 'touchReconnectBtn, notepadOpenBtn, mobileMoreBtn');
        check(`${vp.label}: no action wraps to a second line`,
            m.touchActions.lines, 1);
        check(`${vp.label}: the action row needs no scroll surface`,
            m.touchActions.scrolls, false);
        /*
         * v5 amendment line 45: "Khong tao nut menu thu hai o session row hoac
         * composer." Exactly one menu opener app-wide, and it is the one in
         * the action row.
         */
        check(`${vp.label}: exactly one menu button app-wide`,
            m.touchActions.menuOpeners, ['mobileMoreBtn']);
    }

    // WCAG 2.5.5 on touch. Measured on both axes: an earlier piece found the
    // coarse-pointer rule set min-height only, leaving 28x44 icon buttons.
    if (vp.touch) {
        const small = m.controls.filter(c => !c.missing && !c.hidden
            && (c.w < 44 || c.h < 44))
            .map(c => `${c.id} ${c.w}x${c.h}`);
        check(`${vp.label}: every visible action is at least 44x44`, small, []);
    }

    // The terminal starts where the bar ends. If these disagree, something
    // between them has height that the bar measurement did not account for.
    check(`${vp.label}: the terminal starts at the bottom of the bar, deck-relative`,
        m.gridTop - m.deckTop, m.deckBorderTop + m.headerH);

    // capability model (D3): the dock is a touch-shell surface. On
    // pure fine-pointer desktops it stays hidden; on the touch tablet it must
    // render in flow at the bottom. So the expectation flips on vp.touch.
    check(`${vp.label}: the mobile dock ${vp.touch ? 'renders on touch' : 'stays hidden on desktop'}`,
        m.mobileShell.sessionBarVisible, vp.touch);
    // The More sheet is only ever visible when its trigger is pressed; it must
    // never render on its own, on any shell.
    check(`${vp.label}: the More sheet is not rendered`,
        m.mobileShell.moreVisible, false);
    check(`${vp.label}: the inactive More sheet remains hidden`,
        m.mobileShell.moreHidden, true);
    check(`${vp.label}: the inactive More sheet remains inert`,
        m.mobileShell.moreInert, true);
    check(`${vp.label}: exactly one real session strip exists`,
        m.mobileShell.tabCount, 1);
    check(`${vp.label}: the strip directly follows the '+'`,
        m.mobileShell.tabsAfterButton, true);

    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// B1: coarse iPad contract -- the session tier is a real 44px on
// wide touch shells, and the chip and row-2 controls are true 44x44 targets
// with zero vertical drift. Desktop fine pointers keep 48+40=88 (loop above);
// phones keep the 45px strip (measured in the phone suites). Coarse-pointer
// emulation only; runtime-measured, not assumed.
//
// Re-derived for v5 section 3: the coarse bar is 44+44=88, not the
// pre-v5 48+44=92, and the global tier is the 44px #touchActionRow rather than
// a 48px .header-content (which is display:contents on touch). The split
// control is retargeted to the Layout dropdown trigger for the same reason as
// the main loop -- .split-controls is a hidden engine source with no box.
// ============================================================================
for (const vp of [
    { label: 'ipad-portrait', w: 834, h: 1194 },
    { label: 'ipad-landscape', w: 1194, h: 834 },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);

    const m = await page.evaluate(() => {
        const r = el => el ? Math.round(el.getBoundingClientRect().height) : null;
        const tabs = document.getElementById('sessionTabs');
        let chip = tabs && tabs.querySelector('.session-tab');
        let seeded = false;
        if (tabs && !chip) {
            seeded = true;
            chip = document.createElement('div');
            chip.className = 'session-tab';
            chip.innerHTML = '<span class="status-dot connected"></span>'
                + '<span class="tab-label"><span class="tab-host-name">host.example</span>'
                + '<span class="tab-user-name">user</span></span>';
            tabs.appendChild(chip);
        }
        const out = {
            headerH: r(document.querySelector('.header')),
            contentH: r(document.querySelector('.header-content')),
            touchRowH: r(document.getElementById('touchActionRow')),
            tierH: r(document.querySelector('.session-tabs-row')),
            chipH: chip ? Math.round(chip.getBoundingClientRect().height) : null,
            layoutTriggerH: r(document.getElementById('layoutMenuBtn')),
            iconH: r(document.querySelector('#touchActionRow .tab-row-icon-btn')),
            drift: tabs ? tabs.scrollHeight - tabs.clientHeight : null,
            ox: tabs ? getComputedStyle(tabs).overflowX : null,
            oy: tabs ? getComputedStyle(tabs).overflowY : null,
        };
        if (seeded && chip) chip.remove();
        return out;
    });

    console.log(`\n--- ${vp.label} ${vp.w}x${vp.h} (coarse) ---`);
    check(`${vp.label}: the coarse bar is 88px (44 + 44)`, m.headerH, 88);
    check(`${vp.label}: the global/action row is a real 44px`, m.touchRowH, 44);
    check(`${vp.label}: .header-content is a contents pass-through on touch`,
        m.contentH, 0);
    check(`${vp.label}: the session tier is a real 44px`, m.tierH, 44);
    check(`${vp.label}: the chip is a real 44px target`, m.chipH, 44);
    check(`${vp.label}: the layout trigger is a real 44px target`,
        m.layoutTriggerH, 44);
    check(`${vp.label}: the icon control is a real 44px target`, m.iconH, 44);
    check(`${vp.label}: the strip has zero vertical drift`, m.drift, 0);
    check(`${vp.label}: the strip scrolls horizontally only`, m.ox, 'auto');
    check(`${vp.label}: the strip never scrolls vertically`, m.oy, 'hidden');
    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// The opened global menu is right-anchored and hangs below its trigger, at
// both shells. The cluster check in the loop above proves where the TRIGGER
// sits; it says nothing about the panel, which is absolutely positioned and
// could regress to left:0 while every existing assertion stayed green.
// Measured against the trigger's own right edge rather than the viewport's,
// because that is what `right: 0` on an abspos child actually means.
//
// Re-derived: the trigger and panel are capability-dependent. Fine
// pointer uses #accountBtnHeader / #accountDropdownHeader (mockup line 71-75);
// touch uses the ONE global menu, #mobileMoreBtn / #mobileMoreSheet (mockup
// line 125, 128-135), because v5 renders no standalone account trigger on
// touch. Phones are covered by mobile_shell_layout.mjs, which owns the dock.
// ============================================================================
for (const vp of [
    { label: 'acct-ipad-portrait', w: 768, h: 1024, touch: true },
    { label: 'acct-ipad-landscape', w: 1194, h: 834, touch: true },
    { label: 'acct-laptop', w: 1280, h: 800, touch: false },
    { label: 'acct-desktop', w: 1920, h: 1080, touch: false },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    // Freeze animation, for the same reason as the main loop above: .show
    // runs slideDown, whose first keyframe translates the panel UP by 10px.
    // Measured mid-flight, the panel reads as overlapping its own trigger.
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);

    const m = await page.evaluate(vpTouch => {
        /*
         * v5 section 3 / section 6, re-derived.
         *
         * On touch there is no standalone account trigger: the mockup renders
         * .tw5-account only in the DESKTOP header (line 71), and the touch
         * global menu carries the account block as its first child
         * (.tw5-menu-account, line 129). The amendment's line 45 forbids a
         * second menu button, and line 93 anchors the ONE global menu under the
         * "Menu/Tai khoan" button.
         *
         * So on touch the trigger is #mobileMoreBtn and the panel is
         * #mobileMoreSheet, and the account content is reached through it. The
         * old code asserted the desktop #accountBtnHeader geometry at both iPad
         * viewports; that trigger is inside .header-buttons, which is
         * display:none on touch, so all seven assertions were measuring an
         * element with no box.
         */
        const btn = document.getElementById(
            vpTouch ? 'mobileMoreBtn' : 'accountBtnHeader');
        const menu = document.getElementById(
            vpTouch ? 'mobileMoreSheet' : 'accountDropdownHeader');
        if (!btn || !menu) return { triggerRendered: false };
        // Guard the premise: a zero-width or undisplayed trigger would make
        // every geometry comparison below pass on two empty rects.
        const br0 = btn.getBoundingClientRect();
        if (getComputedStyle(btn).display === 'none' || br0.width < 1) {
            return { triggerRendered: false };
        }
        btn.click();
        const mr = menu.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        return {
            triggerRendered: true,
            shown: getComputedStyle(menu).display,
            position: getComputedStyle(menu).position,
            hasWidth: Math.round(mr.width) > 0,
            /*
             * Right-anchored to the trigger. The tolerance is capability-
             * dependent because the two panels anchor to different things:
             *
             *  - fine pointer: the dropdown is an abspos child of the account
             *    selector with `right: 0`, so its right edge coincides with the
             *    trigger's to the pixel.
             *  - touch: mockup line 267 anchors the global menu to `right: 6px`
             *    of the action ROW, while the trigger sits inside the row's own
             *    padding. That is a fixed 10px offset by construction, not
             *    drift. 12px still fails a panel that regresses to left:0 or to
             *    full-bleed, which is what this assertion exists to catch.
             */
            rightAligned: Math.abs(mr.right - br.right) <= (vpTouch ? 12 : 1),
            // Amendment line 93: the right edge must not exceed the viewport.
            inViewport: mr.right <= vw + 1 && mr.left >= -1,
            // The panel must hang BELOW its trigger, not overlap it: a
            // right-aligned menu drawn over the bar is still wrong.
            belowTrigger: Math.round(mr.top) >= Math.round(br.bottom) - 1,
            /*
             * The account block must be reachable from the ONE global menu on
             * touch (mockup line 129). Reported rather than assumed: the app
             * hosts the account dropdown in #mobileSettingsHost, so presence
             * inside the sheet subtree is what makes v5's account block real.
             */
            // Only the hosted tree counts now. #mobileSettingsBtn used to satisfy
            // this as the entry point of the removed intermediate view, so the
            // alternation would have accepted a menu where the account block was
            // one navigation step away rather than present (owner correction
            //: one canonical menu, no Settings step).
            accountReachable: !!menu.querySelector('#accountDropdownHeader'),
        };
    }, vp.touch);

    console.log(`\n--- ${vp.label} ${vp.w}x${vp.h} (touch=${vp.touch}) ---`);
    check(`${vp.label}: the ${vp.touch ? 'global menu' : 'account'} trigger is rendered`,
        m.triggerRendered, true);
    /*
     * "Opens" means it has a painted display, not one particular keyword. The
     * touch global menu is a `flex` column since the frame/menu correction of
     * -- it needs a column with a bounded max-height so its content
     * can scroll to the last row -- while the desktop dropdown stays `block`.
     * Pinning the literal 'block' asserted a layout mode neither surface
     * promises; what matters, and what a closed menu would fail, is that the
     * computed display is not `none`. Width and anchoring are asserted
     * separately below, so an "open but empty" panel still cannot pass.
     */
    check(`${vp.label}: the menu opens`, m.shown !== 'none', true);
    /*
     * Out of normal flow, so it overlays rather than displacing the layout.
     * The touch global menu is `fixed`, not `absolute`: its offset parent is
     * the bottom dock (#sessionBar, which also carries overflow-x:hidden), so
     * only the viewport as containing block lets it anchor to the action row.
     * Both values are out-of-flow; `static` or `relative` still fails.
     */
    check(`${vp.label}: the menu is out of flow`,
        m.position, vp.touch ? 'fixed' : 'absolute');
    check(`${vp.label}: it has a real width`, m.hasWidth, true);
    check(`${vp.label}: it is right-anchored to its trigger`, m.rightAligned, true);
    check(`${vp.label}: it hangs below its trigger`, m.belowTrigger, true);
    check(`${vp.label}: it stays inside the viewport`, m.inViewport, true);
    if (vp.touch) {
        check(`${vp.label}: the account block is reachable from the global menu`,
            m.accountReachable, true);
    }
    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// P4 HDR §12.3: computed-style contract for the visual redesign. Runs at a
// single desktop viewport, UNFROZEN — the freeze tag in the loop above
// collapses every transition and animation to 'none', which is the
// reduced-motion check, not the normal-motion one. A synthetic session-tab
// probe is sufficient: the CSS rules apply by class, and the existing loop
// proves the geometry is unchanged.
// ============================================================================
{
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });

    const p4 = await page.evaluate(() => {
        const split = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
        const tabs = document.getElementById('sessionTabs');
        const probe = document.createElement('div');
        probe.className = 'session-tab';
        probe.innerHTML = '<span class="status-dot connecting"></span>'
            + '<span class="tab-label"><span class="tab-host-name">host.example</span>'
            + '<span class="tab-user-name">user</span></span>';
        if (tabs) tabs.appendChild(probe);
        const cs = el => el ? getComputedStyle(el) : null;
        const st = cs(probe);
        const tri = cs(document.querySelector('.tab-row-icon-btn'));
        const hbtn = cs(document.querySelector('.header .btn'));
        const host = cs(probe.querySelector('.tab-host-name'));
        const user = cs(probe.querySelector('.tab-user-name'));
        const dot = cs(probe.querySelector('.status-dot.connecting'));
        const out = {
            tabTransProp: split(st?.transitionProperty),
            tabTransDur: split(st?.transitionDuration),
            triTransProp: split(tri?.transitionProperty),
            triTransDur: split(tri?.transitionDuration),
            hbtnTransProp: split(hbtn?.transitionProperty),
            hbtnTransDur: split(hbtn?.transitionDuration),
            hostFamily: host?.fontFamily || '',
            hostSize: host?.fontSize || '',
            userFamily: user?.fontFamily || '',
            userSize: user?.fontSize || '',
            dotAnimName: dot?.animationName || '',
            dotAnimDur: dot?.animationDuration || '',
            dotAnimTiming: dot?.animationTimingFunction || '',
            dotAnimIter: dot?.animationIterationCount || '',
        };
        probe.remove();
        return out;
    });

    // Exact scoped transition property sets, ordered (§12.3 P-g; no 'all').
    check('P4: session-tab transition properties are exact ordered set',
        p4.tabTransProp.join(', '),
        'background-color, border-color, color, box-shadow');
    check('P4: tab-row-icon-btn transition properties are exact ordered set',
        p4.triTransProp.join(', '),
        'background-color, border-color, color');
    check('P4: header .btn transition properties are exact ordered set',
        p4.hbtnTransProp.join(', '),
        'background-color, border-color, color, box-shadow');

    // Every effective duration entry is 0.15s, no other duration.
    check('P4: session-tab all durations are 0.15s',
        p4.tabTransDur.every(d => d === '0.15s') && p4.tabTransDur.length === 4, true);
    check('P4: tab-row-icon-btn all durations are 0.15s',
        p4.triTransDur.every(d => d === '0.15s') && p4.triTransDur.length === 3, true);
    check('P4: header .btn all durations are 0.15s',
        p4.hbtnTransDur.every(d => d === '0.15s') && p4.hbtnTransDur.length === 4, true);

    // Typography: mono host 13px, sans user 12px (§12.3 P-f, Row 2).
    check('P4: tab-host-name uses mono font',
        /mono|monospace/i.test(p4.hostFamily), true);
    check('P4: tab-host-name is 13px', p4.hostSize, '13px');
    check('P4: tab-user-name is 12px', p4.userSize, '12px');
    check('P4: host and user font families differ (mono vs sans)',
        p4.hostFamily !== p4.userFamily, true);

    // Connecting-dot pulse in normal motion (§12.3 P-g): full animation contract.
    check('P4: connecting-dot animation name is pulse', p4.dotAnimName, 'pulse');
    check('P4: connecting-dot animation duration is 1.5s', p4.dotAnimDur, '1.5s');
    check('P4: connecting-dot animation timing is ease-in-out', p4.dotAnimTiming, 'ease-in-out');
    check('P4: connecting-dot iteration count is infinite', p4.dotAnimIter, 'infinite');

    check('P4: no page errors', errors, []);
    await ctx.close();
}

// Reduced-motion: the connecting-dot pulse is neutralized (§12.3 a11y).
{
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    const rm = await page.evaluate(() => {
        const tabs = document.getElementById('sessionTabs');
        const probe = document.createElement('div');
        probe.className = 'session-tab';
        probe.innerHTML = '<span class="status-dot connecting"></span>';
        if (tabs) tabs.appendChild(probe);
        const dot = getComputedStyle(probe.querySelector('.status-dot.connecting'));
        const out = { animName: dot.animationName };
        probe.remove();
        return out;
    });
    check('P4 reduced-motion: connecting-dot animation disabled',
        rm.animName, 'none');
    check('P4 reduced-motion: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// Blocker 9 -- desktop outer frame, pane hairlines, and touch flattening.
//
// Authority:
//   - mockup line 220: real 1px border, 12px radius, shell background, and
//     0 18px 42px outer shadow;
//   - mockup lines 252-253 and 313-315: one continuous terminal plane with
//     neutral one-pixel internal edges;
//   - approved blocker-9 plan: a visible desktop stage/gutter, no full-perimeter
//     active-pane ring, and edge-to-edge touch reset.
//
// Measurements use production markup and computed styles. The desktop rail is
// opened through the real visible account-menu route, so this also proves that
// restoring the frame does not turn the approved non-blocking rail into an
// overlay or move the frame itself.
// ============================================================================
console.log('\n--- B9 desktop frame, split hairlines, rail, and touch reset ---');
for (const vp of [
    { label: 'desktop1440', width: 1440, height: 900, terminalFloor: 600 },
    { label: 'desktop1024', width: 1024, height: 768, terminalFloor: 480 },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();
    const b9Label = label => label.replace(/^B9 /, `B9 ${vp.label} `);
    const b9Check = (label, actual, expected) =>
        check(b9Label(label), actual, expected);
    const b9AtLeast = (label, actual, floor, unit = '') =>
        atLeast(b9Label(label), actual, floor, unit);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => SessionManager.setSplitLayout(4));
    await page.waitForTimeout(80);

    const measure = () => page.evaluate(() => {
        const rect = element => {
            const r = element.getBoundingClientRect();
            return {
                left: Math.round(r.left), top: Math.round(r.top),
                right: Math.round(r.right), bottom: Math.round(r.bottom),
                width: Math.round(r.width), height: Math.round(r.height),
            };
        };
        const deck = document.getElementById('deckWindow');
        const header = document.querySelector('.header');
        const grid = document.getElementById('terminalGrid');
        const area = document.querySelector('.terminal-area');
        const rail = document.getElementById('commandRail');
        const ds = getComputedStyle(deck);
        const gs = getComputedStyle(grid);
        const panes = [...grid.querySelectorAll(':scope > .terminal-pane')];
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;'
            + 'border:1px solid var(--tw-border);'
            + 'background:var(--tw-shell)';
        document.body.appendChild(probe);
        const probeStyle = getComputedStyle(probe);
        const expectedBorder = probeStyle.borderTopColor;
        const expectedShell = probeStyle.backgroundColor;
        probe.remove();
        const paneData = panes.map(pane => {
            const s = getComputedStyle(pane);
            return {
                rect: rect(pane),
                padding: [s.paddingTop, s.paddingRight,
                    s.paddingBottom, s.paddingLeft],
                radius: [s.borderTopLeftRadius, s.borderTopRightRadius,
                    s.borderBottomRightRadius, s.borderBottomLeftRadius],
                shadow: s.boxShadow,
                active: pane.classList.contains('active'),
                borders: [s.borderTopWidth, s.borderRightWidth,
                    s.borderBottomWidth, s.borderLeftWidth],
                borderColors: [s.borderTopColor, s.borderRightColor,
                    s.borderBottomColor, s.borderLeftColor],
                background: s.backgroundColor,
            };
        });
        return {
            innerWidth, innerHeight,
            deck: rect(deck), header: rect(header), grid: rect(grid),
            area: rect(area), rail: rect(rail),
            borderWidths: [ds.borderTopWidth, ds.borderRightWidth,
                ds.borderBottomWidth, ds.borderLeftWidth],
            borderStyles: [ds.borderTopStyle, ds.borderRightStyle,
                ds.borderBottomStyle, ds.borderLeftStyle],
            borderColors: [ds.borderTopColor, ds.borderRightColor,
                ds.borderBottomColor, ds.borderLeftColor],
            expectedBorder, expectedShell,
            radius: ds.borderTopLeftRadius,
            background: ds.backgroundColor,
            shadow: ds.boxShadow,
            gridGap: [gs.rowGap, gs.columnGap],
            gridPadding: [gs.paddingTop, gs.paddingRight,
                gs.paddingBottom, gs.paddingLeft],
            panes: paneData,
            railPosition: getComputedStyle(rail).position,
            railVisibility: getComputedStyle(rail).visibility,
        };
    });

    const closed = await measure();
    const frameMargins = [closed.deck.left, closed.deck.top,
        closed.innerWidth - closed.deck.right,
        closed.innerHeight - closed.deck.bottom];
    b9Check('B9 frame: desktop deck is inset from all four viewport edges',
        frameMargins.every(value => value > 0), true);
    /*
     * The gutter is an EVEN 6px on all four edges (deck.css .deck-window
     * `margin: 6px`).
     *
     * Two owner rulings apply and the second corrects the first. The asymmetric
     * 8 left / 12 top / 6 right / 24 bottom came from shadow-clearance floors
     * ([INF-B9-1], then Entry 39's mockup-measured inline values); the owner
     * rejected the asymmetry on sight because it read as a mistake
     * and the 24px bottom as a void under the terminal. EVEN is the requirement
     * and stays the requirement, so shadow clearance no longer sets the numbers.
     *
     * That ruling was implemented as 4px, and the owner reported
     * the result as a regression -- "the outer product frame border/background
     * separation has disappeared" -- restating the original scope: "The earlier
     * instruction was only to reduce excessive outer browser gutter slightly,
     * never to remove the product border, radius, background separation, desktop
     * shell, or responsive switch." At 4px the 1px border was crushed against the
     * viewport edge with no visible ground outside it. 6px is the owner's stated
     * target: still compact, half the original top inset and a quarter of the
     * original bottom, but with room for the border to read.
     *
     * The assertion is EXACT equality on every edge, not a floor, because "even"
     * is the actual requirement -- a floor would pass an asymmetric frame that
     * happened to clear it, which is the thing being ruled out. The paired
     * ceiling in shell_regression_contract.mjs stops it drifting back down.
     * frameMargins is [left, top, right-gap, bottom-gap].
     */
    b9Check('B9 frame: desktop stage keeps an even 6px gutter on all four edges',
        frameMargins.map(v => Math.round(v)), [6, 6, 6, 6]);
    b9Check('B9 frame: border is an actual one-pixel box border',
        closed.borderWidths, ['1px', '1px', '1px', '1px']);
    b9Check('B9 frame: actual border is solid on every edge',
        closed.borderStyles, ['solid', 'solid', 'solid', 'solid']);
    b9Check('B9 frame: border uses the resolved theme token',
        closed.borderColors, Array(4).fill(closed.expectedBorder));
    b9Check('B9 frame: radius is the mockup 12px', closed.radius, '12px');
    b9Check('B9 frame: shell uses the resolved theme background',
        closed.background, closed.expectedShell);
    b9Check('B9 frame: outer 0 18px 42px shadow is painted',
        /18px 42px/.test(closed.shadow), true);
    b9Check('B9 frame: the old inset fake-border layer is absent',
        closed.shadow.includes('inset'), false);
    b9Check('B9 frame: terminal top is measured deck-relative',
        closed.grid.top - closed.deck.top,
        parseFloat(closed.borderWidths[0]) + closed.header.height);

    b9Check('B9 pane: split-4 creates four direct panes', closed.panes.length, 4);
    b9Check('B9 pane: grid has zero row and column gap',
        closed.gridGap, ['0px', '0px']);
    b9Check('B9 pane: grid has zero padding',
        closed.gridPadding, ['0px', '0px', '0px', '0px']);
    b9Check('B9 pane: every direct pane has zero padding',
        closed.panes.every(p => p.padding.every(value => value === '0px')), true);
    b9Check('B9 pane: every direct pane has zero radius',
        closed.panes.every(p => p.radius.every(value => value === '0px')), true);
    b9Check('B9 pane: exactly one pane remains active',
        closed.panes.filter(p => p.active).length, 1);
    b9Check('B9 pane: direct panes have no full-perimeter box shadow',
        closed.panes.every(p => p.shadow === 'none'), true);
    b9Check('B9 pane: split-4 paints only the approved leading-edge topology',
        closed.panes.map(p => p.borders.join('/')), [
            '0px/0px/0px/0px',
            '0px/0px/0px/1px',
            '1px/0px/0px/0px',
            '1px/0px/0px/1px',
        ]);
    b9Check('B9 pane: every painted divider uses the neutral theme token',
        closed.panes.every(p => p.borders.every((width, index) =>
            width === '0px' || p.borderColors[index] === closed.expectedBorder)), true);
    b9Check('B9 pane: vertical seams are continuous with no gap',
        closed.panes[0].rect.right === closed.panes[1].rect.left
            && closed.panes[2].rect.right === closed.panes[3].rect.left, true);
    b9Check('B9 pane: horizontal seams are continuous with no gap',
        closed.panes[0].rect.bottom === closed.panes[2].rect.top
            && closed.panes[1].rect.bottom === closed.panes[3].rect.top, true);

    // Real desktop route: the header Library button (Entry 39).
    await page.click('#commandLibraryBtn');
    await page.waitForTimeout(400);
    const open = await measure();
    b9Check('B9 rail: the real account-menu route opens the rail',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    b9Check('B9 rail: open rail remains in normal flow', open.railPosition, 'static');
    b9Check('B9 rail: open rail is visible', open.railVisibility, 'visible');
    b9Check('B9 rail: opening the rail does not move or resize the frame',
        JSON.stringify(open.deck), JSON.stringify(closed.deck));
    b9Check('B9 rail: rail stays inside the framed product',
        open.rail.left >= open.deck.left
            && open.rail.right <= open.deck.right
            && open.rail.top >= open.deck.top
            && open.rail.bottom <= open.deck.bottom, true);
    b9Check('B9 rail: terminal ends exactly where the rail begins',
        open.area.right, open.rail.left);
    b9AtLeast('B9 rail: terminal remains visibly usable',
        open.area.width, vp.terminalFloor, 'px');

    await page.click('#commandRailCloseBtn');
    await page.waitForTimeout(400);
    const reclosed = await measure();
    b9Check('B9 rail: close restores the terminal width',
        reclosed.area.width, closed.area.width);
    b9Check('B9 desktop: no page errors', errors, []);
    await ctx.close();
}

for (const vp of [
    { label: 'tablet768', width: 768, height: 1024 },
    { label: 'ipad', width: 834, height: 1194 },
    { label: 'phone390', width: 390, height: 844 },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);
    const touch = await page.evaluate(() => {
        const deck = document.getElementById('deckWindow');
        const d = deck.getBoundingClientRect();
        const ds = getComputedStyle(deck);
        const bs = getComputedStyle(document.body);
        return {
            deck: {
                left: Math.round(d.left), top: Math.round(d.top),
                right: Math.round(d.right), bottom: Math.round(d.bottom),
                width: Math.round(d.width), height: Math.round(d.height),
            },
            innerWidth, innerHeight,
            borderWidths: [ds.borderTopWidth, ds.borderRightWidth,
                ds.borderBottomWidth, ds.borderLeftWidth],
            radius: ds.borderTopLeftRadius,
            shadow: ds.boxShadow,
            bodyPadding: [bs.paddingTop, bs.paddingRight,
                bs.paddingBottom, bs.paddingLeft],
        };
    });
    check(`B9 touch ${vp.label}: deck remains edge-to-edge`,
        JSON.stringify(touch.deck), JSON.stringify({
            left: 0, top: 0, right: touch.innerWidth, bottom: touch.innerHeight,
            width: touch.innerWidth, height: touch.innerHeight,
        }));
    check(`B9 touch ${vp.label}: desktop gutter is fully reset`,
        touch.bodyPadding, ['0px', '0px', '0px', '0px']);
    check(`B9 touch ${vp.label}: frame border is removed`,
        touch.borderWidths, ['0px', '0px', '0px', '0px']);
    check(`B9 touch ${vp.label}: frame radius is removed`, touch.radius, '0px');
    check(`B9 touch ${vp.label}: frame shadow is removed`, touch.shadow, 'none');
    check(`B9 touch ${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
