// Trusted-touch (CDP Input.dispatchTouchEvent) verification of the mobile
// focus + long-press fix, driven through the REAL terminal-manager.js AND the
// REAL session-manager.js focusActivePane — not synthetic dispatchEvent (that
// gap is what shipped the original bug). The fixture builds a real xterm via
// the real terminal-manager.js; we additionally load the real session-manager.js
// and wire the real .terminal-pane click -> focusActivePane chain, so the full
// tap -> synthetic-click -> focusActivePane race runs exactly as in production.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// The checkout this gate lives in. It used to be the deployment path,
// which made the gate pass on one server and 404 everywhere else.
const sourceRoot = path.resolve(import.meta.dirname, '../..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css' };
function startServer(){
  const s=http.createServer((req,res)=>{
    const rel=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'');
    const fp=path.join(sourceRoot,rel);
    if(!fp.startsWith(sourceRoot)||!fs.existsSync(fp)||!fs.statSync(fp).isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'});
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s)));
}

let passed=0, failed=0;
function check(label, got, want){
  const ok = got===want;
  if(ok) passed++; else failed++;
  console.log(`${ok?'PASS':'FAIL'}  ${label}  => got ${got} | want ${want}`);
}

const server=await startServer();
const {port}=server.address();
const browser=await chromium.launch();
// hasTouch + iPhone 12 Pro Max CSS viewport so isMobile() is true via width too.
const context=await browser.newContext({hasTouch:true, viewport:{width:428,height:926},
  permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
await page.goto(`http://127.0.0.1:${port}/tests/browser/fixture.html`);
await page.waitForFunction('window.__ready === true',{timeout:10000});

// Load the REAL session-manager.js (defines global const SessionManager; it has
// no load-time side effects — it's a plain object literal).
await page.addScriptTag({ url: `http://127.0.0.1:${port}/static/js/session-manager.js` });

// Wire the real production chain around the fixture's real terminal.
const key = await page.evaluate(() => {
  const KEY = window.__probe.key;                 // 'test'
  const wrapper = document.getElementById('term'); // .terminal-wrapper
  // The real setActivePane() bails out unless #terminalGrid exists (it looks the
  // panes up inside it), so build the pane inside a real grid.
  const grid = document.createElement('div');
  grid.id = 'terminalGrid';
  wrapper.parentNode.insertBefore(grid, wrapper);
  // Put the wrapper inside a real .terminal-pane with the real click handler.
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.paneIndex = '0';
  grid.appendChild(pane);
  pane.appendChild(wrapper);
  pane.addEventListener('click', () => { SessionManager.focusActivePane(); });
  // A visible #mobileInput (offsetParent !== null) like the real session-bar.
  const inp = document.createElement('input');
  inp.id = 'mobileInput'; inp.type = 'text';
  document.body.appendChild(inp);
  // Point SessionManager at the fixture's terminal.
  SessionManager.paneAssignments = [KEY];
  SessionManager.activePaneIndex = 0;
  return KEY;
});

const geo=await page.evaluate(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
const cx=Math.round(geo.x+geo.w/2), cy=Math.round(geo.y+geo.h/2);
const client=await context.newCDPSession(page);
const activeId = () => page.evaluate(() => {
  const a=document.activeElement;
  if(!a) return 'null';
  if(a.id) return '#'+a.id;
  if((''+a.className).includes('xterm-helper-textarea')) return 'xterm-textarea';
  return a.tagName;
});
async function tap(){
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
const blur = () => page.evaluate(()=>document.activeElement&&document.activeElement.blur());

// Case 1 — FIRST tap after load. P1 Composer-authoritative contract
// (plan §2.2): on a touch shell the composer is the sole input
// surface, so a terminal tap routes focus to #mobileInput (via
// setupComposerInputOwnership's click handler), never to xterm's hidden
// textarea. (The F1 expectation of xterm-textarea is superseded.)
// Still guards lastTap=-Infinity.
await blur();
await tap(); await page.waitForTimeout(450);
check('1) first single tap -> composer (P1: composer authoritative)', await activeId(), '#mobileInput');

// Case 2 — double tap AT THE SAME SPOT. P1 §2.2: no raw-focus exception
// remains on touch; the double-tap branch preventDefaults (zoom) and focuses
// #mobileInput, re-asserting after xterm's synthetic mousedown.
await tap(); await page.waitForTimeout(90); await tap(); await page.waitForTimeout(450);
check('2) double tap (same spot) -> composer (P1: no raw focus)', await activeId(), '#mobileInput');
// _wantRawFocus is gone: the double-tap branch calls terminal.focus() directly,
// so there is no flag to consume. Assert the dead property is truly absent
// rather than re-checking a value it no longer has.
check('2b) _wantRawFocus removed from TerminalManager',
  await page.evaluate(()=>Object.prototype.hasOwnProperty.call(TerminalManager,'_wantRawFocus')), false);

// Case 3 — a single tap after the double. P1 Composer-authoritative: every
// touch-shell tap path ends on #mobileInput; the composer is the sole owner.
await tap(); await page.waitForTimeout(450);
check('3) single after double -> composer (P1: composer authoritative)', await activeId(), '#mobileInput');

// Case 3b — two taps that are TEMPORALLY close but SPATIALLY far (> DOUBLE_TAP_PX)
// must NOT be read as a double-tap (the distance-check regression this was added
// for still holds). Under the P1 contract both paths (single and double) end on
// the composer, so the DISTINCTION must be proven by the double-tap branch's
// observable side channel, not by focus: the near pair fires the branch's
// preventDefault (suppressing the synthetic click), the far pair must not.
// We spy preventDefault by wrapping touchend dispatch capture on the wrapper.
await blur();
async function tapAt(x, y){
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
await page.evaluate(() => {
  window.__pdEvents = [];
  const w = document.querySelector('.terminal-wrapper');
  w.addEventListener('touchend', (e) => {
    window.__pdEvents.push(e.defaultPrevented);
  }, { capture: false });
});
await tapAt(cx, cy); await page.waitForTimeout(90);
// 120px to the LEFT: the fixture terminal is wider than the 428px viewport, so
// cx+120 would land outside it and hit <body> instead of the wrapper.
await tapAt(cx - 120, cy);          // same 90ms window, but 120px away
await page.waitForTimeout(450);
const farPairPD = await page.evaluate(() => window.__pdEvents);
check('3b) far-apart pair is not read as a double-tap (no branch preventDefault)',
  farPairPD.includes(true), false);
check('3b) both close-in-time far-apart taps end on the composer (P1)',
  await activeId(), '#mobileInput');

// Case 4 — tab-switch funnels into focusActivePane. Dated amendment
// (F1-Strict-Focus): on mobile focusActivePane is a strict-focus NO-OP — it must
// update pane/session/layout only and never focus the composer or xterm's
// textarea. After blur() the active element is BODY; it must stay BODY.
await blur();
await page.evaluate(()=>SessionManager.focusActivePane());
await page.waitForTimeout(50);
check('4) tab-switch (focusActivePane) -> BODY (F1: no auto-focus)', await activeId(), 'BODY');

// Case 5 — DESKTOP tap keeps terminal focus. The branch under test is the
// double-tap `else -> terminal.focus()` arm, gated on isTouchShell() — the real
// shell-capability helper (TOUCH_SHELL_QUERY media query), not the width-only
// isMobile(). Stub the capability itself: override the media query the helper
// reads, so the composer-redirect listener (focusin, also isTouchShell-gated)
// and the double-tap branch take the desktop path together — exactly what a
// fine-pointer device does. isMobile() is untouched.
await blur();
await tap(); await page.waitForTimeout(90);
await page.evaluate(()=>{ window.__origIsTouchShell = TerminalManager.isTouchShell; TerminalManager.isTouchShell = () => false; });
await tap(); await page.waitForTimeout(450);
check('5) desktop double-tap -> terminal (else arm of isTouchShell)', await activeId(), 'xterm-textarea');
await page.evaluate(()=>{ TerminalManager.isTouchShell = window.__origIsTouchShell; });

// Case 5b — mobile but #mobileInput hidden (offsetParent null) -> terminal.
await blur();
await page.evaluate(()=>{ document.getElementById('mobileInput').style.display='none'; });
await tap(); await page.waitForTimeout(450);
check('5b) mobile + input hidden -> terminal', await activeId(), 'xterm-textarea');
await page.evaluate(()=>{ document.getElementById('mobileInput').style.display=''; });

// Case 6 — long-press still selects WITH the FIX 1 CSS applied (proves the
// callout/user-select suppression does not break terminal.select()). CDP does
// NOT emit the iOS callout touchcancel, so this only regression-proves the
// timer->select path; the callout suppression itself needs a real iPhone.
await page.evaluate(() => {
  const st=document.createElement('style');
  st.textContent='.terminal-wrapper .xterm,.terminal-wrapper .xterm-screen{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}';
  document.head.appendChild(st);
  window.__probe.disableAppMouse(); window.__probe.clearSelection();
  window.__probe.term.write('\x1b[H\x1b[2JLONGPRESS_SELECT_TEST_LINE_0123456789\r\n');
});
await page.waitForTimeout(80);
// Anchor at the terminal CENTER, not a corner: CDP will not dispatch touchEnd
// for a touch that started right at the top edge (verified: corner => touchend
// count=0; center => touchend fires). Nothing to do with the code under test.
const lpx=cx, lpy=cy;
await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:lpx,y:lpy}]});
await page.waitForTimeout(620);
const held=await page.evaluate(()=>({sel:window.__probe.hasSelection(), cls:document.querySelector('.terminal-wrapper').classList.contains('touch-selecting')}));
check('6) long-press hasSelection (with FIX1 CSS)', held.sel, true);
check('6b) long-press adds .touch-selecting', held.cls, true);
// A touchMove then touchEnd lifts the finger: endSelection() must clear the
// class and (real device) copy the selection. (The move also extends selection.)
await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:lpx+120,y:lpy}]});
await page.waitForTimeout(40);
await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await page.waitForTimeout(100);
const afterLift=await page.evaluate(()=>document.querySelector('.terminal-wrapper').classList.contains('touch-selecting'));
check('6c) touchEnd clears .touch-selecting', afterLift, false);

