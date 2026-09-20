#!/usr/bin/env node
/*
 * TWO DEVICES ON ONE tmux SESSION, against the deployed build.
 *
 * tmux draws ONE window at ONE size (measured 2026-09-13: grouped sessions,
 * `window-size` in every mode and `aggressive-resize` all leave two clients of
 * the same window at the same size -- a pane has one grid). So the owner's
 * four reports are about how a client PRESENTS a window that is not its own
 * fit, and this gate pins that presentation on the real server:
 *
 *   §1 a desktop alone renders its own fit at the base font;
 *   §2 a phone joins: the desktop's engine takes the shared window, and the
 *      painted grid FILLS the pane (no cut frame, no black band below);
 *   §3 the desktop is not blank while shrunk;
 *   §4 the phone with its keyboard up (short pane, alternate-screen hold is
 *      not exercised here) still shows the whole grid inside its pane;
 *   §5 the phone leaves: the desktop returns to its fit and base font within
 *      a few seconds and is NOT blank (the "empty frame" report);
 *   §6 an idle desktop reports no resize churn (the "window jitter" report).
 *
 * Run (on the deploy host, from source/):
 *     node tests/browser/two_device_live.mjs
 */
import { launch, login, attachExisting, settle, C } from './harness_live.mjs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}
const checkTrue = (label, v) => check(label, v === true, true);
const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);

/* Everything a device says about its own presentation of a session. */
const READ = (page, sid) => page.evaluate((s) => {
    const key = (TerminalManager.sessionTerminals[s] || [])[0];
    const t = TerminalManager.terminals[key];
    const wrapper = TerminalManager.terminalContainers[s];
    const screen = t.element.querySelector('.xterm-screen');
    const w = wrapper.getBoundingClientRect();
    const sc = screen.getBoundingClientRect();
    const buf = t.buffer.active;
    let painted = 0;
    for (let i = 0; i < t.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line && line.translateToString(true).trim() !== '') painted++;
    }
    return {
        cols: t.cols, rows: t.rows, font: t.options.fontSize,
        base: TerminalManager.baseFontSize ?? null,
        window: TerminalManager.windowGeometry[s] || null,
        reported: TerminalManager.reportedSizes[s]
            ? [TerminalManager.reportedSizes[s].cols, TerminalManager.reportedSizes[s].rows] : null,
        wrapper: { w: Math.round(w.width), h: Math.round(w.height) },
        screen: { w: Math.round(sc.width), h: Math.round(sc.height),
                  top: Math.round(sc.top - w.top), left: Math.round(sc.left - w.left) },
        fillW: +(sc.width / w.width).toFixed(2), fillH: +(sc.height / w.height).toFixed(2),
        painted, bufferType: buf.type,
    };
}, sid);

const desktop = await launch({ engine: 'chromium', width: 1440, height: 900 });
await login(desktop.page);
const { sid, info } = await attachExisting(desktop.page, { host: C.SSH_HOST || null });
await settle(desktop.page, sid);
await desktop.page.waitForTimeout(1500);

// §1
const alone = await READ(desktop.page, sid);
num('§1 desktop alone', alone);
/*
 * "Alone" is a precondition this harness cannot enforce: the owner's own
 * browser may be attached to the same tmux session, and then the window is
 * that device's minimum, not this desktop's fit (seen 2026-09-13: window 126
 * cols against a 165-col fit). The fill rows are meaningful only when the
 * window really is this pane's fit; otherwise they are reported and skipped.
 */
const constrained = (m) => m.window
    && (m.window.cols < m.reported[0] || m.window.rows < m.reported[1]);
if (constrained(alone)) {
    console.log(`      [harness] another client holds this window at ${alone.window.cols}x${alone.window.rows}`
        + ` (this pane fits ${alone.reported[0]}x${alone.reported[1]}); §1 fill skipped`);
} else {
    checkTrue('§1 the engine is the pane\'s own fit (fills the pane)', alone.fillW > 0.9 && alone.fillH > 0.9);
}
check('§1 base font', alone.font, alone.base ?? alone.font);
checkTrue('§1 painted', alone.painted > 0);

// §2 a phone joins the same session
const phone = await launch({ engine: 'chromium', width: 390, height: 844, touch: true });
await login(phone.page);
const { sid: psid } = await attachExisting(phone.page, { host: info.host, user: info.user });
await settle(phone.page, psid);
await phone.page.waitForTimeout(2500);
const shrunk = await READ(desktop.page, sid);
const pview = await READ(phone.page, psid);
num('§2 desktop with phone', shrunk);
num('§2 phone', pview);
checkTrue('§2 GUARD: the phone\'s fit is smaller than the desktop\'s', pview.cols < alone.cols);
check('§2 desktop engine == shared window', [shrunk.cols, shrunk.rows],
    shrunk.window ? [shrunk.window.cols, shrunk.window.rows] : null);
check('§2 phone engine == shared window', [pview.cols, pview.rows],
    pview.window ? [pview.window.cols, pview.window.rows] : null);
checkTrue('§2 the shrunk desktop grid FILLS its pane on one axis (no cut frame, no black band)',
    shrunk.fillW > 0.9 || shrunk.fillH > 0.9);
checkTrue('§2 and is centred horizontally',
    Math.abs(shrunk.screen.left * 2 + shrunk.screen.w - shrunk.wrapper.w) < 40);
