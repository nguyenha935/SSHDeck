/*
 * S27 GATE — the live-edge intent: a row GROW on a buffer with scrollback must
 * not strand the viewport above the live edge.
 *
 * THE DEFECT THIS PINS, measured on the live box (/tmp/s26reg/diag3_s27.out)
 * and localised on the vendored engine (/tmp/s26reg/diag6_s27.out,
 * diag7_s27.out):
 *
 *   The app's own `.xterm{height:100%}` (style.css:5729) makes the absolutely
 *   positioned `.xterm-viewport` scroller grow in the SAME layout pass as the
 *   pane, while xterm still holds the old row count. maxScrollTop
 *   (= scrollHeight - clientHeight) falls, the browser clamps scrollTop, and
 *   xterm's Viewport translates the clamp into a real buffer scroll. The fit,
 *   debounced behind requestFit, then arrives AFTER the contamination and
 *   carries it into the new grid:
 *
 *       shrink 48->34 rows:  viewportY 114  baseY 114  gap  0   painted 51
 *       grow   34->48 rows:  viewportY  86  baseY 114  gap 28   painted  8
 *
 *   `painted 8` is the Owner's "resize goes blank": the last visible row is
 *   nearly empty because the viewport is showing history, not the prompt. The
 *   gap is 2x the row delta (clamp one delta, resize another) and it is
 *   permanent -- writeToTerminalWithScroll captures shouldScroll from
 *   isTerminalAtBottom, which is false forever after, so nothing re-glues.
 *
 *   The SHRINK path never stranded because the write funnel's incidental
 *   scrollToBottom calls re-glued it; only the GROW has no writer.
 *
 * THE FIX, in terminal-manager.js (v41): a standing per-terminal flag -- "was
 * this terminal at the live edge" -- maintained from xterm's OWN scroll event
 * and gated on provenance: a scroll whose scroller height is unchanged is a
 * decision and refreshes the flag; a scroll arriving with a DIFFERENT scroller
 * height is a geometry clamp, so the flag is kept and marked PENDING instead.
 * A scroll arriving while the mark is already set is suppressed as well, because
 * the ResizeObserver callback may have adopted the new height first and the two
 * are then indistinguishable by height (production measurement in the note beside
 * the MUTATED_PENDING build). The bottom of fitTerminal then re-glues the live edge
 * for a pending terminal that was on it (observeLiveEdge / noteLiveEdgeScroll /
 * noteLiveEdgeResize / restoreLiveEdgeIntent). A terminal deliberately scrolled up
 * is recorded false by the same scroll path and is never yanked to the bottom.
 *
 * A FIRST ATTEMPT SAMPLED THE STATE INSIDE THE ResizeObserver CALLBACK, on the
 * strength of diag7 Q1 where that callback still read gap 0 with the new
 * clientHeight. Production contradicted it: diag9_s27.out, first sample +55ms
 * after a real viewport grow, read gap 9 with the sampled capture ALREADY
 * showing atLiveEdge false -- the clamp beat the callback. The fixture only won
 * that race because it changed the height from JS, which delivers the callback
 * in the same rendering update. That is why the flag is maintained continuously
 * rather than sampled at resize time.
 *
 * WHAT THIS GATE DRIVES: the REAL terminal-manager.js against REAL xterm, in a
 * page that reproduces the two conditions the bare bundle lacks -- the app's
 * `.xterm{height:100%}` CSS shape and the app's own ResizeObserver +
 * requestFit debounce path. Nothing under test is reimplemented: the resize is
 * delivered the way production delivers it (the wrapper's height changes; the
 * observer terminal-manager itself installs reacts). The BROWSER-resize
 * ordering is a known coverage boundary -- see the note below the T-G3 block.
 *
 * MUTATION PROOF (AGENTS.md §2), RETIRED -- see the T-G4 block.
 * T-G4 used to replay the T-G2 journey against a terminal-manager whose
 * re-glue CALL was removed, and the grow had to strand or T-G2 proved nothing.
 * It no longer strands, and the reason is the ENGINE: xterm 6 renders no DOM
 * scroller, so there is nothing for the browser to clamp. T-G4 now asserts
 * those engine facts, which makes the retirement self-correcting -- an engine
 * that brings DOM scrolling back turns that block red.
 *
 * Run: node tests/browser/viewport_live_edge_intent.mjs   (from source/)
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
};

/*
 * The harness reproduces the two production conditions diag4/diag5 proved the
 * bare bundle lacks:
 *   - `.xterm { height: 100% }` -- style.css:5729, the rule that makes the
 *     scroller's clientHeight track the pane instead of the grid;
 *   - the wrapper is the box that changes height, exactly like
 *     `.terminal-wrapper` inside the pane.
 * No other styling: cosmetics are irrelevant to the geometry under test.
 */
