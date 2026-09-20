// Trusted verification of the mobile app-shell + notepad + zoom + reconnect-overlay
// fix, driven against the REAL static/css/style.css and (for the overlay) the REAL
// static/js/session-manager.js showReconnectOverlay — not synthetic copies.
//
// What is proven here (offline):
//   A  touch-action:manipulation on .terminal-wrapper, PORTRAIT *and* LANDSCAPE
//      (the rule is global, so the 926px-wide iPhone landscape is covered too).
//   B  .xterm-viewport has overscroll-behavior:contain; and the app-shell locks
//      page scroll (document not scrollable, body overflow hidden) so a swipe has
//      nothing to move on the page.
//   C  the shell height follows --app-height (fixed frame), and the mobile
//      min-height floors are gone (0px) in both portrait and the <=767 landscape
//      override.
//   D  .session-overlay is pointer-events:none and its card pointer-events:auto,
//      built by the REAL showReconnectOverlay; a trusted tap on the Reconnect
//      button fires its handler, a trusted tap on the dimmed backdrop passes
//      through to the element beneath.
//   Notepad the sheet is position:absolute;bottom:0 INSIDE .workspace, hidden by
//      default (translateY(100%), clipped away by the workspace so it never covers
//      the input bar) and shown with .mobile-open (rests on top of the input bar,
//      no overlap, input still tappable); toggled purely by #notepadOpenBtn.
//
// What still needs a real iPhone (documented in the plan): iOS double-tap-zoom
// suppression + pinch still working, real URL-bar/soft-keyboard behavior, the
// long-press callout/magnifier suppression over text (both orientations),
// rubber-band overscroll feel, and admin page still scrolling.
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
  console.log(`${ok?'PASS':'FAIL'}  ${label}  => got ${JSON.stringify(got)} | want ${JSON.stringify(want)}`);
}

const server=await startServer();
const {port}=server.address();
const base=`http://127.0.0.1:${port}`;
const browser=await chromium.launch();
const context=await browser.newContext({hasTouch:true, isMobile:true, viewport:{width:428,height:926}});
const page=await context.newPage();
await page.goto(`${base}/tests/browser/fixture.html`);
await page.waitForFunction('window.__ready === true',{timeout:10000});

// The fixture ships no <meta name="viewport">, so Chromium falls back to a 980px
// layout viewport and no @media(max-width:767px) rule would ever match — the exact
// opposite of the real index.html, which declares width=device-width. Inject it so
// the layout viewport equals the device width (428px) and the mobile rules apply,
// mirroring production. (The global touch-action rule matches regardless; only the
// media-scoped app-shell/notepad rules need this.)
await page.evaluate(() => {
  let m = document.querySelector('meta[name="viewport"]');
  if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
  m.setAttribute('content', 'width=device-width, initial-scale=1');
});
await page.waitForTimeout(50);

// Load the REAL shipped stylesheet over the fixture (fixture only ships xterm.css).
await page.addStyleTag({ url: `${base}/static/css/style.css` });
// deck.css owns the .deck-window shell box and MUST load after style.css,
// exactly as templates/index.html does. Without it the shell wrapper has no
// flex sizing and every geometry assertion below measures a broken layout.
await page.addStyleTag({ url: `${base}/static/css/deck.css` });
// Load the REAL session-manager.js (plain object literal, no load-time side effects).
await page.addScriptTag({ url: `${base}/static/js/session-manager.js` });
const client=await context.newCDPSession(page);

// ---------------------------------------------------------------------------
// Case A (#3/#4) — touch-action on .terminal-wrapper is now AUTO, not
// manipulation. `manipulation` failed to block iOS double-tap-zoom (WebKit bug)
// AND made iOS claim the gesture early, firing touchcancel that killed the
// long-press timer. It was removed; double-tap-zoom is blocked in JS instead
// (terminal-manager preventDefault on the second touchend). Verify AUTO in BOTH
// portrait (428w) and landscape (926w) — the old rule was global, so this proves
// it is gone everywhere. The fixture's #term carries class .terminal-wrapper.
// ---------------------------------------------------------------------------
const taPortrait = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.terminal-wrapper')).touchAction);
check('A) touch-action portrait (428w) is auto (manipulation removed)', taPortrait, 'auto');

await page.setViewportSize({width:926, height:428});           // iPhone 12 Pro Max landscape
await page.waitForTimeout(30);
const taLandscape = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.terminal-wrapper')).touchAction);
check('A) touch-action landscape (926w) is auto', taLandscape, 'auto');
await page.setViewportSize({width:428, height:926});

// ---------------------------------------------------------------------------
// Case B — overscroll containment on the xterm viewport (created by real xterm).
// ---------------------------------------------------------------------------
const overscroll = await page.evaluate(() => {
  const vp = document.querySelector('.xterm-viewport');
  return vp ? getComputedStyle(vp).overscrollBehaviorY : 'NO-VIEWPORT';
});
check('B) xterm-viewport overscroll-behavior contain', overscroll, 'contain');

// ---------------------------------------------------------------------------
// Case H — the session strip scrolls HORIZONTALLY ONLY.
//
// Reported from a production iPhone: the strip also drifted vertically. Two
// causes, both measured here with the real strip markup and enough real tabs to
// overflow the row. First, overflow-x:auto forces a non-visible used value on
// the other axis, so overflow-y computed `auto` although nothing declared it.
// Second, the strip's own vertical padding shrank its content box below the
// 44px tab height, which is what produced the scrollable slack (scrollHeight 53
// against clientHeight 45 before the fix, and scrollTop=40 clamping to 8).
//
// Both viewports the acceptance report names. The tab must stay 44px AND stay
// unclipped: pinning overflow-y over a short content box would have hidden the
// drift by cutting the tabs off instead.
//
// Uses its own page: the scaffold below replaces document.body wholesale.
// ---------------------------------------------------------------------------
{
  const stripMarkup = (() => {
    const src = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
    // Anchor on the row's real close (the </header> that follows it) rather than
    // on the first "</div></div>" pair: the lazy form silently truncated the
    // scaffold whenever the tag sequence inside the row changed.
    const m = src.match(/(<div class="session-tabs-row">[\s\S]*?\n {8}<\/div>)\n {4}<\/header>/);
    if (!m) throw new Error('could not extract .session-tabs-row from index.html');
    return m[1];
  })();
  check('H) extracted the real session strip from index.html',
    /id="sessionTabs"/.test(stripMarkup), true);
  // The scaffold must be the WHOLE row: a truncated capture used to surface only
  // as an opaque waitForFunction timeout further down.
  check('H) the extracted strip is balanced (whole row, not truncated)',
    (stripMarkup.match(/<div\b/g) || []).length
      === (stripMarkup.match(/<\/div>/g) || []).length, true);

  for (const [w, h] of [[390, 844], [360, 800]]) {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true,
                                           viewport: { width: w, height: h } });
    const sp = await ctx.newPage();
    await sp.goto(`${base}/tests/browser/fixture.html`);
    await sp.evaluate(() => {
      let m = document.querySelector('meta[name="viewport"]');
      if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
      m.setAttribute('content', 'width=device-width, initial-scale=1');
    });
    await sp.addStyleTag({ url: `${base}/static/css/style.css` });
    await sp.addStyleTag({ url: `${base}/static/css/deck.css` });
    await sp.evaluate(strip => {
      document.body.className = '';
      document.body.innerHTML =
        `<header class="header">${strip}</header>`
        + `<main class="main-content"><div class="workspace"></div></main>`;
      // Six tabs: more than fits, so the row really is horizontally scrollable
      // and any vertical slack is measurable rather than theoretical.
      const t = document.getElementById('sessionTabs');
      for (let i = 0; i < 6; i++) {
        const d = document.createElement('div');
        d.className = 'session-tab';
        d.setAttribute('role', 'tab');
        d.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        d.setAttribute('tabindex', '0');
        d.innerHTML = '<span class="status-dot connected"></span>'
          + `<span class="tab-label"><strong class="tab-host-name">host${i}.example.com</strong>`
          + `<small class="tab-user-name">user${i}</small></span>`;
        t.appendChild(d);
      }
    }, stripMarkup);
    // Dated test-harness synchronization amendment (not a product
    // change): under the suite's CPU load the injected tabs are not always laid
    // out within a fixed 60ms, so measuring too early reads a 0-height tab and a
    // non-overflowing strip. Replace the constant sleep with a readiness
    // predicate on the real preconditions of the geometry assertions (first tab
    // 44px, strip wider than its box). waitForFunction's options go in the third
    // position; the second is the page-function argument, so null is passed.
    // Every H acceptance assertion below is unchanged.
    await sp.waitForFunction(() => {
      const t = document.getElementById('sessionTabs');
      const tab = t && t.querySelector('.session-tab');
      return !!tab && Math.round(tab.getBoundingClientRect().height) === 44
          && t.scrollWidth > t.clientWidth;
    }, null, { timeout: 5000 });

    const m = await sp.evaluate(() => {
      const t = document.getElementById('sessionTabs');
      const cs = getComputedStyle(t);
      const box = t.getBoundingClientRect();
      const tab = t.querySelector('.session-tab').getBoundingClientRect();
      t.scrollTop = 40; const drift = t.scrollTop; t.scrollTop = 0;
      t.scrollLeft = 120; const panned = t.scrollLeft; t.scrollLeft = 0;
      return {
        oy: cs.overflowY, ta: cs.touchAction, obx: cs.overscrollBehaviorX,
        padY: `${cs.paddingTop}/${cs.paddingBottom}`,
        noSlack: t.scrollHeight === t.clientHeight,
        wider: t.scrollWidth > t.clientWidth,
        tabH: tab.height,
        unclipped: tab.top >= box.top - 0.5 && tab.bottom <= box.bottom + 0.5,
        drift, panned,
      };
    });

    check(`H) ${w}x${h}: overflow-y pinned hidden (not the implied auto)`, m.oy, 'hidden');
    check(`H) ${w}x${h}: touch-action pan-x confines the gesture`, m.ta, 'pan-x');
    check(`H) ${w}x${h}: overscroll-behavior-x contain (no scroll chaining)`, m.obx, 'contain');
    check(`H) ${w}x${h}: no vertical padding shrinking the content box`, m.padY, '0px/0px');
    check(`H) ${w}x${h}: no vertical scroll range at all`, m.noSlack, true);
    check(`H) ${w}x${h}: scrollTop stays 0 when driven to 40`, m.drift, 0);
    check(`H) ${w}x${h}: tab is still the 44px touch target`, m.tabH, 44);
    check(`H) ${w}x${h}: tab is not clipped by the pinned overflow`, m.unclipped, true);
    check(`H) ${w}x${h}: strip is still wider than its box`, m.wider, true);
    check(`H) ${w}x${h}: horizontal scrolling still works`, m.panned, 120);
    await ctx.close();
  }

  // The terminal keeps its own gestures: a non-auto touch-action there fired
  // touchcancel and killed long-press selection, so the fix must stay off it.
  // Comments are stripped FIRST -- the prose above (and the note near the
  // .xterm-viewport rules) names .terminal-wrapper while explaining why it has
  // no touch-action, and a text search would match the explanation itself.
  // Then every real rule is split on its own braces, so a selector list cannot
  // borrow declarations from the block before it.
  const cssSrcH = (await (await fetch(`${base}/static/css/style.css`)).text())
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const wrapperRules = [...cssSrcH.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => /(^|[\s>+~])\.terminal-wrapper(\b|$)/.test(s.trim())));
  check('H) found the real .terminal-wrapper rules to check', wrapperRules.length > 0, true);
  check('H) no touch-action landed on .terminal-wrapper',
    wrapperRules.some(m => /touch-action/.test(m[2])), false);
  // And the gesture constraint really is on the strip, not inherited from a
  // parent that would also cover the terminal.
  check('H) touch-action:pan-x is declared on .session-tabs itself',
    [...cssSrcH.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .some(m => /(^|,)\s*\.session-tabs\s*$/.test(m[1].split('{')[0].trim())
                 && /touch-action:\s*pan-x/.test(m[2])), true);
}

