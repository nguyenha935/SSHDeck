/*
 * The Command Library rail, measured against production markup.
 *
 * The Library used to be a section of #commandWorkspaceModal -- a blocking
 * xlarge dialog that hid the terminal -- and clicking a command called
 * executeCommand, which emitted ssh_input immediately while the notification
 * claimed it had merely been "inserted". Both are gone: the Library is now
 * #commandRail, a non-blocking auxiliary panel (right rail on a fine-pointer
 * desktop, Note-like bottom sheet on every touch shell), and a click inserts
 * into the local composer draft at the caret.
 *
 * The rules this file follows are the ones earlier false-greens in this project
 * established:
 *   1. Read the production template; never rebuild the markup. A hand-written
 *      fixture drifts from index.html silently and stays green.
 *   2. Assert on post-layout measurements, not on the presence of a class or a
 *      rule. "the sheet is 45dvh" in the stylesheet says nothing about what the
 *      terminal measures once the grid track is involved.
 *   3. Prove a negative with a recorded side-effect spy, not with an absence of
 *      symptoms: every socket emit is captured, so "inserting does not run the
 *      command" is a count, not an impression.
 *
 * Sections:
 *   §1  insert-at-caret and paste stage the draft and emit ZERO ssh_input;
 *       only Send and Ctrl/Cmd+Enter commit.
 *   §2  touch open: no Search focus, no keyboard, draft preserved.
 *   §3  F1 toggles from composer focus; Escape from xterm never closes the
 *       rail; two-way Notepad/Command exclusion; the closed rail is
 *       aria-hidden + inert and not focus reachable.
 *   §4  geometry: desktop right-hand auxiliary panel with a live terminal,
 *       desktop composer visible only while open, open/close restores
 *       geometry, and both auxiliary drags save a non-zero shared width.
 *   §5  touch tiers (768x1024, 1024x768, phone portrait/landscape): bottom
 *       sheet, zero terminal-width loss, composer + lifecycle toolbar present
 *       and operable, card list without horizontal overflow, 44px targets,
 *       plus the sheet-geometry contract -- pre-scroll elementFromPoint on the
 *       first card's Insert, a one-card-tall scroller, contained 44px OS
 *       filters, no help block, at least a third of visible terminal context,
 *       and vertical wrapped cards outside the documented max-height:500px
 *       compact exception.
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

function atLeast(label, actual, floor, unit = '') {
    const ok = typeof actual === 'number' && actual >= floor;
    if (ok) {
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

// Every context this run opens, so the finally block can close them even when a
// section throws mid-way. Playwright would otherwise leave the browser and the
// HTTP server alive and the process would hang instead of reporting.
const openContexts = [];

/*
 * addInitScript runs BEFORE the production scripts, so anything they assign at
 * the end of their own file (TerminalManager, i18n) replaces what is stubbed
 * here. isTouchShell is therefore NOT forced: the real capability query decides,
 * which is exactly what these tiers are testing (hasTouch contexts land on the
 * coarse branch, non-touch contexts on the fine branch).
 */
const STUBS = `
    const noop = () => {};
    window.__emits = [];
    window.socket = {
        on: noop, off: noop, once: noop, io: { on: noop },
        emit: (ev, payload) => { window.__emits.push({ ev, payload }); },
    };
    window.showNotification = noop;
    window.ModalManager = {
        open: (m) => m && m.classList.add('show'),
        close: (m) => m && m.classList.remove('show'),
    };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

async function newPage(w, h, { touch = false } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch,
        isMobile: touch,
    });
    openContexts.push(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    // The session bar (and with it the composer dock) ships hidden until a
    // session exists; production removes .hidden in showSessionBar.
    await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
    });
    await page.waitForTimeout(50);
    /*
     * app.js:15 assigns window.socket = io(...) at load, replacing anything the
     * init script staged. The emit spy therefore has to be installed AFTER load,
     * by wrapping whatever object production ended up with -- exactly the
     * pattern session_actions.mjs uses. Wrapping (not replacing) keeps every
     * other socket method intact.
     */
    await page.evaluate(() => {
        window.__emits = [];
        const real = window.socket?.emit?.bind(window.socket);
        window.socket.emit = (ev, payload, ack) => {
            window.__emits.push({ ev, payload });
            // Never reach the network: there is no server behind this fixture.
            if (typeof ack === 'function') ack({ success: true });
        };
        void real;
    });
    return { ctx, page, errors };
}

// A real session in the production store, so getActiveSession() is truthy and
// the lifecycle toolbar has something to act on.
async function seedSession(page, id = 's1', opts = {}) {
    await page.evaluate(({ id, opts }) => {
        SessionManager.sessions[id] = {
            id, session_id: id,
            host: opts.host || 'host.example', port: 22,
            username: 'sshdeck', authType: 'key', keyId: 'k1',
            jumpHostId: null, displayName: opts.displayName || 'Prod DB',
            connected: opts.connected !== undefined ? opts.connected : true,
            isPersistentCandidate: false, tmuxSessionName: null,
            terminalId: `term-${id}`, useTmux: false, viaJump: null,
        };
        if (!document.getElementById(`tab-${id}`)) {
            SessionManager.createSessionTab(id, opts.host || 'host.example', 'sshdeck');
        }
        SessionManager.activeSessionId = id;
    }, { id, opts });
}

// Two commands through the real setCommands -> renderCommandsList path, so the
// cards under test are the ones production builds.
async function seedCommands(page) {
    await page.evaluate(() => {
        CommandLibrary.setCommands([
            {
                id: 'c1', name: 'Disk usage', command: 'df -h',
                parameters: '', description: 'Show free space',
                os: ['linux'], category: 'system', isSystem: false,
            },
            {
                id: 'c2',
                name: 'Very long pipeline that would overflow a narrow rail',
                command: 'journalctl -u nginx.service --since "2026-08-01 00:00:00" --no-pager | grep -Ei "error|warn" | tail -n 200',
                parameters: '--follow --output=short-precise',
                description: 'A deliberately long command, to prove wrapping',
                os: ['linux', 'macos'], category: 'logs', isSystem: false,
            },
        ]);
    });
    await page.waitForTimeout(50);
}

const inputEmits = page => page.evaluate(
    () => window.__emits.filter(e => e.ev === 'ssh_input'));

/*
 * The real fine-pointer entry path to the Library opener, as of H2.
 *
 * v5's desktop header is exactly four elements (mockup lines 66-72) and has no
 * room for a Library opener; Entry 39: it left the account
 * menu, which is closed until its trigger is pressed. Clicking the opener
 * therefore needs the menu opened first -- with a REAL click on
 * #accountBtnHeader, never a force-click and never a JS .click() that would
 * bypass the very visibility this proves.
 *
 * Idempotent by construction: the account trigger is a toggle, so an already
 * open menu is left alone rather than shut.
 */
async function clickRailOpener(page) {
    // Entry 39: the header Lệnh button is the one canonical
    // desktop rail opener since the account-menu item became Transfer Files.
    await page.click('#commandLibraryBtn');
}

/*
 * Open the per-chip lifecycle sheet (amendment section 3 line 56: re-tap or
 * long-press). Idempotent: the gesture is a TOGGLE, so re-tapping an already
 * open sheet would close it again -- a trap that made an earlier suite report
 * "the sheet did not open" when it had in fact opened and shut.
 */
async function openLifecycleSheet(page, sessionId) {
    const already = await page.evaluate(() => {
        const s = document.getElementById('sessionActionsSheet');
        return !!s && !s.hidden;
    });
    if (already) return true;
    await page.click(`#tab-${sessionId}`);
    await page.waitForTimeout(80);
    return await page.evaluate(() => {
        const s = document.getElementById('sessionActionsSheet');
        return !!s && !s.hidden;
    });
}

