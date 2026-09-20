/*
 * W8 — create-user form icon contract.
 *
 * The add-user modal in templates/admin.html was the only v5 auth form without
 * the project's icon system: every text/password input on login, register and
 * change_password has a leading icon inside a5-input-wrap, every password field
 * has a reveal toggle, and every submit button has a trailing icon. This suite
 * proves the admin form now carries the same contract at the DOM, CSS-cascade,
 * behavioural and layout level, across all 10 themes × 3 viewports.
 *
 * MUTATION-SAFE DESIGN: every page.evaluate uses optional chaining and returns
 * null for missing elements — no .querySelector on null, no getComputedStyle on
 * null. Each section first records structural preconditions, emits named FAILs
 * for missing structure, and conditionally skips dependent measurements/actions
 * (clicks, computed-style reads) so a mutation that removes an element produces
 * meaningful named RED assertions, never a TypeError hang or a synthesized pass.
 * All clicks are bounded (5s timeout). Every context is closed in finally.
 *
 * The page is the SHIPPED template rendered through the same Jinja substitution
 * auth_pages_v5.mjs uses — not a hand-written fixture. A test that writes its
 * own markup agrees with itself and proves nothing.
 *
 * Run: node tests/browser/w8_admin_form_icons.mjs   (from source/)
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
    '.woff2': 'font/woff2',
};

function renderTemplate(rel, theme) {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'testadmin');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
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
// static/css/style.css:312-829. Same list as auth_pages_v5.mjs.
const THEMES = ['glass', 'retro', 'solar', 'paper', 'noir', 'arctic-ice',
                'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];

const VIEWPORTS = [
    { label: 'desktop', w: 1280, h: 800, touch: false },
    { label: 'ipad-portrait', w: 834, h: 1194, touch: true },
    { label: 'phone-390', w: 390, h: 844, touch: true },
];

// Render the admin template with a given theme. The route reads this closure.
// login and register are served too: §6 compares the admin form's measured
// geometry and typography against theirs rather than against copied numbers.
let currentTheme = 'glass';
const routes = {
    '/admin': () => renderTemplate('templates/admin.html', currentTheme),
    '/login': () => renderTemplate('templates/login.html', currentTheme),
    '/register': () => renderTemplate('templates/register.html', currentTheme),
};
const server = await startServer(routes);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const pageErrors = [];

/*
 * Open the add-user modal and freeze animations. Returns the page. The modal
 * open click is bounded; if #adminAddUserBtn is missing the click throws
 * within 5s and the caller's try/finally closes the context.
 */
async function openModal(page) {
    await page.click('#adminAddUserBtn', { timeout: 5000 });
    await page.waitForSelector('#addUserModal.show', { state: 'visible', timeout: 5000 });
    await page.evaluate(() => {
        const st = document.createElement('style');
        st.textContent =
            '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(st);
    });
}

/*
 * Collect ALL structural preconditions in one null-safe evaluate. Every
 * .closest/.querySelector uses optional chaining; missing elements yield null,
 * never a TypeError. The returned object feeds every downstream section so
 * dependent checks can be skipped without throwing.
 */