const HARNESS_HTML = `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="/static/vendor/xterm/xterm.css">
    <style>
      html, body { margin: 0; padding: 0; }
      #host { width: 390px; height: 691px; overflow: hidden; }
      .terminal-wrapper { height: 100%; }
      /* the production rule (style.css:5729), minus cosmetics */
      .xterm { height: 100%; width: 100%; box-sizing: border-box; }
    </style>
</head><body>
    <div id="terminalsContainer"></div>
    <div id="host" class="terminal-wrapper"></div>
</body></html>`;

const tmSource = fs.readFileSync(
    path.join(ROOT, 'static/js/terminal-manager.js'), 'utf8');
// The mutation: kill exactly the re-glue call, leaving the flag and its observer
// in place, so what is measured is the FIX and not the whole resize pipeline.
const MUTATION_TARGET = '            this.restoreLiveEdgeIntent(key);';
const MUTATED = tmSource.replace(MUTATION_TARGET,
    '            /* mutation: re-glue disabled */');
if (MUTATED === tmSource) {
    // A mutation that silently failed to apply would make the negative rows
    // below pass for the wrong reason -- the exact hole AGENTS.md §2 forbids.
    console.log('FAIL  the mutation target string was not found in '
        + 'terminal-manager.js; the negative rows would prove nothing');
    process.exit(1);
}

/*
 * THE SECOND MUTATION -- the pending SUPPRESSION in noteLiveEdgeScroll.
 *
 * It is built here and SERVED, but no row drives it: the coverage note below the
 * T-G3 block records the measurement (it does not strand in this harness at any
 * inter-resize delay, because a JS-driven resize delivers the clamp-scroll while
 * the buffer is still at the edge). The mutant source is still produced so this
 * file fails loudly if the clause is ever renamed or deleted from the product --
 * a silent disappearance would leave the production §R4 row as the only guard, and
 * nothing here would say so.
 */
const PENDING_TARGET = `        if (entry.pending) {`;
const MUTATED_PENDING = tmSource.replace(PENDING_TARGET,
    `        if (false) {`);
