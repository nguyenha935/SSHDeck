/*
 * Switching sessions on a phone, and the split policy that goes with it.
 *
 * Two claims, both measured against the real templates/index.html:
 *
 *   1. A horizontal swipe ON THE TAB STRIP moves one session. Not on the
 *      terminal: the terminal already owns horizontal drag (tmux scrollback),
 *      long-press (select) and double-tap, all settled over fifteen rounds of
 *      real-hardware testing, and a swipe handler there would have to guess
 *      which gesture was meant. The strip has only its own scroll to
 *      disambiguate from, which the handler does by checking scrollLeft.
 *
 *   2. A phone is capped at TWO panes in either orientation (amendment v5
 *      line 91), while iPad is capped at four and desktop at six. Landscape
 *      926x428 is wider than 767px, so the capability/height branch must keep
 *      it in the phone cap rather than misclassify it as a tablet.
 *
 * Sessions are created by calling SessionManager's own methods, not by
 * hand-building tabs: the swipe reads tab order out of the DOM, so a fixture
 * that writes its own tabs would test the fixture. Everything below the socket
 * is stubbed; the markup and the stylesheet are production.
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
 * Drives a real touch sequence through CDP. page.touchscreen.tap() cannot
 * express a drag, and dispatching synthetic TouchEvents from page.evaluate
 * produces untrusted events -- which is exactly the class of false green this
 * project has been bitten by before (a suite that "passed" on events the
 * browser would never have delivered).
 */
async function swipe(page, selector, dx, dy) {
    const box = await page.locator(selector).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
    });
    // Intermediate moves: a single jump from start to end can be read as a
    // teleport rather than a drag by handlers that track movement.
    for (const t of [0.34, 0.67, 1]) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + dx * t, y: y + dy * t }],
        });
    }
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
    });
    await cdp.detach();
    await page.waitForTimeout(80);
}

/*
 * Stubs everything under SessionManager: a socket that records emits, a fake
 * TerminalManager, and i18n. SessionManager itself, the markup and the
 * stylesheet stay real -- those are what is under test.
 */
const STUBS = `
    window.__emits = [];
    const noop = () => {};
    window.socket = {
        on: noop, off: noop, once: noop,
        emit: (evt, payload) => window.__emits.push({ evt, payload }),
        io: { on: noop },
    };
    window.TerminalManager = {
        createTerminal: () => {},
        disposeTerminal: () => {},
        fitAllTerminals: () => {},
        fitTerminal: () => {},
        requestFit: () => {},
        cancelPendingFit: () => {},
        focusTerminal: () => {},
        applyThemeToAll: () => {},
        getTerminal: () => null,
        writeToTerminal: () => {},
    };
    window.i18n = { t: k => k, getLanguage: () => 'en', getLanguages: () => [],
                    setLanguage: noop, apply: noop };
`;

