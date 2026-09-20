/*
 * Bucket P -- the panels and read-outs the v5 mockup draws, measured against
 * production markup with a REAL xterm.
 *
 * Why this file exists rather than assertions bolted onto an existing suite:
 * every other touch suite stubs TerminalManager (mobile_shell_layout.mjs:83),
 * which is correct for chrome geometry but makes two of the P items
 * unmeasurable. "The keypad must never cover the terminal" is a statement about
 * the rendered .xterm-screen box, and "the search counter reads N / M" is a
 * statement about the search addon's own onDidChangeResults event. Both need a
 * live terminal with a real buffer, so this suite builds one through the
 * production path (createTerminal -> attachTerminal -> assignSessionToPane) and
 * never stubs it.
 *
 * Sections:
 *   §1  P4 terminal search: the "N / M" counter, prev/next stepping, the
 *       localized no-match string, and the threshold case where the addon
 *       reports resultIndex -1.
 *   §2  P6 keypad vs terminal: the keypad PUSHES the terminal rather than
 *       covering it -- zero overlap against both the grid box and the rendered
 *       .xterm-screen box, at phone and iPad, with the surviving row count
 *       recorded at each tier.
 *   §3  P1 notes panel head: mockup line 177 shape -- flex head, 2px title
 *       grid, the "Tự lưu · <host>" subtitle, a working close control, and the
 *       textarea on the terminal plane.
 *   §4  P2 command rail: mockup line 181 -- 46px single-tap rows with the
 *       corner-down-left affordance, the bordered search field, and insert
 *       still emitting ZERO ssh_input (the mockup's own note, spec line 415,
 *       is "insert to edit BEFORE running").
 *   §5  P5 status bar: mockup line 189/262 content, order and sizes, and the
 *       spec-357/363 removal on phone tiers.
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

function atLeast(label, actual, floor, unit = '') {
    if (typeof actual === 'number' && actual >= floor) {
        pass++;
        console.log(`PASS  ${label} (${actual}${unit} >= ${floor}${unit})`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected >= ${floor}${unit}`
            + `\n        actual   ${actual}${unit}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
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
 * The socket is stubbed and RECORDS every emit, so "insert does not run the
 * command" is a count rather than an impression. TerminalManager is NOT
 * stubbed: this suite's whole point is a real terminal.
 */
const SOCKET_SPY = `
    window.__emits = [];
    const noop = () => {};
    window.socket = {
        connected: true,
        on: noop, off: noop, once: noop,
        emit: (ev, payload) => window.__emits.push([ev, payload]),
        io: { on: noop, engine: { on: noop, transport: { name: 'websocket' } } },
    };
`;

// Seeds sessions through SessionManager's own public entry points, the same way
// the shipped suites do -- no invented credential and no hand-written chip DOM.
const SEED = `
    (() => {
        const mk = (id, host, conn) => {
            SessionManager.sessions[id] = { id, session_id: id, host, port: 22,
                username: 'probe', authType: 'password', keyId: null, jumpHostId: null,
                displayName: host, connected: conn, isPersistentCandidate: false,
                tmuxSessionName: null, terminalId: null, useTmux: false, viaJump: null };
            if (!document.getElementById('tab-' + id)) {
                SessionManager.createSessionTab(id, host, 'probe');
            }
        };
        mk('s1', 'tiny', true);
        mk('s2', 'goclaw', true);
        SessionManager.switchSession('s1');
    })();
`;

// The production sequence for a real xterm in a real pane. Order matters:
// terminalId must be set before createTerminal, and assignSessionToPane is what
// puts the wrapper into the grid track the keypad has to push.
const REAL_TERMINAL = `
    (() => {
        const w = document.createElement('div');
        w.id = 'terminal-s1';
        w.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(w);
        SessionManager.sessions.s1.terminalId = 'terminal-s1';
        TerminalManager.createTerminal('s1');
        TerminalManager.attachTerminal('s1', 'terminal-s1');
        SessionManager.assignSessionToPane('s1', 0);
    })();
`;

/*
 * terminal.write() is ASYNC -- it takes a completion callback. Writing in the
 * same evaluate() as createTerminal leaves the buffer empty, which reads
 * exactly like "search found nothing" and cost a full debugging cycle earlier.
 * This resolves only once xterm has acknowledged every line.
 */
async function writeLines(page, lines) {
    await page.evaluate((rows) => new Promise((resolve) => {
        const key = Object.keys(TerminalManager.terminals)[0];
        const term = TerminalManager.terminals[key];
        let done = 0;
        rows.forEach((line) => term.write(line + '\r\n', () => {
            if (++done === rows.length) resolve();
        }));
    }), lines);
}

async function open(vp, {
    seed = true, terminal = false, notepadCollapsed,
} = {}) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: !!vp.touch, isMobile: !!vp.touch, deviceScaleFactor: 1,
    });
    await ctx.addInitScript(SOCKET_SPY);
    if (notepadCollapsed !== undefined) {
        await ctx.addInitScript(value => {
            localStorage.setItem('notepadCollapsed', value);
        }, notepadCollapsed);
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    /*
     * app.js:15 assigns window.socket = io(...) at LOAD, replacing whatever the
     * init script staged -- so the SOCKET_SPY above is discarded and an emit
     * count taken from it is silently always zero. That is not a hypothetical:
     * mutation M9 (make insert append a carriage return, i.e. re-introduce the
     * pre-v5 "insert secretly runs the command" defect) stayed GREEN against
     * the init-script spy, because nothing was ever recorded to compare.
     *
     * The spy is therefore installed AFTER load by WRAPPING the object
     * production ended up with, the same pattern command_rail.mjs:172 and
     * session_actions.mjs use. Wrapping rather than replacing keeps every other
     * socket method intact.
     */
    await page.evaluate(() => {
        window.__emits = [];
        const real = window.socket?.emit?.bind(window.socket);
        window.socket.emit = (ev, payload, ack) => {
            window.__emits.push([ev, payload]);
            if (typeof ack === 'function') ack({ success: true });
        };
        void real;
    });
    // The mockup's copy is Vietnamese. A bare fixture has no stored preference,
    // so the shell falls back to English -- which would make every P7 wording
    // assertion below compare against the wrong locale. Set through i18n's own
    // public setter, never by writing the strings into the DOM.
    await page.evaluate(() => {
        if (window.i18n && typeof i18n.setLanguage === 'function') {
            try { i18n.setLanguage('vi'); } catch (e) { /* fixture-only */ }
        }
    });
    await page.waitForTimeout(200);
    if (seed) {
        await page.evaluate(SEED);
        await page.waitForTimeout(200);
    }
    if (terminal) {
        await page.evaluate(REAL_TERMINAL);
        await page.waitForTimeout(600);
    }
    return { ctx, page, errors };
}

const DESKTOP = { label: 'desktop', w: 1440, h: 900, touch: false };

