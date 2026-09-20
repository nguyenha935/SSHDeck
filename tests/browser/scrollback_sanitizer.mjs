/*
 * Scrollback capacity is user data, and xterm does not defend itself against it.
 *
 * The stored value comes from localStorage (`terminalScrollback`), written by
 * the Settings input. createTerminal used to hand it to the Terminal
 * constructor through a bare parseInt, which is not a validation:
 *
 *   'abc'    -> NaN     -> `new Terminal` throws RangeError: Invalid array
 *                          length. createTerminal throws, and because every
 *                          session restore builds its terminal through it, the
 *                          whole restore dies -- one bad string and the app is
 *                          empty on load.
 *   '12abc'  -> 12      -> parseInt takes the numeric PREFIX, so garbage is
 *   '1e3'    -> 1          silently accepted as a 1-to-12 line scrollback.
 *   '1.5'    -> 1
 *   '0'      -> 0       -> a terminal with no scrollback at all.
 *   '-5'     -> -5      -> the engine substitutes 1000, undocumented.
 *   '999999' -> 999999  -> accepted unclamped; the buffer is user-unbounded.
 *
 * sanitizeScrollback normalises the value BEFORE the engine sees it, so none of
 * those engine behaviours is reachable from app data any more. Two deliberately
 * different rules, both asserted below:
 *
 *   - not a well-formed integer (including 0, xterm's "no scrollback"
 *     sentinel) -> the DEFAULT capacity, i.e. "nothing usable is stored";
 *   - a well-formed integer out of range -> clamped into [50, 10000], so a
 *     stale or hand-edited bound still yields a working terminal.
 *
 * S16 D4-H1: the default is no longer the literal 150 this file used to assert.
 * It is DERIVED -- `min(SCROLLBACK_MAX, serverReplayLines)` -- because the client
 * kept 150 lines while the server's restore path was prepared to send 5000, so
 * history the server had already delivered was discarded on arrival (measured:
 * 195 of 400 clean-replay lines reachable). Every row below now reads the
 * default from `TerminalManager.SCROLLBACK_DEFAULT` instead of hard-coding it.
 * That is deliberate and is NOT a weakening: the property under test here was
 * never the number, it was "a malformed stored value routes to the default
 * rather than to the floor or to the engine" -- and each row still distinguishes
 * the default from the floor (50), from the ceiling (10000) and from any
 * numeric-prefix misreading, all of which are different values. A companion row
 * asserts the derivation itself, so the default cannot silently become the floor
 * and make this file vacuous.
 *
 * The checks run through the SHIPPED path -- the real vendored xterm build and
 * the real terminal-manager.js, over a real HTTP origin so localStorage behaves
 * as it does live -- because the defect is in what the constructor receives,
 * which no source-text assertion can see. Section 1 poisons localStorage BEFORE
 * the page's own bootstrap runs, which is the actual user-visible failure (the
 * restore dying), not a synthetic call.
 *
 * Run: node tests/browser/scrollback_sanitizer.mjs   (from source/)
 * Exit code 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

// Minimal static server rooted at source/, so /static/vendor/... resolves to
// the exact files the app serves and /tests/browser/fixture.html is the page.
function startServer() {
    const server = http.createServer((req, res) => {
        try {
            const urlPath = decodeURIComponent(req.url.split('?')[0]);
            const filePath = path.join(sourceRoot, urlPath.replace(/^\/+/, ''));
            if (!filePath.startsWith(sourceRoot)) {
                res.writeHead(403); res.end('forbidden'); return;
            }
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
            });
            fs.createReadStream(filePath).pipe(res);
        } catch (e) {
            res.writeHead(500); res.end(String(e));
        }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

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

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

/*
 * Section 1 -- the failure as a user meets it.
 *
 * fixture.html builds its terminal through the shipped createTerminal in a
 * top-level script, exactly as a session restore does. Poisoning localStorage
 * from an init script (which runs before any page script) reproduces the real
 * sequence: a value stored by an earlier visit, read on the next load. If
 * createTerminal throws, the bootstrap dies and window.__probe never exists --
 * which is precisely what "the restore dies" means.
 */
{
    console.log('--- 1. page bootstrap survives a poisoned stored value ---');
    const context = await browser.newContext();
    await context.addInitScript(() => {
        try { localStorage.setItem('terminalScrollback', 'abc'); } catch (e) { /* opaque origin */ }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(`${e.name}: ${e.message}`));
    await page.goto(`${base}/tests/browser/fixture.html`, { waitUntil: 'load' });

    // Guards this section: if the init script had not landed, the fixture would
    // boot on the default and every assertion below would pass vacuously.
    check('T-SB1 the poisoned value really was stored before the bootstrap ran',
        await page.evaluate(() => localStorage.getItem('terminalScrollback')), 'abc');
    check('T-SB1 the bootstrap completed (no uncaught error during load)',
        pageErrors.join(' | '), '');
    check('T-SB1 the terminal exists after a poisoned load',
        await page.evaluate(() => typeof window.__probe?.term), 'object');
    check('T-SB1 the poisoned load falls back to the default capacity',
        await page.evaluate(() => window.__probe?.term?.options?.scrollback),
        await page.evaluate(() => window.TerminalManager.SCROLLBACK_DEFAULT));
    // Non-vacuity for the row above: the default must be a DISTINCT value, not
    // the floor the clamp would also produce.
    check('T-SB1 the default is distinguishable from the clamp floor',
        await page.evaluate(() => window.TerminalManager.SCROLLBACK_DEFAULT
            !== window.TerminalManager.SCROLLBACK_MIN), true);

    await context.close();
}

const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${base}/tests/browser/fixture.html`, { waitUntil: 'load' });

// Guards every section below: these are the real shipped objects, so a 150 or a
// throw is a result and not a missing dependency.
console.log('\n--- environment ---');
check('the real vendored xterm is loaded',
    await page.evaluate(() => typeof window.Terminal), 'function');
check('the real terminal-manager is loaded',
    await page.evaluate(() => typeof window.TerminalManager), 'object');
check('sanitizeScrollback is exposed on the manager',
    await page.evaluate(() => typeof window.TerminalManager.sanitizeScrollback), 'function');

/*
 * S16 D4-H1: the derived default, asserted here so every "-> DEFAULT" row below
 * is anchored to a value this file has independently checked rather than to
 * whatever the manager happens to say.
 */
const DEFAULT = await page.evaluate(
    () => window.TerminalManager.SCROLLBACK_DEFAULT);
const SB_MIN = await page.evaluate(() => window.TerminalManager.SCROLLBACK_MIN);
const SB_MAX = await page.evaluate(() => window.TerminalManager.SCROLLBACK_MAX);
console.log(`\n--- 1b. the derived default (S16 D4-H1) ---`);
check('the default is derived from the server replay cap, clamped to the range',
    DEFAULT, Math.max(SB_MIN, Math.min(SB_MAX,
        await page.evaluate(() => window.TerminalManager.serverReplayLines
            ?? window.TerminalManager.SERVER_REPLAY_LINES_FALLBACK))));
check('the compile-time fallback equals the server cap it mirrors',
    await page.evaluate(
        () => window.TerminalManager.SERVER_REPLAY_LINES_FALLBACK), 5000);
check('a learned server cap moves the default',
    await page.evaluate(() => {
        const tm = window.TerminalManager;
        const before = tm.serverReplayLines;
        tm.noteServerReplayLines(777);
        const derived = tm.SCROLLBACK_DEFAULT;
        tm.serverReplayLines = before;
        return derived;
    }), 777);
check('a malformed server cap leaves the default alone',
    await page.evaluate(() => {
        const tm = window.TerminalManager;
        const before = tm.serverReplayLines;
        tm.noteServerReplayLines('lots');
        const derived = tm.SCROLLBACK_DEFAULT;
        tm.serverReplayLines = before;
        return derived;
    }), DEFAULT);
check('the derived default is not the floor (rows below stay meaningful)',
    DEFAULT !== SB_MIN, true);

/*
 * Section 2 -- the stored value, through the shipped createTerminal.
 *
 * Each case stores a value, builds a terminal the way a restore does, and reads
 * back what the ENGINE ended up holding. A throw is reported as a value so a
 * failure names the defect instead of aborting the run.
 */
{
    console.log('\n--- 2. createTerminal(): stored value -> engine capacity ---');
    const CASES = [
        ['T-SB1 ', 'abc', DEFAULT],
        ['T-SB2 ', '12abc', DEFAULT],
        ['T-SB3 ', '0', DEFAULT],
        ['T-SB4 ', '-5', 50],
        ['T-SB5 ', '999999', 10000],
        ['T-SB6a', '1e3', DEFAULT],
        ['T-SB6b', '1.5', DEFAULT],
        ['T-SB6c', ' 200 ', 200],
    ];

    for (const [id, stored, expected] of CASES) {
        const actual = await page.evaluate(([stored, key]) => {
            localStorage.setItem('terminalScrollback', stored);
            try {
                const term = window.TerminalManager.createTerminal(key);
                const capacity = term.options.scrollback;
                window.TerminalManager.destroyTerminal(key);
                return capacity;
            } catch (e) {
                return `${e.constructor.name}: ${e.message}`;
            }
        }, [stored, `sb-${stored}`]);
        check(`${id} stored ${JSON.stringify(stored)} -> ${expected} lines`, actual, expected);
    }

    /*
     * Companion to the whole section. Every case above expects a sane number,
     * so a sanitizer that always returned the default would pass most of them:
     * a legitimate value must still arrive unchanged, and the absence of a
     * stored value must still mean the default.
     */
    check('a legitimate stored value is passed through untouched',
        await page.evaluate(() => {
            try {
                localStorage.setItem('terminalScrollback', '500');
                const term = window.TerminalManager.createTerminal('sb-legit');
                const capacity = term.options.scrollback;
                window.TerminalManager.destroyTerminal('sb-legit');
                return capacity;
            } catch (e) {
                return e.constructor.name + ': ' + e.message;
            }
        }), 500);
    check('no stored value means the default capacity',
        await page.evaluate(() => {
            try {
                localStorage.removeItem('terminalScrollback');
                const term = window.TerminalManager.createTerminal('sb-unset');
                const capacity = term.options.scrollback;
                window.TerminalManager.destroyTerminal('sb-unset');
                return capacity;
            } catch (e) {
                return e.constructor.name + ': ' + e.message;
            }
        }), DEFAULT);
}

/*
 * Section 3 -- the sanitizer's own contract.
 *
 * S2 will call this same function on the live-assignment path, where the input
 * is whatever the Settings input yields rather than a localStorage string, so
 * the number and empty forms are part of the contract even though createTerminal
 * only ever passes a string or null.
 */
{
    console.log('\n--- 3. sanitizeScrollback() contract ---');
    const CONTRACT = [
        ['null', null, DEFAULT],
        ['undefined', undefined, DEFAULT],
        ['empty string', '', DEFAULT],
        ['whitespace only', '   ', DEFAULT],
        ['non-numeric string', 'abc', DEFAULT],
        ['numeric prefix', '12abc', DEFAULT],
        ['exponent form', '1e3', DEFAULT],
        ['decimal string', '1.5', DEFAULT],
        ['zero', '0', DEFAULT],
        ['negative', '-5', 50],
        ['below the floor', '20', 50],
        ['at the floor', '50', 50],
        ['at the ceiling', '10000', 10000],
        ['above the ceiling', '999999', 10000],
        ['padded integer', ' 200 ', 200],
        ['explicit plus', '+300', 300],
        ['NaN as a number', Number.NaN, DEFAULT],
        ['Infinity as a number', Number.POSITIVE_INFINITY, DEFAULT],
        ['number below the floor', 20, 50],
        ['number above the ceiling', 50000, 10000],
        ['number in range', 400, 400],
    ];

    for (const [label, input, expected] of CONTRACT) {
        // Reported, not thrown: a missing or broken sanitizer must show up as
        // a named red row, which is what the mutation check reads.
        const actual = await page.evaluate((value) => {
            try {
                return window.TerminalManager.sanitizeScrollback(value);
            } catch (e) {
                return e.constructor.name + ': ' + e.message;
            }
        }, input);
        check(`sanitize ${label} -> ${expected}`, actual, expected);
    }

    // The output must always be usable as an array length, which is what the
    // constructor does with it -- an integer is part of the contract, not a
    // by-product of the inputs chosen above.
    check('every sanitized value is a non-negative integer',
        await page.evaluate(() => {
            try {
                return ['abc', '0', '-5', '999999', '1.5', 7.9, null]
                    .every(v => Number.isInteger(window.TerminalManager.sanitizeScrollback(v)));
            } catch (e) {
                return e.constructor.name + ': ' + e.message;
            }
        }), true);
}

/*
 * Section 4 -- the premise of this whole file.
 *
 * If a future xterm defended itself, the sanitizer would still be correct but
 * these tests would no longer be protecting anything, and the comments above
 * would be wrong. Assert the engine behaviour the fix exists for, so the day it
 * changes, this file says so instead of quietly passing.
 */
{
    console.log('\n--- 4. the engine behaviour the sanitizer exists for ---');
    const raw = await page.evaluate(() => {
        const attempt = (value) => {
            try {
                return { ok: true, value: new window.Terminal({ scrollback: value }).options.scrollback };
            } catch (e) {
                return { ok: false, error: e.constructor.name };
            }
        };
        return {
            nan: attempt(Number.NaN), zero: attempt(0),
            negative: attempt(-5), huge: attempt(999999),
        };
    });
    check('the engine still throws on NaN', raw.nan.error, 'RangeError');
    check('the engine still accepts 0 as "no scrollback"', raw.zero.value, 0);
    check('the engine still substitutes its own value for a negative', raw.negative.value, 1000);
    check('the engine still accepts an unbounded capacity', raw.huge.value, 999999);
}

/*
 * Section 5 -- the range is shared, so it must stay in lockstep.
 *
 * The Settings input declares the same bounds in markup. If someone widens one
 * side only, the UI and the sanitizer disagree about what a legal value is and
 * the disagreement is invisible until a user hits the edge.
 */
{
    console.log('\n--- 5. the Settings input and the sanitizer agree on the range ---');
    const html = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
    const input = html.match(/<input[^>]*id="scrollbackInput"[^>]*>/s);
    check('the Settings input exists in the template', !!input, true);
    check('the input floor matches SCROLLBACK_MIN',
        input?.[0].match(/min="(\d+)"/)?.[1],
        String(await page.evaluate(() => window.TerminalManager.SCROLLBACK_MIN)));
    check('the input ceiling matches SCROLLBACK_MAX',
        input?.[0].match(/max="(\d+)"/)?.[1],
        String(await page.evaluate(() => window.TerminalManager.SCROLLBACK_MAX)));
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
