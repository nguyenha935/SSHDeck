/*
 * P1 — Composer & paste contract + visualViewport keyboard acceptance.
 *
 * Covers three gaps the existing suites leave open:
 *  §1  helper text (.mobile-composer-help) always visible at every width,
 *      including the narrowest 359px — never hidden, never clipped to 0px.
 *      Visibility is proven with a nonzero rendered rect, not display alone.
 *  §2  real ClipboardEvent paste into #mobileInput on a coarse context ⇒
 *      ZERO ssh_input; the draft stays editable; explicit Send commits with
 *      the exact bracketed-paste bytes from commitMobileInput.
 *  §3  real visualViewport keyboard-OPEN acceptance at the three named
 *      viewports (390×844 phone, 834×1194 iPad portrait, 1194×834 iPad
 *      landscape): shrinking visualViewport.height below 75% of the
 *      load-time initialHeight must toggle body.keyboard-open, pin
 *      --app-height to the shrunk height, keep the dock in the touch shell's
 *      normal flex flow (position:relative) with its bottom edge anchored to
 *      the shrunken shell, keep the composer visible above the keyboard, and
 *      reduce terminal rows — not hide the terminal.
 *      Every geometry assertion recomputes its rect INSIDE the final
 *      requestAnimationFrame after layout settles, so it cannot pass with
 *      the composer still sitting below the keyboard.
 *
 * Uses the same renderTemplate / http-server / STUBS infrastructure as the
 * existing browser suites. No production source is modified by this test.
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

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
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

// Same stubs the other coarse suites use: socket is a no-op, TerminalManager is
// inert. The real app.js binds to #mobileInput and the visualViewport handler is
// the real one from terminal-manager.js (loaded via the page's own <script>).
const STUBS = `
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop, io: { on: noop } };
    window.TerminalManager = {
        createTerminal: noop, disposeTerminal: noop, fitAllTerminals: noop,
        fitTerminal: noop, focusTerminal: noop, applyThemeToAll: noop,
        requestFit: noop, cancelPendingFit: noop,
        getTerminal: () => null, writeToTerminal: noop, destroyTerminal: noop,
        isTouchShell: () => true, isDesktopShell: () => false,
    };
`;

async function newPage(w, h) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: true,
        isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // Make the session bar visible (it starts hidden until a session exists).
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    return { ctx, page, errors };
}

// ============================================================================
// §1 — helper text always visible at every width (nonzero rendered rect)
// ============================================================================
for (const [label, w, h] of [
    ['359px (narrowest)', 359, 780],
    ['428×926 (phone)', 428, 926],
    ['834×1194 (iPad portrait)', 834, 1194],
    ['1194×834 (iPad landscape)', 1194, 834],
]) {
    const { ctx, page, errors } = await newPage(w, h);
    const helper = await page.evaluate(() => {
        const el = document.querySelector('.mobile-composer-help');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            rendered: r.width > 0 && r.height > 0 && r.right > r.left && r.bottom > r.top,
            height: Math.round(r.height),
            width: Math.round(r.width),
            ws: cs.whiteSpace,
            textOverflow: cs.textOverflow,
            role: el.getAttribute('role'),
            text: el.textContent.trim(),
        };
    });
    check(`${label}: helper span exists`, helper !== null, true);
    check(`${label}: helper renders with a nonzero rect (w>0, h>0)`, helper?.rendered, true);
    check(`${label}: helper role is "note"`, helper?.role, 'note');
    check(`${label}: helper white-space is nowrap`, helper?.ws, 'nowrap');
    check(`${label}: helper text-overflow is ellipsis`, helper?.textOverflow, 'ellipsis');
    check(`${label}: helper has non-empty text`, (helper?.text || '').length > 0, true);
    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §2 — real ClipboardEvent paste ⇒ zero ssh_input ⇒ editable draft ⇒ Send
// ============================================================================
{
    const { ctx, page, errors } = await newPage(428, 926);
    await page.waitForTimeout(80);

    // Seed a session so commitMobileInput has an active session to target.
    // NOTE: session-manager.js declares `const SessionManager = {...}` — a
    // global LEXICAL binding reachable from page.evaluate but NOT a property
    // of window (the same suites reference it bare for this reason).
    await page.evaluate(() => {
        const SM = SessionManager;
        SM.sessions['paste-sess'] = {
            session_id: 'paste-sess', host: 'paste.example', username: 'sshdeck',
            port: 22, authType: 'key', keyId: 'k1', connected: true,
        };
        if (!document.getElementById('tab-paste-sess')) {
            SM.createSessionTab('paste-sess', 'paste.example', 'sshdeck');
        }
        SM.activeSessionId = 'paste-sess';
    });

    // Wrap socket.emit to record every ssh_input.
    await page.evaluate(() => {
        window.__sshInputEmits = [];
        const real = window.socket.emit.bind(window.socket);
        window.socket.emit = (ev, payload) => {
            if (ev === 'ssh_input') window.__sshInputEmits.push(payload);
            return real(ev, payload);
        };
    });

    /*
     * Fire a real ClipboardEvent at #mobileInput. There is NO custom paste
     * handler: the pasted text reaches the line through the composer's own
     * diff, exactly like typing. Synthetic ClipboardEvent does not trigger
     * native insertion, so the value is also set to simulate its result.
     *
     * REWRITTEN (Phase 2). This section used to assert that a paste
     * emitted ZERO bytes and that Send delivered the whole text plus CR -- the
     * local-draft model the owner retired. The composer now MIRRORS the
     * session's input line, so a paste is on the line as soon as it lands and
     * Send is the CR that runs it. The multi-line bracketed-paste wrapper is
     * likewise gone from this path: the box holds real newlines, each of which
     * is ESC+CR on the line (Broadcast still wraps, see
     * touch_broadcast_acceptance).
     */
    const PASTE_TEXT = 'kubectl get pods -n production';
    await page.evaluate((text) => {
        const input = document.getElementById('mobileInput');
        // Dispatch a real ClipboardEvent (proves no custom handler emits).
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        input.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
        }));
        // Simulate the native insertion result (synthetic events don't insert).
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, PASTE_TEXT);

    check('§2 paste: the pasted text reaches the line as ONE edit',
        await page.evaluate(() => window.__sshInputEmits.map(e => e.data)),
        [PASTE_TEXT]);
    check('§2 paste: it went to the active session',
        await page.evaluate(() => window.__sshInputEmits[0]?.session_id), 'paste-sess');
    check('§2 paste: no custom handler wrapped it in a bracketed paste',
        await page.evaluate(() =>
            window.__sshInputEmits.some(e => e.data.includes('\x1b[200~'))), false);
    check('§2 paste: draft holds the pasted text (editable)',
        await page.evaluate(() => document.getElementById('mobileInput').value), PASTE_TEXT);

    // Send runs the line the session already holds: the bare CR.
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(60);

    const emits = await page.evaluate(() => window.__sshInputEmits);
    check('§2 paste: Send adds exactly one byte', emits.length, 2);
    check('§2 paste: and it is the run CR', emits[1]?.data, '\r');
    check('§2 paste: draft cleared after commit',
        await page.evaluate(() => document.getElementById('mobileInput').value), '');

    // A multi-line paste: each newline is ESC+CR on the line, in one edit.
    const MULTI = 'line one\nline two\nline three';
    await page.evaluate(() => { window.__sshInputEmits.length = 0; });
    await page.evaluate((text) => {
        const input = document.getElementById('mobileInput');
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, MULTI);
    await page.waitForTimeout(60);
    const emits2 = await page.evaluate(() => window.__sshInputEmits);
    check('§2 paste multi-line: one edit carries the whole paste', emits2.length, 1);
    check('§2 paste multi-line: newlines travel as ESC+CR',
        emits2[0]?.data, MULTI.replace(/\n/g, '\x1b\r'));
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(60);
    check('§2 paste multi-line: Send is still the bare CR',
        await page.evaluate(() => window.__sshInputEmits.at(-1)?.data), '\r');

    check('§2 paste: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §3 — real visualViewport keyboard-OPEN acceptance at 3 named viewports
// ============================================================================
// terminal-manager.js captures initialHeight = window.visualViewport.height at
// load time. Shrinking visualViewport.height below 75% of that value and firing
// a resize event drives the REAL handler: it pins --app-height, toggles
// body.keyboard-open, and normal flex flow anchors the dock to the shrunken shell.
for (const [label, w, h, kbHeight] of [
    ['390×844 phone', 390, 844, 469],          // 469/844 = 0.556 < 0.75
    ['834×1194 iPad portrait', 834, 1194, 600], // 600/1194 = 0.502 < 0.75
    ['1194×834 iPad landscape', 1194, 834, 500], // 500/834 = 0.599 < 0.75
]) {
    const { ctx, page, errors } = await newPage(w, h);
    await page.waitForTimeout(80);

    // Install a real xterm so row-count assertions are meaningful.
    await page.evaluate(() => {
        const grid = document.getElementById('terminalGrid');
        if (!grid) return;
        grid.innerHTML = '';
        const pane = document.createElement('div');
        pane.className = 'terminal-pane';
        pane.dataset.paneIndex = '0';
        const host = document.createElement('div');
        host.className = 'terminal-wrapper';
        host.id = 'kbTerminal';
        pane.appendChild(host);
        grid.appendChild(pane);
        const terminal = new Terminal({ fontSize: 14, lineHeight: 1 });
        const fit = new FitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();
        // Stand in for the per-terminal ResizeObserver that the stubbed
        // TerminalManager normally attaches. Fit from the actual resized wrapper.
        new ResizeObserver(() => fit.fit()).observe(host);
        window.__kbTerminal = terminal;
        window.__kbFit = fit;
    });

    const before = await page.evaluate(() => ({
        rows: window.__kbTerminal ? window.__kbTerminal.rows : null,
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        appHeight: document.documentElement.style.getPropertyValue('--app-height'),
    }));

    check(`${label}: keyboard-open false before shrink`, before.keyboardOpen, false);
    check(`${label}: terminal rows positive before shrink`,
        before.rows !== null && before.rows > 0, true);

    // Shrink the visual viewport the way the soft keyboard does, fire the real
    // resize handler registered by terminal-manager.js at load, then recompute
    // EVERY rect inside the final rAF so layout has settled before measuring.
    const after = await page.evaluate((kbH) => {
        Object.defineProperty(window.visualViewport, 'height', {
            configurable: true, get: () => kbH,
        });
        window.visualViewport.dispatchEvent(new Event('resize'));
        return new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const dock = document.querySelector('.session-bar');
                const composer = document.getElementById('mobileInput');
                const dockCS = dock ? getComputedStyle(dock) : null;
                // Recomputed HERE — inside the final rAF, after layout settles.
                const cr = composer ? composer.getBoundingClientRect() : null;
                const dr = dock ? dock.getBoundingClientRect() : null;
                resolve({
                    keyboardOpen: document.body.classList.contains('keyboard-open'),
                    appHeight: document.documentElement.style.getPropertyValue('--app-height'),
                    dockPos: dockCS ? dockCS.position : null,
                    dockBottom: dr ? dr.bottom : null,
                    composerHeight: cr ? cr.height : null,
                    composerTop: cr ? cr.top : null,
                    composerBottom: cr ? cr.bottom : null,
                    viewportHeight: window.visualViewport.height,   // = kbH (overridden getter)
                    rows: window.__kbTerminal ? window.__kbTerminal.rows : null,
                });
            }));
        });
    }, kbHeight);

    check(`${label}: body.keyboard-open toggled after shrink`, after.keyboardOpen, true);
    check(`${label}: --app-height pinned to shrunk viewport`, after.appHeight, `${kbHeight}px`);
    // Amendment line 93 requires the composer/keypad stack to remain in flex
    // flow. The canonical touch override therefore owns position:relative;
    // containment and the dock's measured bottom edge prove the actual keyboard
    // outcome below. Pinning absolute positioning here was the stale pre-flow
    // mechanism and contradicted the literal v5 contract.
    check(`${label}: dock stays in touch-shell flex flow (position:relative)`,
        after.dockPos, 'relative');
    check(`${label}: composer has nonzero rendered height`, after.composerHeight > 0, true);
    check(`${label}: composer top is on-or-below viewport top (>= 0)`, after.composerTop >= 0, true);
    check(`${label}: composer bottom within shrunken viewport (+1px tol)`,
        after.composerBottom <= after.viewportHeight + 1, true);
    check(`${label}: dock bottom edge within shrunken viewport (+1px tol)`,
        after.dockBottom !== null && after.dockBottom > 0
            && after.dockBottom <= after.viewportHeight + 1, true);
    check(`${label}: terminal rows positive after shrink`, after.rows > 0, true);
    check(`${label}: terminal rows decreased (not hidden)`, after.rows < before.rows, true);

    check(`${label}: no page errors`, errors, []);
    await ctx.close();
}

