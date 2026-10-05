/*
 * The two auth pages, measured against the v5 rulings. (The change-password
 * and admin pages are part of Settings now: settings_view.mjs and
 * settings_admin.mjs.)
 *
 * These are the SHIPPED templates (templates/login.html, register.html),
 * rendered through the same Jinja
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
 * 2. A footer link must be identifiable as a link in EVERY theme.
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

for (const [label, src] of [['login', login], ['register', register]]) {
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

/*
 * CACHE PIN for the auth-page script.
 *
 * auth.js was among the last shipped frontend files in this tree with no `?v=`
 * at all, and the documented cache-bust contract is that changing a static
 * asset without
 * raising its pin ships the change invisibly behind a stale browser copy. That
 * is worse here than elsewhere: the password reveal toggle and the live
 * validation are the visible behaviour, so a stale auth.js looks like the
 * feature was never built.
 *
 * auth.js is loaded by both templates, so the pin is asserted on each: a partial
 * bump would fix login and leave register stale, which is the failure mode a
 * single assertion would miss. v5: the admin create-user validation left with
 * the admin page.
 */
const AUTH_JS_PIN = 5;
for (const [label, src] of [['login', login], ['register', register]]) {
    check(`${label}: auth.js carries the current ?v=${AUTH_JS_PIN} pin`,
        src.includes(`filename='js/auth.js') }}?v=${AUTH_JS_PIN}"`), true);
    check(`${label}: auth.js has exactly one script reference`,
        (src.match(/filename='js\/auth\.js'\)\s*\}\}/g) || []).length, 1);
    check(`${label}: no unpinned auth.js tag survives`,
        /filename='js\/auth\.js'\)\s*\}\}"/.test(src), false);
}
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
