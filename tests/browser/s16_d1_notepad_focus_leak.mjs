/*
 * S16 defect D1 — note text must never end up in the composer.
 *
 * Owner report (deployed S15): text typed as a NOTE leaks INTO the
 * composer input box. Answer Q-D1: the owner DENIES having typed
 * that text into any input while sessionless, so the unbound-slot migration
 * (audit candidate C2) is UNPROVEN and is probed separately
 * (tests/browser/s16_d1_unbound_probe.mjs), not gated here.
 *
 * Addition C names the chain this file gates -- the FOCUS STEAL:
 *   1. `body.keyboard-open:not(.notepad-focused) .notepad-panel { display:none }`
 *      (style.css:5018) hides the notes panel WHILE IT IS FOCUSED whenever the
 *      `notepad-focused` companion class is not set. display:none drops focus.
 *   2. The touch-shell redirectors then hand focus -- and therefore every
 *      following keystroke -- to #mobileInput:
 *        - container click  -> terminal-manager.js:1202
 *        - xterm helper focusin -> terminal-manager.js:1219
 *      Neither asks whether the NOTEPAD currently owns the keyboard.
 * Result: the user is still typing a note and the characters land in the
 * composer, which is exactly "note text leaks INTO the composer".
 *
 * The two classes are written in two different places -- app.js:4497-4504
 * (focus/blur) and terminal-manager.js:3675-3679 (the keyboard transition
 * edge) -- so a keyboard-open that is recomputed while the notepad holds focus
 * but `notepad-focused` is absent is representable, and that state is what
 * rule 1 turns into a dropped focus.
 *
 * Sections (RED on current code):
 *   §F1  a click on the terminal container must NOT steal focus from a focused
 *        #sessionNotepad
 *   §F2  an xterm-helper focusin must NOT steal focus from a focused notepad
 *   §F3  the notes panel must not be display:none while it owns the keyboard
 *        (a hidden panel drops focus, and the next keystrokes are the leak)
 *   §F4  end-to-end: keystrokes typed after the flip must land in the NOTE,
 *        never in #mobileInput
 *   §F5  S17 R1 (FIX 5): a DOUBLE-TAP on the terminal must not steal a focused
 *        notepad -- neither immediately nor through its queued re-assert --
 *        and §F5b: with the companion class missing it must still never land
 *        focus on #mobileInput
 *   §F6  S17 R1 (FIX 5): SessionManager.focusActivePane, the funnel every focus
 *        route in the shell passes through, must leave a focused notepad alone
 *        while still routing focus normally when no note is focused
 *   §Z   zero page errors
 *
 * Run: node tests/browser/s16_d1_notepad_focus_leak.mjs   (from source/)
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

const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.__wire = [];
    window.socket = {
        connected: true,
        id: 'sock-s16d1-1',
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

const SID = 'S16-D1-1';

// A live session with a REAL terminal attached, because the focus redirectors
// under test are installed by attachTerminal (setupComposerInputOwnership).
const SEED = `(sid) => {
    SessionManager.sessions[sid] = { id: sid, session_id: sid, host: 'd1.example',
        port: 22, username: 'd1', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: 'D1', connected: true, isPersistentCandidate: false,
        tmuxSessionName: 'sshdeck_d1', terminalId: 'term-' + sid, useTmux: true,
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

// Open the notes sheet the way the shipped Notes control does on a touch shell
// and put the caret in it, then declare the keyboard open exactly as
// terminal-manager's viewport path does. `notepad-focused` is deliberately NOT
// set here: that is the representable state the two writers can produce (the
// class is written on the keyboard TRANSITION edge and on focus/blur, so a
// recompute while the notepad holds focus can leave it absent) and it is the
// state style.css:5018 turns into a dropped focus.
const OPEN_NOTES_AND_FLIP = `() => {
    const panel = document.getElementById('notepadPanel');
    const notepad = document.getElementById('sessionNotepad');
    panel.classList.add('mobile-open');
    notepad.focus();
    notepad.value = 'ghi chu cua toi';
    notepad.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.classList.add('keyboard-open');
    return document.activeElement ? document.activeElement.id : null;
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

// ── §F3 the panel must not be hidden while it owns the keyboard ─────────────
{
    const { ctx, page, errors } = await openPage();
    const focused = await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    check('§F3 the notepad really holds focus before the flip',
        focused, 'sessionNotepad');
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => {
        const panel = document.getElementById('notepadPanel');
        const notepad = document.getElementById('sessionNotepad');
        return {
            display: getComputedStyle(panel).display,
            offsetParent: notepad.offsetParent === null ? 'null' : 'present',
            active: document.activeElement ? document.activeElement.id : null,
        };
    });
    check('§F3 the notes panel is not display:none while focused',
        state.display !== 'none', true);
    check('§F3 the notes textarea is still laid out (focus cannot be dropped)',
        state.offsetParent, 'present');
    check('§F3 focus still belongs to the notepad', state.active, 'sessionNotepad');
    check('§Z no page errors (F3)', errors, []);
    await ctx.close();
}

// ── §F1 the container click must not steal a focused notepad ────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    await page.waitForTimeout(80);
    // The shipped redirector: a click anywhere on the terminal wrapper while
    // the composer is visible focuses #mobileInput (terminal-manager.js:1202).
    await page.evaluate((sid) => {
        document.getElementById('sessionNotepad').focus();
        TerminalManager.terminalContainers[sid]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, SID);
    await page.waitForTimeout(80);
    const f1 = await page.evaluate(() => ({
        active: document.activeElement ? document.activeElement.id : null,
        composer: document.getElementById('mobileInput').value,
    }));
    check('§F1 a terminal click does not steal focus from the notepad',
        f1.active, 'sessionNotepad');
    check('§F1 the composer box stays empty', f1.composer, '');
    check('§Z no page errors (F1)', errors, []);
    await ctx.close();
}

// ── §F2 an xterm-helper focus must not steal a focused notepad ──────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    await page.waitForTimeout(80);
    /*
     * The redirector guard is exercised in the state where it MATTERS: the
     * companion class is missing while the notepad holds the caret. §F3 covers
     * the class-sync half (with the fix that state no longer arises from the
     * keyboard path); this row covers the guard itself, so it forces the state
     * directly rather than depending on the class writers -- a redirector that
     * only behaves when another module got the classes right is not a guard.
     *
     * A REAL focus move, not a synthetic dispatch: `focusin` fires AFTER the
     * move, so by the time the handler runs `document.activeElement` is already
     * the helper and the only surviving evidence of who was typing is the
     * event's `relatedTarget`.
     */
    await page.evaluate((sid) => {
        document.getElementById('sessionNotepad').focus();
        document.body.classList.remove('notepad-focused');
        const helper = TerminalManager.terminalContainers[sid]
            .querySelector('.xterm-helper-textarea');
        helper.focus();
    }, SID);
    await page.waitForTimeout(120);
    const f2 = await page.evaluate(() => {
        const a = document.activeElement;
        return { active: a ? (a.id || a.className) : null };
    });
    check('§F2 an xterm helper focus does not bounce onto the composer',
        f2.active === 'mobileInput', false);
    check('§Z no page errors (F2)', errors, []);
    await ctx.close();
}

