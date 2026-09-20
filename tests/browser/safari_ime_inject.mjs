#!/usr/bin/env node
/*
 * SAFARI + A VIETNAMESE IME: the composed text must reach the terminal.
 *
 * Owner report, standing since and still open after the views
 * rewrite: on Safari for macOS with Telex/VNI "chỉ gõ được số" -- digits
 * arrive, letters do not. Digits are the one class of key a Vietnamese IME
 * does not compose, so the defect is in the COMPOSITION path.
 *
 * Measured first (probe, WebKit 26.5 vs Chromium 149): a plain
 * keystroke and a non-composed insertText both reach the wire on BOTH engines,
 * so the app's own input path is not at fault. What cannot be reproduced
 * headlessly is a real IME, so this suite drives the composition EVENTS
 * directly and pins the product's behaviour for the two outcomes that matter:
 *
 *   §1 the engine delivers NOTHING for the composition (the Safari failure):
 *      the app sends the composed text itself, exactly once;
 *   §2 the engine delivers the text itself: the app sends nothing more, so a
 *      working engine never double-types;
 *   §3 the engine delivers a PREFIX: only the missing tail is sent;
 *   §4 an empty composition (the user cancelled) sends nothing;
 *   §5 the rescue is WebKit-only, so Chromium keeps the engine's own path.
 *
 * Run: node tests/browser/safari_ime_inject.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
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
    '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
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
            res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return;
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

const INIT = `
    const noop = () => {};
    window.__emits = []; window.__handlers = {};
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    window.io = () => ({ connected: true, on: record, off: noop, once: record,
        emit: (ev, p) => { window.__emits.push({ ev, p }); }, io: { on: noop } });
    window.socket = window.io();
    window.__server = (ev, p) => { for (const fn of (window.__handlers[ev] || [])) fn(p); };
    window.showNotification = noop;
    window.ModalManager = { open: m => m && m.classList.add('show'),
        close: m => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const SID = 'aaaa1111-imex-4aaa-8aaa-000000000001';
const FRAME = {
    snapshot_version: 1, session_id: SID, host: 'tiny.example', port: 22,
    username: 'u', connected: true, auth_type: 'password', key_id: null,
    via_jump: null, use_tmux: true, tmux_session_name: 'sshdeck_ime',
    display_name: 'IME', pane_index: null, replay_total_chunks: 0,
    replay_truncated: false, replay_dropped_bytes: 0, replay_history_lines: 0,
    legacy_tmux_locale: null,
};

async function openApp(engine) {
    const browser = await engine.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/socket.io.min.js*', r =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    await page.addInitScript(INIT);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
        null, { timeout: 20000 });
    await page.evaluate(f => window.__server('ssh_session_restored', f), FRAME);
    await page.waitForTimeout(500);
    await page.evaluate(s => window.__server('view_attached', { session_id: s }), SID);
    await page.waitForTimeout(200);
    return { browser, page, errors };
}

/*
 * One composition, as the browser reports it. `engineText` is what the engine
 * leaves in the textarea for xterm to find: '' reproduces the Safari failure
 * (nothing to slice, so xterm delivers nothing), the composed text reproduces
 * a working engine.
 */
async function compose(page, text, engineText) {
    await page.evaluate(({ text, engineText }) => {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        ta.dispatchEvent(new CompositionEvent('compositionupdate',
            { bubbles: true, data: text.slice(0, 1) }));
        ta.value = engineText;
        ta.dispatchEvent(new CompositionEvent('compositionend',
            { bubbles: true, data: text }));
    }, { text, engineText });
    await page.waitForTimeout(180);
}
const wire = page => page.evaluate(() => window.__emits
    .filter(e => e.ev === 'ssh_input').map(e => e.p.data));
const clear = page => page.evaluate(() => { window.__emits = []; });

