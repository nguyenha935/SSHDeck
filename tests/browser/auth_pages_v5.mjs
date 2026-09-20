/*
 * The four converted auth pages, measured against the v5 rulings.
 *
 * These are the SHIPPED templates (templates/login.html, register.html,
 * change_password.html, admin.html), rendered through the same Jinja
 * substitution the other browser suites use, not a hand-written fixture. A
 * test that writes its own markup agrees with itself and proves nothing; this
 * repository has already shipped false-green tests that way.
 *
 * What is asserted, and why each one is here rather than assumed:
 *
 *   - 44px floor on every interactive control, at every viewport, with the
 *     LABEL measured for a wrapped checkbox ([INF-5], the rule modal_narrow
 *     already enforces). This is the INF-4 ruling made testable.
 *   - All 10 themes resolve. A theme that fails to apply does not throw; it
 *     silently leaves the tokens empty, so it must be measured.
 *   - No horizontal overflow at 359px (narrowest supported) and 926x428
 *     (phone landscape).
 *   - [INF-6](a) admin reflows to STACKED CARDS on a phone. `overflow-x:auto`
 *     would pass a naive "document does not overflow" check while still
 *     forcing a sideways drag per row, so this asserts the reflow itself:
 *     cells become block-level, the header row leaves layout, and every cell
 *     carries a data-label. It also asserts the table is NOT wider than the
 *     viewport, which is the user-visible consequence.
 *   - [INF-6](b) every row action stays >=44px in the stacked form.
 *   - Zero emoji and zero Lucide runtime on any converted page.
 *   - Every backend/JS contract hook survives the restyle.
 *
 * Run: node tests/browser/auth_pages_v5.mjs   (from source/)
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
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
};

/*
 * Render a shipped template. Only Jinja syntax is substituted -- no markup is
 * added, removed or rewritten, so what is measured is what ships.
 *
 * `theme` is substituted to a real theme name so the data-theme attribute is
 * meaningful; everything else collapses the way the other suites do it.
 */
function renderTemplate(rel, theme) {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    // The theme expression, in both the bare and |default forms the templates use.
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'testadmin');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    // Exercise the flash branch: keep the block, drop the Jinja control flow.
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{[^}]*\}\}/g, '');
    return html;
}

function startServer(routes) {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (routes[rel]) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(routes[rel]());
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
const failures = [];

function check(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(`FAIL  ${name}\n      got  ${JSON.stringify(got)}`
            + `\n      want ${JSON.stringify(want)}`);
    }
}

// 10 themes: glass IS :root (no body[data-theme] block), plus the nine at
// static/css/style.css:312-829.
const THEMES = ['glass', 'retro', 'solar', 'paper', 'noir', 'arctic-ice',
                'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];

const PAGES = [
    { name: 'login', tpl: 'templates/login.html', url: '/login' },
    { name: 'register', tpl: 'templates/register.html', url: '/register' },
    { name: 'change_password', tpl: 'templates/change_password.html', url: '/change_password' },
    { name: 'admin', tpl: 'templates/admin.html', url: '/admin' },
];

// The canonical set, from tests/browser/mobile_shell_layout.mjs:107-131.
//
// 390x844 is an ADDITION to that canonical list, not a copy of it. It is the
// iPhone 12/13/14/15 logical viewport and the single most common phone width in
// use; testing 359 and 428 either side of it left the most likely real-world
// width untested, and a clipped-viewport defect on the auth pages was found by
// eye at 390 that no assertion at 359 or 428 reported.
const VIEWPORTS = [
    { label: 'phone-small', w: 359, h: 800, touch: true },
    { label: 'phone-390', w: 390, h: 844, touch: true },
    { label: 'phone', w: 428, h: 926, touch: true },
    { label: 'landscape', w: 926, h: 428, touch: true },
    { label: 'tablet', w: 768, h: 1024, touch: true },
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true },
    { label: 'laptop', w: 1280, h: 800, touch: false },
    { label: 'desktop', w: 1920, h: 1080, touch: false },
];

let currentTheme = 'glass';
const routes = {};
for (const p of PAGES) {
    routes[p.url] = () => renderTemplate(p.tpl, currentTheme);
}

const server = await startServer(routes);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const pageErrors = [];

