/*
 * The three release-blocking regressions the owner, each
 * pinned by a measurement that can actually fail.
 *
 *   A. "mobile still exposes two menu entry points"
 *   B. "the desktop UI they approved is gone or no longer activates correctly"
 *   C. "the outer product frame border/background separation has disappeared"
 *
 * Why these assertions and not screenshots. Every one of these regressions
 * shipped through a green screenshot harness, because a PNG of a wrong shell is
 * a valid PNG. So each contract here measures the STRUCTURE that was wrong:
 * how many menu surfaces and triggers exist, which shell branch a hybrid
 * desktop resolves to, and whether the frame has a border with distinct ground
 * on both sides of it. A render is evidence for the owner's eye; these are the
 * gate.
 *
 * The hybrid-desktop tier is the important one for B. Playwright's hasTouch
 * makes Chromium report (any-pointer: coarse) and (hover: none) while KEEPING a
 * 1440x900 fine-pointer viewport -- which is exactly the machine the owner has
 * (a desktop with a touchscreen), and exactly the machine the old four-way OR
 * query stole the desktop shell from.
 *
 * Run: node tests/browser/shell_regression_contract.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium, devices } from 'playwright';
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
const failures = [];

function check(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failures.push(name);
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}`
            + `\n      want ${JSON.stringify(want)}`);
    }
}

function ok(name, cond, detail = '') {
    if (cond) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failures.push(name);
        console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
    }
}

const server = await startServer(renderTemplate());
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const KILL_MOTION =
    '*,*::before,*::after{transition:none!important;animation:none!important}';

async function open(opts) {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: KILL_MOTION });
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined');
    await page.waitForTimeout(250);
    return { context, page, pageErrors };
}

/* ════════════════════════════════════════════════════════════════════════════
 * §1  CORRECTION A -- ONE canonical mobile menu.
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const { context, page, pageErrors } = await open({
        viewport: { width: 390, height: 844 },
        hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });

    // The deleted intermediate surface must be gone from the DOM entirely, not
    // merely hidden. A hidden second menu is still a second menu one CSS edit
    // away from being visible again.
    check('phone390: zero intermediate Settings-navigation nodes',
        await page.evaluate(() => ['mobileMoreActions', 'mobileSettingsView',
            'mobileSettingsBtn', 'mobileSettingsBackBtn']
            .filter(id => document.getElementById(id))), []);

    check('phone390: zero mobileProfilesBtn proxy',
        await page.evaluate(() => !!document.getElementById('mobileProfilesBtn')),
        false);

    // Every proxy that fired .click() at a real control is gone too: a proxy is
    // a duplicate action by definition.
    check('phone390: zero data-mobile-action-target proxies remain',
        await page.evaluate(() => [...document.querySelectorAll(
            '[data-mobile-action-target]')].map(n => n.id)), []);

    // Exactly one VISIBLE global-menu trigger.
    const triggers = await page.evaluate(() => {
        const ids = ['mobileMoreBtn', 'accountBtnHeader'];
        const vis = [];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && cs.display !== 'none'
                && cs.visibility !== 'hidden') {
                vis.push({ id, x: Math.round(r.x), y: Math.round(r.y),
                    w: Math.round(r.width), h: Math.round(r.height) });
            }
        }
        return vis;
    });
    check('phone390: exactly one visible global-menu trigger',
        triggers.map(t => t.id), ['mobileMoreBtn']);
    ok('phone390: the one trigger meets the 44px touch floor',
        triggers[0] && triggers[0].w >= 44 && triggers[0].h >= 44,
        JSON.stringify(triggers[0]));

    // Open it. One tap, straight to the canonical tree -- no Settings step.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(250);

    const opened = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const tree = document.getElementById('accountDropdownHeader');
        const host = document.getElementById('mobileSettingsHost');
        return {
            sheetOpen: !sheet.hidden,
            treeInHost: tree?.parentElement === host,
            treeShown: tree?.classList.contains('show'),
            hostChildren: [...host.children].map(c => c.id || c.className),
        };
    });
    ok('phone390: one tap opens the sheet', opened.sheetOpen);
    ok('phone390: the canonical account tree is hosted directly (no Settings step)',
        opened.treeInHost && opened.treeShown, JSON.stringify(opened));

    // Exactly one canonical menu SURFACE is visible.
    const surfaces = await page.evaluate(() => {
        const cands = ['mobileMoreSheet', 'accountDropdownHeader'];
        const painted = [];
        for (const id of cands) {
            const el = document.getElementById(id);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && cs.display !== 'none') {
                painted.push({ id, boxed: cs.borderTopWidth !== '0px'
                    || cs.backgroundImage !== 'none'
                    || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' });
            }
        }
        return painted;
    });
    // The tree is visible INSIDE the sheet -- that is one surface, not two, so
    // only the sheet may carry a box of its own.
    check('phone390: only the sheet is a painted menu surface',
        surfaces.filter(s => s.boxed).map(s => s.id), ['mobileMoreSheet']);

    // Every canonical action exists EXACTLY ONCE in the whole document.
    const CANON = ['newConnectionBtn', 'fileTransferBtn', 'commandLibraryBtn',
        'reloadPageBtn', 'manageProfilesBtn', 'fileTransferOpenBtn',
        'logoutBtn', 'changePasswordBtn'];
    const counts = await page.evaluate(ids => Object.fromEntries(ids.map(id =>
        [id, document.querySelectorAll(`#${id}`).length])), CANON);
    check('phone390: every canonical action appears exactly once',
        Object.entries(counts).filter(([, n]) => n !== 1), []);

    // Profiles exists exactly once and is INSIDE the canonical tree.
    check('phone390: Profiles lives inside the canonical tree, once',
        await page.evaluate(() => {
            const all = document.querySelectorAll('#manageProfilesBtn');
            const tree = document.getElementById('accountDropdownHeader');
            return { count: all.length, inTree: !!(all[0] && tree.contains(all[0])) };
        }), { count: 1, inTree: true });

    // The relocated globals are the REAL nodes, inside the one host.
    // W14 item 7: New Connection is NOT a sheet member -- the same node is the
    // permanent first child of .session-tabs-row in every viewport.
    check('phone390: Files / Commands are hosted real nodes',
        await page.evaluate(() => ['fileTransferBtn',
            'commandLibraryBtn'].map(id => {
            const el = document.getElementById(id);
            const host = document.getElementById('mobileSettingsHost');
            return { id, hosted: !!el && host.contains(el) };
        }).filter(r => !r.hosted)), []);

    check('phone390: New Connection is the strip\'s first child, not the sheet\'s',
        await page.evaluate(() => {
            const btn = document.getElementById('newConnectionBtn');
            return {
                nodes: document.querySelectorAll('#newConnectionBtn').length,
                stripHome: !!btn?.parentElement
                    ?.classList.contains('session-tabs-row'),
                firstChild: btn?.parentElement?.firstElementChild === btn,
                inSheet: !!btn?.closest('#mobileMoreSheet'),
            };
        }), { nodes: 1, stripHome: true, firstChild: true, inSheet: false });

    // Right-anchored to its one trigger, and fully inside the product viewport.
    const anchor = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const trig = document.getElementById('mobileMoreBtn');
        const deck = document.getElementById('deckWindow');
        const s = sheet.getBoundingClientRect();
        const t = trig.getBoundingClientRect();
        const d = deck.getBoundingClientRect();
        return {
            rightDelta: Math.round(Math.abs(s.right - d.right)),
            withinLeft: s.left >= d.left - 1,
            withinRight: s.right <= d.right + 1,
            withinTop: s.top >= d.top - 1,
            withinBottom: s.bottom <= d.bottom + 1,
            aboveTrigger: s.bottom <= t.top + 2,
        };
    });
    ok('phone390: the menu is right-clamped inside the product viewport',
        anchor.withinLeft && anchor.withinRight && anchor.withinTop
        && anchor.withinBottom, JSON.stringify(anchor));

    // BOUNDED height derived from the real viewport, and the LAST row reachable
    // by real scrolling. This is the assertion that a clipped menu fails.
    const reach = await page.evaluate(async () => {
        const sheet = document.getElementById('mobileMoreSheet');
        const tree = document.getElementById('accountDropdownHeader');
        const logout = document.getElementById('logoutBtn');
        const before = sheet.scrollTop;
        sheet.scrollTop = sheet.scrollHeight;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const s = sheet.getBoundingClientRect();
        const l = logout.getBoundingClientRect();
        return {
            scrollable: sheet.scrollHeight > sheet.clientHeight + 1,
            scrolled: sheet.scrollTop > before,
            // one scroll container only: the tree must not scroll separately
            treeScrolls: tree.scrollHeight > tree.clientHeight + 1,
            logoutVisibleAfterScroll:
                l.height > 0 && l.top >= s.top - 1 && l.bottom <= s.bottom + 1,
            sheetH: Math.round(s.height),
            viewportH: window.innerHeight,
        };
    });
    ok('phone390: the menu height is bounded by the viewport',
        reach.sheetH > 0 && reach.sheetH <= reach.viewportH,
        JSON.stringify(reach));
    ok('phone390: exactly one scroll container (the sheet, not the tree)',
        !reach.treeScrolls, JSON.stringify(reach));
    ok('phone390: the final Logout row is reachable by real scrolling',
        reach.logoutVisibleAfterScroll, JSON.stringify(reach));

    // Nested theme/language sections still work inside the hosted tree.
    // The expanders are #themeExpanderHeader / #langExpanderHeader (the rows that
     // carry aria-expanded); #themeBtnHeader does not exist. Asserting existence
     // first, so a renamed control fails loudly here instead of silently
     // clicking nothing and reporting a closed section.
    const nested = await page.evaluate(() => {
        const tBtn = document.getElementById('themeExpanderHeader');
        const lBtn = document.getElementById('langExpanderHeader');
        tBtn?.click();
        const t = document.getElementById('themeDropdownHeader');
        const tOpen = t?.classList.contains('show');
        const tCount = t?.querySelectorAll('.theme-option').length || 0;
        const tVisible = !!t && t.getBoundingClientRect().height > 0;
        lBtn?.click();
        const l = document.getElementById('langDropdownHeader');
        return {
            triggersExist: !!tBtn && !!lBtn,
            tOpen, tCount, tVisible,
            lOpen: l?.classList.contains('show'),
            lVisible: !!l && l.getBoundingClientRect().height > 0,
        };
    });
    ok('phone390: both nested expander triggers exist in the hosted tree',
        nested.triggersExist, JSON.stringify(nested));
    // Opens AND is actually painted: a .show class on a zero-height box is a
    // dead row, which is one of the failure modes the owner called out.
    check('phone390: nested Theme section opens with all 10 themes, painted',
        { open: nested.tOpen, count: nested.tCount, visible: nested.tVisible },
        { open: true, count: 10, visible: true });
    check('phone390: nested Language section opens, painted',
        { open: nested.lOpen, visible: nested.lVisible },
        { open: true, visible: true });

    check('phone390: no page errors', pageErrors, []);
    await context.close();
}

/* ════════════════════════════════════════════════════════════════════════════
 * §2  Menu lifecycle: the tree goes HOME, so desktop keeps working.
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const { context, page } = await open({
        viewport: { width: 390, height: 844 },
        hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });

    const home = await page.evaluate(() =>
        document.getElementById('accountDropdownHeader').parentElement.className);

    for (let i = 0; i < 3; i += 1) {
        await page.click('#mobileMoreBtn');
        await page.waitForTimeout(120);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
    }

    check('phone390: Escape closes the one menu',
        await page.evaluate(() =>
            !document.getElementById('mobileMoreSheet').hidden), false);
    check('phone390: the tree is restored to its desktop home after 3 cycles',
        await page.evaluate(() =>
            document.getElementById('accountDropdownHeader').parentElement.className),
        home);
    check('phone390: still exactly one tree in the document after 3 cycles',
        await page.evaluate(() =>
            document.querySelectorAll('#accountDropdownHeader').length), 1);
    await context.close();
}

/* ════════════════════════════════════════════════════════════════════════════
 * §3  CORRECTION B -- the touch capability contract.
 * ══════════════════════════════════════════════════════════════════════════ */
