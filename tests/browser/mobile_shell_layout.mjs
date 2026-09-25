/*
 * Final adaptive mobile-shell geometry against the real index.html and CSS.
 *
 * The phone contract has two independent dimensions: a 66px functional dock
 * (composer 44 + overhead 4 + the W14 item 3 status band 17 = 65, rounded up
 * by the 1px dock border to 66) and any OS bottom safe inset outside it. Both
 * are measured here, first with no inset and then with a simulated 34px inset.
 * The one real session strip, the production controls, and a real xterm
 * instance are used throughout.
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

function atMost(label, actual, limit, unit = '') {
    if (typeof actual === 'number' && actual <= limit) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} <= ${limit}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected <= ${limit}${unit}`
            + `\n        actual   ${actual}${unit}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
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
    window.socket = { on: noop, off: noop, once: noop, emit: noop, io: { on: noop } };
    window.TerminalManager = {
        createTerminal: noop, disposeTerminal: noop, fitAllTerminals: noop,
        fitTerminal: noop, focusTerminal: noop, applyThemeToAll: noop,
        requestFit: noop, cancelPendingFit: noop,
        getTerminal: () => null, writeToTerminal: noop,
    };
`;

/*
 * Chrome expectations are DERIVED FROM THE DESIGN TOKENS at runtime, not
 * hardcoded. `dock` and `strip` below are read from the page via
 * expectedChrome() and cross-checked against the measured boxes, so:
 *
 *   - changing a token moves the expectation with it (no stale constant), and
 *   - a layout regression that does NOT come from a token change still fails,
 *     because the measured box must equal the token-derived value.
 *
 * That is what keeps this a real bound. The previous `dock: 66` was a literal
 * pinning the PRE-v5 dock, which still carried the Menu and Notepad buttons;
 * v5 section 3 moved both into the touch action row, so the dock is now the
 * composer band alone. Measured 48px at all seven touch viewports.
 */
const VIEWPORTS = [
    // Every touch tier uses the same top-first structure: global actions,
    // session strip, workspace, then the composer dock.
    { label: 'phone-small', w: 359, h: 800, touch: true, top: 88, bottomHeader: false },
    { label: 'phone', w: 428, h: 926, touch: true, top: 88, bottomHeader: false },
    { label: 'phone-360', w: 360, h: 800, touch: true, top: 88, bottomHeader: false },
    { label: 'phone-390', w: 390, h: 844, touch: true, top: 88, bottomHeader: false },
    // RESTATED (owner ruling): phone landscape keeps the same
    // two-row touch header as portrait. The v5 40px compact band, and the
    // relocation of the strip and the brand into the composer dock, are
    // retired -- "điện thoại quá bé để chuyển như vậy". The 926x428 tier
    // is therefore measured exactly like the >=768 touch tiers.
    { label: 'landscape', w: 926, h: 428, touch: true, top: 88, bottomHeader: false },
    // capability model (D3): touch tablets get the functional dock.
    // On >=768px the 88px two-tier header (44+44) stays visible at the TOP and
    // the session tabs remain in it, so the dock is IN FLOW at the bottom.
    { label: 'tablet', w: 768, h: 1024, touch: true, top: 88, bottomHeader: false },
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true, top: 88, bottomHeader: false },
    { label: 'ipad-landscape', w: 1194, h: 834, touch: true, top: 88, bottomHeader: false },
    // Pure fine-pointer desktop: must NOT get the dock (D3 leaves it desktop).
    // Mockup lines 228-229 specify the desktop pair literally: .tw5-global-row
    // 44px + .tw5-workspace-row 40px = 84px, both border-box. The old 88 copied
    // the TOUCH pair (44+44, mockup lines 324-325) into desktop and was stale.
    { label: 'laptop', w: 1280, h: 800, touch: false, top: 84, bottomHeader: false },
    { label: 'desktop', w: 1920, h: 1080, touch: false, top: 84, bottomHeader: false },
];

/*
 * Read the shell's own tokens and compute what the dock and its functional
 * band MUST measure. px() rejects anything that is not a resolved pixel
 * length, so an unresolved calc() or a missing token fails loudly instead of
 * silently becoming NaN and comparing equal to nothing.
 */
async function expectedChrome(page) {
    return page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const px = (name) => {
            const raw = cs.getPropertyValue(name).trim();
            const value = parseFloat(raw);
            if (!/^-?[\d.]+px$/.test(raw) || Number.isNaN(value)) {
                throw new Error(`token ${name} is not a resolved px length: "${raw}"`);
            }
            return value;
        };
        const content = px('--composer-content-height');
        const overhead = px('--composer-band-overhead');
        // W14 item 3: the mini status band charges its own height term to the
        // dock. On short-landscape tiers the band is re-hidden and the term is
        // zeroed, so the derived expectation stays right for every tier.
        const statusBand = px('--mobile-status-band');
        const safeBottom = px('--shell-safe-bottom');
        const dock = getComputedStyle(document.getElementById('sessionBar'));
        return {
            // The dock's functional band: the composer row, its padding, and
            // the mini status band.
            functional: content + overhead + statusBand,
            // Short landscape adds asymmetric outer padding around the same 48px
            // functional token. The real-page probe measured 2px top + 1px bottom
            // at both 844x390 and 926x428. Other tiers are border-box 48px and do
            // not add this padding to the outer rect, so callers apply it only in
            // the short-landscape band instead of globally.
            // The safe-area inset is delivered THROUGH padding-bottom, so it must
            // be excluded here or the inset section counts it twice (measured:
            // expected 119 vs actual 85 at 926x428 under a simulated 34px inset,
            // because padding-bottom read 35px instead of the base 1px).
            dockPadding: parseFloat(dock.paddingTop)
                + Math.max(0, parseFloat(dock.paddingBottom) - safeBottom),
            dockSeparator: parseFloat(dock.borderTopWidth),
            // Its outer box adds the OS-reserved inset BELOW the band, never
            // inside it -- that is the invariant the inset section proves.
            dockOuter: content + overhead + statusBand + safeBottom,
            safeBottom,
            strip: px('--shell-strip'),
            touchActions: px('--shell-touch-actions'),
        };
    });
}

async function installTerminal(page) {
    await page.evaluate(() => {
        const grid = document.getElementById('terminalGrid');
        grid.innerHTML = '';
        const pane = document.createElement('div');
        pane.className = 'terminal-pane';
        pane.dataset.paneIndex = '0';
        const host = document.createElement('div');
        host.className = 'terminal-wrapper';
        host.id = 'geometryTerminal';
        pane.appendChild(host);
        grid.appendChild(pane);

        const terminal = new Terminal({ fontSize: 14, lineHeight: 1 });
        const fit = new FitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();
        window.__geometryTerminal = terminal;
        window.__geometryFit = fit;
    });
}

async function seedSessionTabs(page) {
    await page.evaluate(() => {
        const strips = document.querySelectorAll('#sessionTabs');
        if (strips.length !== 1) {
            throw new Error(`expected one real #sessionTabs, found ${strips.length}`);
        }

        const strip = strips[0];
        if (strip.childElementCount > 0) {
            return;
        }

        strip.insertAdjacentHTML('beforeend', `
            <div class="session-tab active" data-session-id="geometry-one"
                 role="tab" aria-selected="true" tabindex="0">
                <span class="status-dot connected" aria-hidden="true"></span>
                <span class="tab-label">
                    <strong class="tab-host-name">host-one.example</strong>
                    <small class="tab-user-name">geometry</small>
                </span>
            </div>
            <div class="session-tab" data-session-id="geometry-two"
                 role="tab" aria-selected="false" tabindex="0">
                <span class="status-dot connected" aria-hidden="true"></span>
                <span class="tab-label">
                    <strong class="tab-host-name">host-two.example</strong>
                    <small class="tab-user-name">geometry</small>
                </span>
            </div>
        `);
    });
}

async function measure(page) {
    return page.evaluate(() => {
        window.__geometryFit.fit();
        const roundedBox = element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const visible = style.display !== 'none' && style.visibility !== 'hidden'
                && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            return {
                visible,
                left: Math.round(rect.left), right: Math.round(rect.right),
                top: Math.round(rect.top), bottom: Math.round(rect.bottom),
                width: Math.round(rect.width), height: Math.round(rect.height),
            };
        };
        const deckElement = document.getElementById('deckWindow');
        const deck = roundedBox(deckElement);
        const deckStyle = getComputedStyle(deckElement);
        const deckContentTop = deck.top
            + Math.round(parseFloat(deckStyle.borderTopWidth) || 0);
        const deckContentBottom = deck.bottom
            - Math.round(parseFloat(deckStyle.borderBottomWidth) || 0);
        const header = roundedBox(document.querySelector('.header'));
        const dockElement = document.getElementById('sessionBar');
        const dock = roundedBox(dockElement);
        // The status bar is chrome below the workspace and before the dock, and
        // is present on desktop too. Both bands participate in the product-frame
        // accounting and are measured independently rather than assumed.
        const statusBar = roundedBox(document.getElementById('statusBar'));
        const grid = roundedBox(document.getElementById('terminalGrid'));
        const terminalHost = roundedBox(document.getElementById('geometryTerminal'));
        const input = roundedBox(document.getElementById('mobileInput'));
        const tabsElement = document.getElementById('sessionTabs');
        const tabs = roundedBox(tabsElement);
        const safeBottom = parseFloat(getComputedStyle(document.documentElement)
            .getPropertyValue('--shell-safe-bottom')) || 0;
        const functionalTop = dock.top;
        const functionalBottom = dock.visible ? dock.bottom - Math.round(safeBottom) : dock.bottom;
        // v5 section 3 makes Menu toàn cục action 6 of the TOP action row, and
        // forbids a menu button in the composer ("Không tạo nút menu thứ hai ở
        // session row hoặc composer"). #mobileMoreBtn is therefore no longer a
        // dock control -- touch-action-row.js relocates it into
        // #touchActionRow. The dock is the shared composer plus its two
        // controls. That the Menu button is NOT here is asserted separately by
        // desktop_shell.mjs's one-menu-button check.
        const dockControls = ['mobileInput', 'mobileKeypadBtn', 'mobileSendBtn']
            .map(id => ({ id, ...roundedBox(document.getElementById(id)) }));

        const selector = 'button, a[href], input, textarea, select, [role="button"], [tabindex]';
        const visibleTargets = [...document.querySelectorAll(selector)]
            .filter(element => {
                if (element.disabled || element.closest('[hidden], [inert]')) return false;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                /*
                 * `display` plus a non-zero box is NOT enough to call a transformed
                 * sheet visible. The closed touch Notes panel parks itself below
                 * the frame with translateY(100%) (style.css:6903). Under the
                 * simulated 34px inset it is pushed far enough up that a 29px
                 * sliver of its 20px-wide textarea intersects the frame
                 * (measured 995..1372 in a 1024px viewport at tablet), so a bare
                 * intersection test still admitted it and it was reported as a
                 * 20x377 "visible" target.
                 *
                 * REACHABILITY is the real contract, exactly as this section's
                 * comment states: the element must own the point a finger would
                 * land on. The parked sheet's centre sits at y~1183, outside the
                 * viewport, where elementFromPoint returns null -- nothing can tap
                 * it. An OPEN sheet owns its centre and is measured normally, so
                 * this excludes only what is genuinely untappable and exempts no
                 * real control.
                 */
                const cx = Math.round(rect.left + rect.width / 2);
                const cy = Math.round(rect.top + rect.height / 2);
                const centreInViewport = cx >= 0 && cx < innerWidth
                    && cy >= 0 && cy < innerHeight;
                if (!centreInViewport) return false;
                return style.display !== 'none' && style.visibility !== 'hidden'
                    && style.opacity !== '0' && style.pointerEvents !== 'none'
                    && rect.width > 0 && rect.height > 0;
            })
            .map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    id: element.id || element.getAttribute('aria-label')
                        || String(element.className),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
            });

        return {
            header, dock, statusBar, grid, terminalHost, input, tabs, dockControls,
            deckContentTop, deckContentBottom,
            safeBottom: Math.round(safeBottom),
            functionalTop,
            functionalBottom,
            functionalHeight: dock.visible ? functionalBottom - functionalTop : 0,
            terminalRows: window.__geometryTerminal.rows,
            terminalCols: window.__geometryTerminal.cols,
            targetFailures: visibleTargets
                .filter(target => target.width < 44 || target.height < 44)
                .map(target => `${target.id}:${target.width}x${target.height}`),
            tabCount: document.querySelectorAll('#sessionTabs').length,
            tabsParent: tabsElement.parentElement.id
                || String(tabsElement.parentElement.className),
            tabsAfterButton: document.getElementById('newConnectionBtn')
                ?.nextElementSibling === tabsElement,
            inputTag: document.getElementById('mobileInput').tagName,
            inputRows: document.getElementById('mobileInput').rows,
        };
    });
}

