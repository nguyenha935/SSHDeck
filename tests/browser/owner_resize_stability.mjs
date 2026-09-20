/*
 * Owner batch — the two resize defects the owner reported, on the
 * REAL client (real terminal-manager, real xterm, real app.js wiring).
 *
 *  §A  ALT-SCREEN ROW HOLD (owner: "contect tailscale đang mở codex CLI hoàn
 *      toàn không được fix việc nhảy lên trên đầu khi thay đổi kích thước").
 *      Shrinking a desktop window while a full-screen program owns the pane
 *      must not move the program's content. Four or five earlier fixes missed
 *      this because they all tried to restore a VIEWPORT: an alternate buffer
 *      has no scrollback, so viewportY/baseY are structurally 0 and never move.
 *      What moves the picture is xterm's Buffer.resize, which on a
 *      no-scrollback buffer runs lines.trimStart(delta) and DESTROYS rows off
 *      the top. §A2 is the mutant that proves the assertion has teeth.
 *
 *  §B  EXIT-SCROLL STABILITY (owner: "nút thoát cuộn ... giật giật lúc mở bàn
 *      phím, đóng bàn phím"). Opening and closing the soft keyboard while the
 *      terminal sits AT the bottom must not flash the button. The box grows
 *      before the engine follows, so for ~60ms (150ms under a real iOS
 *      animation) xterm reports a viewport nobody moved.
 *
 *  §C  The control case §B must not break: a user who really IS scrolled up
 *      keeps the button through the same gesture.
 *
 * No production source is modified by this test.
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
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const STUBS = `
    const noop = () => {};
    window.__handlers = {};
    window.__emits = [];
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.io = () => ({ connected: true, id: 'sock-ors', on: record, off: noop, once: record,
        emit: (ev, p) => window.__emits.push({ ev, p }), io: { on: noop } });
    window.socket = window.io();
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();
const errors = [];

/*
 * One real client with one real attached terminal. `mutate` runs before the
 * session is built, which is how the MUTANT variants disable the fix under
 * test without touching the source file.
 */