if (MUTATED_PENDING === tmSource || tmSource.indexOf(PENDING_TARGET) < 0) {
    console.log('FAIL  the pending-suppression clause is missing from '
        + 'terminal-manager.js; production §R4 measured it as necessary '
        + '(diag14_s27.out) and nothing here would catch its removal');
    process.exit(1);
}

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/harness.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(HARNESS_HTML);
            return;
        }
        if (rel === '/static/js/terminal-manager.mutated.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(MUTATED);
            return;
        }
        if (rel === '/static/js/terminal-manager.nopending.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(MUTATED_PENDING);
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
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

async function loadHarness(mutated, variant = 'reglue') {
    pageErrors.length = 0;
    await page.goto(`${base}/harness.html`, { waitUntil: 'load' });
    await page.addScriptTag({ url: `${base}/static/vendor/xterm/xterm.js` });
    await page.addScriptTag({ url: `${base}/static/vendor/xterm/xterm-addon-fit.js` });
    const mutantUrl = variant === 'nopending'
        ? `${base}/static/js/terminal-manager.nopending.js`
        : `${base}/static/js/terminal-manager.mutated.js`;
    await page.addScriptTag({ url: mutated
        ? mutantUrl
        : `${base}/static/js/terminal-manager.js` });
    if (mutated && variant === 'nopending') {
        // Reserved for a harness that can reproduce the production ordering; no
        // row drives this variant today (see the coverage note below T-G3).
        check('nopending mutant is servable', true, true);
    } else if (mutated) {
        // The mutated page must have loaded the mutated source, and it must be
        // mutated in the ONE way intended: the re-glue function still defined,
        // the flag still maintained, only the call gone. Read from the served
        // bytes so this is a fact about the page, not about my intent.
        const state = await page.evaluate(async (url) => {
            const src = await (await fetch(url)).text();
            return {
                hasFn: typeof window.TerminalManager.restoreLiveEdgeIntent === 'function',
                hasIntent: !!window.TerminalManager.liveEdgeIntent,
                hasObserver: typeof window.TerminalManager.observeLiveEdge === 'function',
                callGone: !src.includes('this.restoreLiveEdgeIntent(key);'),
            };
        }, `${base}/static/js/terminal-manager.mutated.js`);
        check('mutation load: the re-glue CALL is gone from the served bytes',
            state.callGone, true);
        check('mutation load: the flag and its observer are still present, so '
            + 'only the re-glue is missing',
            state.hasFn && state.hasIntent && state.hasObserver, true);
    } else {
        check('harness loaded the real TerminalManager',
            await page.evaluate(() =>
                typeof window.TerminalManager === 'object'), true);
        check('harness loaded real xterm',
            await page.evaluate(() => typeof window.Terminal === 'function'), true);
    }
}

async function attachSession(sessionId) {
    await page.evaluate((sid) => {
        const holder = document.getElementById('terminalsContainer');
        const el = document.createElement('div');
        el.id = `term-${sid}`;
        el.className = 'terminal-wrapper';
        el.style.width = '390px';
        el.style.height = '691px';
        holder.appendChild(el);
        window.TerminalManager.createTerminal(sid);
        window.TerminalManager.attachTerminal(sid, `term-${sid}`);
    }, sessionId);
    await page.waitForFunction((sid) => {
        const keys = window.TerminalManager.sessionTerminals[sid] || [];
        return keys.length > 0
            && keys.every(k => window.TerminalManager.terminalReady[k]);
    }, sessionId, { timeout: 8000 });
}

// The measured facts, in the same vocabulary as the diagnostics.
async function snap(sessionId) {
    return await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        if (!term) return null;
        const b = term.buffer.active;
        const lastVisible = b.getLine(b.viewportY + term.rows - 1);
        const vp = term.element ? term.element.querySelector('.xterm-viewport') : null;
        const intent = TM.liveEdgeIntent ? TM.liveEdgeIntent[key] : undefined;
        return {
            intent: intent === undefined ? 'ABSENT'
                : `${intent.atLiveEdge}/${intent.pending}/${intent.clientHeight}`,
            grid: term.cols + 'x' + term.rows,
            baseY: b.baseY, viewportY: b.viewportY,
            gap: b.baseY - b.viewportY,
            atBottom: b.viewportY >= b.baseY,
            painted: lastVisible
                ? lastVisible.translateToString(true).trimEnd().length : 0,
            lastRow: lastVisible
                ? lastVisible.translateToString(true).trimEnd() : '',
            scrollTop: vp ? Math.round(vp.scrollTop) : null,
            clientHeight: vp ? vp.clientHeight : null,
        };
    }, sessionId);
}

async function writeLines(sessionId, n, tag) {
    await page.evaluate(({ sid, n, tag }) => new Promise(resolve => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        let payload = '';
        for (let i = 1; i <= n; i++) payload += `${tag}-${i}\r\n`;
        // A final line WITHOUT a newline, so the live-edge row holds real
        // content -- the harness has no shell prompt to paint there. Stranding
        // the viewport leaves an H-i history row visible instead of this marker,
        // which is what the lastRow assertions read.
        term.write(payload + 'LIVE-EDGE', () => resolve());
    }), { sid: sessionId, n, tag });
}