// ---------------------------------------------------------------------------
// §1  Insertion stages the draft. Nothing runs until an explicit commit.
// ---------------------------------------------------------------------------
try {

console.log('\n--- §1 insert and paste stage the draft; only Send / Ctrl+Enter commits ---');
{
    /*
     * These are COMPOSER semantics, so they must run on a shell that has a
     * composer. v5 section 5 invariant 5 forbids any visible composer on
     * fine-pointer desktop in its normal state, and insertCommand branches on
     * exactly that (command-library.js:453): `useSharedComposer` is
     * isTouchShell() || Broadcast open. At 1440x900 fine-pointer the desktop
     * branch runs instead -- raw ssh_input with NO trailing CR, so the text
     * lands on the shell's editable line and is NOT executed -- which is why
     * this block used to read an empty #mobileInput and count "stray" emits
     * that were in fact the documented behaviour. The desktop branch is
     * asserted on its own terms in the block below.
     */
    const { ctx, page, errors } = await newPage(834, 1194, { touch: true });
    await seedSession(page);
    await seedCommands(page);
    await page.evaluate(() => CommandLibrary.openLibrary());
    await page.waitForTimeout(50);

    /*
     * REVISED (Phase 2). "Insert stages, never runs" still holds and
     * is still what these rows measure -- but the composer now MIRRORS the
     * session's input line, so staging means the text is ON the line, not held
     * back in the browser. The measurable difference between staging and
     * running is the CARRIAGE RETURN, which only an explicit commit sends, so
     * that is what these rows assert instead of a byte count of zero.
     */
    const ranLine = async (page) => (await inputEmits(page))
        .some(e => (e.payload?.data || '').includes('\r'));

    // Real click on the production insert button of the first card.
    await page.click('#commandsList .command-row .cmd-insert');
    await page.waitForTimeout(50);
    check('§1 insert: draft holds the command', await page.inputValue('#mobileInput'), 'df -h');
    check('§1 insert: the command is staged, not run', await ranLine(page), false);
    check('§1 insert: no ssh_connect emitted',
        (await page.evaluate(() => window.__emits.filter(e => e.ev === 'ssh_connect').length)), 0);
    check('§1 insert: the rail stays open so several commands can be composed',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§1 insert: the draft is still editable',
        await page.evaluate(() => {
            const c = document.getElementById('mobileInput');
            return !c.readOnly && !c.disabled;
        }), true);

    // Caret splice: place the caret mid-draft and insert again.
    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        c.value = 'sudo  --all';
        c.selectionStart = c.selectionEnd = 5;   // between "sudo " and " --all"
    });
    await page.click('#commandsList .command-row .cmd-insert');
    await page.waitForTimeout(50);
    check('§1 caret: the command landed at the caret, not at the end',
        await page.inputValue('#mobileInput'), 'sudo df -h --all');
    check('§1 caret: caret sits after the inserted text',
        await page.evaluate(() => document.getElementById('mobileInput').selectionStart),
        'sudo df -h'.length);
    check('§1 caret: still nothing run', await ranLine(page), false);

    // A real paste into the composer is likewise inert.
    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        c.value = '';
        c.focus();
    });
    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        const dt = new DataTransfer();
        dt.setData('text/plain', 'rm -rf /tmp/pasted');
        c.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
        }));
        // Chromium does not mutate the value for a synthetic paste; production
        // does not either -- it has no paste handler on the composer, which is
        // the point. Emulate the browser's own default insertion.
        c.setRangeText('rm -rf /tmp/pasted', 0, 0, 'end');
        c.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(50);
    check('§1 paste: pasted text sits in the draft',
        await page.inputValue('#mobileInput'), 'rm -rf /tmp/pasted');
    check('§1 paste: pasting runs nothing', await ranLine(page), false);

    // Plain Enter inserts a newline; it must not commit. On the line that is
    // ESC+CR (a newline inside Claude Code / codex), never a bare CR.
    await page.focus('#mobileInput');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(30);
    check('§1 Enter: still nothing run',
        (await inputEmits(page)).some(e => /(?<!\x1b)\r/.test(e.payload?.data || '')),
        false);
    check('§1 Enter: a newline joined the draft',
        (await page.inputValue('#mobileInput')).includes('\n'), true);

    // Ctrl+Enter commits exactly once, as one payload.
    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        c.value = 'echo one';
        c.focus();
    });
    let before = (await inputEmits(page)).length;
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(50);
    let sent = (await inputEmits(page)).slice(before);
    // The box was rewritten directly (no input event), so the commit first
    // corrects the line -- DELs for what the mirror still held -- and then
    // runs it. The tail is what matters: the draft, then exactly one CR.
    check('§1 Ctrl+Enter: the draft reaches the line and is run exactly once',
        [sent.map(e => e.payload.data).join('').endsWith('echo one\r'),
         sent.filter(e => e.payload.data.includes('\r')).length],
        [true, 1]);
    check('§1 Ctrl+Enter: addressed to the active session',
        sent.every(e => e.payload?.session_id === 's1'), true);
    check('§1 Ctrl+Enter: the draft was cleared on success',
        await page.inputValue('#mobileInput'), '');

    // Send commits too, and only when pressed.
    await page.evaluate(() => {
        document.getElementById('mobileInput').value = 'echo two';
    });
    before = (await inputEmits(page)).length;
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(50);
    sent = (await inputEmits(page)).slice(before);
    check('§1 Send: it carries the second draft and runs it once',
        [sent.map(e => e.payload.data).join(''),
         sent.filter(e => e.payload.data.includes('\r')).length],
        ['echo two\r', 1]);

    check('§1 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §1b  The OTHER insert destination: fine-pointer desktop, which v5 section 5
//      invariant 5 leaves without any composer. insertCommand then emits the
//      text as raw ssh_input with NO trailing '\r' (command-library.js:453-462,
//      "the same verbatim, no-CR emit the function keypad uses"), so the shell
//      leaves it on the editable command line and the user decides when to run
//      it. The absence of the CR is the whole safety property here -- an emit
//      that carried one would EXECUTE a command the UI said was only inserted,
//      which is exactly the executeCommand defect this design replaced.
// ---------------------------------------------------------------------------
console.log('\n--- §1b desktop insert lands at the prompt, never executed ---');
{
    const { ctx, page, errors } = await newPage(1440, 900);
    await seedSession(page);
    await seedCommands(page);
    await page.evaluate(() => CommandLibrary.openLibrary());
    await page.waitForTimeout(50);

    check('§1b the real capability query classifies this as a desktop shell',
        await page.evaluate(() => TerminalManager.isTouchShell()), false);
    check('§1b v5 invariant 5: no composer is visible on fine-pointer desktop',
        await page.evaluate(() => {
            const c = document.getElementById('mobileInput');
            if (!c) return false;
            const r = c.getBoundingClientRect();
            return getComputedStyle(c).display === 'none' || r.width === 0 || r.height === 0;
        }), true);

    await page.click('#commandsList .command-row .cmd-insert');
    await page.waitForTimeout(50);
    const desktopSent = await inputEmits(page);
    check('§1b insert emits exactly one ssh_input', desktopSent.length, 1);
    check('§1b it carries the command verbatim', desktopSent[0]?.payload?.data, 'df -h');
    check('§1b and it carries NO carriage return (nothing is executed)',
        /[\r\n]/.test(desktopSent[0]?.payload?.data ?? ''), false);
    check('§1b addressed to the active session',
        desktopSent[0]?.payload?.session_id, 's1');
    check('§1b no ssh_connect emitted',
        await page.evaluate(() => window.__emits.filter(e => e.ev === 'ssh_connect').length), 0);
    check('§1b the rail stays open so several commands can be composed',
        await page.evaluate(() => CommandLibrary.isOpen()), true);

    check('§1b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §2  Touch open: no Search focus, no keyboard summoned, draft preserved.
// ---------------------------------------------------------------------------
console.log('\n--- §2 touch open never focuses Search and never clears the draft ---');
{
    const { ctx, page, errors } = await newPage(390, 844, { touch: true });
    await seedSession(page);
    await seedCommands(page);

    check('§2 the real capability query classifies this as a touch shell',
        await page.evaluate(() => TerminalManager.isTouchShell()), true);

    // A draft in progress, with the keyboard up (focus in the composer).
    await page.focus('#mobileInput');
    await page.evaluate(() => {
        document.getElementById('mobileInput').value = 'half-typed --draft';
    });
    check('§2 precondition: the composer holds focus before opening',
        await page.evaluate(() => document.activeElement?.id), 'mobileInput');

    /*
     * The real touch entry path. #commandRailOpenBtn is a .tab-row-icon-btn and
     * those are display:none below 1024px, so a touch user reaches the Library
     * through the one global menu.
     *
     * Owner correction: that used to be a PROXY -- #mobileCommandsBtn
     * carrying data-mobile-action-target="commandLibraryBtn", with
     * header-menus.js dispatching a click at the real button. The proxy is gone
     * along with the intermediate menu view; touch-action-row.js now MOVES the
     * real #commandLibraryBtn into the menu, so the user taps the same node this
     * line clicks.
     *
     * The blur under test is openLibrary's, so it is measured on a path that does
     * not move focus by itself: opening the menu would blur the composer before
     * the rail ever opened, which would prove nothing. A direct click on the real
     * control keeps focus where the user left it until openLibrary acts.
     */
    await page.evaluate(() => document.getElementById('commandLibraryBtn').click());
    await page.waitForTimeout(80);

    check('§2 the rail opened', await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§2 Search did NOT take focus (no soft keyboard for a mere open)',
        await page.evaluate(() => document.activeElement?.id === 'commandSearchInput'), false);
    // openLibrary blurs the composer on touch to clear the keyboard out of the
    // sheet's way. Blur must not clear what was typed.
    check('§2 the composer was blurred, retracting the keyboard',
        await page.evaluate(() => document.activeElement?.id === 'mobileInput'), false);
    check('§2 the draft survived the blur',
        await page.inputValue('#mobileInput'), 'half-typed --draft');

    // And the user-facing menu route reaches the same toggle. The menu hosts the
    // REAL #commandLibraryBtn now, so the route clicks that node rather than a
    // proxy for it.
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(80);
    await page.click('#commandLibraryBtn');
    await page.waitForTimeout(80);
    check('§2 the menu Commands entry toggled the rail closed',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    await page.click('#mobileMoreBtn');
    await page.waitForTimeout(80);
    await page.click('#commandLibraryBtn');
    await page.waitForTimeout(80);
    check('§2 and toggled it open again',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§2 the draft survived both toggles',
        await page.inputValue('#mobileInput'), 'half-typed --draft');

    // Even after the focus timer would have fired, Search stays unfocused.
    await page.waitForTimeout(250);
    check('§2 Search is still unfocused once the fine-pointer timer would have run',
        await page.evaluate(() => document.activeElement?.id === 'commandSearchInput'), false);

    // A deliberate tap into Search is still allowed.
    await page.click('#commandSearchInput');
    check('§2 tapping Search focuses it, as the user asked',
        await page.evaluate(() => document.activeElement?.id), 'commandSearchInput');

    // Inserting from the sheet still stages, never sends.
    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        c.value = '';
        c.selectionStart = c.selectionEnd = 0;
    });
    await page.click('#commandsList .command-row .cmd-insert');
    await page.waitForTimeout(50);
    check('§2 touch insert staged the draft', await page.inputValue('#mobileInput'), 'df -h');
    check('§2 touch insert stages without running',
        (await inputEmits(page)).some(e => (e.payload?.data || '').includes('\r')),
        false);

    check('§2 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §3  Keyboard and exclusion contracts.
// ---------------------------------------------------------------------------
console.log('\n--- §3 F1 toggle, xterm Escape, two-way exclusion, closed-rail focus exclusion ---');
{
    const { ctx, page, errors } = await newPage(1440, 900);
    await seedSession(page);
    await seedCommands(page);

    // --- closed rail is out of the accessibility tree and out of tab order ---
    const closedState = await page.evaluate(() => {
        const rail = document.getElementById('commandRail');
        const cs = getComputedStyle(rail);
        return {
            ariaHidden: rail.getAttribute('aria-hidden'),
            inert: rail.hasAttribute('inert'),
            visibility: cs.visibility,
            pointerEvents: cs.pointerEvents,
        };
    });
    check('§3 closed: aria-hidden="true"', closedState.ariaHidden, 'true');
    check('§3 closed: inert', closedState.inert, true);
    check('§3 closed: visibility hidden', closedState.visibility, 'hidden');
    check('§3 closed: pointer-events none', closedState.pointerEvents, 'none');

    /*
     * Sequential focus reachability, proven by driving real Tab presses from a
     * control before the rail and seeing where focus lands -- an inert subtree
     * must never appear.
     *
     * The anchor is #notepadOpenBtn, not #commandRailOpenBtn: as of H2 the
     * latter sits inside the closed account menu, and .focus() on a node in a
     * display:none subtree is a no-op that silently leaves focus on <body>.
     * That would still have walked the document and still passed -- from the
     * wrong starting point, which is exactly the vacuous pass this suite exists
     * to avoid. #notepadOpenBtn is a painted control in the workspace row,
     * immediately before the rail in DOM order, so the walk starts where the
     * assertion means it to.
     */
    await page.evaluate(() => document.getElementById('notepadOpenBtn').focus());
    check('§3 closed: the Tab walk starts on a real, focused control',
        await page.evaluate(() => document.activeElement?.id), 'notepadOpenBtn');
    const tabbedInto = [];
    for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        tabbedInto.push(await page.evaluate(() => {
            const el = document.activeElement;
            return el?.closest?.('#commandRail') ? (el.id || 'anonymous-in-rail') : '';
        }));
    }
    check('§3 closed: 12 Tab presses never land inside the rail',
        tabbedInto.filter(Boolean).join(','), '');

    /*
     * F1 FROM COMPOSER FOCUS needs a shell that HAS a composer: v5 section 5
     * invariant 5 leaves fine-pointer desktop without one, so focusing
     * #mobileInput here silently failed and the precondition read false. The
     * composer-focus case therefore runs on its own touch context below; the
     * desktop tier still proves F1 toggles, just from the tier's own focus.
     */
    await page.evaluate(() => CommandLibrary.openLibrary());
    await page.waitForTimeout(50);
    check('§3 F1 precondition (desktop): rail open, no composer to focus',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    await page.keyboard.press('F1');
    await page.waitForTimeout(50);
    check('§3 F1 CLOSES the open rail',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    await page.keyboard.press('F1');
    await page.waitForTimeout(50);
    check('§3 F1 again REOPENS it (toggle, not open-only)',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§3 F1 toggling emitted no ssh_input', (await inputEmits(page)).length, 0);

    // --- open rail is in the accessibility tree ---
    const openState = await page.evaluate(() => {
        const rail = document.getElementById('commandRail');
        return {
            ariaHidden: rail.getAttribute('aria-hidden'),
            inert: rail.hasAttribute('inert'),
            visibility: getComputedStyle(rail).visibility,
        };
    });
    check('§3 open: aria-hidden="false"', openState.ariaHidden, 'false');
    check('§3 open: inert removed', openState.inert, false);
    check('§3 open: visibility visible', openState.visibility, 'visible');

    // --- Escape from the terminal must reach xterm, never close the rail ---
    await page.evaluate(() => {
        // A focusable stand-in for xterm's textarea inside the terminal area:
        // the fixture has no live xterm, and what is under test is the rail's
        // handler scope, not xterm itself.
        const host = document.querySelector('.terminal-area');
        let ta = document.getElementById('fakeXtermInput');
        if (!ta) {
            ta = document.createElement('textarea');
            ta.id = 'fakeXtermInput';
            host.appendChild(ta);
        }
        window.__escapesSeenByTerminal = 0;
        ta.addEventListener('keydown', e => {
            if (e.key === 'Escape') window.__escapesSeenByTerminal++;
        });
        ta.focus();
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    check('§3 Escape from the terminal did NOT close the rail',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§3 Escape reached the terminal element',
        await page.evaluate(() => window.__escapesSeenByTerminal), 1);

    // --- Escape from inside the rail closes it ---
    await page.evaluate(() => document.getElementById('commandSearchInput').focus());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    check('§3 Escape from inside the rail closes it',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    check('§3 closing re-applies inert',
        await page.evaluate(() =>
            document.getElementById('commandRail').hasAttribute('inert')), true);

    // --- two-way mutual exclusion, both directions, real clicks ---
    const notepadOpen = () => page.evaluate(() => {
        const p = document.getElementById('notepadPanel');
        return !p.classList.contains('collapsed') && !!p.offsetParent;
    });

    // Direction 1: opening Notepad closes Command.
    await clickRailOpener(page);
    await page.waitForTimeout(50);
    check('§3 exclusion setup: Command open', await page.evaluate(() => CommandLibrary.isOpen()), true);
    await page.click('#notepadOpenBtn');
    await page.waitForTimeout(50);
    check('§3 exclusion: opening Notepad closed Command',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    check('§3 exclusion: Notepad is the one that is open', await notepadOpen(), true);
    // Closing Command must not fight the panel the user just asked for.
    check('§3 exclusion: focus was not yanked back to the Command invoker',
        await page.evaluate(() => document.activeElement?.id === 'commandLibraryBtn'), false);

    // Direction 2: opening Command closes Notepad.
    await clickRailOpener(page);
    await page.waitForTimeout(50);
    check('§3 exclusion: opening Command closed Notepad', await notepadOpen(), false);
    check('§3 exclusion: Command is the one that is open',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§3 exclusion: never both at once',
        await page.evaluate(() => {
            const np = document.getElementById('notepadPanel');
            const railOpen = CommandLibrary.isOpen();
            const npOpen = !np.classList.contains('collapsed') && !!np.offsetParent;
            return railOpen && npOpen;
        }), false);

    /*
     * Both external controls stay reachable throughout. #notepadOpenBtn is a
     * painted workspace-row control, so offsetParent is the right test for it.
     * Entry 39: #commandLibraryBtn is the header route, so "reachable"
     * means it paints in the bare header with no menu opened -- measured below
     * on its own rect. The account menu is then opened and shut for real to
     * prove that inspecting it disturbs neither the rail nor the opener.
     */
    check('§3 the Notepad control remains visible and enabled',
        await page.evaluate(() => {
            const b = document.getElementById('notepadOpenBtn');
            return !!b && !b.disabled && b.offsetParent !== null;
        }), true);
    check('§3 the Library opener remains reachable in the header',
        await page.evaluate(() => {
            const b = document.getElementById('commandLibraryBtn');
            const r = b?.getBoundingClientRect();
            return !!b && !b.disabled && b.getClientRects().length > 0
                && getComputedStyle(b).visibility !== 'hidden'
                && r.width > 0 && r.height > 0;
        }), true);
    /*
     * Close the menu with its own trigger, not Escape: Escape is also the
     * rail's own dismiss key, and pressing it here closed the open rail --
     * which then failed the next step with "#commandRailSetsBtn is not
     * visible". Toggling the trigger dismisses only the menu, so the section
     * continues against the same open rail it was measuring.
     */
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    check('§3 inspecting the account menu left the rail open',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    /*
     * Entry 39 moved the Library opener into the header, so the rail
     * is now opened WITHOUT the account menu -- the toggle above therefore
     * OPENS it. Toggle it shut again (and prove it shut) so the section's later
     * steps act on the same bare shell they measured; while open, the dropdown
     * overlays the rail and intercepted the in-rail Sets click.
     */
    check('§3 the account menu opened for the reachability measurement',
        await page.evaluate(() =>
            document.getElementById('accountDropdownHeader')?.offsetParent !== null), true);
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    check('§3 the account menu was toggled shut again',
        await page.evaluate(() =>
            document.getElementById('accountDropdownHeader')?.offsetParent !== null), false);
    check('§3 closing the account menu left the rail open',
        await page.evaluate(() => CommandLibrary.isOpen()), true);

    // Sets is reachable from inside the rail, and is the only modal content.
    await page.click('#commandRailSetsBtn');
    await page.waitForTimeout(80);
    // v5 split the old #commandWorkspaceModal: the Library became this rail and
    // the modal host now "owns Command Sets only" (command-workspace.js:1-7,
    // :20). The dead id returned null, so .classList threw and aborted the run.
    check('§3 the in-rail Sets button opens the Sets modal',
        await page.evaluate(() =>
            document.getElementById('commandSetsModal')?.classList.contains('show')), true);
    check('§3 the superseded workspace modal is gone',
        await page.evaluate(() => !!document.getElementById('commandWorkspaceModal')), false);
    check('§3 no Library tab survives in the modal',
        await page.evaluate(() => !!document.getElementById('commandLibraryTab')), false);

    check('§3 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §3b  F1 from COMPOSER focus, on a shell that actually has a composer. This is
//      the case §3 could not reach on fine-pointer desktop (v5 section 5
//      invariant 5: no composer there), and it is the one that matters most --
//      F1 must toggle the rail while the user is mid-draft WITHOUT disturbing
//      the draft or emitting anything.
// ---------------------------------------------------------------------------
console.log('\n--- §3b F1 toggles from composer focus on a touch shell ---');
{
    const { ctx, page, errors } = await newPage(834, 1194, { touch: true });
    await seedSession(page);
    await seedCommands(page);

    await page.evaluate(() => {
        const c = document.getElementById('mobileInput');
        c.value = 'draft in progress';
        c.selectionStart = c.selectionEnd = c.value.length;
    });
    await page.evaluate(() => CommandLibrary.openLibrary());
    await page.waitForTimeout(50);
    await page.focus('#mobileInput');
    check('§3b precondition: composer focused and rail open',
        await page.evaluate(() => document.activeElement?.id === 'mobileInput'
            && CommandLibrary.isOpen()), true);

    await page.keyboard.press('F1');
    await page.waitForTimeout(50);
    check('§3b F1 from the composer CLOSES the open rail',
        await page.evaluate(() => CommandLibrary.isOpen()), false);
    await page.focus('#mobileInput').catch(() => {});
    await page.keyboard.press('F1');
    await page.waitForTimeout(50);
    check('§3b F1 again REOPENS it (toggle, not open-only)',
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§3b the in-progress draft survived both toggles',
        await page.inputValue('#mobileInput'), 'draft in progress');
    check('§3b F1 toggling emitted no ssh_input', (await inputEmits(page)).length, 0);

    check('§3b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §4  Desktop geometry: a real right-hand auxiliary panel, not an overlay.
// ---------------------------------------------------------------------------
console.log('\n--- §4 desktop rail geometry, composer visibility, shared-width drags ---');
{
    const { ctx, page, errors } = await newPage(1440, 900);
    await seedSession(page);
    await seedCommands(page);
    /*
     * A real xterm in a real pane, so "the terminal stays visible and usable" is
     * measured against something that renders rows. This is the production
     * sequence from createSession: a .terminal-wrapper in #terminalsContainer,
     * then createTerminal + attachTerminal against it, then the pane assignment
     * that moves the wrapper into #terminalGrid.
     */
    await page.evaluate(() => {
        const wrapper = document.createElement('div');
        wrapper.id = 'terminal-s1';
        wrapper.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(wrapper);
        SessionManager.sessions.s1.terminalId = 'terminal-s1';
        TerminalManager.createTerminal('s1');
        TerminalManager.attachTerminal('s1', 'terminal-s1');
        SessionManager.assignSessionToPane('s1', 0);
    });
    await page.waitForTimeout(300);

    /*
     * The Notepad ships OPEN on a fresh profile, so it -- not the Command rail --
     * owns the shared track at load. Every "closed" baseline below therefore
     * means BOTH auxiliary panels closed, which is the state a user reaches by
     * collapsing the Notepad. Measuring against the shipped default instead
     * would compare the rail against the Notepad's own width and read zero
     * push, which is exactly the false green this comment exists to prevent.
     */
    await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        if (!panel.classList.contains('collapsed')) {
            // #notepadToggle is the withdrawn chevron (owner ruling,
            // defect 9) and no longer closes anything; the panel's own close
            // control is what a user presses to release the auxiliary track.
            document.getElementById('notepadCloseBtn').click();
        }
    });
    await page.waitForTimeout(300);

    const geom = () => page.evaluate(() => {
        const r = el => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
                left: Math.round(b.left), right: Math.round(b.right),
                top: Math.round(b.top), bottom: Math.round(b.bottom),
                w: Math.round(b.width), h: Math.round(b.height),
            };
        };
        const ws = document.getElementById('workspace');
        const rail = document.getElementById('commandRail');
        const area = document.querySelector('.terminal-area');
        const bar = document.getElementById('mobileInputBar');
        const rows = document.querySelector('#terminalGrid .xterm-rows');
        return {
            workspace: r(ws), rail: r(rail), area: r(area), bar: r(bar),
            cols: getComputedStyle(ws).gridTemplateColumns,
            railPosition: getComputedStyle(rail).position,
            barDisplay: bar ? getComputedStyle(bar).display : 'NONE',
            barVisible: bar ? bar.offsetParent !== null : false,
            sendVisible: (() => {
                const b = document.getElementById('mobileSendBtn');
                return !!b && b.offsetParent !== null;
            })(),
            send: r(document.getElementById('mobileSendBtn')),
            composerVisible: (() => {
                const c = document.querySelector('.mobile-composer');
                return !!c && c.offsetParent !== null;
            })(),
            hiddenDockButtons: ['mobileMoreBtn', 'mobileKeypadBtn', 'mobileSendBtn',
                'exitScrollBtn'].filter(id => {
                const b = document.getElementById(id);
                return b && b.offsetParent !== null;
            }),
            terminalRows: rows ? rows.children.length : 0,
            railScrollerId: (() => {
                const list = document.getElementById('commandsList');
                const cs = getComputedStyle(list);
                return `${cs.overflowY}/${cs.overflowX}`;
            })(),
        };
    });

    const closed = await geom();
    check('§4 closed: the auxiliary track is zero', closed.cols.endsWith(' 0px'), true);
    check('§4 closed: the desktop composer dock is not rendered', closed.barVisible, false);

    await clickRailOpener(page);
    await page.waitForTimeout(400);   // past the 300ms fit
    const open = await geom();

    check('§4 open: the rail is in normal flow, not an overlay',
        open.railPosition, 'static');
    check('§4 open: the rail occupies the right-hand edge of the workspace',
        open.rail.right, open.workspace.right);
    check('§4 open: the terminal area ends exactly where the rail begins',
        open.area.right, open.rail.left);
    check('§4 open: the rail does not overlap the terminal columns',
        open.area.right <= open.rail.left, true);
    check('§4 open: the terminal narrowed by the rail width, i.e. it was pushed',
        closed.area.w - open.area.w, open.rail.w);
    atLeast('§4 open: the terminal is still wide enough to use', open.area.w, 600, 'px');
    atLeast('§4 open: the live terminal still renders rows', open.terminalRows, 5);
    check('§4 open: the shared track carries the rail width',
        open.cols.endsWith(` ${open.rail.w}px`), true);

    /*
     * The composer must NOT appear just because the rail opened. Amendment
     * section 5's display matrix is explicit for "Desktop thuong": Composer
     * "An" (hidden), Nut gui "Khong co" (no Send button) -- and only "Desktop
     * Broadcast" reveals the one shared composer. Opening an auxiliary panel is
     * not a device-state change, so the rail cannot conjure a composer; that is
     * why insertCommand takes the raw no-CR prompt path here instead (asserted
     * in section 1b).
     *
     * The old expectation demanded the composer and a 44px Send at this tier,
     * i.e. exactly the surface the matrix forbids. Inverted, and the dock-button
     * absence check is kept and widened to cover Send, so "no touch dock creeps
     * onto desktop" is still enforced rather than dropped.
     */
    check('§4 open: v5 section 5 matrix -- no composer on fine-pointer desktop',
        open.composerVisible, false);
    check('§4 open: and no Send button', open.sendVisible, false);
    check('§4 open: no touch dock buttons appear either',
        open.hiddenDockButtons.join(','), '');
    check('§4 open: the card list is the vertical scroller',
        open.railScrollerId, 'auto/hidden');

    // No horizontal overflow inside the rail at desktop rail width, including
    // the deliberately long command.
    const overflow = await page.evaluate(() => {
        const list = document.getElementById('commandsList');
        const worst = [...list.querySelectorAll('.command-row')]
            .map(r => r.scrollWidth - r.clientWidth);
        const osb = document.querySelector('.command-rail .os-filter-toolbar');
        const railBox = document.getElementById('commandRail').getBoundingClientRect();
        const osBtns = [...osb.querySelectorAll('.os-filter-btn')];
        return {
            listOverflow: list.scrollWidth - list.clientWidth,
            rowOverflow: Math.max(0, ...worst),
            railOverflow: (() => {
                const rail = document.getElementById('commandRail');
                return rail.scrollWidth - rail.clientWidth;
            })(),
            osOverflow: osb.scrollWidth - osb.clientWidth,
            osShown: osb.offsetParent !== null,
            // .command-rail is overflow:hidden, so railOverflow above is
            // CLAMPED to 0 and cannot see chips escaping. Compare rects.
            filtersAllInside: osBtns.every(x => {
                const b = x.getBoundingClientRect();
                return b.left >= railBox.left - 1 && b.right <= railBox.right + 1
                    && b.top >= railBox.top - 1 && b.bottom <= railBox.bottom + 1;
            }),
            osRows: new Set(osBtns.map(
                x => Math.round(x.getBoundingClientRect().top))).size,
        };
    });
    check('§4 open: the card list has no horizontal overflow', overflow.listOverflow, 0);
    check('§4 open: no card overflows sideways', overflow.rowOverflow, 0);
    check('§4 open: the rail itself has no horizontal overflow', overflow.railOverflow, 0);
    // §5 has carried these three since the touch sheet was written; §4 never
    // did, which is why 189px of escaped OS filter sat under a green suite.
    check('§4 open: the OS filter is available', overflow.osShown, true);
    check('§4 open: the OS filter has no horizontal overflow', overflow.osOverflow, 0);
    check('§4 open: every OS filter box is inside the rail', overflow.filtersAllInside, true);
    check('§4 open: the chips wrap to exactly two rows', overflow.osRows, 2);

    /*
     * P2 / mockup line 181 changed what a library entry IS. Insert used to be
     * one of three or four equal 26px icon buttons inside a stacked card; the
     * mockup makes the whole 46px .tw5-list-row the insert affordance, with the
     * corner-down-left glyph stating that, and leaves edit/delete/copy as
     * secondary controls beside it.
     *
     * So "insert is the leading .btn-icon" is no longer the contract -- insert
     * is not a .btn-icon at all. What replaces it is stronger, not weaker: the
     * primary target is asserted to be the ROW (which is larger than the 44px
     * floor it used to be measured against, and is verified by hit test below),
     * and every remaining secondary action still has to clear the fine-pointer
     * floor the mockup sets for .tw5-icon-control (spec line 232: 32px).
     */
    const actions = await page.evaluate(() => {
        const row = document.querySelector('#commandsList .command-row');
        const rail = document.getElementById('commandRail').getBoundingClientRect();
        const primary = row.querySelector('.command-rail-item');
        const pr = primary.getBoundingClientRect();
        return {
            primary: {
                tag: primary.tagName,
                isInsert: primary.classList.contains('cmd-insert'),
                w: Math.round(pr.width), h: Math.round(pr.height),
                inside: pr.left >= rail.left - 1 && pr.right <= rail.right + 1,
                glyph: primary.querySelector(':scope > .icon use')
                    ?.getAttribute('href') || '',
                ownsCentre: (() => {
                    const el = document.elementFromPoint(
                        Math.round(pr.left + pr.width / 2),
                        Math.round(pr.top + pr.height / 2));
                    return !!el && primary.contains(el);
                })(),
            },
            secondary: [...row.querySelectorAll('.command-actions .btn-icon')]
                .map(b => {
                    const r = b.getBoundingClientRect();
                    return {
                        cls: b.className.replace('btn-icon ', ''),
                        w: Math.round(r.width), h: Math.round(r.height),
                        inside: r.left >= rail.left - 1 && r.right <= rail.right + 1,
                    };
                }),
        };
    });
    check('§4 open: the whole row is the insert control', actions.primary.tag, 'BUTTON');
    check('§4 open: and it carries the insert behaviour', actions.primary.isInsert, true);
    check('§4 open: it states insert with corner-down-left (mockup line 181)',
        actions.primary.glyph.includes('#icon-corner-down-left'), true);
    atLeast('§4 open: the primary target meets the mockup 46px row',
        actions.primary.h, 46, 'px');
    check('§4 open: the primary target owns its own centre',
        actions.primary.ownsCentre, true);
    check('§4 open: the primary target is inside the rail, not clipped',
        actions.primary.inside, true);
    // A user command carries edit + delete; a system command carries copy.
    check('§4 open: the row keeps its secondary actions',
        actions.secondary.length >= 1, true);
    for (const a of actions.secondary) {
        atLeast(`§4 open: ${a.cls} meets the mockup 32px icon control`, a.w, 32, 'px');
        atLeast(`§4 open: ${a.cls} meets it vertically too`, a.h, 32, 'px');
        check(`§4 open: ${a.cls} is inside the rail, not clipped`, a.inside, true);
    }

    // Close restores the geometry exactly.
    await page.click('#commandRailCloseBtn');
    await page.waitForTimeout(400);
    const reclosed = await geom();
    check('§4 close: the auxiliary track is zero again',
        reclosed.cols.endsWith(' 0px'), true);
    check('§4 close: the terminal area regained its full width',
        reclosed.area.w, closed.area.w);
    check('§4 close: the desktop composer is gone again', reclosed.barVisible, false);
    atLeast('§4 close: the live terminal still renders rows', reclosed.terminalRows, 5);

    // --- both auxiliary drags save a non-zero shared width ---
    // The two panels share one grid track, and the hidden one measures 0, so a
    // drag started while Command owns the track must measure the RAIL. Before
    // auxPanel() this saved 0 and poisoned the stored layout.
    /*
     * Grab the handle near the top. The former #notepadToggle chevron sat at
     * the handle's vertical centre and startResize returned early for it by
     * design (a click on the chevron was a collapse, not a drag), so a centre
     * grab was a no-op while the Notepad was open. That chevron is gone (W6),
     * so the only reason to stay near the top now is consistency with the
     * gesture both drags are measured through.
     */
    const dragHandle = async (dx) => {
        const box = await page.evaluate(() => {
            const b = document.getElementById('resizeHandle').getBoundingClientRect();
            const y = b.top + 40;
            return { x: b.left + b.width / 2, y };
        });
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.mouse.move(box.x + dx, box.y, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        return page.evaluate(() => ({
            saved: parseFloat(localStorage.getItem('workspace-notepad-width')),
            track: getComputedStyle(document.getElementById('workspace'))
                .gridTemplateColumns,
        }));
    };

    // Notepad drag first (unchanged behavior). Assert the panel is actually open
    // before dragging: a collapsed panel measures 0 and the drag would prove
    // nothing about the measurement path.
    await page.evaluate(() => localStorage.removeItem('workspace-notepad-width'));
    /*
     * Open Notes through its CANONICAL opener, #notepadOpenBtn. The former
     * in-terminal chevron (#notepadToggle) is gone from the template (W6),
     * so #notepadOpenBtn is the sole opener at every tier.
     */
    await page.evaluate(() => {
        if (CommandLibrary.isOpen()) CommandLibrary.closeLibrary();
        const panel = document.getElementById('notepadPanel');
        if (panel.classList.contains('collapsed')) {
            document.getElementById('notepadOpenBtn').click();
        }
    });
    await page.waitForTimeout(300);
    check('§4 drag: the Notepad is open and owns the track',
        await page.evaluate(() =>
            !document.getElementById('notepadPanel').classList.contains('collapsed')), true);
    atLeast('§4 drag: the open Notepad measures a real width',
        await page.evaluate(() => document.getElementById('notepadPanel').offsetWidth), 1, 'px');
    const noteDrag = await dragHandle(-60);
    atLeast('§4 drag: a Notepad drag saved a non-zero shared width', noteDrag.saved, 1, 'px');

    // Command drag: Notepad is hidden and measures 0 while the rail owns it.
    await page.evaluate(() => localStorage.removeItem('workspace-notepad-width'));
    await clickRailOpener(page);
    await page.waitForTimeout(300);
    check('§4 drag: Command owns the track', await page.evaluate(() => CommandLibrary.isOpen()), true);
    check('§4 drag: the hidden Notepad measures zero, which is the trap',
        await page.evaluate(() => document.getElementById('notepadPanel').offsetWidth), 0);
    const cmdDrag = await dragHandle(-60);
    atLeast('§4 drag: a Command drag saved a non-zero shared width', cmdDrag.saved, 1, 'px');
    check('§4 drag: it did not save zero', cmdDrag.saved === 0, false);
    check('§4 drag: the track still carries a real width',
        cmdDrag.track.endsWith(' 0px'), false);

    check('§4 no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §4b  Narrow fine-pointer rail at 1280x800.
// ---------------------------------------------------------------------------
console.log('\n--- §4b narrow desktop rail (1280x800) ---');
{
    const { ctx, page, errors } = await newPage(1280, 800);
    await seedSession(page);
    await seedCommands(page);

    check('§4b: fine pointer, not a touch shell',
        await page.evaluate(() => TerminalManager.isTouchShell()), false);

    await clickRailOpener(page);
    await page.waitForTimeout(300);
    check('§4b: the rail is open', await page.evaluate(() => CommandLibrary.isOpen()), true);

    const narrow = await page.evaluate(() => {
        const rail = document.getElementById('commandRail');
        const railBox = rail.getBoundingClientRect();
        const list = document.getElementById('commandsList');
        const card = list.querySelector('.command-row');
        const btns = [...document.querySelectorAll(
            '.command-rail .os-filter-toolbar .os-filter-btn')];
        return {
            listClientH: list.clientHeight,
            firstCardH: Math.round(card.getBoundingClientRect().height),
            chipCount: btns.length,
            rowCount: new Set(btns.map(
                b => Math.round(b.getBoundingClientRect().top))).size,
            allInside: btns.every(b => {
                const r = b.getBoundingClientRect();
                return r.left >= railBox.left - 1 && r.right <= railBox.right + 1
                    && r.top >= railBox.top - 1 && r.bottom <= railBox.bottom + 1;
            }),
            // Inside the rail box is not the same as tappable: hit-test each.
            allReachable: btns.every(b => {
                const r = b.getBoundingClientRect();
                const el = document.elementFromPoint(
                    Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
                return el === b || b.contains(el);
            }),
        };
    });

    check('§4b: all five OS chips are rendered', narrow.chipCount, 5);
    check('§4b: OS chips wrap to exactly two rows', narrow.rowCount, 2);
    check('§4b: every OS chip box is inside the rail', narrow.allInside, true);
    check('§4b: every OS chip wins its own hit test', narrow.allReachable, true);
    // The regression this section exists for: 159px list under a 177px card.
    atLeast('§4b: the rail shows a full command card',
        narrow.listClientH, narrow.firstCardH, 'px');

    check('§4b no page errors', errors.join(' | '), '');
    await ctx.close();
}

// ---------------------------------------------------------------------------
// §5  Touch tiers: bottom sheet, zero terminal-width loss, composer and
//     lifecycle controls present and operable, rename/reset usable.
//
// All four are coarse-pointer contexts, so they land on the frozen capability
// predicate whatever their width: 768x1024 and 1024x768 are iPads, which must
// behave as touch shells and never as desktop side rails.
// ---------------------------------------------------------------------------
const TOUCH_TIERS = [
    { label: 'ipad-portrait', w: 768, h: 1024 },
    { label: 'ipad-landscape', w: 1024, h: 768 },
    { label: 'phone-portrait', w: 390, h: 844 },
    { label: 'phone-landscape', w: 844, h: 390 },
];

for (const tier of TOUCH_TIERS) {
    console.log(`\n--- §5 ${tier.label} (${tier.w}x${tier.h}) command sheet ---`);
    const { ctx, page, errors } = await newPage(tier.w, tier.h, { touch: true });
    await seedSession(page);
    await seedCommands(page);

    check(`§5 ${tier.label}: classified as a touch shell`,
        await page.evaluate(() => TerminalManager.isTouchShell()), true);

    /*
     * Baseline = BOTH auxiliary panels closed. The Notepad ships open, and above
     * 767px it is still a desktop side rail (its own mobile sheet rules are
     * scoped to max-width:767px), so leaving it open would make the iPad tiers
     * measure the Command sheet against the Notepad's occupied track -- and
     * "the terminal lost no width" would read as a width GAIN when the sheet
     * evicted the Notepad. Closing it first isolates what this section tests.
     */
    await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        panel.classList.remove('mobile-open');
        if (!panel.classList.contains('collapsed')) {
            document.getElementById('notepadOpenBtn')?.click();
        }
    });
    await page.waitForTimeout(300);

    const measure = () => page.evaluate(() => {
        const box = el => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
                left: Math.round(b.left), right: Math.round(b.right),
                top: Math.round(b.top), bottom: Math.round(b.bottom),
                w: Math.round(b.width), h: Math.round(b.height),
            };
        };
        const ws = document.getElementById('workspace');
        const rail = document.getElementById('commandRail');
        const area = document.querySelector('.terminal-area');
        return {
            workspace: box(ws), rail: box(rail), area: box(area),
            cols: getComputedStyle(ws).gridTemplateColumns,
            railPosition: getComputedStyle(rail).position,
            railVisibility: getComputedStyle(rail).visibility,
            composerVisible: (() => {
                const c = document.querySelector('.mobile-composer');
                return !!c && c.offsetParent !== null;
            })(),
            sendVisible: (() => {
                const b = document.getElementById('mobileSendBtn');
                return !!b && b.offsetParent !== null;
            })(),
            toolbarVisible: (() => {
                const t = document.getElementById('sessionActionsToolbar');
                return !!t && t.offsetParent !== null;
            })(),
        };
    });

    const before = await measure();
    // Zero terminal-width loss is the whole point of an absolutely positioned
    // sheet: the shared grid track must be 0 on touch, not the rail width.
    check(`§5 ${tier.label}: the auxiliary grid track is zero before opening`,
        before.cols.endsWith(' 0px'), true);

    await page.evaluate(() => document.getElementById('commandLibraryBtn').click());
    await page.waitForTimeout(400);
    const open = await measure();

    check(`§5 ${tier.label}: the rail opened`,
        await page.evaluate(() => CommandLibrary.isOpen()), true);
    check(`§5 ${tier.label}: it is a bottom sheet, not a side rail`,
        open.railPosition, 'absolute');
    check(`§5 ${tier.label}: the sheet spans the full workspace width`,
        open.rail.w, open.workspace.w);
    check(`§5 ${tier.label}: it sits at the bottom of the workspace`,
        open.rail.bottom, open.workspace.bottom);
    check(`§5 ${tier.label}: the sheet is visible`, open.railVisibility, 'visible');
    check(`§5 ${tier.label}: the auxiliary grid track is STILL zero`,
        open.cols.endsWith(' 0px'), true);
    check(`§5 ${tier.label}: the terminal lost NO width`, open.area.w, before.area.w);
    check(`§5 ${tier.label}: the live terminal is still on screen above the sheet`,
        open.area.top < open.rail.top, true);
    // A sheet that ate the whole workspace would leave no terminal context. The
    // sheet is bounded by 66% of the workspace, so this floor is structural, not
    // a property of the sampled viewports. Tenths, and 33.4 not 33, so a sheet
    // at exactly two thirds cannot pass on integer rounding alone.
    atLeast(`§5 ${tier.label}: the terminal keeps at least a third of the height`,
        Math.round((open.workspace.h - open.rail.h) / open.workspace.h * 1000) / 10,
        33.4, '%');

    // Composer and Send are the commit path; both must be operable on touch.
    check(`§5 ${tier.label}: the composer is present`, open.composerVisible, true);
    check(`§5 ${tier.label}: Send is present`, open.sendVisible, true);

    // The card list is the scroller and nothing overflows sideways.
    const flow = await page.evaluate(() => {
        const list = document.getElementById('commandsList');
        const cs = getComputedStyle(list);
        const rows = [...list.querySelectorAll('.command-row')];
        const listBox = list.getBoundingClientRect();
        const rail = document.getElementById('commandRail');
        const railBox = rail.getBoundingClientRect();
        const cardBox = rows[0].getBoundingClientRect();
        const ins = rows[0].querySelector('.cmd-insert');
        const ir = ins.getBoundingClientRect();
        // Hit test BEFORE any scrolling. Geometry alone missed four tiers where
        // the first card straddled the scroller edge and the dock or the tab
        // strip owned the pixel the user actually taps.
        const hitEl = document.elementFromPoint(
            Math.round(ir.left + ir.width / 2), Math.round(ir.top + ir.height / 2));
        const osb = document.querySelector('.command-rail .os-filter-toolbar');
        const osShown = osb.offsetParent !== null;
        const osBtns = osShown ? [...osb.querySelectorAll('.os-filter-btn')] : [];
        const at = list.scrollTop;
        list.scrollTop = 40;
        const scrollMoved = list.scrollTop > at;
        list.scrollTop = at;
        let minSide = Infinity, minSel = '';
        for (const el of rail.querySelectorAll('button,input,select,textarea,a[href]')) {
            if (el.offsetParent === null) continue;
            const b = el.getBoundingClientRect();
            if (b.width < 1 || b.height < 1) continue;
            if (Math.min(b.width, b.height) < minSide) {
                minSide = Math.round(Math.min(b.width, b.height));
                minSel = el.id || el.className || el.tagName;
            }
        }
        return {
            overflowY: cs.overflowY, overflowX: cs.overflowX,
            listOverflow: list.scrollWidth - list.clientWidth,
            rowOverflow: Math.max(0, ...rows.map(r => r.scrollWidth - r.clientWidth)),
            panelOverflow: (() => {
                const p = document.getElementById('commandLibraryPanel');
                return p.scrollWidth - p.clientWidth;
            })(),
            scrollable: list.scrollHeight >= list.clientHeight,
            railOverflow: rail.scrollWidth - rail.clientWidth,
            osOverflow: osb.scrollWidth - osb.clientWidth,
            pageOverflow: document.documentElement.scrollWidth
                - document.documentElement.clientWidth,
            firstCardH: Math.round(cardBox.height),
            listClientH: list.clientHeight,
            cardFullyInsideList: cardBox.top >= listBox.top - 1
                && cardBox.bottom <= listBox.bottom + 1,
            // Still the decisive reachability check, just aimed at what the
            // insert control now IS: the whole 46px row rather than a 26px icon
            // button inside a card.
            hit: (hitEl === ins || ins.contains(hitEl))
                ? 'cmd-insert'
                : `OBSCURED:${hitEl ? (hitEl.id || hitEl.className || hitEl.tagName) : 'null'}`,
            realScroller: list.scrollHeight > list.clientHeight,
            scrollMoved,
            minSide, minSel,
            helpRendered: document.querySelector('.command-rail .command-help')
                .offsetParent !== null,
            osShown,
            filtersAllInside: osBtns.every(x => {
                const b = x.getBoundingClientRect();
                return b.left >= railBox.left - 1 && b.right <= railBox.right + 1
                    && b.top >= railBox.top - 1 && b.bottom <= railBox.bottom + 1;
            }),
            filtersAll44: osBtns.every(x => x.getBoundingClientRect().height >= 44),
            cardDirection: getComputedStyle(rows[0]).flexDirection,
            // P2 / mockup line 181: the command text is a <code> inside the row
            // button now, not a .command-text cell in a stacked card. The cell
            // wrappers are gone with the card, so this reads the row's own code.
            codeWhiteSpace: getComputedStyle(
                rows[0].querySelector('.command-rail-item code')).whiteSpace,
            primaryH: (() => {
                const b = rows[0].querySelector('.command-rail-item');
                return b ? Math.round(b.getBoundingClientRect().height) : 0;
            })(),
            actions: (() => {
                const row = rows[0];
                return [...row.querySelectorAll('.command-actions .btn-icon')].map(b => {
                    const r = b.getBoundingClientRect();
                    return { w: Math.round(r.width), h: Math.round(r.height) };
                });
            })(),
        };
    });
    check(`§5 ${tier.label}: the card list is the vertical scroller`, flow.overflowY, 'auto');
    check(`§5 ${tier.label}: it never scrolls horizontally`, flow.overflowX, 'hidden');
    check(`§5 ${tier.label}: the card list has no horizontal overflow`, flow.listOverflow, 0);
    check(`§5 ${tier.label}: no card overflows sideways`, flow.rowOverflow, 0);
    check(`§5 ${tier.label}: the panel itself has no horizontal overflow`, flow.panelOverflow, 0);
    for (const [i, a] of flow.actions.entries()) {
        atLeast(`§5 ${tier.label}: card action ${i} is a 44px target (w)`, a.w, 44, 'px');
        atLeast(`§5 ${tier.label}: card action ${i} is a 44px target (h)`, a.h, 44, 'px');
    }

    // The decisive check: the primary action must own its own pixel with no
    // scrolling first. A card that merely EXISTS in the DOM is not reachable.
    check(`§5 ${tier.label}: the first card's Insert wins the hit test pre-scroll`,
        flow.hit, 'cmd-insert');
    check(`§5 ${tier.label}: the first card fits inside the scroller`,
        flow.cardFullyInsideList, true);
    atLeast(`§5 ${tier.label}: the scroller is at least one card tall`,
        flow.listClientH, flow.firstCardH, 'px');
    /*
     * "The list must actually overflow" was a property of the OLD 97px stacked
     * card, where two seeded commands guaranteed overflow. With the mockup's
     * 46px row (line 181) the same two commands measure ~94px and legitimately
     * fit at the taller tiers -- so asserting overflow here would assert that
     * the row is too tall, which is the opposite of the fix.
     *
     * What the section actually needs to prove is that the list SCROLLS WHEN IT
     * OVERFLOWS, so that is asserted directly: overflow-y is already checked
     * above, and here the container is driven past its own content to confirm
     * the scroll port is live rather than clipped.
     */
    check(`§5 ${tier.label}: the list is a live scroll port`,
        flow.overflowY, 'auto');
    if (flow.realScroller) {
        check(`§5 ${tier.label}: and when content overflows it actually scrolls`,
            flow.scrollMoved, true);
    } else {
        check(`§5 ${tier.label}: content fits, so nothing is clipped out of reach`,
            flow.cardFullyInsideList, true);
    }

    // Blanket floor over every rendered control in the sheet, not just the card
    // actions above: the Search input shipped at 43px and no assertion saw it.
    atLeast(`§5 ${tier.label}: smallest rendered target in the sheet (${flow.minSel})`,
        flow.minSide, 44, 'px');

    // Containment. The OS filter was 104px of unreachable horizontal overflow
    // before the touch rules existed -- Windows and macOS could not be tapped.
    check(`§5 ${tier.label}: the OS filter has no horizontal overflow`,
        flow.osOverflow, 0);
    check(`§5 ${tier.label}: the rail has no horizontal overflow`, flow.railOverflow, 0);
    check(`§5 ${tier.label}: the page has no horizontal overflow`, flow.pageOverflow, 0);
    check(`§5 ${tier.label}: every OS filter box is inside the sheet`,
        flow.filtersAllInside, true);
    check(`§5 ${tier.label}: every rendered OS filter is a 44px target`,
        flow.filtersAll44, true);

    // Help is desktop-only; in the sheet it costs the first card its place.
    check(`§5 ${tier.label}: command help is not rendered in the sheet`,
        flow.helpRendered, false);

    /*
     * P2 / mockup line 181 replaced the stacked two-line card with ONE 46px
     * .tw5-list-row at EVERY tier, so "cards stay vertical above 500px, compact
     * row below" is no longer the contract -- there is only the one row shape.
     * The short-landscape exception it documented is gone with the thing it was
     * excepting.
     *
     * This is not a weakening: the row direction is now asserted at every tier
     * rather than only at one, the 46px floor is asserted (it was not before),
     * and the wrap rule flips to its opposite for a measured reason -- a
     * wrapping <code> inside a fixed 46px row pushes the trailing affordance
     * out of the row it belongs to, so the mockup's row clips instead.
     */
    check(`§5 ${tier.label}: the entry is one row, not a stacked card`,
        flow.cardDirection, 'row');
    atLeast(`§5 ${tier.label}: and it meets the mockup 46px row`,
        flow.primaryH, 46, 'px');
    check(`§5 ${tier.label}: the command text clips rather than wrapping the row open`,
        flow.codeWhiteSpace, 'nowrap');
    if (tier.h > 500) {
        check(`§5 ${tier.label}: the OS filter is available`, flow.osShown, true);
    } else {
        check(`§5 ${tier.label}: and drops the OS filter for sheet height`,
            flow.osShown, false);
    }

    // Insert from the sheet stages, never runs.
    await page.click('#commandsList .command-row .cmd-insert');
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: insert staged the draft`,
        await page.inputValue('#mobileInput'), 'df -h');
    check(`§5 ${tier.label}: insert stages without running`,
        (await inputEmits(page)).some(e => (e.payload?.data || '').includes('\r')),
        false);

    // Send commits exactly once from the touch dock.
    await page.click('#mobileSendBtn');
    await page.waitForTimeout(80);
    const committed = await inputEmits(page);
    check(`§5 ${tier.label}: Send committed the staged command exactly once`,
        [committed.map(e => e.payload.data).join(''),
         committed.filter(e => e.payload.data.includes('\r')).length],
        ['df -h\r', 1]);

    // --- rename and reset are visible and operable for a running tab ---
    /*
     * The persistent lifecycle TOOLBAR is gone. Amendment section 3 line 52 --
     * "Session row: Khong chua action, spacer hay menu; session strip dung toan
     * bo chieu ngang con lai" -- forbids exactly the 144px band it occupied, so
     * #sessionActionsToolbar no longer exists in the template or in any script.
     * The four lifecycle actions now live in the #sessionActionsSheet, opened by
     * re-tapping or long-pressing a chip (line 56), with close as its danger row
     * (mockup line 184).
     *
     * Selecting the running tab first is what makes the sheet's actions apply to
     * it -- the sheet is per-target, so this replaces the old "selecting enabled
     * rename/reset" pair without losing that guarantee.
     */
    await page.evaluate(() => SessionManager.switchSession('s1'));
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: the superseded lifecycle toolbar is gone`,
        await page.evaluate(() => !!document.getElementById('sessionActionsToolbar')), false);

    // Re-tap the already-selected chip: production's own gesture for opening
    // the sheet. A trusted click, so hit-testing is genuinely exercised.
    await page.click('#tab-s1');
    await page.waitForTimeout(80);
    const toolbar = await page.evaluate(() => {
        const sheet = document.getElementById('sessionActionsSheet');
        const info = action => {
            const b = sheet?.querySelector(`[data-lifecycle-action="${action}"]`);
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return {
                visible: b.offsetParent !== null,
                disabled: b.disabled,
                w: Math.round(r.width), h: Math.round(r.height),
            };
        };
        return {
            sheetOpen: !!sheet && !sheet.hidden,
            rename: info('rename'),
            reset: info('reset'),
            reconnect: info('reconnect'),
            close: info('close'),
        };
    });
    check(`§5 ${tier.label}: re-tapping the chip opens the lifecycle sheet`,
        toolbar.sheetOpen, true);
    for (const name of ['rename', 'reconnect', 'reset', 'close']) {
        check(`§5 ${tier.label}: ${name} is visible`, toolbar[name]?.visible, true);
        atLeast(`§5 ${tier.label}: ${name} is a 44px target (w)`, toolbar[name]?.w, 44, 'px');
        atLeast(`§5 ${tier.label}: ${name} is a 44px target (h)`, toolbar[name]?.h, 44, 'px');
    }
    check(`§5 ${tier.label}: rename is enabled for the running tab`,
        toolbar.rename?.disabled, false);
    check(`§5 ${tier.label}: reset is enabled for the running tab`,
        toolbar.reset?.disabled, false);

    // Rename: a real tap opens the inline editor on the chip and a committed
    // value reaches the store.
    await page.click('#sessionActionsSheet [data-lifecycle-action="rename"]');
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: rename opened the inline editor on the chip`,
        await page.evaluate(() => !!document.querySelector('#tab-s1 .tab-rename-input')), true);
    await page.fill('#tab-s1 .tab-rename-input', 'Renamed on touch');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: the rename was committed to the session`,
        await page.evaluate(() => SessionManager.sessions.s1.displayName), 'Renamed on touch');

    /*
     * Reset's gate is the S5 in-app confirm dialog (#sessionConfirm), not
     * window.confirm(). The stub that used to stand here overrode a global the
     * app no longer calls, so it would have passed against a Reset that fired
     * with no confirmation at all. Driving the real dialog with real clicks is
     * strictly stronger: it exercises the same two buttons a user does, and it
     * would fail if the dialog stopped rendering or stopped gating.
     */
    const beforeReset = (await page.evaluate(() => window.__emits.length));
    await openLifecycleSheet(page, 's1');
    await page.click('#sessionActionsSheet [data-lifecycle-action="reset"]');
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: reset opens the confirm dialog`,
        await page.evaluate(() =>
            !document.getElementById('sessionConfirm').hidden), true);
    await page.click('#sessionConfirmCancel');
    await page.waitForTimeout(80);
    check(`§5 ${tier.label}: cancelling closes the dialog`,
        await page.evaluate(() =>
            document.getElementById('sessionConfirm').hidden), true);
    check(`§5 ${tier.label}: reset is operable and a declined confirm emits nothing`,
        await page.evaluate(() => window.__emits.length), beforeReset);
    // Accept it, and exactly one ssh_connect goes out.
    await page.evaluate(() => { window.__emits = []; });
    await openLifecycleSheet(page, 's1');
    await page.click('#sessionActionsSheet [data-lifecycle-action="reset"]');
    await page.waitForTimeout(80);
    await page.click('#sessionConfirmAccept');
    await page.waitForTimeout(120);
    check(`§5 ${tier.label}: an accepted reset emits exactly one ssh_connect`,
        await page.evaluate(() =>
            window.__emits.filter(e => e.ev === 'ssh_connect').length), 1);

    // --- open/close restores geometry ---
    await page.evaluate(() => CommandLibrary.closeLibrary());
    await page.waitForTimeout(400);
    const after = await measure();
    check(`§5 ${tier.label}: closing restored the terminal width`, after.area.w, before.area.w);
    check(`§5 ${tier.label}: closing restored the workspace height`,
        after.area.h, before.area.h);
    check(`§5 ${tier.label}: the closed sheet is hidden again`,
        after.railVisibility, 'hidden');
    check(`§5 ${tier.label}: the closed sheet is inert again`,
        await page.evaluate(() =>
            document.getElementById('commandRail').hasAttribute('inert')), true);

    check(`§5 ${tier.label}: no page errors`, errors.join(' | '), '');
    await ctx.close();
}

} catch (err) {
    // A thrown section is a failure, not a crash: record it, then let the
    // finally block release resources and the summary below report a red run.
    fail++;
    console.log(`FAIL  unhandled error: ${err && err.message ? err.message : String(err)}`);
} finally {
    // Guaranteed cleanup: a throwing section must not leave contexts, the
    // browser or the HTTP server alive -- that turns a failure into a hang.
    for (const ctx of openContexts) {
        await ctx.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
