/*
 * Spec geometry audit -- MEASUREMENT ONLY.
 *
 * This file does not assert and does not gate. It loads the shipped templates and
 * production modules exactly as the acceptance harness does, measures COMPUTED
 * geometry from the live DOM, and prints one row per property:
 *
 *     surface | element | property | mockup | live | delta
 *
 * The mockup column is transcribed from docs/spec/sshdeck-ui-plan-v5.html
 * with its line number, so every expectation here is traceable to the authority
 * rather than to an opinion. Where the mockup is SILENT the row is marked
 * `spec: silent` and no delta is claimed -- an inference is not a deviation.
 *
 * Why this exists: images prove appearance, and this session cannot read them
 * (Entry 23). A numeric audit is the complement that can see a wrong
 * border width, a missing divider, a mis-anchored dropdown or a drifted chip
 * geometry. It structurally CANNOT see "too large", "wrongly stacked" or "ugly",
 * so it is never a substitute for the human PNG eye gate.
 *
 * Run: node tests/browser/spec_geometry_audit.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
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
    const manager = { on() { return manager; }, off() { return manager; } };
    window.io = () => {
        const socket = {
            connected: true, io: manager,
            on() { return socket; }, off() { return socket; },
            once() { return socket; },
            emit(e, p, ack) { if (typeof ack === 'function') ack({ success: true }); return socket; },
            connect() { socket.connected = true; return socket; },
            disconnect() { socket.connected = false; return socket; },
        };
        return socket;
    };
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const theme = new URL(req.url, 'http://x').searchParams.get('theme') || 'glass';
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
            return;
        }
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html', theme));
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
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop,
                      connected: true, io: { on: noop } };
`;

const rows = [];
/*
 * mockup === null means the mockup is silent on this property. The row is still
 * reported (the live value is useful context) but no delta is computed, so an
 * implementation choice is never presented as a spec deviation.
 */
function row(surface, element, property, mockup, live, note = '') {
    let delta;
    if (mockup === null) {
        delta = 'spec: silent';
    } else if (String(mockup) === String(live)) {
        delta = 'MATCH';
    } else if (typeof mockup === 'number' && typeof live === 'number') {
        const d = Math.round((live - mockup) * 100) / 100;
        delta = `${d > 0 ? '+' : ''}${d}px`;
    } else {
        delta = 'DIFFERS';
    }
    rows.push({ surface, element, property, mockup: mockup === null ? '(silent)' : mockup,
        live, delta, note });
}