// ============================================================================
// §4 — constrained-tier visible strings fit their boxes, in every locale.
//      Empty box only: past the cap a scrolling draft legitimately has
//      scrollHeight > clientHeight -- that IS the auto-grow contract.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(844, 390);
    await page.waitForTimeout(80);
    await page.evaluate(() => {
        const SM = SessionManager;
        SM.sessions['locale-sess'] = {
            session_id: 'locale-sess', host: 'l.example', username: 'sshdeck',
            port: 22, authType: 'key', keyId: 'k1', connected: true,
        };
        if (!document.getElementById('tab-locale-sess')) {
            SM.createSessionTab('locale-sess', 'l.example', 'sshdeck');
        }
        SM.activeSessionId = 'locale-sess';
    });

    for (const lang of ['en', 'vi', 'de', 'fr', 'es', 'zh']) {
        const m = await page.evaluate(async (l) => {
            // setLanguage is synchronous, but the placeholder/text writes must
            // reflow before any rect or scrollHeight is read; reset to the true
            // empty resting state or a stale inline height hides a wrap.
            await Promise.resolve(i18n.setLanguage(l));
            const i = document.getElementById('mobileInput');
            i.value = '';
            i.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const help = document.querySelector('.mobile-composer-help');
            const sp = document.createElement('span');
            sp.style.cssText = 'position:absolute;left:-9999px;'
                + 'visibility:hidden;white-space:nowrap;';
            sp.style.font = getComputedStyle(help).font;
            sp.textContent = help.textContent.trim();
            document.body.appendChild(sp);
            const hintW = Math.ceil(sp.getBoundingClientRect().width);
            sp.remove();
            return { value: i.value, scrollH: i.scrollHeight, clientH: i.clientHeight,
                hintW, helpBox: help.clientWidth, hint: help.textContent.trim(),
                ariaLabel: i.getAttribute('aria-label'), placeholder: i.placeholder };
        }, lang);
        check(`§4 ${lang}: the composer is empty at rest`, m.value, '');
        check(`§4 ${lang}: an empty composer does not wrap its placeholder`,
            m.scrollH <= m.clientH, true);
        check(`§4 ${lang}: the hint is not truncated`, m.hintW <= m.helpBox, true);
        check(`§4 ${lang}: the hint still says something`, m.hint.length > 0, true);
        check(`§4 ${lang}: the composer has a localized accessible name`,
            typeof m.ariaLabel === 'string' && m.ariaLabel.length > 0, true);
        check(`§4 ${lang}: the placeholder is localized`, m.placeholder.length > 0, true);
    }
    check('§4: no page errors', errors, []);
    await ctx.close();
}

