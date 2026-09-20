/*
 * The header menus, driven the way a user drives them.
 *
 * tests/test_header_menus.py checks the shape of the extracted file. This drives
 * the real templates/index.html in Chromium and clicks the actual controls,
 * because the failure mode of moving 146 lines out of an inline <script> is that
 * everything still LOOKS right and nothing opens.
 *
 * What is worth asserting here, and why:
 *   - The menu opens on click. The five inline onclick= attributes were the only
 *     thing binding these buttons before, so if the extracted bindings never run
 *     the page is silently inert.
 *   - Picking a theme changes data-theme AND repaints the terminals. The palette
 *     reaches xterm only via TerminalManager.applyThemeToAll(), which reads
 *     --term-* out of CSS; without it the page themes and the terminals do not.
 *   - The Theme/Language rows do NOT close the account menu. They open a
 *     sub-section in place, so closing on them would shut the menu the instant
 *     you reached for a theme -- the exact bug an over-tidy rewrite introduces.
 *   - A click outside closes everything.
 *
 * Run: node tests/browser/header_menus.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    // theme|default('glass') is what picks the starting theme; blanking it would
    // leave data-theme empty and the picker with nothing to mark active.
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    html = html.replace(/\{\{[^}]*\}\}/g, '');
    return html;
}

function startServer(html) {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
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
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let passed = 0;
let failed = 0;

function check(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}`
            + `\n      want ${JSON.stringify(want)}`);
    }
}

const server = await startServer(renderTemplate());
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(`${base}/`, { waitUntil: 'load' });
await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
        '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(style);
});

const shown = id => page.evaluate(
    i => !!document.getElementById(i)?.classList.contains('show'), id);

// The theme list is built by the extracted file at init. If it never ran, the
// dropdown is empty and every check below would fail for one shared reason --
// so establish it first.
check('theme picker is populated at init',
    await page.evaluate(
        () => document.querySelectorAll('#themeDropdownHeader .theme-option').length),
    10);

check('account menu starts closed', await shown('accountDropdownHeader'), false);

await page.click('#accountBtnHeader');
check('clicking the account button opens the menu',
    await shown('accountDropdownHeader'), true);

/*
 * Mockup v5 line 265 anchors the dropdown 1px below its owning wrapper. Measure
 * from .account-selector -- the absolute-positioning owner -- rather than from
 * the button inside it, whose box is not the containing block contract.
 */
const accountGeometry = await page.evaluate(() => {
    const owner = document.querySelector('.account-selector');
    const menu = document.getElementById('accountDropdownHeader');
    const ownerRect = owner.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    return {
        display: getComputedStyle(menu).display,
        width: Math.round(menuRect.width),
        height: Math.round(menuRect.height),
        ownerGap: Math.round(menuRect.top - ownerRect.bottom),
        rightAligned: Math.abs(menuRect.right - ownerRect.right) <= 1,
        contained: menuRect.left >= 0 && menuRect.right <= innerWidth,
    };
});
check('the open account menu is a positive, viewport-contained box',
    {
        display: accountGeometry.display,
        positive: accountGeometry.width > 0 && accountGeometry.height > 0,
        contained: accountGeometry.contained,
    }, { display: 'block', positive: true, contained: true });
check('the account menu is 1px below its owning wrapper',
    accountGeometry.ownerGap, 1);
check('the account menu keeps its right edge on the owning wrapper',
    accountGeometry.rightAligned, true);

// The load-bearing one: the expanders must not close the menu around them.
await page.click('#themeExpanderHeader');
check('the Theme expander opens its sub-section', await shown('themeDropdownHeader'), true);
check('the Theme expander leaves the account menu open',
    await shown('accountDropdownHeader'), true);

await page.click('#langExpanderHeader');
check('the Language expander opens its sub-section',
    await shown('langDropdownHeader'), true);
check('opening Language closes Theme (only one sub-section at a time)',
    await shown('themeDropdownHeader'), false);
check('the Language expander leaves the account menu open',
    await shown('accountDropdownHeader'), true);

// The mirror direction. Only one of these two was checked at first, and a
// mutation removing the closeLangDropdown() call from the Theme toggle survived
// the whole suite: "only one sub-section at a time" has to hold both ways round,
// so both ways round get asserted.
await page.click('#themeExpanderHeader');
check('opening Theme closes Language (the mirror direction)',
    await shown('langDropdownHeader'), false);
check('opening Theme reopens its own sub-section',
    await shown('themeDropdownHeader'), true);

// Pick a theme and prove it reached both the page and the terminals.
await page.evaluate(() => {
    window.__appliedToAll = 0;
    window.TerminalManager = window.TerminalManager || {};
    window.TerminalManager.applyThemeToAll = () => { window.__appliedToAll += 1; };
});
// Open the theme list from a known state rather than toggling blind. Toggling
// assumes it was closed, and once the mirror-direction check above left it open
// this click closed it instead -- then the option below was never clickable.
await page.evaluate(() => {
    document.getElementById('accountDropdownHeader').classList.add('show');
    document.getElementById('themeDropdownHeader').classList.add('show');
});
await page.click('#themeDropdownHeader .theme-option[data-theme-id="noir"]');

check('picking a theme sets data-theme on the body',
    await page.evaluate(() => document.body.getAttribute('data-theme')), 'noir');
check('picking a theme repaints the live terminals',
    await page.evaluate(() => window.__appliedToAll), 1);
check('picking a theme marks that option active',
    await page.evaluate(() => {
        const active = document.querySelectorAll('#themeDropdownHeader .theme-option.active');
        return [active.length, active[0]?.dataset.themeId];
    }), [1, 'noir']);
check('picking a theme closes the theme sub-section',
    await shown('themeDropdownHeader'), false);

// A theme with a real CSS block must actually change what is rendered, or the
// picker is relabelling nothing.
//
// Read backgroundImage, not backgroundColor. `body` is painted with
// `background: var(--bg-gradient)` (style.css), so backgroundColor computes to
// rgba(0,0,0,0) under EVERY theme -- comparing it reported "no difference" for a
// theme switch that was working correctly. Also check a token the terminals
// consume, since that is the value that has to travel for the palette to change.
const readTheme = theme => page.evaluate(t => {
    document.body.setAttribute('data-theme', t);
    const cs = getComputedStyle(document.body);
    return {
        /*
         * The app shell's page canvas is a COLOUR, not a gradient image, since
         * the frame correction of: deck.css paints body with
         * --deck-canvas (a color-mix derived from the theme) so the framed
         * product has ground distinct from its own fill. Reading
         * backgroundImage alone therefore returns 'none' in every theme and
         * would compare two identical values -- a vacuous pass on the previous
         * gradient and a false failure now. Compare whatever the theme actually
         * paints, image or colour.
         */
        paint: `${cs.backgroundImage}|${cs.backgroundColor}`,
        termBg: cs.getPropertyValue('--term-background').trim(),
        accent: cs.getPropertyValue('--accent-primary').trim(),
    };
}, theme);