/*
 * Every visible coarse-pointer target must be reachable at 44x44.
 *
 * REACHABLE, not painted. A control may carry an invisible ::after hit target
 * larger than its painted box (the six action buttons did while phone
 * landscape drew a 40px band, entry 3, retired).
 * getBoundingClientRect reports only the painted box, so it would fail such
 * a control while a real finger lands correctly.
 *
 * Entry 3 also records the converse trap: a computed ::after can report 44x44
 * while an ancestor's overflow clips it back, and computed style cannot see
 * that. So neither box is trusted -- the reachable band is probed with
 * elementFromPoint, which is what a real tap actually resolves against.
 *
 * This is STRONGER than the painted-box check it replaces: it fails both a
 * too-small target AND a target that measures correctly but is clipped,
 * overlapped, or covered by a sibling. Nothing is exempted.
 */
async function assertTargetState(page, label) {
    const failures = await page.evaluate(() => {
        const selector = 'button, a[href], input, textarea, select, [role="button"], [tabindex]';
        return [...document.querySelectorAll(selector)]
            .filter(element => {
                if (element.disabled || element.closest('[hidden], [inert]')) return false;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                /*
                 * `display` plus a non-zero box is NOT enough to call a transformed
                 * sheet visible. The closed touch Notes panel parks itself below
                 * the frame with translateY(100%) (style.css:6903). Under the
                 * simulated 34px inset it is pushed far enough up that a 29px
                 * sliver of its 20px-wide textarea intersects the frame
                 * (measured 995..1372 in a 1024px viewport at tablet), so a bare
                 * intersection test still admitted it and it was reported as a
                 * 20x377 "visible" target.
                 *
                 * REACHABILITY is the real contract, exactly as this section's
                 * comment states: the element must own the point a finger would
                 * land on. The parked sheet's centre sits at y~1183, outside the
                 * viewport, where elementFromPoint returns null -- nothing can tap
                 * it. An OPEN sheet owns its centre and is measured normally, so
                 * this excludes only what is genuinely untappable and exempts no
                 * real control.
                 */
                const cx = Math.round(rect.left + rect.width / 2);
                const cy = Math.round(rect.top + rect.height / 2);
                const centreInViewport = cx >= 0 && cx < innerWidth
                    && cy >= 0 && cy < innerHeight;
                if (!centreInViewport) return false;
                return style.display !== 'none' && style.visibility !== 'hidden'
                    && style.opacity !== '0' && style.pointerEvents !== 'none'
                    && rect.width > 0 && rect.height > 0;
            })
            .map((element) => {
                const rect = element.getBoundingClientRect();
                const id = element.id || element.getAttribute('aria-label')
                    || String(element.className);
                // Reachable band through the element's own centre column.
                const cx = Math.round(rect.left + rect.width / 2);
                const owns = (y) => {
                    const hit = document.elementFromPoint(cx, y);
                    return !!(hit && (hit === element || element.contains(hit)));
                };
                let top = Math.round(rect.top);
                let bottom = Math.round(rect.bottom);
                while (top - 1 >= 0 && owns(top - 1)) top--;
                while (bottom + 1 < window.innerHeight && owns(bottom)) bottom++;
                // Same walk horizontally, through the centre row.
                const cy = Math.round(rect.top + rect.height / 2);
                const ownsX = (x) => {
                    const hit = document.elementFromPoint(x, cy);
                    return !!(hit && (hit === element || element.contains(hit)));
                };
                let left = Math.round(rect.left);
                let right = Math.round(rect.right);
                while (left - 1 >= 0 && ownsX(left - 1)) left--;
                while (right + 1 < window.innerWidth && ownsX(right)) right++;
                return { id, hitW: right - left, hitH: bottom - top,
                    w: Math.round(rect.width), h: Math.round(rect.height) };
            })
            .filter(target => target.hitW < 44 || target.hitH < 44)
            .map(target => `${target.id}:paint=${target.w}x${target.h}`
                + ` hit=${target.hitW}x${target.hitH}`);
    });
    check(`${label}: every visible coarse-pointer target is reachable at 44x44`,
        failures, []);
}

const baseRows = new Map();

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.touch,
        isMobile: vp.touch,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const measured = await measure(page);
    baseRows.set(vp.label, measured.terminalRows);
    const tok = await expectedChrome(page);
    // Phones put the whole two-row touch header at the BOTTOM, above the dock,
    // so it is bottom chrome rather than top chrome. Measured, not assumed:
    // the header box is compared against the token sum below.
    const strip = vp.bottomHeader ? measured.header.height : 0;
    const top = vp.bottomHeader ? 0 : (measured.header.visible ? measured.header.height : 0);
    const dock = measured.dock.visible ? measured.dock.height : 0;
    // Every touch tier is a border-box dock: the 2px+1px padding the old
    // short-landscape dock added around its shared strip went with the strip
    //.
    const expectedDock = vp.touch ? tok.dockOuter : 0;
    const chrome = top + dock + strip;
    // v5 desktop uses the mockup's 44px global row + 40px workspace row =
    // 84px (lines 228-229), while touch tablets use 44+44 = 88px (324-325).
    // The budget is derived from vp.top below, so each capability tier carries
    // its own approved number rather than borrowing the other tier's constant.
    //
    // Phones move 15% -> 17.1% -> the W14 item 3 status band
    // raises the approved chrome again.
    // The bound is DERIVED for every touch tier from the approved geometry
    // (top header + token-derived dock; the bottom-header tiers fold the strip
    // into `top`) plus a 0.1% slack, exactly like the short-landscape branch
    // below already was. The slack keeps it a real bound: any dock or header
    // row 1px over the approved value still fails (0.001 < 1/800).
    const budget = ((top + strip + expectedDock) / vp.h) + 0.001;

    console.log(`\n--- base ${vp.label} ${vp.w}x${vp.h}: terminal `
        + `${measured.terminalCols}x${measured.terminalRows}, grid `
        + `${measured.grid.left},${measured.grid.top}..`
        + `${measured.grid.right},${measured.grid.bottom} ---`);
    check(`${vp.label}: top chrome`, top, vp.top);
    check(`${vp.label}: bottom dock outer box`, dock, expectedDock);
    if (vp.bottomHeader) {
        // The bottom header is exactly the two v5 rows: action row + session
        // row. Pinning it to the token sum keeps a third row, or a row that
        // silently grows, failing.
        check(`${vp.label}: bottom header is the two v5 rows`,
            strip, tok.touchActions + tok.strip);
    }
    check(`${vp.label}: total permanent chrome`, chrome, vp.top + expectedDock + strip);
    atMost(`${vp.label}: total chrome stays within budget`,
        Number((100 * chrome / vp.h).toFixed(1)), 100 * budget, '%');
    check(`${vp.label}: terminal begins below top chrome`,
        measured.grid.top, measured.deckContentTop + top);
    /*
     * HEADER PLACEMENT (product defect fixed at style.css:8067-8095). The
     * canonical touch override sets .header { order: 1 }, which is the deliberate
     * PHONE layout -- header below the elastic main content, just above the dock.
     * It was applied to every coarse device, so tablet/iPad rendered the 88px
     * header at the BOTTOM with the terminal starting at y=0 (measured: header
     * 888..976 at 768x1024, 1058..1146 at 834x1194, 698..786 at 1194x834).
     *
     * Asserted as ORDERING, not just as a coordinate: a regression that restores
     * order:1 for >=768px puts the header after the grid again and fails here even
     * if some other rule happened to keep grid.top at 88. The phone exception is
     * asserted in the same breath rather than excluded, so the two tiers can never
     * silently converge.
     */
    if (vp.bottomHeader) {
        check(`${vp.label}: phone keeps the documented bottom-header exception`,
            measured.header.top >= measured.grid.bottom, true);
    } else if (vp.touch) {
        check(`${vp.label}: touch header sits ABOVE the terminal`,
            measured.header.bottom <= measured.grid.top, true);
        check(`${vp.label}: touch header starts at the top of the frame`,
            measured.header.top, 0);
    }
    // The status bar is chrome below the dock at EVERY viewport, desktop
    // included. The old expectation omitted it and only passed because the
    // stale 66px dock over-counted by roughly the same amount; with the dock
    // measured correctly the omission became visible. Included explicitly so
    // both boxes are pinned independently.
    const statusH = measured.statusBar.visible ? measured.statusBar.height : 0;
    check(`${vp.label}: terminal ends above complete bottom chrome`,
        measured.grid.bottom, measured.deckContentBottom - dock - statusH);
    /*
     * RE-TARGETED (ruling, mockup lines 189/191, 220 and 357/363).
     *
     * The status bar precedes the composer dock in the mockup, so it must sit
     * above a visible dock. Phone and phone-landscape remove it entirely. On a
     * fine pointer there is no dock, and blocker 9 introduced the mockup's real
     * bordered product frame plus outer gutter; the old `statusBar.bottom ===
     * vp.h` therefore pinned the pre-frame viewport edge rather than the painted
     * product edge.
     *
     * Both bottom-chrome checks remain exact equalities, now against the measured
     * deck content bottom (border box minus its real border). Touch stays
     * edge-to-edge, so its reference is numerically unchanged; desktop resolves
     * to the framed content edge instead of silently demanding the gutter vanish.
     */
    if (!measured.statusBar.visible) {
        // Phone and phone-landscape: the band is removed, not shrunk.
        check(`${vp.label}: the status bar is absent where the mockup removes it`,
            vp.w < 768 || vp.h < 500, true);
    } else {
        check(`${vp.label}: the status bar sits above the dock, not below it`,
            measured.dock.visible
                ? measured.statusBar.bottom <= measured.dock.top
                : measured.statusBar.bottom === measured.deckContentBottom,
            true);
        check(`${vp.label}: the status bar is the last chrome above the dock`,
            measured.statusBar.bottom + (measured.dock.visible ? dock : 0),
            measured.deckContentBottom);
    }
    check(`${vp.label}: real terminal host stays within the terminal grid`,
        measured.terminalHost.left >= measured.grid.left
            && measured.terminalHost.right <= measured.grid.right
            && measured.terminalHost.top >= measured.grid.top
            && measured.terminalHost.bottom <= measured.grid.bottom, true);
    check(`${vp.label}: real terminal renders at least one row`,
        measured.terminalRows > 0, true);
    check(`${vp.label}: exactly one real sessionTabs`, measured.tabCount, 1);

    if (vp.touch) {
        // measured.functionalHeight is the dock's OUTER rect minus the safe-area
        // inset, so in short landscape it still carries that tier's 2px+1px
        // asymmetric padding around the 48px functional token. Compared against
        // the same tier-aware expectation as the outer box rather than against the
        // bare token, so the 48px band stays pinned and the padding cannot drift.
        check(`${vp.label}: functional dock band matches the composer tokens`,
            measured.functionalHeight, tok.functional);
        check(`${vp.label}: base safe-area band is zero`, measured.safeBottom, 0);
        check(`${vp.label}: mobile input remains visible`, measured.input.visible, true);
        const outsideBand = measured.dockControls
            .filter(control => !control.visible
                || control.top < measured.functionalTop
                || control.bottom > measured.functionalBottom)
            .map(control => `${control.id}:${control.top}..${control.bottom}`);
        check(`${vp.label}: every dock control stays in the functional band`, outsideBand, []);
        // Hit-target-aware: v5 requires a 44x44 TARGET, and it is established
        // that the target may be an invisible ::after
        // while the painted box stays smaller. getBoundingClientRect cannot see
        // that, so measure the reachable band with elementFromPoint instead.
        const smallDock = await page.evaluate((ids) => ids.map((id) => {
            const el = document.getElementById(id);
            if (!el) return `${id}:absent`;
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden'
                || r.width === 0 || r.height === 0) return `${id}:hidden`;
            const cx = Math.round(r.left + r.width / 2);
            const owns = (y) => {
                const hit = document.elementFromPoint(cx, y);
                return !!(hit && (hit === el || el.contains(hit)));
            };
            let top = Math.round(r.top);
            let bottom = Math.round(r.bottom);
            while (top - 1 >= 0 && owns(top - 1)) top--;
            while (bottom + 1 < window.innerHeight && owns(bottom)) bottom++;
            const hitH = bottom - top;
            return (r.width >= 44 && hitH >= 44)
                ? null : `${id}:paint=${Math.round(r.width)}x${Math.round(r.height)} hit=${hitH}`;
        }).filter(Boolean), ['mobileInput', 'mobileKeypadBtn', 'mobileSendBtn']);
        check(`${vp.label}: dock controls are reachable 44x44 targets`, smallDock, []);
    } else {
        check(`${vp.label}: mobile dock controls stay absent`,
            measured.dockControls.filter(control => control.visible).map(control => control.id), []);
    }

    // The strip has ONE home at every tier: the header's strip row, directly
    // after the '+'. Phone landscape used to move it into the dock; that is
    // retired, and the tier now takes the >=768
    // touch rules like an iPad -- measured: an empty strip is 0px tall there
    // as on the iPad, while the phone-portrait block gives it the 44px token
    // -- so it is measured in the tablet branch below, not the phone one.
    if (['phone-small', 'phone', 'phone-360', 'phone-390'].includes(vp.label)) {
        check(`${vp.label}: the strip stays in the production header row`,
            measured.tabsParent, 'session-tabs-row');
        check(`${vp.label}: the strip directly follows the '+'`,
            measured.tabsAfterButton, true);
        check(`${vp.label}: the session strip stays above the workspace`,
            measured.tabs.visible && measured.tabs.height === tok.strip
                && measured.tabs.bottom === measured.grid.top, true);
    } else {
        check(`${vp.label}: the strip directly follows the '+'`,
            measured.tabsAfterButton, true);
        check(`${vp.label}: More sheet stays inactive`,
            await page.locator('#mobileMoreSheet').isVisible(), false);
    }

    check(`${vp.label}: mobileInput remains a one-row textarea`,
        `${measured.inputTag}:${measured.inputRows}`, 'TEXTAREA:1');

    if (vp.touch) {
        const touchHeader = await page.evaluate(() => {
            const brand = document.getElementById('headerBrand');
            const row = document.getElementById('touchActionRow');
            const logo = brand?.querySelector('.brand-logo');
            const wordmark = brand?.querySelector('.app-title');
            const br = brand?.getBoundingClientRect();
            const rr = row?.getBoundingClientRect();
            const visible = el => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return getComputedStyle(el).display !== 'none'
                    && r.width > 0 && r.height > 0;
            };
            return {
                brandNodes: document.querySelectorAll('#headerBrand').length,
                logoNodes: document.querySelectorAll('#headerBrand .brand-logo').length,
                actions: [...row.children].filter(visible).length,
                collision: (() => {
                    const brandHeader = brand?.closest('.header');
                    const rowHeader = row?.closest('.header');
                    return !!(brandHeader && rowHeader && brandHeader === rowHeader
                        && visible(brand) && visible(row) && br && rr
                        && br.right > rr.left + 0.5);
                })(),
                wordmarkVisible: visible(wordmark),
                logoVisible: visible(logo),
            };
        });
        check(`${vp.label}: one brand node and one logo remain`,
            `${touchHeader.brandNodes}:${touchHeader.logoNodes}`, '1:1');
        check(`${vp.label}: all six touch actions remain visible`, touchHeader.actions, 6);
        check(`${vp.label}: brand and action row do not collide`, touchHeader.collision, false);
        if (vp.w <= 390 && vp.h >= 500) {
            check(`${vp.label}: phone density hides the wordmark first`,
                touchHeader.wordmarkVisible, false);
            check(`${vp.label}: phone density keeps the logo`, touchHeader.logoVisible, true);
        }
        /*
         * Two states, not three. There used to be a
         * third -- "Settings open" -- reached by clicking #mobileSettingsBtn
         * inside the sheet, because the account controls lived behind an
         * intermediate navigation step. That step WAS the second menu entry point
         * the owner reported, so it is gone and one open shows everything.
         *
         * The 44x44 reachability audit is unchanged and now covers strictly MORE
         * controls in the open state, since the relocated globals and the whole
         * canonical account tree are all present in that single open menu.
         */
        await assertTargetState(page, `${vp.label} menu closed`);
        await page.click('#mobileMoreBtn');
        await assertTargetState(page, `${vp.label} canonical menu open`);
    }

    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

