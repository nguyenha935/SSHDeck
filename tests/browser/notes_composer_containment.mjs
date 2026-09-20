#!/usr/bin/env node
/*
 * G5 / audit §10 F4-a — the NOTES→COMPOSER journey, as a PERMANENT gate.
 *
 * Amendment text (AUDIT_matrix_and_plan.txt:477 and :562):
 *   F4-a "Journey probe on current build (scratch account): open Notes,
 *         type, close sheet mid-composition (iOS profile), tap terminal,
 *         examine composer value + focus timeline; repeat with
 *         panel-close-by-navigate."
 *   G5   "notes_composer_containment.mjs: the F4-a journey as a permanent
 *         gate (composer must not contain note text; focus ends where the
 *         user aimed). NOTE: ... promoted to a gate once defect 4 reproduces
 *         or is refuted; until then it documents the journey only."
 *
 * This file IS that journey, driven on the real app with GENUINE composition
 * events (CDP Input.imeSetComposition — the same trusted-IME channel
 * defect1_ime_ownership_probe.mjs uses), so the iOS-profile shape (a
 * composition still open when the sheet closes) is exercised rather than
 * simulated with synthetic flags.
 *
 * Journeys:
 *   §J1  open Notes → type a composed Vietnamese syllable (composition OPEN)
 *        → close the sheet mid-composition via the sheet's X → tap terminal.
 *   §J2  the same, but the sheet closes by NAVIGATE-exclusion
 *        (sshdeck:aux-panel-opening from the command rail) instead of its X.
 *   §J3  plain typing (no IME): open Notes, type, close mid-word, tap.
 *
 * Asserted on every journey (the G5 contract):
 *   - the composer NEVER contains note text;
 *   - after the final tap, focus ends where the user aimed (the terminal /
 *     composer per the shipped authority rules — never left in a hidden
 *     panel);
 *   - zero page errors.
 *
 * Classification note (F4-b): this gate documents AND asserts the journey on
 * the current build. If every row is green here, defect 4 does not reproduce
 * through these paths; the artifact of this run is the refutation evidence.
 * Run: node tests/browser/notes_composer_containment.mjs   (from source/)
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
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
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
    const noop = () => {};
    window.__socketHandlers = {};
    window.__wire = [];
    window.socket = {
        connected: true,
        id: 'sock-g5-1',
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop,
        emit: (name, payload) => { window.__wire.push({ name, payload }); },
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket, configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const SID = 'G5-1';

// A live session with a REAL attached terminal: the redirectors under test are
// installed by attachTerminal, exactly as in s16_d1_notepad_focus_leak.mjs.
const SEED = `(sid) => {
    SessionManager.sessions[sid] = { id: sid, session_id: sid, host: 'g5.example',
        port: 22, username: 'g5', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: 'G5', connected: true, isPersistentCandidate: false,
        tmuxSessionName: 'sshdeck_g5', terminalId: 'term-' + sid, useTmux: true,
        viaJump: null, latencyMs: null };
    SessionManager.activeSessionId = sid;
    const el = document.createElement('div');
    el.id = 'term-' + sid;
    el.className = 'terminal-wrapper';
    document.getElementById('terminalsContainer').appendChild(el);
    TerminalManager.createTerminal(sid);
    TerminalManager.attachTerminal(sid, 'term-' + sid);
    document.dispatchEvent(new CustomEvent('sshdeck:active-session-changed', {
        detail: { sessionId: sid },
    }));
}`;

async function openPage() {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.evaluate(new Function('return ' + SEED)(), SID);
    await page.waitForTimeout(600);
    return { ctx, page, errors };
}

// Open Notes the way the shipped control does and start a REAL composition in
// the note textarea through CDP (trusted IME frames, as an iOS profile emits).
async function openNotesAndCompose(page, text = 'ghi chusaats') {
    await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        panel.classList.add('mobile-open');
        document.getElementById('sessionNotepad').focus();
        document.body.classList.add('keyboard-open', 'notepad-focused');
    });
    await page.waitForTimeout(80);
    const cdp = await page.context().newCDPSession(page);
    // Leave the syllable MID-COMPOSITION: the last imeSetComposition is never
    // committed — the exact "close sheet mid-composition" shape of F4-a.
    let done = '';
    for (const step of ['g', 'gh', 'ghi', 'ghi c']) {
        await cdp.send('Input.imeSetComposition', {
            text: step, selectionStart: step.length, selectionEnd: step.length,
        });
        await page.waitForTimeout(20);
        done = step;
    }
    return { cdp, committedText: done };
}

const stateOf = (page) => page.evaluate(() => ({
    composer: document.getElementById('mobileInput').value,
    note: document.getElementById('sessionNotepad').value,
    active: document.activeElement
        ? (document.activeElement.id || document.activeElement.className) : null,
    sheetOpen: document.getElementById('notepadPanel').classList.contains('mobile-open'),
}));

// A real tap on the terminal wrapper through CDP touch events.
async function tapTerminal(page) {
    const pt = await page.evaluate((sid) => {
        const w = TerminalManager.terminalContainers[sid];
        const r = w.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, SID);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd', touchPoints: [],
    });
    await cdp.detach();
    await page.waitForTimeout(120);
}

// ── §J1 close the sheet MID-COMPOSITION via its X, then tap the terminal ────
{
    const { ctx, page, errors } = await openPage();
    await openNotesAndCompose(page);
    let s = await stateOf(page);
    check('§J1 setup: composition text sits in the NOTE', s.note, 'ghi c');

    // Close the sheet out from under the OPEN composition (the F4-a act).
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(120);

    // Tap the terminal, as the Owner did right after closing.
    await tapTerminal(page);

    s = await stateOf(page);
    check('§J1 the composer contains no note text',
        s.composer.includes('ghi'), false);
    check('§J1 the composer value stays empty', s.composer, '');
    const focusOk = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const a = document.activeElement;
        const inHiddenPanel = !!(p && a && p.contains(a)
            && getComputedStyle(p).display === 'none');
        return { inHiddenPanel, id: a ? (a.id || a.className) : null };
    });
    check('§J1 focus never rests inside a hidden notes panel',
        focusOk.inHiddenPanel, false);
    // RED BY MEASURED DESIGN on the current build — F4-a probe defect D1
    // (/tmp/s16work/EORD_evidence.txt): while a focused note holds the
    // keyboard, a trusted tap on #notepadCloseBtn blurs the note mid-click;
    // app.js removes .notepad-focused, style.css:5088 display:none's the
    // panel between mousedown and mouseup, and Chromium re-hit-tests mouseup
    // onto <body> — no click reaches the button. F4-b: nothing changed
    // speculatively; this row stays red until D1/D2 are ruled on in the
    // geometry step (G8 territory).
    check('§J1 the sheet is actually closed', s.sheetOpen, false);
    check('§Z no page errors (J1)', errors, []);
    await ctx.close();
}

// ── §J2 the same journey, but the sheet closes BY NAVIGATE ──────────────────
{
    const { ctx, page, errors } = await openPage();
    await openNotesAndCompose(page);
    await page.evaluate(() => {
        // The command-rail exclusion: any aux-panel-opening that is NOT the
        // notepad closes the sheet (app.js sshdeck:aux-panel-opening handler).
        document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening',
            { detail: { panel: 'commands' } }));
    });
    await page.waitForTimeout(120);
    await tapTerminal(page);
    const s2 = await stateOf(page);
    check('§J2 navigate-close: the composer contains no note text',
        s2.composer.includes('ghi'), false);
    check('§J2 navigate-close: the composer value stays empty', s2.composer, '');
    const focusOk2 = await page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        const a = document.activeElement;
        return !!(p && a && p.contains(a)
            && getComputedStyle(p).display === 'none');
    });
    check('§J2 navigate-close: focus never rests in a hidden panel',
        focusOk2, false);
    check('§Z no page errors (J2)', errors, []);
    await ctx.close();
}

// ── §J3 plain typing (no IME): close mid-word, then tap ─────────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        panel.classList.add('mobile-open');
        const n = document.getElementById('sessionNotepad');
        n.focus();
        n.value = 'cong viec hom nay';
        n.dispatchEvent(new Event('input', { bubbles: true }));
        document.body.classList.add('keyboard-open');
    });
    await page.waitForTimeout(60);
    await page.click('#notepadCloseBtn');
    await page.waitForTimeout(100);
    await tapTerminal(page);
    const s3 = await stateOf(page);
    check('§J3 plain typing: the composer contains no note text',
        s3.composer.includes('cong') || s3.composer.includes('viec'), false);
    check('§J3 plain typing: the composer value stays empty', s3.composer, '');
    check('§Z no page errors (J3)', errors, []);
    await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
await new Promise(r => server.close(r));
process.exit(fail === 0 ? 0 : 1);