function probeStructure(page) {
    return page.evaluate(() => {
        const uInput = document.getElementById('newUsername');
        const pInput = document.getElementById('newPassword');
        const uWrap = uInput?.closest('.a5-input-wrap');
        const pWrap = pInput?.closest('.a5-input-wrap');
        const uIcon = uWrap?.querySelector('.a5-input-icon');
        const pIcon = pWrap?.querySelector('.a5-input-icon');
        const uUse = uIcon?.querySelector('svg use');
        const pUse = pIcon?.querySelector('svg use');
        const toggle = pWrap?.querySelector('.a5-toggle.password-toggle');
        const toggleUse = toggle?.querySelector('svg use');
        const submit = document.getElementById('submitNewUser');
        const submitSvg = submit?.querySelector('svg use');
        const submitSvgEl = submit?.querySelector('svg');
        const cb = document.getElementById('newIsAdmin');
        const uLabel = document.querySelector('label[for="newUsername"]');
        const pLabel = document.querySelector('label[for="newPassword"]');
        const authScript = document.querySelector('script[src*="auth.js"]');
        return {
            uInput: !!uInput,
            pInput: !!pInput,
            uWrap: !!uWrap,
            pWrap: !!pWrap,
            uIcon: !!uIcon,
            pIcon: !!pIcon,
            uHref: uUse?.getAttribute('href') || null,
            pHref: pUse?.getAttribute('href') || null,
            toggle: !!toggle,
            toggleTarget: toggle?.dataset.target || null,
            toggleAriaLabel: toggle?.getAttribute('aria-label') || null,
            toggleI18n: toggle?.hasAttribute('data-i18n-aria-label') ?? null,
            toggleHref: toggleUse?.getAttribute('href') || null,
            pInputType: pInput?.type || null,
            submit: !!submit,
            submitSvg: !!submitSvg,
            submitSvgHidden: submitSvgEl?.getAttribute('aria-hidden') || null,
            submitHref: submitSvg?.getAttribute('href') || null,
            uIconHidden: uIcon?.getAttribute('aria-hidden') || null,
            cb: !!cb,
            cbType: cb?.type || null,
            uLabelFor: uLabel?.getAttribute('for') || null,
            pLabelFor: pLabel?.getAttribute('for') || null,
            authScript: !!authScript,
            uCount: document.querySelectorAll('#newUsername').length,
            pCount: document.querySelectorAll('#newPassword').length,
            submitCount: document.querySelectorAll('#submitNewUser').length,
            cbCount: document.querySelectorAll('#newIsAdmin').length,
        };
    });
}

/*
 * Collect computed CSS for the icon-bearing elements. Null-safe: if an element
 * is missing, the property is null and the downstream check naturally FAILs.
 */
function probeComputed(page) {
    return page.evaluate(() => {
        const uInput = document.getElementById('newUsername');
        const pInput = document.getElementById('newPassword');
        const uWrap = uInput?.closest('.a5-input-wrap');
        const pWrap = pInput?.closest('.a5-input-wrap');
        const uIcon = uWrap?.querySelector('.a5-input-icon');
        const toggle = pWrap?.querySelector('.a5-toggle');
        const submit = document.getElementById('submitNewUser');
        const submitSvg = submit?.querySelector('svg');
        const uCs = uInput ? getComputedStyle(uInput) : null;
        const pCs = pInput ? getComputedStyle(pInput) : null;
        const uIconCs = uIcon ? getComputedStyle(uIcon) : null;
        const toggleCs = toggle ? getComputedStyle(toggle) : null;
        const wrapCs = pWrap ? getComputedStyle(pWrap) : null;
        const submitSvgCs = submitSvg ? getComputedStyle(submitSvg) : null;
        return {
            uPadLeft: uCs ? parseFloat(uCs.paddingLeft) : null,
            pPadLeft: pCs ? parseFloat(pCs.paddingLeft) : null,
            pPadRight: pCs ? parseFloat(pCs.paddingRight) : null,
            uIconPos: uIconCs ? uIconCs.position : null,
            uIconW: uIconCs ? parseFloat(uIconCs.width) : null,
            uIconPE: uIconCs ? uIconCs.pointerEvents : null,
            toggleW: toggleCs ? parseFloat(toggleCs.width) : null,
            toggleH: toggleCs ? parseFloat(toggleCs.height) : null,
            togglePos: toggleCs ? toggleCs.position : null,
            wrapPos: wrapCs ? wrapCs.position : null,
            submitSvgW: submitSvgCs ? parseFloat(submitSvgCs.width) : null,
            submitSvgH: submitSvgCs ? parseFloat(submitSvgCs.height) : null,
        };
    });
}

/*
 * Collect layout rects for overlap/overflow checks. Null-safe.
 */