// Seed the admin tables so the reflow has real rows to measure. This mirrors
// what admin.js renderUsers/renderAudit produce, including applyColumnLabels.
async function seedAdminTables(page) {
    await page.evaluate(() => {
        const usersBody = document.getElementById('adminUsersBody');
        const mk = (u) => {
            const tr = document.createElement('tr');
            tr.dataset.userId = u.id;
            tr.innerHTML =
                `<td>${u.id}</td>` +
                `<td>${u.username}</td>` +
                `<td><span class="admin-badge">User</span></td>` +
                `<td><span class="admin-badge">Active</span></td>` +
                `<td>2026-07-01</td>` +
                `<td>2026-08-06</td>` +
                `<td><div class="a5-row-actions admin-actions">` +
                `<button class="a5-btn btn btn-secondary" data-act="promote">Promote</button>` +
                `<button class="a5-btn btn btn-secondary" data-act="lock">Lock</button>` +
                `<button class="a5-btn a5-btn-danger btn btn-danger" data-act="delete">Delete</button>` +
                `</div></td>`;
            return tr;
        };
        usersBody.appendChild(mk({ id: 1, username: 'testadmin' }));
        usersBody.appendChild(mk({ id: 2, username: 'alice' }));

        // The same mirroring admin.js applyColumnLabels() performs.
        const table = document.getElementById('adminUsersTable');
        const headers = Array.from(table.querySelectorAll('thead th'))
            .map(th => th.textContent.trim());
        table.querySelectorAll('tbody tr').forEach(tr => {
            Array.from(tr.children).forEach((td, i) => {
                const isLast = i === headers.length - 1;
                td.setAttribute('data-label', isLast ? '' : (headers[i] || ''));
            });
        });
    });
}

/* ---------------------------------------------------------------------------
 * 1. Geometry and themes, every page x viewport x theme.
 * ------------------------------------------------------------------------ */
for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.touch, isMobile: vp.touch,
    });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(`${vp.label}: ${e}`));

    for (const p of PAGES) {
        for (const theme of THEMES) {
            currentTheme = theme;
            await page.goto(`${base}${p.url}`, { waitUntil: 'load' });
            await page.evaluate(() => {
                const st = document.createElement('style');
                st.textContent =
                    '*,*::before,*::after{transition:none!important;animation:none!important}';
                document.head.appendChild(st);
            });
            if (p.name === 'admin') await seedAdminTables(page);

            const m = await page.evaluate(() => {
                const small = [];
                document.querySelectorAll(
                    'button, a[href], input, select, textarea').forEach(el => {
                    const cs = getComputedStyle(el);
                    if (cs.display === 'none' || cs.visibility === 'hidden') return;
                    if (el.closest('[aria-hidden="true"], [hidden], .hidden')) return;
                    let rect = el.getBoundingClientRect();
                    if (rect.width < 1 || rect.height < 1) return;
                    if (el.tagName === 'INPUT'
                        && (el.type === 'checkbox' || el.type === 'radio')) {
                        const lab = el.closest('label')
                            || (el.id && document.querySelector(`label[for="${el.id}"]`));
                        if (lab) rect = lab.getBoundingClientRect();
                    }
                    if (el.type === 'hidden') return;
                    if (rect.width < 44 || rect.height < 44) {
                        small.push(`${el.id || el.className || el.tagName}:`
                            + `${Math.round(rect.width)}x${Math.round(rect.height)}`);
                    }
                });

                const bs = getComputedStyle(document.body);
                const tokens = {
                    bg: bs.getPropertyValue('--bg-primary').trim(),
                    text: bs.getPropertyValue('--text-primary').trim(),
                    accent: bs.getPropertyValue('--accent-primary').trim(),
                    border: bs.getPropertyValue('--border-color').trim(),
                };

                // No decorative glyph should exceed the 56px brand mark. An
                // unsized <svg> renders at 300x150, so this catches it by an
                // order of magnitude rather than by a tight bound.
                const icons = Array.from(document.querySelectorAll('svg'));
                const oversizedIcons = icons.map(s => {
                    const q = s.getBoundingClientRect();
                    return (q.width > 56 || q.height > 56)
                        ? `${Math.round(q.width)}x${Math.round(q.height)}` : null;
                }).filter(Boolean);

                return {
                    small,
                    overflow: Math.max(0,
                        document.documentElement.scrollWidth - window.innerWidth),
                    unresolved: Object.entries(tokens)
                        .filter(([, v]) => !v).map(([k]) => k),
                    textIsBg: !!tokens.text && tokens.text === tokens.bg,
                    themeAttr: document.body.getAttribute('data-theme'),
                    oversizedIcons,
                    iconCount: icons.length,
                    lastControlReachable: (() => {
                        const de = document.documentElement;
                        const ctrls = Array.from(document.querySelectorAll(
                            'button, a[href], input:not([type=hidden]), select'))
                            .filter(e => e.offsetParent !== null);
                        if (!ctrls.length) { return true; }
                        const last = ctrls[ctrls.length - 1];
                        const y = window.scrollY;
                        window.scrollTo(0, de.scrollHeight);
                        const q = last.getBoundingClientRect();
                        const ok = q.bottom <= de.clientHeight + 1 && q.top >= -1;
                        window.scrollTo(0, y);
                        return ok;
                    })(),
                };
            });

            const at = `${p.name}@${vp.label}/${theme}`;
            check(`${at}: every control reaches 44px`, m.small, []);
            check(`${at}: no horizontal overflow`, m.overflow, 0);
            check(`${at}: all theme tokens resolve`, m.unresolved, []);
            check(`${at}: text is not the background colour`, m.textIsBg, false);
            check(`${at}: data-theme applied`, m.themeAttr, theme);
            /*
             * An <svg> with no intrinsic size and no CSS size falls back to the
             * SVG default 300x150 and paints over the card. That actually
             * shipped in the first screenshot pass and EVERY geometry assertion
             * above still passed -- the controls were all >=44px and nothing
             * overflowed, so only a rendered pixel showed it. This is the
             * assertion that would have caught it.
             */
            check(`${at}: no icon renders oversized`, m.oversizedIcons, []);
            check(`${at}: icons actually rendered`, m.iconCount > 0, true);

            /*
             * The document must never CLIP its own content away.
             *
             * The auth pages share <body> with the terminal shell, and
             * style.css:238-265 locks the shell to `overflow: hidden` with
             * `height: 100dvh` so the PTY can never scroll the page. That is
             * correct for the shell and WRONG for a document-flow form, which is
             * as tall as its fields. style.css:267-272 repairs it, but only
             * inside `@media (max-width: 767px)` -- and the 926x428 phone
             * LANDSCAPE viewport is 926px WIDE, so it sat above that breakpoint
             * and never got the repair.
             *
             * Measured before the fix at 926x428: scrollHeight == clientHeight
             * (the overflow was clipped away, so the page did not even report
             * itself as scrollable) while the last control sat below the fold and
             * window.scrollTo() moved nothing. Login was impossible in phone
             * landscape. Measured after: 223px of real scroll range and the last
             * control reachable.
             *
             * Asserted as reachability, not as a height number: if the content is
             * taller than the viewport, scrolling to the end must bring the last
             * interactive control fully into view. A pure "does it overflow"
             * check cannot see this bug, because clipping makes the overflow
             * invisible to the very property you would test.
             */
            check(`${at}: last control reachable after scrolling to the end`,
                m.lastControlReachable, true);
        }
    }
    await context.close();
}

