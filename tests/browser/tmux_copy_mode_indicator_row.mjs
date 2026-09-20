#!/usr/bin/env node
/*
 * S30 — THE COPY-MODE INDICATOR IS DRAWN AT THE PANE'S TOP. PROVEN, WITH THE
 *       DISCARDED-WRITE CONSEQUENCE ATTACHED.
 *
 * THE DEFECT THIS GATE EXISTS FOR, measured on the live deployment before any
 * code changed (/tmp/s26reg/s30_p5_G.log, /tmp/s26reg/s30_p6_H.log):
 *
 *   a real swipe on a session holding real output ->
 *     tmux paints its copy-mode position indicator at PANE ROW 0 ("[75/357]")
 *     and switches its status line from `bash*` to `[tmux]*`
 *     tmuxPaneInCopyModeIndicator scanned only the LAST FOUR rows -> false
 *     writeNeedsScrollExit -> false
 *     `leave_scroll` never rode the ssh_input event (app.js:1334-1338)
 *     handle_ssh_input never called exit_tmux_copy_mode (socket_events.py:1188)
 *     tmux DISCARDED the bytes, and the shell line stayed the bare prompt
 *
 * That was proved causal by mutation on the live box: widening the scanned
 * window at runtime, changing nothing else, made the identical write reach the
 * shell (ARM B); restoring the shipped method brought the discard straight back
 * (ARM C). So the whole S23 R4 fix was inert on every session that had ever
 * scrolled -- which is every session the Owner uses -- and that is the Owner's
 * "composer still cannot send deletion to the real terminal line".
 *
 * WHY THE S23 WINDOW LOOKED RIGHT. Its evidence (/tmp/s16work/s22_i4_ordering.out)
 * was taken on a nearly-EMPTY pane, where the shell prompt IS the pane's top
 * row -- so "the indicator sits next to the prompt, near the bottom" and "the
 * indicator sits at the pane top" were indistinguishable in that sample. §B
 * below keeps that empty-pane shape as a permanent row, because the corrected
 * detector must still cover it.
 *
 * WHY NOT SWEEP ALL 48 ROWS. The regex is anchored to the row END, and ordinary
 * output can legitimately end in a bracketed fraction ("progress [3/60]"). A
 * whole-window sweep would call any such pane "in copy mode" and put a tmux
 * query plus an ESC decision behind every keystroke. §D holds that line: an
 * indicator-shaped line on a MIDDLE row must NOT read as copy mode. The two
 * scanned windows -- the pane's top row, and the bottom rows where tmux's status
 * line lives -- are exactly where tmux itself writes.
 *
 * SECTIONS
 *   §0  structural: both scanned windows are still in the shipped source, so a
 *       deletion cannot make the behavioural rows below vacuously green.
 *   §A  THE BITING ROW: a FULL pane with the indicator on its top row is
 *       detected, writeNeedsScrollExit agrees, and the real write funnel puts
 *       `leave_scroll: true` on the wire.
 *   §B  the S23 empty-pane shape still works (indicator on a bottom row).
 *   §C  a pane with no indicator anywhere reads false and spends no leave_scroll.
 *   §D  an indicator-shaped line on a MIDDLE row does NOT read as copy mode.
 *   §E  S30-B: which payloads dataIsMouseReport calls the pointer
 *       interaction itself rather than something the user wrote.
 *   §F  S30-B THE BITING ROW: on the very pane §A flags, a payload that IS
 *       the scroll spends NO leave_scroll while its bytes still reach the
 *       wire unchanged, and a deliberate write merely CONTAINING report text
 *       still spends one.
 *   §M  MUTATION: reinstall the pre-S30 four-rows-only reader at runtime and
 *       show §A goes red -- detector false, funnel spends no leave_scroll.
 *   §N  MUTATION: remove the S30-B guard at runtime and show §F goes red --
 *       the funnel flags the scroll's own reports again, which is exactly the
 *       path that wrote raw SGR bytes into the Owner's shell line.
 *
 * The mutant is installed by replacing the product method with the pre-fix copy
 * of itself, in the page, and removed again in the same page: no source file is
 * edited, so nothing can be left behind on disk.
 *
 * Run: node tests/browser/tmux_copy_mode_indicator_row.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        failures.push(label);
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);

// ---------------------------------------------------------------------------
// §0 STRUCTURAL GUARDS
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(
    path.join(ROOT, 'static/js/terminal-manager.js'), 'utf8');
const reader = (() => {
    const start = SRC.indexOf('\n    tmuxPaneInCopyModeIndicator(terminal) {');
    return SRC.slice(start, SRC.indexOf('\n    },', start));
})();
check('§0 the indicator reader still scans the pane\'s TOP row (this is where '
    + 'tmux draws the copy-mode position indicator; without it the detector is '
    + 'inert on every pane holding output)',
    reader.includes('buf.getLine(buf.viewportY)'), true);
check('§0 the indicator reader still scans the bottom window too (the S23 '
    + 'empty-pane shape depends on it)',
    /const first = Math\.max\(0, last - 3\)/.test(reader), true);
check('§0 the match is still ANCHORED to the row end, which is the only thing '
    + 'separating tmux\'s indicator from output ending in "[3/60]"',
    reader.includes('\\[[0-9]+\\/[0-9]+\\]\\s*$'), true);
const predicate = (() => {
    const start = SRC.indexOf('    writeNeedsScrollExit(sessionId) {');
    return SRC.slice(start, SRC.indexOf('\n    },', start));
})();
check('§0 writeNeedsScrollExit still asks the painted-indicator reader',
    predicate.includes('tmuxPaneInCopyModeIndicator'), true);
const APP = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');
const funnel = (() => {
    const start = APP.indexOf('window.emitTerminalInput = ');
    return APP.slice(start, APP.indexOf('\n    };', start));
})();
check('§0 the ONE write funnel still asks the predicate and rides leave_scroll '
    + 'on the existing ssh_input event',
    funnel.includes('writeNeedsScrollExit') && funnel.includes('leave_scroll'), true);
// The CALL, not the name: the funnel's own comment block mentions
// TerminalManager.dataIsMouseReport, so asserting the bare name passes against
// prose alone -- measured, by deleting the conjunct and watching this row stay
// green while §F went red. `dataIsMouseReport(data)` appears only in code.
check('§0 S30-B: and the funnel still CALLS dataIsMouseReport on the payload, '
    + 'so the rows below cannot pass because the guard was deleted',
    funnel.includes('dataIsMouseReport(data)'), true);
check('§0 S30-B: the predicate itself is still anchored to the WHOLE payload '
    + '(an unanchored test would strip the exit from any composer line that '
    + 'happens to contain report text)',
    SRC.includes('/^(?:\\x1b\\[<\\d+;\\d+;\\d+[Mm])+$/'), true);

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
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

// The stub records every ssh_input payload, which is how the leave_scroll rows
// below observe the REAL funnel rather than re-deriving its decision.
const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.__sshInputs = [];
    window.socket = {
        connected: true, id: 'sock-cmi',
        on: (n, cb) => { (window.__socketHandlers[n] ||= []).push(cb); },
        off: noop, once: noop,
        emit: (n, p) => {
            if (n === 'ssh_input') window.__sshInputs.push(p);
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

const SID = 'cmi-1';
await page.evaluate((sid) => {
    SessionManager.sessions[sid] = {
        id: sid, session_id: sid, host: 'cmi.example', port: 22,
        username: 'cmi', authType: 'key', keyId: 'k1', jumpHostId: null,
        displayName: 'CMI', connected: true, isPersistentCandidate: false,
        tmuxSessionName: 'cmi', terminalId: `term-${sid}`, useTmux: true,
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

/*
 * Paint one full pane exactly as tmux would, through the engine's own write
 * path, and report where the indicator ended up in PANE-ROW terms so every row
 * below is checked against a verified fixture rather than an assumed one.
 *
 * `where`: 'top'    -> the pane's first visible row carries "[75/357]"
 *          'bottom' -> the S23 empty-pane shape: a short pane whose LAST rows
 *                      carry it
 *          'middle' -> an ordinary-output line ending in "[3/60]" mid-pane
 *          'none'   -> no indicator anywhere
 */
