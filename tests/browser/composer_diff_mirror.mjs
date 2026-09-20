#!/usr/bin/env node
/*
 * The COMPOSER AS A MIRROR of the terminal's input line (owner decision
 *; Phase 2 of the tmux-views rewrite). Replaces
 * hybrid_composer_input.mjs, whose model (classifier, immutable streamed
 * prefix, taint, local-only paste) the owner retired.
 *
 * The contract: whatever is in the box is on the active session's line, and
 * every settled edit is turned into the bytes that make that true -- one DEL
 * per grapheme cluster for what changed, then the new tail. Nothing streams
 * DURING an IME composition; the settled syllable streams at compositionend.
 * A newline in the box is ESC+CR; Send is the CR. Backspace on an empty box
 * is a raw DEL. Broadcast makes the box a local draft for Send-all.
 *
 * Real browser, production template and JS; only the socket is a recorder.
 * Typing goes through page.keyboard so the events are trusted; the IME is
 * driven with CDP Input.imeSetComposition, which makes Chromium raise real
 * composition events with isComposing set.
 *
 * Sections:
 *   §1  typing streams the typed characters, one edit at a time
 *   §2  an edit in the middle: DELs back to the common prefix, then the tail
 *   §3  Backspace on an empty box is one raw DEL
 *   §4  Enter is ESC+CR; Send is CR, clears the box and the mirror
 *   §5  Telex: zero bytes while composing, the settled syllable once, one DEL
 *       erases one cluster
 *   §6  paste and a whole-selection replacement are just edits
 *   §7  a Command Library insert (synthetic input event) streams
 *   §8  per-session boxes across a switch; bytes never cross
 *   §9  Broadcast: local draft, Send-all through sendAll, a bracketed paste
 *       for a multi-line draft, refused while the mirror is non-empty
 *   §10 reverse sync: an empty box on bind asks for the line and adopts the
 *       text after the prompt, and the next edit diffs against it
 *   §11 a session that cannot be written to gets no bytes and Send refuses
 *   §12 the keypad ^U clears the line and the box together
 *   §Z  zero page errors
 *
 * Run: node tests/browser/composer_diff_mirror.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`); }
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
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
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
    window.__emits = [];
    window.__handlers = {};
    const record = (ev, fn) => {
        (window.__handlers[ev] = window.__handlers[ev] || []).push(fn);
    };
    window.socket = {
        connected: true, on: record, off: noop, once: record, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
    };
    window.io = () => window.socket;
    window.__server = (ev, payload) => {
        for (const fn of (window.__handlers[ev] || [])) fn(payload);
    };
    window.__notes = [];
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function newPage() {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
        permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (/Failed to load resource/i.test(m.text())) return;
        errors.push(`console: ${m.text()}`);
    });
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
        window.__emits = [];
        const realNote = window.showNotification;
        window.showNotification = (msg, kind, duration) => {
            window.__notes.push({ msg, kind });
            return realNote?.(msg, kind, duration);
        };
        window.socket.emit = (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            if (typeof ack === 'function') ack({ success: true });
        };
    });
    await page.waitForTimeout(50);
    return { ctx, page, errors };
}

async function seedSession(page, id, opts = {}) {
    await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = {
            id, session_id: id, host: opts.host || 'host.example', port: 22,
            username: 'sshdeck', authType: 'key', keyId: 'k1', jumpHostId: null,
            displayName: 'Prod DB',
            connected: opts.connected !== undefined ? opts.connected : true,
            isPersistentCandidate: opts.candidate === true,
            tmuxSessionName: opts.tmux ? `sshdeck_${id}` : null,
            terminalId: `term-${id}`, useTmux: !!opts.tmux, viaJump: null,
        };
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, opts.host || 'host.example', 'sshdeck');
        }
    }, { id, opts });
}
// The app's own switch signal, as setActivePane raises it.
async function activate(page, id) {
    await page.evaluate((id) => {
        SessionManager.activeSessionId = id;
        document.dispatchEvent(new CustomEvent('sshdeck:active-session-changed',
            { detail: { sessionId: id } }));
    }, id);
    await page.waitForTimeout(40);
}
const inputs = page => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'ssh_input')
    .map(e => ({ to: e.payload.session_id, data: e.payload.data })));
const emitsOf = (page, ev) => page.evaluate(
    e => window.__emits.filter(x => x.ev === e).map(x => x.payload), ev);
const clearEmits = page => page.evaluate(() => { window.__emits = []; });
const box = page => page.inputValue('#mobileInput');
async function focusComposer(page) {
    await page.click('#mobileInput');
    await page.waitForTimeout(30);
}
const DEL = '\x7f';

// ── §1 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §1 typing streams the typed characters ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await clearEmits(page);
    await page.keyboard.type('ls');
    await page.waitForTimeout(60);
    check('§1 each keystroke streamed once, in order', await inputs(page),
        [{ to: 'live', data: 'l' }, { to: 'live', data: 's' }]);
    check('§1 the box shows the line', await box(page), 'ls');
    check('§1 the mirror length follows',
        await page.evaluate(() => window.__composerMirrorLen()), 2);
    check('§1 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §2 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §2 an edit in the middle ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await page.keyboard.type('abc');
    await page.waitForTimeout(60);
    await clearEmits(page);
    await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.setSelectionRange(1, 1);
    });
    await page.keyboard.type('X');
    await page.waitForTimeout(60);
    check('§2 box', await box(page), 'aXbc');
    check('§2 bytes: DEL DEL then the new tail', await inputs(page),
        [{ to: 'live', data: `${DEL}${DEL}Xbc` }]);
    await clearEmits(page);
    // Deleting in the middle is the same rule.
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§2 box after a mid-line Backspace', await box(page), 'abc');
    check('§2 bytes: DEL x3 then "bc"', await inputs(page),
        [{ to: 'live', data: `${DEL}${DEL}${DEL}bc` }]);
    check('§2 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §3 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §3 Backspace on an empty box ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await clearEmits(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§3 one raw DEL per press', await inputs(page),
        [{ to: 'live', data: DEL }, { to: 'live', data: DEL }]);
    check('§3 the box stays empty', await box(page), '');
    check('§3 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §4 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §4 Enter is ESC+CR; Send is CR ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await page.keyboard.type('one');
    await page.waitForTimeout(40);
    await clearEmits(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(60);
    check('§4 Enter put a newline in the box', await box(page), 'one\n');
    check('§4 and ESC+CR on the line', await inputs(page),
        [{ to: 'live', data: '\x1b\r' }]);
    await page.keyboard.type('two');
    await page.waitForTimeout(40);
    await clearEmits(page);
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(60);
    check('§4 Send is the bare CR', await inputs(page), [{ to: 'live', data: '\r' }]);
    check('§4 the box cleared', await box(page), '');
    check('§4 the mirror cleared',
        await page.evaluate(() => window.__composerMirrorLen()), 0);
    await clearEmits(page);
    await page.keyboard.type('w');
    await page.waitForTimeout(40);
    check('§4 the next line starts fresh', await inputs(page), [{ to: 'live', data: 'w' }]);
    await clearEmits(page);
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(40);
    check('§4 Ctrl+Enter is Send', await inputs(page), [{ to: 'live', data: '\r' }]);
    check('§4 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §5 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §5 Telex: nothing while composing, the syllable once ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await clearEmits(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ti', selectionStart: 2, selectionEnd: 2 });
    await page.waitForTimeout(30);
    await cdp.send('Input.imeSetComposition', { text: 'tiê', selectionStart: 3, selectionEnd: 3 });
    await page.waitForTimeout(30);
    check('§5 mid-composition: zero bytes', await inputs(page), []);
    await cdp.send('Input.insertText', { text: 'tiến' });
    await page.waitForTimeout(80);
    check('§5 the settled syllable streamed once, NFC', await inputs(page),
        [{ to: 'live', data: 'tiến'.normalize('NFC') }]);
    check('§5 box', await box(page), 'tiến');
    await clearEmits(page);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§5 one Backspace erases one cluster: one DEL', await inputs(page),
        [{ to: 'live', data: DEL }]);
    check('§5 box after the Backspace', await box(page), 'tiế');
    check('§5 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §6 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §6 paste and replacement are edits ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await page.keyboard.type('ab');
    await page.waitForTimeout(40);
    await clearEmits(page);
    await page.evaluate(() => navigator.clipboard.writeText('CD'));
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(80);
    check('§6 paste streamed as the appended tail', await inputs(page),
        [{ to: 'live', data: 'CD' }]);
    await clearEmits(page);
    // Select everything the way a long-press "Select all" does, then type
    // over it: the browser replaces the selection in one input event.
    await page.evaluate(() => document.getElementById('mobileInput').select());
    await page.keyboard.insertText('zz');
    await page.waitForTimeout(60);
    check('§6 replacing the selection: DEL x4 then "zz"', await inputs(page),
        [{ to: 'live', data: `${DEL}${DEL}${DEL}${DEL}zz` }]);
    check('§6 box', await box(page), 'zz');
    check('§6 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §7 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §7 a Command Library insert streams ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await clearEmits(page);
    await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.value = 'docker ps';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(60);
    check('§7 the inserted text is on the line', await inputs(page),
        [{ to: 'live', data: 'docker ps' }]);
    check('§7 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §8 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §8 per-session boxes across a switch ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'A');
    await seedSession(page, 'B');
    await activate(page, 'A');
    await focusComposer(page);
    await page.keyboard.type('for-a');
    await page.waitForTimeout(40);
    await activate(page, 'B');
    check('§8 B starts empty', await box(page), '');
    await clearEmits(page);
    await focusComposer(page);
    await page.keyboard.type('b1');
    await page.waitForTimeout(40);
    check('§8 B typing goes to B only',
        (await inputs(page)).every(i => i.to === 'B'), true);
    await activate(page, 'A');
    check("§8 back on A the box shows A's line", await box(page), 'for-a');
    await clearEmits(page);
    await focusComposer(page);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.waitForTimeout(40);
    check('§8 the diff continues against A\'s mirror', await inputs(page),
        [{ to: 'A', data: '!' }]);
    check('§8 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §9 ───────────────────────────────────────────────────────────────────────
console.log('\n--- §9 Broadcast ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'A');
    await seedSession(page, 'B');
    await activate(page, 'A');
    await focusComposer(page);
    await page.keyboard.type('x');
    await page.waitForTimeout(40);
    await clearEmits(page);
    // Opening Broadcast with text in the box RETRACTS what the mirror put on
    // the active session's line -- the box is a local draft from here, and
    // that session must not receive the same text twice.
    await page.evaluate(() => {
        BroadcastInput.show();
        document.dispatchEvent(new CustomEvent('sshdeck:broadcast-changed',
            { detail: { active: true, count: 2, total: 2, allMode: true } }));
    });
    await page.waitForTimeout(60);
    check('§9 Broadcast opens', await page.evaluate(() => BroadcastInput.open === true), true);
    check('§9 and the mirror is retracted', await inputs(page), [{ to: 'A', data: DEL }]);
    check('§9 the box keeps the text', await box(page), 'x');
    await page.evaluate(() => {
        const el = document.getElementById('mobileInput');
        el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    /*
     * THE FAN-OUT IS NOT A COMPOSER PATH: "Bật Broadcast
     * thì ấn gửi là gửi thẳng lệnh chạy luôn, bỏ qua ô nhập của terminal
     * luôn." So this is measured through the REAL BroadcastInput.sendAll, not
     * a stub: Send puts the whole text plus the run CR on EVERY selected
     * session at once, and the composer's own diff never touches the line.
     */
    await clearEmits(page);
    await focusComposer(page);
    await page.keyboard.type('uptime');
    await page.waitForTimeout(60);
    check('§9 typing under Broadcast streams nothing', await inputs(page), []);
    check('§9 the box holds the draft', await box(page), 'uptime');
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(60);
    check('§9 Send runs the command on every selected session, once each',
        await inputs(page),
        [{ to: 'A', data: 'uptime\r' }, { to: 'B', data: 'uptime\r' }]);
    check('§9 the box cleared', await box(page), '');

    // A multi-line draft travels as ONE bracketed paste, so the shell runs its
    // lines in order rather than treating the newlines as edits.
    await clearEmits(page);
    await focusComposer(page);
    await page.keyboard.type('up');
    await page.keyboard.press('Enter');
    await page.keyboard.type('down');
    await page.waitForTimeout(60);
    check('§9 a multi-line draft still streams nothing', await inputs(page), []);
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(60);
    check('§9 Send-all: one bracketed paste per session, with the run CR',
        await inputs(page), [
            { to: 'A', data: '\x1b[200~up\rdown\x1b[201~\r' },
            { to: 'B', data: '\x1b[200~up\rdown\x1b[201~\r' },
        ]);

    await focusComposer(page);
    await page.keyboard.type('kept');
    await page.waitForTimeout(40);
    await page.evaluate(() => {
        BroadcastInput.hide ? BroadcastInput.hide() : (BroadcastInput.open = false);
        document.dispatchEvent(new CustomEvent('sshdeck:broadcast-changed',
            { detail: { active: false, count: 0, total: 2, allMode: true } }));
    });
    await page.waitForTimeout(40);
    check('§9 Broadcast off keeps the box', await box(page), 'kept');
    await clearEmits(page);
    await page.keyboard.type('!');
    await page.waitForTimeout(60);
    check('§9 the next edit streams the whole box to the active session',
        await inputs(page), [{ to: 'A', data: 'kept!' }]);
    check('§9 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §10 ──────────────────────────────────────────────────────────────────────
console.log('\n--- §10 reverse sync ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'T', { tmux: true });
    await clearEmits(page);
    await activate(page, 'T');
    check('§10 an empty box on bind asks for the line',
        await emitsOf(page, 'get_terminal_line'), [{ session_id: 'T' }]);
    await page.evaluate(() => window.__server('terminal_line_data', {
        session_id: 'T', line: 'root@tiny-server:~# echo tiến', cursor_x: 29, cursor_y: 3,
    }));
    await page.waitForTimeout(40);
    check('§10 the text after the prompt is adopted', await box(page), 'echo tiến');
    check('§10 and is the mirror',
        await page.evaluate(() => window.__composerMirrorLen()), 9);
    await clearEmits(page);
    await focusComposer(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§10 the next edit diffs against the adopted line', await inputs(page),
        [{ to: 'T', data: DEL }]);
    check('§10 box', await box(page), 'echo tiế');
    // A line the server cannot read leaves the box alone.
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(40);
    await clearEmits(page);
    await page.evaluate(() => window.__server('terminal_line_unavailable',
        { session_id: 'T', reason: 'alternate screen' }));
    check('§10 unavailable: the box stays empty', await box(page), '');
    check('§10 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §11 ──────────────────────────────────────────────────────────────────────
console.log('\n--- §11 a session that cannot be written to ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'dead', { connected: false, candidate: true });
    await activate(page, 'dead');
    await focusComposer(page);
    await clearEmits(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§11 no bytes for a candidate', await inputs(page), []);
    check('§11 the box keeps the local draft', await box(page), 'ab');
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(40);
    check('§11 Send refuses', await inputs(page), []);
    check('§11 and says so',
        await page.evaluate(() => window.__notes.some(n => n.kind === 'warning')), true);
    check('§11 no errors', errors.join(' | '), '');
    await ctx.close();
}

// ── §12 ──────────────────────────────────────────────────────────────────────
/*
 * A ^U from ANY route kills the line the box mirrors, so the box and the
 * mirror empty with it. The keypad carries no ^U key of its own -- the v5
 * mockup fixes its two pages at eight keys each, and page 2's last slot is
 * Del -- so the route measured here is the sticky Ctrl, which is what a
 * physical keyboard and any future control-byte caller reach.
 */
console.log('\n--- §12 a line-kill empties the box with the line ---');
{
    const { ctx, page, errors } = await newPage();
    await seedSession(page, 'live');
    await activate(page, 'live');
    await focusComposer(page);
    await page.keyboard.type('half a line');
    await page.waitForTimeout(40);
    await clearEmits(page);
    await page.evaluate(() => {
        document.getElementById('mobileKeypadBtn').click();
        document.querySelector('.keypad-key[data-keypad-modifier="ctrl"]').click();
        const el = document.getElementById('mobileInput');
        el.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', data: 'u', bubbles: true, cancelable: true,
        }));
    });
    await page.waitForTimeout(40);
    check('§12 ^U on the wire', await inputs(page), [{ to: 'live', data: '\x15' }]);
    check('§12 the box emptied with the line', await box(page), '');
    check('§12 the mirror emptied',
        await page.evaluate(() => window.__composerMirrorLen()), 0);
    check('§12 no errors', errors.join(' | '), '');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
