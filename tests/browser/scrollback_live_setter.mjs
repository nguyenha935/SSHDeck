#!/usr/bin/env node
/*
 * S2 / T-SB7..T-SB9 -- the Settings scrollback control, through the handler
 * app.js really registers.
 *
 * S1 gave `new Terminal({scrollback})` a single strict contract
 * (TerminalManager.sanitizeScrollback). The Settings input never used it: the
 * change handler carried its own validation --
 *
 *     let val = parseInt(scrollbackInput.value, 10);
 *     if (isNaN(val) || val < 50) val = 50;
 *     if (val > 10000) val = 10000;
 *
 * -- which disagrees with the shared contract in two ways a user can see.
 * `parseInt` reads a numeric PREFIX, so '1e3' becomes 1 and '1.5' becomes 1;
 * and every malformed value (including '0', xterm's "no scrollback" sentinel)
 * collapses to the FLOOR, 50, where the shared contract says "nothing usable
 * was given, use the DEFAULT". The same stored string therefore produced 50
 * lines on the live terminals and the default on the next reload -- two answers
 * from one setting -- and a second copy of the bounds sat in a second file, free
 * to drift from the input's own min/max.
 *
 * S16 D4-H1: that default is no longer the literal 150 this file asserted. It is
 * DERIVED from the server's replay line cap -- min(SCROLLBACK_MAX,
 * serverReplayLines) -- because the client kept 150 lines while the restore path
 * was prepared to send 5000, so history the server had already delivered was
 * discarded on arrival. The rows below therefore read the default from
 * TerminalManager.SCROLLBACK_DEFAULT. The property under test is unchanged and
 * undiminished: malformed input must reach the DEFAULT, which each row still
 * distinguishes from the floor (50), the ceiling (10000) and every
 * numeric-prefix misreading; section 3 additionally asserts the derivation, so
 * the default cannot quietly collapse onto the floor and make this file vacuous.
 *
 * D-8 (plan section 6.4, plan line 1317) settles the rest: the same sanitizer
 * runs before EVERY live `options.scrollback` assignment, malformed UI/storage
 * data normalises to the default, and a finite value is clamped to 50..10000.
 * The plan's
 * older phrasing for T-SB7 ("rejected, terminal keeps its previous value")
 * predates that rule; D-8's normalisation is what is implemented, and the
 * invariant both express -- no NaN and no engine-interpreted value ever reaches
 * a live terminal -- is asserted in section 3.
 *
 * Why this file drives the real page rather than the sanitizer:
 *
 *   - the defect is in the WIRING, so a direct sanitizeScrollback() call proves
 *     nothing here. Every row below sets #scrollbackInput and dispatches a
 *     `change` event, which is the only thing the app itself does;
 *   - `#scrollbackInput` is `type="number"`, and the DOM sanitises the value
 *     BEFORE any handler sees it: 'abc' and '12abc' arrive as '', while '1e3',
 *     '1.5', '0' and '-5' arrive verbatim because they are valid
 *     floating-point numbers. Each row therefore asserts what the handler
 *     actually received (`seen`) as its own premise -- otherwise a row could
 *     pass while testing a value that never arrived;
 *   - the terminals are built through the shipped `createTerminal`, so
 *     `TerminalManager.terminals` holds real xterm objects and
 *     `options.scrollback` is read back off the engine, not off a stub.
 *
 * Baseline 777 is deliberately neither an expected result nor the default, so a
 * row can only pass if the handler really wrote the value.
 *
 * Run: node tests/browser/scrollback_live_setter.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BASELINE = 777;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
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
    '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
};

function renderTemplate(name) {
    let html = fs.readFileSync(path.join(ROOT, `templates/${name}.html`), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const INDEX = renderTemplate('index');

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        if (rel === '' || rel === 'index') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(INDEX);
            return;
        }
        const fp = path.join(ROOT, rel);
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

/* app.js runs `window.socket = io()` and the settings block lives in the same
 * DOMContentLoaded handler, so the socket has to exist for the registration to
 * be reached at all. Same stub set as w7_scroll_scope.mjs; it touches neither
 * localStorage nor TerminalManager. */