checkTrue('§2 zoomed only if the window is below the fit on BOTH axes',
    (shrunk.rows < alone.rows && shrunk.cols < alone.cols) ? shrunk.font > alone.font : shrunk.font === alone.font);
checkTrue('§2 the desktop still REPORTS its true fit (the minimum can grow back)',
    !!shrunk.reported && shrunk.reported[0] >= alone.cols - 1);

// §3
checkTrue('§3 the shrunk desktop is not blank', shrunk.painted > 0);

/*
 * §3b WHAT THE DESKTOP ACTUALLY SHOWS. `painted > 0` is not enough: measured
 * 2026-09-14, a desktop whose window shrank holds 165-cell lines whose first
 * 49 columns are the window and whose tail is tmux's `·` filler (tmux draws
 * the smaller window at the LEFT of a wider client and fills the rest). The
 * renderer shows only `cols` columns, so the filler must be OUTSIDE them, and
 * what is inside must be the same text the phone is looking at.
 */
const visible = (page, id) => page.evaluate((s) => {
    const t = TerminalManager.terminals[(TerminalManager.sessionTerminals[s] || [])[0]];
    const buf = t.buffer.active; const out = [];
    for (let i = 0; i < t.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        out.push(line ? line.translateToString(true).slice(0, t.cols).replace(/\s+$/, '') : '');
    }
    return out;
}, id);
const dView = await visible(desktop.page, sid);
const pView = await visible(phone.page, psid);
num('§3b desktop visible head', dView.filter(l => l).slice(0, 3));
check('§3b no tmux filler inside the desktop\'s visible columns',
    dView.filter(l => /·{4}/.test(l)).length, 0);
check('§3b the desktop shows the same lines as the phone',
    dView.filter(l => l).slice(0, 5), pView.filter(l => l).slice(0, 5));

// §4 the phone with the keyboard up: the app pins the shell to --app-height
await phone.page.evaluate(() => {
    document.documentElement.style.setProperty('--app-height', '420px');
    document.body.classList.add('keyboard-open');
    window.dispatchEvent(new Event('resize'));
});
await phone.page.waitForTimeout(2500);
const kb = await READ(phone.page, psid);
num('§4 phone keyboard up', kb);
if (kb.bufferType === 'alternate') {
    // 2026-09-14: the held grid keeps its rows and the TEXT shrinks, so the
    // whole grid stays inside the shortened pane (nothing anchored, no slack).
    checkTrue('§4 a held grid keeps its rows under the keyboard', kb.rows === pview.rows);
    checkTrue('§4 and shrinks its text to stay whole inside the shortened pane',
        kb.font < pview.font && kb.screen.top >= 0 && kb.screen.top + kb.screen.h <= kb.wrapper.h + 1);
} else {
    checkTrue('§4 the whole grid sits inside the shortened pane',
        kb.screen.top >= -1 && kb.screen.top + kb.screen.h <= kb.wrapper.h + 1);
}
checkTrue('§4 and fills it on one axis', kb.fillW > 0.9 || kb.fillH > 0.9);
await phone.page.evaluate(() => {
    document.documentElement.style.removeProperty('--app-height');
    document.body.classList.remove('keyboard-open');
    window.dispatchEvent(new Event('resize'));
});
await phone.page.waitForTimeout(1500);

// §6 idle churn on the desktop while both are attached
const churn0 = await desktop.page.evaluate(() => {
    window.__resizes = 0;
    const orig = window.socket.emit.bind(window.socket);
    window.socket.emit = (ev, ...a) => { if (ev === 'ssh_resize') window.__resizes++; return orig(ev, ...a); };
    return 0;
});
await desktop.page.waitForTimeout(4000);
const churn = await desktop.page.evaluate(() => window.__resizes);
num('§6 ssh_resize emitted by an idle desktop over 4s', churn + churn0);
check('§6 an idle desktop does not churn', churn, 0);

// §7 the desktop goes hidden and comes back while the phone is still on
await desktop.page.evaluate(s => { TerminalManager.detachViews([s]); TerminalManager.syncViews(); }, sid);
await desktop.page.waitForTimeout(3500);
const rejoined = await READ(desktop.page, sid);
num('§7 desktop re-attached with the phone still on', rejoined);
check('§7 engine == shared window after the re-attach', [rejoined.cols, rejoined.rows],
    rejoined.window ? [rejoined.window.cols, rejoined.window.rows] : null);
checkTrue('§7 and it is painted, not an empty frame', rejoined.painted > 0);

// §5 the phone leaves
await phone.browser.close();
await desktop.page.waitForTimeout(4000);
const back = await READ(desktop.page, sid);
num('§5 desktop after the phone left', back);
check('§5 the engine is back at the fit', [back.cols, back.rows], [alone.cols, alone.rows]);
check('§5 base font again', back.font, alone.font);
checkTrue('§5 the desktop is NOT blank after the phone left', back.painted > 0);
if (constrained(back)) {
    console.log(`      [harness] another client holds this window at ${back.window.cols}x${back.window.rows}; §5 fill skipped`);
} else {
    checkTrue('§5 and fills its pane again', back.fillW > 0.9 && back.fillH > 0.9);
}

check('§Z no page errors (desktop)', desktop.pageErrors, []);
await desktop.browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