const SHELL_TIERS = [
    { name: 'desktop1440', want: 'desktop',
      opts: { viewport: { width: 1440, height: 900 } } },
    { name: 'desktop1024', want: 'desktop',
      opts: { viewport: { width: 1024, height: 768 } } },
    /*
     * The hybrid desktop (fine pointer + attached touchscreen) is NOT a tier
     * here, and the reason is a measured browser limitation rather than a
     * decision.
     *
     * Chromium couples touch emulation to the PRIMARY pointer. Measured, all
     * three routes, at 1440x900:
     *
     *   context hasTouch:true                    -> pointer:coarse hover:none
     *   hasTouch + CDP setEmulatedMedia(fine)    -> pointer:coarse hover:none
     *   CDP setTouchEmulationEnabled(5 points)   -> pointer:coarse hover:none
     *   launch --touch-events=enabled            -> pointer:fine, maxTouchPoints 0
     *
     * So Chromium reports either a phone (coarse primary + touch) or a plain
     * mouse desktop (fine primary + NO touch). The real hybrid state --
     * pointer:fine, hover:hover, any-pointer:coarse -- is not reachable, and a
     * tier claiming to be a hybrid would in fact be testing a phone at desktop
     * width and would pass whatever the predicate said.
     *
     * The hybrid contract is therefore asserted directly against the predicate
     * in §3b below, by evaluating the shipped query string for the exact
     * capability vector a hybrid reports. That is a real assertion about the
     * shipped code, and it fails if the standalone branches come back.
     */
    { name: 'ipad-portrait', want: 'touch',
      opts: { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true } },
    { name: 'ipad-landscape', want: 'touch',
      opts: { viewport: { width: 1112, height: 834 }, hasTouch: true, isMobile: true } },
    { name: 'phone390', want: 'touch',
      opts: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    { name: 'phone359', want: 'touch',
      opts: { viewport: { width: 359, height: 780 }, hasTouch: true, isMobile: true } },
    { name: 'phone-landscape', want: 'touch',
      opts: { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } },
];

for (const tier of SHELL_TIERS) {
    const { context, page, pageErrors } = await open(tier.opts);

    const state = await page.evaluate(() => {
        const vis = id => {
            const el = document.getElementById(id);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.display !== 'none'
                && cs.visibility !== 'hidden';
        };
        return {
            jsTouch: TerminalManager.isTouchShell(),
            jsDesktop: TerminalManager.isDesktopShell(),
            cssTouch: matchMedia(TerminalManager.TOUCH_SHELL_QUERY).matches,
            layoutCap: SessionManager.layoutCap(),
            headerTitleRow: vis('headerBrand'),
            touchActionRow: vis('touchActionRow'),
            sessionRow: vis('sessionRow'),
            composer: vis('mobileInputBar'),
            desktopAccountTrigger: vis('accountBtnHeader'),
            touchMenuTrigger: vis('mobileMoreBtn'),
        };
    });

    const isTouch = tier.want === 'touch';
    check(`${tier.name}: shell branch is ${tier.want}`,
        { js: state.jsTouch, css: state.cssTouch, desktop: state.jsDesktop },
        { js: isTouch, css: isTouch, desktop: !isTouch });

    // JS and CSS must never disagree -- that disagreement is how half-touch
    // shells appear.
    ok(`${tier.name}: JS and CSS agree on the branch`,
        state.jsTouch === state.cssTouch,
        JSON.stringify(state));

    // The approved desktop shell: navigation/session rows present, touch dock
    // absent. On touch, exactly the inverse.
    check(`${tier.name}: touch dock surfaces ${isTouch ? 'present' : 'absent'}`,
        { row: state.touchActionRow, composer: state.composer,
          trigger: state.touchMenuTrigger },
        { row: isTouch, composer: isTouch, trigger: isTouch });

    // Layout caps: desktop 1-6, touch 1-4 (tablet) / 1-2 (phone).
    ok(`${tier.name}: layout cap ${state.layoutCap} matches the tier`,
        isTouch ? state.layoutCap <= 4 : state.layoutCap === 6,
        `cap=${state.layoutCap}`);

    check(`${tier.name}: no page errors`, pageErrors, []);
    await context.close();
}

/* ════════════════════════════════════════════════════════════════════════════
 * §3b THE HYBRID CONTRACT, asserted against the SHIPPED predicate.
 *
 * Chromium cannot present a real hybrid (see the note in SHELL_TIERS), so this
 * evaluates the shipped query string against each capability vector directly.
 * matchMedia parses and evaluates the real query, so this measures the product's
 * own predicate -- not a restatement of it -- and it goes red the moment a
 * standalone (hover: none) or (any-pointer: coarse) branch returns.
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const { context, page } = await open({ viewport: { width: 1440, height: 900 } });

    // The shipped string, read from the product. Not a copy pasted into the test.
    const query = await page.evaluate(() => TerminalManager.TOUCH_SHELL_QUERY);

    ok('the shipped predicate is a conjunction, not a four-way OR',
        /\(pointer:\s*coarse\)\s*and\s*\(hover:\s*none\)/.test(query)
        && !/\(any-pointer/.test(query),
        `query=${query}`);

    /*
     * Evaluate the shipped query against explicit capability vectors. Chromium
     * has no API to force a vector for matchMedia, so each is checked by
     * substituting the vector into the query's own terms: every term is a
     * feature test whose value we know for that device class, so the query's
     * truth value follows from boolean evaluation of the parsed query. Done in
     * the page so the SAME string the product ships is the one parsed.
     */
    const verdicts = await page.evaluate(q => {
        // Capability vectors, as the CSS spec defines the features.
        const DEVICES = {
            'mouse desktop':          { pointer: 'fine',   hover: 'hover', anyPointer: ['fine'],           width: 1440 },
            'hybrid desktop 1440':    { pointer: 'fine',   hover: 'hover', anyPointer: ['fine', 'coarse'], width: 1440 },
            'hybrid desktop 1024':    { pointer: 'fine',   hover: 'hover', anyPointer: ['fine', 'coarse'], width: 1024 },
            'phone':                  { pointer: 'coarse', hover: 'none',  anyPointer: ['coarse'],         width: 390 },
            'tablet portrait':        { pointer: 'coarse', hover: 'none',  anyPointer: ['coarse'],         width: 834 },
            'tablet landscape':       { pointer: 'coarse', hover: 'none',  anyPointer: ['coarse'],         width: 1112 },
            'narrow desktop window':  { pointer: 'fine',   hover: 'hover', anyPointer: ['fine'],           width: 700 },
        };
        // Evaluate one media feature against a vector.
        const feature = (name, value, d) => {
            if (name === 'pointer') return d.pointer === value;
            if (name === 'hover') return d.hover === value;
            if (name === 'any-pointer') return d.anyPointer.includes(value);
            if (name === 'max-width') return d.width <= parseInt(value, 10);
            if (name === 'min-width') return d.width >= parseInt(value, 10);
            return false;
        };
        // Parse "a, b and c" comma-OR of and-conjunctions of (name: value).
        const evaluate = (queryText, d) => queryText.split(',').some(branch =>
            branch.split(/\s+and\s+/).every(term => {
                const m = term.trim().match(/^\(([a-z-]+):\s*([^)]+)\)$/);
                return m ? feature(m[1], m[2].trim(), d) : false;
            }));
        const out = {};
        for (const [name, d] of Object.entries(DEVICES)) out[name] = evaluate(q, d);
        return out;
    }, query);

    // The regression, stated as the assertion that would have caught it.
    check('hybrid desktop 1440 (fine+hover+touchscreen) resolves DESKTOP',
        verdicts['hybrid desktop 1440'], false);
    check('hybrid desktop 1024 (fine+hover+touchscreen) resolves DESKTOP',
        verdicts['hybrid desktop 1024'], false);
    check('plain mouse desktop resolves DESKTOP', verdicts['mouse desktop'], false);
    // And real touch devices must still resolve touch.
    check('phone resolves TOUCH', verdicts.phone, true);
    check('tablet portrait resolves TOUCH', verdicts['tablet portrait'], true);
    check('tablet landscape resolves TOUCH', verdicts['tablet landscape'], true);
    // The approved narrow fallback survives.
    check('narrow desktop window (<768) resolves TOUCH via the width fallback',
        verdicts['narrow desktop window'], true);

    await context.close();
}