// ---------------------------------------------------------------------------
// Build a faithful app-shell scaffold for the shell / notepad / overlay cases.
// Mirrors index.html AFTER the chat-layout move: main.main-content >
// .workspace > .terminal-area > … > .terminal-wrapper, with .notepad-panel
// still INSIDE .workspace, and #sessionBar/.mobile-input-bar now the LAST child
// of .main-content (moved to the bottom). Real style.css is already loaded here.
//
// The complete #sessionBar is taken VERBATIM from templates/index.html rather
// than hand-written here. That keeps the one-row textarea, dock controls, and real
// More action ownership aligned with the production DOM.
// ---------------------------------------------------------------------------
const SESSION_BAR_MARKUP = (() => {
  const src = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
  // Anchor on the direct .deck-window close. A lazy nested-div match truncated
  // the block at #mobileInputBar or #mobileKeypad, while the former </main>
  // anchor became impossible when #sessionBar moved beside main.
  const m = src.match(
    /(<div class="session-bar hidden" id="sessionBar">[\s\S]*?\n {4}<\/div>)\n\n {4}<\/div><!-- \/.deck-window -->/);
  if (!m) throw new Error('could not extract #sessionBar from index.html');
  const block = m[1];
  if ((block.match(/<div\b/g) || []).length
      !== (block.match(/<\/div>/g) || []).length) {
    throw new Error('extracted #sessionBar is not balanced');
  }
  if ((block.match(/class="mobile-keypad-grid"/g) || []).length !== 2
      || (block.match(/class="keypad-key"/g) || []).length !== 16) {
    throw new Error('extracted #sessionBar does not contain the v5 2 x 8 keypad');
  }
  return block;
})();
// The v5 header row, also verbatim. Needed because #notepadOpenBtn -- the ONE
// Notes control after v5 removed #mobileNotepadBtn -- lives in
// .session-tabs-row (index.html:243-252), not in the dock. The scaffold used to
// inject an EMPTY <header>, so the control did not exist on this page at all
// and getElementById returned null. Amendment section 3 lines 35-40 place Ghi
// chú in the global/action row, so the header is part of the topology these
// dock-ownership assertions are about.
const HEADER_ROW_MARKUP = (() => {
  const src = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
  // Anchor on </header>, not on a nested </div>: the row contains several
  // nested divs, so a lazy match stopped at the first inner close and dropped
  // .tab-row-actions (which owns #notepadOpenBtn) entirely.
  const m = src.match(/(<div class="session-tabs-row">[\s\S]*?\n {8}<\/div>)\n {4}<\/header>/);
  if (!m) throw new Error('could not extract .session-tabs-row from index.html');
  return m[1];
})();
check('C) extracted the real header row from index.html',
  /id="notepadOpenBtn"/.test(HEADER_ROW_MARKUP), true);
// This is a fixture sanity check: it proves the markup really came from
// index.html rather than a stale copy. #mobileMoreActions was one of its
// landmarks and no longer exists (owner correction: the intermediate
// menu view was the second entry point), so the landmark is now the single host
// that replaced it.
check('C) extracted the real #sessionBar from index.html',
  /id="mobileSettingsHost"/.test(SESSION_BAR_MARKUP)
    && /id="mobileInput" rows="1"/.test(SESSION_BAR_MARKUP)
    && /id="mobileSendBtn"/.test(SESSION_BAR_MARKUP), true);

await page.evaluate(({ SESSION_BAR_MARKUP, HEADER_ROW_MARKUP }) => {
  // The fixture's real terminal-manager.js may have set body.keyboard-open from the
  // emulated visualViewport; that class hides the notepad via display:none (a separate,
  // correct behavior). Clear it so we assert the RESTING notepad state (translateY sheet).
  document.body.className = '';
  document.body.innerHTML = `
    <div class="deck-window">
      <header class="header">${HEADER_ROW_MARKUP}</header>
      <main class="main-content">
        <div class="workspace" id="workspace">
          <div class="terminal-area">
            <div class="terminals-container" id="terminalsContainer">
              <div class="terminal-grid">
                <div class="terminal-pane" data-pane-index="0">
                  <div class="terminal-wrapper" id="term-shell">
                    <div style="height:4000px">tall content to detect page scroll leak</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside class="notepad-panel" id="notepadPanel">
            <textarea id="sessionNotepad" class="notepad-input"></textarea>
          </aside>
        </div>
      </main>
      ${SESSION_BAR_MARKUP}
    </div>`;
  document.getElementById('sessionBar').classList.remove('hidden');
  // Give the app-shell a concrete height (what applyViewportVars pins while the
  // keyboard is open; here just so .workspace has a real measured height for the
  // notepad geometry/hit-test assertions below).
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
}, { SESSION_BAR_MARKUP, HEADER_ROW_MARKUP });
await page.waitForTimeout(30);

// Case #6 — #sessionBar is after main/workspace and is a DIRECT .deck-window
// child. W14 item 3 inserts the mini-status band between the composer and the
// keypad, so the keypad follows THAT status row rather than immediately following
// the composer.
const barOrder = await page.evaluate(() => {
  const ws = document.getElementById('workspace');
  const bar = document.getElementById('sessionBar');
  const input = document.getElementById('mobileInputBar');
  const keypad = document.getElementById('mobileKeypad');
  return {
    followsWorkspace:
      !!(ws.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING),
    directShellChild: bar.parentElement.classList.contains('deck-window'),
    keypadParent: keypad.parentElement.id,
    statusBetweenComposerAndKeypad:
      input.nextElementSibling?.id === 'mobileMiniStatus'
      && input.nextElementSibling.nextElementSibling === keypad,
  };
});
check('#6) #sessionBar is after #workspace in DOM',
  barOrder.followsWorkspace, true);
check('#6) #sessionBar is a direct .deck-window flex child',
  barOrder.directShellChild, true);
check('#6) keypad belongs to the one session-bar dock',
  barOrder.keypadParent, 'sessionBar');
check('#6) W14 mini-status band sits between composer and keypad',
  barOrder.statusBetweenComposerAndKeypad, true);

// Case B — app-shell locks page scroll (nothing for a swipe to move on the page).
const shell = await page.evaluate(() => ({
  bodyOverflow: getComputedStyle(document.body).overflowY,
  pageScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 2,
}));
check('B) body overflow hidden (app-shell lock)', shell.bodyOverflow, 'hidden');
check('B) page not scrollable (no leak)', shell.pageScrollable, false);

// Case C (#2) — shell height follows --app-height WHEN pinned (keyboard open),
// and RESTORES to the full stable frame when the var is cleared. This is the fix
// for "frame shrinks to half screen": terminal-manager now sets --app-height only
// while the keyboard is open and clears it otherwise, so a URL-bar-driven resize
// no longer leaves the frame stuck small — clearing the var snaps it back to full.
const cH = await page.evaluate(() => {
  const full = document.body.clientHeight;                 // var unset -> 100svh fallback
  document.documentElement.style.setProperty('--app-height', '500px');
  const shrunk = document.body.clientHeight;
  document.documentElement.style.removeProperty('--app-height');
  const restored = document.body.clientHeight;
  return { full, shrunk, restored };
});
check('C) shell shrinks to --app-height when pinned (keyboard open)', cH.shrunk, 500);
check('C) shell restores to full when var cleared (frame no longer stuck small)', cH.restored, cH.full);

// Case C (#2) — the fallback is 100svh (the STABLE small viewport), not 100dvh
// (which tracks the URL bar and caused the shrink). Assert the shipped rule text.
const usesSvh = await (await fetch(`${base}/static/css/style.css`)).text();
check('C) body fallback uses 100svh (stable, not 100dvh)',
  /body:has\(\.main-content\)[^}]*var\(--app-height,\s*100svh\)/s.test(usesSvh), true);

// Case A (R5 empty-space) — html and body must BOTH follow --app-height. When the
// soft keyboard opens, JS pins --app-height to the visual-viewport height and body
// shrinks; if html stayed at 100% (full device height) it would be taller than
// body by the keyboard height, and iOS scrolls the focused input up into that empty
// gap ("input pushed near the top, empty space below it"). Pin --app-height and
// assert html clientHeight == body clientHeight (gap 0). Then assert the shipped
// rule text uses var(--app-height,100svh), not the old height:100%.
// Measure via getComputedStyle().height, NOT clientHeight: the root element's
// clientHeight always returns the viewport height regardless of its CSS height,
// so it can't see the html shrink. computed height reflects the resolved CSS.
const gap = await page.evaluate(() => {
  document.documentElement.style.setProperty('--app-height', '500px');
  const g = {
    html: parseFloat(getComputedStyle(document.documentElement).height),
    body: parseFloat(getComputedStyle(document.body).height),
  };
  document.documentElement.style.removeProperty('--app-height');
  return g;
});
check('A) html height follows --app-height (no gap above body, keyboard open)', gap.html, 500);
check('A) html == body height when pinned (empty space eliminated)', gap.html, gap.body);
check('A) shipped html rule uses var(--app-height,100svh), not height:100%',
  /html:has\(\.main-content\)\s*\{[^}]*var\(--app-height,\s*100svh\)/s.test(usesSvh)
  && !/html:has\(\.main-content\)\s*\{[^}]*height:\s*100%/s.test(usesSvh), true);

// Case C — min-height floors removed in portrait.
const cPortrait = await page.evaluate(() => ({
  area: getComputedStyle(document.querySelector('.terminal-area')).minHeight,
  pane: getComputedStyle(document.querySelector('.terminal-pane')).minHeight,
}));
check('C) .terminal-area min-height 0 (portrait)', cPortrait.area, '0px');
check('C) .terminal-pane min-height 0 (portrait)', cPortrait.pane, '0px');

// Case C — <=767 landscape override also 0 (width<=767 AND orientation:landscape).
await page.setViewportSize({width:667, height:375});
await page.waitForTimeout(30);
const cLand = await page.evaluate(() => ({
  isLandscape: matchMedia('(max-width:767px) and (orientation:landscape)').matches,
  area: getComputedStyle(document.querySelector('.terminal-area')).minHeight,
}));
check('C) landscape media matches (<=767, landscape)', cLand.isLandscape, true);
check('C) .terminal-area min-height 0 (landscape override)', cLand.area, '0px');
await page.setViewportSize({width:428, height:926});
await page.waitForTimeout(30);

// ---------------------------------------------------------------------------
// Notepad — toggled purely by the button. It is position:absolute;bottom:0 INSIDE
// .workspace (a position:relative, overflow:hidden flex sibling that ends at the
// top of the bottom input bar). CLOSED (translateY(100%)) => pushed below the
// workspace and CLIPPED away, so nothing covers the input bar. OPEN => rests on
// top of the input bar with no overlap, and the input stays tappable. This
// replaces the old position:fixed + --input-bar-height sheet, whose hidden state
// left a sliver over the input (the reported "notepad covers the input" bug).
// ---------------------------------------------------------------------------
const npDefault = await page.evaluate(() => {
  const p = document.getElementById('notepadPanel');
  return { pos: getComputedStyle(p).position, transform: getComputedStyle(p).transform };
});
check('Notepad position absolute (anchored inside .workspace, not fixed)', npDefault.pos, 'absolute');
check('Notepad default hidden (translateY 100%, matrix has +ty)',
  npDefault.transform !== 'none' && npDefault.transform.startsWith('matrix'), true);