async function openPage(w, h, { touch = false, theme = 'glass' } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.addInitScript(STUBS);
    await page.goto(base + (theme === 'glass' ? '' : `?theme=${theme}`),
        { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(320);
    return { ctx, page };
}

// Same production seed path the acceptance harness uses, so measured chips carry
// real latency and a real disconnected session.
async function seed(page, { layout = 1, variant = 'default' } = {}) {
    await page.evaluate(({ layout, variant }) => {
        SessionManager.setSplitLayout(layout, variant);
        [['s1', 'tiny', 'root'], ['s2', 'goclaw', 'root'], ['s3', 'staging', 'deploy']]
            .forEach(([id, host, username]) => {
                SessionManager.createSession({
                    session_id: id, host, port: 22, username,
                    auth_type: 'key', key_id: 'k1', display_name: host,
                    use_tmux: false, tmux_session_name: null, via_jump: null,
                });
            });
        ['s1', 's2', 's3'].slice(0, SessionManager.layout)
            .forEach((id, i) => SessionManager.assignSessionToPane(id, i));
        SessionManager.setActivePane(0);
        SessionManager.applySessionLatency('s1', 34);
        SessionManager.applySessionLatency('s2', 52);
        SessionManager.updateSessionStatus('s3', 'disconnected');
        SessionManager.setActivePane(0);
    }, { layout, variant });
    await page.waitForFunction(() =>
        ['s1', 's2', 's3'].every(id => TerminalManager.terminalReady[id] === true),
    null, { timeout: 3000 });
    await page.waitForTimeout(120);
}

const px = v => Math.round(parseFloat(v) * 100) / 100 || 0;

// ── 1. Outer app frame + header/toolbar divider (mockup 220, 224, 229) ───────
{
    const { ctx, page } = await openPage(1440, 900);
    await seed(page);
    const m = await page.evaluate(() => {
        const deck = document.getElementById('deckWindow');
        const ds = getComputedStyle(deck);
        const dr = deck.getBoundingClientRect();
        const header = document.querySelector('.header');
        const hs = getComputedStyle(header);
        const tabRow = document.querySelector('.session-tabs-row');
        const ts = tabRow ? getComputedStyle(tabRow) : null;
        return {
            borderTopWidth: ds.borderTopWidth, borderStyle: ds.borderTopStyle,
            borderColor: ds.borderTopColor, radius: ds.borderTopLeftRadius,
            background: ds.backgroundColor, boxShadow: ds.boxShadow,
            insetLeft: Math.round(dr.left),
            insetTop: Math.round(dr.top),
            insetRight: Math.round(window.innerWidth - dr.right),
            headerBorderBottom: hs.borderBottomWidth,
            headerBorderBottomColor: hs.borderBottomColor,
            headerBorderBottomStyle: hs.borderBottomStyle,
            tabRowBorderTop: ts ? ts.borderTopWidth : 'no element',
            tabRowBorderTopStyle: ts ? ts.borderTopStyle : 'no element',
            tabRowHeight: tabRow ? Math.round(tabRow.getBoundingClientRect().height) : 0,
        };
    });
    const S = 'frame (desktop 1440x900)';
    row(S, '.deck-window', 'border-width', 1, px(m.borderTopWidth), 'mockup 220');
    row(S, '.deck-window', 'border-style', 'solid', m.borderStyle, 'mockup 220');
    row(S, '.deck-window', 'border-radius', 12, px(m.radius), 'mockup 220');
    row(S, '.deck-window', 'border-color resolves', null, m.borderColor,
        'mockup 220 uses var(--tw-border); app uses its own token');
    row(S, '.deck-window', 'box-shadow present', 'present',
        m.boxShadow === 'none' ? 'none' : 'present', 'mockup 220 0 18px 42px');
    row(S, '.deck-window', 'inset-left (gutter)', null, m.insetLeft, '[INF-B9-1]');
    row(S, '.deck-window', 'inset-top (gutter)', null, m.insetTop, '[INF-B9-1]');
    row(S, '.deck-window', 'inset-right (gutter)', null, m.insetRight, '[INF-B9-1]');
    /*
     * Mockup 224 puts ONE hairline under the header, and mockup 229 puts one above
     * the workspace row. In the app those are the same visual line: at >=768px
     * `.header` deliberately sets `border-bottom: none` (style.css:912) and the
     * hairline is owned by `.session-tabs-row`'s border-top instead, so the desktop
     * bar stays exactly 48 + 40 = 88px with one hairline inside the session tier's
     * border box (documented at style.css:6966-6971). Scoring .header's own
     * border-bottom therefore measured the wrong element and double-counted the
     * divider. What matters is that EXACTLY ONE hairline separates the two tiers.
     */
    row(S, '.header', 'border-bottom-width (moved by design)', null,
        px(m.headerBorderBottom),
        'style.css:912 sets none at >=768; hairline moves to .session-tabs-row');
    const dividerCount = [px(m.headerBorderBottom), px(m.tabRowBorderTop)]
        .filter(v => v >= 1).length;
    row(S, 'header/toolbar divider', 'exactly one 1px hairline', 1, dividerCount,
        'mockup 224 + 229 describe one line between the two tiers');
    row(S, '.session-tabs-row', 'border-top-width (divider)', 1,
        px(m.tabRowBorderTop), 'mockup 229 workspace-row border-top 1px');
    row(S, '.session-tabs-row', 'border-top-style', 'solid', m.tabRowBorderTopStyle,
        'mockup 229');
    row(S, '.session-tabs-row', 'height', 40, m.tabRowHeight,
        'mockup 229 workspace-row height 40px');

    // ── 2. Header buttons: icon side + label presence (mockup 67-70) ─────────
    // newConnectionBtn left the header in W14 item 7: the SAME node is the
    // permanent first child of the session strip, icon-only at every tier, and
    // gets its own audit rows below instead of the header-button rows.
    const btns = await page.evaluate(() => {
        // Node-side helpers do not cross the evaluate boundary; declare it here.
        const px = v => Math.round(parseFloat(v) * 100) / 100 || 0;
        const out = [];
        for (const id of ['fileTransferBtn',
            'commandLibraryBtn', 'accountBtnHeader']) {
            const el = document.getElementById(id);
            if (!el) { out.push({ id, missing: true }); continue; }
            const icon = el.querySelector('svg, .account-avatar');
            const label = el.querySelector('.btn-label, .account-name');
            const cs = getComputedStyle(el);
            let iconSide = 'none';
            if (icon && label) {
                const ir = icon.getBoundingClientRect();
                const lr = label.getBoundingClientRect();
                iconSide = ir.left < lr.left ? 'left' : 'right';
            }
            out.push({
                id, missing: false, iconSide,
                labelVisible: !!label && getComputedStyle(label).display !== 'none',
                labelText: label ? label.textContent.trim() : '',
                // Mockup 234 specifies min-height, a FLOOR. The rendered rect can
                // legitimately exceed it (padding + line-height), so compare the
                // declared floor against the spec and report the painted height
                // separately rather than treating growth as a deviation.
                declaredMinHeight: px(cs.minHeight),
                minHeight: Math.round(el.getBoundingClientRect().height),
                radius: cs.borderTopLeftRadius,
                glyph: icon?.querySelector?.('use')?.getAttribute('href')?.split('#')[1]
                    || (icon?.tagName === 'svg'
                        ? icon.querySelector('use')?.getAttribute('href')?.split('#')[1]
                        : null) || 'n/a',
            });
        }
        return out;
    });
    const H = 'header buttons (desktop)';
    const EXPECTED_GLYPH = {
        newConnectionBtn: 'icon-plus',
        fileTransferBtn: 'icon-folder-open',
        commandLibraryBtn: 'icon-library',
        accountBtnHeader: 'icon-contact-round',
    };
    for (const b of btns) {
        if (b.missing) {
            row(H, `#${b.id}`, 'exists', 'present', 'MISSING', 'mockup 67-70');
            continue;
        }
        row(H, `#${b.id}`, 'icon side', 'left', b.iconSide,
            'mockup 67-69 place the glyph before the label');
        row(H, `#${b.id}`, 'label visible at 1440', true, b.labelVisible,
            'mockup 67-69 show text labels on desktop');
        row(H, `#${b.id}`, 'declared min-height', 32, b.declaredMinHeight,
            'mockup 234 min-height:32px is a floor');
        row(H, `#${b.id}`, 'painted height', null, b.minHeight,
            'rect may exceed the 32px floor; reported for context');
        row(H, `#${b.id}`, 'border-radius', 7, px(b.radius), 'mockup 234');
        row(H, `#${b.id}`, 'sprite glyph', EXPECTED_GLYPH[b.id], b.glyph,
            'mockup 67-70 data-lucide names');
    }

    // ── 2b. The strip's permanent '+' (W14 item 7) ───────────────────────────
    const stripBtn = await page.evaluate(() => {
        const el = document.getElementById('newConnectionBtn');
        if (!el) { return null; }
        const cs = getComputedStyle(el);
        const icon = el.querySelector('svg');
        return {
            stripHome: !!el.parentElement
                ?.classList.contains('session-tabs-row'),
            firstChild: el.parentElement?.firstElementChild === el,
            iconOnly: getComputedStyle(el.querySelector('.btn-label'))
                .display === 'none',
            height: Math.round(el.getBoundingClientRect().height),
            radius: cs.borderTopLeftRadius,
            glyph: icon?.querySelector('use')?.getAttribute('href')
                ?.split('#')[1] || 'n/a',
            title: el.getAttribute('title'),
        };
    });
    const SB = 'strip new-connection button (desktop)';
    row(SB, '#newConnectionBtn', 'exists', 'present',
        stripBtn ? 'present' : 'MISSING', 'W14 item 7');
    if (stripBtn) {
        /*
         * S35 P59 -- ARGUMENT ORDER. row() is (surface, element, property,
         * mockup, live, note): this call had the prose label in the `mockup`
         * slot, the measured pair in `live`, and the REAL expected value
         * `[true, true]` stranded in `note`, where nothing compares it. So the
         * row compared "session strip, first child" against "true,true" and
         * reported DIFFERS on every run no matter where the button lived --
         * a permanently-red row that could never certify anything. Measured
         * live value is [true, true], i.e. the button IS the strip's first
         * child, exactly as W14 item 7 requires.
         */
        row(SB, '#newConnectionBtn', 'home', [true, true],
            [stripBtn.stripHome, stripBtn.firstChild],
            'W14 item 7 owner instruction: session strip, first child');
        row(SB, '#newConnectionBtn', 'icon-only at 1440', true,
            stripBtn.iconOnly, 'W14 item 7: label hidden at every tier');
        row(SB, '#newConnectionBtn', 'height fits the 40px tier', 30,
            stripBtn.height, 'W14 item 7 strip metrics');
        row(SB, '#newConnectionBtn', 'border-radius', 7, px(stripBtn.radius),
            'mockup 234');
        row(SB, '#newConnectionBtn', 'sprite glyph', 'icon-plus',
            stripBtn.glyph, 'mockup 67 data-lucide name');
        row(SB, '#newConnectionBtn', 'accessible name', 'New Connection',
            stripBtn.title, 'title carries the name the label lost');
    }

    // ── 3. Logo + favicon wiring in <head> (mockup 65, 232) ─────────────────
    const head = await page.evaluate(() => {
        const logo = document.querySelector('.brand-logo');
        const ls = logo ? getComputedStyle(logo) : null;
        const lr = logo ? logo.getBoundingClientRect() : null;
        const link = rel => {
            const el = document.querySelector(`link[rel="${rel}"]`);
            return el ? el.getAttribute('href') : 'ABSENT';
        };
        return {
            logoW: lr ? Math.round(lr.width) : 0,
            logoH: lr ? Math.round(lr.height) : 0,
            logoRadius: ls ? ls.borderTopLeftRadius : 'n/a',
            logoGlyph: logo?.querySelector('use')?.getAttribute('href')
                ?.split('#')[1] || 'n/a',
            title: document.title,
            wordmark: document.querySelector('.app-title')?.textContent.trim() || '',
            iconSvg: link('icon'),
            iconIco: link('alternate icon'),
            appleTouch: link('apple-touch-icon'),
        };
    });
    const L = 'brand + head wiring';
    row(L, '.brand-logo', 'width', 28, head.logoW, 'mockup 232 logo 28x28');
    row(L, '.brand-logo', 'height', 28, head.logoH, 'mockup 232');
    row(L, '.brand-logo', 'border-radius', 7, px(head.logoRadius), 'mockup 232');
    row(L, '.brand-logo', 'sprite glyph', 'icon-square-terminal', head.logoGlyph,
        'mockup 65 square-terminal');
    row(L, '.app-title', 'wordmark text', 'SSHDeck', head.wordmark,
        'mockup 65 / amendment 16');
    row(L, 'link[rel=icon]', 'href', '/static/icons/favicon.svg?v=1', head.iconSvg,
        'primary icon wiring');
    row(L, 'link[rel=alternate icon]', 'href', '/static/icons/favicon.ico?v=1',
        head.iconIco, 'legacy fallback');
    row(L, 'link[rel=apple-touch-icon]', 'href',
        '/static/icons/apple-touch-icon.png?v=1', head.appleTouch, 'iOS icon');

    // ── 4. Fonts per text role (mockup 215, 221, 253) ───────────────────────
    const fonts = await page.evaluate(() => {
        const read = sel => {
            const el = document.querySelector(sel);
            if (!el) return { missing: true };
            const cs = getComputedStyle(el);
            return { family: cs.fontFamily, weight: cs.fontWeight,
                size: cs.fontSize };
        };
        return {
            body: read('body'),
            chipStrong: read('#tab-s1 .tab-label strong'),
            chipSmall: read('#tab-s1 .tab-label small'),
            appTitle: read('.app-title'),
            terminal: read('#terminal-s1 .xterm'),
            terminalRows: read('#terminal-s1 .xterm-rows')
                .missing ? read('#terminal-s1 .xterm-screen') : read('#terminal-s1 .xterm-rows'),
            statusBar: read('#statusBar'),
        };
    });
    const F = 'fonts';
    // Compare the font stack with whitespace normalised: getComputedStyle returns
    // ", " separators while the mockup source has none, so a raw string compare
    // reported a difference where the stack is identical.
    const norm = s => String(s).replace(/\s*,\s*/g, ',').trim();
    const uiStack = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    row(F, 'body', 'font-family (UI stack)', uiStack,
        norm(fonts.body.family), 'mockup 215; whitespace-normalised compare');
    row(F, 'chip <strong>', 'font-weight', 500, Number(fonts.chipStrong.weight),
        'mockup 221 strong{font-weight:500}');
    row(F, '.app-title', 'font-weight', null, Number(fonts.appTitle.weight),
        'mockup 65 uses <strong> inside .tw5-brand');
    /*
     * Read the font off the element xterm actually renders glyphs into. `.xterm`
     * is the container and inherits the UI stack; the monospace face lives on the
     * rows layer, so measuring the container reported the UI font and looked like
     * a violation of mockup 253 when it was not.
     */
    row(F, 'terminal rows', 'font-family is monospace', 'monospace-ish',
        /mono|Menlo|Consolas|Courier|Courier New/i.test(fonts.terminalRows.family || '')
            ? 'monospace-ish' : fonts.terminalRows.family, 'mockup 253');
    row(F, 'chip <small>', 'font-weight', null, Number(fonts.chipSmall.weight),
        'mockup 245 sets colour/nowrap only');
    row(F, '#statusBar', 'font-family', null, fonts.statusBar.family,
        'mockup 262 sets colour/background only');

    // ── 5. Session chip geometry + latency + counter (mockup 243-249, 86-89) ─
    const chips = await page.evaluate(() => {
        const strip = document.getElementById('sessionTabs');
        const ss = strip ? getComputedStyle(strip) : null;
        const tab = document.getElementById('tab-s1');
        const cs = getComputedStyle(tab);
        const before = getComputedStyle(tab, '::before');
        const r = tab.getBoundingClientRect();
        const dot = tab.querySelector('.status-dot');
        const dotCs = dot ? getComputedStyle(dot) : null;
        const dotR = dot ? dot.getBoundingClientRect() : null;
        // Painted pill: ::before owns the paint on touch; on fine pointer the
        // element itself paints (Entry 21).
        const pillH = before.content !== 'none'
            ? px(before.height) : Math.round(r.height);
        return {
            stripGap: ss ? ss.gap : 'n/a',
            elementH: Math.round(r.height),
            pillH: typeof pillH === 'number' ? pillH : parseFloat(pillH),
            minWidth: cs.minWidth,
            padding: cs.padding,
            radius: cs.borderTopLeftRadius,
            beforeRadius: before.content !== 'none'
                ? before.borderTopLeftRadius : 'no ::before',
            dotW: dotR ? Math.round(dotR.width) : 0,
            dotRadius: dotCs ? dotCs.borderTopLeftRadius : 'n/a',
            s1Small: document.querySelector('#tab-s1 .tab-user-name')?.textContent.trim(),
            s2Small: document.querySelector('#tab-s2 .tab-user-name')?.textContent.trim(),
            s3Small: document.querySelector('#tab-s3 .tab-user-name')?.textContent.trim(),
            s1Strong: document.querySelector('#tab-s1 strong')?.textContent.trim(),
            counterExists: !!document.getElementById('composerTarget'),
            counterHidden: document.getElementById('composerTarget')?.hidden,
            counterText: document.querySelector('#composerTarget .composer-target-label')
                ?.textContent.trim() || '',
            statusLatency: document.getElementById('statusBarLatency')?.textContent.trim(),
        };
        function px(v) { return Math.round(parseFloat(v) * 100) / 100 || 0; }
    });
    const C = 'session chips (desktop)';
    row(C, '.session-tab', 'painted pill height', 30, chips.pillH,
        'mockup 243 height:30px (ruled 21/23: 30px on both surfaces)');
    row(C, '.session-tab', 'min-width', 92, px(chips.minWidth), 'mockup 243');
    row(C, '.session-tab', 'padding', '1px 7px', chips.padding, 'mockup 243');
    row(C, '.session-tabs', 'gap', 3, px(chips.stripGap), 'mockup 241 gap:3px');
    row(C, '.status-dot', 'width', 7, chips.dotW, 'mockup 249 dot 7x7');
    row(C, '.status-dot', 'border-radius is round', '50%', chips.dotRadius,
        'mockup 249');
    row(C, '#tab-s1 strong', 'primary text', 'tiny', chips.s1Strong, 'mockup 86');
    row(C, '#tab-s1 small', 'secondary text', 'root · 34 ms', chips.s1Small,
        'mockup 86 "root · 34 ms"');
    row(C, '#tab-s2 small', 'secondary text', 'root · 52 ms', chips.s2Small,
        'mockup 87 "root · 52 ms"');
    /*
     * The mockup is written in Vietnamese, but the shell's active locale here is
     * English, where session.disconnectedShort is "Disconnected" (i18n.js:444);
     * the Vietnamese string "Đã ngắt" exists at i18n.js:936. So the expectation is
     * "the disconnected chip shows its translated short copy", not the literal
     * Vietnamese string -- comparing against the latter measured the locale, not
     * the product.
     */
    row(C, '#tab-s3 small', 'disconnected copy (en locale)', 'Disconnected',
        chips.s3Small, 'mockup 88 "Đã ngắt" = i18n session.disconnectedShort');
    row(C, '#statusBarLatency', 'active latency text', '34 ms', chips.statusLatency,
        'mockup 188 statusbar "Đã kết nối · 34 ms"');
    row(C, '#composerTarget', 'exists in DOM', true, chips.counterExists,
        'mockup 191 target chip');
    row(C, '#composerTarget', 'hidden when Broadcast off', true, chips.counterHidden,
        'amendment 74 desktop normal has no target');

    await ctx.close();
}

// ── 6. Broadcast counter text format (mockup 191, amendment 83) ─────────────
{
    const { ctx, page } = await openPage(1440, 900);
    await seed(page);
    await page.locator('#broadcastToggleBtn').click();
    await page.waitForTimeout(160);
    const b = await page.evaluate(() => {
        const target = document.getElementById('composerTarget');
        const label = target?.querySelector('.composer-target-label');
        const sendLabel = document.querySelector('#mobileSendBtn .btn-label');
        const chipCs = target ? getComputedStyle(target) : null;
        return {
            hidden: target?.hidden,
            text: label?.textContent.trim() || '',
            minHeight: target ? Math.round(target.getBoundingClientRect().height) : 0,
            radius: chipCs ? chipCs.borderTopLeftRadius : 'n/a',
            sendLabelVisible: sendLabel
                ? getComputedStyle(sendLabel).display !== 'none' : false,
            sendLabelText: sendLabel?.textContent.trim() || '',
            composerCount: document.querySelectorAll('.mobile-composer').length,
            inputCount: document.querySelectorAll('#mobileInput').length,
        };
    });
    const B = 'broadcast on (desktop)';
    row(B, '#composerTarget', 'visible when Broadcast on', false, b.hidden,
        'mockup 191 / amendment 75');
    row(B, '#composerTarget', 'counts connected sendable only', 'All 2', b.text,
        'amendment 83: s3 disconnected is excluded, so N=2');
    row(B, '#composerTarget', 'min-height', 42, b.minHeight, 'mockup 372');
    row(B, '#composerTarget', 'border-radius', 7, px(b.radius), 'mockup 372');
    row(B, '#mobileSendBtn label', 'visible on desktop Broadcast', true,
        b.sendLabelVisible, 'amendment 75 "Icon + Gửi tất cả"');
    row(B, '.mobile-composer', 'exactly one instance', 1, b.composerCount,
        'amendment 68');
    row(B, '#mobileInput', 'exactly one instance', 1, b.inputCount, 'amendment 68');
    await ctx.close();
}

// ── 7. Dropdown anchoring vs trigger (mockup 264-268, amendment 92) ─────────
for (const [label, w, h, touch, triggerId, panelId] of [
    ['desktop account menu', 1440, 900, false, 'accountBtnHeader', 'accountDropdownHeader'],
    ['desktop layout menu', 1440, 900, false, 'layoutMenuBtn', 'layoutMenu'],
    ['iPad layout menu', 834, 1194, true, 'layoutMenuBtn', 'layoutMenu'],
    ['phone390 More sheet', 390, 844, true, 'mobileMoreBtn', 'mobileMoreSheet'],
]) {
    const { ctx, page } = await openPage(w, h, { touch });
    await seed(page, { layout: touch ? 2 : 1 });
    const trigger = page.locator(`#${triggerId}`);
    if (touch) await trigger.tap(); else await trigger.click();
    await page.waitForTimeout(220);
    const a = await page.evaluate(({ triggerId, panelId }) => {
        const t = document.getElementById(triggerId).getBoundingClientRect();
        const p = document.getElementById(panelId).getBoundingClientRect();
        return {
            gap: Math.round((p.top - t.bottom) * 100) / 100,
            gapAbove: Math.round((t.top - p.bottom) * 100) / 100,
            rightDelta: Math.round((t.right - p.right) * 100) / 100,
            width: Math.round(p.width),
            insideViewportRight: Math.round(window.innerWidth - p.right),
            insideViewportLeft: Math.round(p.left),
            opensUpward: p.bottom <= t.top,
        };
    }, { triggerId, panelId });
    const D = `dropdown anchor (${label})`;
    // Mockup 264-268 anchor every floating surface 1px below the row that owns
    // it. On phones the app's header is at the BOTTOM, so the card opens upward
    // by the ruled adaptation (Entry 5 Part B) -- reported, not scored.
    if (a.opensUpward) {
        row(D, `#${panelId}`, 'gap above trigger', null, a.gapAbove,
            'Entry 5 Part B: upward adaptation');
        row(D, `#${panelId}`, 'opens upward', null, true,
            'mockup 265-268 is top:calc(100%+1px) for a TOP header');
    } else {
        row(D, `#${panelId}`, 'gap below trigger', 1, a.gap,
            'mockup 265-268 top:calc(100% + 1px)');
    }
    row(D, `#${panelId}`, 'right edge vs trigger right', null, a.rightDelta,
        'mockup 265-268 right:8px / 6px of the ROW, not the trigger');
    row(D, `#${panelId}`, 'inside viewport (right slack)', 'positive',
        a.insideViewportRight >= 0 ? 'positive' : `${a.insideViewportRight}`,
        'amendment 92 right edge must not exceed viewport');
    row(D, `#${panelId}`, 'inside viewport (left slack)', 'positive',
        a.insideViewportLeft >= 0 ? 'positive' : `${a.insideViewportLeft}`,
        'amendment 92');
    row(D, `#${panelId}`, 'width', null, a.width,
        label.includes('More') ? 'mockup 267 min(300px, 100%-12px)' : 'mockup 265-266');
    await ctx.close();
}

// ── 8. Touch rows, keypad, exit-scroll, notes (mockup 323-325, 341-347, 336-339) ──
for (const [label, w, h] of [
    ['iPad portrait', 834, 1194],
    ['phone390', 390, 844],
    ['phone landscape', 926, 428],
]) {
    const { ctx, page } = await openPage(w, h, { touch: true });
    await seed(page, { layout: 2 });
    const t = await page.evaluate(() => {
        const actionRow = document.getElementById('touchActionRow');
        const sessionRow = document.querySelector('.session-tabs-row');
        const ar = actionRow?.getBoundingClientRect();
        const sr = sessionRow?.getBoundingClientRect();
        const tab = document.getElementById('tab-s1');
        const tr = tab?.getBoundingClientRect();
        const before = tab ? getComputedStyle(tab, '::before') : null;
        return {
            actionRowH: ar ? Math.round(ar.height) : 0,
            sessionRowH: sr ? Math.round(sr.height) : 0,
            // VISIBLE buttons only. The row also HOSTS relocated secondary
            // controls that are display:none while docked, so a raw
            // querySelectorAll count reports 9-11 and is not the six actions
            // amendment 32-39 is about.
            actionCount: actionRow
                ? [...actionRow.querySelectorAll('button')].filter(b => {
                    const cs = getComputedStyle(b);
                    const r = b.getBoundingClientRect();
                    return cs.display !== 'none' && cs.visibility !== 'hidden'
                        && r.width > 0 && r.height > 0;
                }).length : 0,
            // .session-tabs-row is `display: contents` at some tiers (its
            // children lay out as siblings of the header rows) and `none` in
            // phone landscape, where the strip relocates into the dock. Its own
            // rect is then meaningless, so measure the band that actually paints.
            sessionRowDisplay: sessionRow ? getComputedStyle(sessionRow).display : 'n/a',
            stripH: (() => {
                const strip = document.getElementById('sessionTabs');
                return strip ? Math.round(strip.getBoundingClientRect().height) : 0;
            })(),
            chipElementH: tr ? Math.round(tr.height) : 0,
            chipPillH: before && before.content !== 'none'
                ? Math.round(parseFloat(before.height)) : (tr ? Math.round(tr.height) : 0),
            chipSmall: document.querySelector('#tab-s1 .tab-user-name')?.textContent.trim(),
            landscape: window.matchMedia('(orientation: landscape)').matches,
        };
    });
    const T = `touch rows (${label} ${w}x${h})`;
    const isPhoneLandscape = (w === 926 && h === 428);
    // Mockup 323 is 44px; mockup 358 rules phone landscape to a 40px band, and
    // Entry 1/3 record that approved 40px band plus its 44px hit target.
    row(T, '#touchActionRow', 'height', isPhoneLandscape ? 40 : 44, t.actionRowH,
        isPhoneLandscape
            ? 'mockup 358 + Entry 1 (approved 40px band)'
            : 'mockup 323 touch-global-row 44px');
    // The row element is display:contents / none at several tiers (its children
    // lay out as header siblings, and in phone landscape the strip relocates into
    // the dock), so the painted strip is the meaningful band.
    row(T, '.session-tabs-row', 'display', null, t.sessionRowDisplay,
        'contents/none by tier: the row is not a painted box everywhere');
    row(T, '#sessionTabs', 'painted strip height', null, t.stripH,
        'mockup 324/358 govern the ROW; measured here for context');
    row(T, '#touchActionRow', 'six global actions', 6, t.actionCount,
        'amendment 32-39');
    row(T, '.session-tab', 'painted pill height', 30, t.chipPillH,
        'mockup 325 touch chip 30px');
    /*
     * Amendment 54 requires a 44px TAP BAND, which Entry 7 Part A
     * implements as an invisible centred ::after rather than by growing the
     * painted element -- so the element rect is legitimately 40px in the 40px
     * landscape row while the reachable band is 44px. The element rect alone
     * cannot express that, so it is reported unscored here; mobile_shell_layout
     * owns the real hit-target proof via elementFromPoint.
     */
    row(T, '.session-tab', 'element rect height', null, t.chipElementH,
        'amendment 54 hit band is a ::after; see Entry 7 Part A');
    row(T, '#tab-s1 small', 'touch secondary is user only', 'root', t.chipSmall,
        'mockup 149-151: touch chips show the user, no latency');

    // keypad
    await page.locator('#mobileKeypadBtn').tap();
    await page.locator('#mobileKeypad').waitFor({ state: 'visible' });
    await page.waitForTimeout(140);
    const k = await page.evaluate(() => {
        const kp = document.getElementById('mobileKeypad');
        const kr = kp.getBoundingClientRect();
        const grid = document.querySelector('.mobile-keypad-grid');
        const gs = getComputedStyle(grid);
        const key = document.querySelector('.keypad-key');
        const kcs = getComputedStyle(key);
        const pane = document.querySelector('.terminal-pane.active')
            || document.querySelector('.terminal-pane');
        const pr = pane.getBoundingClientRect();
        return {
            cols: gs.gridTemplateColumns.trim().split(/\s+/).length,
            rows: gs.gridTemplateRows.trim().split(/\s+/).length,
            keyMinH: Math.round(key.getBoundingClientRect().height),
            keyRadius: kcs.borderTopLeftRadius,
            keypadPadding: getComputedStyle(kp).padding,
            keypadBorderTop: getComputedStyle(kp).borderTopWidth,
            overlap: Math.max(0, Math.min(kr.bottom, pr.bottom) - Math.max(kr.top, pr.top)),
            workspacePositive: pr.height > 0,
            keyCount: document.querySelectorAll('.keypad-key').length,
            gridCount: document.querySelectorAll('.mobile-keypad-grid').length,
        };
    });
    const K = `keypad (${label})`;
    row(K, '.mobile-keypad-grid', 'columns', 4, k.cols, 'mockup 346 repeat(4,...)');
    row(K, '.mobile-keypad-grid', 'rows', 2, k.rows, 'mockup 198 two rows of 4');
    row(K, '.keypad-key', 'min-height', 39, k.keyMinH, 'mockup 347 min-height:39px');
    row(K, '.keypad-key', 'border-radius', 7, px(k.keyRadius), 'mockup 347');
    row(K, '.mobile-keypad', 'padding', '5px', k.keypadPadding, 'mockup 342 padding:5px');
    row(K, '.mobile-keypad', 'border-top-width', 1, px(k.keypadBorderTop),
        'mockup 342 border-top 1px');
    row(K, '.mobile-keypad', 'terminal overlap', 0, Math.round(k.overlap),
        'amendment 94 keypad must not overlay the terminal');
    row(K, 'grids x keys', 'inventory', '2 x 8 = 16',
        `${k.gridCount} x ${k.keyCount / (k.gridCount || 1)} = ${k.keyCount}`,
        'mockup 198-199');

    /*
     * Exit-scroll needs a tmux session to be revealable at all: renderExitScrollState
     * gates on `session.useTmux && isSessionScrolled(active)` (app.js:2823). The seed
     * above creates s1 WITHOUT tmux, so the earlier version of this audit measured a
     * permanently hidden button and reported width/height 0 as a deviation -- an audit
     * bug, not a product one. Re-seed s1 with tmux through the production creation
     * path before driving the state owner.
     */
    await page.evaluate(() => {
        SessionManager.closeSession('s1');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'audit-s1', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    /*
     * setScrollState must come AFTER the recreation settles. destroyTerminal on the
     * close path clears scrollStateBySession for the id, and setScrollState is
     * change-gated (terminal-manager.js:763), so setting it inside the same
     * evaluate as the rebuild left `isSessionScrolled('s1') === false` and the
     * button correctly stayed hidden -- measured, and an ordering bug in this audit
     * rather than a product fault.
     */
    await page.waitForTimeout(160);
    await page.evaluate(() => TerminalManager.setScrollState('s1', true));
    await page.waitForTimeout(160);
    const es = await page.evaluate(() => {
        const btn = document.getElementById('exitScrollBtn');
        const label = btn.querySelector('.btn-label');
        const r = btn.getBoundingClientRect();
        return {
            hidden: btn.hidden,
            width: Math.round(r.width), height: Math.round(r.height),
            labelVisible: getComputedStyle(label).display !== 'none',
            landscape: window.matchMedia('(orientation: landscape)').matches,
        };
    });
    const E = `exit-scroll (${label})`;
    // Owner ruling: phone portrait + iPad portrait icon-only; wider landscape
    // layouts (iPad landscape, phone landscape) reveal the short label.
    const labelExpected = es.landscape;
    row(E, '#exitScrollBtn', 'revealed by scroll state', false, es.hidden,
        'mockup 336-337');
    row(E, '#exitScrollBtn', 'label visible', labelExpected, es.labelVisible,
        'mockup 338/423 + owner ruling: portrait icon-only, landscape labelled');
    row(E, '#exitScrollBtn', 'height', 44, es.height, 'touch floor 44px');
    if (!labelExpected) {
        row(E, '#exitScrollBtn', 'icon-only width', 44, es.width,
            'mockup 339 width:42px scaled to the app 44px floor');
    } else {
        row(E, '#exitScrollBtn', 'labelled width > 44', 'yes',
            es.width > 44 ? 'yes' : `no (${es.width})`, 'mockup 194 label form');
    }
    await ctx.close();
}

// ── 9. Notes panel (mockup 176, 290-295) ────────────────────────────────────
for (const [label, w, h, touch] of [
    ['desktop', 1440, 900, false],
    ['iPad portrait', 834, 1194, true],
    ['phone390', 390, 844, true],
]) {
    const { ctx, page } = await openPage(w, h, { touch });
    await seed(page, { layout: touch ? 2 : 1 });
    if (touch) {
        await page.locator('#notepadOpenBtn').tap();
    } else {
        await page.evaluate(() =>
            document.getElementById('notepadPanel').classList.remove('collapsed'));
    }
    await page.waitForTimeout(220);
    const n = await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        const r = panel.getBoundingClientRect();
        const cs = getComputedStyle(panel);
        const head = panel.querySelector('.notepad-header');
        const ta = document.getElementById('sessionNotepad');
        const tacs = ta ? getComputedStyle(ta) : null;
        return {
            width: Math.round(r.width), height: Math.round(r.height),
            borderLeft: cs.borderLeftWidth,
            headPadding: head ? getComputedStyle(head).padding : 'n/a',
            headBorderBottom: head ? getComputedStyle(head).borderBottomWidth : 'n/a',
            taMargin: tacs ? tacs.margin : 'n/a',
            taPadding: tacs ? tacs.padding : 'n/a',
            taRadius: tacs ? tacs.borderTopLeftRadius : 'n/a',
            taMono: tacs ? /mono|Menlo|Consolas/i.test(tacs.fontFamily) : false,
            metaText: document.getElementById('notepadMetaHost')?.textContent.trim() || '',
        };
    });
    const N = `notes (${label})`;
    row(N, '.notepad-panel', 'painted width > 0', 'yes',
        n.width > 0 ? 'yes' : 'no', 'mockup 290 inspector');
    row(N, '.notepad-panel', 'border-left-width', touch ? null : 1,
        px(n.borderLeft), 'mockup 290 border-left 1px (desktop rail)');
    row(N, '.notepad-header', 'padding', '9px', n.headPadding,
        'mockup 292 panel-head padding:9px');
    row(N, '.notepad-header', 'border-bottom-width', 1, px(n.headBorderBottom),
        'mockup 292');
    row(N, '#sessionNotepad', 'margin', '9px', n.taMargin, 'mockup 295 margin:9px');
    row(N, '#sessionNotepad', 'padding', '9px', n.taPadding, 'mockup 295 padding:9px');
    row(N, '#sessionNotepad', 'border-radius', 7, px(n.taRadius), 'mockup 295');
    row(N, '#sessionNotepad', 'monospace', true, n.taMono, 'mockup 295');
    // Compare on trimmed content: the separator lives in a sibling node, so the
    // leading " · " I expected was never part of this element's text.
    row(N, '.notepad-meta-host', 'names the session', '· tiny', n.metaText,
        'mockup 176 "Tự lưu · tiny"');
    await ctx.close();
}

// ── 10. All 10 themes: frame + divider tokens resolve and differ ────────────
const THEMES = ['glass', 'retro', 'solar', 'paper', 'noir', 'arctic-ice',
    'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian'];
const themeRows = [];
for (const theme of THEMES) {
    const { ctx, page } = await openPage(1440, 900, { theme });
    await seed(page);
    const t = await page.evaluate(() => {
        const deck = getComputedStyle(document.getElementById('deckWindow'));
        const header = getComputedStyle(document.querySelector('.header'));
        const tabRow = getComputedStyle(document.querySelector('.session-tabs-row'));
        return {
            frameBorderW: deck.borderTopWidth,
            frameBorderC: deck.borderTopColor,
            frameRadius: deck.borderTopLeftRadius,
            frameBg: deck.backgroundColor,
            shadow: deck.boxShadow === 'none' ? 'none' : 'present',
            headerDivider: header.borderBottomWidth,
            rowDivider: tabRow.borderTopWidth,
            unresolved: [deck.borderTopColor, deck.backgroundColor]
                .filter(v => !v || v === '' ).length,
        };
    });
    themeRows.push({ theme, ...t });
    await ctx.close();
}
for (const t of themeRows) {
    const S = `theme ${t.theme}`;
    row(S, '.deck-window', 'border-width', 1, px(t.frameBorderW), 'mockup 220');
    row(S, '.deck-window', 'border-radius', 12, px(t.frameRadius), 'mockup 220');
    row(S, '.deck-window', 'box-shadow', 'present', t.shadow, 'mockup 220');
    // One hairline between the tiers, wherever it is owned (see the desktop block).
    row(S, 'header/toolbar divider', 'exactly one 1px hairline', 1,
        [px(t.headerDivider), px(t.rowDivider)].filter(v => v >= 1).length,
        'mockup 224 + 229');
    row(S, 'tokens', 'all resolve', 0, t.unresolved, 'AGENTS section 4');
}
const distinctBorders = new Set(themeRows.map(t => t.frameBorderC)).size;
const distinctBgs = new Set(themeRows.map(t => t.frameBg)).size;
row('themes (all 10)', '.deck-window', 'distinct border colours across themes',
    null, `${distinctBorders} of 10`, 'a shared token would give 1');
row('themes (all 10)', '.deck-window', 'distinct shell backgrounds', null,
    `${distinctBgs} of 10`, 'AGENTS section 4');

await browser.close();
server.close();

// ── Report ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const W = [26, 26, 34, 16, 22, 14];
console.log('\n' + [
    pad('SURFACE', W[0]), pad('ELEMENT', W[1]), pad('PROPERTY', W[2]),
    pad('MOCKUP', W[3]), pad('LIVE', W[4]), pad('DELTA', W[5]),
].join(' '));
console.log('-'.repeat(W.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) {
    console.log([
        pad(r.surface, W[0]), pad(r.element, W[1]), pad(r.property, W[2]),
        pad(r.mockup, W[3]), pad(r.live, W[4]), pad(r.delta, W[5]),
    ].join(' '));
}

const deviations = rows.filter(r =>
    r.delta !== 'MATCH' && r.delta !== 'spec: silent');
console.log(`\nrows: ${rows.length}`);
console.log(`matches: ${rows.filter(r => r.delta === 'MATCH').length}`);
console.log(`spec-silent (reported, not scored): `
    + `${rows.filter(r => r.delta === 'spec: silent').length}`);
console.log(`deviations: ${deviations.length}`);
if (deviations.length) {
    console.log('\nDEVIATIONS');
    for (const d of deviations) {
        console.log(`  ${d.surface} | ${d.element} | ${d.property}`);
        console.log(`      mockup=${d.mockup}  live=${d.live}  delta=${d.delta}`);
        if (d.note) console.log(`      ref: ${d.note}`);
    }
}