// Case 7 — a swipe (>10px) must NOT enter selection (long-press cancelled).
await page.evaluate(()=>{ window.__probe.clearSelection(); });
await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy}]});
await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx,y:cy-60}]});
await page.waitForTimeout(60);
const swSel=await page.evaluate(()=>({sel:window.__probe.hasSelection(), cls:document.querySelector('.terminal-wrapper').classList.contains('touch-selecting')}));
await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
check('7) swipe does not select', swSel.sel || swSel.cls, false);

// Helpers for the remaining cases: record showNotification calls and stub the
// clipboard so the toast reflects the REAL promise outcome.
async function installNotifyRecorder(clipboardMode){
  await page.evaluate((mode) => {
    window.__notes = [];
    window.i18n = { t: (k) => k };                       // toast asserts on the key
    window.showNotification = (msg, type) => window.__notes.push([msg, type]);
    // navigator.clipboard is read-only in Chromium; redefine the whole object.
    const impl = mode === 'reject'
      ? { writeText: () => Promise.reject(new Error('NotAllowedError')) }
      : mode === 'missing'
        ? {}
        : { writeText: () => Promise.resolve() };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => impl });
  }, clipboardMode);
}
const notes = () => page.evaluate(()=>{ const n=window.__notes.slice(); window.__notes.length=0; return n; });