function probeLayout(page) {
    return page.evaluate(() => {
        const uInput = document.getElementById('newUsername');
        const pInput = document.getElementById('newPassword');
        const uWrap = uInput?.closest('.a5-input-wrap');
        const pWrap = pInput?.closest('.a5-input-wrap');
        const uIcon = uWrap?.querySelector('.a5-input-icon');
        const toggle = pWrap?.querySelector('.a5-toggle');
        const submit = document.getElementById('submitNewUser');
        const submitSvg = submit?.querySelector('svg');
        const modal = document.getElementById('addUserModal');
        const mc = modal?.querySelector('.modal-content');
        const uR = uInput?.getBoundingClientRect();
        const uIR = uIcon?.getBoundingClientRect();
        const pR = pInput?.getBoundingClientRect();
        const tR = toggle?.getBoundingClientRect();
        const sR = submit?.getBoundingClientRect();
        const svR = submitSvg?.getBoundingClientRect();
        const mcR = mc?.getBoundingClientRect();
        return {
            iconRight: uIR ? Math.round(uIR.right) : null,
            inputGutterEdge: uR ? Math.round(uR.left + 40) : null,
            toggleLeft: tR ? Math.round(tR.left) : null,
            inputRightText: pR ? Math.round(pR.right - 44) : null,
            svgAfterText: (svR && sR) ? svR.left > sR.left + 20 : null,
            svgInButton: (svR && sR) ? svR.right <= sR.right : null,
            modalFits: mcR ? mcR.right <= window.innerWidth : null,
            docOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            uVisible: uR ? (uR.width > 0 && uR.height > 0) : null,
            pVisible: pR ? (pR.width > 0 && pR.height > 0) : null,
            submitVisible: sR ? (sR.width > 0 && sR.height > 0) : null,
            iconVisible: uIR ? (uIR.width > 0 && uIR.height > 0) : null,
            toggleVisible: tR ? (tR.width > 0 && tR.height > 0) : null,
            iconRect: uIR ? { w: Math.round(uIR.width), h: Math.round(uIR.height) } : null,
            toggleRect: tR ? { w: Math.round(tR.width), h: Math.round(tR.height) } : null,
        };
    });
}

/*
 * Collect theme-token resolution for contrast/colour checks. Null-safe.
 */
function probeTokens(page) {
    return page.evaluate(() => {
        const body = document.body;
        const bs = getComputedStyle(body);
        const uInput = document.getElementById('newUsername');
        const uIcon = uInput?.closest('.a5-input-wrap')?.querySelector('.a5-input-icon');
        const uCs = uInput ? getComputedStyle(uInput) : null;
        const uIconCs = uIcon ? getComputedStyle(uIcon) : null;
        return {
            bg: bs.getPropertyValue('--bg-primary').trim(),
            text: bs.getPropertyValue('--text-primary').trim(),
            accent: bs.getPropertyValue('--accent-primary').trim(),
            border: bs.getPropertyValue('--border-color').trim(),
            muted: bs.getPropertyValue('--text-muted').trim(),
            inputColor: uCs ? uCs.color : null,
            inputBg: uCs ? uCs.backgroundColor : null,
            iconColor: uIconCs ? uIconCs.color : null,
        };
    });
}

