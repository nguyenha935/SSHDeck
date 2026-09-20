/*
 * Item 2: notepad client-side revision adoption.
 *
 * The server contract (tests/test_notepad_sync.py) now carries revisions. The
 * app must adopt it, and it must stop the stale overwrite that resurrected
 * deleted notes. Redesigned: the SAVER learns its outcome from the
 * save_notepad ACK, never from a broadcast back to itself, and a foreign frame
 * is deferred while the box is focused so it can never yank the caret:
 *
 *   §C on socket 'connected' the app requests get_notepad and stores the
 *      revision the server reports;
 *   §S every save_notepad carries the revision the app last saw as
 *      base_revision, and adopts the ACK's revision synchronously — so a burst
 *      of saves from one device never self-conflicts;
 *   §U a notepad_updated broadcast (another device saved) refreshes the box
 *      and the stored revision WHEN the box is not focused;
 *   §D a foreign frame that arrives while the box IS focused is deferred: the
 *      box is left alone and adopts the frame on blur (the anti-jank pin);
 *   §K a stale save's ACK carries applied:false with the server truth; the box
 *      takes it and the user is told — the stale writer's text is not
 *      resurrected;
 *   §R a keystroke inside the previous save's round trip re-bases on that
 *      ACK's revision (saves are serialized) — no self-conflict toast;
 *   §R2 RTT SHORTER than the debounce: the second save flushes DIRECTLY (not
 *      queued) and re-bases on the first ACK's revision too — the production
 *      fast-typist path that used to erase the just-typed char;
 *   §I typing keeps working; the 300ms debounce still coalesces edits into
 *      one save.
 *
 * Run: node tests/browser/owner_batch_notepad_client.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = Array.isArray(actual) ? actual.join(', ') : actual;
    const e = Array.isArray(expected) ? expected.join(', ') : expected;
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${JSON.stringify(e)}\n        actual   ${JSON.stringify(a)}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png' };
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
        if (rel === '/' || rel === '/index.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); return; }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const STUBS = `
    const noop = () => {};
    window.__handlers = {};
    window.__emits = [];
    window.__notes = [];
    const record = (ev, fn) => { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); };
    // save_notepad now takes an ack callback. The test sets window.__ackNext to
    // the response the server would return; the stub invokes the callback with
    // it synchronously, mirroring the socket.io ack the real handler returns.
    window.__ackNext = null;
    window.io = () => ({ connected: true, id: 'self-sid', on: record, off: noop, once: record,
        emit: (ev, p, cb) => {
            window.__emits.push({ ev, p });
            if (typeof cb === 'function') {
                cb(window.__ackNext != null ? window.__ackNext : { applied: true, notepad: p?.text ?? '', revision: (p?.base_revision ?? 0) + 1 });
            }
        }, io: { on: noop } });
    window.socket = window.io();
    window.showNotification = (msg, type) => window.__notes.push({ msg: String(msg), type });
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show'), trapFocus: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(STUBS);
await page.goto(base, { waitUntil: 'load' });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
await page.waitForTimeout(150);

// §C: the 'connected' handshake requests the notepad.
await page.evaluate(() => {
    (window.__handlers['connected'] || []).forEach(fn => fn({ status: 'success' }));
});
await page.waitForTimeout(100);
const c1 = await page.evaluate(() =>
    window.__emits.filter(e => e.ev === 'get_notepad').length);
check('§C connected requests get_notepad', c1 >= 1, true);

// Server answers revision 3 with content.
await page.evaluate(() => {
    (window.__handlers['notepad_data'] || []).forEach(fn =>
        fn({ notepad: 'desktop truth', revision: 3 }));
});
await page.waitForTimeout(100);
const c2 = await page.evaluate(() => document.getElementById('sessionNotepad')?.value ?? null);
check('§C notepad_data paints the box', c2, 'desktop truth');

// §S: typing debounces into ONE save carrying the last-seen revision; the
// ack's revision is adopted synchronously.
await page.evaluate(() => {
    window.__emits.length = 0;
    // The server accepts and returns revision 4.
    window.__ackNext = { applied: true, notepad: 'desktop truth v2', revision: 4 };
});
const pad = await page.$('#sessionNotepad');
await pad.focus();
await pad.type(' v2', { delay: 20 });
await page.waitForTimeout(600);   // > 300ms debounce
const s1 = await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad');
    return { count: saves.length, payload: saves[0]?.p ?? null };
});
check('§S debounce coalesces edits into one save', s1.count, 1);
check('§S the save carries the last-seen revision as base_revision',
    s1.payload?.base_revision, 3);
check('§S the save text is the full edited content', s1.payload?.text, 'desktop truth v2');

// §S-2: a SECOND save while focused bases off the ACK's revision (4), never
// the stale 3 — this is the self-conflict the redesign kills. The box is
// focused throughout and is never overwritten by the saver's own save.
await page.evaluate(() => {
    window.__emits.length = 0;
    window.__ackNext = { applied: true, notepad: 'desktop truth v2!', revision: 5 };
});
await pad.type('!', { delay: 20 });
await page.waitForTimeout(600);
const s2 = await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad');
    return { base: saves[0]?.p?.base_revision ?? null, box: document.getElementById('sessionNotepad')?.value ?? null };
});
check('§S-2 the next save bases off the ACK revision, not the stale one', s2.base, 4);
check('§S-2 the saver box is never rewritten by its own save', s2.box, 'desktop truth v2!');

// §D: a foreign frame that arrives WHILE the box is focused is deferred — the
// box is left alone (no caret yank) and adopts the frame only on blur.
await page.evaluate(() => {
    window.__ackNext = null;
    (window.__handlers['notepad_updated'] || []).forEach(fn =>
        fn({ notepad: 'mobile wrote', revision: 8 }));
});
await page.waitForTimeout(100);
const d1 = await page.evaluate(() => ({
    box: document.getElementById('sessionNotepad')?.value ?? null,
    focused: document.activeElement === document.getElementById('sessionNotepad'),
}));
check('§D a foreign frame does NOT overwrite the focused box', d1.box, 'desktop truth v2!');
check('§D the box is still focused', d1.focused, true);
// Blur applies the deferred frame.
await page.evaluate(() => document.getElementById('sessionNotepad')?.blur());
await page.waitForTimeout(100);
const d2 = await page.evaluate(() => document.getElementById('sessionNotepad')?.value ?? null);
check('§D on blur the deferred frame is adopted', d2, 'mobile wrote');
// A subsequent save bases off the adopted revision 8.
await page.evaluate(() => {
    window.__emits.length = 0;
    window.__ackNext = { applied: true, notepad: 'mobile wrote?', revision: 9 };
});
await pad.focus();
await pad.type('?', { delay: 20 });
await page.waitForTimeout(600);
const d3 = await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad');
    return saves[0]?.p ?? null;
});
check('§D the next save bases off the adopted foreign revision', d3?.base_revision, 8);

// §U: a foreign frame while the box is NOT focused refreshes it immediately.
await page.evaluate(() => {
    document.getElementById('sessionNotepad')?.blur();
    (window.__handlers['notepad_updated'] || []).forEach(fn =>
        fn({ notepad: 'another device', revision: 11 }));
});
await page.waitForTimeout(100);
const u1 = await page.evaluate(() => document.getElementById('sessionNotepad')?.value ?? null);
check('§U an unfocused box adopts a foreign frame at once', u1, 'another device');

// §K: a STALE save's ack (applied:false) hands back the server truth. With the
// box unfocused the box takes it and the user is told.
await page.evaluate(() => {
    window.__emits.length = 0;
    window.__ackNext = { applied: false, notepad: 'server won', revision: 20 };
});
await pad.focus();
await pad.type('x', { delay: 20 });
await page.evaluate(() => document.getElementById('sessionNotepad')?.blur());
await page.waitForTimeout(600);
const k1 = await page.evaluate(() => ({
    box: document.getElementById('sessionNotepad')?.value ?? null,
    warned: !!document.querySelector(
        '#notificationContainer .notification-warning'),
}));
check('§K a stale ack overwrites the unfocused box with server truth', k1.box, 'server won');
check('§K the user is told about the conflict (real warning toast)', k1.warned, true);
// And the next save bases off revision 20 — the conflict is resolved forward.
await page.evaluate(() => {
    window.__emits.length = 0;
    window.__ackNext = { applied: true, notepad: 'server won+', revision: 21 };
});
await pad.focus();
await pad.type('+', { delay: 20 });
await page.waitForTimeout(600);
const k2 = await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad');
    return saves[0]?.p ?? null;
});
check('§K after conflict the save bases off the server revision', k2?.base_revision, 20);

// §R: A KEYSTROKE INSIDE THE PREVIOUS SAVE'S ROUND TRIP. Measured on the
// deployment (/tmp/ds/notepad_probe.mjs, RTT ~230ms): every second
// save went out with the pre-ACK revision, came back applied:false and raised
// the "changed on another device" toast with nobody else editing. The ack is
// therefore DELAYED here so the next keystroke lands before it, and the
// contract is: saves are serialized, the second one bases on the revision the
// first ACK taught, and no conflict toast appears on a single device.
await page.evaluate(() => {
    document.getElementById('sessionNotepad')?.blur();
    window.__emits.length = 0;
    window.__notes.length = 0;
    // Server state as the app believes it: revision 21 (from §K).
    let rev = 21;
    const realEmit = window.socket.emit;
    window.__restoreEmit = () => { window.socket.emit = realEmit; };
    window.socket.emit = (ev, p, cb) => {
        window.__emits.push({ ev, p });
        if (ev !== 'save_notepad' || typeof cb !== 'function') return;
        // A real server: stale base -> applied:false; fresh base -> bump.
        setTimeout(() => {
            if (p.base_revision !== rev) {
                cb({ applied: false, notepad: 'SERVER', revision: rev });
            } else {
                rev += 1;
                cb({ applied: true, notepad: p.text, revision: rev });
            }
        }, 450);
    };
});
await pad.focus();
await pad.type('a', { delay: 20 });
await page.waitForTimeout(400);   // > debounce: save #1 is on the wire, ack pending
await pad.type('b', { delay: 20 });
await page.waitForTimeout(400);   // save #2 debounced while #1 still in flight
await page.waitForTimeout(1500);  // both round trips complete
const r1 = await page.evaluate(() => {
    const saves = window.__emits.filter(e => e.ev === 'save_notepad').map(e => e.p);
    return {
        bases: saves.map(s => s.base_revision),
        texts: saves.map(s => s.text.slice(-2)),
        warnings: window.__notes.filter(n => n.type === 'warning').length,
        box: document.getElementById('sessionNotepad')?.value ?? null,
    };
});
check('§R two saves went out, serialized', r1.bases.length, 2);
check('§R the second save bases on the FIRST ack\'s revision (22), not the stale 21',
    r1.bases, [21, 22]);
check('§R the second save carries the newest text', r1.texts[1], 'ab');
check('§R no conflict toast on a single device typing through its own RTT',
    r1.warnings, 0);
check('§R the box keeps what the user typed', r1.box.endsWith('ab'), true);
await page.evaluate(() => window.__restoreEmit());

// §R2: RTT SHORTER THAN THE DEBOUNCE — the DIRECT-FLUSH self-conflict. §R uses a
// 450ms ack (> the 300ms debounce), so save #2 is always QUEUED behind an
// in-flight #1 and re-based by drainQueuedNotepadSave. Production RTT is
// ~90-230ms (< debounce), so #1's ack returns BEFORE #2's debounce fires and #2
// flushes DIRECTLY with the base it froze at input time. That frozen base is now
// stale (the ack advanced the revision), so the server refused it applied:false,
// the box adopted server truth over the focused caret and erased the just-typed
// char with a spurious toast. The contract: the direct flush re-bases too, so a
// single fast typist never self-conflicts and never loses a keystroke.
await page.evaluate(() => {
    document.getElementById('sessionNotepad')?.blur();
    window.__emits.length = 0;
    window.__notes.length = 0;
    window.__acks = [];
    // A faithful conditional server whose ACKs are RELEASED MANUALLY, so the
    // stale window is deterministic instead of a wall-clock race: the first save
    // defines the baseline; a later save carrying an out-of-date base is refused.
    // The gate lets the test type the second char WHILE save #1 is still in
    // flight (so it freezes the OLD base), then release #1's ack (advancing the
    // revision) BEFORE save #2 flushes directly. WITHOUT the direct-flush re-base
    // #2 goes out on the stale base and is REFUSED; WITH it #2 re-bases and
    // applies. (The applied:false path no longer toasts over a focused box, so
    // the discriminator is the refusal itself, not the toast.)
    let rev = null;
    window.__pendingAcks = [];
    const realEmit = window.socket.emit;
    window.__restoreEmit = () => { window.socket.emit = realEmit; };
    window.socket.emit = (ev, p, cb) => {
        window.__emits.push({ ev, p });
        if (ev !== 'save_notepad' || typeof cb !== 'function') return;
        window.__pendingAcks.push(() => {
            if (rev === null) rev = p.base_revision;
            const applied = p.base_revision === rev;
            window.__acks.push({ base: p.base_revision, applied });
            if (applied) {
                rev += 1;
                cb({ applied: true, notepad: p.text, revision: rev });
            } else {
                cb({ applied: false, notepad: 'SERVER', revision: rev });
            }
        });
    };
    window.__releaseAck = () => { const f = window.__pendingAcks.shift(); if (f) f(); };
});
await pad.focus();
await pad.type('a', { delay: 20 });
await page.waitForTimeout(340);   // > debounce: save #1 has flushed, its ack held
await pad.type('b', { delay: 20 });   // typed in flight -> freezes the OLD base
await page.waitForTimeout(50);
await page.evaluate(() => window.__releaseAck());   // #1 ack returns, advances revision
await page.waitForTimeout(340);   // > debounce: save #2 DIRECT-flushes, nothing in flight
await page.evaluate(() => window.__releaseAck());   // #2 ack
await page.waitForTimeout(120);
const r2 = await page.evaluate(() => ({
    acks: window.__acks,
    warnings: window.__notes.filter(n => n.type === 'warning').length,
    box: document.getElementById('sessionNotepad')?.value ?? null,
}));
check('§R2 two saves round-tripped', r2.acks.length, 2);
check('§R2 the second save was NOT refused (direct flush re-based off the ack)',
    r2.acks[1] && r2.acks[1].applied, true);
check('§R2 the second save based on the advanced revision, not the stale one',
    r2.acks[1] && r2.acks[1].base, r2.acks[0].base + 1);
check('§R2 no self-conflict toast for a single fast typist', r2.warnings, 0);
check('§R2 the box keeps the just-typed char', r2.box.endsWith('ab'), true);
await page.evaluate(() => window.__restoreEmit());

check('§Z no page errors', errors, []);
await ctx.close();
await browser.close();
server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
