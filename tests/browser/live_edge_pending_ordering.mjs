#!/usr/bin/env node
/*
 * S28 — THE `pending` SUPPRESSION CLAUSE, PROVEN DETERMINISTICALLY.
 *
 * WHAT THIS REPLACES, AND WHY IT EXISTS.
 *
 * The clause under test is one line in `noteLiveEdgeScroll`
 * (terminal-manager.js):
 *
 *     if (entry.pending) {
 *         // A geometry change is already in flight and this scroll arrives
 *         // with the height the resize callback just adopted, so it cannot be
 *         // distinguished from a clamp by height -- and measured on the live
 *         // box it IS the clamp. The intent stands until the fit consumes it.
 *         return;
 *     }
 *
 * Until now it had NO deterministic gate, and the record is worth keeping
 * straight about why:
 *
 *   * tests/browser/viewport_live_edge_intent.mjs tried and could not. Its
 *     author drove a JS wrapper resize at seven inter-resize delays
 *     (0/50/100/150/200/300/500ms); the mutant stranded at NONE of them, and
 *     those rows were DELETED rather than kept green -- correct under
 *     AGENTS.md §2, and honestly documented in that file's long comment. What
 *     survived there is a structural guard that the clause still textually
 *     exists.
 *
 *   * §R4M of the production probe (/tmp/s26reg/prod_regress_s27.mjs) covered
 *     it only PROBABILISTICALLY: it repeated one grow journey five times and
 *     required "at least one of 5 strands". Measured across six runs of
 *     identical product code that oracle returned 2, 1, 0, 5 and 0 of 5, and
 *     0 of 12 when the count was raised -- so it reported "no defect" on
 *     roughly a third of runs. An oracle that is silent a third of the time is
 *     not an assertion, and raising the repetition count was tried and failed.
 *
 * THE ORDERING THE OLD HARNESSES COULD NOT BUILD, now built here from measured
 * facts (/tmp/s26reg/diag29..diag34). Three conditions must hold AT ONCE, and
 * every previous attempt missed at least one:
 *
 *   1. The product's OWN ResizeObserver must have already adopted the new
 *      scroller height, so `entry.clientHeight === viewport.clientHeight` and
 *      `entry.pending === true`. Waiting one animation frame is NOT enough
 *      (measured: the box was 844 while the entry still read 600); with an
 *      un-adopted height the clamp takes `noteLiveEdgeScroll`'s own
 *      clamp branch instead of the equal-heights branch, which is a different
 *      code path and can never discriminate the mutant. So this file POLLS THE
 *      PRODUCT'S OWN STATE for that exact triple, never a fixed delay.
 *
 *   2. The clamp must reach the engine through xterm's real buffer-scroll path
 *      (`term.scrollLines`), because that is what dispatches `onScroll` into
 *      `noteLiveEdgeScroll`. Setting `.xterm-viewport.scrollTop` directly does
 *      NOT translate into a buffer scroll -- measured: the observer was never
 *      entered at all and both arms read identical, proving nothing.
 *
 *   3. All of it must land INSIDE the 50ms fit debounce (`requestFit`'s
 *      default). An earlier revision took a snapshot between the resize
 *      and the clamp; the round trip alone overran the debounce, the fit had
 *      already re-glued, and both arms read "not stranded".
 *
 * THE DEBOUNCE NOW STARTS AT THE SECOND CHANGE (2026-09-25). The first box
 * change of a burst is fitted inside its own ResizeObserver callback
 * (`requestFitLeading`), so the fit consumes `pending` in the same callback
 * that set it and no clamp can land between them. Later changes of the burst
 * still go through `requestFit` and keep the window this clause guards. So the
 * journey opens a burst with a first grow, waits for that fit to have
 * consumed its mark, and builds the three conditions on the SECOND grow.
 * Measured on xterm 6 before restating (Chromium and WebKit; a single grow,
 * a keyboard-close grow and a burst, each at the live edge): a real grow
 * produced ZERO scroll events and every run ended on the live row, with the
 * leading fit and without it. The clamp is injected below for that reason.
 *
 * With those three satisfied the pair discriminates cleanly and repeatably:
 *
 *   unmutated  enter equalH=true pending=true -> exit intent=true/true
 *              -> after the fit: gap 0, atBottom true, LIVE-EDGE visible
 *   M2 mutant  enter equalH=true pending=true -> exit intent=false/false
 *              -> after the fit: gap 26, atBottom false, an H-### history row
 *                 visible instead, and STILL stranded 2s later
 *
 * The mutant is installed by replacing the product method with a copy of
 * itself MINUS the clause, at runtime, and it is removed again in the same
 * page -- no source file is edited, so there is nothing to restore on disk and
 * no way for a crash to leave a mutant behind. The file additionally asserts
 * that the clause is still textually present in the shipped source, so
 * deleting it cannot make this gate vacuously green.
 *
 * WHAT THIS FILE DOES NOT DO. It does not weaken, replace or excuse the
 * POSITIVE requirement. "§R4M UNMUTATED: ZERO stranded" in the production
 * probe stays exactly as it is and keeps running against the real box; that
 * row has passed in every run (35 consecutive grow journeys, zero strands).
 * What moves here is only the MUTANT half of the discrimination, from a coin
 * flip to a proof.
 *
 * Run: node tests/browser/live_edge_pending_ordering.mjs   (from source/)
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

// ---------------------------------------------------------------------------
// §0 The clause must still EXIST in the shipped source. Without this row a
//    future deletion would make every behavioural row below pass for the wrong
//    reason -- the mutant would simply equal the product.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(
    path.join(ROOT, 'static/js/terminal-manager.js'), 'utf8');
const CLAUSE = `        if (entry.pending) {`;
check('§0 the pending-suppression clause is present in terminal-manager.js '
    + '(production measured it as necessary; this gate proves why)',
    SRC.includes(CLAUSE), true);

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = {
        connected: true, id: 'sock-lep',
        on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop,
        emit: (n, p) => {
            // Answer every size proposal as the real server does, so the S28
            // geometry hold never sits armed in this fixture.
            if (n === 'ssh_resize' && p && p.cols && p.rows) {
                (window.__socketHandlers['pty_geometry'] || []).forEach(cb => cb({
                    session_id: p.session_id, cols: p.cols, rows: p.rows,
                    applied: true }));
            }
        },
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', { get: () => () => window.socket,
        configurable: false });
    window.showNotification = noop;
    window.ModalManager = { open: noop, close: noop };
    window.clearConnectionProfileState = noop;
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop };
`;

const browser = await chromium.launch();

/*
 * ONE journey. `mutate` decides only whether the `pending` clause is present in
 * the method the engine calls -- everything else, in both arms, is identical
 * and goes through the product's own entry points.
 */
