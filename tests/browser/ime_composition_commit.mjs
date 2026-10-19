/*
 * WHAT A VIETNAMESE IME COMMITS IS WHAT REACHES THE SESSION, ONCE.
 *
 * Owner report 2026-10-19 (Edge on macOS, the built-in Vietnamese input
 * method, a plain shell as well as Claude Code): typing fast, letters arrive
 * late, and then whole stretches of the line are sent again.
 *
 * Measured from the keyboard log (3106 lines): the IME composes each word --
 * keydown 229, compositionstart, compositionupdate per letter, compositionend
 * with the committed word (often with its space or comma). Over one run 89 of
 * 90 words reached the wire exactly; "team," went out as "team". The page's
 * main thread was blocked 25-42 s a minute (perf probe), so the IME's events
 * and the next keys reach the page in bursts.
 *
 * xterm 6.0.0's CompositionHelper does not send what the IME committed: it
 * slices the textarea between marks it updates in setTimeout(0), and for a
 * 229 keydown outside a composition it diffs the textarea a tick later with
 * `t.replace(before, "")` -- the WHOLE textarea when the old value is no longer
 * in it. When the next key lands before those timeouts, the slice is cut at a
 * stale mark (the comma) or the diff resends text (the doubled stretches).
 *
 * The IME events are dispatched exactly as the log recorded them, either one
 * task per key (the page keeping up) or the whole sentence in one task (the
 * page blocked).
 *
 *   §1 keeping up: every word is sent once, in order
 *   §2 blocked: the same sentence is sent once, in order
 *   §3 "team," then a space outside the composition: the comma survives
 *   §4 a composition cancelled (empty commit) sends nothing
 *   §5 a key that is not the IME's ends a composition: its text is sent once
 *   §6 the guard is installed on the engine's own composition helper
 *   §7 a 229 key with no composition: the textarea's change is sent as DELs
 *      and the new text, never the whole textarea on top of the line; a
 *      change far from the end, or a cleared textarea, sends nothing
 *   §8 a commit that differs from what was shown sends the commit
 *
 * Chromium and WebKit; WebKit also runs the Safari rescue, which must not
 * send anything the engine already delivered.
 *   §Z no page errors
 *
 * Run: node tests/browser/ime_composition_commit.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
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

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

/*
 * Socket.IO client fixture, served at the vendored path the production template
 * actually loads (templates/index.html:1565).
 *
 * It has to define io() rather than assign window.socket: app.js:15 runs
 * `window.socket = io(...)` at startup, so a socket injected by addInitScript is
 * overwritten and captures nothing. That failure is silent -- it looks exactly
 * like the app not emitting -- which is why the fixture lives at the real path.
 *
 * ssh_input is echoed back as ssh_output so the terminal renders what was
 * transmitted, closing the same loop a remote shell would.
 */
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true,
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload) {
            window.__emits.push({ evt, payload, t: performance.now() });
            if (evt === 'ssh_input' && payload && payload.data) {
                (handlers.ssh_output || []).forEach(fn => fn({
                    session_id: payload.session_id, data: payload.data,
                }));
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.io = () => sock;
})();
`;

const EMIT_PRELUDE = 'window.__emits = [];';

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
};

let browser;

async function shell({ width, height, touch }) {
    const ctx = await browser.newContext({
        viewport: { width, height }, hasTouch: touch, isMobile: touch,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(EMIT_PRELUDE);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'root',
            auth_type: 'key', key_id: 'k1', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'visual-s1', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    await page.waitForTimeout(600);
    return { ctx, page, pageErrors };
}


// The IME, event for event as the keyboard log recorded it.
const IME = `
window.__ime = (() => {
    const ta = () => TerminalManager.terminals.s1.textarea;
    const key = (type, key, keyCode, composing) => {
        const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, isComposing: composing });
        Object.defineProperty(e, 'keyCode', { get: () => keyCode });
        Object.defineProperty(e, 'which', { get: () => keyCode });
        Object.defineProperty(e, 'charCode', { get: () => (type === 'keypress' ? keyCode : 0) });
        ta().dispatchEvent(e);
    };
    const comp = (type, data) => ta().dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    const edit = (value, data, inputType, composing) => {
        ta().dispatchEvent(new InputEvent('beforeinput', { data, inputType, isComposing: composing, bubbles: true }));
        ta().value = value;
        ta().dispatchEvent(new InputEvent('input', { data, inputType, isComposing: composing, bubbles: true }));
    };
    // One word: the letters' prefixes as the IME shows them, then the commit.
    const word = (steps, commit) => {
        const base = ta().value;
        key('keydown', steps[0].slice(-1), 229, false);
        comp('compositionstart', '');
        steps.forEach((data, i) => {
            if (i) key('keydown', data.slice(-1), 229, true);
            comp('compositionupdate', data);
            edit(base + data, data, 'insertCompositionText', true);
        });
        if (commit === null) {
            edit(base, '', 'insertCompositionText', true);
            comp('compositionend', '');
            return '';
        }
        comp('compositionend', commit);
        return commit;
    };
    // A key the IME does not take: keydown then keypress, as a browser sends it.
    const plain = (ch, code) => {
        key('keydown', ch, code, false);
        key('keypress', ch, code, false);
        return ch;
    };
    return { word, plain, key, comp, edit };
})();
`;
const SENTENCE = [
    ['w', ['B', 'Bâ', 'Bây', 'Bây '], 'Bây '],
    ['w', ['g', 'gi', 'giơ', 'giờ', 'giờ '], 'giờ '],
    ['w', ['v', 'va', 'vâ', 'vân', 'vấn', 'vấn '], 'vấn '],
    ['w', ['d', 'đ', 'đe', 'đê', 'đề', 'đề '], 'đề '],
    ['w', ['n', 'nh', 'nhờ', 'nhờ '], 'nhờ '],
    ['w', ['v', 'va', 'vả', 'vả '], 'vả '],
    ['w', ['t', 'te', 'tea', 'team', 'team,'], 'team,'],
    ['k', ' ', 32],
    ['w', ['t', 'tư', 'tưở', 'tưởng', 'tưởng '], 'tưởng '],
    ['w', ['l', 'lư', 'lượ', 'lượt', 'lượt.'], 'lượt.'],
];
const typed = SENTENCE.map(s => (s[0] === 'w' ? s[2] : s[1])).join('');
const errors = [];
const sent = page => page.evaluate(() => window.__emits
    .filter(e => e.evt === 'ssh_input').map(e => e.payload.data).join(''));
const reset = page => page.evaluate(() => {
    const t = TerminalManager.terminals.s1;
    t.textarea.value = '';
    window.__emits.length = 0;
});
// Play the sentence: one task per word (keeping up) or all in one task.
const play = (page, seq, blocked) => page.evaluate(async ({ seq, blocked }) => {
    const step = s => (s[0] === 'w' ? window.__ime.word(s[1], s[2]) : window.__ime.plain(s[1], s[2]));
    if (blocked) {
        seq.forEach(step);
    } else {
        for (const s of seq) {
            step(s);
            await new Promise(r => setTimeout(r, 30));
        }
    }
    await new Promise(r => setTimeout(r, 200));
}, { seq, blocked });

for (const type of [chromium, webkit]) {
const name = type.name();
browser = await type.launch();
const { ctx, page, pageErrors } = await shell({ width: 1280, height: 800, touch: false });
await page.locator('#terminal-s1 .xterm-screen').click();
await page.evaluate(IME);

await reset(page);
await play(page, SENTENCE, false);
check(`§1 [${name}] ` + 'keeping up: every word is sent once, in order', await sent(page), typed);

await reset(page);
await play(page, SENTENCE, true);
check(`§2 [${name}] ` + 'blocked: the same sentence is sent once, in order', await sent(page), typed);

await reset(page);
await play(page, [SENTENCE[6], SENTENCE[7]], true);
check(`§3 [${name}] ` + '"team," then a space outside the composition: the comma survives', await sent(page), 'team, ');

await reset(page);
await play(page, [['w', ['a', 'ă', 'ắ'], null], ['k', ' ', 32]], true);
check(`§4 [${name}] ` + 'a cancelled composition sends nothing', await sent(page), ' ');

await reset(page);
await page.evaluate(async () => {
    const t = TerminalManager.terminals.s1.textarea;
    window.__ime.key('keydown', 'x', 229, false);
    window.__ime.comp('compositionstart', '');
    window.__ime.comp('compositionupdate', 'xin');
    window.__ime.edit('xin', 'xin', 'insertCompositionText', true);
    window.__ime.key('keydown', 'Tab', 9, true);
    window.__ime.comp('compositionend', 'xin');
    await new Promise(r => setTimeout(r, 200));
    return t.value;
});
check(`§5 [${name}] ` + 'a key the IME does not take ends the composition: its text once, then the key',
    await sent(page), 'xin\t');

check(`§6 [${name}] ` + 'the guard is installed on the engine\'s composition helper',
    await page.evaluate(() => !!TerminalManager.terminals.s1._core?._compositionHelper?.__sshdeckCommit), true);

await reset(page);
await play(page, [['w', ['v', 'vi', 'vie'], 'việt ']], true);
check(`§8 [${name}] a commit that differs from the preview sends the commit`, await sent(page), 'việt ');

// §7 a 229 keydown outside any composition: the textarea diff.
const diff = (from, to) => page.evaluate(async ({ from, to }) => {
    const t = TerminalManager.terminals.s1.textarea;
    t.value = from;
    window.__emits.length = 0;
    window.__ime.key('keydown', 'x', 229, false);
    t.value = to;
    await new Promise(r => setTimeout(r, 120));
    return window.__emits.filter(e => e.evt === 'ssh_input').map(e => e.payload.data).join('');
}, { from, to });
check(`§7 [${name}] an append at the end is sent`, await diff('xin ch', 'xin cha'), 'a');
check(`§7 [${name}] a replaced last letter is DEL + the letter`, await diff('xin cha', 'xin chà'), '\x7fà');
check(`§7 [${name}] a rewrite is DELs + the new text, not the whole textarea on top`,
    await diff('xin chào bạn', 'Xin chào bạn'), '\x7f'.repeat(12) + 'Xin chào bạn');
check(`§7 [${name}] a change further back than 64 letters sends nothing`,
    await diff('a'.repeat(100), 'b' + 'a'.repeat(99)), '');
check(`§7 [${name}] a cleared textarea sends nothing`, await diff('xin chào', ''), '');

errors.push(...pageErrors.map(e => `${name}: ${e}`));
await ctx.close();
await browser.close();
}
check('§Z no page errors', errors, []);
server.close();
console.log(`\nime_composition_commit: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