// ── §1 DOM structure (desktop, glass) ──────────────────────────────────────
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
        const page = await ctx.newPage();
        page.on('pageerror', e => pageErrors.push(String(e)));
        await page.goto(`${base}/admin`, { waitUntil: 'load' });
        await openModal(page);
        const d = await probeStructure(page);

        // Username
        check('§1 username: exactly one #newUsername', d.uCount, 1);
        check('§1 username: inside a5-input-wrap with a5-input-icon', d.uWrap && d.uIcon, true);
        check('§1 username: icon aria-hidden true', d.uIconHidden, 'true');
        check('§1 username: icon href resolves to icon-contact-round',
            d.uHref && d.uHref.includes('#icon-contact-round'), true);

        // Password
        check('§1 password: exactly one #newPassword', d.pCount, 1);
        check('§1 password: inside a5-input-wrap', d.pWrap, true);
        check('§1 password: leading icon is icon-lock',
            d.pHref && d.pHref.includes('#icon-lock'), true);
        check('§1 password: reveal toggle present', d.toggle, true);
        check('§1 password: toggle data-target is newPassword', d.toggleTarget, 'newPassword');
        check('§1 password: toggle has aria-label',
            d.toggleAriaLabel !== null && d.toggleAriaLabel.length > 0, true);
        check('§1 password: toggle icon is icon-eye',
            d.toggleHref && d.toggleHref.includes('#icon-eye'), true);
        check('§1 password: input type is password', d.pInputType, 'password');

        // Submit
        check('§1 submit: exactly one #submitNewUser', d.submitCount, 1);
        check('§1 submit: trailing icon present', d.submitSvg, true);
        check('§1 submit: icon is icon-arrow-right',
            d.submitHref && d.submitHref.includes('#icon-arrow-right'), true);
        check('§1 submit: icon aria-hidden true', d.submitSvgHidden, 'true');

        // auth.js
        check('§1 auth.js script tag present in page', d.authScript, true);

        // Checkbox
        check('§1 make-admin: checkbox preserved', d.cb && d.cbType === 'checkbox', true);
        check('§1 make-admin: exactly one', d.cbCount, 1);
    } finally {
        await ctx.close();
    }
}

// ── §2 CSS cascade (computed, desktop) ─────────────────────────────────────
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
        const page = await ctx.newPage();
        await page.goto(`${base}/admin`, { waitUntil: 'load' });
        await openModal(page);
        const d = await probeStructure(page);
        const css = await probeComputed(page);

        // Precondition-guarded: if structure is missing, these naturally FAIL
        // (null !== value) without throwing.
        check('§2 username: padding-left reserves icon gutter (>=40px)',
            css.uPadLeft !== null && css.uPadLeft >= 40, true);
        check('§2 password: padding-left reserves icon gutter (>=40px)',
            css.pPadLeft !== null && css.pPadLeft >= 40, true);
        check('§2 password: padding-right reserves toggle (>=44px)',
            css.pPadRight !== null && css.pPadRight >= 44, true);
        check('§2 username icon: position absolute', css.uIconPos, 'absolute');
        check('§2 username icon: width 18px', css.uIconW, 18);
        check('§2 username icon: pointer-events none', css.uIconPE, 'none');
        check('§2 toggle: width >=44px', css.toggleW !== null && css.toggleW >= 44, true);
        check('§2 toggle: height >=44px', css.toggleH !== null && css.toggleH >= 44, true);
        check('§2 input-wrap: position relative', css.wrapPos, 'relative');
        check('§2 submit svg: width 18px', css.submitSvgW, 18);
        check('§2 submit svg: height 18px', css.submitSvgH, 18);
    } finally {
        await ctx.close();
    }
}