async function journey(mutate) {
    const SID = mutate ? 'lep-mutant' : 'lep-real';
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
        null, { timeout: 15000 });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });

    await page.evaluate((sid) => {
        SessionManager.sessions[sid] = {
            id: sid, session_id: sid, host: 'lep.example', port: 22,
            username: 'lep', authType: 'key', keyId: 'k1', jumpHostId: null,
            displayName: 'LEP', connected: true, isPersistentCandidate: false,
            tmuxSessionName: 'lep', terminalId: `term-${sid}`, useTmux: true,
            viaJump: null, latencyMs: null,
        };
        const holder = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = `term-${sid}`;
        el.className = 'terminal-wrapper';
        el.style.width = '390px';
        el.style.height = '600px';
        holder.appendChild(el);
        TerminalManager.createTerminal(sid);
        TerminalManager.attachTerminal(sid, `term-${sid}`);
        SessionManager.assignSessionToPane(sid, 0);
        SessionManager.setActivePane(0);
    }, SID);
    await page.waitForFunction((sid) => {
        const keys = TerminalManager.sessionTerminals[sid] || [];
        return keys.length > 0 && TerminalManager.terminalReady[keys[0]];
    }, SID, { timeout: 10000 });
    await page.waitForTimeout(400);

    // History to strand, and a marker on the live row so "stranded" is legible
    // as content rather than only as a number.
    await page.evaluate((sid) => new Promise(res => {
        const key = (TerminalManager.sessionTerminals[sid] || [])[0];
        const term = TerminalManager.terminals[key];
        let s = '';
        for (let i = 1; i <= 140; i++) s += `H-${i}\r\n`;
        term.write(s + 'LIVE-EDGE', () => res());
    }), SID);
    await page.waitForTimeout(600);

    if (mutate) {
        await page.evaluate(() => {
            const TM = window.TerminalManager;
            // A copy of the shipped method with ONE clause removed. Runtime
            // only: no file is edited, so no restore can be missed.
            TM.noteLiveEdgeScroll = function (terminalKey) {
                const terminal = this.terminals[terminalKey];
                const buffer = terminal && terminal.buffer && terminal.buffer.active;
                if (!buffer) return;
                const height = this.liveEdgeViewportHeight(terminal);
                const entry = this.liveEdgeIntent[terminalKey];
                if (!entry) return;
                if (entry.clientHeight !== height) {
                    entry.clientHeight = height;
                    entry.pending = true;
                    return;
                }
                /* MUTATION: `if (entry.pending) return;` removed. */
                entry.atLiveEdge = buffer.viewportY >= buffer.baseY;
                entry.pending = false;
            };
        });
    }

    const observed = await page.evaluate(async (sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        const vp = term.element.querySelector('.xterm-viewport');
        const el = document.getElementById(`term-${sid}`);
        const calls = [];
        const realNote = TM.noteLiveEdgeScroll.bind(TM);
        TM.noteLiveEdgeScroll = function (k) {
            const e = TM.liveEdgeIntent[k];
            const entered = {
                equalH: e ? e.clientHeight === vp.clientHeight : null,
                pending: e ? e.pending : null,
            };
            const r = realNote(k);
            const e2 = TM.liveEdgeIntent[k];
            calls.push({ ...entered,
                exitAtLiveEdge: e2 ? e2.atLiveEdge : null,
                exitPending: e2 ? e2.pending : null });
            return r;
        };

        // (0) open the burst: the first change is fitted in its own callback,
        //     which consumes its pending mark at once (requestFitLeading).
        el.style.height = '700px';
        void el.offsetHeight;
        await new Promise(resolve => {
            const t0 = performance.now();
            const tick = () => {
                const e = TM.liveEdgeIntent[key];
                if ((e && e.clientHeight === vp.clientHeight && e.pending === false)
                    || performance.now() - t0 > 200) {
                    return resolve();
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        calls.length = 0;

        // (1) the product's own ResizeObserver path: grow the scroller box
        //     again, inside the burst, so the fit is the debounced one.
        el.style.height = '844px';
        void el.offsetHeight;

        // (2) wait for the OBSERVER to have adopted the new height, proven by
        //     the state the product itself writes. Never a fixed delay, and
        //     bounded well inside the 50ms fit debounce.
        const landedMs = await new Promise(resolve => {
            const t0 = performance.now();
            const tick = () => {
                const e = TM.liveEdgeIntent[key];
                if (e && e.clientHeight === vp.clientHeight && e.pending === true) {
                    return resolve(Math.round(performance.now() - t0));
                }
                if (performance.now() - t0 > 40) return resolve(-1);
                requestAnimationFrame(tick);
            };
            tick();
        });

        // (3) THE CLAMP, through xterm's real buffer-scroll entry point, which
        //     is what dispatches onScroll into noteLiveEdgeScroll.
        term.scrollLines(-9);
        await new Promise(r => requestAnimationFrame(() => r()));
        return { landedMs, calls };
    }, SID);

    const read = () => page.evaluate((sid) => {
        const key = (TerminalManager.sessionTerminals[sid] || [])[0];
        const term = TerminalManager.terminals[key];
        const b = term.buffer.active;
        const last = b.getLine(b.viewportY + term.rows - 1);
        return {
            gap: b.baseY - b.viewportY,
            atBottom: b.viewportY >= b.baseY,
            lastRow: last ? last.translateToString(true).trimEnd() : '',
        };
    }, SID);

    await page.waitForTimeout(1500);
    const settled = await read();
    await page.waitForTimeout(2000);
    const held = await read();

    await ctx.close();
    return { observed, settled, held, errors };
}

// ---------------------------------------------------------------------------
// §1 THE UNMUTATED CONTRACT
// ---------------------------------------------------------------------------
{
    const r = await journey(false);
    console.log(`      §1 observer landed after ${r.observed.landedMs}ms`);
    console.log(`      §1 scroll calls = ${JSON.stringify(r.observed.calls)}`);
    console.log(`      §1 settled = ${JSON.stringify(r.settled)}`);

    check('§1 precondition: the ResizeObserver adopted the new height before the '
        + 'clamp (a fixed delay does not guarantee this)',
        r.observed.landedMs >= 0, true);
    const clamp = r.observed.calls.find(c => c.equalH === true);
    check('§1 precondition: the clamp really entered noteLiveEdgeScroll, with '
        + 'EQUAL heights and pending true -- the exact adverse ordering',
        clamp ? clamp.pending === true : false, true);
    check('§1 the clause SUPPRESSES that clamp: the recorded intent still says '
        + 'the user is at the live edge', clamp ? clamp.exitAtLiveEdge : null, true);
    check('§1 and the pending mark survives for the fit to consume',
        clamp ? clamp.exitPending : null, true);
    check('§1 the fit re-glues: the viewport ends AT the live edge',
        r.settled.atBottom, true);
    check('§1 with no gap', r.settled.gap, 0);
    check('§1 and the live row is the one on screen', r.settled.lastRow, 'LIVE-EDGE');
    check('§1 it is still there 2s later (not a transient)', r.held.atBottom, true);
    check('§1 no page errors', r.errors.length, 0);
    if (r.errors.length) console.log(`        ${r.errors.slice(0, 3).join('\n        ')}`);
}

// ---------------------------------------------------------------------------
// §2 THE MUTANT MUST STRAND — deterministically, not one run in three.
// ---------------------------------------------------------------------------
{
    const r = await journey(true);
    console.log(`      §2 observer landed after ${r.observed.landedMs}ms`);
    console.log(`      §2 scroll calls = ${JSON.stringify(r.observed.calls)}`);
    console.log(`      §2 settled = ${JSON.stringify(r.settled)}`);

    check('§2 precondition: the mutant journey reproduced the SAME adverse '
        + 'ordering (otherwise it is not comparable to §1)',
        r.observed.landedMs >= 0, true);
    const clamp = r.observed.calls.find(c => c.equalH === true);
    check('§2 precondition: the clamp entered noteLiveEdgeScroll with pending true',
        clamp ? clamp.pending === true : false, true);
    check('§2 MUTANT: without the clause the clamp is believed and the recorded '
        + 'intent flips to "not at the live edge"',
        clamp ? clamp.exitAtLiveEdge : null, false);
    check('§2 MUTANT: the fit then declines to re-glue and the viewport STRANDS',
        r.settled.atBottom, false);
    check('§2 MUTANT: with a real gap, not a rounding artefact',
        r.settled.gap > 0, true);
    check('§2 MUTANT: a history row is on screen instead of the live row',
        r.settled.lastRow.startsWith('H-'), true);
    check('§2 MUTANT: and the strand is PERMANENT (still there 2s later)',
        r.held.atBottom, false);
    check('§2 no page errors', r.errors.length, 0);
    if (r.errors.length) console.log(`        ${r.errors.slice(0, 3).join('\n        ')}`);
}

await browser.close();
server.close();
console.log(`\nlive_edge_pending_ordering: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