const INIT_SCRIPT = `
    const noop = () => {};
    window.io = () => ({
        connected: true, on: noop, off: noop, once: noop, emit: noop,
        io: { on: noop },
    });
    window.socket = window.io();
    window.showNotification = noop;
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.route('**/socket.io.min.js*', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.addInitScript(INIT_SCRIPT);
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(
    () => window.TerminalManager && typeof SessionManager !== 'undefined' && !!window.socket,
    null, { timeout: 10000 });

/*
 * Section 1 -- the harness is the real app, so a value below is a result and
 * not a missing dependency.
 */
console.log('--- 1. environment ---');
check('no uncaught page error during load', pageErrors.join(' | '), '');
check('the real terminal manager is loaded',
    await page.evaluate(() => typeof window.TerminalManager), 'object');
check('the S1 sanitizer is available to the settings path',
    await page.evaluate(() => typeof window.TerminalManager.sanitizeScrollback), 'function');
check('the Settings control exists on the page',
    await page.evaluate(() => !!document.getElementById('scrollbackInput')), true);
check('the Settings control is a number input',
    await page.evaluate(() => document.getElementById('scrollbackInput').type), 'number');

// Two live terminals, built the way a session does, so "every existing
// terminal" is a claim with more than one subject.
const built = await page.evaluate(() => {
    try {
        localStorage.setItem('terminalScrollback', '500');
        window.TerminalManager.createTerminal('s2-a');
        window.TerminalManager.createTerminal('s2-b');
        return {
            keys: Object.keys(window.TerminalManager.terminals)
                .filter(k => k.startsWith('s2-')).join(','),
            a: window.TerminalManager.terminals['s2-a'].options.scrollback,
            b: window.TerminalManager.terminals['s2-b'].options.scrollback,
        };
    } catch (e) {
        return { keys: e.constructor.name + ': ' + e.message, a: null, b: null };
    }
});
check('two live terminals exist in the manager', built.keys, 's2-a,s2-b');
check('they were built through the shipped path (stored 500 honoured)',
    `${built.a}/${built.b}`, '500/500');

/*
 * Section 2 -- the rows themselves.
 *
 * `seen` is the value the DOM handed the handler; it is asserted first because
 * `type="number"` rewrites some of these before any JavaScript runs, and a row
 * that silently tested '' instead of '12abc' would be worthless.
 */
async function drive({ raw, asText = false }) {
    return page.evaluate(({ raw, asText, baseline }) => {
        const out = { error: '' };
        try {
            const input = document.getElementById('scrollbackInput');
            const TM = window.TerminalManager;

            localStorage.setItem('terminalScrollback', String(baseline));
            TM.terminals['s2-a'].options.scrollback = baseline;
            TM.terminals['s2-b'].options.scrollback = baseline;

            // Delegation is observed, not grepped: whatever the handler asks
            // the shared contract is recorded here.
            const calls = [];
            const original = TM.sanitizeScrollback;
            TM.sanitizeScrollback = function (value) {
                calls.push(String(value));
                return original.call(this, value);
            };

            if (asText) input.type = 'text';
            input.value = raw;
            out.seen = input.value;
            input.dispatchEvent(new Event('change', { bubbles: true }));

            TM.sanitizeScrollback = original;
            if (asText) input.type = 'number';

            out.calls = calls.join('|');
            out.stored = localStorage.getItem('terminalScrollback');
            out.echoed = input.value;
            out.termA = TM.terminals['s2-a'].options.scrollback;
            out.termB = TM.terminals['s2-b'].options.scrollback;
        } catch (e) {
            out.error = e.constructor.name + ': ' + e.message;
        }
        return out;
    }, { raw, asText, baseline: BASELINE });
}

// S16 D4-H1: read the derived default from the shipped manager rather than
// restating a literal that is now computed.
const DEFAULT = await page.evaluate(
    () => window.TerminalManager.SCROLLBACK_DEFAULT);

const CASES = [
    { id: 'T-SB7a', what: "garbage 'abc' typed into the field", raw: 'abc', seen: '', expect: DEFAULT },
    { id: 'T-SB7b', what: 'the field cleared', raw: '', seen: '', expect: DEFAULT },
    { id: 'T-SB7c', what: "numeric prefix '12abc'", raw: '12abc', seen: '', expect: DEFAULT },
    { id: 'T-SB8a', what: "exponent form '1e3'", raw: '1e3', seen: '1e3', expect: DEFAULT },
    { id: 'T-SB8b', what: "decimal '1.5'", raw: '1.5', seen: '1.5', expect: DEFAULT },
    { id: 'T-SB8c', what: "zero, xterm's no-scrollback sentinel", raw: '0', seen: '0', expect: DEFAULT },
    // The handler must do its own validation rather than lean on the input's
    // type. Switching the type is a test-only manipulation of the DOM (no
    // source change) and is the only way to hand the handler a raw string.
    {
        id: 'T-SB8d', what: "'12abc' delivered verbatim (type switched, test-only)",
        raw: '12abc', seen: '12abc', expect: DEFAULT, asText: true,
    },
    { id: 'T-SB9a', what: "negative '-5'", raw: '-5', seen: '-5', expect: 50 },
    { id: 'T-SB9b', what: "below the floor '20'", raw: '20', seen: '20', expect: 50 },
    { id: 'T-SB9c', what: "at the floor '50'", raw: '50', seen: '50', expect: 50 },
    { id: 'T-SB9d', what: "at the ceiling '10000'", raw: '10000', seen: '10000', expect: 10000 },
    { id: 'T-SB9e', what: "above the ceiling '50000'", raw: '50000', seen: '50000', expect: 10000 },
    { id: 'T-SB9f', what: "a legitimate in-range value '2000'", raw: '2000', seen: '2000', expect: 2000 },
];

console.log('\n--- 2. change event on #scrollbackInput -> storage + live terminals ---');
const assigned = [];
for (const c of CASES) {
    const r = await drive(c);
    check(`${c.id} ${c.what}: no error on the handler path`, r.error, '');
    check(`${c.id} ${c.what}: the handler received ${JSON.stringify(c.seen)}`, r.seen, c.seen);
    check(`${c.id} ${c.what}: persisted "${c.expect}"`, r.stored, String(c.expect));
    check(`${c.id} ${c.what}: the field shows "${c.expect}"`, r.echoed, String(c.expect));
    check(`${c.id} ${c.what}: live terminal s2-a holds ${c.expect}`, r.termA, c.expect);
    check(`${c.id} ${c.what}: live terminal s2-b holds ${c.expect}`, r.termB, c.expect);
    assigned.push(r.termA, r.termB);
    if (c.id === 'T-SB8a' || c.id === 'T-SB9f') {
        // One rejected value and one accepted one: both must be decided by the
        // shared contract, asked exactly once, with what the field held.
        check(`${c.id} ${c.what}: decided by the shared sanitizer, once`, r.calls, c.seen);
    }
}

/*
 * Section 3 -- the invariant behind the rows, and the range they share.
 *
 * D-8's whole point is that nothing an engine has to interpret survives this
 * path, so the assignments are also checked as a set.
 */
console.log('\n--- 3. invariant and shared range ---');
check('every value assigned to a live terminal is an integer in [50, 10000]',
    assigned.every(v => Number.isInteger(v) && v >= 50 && v <= 10000), true);
check('no value assigned to a live terminal is NaN',
    assigned.some(v => typeof v === 'number' && Number.isNaN(v)), false);

const bounds = await page.evaluate(() => {
    const input = document.getElementById('scrollbackInput');
    const TM = window.TerminalManager;
    return {
        min: TM.SCROLLBACK_MIN, max: TM.SCROLLBACK_MAX, def: TM.SCROLLBACK_DEFAULT,
        serverCap: TM.serverReplayLines ?? TM.SERVER_REPLAY_LINES_FALLBACK,
        inputMin: input.getAttribute('min'), inputMax: input.getAttribute('max'),
    };
});
check('the sanitizer floor is the one the plan names', bounds.min, 50);
check('the sanitizer ceiling is the one the plan names', bounds.max, 10000);
// S16 D4-H1: the default is derived, so what is pinned is the DERIVATION, not a
// literal. The floor/ceiling rows above are unchanged -- those are still fixed.
check('the sanitizer default is derived from the server replay cap',
    bounds.def, Math.max(bounds.min, Math.min(bounds.max, bounds.serverCap)));
check('the default is not the floor (the rows above stay meaningful)',
    bounds.def !== bounds.min, true);
check('the input floor still matches the sanitizer', bounds.inputMin, String(bounds.min));
check('the input ceiling still matches the sanitizer', bounds.inputMax, String(bounds.max));

/*
 * Section 4 -- one owner in the source, so the duplicate cannot come back.
 *
 * Static, and deliberately secondary to the measured rows above: it is the
 * cheapest guard against a second copy of the bounds reappearing beside the
 * delegation and drifting from it.
 */
console.log('\n--- 4. no second copy of the contract in app.js ---');
const appSrc = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');
check('app.js delegates to the shared sanitizer exactly once',
    (appSrc.match(/TerminalManager\.sanitizeScrollback\(/g) || []).length, 1);
check('app.js no longer parses the control itself',
    /parseInt\(\s*scrollbackInput\.value/.test(appSrc), false);

await context.close();
await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