// ── §3 Reveal toggle behavior ──────────────────────────────────────────────
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
        const page = await ctx.newPage();
        await page.goto(`${base}/admin`, { waitUntil: 'load' });
        await openModal(page);
        const d = await probeStructure(page);

        // Precondition: toggle must exist. If missing (mutation b), skip the
        // click and emit named FAILs — never hang on a 30s selector timeout.
        if (!d.toggle) {
            check('§3 toggle exists for click test', false, true);
            check('§3 after first click: type flips to text',
                'PRECONDITION-FAILED: toggle missing', 'text');
            check('§3 after second click: type back to password',
                'PRECONDITION-FAILED: toggle missing', 'password');
            check('§3 toggle: keyboard-focusable',
                'PRECONDITION-FAILED: toggle missing', true);
        } else {
            check('§3 toggle exists for click test', true, true);

            // Type a value so the toggle has something to reveal.
            await page.fill('#newPassword', 'sup3rsecret');

            // Before click: type is password
            const before = await page.evaluate(() =>
                document.getElementById('newPassword')?.getAttribute('type') || null);
            check('§3 before toggle: type is password', before, 'password');

            // Bounded click — the element exists, so this should not timeout.
            await page.click('.a5-toggle.password-toggle', { timeout: 5000 });
            const after = await page.evaluate(() => {
                const input = document.getElementById('newPassword');
                const btn = document.querySelector('.a5-toggle.password-toggle');
                return {
                    type: input?.getAttribute('type') || null,
                    active: btn?.classList.contains('active') ?? false,
                };
            });
            check('§3 after first click: type flips to text', after.type, 'text');
            check('§3 after first click: toggle gains active class', after.active, true);

            // Click again — flips back
            await page.click('.a5-toggle.password-toggle', { timeout: 5000 });
            const after2 = await page.evaluate(() => {
                const input = document.getElementById('newPassword');
                const btn = document.querySelector('.a5-toggle.password-toggle');
                return {
                    type: input?.getAttribute('type') || null,
                    active: btn?.classList.contains('active') ?? false,
                    value: input?.value || null,
                };
            });
            check('§3 after second click: type back to password', after2.type, 'password');
            check('§3 after second click: active class removed', after2.active, false);
            check('§3 toggle preserves password value across flips', after2.value, 'sup3rsecret');

            // Keyboard-focusable
            const focusable = await page.evaluate(() => {
                const btn = document.querySelector('.a5-toggle.password-toggle');
                if (!btn) return false;
                btn.focus();
                return document.activeElement === btn;
            });
            check('§3 toggle: keyboard-focusable', focusable, true);
        }
    } finally {
        await ctx.close();
    }
}

// ── §4 Theme × viewport matrix (10 themes × 3 viewports) ───────────────────
// Icons visible, tokens resolve, no overlap, no overflow, focus works.
for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
        const ctx = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            hasTouch: vp.touch, isMobile: vp.touch,
        });
        try {
            const page = await ctx.newPage();
            page.on('pageerror', e => pageErrors.push(`${vp.label}/${theme}: ${e}`));
            currentTheme = theme;
            await page.goto(`${base}/admin`, { waitUntil: 'load' });
            await openModal(page);

            const d = await probeStructure(page);
            const L = `${vp.label}/${theme}`;

            // Structural preconditions hold in every theme
            check(`§4 ${L}: username wrap+icon present`, d.uWrap && d.uIcon, true);
            check(`§4 ${L}: password wrap+icon present`, d.pWrap && d.pIcon, true);
            check(`§4 ${L}: toggle present`, d.toggle, true);
            check(`§4 ${L}: submit icon present`, d.submitSvg, true);

            // Token resolution — every theme must resolve its tokens
            const tk = await probeTokens(page);
            check(`§4 ${L}: --bg-primary resolves`, tk.bg.length > 0, true);
            check(`§4 ${L}: --text-primary resolves`, tk.text.length > 0, true);
            check(`§4 ${L}: --accent-primary resolves`, tk.accent.length > 0, true);
            check(`§4 ${L}: --border-color resolves`, tk.border.length > 0, true);
            check(`§4 ${L}: --text-muted resolves`, tk.muted.length > 0, true);

            // Input colour uses a token (not transparent, not same as bg)
            check(`§4 ${L}: input color resolves (non-transparent)`,
                tk.inputColor !== null && tk.inputColor !== 'rgba(0, 0, 0, 0)', true);
            check(`§4 ${L}: input background resolves (non-transparent)`,
                tk.inputBg !== null && tk.inputBg !== 'rgba(0, 0, 0, 0)', true);
            check(`§4 ${L}: input color differs from background`,
                tk.inputColor !== null && tk.inputBg !== null
                && tk.inputColor !== tk.inputBg, true);
            // Icon colour resolves (uses --text-muted token)
            check(`§4 ${L}: icon color resolves`, tk.iconColor !== null, true);

            // Layout: no overlap, no overflow
            const m = await probeLayout(page);
            check(`§4 ${L}: icon does not overlap input text`,
                m.iconRight !== null && m.inputGutterEdge !== null
                && m.iconRight <= m.inputGutterEdge, true);
            check(`§4 ${L}: toggle does not overlap input text`,
                m.toggleLeft !== null && m.inputRightText !== null
                && m.toggleLeft >= m.inputRightText, true);
            check(`§4 ${L}: submit svg renders after text`, m.svgAfterText, true);
            check(`§4 ${L}: submit svg within button`, m.svgInButton, true);
            check(`§4 ${L}: modal fits viewport width`, m.modalFits, true);
            check(`§4 ${L}: no horizontal document overflow`, m.docOverflow, 0);
            check(`§4 ${L}: username field visible`, m.uVisible, true);
            check(`§4 ${L}: password field visible`, m.pVisible, true);
            check(`§4 ${L}: submit button visible`, m.submitVisible, true);
            check(`§4 ${L}: leading icon visible`, m.iconVisible, true);
            check(`§4 ${L}: toggle visible`, m.toggleVisible, true);

            // Focus-visible: focus the username input and check the focus style
            // applies (outline or box-shadow). This proves the :focus-visible
            // rule from auth-v5.css carries into every theme.
            const focusOk = await page.evaluate(() => {
                const input = document.getElementById('newUsername');
                if (!input) return null;
                input.focus();
                const cs = getComputedStyle(input);
                // auth-v5.css:focus sets border-color + box-shadow
                return cs.borderStyle !== 'none'
                    || cs.boxShadow !== 'none'
                    || cs.outlineStyle !== 'none';
            });
            check(`§4 ${L}: focus applies visible style to input`, focusOk, true);
        } finally {
            await ctx.close();
        }
    }
}