// CLOSED: hit-test the center of the input bar — it must return the input itself,
// and the notepad must NOT be anywhere in the paint stack there (proves the
// closed sheet is fully clipped away, not merely behind the bar).
const closed = await page.evaluate(() => {
  const inp = document.getElementById('mobileInput');
  const b = inp.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const stack = document.elementsFromPoint(cx, cy);
  return {
    hitIsInput: !!hit && hit.id === 'mobileInput',
    notepadInStack: stack.some(e => e.id === 'notepadPanel'),
  };
});
check('Notepad CLOSED: input bar is hit-tappable (not covered)', closed.hitIsInput, true);
check('Notepad CLOSED: notepad fully clipped away (not in paint stack over input)', closed.notepadInStack, false);

// OPEN: sheet slides to rest (translateY 0), sits ABOVE the input bar with no
// overlap, and the input is STILL tappable.
await page.evaluate(() => document.getElementById('notepadPanel').classList.add('mobile-open'));
await page.waitForTimeout(260);   // let the 0.2s transform transition settle
const open = await page.evaluate(() => {
  const np = document.getElementById('notepadPanel');
  const bar = document.getElementById('sessionBar');
  const inp = document.getElementById('mobileInput');
  const m = new DOMMatrixReadOnly(getComputedStyle(np).transform);
  const nr = np.getBoundingClientRect(), br = bar.getBoundingClientRect();
  const ib = inp.getBoundingClientRect();
  const hit = document.elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2);
  // The sheet is absolute; bottom: 0 inside .workspace, so it rests on the top
  // edge of the permanent bottom chrome.
  //
  // RE-DERIVED from the same measured chrome the Case I contract uses. The old
  // form asked whether .header was position:fixed to decide if a strip was
  // "docked"; nothing is out of flow any more, so that test was always false and
  // chromeTop silently fell through to the dock top. On a touch shell the CSS
  // order is main(0) -> header(1) -> sessionBar(2), so the workspace's bottom
  // edge abuts whichever permanent chrome is painted FIRST below it -- the header
  // on a phone, the dock where no strip row is rendered. Measure that instead of
  // inferring it from a positioning scheme.
  const strip = document.querySelector('.header');
  const sr = strip.getBoundingClientRect();
  const stripBelowWorkspace = getComputedStyle(strip).display !== 'none'
    && sr.height > 0
    && sr.top >= document.getElementById('workspace').getBoundingClientRect().top;
  const chromeTop = stripBelowWorkspace ? Math.min(sr.top, br.top) : br.top;
  // Horizontal geometry. The sheet was pinned to grid-column 2, so its abspos
  // containing block was that track -- implicit and zero-width at phone widths
  // -- and left/right: 0 resolved to a 180px box at x=390, entirely offscreen.
  // Every prior assertion here was vertical, so nothing caught it.
  const wr = document.getElementById('workspace').getBoundingClientRect();
  return {
    ty: Math.round(m.f),
    overlapsBar: nr.bottom > br.top + 1,
    overlapsStrip: stripBelowWorkspace ? nr.bottom > sr.top + 1 : false,
    restsOnChrome: Math.abs(nr.bottom - chromeTop) <= 1,
    inputStillHit: !!hit && hit.id === 'mobileInput',
    fullWidth: Math.round(nr.width) === Math.round(wr.width),
    leftFlush: Math.round(nr.left) === Math.round(wr.left),
  };
});
check('Notepad OPEN: translateY 0 (shown)', open.ty, 0);
check('Notepad OPEN: rests exactly on top of the permanent bottom chrome', open.restsOnChrome, true);
check('Notepad OPEN: does not overlap input bar', open.overlapsBar, false);
check('Notepad OPEN: does not overlap the docked session strip', open.overlapsStrip, false);
check('Notepad OPEN: input bar still tappable', open.inputStillHit, true);
check('Notepad OPEN: the sheet is full-bleed, not a clipped column', open.fullWidth, true);
check('Notepad OPEN: its left edge is the workspace left edge', open.leftFlush, true);
await page.evaluate(() => document.getElementById('notepadPanel').classList.remove('mobile-open'));

// No leftover JS geometry: --input-bar-height must be gone from both CSS and JS
// (the sheet no longer depends on a measured bar height).
const cssSrc = await (await fetch(`${base}/static/css/style.css`)).text();
const tmSrc0 = await (await fetch(`${base}/static/js/terminal-manager.js`)).text();
check('No --input-bar-height consumer in CSS', /var\(--input-bar-height/.test(cssSrc), false);
check('No --input-bar-height writer in terminal-manager.js', /--input-bar-height/.test(tmSrc0), false);

// Notepad — the ONE toggle exists in the shipped index.html.
//
// RE-TARGETED from #mobileNotepadBtn to #notepadOpenBtn. v5 removed the second
// dock button: amendment section 3 lines 35-40 list Ghi chú as action 5 of the
// six-action global/action row, and line 45 forbids a second menu/action in the
// composer -- so Notes is a header action that relocates into the touch action
// row, not a dock member. index.html:243-252 records the move, including the
// aria-controls/aria-expanded that came across from the deleted node.
// A UNIQUENESS bound is added because the whole point of v5's change is that
// there is exactly ONE Notes control.
const indexHtml = await (await fetch(`${base}/templates/index.html`)).text();
check('Notepad #notepadOpenBtn present in index.html', /id="notepadOpenBtn"/.test(indexHtml), true);
check('the removed #mobileNotepadBtn is gone from index.html',
  /id="mobileNotepadBtn"/.test(indexHtml), false);
check('exactly one Notes control in index.html',
  (indexHtml.match(/id="notepadOpenBtn"/g) || []).length, 1);

// #1 (long-press over text) — the iOS callout/selection suppression must be scoped
// to (pointer: coarse), NOT (max-width: 767px). The width query left the callout
// live on the 926px-wide iPhone landscape, so iOS hijacked long-press over text
// (forcing "hold over blank space to drag-copy"). Assert the shipped rule text.
// Entry 39: the coarse-only blocks may carry the narrow-width tier
// term; the contract is that the suppression lives in the touch-shell block.
check('#1) callout suppression scoped to the touch-shell block',
  /@media \(pointer: coarse\)(?:,[^{]*)?\{[^@]*\.terminal-wrapper \.xterm-screen[^}]*-webkit-touch-callout:\s*none/s.test(cssSrc)
  || /@media \(pointer: coarse\)(?:,[^{]*)?\{[\s\S]*?\.terminal-wrapper \.xterm,[\s\S]*?-webkit-touch-callout:\s*none/.test(cssSrc), true);

// ---------------------------------------------------------------------------
// Round 3 regressions (measured, real CSS at 428x926).
// ---------------------------------------------------------------------------

// R3-#1 — the mobile input's font-size must be >= 16px. Below 16px, iOS Safari
// auto-zooms the page on focus, and on the fixed app-shell that zoom pushes the
// bottom input bar out of view ("tap the input -> it zooms AND disappears").
// #mobileInput lives inside .mobile-input-bar in the scaffold; real CSS loaded.
const inputFont = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.getElementById('mobileInput')).fontSize));
check('R3-#1) mobile input font-size >= 16 (no iOS focus-zoom)', inputFont >= 16, true);

// Case B (R5 readability) — the production mobile input remains a wrapping
// one-row <textarea>, not a single-line <input> or the obsolete two-row fixture.
const inputWrap = await page.evaluate(() => {
  const el = document.getElementById('mobileInput');
  return { tag: el.tagName, rows: el.rows, ws: getComputedStyle(el).whiteSpace };
});
check('B) mobile input is a textarea (multi-line, wraps)', inputWrap.tag, 'TEXTAREA');
check('B) mobile input uses the production one-row height', inputWrap.rows, 1);
check('B) mobile input wraps (white-space not nowrap)', inputWrap.ws !== 'nowrap', true);

// Case C (R5 dock / More ownership) — the permanent dock is one functional row:
// More, the input, the app-owned Notepad toggle, keypad, and Send. Exit Copy is
// the only app-owned node still inside #mobileMoreActions.
//
// P2: the lifecycle Rename/Reconnect/Reset controls are NOT dock
// members. They live beside the strip in .session-tabs-row, so the dock order
// below is only the actual #mobileInputBar children again -- and this assertion
// now also pins that the toolbar has not leaked back into the dock.
const toolsLayout = await page.evaluate(() => {
  const bar = document.getElementById('mobileInputBar');
  // The single canonical menu host replaced #mobileMoreActions (owner
  // correction).
  const more = document.getElementById('mobileSettingsHost');
  return {
    barDir: getComputedStyle(bar).flexDirection,
    dockIds: Array.from(bar.querySelectorAll('[id]')).map(element => element.id),
    actionIds: Array.from(more.children).map(element => element.id),
    // .tab-row-actions has a class, not an id, so report a stable token when the
    // control is where v5 puts it. Anything else reports the real parent id and
    // fails loudly rather than silently matching.
    notepadParent: (() => {
      const el = document.getElementById('notepadOpenBtn');
      if (!el) return 'MISSING';
      const p = el.parentElement;
      return p.classList.contains('tab-row-actions')
        ? 'tab-row-actions-owner' : (p.id || p.className);
    })(),
    exitScrollParent: document.getElementById('exitScrollBtn').parentElement.id,
    duplicateNotepad: document.querySelectorAll('#notepadOpenBtn').length,
    legacyNotepad: document.querySelectorAll('#mobileNotepadBtn').length,
    duplicateExitScroll: document.querySelectorAll('#exitScrollBtn').length,
  };
});
check('C) mobile-input-bar is one row', toolsLayout.barDir, 'row');
// Notes is NOT a dock member under v5 (section 3 lines 35-40: Ghi chú is action
// 5 of the global/action row; line 45: no second action in the composer).
// B2 / mockup line 192 puts the Broadcast target chip at the START of the dock,
// before the composer -- it states the blast radius of the next send, so it has
// to be readable without the eye entering the text box. It used to be the last
// [id] here because it was a caption absolutely positioned inside the textarea's
// own bottom band; that band rule is deleted, so its DOM position moved with it.
check('C) dock markup holds More / composer target / input / keypad / Exit scroll / Send in production order',
  toolsLayout.dockIds.join(','),
  'mobileMoreBtn,composerTarget,mobileInput,mobileKeypadBtn,exitScrollBtn,mobileSendBtn');
check('C) no legacy #mobileNotepadBtn anywhere in the live page',
  toolsLayout.legacyNotepad, 0);
// The lifecycle toolbar belongs to the session tier, so no part of it may be a
// descendant of the dock in either orientation.
check('C) no lifecycle control is a dock descendant',
  await page.evaluate(() => document.getElementById('mobileInputBar')
    .querySelectorAll('#sessionActionsControl, [data-lifecycle-action]').length), 0);
/*
 * The menu's action set is now REAL relocated controls, not proxies (owner
 * correction). The old expectation named the four proxy ids that
 * constituted the removed second menu.
 *
 * Scope note, measured: this fixture serves ONLY the extracted #sessionBar
 * fragment, so the header-owned controls (New Connection, Files, Commands,
 * Reload, Profiles) are legitimately not in this document at all, and
 * touch-action-row.js does its relocating at runtime against a full shell. So
 * this suite cannot assert where those controls live -- header_menus.mjs and
 * shell_regression_contract.mjs do that against the real shell.
 *
 * What this suite CAN prove from the served fragment is the property that made
 * the proxies a defect in the first place: the menu host ships EMPTY, carrying no
 * baked-in copy of any action and no proxy to dispatch at one.
 */
// This suite's check() compares with ===, so the probe returns a scalar.
check('C) the menu host ships empty, with no baked-in action copies',
  await page.evaluate(() => {
    const host = document.getElementById('mobileSettingsHost');
    return `children=${host.children.length},html=${host.innerHTML.trim().length}`;
  }), 'children=0,html=0');
check('C) no proxy action survives in the served markup',
  await page.evaluate(() =>
    document.querySelectorAll('[data-mobile-action-target]').length), 0);
// v5 section 3 lines 35-40 make Ghi chú action 5 of the global/action row, and
// line 45 forbids a second action in the composer, so the ONE Notes control
// lives in the header row (.tab-row-actions), NOT the dock. index.html:243-252.
check('C) the real Notepad control lives in the header row, not the dock',
  toolsLayout.notepadParent, 'tab-row-actions-owner');
check('C) the one Exit-scroll control lives in the composer dock',
  toolsLayout.exitScrollParent, 'mobileInputBar');
check('C) Notepad and Exit-scroll are not cloned',
  `${toolsLayout.duplicateNotepad}:${toolsLayout.duplicateExitScroll}`, '1:1');

// DOM order alone is not the claim — measure where Send actually lands.
const sendPos = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#mobileInputBar > button')];
  const send = document.getElementById('mobileSendBtn');
  const rightOf = (button) => button.getBoundingClientRect().right;
  return {
    isRightmost: btns.every(button => rightOf(button) <= rightOf(send) + 0.5),
    flowDir: getComputedStyle(document.getElementById('mobileInputBar')).flexDirection,
  };
});
check('C) the Send button really is painted furthest right', sendPos.isRightmost, true);
check('C) the dock flows left-to-right (not reversed)', sendPos.flowDir, 'row');