// ── WebKit: the engine under report ─────────────────────────────────────────
{
    const { browser, page, errors } = await openApp(webkit);
    check('§5 the rescue is armed on WebKit',
        await page.evaluate(() => TerminalManager.engineNeedsCompositionRescue()), true);

    // §1 the Safari failure: the engine reports the composition but leaves the
    // textarea empty, so xterm's slice finds nothing and delivers nothing.
    await clear(page);
    await compose(page, 'tiến', '');
    check('§1 the composed text reaches the wire exactly once',
        await wire(page), ['tiến']);

    // §2 a working engine: xterm finds the text and delivers it itself.
    await clear(page);
    await compose(page, 'việt', 'việt');
    check('§2 a delivered composition is not sent twice',
        (await wire(page)).join(''), 'việt');

    // §3 only a prefix arrived.
    await clear(page);
    await page.evaluate(() => {
        const key = (TerminalManager.sessionTerminals[
            Object.keys(TerminalManager.sessionTerminals)[0]] || [])[0];
        const cb = TerminalManager.inputCallbacks[key];
        // Deliver 'ti' the way the engine would, mid-composition.
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        TerminalManager.compositionRescue[key].delivered = 'ti';
        window.__emits.push({ ev: 'ssh_input', p: { data: 'ti' } });
        ta.dispatchEvent(new CompositionEvent('compositionend',
            { bubbles: true, data: 'tiến' }));
    });
    await page.waitForTimeout(180);
    check('§3 only the missing tail is sent', await wire(page), ['ti', 'ến']);

    // §4 a cancelled composition.
    await clear(page);
    await compose(page, '', '');
    check('§4 an empty composition sends nothing', await wire(page), []);

    check('§Z no page errors (webkit)', errors, []);
    await browser.close();
}