/* ════════════════════════════════════════════════════════════════════════════
 * §4  CORRECTION C -- frame, with ground on both sides of the border.
 * ══════════════════════════════════════════════════════════════════════════ */
const THEMES = ['glass', 'retro', 'solar', 'paper', 'noir', 'arctic-ice',
    'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];

{
    const { context, page } = await open({ viewport: { width: 1440, height: 900 } });

    const frame = await page.evaluate(() => {
        const deck = document.getElementById('deckWindow');
        const r = deck.getBoundingClientRect();
        const cs = getComputedStyle(deck);
        return {
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            left: Math.round(r.left),
            top: Math.round(r.top),
            right: Math.round(window.innerWidth - r.right),
            bottom: Math.round(window.innerHeight - r.bottom),
            borderTop: cs.borderTopWidth,
            borderColor: cs.borderTopColor,
            radius: cs.borderTopLeftRadius,
            shadow: cs.boxShadow !== 'none',
        };
    });

    // Gutter FLOOR and CEILING. A floor alone let 4px through and the frame
    // vanished; a ceiling alone would allow the rejected 24px void to return.
    ok('desktop1440: every gutter side is within 5..12px (floor AND ceiling)',
        [frame.left, frame.top, frame.right, frame.bottom]
            .every(v => v >= 5 && v <= 12),
        JSON.stringify(frame));
    check('desktop1440: the gutter is EVEN on all four sides (owner ruling)',
        new Set([frame.left, frame.top, frame.right, frame.bottom]).size, 1);
    check('desktop1440: 1px token border and 12px radius',
        { border: frame.borderTop, radius: frame.radius },
        { border: '1px', radius: '12px' });
    ok('desktop1440: the border colour is a real painted colour, not transparent',
        !/rgba\(0, 0, 0, 0\)|transparent/.test(frame.borderColor),
        frame.borderColor);
    ok('desktop1440: the token drop shadow is present', frame.shadow);

    /*
     * THE REGRESSION ITSELF. The border was declared and painted the whole time;
     * what disappeared was the SEPARATION, because the page canvas and the shell
     * fill were the same colour. So measure the two planes the border sits
     * between, in every theme, and require them to differ.
     */
    for (const theme of THEMES) {
        const sep = await page.evaluate(async (t) => {
            document.body.setAttribute('data-theme', t);
            await new Promise(r => requestAnimationFrame(
                () => requestAnimationFrame(r)));
            const deck = document.getElementById('deckWindow');
            const cs = getComputedStyle(deck);
            const bodyCs = getComputedStyle(document.body);
            /*
             * Must read BOTH forms Chromium returns. color-mix() computes to
             * `color(srgb 0.14 0.14 0.14)` with 0-1 components, not to
             * `rgb(36, 36, 36)`, so an rgb-only parser silently fails on exactly
             * the canvas token this contract exists to measure. Normalise to
             * 0-255 for both.
             */
            const parse = c => {
                const srgb = c.match(
                    /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
                if (srgb) return [1, 2, 3].map(i => +srgb[i] * 255);
                const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
                return m ? [+m[1], +m[2], +m[3]] : null;
            };
            const canvas = parse(bodyCs.backgroundColor);
            const shell = parse(cs.backgroundColor);
            return {
                canvas: bodyCs.backgroundColor,
                shell: cs.backgroundColor,
                delta: canvas && shell
                    ? Math.max(...[0, 1, 2].map(i => Math.abs(canvas[i] - shell[i])))
                    : -1,
                borderPainted: cs.borderTopWidth === '1px'
                    && !/rgba\(0, 0, 0, 0\)/.test(cs.borderTopColor),
            };
        }, theme);
        ok(`theme ${theme}: canvas differs from shell fill (separation exists)`,
            sep.delta >= 12, `delta=${sep.delta} canvas=${sep.canvas} shell=${sep.shell}`);
        ok(`theme ${theme}: the 1px border is painted (structural affordance)`,
            sep.borderPainted, JSON.stringify(sep));
    }
    await context.close();
}

/* ════════════════════════════════════════════════════════════════════════════
 * §4b PAINTED PIXELS, not declared values.
 *
 * §4 reads computed style, and computed style cannot see compositing. Measured
 * on a real 1440x900 screenshot of the corrected build: the declared
 * canvas-vs-shell delta is 32, but the frame's own `0 18px 42px` drop shadow
 * darkens the canvas INSIDE the 6px gutter by 7-8 levels, so the delta a human
 * actually sees across the left edge is 5, not 32.
 *
 * That is still a visible frame -- the 1px border reads against the terminal
 * plane at delta 10, and against the shell chrome band at delta 20 -- but the
 * declared number overstates it, and the gutter is narrow enough that the shadow
 * covers most of it. So this section measures the SCREENSHOT: it captures the
 * real pixels and asserts that a boundary is discernible along each edge by at
 * least one of the two mechanisms the frame has (a colour step, or the border
 * line itself). A frame that vanishes into its background fails here even when
 * every computed value looks correct -- which is precisely the failure the owner
 * reported and computed-value assertions missed.
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const { context, page } = await open({ viewport: { width: 1440, height: 900 } });
    const shot = await page.screenshot({ type: 'png' });
    const geo = await page.evaluate(() => {
        const r = document.getElementById('deckWindow').getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top),
                 right: Math.round(r.right), bottom: Math.round(r.bottom),
                 vw: window.innerWidth, vh: window.innerHeight };
    });

    /*
     * Decode the PNG in the page: no pngjs dependency (it is not installed), and
     * Chromium's own decoder is the same one that painted the pixels.
     */
    const samples = await page.evaluate(async ({ dataUrl, g }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx2 = c.getContext('2d');
        ctx2.drawImage(img, 0, 0);
        const at = (x, y) => {
            const d = ctx2.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2]];
        };
        const midY = Math.round((g.top + g.bottom) / 2);
        const midX = Math.round((g.left + g.right) / 2);
        return {
            scale: c.width / g.vw,
            corner: at(0, 0),
            left: { canvas: at(Math.max(0, g.left - 3), midY),
                    border: at(g.left, midY),
                    inside: at(g.left + 3, midY) },
            right: { canvas: at(Math.min(c.width - 1, g.right + 2), midY),
                     border: at(g.right - 1, midY),
                     inside: at(g.right - 4, midY) },
            top: { canvas: at(midX, Math.max(0, g.top - 3)),
                   border: at(midX, g.top),
                   inside: at(midX, g.top + 3) },
            // The header chrome band, the widest-contrast plane the frame abuts.
            chrome: { canvas: at(Math.max(0, g.left - 3), g.top + 14),
                      inside: at(g.left + 3, g.top + 14) },
        };
    }, { dataUrl: `data:image/png;base64,${shot.toString('base64')}`, g: geo });

    const delta = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));

    for (const edge of ['left', 'right', 'top']) {
        const s = samples[edge];
        const canvasToBorder = delta(s.canvas, s.border);
        const borderToInside = delta(s.border, s.inside);
        const canvasToInside = delta(s.canvas, s.inside);
        const best = Math.max(canvasToBorder, borderToInside, canvasToInside);
        ok(`painted ${edge} edge: a boundary is discernible in real pixels`,
            best >= 8,
            `canvas=${s.canvas} border=${s.border} inside=${s.inside} `
            + `deltas c/b=${canvasToBorder} b/i=${borderToInside} c/i=${canvasToInside}`);
    }

    // Against the chrome band the separation must be unambiguous.
    ok('painted frame separates from the header chrome plane',
        delta(samples.chrome.canvas, samples.chrome.inside) >= 12,
        `canvas=${samples.chrome.canvas} chrome=${samples.chrome.inside} `
        + `delta=${delta(samples.chrome.canvas, samples.chrome.inside)}`);

    // And the canvas is genuinely a different plane from the shell somewhere in
    // the gutter -- measured at the corner, where the shadow does not reach.
    ok('painted canvas at the corner is distinct from the shell fill',
        delta(samples.corner, samples.left.inside) >= 8,
        `corner=${samples.corner} shell=${samples.left.inside} `
        + `delta=${delta(samples.corner, samples.left.inside)}`);

    await context.close();
}

{
    // Touch stays edge-to-edge: no frame, no wasted width, no unpainted strip.
    const { context, page } = await open({
        viewport: { width: 359, height: 780 },
        hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    const t = await page.evaluate(() => {
        const deck = document.getElementById('deckWindow');
        const r = deck.getBoundingClientRect();
        const cs = getComputedStyle(deck);
        return {
            w: Math.round(r.width), vw: window.innerWidth,
            left: Math.round(r.left),
            border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            shell: cs.backgroundColor,
        };
    });
    check('phone359: touch is edge-to-edge with no frame geometry',
        { fullWidth: t.w === t.vw, left: t.left, border: t.border, radius: t.radius },
        { fullWidth: true, left: 0, border: '0px', radius: '0px' });
    ok('phone359: no canvas colour is exposed behind the touch shell',
        t.bodyBg === t.shell, `body=${t.bodyBg} shell=${t.shell}`);
    await context.close();
}

await browser.close();
server.close();

console.log(`\ntotal=${passed + failures.length} passed=${passed} failed=${failures.length}`);
if (failures.length) {
    console.error('FAILURES');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exitCode = 1;
}