// ── §F4 end-to-end: the characters must reach the NOTE ──────────────────────
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    await page.waitForTimeout(80);
    await page.evaluate((sid) => {
        document.getElementById('sessionNotepad').focus();
        TerminalManager.terminalContainers[sid]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, SID);
    await page.waitForTimeout(80);
    // The user keeps typing the note. Whatever the app did with focus, these
    // characters belong to the note.
    await page.keyboard.type(' tiep tuc');
    await page.waitForTimeout(120);
    const f4 = await page.evaluate(() => ({
        note: document.getElementById('sessionNotepad').value,
        composer: document.getElementById('mobileInput').value,
    }));
    check('§F4 the continued keystrokes landed in the note',
        f4.note, 'ghi chu cua toi tiep tuc');
    check('§F4 no note text leaked into the composer', f4.composer, '');
    check('§Z no page errors (F4)', errors, []);
    await ctx.close();
}

/*
 * ── §F5 S17 R1 (FIX 5): the DOUBLE-TAP redirect had no Notes guard ──────────
 *
 * The two redirectors §F1/§F2 gate were fixed in S16-D1, but the double-tap
 * branch of the touchend handler (terminal-manager.js, inside the isTouchShell()
 * case) called mobileInput.focus() plus a setTimeout re-assert with NO
 * notepadOwnsKeyboard() check, unlike its siblings at :1381 and :1422. So a
 * double-tap landing while the Notes sheet owned the keyboard moved focus into
 * the composer and the rest of the note was typed there -- the Owner's R1
 * "composer contaminated with NOTE text", still live in his 10:20
 * test. Measured in probe4: A3 STEALS to mobileInput on touch.
 *
 * The setTimeout re-assert is why this needs its own row: even if something else
 * restored focus, a task queued from here would take it back a tick later, so
 * the assertion has to survive that tick.
 */
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    await page.waitForTimeout(80);

    const doubleTap = await page.evaluate(async (sid) => {
        const notepad = document.getElementById('sessionNotepad');
        notepad.focus();
        const wrapper = TerminalManager.terminalContainers[sid];
        const rect = wrapper.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const tap = () => {
            const mk = (type) => {
                const touch = new Touch({
                    identifier: 11, target: wrapper,
                    clientX: x, clientY: y,
                    pageX: x + window.scrollX, pageY: y + window.scrollY,
                    screenX: x, screenY: y,
                });
                return new TouchEvent(type, {
                    bubbles: true, cancelable: true,
                    touches: type === 'touchend' ? [] : [touch],
                    targetTouches: type === 'touchend' ? [] : [touch],
                    changedTouches: [touch],
                });
            };
            wrapper.dispatchEvent(mk('touchstart'));
            wrapper.dispatchEvent(mk('touchend'));
        };
        // Two taps inside DOUBLE_TAP_MS and DOUBLE_TAP_PX of each other.
        tap();
        tap();
        const immediate = document.activeElement
            ? (document.activeElement.id || document.activeElement.className)
            : null;
        // Let the setTimeout(..., 0) re-assert run before reading again.
        await new Promise(r => setTimeout(r, 30));
        return {
            immediate,
            settled: document.activeElement
                ? (document.activeElement.id || document.activeElement.className)
                : null,
            composer: document.getElementById('mobileInput').value,
            note: notepad.value,
        };
    }, SID);

    check('§F5 a double-tap does not steal focus from the notepad',
        doubleTap.immediate, 'sessionNotepad');
    check('§F5 nor does its queued re-assert take it a tick later',
        doubleTap.settled, 'sessionNotepad');
    check('§F5 the composer box stays empty', doubleTap.composer, '');

    // End-to-end: the characters after the double-tap belong to the NOTE.
    await page.keyboard.type(' sau hai lan go');
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => ({
        note: document.getElementById('sessionNotepad').value,
        composer: document.getElementById('mobileInput').value,
    }));
    check('§F5 the keystrokes after the double-tap landed in the note',
        after.note, 'ghi chu cua toi sau hai lan go');
    check('§F5 no note text leaked into the composer', after.composer, '');

    /*
     * The same double-tap in the state §F2 forces -- the companion class missing
     * while the notepad holds the caret. Here style.css:5018 hides the panel and
     * the platform drops focus to <body> a tick later, so the surviving property
     * is §F2's: whatever else happens, focus must NOT land on #mobileInput and no
     * note text may appear there. A redirector that only behaves when another
     * module got the classes right is not a guard.
     */
    const forced = await page.evaluate(async (sid) => {
        const notepad = document.getElementById('sessionNotepad');
        notepad.focus();
        document.body.classList.remove('notepad-focused');
        const wrapper = TerminalManager.terminalContainers[sid];
        const rect = wrapper.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const tap = () => {
            const mk = (type) => {
                const touch = new Touch({
                    identifier: 12, target: wrapper,
                    clientX: x, clientY: y,
                    pageX: x + window.scrollX, pageY: y + window.scrollY,
                    screenX: x, screenY: y,
                });
                return new TouchEvent(type, {
                    bubbles: true, cancelable: true,
                    touches: type === 'touchend' ? [] : [touch],
                    targetTouches: type === 'touchend' ? [] : [touch],
                    changedTouches: [touch],
                });
            };
            wrapper.dispatchEvent(mk('touchstart'));
            wrapper.dispatchEvent(mk('touchend'));
        };
        tap();
        tap();
        await new Promise(r => setTimeout(r, 40));
        return {
            active: document.activeElement
                ? (document.activeElement.id || document.activeElement.className)
                : null,
            composer: document.getElementById('mobileInput').value,
        };
    }, SID);
    check('§F5b even with the companion class missing, focus never lands on the composer',
        forced.active === 'mobileInput', false);
    check('§F5b and the composer box is still empty', forced.composer, '');

    check('§Z no page errors (F5)', errors, []);
    await ctx.close();
}

