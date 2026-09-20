/*
 * W14 item 6 — broadcast target picker gate.
 *
 * #composerTarget became a button opening an anchored checklist
 * (#broadcastTargetMenu) with stable selection semantics:
 *
 *   §A default Select All: opening Broadcast with 3 sendable sessions checks
 *      all 3 and the chip reads "3 / 3"-equivalent all-mode ("All 3").
 *   §B all-mode auto-include: a 4th session connecting while all-mode is
 *      active is selected automatically.
 *   §C custom subset: unchecking one row leaves all-mode; the chip switches
 *      to the x/y form; Send fans out to exactly the checked ids.
 *   §D blast radius held: while in custom mode a newly connected session
 *      appears in the list UNCHECKED and Send still hits only the subset.
 *   §E Select All re-arms all-mode and selects every current session.
 *   §F disconnect removal: a session dropping disappears from the list AND
 *      the selection; the count updates.
 *   §G empty selection blocks Send: notification path, zero emits.
 *   §H re-open defaults back to Select All (no stale subset).
 *
 * Run: node tests/browser/broadcast_target_picker.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
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
    window.__emits = [];
    window.socket = {
        connected: false,
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop,
        emit: (name, payload) => window.__emits.push({ name, payload }),
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket,
        configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

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
await page.waitForTimeout(120);

// Helpers driving the REAL production paths.
//
// Sessions are seeded as SENDABLE RECORDS directly (connected:true, not a
// candidate) rather than through createSession + assignSessionToPane: the
// pane assignment path activates EACH new session, and a newcomer evicting the
// previous pane owner rebinds the shared composer to a fresh per-session draft
// -- legitimate product behaviour, but not what this picker gate measures. The
// gate needs a stable composer draft across membership changes, and seeding
// records (with no pane takeover) is the same harness shape the lifecycle
// suites use.
const addSession = (id, host) => page.evaluate(({ id, host }) => {
    SessionManager.sessions[id] = {
        id, session_id: id, host, port: 22, username: 'bcast',
        authType: 'key', keyId: 'k1', jumpHostId: null, displayName: host,
        connected: true, isPersistentCandidate: false, tmuxSessionName: null,
        terminalId: null, useTmux: false, viaJump: null,
    };
}, { id, host });

const announceSendable = () => page.evaluate(() => SessionManager.notifySendableSessionsChanged());

const chipText = () => page.evaluate(() =>
    document.querySelector('#composerTarget .composer-target-label')?.textContent.trim() ?? '');

const menuRows = () => page.evaluate(() => {
    const menu = document.getElementById('broadcastTargetMenu');
    if (!menu || menu.hidden) return null;
    return [...menu.querySelectorAll('.broadcast-target-option')].map(r => ({
        label: r.querySelector('.broadcast-target-option-label')?.textContent.trim(),
        checked: r.getAttribute('aria-checked'),
        target: r.dataset.broadcastTarget ?? null,
    }));
});

const send = () => page.evaluate(() => {
    window.__emits.length = 0;
    window.commitTerminalDraft(document.getElementById('mobileInput'));
    return window.__emits.filter(x => x.name === 'ssh_input').map(x => x.payload);
});

// Seed three connected sendable sessions.
await addSession('bp-1', 'host-one.example');
await addSession('bp-2', 'host-two.example');
await addSession('bp-3', 'host-three.example');
await page.waitForTimeout(150);

// Type a one-line draft to broadcast.
await page.evaluate(() => {
    const el = document.getElementById('mobileInput');
    el.value = 'uptime';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(80);

// ── §A default Select All ───────────────────────────────────────────────────
await page.evaluate(() => window.BroadcastInput.show());
await page.waitForTimeout(100);
check('§A Broadcast opens with all-mode',
    await page.evaluate(() => BroadcastInput.allMode), true);
check('§A all three sessions selected by default',
    await page.evaluate(() => BroadcastInput.selectedCount()), 3);
check('§A chip shows the all-mode count', await chipText(), 'All 3');

// Open the picker: all rows checked, Select All checked.
await page.evaluate(() => BroadcastInput.openMenu());
await page.waitForTimeout(80);
let rows = await menuRows();
check('§A picker lists Select All + three sessions', rows?.length, 4);
check('§A every row starts checked',
    rows?.every(r => r.checked === 'true'), true);

// ── §B all-mode auto-include ────────────────────────────────────────────────
await addSession('bp-4', 'host-four.example');
await announceSendable();
await page.waitForTimeout(100);
check('§B a newcomer is selected automatically in all-mode',
    await page.evaluate(() => BroadcastInput.selectedCount()), 4);
check('§B the chip follows the new total', await chipText(), 'All 4');
rows = await menuRows();
check('§B the newcomer row appears checked',
    rows?.find(r => r.target === 'bp-4')?.checked, 'true');

// ── §C custom subset ────────────────────────────────────────────────────────
await page.evaluate(() => BroadcastInput.toggleSession('bp-2'));
await page.waitForTimeout(80);
check('§C unchecking leaves all-mode',
    await page.evaluate(() => BroadcastInput.allMode), false);
check('§C selection shrinks to three',
    await page.evaluate(() => BroadcastInput.selectedCount()), 3);
check('§C the chip switches to the x/y form', await chipText(), '3 / 4');
{
    const frames = await send();
    check('§C Send fans out to exactly the checked ids',
        frames.map(f => f.session_id).sort(), ['bp-1', 'bp-3', 'bp-4']);
    check('§C each frame carries the draft + CR',
        frames.every(f => f.data === 'uptime\r'), true);
}

// ── §D blast radius held ────────────────────────────────────────────────────
await addSession('bp-5', 'host-five.example');
await announceSendable();
await page.waitForTimeout(100);
check('§D newcomer in custom mode stays out of the selection',
    await page.evaluate(() => BroadcastInput.selected.has('bp-5')), false);
check('§D the chip counts x/y honestly', await chipText(), '3 / 5');
rows = await menuRows();
check('§D the newcomer row appears UNCHECKED',
    rows?.find(r => r.target === 'bp-5')?.checked, 'false');
{
    const frames = await send();
    check('§D Send still hits only the chosen subset',
        frames.map(f => f.session_id).sort(), ['bp-1', 'bp-3', 'bp-4']);
}

// ── §E Select All re-arms ───────────────────────────────────────────────────
await page.evaluate(() => BroadcastInput.selectAll());
await page.waitForTimeout(80);
check('§E Select All returns to all-mode',
    await page.evaluate(() => BroadcastInput.allMode), true);
check('§E every current session is selected',
    await page.evaluate(() => BroadcastInput.selectedCount()), 5);
check('§E the chip returns to the all-mode form', await chipText(), 'All 5');
rows = await menuRows();
check('§E the previously-unchecked newcomer is checked now',
    rows?.find(r => r.target === 'bp-5')?.checked, 'true');

// ── §F disconnect removal ───────────────────────────────────────────────────
await page.evaluate(() => {
    SessionManager.updateSessionStatus('bp-4', 'disconnected');
    SessionManager.notifySendableSessionsChanged();
});
await page.waitForTimeout(100);
check('§F a dropped session leaves the selection',
    await page.evaluate(() => BroadcastInput.selected.has('bp-4')), false);
check('§F the chip counts without it', await chipText(), 'All 4');
rows = await menuRows();
check('§F the dropped session is gone from the list',
    rows?.some(r => r.target === 'bp-4'), false);

// ── §G empty selection blocks Send ──────────────────────────────────────────
// The successful sends above CONSUMED the draft (clearOnSuccess is the product
// contract), so type a fresh line the blocked send must keep.
await page.evaluate(() => {
    const el = document.getElementById('mobileInput');
    el.value = 'uptime';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(80);
await page.evaluate(() => {
    for (const id of [...BroadcastInput.selected]) {
        BroadcastInput.toggleSession(id);
    }
});
await page.waitForTimeout(80);
check('§G the selection can be emptied',
    await page.evaluate(() => BroadcastInput.selectedCount()), 0);
{
    const frames = await send();
    check('§G Send emits nothing on an empty selection', frames, []);
    check('§G the draft survives the blocked send',
        await page.evaluate(() => document.getElementById('mobileInput').value), 'uptime');
}

// ── §H re-open defaults to Select All ───────────────────────────────────────
await page.evaluate(() => window.BroadcastInput.close());
await page.waitForTimeout(60);
await page.evaluate(() => window.BroadcastInput.show());
await page.waitForTimeout(80);
check('§H re-opening Broadcast restarts in all-mode',
    await page.evaluate(() => BroadcastInput.allMode), true);
check('§H the stale empty subset is gone',
    await page.evaluate(() => BroadcastInput.selectedCount()), 4);
check('§H the chip shows the all-mode count', await chipText(), 'All 4');

check('§Z no page errors', errors, []);

await ctx.close();
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