const paint = (sid, where) => {
    const keys = TerminalManager.sessionTerminals[sid] || [];
    const term = TerminalManager.terminals[keys[0]];
    return new Promise((resolve) => {
        const R = term.rows;
        const pad = (s) => {
            // Flush against the right edge of the pane, which is where tmux
            // draws it.
            const room = Math.max(1, term.cols - s.length);
            return ' '.repeat(room) + s;
        };
        let lines = [];
        if (where === 'top') {
            lines.push('CMI-ROW-0' + pad('[75/357]').slice(9));
            for (let i = 1; i < R - 1; i++) lines.push(`CMI-ROW-${i}`);
            lines.push('[sshdeck_s0:[tmux]*   "cmi" 12:00 30-Aug-26');
        } else if (where === 'bottom') {
            for (let i = 0; i < R - 2; i++) lines.push('');
            lines.push('cmi@host:~$' + pad('[0/0]').slice(11));
            lines.push('[sshdeck_s0:[tmux]*   "cmi" 12:00 30-Aug-26');
        } else if (where === 'middle') {
            for (let i = 0; i < R - 1; i++) {
                lines.push(i === Math.floor(R / 2)
                    ? 'progress [3/60]' : `CMI-ROW-${i}`);
            }
            lines.push('[sshdeck_s0:bash*     "cmi" 12:00 30-Aug-26');
        } else {
            for (let i = 0; i < R - 1; i++) lines.push(`CMI-ROW-${i}`);
            lines.push('[sshdeck_s0:bash*     "cmi" 12:00 30-Aug-26');
        }
        // Home + clear, then the rows, so the pane is repainted in place the way
        // tmux repaints its single window -- no scrollback is added.
        term.write('\x1b[H\x1b[2J' + lines.join('\r\n'), () => resolve());
    });
};

