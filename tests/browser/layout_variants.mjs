/*
 * v5 L3/L4/L5 -- pane engine, layout menu and previews.
 *
 * Authority:
 *   - sshdeck-ui-plan-v5.html lines 99-110: heading + eight desktop choices
 *   - lines 136-144: touch menu choices
 *   - lines 277-289: heading/grid/preview geometry
 *   - lines 313-315: rendered split shapes and pane labels
 *   - amendment-v5.md line 91: desktop 1-6, iPad 1-4, phone 1-2
 *   - amendment-v5.md lines 92/107/118: anchored dropdown, filtered cap
 *
 * Existing mobile_session_switch.mjs proves WHICH options are offered. It does
 * not prove that selecting one produces the promised real grid. That gap hid a
 * production defect: phone offered both two-pane choices, but legacy CSS hid
 * every pane after the first, so "2 dọc" and "2 ngang" both painted one pane.
 *
 * This suite therefore binds preview -> click -> engine state -> real grid for
 * every approved choice, and measures the phone/iPad/desktop cap independently.
 * Every assertion uses production markup, JS and CSS in Chromium.
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

function atLeast(label, actual, floor) {
    if (typeof actual === 'number' && actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual} >= ${floor})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}`
            + `\n        actual   ${actual}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json', '.map': 'application/json',
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const STUBS = `
    window.__emits = [];
    const noop = () => {};
    window.socket = {
        connected: true,
        on: noop, off: noop, once: noop,
        emit: (event, payload) => window.__emits.push([event, payload]),
        io: { on: noop, engine: { on: noop, transport: { name: 'websocket' } } },
    };
`;

async function open(vp) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: !!vp.touch,
        isMobile: !!vp.mobile,
        deviceScaleFactor: 1,
    });
    await ctx.addInitScript(STUBS);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(400);
    return { ctx, page, errors };
}

const CHOICES = [
    { id: '1:default', count: 1, variant: 'default', label: '1 pane',
      cls: 'terminal-grid split-1', rows: 1, cols: 1, tall: false },
    { id: '2:default', count: 2, variant: 'default', label: '2 dọc',
      cls: 'terminal-grid split-2', rows: 1, cols: 2, tall: false },
    { id: '2:rows', count: 2, variant: 'rows', label: '2 ngang',
      cls: 'terminal-grid split-2 split-2-rows', rows: 2, cols: 1, tall: false },
    { id: '3:default', count: 3, variant: 'default', label: '3 pane',
      cls: 'terminal-grid split-3', rows: 2, cols: 2, tall: true },
    { id: '4:default', count: 4, variant: 'default', label: '4 pane',
      cls: 'terminal-grid split-4', rows: 2, cols: 2, tall: false },
    { id: '4:main', count: 4, variant: 'main', label: '4 + chính',
      cls: 'terminal-grid split-4 split-4-main', rows: 3, cols: 2, tall: true },
    { id: '5:default', count: 5, variant: 'default', label: '5 pane',
      cls: 'terminal-grid split-5', rows: 4, cols: 2, tall: true },
    { id: '6:default', count: 6, variant: 'default', label: '6 pane',
      cls: 'terminal-grid split-6', rows: 2, cols: 3, tall: false },
];

const VIEWPORTS = [
    { label: 'desktop', w: 1440, h: 900, touch: false, mobile: false,
      cap: 6, choices: CHOICES.map(c => c.id), columns: 4,
      policy: 'Desktop · đầy đủ 1–6 pane', badge: '1–6' },
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true, mobile: false,
      cap: 4, choices: CHOICES.slice(0, 5).map(c => c.id), columns: 4,
      policy: 'iPad · tối đa 4 pane', badge: '1–4' },
    { label: 'ipad-landscape', w: 1194, h: 834, touch: true, mobile: false,
      cap: 4, choices: CHOICES.slice(0, 5).map(c => c.id), columns: 4,
      policy: 'iPad · tối đa 4 pane', badge: '1–4' },
    { label: 'phone390', w: 390, h: 844, touch: true, mobile: true,
      cap: 2, choices: CHOICES.slice(0, 3).map(c => c.id), columns: 2,
      policy: 'Điện thoại · tối đa 2 pane', badge: '1–2' },
    { label: 'phone-landscape', w: 926, h: 428, touch: true, mobile: true,
      cap: 2, choices: CHOICES.slice(0, 3).map(c => c.id), columns: 2,
      policy: 'Điện thoại ngang · tối đa 2 pane', badge: '1–2' },
];

function tracks(value) {
    return value.split(' ').filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// §1 desktop -- all eight choices, preview -> engine -> real grid
// ---------------------------------------------------------------------------
console.log('\n== §1 desktop all approved layouts ==');
{
    const { ctx, page, errors } = await open(VIEWPORTS[0]);
    await page.evaluate(() => i18n.setLanguage('vi'));
    await page.click('#layoutMenuBtn');
    await page.waitForTimeout(80);

    const menu = await page.evaluate(() => {
        const root = document.getElementById('layoutMenu');
        const heading = root.querySelector('.layout-menu-heading');
        const grid = root.querySelector('.layout-grid');
        const rect = root.getBoundingClientRect();
        const trigger = document.getElementById('layoutMenuBtn').getBoundingClientRect();
        const options = [...grid.querySelectorAll('.touch-layout-option')];
        return {
            title: heading.querySelector('strong').textContent.trim(),
            policy: heading.querySelector('small').textContent.trim(),
            badge: heading.querySelector('.layout-count-badge').textContent.trim(),
            options: options.map(o => `${o.dataset.layout}:${o.dataset.variant}`),
            labels: options.map(o => o.lastElementChild.textContent.trim()),
            gridColumns: getComputedStyle(grid).gridTemplateColumns
                .split(' ').filter(Boolean).length,
            belowTrigger: rect.top >= trigger.bottom,
            insideViewport: rect.left >= 0 && rect.right <= innerWidth,
            menuWidth: Math.round(rect.width),
            previewCounts: options.map(o => o.querySelectorAll('.layout-preview i').length),
        };
    });
    check('§1 heading title matches mockup line 100', menu.title, 'Bố cục terminal');
    check('§1 policy matches desktop line 100', menu.policy, VIEWPORTS[0].policy);
    check('§1 badge matches desktop cap', menu.badge, VIEWPORTS[0].badge);
    check('§1 eight choices in approved order', menu.options, VIEWPORTS[0].choices);
    check('§1 Vietnamese labels match mockup lines 102-109', menu.labels,
        CHOICES.map(c => c.label));
    check('§1 desktop grid has four columns', menu.gridColumns, 4);
    check('§1 menu is anchored below its trigger', menu.belowTrigger, true);
    check('§1 menu remains inside product viewport', menu.insideViewport, true);
    atLeast('§1 menu has the full mockup-sized desktop width', menu.menuWidth, 390);
    check('§1 every preview has exactly its pane count', menu.previewCounts,
        CHOICES.map(c => c.count));

    for (const choice of CHOICES) {
        /*
         * Drive the REAL visible option. With no sessions, setupSplitControls
         * takes its direct setSplitLayout path, so this single click proves the
         * whole chain:
         *
         *   visible (count,variant) option -> delegated canonical .split-btn
         *   -> app.js handler -> SessionManager -> CSS grid
         *
         * Calling setSplitLayout here would let a broken delegation selector
         * pass -- especially dangerous for 2:rows and 4:main, whose count-only
         * identity is shared with another choice.
         */
        if (await page.evaluate(() => document.getElementById('layoutMenu').hidden)) {
            await page.click('#layoutMenuBtn');
        }
        await page.click(
            `#layoutMenu .touch-layout-option[data-layout="${choice.count}"]`
            + `[data-variant="${choice.variant}"]`);
        await page.waitForTimeout(30);
        // The click intentionally closes the dropdown. Reopen before reading
        // preview used values: under a display:none ancestor Chromium serializes
        // `repeat(3, 1fr)` literally, so splitting on spaces would count syntax
        // tokens rather than painted tracks -- a transient-state false failure.
        await page.evaluate(() => TouchActionRow.openLayoutMenu());

        const result = await page.evaluate(({ count, variant }) => {
            const grid = document.getElementById('terminalGrid');
            const panes = [...grid.querySelectorAll(':scope > .terminal-pane')];
            const preview = document.querySelector(
                `#layoutMenu .touch-layout-option[data-layout="${count}"]`
                + `[data-variant="${variant}"] .layout-preview`);
            const gcs = getComputedStyle(grid);
            const pcs = preview ? getComputedStyle(preview) : null;
            const first = panes[0] ? getComputedStyle(panes[0]) : null;
            return {
                layout: SessionManager.layout,
                variant: SessionManager.layoutVariant,
                className: grid.className,
                paneCount: panes.length,
                visible: panes.filter(p => getComputedStyle(p).display !== 'none').length,
                rowTracks: gcs.gridTemplateRows.split(' ').filter(Boolean).length,
                colTracks: gcs.gridTemplateColumns.split(' ').filter(Boolean).length,
                previewRows: pcs ? pcs.gridTemplateRows.split(' ').filter(Boolean).length : 0,
                previewCols: pcs ? pcs.gridTemplateColumns.split(' ').filter(Boolean).length : 0,
                firstRowSpan: first ? first.gridRowEnd !== 'auto' : false,
                badgeNumbers: panes.map(p => p.querySelector('.pane-number-badge')?.textContent),
                labelled: panes.every(p => !!p.querySelector('.pane-label')),
                selected: [...document.querySelectorAll('.split-btn[aria-pressed="true"]')]
                    .map(b => `${b.dataset.layout}:${b.dataset.variant}`),
                stored: JSON.parse(localStorage.getItem('terminalLayout')),
            };
        }, choice);

        check(`§1 ${choice.id}: engine count`, result.layout, choice.count);
        check(`§1 ${choice.id}: engine variant`, result.variant, choice.variant);
        check(`§1 ${choice.id}: canonical class`, result.className, choice.cls);
        check(`§1 ${choice.id}: creates exactly ${choice.count} panes`,
            result.paneCount, choice.count);
        check(`§1 ${choice.id}: every pane paints`, result.visible, choice.count);
        check(`§1 ${choice.id}: real row count`, result.rowTracks, choice.rows);
        check(`§1 ${choice.id}: real column count`, result.colTracks, choice.cols);
        check(`§1 ${choice.id}: preview row count mirrors real`,
            result.previewRows, choice.rows);
        check(`§1 ${choice.id}: preview column count mirrors real`,
            result.previewCols, choice.cols);
        check(`§1 ${choice.id}: tall primary agrees with preview`,
            result.firstRowSpan, choice.tall);
        check(`§1 ${choice.id}: every pane carries a label`, result.labelled, true);
        check(`§1 ${choice.id}: pane number badges are derived`, result.badgeNumbers,
            Array.from({ length: choice.count }, (_, i) => String(i + 1)));
        check(`§1 ${choice.id}: exactly this choice is selected`,
            result.selected, [choice.id]);
        check(`§1 ${choice.id}: persisted count`, result.stored.layout, choice.count);
        check(`§1 ${choice.id}: persisted variant`, result.stored.variant, choice.variant);
    }

    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2 device caps and visible rendering