// Case D (R5 notepad zoom) — the notepad textarea must be >= 16px on touch devices
// so focusing it does not trigger iOS focus-zoom (same threshold as #mobileInput).
// Desktop keeps the compact 12px; the bump is scoped to (pointer: coarse).
const notepadFont = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.getElementById('sessionNotepad')).fontSize));
check('D) notepad font-size >= 16 on touch (no iOS focus-zoom)', notepadFont >= 16, true);

// (R3-#2 notepad-covers-input is now covered by the position:absolute-in-.workspace
// hit-test assertions in the Notepad section above — the old ResizeObserver +
// --input-bar-height mechanism was removed, so its source-shape checks are gone.)

// R3-#3 — the reload button's material-icon must match the row's icon scale
// (default material-icons is 24px; the sibling SVG icons are 14px). Assert the
// rule renders the glyph at 16px, not the oversized 24px default.
const reloadIconFont = await page.evaluate(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<div class="tab-row-icon-btn" id="_ri"><span class="material-icons">refresh</span></div>');
  const f = getComputedStyle(document.querySelector('#_ri .material-icons')).fontSize;
  document.getElementById('_ri').remove();
  return f;
});
check('R3-#3) reload material-icon is 16px (matches row, not 24px default)', reloadIconFont, '16px');

// ---------------------------------------------------------------------------
// Case D — reconnect overlay via the REAL showReconnectOverlay.
// Close the notepad first — it's a z-index:900 slide-up sheet over the bottom ~45%;
// if it stays open it would intercept the trusted tap on a Reconnect button that
// lands in that region (test isolation).
// ---------------------------------------------------------------------------
await page.evaluate(() => document.getElementById('notepadPanel').classList.remove('mobile-open'));
await page.waitForTimeout(260);
const overlayGeo = await page.evaluate(() => {
  // A real terminal container the overlay attaches to (id = session.terminalId).
  const wrapper = document.getElementById('term-shell');
  wrapper.id = 'terminal-sess1';           // showReconnectOverlay looks up by this id
  SessionManager.sessions = { sess1: { terminalId: 'terminal-sess1', isPersistentCandidate: true, tmuxSessionName: 'sshdeck_sess1' } };
  window.__reconnectFired = false;
  // The overlay button routes through the ONE lifecycle owner, requestReconnect,
  // which is what decides the branch (key/Tailscale reconnect directly, password
  // opens the credential form). It used to call prefillConnectionForm directly,
  // which is why the spy sat there. THIS suite's subject is unchanged: whether a
  // TRUSTED tap actually reaches the button's handler through the overlay's
  // pointer-events layering. The routing contract itself is owned by
  // tests/browser/lifecycle_entry_matrix.mjs §6.
  SessionManager.requestReconnect = () => { window.__reconnectFired = true; };
  // Mark a spot on the wrapper (behind the dimmed backdrop) to prove tap-through.
  wrapper.addEventListener('click', () => { window.__wrapperGotTap = true; });
  window.__wrapperGotTap = false;

  SessionManager.showReconnectOverlay('sess1');            // REAL overlay-building code

  const overlay = wrapper.querySelector('.session-overlay');
  const card = wrapper.querySelector('.session-overlay-card');
  const btn = wrapper.querySelector('.session-overlay-card button');
  const br = btn.getBoundingClientRect();
  const wr = wrapper.getBoundingClientRect();
  return {
    overlayPE: getComputedStyle(overlay).pointerEvents,
    cardPE: getComputedStyle(card).pointerEvents,
    btn: { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2) },
    // A backdrop-only point: top-left corner of the wrapper, away from the centered card.
    backdrop: { x: Math.round(wr.x + 8), y: Math.round(wr.y + 8) },
  };
});
check('D) overlay pointer-events none', overlayGeo.overlayPE, 'none');
check('D) overlay-card pointer-events auto', overlayGeo.cardPE, 'auto');

async function trustedTap(x, y){
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}

await trustedTap(overlayGeo.btn.x, overlayGeo.btn.y);
await page.waitForTimeout(60);
check('D) tap Reconnect button fires handler', await page.evaluate(()=>window.__reconnectFired), true);

await trustedTap(overlayGeo.backdrop.x, overlayGeo.backdrop.y);
await page.waitForTimeout(60);
check('D) tap on dimmed backdrop passes through to terminal', await page.evaluate(()=>window.__wrapperGotTap), true);

// ---------------------------------------------------------------------------
// Case #3/#4 (static) — the double-tap-zoom block moved from CSS touch-action
// into JS. The dynamic tap->focus behavior is covered by mobile_focus_trusted.mjs
// (real xterm + real focusActivePane); here we assert the shipped source shape so
// a regression that drops the preventDefault (zoom returns) is caught. P1 §2.2
//: the double-tap branch must preventDefault (block zoom) AND route
// the touch path to the COMPOSER (#mobileInput), with raw terminal.focus() only
// on the desktop else arm. The pre-P1 "focuses terminal directly" expectation is
// superseded — no raw-focus exception remains on touch.
const tmSrc = await (await fetch(`${base}/static/js/terminal-manager.js`)).text();
// Isolate the touchend handler's double-tap branch: from `now - lastTap` to the
// close of the `if (!moved)` block.
//
// The {0,N} bound is a HARNESS WINDOW, not an assertion: it only has to be large
// enough to still contain the whole branch. S17 FIX 5 added the
// notepadOwnsKeyboard guard plus its comment block inside this branch, taking it
// past the old 1500 and making all four checks below fail on a slice that was
// simply cut short. Raised to 4000 (the branch is ~3200 chars); every assertion
// below is byte-identical.
const dtBranch = (tmSrc.match(/now - lastTap < DOUBLE_TAP_MS[\s\S]{0,4000}?No raw-terminal-focus dispatch remains/) || [''])[0];
check('#3) double-tap branch calls preventDefault (blocks iOS zoom)',
  /event\.preventDefault\(\)/.test(dtBranch), true);
check('#4/#3) double-tap branch routes touch to the Composer (#mobileInput)',
  /if \(this\.isTouchShell\(\)\) \{[\s\S]*?mobileInput\.focus\(\);[\s\S]*?setTimeout\(\(\) => mobileInput\.focus\(\), 0\);[\s\S]*?\} else \{[\s\S]*?terminal\.focus\(\);[\s\S]*?\}/.test(dtBranch), true);
check('#4/#3b) double-tap branch re-asserts composer focus after xterm mousedown',
  /setTimeout\(\(\) => mobileInput\.focus\(\), 0\);/.test(dtBranch), true);
check('#4/#3c) desktop keeps raw terminal.focus() (else arm intact)',
  /\} else \{[\s\S]*?terminal\.focus\(\);[\s\S]*?\}/.test(dtBranch), true);
// S17 R1 (FIX 5): the branch must DECLINE the focus move while the Notes sheet
// owns the keyboard, like its two siblings at terminal-manager.js:1381/:1422.
// Without this the rest of a note is typed into the composer -- the Owner's
// "composer contaminated with NOTE text". The guard sits before both arms, so
// preventDefault above still blocks iOS zoom and only the focus move is declined.
check('#3d) double-tap branch declines to steal a focused Notes sheet',
  /if \(this\.notepadOwnsKeyboard\(\)\) \{[\s\S]{0,120}?return;[\s\S]{0,40}?\}[\s\S]*?if \(this\.isTouchShell\(\)\)/.test(dtBranch), true);
// The dead _wantRawFocus flag is gone for good: it was never set anywhere, so the
// reset in focusActivePane could never consume it. Assert it is absent from BOTH
// production files, otherwise a revert would quietly reintroduce the leak.
const smSrc = await (await fetch(`${base}/static/js/session-manager.js`)).text();
check('#4b) _wantRawFocus removed from terminal-manager.js',
  /_wantRawFocus/.test(tmSrc), false);
check('#4c) _wantRawFocus removed from session-manager.js',
  /_wantRawFocus/.test(smSrc), false);
// The double-tap must be gated on distance too (time alone turned two quick taps
// in different places into an unwanted raw-focus switch).
check('#4d) double-tap requires spatial proximity (DOUBLE_TAP_PX)',
  /DOUBLE_TAP_PX\s*=\s*\d+/.test(tmSrc) && /Math\.abs\(tapX - lastTapX\) <= DOUBLE_TAP_PX/.test(tmSrc),
  true);
// A second finger must poison the gesture, and touchend must bail out while any
// finger is still down — otherwise a staggered two-finger lift reads as a
// double-tap and steals focus from the IME.
check('#4e) multi-touch state exists and touchend bails while fingers remain',
  /let multiTouch = false;/.test(tmSrc) && /if \(event\.touches\.length > 0\)/.test(tmSrc), true);

// ---------------------------------------------------------------------------
// Round 7 — the single contextual Exit-scroll control lives before Send in the
// shared composer dock. At rest it is hidden and state code owns its reveal.
const idxHtml = await (await fetch(`${base}/templates/index.html`)).text();
/*
 * The menu host, not the deleted #mobileMoreActions list. That list was removed
 * with the intermediate second menu, so this regex
 * matched nothing and every assertion below that searched the result was testing
 * the empty string -- passing whatever the markup said. The host is the surface
 * that must stay free of baked-in action copies, so it is what is extracted now,
 * and R7/R7a are non-vacuous again (they require the extraction to have
 * succeeded).
 */
const moreActionsBlock = (idxHtml.match(/<div class="mobile-settings-host" id="mobileSettingsHost">[\s\S]*?<\/div>/) || [''])[0];
const inputBarStart = idxHtml.indexOf('<div class="mobile-input-bar" id="mobileInputBar">');
const keypadStart = idxHtml.indexOf('<div class="mobile-keypad" id="mobileKeypad"', inputBarStart);
const inputBarBlock = inputBarStart >= 0 && keypadStart > inputBarStart
  ? idxHtml.slice(inputBarStart, keypadStart) : '';
const exitCopyTag = (inputBarBlock.match(
  /<button\b[^>]*\bid="exitScrollBtn"[\s\S]*?>/) || [''])[0];