/* ---------------------------------------------------------------------------
 * 2. [INF-6](a) admin reflows to stacked cards on a phone -- and does NOT
 *    merely gain a horizontal scrollbar.
 *
 * The reflow breakpoint is 700px. 926x428 (phone landscape) is WIDER than
 * that and deliberately keeps the real table: at 926px the columns fit, and
 * the scarce axis there is height, not width (amendment line 55 compresses
 * the shell for the same reason). So landscape is asserted against the
 * condition that actually matters -- no sideways drag -- rather than being
 * forced into a stacked form it does not need.
 * ------------------------------------------------------------------------ */
currentTheme = 'glass';
for (const vp of [{ label: 'phone-small', w: 359, h: 800, stacks: true },
                  { label: 'phone', w: 428, h: 926, stacks: true },
                  { label: 'landscape', w: 926, h: 428, stacks: false }]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(`reflow-${vp.label}: ${e}`));
    await page.goto(`${base}/admin`, { waitUntil: 'load' });
    await seedAdminTables(page);

    const r = await page.evaluate(() => {
        const table = document.getElementById('adminUsersTable');
        const wrap = table.closest('.a5-table-wrap');
        const firstCell = table.querySelector('tbody td');
        const thead = table.querySelector('thead');
        const cells = Array.from(table.querySelectorAll('tbody td'));
        const actions = Array.from(
            table.querySelectorAll('tbody .a5-row-actions button'));

        return {
            // In the stacked form a cell is laid out as a flex row (label left,
            // value right) -- the point is that it is NOT a table-cell any more.
            cellDisplay: getComputedStyle(firstCell).display,
            headPosition: getComputedStyle(thead).position,
            missingLabels: cells.filter(td => !td.hasAttribute('data-label')).length,
            // The user-visible consequence, asserted at EVERY width.
            tableWider: Math.max(0, table.scrollWidth - window.innerWidth),
            wrapScrolls: wrap.scrollWidth > wrap.clientWidth + 1,
            smallActions: actions.map(b => {
                const q = b.getBoundingClientRect();
                return (q.height < 44 || q.width < 44)
                    ? `${b.dataset.act}:${Math.round(q.width)}x${Math.round(q.height)}` : null;
            }).filter(Boolean),
            actionCount: actions.length,
        };
    });

    const at = `admin reflow @ ${vp.label}`;
    if (vp.stacks) {
        check(`${at}: cells are no longer table-cells`,
            r.cellDisplay !== 'table-cell', true);
        check(`${at}: cells stack as flex rows`, r.cellDisplay, 'flex');
        check(`${at}: header row is removed from layout`, r.headPosition, 'absolute');
        check(`${at}: every cell carries a data-label`, r.missingLabels, 0);
    } else {
        check(`${at}: keeps the real table above the breakpoint`,
            r.cellDisplay, 'table-cell');
    }
    // Both forms must satisfy this: it is the whole point of the condition.
    check(`${at}: table is not wider than the viewport`, r.tableWider, 0);
    check(`${at}: wrapper does not scroll sideways`, r.wrapScrolls, false);
    check(`${at}: row actions were rendered`, r.actionCount > 0, true);
    check(`${at}: every row action reaches 44px`, r.smallActions, []);
    await ctx.close();
}