// ---------------------------------------------------------------------------
console.log('\n== §2 device caps and actual pane rendering ==');
for (const vp of VIEWPORTS) {
    const { ctx, page, errors } = await open(vp);
    await page.evaluate(() => i18n.setLanguage('vi'));
    // Trigger can be hidden in a transient relocated parent until TouchActionRow
    // completes; open through the same production method after init settles.
    await page.evaluate(() => TouchActionRow.openLayoutMenu());
    await page.waitForTimeout(80);

    const menu = await page.evaluate(() => {
        const root = document.getElementById('layoutMenu');
        const grid = root.querySelector('.layout-grid');
        const options = [...root.querySelectorAll('.touch-layout-option')];
        return {
            title: root.querySelector('.layout-menu-heading strong')?.textContent.trim(),
            policy: root.querySelector('.layout-menu-policy')?.textContent.trim(),
            badge: root.querySelector('.layout-count-badge')?.textContent.trim(),
            options: options.map(o => `${o.dataset.layout}:${o.dataset.variant}`),
            columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
            inside: (() => {
                const r = root.getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth
                    && r.top >= 0 && r.bottom <= innerHeight;
            })(),
            rect: (() => {
                const r = root.getBoundingClientRect();
                return { left: Math.round(r.left), top: Math.round(r.top),
                    right: Math.round(r.right), bottom: Math.round(r.bottom),
                    width: Math.round(r.width), height: Math.round(r.height),
                    innerWidth, innerHeight,
                    triggerParent: document.getElementById('layoutMenuBtn')
                        ?.parentElement?.parentElement?.id || '',
                    menuOffsetParent: root.offsetParent?.id
                        || root.offsetParent?.className || '',
                    rowRect: (() => {
                        const n = document.getElementById('touchActionRow');
                        const x = n?.getBoundingClientRect();
                        return x ? { top: Math.round(x.top), bottom: Math.round(x.bottom) } : null;
                    })(),
                    triggerRect: (() => {
                        const n = document.getElementById('layoutMenuBtn');
                        const x = n?.getBoundingClientRect();
                        return x ? { top: Math.round(x.top), bottom: Math.round(x.bottom) } : null;
                    })(),
                    headerRect: (() => {
                        const n = document.querySelector('.header');
                        const x = n?.getBoundingClientRect();
                        return x ? { top: Math.round(x.top), bottom: Math.round(x.bottom) } : null;
                    })() };
            })(),
            names: options.every(o => o.textContent.trim().length > 0),
            previews: options.every(o => o.querySelector('.layout-preview')),
        };
    });
    check(`§2 ${vp.label}: heading exists`, menu.title, 'Bố cục terminal');
    check(`§2 ${vp.label}: device policy`, menu.policy, vp.policy);
    check(`§2 ${vp.label}: cap badge`, menu.badge, vp.badge);
    check(`§2 ${vp.label}: exact choices`, menu.options, vp.choices);
    check(`§2 ${vp.label}: grid columns`, menu.columns, vp.columns);
    check(`§2 ${vp.label}: menu is inside viewport (${JSON.stringify(menu.rect)})`,
        menu.inside, true);
    check(`§2 ${vp.label}: every option is named`, menu.names, true);
    check(`§2 ${vp.label}: every option has a preview`, menu.previews, true);

    // Request beyond cap through the engine (not the menu): a saved desktop
    // preference and direct callers never pass through menu filtering.
    const clamped = await page.evaluate(() => {
        SessionManager.setSplitLayout(6, 'main');
        const grid = document.getElementById('terminalGrid');
        const panes = [...grid.querySelectorAll(':scope > .terminal-pane')];
        return {
            layout: SessionManager.layout,
            variant: SessionManager.layoutVariant,
            className: grid.className,
            panes: panes.length,
            visible: panes.filter(p => getComputedStyle(p).display !== 'none').length,
        };
    });
    check(`§2 ${vp.label}: engine clamps an oversized request`,
        clamped.layout, vp.cap);
    // A clamp can make the requested variant valid for the clamped count:
    // (6, main) -> (4, main) on iPad, because `main` is the approved 4-pane
    // variant. On desktop it stays count 6 and `main` is invalid; on phone it
    // becomes count 2 and is invalid there too.
    const clampedVariant = vp.cap === 4 ? 'main' : 'default';
    check(`§2 ${vp.label}: variant is normalized after clamp`,
        clamped.variant, clampedVariant);
    check(`§2 ${vp.label}: grid class follows clamped identity`,
        clamped.className, `terminal-grid split-${vp.cap}`
            + (clampedVariant === 'default' ? '' : ` split-${vp.cap}-${clampedVariant}`));
    check(`§2 ${vp.label}: engine creates the capped pane count`,
        clamped.panes, vp.cap);
    // S36: phone portrait shows only 1 pane (the active one) via CSS;
    // landscape and desktop show all capped panes.
    const expectedVisible = (vp.label === 'phone390') ? 1 : vp.cap;
    check(`§2 ${vp.label}: all capped panes are actually visible`,
        clamped.visible, expectedVisible);

    if (vp.cap === 2) {
        for (const variant of ['default', 'rows']) {
            const shape = await page.evaluate(v => {
                SessionManager.setSplitLayout(2, v);
                const grid = document.getElementById('terminalGrid');
                const panes = [...grid.querySelectorAll(':scope > .terminal-pane')];
                const cs = getComputedStyle(grid);
                return {
                    visible: panes.filter(p => getComputedStyle(p).display !== 'none').length,
                    rows: cs.gridTemplateRows.split(' ').filter(Boolean).length,
                    cols: cs.gridTemplateColumns.split(' ').filter(Boolean).length,
                };
            }, variant);
            // S36: phone portrait collapses to 1 visible pane, 1x1 grid.
            // Landscape shows 2 panes with the variant's grid.
            const expectVisible = (vp.label === 'phone390') ? 1 : 2;
            const expectRows = (vp.label === 'phone390') ? 1 : (variant === 'rows' ? 2 : 1);
            const expectCols = (vp.label === 'phone390') ? 1 : (variant === 'rows' ? 1 : 2);
            check(`§2 ${vp.label}/${variant}: two panes really paint`,
                shape.visible, expectVisible);
            check(`§2 ${vp.label}/${variant}: row count`,
                shape.rows, expectRows);
            check(`§2 ${vp.label}/${variant}: column count`,
                shape.cols, expectCols);
        }
    }

    check(`§2 ${vp.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §3 saved layout restore: cap + variant survive correctly
// ---------------------------------------------------------------------------
console.log('\n== §3 saved layout restore ==');
{
    const { ctx, page, errors } = await open(VIEWPORTS[0]);
    await page.evaluate(() => {
        localStorage.setItem('terminalLayout', JSON.stringify({ layout: 4, variant: 'main' }));
        SessionManager.layout = 1;
        SessionManager.layoutVariant = 'default';
        SessionManager.paneAssignments = [];
        SessionManager.init();
    });
    let saved = await page.evaluate(() => ({
        layout: SessionManager.layout,
        variant: SessionManager.layoutVariant,
        cls: document.getElementById('terminalGrid').className,
    }));
    check('§3 desktop restores saved count', saved.layout, 4);
    check('§3 desktop restores saved variant', saved.variant, 'main');
    check('§3 desktop restores variant class', saved.cls,
        'terminal-grid split-4 split-4-main');
    check('§3 desktop restore has no page errors', errors.join(' | '), '');
    await ctx.close();
}
{
    const vp = VIEWPORTS.find(v => v.label === 'phone390');
    const { ctx, page, errors } = await open(vp);
    await page.evaluate(() => {
        localStorage.setItem('terminalLayout', JSON.stringify({ layout: 5, variant: 'main' }));
        SessionManager.layout = 1;
        SessionManager.layoutVariant = 'default';
        SessionManager.paneAssignments = [];
        SessionManager.init();
    });
    const saved = await page.evaluate(() => {
        const panes = [...document.querySelectorAll('#terminalGrid > .terminal-pane')];
        return {
            layout: SessionManager.layout,
            variant: SessionManager.layoutVariant,
            cls: document.getElementById('terminalGrid').className,
            panes: panes.length,
            visible: panes.filter(p => getComputedStyle(p).display !== 'none').length,
        };
    });
    check('§3 phone clamps a saved 5-pane layout to 2', saved.layout, 2);
    check('§3 phone drops a variant invalid after clamp', saved.variant, 'default');
    check('§3 phone emits the canonical clamped class', saved.cls,
        'terminal-grid split-2');
    check('§3 phone creates two panes after restore', saved.panes, 2);
    // S36: phone portrait (390x844) shows only the active pane.
    check('§3 phone shows both restored panes', saved.visible, 1);
    check('§3 phone restore has no page errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
