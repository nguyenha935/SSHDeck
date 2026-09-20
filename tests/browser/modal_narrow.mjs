/*
 * The three modals that are tightest on a phone, measured rather than assumed.
 *
 * DESIGN.md section 13 records the touch-target deviation; this file is the
 * measurement behind it for commandWorkspaceModal, filePreviewModal and
 * commandFormModal -- the three the redesign plan flagged as the ones that would
 * break at 428px because they carry a 5-column table header, a row of icon
 * actions beside a title, and a two-pane editor respectively.
 *
 * Why geometry and not `overflow-x: hidden`: `width: min(100%, N)` guarantees a
 * dialog never overflows the viewport, so an overflow check passes while the
 * text inside still collides. This measures real element rects instead.
 *
 * Two probe bugs were found and fixed while writing it, both of which made the
 * code look broken when it was not, so both are guarded against here:
 *
 *   1. Nested pairs always share area. <label>Name <span>*</span></label> puts
 *      the span inside the label by definition, and counting those reported six
 *      phantom collisions in commandFormModal -- every one a parent and its own
 *      child. Ancestors are skipped.
 *   2. A checkbox is toggled by tapping its label, so the LABEL is the target
 *      WCAG 2.5.5 measures. Measuring the 13px painted input instead flags a
 *      failure a finger never experiences.
 *
 * Run: node tests/browser/modal_narrow.mjs   (from source/)
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
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
};

// Render the shipped template. Only Jinja syntax is substituted -- no markup is
// added, removed or rewritten, so what is measured is what ships. A test that
// writes its own markup agrees with itself and proves nothing; this repository
// has already shipped two false-green tests that way.
function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    // A Jinja expression standing in for a JS *value* cannot collapse to
    // nothing, or the inline scripts die with a SyntaxError and the page never
    // lays out. Flask emits JSON here, so emit JSON.
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
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

// The three tightest dialogs, at the narrowest width the project supports (359,
// DESIGN.md section 2) and the reference phone (428).
/*
 * v5 split the old #commandWorkspaceModal into two surfaces, so measuring one id
 * no longer covers it: #commandSetsModal is the modal successor (command-
 * workspace.js: "this host owns Command Sets only"), and the Command Library
 * moved out to #commandRail, "a non-blocking rail that keeps the terminal
 * visible". Both are measured, so the coverage the old single entry gave is
 * kept rather than reduced.
 *
 * The rail is not a .modal: it opens with .aux-open + inert removal
 * (command-library.js openLibrary) and its own root is the <aside>, not a
 * .modal-content child -- hence the per-entry `open`/`root` below instead of
 * one hardcoded shape.
 */
const MODALS = [
    { id: 'commandSetsModal' },
    { id: 'filePreviewModal' },
    { id: 'commandFormModal' },
    {
        id: 'commandRail',
        // Mirror openLibrary's own state change rather than calling it, so the
        // measurement does not depend on SessionManager/loadCommands stubs.
        open: (m) => {
            m.classList.add('aux-open');
            m.removeAttribute('inert');
            m.setAttribute('aria-hidden', 'false');
        },
        close: (m) => {
            m.classList.remove('aux-open');
            m.setAttribute('inert', '');
            m.setAttribute('aria-hidden', 'true');
        },
        // The rail IS its own dialog box; there is no .modal-content wrapper.
        root: (m) => m,
    },
];
const VIEWPORTS = [[428, 926], [359, 780]];

const server = await startServer(renderTemplate());
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const pageErrors = [];