/*
 * §6 THE MEASURED SAFARI TRACE. `?kbdebug=1` on the owner's Safari 26.6.2 with
 * the Vietnamese input method, 42 events:
 *
 *   xterm.keydown            13   every letter: keyCode 229, isComposing false
 *   xterm.input insertReplacementText 10  -> onData  0
 *   xterm.input insertText             3  -> onData  3   (two spaces, one `a`)
 *   composition events                 0
 *
 * There is no composition: the IME REWRITES the word in the textarea with
 * `insertReplacementText`, which xterm 5.3.0 ignores (it acts on `insertText`
 * only). This section replays that shape -- the textarea value growing, one
 * replacement per letter -- and requires the letters to reach the terminal.
 */
{
    const { browser, page, errors } = await openApp(webkit);
    await clear(page);
    // "tien" typed one letter at a time, each arriving as a replacement of the
    // whole word, then the IME's accented rewrite, exactly as measured.
    /*
     * The value lands one macrotask AFTER the keydown, which is what makes
     * xterm deliver nothing: its keyCode-229 path reads the textarea on a
     * setTimeout(0) that runs while the value is still the old one. The
     * non-vacuous check below records that the engine really did stay silent.
     */
    const steps = ['t', 'ti', 'tie', 'tien', 'tiến'];
    await page.evaluate(() => {
        window.__engine = [];
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const inner = TerminalManager.inputCallbacks[key];
        TerminalManager.inputCallbacks[key] = (d) => inner(d);
        const t = TerminalManager.terminals[key];
        t.onData(d => window.__engine.push(d));
    });
    for (const value of steps) {
        await page.evaluate(() => {
            const ta = document.querySelector('.xterm-helper-textarea');
            ta.focus();
            ta.dispatchEvent(new KeyboardEvent('keydown',
                { bubbles: true, key: 'x', keyCode: 229, which: 229 }));
        });
        await page.waitForTimeout(20);
        await page.evaluate((v) => {
            const ta = document.querySelector('.xterm-helper-textarea');
            ta.value = v;
            ta.dispatchEvent(new InputEvent('input', {
                bubbles: true, inputType: 'insertReplacementText', data: v,
            }));
        }, value);
        await page.waitForTimeout(90);
    }
    check('§6 GUARD: the engine itself delivered nothing (the measured shape)',
        await page.evaluate(() => window.__engine.length), 0);
    const sent = (await wire(page)).join('');
    check('§6 the line ends up as the word the user typed',
        (() => {
            let line = '';
            for (const ch of sent) {
                if (ch === '\x7f') line = line.slice(0, -1);
                else line += ch;
            }
            return line;
        })(), 'tiến');
    check('§6 and the rewrite erased before it retyped',
        sent.includes('\x7f'), true);

    /*
     * §8 A REAL KEY. The engine delivers space, Enter and digits on KEYDOWN --
     * before `input` fires at all -- so the rescue must recognise its own
     * edit's bytes in what the engine already sent, not merely ask whether
     * anything arrived. Asking the latter doubled every space (owner,
     *: "bị dup 2 lần dấu cách").
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        // The engine's keydown delivery, then the `insertText` event it
        // precedes -- the shape a space, an Enter or a digit really has.
        TerminalManager.compositionRescue[key].delivered = ' ';
        ta.value += ' ';
        ta.dispatchEvent(new InputEvent('input',
            { bubbles: true, inputType: 'insertText', data: ' ' }));
    });
    await page.waitForTimeout(120);
    // Exactly one: the engine's. The harness's planted record stands for the
    // keydown delivery that precedes the event; the rescue must add nothing.
    check('§8 a key the engine delivered is not sent twice',
        await wire(page), [' ']);

    // An `insertText` IS handled by xterm: it must not be sent twice.
    await clear(page);
    await page.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value += ' ';
        ta.dispatchEvent(new InputEvent('input',
            { bubbles: true, inputType: 'insertText', data: ' ' }));
    });
    await page.waitForTimeout(120);
    check('§6 an input the engine handles is delivered once', await wire(page), [' ']);

    /*
     * §7 THE FIRST LETTER AFTER A CLICK. tmux turns focus reporting on, so
     * clicking into the terminal makes the engine emit `\x1b[I` -- on the same
     * channel the rescue watches for "the engine already delivered this". It
     * used to swallow the next edit whole: the owner's "Rồi rất tốt" arrived as
     * "ồi rất tốt". A terminal's own reply is not the user typing.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        // Exactly what a focus report looks like arriving on onData.
        TerminalManager.compositionRescue[key].delivered = '\x1b[I';
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        // Appended, as the IME does: the only edit is the new letter.
        ta.value += 'R';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertReplacementText', data: 'R',
        }));
    });
    await page.waitForTimeout(120);
    check('§7 the first letter is not swallowed by a focus report',
        (await wire(page)).join(''), 'R');

    /*
     * §9 AN `insertText` THE ENGINE DID NOT DELIVER. xterm 6 handles an
     * `insertText` in its input listener only when the event is not `composed`
     * or no keydown was seen; a real Safari keystroke is both, so the letter
     * reaches the wire only through the keydown's setTimeout(0) read of the
     * textarea -- and the first letter of a word lands after that read. The
     * doubled-space fix skipped `insertText` outright and lost it: "Rồi"
     * arrived as "ồi" a second time. The shape here is
     * the real one: keydown 229 seen, then a composed insertText.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        window.__engine = [];
        TerminalManager.terminals[key].onData(d => window.__engine.push(d));
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value = '';
        TerminalManager.compositionRescue[key].lastValue = '';
        ta.dispatchEvent(new KeyboardEvent('keydown',
            { bubbles: true, composed: true, key: 'R', keyCode: 229, which: 229 }));
    });
    await page.waitForTimeout(20);
    await page.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input',
            { bubbles: true, composed: true, inputType: 'insertText', data: 'R' }));
    });
    await page.waitForTimeout(120);
    check('§9 GUARD: the engine delivered nothing for it',
        await page.evaluate(() => window.__engine), []);
    check('§9 the first letter is sent by the rescue, once', await wire(page), ['R']);

    /*
     * §10 xterm EMPTIES THE TEXTAREA ON BLUR, with no input event. A record
     * still holding the old word would turn the next letter into a burst of
     * DELs against a line the user did not ask to erase.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value = 'tốt ';
        TerminalManager.compositionRescue[key].lastValue = 'tốt ';
        ta.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
        ta.value = '';   // what xterm's own blur handler leaves
        ta.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
        ta.focus();
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input',
            { bubbles: true, inputType: 'insertReplacementText', data: 'R' }));
    });
    await page.waitForTimeout(120);
    check('§10 after a blur the next letter carries no DELs',
        (await wire(page)).join(''), 'R');

    /*
     * §11 ...and after Enter, which xterm clears on its own keydown path.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value = 'ls';
        TerminalManager.compositionRescue[key].lastValue = 'ls';
        ta.dispatchEvent(new KeyboardEvent('keydown',
            { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
    });
    await page.waitForTimeout(60);
    await page.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input',
            { bubbles: true, inputType: 'insertReplacementText', data: 'R' }));
    });
    await page.waitForTimeout(120);
    const afterEnter = await wire(page);
    check('§11 after Enter the next letter carries no DELs',
        afterEnter.filter(d => d !== '\r').join(''), 'R');

    /*
     * §12 THE CLICK THAT FOCUSED THE TERMINAL. tmux has the mouse on, so the
     * click reaches onData as an SGR report (`\x1b[<0;12;40M` + release)
     * ahead of the first letter. The first filter allowed only digits, `;`
     * and `?` inside the CSI, so `<` survived and the first edit after a
     * click was dropped as "already handled".
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        TerminalManager.compositionRescue[key].delivered =
            '\x1b[<0;12;40M\x1b[<0;12;40m\x1b[I';
        TerminalManager.compositionRescue[key].lastValue = '';
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertReplacementText', data: 'R',
        }));
    });
    await page.waitForTimeout(120);
    check('§12 the first letter after a mouse-reported click is sent',
        (await wire(page)).join(''), 'R');

    /*
     * §13 THE COLOUR ANSWER. Claude Code asks the terminal for its colours
     * (OSC 10/11) whenever it gains focus; the answers are OSC strings ending
     * in ST, not CSI, and the first filter did not know them.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.value = '';
        TerminalManager.compositionRescue[key].lastValue = '';
        TerminalManager.compositionRescue[key].delivered =
            '\x1b]10;rgb:e6e6/eded/f3f3\x1b\\\x1b]11;rgb:1c1c/2121/2828\x1b\\';
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertReplacementText', data: 'R',
        }));
    });
    await page.waitForTimeout(120);
    check('§13 the first letter after an OSC colour answer is sent',
        (await wire(page)).join(''), 'R');

    /*
     * §14 A RUN OF BACKSPACES. The engine handles Backspace at keydown (a DEL
     * on the wire, the textarea untouched, no input event), so the DELs sat
     * in `delivered` until the next edit and made it look already handled:
     * "Rồi" typed after Backspaces reached the shell as "ồi" (owner's log).
     * The rescue now consumes the bytes of an engine-handled key one tick
     * later and shrinks the textarea by the erased character.
     */
    await clear(page);
    await page.evaluate(() => {
        const keys = Object.keys(TerminalManager.sessionTerminals);
        const key = (TerminalManager.sessionTerminals[keys[0]] || [])[0];
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.focus();
        ta.value = 'ă';
        TerminalManager.compositionRescue[key].lastValue = 'ă';
        TerminalManager.compositionRescue[key].delivered = '';
    });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    check('§14 the engine sent the DELs itself',
        (await wire(page)).join(''), '\x7f\x7f');
    check('§14 the textarea lost the erased character',
        await page.evaluate(() => document.querySelector('.xterm-helper-textarea').value), '');
    await page.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.value = 'R';
        ta.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertReplacementText', data: 'R',
        }));
    });
    await page.waitForTimeout(120);
    check('§14 the letter after the Backspaces is sent, once',
        (await wire(page)).join(''), '\x7f\x7fR');

    check('§Z no page errors (safari trace)', errors, []);
    await browser.close();
}

// ── Chromium: the engine that needs no rescue ───────────────────────────────
{
    const { browser, page, errors } = await openApp(chromium);
    check('§5 the rescue is NOT armed on Chromium',
        await page.evaluate(() => TerminalManager.engineNeedsCompositionRescue()), false);
    await clear(page);
    await compose(page, 'tiến', '');
    check('§5 so a composition Chromium did not deliver is left alone',
        await wire(page), []);
    check('§Z no page errors (chromium)', errors, []);
    await browser.close();
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