const READ = (sid) => {
    const keys = TerminalManager.sessionTerminals[sid] || [];
    const t = TerminalManager.terminals[keys[0]];
    const b = t.buffer.active;
    const rows = [];
    for (let i = 0; i < t.rows; i++) {
        const line = b.getLine(b.viewportY + i);
        if (line && /\[[0-9]+\/[0-9]+\]\s*$/.test(line.translateToString(true))) {
            rows.push(i);
        }
    }
    return {
        indicatorPaneRows: rows,
        detector: TerminalManager.tmuxPaneInCopyModeIndicator(t),
        needsExit: TerminalManager.writeNeedsScrollExit(sid),
        topRow: (b.getLine(b.viewportY)?.translateToString(true) ?? '').trimEnd().slice(-20),
        paneRows: t.rows, viewportY: b.viewportY,
    };
};

// One write through the REAL funnel, reporting what went on the wire.
// `data` is reported back verbatim because S30-B suppresses an ADVISORY and
// nothing else: if the guard ever started filtering bytes the gesture would
// stop scrolling, so every row that asserts a suppressed flag also asserts the
// payload still left unchanged.
const writeThroughFunnel = (sid, data) => {
    window.__sshInputs.length = 0;
    const ok = window.emitTerminalInput(sid, data);
    const last = window.__sshInputs[window.__sshInputs.length - 1] || null;
    return {
        ok, sent: !!last,
        leaveScroll: last ? last.leave_scroll === true : null,
        data: last ? last.data : null,
    };
};

// ---------------------------------------------------------------------------
// §A THE BITING ROW — a full pane, indicator on the pane's TOP row
// ---------------------------------------------------------------------------
console.log('\n--- §A full pane, tmux indicator on the pane\'s top row ---');
await page.evaluate(({ s, w, src }) => {
    window.__paint = new Function('sid', 'where', `return (${src})(sid, where)`);
    return window.__paint(s, w);
}, { s: SID, w: 'top', src: paint.toString() });
await page.waitForTimeout(300);
const a = await page.evaluate(READ, SID);
num('§A pane state', a);
check('§A fixture precondition: the indicator really is on pane row 0 and '
    + 'NOWHERE in the bottom four rows',
    a.indicatorPaneRows.join(',') , '0');
check('§A THE DEFECT, CLOSED: the detector sees tmux\'s copy-mode indicator on '
    + 'a pane holding real output', a.detector, true);
check('§A writeNeedsScrollExit therefore says a write must leave copy mode first',
    a.needsExit, true);
const aWire = await page.evaluate(({ s, src }) => {
    window.__wf = new Function('sid', 'data', `return (${src})(sid, data)`);
    return window.__wf(s, 'echo LANDS');
}, { s: SID, src: writeThroughFunnel.toString() });
num('§A what the funnel put on the wire', aWire);
check('§A the write funnel rides leave_scroll on the ssh_input event, which is '
    + 'what stops tmux discarding the bytes', aWire.leaveScroll, true);