for (const vp of VIEWPORTS.filter(viewport => viewport.touch)) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({ content: `
        *,*::before,*::after{animation:none!important;transition:none!important}
        :root{--shell-safe-bottom:34px}
    ` });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const measured = await measure(page);
    // Re-read the tokens UNDER the simulated inset, so the expectation follows
    // --shell-safe-bottom: 34px the same way production follows env(). The
    // invariant being proved is structural: the inset is added BELOW the
    // functional band, never subtracted from it, so a 34px home indicator
    // cannot squeeze 44px controls into 14px.
    const tok = await expectedChrome(page);
    const strip = vp.bottomHeader ? measured.header.height : 0;
    const statusH = measured.statusBar.visible ? measured.statusBar.height : 0;
    const rowLoss = baseRows.get(vp.label) - measured.terminalRows;
    console.log(`\n--- simulated 34px inset ${vp.label} ${vp.w}x${vp.h}: terminal `
        + `${measured.terminalCols}x${measured.terminalRows}, grid `
        + `${measured.grid.left},${measured.grid.top}..`
        + `${measured.grid.right},${measured.grid.bottom} ---`);
    // Same border-box dock at every touch tier: the 34px inset is added BELOW
    // the band, never subtracted from it.
    check(`${vp.label} inset: dock outer box is the band plus the 34px inset`,
        measured.dock.height, tok.dockOuter);
    check(`${vp.label} inset: functional control band is unchanged by the inset`,
        measured.functionalHeight, tok.functional);
    check(`${vp.label} inset: OS-reserved band is 34px`, measured.safeBottom, 34);
    check(`${vp.label} inset: terminal ends above the docked strip and the dock`,
        measured.grid.bottom, vp.h - tok.dockOuter - statusH);
    const outsideBand = measured.dockControls
        .filter(control => !control.visible
            || control.top < measured.functionalTop
            || control.bottom > measured.functionalBottom)
        .map(control => `${control.id}:${control.top}..${control.bottom}`);
    check(`${vp.label} inset: controls do not occupy the OS-reserved band`, outsideBand, []);
    // Hit-target-aware for the same reason as the base loop: the painted box
    // is not the reachable target.
    const smallDock = await page.evaluate((ids) => ids.map((id) => {
        const el = document.getElementById(id);
        if (!el) return `${id}:absent`;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden'
            || r.width === 0 || r.height === 0) return `${id}:hidden`;
        const cx = Math.round(r.left + r.width / 2);
        const owns = (y) => {
            const hit = document.elementFromPoint(cx, y);
            return !!(hit && (hit === el || el.contains(hit)));
        };
        let top = Math.round(r.top);
        let bottom = Math.round(r.bottom);
        while (top - 1 >= 0 && owns(top - 1)) top--;
        while (bottom + 1 < window.innerHeight && owns(bottom)) bottom++;
        const hitH = bottom - top;
        return (r.width >= 44 && hitH >= 44)
            ? null : `${id}:paint=${Math.round(r.width)}x${Math.round(r.height)} hit=${hitH}`;
    }).filter(Boolean), ['mobileInput', 'mobileKeypadBtn', 'mobileSendBtn']);
    check(`${vp.label} inset: dock controls remain reachable at 44x44`, smallDock, []);
    check(`${vp.label} inset: real terminal host stays inside its grid`,
        measured.terminalHost.top >= measured.grid.top
            && measured.terminalHost.bottom <= measured.grid.bottom, true);
    check(`${vp.label} inset: real terminal still renders rows`, measured.terminalRows > 0, true);
    check(`${vp.label} inset: 34px is paid by terminal height, not dock controls`,
        rowLoss >= 1 && rowLoss <= 4, true);
    await assertTargetState(page, `${vp.label} simulated inset`);
    check(`${vp.label} inset: no page errors`, errors, []);
    await ctx.close();
}