// And the converse: on a wide viewport it is still a real table.
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/admin`, { waitUntil: 'load' });
    await seedAdminTables(page);
    const d = await page.evaluate(() => ({
        cell: getComputedStyle(document.querySelector('#adminUsersTable tbody td')).display,
        head: getComputedStyle(document.querySelector('#adminUsersTable thead')).position,
    }));
    check('admin @ laptop: still a real table', d.cell, 'table-cell');
    check('admin @ laptop: header row is in layout', d.head, 'static');
    await ctx.close();
}

/* ---------------------------------------------------------------------------
 * 2b. A toast must never cover the only way off the admin page.
 *
 * The shared toast stack is `.notification-container { position: fixed;
 * top: 24px; right: 24px; z-index: 11000 }` (style.css:4132) and admin.html
 * puts the "Back to Terminal" link in that same corner in normal flow
 * (admin.html:46-51), so the two collide by construction.
 *
 * Why this needs its OWN assertion rather than riding on the geometry checks
 * above: every existing admin assertion is a FLOOR (>=44px, no overflow, still
 * a table). None of them can see two elements that are each perfectly sized but
 * STACKED ON TOP OF EACH OTHER -- which is exactly Entry 11's lesson that a
 * geometry-floor set proves a minimum, never an appearance. Measured before the
 * fix: 147x36 px of cover at 834/926/390, and elementFromPoint() at the LINK'S
 * OWN CENTRE returned the toast, i.e. the link was genuinely unclickable.
 *
 * The hit test is the load-bearing half. A pure rect-overlap check would pass
 * the moment the boxes were nudged apart by a pixel while the toast still ate
 * the clicks, so the assertion is "is the link still the top element at its own
 * centre", not merely "do the rectangles miss each other".
 */
for (const vp of [
    { label: 'laptop', w: 1440, h: 900 },
    { label: 'tablet', w: 834, h: 1194 },
    { label: 'phone-landscape', w: 926, h: 428 },
    { label: 'phone-390', w: 390, h: 844 },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: vp.w <= 926, isMobile: vp.w <= 926,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/admin`, { waitUntil: 'load' });

    /* Raise the toast, THEN let its entry animation finish before measuring.
     *
     * `.notification` carries `animation: notificationSlideIn 0.4s` (style.css),
     * so for the first 400ms the element sits at its pre-animation offset --
     * off-screen to the right. Measuring immediately reads that transient rect,
     * which never overlaps anything, and the assertion passes no matter where
     * the container is anchored. Proven: with the fix mutated back to
     * `top: 24px` the suite still reported 0 failures until this wait was
     * added, while a standalone probe that happened to wait 350ms saw the full
     * 147x36 overlap. A settled rect is the only one worth asserting on.
     */
    await page.evaluate(() => {
        const cont = document.getElementById('notificationContainer');
        if (!cont) { return; }
        const el = document.createElement('div');
        el.className = 'notification notification-error';
        el.textContent = 'Request failed (500)';
        cont.appendChild(el);
    });
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => {
        const back = document.querySelector('.a5-topbar-actions .a5-btn');
        const el = document.querySelector('#notificationContainer .notification');
        if (!back || !el) { return { missing: true }; }

        const B = back.getBoundingClientRect();
        const T = el.getBoundingClientRect();
        const ox = Math.min(B.right, T.right) - Math.max(B.left, T.left);
        const oy = Math.min(B.bottom, T.bottom) - Math.max(B.top, T.top);
        const top = document.elementFromPoint(B.left + B.width / 2, B.top + B.height / 2);
        return {
            missing: false,
            toastRaised: T.height > 0,
            // A toast parked outside the viewport would make "no overlap"
            // vacuous, so require it to be on-screen before trusting the result.
            // innerWidth/innerHeight, NOT clientWidth/clientHeight: under
            // `isMobile: true` Chromium reserves a ~13px scrollbar gutter, so the
            // client box is smaller than the CSS viewport and a correctly-placed
            // toast reads as off-screen against it. That produced 4 false
            // OFF-SCREEN flags in a standalone probe before being corrected.
            toastOnScreen: T.top >= -1 && T.left >= -1
                && T.right <= window.innerWidth + 1 && T.bottom <= window.innerHeight + 1,
            overlaps: ox > 0 && oy > 0,
            backClickable: !!(top && (top === back || back.contains(top))),
        };
    });

    const at = `admin toast @ ${vp.label}`;
    check(`${at}: the back link and the toast container both exist`, r.missing, false);
    // Guards the guard: if no toast actually rendered, or it rendered off to the
    // side, "no overlap" would be vacuously true and this block would assert
    // nothing at all.
    check(`${at}: a toast really was raised`, r.toastRaised, true);
    check(`${at}: the toast is inside the viewport`, r.toastOnScreen, true);
    check(`${at}: toast does not overlap the back link`, r.overlaps, false);
    check(`${at}: back link is still the hit target at its own centre`, r.backClickable, true);

    /* The SECOND occlusion, and the reason this block asserts on the tab row too.
     *
     * Clearing the topbar alone moved the toast down onto the tab strip rather
     * than out of the way: at 390x844 it covered the Settings tab by 2394px^2
     * (3577 at 359x800) and elementFromPoint at that tab's own centre returned
     * the toast. Every assertion above still passed, because the back link was
     * genuinely clear -- so "the back link is reachable" does not imply "the
     * page is usable". Each control the toast can reach needs its own hit test.
     *
     * Wider viewports never overlapped (the three tabs end long before the
     * toast starts), so a desktop-only check would also have missed it. The
     * phone widths are the ones that bite.
     */
    const tabs = await page.evaluate(() => {
        const el = document.querySelector('#notificationContainer .notification');
        if (!el) { return null; }
        const T = el.getBoundingClientRect();
        /* Collect every visible interactive control rather than a hand-listed
         * set, so a control added later cannot silently escape the check.
         * Skip zero-area and clipped elements: a rect that paints nowhere
         * cannot be occluded (the admin thead is absolute 1x1 with
         * clip-path: inset(50%) and would otherwise report a bogus rect).
         */
        const hidden = (n) => {
            for (let q = n; q && q !== document.documentElement; q = q.parentElement) {
                const cs = getComputedStyle(q);
                if (cs.display === 'none' || cs.visibility === 'hidden'
                    || Number(cs.opacity) === 0 || cs.clipPath !== 'none') { return true; }
            }
            return false;
        };
        const sel = 'button, a[href], input, select, textarea, [role="tab"],'
            + ' [tabindex]:not([tabindex="-1"])';
        const controls = [...document.querySelectorAll(sel)].filter((n) => {
            const R = n.getBoundingClientRect();
            return R.width > 1 && R.height > 1 && !el.contains(n) && !hidden(n);
        });
        return controls.map((tab) => {
            const B = tab.getBoundingClientRect();
            const ox = Math.min(B.right, T.right) - Math.max(B.left, T.left);
            const oy = Math.min(B.bottom, T.bottom) - Math.max(B.top, T.top);
            const top = document.elementFromPoint(B.left + B.width / 2, B.top + B.height / 2);
            return {
                label: (tab.textContent || tab.getAttribute('aria-label')
                    || tab.tagName).trim().slice(0, 24),
                // The acceptance number is the OVERLAP AREA, not the hit test.
                // A control that is half-covered but still hittable at its
                // centre is a defect; the hit test is kept only as a
                // corroborating signal.
                overlap: Math.round(Math.max(0, ox) * Math.max(0, oy)),
                clickable: !!(top && (top === tab || tab.contains(top))),
            };
        });
    });
    // Would-be-vacuous guard: if the tab strip were absent or empty, a forEach
    // over it would assert nothing while looking green.
    check(`${at}: interactive controls were actually collected`,
        Array.isArray(tabs) && tabs.length >= 3, true);
    for (const t of (tabs || [])) {
        check(`${at}: toast overlaps "${t.label}" by 0px2`, t.overlap, 0);
        check(`${at}: "${t.label}" is still the hit target at its own centre`, t.clickable, true);
    }

    /* The anchor TIER, not just the outcome.
     *
     * "0 overlap" can be true for the wrong reason -- e.g. the toast never
     * painted, or a future edit happens to shrink the tab row. So assert the
     * mechanism directly: on the narrow tier the toast must sit in the bottom
     * half of the viewport with its gap to the bottom edge equal to the derived
     * max(--a5-gap, safe-area-inset-bottom); everywhere else it stays top-right
     * exactly as before.
     *
     * The narrow tier deliberately matches on EITHER width or short-landscape.
     * Width alone is not enough: phone landscape is 926px WIDE, well above the
     * 767px canonical breakpoint, so a width-only query leaves the single most
     * chrome-crowded viewport on the desktop tier.
     */
    const anch = await page.evaluate(() => {
        const el = document.querySelector('#notificationContainer .notification');
        if (!el) { return null; }
        /* Measure the CONTAINER, not the first .notification. The container is
         * what the media query anchors, and toasts stack inside it -- with two
         * queued, querySelector returns the UPPER one, whose distance to the
         * bottom edge includes the toast below it (that read 70px instead of 8).
         */
        const cont = document.getElementById('notificationContainer');
        if (!cont) { return null; }
        const T = cont.getBoundingClientRect();
        // The a5 tokens are declared on `.a5`, not on :root, and custom-property
        // substitution resolves against the element the property is DECLARED on.
        // Reading them off documentElement yields an empty string.
        const gap = getComputedStyle(document.querySelector('.a5') || cont)
            .getPropertyValue('--a5-gap').trim();
        return {
            narrowTier: matchMedia('(max-width: 767px)').matches
                || matchMedia('(max-height: 480px) and (orientation: landscape)').matches,
            inBottomHalf: T.top > window.innerHeight / 2,
            gapBottom: Math.round(window.innerHeight - T.bottom),
            gapToken: parseInt(gap, 10),
        };
    });
    check(`${at}: the toast was measurable for the anchor check`, anch !== null, true);
    if (anch) {
        check(`${at}: narrow tier bottom-anchors the toast`,
            anch.narrowTier ? anch.inBottomHalf : !anch.inBottomHalf, true);
        if (anch.narrowTier) {
            // Derived from the token, not a literal: --a5-gap is the floor and
            // headless Chromium reports a 0 safe-area inset, so max() == the gap.
            check(`${at}: bottom gap equals max(--a5-gap, safe-area-inset-bottom)`,
                anch.gapBottom, anch.gapToken);
        }
    }
    await ctx.close();
}