// Long-press + drag + lift, ending inside the 428px viewport (the fixture
// terminal is 780px wide, so a rightward drag would leave the window).
async function longPressCopy(x=cx, y=cy){
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  await page.waitForTimeout(620);
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-120,y,id:1}]});
  await page.waitForTimeout(40);
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(150);
}

// Cases 8/8b/8c — the clipboard TOAST must reflect the real promise outcome.
// These call the shipped reportCopyResult() directly rather than going through a
// long-press: verified in this fixture that terminal.getSelection() returns ''
// even with text on every row, so a gesture-driven copy never reaches the
// clipboard branch at all (reportCopyResult is only called for a non-empty
// selection). Driving the method with real text is what actually exercises the
// resolve/reject/missing paths that shipped the "always Copied" bug.
await installNotifyRecorder('reject');
await notes();
await page.evaluate(async ()=>{ TerminalManager.reportCopyResult('SOME_TEXT'); });
await page.waitForTimeout(120);
const rejectNotes = await notes();
check('8) clipboard reject toasts copyFailed (not copied)',
  rejectNotes.some(([m])=>m==='clipboard.copyFailed') && !rejectNotes.some(([m])=>m==='clipboard.copied'),
  true);

await installNotifyRecorder('resolve');
await notes();
await page.evaluate(async ()=>{ TerminalManager.reportCopyResult('SOME_TEXT'); });
await page.waitForTimeout(120);
const okNotes = await notes();
check('8b) clipboard resolve toasts copied',
  okNotes.some(([m])=>m==='clipboard.copied') && !okNotes.some(([m])=>m==='clipboard.copyFailed'),
  true);