// --- Option B approved geometry, at the two viewports the decision was measured
// on. Placement, the reserved band, keyboard-open reclamation and the exact
// terminal heights the approval preserved.
//
// The reserved band and the reclaimed amount are DERIVED from the tokens, not
// literals. Option B's shape is unchanged -- header and dock both out of flow,
// .main-content reserving exactly their combined height, keyboard-open giving
// back exactly the header -- but the numbers moved with v5 section 3: the
// reserved band is the two-row header (44+44) plus the dock (48) plus the
// status bar, and keyboard-open reclaims the whole two-row header, not a single
// 45px strip. Terminal height is likewise derived from the frame rather than
// pinned to a literal, so it stays an exact equality. ---
for (const vp of [{ label: 'decision-390', w: 390, h: 844 },
                  { label: 'decision-360', w: 360, h: 800 }]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const m = await measure(page);
    const tok = await expectedChrome(page);
    const placement = await page.evaluate(() => ({
        headerPos: getComputedStyle(document.querySelector('.header')).position,
        dockPos: getComputedStyle(document.getElementById('sessionBar')).position,
        reserved: Math.round(parseFloat(
            getComputedStyle(document.querySelector('.main-content')).paddingBottom)),
    }));
    const statusH = m.statusBar.visible ? m.statusBar.height : 0;
    const headerH = tok.touchActions + tok.strip;
    const expectedReserved = headerH + tok.dockOuter;
    console.log(`\n--- option B ${vp.label} ${vp.w}x${vp.h}: terminal `
        + `${m.terminalCols}x${m.terminalRows}, grid height ${m.grid.height} ---`);
    /*
     * RE-TARGETED (v5, amendment line 94). The three assertions here used to
     * require position:fixed for the strip and the dock, plus a padding-bottom
     * reserve on .main-content sized to the header + dock. That was the OVERLAY
     * model: out-of-flow chrome floating over the terminal, with the terminal
     * given artificial padding so its rows were not covered.
     *
     * v5 retires it. The shell is a .deck-window flex COLUMN, the chrome are
     * ordinary flex items, and the terminal shrinks because the column
     * redistributes real space -- not because padding fakes room. So a reserve of
     * 0 is now correct and `fixed` is now a regression.
     *
     * The same three behaviours are still guarded, restated in the flow model:
     * the chrome stay in flow, they charge no phantom reserve, and the space they
     * occupy is conserved against the frame (asserted just below via
     * `terminal keeps its approved height`, which is an exact equality derived
     * from the tokens).
     */
    check(`${vp.label}: session strip participates in normal flow`,
        placement.headerPos, 'relative');
    check(`${vp.label}: control band participates in normal flow`,
        placement.dockPos, 'relative');
    check(`${vp.label}: main content charges no phantom padding reserve`,
        placement.reserved, 0);
    check(`${vp.label}: the chrome still occupies exactly the two v5 rows plus the dock`,
        m.header.height + m.dock.height, expectedReserved);
    check(`${vp.label}: the measured header matches the two v5 rows`,
        m.header.height, headerH);
    check(`${vp.label}: strip sits directly above the terminal`,
        m.tabs.bottom === m.grid.top && m.tabs.height === tok.strip, true);
    check(`${vp.label}: terminal starts below the two touch rows`, m.grid.top, headerH);
    check(`${vp.label}: terminal keeps its approved height`,
        m.grid.height, vp.h - expectedReserved - statusH);

    const reclaimed = await page.evaluate(() => {
        const shown = () => getComputedStyle(document.querySelector('.header')).display !== 'none';
        document.body.classList.add('keyboard-open');
        const pad = Math.round(parseFloat(
            getComputedStyle(document.querySelector('.main-content')).paddingBottom));
        const stripShown = shown();
        const notes = document.getElementById('notepadPanel');
        const wasOpen = notes.classList.contains('mobile-open');
        notes.classList.add('mobile-open');
        const notesStripShown = shown();
        notes.classList.toggle('mobile-open', wasOpen);
        document.body.classList.remove('keyboard-open');
        return { pad, stripShown, notesStripShown };
    });
    /*
     * RESTATED 2026-09-25, class (a). This row asserted that the system keyboard
     * hides the strip. OWNER RULING 2026-09-25: typing into the terminal, the
     * keyboard behaves like the function keypad -- the header stays and only
     * the bottom edge moves (spec line 352 draws the keyboard state with the
     * header in place; line 421 says the keypad works the same way). Typing
     * into the NOTES still takes the whole screen, so the header still goes
     * while the notes sheet is open -- the companion row, which keeps the
     * narrowed rule honest.
     */
    check(`${vp.label}: keyboard-open keeps the docked strip, as the keypad does`,
        reclaimed.stripShown, true);
    check(`${vp.label}: with the notes sheet open it still goes`, reclaimed.notesStripShown, false);
    /*
     * Under the retired reserve model, the keyboard reclaimed the header by
     * SHRINKING .main-content's padding-bottom. In the flow model there is no
     * padding: no reserve may appear in either state -- a padding-bottom
     * reappearing here would mean the retired mechanism had been restored.
     */
    check(`${vp.label}: keyboard-open adds no padding reserve`,
        `open=${reclaimed.pad} closed=${placement.reserved}`, 'open=0 closed=0');
    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

// --- Landscape is width-keyed (min-width: 768px) and must be untouched by B. ---
{
    const ctx = await browser.newContext({
        viewport: { width: 926, height: 428 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    const ls = await page.evaluate(() => ({
        headerDisplay: getComputedStyle(document.querySelector('.header')).display,
        headerHeight: Math.round(
            document.querySelector('.header').getBoundingClientRect().height),
        rowVisibleActions: [...document.getElementById('touchActionRow').children]
            .filter(el => el.getBoundingClientRect().width > 0
                && el.getBoundingClientRect().height > 0).length,
        reserved: Math.round(parseFloat(
            getComputedStyle(document.querySelector('.main-content')).paddingBottom)),
        dockPos: getComputedStyle(document.getElementById('sessionBar')).position,
    }));
    // RESTATED (owner ruling): no compact band any more -- phone
    // landscape draws the same two-row touch header as portrait (44px actions
    // + 44px strip), laid out, and the six v5 actions are all in its row.
    check('landscape: the header is drawn, not hidden',
        ls.headerDisplay !== 'none', true);
    check('landscape: the two-row touch header is 88px', ls.headerHeight, 88);
    // Six, not five. v5 section 3 lists Menu toàn cục as action 6 and requires
    // "iPad ngang và phone ngang vẫn giữ đúng sáu action". The old expectation
    // of five predates Menu moving out of the composer dock, which the same
    // section forbids ("Không tạo nút menu thứ hai ở session row hoặc composer").
    check('landscape: all six v5 row actions are visible in it',
        ls.rowVisibleActions, 6);
    check('landscape: no strip band is reserved', ls.reserved, 0);
    check('landscape: dock keeps its in-flow position', ls.dockPos, 'relative');
    await ctx.close();
}


// --- Option B: approved geometry at the two viewports the decision was measured
// on, the reserved band, keyboard-open reclamation, and the More/Settings
// interaction the docked strip must not intercept (deviation 1). ---
for (const optB of [{ label: 'decision-390', w: 390, h: 844, terminal: 733 },
                    { label: 'decision-360', w: 360, h: 800, terminal: 689 }]) {
    const ctx = await browser.newContext({
        viewport: { width: optB.w, height: optB.h }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const geo = await measure(page);
    const tokB = await expectedChrome(page);
    const placement = await page.evaluate(() => ({
        headerPos: getComputedStyle(document.querySelector('.header')).position,
        dockPos: getComputedStyle(document.getElementById('sessionBar')).position,
        reserved: Math.round(parseFloat(
            getComputedStyle(document.querySelector('.main-content')).paddingBottom)),
    }));
    const statusHB = geo.statusBar.visible ? geo.statusBar.height : 0;
    const headerHB = tokB.touchActions + tokB.strip;
    const expectedReservedB = headerHB + tokB.dockOuter;
    console.log(`\n--- option B ${optB.label} ${optB.w}x${optB.h}: terminal `
        + `${geo.terminalCols}x${geo.terminalRows}, grid height ${geo.grid.height} ---`);
    // RE-TARGETED to the v5 normal-flow contract; see the identical note in the
    // first decision-* block above for why the fixed/absolute reserve model was
    // retired (amendment line 94) and how each behaviour is still guarded.
    check(`${optB.label}: session strip participates in normal flow`,
        placement.headerPos, 'relative');
    check(`${optB.label}: control band participates in normal flow`,
        placement.dockPos, 'relative');
    check(`${optB.label}: main content charges no phantom padding reserve`,
        placement.reserved, 0);
    check(`${optB.label}: the chrome still occupies exactly the two v5 rows plus the dock`,
        geo.header.height + geo.dock.height, expectedReservedB);
    check(`${optB.label}: strip sits directly above the terminal`,
        geo.tabs.bottom === geo.grid.top && geo.tabs.height === tokB.strip, true);
    check(`${optB.label}: terminal starts below the two touch rows`,
        geo.grid.top, headerHB);
    check(`${optB.label}: terminal keeps its approved height`,
        geo.grid.height, optB.h - expectedReservedB - statusHB);

    // The sheet carries its positioned rules only while it is not [hidden].
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(100);
    const sheet = await page.evaluate(() => {
        const el = document.getElementById('mobileMoreSheet');
        const r = el.getBoundingClientRect();
        const strip = document.querySelector('.header').getBoundingClientRect();
        // The hit test needs any real control inside the open menu. It used to
        // use #mobileSettingsBtn, which was the entry point of the removed
        // intermediate view; the first relocated
        // global serves the same purpose and is not tied to a deleted surface.
        const probe = el.querySelector('button');
        const btn = probe.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(btn.left + btn.width / 2),
                                              Math.round(btn.top + btn.height / 2));
        return {
            gapBelowTrigger: Math.round(r.top) - Math.round(
                document.getElementById('mobileMoreBtn').getBoundingClientRect().bottom),
            scrolls: getComputedStyle(el).overflowY,
            hitIsInSheet: !!(hit && el.contains(hit)),
        };
    });
    check(`${optB.label}: More sheet hangs directly below its Menu trigger`,
        sheet.gapBelowTrigger, 1);
    check(`${optB.label}: More sheet keeps its overflow scroll`, sheet.scrolls, 'auto');
    check(`${optB.label}: a menu control wins its own hit test`, sheet.hitIsInSheet, true);
    // The canonical account tree is hosted by that one open, with no Settings
    // step to navigate through.
    check(`${optB.label}: the canonical account tree is visible in the docked sheet`,
        await page.evaluate(() => {
            const tree = document.getElementById('accountDropdownHeader');
            const sheetEl = document.getElementById('mobileMoreSheet');
            const r = tree.getBoundingClientRect();
            return sheetEl.contains(tree) && r.width > 0 && r.height > 0;
        }), true);

    const reclaimed = await page.evaluate(() => {
        const shown = () => getComputedStyle(document.querySelector('.header')).display !== 'none';
        document.body.classList.add('keyboard-open');
        const pad = Math.round(parseFloat(
            getComputedStyle(document.querySelector('.main-content')).paddingBottom));
        const stripShown = shown();
        const notes = document.getElementById('notepadPanel');
        const wasOpen = notes.classList.contains('mobile-open');
        notes.classList.add('mobile-open');
        const notesStripShown = shown();
        notes.classList.toggle('mobile-open', wasOpen);
        document.body.classList.remove('keyboard-open');
        return { pad, stripShown, notesStripShown };
    });
    // RESTATED 2026-09-25, class (a): see the first decision-* block.
    check(`${optB.label}: keyboard-open keeps the docked strip, as the keypad does`,
        reclaimed.stripShown, true);
    check(`${optB.label}: with the notes sheet open it still goes`, reclaimed.notesStripShown, false);
    check(`${optB.label}: keyboard-open adds no padding reserve`,
        `open=${reclaimed.pad} closed=${placement.reserved}`, 'open=0 closed=0');
    void headerHB;
    check(`${optB.label}: no page errors`, errors, []);
    await ctx.close();
}

// --- Landscape is width-keyed (min-width: 768px) and must be untouched by B. ---
{
    const ctx = await browser.newContext({
        viewport: { width: 926, height: 428 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(100);
    const ls = await page.evaluate(() => {
        const sheet = document.getElementById('mobileMoreSheet');
        const cs = getComputedStyle(sheet);
        const r = sheet.getBoundingClientRect();
        const triggerEl = document.getElementById('mobileMoreBtn');
        const trigger = triggerEl.getBoundingClientRect();
        const header = document.querySelector('.header').getBoundingClientRect();
        /*
         * The bottom edge a FINGER reaches on the trigger. Since the 40px band
         * was retired the six actions paint their
         * whole 44px target and carry no ::after hit box, so this equals the
         * painted bottom; the derivation is kept because it mirrors
         * triggerReachableBottom() in header-menus.js, which still reads it.
         */
        const after = getComputedStyle(triggerEl, '::after');
        let reachableBottom = trigger.bottom;
        const afterH = parseFloat(after.height);
        if (after.content !== 'none' && Number.isFinite(afterH) && afterH > 0) {
            const borderTop = parseFloat(getComputedStyle(triggerEl).borderTopWidth) || 0;
            const offsetTop = parseFloat(after.top);
            const anchor = Number.isFinite(offsetTop)
                ? trigger.top + borderTop + offsetTop
                : trigger.top + trigger.height / 2;
            const shift = after.transform && after.transform !== 'none'
                ? (new DOMMatrixReadOnly(after.transform).f || 0) : 0;
            reachableBottom = Math.max(reachableBottom, anchor + shift + afterH);
        }
        /*
         * Is the anchoring VISUALLY gapless? The card's box now starts 4px below
         * the painted band, and a solid box-shadow tongue re-paints those rows.
         * A shadow has no box to measure, so the only honest probe is the painted
         * result: sample the shadow's own colour stop and confirm the rows
         * between the painted band and the card box are covered by it.
         */
        const tongue = cs.boxShadow;
        const bandBottom = Math.round(header.bottom);
        return {
            headerDisplay: getComputedStyle(document.querySelector('.header')).display,
            reserved: Math.round(parseFloat(
                getComputedStyle(document.querySelector('.main-content')).paddingBottom)),
            dockPos: getComputedStyle(document.getElementById('sessionBar')).position,
            sheetPos: cs.position,
            sheetScrolls: cs.overflowY,
            sheetWidth: Math.round(r.width),
            // Anchoring, expressed as relationships rather than absolutes.
            gapBelowTrigger: Math.round(r.top) - Math.round(trigger.bottom),
            gapBelowReachable: Math.round(r.top) - Math.round(reachableBottom),
            reachableOvershoot: Math.round(reachableBottom) - Math.round(trigger.bottom),
            /*
             * The tongue must reach back to the row the card USED to occupy, so
             * no row between the band and the card is left unpainted. The card's
             * box top is r.top and its old anchor was bandBottom + 1, so the
             * shadow has to extend (r.top - bandBottom - 1) px upwards. Measured
             * on the serialised computed value, where each solid stop reads as
             * `<colour> 0px -Npx 0px 0px`; a blurred or spread stop does not
             * match, because a soft shadow is not continuous paint.
             */
            tongueSpansGap: (() => {
                const rows = Math.round(r.top) - bandBottom - 1;
                if (rows <= 0) return true;
                const reach = tongue.split(/,(?![^(]*\))/)
                    .map(stop => stop.trim().match(/\s0px\s+-(\d+)px\s+0px\s+0px$/))
                    .filter(Boolean)
                    .map(m => Number(m[1]));
                return reach.length > 0 && Math.max(...reach) >= rows;
            })(),
            rightDelta: Math.round(trigger.right) - Math.round(r.right),
            withinViewport: Math.round(r.right) <= window.innerWidth
                && Math.round(r.left) >= 0
                && Math.round(r.bottom) <= window.innerHeight,
            headerHeight: Math.round(header.height),
        };
    });
    // Opening the More sheet must not collapse or resize the header.
    // RESTATED (owner ruling): the two-row touch header, 88px.
    check('landscape More open: header is still drawn',
        ls.headerDisplay !== 'none', true);
    check('landscape More open: the two-row header is still 88px', ls.headerHeight, 88);
    check('landscape: no strip band is reserved', ls.reserved, 0);
    check('landscape: dock keeps its in-flow position', ls.dockPos, 'relative');
    // Re-derived: the global menu is now a
    // dropdown anchored under its own trigger, per mockup line 267
    // (top: calc(100% + 1px); right: 6px; width: min(300px, ...)). The old
    // 'bottom: 65px' pinned the pre-entry-5 bottom-sheet anchor, which opened
    // ~650px away from the Menu button at this viewport.
    //
    // Asserted as relationships, so the check survives a viewport change but
    // still fails a mis-anchored panel: 1px below the band, right-aligned to
    // the trigger within the 6px the mockup specifies, and fully on-screen.
    check('landscape: More sheet is out of flow', ls.sheetPos, 'fixed');
    /*
     * The card hangs exactly 1px below the trigger a finger reaches (S17 step
     * B: anchoring on a painted edge shorter than the hit box let the card,
     * which out-stacks the buttons, take hit rows back). RESTATED:
     * with the 40px band retired the trigger paints its whole target, so the
     * reachable bottom IS the painted bottom (overshoot 0), and the card,
     * hanging from the 44px action row, overlays the strip row below it --
     * the same "global menu hangs under its trigger" shape the >=768 touch
     * tier (mockup line 267) has always had. The tongue row stays: with no
     * vacated rows it is vacuously true and would fail the moment rows
     * reappeared.
     */
    check('landscape: More sheet hangs 1px below the trigger a finger reaches',
        ls.gapBelowReachable, 1);
    check('landscape: the trigger paints its whole target (no invisible overshoot)',
        ls.reachableOvershoot, 0);
    check('landscape: the vacated rows are painted, so the anchoring stays gapless',
        ls.tongueSpansGap, true);
    check('landscape: the card box starts 1px past the painted trigger',
        ls.gapBelowTrigger, 1);
    // Mockup line 267 declares 300px on a content-box card: 300 content
    // + 2x5px padding + 2x1px border = 312px rendered outer width. The app
    // is globally border-box, so getBoundingClientRect() must be 312px.
    check('landscape: More sheet is the mockup 312px outer card', ls.sheetWidth, 312);
    check('landscape: More sheet is right-aligned to its trigger',
        ls.rightDelta >= -6 && ls.rightDelta <= 6, true);
    check('landscape: More sheet stays inside the viewport', ls.withinViewport, true);
    check('landscape: More sheet keeps its overflow scroll', ls.sheetScrolls, 'auto');
    await ctx.close();
}

// --- Hybrid touch shell (spec 3b): a fine primary pointer that also has a
// coarse secondary input (any-pointer: coarse) MUST be a touch shell. The
// desktop-default block (pointer:fine and hover:hover and min-height) matches,
// but the canonical touch override (any-pointer: coarse) comes later and wins.
// CSS and the shared JS helper must give the same answer. ---
{
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: true, isMobile: false,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    // Chromium derives pointer:coarse from hasTouch; explicitly emulate the
    // hybrid shape the spec calls out: fine primary + hover + any coarse.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
        features: [
            { name: 'pointer', value: 'fine' },
            { name: 'hover', value: 'hover' },
            { name: 'any-pointer', value: 'coarse' },
        ],
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    const hybrid = await page.evaluate(() => {
        const cssTouch = window.matchMedia(
            '(pointer: coarse), (hover: none), (any-pointer: coarse)').matches;
        return {
            cssTouch,
            jsTouch: TerminalManager.isTouchShell(),
            jsDesktop: TerminalManager.isDesktopShell(),
            dockDisplay: getComputedStyle(document.getElementById('sessionBar')).display,
            inputBarDisplay: getComputedStyle(document.getElementById('mobileInputBar')).display,
        };
    });
    check('hybrid: canonical CSS query matches (any-pointer: coarse)', hybrid.cssTouch, true);
    check('hybrid: JS isTouchShell() agrees with the CSS query', hybrid.jsTouch, hybrid.cssTouch);
    check('hybrid: JS isDesktopShell() is false', hybrid.jsDesktop, false);
    check('hybrid: the dock renders (touch shell wins over desktop default)',
        hybrid.dockDisplay, 'flex');
    check('hybrid: the composer renders (touch shell wins)',
        hybrid.inputBarDisplay, 'flex');
    // The hybrid is a touch shell, so the 44x44 touch-target floor applies even
    // though its primary pointer is fine. The canonical (pointer: coarse),
    // (hover: none), (any-pointer: coarse) touch-target block must square up
    // the action row -- the width-only (pointer: coarse) scope used to miss
    // exactly this.
    //
    // The list is the SIX v5 actions, not the old three. #reloadPageBtn was in
    // the old list, but v5 section 3 makes it SECONDARY: touch-action-row.js
    // moves it into #mobileSettingsHost inside the one menu, where it measures
    // 0x0 while the sheet is closed. Asserting it visible in the row would
    // demand a v5 violation. Its reachability in the sheet is covered by the
    // assertTargetState passes with the sheet open.
    //
    // Two explicit checks kept: (1) all six are present and visible, so a
    // regression that hides one cannot be masked by "no visible failures";
    // (2) each is a real >= 44x44 target.
    const hybridTargets = await page.evaluate(() =>
        ['layoutMenuBtn', 'broadcastToggleBtn', 'saveTranscriptBtn',
         'touchReconnectBtn', 'notepadOpenBtn', 'mobileMoreBtn'].map(id => {
            const el = document.getElementById(id);
            if (!el) return { id, present: false, visible: false, w: 0, h: 0 };
            const style = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const visible = !el.hasAttribute('hidden')
                && style.display !== 'none' && style.visibility !== 'hidden'
                && r.width > 0 && r.height > 0;
            return { id, present: true, visible, w: Math.round(r.width), h: Math.round(r.height) };
        }));
    check('hybrid: all six v5 action buttons are present and visible',
        hybridTargets.filter(t => !t.present || !t.visible).map(t => t.id), []);
    check('hybrid: each visible action target is at least 44x44',
        hybridTargets.filter(t => t.w < 44 || t.h < 44)
            .map(t => `${t.id}:${t.w}x${t.h}`), []);
    /*
     * The complement: controls that are NOT among the six must still be reachable
     * through the one menu rather than silently lost. Reload is the case that was
     * once reported missing on iPad/mobile.
     *
     * OWNER CORRECTION (second pass) changed WHEN it is in the sheet,
     * so this check now opens the menu. #reloadPageBtn LIVES inside
     * #accountDropdownHeader (templates/index.html:162) and that tree is moved
     * into the sheet on open and handed back to the desktop header on close. It
     * used to be relocated into #mobileSettingsHost at sync time and sat there as
     * a detached sibling card measuring 0x0 while the sheet was closed -- which is
     * what this assertion measured, and why "reachable" was satisfied by a node
     * nobody could reach.
     *
     * Opening first makes the claim the real one: after one tap the control is in
     * the menu, painted, and a genuine touch target.
     */
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(120);
    const hybridSecondary = await page.evaluate(() =>
        ['reloadPageBtn'].map((id) => {
            const el = document.getElementById(id);
            if (!el) return `${id}:absent`;
            if (!el.closest('#mobileMoreSheet')) return `${id}:not-in-sheet`;
            const r = el.getBoundingClientRect();
            if (r.width < 44 || r.height < 44) {
                return `${id}:${Math.round(r.width)}x${Math.round(r.height)}`;
            }
            const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return hit && el.contains(hit) ? null : `${id}:not-hit-testable`;
        }).filter(Boolean));
    check('hybrid: secondary controls are reachable in the opened More sheet',
        hybridSecondary, []);
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(80);
    check('hybrid: no page errors', errors, []);
    await ctx.close();
}

// --- Pure fine-pointer desktop: the complement of the hybrid case. No coarse
// input anywhere means the desktop default stands: helper reports desktop and
// the dock stays hidden. ---
{
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: false, isMobile: false,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    const fine = await page.evaluate(() => ({
        jsTouch: TerminalManager.isTouchShell(),
        jsDesktop: TerminalManager.isDesktopShell(),
        dockDisplay: getComputedStyle(document.getElementById('sessionBar')).display,
        inputBarDisplay: getComputedStyle(document.getElementById('mobileInputBar')).display,
    }));
    check('pure-fine desktop: isTouchShell() is false', fine.jsTouch, false);
    check('pure-fine desktop: isDesktopShell() is true', fine.jsDesktop, true);
    check('pure-fine desktop: the dock stays hidden', fine.dockDisplay, 'none');
    check('pure-fine desktop: the composer stays hidden', fine.inputBarDisplay, 'none');
    await ctx.close();
}

// --- F3 auto-grow + placeholder (dated amendment) ----------------
// On a phone viewport the composer textarea must: (1) measure min-height 44px
// and height >= 44px when empty/one line; (2) cap at min(max-height, 30% of
// app height) with overflow-y:auto when filled past four lines (W14 item 4
// raised the cap from 88px to four lines of 16px/1.4 text); (3) show the new
// concise placeholder. RED against current source (fixed 44px height, old
// placeholder, no auto-grow CSS/JS).
{
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const grow = await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        const cs = getComputedStyle(el);
        return {
            minHeight: Math.round(parseFloat(cs.minHeight)) || 0,
            heightOneLine: Math.round(el.getBoundingClientRect().height),
            overflowY: cs.overflowY,
        };
    });
    check('F3 phone: composer min-height is 44px', grow.minHeight, 44);
    check('F3 phone: one-line height >= 44px', grow.heightOneLine >= 44, true);

    // Fill ~6 lines and check the cap. W14 item 4: the cap is FOUR lines of
    // the composer text plus its vertical padding/border, measured live from
    // the element's computed style (the same measure measureAndGrow uses),
    // then bounded by 30% of the usable app height.
    const capped = await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.value = Array(6).fill('line').join('\n');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const cs = getComputedStyle(el);
        const appH = window.innerHeight;
        const lh = parseFloat(cs.lineHeight) || 22.4;
        const vertical = ['paddingTop', 'paddingBottom',
            'borderTopWidth', 'borderBottomWidth']
            .reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0);
        const fourLineCap = Math.ceil(4 * lh + vertical);
        const cap = Math.min(fourLineCap, Math.floor(appH * 0.30));
        const h = Math.round(el.getBoundingClientRect().height);
        return { h, cap, fourLineCap, overflowY: cs.overflowY, withinCap: h <= cap + 1 };
    });
    // The raised cap must clear the old 88px ceiling (four lines of 22.4 +
    // padding/border = 108px at the 16px/1.4 composer text).
    check('F3 phone: the cap is four lines and exceeds the old 88px ceiling',
        capped.fourLineCap > 88, true);
    check('F3 phone: six lines capped at min(4-line cap, 30% app height)',
        capped.withinCap, true);
    check('F3 phone: overflow-y is auto past the cap', capped.overflowY, 'auto');

    // Placeholder.
    const ph = await page.evaluate(() =>
        document.getElementById('mobileInput').getAttribute('placeholder'));
    check('F3 phone: placeholder is the new concise string', ph, 'Command…');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// Notepad shell form. The panel's sheet conversion used to ride
// @media (max-width: 767px), so every coarse tablet got the DESKTOP side rail:
// it sat in the auxiliary grid track and cost 240-287px of terminal. Width may
// gate density but may never decide whether the dock exists, so these tiers
// assert the capability contract directly. 768x1024 and 1024x768 are the two
// locked tablet tiers; 844x390 is a PHONE in landscape, which the old width
// query also mis-shelled because 844 > 767.
// ---------------------------------------------------------------------------
const NOTEPAD_TIERS = [
    { label: 'np-ipad-portrait', w: 768, h: 1024 },
    { label: 'np-ipad-landscape', w: 1024, h: 768 },
    { label: 'np-ipad-834', w: 834, h: 1194 },
    { label: 'np-ipad-1194', w: 1194, h: 834 },
    { label: 'np-phone-portrait', w: 390, h: 844 },
    { label: 'np-phone-landscape', w: 844, h: 390 },
];

for (const vp of NOTEPAD_TIERS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    const probe = () => page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const ws = document.getElementById('workspace');
        const area = document.querySelector('.terminal-area');
        const ta = document.getElementById('sessionNotepad');
        const handle = document.getElementById('resizeHandle');
        const toggleNodes = document.querySelectorAll('#notepadToggle').length;
        const cs = getComputedStyle(p);
        const pb = p.getBoundingClientRect();
        const wb = ws.getBoundingClientRect();
        const tb = ta.getBoundingClientRect();
        const cols = getComputedStyle(ws).gridTemplateColumns;
        return {
            position: cs.position,
            // Laid out full size in BOTH states; only the transform differs, so
            // geometry is asserted the same way open or closed.
            ty: Math.round(new DOMMatrixReadOnly(cs.transform).f),
            mobileOpen: p.classList.contains('mobile-open'),
            fullWidth: Math.round(pb.width) === Math.round(wb.width),
            leftFlush: Math.round(pb.left) === Math.round(wb.left),
            trackZero: / 0px$/.test(cols) || !/ /.test(cols),
            areaW: Math.round(area.getBoundingClientRect().width),
            taW: Math.round(tb.width), taH: Math.round(tb.height),
            handleShown: handle ? getComputedStyle(handle).display !== 'none' : false,
            toggleAbsent: toggleNodes === 0,
        };
    });

    const closed = await probe();
    check(`${vp.label}: the Notepad is a bottom sheet, not a side rail`,
        closed.position, 'absolute');
    check(`${vp.label}: closed, it is translated out of view`, closed.ty > 0, true);
    check(`${vp.label}: the resize handle is hidden on touch`, closed.handleShown, false);
    check(`${vp.label}: the desktop collapse toggle is absent (W6)`,
        closed.toggleAbsent, true);

    // v5 section 3 lists Ghi chú among the six touch header actions, so the
    // dock's second Note button (#mobileNotepadBtn) is gone and #notepadOpenBtn
    // is the ONE Notes control at every tier. touch-action-row.js relocates it
    // into #touchActionRow on coarse pointers, so a real click still reaches it.
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(250);
    const open = await probe();
    check(`${vp.label}: the Note entry opens it`, open.mobileOpen, true);
    check(`${vp.label}: open, it rests at translateY 0`, open.ty, 0);
    check(`${vp.label}: it spans the full workspace width`, open.fullWidth, true);
    check(`${vp.label}: its left edge is the workspace's`, open.leftFlush, true);
    check(`${vp.label}: the auxiliary grid track is zero`, open.trackZero, true);
    check(`${vp.label}: the terminal lost NO width`, open.areaW, closed.areaW);
    check(`${vp.label}: the textarea is usable`,
        open.taW >= 200 && open.taH >= 100, true);

    // Keyboard + focus. While the panel was a flow grid child, hiding
    // .terminal-area did not hand it the space -- the row collapsed instead and
    // the iPad textarea measured 239x66, about two visible lines. Out of flow it
    // keeps its own 45dvh height.
    await page.evaluate(() =>
        document.body.classList.add('keyboard-open', 'notepad-focused'));
    await page.waitForTimeout(150);
    const kb = await probe();
    check(`${vp.label}: keyboard-open + focused keeps the sheet rendered`,
        kb.position, 'absolute');
    check(`${vp.label}: it is still full-bleed under the keyboard`, kb.fullWidth, true);
    check(`${vp.label}: the textarea is still usable under the keyboard`,
        kb.taW >= 200 && kb.taH >= 100, true);

    /*
     * RE-TARGETED, not relaxed (S21 item 1, ruled).
     *
     * This row used to assert `display: none` here, from
     * style.css:5088 `body.keyboard-open:not(.notepad-focused) .notepad-panel`.
     * That was right about the INTENT (an unused sheet must not occupy the
     * terminal) and wrong about the MECHANISM, and the mechanism was a defect:
     * `notepad-focused` follows the LIVE focus, so pressing the sheet's own X
     * blurred the note and display:none'd the panel BETWEEN mousedown and
     * mouseup -- Chromium then re-hit-tested mouseup against the vanished
     * subtree and the click landed on .workspace, so the sheet could never be
     * closed by its own button (measured timeline:
     * /tmp/s16work/s21_j1_mech.out). The ruling ordered the rule deleted.
     *
     * The replacement contract, asserted below in three parts rather than one:
     *   - the panel is NEVER display:none on this path (that is the defect);
     *   - it stays hit-testable, which is what makes the close click survive;
     *   - and hiding is done by GEOMETRY: a panel without .mobile-open is
     *     translated out of .workspace, which is position:relative +
     *     overflow:hidden, so it is clipped rather than removed. The old 253px
     *     interactive dead band over the terminal is gone -- proven by
     *     elementFromPoint, not by a style declaration.
     */
    /*
     * The fixture must be a REAL keyboard state before any of this is
     * measurable. `keyboard-open` alone collapses the shell here -- measured
     * ws[0..0] deck[0..65] -- because terminal-manager pins `--app-height` to
     * the visual viewport in production and nothing in this fixture does. The
     * old row could not notice: it read only `display`. Pinned to the D2
     * evidence's own shape (viewport minus a ~253px keyboard).
     */
    await page.evaluate((h) => {
        document.documentElement.style.setProperty('--app-height', (h - 253) + 'px');
        document.body.classList.remove('notepad-focused');
    }, vp.h);
    await page.waitForTimeout(150);
    check(`${vp.label}: keyboard-open + unfocused never display:none's the sheet`,
        await page.evaluate(() =>
            getComputedStyle(document.getElementById('notepadPanel')).display
            !== 'none'),
        true);
    check(`${vp.label}: the sheet stays hit-testable through the whole gesture`,
        await page.evaluate(() => {
            const p = document.getElementById('notepadPanel');
            const r = p.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return 'zero-box';
            /*
             * The MIDPOINT of the panel's intersection with the viewport, not a
             * fixed offset from its top. On a landscape phone the sheet's 45dvh
             * is taller than the keyboard-shrunk workspace, so its top edge sits
             * ABOVE y=0 and a top-anchored probe lands off-screen -- which says
             * nothing about hit-testability. An empty intersection is a real
             * failure and is reported as one.
             */
            const top = Math.max(0, r.top);
            const bottom = Math.min(window.innerHeight, r.bottom);
            if (bottom - top < 2) return 'no-visible-band';
            const y = Math.round((top + bottom) / 2);
            const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2), y);
            return hit && p.contains(hit) ? 'inside-panel'
                : 'elsewhere:' + (hit ? (hit.id || hit.className) : 'null')
                    + '@' + y + ' panel[' + Math.round(r.top) + '..'
                    + Math.round(r.bottom) + ']';
        }),
        'inside-panel');
    // And the CLOSED sheet occupies nothing interactive over the terminal, at
    // the very height the D2 evidence measured a 253px live band.
    await page.evaluate(() => {
        document.getElementById('notepadPanel').classList.remove('mobile-open');
    });
    await page.waitForTimeout(150);
    check(`${vp.label}: closed under the keyboard, nothing of the sheet is hit`,
        await page.evaluate(() => {
            const p = document.getElementById('notepadPanel');
            const ws = document.getElementById('workspace').getBoundingClientRect();
            const hit = document.elementFromPoint(
                Math.round(ws.left + ws.width / 2), Math.round(ws.bottom - 4));
            return !!(hit && p.contains(hit));
        }),
        false);
    await page.evaluate(() => {
        document.getElementById('notepadPanel').classList.add('mobile-open');
        document.documentElement.style.removeProperty('--app-height');
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => document.body.classList.remove('keyboard-open'));
    await page.waitForTimeout(120);

    // Mutual exclusion: opening Command must close the Notepad, never both.
    await page.evaluate(() => document.getElementById('commandLibraryBtn').click());
    await page.waitForTimeout(250);
    const excl = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const r = document.getElementById('commandRail');
        const ws = document.getElementById('workspace');
        return {
            noteOpen: p.classList.contains('mobile-open'),
            railOpen: r.classList.contains('aux-open'),
            bothVisible: p.offsetParent !== null && r.offsetParent !== null,
            cols: getComputedStyle(ws).gridTemplateColumns,
        };
    });
    check(`${vp.label}: opening Command closed the Notepad`, excl.noteOpen, false);
    check(`${vp.label}: the Command rail is the one open`, excl.railOpen, true);
    check(`${vp.label}: never both at once`, excl.bothVisible, false);
    check(`${vp.label}: the track stays zero for the Command sheet`,
        / 0px$/.test(excl.cols) || !/ /.test(excl.cols), true);
    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}