/* ---------------------------------------------------------------------------
 * 2c. A footer link must be identifiable as a link in EVERY theme.
 *
 * Two independent reasons the affordance cannot rest on colour alone:
 *
 * 1. TOUCH. The previous rule was `text-decoration: none` with the underline
 *    only on `:hover`. Hover does not exist on a touchscreen, so on every phone
 *    in all ten themes these links had NO affordance whatsoever. Touch is the
 *    project's first stated priority, so this alone is disqualifying.
 *
 * 2. OBSIDIAN's palette. Mockup line 219 sets `--tw-accent:#fff` AND
 *    `--tw-text:#fff` on `--tw-shell:#000`: the accent is deliberately the same
 *    colour as primary text. Measured in the shipped stylesheet, obsidian's
 *    --accent-primary and --text-primary are both #ffffff. So a link cannot be
 *    distinguished from primary body copy by hue on that theme at all.
 *
 *    NOTE, measured rather than assumed: the .a5-footer WRAPPER uses
 *    --text-secondary (#b8b8b8 in obsidian), not --text-primary, so the link
 *    (#ffffff) and the footer prose around it are 255 vs 184 -- close, but not
 *    identical. An earlier version of this comment claimed they were identical;
 *    that was wrong about the element. The accent==text collision is real but
 *    lives on --text-primary, which is what the card body uses.
 *
 * Fixing this with a colour is prohibited by amendment line 109 ("mọi theme
 * hiện có vẫn hoạt động; không hardcode lại theme hoặc đổi token ngoài phạm
 * vi"), and obsidian's accent==text is intentional. An underline carries no
 * colour of its own, so it cannot break a palette and works in all 10 themes.
 *
 * The assertion deliberately does NOT grep the stylesheet for "underline" --
 * that passes on a sheet where a later rule resets it, the cascade trap this
 * project has already hit four times. It reads the COMPUTED style after
 * switching data-theme, per theme.
 */
{
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: 'load' });

    for (const theme of THEMES) {
        const r = await page.evaluate((t) => {
            document.body.setAttribute('data-theme', t);
            const a = document.querySelector('.a5-footer a');
            if (!a) { return { missing: true }; }
            const cs = getComputedStyle(a);
            return {
                missing: false,
                line: cs.textDecorationLine,
                thickness: cs.textDecorationThickness,
            };
        }, theme);

        const at = `footer link @ ${theme}`;
        check(`${at}: the footer link exists`, r.missing, false);
        check(`${at}: carries a persistent underline`, r.line, 'underline');
        // Not merely declared: a 0px rule paints nothing.
        check(`${at}: the underline has non-zero thickness`,
            r.thickness !== '0px' && r.thickness !== 'auto0px', true);
    }

    /* Guards the guard. If NO theme actually had accent==text, the underline
     * could be traded back for colour and nothing here would fail. Obsidian is
     * that theme (mockup line 219), so pin the collision itself -- on
     * --text-primary, which is where it really is. */
    const obsidian = await page.evaluate(() => {
        document.body.setAttribute('data-theme', 'obsidian');
        const cs = getComputedStyle(document.body);
        return {
            accent: cs.getPropertyValue('--accent-primary').trim().toLowerCase(),
            textPrimary: cs.getPropertyValue('--text-primary').trim().toLowerCase(),
        };
    });
    check('obsidian really is the accent==text-primary case the underline exists for',
        obsidian.accent === obsidian.textPrimary, true);

    await ctx.close();
}