await installNotifyRecorder('missing');
await notes();
await page.evaluate(async ()=>{ TerminalManager.reportCopyResult('SOME_TEXT'); });
await page.waitForTimeout(120);
const missNotes = await notes();
check('8c) missing clipboard API toasts copyFailed',
  missNotes.some(([m])=>m==='clipboard.copyFailed'), true);

// Case 9 — MULTI-TOUCH (pinch): a second finger poisons the gesture. Lifting the
// two fingers one after the other must not read as two taps (i.e. a double-tap
// into raw xterm), must not copy, and must leave no .touch-selecting behind.
await installNotifyRecorder('resolve');
await page.evaluate(()=>{ window.__probe.clearSelection(); });
await blur();
await notes();
// Each touch point MUST carry a distinct id, otherwise CDP coalesces them and
// the page only ever sees a single finger (verified: without ids the second
// touchStart never reaches the listener at all).
await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy,id:1}]});
await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy,id:1},{x:cx-80,y:cy+40,id:2}]});
await page.waitForTimeout(620);      // outlast LONG_PRESS_MS: no selection may start
const duringPinch = await page.evaluate(()=>({
  cls: document.querySelector('.terminal-wrapper').classList.contains('touch-selecting'),
  sel: window.__probe.hasSelection(),
}));
check('9) two fingers do not start a selection', duringPinch.cls || duringPinch.sel, false);
// Lift the fingers one at a time: the first touchend still reports one finger
// down, which must not complete a tap.
await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[{x:cx,y:cy,id:1}]});
await page.waitForTimeout(60);
await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await page.waitForTimeout(450);
check('9b) staggered two-finger lift is not a double-tap (no raw focus)',
  await activeId() === 'xterm-textarea', false);
const pinchNotes = await notes();
check('9c) pinch produces no copy toast', pinchNotes.length, 0);
check('9d) pinch leaves no .touch-selecting',
  await page.evaluate(()=>document.querySelector('.terminal-wrapper').classList.contains('touch-selecting')), false);

// Case 10 — after a pinch sequence, ordinary gestures still work (state was
// reset, not left poisoned). P1 Composer-authoritative: a single tap after
// pinch ends on #mobileInput; the point is that the gesture state recovered
// and the composer is still reachable through the ordinary path.
await blur();
await tap(); await page.waitForTimeout(450);
check('10) single tap after pinch -> composer (P1: state recovered)', await activeId(), '#mobileInput');
// ...and a long-press still selects.
await page.evaluate(()=>{ window.__probe.clearSelection(); });
await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy}]});
await page.waitForTimeout(620);
check('10b) long-press still selects after pinch',
  await page.evaluate(()=>window.__probe.hasSelection()), true);
await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await page.waitForTimeout(120);

// Case 11 — long-press on an INACTIVE pane must activate the touched pane first
// (so any later input goes to the touched session). Dated amendment
// (F1-Strict-Focus): the copy path must NOT then redirect focus to the composer;
// it leaves the active element as BODY. The wrapper lives in pane index 0;
// make pane 1 the active one and spy on the real setActivePane.
await installNotifyRecorder('resolve');
await page.evaluate(() => {
  // A second (empty) pane so index 1 is a legitimate active pane.
  const pane2 = document.createElement('div');
  pane2.className = 'terminal-pane';
  pane2.dataset.paneIndex = '1';
  document.body.appendChild(pane2);
  SessionManager.paneAssignments = [window.__probe.key, null];
  SessionManager.activePaneIndex = 1;             // pane 0 (touched) is NOT active
  window.__setActive = [];
  const orig = SessionManager.setActivePane.bind(SessionManager);
  SessionManager.setActivePane = (i) => { window.__setActive.push(i); return orig(i); };
});
await blur();
await page.evaluate(()=>{ window.__probe.clearSelection(); });
await longPressCopy();
// check() compares with ===, so compare the recorded calls as a JSON string.
check('11) long-press on inactive pane activates the touched pane (index 0)',
  await page.evaluate(()=>JSON.stringify(window.__setActive)), '[0]');
check('11b) touched pane became active',
  await page.evaluate(()=>SessionManager.activePaneIndex), 0);
check('11c) long-press copy does NOT focus composer (F1: stays BODY)',
  await activeId(), 'BODY');

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close(); server.close();
process.exit(failed>0?1:0);