// ---------------------------------------------------------------------------
// §1  P4 -- terminal search "N / M"
// ---------------------------------------------------------------------------
console.log('\n== §1 P4 terminal search counter ==');
{
    const { ctx, page, errors } = await open(DESKTOP, { terminal: true });
    await writeLines(page, [
        'first sshdeck line', 'second sshdeck line', 'third sshdeck line',
        'fourth sshdeck line', 'fifth sshdeck line', 'no match here',
    ]);

    const built = await page.evaluate(() => ({
        terminals: Object.keys(TerminalManager.terminals).length,
        addon: typeof TerminalManager.getSearchResults === 'function',
    }));
    check('§1 precondition: a real terminal exists', built.terminals, 1);
    check('§1 precondition: the results cache is exposed', built.addon, true);

    await page.evaluate(() => TerminalSearch.open());
    await page.waitForTimeout(150);

    const placeholder = await page.evaluate(() =>
        document.getElementById('terminalSearchInput').placeholder);
    check('§1 P7: the placeholder is localized, not a hardcoded literal',
        placeholder, 'Tìm trong terminal…');

    await page.fill('#terminalSearchInput', 'sshdeck');
    await page.waitForTimeout(400);
    const first = await page.evaluate(() => {
        const bar = document.getElementById('terminalSearchBar');
        const cs = getComputedStyle(bar);
        const inputCS = getComputedStyle(
            document.getElementById('terminalSearchInput'));
        const glyphUse = bar.querySelector('.search-glyph use');
        return {
            count: document.getElementById('terminalSearchCount').textContent,
            res: TerminalManager.getSearchResults('s1'),
            glyph: glyphUse?.getAttribute('href') || '',
            top: cs.top,
            right: cs.right,
            zIndex: cs.zIndex,
            radius: cs.borderTopLeftRadius,
            padding: cs.padding,
            gap: cs.gap,
            inputBorder: inputCS.borderTopWidth,
            inputBackground: inputCS.backgroundColor,
        };
    });
    check('§1 the counter renders N / M on the first match', first.count, '1 / 5');
    check('§1 and it is driven by the addon event, not a guess',
        first.res && first.res.resultCount, 5);
    check('§1 P4: the bar starts with the mockup search icon',
        first.glyph.includes('#icon-search'), true);
    check('§1 P4: search overlay top offset is 7px', first.top, '7px');
    check('§1 P4: search overlay right offset is 7px', first.right, '7px');
    check('§1 P4: search overlay z-index is 30', first.zIndex, '30');
    check('§1 P4: search overlay radius is 10px', first.radius, '10px');
    check('§1 P4: search overlay padding is 4px 5px',
        first.padding, '4px 5px');
    check('§1 P4: search overlay gap is 4px', first.gap, '4px');
    check('§1 P4: the input inside the overlay is borderless',
        first.inputBorder, '0px');
    check('§1 P4: the input background is transparent',
        first.inputBackground, 'rgba(0, 0, 0, 0)');

    await page.click('#terminalSearchNext');
    await page.waitForTimeout(350);
    check('§1 Next steps the index',
        await page.evaluate(() =>
            document.getElementById('terminalSearchCount').textContent), '2 / 5');

    await page.click('#terminalSearchNext');
    await page.waitForTimeout(350);
    check('§1 Next steps again',
        await page.evaluate(() =>
            document.getElementById('terminalSearchCount').textContent), '3 / 5');

    await page.click('#terminalSearchPrev');
    await page.waitForTimeout(350);
    check('§1 Prev steps back',
        await page.evaluate(() =>
            document.getElementById('terminalSearchCount').textContent), '2 / 5');

    await page.fill('#terminalSearchInput', 'zzzz-no-such-term');
    await page.waitForTimeout(400);
    check('§1 the no-match string is localized too',
        await page.evaluate(() =>
            document.getElementById('terminalSearchCount').textContent),
        'Không có kết quả');

    await page.fill('#terminalSearchInput', '');
    await page.waitForTimeout(300);
    check('§1 an empty term shows no counter at all',
        await page.evaluate(() =>
            document.getElementById('terminalSearchCount').textContent), '');

    /*
     * The addon reports resultIndex -1 when its match threshold is exceeded
     * (@xterm/addon-search: _onDidChangeResults.fire with t = -1). Rendering
     * "0 / N" there would state a position the addon explicitly refused to
     * give, so the bare total is rendered instead. Driven through the real
     * event rather than by calling renderCount with a literal.
     */
    const threshold = await page.evaluate(async () => {
        const key = Object.keys(TerminalManager.terminals)[0];
        TerminalManager.searchResults[key] = { resultIndex: -1, resultCount: 42 };
        document.getElementById('terminalSearchInput').value = 'sshdeck';
        document.dispatchEvent(new CustomEvent('sshdeck:search-results',
            { detail: { key } }));
        return document.getElementById('terminalSearchCount').textContent;
    });
    check('§1 resultIndex -1 renders the bare total, never a fabricated index',
        threshold, '42');

    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2  P6 -- the keypad must never cover the terminal
// ---------------------------------------------------------------------------
console.log('\n== §2 P6 keypad never covers the terminal ==');
{
    const TOUCH = [
        { label: 'ipad-portrait', w: 834, h: 1194, touch: true },
        { label: 'ipad-landscape', w: 1194, h: 834, touch: true },
        { label: 'phone390', w: 390, h: 844, touch: true },
        { label: 'phone359', w: 359, h: 780, touch: true },
        { label: 'phone-landscape', w: 844, h: 390, touch: true },
    ];

    for (const vp of TOUCH) {
        const { ctx, page, errors } = await open(vp, { terminal: true });
        await writeLines(page, ['probe row']);

        const read = () => page.evaluate(() => {
            const key = Object.keys(TerminalManager.terminals)[0];
            const term = key ? TerminalManager.terminals[key] : null;
            const grid = document.getElementById('terminalGrid').getBoundingClientRect();
            const kpEl = document.getElementById('mobileKeypad');
            const kp = kpEl ? kpEl.getBoundingClientRect() : null;
            const compEl = document.getElementById('mobileInputBar');
            const comp = compEl ? compEl.getBoundingClientRect() : null;
            const screenEl = document.querySelector('#terminalGrid .xterm-screen');
            const scr = screenEl ? screenEl.getBoundingClientRect() : null;
            const ov = (a, b) => (a && b)
                ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;
            return {
                rows: term ? term.rows : null,
                open: kpEl ? getComputedStyle(kpEl).display !== 'none' : false,
                kpH: kp ? Math.round(kp.height) : 0,
                kpWidth: kp ? Math.round(kp.width) : null,
                compVisible: !!compEl && comp.height > 0
                    && getComputedStyle(compEl).display !== 'none',
                compPosition: compEl ? getComputedStyle(compEl).position : null,
                kpPosition: kpEl ? getComputedStyle(kpEl).position : null,
                compTop: comp ? Math.round(comp.top) : null,
                compBottom: comp ? Math.round(comp.bottom) : null,
                compWidth: comp ? Math.round(comp.width) : null,
                workspaceH: Math.round(document.querySelector('.main-content')
                    .getBoundingClientRect().height),
                overlapGrid: Math.round(ov(grid, kp)),
                overlapScreen: Math.round(ov(scr, kp)),
                screenBottom: scr ? Math.round(scr.bottom) : null,
                kpTop: kp ? Math.round(kp.top) : null,
                headTitle: document.querySelector('.keypad-head-title')
                    ?.textContent.trim(),
                pageLabel: document.getElementById('keypadPageLabel')
                    ?.textContent.trim(),
                closeDisplay: getComputedStyle(
                    document.getElementById('keypadCloseBtn')).display,
                closeHeight: Math.round(document.getElementById('keypadCloseBtn')
                    .getBoundingClientRect().height),
            };
        });

        const closed = await read();
        await page.click('#mobileKeypadBtn', { force: true }).catch(() => {});
        await page.waitForTimeout(900);
        const opened = await read();

        console.log(`    [${vp.label}] closed=${JSON.stringify(closed)}`);
        console.log(`    [${vp.label}] open  =${JSON.stringify(opened)}`);

        check(`§2 ${vp.label}: the keypad actually opened`, opened.open, true);
        atLeast(`§2 ${vp.label}: and it has real height`, opened.kpH, 40, 'px');
        check(`§2 ${vp.label}: page read-out is Vietnamese and derived`,
            opened.pageLabel, 'Trang 1 / 2');
        if (vp.label !== 'phone-landscape') {
            check(`§2 ${vp.label}: labelled head uses mockup wording`,
                opened.headTitle, 'Phím terminal');
            check(`§2 ${vp.label}: head close remains a 44px touch target`,
                opened.closeHeight, 44);
        } else {
            // The <=500px landscape exception is documented in deck.css: a 44px
            // head removes two terminal rows; it is hidden, never shrunk below
            // the touch floor, and the dock toggle stays the close affordance.
            check('§2 phone-landscape: close is hidden rather than undersized',
                opened.closeDisplay, 'none');
        }
        check(`§2 ${vp.label}: zero overlap with the terminal grid`,
            opened.overlapGrid, 0);
        check(`§2 ${vp.label}: zero overlap with the RENDERED rows box`,
            opened.overlapScreen, 0);
        atMost(`§2 ${vp.label}: the rows box ends at or above the keypad`,
            opened.screenBottom, opened.kpTop, 'px');
        // DEFECT REGRESSION (fixed, static/css/style.css touch
        // block): #sessionBar is a wrapping flex ROW, and the composer
        // (flex: 1 1 0%; min-width: 0) and the keypad (flex: 0 0 100%) used
        // to share ONE flex line -- the keypad's full-width basis collapsed
        // the composer to 0px width and its band overflowed on top of the
        // keypad (measured keypad 689-843 vs composer band 744-788 at phone
        // 390x844). Amendment §6: the keypad follows the composer in flex
        // flow, composer first, keypad second, never a shared line. These
        // assertions pin the corrected geometry at every touch tier.
        check(`§2 ${vp.label}: the composer stays visible while the keypad is open`,
            opened.compVisible, true);
        /* W14 item 6: #mobileInputBar is position:relative solely as the
           containing block for the absolute #broadcastTargetMenu. Relative
           positioning remains IN normal flow (unlike absolute/fixed), so the
           flow contract is now "not out-of-flow" rather than the old static
           keyword. The geometric assertions below still prove ordering and
           zero overlap. */
        check(`§2 ${vp.label}: the composer remains a normal-flow item`,
            ['static', 'relative'].includes(opened.compPosition), true);
        check(`§2 ${vp.label}: the keypad is a normal-flow item`,
            opened.kpPosition, 'static');
        check(`§2 ${vp.label}: the composer starts before the keypad`,
            opened.compTop < opened.kpTop, true);
        atLeast(`§2 ${vp.label}: the keypad starts at or below the composer's bottom`,
            opened.kpTop, opened.compBottom - 1, 'px');
        check(`§2 ${vp.label}: composer and keypad do not share a flex line`,
            opened.compBottom <= opened.kpTop + 1
            && opened.compTop < opened.kpTop, true);
        // The composer has a line to itself at EVERY touch tier, so its width
        // matches the keypad's -- both use the `0 0 100%` basis -- and is
        // never collapsed to 0. Phone landscape used to be the one exception
        // (the composer shared the dock band with the relocated session strip
        // at min(430px, 55vw)); that relocation was retired by owner ruling
        //, so the tier is pinned like the others.
        check(`§2 ${vp.label}: the composer keeps a full-width basis`,
            Math.abs(opened.compWidth - opened.kpWidth) <= 2
            && opened.compWidth > 0, true);
        check(`§2 ${vp.label}: the workspace stays positive with the keypad open`,
            opened.workspaceH > 0, true);
        // The keypad takes rows because it is IN FLOW -- that is the whole
        // point. What must not happen is the terminal keeping its row count
        // while the keypad paints on top of it, which is what an overlay does.
        atLeast(`§2 ${vp.label}: rows remain usable with the keypad open`,
            opened.rows, 7);
        check(`§2 ${vp.label}: opening the keypad reduced rows (it pushes, not covers)`,
            opened.rows < closed.rows, true);
        check(`§2 ${vp.label}: no page errors`, errors.join(' | '), '');
        await ctx.close();
    }
}

// ---------------------------------------------------------------------------
// §2b  the keypad trigger's aria-expanded is the exact inverse of the panel's
//      aria-hidden, on open and on EVERY close path.
//
// A screen-reader user has two sources of truth for whether the sheet is up:
// the trigger's aria-expanded and the panel's aria-hidden. If they disagree the
// control lies about its own state, so the two are asserted as ONE snapshot
// value -- a half-updated state (one attribute written, the other stale) cannot
// pass by satisfying an assertion the other attribute would have caught.
//
// Hosted here rather than in a reduced fixture on purpose: this page is the real
// templates/index.html reached through a real navigation, so app.js binds
// through its own DOMContentLoaded and setKeypad (static/js/app.js:2477-2502) is
// the actual owner under test. Its aria-expanded write is at app.js:2490.
//
// Verified while writing this section: setKeypad is the ONLY writer of the
// keypad's .mobile-open class (app.js:2487), and all four close paths route
// through it -- composer focus (2675), dock toggle (2679), head close (2685) and
// session switch (2802). No path bypasses it, so no product change is needed.
console.log('\n== §2b keypad trigger aria-expanded mirrors aria-hidden ==');
{
    const { ctx, page, errors } = await open(
        { label: 'phone390', w: 390, h: 844, touch: true });

    /*
     * Anti-vacuity pin 1: the initial aria-expanded must come from the TEMPLATE,
     * not from a test-side write and not from app.js's first paint. Read from the
     * served HTML string, so a template that shipped the trigger without the
     * attribute fails here instead of silently making every assertion below a
     * statement about JS only.
     */
    const triggerTag = html.match(/<button[^>]*id="mobileKeypadBtn"[^>]*>/)
        || html.match(/<button[^>]*id="mobileKeypadBtn"[\s\S]*?>/);
    check('§2b the template ships the trigger',
        !!triggerTag, true);
    check('§2b the template itself carries aria-expanded="false"',
        /aria-expanded="false"/.test(triggerTag ? triggerTag[0] : ''), true);
    check('§2b the template itself carries aria-controls="mobileKeypad"',
        /aria-controls="mobileKeypad"/.test(triggerTag ? triggerTag[0] : ''), true);

    // Anti-vacuity pin 2: the head close control really is in this DOM. Without
    // it the head-close path below would be measuring nothing.
    check('§2b the head close control exists in the real DOM',
        await page.evaluate(() => !!document.getElementById('keypadCloseBtn')),
        true);

    // The pair, as one value. Compared via JSON because this suite's check()
    // uses === and would compare two objects by reference.
    const pair = () => page.evaluate(() => JSON.stringify({
        expanded: document.getElementById('mobileKeypadBtn')
            .getAttribute('aria-expanded'),
        hidden: document.getElementById('mobileKeypad')
            .getAttribute('aria-hidden'),
    }));
    const CLOSED = JSON.stringify({ expanded: 'false', hidden: 'true' });
    const OPEN = JSON.stringify({ expanded: 'true', hidden: 'false' });

    check('§2b at rest the pair is closed/hidden', await pair(), CLOSED);

    /*
     * Anti-vacuity pin 3: setKeypad must be REACHABLE. Proven behaviourally --
     * a real click on the template's trigger has to move the pair. If app.js
     * never bound (a fixture regression), this fails and every close-path
     * assertion below is known to be untrustworthy rather than quietly green.
     */
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(120);
    const afterOpen = await pair();
    check('§2b setKeypad is reachable: a real trigger click opened the pair',
        afterOpen, OPEN);
    check('§2b and the panel really is open (not just attributes)',
        await page.evaluate(() =>
            document.getElementById('mobileKeypad')
                .classList.contains('mobile-open')), true);

    // ---- close path 1: the dock toggle -----------------------------------
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(120);
    check('§2b close via dock toggle keeps the pair inverse', await pair(), CLOSED);

    // ---- close path 2: the head close button -----------------------------
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(120);
    check('§2b reopened before the head-close path', await pair(), OPEN);
    await page.click('#keypadCloseBtn', { force: true });
    await page.waitForTimeout(120);
    check('§2b close via the head close button keeps the pair inverse',
        await pair(), CLOSED);

    // ---- close path 3: the composer focus transition ---------------------
    // Tapping the box is the explicit hand-off back to the system keyboard.
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(120);
    check('§2b reopened before the composer-focus path', await pair(), OPEN);
    await page.evaluate(() => document.getElementById('mobileInput').focus());
    await page.waitForTimeout(120);
    check('§2b close via composer focus keeps the pair inverse',
        await pair(), CLOSED);

    // ---- close path 4: a session switch ----------------------------------
    // Driven through SessionManager's own public switch, so the production
    // sshdeck:active-session-changed listener is what closes the sheet.
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(120);
    check('§2b reopened before the session-switch path', await pair(), OPEN);
    await page.evaluate(() => SessionManager.switchSession('s2'));
    await page.waitForTimeout(150);
    check('§2b close via a session switch keeps the pair inverse',
        await pair(), CLOSED);

    /*
     * Ownership. If any other writer touched either attribute, the two would
     * drift apart after repeated transitions rather than on the first one. Two
     * full consecutive toggles, with the pair asserted at every step, is what
     * makes setKeypad demonstrably the single owner rather than merely the first
     * one to run.
     */
    const toggleTrail = [];
    for (let i = 0; i < 2; i += 1) {
        await page.click('#mobileKeypadBtn', { force: true });
        await page.waitForTimeout(120);
        toggleTrail.push(await pair());
        await page.click('#mobileKeypadBtn', { force: true });
        await page.waitForTimeout(120);
        toggleTrail.push(await pair());
    }
    check('§2b two consecutive toggles keep the pair inverse at every step',
        toggleTrail.join(' | '),
        [OPEN, CLOSED, OPEN, CLOSED].join(' | '));

    check('§2b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2c  keypad inventory, locale copy, and a REAL second page.
//
// OWNERSHIP (do not delete either side as a duplicate): mobile_shell_trusted.mjs
// :1244 and the mobile_realtime_input.mjs extractor pin the SOURCE shape (2x8,
// 16 keys, template markup); this section pins the RENDERED page. A template edit
// that keeps the source counts but breaks what the browser actually paints is
// only caught here.
//
// Mockup line 199 read directly: page 1 keys 1-4 are icon-only arrows (their text
// content is empty in the mockup too), keys 5-8 carry text; page 2 is all text.
// So arrows are locked by accessible name plus a painted icon box, and the twelve
// text keys by visible label plus accessible name.
console.log('\n== §2c keypad inventory, locales, and real page 2 ==');
{
    const { ctx, page, errors } = await open(
        { label: 'phone390', w: 390, h: 844, touch: true }, { terminal: true });
    await writeLines(page, ['probe row']);
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(200);

    // open() sets vi by default (this suite measures the Vietnamese mockup copy),
    // so the English inventory below pins its locale explicitly rather than
    // inheriting one -- otherwise these names would be measuring the wrong shell.
    await page.evaluate(() => i18n.setLanguage('en'));
    await page.waitForTimeout(150);

    const inv = await page.evaluate(() => {
        const grids = [...document.querySelectorAll('.mobile-keypad-grid')];
        return grids.map(g => [...g.querySelectorAll('.keypad-key')]
            .sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return (ra.top - rb.top) || (ra.left - rb.left);
            })
            .map(k => {
                const r = k.getBoundingClientRect();
                const icon = k.querySelector('svg.icon');
                return {
                    name: (k.getAttribute('aria-label') || '').trim(),
                    text: k.textContent.trim(),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    iconW: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
                    display: getComputedStyle(k).display,
                };
            }));
    });
    check('§2c the keypad renders exactly two pages', inv.length, 2);
    check('§2c each page renders exactly 8 keys',
        inv.map(p => p.length).join(','), '8,8');
    check('§2c page 1 accessible names match mockup line 199 in painted order',
        inv[0].map(k => k.name).join('|'),
        'Arrow left|Arrow up|Arrow down|Arrow right|Escape|Tab|Shift Tab|Next keypad page');
    check('§2c page 2 accessible names match mockup line 199 in painted order',
        inv[1].map(k => k.name).join('|'),
        'Home|Page up|Page down|End|Control|Alt|Delete|Previous keypad page');
    check('§2c page 2 visible labels match mockup line 199 literally',
        inv[1].map(k => k.text).join('|'),
        'Home|PgUp|PgDn|End|Ctrl|Alt|Del|‹ Previous');
    check('§2c page 1 text keys 5-8 carry the mockup visible labels',
        inv[0].slice(4).map(k => k.text).join('|'), 'Esc|Tab|⇧Tab|Next ›');
    for (const [pi, keys] of inv.entries()) {
        for (const [ki, k] of keys.entries()) {
            const p = `§2c page ${pi + 1} key ${ki + 1}`;
            check(`${p}: is not display:none`, k.display !== 'none', true);
            atLeast(`${p}: meets the 44px touch width`, k.w, 44, 'px');
            atLeast(`${p}: meets the 44px touch height`, k.h, 44, 'px');
            check(`${p}: has a non-empty accessible name`, k.name.length > 0, true);
        }
    }
    for (const [ki, k] of inv[0].slice(0, 4).entries()) {
        atLeast(`§2c page 1 arrow ${ki + 1}: paints a real icon`, k.iconW, 8, 'px');
    }

    // Locale copy: visible labels are the mockup's Vietnamese, while the
    // accessible name comes from the *Label keys and carries NO chevron.
    await page.evaluate(() => i18n.setLanguage('vi'));
    await page.waitForTimeout(150);
    const viCopy = await page.evaluate(() => {
        const n = document.querySelector('.keypad-key[data-keypad-page="2"]');
        const p = document.querySelector('.keypad-key[data-keypad-page="1"]');
        return {
            nextText: n.textContent.trim(),
            prevText: p.textContent.trim(),
            nextName: (n.getAttribute('aria-label') || '').trim(),
            prevName: (p.getAttribute('aria-label') || '').trim(),
        };
    });
    check('§2c vi: Next renders the mockup visible label', viCopy.nextText, 'Tiếp ›');
    check('§2c vi: Previous renders the mockup visible label', viCopy.prevText, '‹ Trước');
    check('§2c vi: Next accessible name comes from keypadNextLabel',
        viCopy.nextName, 'Trang phím tiếp theo');
    check('§2c vi: Previous accessible name comes from keypadPreviousLabel',
        viCopy.prevName, 'Trang phím trước');
    check('§2c vi: Next accessible name carries no chevron',
        /[›‹]/.test(viCopy.nextName), false);
    check('§2c vi: Previous accessible name carries no chevron',
        /[›‹]/.test(viCopy.prevName), false);
    // Template-owned attributes are read from the SERVED HTML string, so a
    // test-side write can never satisfy them.
    const nextTag = html.match(/<button[^>]*data-keypad-page="2"[^>]*>/);
    check('§2c the served template ships the Next control', !!nextTag, true);
    check('§2c the template wires the Next accessible name key',
        /data-i18n-aria-label="terminal\.keypadNextLabel"/.test(nextTag ? nextTag[0] : ''),
        true);
    check('§2c the template wires the Next visible label key',
        /data-i18n="terminal\.keypadNext"/.test(nextTag ? nextTag[0] : ''), true);

    // Page 2 is real, not a label change.
    const resizes = () => page.evaluate(() => window.__emits
        .filter(([e]) => e === 'ssh_resize' || e === 'view_attach').length);
    const beforePaging = await resizes();
    await page.evaluate(() =>
        document.querySelector('.keypad-key[data-keypad-page="2"]').click());
    await page.waitForTimeout(300);
    const p2 = await page.evaluate(() => {
        const t = document.getElementById('mobileKeypadPages');
        const dots = [...document.querySelectorAll('.keypad-dot')];
        const target = document.querySelector('.keypad-key[data-key="Home"]');
        const r = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return {
            scrollLeft: Math.round(t.scrollLeft),
            clientWidth: Math.round(t.clientWidth),
            activeDot: dots.findIndex(d => d.classList.contains('is-active')),
            inViewport: r.left >= 0 && r.right <= window.innerWidth,
            reaches: !!hit && (hit === target || target.contains(hit)),
        };
    });
    check('§2c the page-2 track moved off page 1', p2.scrollLeft > 0, true);
    check('§2c scrollLeft is about one page width',
        Math.abs(p2.scrollLeft - p2.clientWidth) <= 2, true);
    check('§2c the active dot moved to the second page', p2.activeDot, 1);
    check('§2c a page-2 key is inside the viewport', p2.inViewport, true);
    check('§2c a hit test at a page-2 key centre returns that key', p2.reaches, true);
    check('§2c paging emitted no PTY resize', (await resizes()) - beforePaging, 0);

    check('§2c no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2e  Broadcast refuses sticky modifiers.
//
// Hosted here because this suite loads the REAL session-manager.js, whose
// getAllSessions() (session-manager.js:2562) is what BroadcastInput.sendAll()
// needs, and the real template ships #broadcastToggleBtn.
console.log('\n== §2e Broadcast refuses sticky modifiers ==');
{
    const { ctx, page, errors } = await open(
        { label: 'phone390', w: 390, h: 844, touch: true }, { terminal: true });
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(200);

    const modState = n => page.evaluate(k => {
        const b = document.querySelector(`[data-keypad-modifier="${k}"]`);
        return JSON.stringify({
            pressed: b.getAttribute('aria-pressed'),
            painted: b.classList.contains('is-armed'),
        });
    }, n);
    const UNARMED = JSON.stringify({ pressed: 'false', painted: false });
    const ARMED = JSON.stringify({ pressed: 'true', painted: true });
    const inputs = () => page.evaluate(() =>
        window.__emits.filter(([e]) => e === 'ssh_input').length);

    // Anti-vacuity: the toggle and the modifiers exist, and Broadcast really has
    // more than one sendable target, so a fan-out is observable at all.
    check('§2e the Broadcast toggle exists',
        await page.evaluate(() => !!document.getElementById('broadcastToggleBtn')), true);
    check('§2e both sticky modifiers exist',
        await page.evaluate(() =>
            document.querySelectorAll('[data-keypad-modifier]').length), 2);
    check('§2e Broadcast sees two sendable targets',
        await page.evaluate(() => BroadcastInput.targetCount()), 2);

    // A pre-armed modifier is cleared on ENTERING Broadcast.
    await page.evaluate(() =>
        document.querySelector('[data-keypad-modifier="ctrl"]').click());
    check('§2e Ctrl really armed before Broadcast opens', await modState('ctrl'), ARMED);
    await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.value = 'uptime';
        el.setSelectionRange(3, 3);
        window.__emits.length = 0;
        BroadcastInput.show();
    });
    await page.waitForTimeout(150);
    check('§2e Broadcast is open', await page.evaluate(() => BroadcastInput.open), true);
    check('§2e entering Broadcast cleared the armed Ctrl', await modState('ctrl'), UNARMED);
    check('§2e entering Broadcast emitted no ssh_input', await inputs(), 0);

    // Arming is REFUSED while Broadcast is open, and emits nothing.
    await page.evaluate(() => {
        document.querySelector('[data-keypad-modifier="ctrl"]').click();
        document.querySelector('[data-keypad-modifier="alt"]').click();
    });
    // Both modifiers are asserted, and the Alt row is NOT redundant: with the
    // refusal guard removed, the Ctrl click arms Ctrl and the following Alt click
    // arms Alt, which disarms Ctrl -- so the Ctrl assertion passes for the wrong
    // reason and only the Alt row catches the leak. Mutation-verified.
    check('§2e Ctrl cannot arm under Broadcast', await modState('ctrl'), UNARMED);
    check('§2e Alt cannot arm under Broadcast', await modState('alt'), UNARMED);
    check('§2e refused arming emitted no ssh_input', await inputs(), 0);

    // The shared draft and caret are untouched, so explicit Send still fans out.
    check('§2e the shared draft text and caret are preserved',
        await page.evaluate(() => {
            const el = document.getElementById('mobileInput');
            return JSON.stringify(
                { v: el.value, s: el.selectionStart, e: el.selectionEnd });
        }),
        JSON.stringify({ v: 'uptime', s: 3, e: 3 }));
    await page.evaluate(() => { window.__emits.length = 0; });
    await page.click('#mobileSendBtn', { force: true });
    await page.waitForTimeout(250);
    check('§2e explicit Send still fans the draft out to both targets',
        (await page.evaluate(() => window.__emits
            .filter(([e]) => e === 'ssh_input')
            .map(([, p]) => `${p.session_id}:${p.data}`)
            .sort())).join(' | '),
        's1:uptime\r | s2:uptime\r');

    check('§2e no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2d  exact PTY resize accounting for the keypad.
//
// terminal.onResize in terminal-manager.js is the ONE emitter of ssh_resize, so
// these counts describe real geometry changes: open and close each move the
// terminal box exactly once, and a page change -- both pages being the same 4x2
// grid inside one fixed-height track -- must move nothing. 844x390 is RETAINED
// and 926x428 is added alongside it.
console.log('\n== §2d keypad PTY resize accounting ==');
for (const vp of [
    { label: 'phone390', w: 390, h: 844, touch: true },
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true },
    { label: 'phone-landscape', w: 844, h: 390, touch: true },
    { label: 'landscape926', w: 926, h: 428, touch: true },
]) {
    const { ctx, page, errors } = await open(vp, { terminal: true });
    await writeLines(page, ['probe row']);
    /*
     * Stand the view up as ATTACHED before the counting starts. A pane whose
     * attach is still in flight parks its next size instead of sending it --
     * there is no tmux client to resize yet, and the ack applies the parked
     * size as one resize -- so an unacknowledged fixture would count zero for
     * the keypad open and make the row below say the opposite of what it means.
     */
    await page.evaluate(() => {
        const sid = Object.keys(TerminalManager.sessionTerminals)[0];
        if (sid) TerminalManager.noteViewAttached(sid);
    });
    await page.waitForTimeout(300);

    /*
     * The pane telling the server what it fits, in EITHER form.
     *
     *: a pane's first report carries its size on `view_attach` --
     * there is no tmux client to resize until this socket has one -- and every
     * report after the attach is an `ssh_resize`. This harness has no server to
     * acknowledge the attach, so counting only `ssh_resize` would read a
     * correctly reported keyboard open as no report at all. What this section
     * is about is the COUNT: exactly one per box change, never two.
     */
    const resizes = () => page.evaluate(() => window.__emits
        .filter(([e]) => e === 'ssh_resize' || e === 'view_attach').length);
    const geom = () => page.evaluate(() => {
        const key = Object.keys(TerminalManager.terminals)[0];
        const t = key ? TerminalManager.terminals[key] : null;
        return t ? `${t.rows}x${t.cols}` : 'none';
    });

    // Anti-vacuity: a live terminal must exist, or every count below is a
    // statement about an emitter that was never wired.
    check(`§2d ${vp.label}: a real terminal exists`,
        await page.evaluate(() =>
            Object.keys(TerminalManager.terminals).length), 1);

    // Settle first: attach/fit churn from setup is not charged to the open.
    await page.evaluate(() => { window.__emits.length = 0; });
    const closedGeom = await geom();

    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(700);
    const openGeom = await geom();
    check(`§2d ${vp.label}: opening the keypad emits exactly one PTY resize`,
        await resizes(), 1);
    check(`§2d ${vp.label}: and the terminal geometry really changed`,
        openGeom !== closedGeom, true);

    await page.evaluate(() => { window.__emits.length = 0; });
    await page.evaluate(() =>
        document.querySelector('.keypad-key[data-keypad-page="2"]').click());
    await page.waitForTimeout(700);
    check(`§2d ${vp.label}: a page change emits zero PTY resizes`,
        await resizes(), 0);
    check(`§2d ${vp.label}: rows and cols are unchanged by a page change`,
        await geom(), openGeom);

    await page.evaluate(() => { window.__emits.length = 0; });
    await page.click('#mobileKeypadBtn', { force: true });
    await page.waitForTimeout(700);
    check(`§2d ${vp.label}: closing the keypad emits exactly one PTY resize`,
        await resizes(), 1);
    check(`§2d ${vp.label}: and the geometry is restored`, await geom(), closedGeom);

    check(`§2d ${vp.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2f  a fine-pointer desktop under 501px tall must not paint an empty dock.
//
// The required contract, written as the contract rather than as current
// behaviour. A separate fine-pointer context is mandatory: (pointer: coarse) is
// a property of the input device, so a touch context matches coarse at every
// viewport size and resizing cannot emulate a mouse.
console.log('\n== §2f short fine-pointer desktop has no empty dock ==');
for (const vp of [{ w: 1280, h: 480 }, { w: 1440, h: 420 }]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        hasTouch: false, isMobile: false, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const dock = await page.evaluate(() => {
        const bar = document.getElementById('sessionBar');
        if (!bar) return { present: false };
        const cs = getComputedStyle(bar);
        const rect = bar.getBoundingClientRect();
        // "Empty" means: painted, but holding no control a user could actually
        // reach. Measured from the children's own boxes, not from a class name.
        const visibleControls = [...bar.querySelectorAll('button, textarea, input')]
            .filter((el) => {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden'
                    && parseFloat(s.opacity) > 0 && r.width > 0 && r.height > 0;
            }).length;
        return {
            present: true,
            coarse: window.matchMedia('(pointer: coarse)').matches,
            display: cs.display,
            height: Math.round(rect.height),
            visibleControls,
        };
    });

    check(`§2f ${vp.w}x${vp.h}: the dock element exists to be measured`,
        dock.present, true);
    check(`§2f ${vp.w}x${vp.h}: really a fine-pointer context`, dock.coarse, false);
    check(`§2f ${vp.w}x${vp.h}: no empty session dock is painted`,
        dock.display === 'none' || dock.visibleControls > 0, true);
    check(`§2f ${vp.w}x${vp.h}: an absent dock occupies no vertical space`,
        dock.display === 'none' ? dock.height === 0 : true, true);
    check(`§2f ${vp.w}x${vp.h}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §3  P1 -- notes panel head
// ---------------------------------------------------------------------------
console.log('\n== §3 P1 notes panel ==');
{
    const { ctx, page, errors } = await open(DESKTOP);

    /*
     * First visit has no notepadCollapsed key. v5 starts Notes closed, with no
     * auxiliary track charged to the terminal. Open through the one production
     * desktop control rather than removing .collapsed in the fixture, so the
     * ceiling and floor exercise the same state helper a user reaches.
     */
    const initial = await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        const terminal = document.querySelector('.terminal-area').getBoundingClientRect();
        const tracks = getComputedStyle(document.getElementById('workspace'))
            .gridTemplateColumns.split(' ').map(parseFloat);
        return {
            stored: localStorage.getItem('notepadCollapsed'),
            collapsed: panel.classList.contains('collapsed'),
            panelWidth: Math.round(panel.getBoundingClientRect().width),
            auxiliaryTrack: Math.round(tracks[1] || 0),
            terminalWidth: Math.round(terminal.width),
        };
    });
    check('§3 storage-absent first visit has no preference',
        initial.stored, null);
    check('§3 storage-absent first visit starts collapsed',
        initial.collapsed, true);
    check('§3 first-visit auxiliary panel width is zero',
        initial.panelWidth, 0);
    check('§3 first-visit auxiliary track is zero',
        initial.auxiliaryTrack, 0);
    atLeast('§3 the closed state leaves a usable terminal',
        initial.terminalWidth, 600, 'px');

    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(350);

    const head = await page.evaluate(() => {
        const g = (sel, props) => {
            const n = document.querySelector(sel);
            if (!n) return null;
            const cs = getComputedStyle(n);
            const out = {};
            props.forEach(p => { out[p] = cs[p]; });
            return out;
        };
        const panel = document.getElementById('notepadPanel');
        const ta = document.getElementById('sessionNotepad');
        const taCS = getComputedStyle(ta);
        const grid = document.querySelector('#terminalGrid, .terminal-area');
        const panelRect = panel.getBoundingClientRect();
        const taRect = ta.getBoundingClientRect();
        const terminalRect = document.querySelector('.terminal-area')
            .getBoundingClientRect();
        return {
            head: g('.notepad-header',
                ['display', 'alignItems', 'justifyContent', 'gap', 'padding']),
            titleRow: g('.notepad-title-row', ['display', 'gap']),
            metaFontSize: getComputedStyle(
                document.querySelector('.notepad-meta')).fontSize,
            children: [...document.querySelector('.notepad-header').children]
                .map(n => n.className.split(' ')[0]),
            meta: document.querySelector('.notepad-meta').textContent
                .replace(/\s+/g, ' ').trim(),
            closeExists: !!document.getElementById('notepadCloseBtn'),
            ta: { margin: taCS.margin, padding: taCS.padding,
                border: taCS.borderTopWidth, radius: taCS.borderTopLeftRadius,
                bg: taCS.backgroundColor },
            termPlane: grid
                ? getComputedStyle(document.body).getPropertyValue('--tw-terminal').trim()
                : null,
            minWidth: getComputedStyle(panel).minWidth,
            openGeometry: {
                panelWidth: Math.round(panelRect.width),
                contained: panelRect.left >= 0 && panelRect.right <= innerWidth,
                terminalWidth: Math.round(terminalRect.width),
            },
            textareaContained: taRect.left >= panelRect.left
                && taRect.right <= panelRect.right
                && taRect.top >= panelRect.top
                && taRect.bottom <= panelRect.bottom,
        };
    });

    // Spec 292.
    check('§3 the head is a flex row', head.head.display, 'flex');
    check('§3 head centres its children', head.head.alignItems, 'center');
    check('§3 head pushes the close control to the far edge',
        head.head.justifyContent, 'space-between');
    check('§3 head gap is the mockup 8px', head.head.gap, '8px');
    check('§3 head padding is the mockup 9px', head.head.padding, '9px');
    // Spec 293.
    check('§3 the title block is a 2px grid, not a flex row',
        head.titleRow.display, 'grid');
    check('§3 title/subtitle gap is 2px', head.titleRow.gap, '2px');
    check('§3 the head holds exactly title-block + close',
        head.children.join(','), 'notepad-title-row,notepad-close');
    check('§3 P1/P7: the subtitle names the session host',
        head.meta, 'Tự lưu · tiny');
    /*
     * Mockup v5 spec 294 sets only `color` on .tw5-panel-head small. Against
     * its 16px root, Chromium renders that inherited <small> default at
     * 13.33px. The app uses a <div>, so deck.css states the whole-pixel 13px
     * equivalent explicitly. This is also the interface-text floor regression:
     * 11px failed modal_narrow at both 428x926 and 359x780.
     */
    check('§3 the meta line matches the mockup 13px rendered size',
        head.metaFontSize, '13px');
    check('§3 a close control exists (mockup line 177)', head.closeExists, true);
    // Spec 295.
    check('§3 the textarea keeps the mockup 9px margin', head.ta.margin, '9px');
    check('§3 and the mockup 9px padding', head.ta.padding, '9px');
    check('§3 and a 1px border', head.ta.border, '1px');
    check('§3 and a 7px radius', head.ta.radius, '7px');
    // Spec 290.
    check('§3 the panel takes the mockup 255px floor', head.minWidth, '255px');
    atLeast('§3 opening Notes gives the panel a positive width',
        head.openGeometry.panelWidth, 255, 'px');
    check('§3 the open Notes panel stays inside the viewport',
        head.openGeometry.contained, true);
    atLeast('§3 opening Notes leaves a usable terminal',
        head.openGeometry.terminalWidth, 255, 'px');
    check('§3 the textarea stays inside the panel on all four edges',
        head.textareaContained, true);

    // The close control is a real control, not decoration.
    const closed = await page.evaluate(() => {
        document.getElementById('notepadCloseBtn').click();
        return document.getElementById('notepadPanel').classList.contains('collapsed');
    });
    check('§3 the close control actually closes the panel', closed, true);

    // The host tracks the session, which is the reason it is there at all.
    const switched = await page.evaluate(() => {
        SessionManager.switchSession('s2');
        return document.getElementById('notepadMetaHost').textContent.trim();
    });
    check('§3 the host follows the active session', switched, '· goclaw');

    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();

    // One independent companion: an explicit false preference must open Notes.
    {
        const {
            ctx: explicitCtx,
            page: explicitPage,
            errors: explicitErrors,
        } = await open(DESKTOP, { notepadCollapsed: 'false' });
        await explicitPage.waitForTimeout(100);

        const explicitState = await explicitPage.evaluate(() => {
            const panel = document.getElementById('notepadPanel');
            const textarea = document.getElementById('sessionNotepad');
            const panelRect = panel.getBoundingClientRect();
            const textareaRect = textarea.getBoundingClientRect();
            return {
                stored: localStorage.getItem('notepadCollapsed'),
                collapsed: panel.classList.contains('collapsed'),
                textareaContained: textareaRect.left >= panelRect.left
                    && textareaRect.right <= panelRect.right
                    && textareaRect.top >= panelRect.top
                    && textareaRect.bottom <= panelRect.bottom,
            };
        });

        check('§3 explicit false stores the open preference',
            explicitState.stored, 'false');
        check('§3 explicit false opens Notes',
            explicitState.collapsed, false);
        check('§3 explicit false keeps the textarea contained',
            explicitState.textareaContained, true);
        check('§3 explicit false has no page errors',
            explicitErrors.join(' | '), '');

        await explicitCtx.close();
    }
}

// ---------------------------------------------------------------------------
// §4  P2 -- command rail list rows
// ---------------------------------------------------------------------------
console.log('\n== §4 P2 command library rows ==');
{
    const { ctx, page, errors } = await open(DESKTOP);
    await page.evaluate(() => {
        CommandLibrary.commands = [{
            id: 'c1', name: 'Trạng thái dịch vụ', command: 'systemctl status',
            parameters: '', description: '', os: ['linux'], isSystem: true,
        }, {
            id: 'c2', name: 'Theo dõi log', command: 'journalctl -u · -f',
            parameters: '', description: '', os: ['linux'], isSystem: false,
        }];
        CommandLibrary.filteredCommands = CommandLibrary.commands.slice();
        CommandLibrary.toggleLibrary(document.getElementById('commandLibraryBtn'));
        CommandLibrary.renderCommandsList();
    });
    await page.waitForTimeout(400);

    const rail = await page.evaluate(() => {
        const item = document.querySelector('.command-rail-item');
        const cs = item ? getComputedStyle(item) : null;
        const search = document.querySelector('.command-rail .command-toolbar');
        const sCS = search ? getComputedStyle(search) : null;
        const span = item ? getComputedStyle(item.querySelector('span')) : null;
        return {
            rows: document.querySelectorAll('.command-rail-item').length,
            rowDirection: getComputedStyle(
                document.querySelector('.command-row')).flexDirection,
            rowHeight: Math.round(document.querySelector('.command-row')
                .getBoundingClientRect().height),
            subtitle: document.querySelector('.command-rail-subtitle')
                ?.textContent.trim(),
            subtitleFontSize: getComputedStyle(
                document.querySelector('.command-rail-subtitle')).fontSize,
            titleFontSize: getComputedStyle(
                document.querySelector('.command-rail-header h2')).fontSize,
            minHeight: cs && cs.minHeight,
            height: item ? Math.round(item.getBoundingClientRect().height) : null,
            padding: cs && cs.padding,
            gap: cs && cs.gap,
            justify: cs && cs.justifyContent,
            spanDisplay: span && span.display,
            spanGap: span && span.gap,
            glyph: item
                ? item.querySelector(':scope > .icon use')?.getAttribute('href') : null,
            isButton: item ? item.tagName : null,
            nestedButtons: item ? item.querySelectorAll('button').length : null,
            searchDisplay: sCS && sCS.display,
            searchPadding: sCS && sCS.padding,
            searchGap: sCS && sCS.gap,
            searchBorder: sCS && sCS.borderTopWidth,
            searchRadius: sCS && sCS.borderTopLeftRadius,
            searchIsLabel: search ? search.tagName : null,
            inputBorder: getComputedStyle(
                document.getElementById('commandSearchInput')).borderTopWidth,
        };
    });

    check('§4 both seeded commands render as rows', rail.rows, 2);
    check('§4 P7: the rail carries the mockup subtitle',
        rail.subtitle, 'Chèn để sửa trước khi chạy');
    check('§4 the panel title matches the mockup 16px strong',
        rail.titleFontSize, '16px');
    check('§4 the subtitle matches the mockup 13px rendered small',
        rail.subtitleFontSize, '13px');
    // Spec 298.
    /*
     * The row is ONE line, and that is load-bearing rather than cosmetic: a
     * stacked two-line entry measured ~97px, which starved the phone-landscape
     * sheet's own scroller to 0px and put the first row outside it, so its
     * Insert lost the pre-scroll hit test. Asserted as geometry, not as a
     * keyword, and bounded so a third line cannot creep back in.
     */
    check('§4 the entry is one row, not a stacked card', rail.rowDirection, 'row');
    atMost('§4 and the whole entry stays within one mockup row', rail.rowHeight, 48, 'px');
    check('§4 the row takes the mockup 46px floor', rail.minHeight, '46px');
    check('§4 and measures it', rail.height, 46);
    check('§4 row padding is the mockup 7px 9px', rail.padding, '7px 9px');
    check('§4 row gap is 8px', rail.gap, '8px');
    check('§4 the affordance glyph sits at the far edge',
        rail.justify, 'space-between');
    // Spec 293.
    check('§4 the row text block is a 2px grid', rail.spanDisplay, 'grid');
    check('§4 with a 2px gap', rail.spanGap, '2px');
    check('§4 the trailing glyph is corner-down-left (mockup line 181)',
        rail.glyph && rail.glyph.includes('#icon-corner-down-left'), true);
    check('§4 the whole row is the tappable control', rail.isButton, 'BUTTON');
    check('§4 and holds no nested button (invalid markup)', rail.nestedButtons, 0);
    // Spec 296/297.
    check('§4 the search field is the bordered box', rail.searchDisplay, 'flex');
    check('§4 search padding is the mockup 6px 7px', rail.searchPadding, '6px 7px');
    check('§4 search gap is 6px', rail.searchGap, '6px');
    check('§4 the box carries the border', rail.searchBorder, '1px');
    check('§4 and the 7px radius', rail.searchRadius, '7px');
    check('§4 it is a label, so the whole box focuses the input',
        rail.searchIsLabel, 'LABEL');
    check('§4 the input inside it is bare', rail.inputBorder, '0px');

    /*
     * The mockup's own behaviour note (spec line 415) is "insert to edit BEFORE
     * running", so tapping a row must NOT reach the remote. Counted from the
     * socket spy, not inferred.
     */
    const before = await page.evaluate(() => window.__emits.length);
    await page.click('.command-rail-item');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
        total: window.__emits.length,
        ssh: window.__emits.filter(([e]) => e === 'ssh_input').length,
        withCR: window.__emits.filter(([e, p]) =>
            e === 'ssh_input' && typeof p?.data === 'string'
            && p.data.includes('\r')).length,
    }));
    check('§4 tapping a row emits no carriage return, so nothing RUNS',
        after.withCR, 0);
    check('§4 desktop insert writes to the prompt exactly once',
        after.ssh - before >= 0 && after.ssh <= 1, true);

    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §5  P5 -- status bar