const glass = await readTheme('glass');
const noir = await readTheme('noir');
check('the two themes paint different backgrounds', glass.paint !== noir.paint, true);
check('the two themes expose a different --term-background',
    glass.termBg !== noir.termBg && !!glass.termBg && !!noir.termBg, true);
check('the two themes expose a different --accent-primary',
    glass.accent !== noir.accent, true);

/*
 * The swatch dot for a light theme needs an outline or it disappears: a pale
 * colour on a pale dropdown reads as an empty gap where the other nine show a
 * dot. This file used to write `border:1px solid #666` inline for exactly that,
 * one fixed grey regardless of theme; it is now a class, so the border colour
 * comes from the stylesheet and follows the theme like everything else.
 *
 * Measured as a rendered border width, not as the presence of the class: a class
 * that no rule matches would still pass a class check while rendering nothing.
 */
{
    await page.evaluate(() => document.body.setAttribute('data-theme', 'glass'));
    const swatches = await page.evaluate(() => {
        const read = id => {
            const dot = document.querySelector(
                `#themeDropdownHeader .theme-option[data-theme-id="${id}"] .theme-color-dot`);
            const cs = getComputedStyle(dot);
            return {
                marked: dot.classList.contains('is-light'),
                width: Math.round(parseFloat(cs.borderTopWidth)),
                colour: cs.borderTopColor,
                // The dot's own colour is data from the THEMES list and stays
                // inline; only the outline moved to CSS.
                background: cs.backgroundColor,
            };
        };
        return { paper: read('paper'), noir: read('noir') };
    });

    check('the light theme swatch is marked', swatches.paper.marked, true);
    check('the light theme swatch renders an outline',
        swatches.paper.width >= 1, true);
    check('a dark theme swatch has none', swatches.noir.width, 0);
    check('the outline colour comes from the theme, not a fixed grey',
        swatches.paper.colour !== 'rgb(102, 102, 102)', true);
    check('the swatch still carries its own colour',
        swatches.paper.background !== swatches.noir.background, true);
    check('neither swatch lost its colour',
        [swatches.paper.background, swatches.noir.background]
            .every(c => c && c !== 'rgba(0, 0, 0, 0)'), true);
}

/*
 * The scrollback row is .account-item but NOT .account-action: it is a setting
 * you adjust in place, so touching it must not close the menu around the input
 * you are typing into.
 *
 * This case exists because a mutation escaped without it. Widening the close
 * condition from .account-action to .account-item -- the exact over-tidy edit
 * that shuts the menu on the way to a theme -- left every other check green,
 * because both expanders call stopPropagation() and so never reach the
 * dropdown's delegated handler at all. The scrollback row does reach it, which
 * makes it the one place the widened selector is observable.
 */
// Reopen explicitly: picking a theme above left the menu itself open but this
// must not depend on that. Assert the precondition rather than assume it -- the
// first version of this check clicked a hidden input and timed out.
await page.evaluate(
    () => document.getElementById('accountDropdownHeader').classList.add('show'));
check('the account menu is open before the in-place setting is touched',
    await shown('accountDropdownHeader'), true);
await page.click('#scrollbackInput');
check('touching the scrollback setting leaves the account menu open',
    await shown('accountDropdownHeader'), true);

await page.click('.main-content', { position: { x: 5, y: 5 } });
check('a click outside closes the account menu',
    await shown('accountDropdownHeader'), false);

check('no page errors', pageErrors, []);
await context.close();