/* ---------------------------------------------------------------------------
 * 3. Identity and contracts: source-level, so a regression is caught even if
 *    it never reaches a rendered pixel.
 * ------------------------------------------------------------------------ */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
for (const p of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, p.tpl), 'utf8');
    check(`${p.name}: no emoji glyphs remain`, EMOJI.test(src), false);
    check(`${p.name}: no Lucide runtime`, /data-lucide|lucide\.min|createIcons/.test(src), false);
    check(`${p.name}: uses the shipped sprite`, src.includes('icons/icons.svg'), true);
    check(`${p.name}: carries the v5 stylesheet`, src.includes('auth-v5.css'), true);
    check(`${p.name}: body carries the a5 root class`, /<body class="a5"/.test(src), true);
}

// Backend contracts that a restyle must not drop.
const login = fs.readFileSync(path.join(ROOT, 'templates/login.html'), 'utf8');
const register = fs.readFileSync(path.join(ROOT, 'templates/register.html'), 'utf8');
const changePw = fs.readFileSync(path.join(ROOT, 'templates/change_password.html'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'templates/admin.html'), 'utf8');

for (const [label, src] of [['login', login], ['register', register],
                            ['change_password', changePw]]) {
    check(`${label}: CSRF token input preserved`,
        src.includes('name="csrf_token"') && src.includes('csrf_token()'), true);
    check(`${label}: flash message loop preserved`,
        src.includes('get_flashed_messages(with_categories=true)'), true);
    check(`${label}: password toggle hook preserved`,
        src.includes('class="a5-toggle password-toggle"'), true);
}