// The inverse contract: a fine-pointer desktop must KEEP the side rail. Without
// this, a future coarse rule that leaked past the capability predicate would
// turn the desktop Notepad into a sheet and no test would notice.
for (const vp of [{ label: 'np-laptop-fine', w: 1280, h: 800 },
                  { label: 'np-desktop-fine', w: 1920, h: 1080 }]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h }, hasTouch: false, isMobile: false,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await seedSessionTabs(page);
    await installTerminal(page);
    await page.waitForTimeout(100);

    /*
     * FIRST-VISIT STATE, asserted before anything is opened (ruling; mockup opens
     * Notes only through its tw5-state-notes state, never by default).
     *
     * This block used to measure the rail immediately after load and expect it to
     * own the auxiliary track -- i.e. Notes open by default. That contradicts the
     * approved missing-key-collapsed rule which panel_contracts.mjs section 3
     * asserts and passes. The collapsed state is now covered here explicitly, and
     * the rail is opened through the production control before its own geometry is
     * measured, so both states are guarded instead of one being inverted.
     */
    const firstVisit = await page.evaluate(() => {
        const ws = document.getElementById('workspace');
        const cols = getComputedStyle(ws).gridTemplateColumns;
        return {
            stored: localStorage.getItem('notepadCollapsed'),
            collapsed: document.getElementById('notepadPanel')
                .classList.contains('collapsed'),
            trackZero: / 0px$/.test(cols) || !/ /.test(cols),
            panelWidth: Math.round(document.getElementById('notepadPanel')
                .getBoundingClientRect().width),
            areaW: Math.round(document.querySelector('.terminal-area')
                .getBoundingClientRect().width),
            wsW: Math.round(ws.getBoundingClientRect().width),
        };
    });
    check(`${vp.label}: first visit stores no Notes preference`,
        firstVisit.stored, null);
    check(`${vp.label}: first visit starts collapsed`, firstVisit.collapsed, true);
    check(`${vp.label}: first visit charges no auxiliary track`,
        firstVisit.trackZero, true);
    check(`${vp.label}: first visit paints no rail width`, firstVisit.panelWidth, 0);
    check(`${vp.label}: first visit gives the terminal the whole workspace`,
        `${firstVisit.areaW}/${firstVisit.wsW}`,
        `${firstVisit.wsW}/${firstVisit.wsW}`);

    /*
     * Open through the production control before measuring the rail.
     *
     * #notepadToggle (the chevron on the resize handle) was withdrawn by the
     * owner (ruling, defect 9) and is now gone from the template
     * (W6). Notes has one opener at every tier, #notepadOpenBtn.
     */
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(320);

    const rail = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const ws = document.getElementById('workspace');
        const area = document.querySelector('.terminal-area');
        const handle = document.getElementById('resizeHandle');
        const toggleNodes = document.querySelectorAll('#notepadToggle').length;
        const pb = p.getBoundingClientRect();
        const wb = ws.getBoundingClientRect();
        const ab = area.getBoundingClientRect();
        const cols = getComputedStyle(ws).gridTemplateColumns;
        return {
            position: getComputedStyle(p).position,
            width: Math.round(pb.width),
            // In flow on the right: the terminal ends where the panel begins.
            pushesTerminal: Math.round(ab.right) <= Math.round(pb.left) + 1,
            rightEdge: Math.round(pb.right) === Math.round(wb.right),
            trackZero: / 0px$/.test(cols) || !/ /.test(cols),
            handleShown: handle ? getComputedStyle(handle).display !== 'none' : false,
            toggleAbsent: toggleNodes === 0,
            mobileBtnShown: (() => {
                const b = document.getElementById('mobileNotepadBtn');
                return b ? b.offsetParent !== null : false;
            })(),
        };
    });
    check(`${vp.label}: the Notepad stays an in-flow side rail`, rail.position, 'static');
    check(`${vp.label}: it occupies the auxiliary track`, rail.trackZero, false);
    check(`${vp.label}: it has a real width`, rail.width > 0, true);
    check(`${vp.label}: it sits at the right edge of the workspace`, rail.rightEdge, true);
    check(`${vp.label}: it pushes the terminal rather than overlaying it`,
        rail.pushesTerminal, true);
    check(`${vp.label}: the resize handle is available`, rail.handleShown, true);
    /*
     * #notepadToggle (the chevron on the resize handle) was withdrawn as an
     * affordance by the owner (ruling, defect 9) and is now gone
     * from the template entirely (W6). Asserting its absence is the contract.
     */
    check(`${vp.label}: the withdrawn collapse chevron is absent (W6)`,
        rail.toggleAbsent, true);
    check(`${vp.label}: the touch Note button is not rendered`, rail.mobileBtnShown, false);

    // Collapse must still round-trip, now through the panel's own close control
    // (#notepadCloseBtn), which is what replaced the withdrawn chevron.
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(320);
    const collapsed = await page.evaluate(() => {
        const ws = document.getElementById('workspace');
        const cols = getComputedStyle(ws).gridTemplateColumns;
        return {
            trackZero: / 0px$/.test(cols) || !/ /.test(cols),
            areaW: Math.round(document.querySelector('.terminal-area')
                .getBoundingClientRect().width),
            wsW: Math.round(ws.getBoundingClientRect().width),
        };
    });
    check(`${vp.label}: collapsing releases the auxiliary track`,
        collapsed.trackZero, true);
    check(`${vp.label}: the terminal reclaims the full workspace`,
        collapsed.areaW, collapsed.wsW);

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(320);
    const reopened = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        return {
            position: getComputedStyle(p).position,
            width: Math.round(p.getBoundingClientRect().width),
        };
    });
    check(`${vp.label}: re-expanding restores the side rail`, reopened.position, 'static');
    check(`${vp.label}: at its original width`, reopened.width, rail.width);
    check(`${vp.label}: no page errors`, errors, []);
    await ctx.close();
}