check('R7pre) extracted the menu host block', moreActionsBlock !== '', true);
check('R7) no duplicate Exit-scroll fallback lives inside the menu host',
  /id="mobileExitCopyModeBtn"/.test(moreActionsBlock), false);
check('R7a) no legacy Notepad button in the menu host',
  /id="mobileNotepadBtn"/.test(moreActionsBlock), false);
check('R7a2) extracted the #mobileInputBar block', inputBarBlock !== '', true);
check('R7a3) no Notes control lives inside #mobileInputBar',
  /id="mobileNotepadBtn"|id="notepadOpenBtn"/.test(inputBarBlock), false);
check('R7b) extracted the Exit-scroll opening tag', exitCopyTag !== '', true);
check('R7c) button is a real <button type="button"> (no form submit)',
  /\btype="button"/.test(exitCopyTag), true);
check('R7d) button carries a translatable aria-label',
  /\bdata-i18n-aria-label="tmux\.exitScroll"/.test(exitCopyTag), true);
check('R7d2) contextual control is hidden and excluded from AT at rest',
  /\bhidden\b/.test(exitCopyTag) && /\baria-hidden="true"/.test(exitCopyTag), true);
check('R7e) no inline onclick handler on the button',
  /\bonclick\s*=/.test(exitCopyTag), false);
check('R7e2) Exit-scroll precedes Send in the shared dock',
  inputBarBlock.indexOf('id="exitScrollBtn"') < inputBarBlock.indexOf('id="mobileSendBtn"'), true);

const appSrc = await (await fetch(`${base}/static/js/app.js`)).text();
check('R7f) app.js emits tmux_exit_copy_mode',
  /socket\.emit\('tmux_exit_copy_mode'/.test(appSrc), true);
check('R7g) app.js handles the tmux_copy_mode_exited reply',
  /socket\.on\('tmux_copy_mode_exited'/.test(appSrc), true);
// The control command must stay session-scoped: no global/server-wide tmux
// option may be reachable from the browser (another tool shares this tmux server).
check('R7h) no -g/-s tmux flags anywhere in app.js',
  /tmux[^\n]*\s-[gs]\s/.test(appSrc), false);
// Cache-busts: every JS asset this round changed must carry a ?v= query. The
// filename sits inside a Jinja url_for() call, so the version lands after the
// closing `') }}` — not directly after ".js".
for (const asset of ['i18n.js', 'terminal-manager.js', 'session-manager.js', 'app.js']) {
  const re = new RegExp(`filename='js/${asset.replace('.', '\\.')}'\\s*\\)\\s*\\}\\}\\?v=\\d+`);
  check(`R7i) ${asset} is cache-busted with ?v=`, re.test(idxHtml), true);
}

// ---------------------------------------------------------------------------
// Case E (black gap) — the shell's document scroll is reset while the soft
// keyboard is open.
//
// Measured on an iPhone 12 Pro Max: focusing the bottom #mobileInput (at 621..751)
// shrinks the viewport to 469 and iOS scrolls the document up by exactly
// 751-469 = 282px to reveal the field. --app-height is then pinned to 469 so
// html/body are correct (overlay: htm=469 bod=469), but the 282px scroll offset
// remains — html/body are overflow:hidden so iOS never clamps it — and the
// 469-tall shell paints from y=-282 (overlay: ws=-282..65, bar=65..187), leaving
// the bottom 282px of the screen empty (overlay: bot=(nothing)). That empty band
// is the black gap, and it also pushes the input bar up toward mid-screen.
//
// Chromium cannot reproduce the iOS scroll (html/body overflow:hidden means the
// document simply is not scrollable here), so this asserts the reset is ATTEMPTED
// with the real numbers: stub window.scrollTo / documentElement.scrollTop, report
// a 282px offset, drive the REAL visualViewport resize handler, and check both
// paths fire. Whether iOS honours it is verified on-device via the ?debug=1
// overlay's sy/bT fields.
// ---------------------------------------------------------------------------
const scrollFix = await page.evaluate(async () => {
  const de = document.documentElement;
  const out = { scrollToArgs: null, scrollTopWrites: [], hasVV: !!window.visualViewport };

  // Pretend the document is scrolled 282px, as iOS leaves it.
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 282 });
  Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 });
  Object.defineProperty(de, 'scrollTop', {
    configurable: true,
    get: () => 282,
    set: (v) => { out.scrollTopWrites.push(v); },
  });
  window.scrollTo = (x, y) => { out.scrollToArgs = [x, y]; };

  // Shrink the visual viewport the way the soft keyboard does, then fire the real
  // handler registered by terminal-manager.js at load.
  Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 469 });
  window.visualViewport.dispatchEvent(new Event('resize'));
  out.appHeightAfterResize = de.style.getPropertyValue('--app-height');

  // The handler also resets on the next frame (iOS can apply its scroll late).
  out.syncScrollTopWrites = out.scrollTopWrites.length;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.rafScrollTopWrites = out.scrollTopWrites.length;

  // And on visualViewport scroll, which iOS fires when the caret moves.
  out.scrollToArgs = null;
  window.visualViewport.dispatchEvent(new Event('scroll'));
  out.scrollToArgsOnVVScroll = out.scrollToArgs;

  return out;
});
check('E) real handler pins --app-height to the keyboard viewport',
  scrollFix.appHeightAfterResize, '469px');
check('E) keyboard-open resize resets documentElement.scrollTop to 0',
  scrollFix.scrollTopWrites[0], 0);
check('E) reset also runs on a later frame (iOS applies its scroll late)',
  scrollFix.rafScrollTopWrites > scrollFix.syncScrollTopWrites, true);
check('E) visualViewport scroll while keyboard open resets scroll too',
  JSON.stringify(scrollFix.scrollToArgsOnVVScroll), '[0,0]');

// Static shape: the reset must NOT be implemented as a transform on the shell —
// that creates a containing block and breaks the page's position:fixed modals.
check('E) reset uses scroll, not a transform on html/body',
  /resetShellScroll/.test(tmSrc) && !/documentElement\.style\.transform/.test(tmSrc), true);

// ---------------------------------------------------------------------------
// Case E2 (the band that came back) — the scroll reset must fire in the states
// the user actually hits, not only while the soft keyboard is open.
//
// The device measurement in terminal-manager.js:1146 is unambiguous: iOS scrolls
// the DOCUMENT (by 282px in the measured case) and html/body, being overflow:hidden,
// never clamp it back. A non-zero document offset paints the viewport-tall shell off
// the top of the screen and leaves an empty band at the bottom — that band IS the
// bug, in every state, so the reset must be unconditional.
//
// The three cases below are precisely the ones the old `if (keyboardOpenNow())`
// guard skipped, and each maps to something the user reported:
//   E2a keyboard CLOSED, plain drag/swipe over the shell  ("kéo hoặc vuốt nó vẫn
//       chạy lên được") — visualViewport does not resize, so only the document's own
//       scroll event exists to react to.
//   E2b the function keypad open — it uses body.keypad-open plus a normal-flow
//       dock row and never touches visualViewport, so keyboardOpenNow() is false
//       the entire time the keypad is up.
//   E2c an iOS-shaped keyboard, where the LAYOUT viewport is left alone. The old
//       test shrank only visualViewport.height while window.innerHeight stayed 926,
//       which flatters any implementation: a ratio against innerHeight and a ratio
//       against a load-time snapshot both land at 0.51 and both look correct. This
//       case pins the shape instead of the arithmetic, so it cannot be satisfied by
//       an accident of which denominator was used.
// ---------------------------------------------------------------------------
const e2 = await page.evaluate(async () => {
  const de = document.documentElement;
  const out = {};
  let offset = 282;
  const writes = [];

  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => offset });
  Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 });
  Object.defineProperty(de, 'scrollTop', {
    configurable: true,
    get: () => offset,
    set: (v) => { writes.push(v); },
  });
  window.scrollTo = () => { writes.push('scrollTo0'); };

  const attempt = async (fire) => {
    writes.length = 0;
    await fire();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return writes.length > 0;
  };

  // E2a — no keyboard at all: viewport is full height, document simply got scrolled.
  Object.defineProperty(window.visualViewport, 'height',
    { configurable: true, get: () => window.innerHeight });
  out.plainDrag = await attempt(() => window.dispatchEvent(new Event('scroll')));

  // E2b — function keypad up. Nothing about the viewport changes; the keypad is
  // a normal-flow dock row plus body.keypad-open. Fire the same signal a drag
  // would produce.
  document.body.classList.add('keypad-open');
  out.keypadOpen = await attempt(() => window.dispatchEvent(new Event('scroll')));
  document.body.classList.remove('keypad-open');

  // E2c — iOS-shaped keyboard: visual viewport shrinks, LAYOUT viewport untouched.
  Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 469 });
  out.iosKeyboardLayoutUntouched =
    await attempt(() => window.visualViewport.dispatchEvent(new Event('resize')));
  out.innerHeightDuringKeyboard = window.innerHeight;   // proves the layout viewport was left alone

  // And the offset having gone to 0 must not keep re-firing pointlessly.
  offset = 0;
  out.noopWhenAlreadyZero = !(await attempt(() => window.dispatchEvent(new Event('scroll'))));

  return out;
});
check('E2a) keyboard CLOSED: a plain document scroll is still reset (band on swipe)',
  e2.plainDrag, true);
check('E2b) function keypad open: scroll is reset even though vv never changed',
  e2.keypadOpen, true);
check('E2c) iOS-shaped keyboard (layout viewport untouched): reset still fires',
  e2.iosKeyboardLayoutUntouched, true);
check('E2c) the iOS case really did leave window.innerHeight alone',
  e2.innerHeightDuringKeyboard, 926);
check('E2) already at 0: nothing is written (over-calling is free)',
  e2.noopWhenAlreadyZero, true);

// Static shape: the reset must not be gated behind the keyboard check any more, and
// the document's own scroll event must be listened to (visualViewport alone is silent
// when the URL bar does not move).
check('E2) the scroll reset is no longer gated on keyboardOpenNow()',
  /if\s*\(\s*keyboardOpenNow\(\)\s*\)\s*resetShellScroll/.test(tmSrc), false);