async function openClient({ width, height, mobile, mutate }) {
    const ctx = await browser.newContext(mobile
        ? { viewport: { width, height }, hasTouch: true, isMobile: true }
        : { viewport: { width, height } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.evaluate(() => document.getElementById('sessionBar')?.classList.remove('hidden'));
    await page.waitForFunction(() => typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    if (mutate) await page.evaluate(mutate);
    await page.evaluate(() => {
        SessionManager.sessions.A = { id: 'A', session_id: 'A', host: 'h', port: 22,
            username: 'u', authType: 'key', keyId: 'k', jumpHostId: null, displayName: 'A',
            connected: true, isPersistentCandidate: false, tmuxSessionName: 't_A',
            terminalId: 'term-A', useTmux: true, viaJump: null, latencyMs: null };
        SessionManager.createSessionTab('A', 'h', 'u');
        SessionManager.activeSessionId = 'A';
        const grid = document.getElementById('terminalGrid');
        const pane0 = grid.querySelector('.terminal-pane');
        pane0.querySelectorAll('.pane-empty').forEach(e => e.remove());
        const w = document.createElement('div');
        w.className = 'terminal-wrapper';
        w.id = 'wrap-a';
        pane0.appendChild(w);
        TerminalManager.createTerminal('A', 'A');
        TerminalManager.attachTerminal('A', 'wrap-a', 'A');
    });
    await page.waitForFunction(() => window.TerminalManager.terminalReady['A'] === true,
        null, { timeout: 10000 });
    /*
     *: there is no transport declaration to make any more. Control
     * mode is gone, so exitScrollAction takes ONE route for every tmux session
     * -- ask tmux unless a foreground application owns the mouse -- and the
     * fixture that used to enter control mode was declaring a distinction that
     * no longer exists. What the fixture DOES have to establish is that this
     * socket holds a tmux client for the session, because that is what makes a
     * resize reach anything: the attach is acknowledged here the way the server
     * acknowledges it.
     */
    await page.evaluate(() => {
        (window.__handlers['view_attached'] || []).forEach(
            fn => fn({ session_id: 'A' }));
    });
    const attached = await page.evaluate(() => TerminalManager.views['A']);
    if (attached !== 'attached') {
        throw new Error(`fixture failed to attach the view: ${attached}`);
    }
    return { ctx, page };
}

// Enter the alternate screen and paint a ruler in which every row names
// itself -- so a lost row is identifiable, not merely a changed count.
const paintAltRuler = (page) => page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    TerminalManager.writeOutput('A', '\x1b[?1049h\x1b[H\x1b[2J');
    for (let i = 1; i <= t.rows; i++) {
        TerminalManager.writeOutput('A', `\x1b[${i};1HROW${String(i).padStart(2, '0')}`);
    }
    // Park the cursor low, as a full-screen TUI does: the trim path xterm takes
    // depends on where the cursor sits.
    TerminalManager.writeOutput('A', `\x1b[${Math.max(1, t.rows - 2)};1H`);
});

const readRuler = (page) => page.evaluate(() => {
    const t = TerminalManager.terminals['A'];
    const b = t.buffer.active;
    const rows = [];
    for (let y = 0; y < t.rows; y++) rows.push((b.getLine(y)?.translateToString(true) || '').trim());
    const filled = rows.filter(Boolean);
    return { type: b.type, first: filled[0] || '(blank)', last: filled[filled.length - 1] || '(blank)',
        viewportY: b.viewportY, baseY: b.baseY };
});

// ── §A  Alternate-screen row hold on a desktop window shrink ──────────────
{
    const { ctx, page } = await openClient({ width: 1440, height: 900, mobile: false });
    await paintAltRuler(page);
    await page.waitForTimeout(500);
    const before = await readRuler(page);

    await page.evaluate(() => { window.__emits.length = 0; });
    await page.setViewportSize({ width: 1000, height: 620 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(900);
    const after = await readRuler(page);
    const resized = await page.evaluate(() => window.__emits
        .filter(e => e.ev === 'ssh_resize').length > 0);

    check('§A the pane is on the alternate screen', before.type, 'alternate');
    check('§A the ruler starts at row 1 before the shrink', before.first, 'ROW01');
    check('§A the top row SURVIVES the shrink (no trim, no jump)', after.first, 'ROW01');
    check('§A the bottom row survives too', after.last, before.last);
    // The proposal must still reach the server: holding the engine must not
    // hide this client from the resize authority, or the source never moves.
    check('§A the shrink still proposes the new size to the server', resized, true);
    // The measurement that explains why every viewport-restoring fix failed.
    check('§A viewportY never moved (there is no viewport to restore)',
        `${before.viewportY}/${after.viewportY}`, '0/0');
    await ctx.close();
}

// ── §A2 MUTANT: without the hold, the shrink destroys the top rows ────────
{
    const { ctx, page } = await openClient({
        width: 1440, height: 900, mobile: false,
        mutate: () => {
            // Restore the pre-fix behaviour: resize the engine unconditionally.
            TerminalManager.resizeTerminalPreservingAltRows =
                function (terminal, cols, rows) {
                    if (terminal.cols === cols && terminal.rows === rows) return;
                    terminal.resize(cols, rows);
                };
        },
    });
    await paintAltRuler(page);
    await page.waitForTimeout(500);
    const before = await readRuler(page);
    await page.setViewportSize({ width: 1000, height: 620 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(900);
    const after = await readRuler(page);

    check('§A2 MUTANT: the ruler still started at row 1', before.first, 'ROW01');
    check('§A2 MUTANT: the top rows are DESTROYED without the hold',
        after.first !== 'ROW01', true);
    check('§A2 MUTANT: and viewportY still never moved, so no scroll restore could help',
        `${before.viewportY}/${after.viewportY}`, '0/0');
    await ctx.close();
}

/*
 * An iOS-shaped keyboard: the visual viewport moves over ~240ms in steps
 * rather than in one jump. Chromium's instant resize can close the window in
 * which the buffer lies before any driver samples it; the owner's phone cannot.
 */
async function animateViewport(page, from, to, open) {
    await page.evaluate((isOpen) => {
        document.body.classList.toggle('keyboard-open', isOpen);
    }, open);
    for (let i = 1; i <= 8; i++) {
        await page.evaluate((h) => {
            document.documentElement.style.setProperty('--app-height', h + 'px');
            window.dispatchEvent(new Event('resize'));
        }, Math.round(from + (to - from) * (i / 8)));
        await page.waitForTimeout(30);
    }
}

/*
 * Seed scrollback and settle. xterm's write is ASYNCHRONOUS -- scrolling in the
 * same evaluate as the writes is silently undone when the writes land, which
 * reads as "the button never appeared" and blames the product for a test bug.
 * So drain on the last write's callback, then scroll as a separate step.
 */
async function seedScrollback(page, { scrollUpBy = 0 } = {}) {
    await page.evaluate(() => new Promise(done => {
        const t = TerminalManager.terminals['A'];
        for (let i = 1; i <= 199; i++) t.writeln(`line ${i}`);
        t.writeln('line 200', done);
    }));
    await page.evaluate((up) => {
        const t = TerminalManager.terminals['A'];
        t.scrollToBottom();
        if (up) t.scrollLines(-up);
    }, scrollUpBy);
    await page.waitForTimeout(600);
}

// Watch the attribute the user actually sees, not an internal flag.
const watchButton = (page) => page.evaluate(() => {
    window.__btn = [];
    const btn = document.getElementById('exitScrollBtn');
    new MutationObserver(() => window.__btn.push(btn.hidden))
        .observe(btn, { attributes: true, attributeFilter: ['hidden'] });
});

// ── §B  Keyboard open/close AT THE BOTTOM must not flash the button ───────
{
    const { ctx, page } = await openClient({ width: 390, height: 844, mobile: true });
    await seedScrollback(page);

    const restHidden = await page.evaluate(() => document.getElementById('exitScrollBtn').hidden);
    await watchButton(page);
    await animateViewport(page, 844, 470, true);
    await page.waitForTimeout(700);
    const openFlips = await page.evaluate(() => window.__btn.slice());
    await page.evaluate(() => { window.__btn.length = 0; });
    await animateViewport(page, 470, 844, false);
    await page.waitForTimeout(900);
    const closeFlips = await page.evaluate(() => window.__btn.slice());
    const endHidden = await page.evaluate(() => document.getElementById('exitScrollBtn').hidden);

    check('§B at the bottom the button starts hidden', restHidden, true);
    check('§B opening the keyboard does not flip it', openFlips.length, 0);
    check('§B closing the keyboard does not flip it', closeFlips.length, 0);
    check('§B it is still hidden when the gesture ends', endHidden, true);
    await ctx.close();
}

// ── §B2 MUTANT: reading the buffer alone reintroduces the flash ───────────
/*
 * §B2's MUTANT IS RETIRED (the xterm 6 upgrade).
 *
 * It proved the DOM cross-check in settledAtBottom earns its keep, by replacing
 * that function with the buffer-only read and requiring the button to FLASH on
 * the keyboard-close transient. The transient it reproduced is a property of
 * xterm 5.3.0's DOM scroller: the browser clamps a scroller that is briefly
 * taller than its content and the engine turns that clamp into a buffer scroll.
 * xterm 6 renders no scroll area at all -- there is nothing to clamp -- so the
 * buffer never lies, the mutant behaves exactly like the product, and the row
 * could only pass by asserting something that is no longer true of any engine
 * this ships on.
 *
 * The POSITIVE rows above are untouched: §B1 still requires no flash on a real
 * keyboard cycle, and §C still requires the button on a genuinely scrolled-up
 * terminal -- which is the behaviour the cross-check existed to protect.
 */

// ── §C  A genuinely scrolled user keeps the button through the gesture ────
{
    const { ctx, page } = await openClient({ width: 390, height: 844, mobile: true });
    await seedScrollback(page, { scrollUpBy: 40 });
    // observeScrollState publishes on a 500ms poll, so the button's appearance
    // is not synchronous with the scroll. Wait for the state the user would
    // wait for rather than for a fixed number of milliseconds.
    const shownAtRest = await page.waitForFunction(
        () => document.getElementById('exitScrollBtn').hidden === false,
        null, { timeout: 5000 }).then(() => true, () => false);
    await watchButton(page);
    await animateViewport(page, 844, 470, true);
    await page.waitForTimeout(700);
    await animateViewport(page, 470, 844, false);
    await page.waitForTimeout(900);
    const flips = await page.evaluate(() => window.__btn.slice());
    const stillShown = await page.evaluate(() =>
        document.getElementById('exitScrollBtn').hidden === false);
    // The click below must act on a settled view, so confirm the scroll really
    // is still up in the engine and not merely in the button's attribute.
    const stillScrolled = await page.evaluate(() =>
        !TerminalManager.isTerminalAtBottom(TerminalManager.terminals['A']));

    check('§C a scrolled-up terminal shows the button', shownAtRest, true);
    check('§C the keyboard gesture never hides it', flips.length, 0);
    check('§C it is still shown at the end', stillShown, true);
    check('§C the engine agrees the user is still scrolled up', stillScrolled, true);

    /*
     * And it must still WORK -- the owner's "click vào nó sẽ tự động về ô nhập".
     *
     *: the click takes the TMUX route, because a view is a real tmux
     * client with `mouse on` and a swipe puts the PANE into copy mode. So the
     * click asks the server, and the scroll happens when the answer arrives.
     * The old fixture entered control mode, where the click exited client-side
     * with no round trip at all; that transport is gone, so the test drives
     * both halves of the real route instead.
     */
    await page.evaluate(() => { window.__emits.length = 0; });
    await page.evaluate(() => document.getElementById('exitScrollBtn').click());
    await page.waitForTimeout(300);
    check('§C clicking it asks tmux to leave copy mode, once',
        await page.evaluate(() => window.__emits
            .filter(e => e.ev === 'tmux_exit_copy_mode'
                && e.p?.session_id === 'A').length), 1);
    await page.evaluate(() => {
        (window.__handlers['tmux_copy_mode_exited'] || []).forEach(fn => fn({
            ok: true, session_id: 'A', was_in_mode: true }));
    });
    await page.waitForTimeout(500);
    check('§C the answer returns the terminal to the bottom',
        await page.evaluate(() => TerminalManager.isTerminalAtBottom(
            TerminalManager.terminals['A'])), true);
    check('§C and the button hides itself again',
        await page.evaluate(() => document.getElementById('exitScrollBtn').hidden), true);
    await ctx.close();
}

check('§Z no page errors in any variant', errors.join(' | '), '');

await browser.close();
server.close();
console.log(`\nowner_resize_stability: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