for (const [w, h] of VIEWPORTS) {
    const context = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: true, isMobile: true,
    });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(`${w}x${h}: ${e}`));
    await page.goto(`${base}/`, { waitUntil: 'load' });

    // Freeze motion BEFORE measuring, or the numbers depend on when in the
    // transition the measurement happens to land.
    await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent =
            '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(style);
    });

    for (const spec of MODALS) {
        const id = spec.id;
        const r = await page.evaluate((cfg) => {
            const m = document.getElementById(cfg.mid);
            if (!m) return { missing: true };
            if (cfg.isRail) {
                m.classList.add('aux-open');
                m.removeAttribute('inert');
                m.setAttribute('aria-hidden', 'false');
            } else {
                m.classList.add('show');
                m.setAttribute('aria-hidden', 'false');
            }

            const content = cfg.isRail ? m : m.querySelector('.modal-content');
            const cr = content ? content.getBoundingClientRect() : null;

            // Elements carrying their own text node, for collision detection.
            const leaves = [];
            m.querySelectorAll('*').forEach(el => {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return;
                const rect = el.getBoundingClientRect();
                if (rect.width < 1 || rect.height < 1) return;
                const ownText = Array.from(el.childNodes).some(
                    n => n.nodeType === 3 && n.textContent.trim().length > 0);
                if (!ownText) return;
                leaves.push({ el, txt: el.textContent.trim().slice(0, 24),
                    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
                    fs: parseFloat(cs.fontSize) });
            });

            const overlaps = [];
            for (let i = 0; i < leaves.length; i++) {
                for (let j = i + 1; j < leaves.length; j++) {
                    const a = leaves[i], b = leaves[j];
                    // Skip nesting: a parent always covers its own child.
                    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
                    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                    if (ox > 2 && oy > 2) {
                        overlaps.push(`${a.txt}|${b.txt}`);
                    }
                }
            }

            let hOverflow = 0;
            m.querySelectorAll('*').forEach(el => {
                if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
                    hOverflow = Math.max(hOverflow, el.scrollWidth - el.clientWidth);
                }
            });

            // Effective tap target: for a wrapped checkbox that is the label.
            const small = [];
            m.querySelectorAll('button, a[href], input, select, textarea').forEach(el => {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return;
                let rect = el.getBoundingClientRect();
                if (rect.width < 1) return;
                if (el.tagName === 'INPUT'
                    && (el.type === 'checkbox' || el.type === 'radio')) {
                    const lab = el.closest('label')
                        || (el.id && m.querySelector(`label[for="${el.id}"]`));
                    if (lab) rect = lab.getBoundingClientRect();
                }
                if (rect.width < 44 || rect.height < 44) {
                    small.push(`${el.id || el.className || el.tagName}`
                        + `:${Math.round(rect.width)}x${Math.round(rect.height)}`);
                }
            });

            const tiny = leaves.filter(l => l.fs < 12).map(l => `${l.txt}@${l.fs}px`);

            m.classList.remove(cfg.isRail ? 'aux-open' : 'show');
            if (cfg.isRail) m.setAttribute('inert', '');
            m.setAttribute('aria-hidden', 'true');
            return {
                laidOut: !!cr && cr.width > 100 && cr.height > 100,
                fitsViewport: !!cr && cr.width <= window.innerWidth + 1,
                overlaps, hOverflow, small, tiny,
            };
        }, { mid: id, isRail: id === 'commandRail' });

        const at = `${id} @ ${w}x${h}`;
        check(`${at}: the surface still exists`, r.missing !== true, true);
        check(`${at}: dialog is laid out`, r.laidOut, true);
        check(`${at}: dialog fits the viewport width`, r.fitsViewport, true);
        check(`${at}: no colliding text`, r.overlaps, []);
        check(`${at}: no horizontal overflow inside`, r.hOverflow, 0);
        check(`${at}: every tap target reaches 44px`, r.small, []);
        check(`${at}: no interface text below 12px`, r.tiny, []);
    }
    await context.close();
}