const wait = (ms) => page.waitForTimeout(ms);

// The resize is delivered the way production delivers it: the WRAPPER's height
// changes and terminal-manager's own ResizeObserver reacts through requestFit.
// No fit() call from the test side.
async function setWrapperHeight(sessionId, px) {
    await page.evaluate(({ sid, px }) => {
        const el = document.getElementById(`term-${sid}`);
        el.style.height = px + 'px';
    }, { sid: sessionId, px });
}

// ============================================================================
// T-G1 — the precondition: after the replay-shaped write the buffer really
// holds scrollback and sits at the live edge.
// ============================================================================
await loadHarness(false);
{
    const sid = 'grow-g1';
    await attachSession(sid);
    await writeLines(sid, 200, 'H');
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        TM.terminals[key].scrollToBottom();
    }, sid);
    await wait(400);
    const s = await snap(sid);
    check('T-G1 the buffer holds scrollback (baseY > 0) after 200 lines',
        s.baseY > 0, true);
    check('T-G1 the viewport starts AT the live edge (gap 0)',
        s.gap, 0);
    check('T-G1 the last visible row shows the LIVE EDGE, not history',
        s.lastRow.endsWith('LIVE-EDGE'), true);
}

// ============================================================================
// T-G2 — THE GROW, with the fix (unmutated): shrink then grow through the
// production path; the viewport must still be at the live edge afterwards.
// ============================================================================
{
    const sid = 'grow-g2';
    await attachSession(sid);
    await writeLines(sid, 200, 'G2');
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        TM.terminals[key].scrollToBottom();
    }, sid);
    await wait(400);
    const before = await snap(sid);
    check('T-G2 precondition: at the live edge with scrollback',
        before.baseY > 0 && before.gap === 0, true);

    await setWrapperHeight(sid, 495);          // shrink: 691 -> 495
    await wait(700);
    const shrunk = await snap(sid);
    check('T-G2 shrink held the live edge (gap 0)',
        shrunk.gap, 0);

    await setWrapperHeight(sid, 691);          // THE GROW: 495 -> 691
    await wait(700);
    const grown = await snap(sid);
    // Not proof of the fix any more (see T-G4): a plain regression row.
    check('T-G2 GROW keeps the viewport at the live edge (gap 0)',
        grown.gap, 0);
    check('T-G2 GROW still shows the LIVE EDGE row, not stranded history',
        grown.lastRow.endsWith('LIVE-EDGE'), true);
    check('T-G2 GROW lands atBottom true',
        grown.atBottom, true);
    // It must STAY correct: the defect was permanent, so is the fix.
    await wait(800);
    const settled = await snap(sid);
    check('T-G2 the fix holds after settling (gap still 0)',
        settled.gap, 0);

    // A live write after the grow must keep following the output -- the strand
    // used to freeze shouldScroll forever; with the fix the terminal is at the
    // bottom so the write funnel keeps gluing.
    await writeLines(sid, 5, 'AFTER');
    await wait(600);
    const after = await snap(sid);
    check('T-G2 a live write after the grow still follows (gap 0)',
        after.gap, 0);
}