// ---------------------------------------------------------------- mobile -----
/*
 * The mobile shell owns one non-modal More sheet. Settings is one destination
 * inside it and temporarily hosts the one real desktop account tree. This uses
 * the production DOM and handlers so focus order, movement and proxy clicks are
 * browser-observable rather than inferred from source.
 */
{
    const mobileContext = await browser.newContext({
        viewport: { width: 428, height: 926 },
        hasTouch: true,
        isMobile: true,
    });
    const mobilePage = await mobileContext.newPage();
    // Capture the EXACT MediaQueryList header-menus.js binds its media-exit
    // handler to, so the test can fire the real 'change' event a genuine
    // touch -> desktop capability transition would fire. Chromium cannot emulate
    // pointer/hover capability over CDP (only prefers-color-scheme), so the
    // faithful trigger is a MediaQueryListEvent dispatched at the app's own MQL.
    // Match the canonical query string exactly; every other query delegates
    // untouched to the native implementation.
    await mobilePage.addInitScript(() => {
        const realMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = query => {
            const mediaQueryList = realMatchMedia(query);
            // Capture the FIRST canonical MQL only. TerminalManager.isTouchShell()
            // calls matchMedia with the IDENTICAL query string (it reads the same
            // TOUCH_SHELL_QUERY constant header-menus.js reuses), and it runs on
            // every More/Settings interaction. An unconditional assignment
            // therefore replaces the reference with a fresh, listener-less MQL,
            // and the dispatch below reaches nobody. Instrumented on the real
            // suite: header-menus.js:55 is seq 1, then isTouchShell() produced
            // seq 2 and seq 3 before the dispatch, which fired at seq 3.
            // Entry 39: the canonical query gained the narrow-width
            // term. Owner correction changed it again, to a primary
            // capability conjunction. Matching the literal string meant this
            // interceptor silently stopped capturing anything the moment the
            // query legitimately changed, and the failure surfaced far away as
            // "canonical touch MediaQueryList was never captured". Recognise the
            // canonical query by its SHAPE instead: the one query that asks about
            // pointer capability and carries the narrow-width fallback.
            if (/\(pointer:\s*coarse\)/.test(query)
                && /\(max-width:\s*767px\)/.test(query)
                && !window.__mobileShellMedia) {
                window.__mobileShellMedia = mediaQueryList;
            }
            return mediaQueryList;
        };
    });
    const errors = [];
    mobilePage.on('pageerror', error => errors.push(String(error)));
    await mobilePage.goto(`${base}/`, { waitUntil: 'load' });
    await mobilePage.addStyleTag({
        content: '*,*::before,*::after{transition:none!important;animation:none!important}',
    });
    await mobilePage.evaluate(() => {
        document.getElementById('sessionBar').classList.remove('hidden');
        window.__accountTree = document.getElementById('accountDropdownHeader');
    });
    await mobilePage.waitForTimeout(80);

    /*
     * OWNER CORRECTION -- "mobile still exposes two menu entry
     * points". This block used to drive a TWO-VIEW sheet: an intermediate
     * #mobileMoreActions proxy list, and a #mobileSettingsView reached through a
     * Settings row and left through a Back row, which then hosted the real
     * account tree. That intermediate surface WAS the second menu, so the views
     * are gone and there is nothing to navigate between.
     *
     * Everything that was a genuine invariant is still asserted below, against
     * the single surface: the hidden/inert/aria-hidden trio, trigger ARIA
     * relationships, that the hosted tree is the SAME object moved (never
     * cloned), that it is restored after its marker, real Tab traversal, no
     * focus trap, Escape, outside click and session-bar hide.
     */
    const state = () => mobilePage.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const host = document.getElementById('mobileSettingsHost');
        const account = document.getElementById('accountDropdownHeader');
        return {
            sheet: {
                hidden: sheet.hidden,
                inert: sheet.hasAttribute('inert'),
                ariaHidden: sheet.getAttribute('aria-hidden'),
            },
            moreExpanded: document.getElementById('mobileMoreBtn')
                .getAttribute('aria-expanded'),
            // The sheet has exactly one container child: no competing views.
            sheetContainers: sheet.querySelectorAll(':scope > div').length,
            accountParent: account.parentElement.id || account.parentElement.className,
            accountInHost: account.parentElement === host,
            accountAfterMarker: document.getElementById('accountDropdownRestoreMarker')
                .nextElementSibling === account,
            accountSameObject: account === window.__accountTree,
            accountShown: account.classList.contains('show'),
            accountAriaHidden: account.getAttribute('aria-hidden'),
            focused: document.activeElement.id,
        };
    });

    const initial = await state();
    check('mobile: the one menu starts hidden, inert and aria-hidden',
        initial.sheet, { hidden: true, inert: true, ariaHidden: 'true' });
    check('mobile: the sheet hosts exactly one container, not two views',
        initial.sheetContainers, 1);
    check('mobile: Menu trigger has dialog relationships',
        await mobilePage.evaluate(() => {
            const button = document.getElementById('mobileMoreBtn');
            return {
                popup: button.getAttribute('aria-haspopup'),
                controls: button.getAttribute('aria-controls'),
                expanded: button.getAttribute('aria-expanded'),
            };
        }), { popup: 'dialog', controls: 'mobileMoreSheet', expanded: 'false' });
    check('mobile: the removed Settings navigation has no trigger left',
        await mobilePage.evaluate(() => ['mobileSettingsBtn', 'mobileSettingsBackBtn',
            'mobileMoreActions', 'mobileSettingsView']
            .filter(id => document.getElementById(id))), []);
    check('mobile: account tree starts immediately after its restoration marker',
        initial.accountAfterMarker, true);

    await mobilePage.click('#mobileMoreBtn');
    const opened = await state();
    check('mobile: opening exposes the sheet and synchronizes Menu ARIA',
        { sheet: opened.sheet, expanded: opened.moreExpanded },
        {
            sheet: { hidden: false, inert: false, ariaHidden: 'false' },
            expanded: 'true',
        });
    // The canonical tree arrives on the FIRST open: no Settings step.
    check('mobile: one open hosts the canonical account tree directly',
        { inHost: opened.accountInHost, shown: opened.accountShown,
          sameObject: opened.accountSameObject },
        { inHost: true, shown: true, sameObject: true });
    check('mobile: opening focuses a real control inside the one menu',
        await mobilePage.evaluate(() => {
            const el = document.activeElement;
            return !!el && document.getElementById('mobileMoreSheet').contains(el);
        }), true);

    /*
     * The shared popup contract uses the theme-aware chrome shadow token. Compare
     * resolved computed values so this catches the previous winning
     * `.mobile-more-sheet:not([hidden]) { box-shadow: var(--shadow-lg) }` rule
     * without hardcoding one theme's colour into the test.
     */
    const morePopup = await mobilePage.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const body = getComputedStyle(document.body);
        const probe = document.createElement('div');
        probe.style.boxShadow = body.getPropertyValue('--chrome-shadow-float').trim();
        document.body.appendChild(probe);
        const expectedShadow = getComputedStyle(probe).boxShadow;
        probe.remove();
        const rect = sheet.getBoundingClientRect();
        const style = getComputedStyle(sheet);
        return {
            shadow: style.boxShadow,
            expectedShadow,
            positive: rect.width > 0 && rect.height > 0,
            contained: rect.left >= 0 && rect.right <= innerWidth
                && rect.top >= 0 && rect.bottom <= innerHeight,
            /*
             * `.mobile-more-row` NEVER EXISTED in the product -- not in any
             * template, stylesheet or script. So this collected [] and the
             * `.every()` below passed on the empty set, in every run, whatever
             * the menu did. It is replaced by the real row selector, plus a
             * non-vacuity count so an empty collection fails instead of passing
             * (AGENTS.md section 2: a ceiling needs its floor beside it).
             */
            rowFloors: [...sheet.querySelectorAll('#accountDropdownHeader > .account-item')]
                .filter(row => row.getClientRects().length > 0)
                .map(row => Math.round(row.getBoundingClientRect().height)),
        };
    });
    check('mobile: More uses the resolved shared popup shadow',
        morePopup.shadow, morePopup.expectedShadow);
    check('mobile: More is a positive, viewport-contained surface',
        { positive: morePopup.positive, contained: morePopup.contained },
        { positive: true, contained: true });
    // Non-vacuity first: the tree hosts the three relocated globals plus its own
    // actions, so a real menu has many rows. Without this the floor check below
    // passes on an empty collection -- which is exactly what it did while it
    // queried a selector the product never had.
    check('mobile: the open menu really has rows to measure',
        morePopup.rowFloors.length >= 8, true);
    // 44px on touch, not the mockup's desktop 40 (deck.css scopes 40 to
    // pointer:fine; INF-4 / entry 26 gives touch the WCAG 2.5.5 floor).
    // The offending heights are printed by reporting them on failure.
    check('mobile: every visible menu row clears the 44px touch floor',
        morePopup.rowFloors.filter(height => height < 44), []);

    /*
     * ONE CONTINUOUS MENU, IDENTITY FIRST (owner correction, second
     * pass). This is the rendered ORDER assertion, read off the live DOM.
     *
     * The required order is:
     *   identity, Files, Command Library, Profiles, ...rest
     *
     * New Connection is NOT in the sheet since W14 item 7: the same
     * #newConnectionBtn node is the permanent first child of
     * .session-tabs-row in every viewport and never relocates here.
     *
     * Previously the relocated globals were SIBLINGS of the tree inside
     * #mobileSettingsHost, so the rendered order put them ahead of the identity
     * block and the account actions read as a detached block at the bottom. This
     * check would have passed on that shape -- it only ever asserted that the
     * globals came first, which was the defect. It now asserts the whole opening
     * sequence, in the tree, with identity leading.
     */
    const menuOrder = await mobilePage.evaluate(() => {
        const host = document.getElementById('mobileSettingsHost');
        const tree = document.getElementById('accountDropdownHeader');
        return {
            // One child: the tree. No sibling cards beside it.
            hostChildren: [...host.children].map(el => el.id || el.className),
            // The first five rows of the single tree, in painted order.
            opening: [...tree.children]
                .filter(el => el.getClientRects().length > 0)
                .slice(0, 5)
                .map(el => el.id || el.className),
        };
    });
    check('mobile: the host holds the tree alone -- no sibling cards',
        menuOrder.hostChildren, ['accountDropdownHeader']);
    check('mobile: the one menu opens identity, Files, Commands, Profiles',
        menuOrder.opening.slice(0, 4), ['account-menu-identity',
            'fileTransferBtn', 'commandLibraryBtn', 'manageProfilesBtn']);
    check('mobile: New Connection never enters the sheet (W14 item 7)',
        menuOrder.opening.includes('newConnectionBtn'), false);

    /*
     * The same order, traversed by real keyboard Tab, so it is reachability and
     * not just DOM order. The identity block is deliberately absent: it carries no
     * control (mockup line 129 draws it as presentation), so focus starts on the
     * first action.
     */
    const TAB_ORDER = ['fileTransferBtn',
        'commandLibraryBtn', 'manageProfilesBtn'];
    const tabOrder = [await mobilePage.evaluate(() => document.activeElement.id)];
    for (let index = 1; index < TAB_ORDER.length; index++) {
        await mobilePage.keyboard.press('Tab');
        tabOrder.push(await mobilePage.evaluate(() => document.activeElement.id));
    }
    check('mobile: real Tab order follows the one menu, identity-first',
        tabOrder, TAB_ORDER);

    // Every remaining row of the tree stays in the same tab ring: no navigation
    // step, and nothing stranded outside it. Reload is one of them -- it LIVES in
    // the tree (index.html:162) rather than being relocated beside it.
    let reachedReload = false;
    for (let i = 0; i < 12 && !reachedReload; i += 1) {
        await mobilePage.keyboard.press('Tab');
        reachedReload = await mobilePage.evaluate(() =>
            document.activeElement?.id === 'reloadPageBtn');
    }
    check('mobile: Tab continues through the tree to Reload, no Settings step',
        reachedReload, true);

    const settingsOpen = await state();
    check('mobile: the one real account tree is hosted in the single menu',
        {
            same: settingsOpen.accountSameObject,
            parent: settingsOpen.accountParent,
            shown: settingsOpen.accountShown,
            ariaHidden: settingsOpen.accountAriaHidden,
        }, {
            same: true,
            parent: 'mobileSettingsHost',
            shown: true,
            ariaHidden: 'false',
        });

    const hostedGeometry = await mobilePage.evaluate(() => {
        const account = document.getElementById('accountDropdownHeader');
        const host = document.getElementById('mobileSettingsHost');
        const style = getComputedStyle(account);
        const accountRect = account.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        return {
            position: style.position,
            animationName: style.animationName,
            transform: style.transform,
            inFlow: accountRect.top >= hostRect.top - 1,
            contained: accountRect.left >= hostRect.left - 1
                && accountRect.right <= hostRect.right + 1,
        };
    });
    check('mobile: hosted account tree uses static in-flow geometry', hostedGeometry, {
        position: 'static', animationName: 'none', transform: 'none',
        inFlow: true, contained: true,
    });

    /*
     * THE WIDTH-FALLBACK TOUCH SHELL (regression found, second pass).
     *
     * A MOUSE desktop resized below 768px enters the touch shell through the
     * `(max-width: 767px)` branch of TOUCH_SHELL_QUERY while still matching
     * `(pointer: fine)`. deck.css scopes the tree's 312px desktop CARD width to
     * that same `(pointer: fine)`, so on this one tier both rules applied to the
     * hosted node and the ID-specificity desktop rule won: measured at 700x900,
     * sheet 312 / tree 322, with all 13 rows overflowing the sheet's right edge.
     * Every capability-touch tier was unaffected (294px), which is exactly why
     * neither the phone nor the iPad passes could see it.
     *
     * This viewport is a fine pointer at a narrow width, so it reproduces the
     * combination. `contained` above is measured against the HOST; this measures
     * against the SHEET, which is the box that clips.
     */
    const narrowCtx = await browser.newContext({
        viewport: { width: 700, height: 900 }, hasTouch: false, isMobile: false,
    });
    const narrowPage = await narrowCtx.newPage();
    await narrowPage.goto(`${base}/`, { waitUntil: 'load' });
    await narrowPage.evaluate(() =>
        document.getElementById('sessionBar').classList.remove('hidden'));
    await narrowPage.waitForTimeout(80);
    await narrowPage.click('#mobileMoreBtn');
    await narrowPage.waitForTimeout(150);
    const narrowFit = await narrowPage.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const tree = document.getElementById('accountDropdownHeader');
        const s = sheet.getBoundingClientRect();
        const t = tree.getBoundingClientRect();
        return {
            isFinePointer: matchMedia('(pointer: fine)').matches,
            isTouchShell: matchMedia(TerminalManager.TOUCH_SHELL_QUERY).matches,
            treeWithinSheet: t.left >= s.left - 1 && t.right <= s.right + 1,
            overflowingRows: [...tree.children]
                .filter(el => el.getClientRects().length > 0)
                .filter(el => el.getBoundingClientRect().right > s.right + 1)
                .map(el => el.id || el.className),
        };
    });
    await narrowCtx.close();
    check('narrow desktop: it really is a fine pointer on the touch shell',
        [narrowFit.isFinePointer, narrowFit.isTouchShell], [true, true]);
    check('narrow desktop: the hosted tree fits inside the sheet',
        narrowFit.treeWithinSheet, true);
    check('narrow desktop: no menu row is clipped by the sheet',
        narrowFit.overflowingRows, []);
    // Profiles is the first entry of the canonical tree (mockup line 76, ahead of
    // Theme at line 77) and arrives with it, exactly once -- the deleted
    // #mobileProfilesBtn proxy was the duplicate.
    check('mobile: Profiles is present once, inside the hosted tree',
        await mobilePage.evaluate(() => {
            const all = document.querySelectorAll('#manageProfilesBtn');
            return {
                count: all.length,
                inTree: all.length === 1 && !!all[0].closest('#accountDropdownHeader'),
                proxy: !!document.getElementById('mobileProfilesBtn'),
            };
        }), { count: 1, inTree: true, proxy: false });

    // Escape owns focus restoration when the sheet itself is dismissed.
    await mobilePage.keyboard.press('Escape');
    const escaped = await state();
    check('mobile: Escape closes More and returns focus to its trigger',
        {
            sheet: escaped.sheet,
            expanded: escaped.moreExpanded,
            focused: escaped.focused,
        }, {
            sheet: { hidden: true, inert: true, ariaHidden: 'true' },
            expanded: 'false', focused: 'mobileMoreBtn',
        });

    // Reopening must re-host the SAME tree object and hand it back again: the
    // move/restore cycle has to survive repetition, which is what keeps the
    // desktop account button working after any number of touch opens.
    await mobilePage.click('#mobileMoreBtn');
    await mobilePage.keyboard.press('Escape');
    const settingsEscaped = await state();
    check('mobile: Escape restores account ownership and closes the one menu',
        {
            sheetHidden: settingsEscaped.sheet.hidden,
            accountAfterMarker: settingsEscaped.accountAfterMarker,
            accountShown: settingsEscaped.accountShown,
            sameObject: settingsEscaped.accountSameObject,
        }, {
            sheetHidden: true, accountAfterMarker: true,
            accountShown: false, sameObject: true,
        });

    await mobilePage.click('#mobileMoreBtn');
    await mobilePage.click('.workspace', { position: { x: 5, y: 5 } });
    const outside = await state();
    check('mobile: outside click dismisses and restores the hosted account tree',
        {
            sheetHidden: outside.sheet.hidden,
            accountAfterMarker: outside.accountAfterMarker,
            accountShown: outside.accountShown,
        }, { sheetHidden: true, accountAfterMarker: true, accountShown: false });

    await mobilePage.click('#mobileMoreBtn');
    await mobilePage.evaluate(() => document.getElementById('sessionBar')
        .classList.add('hidden'));
    await mobilePage.waitForTimeout(40);
    const barHidden = await state();
    check('mobile: hiding the session bar dismisses and restores account ownership',
        {
            sheetHidden: barHidden.sheet.hidden,
            accountAfterMarker: barHidden.accountAfterMarker,
        }, { sheetHidden: true, accountAfterMarker: true });
    await mobilePage.evaluate(() => document.getElementById('sessionBar')
        .classList.remove('hidden'));

    /*
     * The canonical globals are MOVED real controls now, not proxies, so the
     * contract changed from "the proxy dispatches exactly one click at the real
     * control" to the stronger "there is only one control, it is inside the one
     * menu, and clicking it fires its own listener exactly once".
     *
     * That is what removes the duplicate-action class of bug entirely: with a
     * proxy there were two nodes and a dispatch between them; now there is one
     * node. The sheet still closes afterwards, which is the delegated
     * sheet-level handler's only remaining job.
     *
     * W14 item 7: newConnectionBtn left this list -- the same node is the
     * permanent first child of .session-tabs-row in every viewport and never
     * enters the sheet. Its home is asserted separately below, on the strip.
     */
    const relocated = ['fileTransferBtn', 'commandLibraryBtn'];
    for (const target of relocated) {
        await mobilePage.evaluate(targetId => {
            window.__hitCounts = window.__hitCounts || {};
            window.__hitCounts[targetId] = 0;
            document.getElementById(targetId).addEventListener('click', () => {
                window.__hitCounts[targetId] += 1;
            });
        }, target);
        await mobilePage.click('#mobileMoreBtn');
        check(`mobile: ${target} is the one node, hosted in the one menu`,
            await mobilePage.evaluate(targetId => ({
                nodes: document.querySelectorAll(`#${targetId}`).length,
                inMenu: !!document.getElementById(targetId)
                    .closest('#mobileMoreSheet'),
            }), target), { nodes: 1, inMenu: true });
        await mobilePage.click(`#${target}`);
        check(`mobile: clicking ${target} fires once and closes the menu`,
            await mobilePage.evaluate(targetId => ({
                count: window.__hitCounts[targetId],
                sheetHidden: document.getElementById('mobileMoreSheet').hidden,
            }), target), { count: 1, sheetHidden: true });
        await mobilePage.evaluate(() => {
            document.querySelectorAll('.modal.show').forEach(modal => {
                modal.classList.remove('show');
                modal.setAttribute('aria-hidden', 'true');
            });
            document.getElementById('sftpFileManager')?.classList.remove('show');
        });
    }

    /*
     * W14 item 7 positive contract: the SAME #newConnectionBtn node is the
     * permanent FIRST CHILD of .session-tabs-row in every viewport -- it never
     * enters the sheet, it is icon-only, and one tap on it opens the connection
     * modal exactly once. This is the assertion the removed sheet entry above
     * must not be able to satisfy.
     */
    await mobilePage.evaluate(() => {
        window.__stripPlusHits = 0;
        document.getElementById('newConnectionBtn').addEventListener('click', () => {
            window.__stripPlusHits += 1;
        });
    });
    check('mobile: New Connection is the strip\'s first child, never the sheet\'s',
        await mobilePage.evaluate(() => {
            const btn = document.getElementById('newConnectionBtn');
            return {
                nodes: document.querySelectorAll('#newConnectionBtn').length,
                stripHome: !!btn?.parentElement
                    ?.classList.contains('session-tabs-row'),
                firstChild: btn?.parentElement?.firstElementChild === btn,
                inSheet: !!btn?.closest('#mobileMoreSheet'),
                labelHidden: btn
                    && getComputedStyle(btn.querySelector('.btn-label'))
                        .display === 'none',
            };
        }),
        { nodes: 1, stripHome: true, firstChild: true, inSheet: false,
            labelHidden: true });
    await mobilePage.click('#newConnectionBtn');
    check('mobile: one tap on the strip \'+\' opens the connection modal once',
        await mobilePage.evaluate(() => ({
            hits: window.__stripPlusHits,
            modalShown: document.getElementById('connectionModal')
                ?.classList.contains('show') === true,
        })), { hits: 1, modalShown: true });
    await mobilePage.evaluate(() => {
        document.querySelectorAll('.modal.show').forEach(modal => {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        });
    });


    // --- Piece F: Profiles is reachable in ONE tap from the canonical menu. ---
    // It arrives with the account tree, so there is no proxy and no Settings
    // step; the delegated sheet-level handler still closes the menu afterwards.
    await mobilePage.evaluate(() => {
        window.__profileHits = 0;
        document.getElementById('manageProfilesBtn')
            .addEventListener('click', () => { window.__profileHits += 1; });
    });
    check('mobile: exactly one Profiles control exists, and it is the real one',
        await mobilePage.evaluate(() => ({
            proxyNodes: document.querySelectorAll('#mobileProfilesBtn').length,
            realNodes: document.querySelectorAll('#manageProfilesBtn').length,
            inTree: !!document.getElementById('manageProfilesBtn')
                .closest('#accountDropdownHeader'),
        })),
        { proxyNodes: 0, realNodes: 1, inTree: true });

    await mobilePage.click('#mobileMoreBtn');
    check('mobile: Profiles is a visible 44px target in the one menu, no Settings step',
        await mobilePage.evaluate(() => {
            const el = document.getElementById('manageProfilesBtn');
            const r = el.getBoundingClientRect();
            return { visible: r.width > 0 && r.height > 0,
                     tall: Math.round(r.height) >= 44,
                     inMenu: !!el.closest('#mobileMoreSheet') };
        }), { visible: true, tall: true, inMenu: true });

    await mobilePage.click('#manageProfilesBtn');
    check('mobile: one tap from the menu opens the one real profile modal',
        await mobilePage.evaluate(() => ({
            hits: window.__profileHits,
            modalShown: document.getElementById('profileManagementModal')
                ?.classList.contains('show') === true,
            sheetHidden: document.getElementById('mobileMoreSheet').hidden,
        })), { hits: 1, modalShown: true, sheetHidden: true });
    await mobilePage.evaluate(() => {
        document.querySelectorAll('.modal.show').forEach(m => {
            m.classList.remove('show'); m.setAttribute('aria-hidden', 'true');
        });
    });

    // These two nodes retain app.js direct ownership; the menu owns dismissal only.
    await mobilePage.evaluate(() => {
        window.__mobileEmits = [];
        window.socket = {
            on: () => {}, off: () => {}, once: () => {},
            emit: (event, payload) => window.__mobileEmits.push({ event, payload }),
            io: { on: () => {} },
        };
        SessionManager.activeSessionId = 'owned-session';
        SessionManager.sessions['owned-session'] = {
            id: 'owned-session', useTmux: true, terminalId: 'none',
        };
        SessionManager.focusActivePane = () => {};
        // v5 section 3 lines 35-40 make Notes one of the six global/action-row
        // controls, so the docked #mobileNotepadBtn was removed and
        // #notepadOpenBtn is the single real Notes control (same retarget as
        // mobile_shell_trusted.mjs).
        window.__notepadNode = document.getElementById('notepadOpenBtn');
        window.__exitNode = document.getElementById('exitScrollBtn');
    });
    await mobilePage.click('#notepadOpenBtn');
    check('mobile: the docked Notepad control toggles the panel without opening More',
        await mobilePage.evaluate(() => ({
            sameNode: document.getElementById('notepadOpenBtn') === window.__notepadNode,
            nodes: document.querySelectorAll('#notepadOpenBtn').length,
            // The superseded docked control must not come back as a second
            // Notes surface (v5 line 45: no duplicate trigger).
            legacyNodes: document.querySelectorAll('#mobileNotepadBtn').length,
            open: document.getElementById('notepadPanel').classList.contains('mobile-open'),
            sheetHidden: document.getElementById('mobileMoreSheet').hidden,
        })), { sameNode: true, nodes: 1, legacyNodes: 0, open: true, sheetHidden: true });

    await mobilePage.evaluate(() => TerminalManager.setScrollState('owned-session', true));
    await mobilePage.click('#exitScrollBtn');
    check('mobile: the one contextual Exit-scroll control emits once and keeps app disabled state',
        await mobilePage.evaluate(() => ({
            sameNode: document.getElementById('exitScrollBtn') === window.__exitNode,
            nodes: document.querySelectorAll('#exitScrollBtn').length,
            legacyNodes: document.querySelectorAll('#mobileExitCopyModeBtn').length,
            emits: window.__mobileEmits.filter(item => item.event === 'tmux_exit_copy_mode'),
            disabled: document.getElementById('exitScrollBtn').disabled,
        })), {
            sameNode: true, nodes: 1, legacyNodes: 0,
            emits: [{ event: 'tmux_exit_copy_mode', payload: { session_id: 'owned-session' } }],
            disabled: true,
        });

    // Media-query exit is tested with active hosted state, then the restored tree
    // must continue to operate from the tablet/desktop account trigger.
    // capability model: a touch TABLET is still a touch shell, so
    // resizing phone -> tablet no longer fires the restore. Chromium cannot
    // emulate a pointer/hover capability transition over CDP (the feature is
    // ignored; only prefers-color-scheme emulates), so the genuine trigger is
    // fired on the exact MediaQueryList header-menus.js bound: dispatching the
    // 'change' event a real touch -> desktop transition would deliver.
    await mobilePage.evaluate(() => {
        document.getElementById('exitScrollBtn').disabled = false;
    });
    await mobilePage.click('#mobileMoreBtn');
    await mobilePage.evaluate(() => {
        const mediaQueryList = window.__mobileShellMedia;
        if (!mediaQueryList) {
            throw new Error('canonical touch MediaQueryList was never captured');
        }
        mediaQueryList.dispatchEvent(
            new MediaQueryListEvent('change', {
                media: mediaQueryList.media,
                matches: false,
            }));
    });
    await mobilePage.setViewportSize({ width: 768, height: 1024 });
    await mobilePage.waitForTimeout(80);
    const mediaExit = await state();
    check('desktop media exit closes mobile state and restores the account tree',
        {
            sheetHidden: mediaExit.sheet.hidden,
            moreExpanded: mediaExit.moreExpanded,
            accountAfterMarker: mediaExit.accountAfterMarker,
            accountShown: mediaExit.accountShown,
        }, {
            sheetHidden: true, moreExpanded: 'false',
            accountAfterMarker: true, accountShown: false,
        });
    /*
     * This context stays hasTouch:true, so 768x1024 is a touch TABLET -- the
     * capability model this suite already documents above ("a touch
     * TABLET is still a touch shell"). At that tier .header-buttons is
     * display:none by the (min-width:768px) and (pointer:coarse) block
     * (style.css:1848-1853), which exists so a touch tablet keeps v5 section
     * 3's TWO-row header instead of three. #accountBtnHeader is a descendant,
     * so it measures 0x0 and is correctly unclickable: the old block demanded a
     * fine-pointer-only surface at a coarse-pointer tier and hung for 30s on it.
     *
     * What the restoration must actually guarantee is that the account TREE
     * came home intact and still works from the surface this tier does expose.
     * Both are asserted -- the tree's identity/placement (which the click was
     * only a proxy for), and that the desktop trigger is genuinely hidden by an
     * ancestor rather than merely absent, so a regression that re-showed it as a
     * third header row still fails here.
     */
    const restored = await mobilePage.evaluate(() => {
        const btn = document.getElementById('accountBtnHeader');
        const r = btn.getBoundingClientRect();
        let hiddenBy = null;
        let el = btn;
        while (el && el !== document.documentElement) {
            if (getComputedStyle(el).display === 'none') {
                hiddenBy = el.className || el.id || el.tagName;
                break;
            }
            el = el.parentElement;
        }
        return {
            sameTree: document.getElementById('accountDropdownHeader') === window.__accountTree,
            afterMarker: document.getElementById('accountDropdownRestoreMarker')
                .nextElementSibling === document.getElementById('accountDropdownHeader'),
            triggerBox: Math.round(r.width) + 'x' + Math.round(r.height),
            hiddenBy,
        };
    });
    check('tablet: the restored account tree is the same object, back at its marker',
        { sameTree: restored.sameTree, afterMarker: restored.afterMarker },
        { sameTree: true, afterMarker: true });
    check('tablet: the fine-pointer account trigger stays hidden on a touch tablet',
        { box: restored.triggerBox, hiddenBy: restored.hiddenBy },
        { box: '0x0', hiddenBy: 'header-buttons' });

    check('mobile lifecycle has no page errors', errors, []);
    await mobileContext.close();
}