check('E2) window scroll is listened to, so a plain drag is caught',
  /window\.addEventListener\('scroll',\s*resetShellScroll/.test(tmSrc), true);
// A capture listener on document would also fire for .xterm-viewport, i.e. tmux
// history scrolling, which the reset must never touch.
check('E2) the reset is NOT bound as a document capture listener (spares xterm)',
  /document\.addEventListener\('scroll',\s*resetShellScroll[^)]*capture/.test(tmSrc), false);

// v3 F1 (dated deviation): the mobile composer may only be focused
// by direct intentional interaction -- the user tapping #mobileInput, or the
// visible Send button refocusing it when it was already active at press time.
// Every other caller funnels through SessionManager.focusActivePane, so the
// shared focus policy must have NO mobile branch, session-manager.js must
// never focus the composer anywhere, and app.js's one remaining composer
// focus (the Send refocus) must be gated on the composer having been active.
check('F1-G1) focusActivePane has no mobile composer branch',
  /isMobile\(\)[\s\S]{0,400}?mobileInput\.focus\(\)/.test(smSrc), false);
check('F1-G2) session-manager.js never focuses the composer anywhere',
  (smSrc.match(/mobileInput\.focus\(\)/g) || []).length, 0);
check('F1-G3) app.js has exactly one composer focus site (the Send refocus)',
  (appSrc.match(/mobileInput\.focus\(\)/g) || []).length, 1);
check('F1-G4) the Send refocus is gated on the composer having been active',
  /wasComposerActive[\s\S]{0,120}?mobileInput\.focus\(\)/.test(appSrc), true);

// The temporary ?debug=1 diagnostics overlay was removed once the device
// measurement confirmed the scroll reset (sy=0/0, bT=0, no gap). Read the real
// template off disk (it is a Jinja file, not fetchable as a rendered page) and
// assert both the script tag and the file itself are gone.
const idxSrc = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
check('E) temporary mobile-debug script tag is gone from index.html',
  /mobile-debug/.test(idxSrc), false);
check('E) temporary mobile-debug.js file is deleted',
  fs.existsSync(path.join(sourceRoot, 'static/js/mobile-debug.js')), false);

// --- F) the function keypad's CSS shape -------------------------------------
// Two things here were measured wrong on the first attempt and are pinned so a
// later edit cannot quietly undo them.
// cssSrc is already read further up this file.

// 1. minmax(0, 1fr), not a bare 1fr. A 1fr track is floored at its content's
//    min-content width and button labels do not wrap, so four columns measured
//    254/254/267/41 px and overflowed a 390px phone instead of dividing the row.
check('F) keypad grid uses minmax(0, 1fr) so columns can actually divide the row',
  /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(cssSrc), true);
check('F) keypad grid does not use a bare repeat(4, 1fr)',
  /grid-template-columns:\s*repeat\(4,\s*1fr\)/.test(cssSrc), false);

// 2. Scoped to the canonical touch query, not a width query. The iPhone 12 Pro
//    Max in LANDSCAPE reports 926px CSS width, so a max-width:768px block
//    computed display:none exactly when the phone was turned sideways —
//    measured at 844px. The capability model widened the scope from
//    (pointer: coarse) to the canonical touch query so hybrid shells (hover:none
//    or any-pointer:coarse with a fine primary pointer) keep the keypad too;
//    the ban is still "never a width query".
// Ask which @media actually ENCLOSES the keypad rules rather than comparing
// lastIndexOf positions: round 12 appended a second coarse block (the 8-column
// landscape rule) AFTER these, and a lastIndexOf-based check silently started
// measuring that one instead.
const keypadEnclosingMedia = (() => {
  const at = cssSrc.indexOf('.keypad-key .material-icons');
  const m = cssSrc.lastIndexOf('@media', at);
  return cssSrc.slice(m, cssSrc.indexOf('{', m)).trim();
})();
check('F) keypad rules live in the canonical touch block, not a width query',
  keypadEnclosingMedia,
  // Owner correction: primary capability as a conjunction.
  '@media (pointer: coarse) and (hover: none), (max-width: 767px)');

// Closed is boxless; open is a static normal-flow flex row. This is a stronger
// ceiling than the retired translate sheet: no hidden painted box, no absolute
// overlay and no compensating terminal reserve.
check('F) closed keypad is display:none',
  /\.mobile-keypad\s*\{[^}]*display:\s*none/.test(cssSrc), true);
check('F) keypad is a static full-width flex row',
  /\.mobile-keypad\s*\{[^}]*position:\s*static[^}]*flex:\s*0\s+0\s+100%/s
    .test(cssSrc), true);
check('F) open keypad becomes a rendered box',
  /\.mobile-keypad\.mobile-open\s*\{[^}]*display:\s*block/.test(cssSrc), true);
check('F) no keypad translateY overlay survives',
  /\.mobile-keypad\s*\{[^}]*transform:\s*translateY\(/.test(cssSrc), false);
check('F) no --keypad-height variable survives in CSS or app.js',
  /--keypad-height/.test(cssSrc)
    || /--keypad-height/.test(
      fs.readFileSync(path.join(sourceRoot, 'static/js/app.js'), 'utf8')),
  false);
check('F) no keypad-open terminal padding reserve survives',
  /body\.keypad-open[^}]*padding-bottom/.test(cssSrc), false);
check('F) keypad keys meet the 44px touch-target minimum',
  /\.keypad-key\s*\{[^}]*min-height:\s*44px/.test(cssSrc), true);

// Markup: exactly ONE new button in the tool row (Cau asked for a toggle, not a
// new row of keys), and the keys carry data-key/data-seq for the handler.
check('F) exactly one keypad toggle button was added to the input bar',
  (idxSrc.match(/id="mobileKeypadBtn"/g) || []).length, 1);
check('F) the keypad panel exists once',
  (idxSrc.match(/id="mobileKeypad"/g) || []).length, 1);
check('F) arrow keys are declared as data-key (xterm encodes them), not raw escapes',
  /data-key="ArrowUp"/.test(idxSrc) && /data-key="ArrowDown"/.test(idxSrc)
  && /data-key="ArrowLeft"/.test(idxSrc) && /data-key="ArrowRight"/.test(idxSrc), true);
check('F) no hand-rolled arrow escape sequence in the markup',
  /data-seq="[^"]*\[A"/.test(idxSrc), false);

// --- G) keypad owns real normal-flow room at every touch capability -----------
// The existence rule remains capability-scoped, never width-scoped. The change
// is architectural: the room comes from #sessionBar growing around its second
// flex row, not from terminal padding.
check('G) normal-flow keypad rule is scoped to the canonical touch query',
  /@media \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.mobile-keypad\s*\{[^}]*position:\s*static/
    .test(cssSrc), true);
check('G) sessionBar wraps so keypad is a second flex line',
  /@media \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.session-bar\s*\{[^}]*flex-wrap:\s*wrap/
    .test(cssSrc), true);
check('G) open keypad makes the dock height content-owned',
  /\.session-bar:has\(\.mobile-keypad\.mobile-open\)\s*\{[^}]*height:\s*auto/
    .test(cssSrc), true);
// ONE layout everywhere: 4 x 2 on a phone upright, a phone sideways and a tablet.
// Round 12's height-scoped 8-column rule is gone — it existed only to squeeze a
// FOUR-row sheet into a ~357px-tall landscape frame, and there are no four rows
// left. Keeping one layout also means the sheet's height no longer changes with
// orientation.
//
// ONE canonical exception is allowed: the short-landscape band that uses the
// FULL frozen touch predicate (all three capability terms, each crossed with
// max-height: 500px). That band owns the Command sheet's compact card row,
// where a 177px vertical card cannot fit a ~176px sheet ceiling. Anything else
// — in particular a bare (pointer: coarse) and (max-height: Npx) block like the
// old 8-column keypad grid — is still rejected, so the protection is unchanged
// for every construction it ever actually caught.
check('G) the old height-scoped 8-column landscape rule is gone',
  cssSrc
    .replace(
      /@media\s*\(pointer:\s*coarse\)\s*and\s*\(max-height:\s*500px\),\s*\n\s*\(hover:\s*none\)\s*and\s*\(max-height:\s*500px\),\s*\n\s*\(any-pointer:\s*coarse\)\s*and\s*\(max-height:\s*500px\)/g,
      '@media (CANONICAL-SHORT-LANDSCAPE)')
    .match(/@media\s*\(pointer:\s*coarse\)\s*and\s*\(max-height:\s*\d+px\)/) !== null,
  false);
check('G) the grid is two rows',
  /\.mobile-keypad-grid\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    .test(cssSrc), true);
// The pages are a native horizontal scroll-snap track, NOT a hand-written gesture
// recogniser — that is what keeps them from interfering with the terminal's own
// touch gestures (tmux history swipe, long-press copy).
check('G) the two pages are a native scroll-snap track',
  /\.mobile-keypad-pages\s*\{[^}]*scroll-snap-type:\s*x\s+mandatory/s.test(cssSrc), true);
check('G) each page snaps and is exactly one sheet wide',
  /\.mobile-keypad-grid\s*\{[^}]*flex:\s*0\s+0\s+100%[^}]*scroll-snap-align:\s*start/s
    .test(cssSrc), true);

// Measure all tiers with the REAL keypad already inside the extracted production
// #sessionBar. It is never injected separately into .workspace.
await page.evaluate(({ sessionBar }) => {
  document.body.className = '';
  document.body.innerHTML = `
    <div class="deck-window">
      <main class="main-content">
        <div class="workspace" id="workspace">
          <div class="terminal-area">
            <div class="terminals-container"><div class="terminal-grid split-1">
              <div class="terminal-pane"><div class="terminal-wrapper" id="term-kp"></div></div>
            </div></div>
          </div>
        </div>
      </main>
      ${sessionBar}
    </div>`;
  document.getElementById('sessionBar').classList.remove('hidden');
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
}, { sessionBar: SESSION_BAR_MARKUP });