check('login: remember checkbox preserved', login.includes('name="remember"'), true);
check('login: registration gate preserved', login.includes('registration_enabled'), true);
check('login: hint ids auth.js looks up',
    login.includes('id="loginUsernameHint"') && login.includes('id="loginPasswordHint"'), true);
check('register: username pattern constraint preserved',
    register.includes('pattern="[a-zA-Z0-9_]{3,32}"'), true);
check('register: password minlength preserved', register.includes('minlength="8"'), true);
check('register: submit guard form id preserved', register.includes('id="registerForm"'), true);
check('register: match indicator id preserved',
    register.includes('id="passwordMatchIndicator"'), true);
check('change_password: submit guard form id preserved',
    changePw.includes('id="changePasswordForm"'), true);
check('change_password: all three field names preserved',
    changePw.includes('name="current_password"')
    && changePw.includes('name="new_password"')
    && changePw.includes('name="confirm_password"'), true);
check('change_password: hint ids auth.js looks up',
    changePw.includes('id="currentPasswordHint"')
    && changePw.includes('id="newPasswordHint"')
    && changePw.includes('id="confirmPasswordHint"'), true);

const ADMIN_IDS = ['adminUsersTable', 'adminUsersBody', 'adminAuditTable',
    'adminAuditBody', 'adminAddUserBtn', 'adminRefreshUsers', 'auditSearch',
    'auditLevel', 'auditRefresh', 'auditPrev', 'auditNext', 'auditPageInfo',
    'settingRegistration', 'addUserModal', 'closeAddUser', 'newUsername',
    'newPassword', 'newIsAdmin', 'submitNewUser', 'notificationContainer'];
check('admin: every admin.js hook id preserved',
    ADMIN_IDS.filter(id => !admin.includes(`id="${id}"`)), []);
check('admin: tab hooks preserved',
    admin.includes('class="a5-tab admin-tab active" data-tab="users"'), true);
check('admin: modal shell contract preserved',
    admin.includes('modal modal-small modal-shell') && admin.includes('class="close"'), true);
check('admin: csrf meta preserved', admin.includes('name="csrf-token"'), true);

// W8: create-user form now carries the v5 icon system like every other auth form.
check('admin: username field has leading icon in input-wrap',
    admin.includes('a5-input-wrap') && admin.includes('#icon-contact-round'), true);
check('admin: password field has lock icon',
    admin.includes('#icon-lock'), true);
check('admin: password reveal toggle wired to newPassword',
    admin.includes('class="a5-toggle password-toggle" data-target="newPassword"'), true);
check('admin: submit button has trailing arrow-right icon',
    /id="submitNewUser"[^]*#icon-arrow-right/.test(admin), true);
check('admin: auth.js loaded for password-toggle hook',
    admin.includes("filename='js/auth.js'"), true);

/*
 * CACHE PINS for the two auth-page scripts.
 *
 * auth.js and admin.js were the last shipped frontend files in this tree with no
 * `?v=` at all. Both changed in this batch — auth.js gained the admin
 * create-user validation, admin.js re-notifies it after clearing the form — and
 * the documented cache-bust contract is that changing a static asset without
 * raising its pin ships the change invisibly behind a stale browser copy. That
 * is worse here than elsewhere: the password reveal toggle and the live
 * validation are the visible behaviour, so a stale auth.js looks like the
 * feature was never built.
 *
 * auth.js is loaded by FOUR templates, so the pin is asserted on each: a partial
 * bump would fix login and leave admin stale, which is the failure mode a single
 * assertion would miss.
 */
const AUTH_JS_PIN = 2;
const ADMIN_JS_PIN = 3;
for (const [label, src] of [['login', login], ['register', register],
    ['change_password', changePw], ['admin', admin]]) {
    check(`${label}: auth.js carries the current ?v=${AUTH_JS_PIN} pin`,
        src.includes(`filename='js/auth.js') }}?v=${AUTH_JS_PIN}"`), true);
    check(`${label}: auth.js has exactly one script reference`,
        (src.match(/filename='js\/auth\.js'\)\s*\}\}/g) || []).length, 1);
    check(`${label}: no unpinned auth.js tag survives`,
        /filename='js\/auth\.js'\)\s*\}\}"/.test(src), false);
}
check(`admin: admin.js carries the current ?v=${ADMIN_JS_PIN} pin`,
    admin.includes(`filename='js/admin.js') }}?v=${ADMIN_JS_PIN}"`), true);
