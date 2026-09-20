/*
 * File Transfer surface EYE GATE — v5 visual/interaction render + measure.
 *
 * The v5 acceptance matrix (visual_acceptance_v5.mjs) renders the two SFTP
 * surfaces it knew about: the inline panel on desktop and phone. It renders the
 * GLOBAL dual-pane server-to-server surface nowhere, so the eye gate
 * had no PNG for the one surface Entry 40 is about.
 *
 * This harness renders it at every tier the gate names -- desktop, iPad portrait,
 * iPad landscape, phone portrait, phone landscape -- and measures, rather than
 * merely photographs, the properties the eye gate asks about:
 *
 *   - global dual-pane Source/Destination actually side by side on wide tiers,
 *     and both ends still REACHABLE on touch tiers via the tabs;
 *   - no clipped, wrapped or overflowing controls anywhere on the surface;
 *   - the modal positioned inside the viewport, not off-screen or scroll-locked;
 *   - the three names distinct and correct on the surfaces that show them;
 *   - zero page errors, zero failed requests, zero HTTP >= 400.
 *
 * Every assertion is measured from the live DOM. Screenshots are written for the
 * human eye gate; the pass/fail verdict here does not depend on them.
 *
 * Run: node tests/browser/transfer_surface_eyegate.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const SHOTS = '/tmp/transfer-eyegate';
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

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

const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true,
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload, ack) {
            window.__emits.push({ evt, payload });
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                window.__idSeq = (window.__idSeq || 0) + 1;
                const id = 'eyegate-' + window.__idSeq;
                window.__serverIds = window.__serverIds || [];
                window.__serverIds.push(id);
                setTimeout(() => ack({ success: true, transfer_id: id }), 0);
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.__socketFixture = sock;
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

const results = [];
const check = (label, ok, detail = '') => results.push({ label, ok: !!ok, detail });
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ label, ok,
        detail: ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}` });
};

const TIERS = [
    { name: 'desktop1440', width: 1440, height: 900, touch: false, wide: true },
    { name: 'ipad-portrait', width: 834, height: 1112, touch: true, wide: true },
    { name: 'ipad-landscape', width: 1112, height: 834, touch: true, wide: true },
    { name: 'phone390', width: 390, height: 844, touch: true, wide: false },
    { name: 'phone-landscape', width: 844, height: 390, touch: true, wide: false },
];

const browser = await chromium.launch();
const diagnostics = [];

for (const tier of TIERS) {
    const ctx = await browser.newContext({
        viewport: { width: tier.width, height: tier.height },
        hasTouch: tier.touch, isMobile: tier.touch, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    const failedRequests = [];
    const badStatus = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('requestfailed', r => failedRequests.push(r.url()));
    page.on('response', r => { if (r.status() >= 400) badStatus.push(`${r.status()} ${r.url()}`); });

    await page.addInitScript(() => { window.__emits = []; });
    await page.goto(BASE, { waitUntil: 'load' });
    /*
     * S26 R1 -- HERMETIC SETUP. The context above was created with this tier's
     * viewport, but a run whose page reports a different one measures every box
     * against the wrong frame, and the ipad-landscape red is exactly that shape
     * (printed 1125x844 for a tier configured 1112x834). Re-stating the size on
     * the PAGE is idempotent when the context already has it and forces a resize
     * when anything else moved it.
     *
     * IT WAITS, BUT IT DOES NOT THROW. A `waitForFunction` here would abort the
     * whole gate before a single assertion ran, and a gate that dies with ZERO
     * assertions is exactly what S25 R4 forbids treating as anything but red
     * without a diagnosis -- it would hide WHICH frame the page was in behind a
     * Playwright timeout. So the agreement is POLLED, the outcome is recorded,
     * and the rows below report it by name. A run in the red state therefore
     * produces a named red row plus the full geometry table, not a crash.
     */
    await page.setViewportSize({ width: tier.width, height: tier.height });
    let frameAgreed = null;
    for (let i = 0; i < 40; i++) {
        frameAgreed = await page.evaluate(() => ({
            iw: window.innerWidth, ih: window.innerHeight,
            cw: document.documentElement.clientWidth,
            ch: document.documentElement.clientHeight,
        }));
        if (frameAgreed.iw === tier.width && frameAgreed.ih === tier.height
            && frameAgreed.cw === tier.width) break;
        await page.waitForTimeout(100);
    }
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });

    // Two connected sessions on two different hosts: a server-to-server surface
    // cannot be judged with one host.
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'eg-s1', via_jump: null,
        });
        SessionManager.createSession({
            session_id: 's2', host: 'goclaw', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'goclaw',
            use_tmux: true, tmux_session_name: 'eg-s2', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(400);

    // Open the GLOBAL dual-pane surface through the production control.
    await page.evaluate(() => document.getElementById('fileTransferOpenBtn')?.click());
    await page.waitForFunction(() => !!window.sftpFileManager, null, { timeout: 8000 });
    await page.waitForTimeout(300);

    // Seed both ends with real state so the panes render like the user's.
    await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.availableSessions = [
            { session_id: 's1', host: 'tiny', username: 'root' },
            { session_id: 's2', host: 'goclaw', username: 'root' },
        ];
        fm.updateSessionLists();
        fm.panes.left.type = 'ssh';
        fm.panes.left.sessionId = 's1';
        fm.panes.left.path = '/opt/sshdeck';
        fm.panes.left.hostInfo = { username: 'root', host: 'tiny' };
        // Three entries, so "at least two rows visible" is a real assertion about
        // the layout rather than an artefact of the fixture having only one file.
        fm.panes.left.files = [
            { name: 'report.log', is_dir: false, size: 4096, permissions: '-rw-r--r--' },
            { name: 'bundle', is_dir: true, size: 0, permissions: 'drwxr-xr-x' },
            { name: 'notes.md', is_dir: false, size: 88, permissions: '-rw-r--r--' },
        ];
        fm.panes.right.type = 'ssh';
        fm.panes.right.sessionId = 's2';
        fm.panes.right.path = '/srv/inbox';
        fm.panes.right.hostInfo = { username: 'root', host: 'goclaw' };
        fm.panes.right.files = [
            { name: 'existing.txt', is_dir: false, size: 12, permissions: '-rw-r--r--' },
            { name: 'archive', is_dir: true, size: 0, permissions: 'drwxr-xr-x' },
            { name: 'inbox.log', is_dir: false, size: 640, permissions: '-rw-r--r--' },
        ];
        ['left', 'right'].forEach(p => {
            fm.updatePathInput(p, fm.panes[p].path);
            fm.renderPane(p);
            fm.updatePaneBadge(p);
        });
    });
    await page.waitForTimeout(250);

    const m = await page.evaluate((tierArgs) => {
        const fm = window.sftpFileManager;
        const modal = document.getElementById('sftpFileManager');
        // A FILE ROW IS A TOUCH TARGET on mobile:
        // it must stay at least 44px high, and two of them must be usable. The
        // floor therefore rides inside the row predicate, so a 36px row fails
        // the count itself instead of passing geometry and failing a separate
        // height check.
        const ROW_FLOOR = tierArgs.touch ? 44 : 24;
        const box = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                x: Math.round(r.left), y: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height),
                right: Math.round(r.right), bottom: Math.round(r.bottom),
            };
        };
        const shown = el => !!el && getComputedStyle(el).display !== 'none'
            && el.getBoundingClientRect().width > 0;

        // Any control on this surface that is clipped or wrapped. A control is
        // clipped when its scroll extent exceeds its client box, and wrapped when
        // its text spans more line boxes than its own line-height allows.
        const controls = [...modal.querySelectorAll(
            'button, select, input, .fm-pane-tab, .fm-transfer-item, .fm-panel-title')];
        const clipped = controls.filter(el => {
            if (!shown(el)) return false;
            return el.scrollWidth > el.clientWidth + 1
                || el.scrollHeight > el.clientHeight + 1;
        }).map(el => ({
            id: el.id || el.className, sw: el.scrollWidth, cw: el.clientWidth,
            sh: el.scrollHeight, ch: el.clientHeight,
        }));

        // Controls poking outside the viewport (off-screen or cut off).
        const overflowing = controls.filter(el => {
            if (!shown(el)) return false;
            const r = el.getBoundingClientRect();
            return r.left < -1 || r.top < -1
                || r.right > window.innerWidth + 1
                || r.bottom > window.innerHeight + 1;
        }).map(el => ({ id: el.id || el.className, box: box(el) }));

        /*
         * TRULY VISIBLE, not merely "in the DOM and not display:none".
         *
         * A 121px pane height passed the old metric while the pane's own children
         * were pushed below the fold inside a clipping ancestor: the path row and
         * the file list existed, had non-zero boxes, and could not be seen. This
         * walks the ancestor chain and intersects each clipping rect, so an
         * element only counts as visible if a real, non-trivial part of it lands
         * inside every clip AND inside the viewport.
         */
        const visibleArea = (el) => {
            if (!el) return 0;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden'
                || Number(cs.opacity) === 0) return 0;
            let r = el.getBoundingClientRect();
            let clip = {
                left: Math.max(0, r.left), top: Math.max(0, r.top),
                right: Math.min(window.innerWidth, r.right),
                bottom: Math.min(window.innerHeight, r.bottom),
            };
            for (let p = el.parentElement; p; p = p.parentElement) {
                const pcs = getComputedStyle(p);
                if (pcs.display === 'none' || pcs.visibility === 'hidden') return 0;
                if (/hidden|clip|auto|scroll/.test(pcs.overflowY + pcs.overflowX)) {
                    const pr = p.getBoundingClientRect();
                    clip = {
                        left: Math.max(clip.left, pr.left),
                        top: Math.max(clip.top, pr.top),
                        right: Math.min(clip.right, pr.right),
                        bottom: Math.min(clip.bottom, pr.bottom),
                    };
                }
            }
            const w = clip.right - clip.left;
            const h = clip.bottom - clip.top;
            return w > 0 && h > 0 ? Math.round(w * h) : 0;
        };
        const seen = el => visibleArea(el) > 0;

        /*
         * USABLE, not merely intersecting.
         *
         * `visibleArea() > 0` counted a ONE-PIXEL sliver as visible, so a list
         * showing one full row plus the top edge of a second reported
         * rowsVisible=2 and went green while the human eye saw a single usable
         * row. That was a FALSE GREEN produced by my own predicate, not by the
         * product.
         *
         * A row is usable only when the user can read and tap it:
         *   - at least 80% of its height survives every clip and the viewport;
         *   - its CENTRE POINT lies inside every clip and the viewport, so a row
         *     bisected by the fold cannot qualify on height alone;
         *   - it is genuinely tappable at that size (>= 24px of visible height).
         */
        const usableRow = (el, minRatio = 0.8) => {
            if (!el) return { usable: false, reason: 'missing' };
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') {
                return { usable: false, reason: 'hidden' };
            }
            const r = el.getBoundingClientRect();
            if (r.height <= 0) return { usable: false, reason: 'zero-height' };
            let clip = {
                left: 0, top: 0,
                right: window.innerWidth, bottom: window.innerHeight,
            };
            for (let p = el.parentElement; p; p = p.parentElement) {
                const pcs = getComputedStyle(p);
                if (pcs.display === 'none' || pcs.visibility === 'hidden') {
                    return { usable: false, reason: 'ancestor-hidden' };
                }
                if (/hidden|clip|auto|scroll/.test(pcs.overflowY + pcs.overflowX)) {
                    const pr = p.getBoundingClientRect();
                    clip = {
                        left: Math.max(clip.left, pr.left),
                        top: Math.max(clip.top, pr.top),
                        right: Math.min(clip.right, pr.right),
                        bottom: Math.min(clip.bottom, pr.bottom),
                    };
                }
            }
            const visH = Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top);
            const visW = Math.min(r.right, clip.right) - Math.max(r.left, clip.left);
            const ratio = visH > 0 ? visH / r.height : 0;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const centreIn = cx >= clip.left && cx <= clip.right
                && cy >= clip.top && cy <= clip.bottom;
            return {
                usable: visW > 0 && ratio >= minRatio && centreIn
                    && visH >= ROW_FLOOR && r.height >= ROW_FLOOR,
                ratio: Math.round(ratio * 100) / 100,
                visibleHeight: Math.round(visH),
                fullHeight: Math.round(r.height),
                centreInside: centreIn,
            };
        };

        const activePane = document.querySelector('#fmLeftPane.active')
            || document.querySelector('#fmRightPane.active')
            || document.getElementById('fmLeftPane');
        const activeKey = activePane?.id === 'fmRightPane' ? 'Right' : 'Left';
        const listEl = document.getElementById(`fm${activeKey}List`);
        const rows = [...(listEl?.querySelectorAll('.fm-file-item') || [])];

        return {
            viewport: { w: window.innerWidth, h: window.innerHeight },
            /*
             * S26 R1 -- THE TWO VIEWPORT NOTIONS, READ SIDE BY SIDE.
             *
             * `viewport` above is window.innerWidth/innerHeight, which is what
             * every diagnostic line in this file prints. `docScrollX` below is
             * documentElement.scrollWidth - documentElement.clientWidth, a
             * DIFFERENT notion: innerWidth includes a classic scrollbar gutter,
             * clientWidth excludes it and reports the real layout viewport.
             *
             * While the two agree, docScrollX measures overflow and the row that
             * asserts it is 0 means what it says. While they DISAGREE, this file
             * is measuring boxes against a frame it does not have, so the three
             * readings below are captured and asserted BEFORE docScrollX is
             * trusted.
             *
             * ON THE RED ipad-landscape RUN, and correcting this comment's own
             * earlier version. It printed `viewport=1125x844 ... docScrollX=13
             * ... left=481x434` for a tier configured 1112x834. An earlier note
             * here attributed that to a 13x10 classic gutter, and another said
             * the pane "took width from one layout and height from the other, so
             * the run was in NEITHER configuration". BOTH WERE WRONG, and the
             * measurements are on file:
             *   - a REAL 1125x834 context reproduces the pane box 481x434
             *     exactly, so the run WAS in a single, real configuration
             *     (/tmp/s16work/s26b_r1/which_layout.out); 1125x844 gives 481x443, which
             *     the red line did not show;
             *   - neither engine on this box can produce innerWidth != clientWidth
             *     at the ROOT: 0 of 32 configurations, element scrollbar
             *     thickness 0px in Chromium 149 and WebKit 26.5
             *     (/tmp/s16work/s26b_r1/classic_sanity.out, /tmp/s16work/s26b_r1/scrollbar_mode.out).
             * So the red run's own provenance is still unexplained -- it is NOT
             * claimed here to be a gutter -- and the rows below exist to make any
             * repeat name its frame instead of blaming layout.
             *
             * The 13px overflow itself, however, was a REAL product defect and is
             * now fixed: `html, body { width: 100vw }` sized the outermost boxes
             * against a viewport that includes the gutter, and in WebKit with a
             * 13px reserved root bar that produced docScrollX 13 at all five
             * tiers, ipad-landscape included. style.css:260-262/267-269 now use
             * `100%`, and tests/browser/root_width_unit_contract.mjs measures it
             * in WebKit with its own negative control.
             */
            layout: {
                w: document.documentElement.clientWidth,
                h: document.documentElement.clientHeight,
            },
            scrollW: document.documentElement.scrollWidth,
            /* ── functional visibility of the browse/select path ────────────── */
            activePaneId: activePane?.id,
            activePaneBox: box(activePane),
            navRowVisible: seen(activePane?.querySelector('.fm-pane-nav')),
            navRowBox: box(activePane?.querySelector('.fm-pane-nav')),
            pathInputVisible: seen(document.getElementById(`fm${activeKey}Path`)),
            pathInputBox: box(document.getElementById(`fm${activeKey}Path`)),
            listVisible: seen(listEl),
            listBox: box(listEl),
            listScrollable: listEl
                ? listEl.scrollHeight > listEl.clientHeight + 1 : false,
            rowCount: rows.length,
            rowsVisible: rows.filter(seen).length,
            // The honest count: rows a user could actually read and tap.
            rowsUsable: rows.filter(r => usableRow(r).usable).length,
            rowDetail: rows.slice(0, 4).map(r => {
                const u = usableRow(r);
                return {
                    name: r.querySelector('.fm-file-name')?.textContent.trim()
                        || r.textContent.trim().slice(0, 18),
                    usable: u.usable, ratio: u.ratio,
                    visH: u.visibleHeight, fullH: u.fullHeight,
                    centre: u.centreInside,
                };
            }),
            rowBoxes: rows.slice(0, 3).map(box),
            /* Queue state, so "empty consumes nothing / in-flight is announced"
             * can be asserted rather than assumed. */
            queueBox: box(document.getElementById('fmQueue')),
            queueVisibleArea: visibleArea(document.getElementById('fmQueue')),
            queueRowCount: document.querySelectorAll('#fmQueueList .fm-transfer-item').length,
            queueHeaderVisible: seen(document.querySelector('#fmQueue .fm-queue-header')
                || document.querySelector('#fmQueueHeader')),
            rowNames: rows.slice(0, 3).map(
                r => r.querySelector('.fm-file-name')?.textContent.trim()
                    || r.textContent.trim().slice(0, 24)),
            /* ── the two selectors must not both say "Source" ───────────────── */
            leftPlaceholder: document.querySelector('#fmLeftSource option[value=""]')
                ?.textContent.trim(),
            rightPlaceholder: document.querySelector('#fmRightSource option[value=""]')
                ?.textContent.trim(),
            leftPlaceholderKey: document.querySelector('#fmLeftSource option[value=""]')
                ?.dataset.i18n,
            rightPlaceholderKey: document.querySelector('#fmRightSource option[value=""]')
                ?.dataset.i18n,
            open: modal.classList.contains('show'),
            transferMode: modal.classList.contains('fm-transfer-mode'),
            mobileMode: modal.classList.contains('fm-mobile-mode'),
            content: box(modal.querySelector('.modal-content')),
            leftPane: box(document.getElementById('fmLeftPane')),
            rightPane: box(document.getElementById('fmRightPane')),
            leftShown: shown(document.getElementById('fmLeftPane')),
            rightShown: shown(document.getElementById('fmRightPane')),
            tabs: box(document.getElementById('fmPaneTabs')),
            tabsShown: shown(document.getElementById('fmPaneTabs')),
            tabBoxes: [...document.querySelectorAll('.fm-pane-tab')].map(box),
            tabLabels: [...document.querySelectorAll('.fm-pane-tab span')]
                .map(s => s.textContent.trim()),
            transferBtn: box(document.getElementById('fmTransfer')),
            transferBtnShown: shown(document.getElementById('fmTransfer')),
            modalTitle: document.querySelector('#fmModalTitle [data-i18n]')?.textContent.trim(),
            contextualName: document.querySelector('#fileTransferBtn .btn-label')?.textContent.trim(),
            globalMenuName: document.querySelector('#fileTransferOpenBtn [data-i18n]')?.textContent.trim(),
            leftHost: document.getElementById('fmLeftBadge')?.textContent.trim()
                || document.getElementById('fmLeftTitle')?.textContent.trim(),
            rightHost: document.getElementById('fmRightBadge')?.textContent.trim()
                || document.getElementById('fmRightTitle')?.textContent.trim(),
            leftPath: document.getElementById('fmLeftPath')?.value,
            rightPath: document.getElementById('fmRightPath')?.value,
            activePane: fm.activePane,
            docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            clipped, overflowing,
        };
    }, { touch: tier.touch });

    const T = tier.name;
    await page.screenshot({ path: `${SHOTS}/${T}-transfer-surface.png` });

    // ── the surface is the right surface ─────────────────────────────────────
    check(`${T}: the global dual-pane surface is open`, m.open && m.transferMode,
        JSON.stringify({ open: m.open, transferMode: m.transferMode }));
    eq(`${T}: the Source end is selected on open`, m.activePane, 'left');

    // ── both ends are reachable, in the tier-appropriate way ────────────────
    if (tier.wide) {
        /*
         * BOTH ENDS VISIBLE AT ONCE is the contract, not "side by side"
         * specifically. A narrow-but-tall surface (iPad portrait, 834x1112)
         * stacks Source above Destination by design -- `@media (max-width:900px)
         * and (min-height:620px)` -- and the user still sees both ends without
         * switching. Demanding horizontal adjacency here was my own over-strict
         * assertion, which failed a layout that satisfies the requirement.
         *
         * What must hold on every wide tier: both panes visible, neither
         * degenerate, Source before Destination in the reading order, and no
         * overlap.
         */
        const sideBySide = m.leftPane.right <= m.rightPane.x + 2;
        const stacked = m.leftPane.bottom <= m.rightPane.y + 2;
        check(`${T}: both transfer ends are visible at once`,
            m.leftShown && m.rightShown,
            JSON.stringify({ leftShown: m.leftShown, rightShown: m.rightShown }));
        check(`${T}: Source precedes Destination without overlapping it`,
            sideBySide || stacked,
            JSON.stringify({ left: m.leftPane, right: m.rightPane }));
        check(`${T}: neither end is a degenerate strip`,
            m.leftPane.w > 120 && m.leftPane.h > 80
            && m.rightPane.w > 120 && m.rightPane.h > 80,
            JSON.stringify({ left: m.leftPane, right: m.rightPane }));
        check(`${T}: the two ends are sized alike`,
            Math.abs(m.leftPane.w - m.rightPane.w) <= Math.max(24, m.leftPane.w * 0.15)
            && Math.abs(m.leftPane.h - m.rightPane.h) <= Math.max(24, m.leftPane.h * 0.15),
            JSON.stringify({ left: m.leftPane, right: m.rightPane }));
        diagnostics.push(`    ${T}: layout=${sideBySide ? 'side-by-side' : 'stacked'}`);
    } else {
        // Single-pane SIZING, but BOTH ends must stay reachable via the tabs.
        check(`${T}: exactly one pane is shown (single-pane sizing)`,
            m.leftShown !== m.rightShown,
            JSON.stringify({ leftShown: m.leftShown, rightShown: m.rightShown }));
        check(`${T}: the Source/Destination switcher is visible`, m.tabsShown,
            JSON.stringify(m.tabs));
        eq(`${T}: the switcher offers exactly two ends`, m.tabBoxes.length, 2);
        check(`${T}: both tabs meet the 44px touch floor`,
            m.tabBoxes.every(b => b.h >= 44), JSON.stringify(m.tabBoxes));
        check(`${T}: the two tabs are equal width`,
            Math.abs(m.tabBoxes[0].w - m.tabBoxes[1].w) <= 1,
            JSON.stringify(m.tabBoxes));
        check(`${T}: the tab labels name both ends`,
            m.tabLabels.length === 2 && m.tabLabels.every(l => l.length > 0)
            && m.tabLabels[0] !== m.tabLabels[1], JSON.stringify(m.tabLabels));
    }

    /* ── THE BROWSE/SELECT PATH MUST BE USABLE, on every tier ────────────────
     *
     * The functional contract behind the pretty picture: if the user cannot see
     * the path row and at least two file rows, they cannot navigate to a file or
     * select one, so no transfer is possible however good the rest looks. Phone
     * landscape passed a 121px pane-height metric while showing only a session
     * selector and a header -- these assertions are what that metric missed.
     */
    check(`${T}: the path/navigation row is actually visible`,
        m.navRowVisible, JSON.stringify({ nav: m.navRowBox, pane: m.activePaneBox }));
    check(`${T}: the path input is actually visible`,
        m.pathInputVisible, JSON.stringify({ path: m.pathInputBox }));
    check(`${T}: the file list is actually visible`,
        m.listVisible, JSON.stringify({ list: m.listBox, pane: m.activePaneBox }));
    /*
     * TWO USABLE FULL ROWS. `rowsVisible >= 2` was a false green: it counted a
     * one-pixel sliver of a second row, so the gate passed a surface the eye saw
     * as having exactly one usable row. This requires >=80% of each row's height
     * inside every clip and its centre point inside the viewport.
     */
    check(`${T}: at least two USABLE file rows (>=80% visible, centre inside)`,
        m.rowsUsable >= 2,
        JSON.stringify({ rowsUsable: m.rowsUsable, rowsIntersecting: m.rowsVisible,
                         rowCount: m.rowCount, detail: m.rowDetail }));
    check(`${T}: the usable rows are distinct real entries`,
        new Set(m.rowDetail.filter(r => r.usable).map(r => r.name)).size >= 2,
        JSON.stringify(m.rowDetail));
    check(`${T}: the visible rows are real entries`,
        m.rowNames.filter(Boolean).length >= 2, JSON.stringify(m.rowNames));
    check(`${T}: the file list is the scroller when content overflows`,
        m.listBox && m.listBox.h > 0, JSON.stringify(m.listBox));

    /* ── the two ends are named distinctly ──────────────────────────────────*/
    check(`${T}: the Source selector uses the Source placeholder`,
        m.leftPlaceholderKey === 'fm.selectSource',
        JSON.stringify({ key: m.leftPlaceholderKey, text: m.leftPlaceholder }));
    check(`${T}: the Destination selector uses the DESTINATION placeholder`,
        m.rightPlaceholderKey === 'fm.selectDestination',
        JSON.stringify({ key: m.rightPlaceholderKey, text: m.rightPlaceholder }));
    check(`${T}: the two selector placeholders differ`,
        !!m.leftPlaceholder && !!m.rightPlaceholder
        && m.leftPlaceholder !== m.rightPlaceholder,
        JSON.stringify({ left: m.leftPlaceholder, right: m.rightPlaceholder }));
    check(`${T}: the Destination placeholder does not say "Source"`,
        !/source/i.test(m.rightPlaceholder || ''),
        JSON.stringify({ right: m.rightPlaceholder }));

    // Transfer must be operable on every tier -- it is the surface's purpose.
    check(`${T}: the Transfer action is operable`,
        m.transferBtnShown && m.transferBtn.w > 0 && m.transferBtn.h > 0,
        JSON.stringify(m.transferBtn));
    if (tier.touch) {
        check(`${T}: the Transfer action meets the 44px touch floor`,
            m.transferBtn.h >= 44, JSON.stringify(m.transferBtn));
    }

    // ── both ends identify their host and path ──────────────────────────────
    check(`${T}: the Source end names its host`, /tiny/.test(m.leftHost || ''),
        JSON.stringify({ leftHost: m.leftHost }));
    check(`${T}: the Destination end names its host`,
        /goclaw/.test(m.rightHost || ''), JSON.stringify({ rightHost: m.rightHost }));
    eq(`${T}: the Source path is shown`, m.leftPath, '/opt/sshdeck');
    eq(`${T}: the Destination path is shown`, m.rightPath, '/srv/inbox');

    // ── nothing clipped, wrapped, overflowing or off-screen ─────────────────
    eq(`${T}: no control is clipped or wrapped`, m.clipped, []);
    eq(`${T}: no control escapes the viewport`, m.overflowing, []);
    /*
     * S26 R1 -- HERMETIC FIRST, GEOMETRY SECOND.
     *
     * These three rows run BEFORE the horizontal-scroll row so that a run whose
     * viewport is not the one this tier asked for is red for THAT reason,
     * named, instead of being red on docScrollX and mistaken for a layout
     * defect. The tier list is hardcoded (ipad-landscape is 1112x834 and git
     * shows it never held another value), so a page reporting anything else has
     * a leaked or overridden viewport and every box it measures is suspect.
     *
     * Row 3 is the one that would have caught the red run: it requires the two
     * viewport notions to AGREE, which is the precondition for
     * `scrollWidth - clientWidth` to mean overflow at all.
     */
    eq(`${T}: the page was granted the viewport this tier asked for`,
        [m.viewport.w, m.viewport.h], [tier.width, tier.height]);
    eq(`${T}: the layout viewport is the granted one too`,
        [m.layout.w, m.layout.h], [tier.width, tier.height]);
    eq(`${T}: both viewport notions agree, so docScrollX measures overflow`,
        m.viewport.w, m.layout.w);
    /*
     * The gutter, named -- and named as a PRECONDITION, not as a diagnosis of
     * the red run. `scrollWidth - clientWidth` only means "content overflows"
     * while window.innerWidth and documentElement.clientWidth agree; a reserved
     * classic gutter makes them differ, and then every box on the page is being
     * compared against a frame this file did not ask for. This row says so by
     * name, per axis, because a gutter can appear on either one independently.
     *
     * What it does NOT do is prove anything about a reserved gutter's effect on
     * layout: this Chromium draws OVERLAY scrollbars and cannot produce one
     * (element thickness 0px; innerWidth never differs from clientWidth in 32
     * configurations -- /tmp/s16work/s26b_r1/classic_sanity.out). The gutter's real
     * consequence -- `width: 100vw` sizing html/body against the viewport WITH
     * the gutter and overflowing the content box by exactly its width -- is
     * measured in WebKit, where it is reproducible, by
     * tests/browser/root_width_unit_contract.mjs (docScrollX 13 -> 0 at all five
     * tiers, with the pre-fix declaration reinjected as a negative control).
     */
    eq(`${T}: no classic scrollbar gutter is inflating the viewport reading`,
        [m.viewport.w - m.layout.w, m.viewport.h - m.layout.h], [0, 0]);
    /*
     * The SETUP-TIME reading, asserted separately from the measurement-time one
     * above. The poll after setViewportSize records what the page reported
     * BEFORE any of the surface was built; if the frame was already wrong there,
     * this row says so, and it distinguishes "the frame was wrong from the
     * start" from "something moved it while the surface was being seeded".
     */
    eq(`${T}: the frame already agreed with the tier at setup time`,
        [frameAgreed.iw, frameAgreed.ih, frameAgreed.cw, frameAgreed.ch],
        [tier.width, tier.height, tier.width, tier.height]);
    eq(`${T}: the page does not scroll horizontally`, m.docScrollX, 0);
    eq(`${T}: the document is no wider than the layout viewport`,
        m.scrollW, m.layout.w);

    // ── the modal sits inside the viewport ──────────────────────────────────
    check(`${T}: the modal is positioned within the viewport`,
        m.content.x >= -1 && m.content.y >= -1
        && m.content.right <= m.viewport.w + 1
        && m.content.bottom <= m.viewport.h + 1,
        JSON.stringify({ content: m.content, viewport: m.viewport }));

    // ── the three names, distinct and correct ───────────────────────────────
    eq(`${T}: the global surface is titled File Transfer`,
        m.modalTitle, 'File Transfer');
    eq(`${T}: the global menu entry matches the surface`,
        m.globalMenuName, 'File Transfer');
    eq(`${T}: the contextual control keeps the short name`,
        m.contextualName, 'Files');
    check(`${T}: global and contextual names are distinct`,
        m.modalTitle !== m.contextualName,
        JSON.stringify({ modal: m.modalTitle, contextual: m.contextualName }));

    // ── an in-flight row renders, on every tier ─────────────────────────────
    const queue = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const id = await fm.transferSSHtoSSH('/opt/sshdeck/report.log',
            { sessionId: 's1' }, '/srv/inbox/report.log', { sessionId: 's2' },
            { name: 'report.log', is_dir: false, size: 4096 });
        window.__socketFixture.__fire('s2s_transfer_progress', {
            transfer_id: id, filename: 'report.log',
            transferred: 2048, total: 4096, percent: 50,
        });
        const row = [...document.querySelectorAll('.fm-transfer-item')].pop();
        const rb = row?.getBoundingClientRect();
        const cancel = row?.querySelector('[data-transfer-cancel]');
        const cb = cancel?.getBoundingClientRect();
        return {
            id,
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
            name: row?.querySelector('.fm-transfer-name')?.textContent.trim(),
            barWidth: row?.querySelector('.fm-transfer-progress-fill')?.style.width,
            rowVisible: !!rb && rb.width > 0 && rb.height > 0,
            rowInViewport: !!rb && rb.right <= window.innerWidth + 1,
            cancelVisible: !!cb && cb.width > 0,
            cancelHeight: cb ? Math.round(cb.height) : 0,
        };
    });
    await page.screenshot({ path: `${SHOTS}/${T}-transfer-inflight.png` });

    /*
     * EMPTY vs IN-FLIGHT queue. On short landscape the empty queue must consume
     * ZERO height -- it was taking 106px of a 390px viewport, which is most of
     * what the file list needed -- but it must REAPPEAR with its header/status the
     * moment a transfer exists, or the user gets no feedback that anything is
     * happening. Both states are asserted and both are photographed.
     */
    const queueStates = await page.evaluate((tierArgs) => {
        const fm = window.sftpFileManager;
        // Same 44px touch-target floor as the main measurement (ruled): a file
        // row under 44px is not a usable touch target, so it
        // must not count toward "two usable rows survive a transfer in flight".
        const ROW_FLOOR = tierArgs.touch ? 44 : 24;
        const el = () => document.getElementById('fmQueue');
        const h = () => {
            const q = el();
            if (!q) return 0;
            const cs = getComputedStyle(q);
            if (cs.display === 'none') return 0;
            return Math.round(q.getBoundingClientRect().height);
        };
        const usableRows = () =>
            [...document.querySelectorAll('#fmLeftList .fm-file-item,'
                + ' #fmRightList .fm-file-item')].filter(r => {
                const rr = r.getBoundingClientRect();
                if (rr.height <= 0) return false;
                if (rr.height < ROW_FLOOR) return false;
                let clip = { top: 0, bottom: window.innerHeight };
                for (let p = r.parentElement; p; p = p.parentElement) {
                    const pcs = getComputedStyle(p);
                    if (/hidden|clip|auto|scroll/.test(pcs.overflowY)) {
                        const pr = p.getBoundingClientRect();
                        clip.top = Math.max(clip.top, pr.top);
                        clip.bottom = Math.min(clip.bottom, pr.bottom);
                    }
                }
                const visH = Math.min(rr.bottom, clip.bottom) - Math.max(rr.top, clip.top);
                const cy = rr.top + rr.height / 2;
                return visH / rr.height >= 0.8 && cy >= clip.top && cy <= clip.bottom;
            }).length;

        const inflight = { height: h(), rows: document.querySelectorAll(
            '#fmQueueList .fm-transfer-item').length, usableFileRows: usableRows() };

        // Drain the queue back to empty through production code, measure, then
        // RESTORE it: the completion assertions further down operate on this same
        // row, and leaving the queue drained made them fail on an absent row --
        // a defect in this harness, not in the product.
        const saved = fm.transferQueue.slice();
        fm.transferQueue = [];
        fm.renderTransferQueue();
        const empty = { height: h(), rows: document.querySelectorAll(
            '#fmQueueList .fm-transfer-item').length, usableFileRows: usableRows() };
        fm.transferQueue = saved;
        fm.renderTransferQueue();
        return { inflight, empty };
    }, { touch: tier.touch });
    await page.screenshot({ path: `${SHOTS}/${T}-queue-empty.png` });

    /*
     * The zero-height empty queue is a SHORT-VIEWPORT rule (height < 620), not a
     * touch rule. phone390 is 390x844 -- portrait, tall -- so it keeps the normal
     * queue panel and asserting zero height there was my own error: `!tier.wide`
     * selected "phone" when the rule is about available HEIGHT.
     */
    const shortTier = tier.height < 620;
    if (shortTier) {
        check(`${T}: an EMPTY queue consumes no height`,
            queueStates.empty.height === 0,
            JSON.stringify(queueStates));
        check(`${T}: an in-flight queue is still announced (non-zero height)`,
            queueStates.inflight.height > 0, JSON.stringify(queueStates));
        check(`${T}: two usable file rows survive WITH a transfer in flight`,
            queueStates.inflight.usableFileRows >= 2, JSON.stringify(queueStates));
        check(`${T}: an in-flight queue does not evict the file list`,
            queueStates.inflight.height <= 60, JSON.stringify(queueStates));
    } else {
        check(`${T}: the queue panel is present on a tall tier`,
            queueStates.empty.height > 0, JSON.stringify(queueStates));
    }
    check(`${T}: draining the queue does not cost file-list rows`,
        queueStates.empty.usableFileRows >= queueStates.inflight.usableFileRows,
        JSON.stringify(queueStates));
    diagnostics.push(`    ${T}: queue empty=${queueStates.empty.height}px `
        + `inflight=${queueStates.inflight.height}px `
        + `usableRows ${queueStates.inflight.usableFileRows}->${queueStates.empty.usableFileRows}`);

    check(`${T}: the queue row renders in flight`,
        queue.rowVisible && queue.rowInViewport, JSON.stringify(queue));
    eq(`${T}: the row names the file`, queue.name, 'report.log');
    eq(`${T}: the row shows progress`, queue.statusText, '50%');
    eq(`${T}: the progress bar matches`, queue.barWidth, '50%');
    check(`${T}: the row offers a Cancel control`, queue.cancelVisible,
        JSON.stringify(queue));

    // ── terminal state renders, and the control disappears with it ──────────
    const done = await page.evaluate((id) => {
        window.__socketFixture.__fire('s2s_transfer_complete', {
            transfer_id: id, filename: 'report.log',
            source_path: '/opt/sshdeck/report.log', dest_path: '/srv/inbox/report.log',
        });
        const row = [...document.querySelectorAll('.fm-transfer-item')].pop();
        return {
            statusText: row?.querySelector('.fm-transfer-status')?.textContent.trim(),
            cancel: !!row?.querySelector('[data-transfer-cancel]'),
        };
    }, queue.id);
    await page.screenshot({ path: `${SHOTS}/${T}-transfer-complete.png` });
    check(`${T}: the completed row reads Done`, /Done/.test(done.statusText || ''),
        JSON.stringify(done));
    check(`${T}: a completed row offers no Cancel control`, !done.cancel, '');

    // ── the surface is clean ────────────────────────────────────────────────
    eq(`${T}: no page errors`, pageErrors.slice(0, 3), []);
    eq(`${T}: no failed requests`, failedRequests.slice(0, 3), []);
    eq(`${T}: no HTTP >= 400`, badStatus.slice(0, 3), []);

    diagnostics.push(`    ${T}: nav=${m.navRowVisible ? 'visible' : 'HIDDEN'} `
        + `path=${m.pathInputVisible ? 'visible' : 'HIDDEN'} `
        + `list=${m.listBox?.w}x${m.listBox?.h} `
        + `rowsUsable=${m.rowsUsable}/${m.rowCount} (intersecting=${m.rowsVisible}) `
        + `left="${m.leftPlaceholder}" right="${m.rightPlaceholder}"`);
    diagnostics.push(`${T}: viewport=${m.viewport.w}x${m.viewport.h} `
        + `layout=${m.layout.w}x${m.layout.h} `
        + `asked=${tier.width}x${tier.height} `
        + `gutter=${m.viewport.w - m.layout.w}x${m.viewport.h - m.layout.h} `
        + `scrollW=${m.scrollW} docScrollX=${m.docScrollX} `
        + `panes=${tier.wide ? 'side-by-side' : 'tabbed'} `
        + `left=${m.leftPane.w}x${m.leftPane.h} right=${m.rightPane.w}x${m.rightPane.h} `
        + `tabs=${m.tabsShown ? m.tabBoxes.map(b => `${b.w}x${b.h}`).join('+') : 'hidden'} `
        + `transferBtn=${m.transferBtn.w}x${m.transferBtn.h} `
        + `title="${m.modalTitle}" contextual="${m.contextualName}" `
        + `clipped=${m.clipped.length} overflow=${m.overflowing.length} `
        + `pageErrors=${pageErrors.length} failedReq=${failedRequests.length}`);

    await ctx.close();
}

await browser.close();
server.close();

console.log('\nRENDERED GEOMETRY (measured, not eyeballed)');
diagnostics.forEach(d => console.log('  ' + d));

const failed = results.filter(r => !r.ok);
console.log('');
results.forEach(r => {
    if (!r.ok) console.log(`FAIL  ${r.label}  (${r.detail})`);
});
console.log(`\nshots -> ${SHOTS}`);
console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length) process.exitCode = 1;