const measureKeypad = async (w, h) => {
  await page.setViewportSize({ width: w, height: h });
  /*
   * Let the wrapper's entry animation FINISH before measuring.
   *
   * `.terminal-wrapper` carries `animation: fadeIn 0.3s ease` (style.css:3200) and
   * fadeIn's from-state is `transform: translateY(10px)` (:3225). Measuring 60ms in
   * caught the wrapper mid-slide: instrumented at portrait 428x926 the wrapper was
   * still displaced by matrix(1,0,0,1,0,7.79) with its animation `running` at
   * currentTime 50ms, so `terminalBottom` read 776 against `keypadTop` 771 and the
   * two zero-intersection checks reported a phantom overlap that drifted run to run
   * (1972 / 1973 / 1974 / 1975 px) -- the signature of a transient, exactly the trap
   * AGENTS section 2 records.
   *
   * Waiting on the element's OWN animations is the settle condition, not a timing
   * guess, and it is strictly stronger than a longer sleep: it fails if the entry
   * animation never finishes. The assertions themselves are untouched, and a real
   * keypad-over-terminal overlap still fails them.
   */
  await page.evaluate(async () => {
    const wrapper = document.getElementById('term-kp');
    await Promise.all(wrapper.getAnimations().map(a => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(60);
  return page.evaluate(() => {
    const kp = document.getElementById('mobileKeypad');
    const bar = document.getElementById('sessionBar');
    kp.classList.remove('mobile-open');
    document.body.classList.remove('keypad-open');
    const closedDisplay = getComputedStyle(kp).display;
    const closedH = Math.round(kp.getBoundingClientRect().height);
    const closedBarH = Math.round(bar.getBoundingClientRect().height);
    kp.classList.add('mobile-open');
    document.body.classList.add('keypad-open');
    const gridStyle = getComputedStyle(document.querySelector('.mobile-keypad-grid'));
    const cols = gridStyle.gridTemplateColumns.trim().split(/\s+/).length;
    const rows = gridStyle.gridTemplateRows.trim().split(/\s+/).length;
    const keyW = [...document.querySelectorAll('.keypad-key')]
      .map((k) => k.getBoundingClientRect().width);
    const keyH = [...document.querySelectorAll('.keypad-key')]
      .map((k) => k.getBoundingClientRect().height);
    const kr = kp.getBoundingClientRect();
    const tr = document.getElementById('term-kp').getBoundingClientRect();
    const intersectionW =
      Math.max(0, Math.min(kr.right, tr.right) - Math.max(kr.left, tr.left));
    const intersectionH =
      Math.max(0, Math.min(kr.bottom, tr.bottom) - Math.max(kr.top, tr.top));
    return {
      cols,
      rows,
      closedDisplay,
      closedH,
      closedBarH,
      keypadH: Math.round(kr.height),
      openBarH: Math.round(bar.getBoundingClientRect().height),
      position: getComputedStyle(kp).position,
      parent: kp.parentElement.id,
      statusBetweenComposerAndKeypad: (() => {
        const input = document.getElementById('mobileInputBar');
        return input.nextElementSibling?.id === 'mobileMiniStatus'
          && input.nextElementSibling.nextElementSibling === kp;
      })(),
      intersectionArea: Math.round(intersectionW * intersectionH),
      terminalBottom: Math.round(tr.bottom),
      keypadTop: Math.round(kr.top),
      minKeyW: Math.round(Math.min(...keyW)),
      minKeyH: Math.round(Math.min(...keyH)),
      terminalH: Math.round(tr.height),
    };
  });
};

const portrait = await measureKeypad(428, 926);
check('G) portrait: closed keypad is boxless',
  portrait.closedDisplay === 'none' && portrait.closedH === 0, true);
check('G) portrait: open keypad is static normal flow',
  portrait.position, 'static');
check('G) portrait: keypad is owned by #sessionBar',
  portrait.parent, 'sessionBar');
check('G) portrait: mini-status band sits between composer and keypad',
  portrait.statusBetweenComposerAndKeypad, true);
check('G) portrait: opening grows the real dock',
  portrait.openBarH > portrait.closedBarH, true);
check('G) portrait: terminal and keypad have zero 2-D intersection',
  portrait.intersectionArea, 0);
check('G) portrait: terminal ends at or above the keypad',
  portrait.terminalBottom <= portrait.keypadTop, true);
check('G) portrait: 4 columns', portrait.cols, 4);
check('G) portrait: 2 rows', portrait.rows, 2);
check('G) portrait: terminal still has plenty of room with the keypad up',
  portrait.terminalH > 400, true);

// Two rows means the sheet is roughly half the height of round 12's four-row one
// (measured 211px then), which is the whole point of this change: the keypad used
// to push the terminal down to almost nothing.
check('G) two rows: the sheet is well under the old 4-row 211px',
  portrait.keypadH < 160, true);

// Landscape uses the SAME layout now. It must still fit and still be tappable.
const landscape = await measureKeypad(926, 428);
check('G) 926x428: closed keypad is boxless',
  landscape.closedDisplay === 'none' && landscape.closedH === 0, true);
check('G) 926x428: keypad remains static normal flow',
  landscape.position, 'static');
check('G) 926x428: opening grows the dock',
  landscape.openBarH > landscape.closedBarH, true);
check('G) 926x428: terminal and keypad have zero 2-D intersection',
  landscape.intersectionArea, 0);
check('G) landscape keeps the same 4 x 2 layout',
  landscape.cols === 4 && landscape.rows === 2, true);
check('G) landscape leaves the terminal at least 200px once pushed up',
  landscape.terminalH >= 200, true);
check('G) landscape keys still meet the 44px touch minimum',
  landscape.minKeyW >= 44 && landscape.minKeyH >= 44, true);

// A tablet held upright — also 4 x 2, no special case.
const tablet = await measureKeypad(834, 1112);
check('G) tablet keeps the same 4 x 2 layout',
  tablet.cols === 4 && tablet.rows === 2, true);
check('G) tablet keys meet the 44px touch minimum',
  tablet.minKeyW >= 44 && tablet.minKeyH >= 44, true);

// The narrowest phone still in service, held sideways (iPhone SE 1st gen).
const tiny = await measureKeypad(568, 320);
check('G) smallest landscape phone: 4 x 2 still meets 44px',
  tiny.cols === 4 && tiny.rows === 2 && tiny.minKeyW >= 44 && tiny.minKeyH >= 44, true);

// All 16 keys must still ship, spread over the two pages, and each must still be
// reachable by the ONE delegated handler. The v5 inventory added two further
// addressing kinds beside data-key/data-seq: the page controls and the sticky
// modifiers, which are keypad-local state rather than terminal input.
const keys = await page.evaluate(() => {
  const pages = [...document.querySelectorAll('.mobile-keypad-grid')];
  return {
    pageCount: pages.length,
    perPage: pages.map((p) => p.querySelectorAll('.keypad-key').length),
    total: document.querySelectorAll('.keypad-key').length,
    allAddressable: [...document.querySelectorAll('.keypad-key')]
      .every((k) => k.hasAttribute('data-key')
        || k.hasAttribute('data-seq')
        || k.hasAttribute('data-keypad-page')
        || k.hasAttribute('data-keypad-modifier')),
    dots: document.querySelectorAll('.keypad-dot').length,
  };
});
check('G) two key pages', keys.pageCount, 2);
check('G) 8 keys on each page', JSON.stringify(keys.perPage), '[8,8]');
check('G) all 16 keys still ship', keys.total, 16);
check('G) every key is addressable by the one delegated handler',
  keys.allAddressable, true);
check('G) one page dot per page', keys.dots, 2);

// Ctrl/Alt are sticky rather than momentary keys. Their state must remain
// visibly painted after pointerup; :active alone is insufficient. The
// realtime-input suite owns the JS toggle. This CSS-backed suite owns the
// complementary rendering contract across every retained theme.
//
// Explicit thresholds:
//   - 4.5:1 for the 16px regular-weight key label (WCAG text contrast);
//   - 3:1 for the persistent inset state indicator (non-text UI contrast).
//
// Theme names are literal here on purpose. A removed or renamed retained theme
// must be reviewed, not silently disappear from this accessibility gate.
const RETAINED_KEYPAD_THEMES = [
  'glass',
  'retro',
  'solar',
  'paper',
  'noir',
  'arctic-ice',
  'rose-gold',
  'cyberpunk-neon',
  'emerald-matrix',
  'obsidian',
];

const armedThemePaint = await page.evaluate((themes) => {
  const ctrl = document.querySelector('[data-keypad-modifier="ctrl"]');
  if (!ctrl) return { found: false, themes: [] };

  const rgb = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const channels = match[1].split(',').slice(0, 3).map(Number);
    return channels.every(Number.isFinite) ? channels : null;
  };
  const luminance = (value) => {
    const channels = rgb(value);
    if (!channels) return null;
    const linear = channels.map((channel) => {
      const encoded = channel / 255;
      return encoded <= 0.04045
        ? encoded / 12.92
        : ((encoded + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1]
      + 0.0722 * linear[2];
  };
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    if (la === null || lb === null) return null;
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  };

  const originalTheme = document.body.getAttribute('data-theme');
  const measurements = themes.map((theme) => {
    document.body.setAttribute('data-theme', theme);
    ctrl.classList.remove('is-armed');

    const idleStyle = getComputedStyle(ctrl);
    const idleRect = ctrl.getBoundingClientRect();
    const idle = {
      color: idleStyle.color,
      background: idleStyle.backgroundColor,
      border: idleStyle.borderTopColor,
      shadow: idleStyle.boxShadow,
      width: idleRect.width,
      height: idleRect.height,
    };

    ctrl.classList.add('is-armed');
    const armedStyle = getComputedStyle(ctrl);
    const armedRect = ctrl.getBoundingClientRect();
    const ringColor =
      armedStyle.boxShadow.match(/rgba?\([^)]+\)/)?.[0] || null;
    const armed = {
      color: armedStyle.color,
      background: armedStyle.backgroundColor,
      border: armedStyle.borderTopColor,
      shadow: armedStyle.boxShadow,
      width: armedRect.width,
      height: armedRect.height,
    };

    return {
      theme,
      idle,
      armed,
      paintChanged:
        idle.color !== armed.color
        || idle.background !== armed.background
        || idle.border !== armed.border
        || idle.shadow !== armed.shadow,
      backgroundChanged: idle.background !== armed.background,
      borderChanged: idle.border !== armed.border,
      geometryUnchanged:
        idle.width === armed.width && idle.height === armed.height,
      hasInsetRing:
        armed.shadow !== 'none' && armed.shadow.includes('inset'),
      textContrast: contrast(armed.color, armed.background),
      ringContrast: contrast(ringColor, armed.background),
    };
  });

  ctrl.classList.remove('is-armed');
  if (originalTheme === null) {
    document.body.removeAttribute('data-theme');
  } else {
    document.body.setAttribute('data-theme', originalTheme);
  }

  return { found: true, themes: measurements };
}, RETAINED_KEYPAD_THEMES);

check('G) sticky Ctrl exists for the armed-paint probe',
  armedThemePaint.found, true);
check('G) armed-paint gate covers the exact 10 retained theme names',
  armedThemePaint.themes.map(({ theme }) => theme).join(','),
  RETAINED_KEYPAD_THEMES.join(','));

for (const measurement of armedThemePaint.themes) {
  const prefix = `G) ${measurement.theme} armed Ctrl`;
  check(`${prefix}: computed paint differs from idle`,
    measurement.paintChanged, true);
  check(`${prefix}: background differs from idle`,
    measurement.backgroundChanged, true);
  check(`${prefix}: accent border differs from idle`,
    measurement.borderChanged, true);
  check(`${prefix}: persistent inset ring is painted`,
    measurement.hasInsetRing, true);
  check(`${prefix}: painting does not change key geometry`,
    measurement.geometryUnchanged, true);
  check(`${prefix}: 16px label contrast is at least 4.5:1`
      + ` (measured ${measurement.textContrast?.toFixed(2)})`,
    measurement.textContrast !== null
      && measurement.textContrast >= 4.5, true);
  check(`${prefix}: inset state indicator contrast is at least 3:1`
      + ` (measured ${measurement.ringContrast?.toFixed(2)})`,
    measurement.ringContrast !== null
      && measurement.ringContrast >= 3, true);
}

// The four arrows must sit TOGETHER on one row, in laptop reading order. They used
// to be split across two rows (Esc/up/down/Tab then left/right), which put the
// vertical pair and the horizontal pair in different places — the layout Cau
// rightly called backwards. Measured from geometry, not from source order: same
// row means the same top edge, adjacent means no other key between them.
const arrows = await page.evaluate(() => {
  const keys = [...document.querySelectorAll('.mobile-keypad-grid')[0]
    .querySelectorAll('.keypad-key')];
  const rowOf = (k) => Math.round(k.getBoundingClientRect().top);
  const arrowKeys = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']
    .map((n) => keys.find((k) => k.dataset.key === n));
  if (arrowKeys.some((k) => !k)) return { found: false };
  const rows = arrowKeys.map(rowOf);
  const firstRowTop = Math.min(...keys.map(rowOf));
  // Left-to-right order of the arrows as actually painted.
  const order = [...arrowKeys]
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map((k) => k.dataset.key);
  // Is any non-arrow key sitting between them on that row?
  const onSameRow = keys.filter((k) => rowOf(k) === rows[0]);
  return {
    found: true,
    allSameRow: new Set(rows).size === 1,
    onFirstRow: rows[0] === firstRowTop,
    order: order.join(','),
    interlopers: onSameRow.filter((k) => !arrowKeys.includes(k)).length,
  };
});
check('G) all four arrow keys were found on page 1', arrows.found, true);
check('G) the four arrows share ONE row (not split across two)', arrows.allSameRow, true);
check('G) that row is the first row of the page', arrows.onFirstRow, true);
check('G) nothing else sits between the arrows on that row', arrows.interlopers, 0);
check('G) arrows read left, up, down, right like a laptop cluster',
  arrows.order, 'ArrowLeft,ArrowUp,ArrowDown,ArrowRight');

// Swiping the in-flow page track must not scroll anything vertically.
check('G) the page track is confined to horizontal panning',
  await page.evaluate(() =>
    getComputedStyle(document.getElementById('mobileKeypadPages')).touchAction), 'pan-x');

// Desktop has no keypad at all, so even a stale open class is inert.
// This needs a SEPARATE context: (pointer: coarse) is a property of the input
// device, and this page's context was created with hasTouch/isMobile, so it
// matches coarse at any viewport size — resizing cannot emulate a mouse.
{
  const mouseCtx = await browser.newContext({ hasTouch: false, isMobile: false,
                                              viewport: { width: 1440, height: 900 } });
  const mousePage = await mouseCtx.newPage();
  await mousePage.goto(`${base}/tests/browser/fixture.html`);
  await mousePage.addStyleTag({ url: `${base}/static/css/style.css` });
  await mousePage.addStyleTag({ url: `${base}/static/css/deck.css` });
  await mousePage.evaluate(({ sessionBar }) => {
    document.body.innerHTML =
      `<div class="deck-window"><main class="main-content">`
      + `<div class="workspace"></div></main>${sessionBar}</div>`;
    // Even with both stale states forced on, a desktop must render nothing.
    document.getElementById('mobileKeypad').classList.add('mobile-open');
    document.body.classList.add('keypad-open');
  }, {
    sessionBar: SESSION_BAR_MARKUP,
  });
  await mousePage.waitForTimeout(60);
  const desktop = await mousePage.evaluate(() => ({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    display: getComputedStyle(document.getElementById('mobileKeypad')).display,
    offsetH: document.getElementById('mobileKeypad').offsetHeight,
  }));
  check('G) desktop really is a fine-pointer context (guards the case below)',
    desktop.coarse, false);
  check('G) desktop: keypad is display:none and measures 0 (rule is inert)',
    desktop.display === 'none' && desktop.offsetH === 0, true);
  await mouseCtx.close();
}

// ---------------------------------------------------------------------------
// Case I — the input dock stays above the iOS soft keyboard.
//
// Reported from a production iPhone: opening the keyboard left the input band
// underneath it. The shell itself already shrinks correctly (terminal-manager
// pins --app-height to visualViewport.height), but .session-bar is
// position:fixed, and a fixed box resolves `bottom` against the LAYOUT
// viewport, which the keyboard does not change — so the dock stayed at the
// bottom of the screen, behind the keyboard. The fix anchors it to the shrunken
// shell while the keyboard is open, into the 48px band that
// body.keyboard-open .main-content already reserves.
//
// Driven against the REAL xterm: the fixture's own terminal (#term, built by the
// shipped createTerminal/attachTerminal) is MOVED into the production pane
// topology, so term.rows below is the shipped instance re-fitting through its
// own ResizeObserver rather than a synthetic box.
//
// On the fixture keyboard-open race: the fixture ships no <meta name="viewport">,
// so Chromium falls back to a 980px layout viewport, terminal-manager captures
// initialHeight from a SCALED visual viewport, and the first real resize then
// computes a ratio far below 0.75 and sets body.keyboard-open by itself —
// silently turning a "closed" reading into an open one. Production index.html
// declares width=device-width, so this case serves the fixture WITH that tag:
// the harness matches production and the race disappears. No production code is
// patched, stubbed or weakened, and the class is then driven only by this test —
// which the first check of each state verifies rather than assumes.
// ---------------------------------------------------------------------------
{
  const KB = 336;      // iPhone portrait soft keyboard
  // W14 item 3 adds a compact status line to the portrait dock, so the dock is
  // no longer the old fixed 48px band. Derive its real token-owned height from
  // --composer-dock-height; this remains a strong bound because a geometry
  // regression not expressed by that token still fails the measured equality.
  const dockHeightFor = (p) => p.evaluate(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--composer-dock-height').trim();
    // The custom property is a calc(); measure the live dock to resolve it.
    const dock = document.getElementById('sessionBar').getBoundingClientRect();
    if (!raw || dock.height <= 0) {
      throw new Error(`invalid composer dock height: token="${raw}" box=${dock.height}`);
    }
    return Math.round(dock.height);
  });

  const fixtureHtml = fs.readFileSync(
    path.join(sourceRoot, 'tests/browser/fixture.html'), 'utf8');
  if (!fixtureHtml.includes('<head>')) throw new Error('fixture has no <head> to patch');
  const stripMarkupI = (() => {
    const src = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
    // Anchor on the row's real close (the </header> that follows it) rather than
    // on the first "</div></div>" pair: the lazy form silently truncated the
    // scaffold whenever the tag sequence inside the row changed.
    const m = src.match(/(<div class="session-tabs-row">[\s\S]*?\n {8}<\/div>)\n {4}<\/header>/);
    if (!m) throw new Error('could not extract .session-tabs-row from index.html');
    return m[1];
  })();

  for (const [w, h] of [[390, 844], [360, 800]]) {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true,
                                           viewport: { width: w, height: h } });
    const ip = await ctx.newPage();
    await ip.route('**/fixture.html', route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: fixtureHtml.replace('<head>',
        '<head><meta name="viewport" content="width=device-width, initial-scale=1">'),
    }));
    await ip.goto(`${base}/tests/browser/fixture.html`);
    await ip.waitForFunction('window.__ready === true', { timeout: 15000 });
    await ip.addStyleTag({ url: `${base}/static/css/style.css` });
    await ip.addStyleTag({ url: `${base}/static/css/deck.css` });

    // Real #sessionBar and real strip, inside the production shell topology.
    //
    // FIXTURE CORRECTION (class (a) fixture defect, not an app defect): this
    // scaffold nested #sessionBar INSIDE <main>, which is the pre-move
    // structure, and had no .deck-window at all. Production
    // (templates/index.html:57-769) wraps the shell in .deck-window and makes
    // #sessionBar a SIBLING after </main>. With the bar inside main it could
    // never be the shell's last flex item, so its bottom measured main's bottom
    // (756 at 390x844, 712 at 360x800) while .header took the trailing 88px.
    // Nothing was missing from the shell; the topology was wrong.
    await ip.evaluate(({ bar, strip }) => {
      const termEl = document.getElementById('term');   // the live xterm host
      const shell = document.createElement('div');
      shell.innerHTML = `<div class="deck-window" id="deckWindow">
        <header class="header">${strip}</header>
        <main class="main-content"><div class="workspace" id="workspace">
          <div class="terminal-area"><div class="terminals-container"><div class="terminal-grid">
            <div class="terminal-pane" data-pane-index="0" id="paneI"></div>
          </div></div></div>
          <aside class="notepad-panel" id="notepadPanel">
            <textarea id="sessionNotepad"></textarea></aside>
        </div></main>${bar}</div>`;
      document.body.innerHTML = '';
      while (shell.firstChild) document.body.appendChild(shell.firstChild);
      document.getElementById('paneI').appendChild(termEl);
      document.getElementById('sessionBar').classList.remove('hidden');
      const t = document.getElementById('sessionTabs');
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('div');
        d.className = 'session-tab';
        d.innerHTML = '<span class="status-dot connected"></span>'
          + `<span class="tab-label">h${i}</span>`;
        t.appendChild(d);
      }
    }, { bar: SESSION_BAR_MARKUP, strip: stripMarkupI });

    const read = () => ip.evaluate(() => {
      const sb = document.getElementById('sessionBar');
      const b = sb.getBoundingClientRect();
      const inp = document.getElementById('mobileInput').getBoundingClientRect();
      const tw = document.getElementById('term').getBoundingClientRect();
      const ws = document.getElementById('workspace').getBoundingClientRect();
      // The SHELL box is what the dock must rest on now that it is the last
      // normal-flow flex item of .deck-window.
      const deck = document.querySelector('.deck-window').getBoundingClientRect();
      const iw = Math.max(0, Math.min(b.right, tw.right) - Math.max(b.left, tw.left));
      const ih = Math.max(0, Math.min(b.bottom, tw.bottom) - Math.max(b.top, tw.top));
      return {
        rows: window.__probe.term.rows,
        kb: document.body.classList.contains('keyboard-open'),
        shellH: Math.round(document.body.getBoundingClientRect().height),
        pos: getComputedStyle(sb).position,
        barTop: Math.round(b.top), barBottom: Math.round(b.bottom),
        barH: Math.round(b.height),
        inpBottom: Math.round(inp.bottom), inpH: Math.round(inp.height),
        twBottom: Math.round(tw.bottom),
        wsBottom: Math.round(ws.bottom),
        deckBottom: Math.round(deck.bottom),
        dockTerminalIntersection: Math.round(iw * ih),
      };
    });

    // ---- keyboard CLOSED: the fix must change nothing here -----------------
    await ip.evaluate(() => {
      document.body.classList.remove('keyboard-open', 'notepad-focused');
      document.documentElement.style.removeProperty('--app-height');
    });
    await ip.waitForTimeout(520);
    const closed = await read();
    check(`I) ${w}x${h} closed: the harness really is in the closed state`, closed.kb, false);
    // RE-TARGETED, not relaxed. `fixed` + a viewport-bottom coordinate asserted
    // the out-of-flow dock the approved change deliberately replaced. The
    // replacements bind the dock to the SHELL box and add a zero-intersection
    // floor and a composer floor the old pair never had, so a regression back to
    // an out-of-flow dock fails here.
    check(`I) ${w}x${h} closed: dock participates in normal flow`,
      closed.pos, 'relative');
    check(`I) ${w}x${h} closed: dock bottom is exactly the shell bottom`,
      closed.barBottom, closed.deckBottom);
    check(`I) ${w}x${h} closed: terminal ends at or above the dock top`,
      closed.twBottom <= closed.barTop, true);
    check(`I) ${w}x${h} closed: dock and terminal have zero 2-D intersection`,
      closed.dockTerminalIntersection, 0);
    check(`I) ${w}x${h} closed: the composer keeps its 44px touch height`,
      closed.inpH >= 44, true);
    const DOCK = await dockHeightFor(ip);
    check(`I) ${w}x${h} closed: workspace ends above the token-derived dock`,
      closed.wsBottom, h - DOCK);
    check(`I) ${w}x${h} closed: the real terminal renders rows (got ${closed.rows})`,
      closed.rows >= 1, true);

    // ---- keyboard OPEN: driven exactly as terminal-manager drives it -------
    await ip.evaluate(vh => {
      document.documentElement.style.setProperty('--app-height', vh + 'px');
      document.body.classList.add('keyboard-open');
    }, h - KB);
    await ip.waitForTimeout(560);
    const open = await read();
    check(`I) ${w}x${h} open: the harness really is in the open state`, open.kb, true);
    check(`I) ${w}x${h} open: the shell shrank to the visual viewport`, open.shellH, h - KB);
    // The dock does NOT switch positioning scheme when the keyboard opens: the
    // shell itself shrinks via --app-height and the in-flow dock follows it.
    // Asserting the scheme is unchanged between states is stricter than the old
    // fixed -> absolute expectation, which allowed the dock to be out of flow in
    // both states.
    check(`I) ${w}x${h} open: dock still participates in normal flow`,
      open.pos, 'relative');
    check(`I) ${w}x${h} open: the dock never switches positioning scheme`,
      open.pos, closed.pos);
    check(`I) ${w}x${h} open: dock bottom is exactly the shrunken shell bottom`,
      open.barBottom, open.deckBottom);
    check(`I) ${w}x${h} open: dock bottom is the shell bottom, above the keyboard`,
      open.barBottom, h - KB);
    check(`I) ${w}x${h} open: dock and terminal have zero 2-D intersection`,
      open.dockTerminalIntersection, 0);
    check(`I) ${w}x${h} open: the token-derived composer/status dock is intact`,
      open.barH, DOCK);
    check(`I) ${w}x${h} open: dock sits exactly in its token-derived band`,
      open.barTop, h - KB - DOCK);
    check(`I) ${w}x${h} open: no gap and no overlap between terminal area and dock`,
      open.barTop, open.wsBottom);
    check(`I) ${w}x${h} open: the input is above the keyboard, not under it`,
      open.inpBottom <= h - KB, true);
    check(`I) ${w}x${h} open: the input keeps its 44px touch height`, open.inpH >= 44, true);
    check(`I) ${w}x${h} open: the terminal never paints under the dock`,
      open.twBottom <= open.barTop, true);
    check(`I) ${w}x${h} open: the real terminal still renders rows (got ${open.rows})`,
      open.rows >= 1, true);
    check(`I) ${w}x${h} open: the keyboard costs rows, the dock move does not`,
      open.rows < closed.rows, true);

    await ctx.close();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close(); server.close();
process.exit(failed>0?1:0);