// --- Piece E: modal-shell contract (additive; index.html roots only). ---
{
    const freeze = async (pg) => pg.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(st);
    });

    const ctxS = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
    const pgS = await ctxS.newPage();
    pgS.on('pageerror', e => pageErrors.push('shell-375: ' + e));
    await pgS.goto(`${base}/`, { waitUntil: 'load' });
    await freeze(pgS);
    const g = await pgS.evaluate(() => {
        const m = document.getElementById('fileTransferModal');
        m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
        const c = m.querySelector('.modal-content').getBoundingClientRect();
        const b = m.querySelector('.close');
        const r = b.getBoundingClientRect();
        m.classList.remove('show'); m.setAttribute('aria-hidden', 'true');
        return { shell: m.classList.contains('modal-shell'), w: Math.round(c.width),
                 vw: window.innerWidth, tag: b.tagName, bw: Math.round(r.width), bh: Math.round(r.height) };
    });
    check('shell@375x667: fileTransferModal carries modal-shell', g.shell, true);
    check('shell@375x667: content width = viewport - 32px gutters', g.w, g.vw - 32);
    check('shell@375x667: close is a focusable BUTTON', g.tag, 'BUTTON');
    check('shell@375x667: close reaches 44x44', [g.bw >= 44, g.bh >= 44], [true, true]);
    await ctxS.close();

    const ctxL = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const pgL = await ctxL.newPage();
    pgL.on('pageerror', e => pageErrors.push('shell-390: ' + e));
    await pgL.goto(`${base}/`, { waitUntil: 'load' });
    await freeze(pgL);
    const l = await pgL.evaluate(() => {
        const m = document.getElementById('commandFormModal');
        const body = m.querySelector('.modal-body');
        const tall = document.createElement('div');
        tall.style.height = '2000px';
        body.appendChild(tall);
        m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
        const c = m.querySelector('.modal-content').getBoundingClientRect();
        const out = { cap: c.height <= 0.85 * window.innerHeight + 1,
                      ov: getComputedStyle(body).overflowY,
                      scrolls: body.scrollHeight > body.clientHeight };
        body.removeChild(tall);
        m.classList.remove('show'); m.setAttribute('aria-hidden', 'true');
        return out;
    });
    check('shell@390x844: long-content dialog capped at 85vh', l.cap, true);
    check('shell@390x844: modal-body overflow-y is auto', l.ov, 'auto');
    check('shell@390x844: modal-body scrolls its overflow', l.scrolls, true);
    await ctxL.close();

    // Generic .modal-shell .close rule (covers span AND button closes, no
    // focus-visible assertion on spans) read from the shipped stylesheet the
    // harness already served via the rendered template's <link>.
    const ctxC = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
    const pgC = await ctxC.newPage();
    pgC.on('pageerror', e => pageErrors.push('shell-cssom: ' + e));
    await pgC.goto(`${base}/`, { waitUntil: 'load' });
    const rule = await pgC.evaluate(() => {
        let found = null;
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            for (const r of rules) {
                if (r.selectorText && r.selectorText.trim() === '.modal-shell .close') {
                    found = { d: r.style.display, ai: r.style.alignItems, jc: r.style.justifyContent, mw: r.style.minWidth, mh: r.style.minHeight };
                }
            }
        }
        return found;
    });
    check('shell: .modal-shell .close is flex-centered 44x44 (span+button)', rule, { d: 'flex', ai: 'center', jc: 'center', mw: '44px', mh: '44px' });
    await ctxC.close();

    const ctxF = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
    const pgF = await ctxF.newPage();
    pgF.on('pageerror', e => pageErrors.push('shell-focus: ' + e));
    await pgF.goto(`${base}/`, { waitUntil: 'load' });
    await freeze(pgF);
    await pgF.evaluate(() => {
        const m = document.getElementById('commandPaletteModal');
        m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
    });
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
        await pgF.keyboard.press('Tab');
        landed = await pgF.evaluate(() => document.activeElement &&
            document.activeElement.id === 'closeCommandPaletteModal');
    }
    const ring = landed ? await pgF.evaluate(() =>
        document.activeElement.matches(':focus-visible') &&
        getComputedStyle(document.activeElement).outlineStyle !== 'none') : false;
    check('shell: keyboard focus lands on button close', landed, true);
    check('shell: focus-visible ring shown on button close', ring, true);
    await pgF.evaluate(() => {
        const m = document.getElementById('commandPaletteModal');
        m.classList.remove('show'); m.setAttribute('aria-hidden', 'true');
    });
    await ctxF.close();
}

check('no page errors while measuring', pageErrors, []);

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