// Every chip is the selection/lifecycle entry target and must own a real 44px
// vertical hit band. Direction-aware REAL CDP swipes only -- after earlier swipes
// the first chip can sit off-screen LEFT, so a fixed leftward swipe would fail for
// the wrong reason. No scrollLeft writes and no scrollIntoView in reachability:
// neither proves what a finger can reach.
//
// Targeting proof is lifecycleActionTargetId after a real tap on a VERIFIED chip
// point. The point rejects legacy controls and any generic interactive/action
// descendant, so a future overlay cannot steal selection while still passing as
// inert label content. Button enabled-state is a consequence of target presence,
// not evidence of targeting.
//
// Every state selects, including the already-active chip: switchSession routes a
// connected chip to setActivePane, which writes the target unconditionally. The
// notifyActiveSessionChanged early return on previous === current guards only the
// EVENT (protecting an in-flight IME composition), never the target.
{
    const T8_IDS = { live: 't8-live', down: 't8-down', cand: 't8-cand' };
    const t8Swipe = async (cdp, x, y, dx) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
            touchPoints: [{ x, y }] });
        for (let k = 1; k <= 10; k++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
                touchPoints: [{ x: Math.round(x + dx * k / 10), y }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const t8Tap = async (cdp, x, y) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
            touchPoints: [{ x, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // Probe the CHIP: does it own its centre AND a full 44px vertical band?
    //
    // RE-TARGETED from .tab-close to the chip. v5 has no on-chip close: mockup
    // sshdeck-ui-plan-v5.html lines 87-89 (desktop strip) and 150-152 (touch
    // strip) list every child of all six chips -- a status dot and a label
    // group, nothing else -- and line 184 (.tw5-session-actions) puts close in
    // the action sheet as its danger row, "Đóng kết nối". Amendment section 3
    // agrees: "Session row: Không chứa action, spacer hay menu".
    //
    // So the element that must own its centre and a 44px band is the chip, and
    // it is now the SAME element the user taps to select -- which is what
    // section 3 requires ("vẫn bấm được để chọn").
    // Close is covered by session_actions.mjs, which asserts all four
    // sheet actions clear 44px and own their centres at all seven viewports.
    const t8Probe = (sid) => {
        const tab = document.getElementById('tab-' + sid);
        const b = tab.getBoundingClientRect();
        const cx = Math.round(b.left + b.width / 2);
        const cy = Math.round(b.top + b.height / 2);
        const owns = (y) => {
            const el = document.elementFromPoint(cx, y);
            return !!(el && el.closest && el.closest('.session-tab') === tab);
        };
        let top = Math.round(b.top), bot = Math.round(b.bottom);
        while (top - 1 >= 0 && owns(top - 1)) top--;
        while (bot + 1 < window.innerHeight && owns(bot)) bot++;
        const centreOwned = owns(cy);
        const s = document.getElementById('sessionTabs');
        const sb = s.getBoundingClientRect();
        // The close control must NOT be rendered on a touch shell at all.
        const cl = tab.querySelector('.tab-close');
        const closeShown = !!cl && getComputedStyle(cl).display !== 'none';
        const tabCS = getComputedStyle(tab);
        const pillCS = getComputedStyle(tab, '::before');
        // Resolve the pseudo paint against the SAME target box. Unlike the bad
        // audit probe recorded in Entry 21, this includes the actual
        // translateY matrix; ignoring it invented an 8-10px overflow.
        const transformY = (() => {
            const m = pillCS.transform.match(/matrix\(([^)]+)\)/);
            return m ? parseFloat(m[1].split(',')[5]) : 0;
        })();
        const pillTop = b.top + parseFloat(pillCS.top) + transformY;
        const pillH = parseFloat(pillCS.height);
        return { chipCx: cx, chipCy: cy,
            w: Math.round(b.width), h: Math.round(b.height),
            // Native target height, from the token that defines it (44px on
            // every touch tier since the phone-landscape 40px row was retired,
            // owner ruling).
            rowH: Math.round(parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue('--shell-strip'))),
            pillH: Math.round(pillH), pillBoxSizing: pillCS.boxSizing,
            pillGapTop: Math.round((pillTop - b.top) * 10) / 10,
            pillGapBottom: Math.round((b.bottom - (pillTop + pillH)) * 10) / 10,
            ownBackground: tabCS.backgroundColor,
            ownBorderTop: tabCS.borderTopWidth,
            ownBorderBottom: tabCS.borderBottomWidth,
            ownShadow: tabCS.boxShadow,
            centreOwned, ownedH: centreOwned ? (bot - top) : 0,
            reached: centreOwned && (bot - top) >= 44,
            closeShown,
            tabL: Math.round(b.left),
            stripL: Math.round(sb.left), scrollLeft: Math.round(s.scrollLeft),
            swipeCx: Math.round(sb.left + sb.width / 2),
            swipeCy: Math.round(sb.top + sb.height / 2) };
    };
    // Swipe toward the chip until its full hit band is reachable. Zero swipes
    // when it already is; recover rightward when it scrolled off to the left.
    const t8Bring = async (page, cdp, id) => {
        const trace = [];
        for (let i = 0; i < 8; i++) {
            const st = await page.evaluate(t8Probe, id);
            trace.push({ i, sl: st.scrollLeft, tabL: st.tabL,
                centre: st.centreOwned, ownedH: st.ownedH, reached: st.reached });
            if (st.reached) return { ...st, trace };
            const dx = st.tabL < st.stripL ? 120 : -120;
            const before = st.scrollLeft;
            await t8Swipe(cdp, st.swipeCx, st.swipeCy, dx);
            await page.waitForTimeout(180);
            const now = await page.evaluate(() =>
                Math.round(document.getElementById('sessionTabs').scrollLeft));
            if (now === before) break;
        }
        const fin = await page.evaluate(t8Probe, id);
        return { ...fin, trace };
    };
    // A point inside the chip that no interactive/action descendant owns.
    // Verified, not assumed. The centre of the WIDEST contiguous safe run, not
    // the first safe pixel, so a partly clipped chip cannot pass with a sliver.
    const t8SafePoint = (sid) => {
        const tab = document.getElementById('tab-' + sid);
        const tb = tab.getBoundingClientRect();
        const controlSelector = '.tab-close, .tab-edit, .tab-reconnect, button, '
            + 'a, input, select, textarea, [role="button"], [data-lifecycle-action]';
        const cy = Math.round(tb.top + tb.height / 2);
        const runs = [];
        let current = null;
        for (let x = Math.round(tb.left) + 2; x < Math.round(tb.right) - 2; x += 1) {
            const el = document.elementFromPoint(x, cy);
            const safe = el && tab.contains(el)
                && !el.closest(controlSelector);
            if (safe) {
                if (current === null) current = { from: x, to: x };
                else current.to = x;
            } else if (current !== null) {
                runs.push(current);
                current = null;
            }
        }
        if (current !== null) runs.push(current);
        if (!runs.length) {
            return { x: null, y: null, found: false, owner: null, runWidth: 0 };
        }
        const widest = runs.reduce((a, b) =>
            (b.to - b.from) > (a.to - a.from) ? b : a);
        const x = Math.round((widest.from + widest.to) / 2);
        const el = document.elementFromPoint(x, cy);
        return { x, y: cy, found: true,
            owner: el ? (el.className || el.tagName) : null,
            runWidth: widest.to - widest.from + 1 };
    };

    for (const [label, w, h] of [
        ['359x780', 359, 780], ['390x844', 390, 844],
        ['844x390', 844, 390], ['1024x768', 1024, 768],
    ]) {
        const ctx = await browser.newContext({
            viewport: { width: w, height: h }, hasTouch: true, isMobile: true,
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(STUBS);
        await page.goto(base, { waitUntil: 'load' });
        await page.addStyleTag({
            content: '*,*::before,*::after{animation:none!important;transition:none!important}',
        });
        await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
        const cdp = await ctx.newCDPSession(page);
        // Real SessionManager sessions with collision-proof ids: seedSessionTabs
        // injects static markup with no #tab-* ids and no SessionManager entries,
        // so it cannot drive lifecycle selection.
        await page.evaluate((ids) => {
            const SM = SessionManager;
            SM.sessions[ids.live] = { id: ids.live, session_id: ids.live,
                host: 'live.example', port: 22, username: 'sshdeck', authType: 'key',
                keyId: 'k1', jumpHostId: null, displayName: 'Live', connected: true,
                isPersistentCandidate: false, tmuxSessionName: null,
                terminalId: 'term-live', useTmux: false, viaJump: null };
            SM.sessions[ids.down] = { ...SM.sessions[ids.live], id: ids.down,
                session_id: ids.down, displayName: 'Down', connected: false,
                isPersistentCandidate: false, terminalId: null };
            SM.sessions[ids.cand] = { ...SM.sessions[ids.live], id: ids.cand,
                session_id: ids.cand, displayName: 'Cand', connected: false,
                isPersistentCandidate: true, terminalId: null };
            for (const id of [ids.live, ids.down, ids.cand]) {
                if (!document.getElementById('tab-' + id)) {
                    SM.createSessionTab(id, 'h.example', 'sshdeck');
                }
            }
            SM.activeSessionId = ids.live;
            document.getElementById('tab-' + ids.live).classList.add('active');
        }, T8_IDS);
        await page.waitForTimeout(150);

        const baseline = await page.evaluate(() => {
            const hdr = document.querySelector('.header').getBoundingClientRect();
            const t = document.getElementById('terminalsContainer').getBoundingClientRect();
            return { headerH: Math.round(hdr.height),
                termW: Math.round(t.width), termH: Math.round(t.height) };
        });

        for (const [state, id] of [['down', T8_IDS.down], ['cand', T8_IDS.cand],
                                   ['active', T8_IDS.live]]) {
            const r = await t8Bring(page, cdp, id);
            console.log(`    [t8 ${label} ${state}] trace=${JSON.stringify(r.trace)}`);
            check(`tab ${label} ${state}: a real swipe makes the chip reachable`,
                r.reached, true);
            // v5 has no on-chip close (mockup lines 87-89 / 150-152 and 184).
            check(`tab ${label} ${state}: no on-chip close on a touch shell`,
                r.closeShown, false);
            // The mockup's own chip floor, sshdeck-ui-plan-v5.html line 243:
            // `.tw5-session { min-width: 92px; ... }`. With close gone the
            // chip must still be wide enough to read and to hit; this is the
            // horizontal counterpart to the 44px vertical band below.
            check(`tab ${label} ${state}: meets the mockup 92px chip floor`,
                r.w >= 92, true);
            // The element remains the native 44px target (40px in phone
            // landscape); the inner pseudo-element owns the 30px paint. Do NOT
            // collapse these references again -- that was the withdrawn
            // 44-to-30 audit framing in Entry 21.
            check(`tab ${label} ${state}: native target height matches its row`,
                r.h, r.rowH);
            check(`tab ${label} ${state}: inner pill paints exactly 30px`,
                r.pillH, 30);
            check(`tab ${label} ${state}: inner pill uses border-box sizing`,
                r.pillBoxSizing, 'border-box');
            check(`tab ${label} ${state}: target element background is transparent`,
                r.ownBackground, 'rgba(0, 0, 0, 0)');
            check(`tab ${label} ${state}: target element has no top border`,
                r.ownBorderTop, '0px');
            check(`tab ${label} ${state}: target element has no bottom border`,
                r.ownBorderBottom, '0px');
            check(`tab ${label} ${state}: target element has no shadow`,
                r.ownShadow, 'none');
            // Amendment line 54: 7.3/6.7px in a 44px row, every touch tier
            // (the phone-landscape 40px row with its 5.3/4.7 gaps was retired
            //). The user-approved tolerance is 1px.
            const expectedGapTop = 7.3;
            const expectedGapBottom = 6.7;
            check(`tab ${label} ${state}: pill top gap matches amendment line 54`,
                Math.abs(r.pillGapTop - expectedGapTop) <= 1, true);
            check(`tab ${label} ${state}: pill bottom gap matches amendment line 54`,
                Math.abs(r.pillGapBottom - expectedGapBottom) <= 1, true);
            check(`tab ${label} ${state}: owns its own centre`, r.centreOwned, true);
            check(`tab ${label} ${state}: owns a 44px vertical band`,
                r.ownedH >= 44, true);

            const m = await page.evaluate((sid) => {
                const tab = document.getElementById('tab-' + sid);
                const s = document.getElementById('sessionTabs');
                const tb = tab.getBoundingClientRect();
                const hdr = document.querySelector('.header').getBoundingClientRect();
                const t = document.getElementById('terminalsContainer').getBoundingClientRect();
                return { tabH: Math.round(tb.height),
                    stripToken: Math.round(parseFloat(
                        getComputedStyle(document.documentElement)
                            .getPropertyValue('--shell-strip'))),
                    stripScrollH: s.scrollHeight, stripClientH: s.clientHeight,
                    stripScrollTop: s.scrollTop,
                    headerH: Math.round(hdr.height),
                    termW: Math.round(t.width), termH: Math.round(t.height),
                    legacyControls: tab.querySelectorAll(
                        '.tab-edit, .tab-reconnect, .tab-close').length };
            }, id);
            // Painted height tracks the row token (44px on every touch tier);
            // the 44px floor is the hit band above.
            check(`tab ${label} ${state}: the tab did not grow`,
                m.tabH, m.stripToken);
            check(`tab ${label} ${state}: strip scrollHeight equals clientHeight`,
                m.stripScrollH, m.stripClientH);
            check(`tab ${label} ${state}: the strip never scrolls vertically`,
                m.stripScrollTop, 0);
            check(`tab ${label} ${state}: the header is unchanged`,
                m.headerH, baseline.headerH);
            check(`tab ${label} ${state}: the terminal width is unchanged`,
                m.termW, baseline.termW);
            check(`tab ${label} ${state}: the terminal height is unchanged`,
                m.termH, baseline.termH);
            check(`tab ${label} ${state}: no legacy inline actions exist`,
                m.legacyControls, 0);

            // t8Bring above deliberately scrolled the strip until the chip's hit
            // band was reachable, which can leave its body mostly under the header.
            // Selecting by tap is a different gesture with a different precondition: the user
            // taps a chip they can see. Bring the chip fully into view first, so
            // this section tests selection rather than re-testing the scroll
            // position the previous section just established. The tap itself is
            // still a real synthetic touch at a measured, verified-safe point.
            await page.evaluate((sid) => {
                document.getElementById('tab-' + sid)
                    .scrollIntoView({ block: 'nearest', inline: 'center' });
            }, id);
            await page.waitForTimeout(180);

            const safe = await page.evaluate(t8SafePoint, id);
            check(`tab-tap ${label} ${state}: a safe non-action tap point exists`,
                safe.found, true);
            // The safe run must itself clear the 44px touch floor. Otherwise a
            // chip could pass through a narrow inert sliver while an interactive
            // descendant owns the area where a real finger lands.
            check(`tab-tap ${label} ${state}: the safe run is a real target, not a sliver`,
                safe.runWidth >= 44, true);
            await page.evaluate(() => {
                document.getElementById('mobileInput')?.blur();
                SessionManager.setLifecycleActionTarget(null);
            });
            await t8Tap(cdp, safe.x, safe.y);
            await page.waitForTimeout(200);
            const sel = await page.evaluate((sid) => ({
                target: SessionManager.lifecycleActionTargetId,
                activeSessionId: SessionManager.activeSessionId,
                marked: document.getElementById('tab-' + sid)
                    .classList.contains('lifecycle-target'),
                disabled: ['sessionActionRename', 'sessionActionReconnect',
                    'sessionActionReset'].map(b => document.getElementById(b)?.disabled),
                exists: !!SessionManager.sessions[sid],
                composerFocused: document.activeElement
                    === document.getElementById('mobileInput'),
                keyboardOpen: document.body.classList.contains('keyboard-open') }), id);
            console.log(`    [t8 ${label} ${state}] safe=${JSON.stringify(safe)} sel=${JSON.stringify(sel)}`);

            check(`tab-tap ${label} ${state}: a real tap selects the lifecycle target`,
                sel.target, id);
            check(`tab-tap ${label} ${state}: the chip shows the selected ring`,
                sel.marked, true);
            check(`tab-tap ${label} ${state}: a target enables all three controls`,
                sel.disabled.join(','), 'false,false,false');
            check(`tab-tap ${label} ${state}: the active pane is not evicted`,
                sel.activeSessionId, T8_IDS.live);
            check(`tab-tap ${label} ${state}: the composer keeps focus away`,
                sel.composerFocused, false);
            check(`tab-tap ${label} ${state}: no keyboard is summoned`,
                sel.keyboardOpen, false);
            check(`tab-tap ${label} ${state}: the session fixture survives`,
                sel.exists, true);
        }
        check(`tab ${label}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