/*
 * DESKTOP -> TOUCH -> DESKTOP RESTORE.
 *
 * The section above fires the media exit on a touch TABLET, where the header
 * buttons stay display:none and the three relocated globals cannot be seen. This
 * one performs the full round trip on a fine-pointer mouse device: it starts at
 * 1440x900 (desktop), where the exact header home of each canonical global and
 * the account tree object are recorded BEFORE anything moves; it then shrinks to
 * 390x844, which makes the same device a touch shell through the
 * `(max-width: 767px)` fallback term of TOUCH_SHELL_QUERY; and it grows back.
 * Both transitions are delivered by the engine itself as MediaQueryList change
 * events -- nothing is emulated and no event is dispatched by hand -- so this
 * exercises the production sync path in both directions.
 *
 * It asserts the full cleanup contract on the way back: the three canonical
 * globals return to their EXACT recorded header parent and position, lose every
 * touch class and label state, expose only the desktop label, stay visible in
 * their desktop home, and still fire exactly once; and the account tree is back
 * after its marker.
 *
 * Label spans are flex items of their button, so CSS BLOCKIFIES their computed
 * display -- an active span reports `block`, not `inline`. The assertions
 * therefore ask "is it visible (display !== 'none')" and "is the inactive one
 * display:none", which is exactly the one-at-a-time contract.
 */
{
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        hasTouch: false, isMobile: false, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && !!window.TouchActionRow, null, { timeout: 15000 });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: false, tmux_session_name: null, via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
        document.getElementById('sessionBar').classList.remove('hidden');
    });
    await page.waitForTimeout(150);

    /*
     * W14 item 7: newConnectionBtn is NO LONGER a relocating global. It is the
     * permanent first child of .session-tabs-row in every viewport, so it stays
     * out of the relocation/restore assertions below; its strip home is asserted
     * separately. Only Files and Command Library still travel into the tree.
     */
    const GLOBALS = ['fileTransferBtn', 'commandLibraryBtn'];

    check('media exit: the device starts as the fine-pointer desktop shell',
        await page.evaluate(() => ({
            shell: matchMedia(TerminalManager.TOUCH_SHELL_QUERY).matches,
            pointer: matchMedia('(pointer: fine)').matches,
        })), { shell: false, pointer: true });

    /*
     * Record each global's EXACT desktop home while the page really is the
     * desktop shell and nothing has moved yet: parent, slot in that parent, and
     * next sibling. The restore at the end must land back on all three. The
     * tree object is captured here too, so the final assertion can prove the
     * SAME node came home.
     */
    await page.evaluate(ids => {
        window.__accountTree = document.getElementById('accountDropdownHeader');
        window.__preTouch = ids.map(id => {
            const el = document.getElementById(id);
            return {
                id,
                parentClass: el.parentElement.className,
                indexInParent: [...el.parentElement.children].indexOf(el),
                nextSiblingId: el.nextElementSibling
                    ? (el.nextElementSibling.id || `.${el.nextElementSibling.className}`)
                    : null,
            };
        });
    }, GLOBALS);
    check('media exit: on desktop the Command control shows only the desktop label',
        await page.evaluate(() => {
            const lib = document.getElementById('commandLibraryBtn');
            return {
                desktopNotNone: getComputedStyle(
                    lib.querySelector('.btn-label-desktop')).display !== 'none',
                menuNone: getComputedStyle(
                    lib.querySelector('.btn-label-menu')).display === 'none',
            };
        }), { desktopNotNone: true, menuNone: true });

    // THE FIRST TRANSITION: shrink to phone width -- the engine delivers the
    // touch-shell entry, and the globals relocate.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    check('media exit: at 390 the same mouse device is a touch shell',
        await page.evaluate(() => ({
            shell: matchMedia(TerminalManager.TOUCH_SHELL_QUERY).matches,
            pointer: matchMedia('(pointer: fine)').matches,
        })), { shell: true, pointer: true });

    // Hosted state: all three inside the tree, carrying the touch classes, and
    // the Command control showing its MENU label, not the header one.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(150);
    const hosted = await page.evaluate(ids => {
        const tree = document.getElementById('accountDropdownHeader');
        const lib = document.getElementById('commandLibraryBtn');
        return {
            inTree: ids.map(id => tree.contains(document.getElementById(id))),
            classes: ids.map(id => [...document.getElementById(id).classList]
                .filter(cls => cls === 'account-item' || cls === 'account-action')),
            menuShown: getComputedStyle(lib.querySelector('.btn-label-menu')).display !== 'none',
            desktopHidden: getComputedStyle(lib.querySelector('.btn-label-desktop')).display === 'none',
            visibleMenuText: lib.querySelector('.btn-label-menu').textContent.trim(),
            wantedMenuText: window.i18n.t('commands.library'),
        };
    }, GLOBALS);
    check('media exit: both relocating globals are hosted in the tree while on touch',
        hosted.inTree, [true, true]);
    check('media exit: both relocating globals carry the hosted row classes',
        hosted.classes, [['account-item', 'account-action'],
            ['account-item', 'account-action']]);
    check('media exit: hosted, the Command control exposes the MENU label',
        [hosted.menuShown, hosted.desktopHidden], [true, true]);
    check('media exit: the hosted label reads commands.library',
        hosted.visibleMenuText, hosted.wantedMenuText);
    check('media exit: New Connection stays on the strip while on touch (W14 item 7)',
        await page.evaluate(() => {
            const btn = document.getElementById('newConnectionBtn');
            return {
                stripHome: btn?.parentElement
                    ?.classList.contains('session-tabs-row'),
                firstChild: btn?.parentElement?.firstElementChild === btn,
                inTree: document.getElementById('accountDropdownHeader')
                    ?.contains(btn) ?? false,
            };
        }), { stripHome: true, firstChild: true, inTree: false });

    // THE RETURN TRANSITION: one resize, engine-delivered change events.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);

    check('media exit: back to the fine-pointer desktop shell',
        await page.evaluate(() => ({
            shell: matchMedia(TerminalManager.TOUCH_SHELL_QUERY).matches,
            pointer: matchMedia('(pointer: fine)').matches,
        })), { shell: false, pointer: true });

    const restored = await page.evaluate(ids => {
        const marker = document.getElementById('accountDropdownRestoreMarker');
        const tree = document.getElementById('accountDropdownHeader');
        const lib = document.getElementById('commandLibraryBtn');
        return {
            // Each global back at its recorded parent, slot and next sibling.
            homes: ids.map(id => {
                const el = document.getElementById(id);
                const pre = window.__preTouch.find(p => p.id === id);
                return {
                    id,
                    sameParent: el.parentElement.className === pre.parentClass,
                    sameSlot: [...el.parentElement.children].indexOf(el)
                        === pre.indexInParent,
                    sameNextSibling: (el.nextElementSibling
                        ? (el.nextElementSibling.id
                            || `.${el.nextElementSibling.className}`) : null)
                        === pre.nextSiblingId,
                };
            }),
            // Every touch class and label state is gone.
            touchLeftovers: ids.flatMap(id => [...document.getElementById(id).classList]
                .filter(cls => ['account-item', 'account-action',
                    'mobile-more-action', 'touch-primary-in-sheet',
                    'touch-action-btn'].includes(cls))),
            labelSpans: ids.map(id => document.getElementById(id)
                .querySelectorAll('[data-touch-secondary-label]').length),
            // The Command control shows the DESKTOP label again.
            desktopShown: getComputedStyle(lib.querySelector('.btn-label-desktop')).display !== 'none',
            menuHidden: getComputedStyle(lib.querySelector('.btn-label-menu')).display === 'none',
            visibleDesktopText: lib.querySelector('.btn-label-desktop').textContent.trim(),
            wantedDesktopText: window.i18n.t('commands.workspace'),
            // Still visible in the header.
            visible: ids.map(id => {
                const el = document.getElementById(id);
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && cs.display !== 'none'
                    && cs.visibility !== 'hidden';
            }),
            // The tree came home: same object, after its marker, closed, in the
            // account selector.
            treeSame: tree === window.__accountTree,
            treeAfterMarker: marker.nextElementSibling === tree,
            treeShown: tree.classList.contains('show'),
            treeParent: tree.parentElement.className,
            sheetHidden: document.getElementById('mobileMoreSheet').hidden,
        };
    }, GLOBALS);

    check('media exit: every global returns to its exact recorded header home',
        restored.homes.filter(h => !(h.sameParent && h.sameSlot && h.sameNextSibling)),
        []);
    check('media exit: no touch class or label state survives the restore',
        [restored.touchLeftovers, restored.labelSpans], [[], [0, 0]]);
    check('media exit: the Command control exposes only the desktop label',
        [restored.desktopShown, restored.menuHidden], [true, true]);
    check('media exit: the restored label reads commands.workspace',
        restored.visibleDesktopText, restored.wantedDesktopText);

    // ONE-SHOT AFTER THE RESTORE: each handler, counted, fires exactly once.
    // Clicking Files opens a modal; it is cleaned below so nothing else
    // observes an open modal. The counts cannot be affected by whatever the
    // handlers open.
    const oneShot = await page.evaluate(ids => {
        window.__exitHits = {};
        ids.forEach(id => {
            window.__exitHits[id] = 0;
            document.getElementById(id).addEventListener('click',
                () => { window.__exitHits[id] += 1; });
        });
        ids.forEach(id => document.getElementById(id).click());
        return window.__exitHits;
    }, GLOBALS);
    check('media exit: each restored control fires exactly once',
        oneShot, { fileTransferBtn: 1, commandLibraryBtn: 1 });

    check('media exit: both relocating globals are visible in their desktop home',
        restored.visible, [true, true]);

    /*
     * W14 item 7 desktop pin: after the full touch round-trip the SAME
     * newConnectionBtn node is still the first child of the strip -- never
     * relocated, icon-only, and its click opens the connection modal once.
     */
    await page.evaluate(() => {
        window.__exitStripHits = 0;
        document.getElementById('newConnectionBtn').addEventListener('click',
            () => { window.__exitStripHits += 1; });
    });
    check('media exit: New Connection is still the strip\'s first child on desktop',
        await page.evaluate(() => {
            const btn = document.getElementById('newConnectionBtn');
            const r = btn.getBoundingClientRect();
            return {
                nodes: document.querySelectorAll('#newConnectionBtn').length,
                stripHome: btn?.parentElement
                    ?.classList.contains('session-tabs-row'),
                firstChild: btn?.parentElement?.firstElementChild === btn,
                visible: r.width > 0 && r.height > 0,
                labelHidden: btn
                    && getComputedStyle(btn.querySelector('.btn-label'))
                        .display === 'none',
            };
        }),
        { nodes: 1, stripHome: true, firstChild: true, visible: true,
            labelHidden: true });
    await page.evaluate(() => document.getElementById('newConnectionBtn').click());
    check('media exit: the strip \'+\' opens the connection modal once on desktop',
        await page.evaluate(() => ({
            hits: window.__exitStripHits,
            modalShown: document.getElementById('connectionModal')
                ?.classList.contains('show') === true,
        })), { hits: 1, modalShown: true });
    check('media exit: the account tree returns after its marker, closed',
        { treeSame: restored.treeSame, treeAfterMarker: restored.treeAfterMarker,
          treeShown: restored.treeShown, sheetHidden: restored.sheetHidden },
        { treeSame: true, treeAfterMarker: true, treeShown: false, sheetHidden: true });
    check('media exit: the tree sits back in the account selector',
        restored.treeParent, 'account-selector');

    // Clean up the modals the one-shot clicks opened.
    await page.evaluate(() => {
        document.querySelectorAll('.modal.show').forEach(modal => {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        });
    });

    check('media exit has no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