// ── §6 D8 parity with login/register: geometry, typography, validation ─────
//
// §1-§5 prove the admin form has the icon system and that it holds in every
// theme and viewport. D8 also asks for consistency with login/register on
// "alignment, height, typography, focus, validation and responsiveness", and
// "consistent" is a comparison — so this section renders login and register too
// and compares the MEASURED values rather than asserting numbers copied from
// one of them.
//
// Measured while writing this (desktop 1280x800, glass): all three forms give
// 44px field height, 40px left gutter, 44px right gutter on the password field,
// 14px/Sora type, 7px radius, an 18x18 absolutely-positioned leading icon at
// x=12, and an 18x18 submit icon in a 44px button — after animations are
// disabled. Without that the admin modal measures mid-transition (40px), which
// is why openModal() injects the freeze before anything is measured.
{
    const metrics = async (page, ids) => page.evaluate(({ u, p, sub }) => {
        const pick = (id) => {
            const i = document.getElementById(id);
            if (!i) return null;
            const cs = getComputedStyle(i);
            const wrap = i.closest('.a5-input-wrap');
            const icon = wrap?.querySelector('.a5-input-icon');
            const ics = icon ? getComputedStyle(icon) : null;
            const ir = icon ? icon.getBoundingClientRect() : null;
            const r = i.getBoundingClientRect();
            return {
                h: Math.round(r.height), padL: cs.paddingLeft, padR: cs.paddingRight,
                fontSize: cs.fontSize, fontFamily: cs.fontFamily.split(',')[0].trim(),
                radius: cs.borderTopLeftRadius, borderW: cs.borderTopWidth,
                iconW: ir ? Math.round(ir.width) : null,
                iconH: ir ? Math.round(ir.height) : null,
                iconLeft: ir ? Math.round(ir.left - r.left) : null,
                iconPos: ics ? ics.position : null,
            };
        };
        const s = document.querySelector(sub);
        const scs = s ? getComputedStyle(s) : null;
        const svg = s?.querySelector('svg');
        const sr = svg ? svg.getBoundingClientRect() : null;
        return {
            user: pick(u), pass: pick(p),
            submit: scs ? {
                h: Math.round(s.getBoundingClientRect().height),
                fontSize: scs.fontSize, radius: scs.borderTopLeftRadius,
                svgW: sr ? Math.round(sr.width) : null,
                svgH: sr ? Math.round(sr.height) : null,
            } : null,
        };
    }, ids);
    const freeze = (page) => page.addStyleTag({
        content: '*,*::before,*::after{transition:none!important;animation:none!important}',
    });
    const LOGIN_IDS = { u: 'username', p: 'password', sub: '.a5-submit' };
    const ADMIN_IDS_M = { u: 'newUsername', p: 'newPassword', sub: '#submitNewUser' };

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
        const page = await ctx.newPage();
        page.on('pageerror', e => pageErrors.push(`§6: ${e}`));

        await page.goto(`${base}/login`, { waitUntil: 'load' });
        await freeze(page);
        const login = await metrics(page, LOGIN_IDS);

        await page.goto(`${base}/register`, { waitUntil: 'load' });
        await freeze(page);
        const register = await metrics(page, LOGIN_IDS);

        await page.goto(`${base}/admin`, { waitUntil: 'load' });
        await openModal(page);
        const admin = await metrics(page, ADMIN_IDS_M);

        // Non-vacuous: the reference forms really were measured, and the two of
        // them agree, so "matches login" is a real constraint and not an
        // accident of one page.
        check('§6 reference: login form measured', login.user !== null, true);
        check('§6 reference: register form measured', register.user !== null, true);
        check('§6 admin form measured', admin.user !== null, true);
        check('§6 login and register agree with each other (baseline)',
            JSON.stringify(login), JSON.stringify(register));

        for (const field of ['user', 'pass']) {
            for (const prop of ['h', 'padL', 'padR', 'fontSize', 'fontFamily',
                'radius', 'borderW', 'iconW', 'iconH', 'iconLeft', 'iconPos']) {
                check(`§6 ${field}.${prop} matches login `
                    + `(${JSON.stringify(login[field]?.[prop])})`,
                    admin[field]?.[prop], login[field]?.[prop]);
            }
        }
        for (const prop of ['h', 'fontSize', 'radius', 'svgW', 'svgH']) {
            check(`§6 submit.${prop} matches login `
                + `(${JSON.stringify(login.submit?.[prop])})`,
                admin.submit?.[prop], login.submit?.[prop]);
        }

        // Validation parity. The rules are auth.py register_user's, which the
        // admin POST reaches, so the constraint attributes must say the same.
        const attrs = await page.evaluate(() => {
            const a = (id) => {
                const i = document.getElementById(id);
                return i ? { required: i.required, pattern: i.pattern,
                    minLength: i.minLength, type: i.type } : null;
            };
            return { u: a('newUsername'), p: a('newPassword'),
                uHint: !!document.getElementById('adminUsernameHint'),
                pHint: !!document.getElementById('adminPasswordHint') };
        });
        check('§6 username is required', attrs.u?.required, true);
        check('§6 username carries the 3-32 pattern from register_user',
            attrs.u?.pattern, '[a-zA-Z0-9_]{3,32}');
        check('§6 password is required', attrs.p?.required, true);
        check('§6 password carries the 8-char floor from register_user',
            attrs.p?.minLength, 8);
        check('§6 both hint nodes exist for auth.js', attrs.uHint && attrs.pHint, true);

        // Live feedback, driven with real typing.
        //
        // MUTATION-SAFE, per this file's stated design: every interaction below
        // is gated on the element being present, and a missing element emits a
        // named FAIL instead of letting page.fill/page.click hang for 30 s and
        // kill the run with a TimeoutError (which the mutation harness reads as
        // "red without FAIL lines" and rejects).
        const present = await page.evaluate(() => ({
            user: !!document.getElementById('newUsername'),
            pass: !!document.getElementById('newPassword'),
            toggle: !!document.querySelector('.a5-toggle.password-toggle'),
            uHintNode: !!document.getElementById('adminUsernameHint'),
        }));
        check('§6 username input present for the typing probe', present.user, true);
        check('§6 password input present for the typing probe', present.pass, true);
        check('§6 reveal toggle present for the click probe', present.toggle, true);

        if (present.user && present.uHintNode) {
            await page.fill('#newUsername', 'ab');
            await page.waitForTimeout(80);
            const shortName = await page.evaluate(() => ({
                invalid: document.getElementById('newUsername').classList.contains('is-invalid'),
                hint: document.getElementById('adminUsernameHint').textContent,
            }));
            check('§6 a 2-char username is marked invalid', shortName.invalid, true);
            check('§6 ...and says why', shortName.hint.length > 0, true);

            await page.fill('#newUsername', 'good_name');
            await page.waitForTimeout(80);
            const goodName = await page.evaluate(() => ({
                valid: document.getElementById('newUsername').classList.contains('is-valid'),
                invalid: document.getElementById('newUsername').classList.contains('is-invalid'),
            }));
            check('§6 a valid username is marked valid', goodName.valid, true);
            check('§6 ...and no longer invalid', goodName.invalid, false);
        }

        if (present.pass) {
            await page.fill('#newPassword', 'short');
            await page.waitForTimeout(80);
            check('§6 a 5-char password is marked invalid',
                await page.evaluate(() =>
                    document.getElementById('newPassword').classList.contains('is-invalid')), true);
            await page.fill('#newPassword', 'longenough1');
            await page.waitForTimeout(80);
            check('§6 an 8+ char password is marked valid',
                await page.evaluate(() =>
                    document.getElementById('newPassword').classList.contains('is-valid')), true);
        }

        // The reveal toggle must still work after validation wrote its classes:
        // both are bound in auth.js and both touch the same input.
        if (present.toggle && present.pass) {
            await page.click('.a5-toggle.password-toggle', { timeout: 5000 });
            await page.waitForTimeout(80);
            check('§6 reveal still flips type after validation ran',
                await page.evaluate(() =>
                    document.getElementById('newPassword').getAttribute('type')), 'text');
            await page.click('.a5-toggle.password-toggle', { timeout: 5000 });
            await page.waitForTimeout(80);
            check('§6 ...and flips back',
                await page.evaluate(() =>
                    document.getElementById('newPassword').getAttribute('type')), 'password');
        }
    } finally {
        await ctx.close();
    }
}
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
        const page = await ctx.newPage();
        await page.goto(`${base}/admin`, { waitUntil: 'load' });
        await openModal(page);
        const d = await probeStructure(page);

        check('§5 username: label associates via for/id', d.uLabelFor, 'newUsername');
        check('§5 password: label associates via for/id', d.pLabelFor, 'newPassword');
        check('§5 username: leading icon aria-hidden', d.uIconHidden, 'true');
        check('§5 toggle: has aria-label',
            d.toggleAriaLabel !== null && d.toggleAriaLabel.length > 0, true);
        check('§5 toggle: has data-i18n-aria-label', d.toggleI18n, true);
        check('§5 submit: trailing icon aria-hidden', d.submitSvgHidden, 'true');

        // Toggle hit target from layout probe
        const m = await probeLayout(page);
        check('§5 toggle: hit target >=44px wide',
            m.toggleRect !== null && m.toggleRect.w >= 44, true);
        check('§5 toggle: hit target >=44px tall',
            m.toggleRect !== null && m.toggleRect.h >= 44, true);
    } finally {
        await ctx.close();
    }
}

check('§no page errors', pageErrors, []);

await browser.close();
server.close();

if (failures.length) {
    console.error(failures.slice(0, 40).join('\n'));
    if (failures.length > 40) console.error(`... and ${failures.length - 40} more`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