// ============================================================================
// T-G3 — the scrolled-up user: a terminal NOT at the live edge when the box
// grows must NOT be yanked to the bottom. The fix records false and declines.
// ============================================================================
{
    const sid = 'grow-g3';
    await attachSession(sid);
    await writeLines(sid, 200, 'G3');
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        TM.terminals[key].scrollToBottom();
        TM.terminals[key].scrollLines(-40);
    }, sid);
    await wait(400);
    const before = await snap(sid);
    check('T-G3 precondition: deliberately scrolled up (gap ~40)',
        before.gap >= 30, true);
    // The flag has to have RECORDED that choice, or T-G3 would pass merely
    // because nothing ran. This reads the product's own state.
    check('T-G3 precondition: the flag recorded the user as NOT at the live edge',
        before.intent.startsWith('false/'), true);

    await setWrapperHeight(sid, 495);
    await wait(700);
    await setWrapperHeight(sid, 691);
    await wait(700);
    const grown = await snap(sid);
    // The user's read position must survive: still away from the live edge,
    // i.e. the fix did not scrollToBottom them.
    check('T-G3 the scrolled-up viewport is NOT yanked to the bottom',
        grown.atBottom, false);
    // And their position must be roughly where they were (the row anchor, not
    // the pixel one, may shift by the grid change; the assertion is about not
    // being glued).
    check('T-G3 the scrolled-up viewport stays well above the live edge',
        grown.gap >= 20, true);
}

/*
 * A BROWSER-VIEWPORT resize row was attempted here and is deliberately absent,
 * and so is a mutant for the `pending` suppression clause.
 *
 * (a) THE BROWSER-RESIZE ROW. The production defect's decisive property is that a
 * BROWSER-driven resize dispatches the clamp-induced scroll BEFORE the
 * ResizeObserver callback, which is why no resize-time sample of the at-edge state
 * is trustworthy (/tmp/s26reg/diag9_s27.out, +55ms: grid still 51x39, baseY 114,
 * viewportY 105, gap 9). I wrote a row that resized the browser viewport with a
 * viewport-sized wrapper to pin that path here -- and its MUTANT twin did NOT
 * strand (measured: gap 0, live-edge row still painted, with the re-glue call
 * removed). So in this harness a Playwright viewport resize does not reproduce
 * the clamp at all, and a row that passes with the fix removed is not an
 * assertion (AGENTS.md §2).
 *
 * (b) THE `pending` SUPPRESSION MUTANT. Production measured that clause as
 * necessary: with two resizes about 100ms apart -- §R4's real pacing, since its
 * probe advances as soon as a row paints -- the ResizeObserver callback adopts the
 * new scroller height BEFORE the clamp-scroll arrives, so the clamp arrives with
 * EQUAL heights, is classified as a deliberate scroll, and overwrites the flag
 * with false (diag14_s27.out: resize +203ms h=691 true/false->true/true; scroll
 * +206ms h=691 baseY 115 vpY 105 true/true->false/false; strand gap 20 permanent
 * to +9s). A mutant removing only that clause was built and driven here at seven
 * inter-resize delays (0/50/100/150/200/300/500ms) and stranded at NONE of them:
 * gap 0, atBottom true, intent true/false every time. Its call tape shows why --
 * on a JS-driven wrapper resize the clamp-scroll reaches noteLiveEdgeScroll while
 * the buffer is still AT the edge (+120ms, baseY 152 vpY 152 gap 0), so recording
 * `true` there happens to be right and the following fit re-glues anyway. The
 * clause's necessity is a property of the browser-resize ordering this harness
 * cannot produce, so those rows were deleted rather than kept green.
 *
 * The honest state of the coverage:
 *
 *   covered here            a JS-driven wrapper resize (T-G2/T-G4), where the
 *                           clamp and the debounced fit are both observable and
 *                           the mutant strands.
 *   covered in production   the browser-resize path AND the back-to-back pacing,
 *                           by §R4 of /tmp/s26reg/prod_regress_s27.mjs against the
 *                           real box -- the probe that found the defect, caught
 *                           v39's wrong capture point, and caught v40's missing
 *                           suppression.
 *   guarded structurally    the suppression clause's PRESENCE, by the
 *                           MUTATED_PENDING build above: this file exits 1 if the
 *                           clause is renamed or removed.
 *
 * A future harness that reproduces the production ordering should add the row
 * back WITH its mutant twin red; until then this comment is the honest state of
 * the coverage rather than a passing row implying more than it proves.
 */

