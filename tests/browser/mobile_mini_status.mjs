/*
 * W14 item 3 — mobile mini status bar contract gate.
 *
 * The touch shell gained a compact status band (#mobileMiniStatus) below the
 * composer: the active session's connection dot + state word + latency, the
 * desktop #statusBar pattern shrunk to one line. This suite pins the bar's
 * OWN contracts (mobile_shell_layout.mjs pins the dock geometry that now
 * accounts for the band):
 *
 *   §V1 visibility by tier — visible on phone AND tablet touch shells,
 *       hidden on desktop (fine pointer) and on short landscape touch
 *       (the nested block zeroes the band token there);
 *   §B  the band's measured box equals the --mobile-status-band height term
 *       that the dock budget charges for it, and the dock's outer height
 *       exceeds the composer by exactly band + paddings + border (no
 *       overlay, no magic constants);
 *   §W  the dock sits BELOW the workspace, not over it;
 *   §S  state flow through the REAL production paths: seeding the active
 *       session dispatches sshdeck:active-session-changed; connect/disconnect
 *       go through SessionManager.updateSessionStatus (which fires
 *       sshdeck:session-status-changed); the latency figure arrives as the
 *       scripted `session_latency` server frame through the registered
 *       production handler (the same frame the 15 s poll delivers live).
 *       A control byte never enters this bar — it is display-only;
 *   §Z  zero page errors on every tier.
 *
 * Run: node tests/browser/mobile_mini_status.mjs   (from source/)
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
    // The real socket.io client's UMD tail assigns window.io AFTER init
    // scripts run; the latency flow below must hit the stub handler registry.
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

// Handler-recording socket stub: app.js's first statement is
// `window.socket = io(...)`, so `io` must resolve to the stub; it is
// installed as a non-configurable getter so a real client library could not
// overwrite it even if loaded.
const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = {
        connected: false,
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop },
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

async function newPage(w, h, touch) {
    const ctx = await browser.newContext({
        viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch,
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
    return { ctx, page, errors };
}

// §V1 visibility by tier: phone and tablet show the band; desktop (fine
// pointer) keeps it display:none; short landscape touch re-hides it and
// zeroes the band token.
for (const [label, w, h, touch, expected] of [
    ['phone', 390, 844, true, 'flex'],
    ['tablet', 768, 1024, true, 'flex'],
    ['desktop', 1440, 900, false, 'none'],
    ['short landscape', 820, 360, true, 'none'],
]) {
    const { ctx, page, errors } = await newPage(w, h, touch);
    const info = await page.evaluate(() => {
        const bar = document.getElementById('mobileMiniStatus');
        return {
            display: bar ? getComputedStyle(bar).display : 'MISSING',
            token: getComputedStyle(document.documentElement)
                .getPropertyValue('--mobile-status-band').trim(),
        };
    });
    check(`§V1 ${label}: the mini status bar display`, info.display, expected);
    check(`§V1 ${label}: no page errors`, errors, []);
    await ctx.close();
}

// §B + §W + §S run on the phone shell, the tier the band was built for.
const { ctx, page, errors } = await newPage(390, 844, true);

const SID = 'MINI-STATUS-1';
await page.evaluate((sid) => {
    // Seed one ACTIVE session through the production session registry and
    // announce it through the same event the tab/select path dispatches.
    const SM = SessionManager;
    SM.sessions[sid] = { id: sid, session_id: sid, host: 'ms.example', port: 22,
        username: 'ms', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: 'Mini', connected: false, isPersistentCandidate: false,
        tmuxSessionName: null, terminalId: null, useTmux: false, viaJump: null };
    SM.activeSessionId = sid;
    document.dispatchEvent(new CustomEvent('sshdeck:active-session-changed', {
        detail: { sessionId: sid },
    }));
}, SID);
await page.waitForTimeout(80); // rAF-coalesced refresh

// §B — the band's box IS the height term the dock budget charges.
const band = await page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const bar = document.getElementById('mobileMiniStatus');
    const dock = document.getElementById('sessionBar');
    const composer = document.getElementById('mobileInputBar');
    const dockCs = getComputedStyle(dock);
    return {
        tokenPx: parseInt(cs.getPropertyValue('--mobile-status-band'), 10),
        barH: Math.round(bar.getBoundingClientRect().height),
        dockH: Math.round(dock.getBoundingClientRect().height),
        composerH: Math.round(composer.getBoundingClientRect().height),
        padTop: parseFloat(dockCs.paddingTop),
        padBottom: parseFloat(dockCs.paddingBottom),
        borderTop: parseFloat(dockCs.borderTopWidth),
        ws: document.getElementById('terminalsContainer').getBoundingClientRect().bottom,
        dockTop: dock.getBoundingClientRect().top,
    };
});
check('§B the --mobile-status-band token is a real height term', band.tokenPx > 0, true);
check('§B the bar box equals its height term', band.barH, band.tokenPx);
check('§B the dock charges exactly band + paddings + border beyond the composer',
    band.dockH - band.composerH, band.tokenPx + band.padTop + band.padBottom + band.borderTop);
check('§W the dock sits below the workspace, never over it',
    band.dockTop >= band.ws - 1, true);

// §S — state flow through the real production paths.
const readBar = () => page.evaluate(() => {
    const bar = document.getElementById('mobileMiniStatus');
    const text = document.getElementById('mobileMiniStatusText');
    const dot = document.getElementById('mobileMiniStatusDot');
    return {
        state: bar.dataset.state,
        text: text.textContent.trim(),
        i18n: text.getAttribute('data-i18n'),
        dot: dot.className.split(/\s+/).filter(c => c !== 'status-dot'),
        latency: document.getElementById('mobileMiniStatusLatency').textContent.trim(),
    };
});

let s = await readBar();
check('§S1 seeded disconnected session reads Disconnected', s.text, 'Disconnected');
check('§S1 the disconnected dot carries the disconnected state class', s.dot, ['disconnected']);
check('§S1 the state word keeps its i18n binding', s.i18n, 'status.disconnected');
check('§S1 latency stays blank while disconnected', s.latency, '');

await page.evaluate((sid) => SessionManager.updateSessionStatus(sid, 'connected'), SID);
await page.waitForTimeout(80);
s = await readBar();
check('§S2 updateSessionStatus(connected) flips the bar to Connected', s.text, 'Connected');
check('§S2 the dot follows the connection state', s.dot, ['connected']);

// The 15 s poll's answer, scripted: the registered production handler
// applies it exactly as live traffic would.
await page.evaluate((sid) => {
    (window.__socketHandlers['session_latency'] || [])
        .forEach(cb => cb({ session_id: sid, latency_ms: 32 }));
}, SID);
await page.waitForTimeout(80);
s = await readBar();
check('§S3 the session_latency frame renders its figure', s.latency, '32 ms');

await page.evaluate((sid) => SessionManager.updateSessionStatus(sid, 'disconnected'), SID);
await page.waitForTimeout(80);
s = await readBar();
check('§S4 disconnect returns the bar to Disconnected', s.text, 'Disconnected');
check('§S4 the dot returns to the disconnected state', s.dot, ['disconnected']);
check('§S4 the latency figure clears with the connection', s.latency, '');

check('§Z no page errors on the state-flow shell', errors, []);

await ctx.close();
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