// ---------------------------------------------------------------------------
// §B the S23 empty-pane shape must still be covered
// ---------------------------------------------------------------------------
console.log('\n--- §B the S23 empty-pane shape (indicator near the bottom) ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'bottom' });
await page.waitForTimeout(300);
const b = await page.evaluate(READ, SID);
num('§B pane state', b);
check('§B fixture precondition: the indicator is on a BOTTOM row, not row 0',
    b.indicatorPaneRows.length === 1 && b.indicatorPaneRows[0] > 0, true);
check('§B the empty-pane shape the S23 evidence recorded is still detected',
    b.detector, true);
check('§B and the funnel still spends leave_scroll there', (await page.evaluate(
    ({ s }) => window.__wf(s, 'x'), { s: SID })).leaveScroll, true);

// ---------------------------------------------------------------------------
// §C no indicator anywhere -> no copy mode, no leave_scroll
// ---------------------------------------------------------------------------
console.log('\n--- §C an ordinary pane at a prompt ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'none' });
await page.waitForTimeout(300);
const c = await page.evaluate(READ, SID);
num('§C pane state', c);
check('§C fixture precondition: no indicator anywhere in the pane',
    c.indicatorPaneRows.length, 0);
check('§C the detector answers false', c.detector, false);
check('§C writeNeedsScrollExit answers false', c.needsExit, false);
const cWire = await page.evaluate(({ s }) => window.__wf(s, 'echo plain'), { s: SID });
num('§C what the funnel put on the wire', cWire);
check('§C an ordinary write spends NO leave_scroll (a tmux query behind every '
    + 'keystroke is exactly what the narrow window exists to avoid)',
    cWire.leaveScroll, false);

// ---------------------------------------------------------------------------
// §D the false-positive line: indicator SHAPE on a middle row is not copy mode
// ---------------------------------------------------------------------------
console.log('\n--- §D ordinary output ending in "[3/60]" on a middle row ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'middle' });
await page.waitForTimeout(300);
const d = await page.evaluate(READ, SID);
num('§D pane state', d);
check('§D fixture precondition: the indicator-shaped line is on a MIDDLE row',
    d.indicatorPaneRows.length === 1
    && d.indicatorPaneRows[0] > 0
    && d.indicatorPaneRows[0] < d.paneRows - 4, true);
check('§D it does NOT read as copy mode -- the scanned windows are the two '
    + 'places tmux itself writes, not the whole pane', d.detector, false);
check('§D and no leave_scroll is spent',
    (await page.evaluate(({ s }) => window.__wf(s, 'y'), { s: SID })).leaveScroll,
    false);

// ---------------------------------------------------------------------------
// §E S30-B — what counts as the pointer interaction itself
// ---------------------------------------------------------------------------
/*
 * The classification is the whole fix, so it is checked directly rather than
 * only through its consequence. Two directions have to hold at once:
 *
 *   the scroll's own bytes must be recognised -- one report, and the several a
 *   single touchmove produces (a 27.5px move over a 14px cell dispatches two
 *   wheels, /tmp/s26reg/s30_p9b.log section J3), which arrive at the funnel
 *   concatenated;
 *
 *   and NOTHING ELSE must be, because every payload this predicate claims is a
 *   payload that loses its copy-mode exit -- which is the S23 R4 defect coming
 *   back for that write. So a composer line that merely CONTAINS report text is
 *   a deliberate write, and a truncated or mistyped sequence is not a report.
 */
console.log('\n--- §E S30-B payload classification ---');
const CLASSIFY = () => {
    const R = (d) => window.TerminalManager.dataIsMouseReport(d);
    const rep = '\x1b[<64;26;31M';
    return {
        onePress: R(rep),
        oneRelease: R('\x1b[<64;26;31m'),
        twoConcatenated: R(rep + '\x1b[<64;26;33M'),
        eightConcatenated: R(new Array(8).fill(rep).join('')),
        composerLeadingText: R('echo ' + rep),
        composerTrailingText: R(rep + ' echo hi'),
        composerReportInsideWord: R('a' + rep + 'b'),
        truncatedNoFinalByte: R('\x1b[<64;26;31'),
        missingEsc: R('[<64;26;31M'),
        wrongFinalByte: R('\x1b[<64;26;31X'),
        notSgr: R('\x1b[M \x1a!'),
        plainKeystroke: R('a'),
        carriageReturn: R('\r'),
        del: R('\x7f'),
        empty: R(''),
        nullData: R(null),
        undefinedData: R(undefined),
        numberData: R(12),
        objectData: R({ toString: () => rep }),
    };
};
const e = await page.evaluate(CLASSIFY);
num('§E classification', e);
check('§E one SGR press report is the pointer interaction', e.onePress, true);
check('§E so is the matching release report (final byte m, which is what a '
    + 'drag-protocol client also emits)', e.oneRelease, true);
check('§E two concatenated reports -- one touchmove crossing two cells -- '
    + 'are still the pointer interaction, not a write', e.twoConcatenated, true);
check('§E and a whole gesture\'s worth of them likewise',
    e.eightConcatenated, true);
check('§E a composer line with text BEFORE report bytes is a deliberate '
    + 'write and must keep its copy-mode exit', e.composerLeadingText, false);
check('§E text AFTER them, likewise', e.composerTrailingText, false);
check('§E report bytes embedded mid-word, likewise',
    e.composerReportInsideWord, false);
check('§E a truncated sequence with no final byte is not a report',
    e.truncatedNoFinalByte, false);
check('§E neither is the same digits without the escape (this is exactly the '
    + 'shape the debris left in the shell line, and typing it must still work)',
    e.missingEsc, false);
check('§E nor a sequence ending in some other letter', e.wrongFinalByte, false);
check('§E nor X10/normal-mode mouse bytes, which this build never emits '
    + '(rows D/E are reached only when SGR is observed)', e.notSgr, false);
check('§E an ordinary keystroke is a write', e.plainKeystroke, false);
check('§E so is Enter', e.carriageReturn, false);
check('§E so is DEL -- the composer\'s erase, the Owner\'s defect 5',
    e.del, false);
check('§E an empty payload is not a report', e.empty, false);
check('§E null is not a report', e.nullData, false);
check('§E undefined is not a report', e.undefinedData, false);
check('§E a number is not a report', e.numberData, false);
check('§E and neither is an object that merely stringifies to one -- the '
    + 'guard reads the payload, it does not coerce it', e.objectData, false);

// ---------------------------------------------------------------------------
// §F S30-B THE BITING ROW — the same pane §A flags, now scrolled
// ---------------------------------------------------------------------------
/*
 * §A proved that on this pane a deliberate write MUST carry the advisory. This
 * section proves the scroll's own reports must NOT, on that identical pane --
 * because the server honours the advisory by exiting copy mode INLINE BEFORE the
 * write (socket_events.py:1188-1196), so a flagged report is written into a pane
 * that is no longer in a mode, where readline prints it as raw text and eats the
 * next write's leading character (/tmp/s26reg/s30_p8.log sections I1/I3).
 */
console.log('\n--- §F S30-B a full pane in copy mode, scroll reports vs writes ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'top' });
await page.waitForTimeout(300);
const fPre = await page.evaluate(READ, SID);
num('§F precondition', fPre);
check('§F precondition: this is the §A pane -- detector true and '
    + 'writeNeedsScrollExit true, so a write here WOULD be flagged',
    fPre.detector && fPre.needsExit, true);
const fRep = await page.evaluate(
    ({ s }) => window.__wf(s, '\x1b[<64;26;31M'), { s: SID });
num('§F one scroll report through the funnel', fRep);
check('§F THE DEFECT, CLOSED: the scroll\'s own report does NOT ask the '
    + 'server to leave copy mode', fRep.leaveScroll, false);
check('§F and its bytes still reach the wire unchanged, which is what makes '
    + 'the gesture scroll at all', fRep.data, '\x1b[<64;26;31M');
const fPair = await page.evaluate(
    ({ s }) => window.__wf(s, '\x1b[<64;26;31M\x1b[<64;26;33M'), { s: SID });
num('§F one touchmove\'s two reports', fPair);
check('§F the two reports one touchmove produces are suppressed together',
    fPair.leaveScroll, false);
check('§F both still reach the wire',
    fPair.data, '\x1b[<64;26;31M\x1b[<64;26;33M');
const fWrite = await page.evaluate(
    ({ s }) => window.__wf(s, 'echo LANDS'), { s: SID });
num('§F a deliberate write on the same pane', fWrite);
check('§F the suppression is per PAYLOAD, not sticky: the very next '
    + 'deliberate write still carries the advisory', fWrite.leaveScroll, true);
const fMixed = await page.evaluate(
    ({ s }) => window.__wf(s, 'echo \x1b[<64;26;31M'), { s: SID });
num('§F a deliberate write containing report text', fMixed);
check('§F a composer line that merely CONTAINS report bytes is still a write '
    + 'and still leaves copy mode -- otherwise S30-B would reopen the discard '
    + 'defect for that line', fMixed.leaveScroll, true);
const fDel = await page.evaluate(({ s }) => window.__wf(s, '\x7f'), { s: SID });
num('§F the composer\'s erase', fDel);
check('§F DEL after a swipe still leaves copy mode -- this is the Owner\'s '
    + 'defect 5 and S30-B must not touch it', fDel.leaveScroll, true);

// ---------------------------------------------------------------------------
// §M MUTATION — reinstall the pre-S30 four-rows-only reader
// ---------------------------------------------------------------------------
console.log('\n--- §M mutation: the pre-S30 reader (bottom four rows only) ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'top' });
await page.waitForTimeout(300);
await page.evaluate(() => {
    window.__origIndicator = TerminalManager.tmuxPaneInCopyModeIndicator;
    // The shipped S23 method, verbatim, before the top-row check was added.
    TerminalManager.tmuxPaneInCopyModeIndicator = function (terminal) {
        if (!terminal || !terminal.buffer || !terminal.buffer.active) return false;
        try {
            const buf = terminal.buffer.active;
            const last = buf.viewportY + terminal.rows - 1;
            const first = Math.max(0, last - 3);
            for (let r = last; r >= first; r -= 1) {
                const line = buf.getLine(r);
                if (!line) continue;
                if (/\[[0-9]+\/[0-9]+\]\s*$/.test(line.translateToString(true))) {
                    return true;
                }
            }
            return false;
        } catch (e) { return false; }
    };
});
const m = await page.evaluate(READ, SID);
num('§M pane state under the mutant', m);
check('§M the mutant misses the indicator on the pane\'s top row -- this is the '
    + 'production defect', m.detector, false);
check('§M so writeNeedsScrollExit goes false again', m.needsExit, false);
const mWire = await page.evaluate(({ s }) => window.__wf(s, 'echo LANDS'), { s: SID });
num('§M what the funnel put on the wire under the mutant', mWire);
check('§M and the funnel spends NO leave_scroll, which is exactly how tmux came '
    + 'to discard every composer write after a swipe', mWire.leaveScroll, false);

await page.evaluate(() => {
    TerminalManager.tmuxPaneInCopyModeIndicator = window.__origIndicator;
});
const r2 = await page.evaluate(READ, SID);
check('§M restored: the shipped reader detects it again', r2.detector, true);


// ---------------------------------------------------------------------------
// §N MUTATION — remove the S30-B guard
// ---------------------------------------------------------------------------
/*
 * The pre-S30-B funnel asked writeNeedsScrollExit alone. Making the predicate
 * answer false for everything reproduces that funnel exactly, without editing a
 * source file, and §F must go red: the scroll's own reports get flagged again,
 * which is the measured debris path.
 */
console.log('\n--- §N mutation: the pre-S30-B funnel (no payload guard) ---');
await page.evaluate(({ s, w }) => window.__paint(s, w), { s: SID, w: 'top' });
await page.waitForTimeout(300);
await page.evaluate(() => {
    window.__origIsMouseReport = TerminalManager.dataIsMouseReport;
    TerminalManager.dataIsMouseReport = () => false;
});
const nRep = await page.evaluate(
    ({ s }) => window.__wf(s, '\x1b[<64;26;31M'), { s: SID });
num('§N one scroll report under the mutant', nRep);
check('§N the mutant flags the scroll\'s own report, so the server exits copy '
    + 'mode and then writes those bytes into a live pane -- this is the Owner\'s '
    + 'raw-escape debris', nRep.leaveScroll, true);
await page.evaluate(() => {
    TerminalManager.dataIsMouseReport = window.__origIsMouseReport;
});
const nRestored = await page.evaluate(
    ({ s }) => window.__wf(s, '\x1b[<64;26;31M'), { s: SID });
check('§N restored: the shipped guard suppresses it again',
    nRestored.leaveScroll, false);

check('§Z no page errors', errors, []);

await ctx.close();
await browser.close();
server.close();

console.log(`\ntmux_copy_mode_indicator_row: ${pass} passed, ${fail} failed`);
if (fail) {
    console.log('FAILED ROWS:');
    failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