// ============================================================================
// §5 — draft lifecycle. notifyActiveSessionChanged dispatches on DOCUMENT with
//      {previousSessionId, currentSessionId}; a window dispatch or a
//      {sessionId} detail silently does nothing.
// ============================================================================
{
    const { ctx, page, errors } = await newPage(844, 390);
    await page.waitForTimeout(80);
    const log = await page.evaluate(() => {
        const SM = SessionManager;
        SM.sessions['d1'] = {
            session_id: 'd1', host: 'd1.example', username: 'sshdeck',
            port: 22, authType: 'key', keyId: 'k1', connected: true,
        };
        SM.sessions['d2'] = { ...SM.sessions['d1'], session_id: 'd2' };
        SM.activeSessionId = 'd1';
        const i = document.getElementById('mobileInput');
        const set = v => {
            i.value = v;
            i.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('draft-one');
        const typed = i.value;
        // The composer binds to whatever getActiveSession() reports, so a
        // notify alone is not a switch: move the active id with it, or the
        // target never changes and the draft correctly stays put.
        SM.activeSessionId = 'd2';
        SM.notifyActiveSessionChanged('d1', 'd2');
        const afterSwitch = i.value;
        set('draft-two');
        document.dispatchEvent(new CustomEvent('sshdeck:raw-terminal-focus',
            { detail: { sessionId: 'd2' } }));
        const afterRaw = i.value;
        set('keep-me');
        SM.notifyActiveSessionChanged('d2', 'd2');
        const afterSame = i.value;
        // Switch back: d1's unsent 'draft-one' must return verbatim. This is
        // what proves the text was parked against its own session rather than
        // discarded, and that it never leaked into d2.
        SM.activeSessionId = 'd1';
        SM.notifyActiveSessionChanged('d2', 'd1');
        const restored = i.value;
        return { typed, afterSwitch, afterRaw, afterSame, restored };
    });
    check('§5: the draft holds what was typed', log.typed, 'draft-one');
    /*
     * Group 3 (app.js bindComposerTo) replaced the old clear-the-box behaviour
     * with per-target save/restore: nothing in the box has reached SSH, so the
     * outgoing session's unsent draft stays with THAT session and the incoming
     * session's own draft is shown. The incoming session d2 has never been
     * typed into, so its draft is empty -- the observable value is the same as
     * the old wipe, but the reason matters, and the restore half is asserted
     * below so a regression to a real wipe still fails here.
     */
    check('§5: switching shows the incoming session its own empty draft',
        log.afterSwitch, '');
    check('§5: the outgoing draft was preserved, not destroyed',
        log.restored, 'draft-one');
    check('§5: raw-terminal-focus preserves the unsent draft', log.afterRaw, 'draft-two');
    check('§5: a same-session notify does not fire, so the draft survives',
        log.afterSame, 'keep-me');
    check('§5: no page errors', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