// ============================================================================
// T-G4 — WHY THE MUTATION PROOF IS RETIRED ( on xterm 6).
//
// This block used to drive the T-G2 journey with the re-glue CALL removed and
// demand a strand. The mutant stopped stranding at the xterm 6 upgrade
// (v3-xterm6-20260913), and the measurement says the cause is the engine, not
// the fix. The S27 defect was: the wrapper grows, `.xterm-viewport` gains
// clientHeight while xterm still holds the old rows, maxScrollTop falls, the
// BROWSER clamps scrollTop, and the engine turns that clamp into a real buffer
// scroll. Every step of that chain needs a DOM scroller, and xterm 6 has none
// (probe output, /tmp scratch):
//
//     .xterm-scroll-area                 absent
//     viewport.scrollHeight              === clientHeight  (maxScrollTop 0)
//     viewport.scrollTop = 0 + 'scroll'  buffer.viewportY unchanged (152)
//     shrink 49->35 rows, grow back      gap 0 at every animation frame
//
// So the mutation cannot strand, and T-G2 can no longer tell the fix apart
// from the engine: it is kept as a plain regression row (the grow must not
// strand), not as proof of the fix. The fix itself (liveEdgeIntent /
// restoreLiveEdgeIntent) is KEPT rather than deleted: it costs one flag per
// scroll, it is a no-op whenever the buffer is already at the edge, and the
// BROWSER-driven resize (the soft keyboard) is the coverage boundary noted
// above -- this fixture drives JS-driven resizes only.
//
// The rows are the engine facts themselves, so the retirement corrects itself:
// if an engine restores DOM-driven scrolling, the last two rows go red and the
// mutation proof must be re-armed.
// ============================================================================
await loadHarness(true);
{
    const sid = 'grow-g4';
    await attachSession(sid);
    await writeLines(sid, 200, 'G4');
    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        TM.terminals[key].scrollToBottom();
    }, sid);
    await wait(400);

    const engine = await page.evaluate(async (sid) => {
        const TM = window.TerminalManager;
        const key = (TM.sessionTerminals[sid] || [])[0];
        const term = TM.terminals[key];
        const vp = term.element.querySelector('.xterm-viewport');
        const before = term.buffer.active.viewportY;
        vp.scrollTop = 0;
        vp.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 200));
        return {
            baseY: term.buffer.active.baseY,
            hasScrollArea: !!term.element.querySelector('.xterm-scroll-area'),
            maxScrollTop: vp.scrollHeight - vp.clientHeight,
            movedByScrollTop: term.buffer.active.viewportY !== before,
        };
    }, sid);
    check('T-G4 ENGINE precondition: the buffer really holds scrollback',
        engine.baseY > 0, true);
    check('T-G4 ENGINE: xterm renders no .xterm-scroll-area',
        engine.hasScrollArea, false);
    check('T-G4 ENGINE: the viewport has no scroll range to clamp (maxScrollTop 0)',
        engine.maxScrollTop, 0);
    check('T-G4 ENGINE: a scrollTop write does not move the buffer',
        engine.movedByScrollTop, false);

    await page.evaluate((sid) => {
        const TM = window.TerminalManager;
        TM.terminals[(TM.sessionTerminals[sid] || [])[0]].scrollToBottom();
    }, sid);
    await wait(300);
    await setWrapperHeight(sid, 495);
    await wait(700);
    const shrunk = await snap(sid);
    check('T-G4 MUTANT shrink path still holds (gap 0) -- never the defect',
        shrunk.gap, 0);
    await setWrapperHeight(sid, 691);
    await wait(700);
    const grown = await snap(sid);
    check('T-G4 MUTANT grow does NOT strand without the re-glue: nothing clamps it',
        grown.gap, 0);
    check('T-G4 MUTANT the live-edge row is shown although the re-glue is gone',
        grown.lastRow.endsWith('LIVE-EDGE'), true);
}

check('no page errors during the gate', pageErrors.length, 0);

await context.close();
await browser.close();
await new Promise(r => server.close(r));
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