/*
 * ── §F6 S17 R1 (FIX 5): focusActivePane is the other steal ──────────────────
 *
 * Every focus route in the shell funnels through SessionManager.focusActivePane
 * (tab click, tab swipe, setActivePane, connect completion, restore/reconnect,
 * pane tap, gesture recovery, search close, exit-scroll), and it had no Notes
 * exception either: on desktop the composer-first branch focuses #mobileInput
 * and the fallthrough calls terminal.focus(). probe4 measured A4/A5/A6 stealing
 * to xterm-helper-textarea on desktop. One guard at the top of the function
 * covers both exits.
 */
{
    const { ctx, page, errors } = await openPage();
    await page.evaluate(new Function('return ' + OPEN_NOTES_AND_FLIP)());
    await page.waitForTimeout(80);

    const viaFocusActivePane = await page.evaluate(() => {
        const notepad = document.getElementById('sessionNotepad');
        notepad.focus();
        document.body.classList.remove('notepad-focused');
        SessionManager.focusActivePane();
        return {
            active: document.activeElement
                ? (document.activeElement.id || document.activeElement.className)
                : null,
            composer: document.getElementById('mobileInput').value,
        };
    });
    check('§F6 focusActivePane leaves a focused notepad alone',
        viaFocusActivePane.active, 'sessionNotepad');
    check('§F6 the composer box stays empty', viaFocusActivePane.composer, '');

    // The guard must not break the ORDINARY case: with the notepad blurred,
    // focusActivePane still routes focus as before.
    const ordinary = await page.evaluate(() => {
        document.getElementById('sessionNotepad').blur();
        document.body.classList.remove('notepad-focused');
        document.body.focus();
        SessionManager.focusActivePane();
        return document.activeElement
            ? (document.activeElement.id || document.activeElement.className)
            : null;
    });
    check('§F6 with no note focused the notepad no longer owns the keyboard',
        ordinary === 'sessionNotepad', false);
    check('§Z no page errors (F6)', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