// ---------------------------------------------------------------- swipe -----
{
    const ctx = await browser.newContext({
        viewport: { width: 428, height: 926 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);

    console.log('\n--- swipe on the tab strip (428x926) ---');

    // Three live sessions through SessionManager's own path.
    const created = await page.evaluate(() => {
        SessionManager.init();
        ['alpha', 'beta', 'gamma'].forEach((host, i) => {
            const id = `s${i}`;
            SessionManager.sessions[id] = {
                session_id: id, host, username: 'u', port: 22,
                terminalId: `term-${id}`, connected: true, status: 'connected',
            };
            SessionManager.createSessionTab(id, host, 'u');
        });
        SessionManager.activeSessionId = 's0';
        return [...document.querySelectorAll('.session-tab')].map(t => t.id);
    });
    check('three tabs painted', created, ['tab-s0', 'tab-s1', 'tab-s2']);

    const active = () => page.evaluate(() => SessionManager.activeSessionId);
    // switchSession assigns to a pane, which needs a real terminal; stub the
    // assignment so the test measures which session was chosen, not the
    // plumbing that moves a terminal element into a pane.
    await page.evaluate(() => {
        SessionManager.assignSessionToPane = (id) => {
            SessionManager.activeSessionId = id;
        };
        SessionManager.setActivePane = () => {};
    });

    check('starts on the first session', await active(), 's0');

    /*
     * v5 amendment section 3 line 52: "Session row: Khong chua action, spacer
     * hay menu; session strip dung toan bo chieu ngang con lai." The old
     * 144px lifecycle-toolbar band that used to sit in this row is exactly what
     * that line forbids, and it is gone -- so the strip now spans the full row
     * and three chips (mockup line 243 floor: min-width 92px) fit without
     * overflowing. Swipe-to-switch is therefore reachable again on a phone,
     * which is the behaviour these cases must pin.
     *
     * The scroll-vs-swipe precedence itself is unchanged and still real: it is
     * exercised by the nine-tab block further down, where the strip genuinely
     * overflows and production's guard (strip.scrollLeft !== startScrollLeft)
     * must refuse to switch. So both halves of the guard stay covered -- the
     * non-overflowing half here, the overflowing half there.
     */
    const stripState = () => page.evaluate(() => {
        const s = document.getElementById('sessionTabs');
        return {
            active: SessionManager.activeSessionId,
            scrollLeft: Math.round(s.scrollLeft),
            overflows: s.scrollWidth > s.clientWidth,
        };
    });
    const seed = await stripState();
    check('the three-tab phone strip no longer overflows', seed.overflows, false);

    await swipe(page, '#sessionTabs', -120, 0);
    let sw = await stripState();
    check('swipe left on a fitting strip switches forward', sw.active, 's1');
    check('...without scrolling the strip', sw.scrollLeft, 0);

    await swipe(page, '#sessionTabs', -120, 0);
    check('a second swipe left advances again',
        (await stripState()).active, 's2');

    await swipe(page, '#sessionTabs', 120, 0);
    check('swipe right steps back',
        (await stripState()).active, 's1');

    // Back to the first session and the left edge, so the next cases start
    // from a known position rather than inheriting the drags above.
    await page.evaluate(() => {
        SessionManager.activeSessionId = 's0';
        document.getElementById('sessionTabs').scrollLeft = 0;
    });

    // Under one touch target: this has to remain a tap, and a tap on a tab
    // already means "switch to this one".
    await swipe(page, '#sessionTabs', -30, 0);
    check('a 30px drag is too short to switch', await active(), 's0');

    // A diagonal drag is someone scrolling past, not choosing a session.
    await swipe(page, '#sessionTabs', -120, 140);
    check('a mostly-vertical drag does not switch', await active(), 's0');

    /*
     * A candidate tab is an offer, not a session: it has no terminal, and
     * switchSession() sends it to the reconnect list. A swipe must skip it,
     * or swiping past one would open a list the user did not ask for.
     */
    await page.evaluate(() => {
        SessionManager.sessions.cand = {
            session_id: 'cand', host: 'ghost', username: 'u', port: 22,
            terminalId: 'term-cand', isPersistentCandidate: true,
        };
        SessionManager.createSessionTab('cand', 'ghost', 'u');
        SessionManager.activeSessionId = 's2';
    });
    const order = await page.evaluate(() => SessionManager.switchableSessionIds());
    check('candidates are not in the swipe order', order, ['s0', 's1', 's2']);

    await swipe(page, '#sessionTabs', -120, 0);
    check('swiping past a candidate does not select it', await active(), 's2');

    /*
     * With more tabs than fit, dragging the strip scrolls it -- and both
     * gestures are a horizontal drag over the same element, so the handler tells
     * them apart by whether scrollLeft moved. A mutation proved this needed its
     * own case: with only three tabs the strip no longer scrolls at all, so
     * removing the guard changed nothing and the check was vacuous.
     */
    await page.evaluate(() => {
        ['delta', 'epsilon', 'zeta', 'eta', 'theta'].forEach((host, i) => {
            const id = `x${i}`;
            SessionManager.sessions[id] = {
                session_id: id, host: `${host}.example.internal`, username: 'u',
                port: 22, terminalId: `term-${id}`, connected: true, status: 'connected',
            };
            SessionManager.createSessionTab(id, `${host}.example.internal`, 'u');
        });
        SessionManager.activeSessionId = 's0';
        const strip = document.getElementById('sessionTabs');
        strip.scrollLeft = 0;
    });
    const scrolls = await page.evaluate(() => {
        const s = document.getElementById('sessionTabs');
        return s.scrollWidth > s.clientWidth;
    });
    check('with nine tabs the strip scrolls', scrolls, true);

    await swipe(page, '#sessionTabs', -160, 0);
    const after = await page.evaluate(() => ({
        active: SessionManager.activeSessionId,
        scrollLeft: Math.round(document.getElementById('sessionTabs').scrollLeft),
    }));
    check('a drag that scrolls the strip does not switch', after.active, 's0');
    check('...because the strip actually scrolled', after.scrollLeft > 0, true);

    // The terminal must not have gained a session-switch gesture: its own
    // horizontal drag is tmux scrollback.
    await page.evaluate(() => { SessionManager.activeSessionId = 's0'; });
    const grid = await page.locator('#terminalGrid').boundingBox();
    if (grid && grid.height > 40) {
        await swipe(page, '#terminalGrid', -160, 0);
        check('swiping the terminal does not switch sessions', await active(), 's0');
    }

    check('no page errors', errors, []);
    await ctx.close();
}

// --------------------------------------- one real strip across orientation -----
{
    console.log('\n--- one real tab strip across orientation ---');
    const ctx = await browser.newContext({
        viewport: { width: 428, height: 926 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(200);

    const before = await page.evaluate(() => {
        SessionManager.init();
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].forEach((host, i) => {
            const id = `o${i}`;
            SessionManager.sessions[id] = {
                session_id: id, host: `${host}.example.internal`, username: 'u',
                port: 22, terminalId: `term-${id}`, connected: true, status: 'connected',
            };
            SessionManager.createSessionTab(id, `${host}.example.internal`, 'u');
        });
        SessionManager.activeSessionId = 'o2';
        document.getElementById('tab-o2').classList.add('active');
        const strip = document.getElementById('sessionTabs');
        strip.scrollLeft = Math.min(47, strip.scrollWidth - strip.clientWidth);
        const focused = document.getElementById('tab-o2');
        focused.tabIndex = 0;
        focused.focus();
        window.__orientationStrip = strip;
        window.__orientationTabs = [...strip.querySelectorAll('.session-tab')];
        window.__tabProbe = 0;
        window.__orientationTabs[1].addEventListener('orientation-probe', () => {
            window.__tabProbe += 1;
        });
        return {
            count: document.querySelectorAll('#sessionTabs').length,
            parent: strip.parentElement.className,
            afterButton: document.getElementById('newConnectionBtn')
                .nextElementSibling === strip,
            ids: window.__orientationTabs.map(tab => tab.id),
            active: strip.querySelector('.session-tab.active')?.id,
            focused: document.activeElement.id,
            scrollLeft: Math.round(strip.scrollLeft),
            swipeBound: strip.dataset.swipeBound,
        };
    });
    check('portrait: exactly one sessionTabs exists', before.count, 1);
    check('portrait: strip is in the production header row', before.parent, 'session-tabs-row');
    check("portrait: strip directly follows the '+'", before.afterButton, true);
    check('portrait: active tab is established', before.active, 'tab-o2');
    check('portrait: a tab descendant can hold focus', before.focused, 'tab-o2');

    await page.setViewportSize({ width: 926, height: 428 });
    await page.waitForTimeout(100);
    const landscape = await page.evaluate(savedScrollLeft => {
        const strip = document.getElementById('sessionTabs');
        const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
        return {
            count: document.querySelectorAll('#sessionTabs').length,
            sameStrip: strip === window.__orientationStrip,
            parent: strip.parentElement.className,
            sameTabs: [...strip.querySelectorAll('.session-tab')]
                .every((tab, index) => tab === window.__orientationTabs[index]),
            ids: [...strip.querySelectorAll('.session-tab')].map(tab => tab.id),
            active: strip.querySelector('.session-tab.active')?.id,
            focused: document.activeElement.id,
            scrollPreserved: Math.round(strip.scrollLeft)
                === Math.min(savedScrollLeft, Math.round(maxScroll)),
            swipeBound: strip.dataset.swipeBound,
            visible: strip.getBoundingClientRect().width > 0
                && strip.getBoundingClientRect().height > 0,
            scrolls: strip.scrollWidth > strip.clientWidth,
        };
    }, before.scrollLeft);
    // RESTATED (owner ruling): the strip no longer relocates into
    // the composer dock in phone landscape; the phone keeps the same two-row
    // header as portrait, so the SAME node stays in the SAME row.
    check('landscape: still exactly one sessionTabs', landscape.count, 1);
    check('landscape: the original strip object is still the strip', landscape.sameStrip, true);
    check('landscape: strip stays in the production header row',
        landscape.parent, 'session-tabs-row');
    check('landscape: all original tab objects survived', landscape.sameTabs, true);
    check('landscape: tab order survived', landscape.ids, before.ids);
    check('landscape: active state survived', landscape.active, before.active);
    check('landscape: focused descendant survived', landscape.focused, before.focused);
    check('landscape: scroll position is preserved within the new range',
        landscape.scrollPreserved, true);
    check('landscape: swipe binding was not duplicated',
        landscape.swipeBound, before.swipeBound);
    check('landscape: strip remains visible inline', landscape.visible, true);

    await page.evaluate(() => window.__orientationTabs[1]
        .dispatchEvent(new Event('orientation-probe')));
    check('a pre-move direct tab listener still fires exactly once',
        await page.evaluate(() => window.__tabProbe), 1);

    await page.setViewportSize({ width: 428, height: 926 });
    await page.waitForTimeout(100);
    const restored = await page.evaluate(() => {
        const strip = document.getElementById('sessionTabs');
        return {
            count: document.querySelectorAll('#sessionTabs').length,
            sameStrip: strip === window.__orientationStrip,
            afterButton: document.getElementById('newConnectionBtn')
                .nextElementSibling === strip,
            sameTabs: [...strip.querySelectorAll('.session-tab')]
                .every((tab, index) => tab === window.__orientationTabs[index]),
            ids: [...strip.querySelectorAll('.session-tab')].map(tab => tab.id),
            active: strip.querySelector('.session-tab.active')?.id,
            swipeBound: strip.dataset.swipeBound,
        };
    });
    check('restored portrait: still exactly one sessionTabs', restored.count, 1);
    check('restored portrait: original strip object returned', restored.sameStrip, true);
    check("restored portrait: strip directly follows the '+'",
        restored.afterButton, true);
    check('restored portrait: original tab objects returned', restored.sameTabs, true);
    check('restored portrait: tab order survived', restored.ids, before.ids);
    check('restored portrait: active state survived', restored.active, before.active);
    check('restored portrait: swipe binding remains singular',
        restored.swipeBound, before.swipeBound);
    await page.evaluate(() => window.__orientationTabs[1]
        .dispatchEvent(new Event('orientation-probe')));
    check('the same direct listener still fires once per click after restoration',
        await page.evaluate(() => window.__tabProbe), 2);
    check('orientation lifecycle has no page errors', errors, []);
    await ctx.close();
}

// ------------------------------------------------------------ tab strip -----
/*
 * Geometry follows the strip's real owner: the portrait and desktop header, or
 * the short-landscape bottom dock. Overflow is allowed only as native horizontal
 * scrolling; the strip must always retain usable inline width and stay visible.
 */
{
    const cases = [
        { label: 'phone', w: 428, h: 926, touch: true, tabH: 44 },
        // RESTATED (owner ruling): phone landscape keeps the
        // portrait touch header, so its chip is the coarse tier's 44px too.
        { label: 'landscape', w: 926, h: 428, touch: true, tabH: 44 },
        // B1: iPad coarse-pointer emulation only (no isMobile), matching the
        // approved coarse shell contract; the strip stays in the header tier.
        { label: 'ipad-portrait', w: 834, h: 1194, touch: true, isMobile: false, tabH: 44 },
        { label: 'ipad-landscape', w: 1194, h: 834, touch: true, isMobile: false, tabH: 44 },
        // S3 / spec 243: the fine-pointer chip is 30px of BORDER box, inside
        // spec 229's 40px row -- gaps 5.5 above / 4.5 below, matching the
        // mockup's own measured chip. The old 32 came from reading 30px as a
        // CONTENT height and adding the 1px borders, but box-sizing is
        // border-box globally (style.css:5), so 30 is the whole box.
        // Entry 21. Touch keeps 44 (WCAG 2.5.5) as the native tap
        // target, with the 30px pill painted by ::before.
        { label: 'laptop', w: 1280, h: 800, touch: false, tabH: 30 },
    ];
    console.log('\n--- tab strip geometry ---');
    for (const vp of cases) {
        const ctx = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            hasTouch: vp.touch,
            isMobile: vp.isMobile !== undefined ? vp.isMobile : vp.touch,
        });
        const page = await ctx.newPage();
        await page.addInitScript(STUBS);
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForTimeout(200);

        const m = await page.evaluate(() => {
            SessionManager.init();
            ['alpha', 'beta', 'gamma'].forEach((host, i) => {
                const id = `s${i}`;
                SessionManager.sessions[id] = {
                    session_id: id, host, username: 'u', port: 22,
                    terminalId: `term-${id}`, connected: true, status: 'connected',
                };
                SessionManager.createSessionTab(id, host, 'u');
            });
            const strip = document.getElementById('sessionTabs');
            const tab = document.getElementById('tab-s0');
            const owner = document.querySelector('.header');
            const tr = tab.getBoundingClientRect();
            const sr = strip.getBoundingClientRect();
            const or = owner.getBoundingClientRect();
            const legacyControls = tab.querySelectorAll(
                '.tab-edit, .tab-reconnect, .tab-close').length;
            // Hit-test the chip centre: computed style cannot see an overlaying
            // child or an ancestor clip, and a synthetic .click() would bypass
            // hit-testing entirely -- elementFromPoint is what catches the
            // target inversion that a centre tap once triggered.
            const cx = Math.round(tr.left + tr.width / 2);
            const cy = Math.round(tr.top + tr.height / 2);
            const hit = document.elementFromPoint(cx, cy);
            return {
                tabH: Math.round(tr.height),
                tabW: Math.round(tr.width),
                centreOwned: !!(hit && hit.closest
                    && hit.closest('.session-tab') === tab),
                legacyControls,
                insideOwner: tr.top >= or.top - 1 && tr.bottom <= or.bottom + 1,
                stripW: Math.round(sr.width),
                stripVisible: sr.width > 0 && sr.height > 0,
                scrolls: strip.scrollWidth > strip.clientWidth,
                overflowX: getComputedStyle(strip).overflowX,
                overflowY: getComputedStyle(strip).overflowY,
                owner: strip.parentElement.id || strip.parentElement.className,
            };
        });

        check(`${vp.label}: the tab is ${vp.tabH}px (spec 243/229)`, m.tabH, vp.tabH);
        // Mockup line 243: .tw5-session { min-width: 92px }. Without this floor
        // a chip can collapse to its label run, which is how the close control
        // came to own the chip centre in the first place.
        check(`${vp.label}: the chip meets the mockup 92px floor`,
            m.tabW >= 92, true);
        check(`${vp.label}: the tab stays inside its real owning band`,
            m.insideOwner, true);
        check(`${vp.label}: the strip remains visible with usable inline width`,
            m.stripVisible && m.stripW >= 120, true);
        check(`${vp.label}: the strip scrolls horizontally only`,
            `${m.overflowX}/${m.overflowY}`, 'auto/hidden');
        if (vp.label === 'landscape') {
            check('landscape: the strip stays in the header row',
                m.owner, 'session-tabs-row');
        }

        /*
         * v5 chips carry a status dot and a label only on every tier -- mockup
         * lines 87-89 and 150-152. All four actions live in the shared sheet
         * (line 184), so no fine/coarse branch may restore inline controls.
         */
        check(`${vp.label}: no legacy inline controls on the chip`,
            m.legacyControls, 0);
        check(`${vp.label}: the chip owns its own centre`,
            m.centreOwned, true);

        if (vp.label === 'landscape') {
            const overflow = await page.evaluate(() => {
                ['delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'].forEach((host, i) => {
                    const id = `wide${i}`;
                    SessionManager.sessions[id] = {
                        session_id: id, host: `${host}.example.internal`, username: 'u',
                        port: 22, terminalId: `term-${id}`, connected: true, status: 'connected',
                    };
                    SessionManager.createSessionTab(id, `${host}.example.internal`, 'u');
                });
                const strip = document.getElementById('sessionTabs');
                return strip.scrollWidth > strip.clientWidth;
            });
            check('landscape: an overflowing nine-tab strip scrolls horizontally',
                overflow, true);
        }

        await ctx.close();
    }
}

// ---------------- v3 F1: session selection must not summon the keyboard ----
/*
 * The mobile composer may only be focused by direct intentional interaction:
 * the user tapping #mobileInput, or the visible Send button refocusing it when
 * it was already active at press time. Every other caller funnels through
 * SessionManager.focusActivePane, so these cases drive the real selection
 * paths (tab click, strip swipe), the choke point itself, and the Send gate,
 * and assert that document.activeElement is never #mobileInput as a result.
 *
 * Connect, restore/reconnect, pane tap, gesture recovery, search close and
 * exit-scroll reach the same choke point (setActivePane -> focusActivePane or
 * focusActivePane directly); the funnel guarantee plus the static greps in
 * mobile_shell_trusted.mjs pin them here, with live confirmation left to the
 * owner's device QA (dated F1 deviation).
 */
{
    console.log('\n--- v3 F1: selection never focuses the composer (428x926) ---');
    const ctx = await browser.newContext({
        viewport: { width: 428, height: 926 },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(300);

    // Real focusActivePane, real setActivePane, real switchSession. The shared
    // stub lacks terminals/isTouchShell, which would make focusActivePane throw
    // before ever reaching the mobile branch -- the classic harness-stub trap.
    // Seed exactly the members it reads (the mobile no-op is gated on
    // isTouchShell since the capability model; isMobile is kept for any legacy
    // reader), with a spy terminal so a mobile
    // terminal-focus steal would be visible too.
    await page.evaluate(() => {
        const focusSpy = { focus: () => { window.__termFocus = (window.__termFocus || 0) + 1; } };
        window.TerminalManager.terminals = { f0: focusSpy, f1: focusSpy };
        window.TerminalManager.isMobile = () => true;
        window.TerminalManager.isTouchShell = () => true;
        window.TerminalManager.isDesktopShell = () => false;
        SessionManager.init();
        ['f0', 'f1'].forEach((id) => {
            SessionManager.sessions[id] = {
                session_id: id, host: id, username: 'u', port: 22,
                terminalId: `term-${id}`, connected: true, status: 'connected',
            };
            SessionManager.createSessionTab(id, id, 'u');
        });
        SessionManager.paneAssignments = ['f0', 'f1'];
        SessionManager.activePaneIndex = 0;
        SessionManager.activeSessionId = 'f0';
    });

    const focusState = () => page.evaluate(() => ({
        active: document.activeElement === document.body
            ? 'body' : document.activeElement.id,
        termFocus: window.__termFocus || 0,
    }));

    /*
     * Amendment section 3 line 56: "Khong tu focus composer va khong tu bat ban
     * phim khi chi chon session." The contract is about the COMPOSER and the
     * keyboard, not about nothing being focused. The chip is deliberately
     * focusable -- session-manager.js gives it role=tab + tabindex=0 so it can
     * be the selection anchor and announce aria-selected -- so focus landing on
     * the tapped chip is correct and required for AT. Asserting 'body' would
     * forbid the accessible behaviour the app is supposed to have.
     *
     * So these assert the real invariant: the composer never takes focus as a
     * side effect of selection. That is strictly tighter than the old check,
     * because 'body' also passed when focus sat on some other non-composer
     * element; this names the element that must never be focused.
     */
    const COMPOSER = 'mobileInput';
    const notComposer = (s) => s.active !== COMPOSER;

    check('baseline: nothing is focused', (await focusState()).active, 'body');

    // A) A tap on another session tab is selection, not typing intent.
    // Click the label, not the tab box: the edit/reconnect/close affordances
    // are children that stopPropagation, so a center-of-tab click can land on
    // one of them and never reach the tab's own switch listener.
    await page.click('#tab-f1 .tab-label');
    let s = await focusState();
    check('F1-A: a tab click switches the session',
        await page.evaluate(() => SessionManager.activeSessionId), 'f1');
    check('F1-A: ...and does not focus the composer', notComposer(s), true);
    check('F1-A: ...and focus rests on the chosen chip', s.active, 'tab-f1');
    check('F1-A: ...and does not take the terminal focus on mobile', s.termFocus, 0);

    // B) A strip swipe is the same selection semantics by another gesture.
    await page.evaluate(() => { SessionManager.activeSessionId = 'f0'; });
    await swipe(page, '#sessionTabs', -120, 0);
    s = await focusState();
    check('F1-B: a strip swipe moves the session',
        await page.evaluate(() => SessionManager.activeSessionId), 'f1');
    check('F1-B: ...and does not focus the composer', notComposer(s), true);

    // C1) The choke point itself: every other caller (connect, restore, pane
    // tap, gesture recovery, search close, exit-scroll) reaches focusActivePane
    // through setActivePane or directly, so a direct call pins the whole class.
    await page.evaluate(() => { SessionManager.activePaneIndex = 1; });
    await page.evaluate(() => SessionManager.focusActivePane());
    s = await focusState();
    check('F1-C1: focusActivePane never focuses the composer on mobile',
        notComposer(s), true);
    check('F1-C1: ...and never takes the terminal focus on mobile', s.termFocus, 0);

    // C2) The canonical path survives: direct intentional focus of the
    // composer (a user tap) must still work.
    await page.evaluate(() => document.getElementById('mobileInput').focus());
    check('F1-C2: a direct focus of #mobileInput still works',
        (await focusState()).active, 'mobileInput');

    // C3) Send refocuses only when the composer was already active at press.
    await page.click('#mobileSendBtn');
    check('F1-C3: Send keeps the keyboard up when the composer was active',
        (await focusState()).active, 'mobileInput');
    await page.evaluate(() => document.getElementById('mobileInput').blur());
    check('F1-C3: the composer released focus first', (await focusState()).active, 'body');
    await page.click('#mobileSendBtn');
    check('F1-C3: Send does not summon the keyboard when the composer was inactive',
        (await focusState()).active, 'body');

    check('F1: no page errors', errors, []);
    await ctx.close();
}

// Desktop guardrail: the same callers still focus the terminal on >=768px.
{
    console.log('\n--- v3 F1: desktop selection still focuses the terminal (1280x800) ---');
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: false,
        isMobile: false,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);

    await page.evaluate(() => {
        const focusSpy = { focus: () => { window.__termFocus = (window.__termFocus || 0) + 1; } };
        window.TerminalManager.terminals = { d0: focusSpy, d1: focusSpy };
        window.TerminalManager.isMobile = () => false;
        window.TerminalManager.isTouchShell = () => false;
        window.TerminalManager.isDesktopShell = () => true;
        SessionManager.init();
        ['d0', 'd1'].forEach((id) => {
            SessionManager.sessions[id] = {
                session_id: id, host: id, username: 'u', port: 22,
                terminalId: `term-${id}`, connected: true, status: 'connected',
            };
            SessionManager.createSessionTab(id, id, 'u');
        });
        SessionManager.paneAssignments = ['d0', 'd1'];
        SessionManager.activePaneIndex = 0;
        SessionManager.activeSessionId = 'd0';
    });

    await page.click('#tab-d1 .tab-label');
    check('F1-D: a desktop tab click still focuses the terminal',
        await page.evaluate(() => (window.__termFocus || 0) >= 1), true);
    check('F1-D: no page errors', errors, []);
    await ctx.close();
}

// -------------------------------------------------------- split policy -----
/*
 * Phone in both orientations, tablet in both, and a laptop. The landscape phone
 * is the case that matters: 926x428 is wider than 767px, so it reads as a tablet
 * to every width-keyed rule.
 */
/*
 * v5 section 4 replaces the four numbered .split-btn buttons with a single
 * Layout dropdown, and the canonical .split-controls group is now hidden +
 * aria-hidden + tabindex=-1 (templates/index.html): a programmatic behaviour
 * source, never a user surface. So the tappable layout surface to measure is
 * #layoutMenu's options, not .split-btn.
 *
 * Expected caps come from amendment line 91 -- "Giu cap: desktop 1-6 pane;
 * iPad 1-4; phone portrait/landscape 1-2" -- not from the implementation.
 * The old expectations also had tablet-portrait at 1-2, which line 91
 * contradicts: an iPad is 1-4 in either orientation.
 */
/*
 * Re-derived. A layout choice is now the (count, variant) PAIR, not
 * the count: v5 lines 102-110 define eight desktop choices of which two pairs
 * share a count ("2 dọc"/"2 ngang" and "4 pane"/"4 + chính"). The old
 * expectations listed counts only, so they could not distinguish the two
 * two-pane choices at all and read the second one as a duplicate.
 *
 * Expected sets still come from amendment line 91 for the CAP -- "Giu cap:
 * desktop 1-6 pane; iPad 1-4; phone portrait/landscape 1-2" -- and from mockup
 * lines 138-142 for which variants a touch tier offers: the touch menu is five
 * entries and has no "4 + chính". The caps below are unchanged from before
 * (phone max 2, iPad max 4, laptop max 6); only the identity of each entry is
 * now asserted, which is strictly stronger than the count-only check it
 * replaces.
 */
const SPLIT = [
    { label: 'phone-portrait', w: 428, h: 926, touch: true,
      choices: ['1:default', '2:default', '2:rows'] },
    { label: 'phone-landscape', w: 926, h: 428, touch: true,
      choices: ['1:default', '2:default', '2:rows'] },
    { label: 'tablet-portrait', w: 768, h: 1024, touch: true,
      choices: ['1:default', '2:default', '2:rows', '3:default', '4:default'] },
    { label: 'tablet-landscape', w: 1024, h: 768, touch: true,
      choices: ['1:default', '2:default', '2:rows', '3:default', '4:default'] },
    { label: 'laptop', w: 1280, h: 800, touch: false,
      choices: ['1:default', '2:default', '2:rows', '3:default',
                '4:default', '4:main', '5:default', '6:default'] },
];

console.log('\n--- split policy ---');

for (const vp of SPLIT) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.touch,
        isMobile: vp.touch,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(200);

    const m = await page.evaluate(() => {
        const tappable = (el) => {
            // An element inside a display: none group is not tappable even
            // though its own display is not none -- check the chain.
            let n = el;
            while (n && n !== document.body) {
                if (getComputedStyle(n).display === 'none') return false;
                n = n.parentElement;
            }
            return true;
        };
        // Open the real v5 surface the way a user does, so the options are
        // rendered by production's own renderLayoutMenu.
        const trigger = document.getElementById('layoutMenuBtn');
        if (trigger && tappable(trigger)) trigger.click();
        const shown = [...document.querySelectorAll('#layoutMenu .touch-layout-option')]
            .filter(tappable)
            .map(b => `${b.dataset.layout}:${b.dataset.variant || 'default'}`);
        // The superseded canonical group must stay out of the user surface
        // entirely (v5 section 4): not tappable, and not in the a11y tree.
        const legacy = [...document.querySelectorAll('.split-btn')].filter(tappable);
        const group = document.querySelector('.split-controls');
        return {
            shown,
            legacyTappable: legacy.length,
            legacyHidden: !!group && group.hasAttribute('hidden')
                && group.getAttribute('aria-hidden') === 'true',
        };
    });

    check(`${vp.label}: tappable split choices`, m.shown, vp.choices);
    // The cap is what amendment line 91 actually constrains, so assert it
    // directly rather than only implying it through the list above.
    check(`${vp.label}: no choice exceeds the device cap`,
        Math.max(...m.shown.map(s => parseInt(s, 10))),
        Math.max(...vp.choices.map(s => parseInt(s, 10))));
    check(`${vp.label}: the superseded numbered buttons are not tappable`,
        m.legacyTappable, 0);
    check(`${vp.label}: the canonical group stays out of the a11y tree`,
        m.legacyHidden, true);
    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