// ---------------------------------------------------------------------------
console.log('\n== §5 P5 status bar ==');
{
    const { ctx, page, errors } = await open(DESKTOP, { terminal: true });
    await page.waitForTimeout(300);

    /*
     * There is no socket.io server behind this fixture, so the page's own
     * socket never reaches connected -- and refresh() last ran before the
     * terminal existed. Both are fixture facts, not app behaviour: flip the
     * connected flag on the REAL socket object and call the REAL refresh, so
     * currentState() and activeTerminal() run their own code. That is exactly
     * the path the `window.SessionManager` guard broke.
     */
    await page.evaluate(() => {
        window.socket.connected = true;
        StatusBar.refresh();
    });
    await page.waitForTimeout(150);

    const sb = await page.evaluate(() => {
        const bar = document.getElementById('statusBar');
        const cs = getComputedStyle(bar);
        const left = getComputedStyle(document.querySelector('.status-bar-left'));
        const body = getComputedStyle(document.body);
        const tok = (n) => body.getPropertyValue(n).trim();
        const norm = (v) => {
            const d = document.createElement('div');
            d.style.color = v; document.body.appendChild(d);
            const out = getComputedStyle(d).color; d.remove(); return out;
        };
        return {
            minHeight: cs.minHeight,
            height: Math.round(bar.getBoundingClientRect().height),
            padding: cs.padding,
            justify: cs.justifyContent,
            borderTop: cs.borderTopWidth,
            leftGap: left.gap,
            leftNowrap: left.whiteSpace,
            bgMatchesToken: cs.backgroundColor === norm(tok('--tw-bar')),
            colorMatchesToken: cs.color === norm(tok('--tw-muted')),
            order: [...bar.querySelectorAll('span[id]')].map(n => n.id),
            state: bar.dataset.state,
            stateText: document.getElementById('statusBarStateText').textContent.trim(),
            dims: document.getElementById('statusBarDims').textContent.trim(),
            dimsWeight: getComputedStyle(
                document.getElementById('statusBarDims')).fontWeight,
            encoding: document.getElementById('statusBarEncoding').textContent.trim(),
        };
    });

    // Spec 262.
    check('§5 the band takes the mockup 22px floor', sb.minHeight, '22px');
    check('§5 and measures it', sb.height, 22);
    check('§5 padding is the mockup 3px 8px', sb.padding, '3px 8px');
    check('§5 the two halves sit at opposite edges', sb.justify, 'space-between');
    check('§5 it carries the hairline', sb.borderTop, '1px');
    check('§5 background is the bar token, no literal', sb.bgMatchesToken, true);
    check('§5 ink is the muted token, no literal', sb.colorMatchesToken, true);
    // Spec 263.
    check('§5 each half uses the mockup 5px gap', sb.leftGap, '5px');
    check('§5 and never wraps', sb.leftNowrap, 'nowrap');
    // Spec 189 content and order.
    check('§5 content order is state, latency, encoding, dims',
        sb.order.join(','),
        'statusBarState,statusBarDot,statusBarStateText,statusBarLatency,'
        + 'statusBarEncoding,statusBarDims');
    check('§5 encoding reads UTF-8', sb.encoding, 'UTF-8');
    /*
     * P5 defect this section was written for: currentState() and
     * activeTerminal() both guarded on `window.SessionManager`, but
     * SessionManager is a top-level const and is never put on window -- so the
     * band could never report "connected" and the geometry read-out was always
     * blank. Both are asserted with a real session AND a real terminal present.
     */
    check('§5 with a session and a live socket the band reports connected',
        sb.state, 'connected');
    check('§5 and says so in Vietnamese', sb.stateText, 'Đã kết nối');
    check('§5 the geometry read-out is populated, not blank',
        /^\d+ × \d+$/.test(sb.dims), true);
    check('§5 the geometry is the bold run (mockup line 189)', sb.dimsWeight, '700');

    check('§5 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// Spec 357/363: the band is REMOVED on phone tiers, not shrunk.
{
    for (const vp of [
        { label: 'phone390', w: 390, h: 844, touch: true },
        { label: 'phone359', w: 359, h: 780, touch: true },
        { label: 'phone-landscape', w: 844, h: 390, touch: true },
    ]) {
        const { ctx, page } = await open(vp);
        check(`§5 ${vp.label}: the band is removed (spec 357/363)`,
            await page.evaluate(() =>
                getComputedStyle(document.getElementById('statusBar')).display),
            'none');
        await ctx.close();
    }
    for (const vp of [
        { label: 'ipad-portrait', w: 834, h: 1194, touch: true },
        { label: 'desktop-compact', w: 1024, h: 768, touch: false },
    ]) {
        const { ctx, page } = await open(vp);
        check(`§5 ${vp.label}: the band is kept`,
            await page.evaluate(() =>
                getComputedStyle(document.getElementById('statusBar')).display),
            'flex');
        await ctx.close();
    }
}

// ---------------------------------------------------------------------------
// §6  P3 -- SFTP panel head, actions and rows
// ---------------------------------------------------------------------------
console.log('\n== §6 P3 SFTP panel ==');
{
    const { ctx, page, errors } = await open(DESKTOP);
    // The manager is lazy by design: the large SFTP DOM is created only when
    // the user opens it. Use its public entry point rather than constructing a
    // parallel fixture or reaching into the class constructor.
    await page.evaluate(() => window.openFileManager());
    await page.waitForFunction(() => !!window.sftpFileManager);
    await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.panes.left.type = 'ssh';
        fm.panes.left.sessionId = 's1';
        fm.panes.left.path = '/opt/sshdeck';
        fm.panes.left.hostInfo = { username: 'root', host: 'tiny' };
        fm.panes.left.files = [
            { name: 'static', is_dir: true, permissions: 'drwxr-xr-x', size: 0 },
            { name: 'app.log', is_dir: false, permissions: '-rw-r--r--', size: 2048 },
        ];
        fm.updatePaneBadge('left');
        fm.renderPane('left');
    });
    await page.waitForTimeout(250);

    const fm = await page.evaluate(() => {
        const head = document.querySelector('#fmLeftPane .fm-panel-head');
        const hcs = getComputedStyle(head);
        const actions = document.querySelector('#fmLeftPane .fm-file-actions');
        const acs = getComputedStyle(actions);
        const rows = [...document.querySelectorAll('#fmLeftList .fm-file-item')];
        const directory = rows.find(n => n.dataset.type === 'directory');
        const dcs = directory ? getComputedStyle(directory) : null;
        return {
            title: document.getElementById('fmLeftTitle').textContent.trim(),
            path: document.getElementById('fmLeftHeadPath').textContent.trim(),
            headDisplay: hcs.display,
            headPadding: hcs.padding,
            headGap: hcs.gap,
            actionsDisplay: acs.display,
            actionsPadding: acs.padding,
            actionsGap: acs.gap,
            uploadText: document.querySelector('#fmLeftUpload span')?.textContent.trim(),
            uploadIcon: document.querySelector('#fmLeftUpload use')?.getAttribute('href'),
            folderIcon: document.querySelector('#fmLeftNewFolder use')?.getAttribute('href'),
            rows: rows.filter(n => n.dataset.type !== 'parent').length,
            parentRows: rows.filter(n => n.dataset.type === 'parent').length,
            directoryName: directory?.querySelector('.fm-file-name')?.textContent.trim(),
            directoryMeta: directory?.querySelector('.fm-file-meta')?.textContent.trim(),
            directoryChevron: directory?.querySelector('.fm-file-chevron use')
                ?.getAttribute('href'),
            rowColumns: dcs?.gridTemplateColumns,
            fileMeta: rows.find(n => n.dataset.type === 'file')
                ?.querySelector('.fm-file-meta')?.textContent.trim(),
            fileHasChevron: !!rows.find(n => n.dataset.type === 'file')
                ?.querySelector('.fm-file-chevron'),
        };
    });

    check('§6 P3/P7: header names the host in Vietnamese', fm.title, 'Tệp · tiny');
    check('§6 P3: header exposes the active breadcrumb path',
        fm.path, '/opt/sshdeck');
    check('§6 P3: header is the mockup flex row', fm.headDisplay, 'flex');
    check('§6 P3: header padding is 9px', fm.headPadding, '9px');
    check('§6 P3: header gap is 8px', fm.headGap, '8px');
    check('§6 P3: file actions are a flex row', fm.actionsDisplay, 'flex');
    check('§6 P3: file actions padding is 9px', fm.actionsPadding, '9px');
    check('§6 P3: file actions gap is 5px', fm.actionsGap, '5px');
    check('§6 P3/P7: upload wording is Vietnamese', fm.uploadText, 'Tải lên');
    check('§6 P3: upload affordance uses icon-upload',
        fm.uploadIcon?.includes('#icon-upload'), true);
    check('§6 P3: new-folder affordance uses icon-folder-plus',
        fm.folderIcon?.includes('#icon-folder-plus'), true);
    check('§6 P3: both seeded rows render', fm.rows, 2);
    check('§6 P3: non-root breadcrumb keeps one parent row', fm.parentRows, 1);
    check('§6 P3: directory row keeps its name', fm.directoryName, 'static');
    check('§6 P3/P7: directory kind is Vietnamese',
        fm.directoryMeta?.startsWith('Thư mục'), true);
    check('§6 P3: directory row ends in chevron-right',
        fm.directoryChevron?.includes('#icon-chevron-right'), true);
    check('§6 P3: file size remains visible in its meta line',
        fm.fileMeta?.includes('2 KB'), true);
    check('§6 P3: files do not fake a navigation chevron', fm.fileHasChevron, false);

    // The per-pane Upload control must delegate to the ONE existing hidden file
    // input, not create another input or another upload handler.
    const upload = await page.evaluate(() => {
        const input = document.getElementById('fmMobileUploadInput');
        let clicks = 0;
        input.addEventListener('click', e => { clicks++; e.preventDefault(); },
            { once: true });
        document.getElementById('fmLeftUpload').click();
        return {
            clicks,
            activePane: window.sftpFileManager.activePane,
            inputs: document.querySelectorAll('#fmMobileUploadInput').length,
        };
    });
    check('§6 P3: Upload delegates to the existing file input once',
        upload.clicks, 1);
    check('§6 P3: Upload targets the pane it is drawn in',
        upload.activePane, 'left');
    check('§6 P3: there is still exactly one upload input', upload.inputs, 1);

    check('§6 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §7  P3 -- the v5 INLINE inspector (#sftpPanel)
//
// §6 above measures the legacy dual-pane modal's left pane. That pane is no
// longer what the File button opens, so on its own it proves nothing about the
// surface the user actually sees: the gate-2 review found the app showing the
// full-screen modal and "Tap to upload files" where v5 draws a compact
// inspector beside the terminal. This section measures that inspector through
// the production entry point (#fileTransferBtn), and the modal stays in the
// suite as the advanced transfer surface it now is.
// ---------------------------------------------------------------------------
console.log('\n== §7 P3 inline SFTP inspector ==');

// Seeds the inline pane with a listing. The socket is a spy, so no real
// directory_listing ever arrives -- openInline leaves the pane in `loading` and
// arms a 10s timeout. Both are cleared here so the rows under test are the
// seeded ones and no late timeout re-renders an error mid-section.
const SEED_INLINE = `
    (() => {
        const fm = window.sftpFileManager;
        const s = fm.panes.inline;
        if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
        s.loading = false;
        s.error = null;
        s.path = '/opt/sshdeck';
        s.hostInfo = { username: 'root', host: 'tiny' };
        s.files = [
            { name: 'static', is_dir: true, permissions: 'drwxr-xr-x', size: 0 },
            { name: 'app.log', is_dir: false, permissions: '-rw-r--r--', size: 2048 },
        ];
        fm.updatePaneBadge('inline');
        fm.renderPane('inline');
    })();
`;

{
    const { ctx, page, errors } = await open(DESKTOP);

    // Closed state, straight from the template -- before the manager exists.
    const before = await page.evaluate(() => {
        const p = document.getElementById('sftpPanel');
        const panelRect = p.getBoundingClientRect();
        const terminalRect = document.querySelector('.terminal-area')
            .getBoundingClientRect();
        return {
            present: !!p,
            display: getComputedStyle(p).display,
            inert: p.hasAttribute('inert'),
            ariaHidden: p.getAttribute('aria-hidden'),
            lazy: !window.sftpFileManager,
            panelWidth: Math.round(panelRect.width),
            terminalWidth: Math.round(terminalRect.width),
        };
    });
    check('§7 the panel host ships in the template', before.present, true);
    check('§7 closed by default', before.display, 'none');
    check('§7 closed panel is inert', before.inert, true);
    check('§7 closed panel is hidden from AT', before.ariaHidden, 'true');
    check('§7 the manager is still lazy before first open', before.lazy, true);
    check('§7 closed panel has no painted width', before.panelWidth, 0);
    atLeast('§7 closed SFTP leaves the terminal full and usable',
        before.terminalWidth, 600, 'px');

    /*
     * The header button, clicked for real. Calling openInline() directly would
     * pass even if #fileTransferBtn were still wired to the legacy modal, which
     * is exactly the defect this section exists to catch.
     */
    await page.click('#fileTransferBtn');
    await page.waitForFunction(() => !!window.sftpFileManager);
    await page.waitForTimeout(150);

    const opened = await page.evaluate(() => {
        const p = document.getElementById('sftpPanel');
        const cs = getComputedStyle(p);
        const workspace = document.getElementById('workspace');
        const workspaceRect = workspace.getBoundingClientRect();
        const panelRect = p.getBoundingClientRect();
        const terminalRect = document.querySelector('.terminal-area')
            .getBoundingClientRect();
        const tracks = getComputedStyle(workspace).gridTemplateColumns
            .split(' ').map(parseFloat);
        const expectedWidth = Math.max(
            255,
            Math.min(workspaceRect.width * 0.34, 340)
        );
        return {
            open: p.classList.contains('sftp-panel-open'),
            display: cs.display,
            column: cs.gridColumnStart,
            row: cs.gridRowStart,
            inert: p.hasAttribute('inert'),
            ariaHidden: p.hasAttribute('aria-hidden'),
            // The v5 surface, NOT the legacy modal.
            modalOpen: window.sftpFileManager.isOpen,
            modalShown: document.getElementById('sftpFileManager')
                .classList.contains('show'),
            labelledbyResolves:
                !!document.getElementById(p.getAttribute('aria-labelledby')),
            activePane: window.sftpFileManager.activePane,
            geometry: {
                panelWidth: Math.round(panelRect.width),
                auxiliaryTrack: Math.round(tracks[1] || 0),
                expectedWidth: Math.round(expectedWidth),
                terminalWidth: Math.round(terminalRect.width),
                contained: panelRect.left >= workspaceRect.left
                    && panelRect.right <= workspaceRect.right,
                overlap: Math.round(Math.max(
                    0,
                    Math.min(panelRect.right, terminalRect.right)
                        - Math.max(panelRect.left, terminalRect.left)
                )),
            },
        };
    });
    check('§7 the File button opens the inline panel', opened.open, true);
    check('§7 the open panel is a flex column', opened.display, 'flex');
    check('§7 the panel is not inert once open', opened.inert, false);
    check('§7 aria-hidden is dropped once open', opened.ariaHidden, false);
    check('§7 aria-labelledby resolves to a real element',
        opened.labelledbyResolves, true);
    check('§7 the inline pane becomes the active pane',
        opened.activePane, 'inline');
    // The gate-2 defect: the File button used to raise the full-screen modal.
    check('§7 the legacy modal is NOT what the File button opens',
        opened.modalOpen, false);
    check('§7 and the modal is not shown either', opened.modalShown, false);
    // Same auxiliary cell as Notes and Commands, so it pushes the terminal the
    // same way instead of being auto-placed into an implicit row beneath it.
    check('§7 the panel shares the auxiliary grid column', opened.column, '2');
    check('§7 the panel shares the auxiliary grid row', opened.row, '1');
    atLeast('§7 desktop SFTP clears the 255px inspector floor',
        opened.geometry.panelWidth, 255, 'px');
    atMost('§7 desktop SFTP respects the 340px inspector ceiling',
        opened.geometry.panelWidth, 340, 'px');
    check('§7 desktop SFTP width follows min(34%, 340px) with its floor',
        opened.geometry.panelWidth, opened.geometry.expectedWidth);
    check('§7 the workspace track exactly owns the SFTP width',
        opened.geometry.auxiliaryTrack, opened.geometry.panelWidth);
    check('§7 desktop SFTP stays inside the workspace',
        opened.geometry.contained, true);
    check('§7 desktop SFTP does not overlap the terminal',
        opened.geometry.overlap, 0);
    atLeast('§7 desktop SFTP leaves a usable terminal',
        opened.geometry.terminalWidth, 255, 'px');

    // Opening SFTP collapses Notes: the exclusion event is what does this, and
    // on fine pointer the notepad's state is .collapsed rather than a sheet.
    check('§7 exclusion: opening SFTP collapsed Notes',
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.contains('collapsed')),
        true);

    await page.evaluate(SEED_INLINE);
    await page.waitForTimeout(150);

    const inline = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#fmInlineList .fm-file-item')];
        const dir = rows.find(n => n.dataset.type === 'directory');
        return {
            title: document.getElementById('fmInlineTitle').textContent.trim(),
            path: document.getElementById('fmInlineHeadPath').textContent.trim(),
            uploadText: document.querySelector('#fmInlineUpload span')?.textContent.trim(),
            uploadIcon: document.querySelector('#fmInlineUpload use')?.getAttribute('href'),
            folderIcon: document.querySelector('#fmInlineNewFolder use')?.getAttribute('href'),
            closeLabel: document.getElementById('sftpPanelClose')
                ?.getAttribute('aria-label'),
            rows: rows.filter(n => n.dataset.type !== 'parent').length,
            parentRows: rows.filter(n => n.dataset.type === 'parent').length,
            dirName: dir?.querySelector('.fm-file-name')?.textContent.trim(),
            dirMeta: dir?.querySelector('.fm-file-meta')?.textContent.trim(),
            dataNameCount: rows.filter(n => n.hasAttribute('data-name')).length,
            count: document.getElementById('fmInlineCount')?.textContent.trim(),
            badge: document.getElementById('fmInlineBadge')?.textContent.trim(),
        };
    });
    // P7: the injected markup is translated. Neither i18n.applyTranslations
    // (does not exist) nor the class's modal-scoped applyTranslations reaches
    // this subtree, so an untranslated panel is the failure mode here.
    check('§7 P7: the head names the host in Vietnamese',
        inline.title, 'Tệp · tiny');
    check('§7 the head carries the active path', inline.path, '/opt/sshdeck');
    check('§7 P7: upload wording is Vietnamese', inline.uploadText, 'Tải lên');
    check('§7 P7: the close control is labelled in Vietnamese',
        inline.closeLabel, 'Đóng');
    check('§7 upload uses icon-upload',
        inline.uploadIcon?.includes('#icon-upload'), true);
    check('§7 new-folder uses icon-folder-plus',
        inline.folderIcon?.includes('#icon-folder-plus'), true);
    check('§7 the seeded rows render through renderPane', inline.rows, 2);
    check('§7 a non-root path keeps one parent row', inline.parentRows, 1);
    check('§7 the directory row keeps its name', inline.dirName, 'static');
    check('§7 P7: directory kind is Vietnamese',
        inline.dirMeta?.startsWith('Thư mục'), true);
    check('§7 rows do not duplicate an escaped filename into unused data-name',
        inline.dataNameCount, 0);
    check('§7 P7: the footer count is localized', inline.count, '2 mục');
    check('§7 the footer badge names the connection',
        inline.badge, 'root@tiny');

    /*
     * Upload targets the panel's OWN hidden input. The modal's
     * #fmMobileUploadInput must not be touched: the two surfaces can be open at
     * once, and crossing them would upload into whichever pane the modal last
     * had selected rather than the directory the user is looking at.
     */
    const upload = await page.evaluate(() => {
        let own = 0;
        let modal = 0;
        document.getElementById('fmInlineUploadInput')
            .addEventListener('click', e => { own++; e.preventDefault(); }, { once: true });
        document.getElementById('fmMobileUploadInput')
            .addEventListener('click', e => { modal++; e.preventDefault(); }, { once: true });
        document.getElementById('fmInlineUpload').click();
        return {
            own, modal,
            activePane: window.sftpFileManager.activePane,
            inputs: document.querySelectorAll('#fmInlineUploadInput').length,
        };
    });
    check('§7 Upload opens the panel\'s own picker once', upload.own, 1);
    check('§7 and never the modal\'s picker', upload.modal, 0);
    check('§7 Upload targets the inline pane', upload.activePane, 'inline');
    check('§7 exactly one inline upload input exists', upload.inputs, 1);

    // Row clicks reach the shared selection logic, and selecting is not
    // navigating -- no directory request is emitted by a single tap.
    const select = await page.evaluate(() => {
        window.__emits.length = 0;
        const row = document.querySelector(
            '#fmInlineList .fm-file-item[data-type="file"]');
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        return {
            selected: window.sftpFileManager.panes.inline.selected.size,
            navigations: window.__emits.filter(([e]) => e === 'list_directory').length,
        };
    });
    check('§7 a row click selects through the shared handler',
        select.selected, 1);
    check('§7 selecting is not navigating', select.navigations, 0);

    /*
     * Language changes. Every other manager re-renders on languageChanged; this
     * one did not, so all three SFTP surfaces stayed in the previous language
     * until a reload. Both halves are checked: the data-i18n walk (the Upload
     * label) and the t()-built row bodies (the directory kind), which the walk
     * alone cannot fix.
     */
    const relang = await page.evaluate(() => {
        i18n.setLanguage('en');
        return {
            title: document.getElementById('fmInlineTitle').textContent.trim(),
            upload: document.querySelector('#fmInlineUpload span')?.textContent.trim(),
            count: document.getElementById('fmInlineCount')?.textContent.trim(),
            dirMeta: document.querySelector(
                '#fmInlineList .fm-file-item[data-type="directory"] .fm-file-meta')
                ?.textContent.trim(),
        };
    });
    check('§7 a language change re-composes the head',
        relang.title, 'Files · tiny');
    check('§7 a language change re-walks the injected labels',
        relang.upload, 'Upload');
    check('§7 a language change re-renders the rows',
        relang.dirMeta?.startsWith('Folder'), true);
    check('§7 a language change re-renders the footer', relang.count, '2 items');
    await page.evaluate(() => i18n.setLanguage('vi'));

    // A directory response can match legacy and inline pane state at once. Only
    // the surface that is actually open should rebuild DOM; hidden panes cache
    // the state and paint it when their own surface opens.
    const hiddenRender = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.panes.left.type = 'ssh';
        fm.panes.left.sessionId = 's1';
        fm.panes.inline.type = 'ssh';
        fm.panes.inline.sessionId = 's1';
        const rendered = [];
        const realRender = fm.renderPane.bind(fm);
        fm.renderPane = pane => {
            rendered.push(pane);
            return realRender(pane);
        };
        const handler = window.socket.listeners?.('directory_listing')?.[0];
        if (handler) {
            handler({
                session_id: 's1', path: '/fresh',
                files: [{ name: 'fresh.log', is_dir: false, size: 1 }],
            });
        }
        fm.renderPane = realRender;
        return {
            handlerPresent: typeof handler === 'function',
            rendered,
            hiddenPath: fm.panes.left.path,
            hiddenFiles: fm.panes.left.files.length,
            refreshOnOpen: fm.panes.left.refreshOnOpen,
            inlinePath: fm.panes.inline.path,
        };
    });
    check('§7 production registered the directory-listing handler under test',
        hiddenRender.handlerPresent, true);
    check('§7 directory response renders only the visible inline surface',
        hiddenRender.rendered.join(','), 'inline');
    check('§7 hidden matching pane still caches fresh state',
        `${hiddenRender.hiddenPath}|${hiddenRender.hiddenFiles}`, '/fresh|1');
    check('§7 hidden matching pane marks one refresh for its next open',
        hiddenRender.refreshOnOpen, true);
    check('§7 visible inline pane receives the same fresh response',
        hiddenRender.inlinePath, '/fresh');

    // Closing while the first directory request is pending must cancel the timer;
    // otherwise a hidden panel re-renders an error and raises a toast ten seconds
    // after the user dismissed it.
    const timeoutClose = await page.evaluate(() => {
        const fm = window.sftpFileManager;
        const state = fm.panes.inline;
        if (state.loadingTimeout) clearTimeout(state.loadingTimeout);
        state.loading = true;
        fm.setLoadingTimeout('inline', 20);
        const armed = state.loadingTimeout !== null;
        fm.closeInline();
        return { armed, token: state.loadingTimeout, loading: state.loading };
    });
    check('§7 timeout cleanup test really armed a loading timeout',
        timeoutClose.armed, true);
    check('§7 closeInline clears the pending timeout token',
        timeoutClose.token, null);
    check('§7 closeInline clears hidden loading state',
        timeoutClose.loading, false);
    await page.waitForTimeout(60);
    check('§7 a closed inline panel raises no late timeout notification',
        await page.evaluate(() => document.querySelectorAll('.notification').length), 0);

    // Reopen before the remaining interaction/language/exclusion contracts.
    await page.click('#fileTransferBtn');
    await page.waitForTimeout(80);

    // Exclusion, both directions, through each panel's production entry point.
    await page.evaluate(() => CommandLibrary.openLibrary());
    await page.waitForTimeout(80);
    check('§7 exclusion: opening Commands closed SFTP',
        await page.evaluate(() =>
            document.getElementById('sftpPanel').classList.contains('sftp-panel-open')),
        false);
    check('§7 exclusion: the closed panel is inert again',
        await page.evaluate(() =>
            document.getElementById('sftpPanel').hasAttribute('inert')), true);
    await page.click('#fileTransferBtn');
    await page.waitForTimeout(80);
    check('§7 exclusion: opening SFTP closed Commands',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    check('§7 exclusion: never both at once',
        await page.evaluate(() =>
            CommandLibrary.isOpen()
            && document.getElementById('sftpPanel').classList.contains('sftp-panel-open')),
        false);

    // Reopening keeps the pane's state rather than rebuilding the subtree.
    const reopened = await page.evaluate(() => ({
        path: document.getElementById('fmInlineHeadPath').textContent.trim(),
        panes: document.querySelectorAll('#sftpPanel .fm-pane').length,
        listeners: document.querySelectorAll('#fmInlineUploadInput').length,
    }));
    check('§7 reopening preserves the latest cached directory', reopened.path, '/fresh');
    check('§7 reopening does not duplicate the pane', reopened.panes, 1);
    check('§7 reopening does not duplicate the input', reopened.listeners, 1);

    // The close control, clicked for real.
    await page.click('#sftpPanelClose');
    await page.waitForTimeout(80);
    const closed = await page.evaluate(() => {
        const p = document.getElementById('sftpPanel');
        return {
            display: getComputedStyle(p).display,
            inert: p.hasAttribute('inert'),
            ariaHidden: p.getAttribute('aria-hidden'),
        };
    });
    check('§7 the close control hides the panel', closed.display, 'none');
    check('§7 the closed panel is inert', closed.inert, true);
    check('§7 the closed panel is hidden from AT', closed.ariaHidden, 'true');

    check('§7 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// Device placement: the panel follows the same capability tiers as Notes and
// Commands -- desktop rail (above), iPad right overlay, phone bottom sheet.
for (const vp of [
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true, overlay: true },
    { label: 'phone390', w: 390, h: 844, touch: true, overlay: false },
]) {
    const { ctx, page, errors } = await open(vp);
    // On touch viewports the desktop header (which holds #fileTransferBtn) is
    // hidden; use the same openFileManager() call that the touch action row
    // dispatches to avoid a spurious timeout.
    await page.evaluate(() => window.openFileManager());
    await page.waitForFunction(() => !!window.sftpFileManager);
    await page.waitForTimeout(150);

    const box = await page.evaluate(() => {
        const p = document.getElementById('sftpPanel');
        const cs = getComputedStyle(p);
        const foot = p.querySelector('.fm-pane-footer');
        return {
            display: cs.display,
            position: cs.position,
            right: cs.right,
            bottom: cs.bottom,
            left: cs.left,
            radius: cs.borderTopLeftRadius,
            footer: foot ? getComputedStyle(foot).display : 'missing',
            close: (() => {
                const r = document.getElementById('sftpPanelClose')
                    .getBoundingClientRect();
                return Math.min(r.width, r.height);
            })(),
            /*
             * The pane box itself, not just the panel: the phone tier's
             * one-pane rule for the legacy modal (sftp-file-manager.css:1404)
             * was unscoped and matched #fmInlinePane too, collapsing the sheet
             * to its 1px border while the panel still computed display:flex.
             * Measuring the pane is what makes that failure mode visible here
             * rather than only as a downstream 0px close target.
             */
            paneDisplay: (() => {
                const pane = document.getElementById('fmInlinePane');
                return pane ? getComputedStyle(pane).display : 'missing';
            })(),
            paneHeight: Math.round(
                document.getElementById('fmInlinePane')
                    ?.getBoundingClientRect().height || 0),
        };
    });
    check(`§7 ${vp.label}: the panel opens`, box.display, 'flex');
    check(`§7 ${vp.label}: the pane inside it is not collapsed`,
        box.paneDisplay, 'flex');
    atLeast(`§7 ${vp.label}: the pane has real height`, box.paneHeight, 120, 'px');
    check(`§7 ${vp.label}: it is an overlay, not a grid track`,
        box.position, 'absolute');
    atLeast(`§7 ${vp.label}: the close target is thumb-sized`, box.close, 44, 'px');
    if (vp.overlay) {
        // Spec 355: right-side overlay on coarse >= 768px.
        check(`§7 ${vp.label}: anchored to the right edge`, box.right, '0px');
        check(`§7 ${vp.label}: square, not a sheet`, box.radius, '0px');
        check(`§7 ${vp.label}: the status footer is kept`, box.footer, 'flex');
    } else {
        // Spec 356: bottom sheet on coarse <= 767px.
        check(`§7 ${vp.label}: anchored to the bottom edge`, box.bottom, '0px');
        check(`§7 ${vp.label}: spans the full width`, box.left, '0px');
        check(`§7 ${vp.label}: rounded like the other sheets`, box.radius, '12px');
        // Height is the scarce axis on a phone; the counts go.
        check(`§7 ${vp.label}: the status footer is dropped`, box.footer, 'none');
    }

    // P6's sibling contract, corrected against the v5 authority. Mockup lines
    // 355-356 make the inspector an OVERLAY by design: iPad a right-side
    // sheet, phone a bottom sheet (max-height:54%). It is SUPPOSED to sit on
    // top of the terminal -- so the claim this block used to carry ("must not
    // cover the terminal") contradicted the mockup and the computed value was
    // discarded with `void overlap`. The honest companion contract is the
    // opposite of what the dead comment said: the panel MUST overlap the
    // terminal (it is an overlay, not a docked sibling), and MUST leave the
    // terminal with visible area (a companion, never a full occluder).
    const overlapArea = await page.evaluate(() => {
        const p = document.getElementById('sftpPanel').getBoundingClientRect();
        const t = (document.querySelector('.xterm-screen')
            || document.querySelector('.terminal-area')).getBoundingClientRect();
        const w = Math.max(0, Math.min(p.right, t.right) - Math.max(p.left, t.left));
        const h = Math.max(0, Math.min(p.bottom, t.bottom) - Math.max(p.top, t.top));
        return { overlap: Math.round(w * h), terminal: Math.round(t.width * t.height) };
    });
    check(`§7 ${vp.label}: the panel really overlays the terminal (it is a sheet)`,
        overlapArea.overlap > 0, true);
    check(`§7 ${vp.label}: the terminal keeps visible area (never fully covered)`,
        overlapArea.overlap < overlapArea.terminal, true);
    check(`§7 ${vp.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