check('admin: admin.js has exactly one script reference',
    (admin.match(/filename='js\/admin\.js'\)\s*\}\}/g) || []).length, 1);
check('admin: create-user form uses same icon system as login',
    admin.includes('#icon-contact-round') && admin.includes('#icon-lock')
    && admin.includes('#icon-eye') && admin.includes('#icon-arrow-right'), true);

/*
 * D8 also asks the create-user form to be consistent with login/register on
 * VALIDATION, not only on icons and geometry. The rules belong to
 * auth.py register_user (3-32 username of letters/numbers/underscore, 8-char
 * password floor), which the admin POST reaches through register_user — so the
 * constraint attributes here must state the same rule, and the hint nodes must
 * exist for auth.js to write into. Measured behaviour is in
 * tests/browser/w8_admin_form_icons.mjs §6; this is the static half.
 */
check('admin: username carries register_user\'s 3-32 pattern',
    admin.includes('pattern="[a-zA-Z0-9_]{3,32}"'), true);
check('admin: password carries register_user\'s 8-char floor',
    admin.includes('minlength="8"'), true);
check('admin: both create-user fields are required',
    (admin.match(/\brequired\b/g) || []).length >= 2, true);
check('admin: hint ids auth.js looks up',
    admin.includes('id="adminUsernameHint"')
    && admin.includes('id="adminPasswordHint"'), true);
const authJs = fs.readFileSync(path.join(ROOT, 'static/js/auth.js'), 'utf8');
check('auth.js owns the admin create-user validation',
    authJs.includes('function setupAdminCreateUserValidation()')
    && authJs.includes('setupAdminCreateUserValidation();'), true);
check('auth.js admin validation is guarded like the others',
    /setupAdminCreateUserValidation\(\)[\s\S]*?if \(!username \|\| !password\) \{/
        .test(authJs), true);
const adminJs = fs.readFileSync(path.join(ROOT, 'static/js/admin.js'), 'utf8');
check('admin.js re-notifies validation after clearing the form',
    adminJs.includes("new Event('input', { bubbles: true })"), true);

// Zero hardcoded colours in the shipped stylesheet.
const css = fs.readFileSync(path.join(ROOT, 'static/css/auth-v5.css'), 'utf8');
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
check('auth-v5.css has zero hardcoded colours',
    noComments.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) || [], []);

// Every symbol the pages reference must exist -- in the sprite, or in the
// brand include, which is inline BECAUSE the mark's own <mask> cannot be
// referenced through an external <use> (see templates/_brand_symbol.html).
const sprite = fs.readFileSync(path.join(ROOT, 'static/icons/icons.svg'), 'utf8');
const brand = fs.readFileSync(path.join(ROOT, 'templates/_brand_symbol.html'), 'utf8');
const have = new Set(Array.from((sprite + brand).matchAll(/id="(icon-[a-z0-9-]+)"/g))
    .map(x => x[1]));
const referenced = new Set();
for (const p of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, p.tpl), 'utf8');
    for (const x of src.matchAll(/#(icon-[a-z0-9-]+)/g)) referenced.add(x[1]);
}
check('every page carries the brand mark exactly once', PAGES.map(p => {
    const src = fs.readFileSync(path.join(ROOT, p.tpl), 'utf8');
    return (src.match(/href="#icon-brand"/g) || []).length;
}), PAGES.map(() => 1));
check('every page includes the inline brand symbol', PAGES.every(p =>
    fs.readFileSync(path.join(ROOT, p.tpl), 'utf8')
        .includes("{% include '_brand_symbol.html' %}")), true);
check('every referenced sprite symbol exists',
    [...referenced].filter(s => !have.has(s)), []);
check('the pages actually reference sprite symbols', referenced.size > 0, true);

check('no page errors while measuring', pageErrors, []);

await browser.close();
server.close();

if (failures.length) {
    console.error(failures.slice(0, 40).join('\n'));
    if (failures.length > 40) console.error(`... and ${failures.length - 40} more`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
