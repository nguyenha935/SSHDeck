/*
 * Offline browser tests for the mobile/touch redesign additions.
 *
 * These load the REAL vendored xterm 5.3.0 build AND the REAL
 * static/js/terminal-manager.js (via tests/browser/fixture.html) and drive the
 * shipped code path with Playwright/Chromium to prove the pieces the redesign
 * adds on top of the #44 baseline (which interaction.test.mjs already covers):
 *
 *   1. OSC 52  -> the registered parser handler decodes the base64 payload and
 *                 writes it to the system clipboard (this is what makes desktop
 *                 mouse-drag copy work like a real terminal, no Shift/button).
 *   2. Long-press -> selection: hold without moving selects the cell under the
 *                 finger; dragging extends it; lifting copies getSelection() to
 *                 the clipboard and shows the "Đã copy" toast.
 *   3. Swipe scroll (ERROR 5): a finger swipe over N cells emits N SGR mouse
 *                 reports (proportional to travel), because the handler fires N
 *                 discrete LINE-MODE wheels — not one wheel carrying the whole
 *                 delta (which xterm collapses to a single report / drops when
 *                 sub-cell).
 *   4. Paste: terminal.paste() wraps text in bracketed-paste markers when the
 *                 app has bracketed mode on, plain otherwise (the mobile "Dán"
 *                 button path). Native paste is already covered in the baseline.
 *   5. ResizeObserver: shrinking the wrapper re-fits the terminal (rows change).
 *
 * Unlike interaction.test.mjs (which deliberately grants NO clipboard permission
 * to prove native paste does not need it), these run in a context that DOES
 * grant clipboard-read/-write, because the redesign's copy path legitimately
 * uses navigator.clipboard.writeText/readText on the HTTPS deployment.
 *
 * Run: node tests/browser/redesign.test.mjs   (from source/)
 * Exit code 0 = all passed, 1 = a failure (details on stderr).
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

function startServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath.replace(/^\/+/, '');
      const filePath = path.join(sourceRoot, rel);
      if (!filePath.startsWith(sourceRoot)) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${cond ? '' : ' -- ' + (detail || '')}`);
}

// Dispatch a real TouchEvent sequence on the .xterm-screen. pageX/pageY are set
// because the swipe handler reads pageY; clientX/clientY drive clientToCell.
async function fireTouch(page, seq) {
  await page.evaluate((steps) => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('term');
    function fire(type, cx, cy) {
      const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
      const ev = new TouchEvent(type, {
        cancelable: true, bubbles: true,
        touches: type === 'touchend' || type === 'touchcancel' ? [] : [t],
        targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : [t],
        changedTouches: [t],
      });
      el.dispatchEvent(ev);
    }
    for (const s of steps) { fire(s.type, s.x, s.y); }
  }, seq);
}

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    hasTouch: true,
    // The redesign's copy/paste path uses the async clipboard API on the HTTPS
    // deployment; grant it here (127.0.0.1 is a secure context under Chromium).
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${base}/tests/browser/fixture.html`);
  await page.waitForFunction('window.__ready === true', { timeout: 10000 });

  check('fixture built terminal via real terminal-manager.js, no page errors',
    consoleErrors.length === 0, consoleErrors.join('; '));

  // Sanity: clipboard round-trips in this context (proves the harness, not the app).
  const rt = await page.evaluate(async () => {
    await navigator.clipboard.writeText('ROUNDTRIP_✓_ăâđ');
    return await navigator.clipboard.readText();
  });
  check('clipboard round-trips in this context', rt === 'ROUNDTRIP_✓_ăâđ',
    `got=${JSON.stringify(rt)}`);

  // Geometry for touch coordinates.
  const geo = await page.evaluate(() => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('term');
    const r = el.getBoundingClientRect();
    const rows = window.__probe.term.rows;
    return { x: r.x, y: r.y, w: r.width, h: r.height, rows, cellH: r.height / rows };
  });
  const cx = Math.round(geo.x + geo.w / 2);
  const cy = Math.round(geo.y + geo.h / 2);

  // ---- 1. OSC 52 -> clipboard ----------------------------------------------
  {
    const expected = 'OSC52_ăâđ_你好'; // ăâđ 你好
    const b64 = await page.evaluate((t) => {
      // Build base64 of the UTF-8 bytes the way tmux/set-clipboard would.
      const bytes = new TextEncoder().encode(t);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }, expected);
    await page.evaluate(() => navigator.clipboard.writeText('__cleared__'));
    await page.evaluate((payload) => {
      window.__probe.term.write('\x1b]52;c;' + payload + '\x07');
    }, b64);
    await page.waitForTimeout(120);
    const got = await page.evaluate(() => navigator.clipboard.readText());
    check('OSC 52 handler decodes payload to clipboard (UTF-8)', got === expected,
      `got=${JSON.stringify(got)}`);

    // A clipboard QUERY (\x1b]52;c;?) must be ignored, not leak/overwrite.
    await page.evaluate(() => navigator.clipboard.writeText('QUERY_GUARD'));
    await page.evaluate(() => window.__probe.term.write('\x1b]52;c;?\x07'));
    await page.waitForTimeout(80);
    const afterQuery = await page.evaluate(() => navigator.clipboard.readText());
    check('OSC 52 clipboard query (?) is ignored (no overwrite)', afterQuery === 'QUERY_GUARD',
      `got=${JSON.stringify(afterQuery)}`);
  }

  // ---- 2. Long-press select -> drag extend -> lift copies + toast ----------
  {
    // Stub window.showNotification (app.js is not loaded in the fixture) so we
    // can assert the touchend copy path fires the toast.
    await page.evaluate(() => {
      window.__toasts = [];
      window.showNotification = (msg, type) => window.__toasts.push({ msg, type });
    });
    await page.evaluate(() => { window.__probe.disableAppMouse(); window.__probe.clearSelection(); });
    await page.evaluate(() => navigator.clipboard.writeText('__pre_longpress__'));

    // touchstart and hold WITHOUT moving so the long-press timer (500ms) fires.
    await fireTouch(page, [{ type: 'touchstart', x: cx, y: cy }]);
    await page.waitForTimeout(600);
    const selectedAfterHold = await page.evaluate(() => window.__probe.hasSelection());
    check('long-press (hold 500ms, no move) enters selection', selectedAfterHold);

    // Drag the finger to the right and down a couple of cells to extend.
    const ex = Math.min(Math.round(geo.x + geo.w - 5), cx + 200);
    const ey = Math.round(cy + geo.cellH * 2);
    await fireTouch(page, [
      { type: 'touchmove', x: cx + 40, y: cy },
      { type: 'touchmove', x: ex, y: ey },
    ]);
    await page.waitForTimeout(50);
    const selText = await page.evaluate(() => window.__probe.getSelection());
    check('drag after long-press extends the selection (non-empty)',
      !!selText && selText.length > 0, `sel=${JSON.stringify((selText || '').slice(0, 40))}`);

    // Lift the finger: touchend copies getSelection() and toasts.
    await fireTouch(page, [{ type: 'touchend', x: ex, y: ey }]);
    await page.waitForTimeout(120);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('touchend copies the selection to the clipboard',
      clip === selText && clip !== '__pre_longpress__', `clip=${JSON.stringify((clip || '').slice(0, 40))}`);
    const toasts = await page.evaluate(() => window.__toasts);
    check('touchend shows a success toast', toasts.length === 1 && toasts[0].type === 'success',
      `toasts=${JSON.stringify(toasts)}`);
    const clearedAfterLift = await page.evaluate(() => window.__probe.hasSelection());
    check('selection is cleared after lift', clearedAfterLift === false);
  }

  // ---- 3. Swipe scroll emits N proportional SGR reports (ERROR 5) ----------
  {
    await page.evaluate(() => { window.__probe.enableAppMouse(); window.__probe.clearData(); });
    // Swipe UP by ~5 cell-heights in one move. The handler must translate this
    // into ~5 line-mode wheels => ~5 SGR reports, NOT 1.
    const travel = Math.round(geo.cellH * 5);
    await fireTouch(page, [
      { type: 'touchstart', x: cx, y: cy + travel },
      { type: 'touchmove', x: cx, y: cy },        // moved up by `travel`
      { type: 'touchend', x: cx, y: cy },
    ]);
    await page.waitForTimeout(120);
    const data = await page.evaluate(() => window.__probe.data.join(''));
    const reports = (data.match(/\x1b\[<(64|65)/g) || []).length;
    check('swipe of ~5 cells emits multiple SGR wheel reports (proportional, not 1)',
      reports >= 3, `reports=${reports} data=${JSON.stringify(data).slice(0, 80)}`);

    // App-mouse OFF: the swipe handler must not forward anything (xterm scrolls
    // its own viewport natively instead).
    await page.evaluate(() => { window.__probe.disableAppMouse(); window.__probe.clearData(); });
    await fireTouch(page, [
      { type: 'touchstart', x: cx, y: cy + travel },
      { type: 'touchmove', x: cx, y: cy },
      { type: 'touchend', x: cx, y: cy },
    ]);
    await page.waitForTimeout(120);
    const offData = await page.evaluate(() => window.__probe.data.join(''));
    check('app-mouse OFF: swipe forwards nothing to PTY', offData.length === 0,
      `data=${JSON.stringify(offData).slice(0, 80)}`);
  }

  // ---- 4. terminal.paste() wraps bracketed paste (mobile Dán button path) ---
  {
    await page.evaluate(() => window.__probe.clearData());
    const bracketed = await page.evaluate(async () => {
      window.__probe.term.write('\x1b[?2004h'); // bracketed paste ON
      await new Promise((r) => setTimeout(r, 30));
      window.__probe.clearData();
      window.__probe.term.paste('line1\nline2');
      await new Promise((r) => setTimeout(r, 80));
      return window.__probe.data.join('');
    });
    check('terminal.paste with bracketed ON wraps in \\x1b[200~ .. \\x1b[201~',
      bracketed.includes('\x1b[200~') && bracketed.includes('\x1b[201~') && bracketed.includes('line1'),
      `data=${JSON.stringify(bracketed)}`);

    await page.evaluate(() => window.__probe.clearData());
    const plain = await page.evaluate(async () => {
      window.__probe.term.write('\x1b[?2004l'); // bracketed paste OFF
      await new Promise((r) => setTimeout(r, 30));
      window.__probe.clearData();
      window.__probe.term.paste('line1\nline2');
      await new Promise((r) => setTimeout(r, 80));
      return window.__probe.data.join('');
    });
    check('terminal.paste with bracketed OFF sends plain text (no 200~), \\n normalised to \\r',
      !plain.includes('\x1b[200~') && plain.includes('line1') && plain.includes('\r'),
      `data=${JSON.stringify(plain)}`);
  }

  // ---- 5. ResizeObserver re-fits when the wrapper shrinks -------------------
  {
    await page.evaluate(() => window.__probe.clearEmitted());
    const before = await page.evaluate(() => window.__probe.term.rows);
    await page.evaluate(() => {
      // Resize the PANE; the wrapper is height:100% of it, exactly like the app.
      document.getElementById('pane').style.height = '200px'; // was 400px
    });
    // Observer debounce is 50ms; give it room plus a fit tick.
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => window.__probe.term.rows);
    check('ResizeObserver re-fits terminal rows when wrapper shrinks', after < before,
      `rows ${before} -> ${after}`);

    // ...and the new size is forwarded to the remote PTY. This is the round-10
    // fix: a fit that only changed the browser side left tmux painting its whole
    // screen into the old, smaller box — the green status line ended up mid-
    // screen with dead rows under it ("the terminal shrank to the top"), and the
    // exit-scroll button then appeared to land on that status line.
    const emits = await page.evaluate(() => window.__probe.resizeEmits());
    check('a fit that changes rows emits exactly one ssh_resize', emits.length === 1,
      `emits=${JSON.stringify(emits)}`);
    check('the ssh_resize payload carries the session id and the NEW rows/cols',
      emits.length === 1
        && emits[0].payload.session_id === 'test'
        && emits[0].payload.rows === after
        && typeof emits[0].payload.cols === 'number',
      `payload=${JSON.stringify(emits[0] && emits[0].payload)} rows=${after}`);
  }

  // ---- 5b. Destroying a terminal clears scrollbar-owned resources ----------
  // observeScrollState owns a periodic refresh plus two xterm disposables.
  // A key can be recreated before an orphaned interval wakes; checking only for
  // terminal absence inside the interval therefore leaks the old lifecycle.
  //
  // S35 P36: the ELEMENT assertions below were retired with the control they
  // pinned. `setupScrollbar` used to build a `.terminal-scrollbar` overlay whose
  // CSS did not exist anywhere in the project, so it was invisible, clipped
  // outside the pane box, and its drag divisor was exactly 0 -- see
  // observeScrollState's note and s35_p5_reload_lifecycle.mjs §5. What this
  // block was really protecting is the CLEANUP REGISTRY (no orphaned interval
  // or disposable survives destroyTerminalKey), and that contract is unchanged
  // and still asserted; only the DOM-count halves are gone, because counting an
  // element that no longer ships would assert nothing.
  {
    const lifecycle = await page.evaluate(() => {
      const manager = window.__probe.manager;
      const terminal = window.__probe.term;
      let disposeCalls = 0;
      const realDispose = terminal.dispose.bind(terminal);
      terminal.dispose = () => {
        disposeCalls++;
        return realDispose();
      };
      const before = {
        registered: typeof manager.scrollbarCleanups.test === 'function',
      };
      manager.destroyTerminalKey('test', 'test');
      return {
        before,
        cleanupPresent: Object.prototype.hasOwnProperty.call(
          manager.scrollbarCleanups, 'test'),
        terminalPresent: Object.prototype.hasOwnProperty.call(manager.terminals, 'test'),
        disposeCalls,
      };
    });
    check('scroll-state lifecycle is registered before terminal destruction',
      lifecycle.before.registered === true,
      JSON.stringify(lifecycle.before));
    check('destroyTerminalKey removes the scroll-state cleanup registry entry',
      lifecycle.cleanupPresent === false, JSON.stringify(lifecycle));
    check('destroyTerminalKey removes the terminal itself',
      lifecycle.terminalPresent === false, JSON.stringify(lifecycle));
    check('destroyTerminalKey still disposes the real xterm instance exactly once',
      lifecycle.disposeCalls === 1, JSON.stringify(lifecycle));
  }

  // The lifecycle test intentionally disposed the first fixture terminal. Build
  // a fresh real terminal under the same key so the remaining contracts exercise
  // key recreation rather than continuing against a dead instance.
  await page.reload();
  await page.waitForFunction('window.__ready === true', { timeout: 10000 });

  // ---- 6. A fit that changes nothing sends nothing --------------------------
  // The emit hangs off terminal.onResize, which xterm fires only on a real
  // rows/cols change. That is what keeps a burst of layout events (keyboard
  // slide, dvh settle) from turning into a burst of PTY resizes.
  {
    await page.evaluate(() => window.__probe.clearEmitted());
    const before = await page.evaluate(() => ({
      rows: window.__probe.term.rows, cols: window.__probe.term.cols,
    }));
    await page.evaluate(() => {
      window.__probe.manager.fitTerminal('test');
      window.__probe.manager.fitTerminal('test');
      window.__probe.manager.fitTerminal('test');
    });
    await page.waitForTimeout(100);
    const emits = await page.evaluate(() => window.__probe.resizeEmits());
    const after = await page.evaluate(() => ({
      rows: window.__probe.term.rows, cols: window.__probe.term.cols,
    }));
    check('three no-op fits emit no ssh_resize at all', emits.length === 0,
      `emits=${JSON.stringify(emits)} size ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  // ---- 7. A hidden wrapper is never fitted ---------------------------------
  // `.terminal-wrapper.unassigned` is display:none (a session not shown in any
  // pane). fitAddon does NOT skip it: it reads getComputedStyle(wrapper) and
  // parseInt()s height/width. On a display:none element those never resolve to
  // pixels, so the declared value comes back verbatim — and the wrapper is
  // `height:100%; width:100%`, so parseInt('100%') === 100 and the addon sees a
  // 100x100 PIXEL box. Measured here: ~10x6 against a visible ~95x32.
  //
  // fit() would apply that. Harmless while nobody acted on it; now that every
  // resize reaches the PTY, a 10x6 would land on tmux and it would repaint its
  // whole screen into that. So fitTerminal must skip a hidden wrapper entirely.
  {
    await page.evaluate(() => window.__probe.clearEmitted());
    const res = await page.evaluate(() => {
      const el = document.getElementById('term');
      el.style.display = 'none';               // what .unassigned does
      const before = { rows: window.__probe.term.rows, cols: window.__probe.term.cols };
      const proposed = window.__probe.manager.fitAddons.test.proposeDimensions();
      const visible = window.__probe.manager.isTerminalVisible('test');
      window.__probe.manager.fitTerminal('test');
      const after = { rows: window.__probe.term.rows, cols: window.__probe.term.cols };
      el.style.display = '';                   // restore
      return { before, after, proposed, visible };
    });
    check('a display:none wrapper reports not visible', res.visible === false,
      `visible=${res.visible}`);
    // Guard against a vacuous test: if the hidden measurement ever stopped being
    // wrong, the two checks below would pass for the wrong reason. Pin the fact
    // that fitAddon really does propose a collapsed size while hidden.
    check('a hidden wrapper really does measure wrong (fitAddon proposes a collapsed size)',
      !!res.proposed && (res.proposed.cols < res.before.cols || res.proposed.rows < res.before.rows),
      `hidden proposal ${JSON.stringify(res.proposed)} vs real ${JSON.stringify(res.before)}`);
    check('fitTerminal leaves a hidden terminal at its last real size',
      res.after.rows === res.before.rows && res.after.cols === res.before.cols,
      `${JSON.stringify(res.before)} -> ${JSON.stringify(res.after)}, ` +
      `fitAddon would have proposed ${JSON.stringify(res.proposed)}`);
    const emits = await page.evaluate(() => window.__probe.resizeEmits());
    check('a hidden wrapper never pushes a size to the PTY', emits.length === 0,
      `emits=${JSON.stringify(emits)}`);
  }

  // ---- 8. No socket yet -> resize is skipped, not thrown -------------------
  // Terminals are built before the Socket.IO client exists on a cold load, and a
  // reconnect nulls it out; the initial fit must not blow up the page there.
  {
    const outcome = await page.evaluate(() => {
      const saved = window.socket;
      window.socket = null;
      let threw = null;
      try {
        const el = document.getElementById('pane');
        el.style.height = '260px';             // force a REAL rows change
        window.__probe.manager.fitTerminal('test');
      } catch (e) {
        threw = String(e);
      }
      window.socket = saved;
      return { threw, rows: window.__probe.term.rows };
    });
    check('fit with no socket does not throw', outcome.threw === null,
      `threw=${outcome.threw}`);
  }

  // ---- 9. Arrows are encoded BY XTERM, so they suit both cursor-key modes ---
  // The mobile keypad has no arrows of its own: it dispatches a synthetic
  // KeyboardEvent at xterm's hidden textarea and lets xterm produce the bytes.
  // That is the whole point. An arrow is \x1b[A in a shell but \x1bOA once a
  // program sets DECCKM (application cursor keys), and a program ignores the
  // wrong form outright. Hard-coding either one would ship the very bug the
  // keypad is meant to fix, so pin both directions here.
  {
    const press = async (key) => {
      await page.evaluate((k) => {
        window.__probe.clearData();
        const ta = document.querySelector('.xterm-helper-textarea');
        const legacy = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[k] || 0;
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: k, code: k, keyCode: legacy, which: legacy, bubbles: true, cancelable: true,
        }));
      }, key);
      await page.waitForTimeout(60);
      return page.evaluate(() => window.__probe.data.join(''));
    };

    await page.evaluate(() => window.__probe.disableAppCursorKeys());
    await page.waitForTimeout(60);
    const normalMode = await page.evaluate(() => window.__probe.modes().applicationCursorKeysMode);
    const upNormal = await press('ArrowUp');
    const downNormal = await press('ArrowDown');
    check('shell (DECCKM off): a synthetic arrow is encoded as the CSI form',
      normalMode === false && upNormal === '\x1b[A' && downNormal === '\x1b[B',
      `mode=${normalMode} up=${JSON.stringify(upNormal)} down=${JSON.stringify(downNormal)}`);

    await page.evaluate(() => window.__probe.enableAppCursorKeys());
    await page.waitForTimeout(60);
    const appMode = await page.evaluate(() => window.__probe.modes().applicationCursorKeysMode);
    const upApp = await press('ArrowUp');
    const downApp = await press('ArrowDown');
    check('in-app (DECCKM on): the SAME dispatch is encoded as the SS3 form',
      appMode === true && upApp === '\x1bOA' && downApp === '\x1bOB',
      `mode=${appMode} up=${JSON.stringify(upApp)} down=${JSON.stringify(downApp)}`);
    check('the two modes really do differ (the encoding is not a constant)',
      upNormal !== upApp, `both were ${JSON.stringify(upNormal)}`);

    // The dispatch must not move focus, or the mobile box would lose the
    // Vietnamese IME every time a function key was pressed.
    const focusKept = await page.evaluate(async () => {
      const probe = document.createElement('textarea');
      probe.id = 'focusProbe';
      document.body.appendChild(probe);
      probe.focus();
      const before = document.activeElement.id;
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38, bubbles: true, cancelable: true,
      }));
      await new Promise((r) => setTimeout(r, 60));
      const after = document.activeElement.id;
      probe.remove();
      return { before, after };
    });
    check('dispatching a key does not steal focus from the mobile input',
      focusKept.before === 'focusProbe' && focusKept.after === 'focusProbe',
      JSON.stringify(focusKept));

    await page.evaluate(() => window.__probe.disableAppCursorKeys());
    await page.waitForTimeout(60);
  }

  // ---- 10. appOwnsMouse tells "no copy-mode" apart from "app is scrolling" --
  // tmux's wheel binding is
  //   if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" {send-keys -M} {copy-mode -e}
  // so while a program owns the mouse tmux never enters copy-mode and honestly
  // answers pane_in_mode=0. Reporting that as a bare "not in scroll mode" read
  // as a broken button to a user who was plainly scrolling inside the app. This
  // is the browser-side flag that separates the two cases, and it has to track
  // the DECSET mode exactly the way tmux's own flag does.
  {
    const read = () => page.evaluate(() => ({
      owns: window.__probe.manager.appOwnsMouse('test'),
      mode: window.__probe.modes().mouseTrackingMode,
    }));

    await page.evaluate(() => window.__probe.disableAppMouse());
    await page.waitForTimeout(60);
    const off = await read();
    check('no app tracking the mouse: appOwnsMouse is false',
      off.owns === false && off.mode === 'none', JSON.stringify(off));

    // 1002h is what a program like claude sets.
    await page.evaluate(() => window.__probe.term.write('\x1b[?1002h'));
    await page.waitForTimeout(60);
    const drag = await read();
    check('app sets 1002h (button-event): appOwnsMouse is true, mode is drag',
      drag.owns === true && drag.mode === 'drag', JSON.stringify(drag));

    await page.evaluate(() => window.__probe.term.write('\x1b[?1002l'));
    await page.waitForTimeout(60);
    const back = await read();
    check('app exits: appOwnsMouse goes back to false',
      back.owns === false && back.mode === 'none', JSON.stringify(back));

    await page.evaluate(() => window.__probe.enableAppMouse());
    await page.waitForTimeout(60);
    const any = await read();
    check('1003h (any-event) also counts as the app owning the mouse',
      any.owns === true && any.mode === 'any', JSON.stringify(any));

    // A build without terminal.modes must degrade to the old wording, not throw.
    const guarded = await page.evaluate(() => {
      const t = window.__probe.manager.terminals.test;
      const saved = Object.getOwnPropertyDescriptor(t, 'modes');
      let threw = null, result = null;
      try {
        Object.defineProperty(t, 'modes', { value: undefined, configurable: true });
        result = window.__probe.manager.appOwnsMouse('test');
      } catch (e) {
        threw = String(e);
      }
      if (saved) Object.defineProperty(t, 'modes', saved);
      else delete t.modes;
      return { threw, result };
    });
    check('a terminal without .modes reports false instead of throwing',
      guarded.threw === null && guarded.result === false, JSON.stringify(guarded));

    await page.evaluate(() => window.__probe.disableAppMouse());
    await page.waitForTimeout(60);
  }

  // ---- 11. The function keypad PUSHES the terminal up, not over it ----------
  // Cau's report: "khi an nut thi ban phim chuc nang do no khong day khung chat
  // terminal len" — the sheet appeared over the bottom rows instead of shrinking
  // the frame the way the soft keyboard does. Measured before the fix: the
  // wrapper stayed 778px and 205px of keys lay over the prompt.
  //
  // RETIRED MECHANISM, RE-TARGETED CONTRACT (v5, amendment line 94).
  //
  // This block originally measured a RESERVE model: one CSS rule
  // (body.keypad-open .terminal-area { padding-bottom: var(--keypad-height) })
  // plus app.js publishing the panel's height into that variable, with the panel
  // itself absolutely positioned and slid in with translateY. That model is gone.
  // --keypad-height has no writer or consumer left, and both style.css and app.js
  // are asserted free of it in mobile_shell_trusted.mjs.
  //
  // v5 requires the keypad to be a NORMAL-FLOW flex item immediately after the
  // sole composer inside #sessionBar: opening it grows the dock, the elastic
  // workspace above shrinks, and the terminal is never overlaid. So the three
  // assertions that encoded the reserve mechanism are re-targeted below rather
  // than deleted -- the same three behaviours are still guarded, measured against
  // the flow model instead of the padding model:
  //
  //   "keypad has a real height to reserve"  -> closed keypad reserves NOTHING
  //                                             (display:none, zero box), and the
  //                                             open panel has a real height.
  //   "shrinks by exactly the keypad height" -> the workspace loses exactly the
  //                                             height the open dock gained.
  //   "does not change size when padding is  -> the panel's height is stable
  //    applied"                                 while open (no feedback loop from
  //                                             the observer re-measuring it).
  //
  // Everything still runs through the shipped path -- real wrapper geometry, the
  // real ResizeObserver, the real terminal.onResize -> ssh_resize -- so it fails
  // if any link in that chain breaks.
  //
  // The app's own markup is built here (the fixture is a bare #pane/#term) with
  // the real keypad extracted from templates/index.html and the real style.css
  // AND deck.css (which owns the .deck-window flex shell the dock sits in), then
  // the live terminal is MOVED into it so the instance and its observer survive.
  {
    const indexHtml = fs.readFileSync(path.join(sourceRoot, 'templates/index.html'), 'utf8');
    /*
     * Anchored on the panel's OWN closing tag at its real indentation (8 spaces),
     * then VALIDATED. The previous pattern stopped at the first `\n` + 12 spaces
     * + `</div>`, which is an INNER close: it captured 1973 chars containing zero
     * .mobile-keypad-grid and zero .keypad-key, so the scaffold mounted an empty
     * shell and the panel "opened" to 63px of head chrome with no keys at all.
     * Validating the extraction makes a markup reshape fail loudly here instead of
     * silently degrading every geometry assertion below into a measurement of
     * nothing.
     */
    const keypadMatch = indexHtml.match(
      /<div class="mobile-keypad" id="mobileKeypad"[\s\S]*?\n {8}<\/div>/);
    check('extracted the real keypad markup from index.html', !!keypadMatch,
      keypadMatch ? `${keypadMatch[0].length} chars` : 'NO MATCH — markup shape changed');
    const keypadPages = keypadMatch
      ? (keypadMatch[0].match(/class="mobile-keypad-grid"/g) || []).length : 0;
    const keypadKeys = keypadMatch
      ? (keypadMatch[0].match(/class="keypad-key"/g) || []).length : 0;
    check('the extracted keypad really carries the v5 2 x 8 inventory',
      keypadPages === 2 && keypadKeys === 16,
      `pages=${keypadPages} keys=${keypadKeys}`);

    // A phone-sized viewport, so the (pointer: coarse) rules apply and the
    // 4-column portrait layout is what gets measured.
    await page.setViewportSize({ width: 428, height: 926 });
    await page.addStyleTag({ url: `${base}/static/css/style.css` });
    // deck.css owns .deck-window's flex sizing and MUST load after style.css,
    // exactly as production orders them. Without it the shell is not a flex
    // column and the dock cannot be the last item that grows.
    await page.addStyleTag({ url: `${base}/static/css/deck.css` });
    await page.evaluate((kp) => {
      // The real terminal-manager may have set body.keyboard-open from the
      // emulated visualViewport; clear it so we measure the resting state.
      document.body.className = '';
      let mt = document.querySelector('meta[name="viewport"]');
      if (!mt) { mt = document.createElement('meta'); mt.name = 'viewport'; document.head.appendChild(mt); }
      mt.setAttribute('content', 'width=device-width, initial-scale=1');

      const term = document.getElementById('term');       // live .terminal-wrapper
      // PRODUCTION TOPOLOGY (templates/index.html:57-769): .deck-window is the
      // outer flex column, <main> holds the elastic workspace, and #sessionBar is
      // a SIBLING after </main> -- the dock is the shell's last flex item. The
      // keypad lives INSIDE #sessionBar immediately after the composer row, not
      // inside .workspace as the retired reserve model had it.
      const shell = document.createElement('div');
      shell.className = 'deck-window';
      shell.id = 'deckWindow';
      shell.innerHTML = `
        <main class="main-content">
          <div class="workspace" id="workspace">
            <div class="terminal-area">
              <div class="terminals-container">
                <div class="terminal-grid split-1">
                  <div class="terminal-pane" data-pane-index="0" id="pane-slot"></div>
                </div>
              </div>
            </div>
          </div>
        </main>
        <div class="session-bar" id="sessionBar">
          <div class="mobile-input-bar" id="mobileInputBar"><textarea id="mobileInput" rows="2"></textarea></div>
          ${kp}
        </div>`;
      document.body.appendChild(shell);
      // Move (not clone) so the terminal instance and its ResizeObserver survive.
      document.getElementById('pane-slot').appendChild(term);
      document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
    }, keypadMatch ? keypadMatch[0] : '<div class="mobile-keypad" id="mobileKeypad"></div>');
    await page.waitForTimeout(400);

    const geom = () => page.evaluate(() => {
      const w = document.getElementById('term').getBoundingClientRect();
      const kp = document.getElementById('mobileKeypad');
      const k = kp.getBoundingClientRect();
      const dock = document.getElementById('sessionBar').getBoundingClientRect();
      const ws = document.getElementById('workspace').getBoundingClientRect();
      return {
        rows: window.__probe.term.rows,
        wrapperH: Math.round(w.height),
        wrapperBottom: Math.round(w.bottom),
        keypadTop: Math.round(k.top),
        keypadH: kp.offsetHeight,
        keypadDisplay: getComputedStyle(kp).display,
        keypadPosition: getComputedStyle(kp).position,
        dockH: Math.round(dock.height),
        workspaceH: Math.round(ws.height),
      };
    });

    await page.evaluate(() => window.__probe.clearEmitted());
    const closed = await geom();
    // RE-TARGETED from "the keypad has a real height to reserve". Under the flow
    // model a CLOSED keypad must reserve nothing at all -- that is the whole
    // point of retiring the padding reserve -- so the floor moved to the OPEN
    // panel, asserted below once it is open.
    check('baseline: a closed keypad reserves no space (display:none, zero box)',
      closed.keypadDisplay === 'none' && closed.keypadH === 0,
      `display=${closed.keypadDisplay} keypadH=${closed.keypadH}`);

    // Open it exactly the way app.js does now: one class on the panel plus the
    // body state. No --keypad-height is published, and nothing is translated.
    await page.evaluate(() => {
      document.getElementById('mobileKeypad').classList.add('mobile-open');
      document.body.classList.add('keypad-open');
    });
    await page.waitForTimeout(400);        // observer debounce + layout settle
    const open = await geom();

    check('the open keypad is a real normal-flow box, not an overlay',
      open.keypadH > 40 && open.keypadPosition === 'static',
      `keypadH=${open.keypadH} position=${open.keypadPosition}`);

    // RE-TARGETED from "shrinks the terminal by exactly the keypad height". The
    // keypad no longer subtracts padding from the terminal; it grows the DOCK,
    // and the elastic workspace above loses exactly what the dock gained. That is
    // the same conservation law the old assertion checked, stated in the flow
    // model, and it still fails if the panel overlays instead of pushing.
    check('opening the keypad grows the dock and shrinks the workspace by the same amount',
      (open.dockH - closed.dockH) === (closed.workspaceH - open.workspaceH)
        && open.dockH > closed.dockH,
      `dock ${closed.dockH} -> ${open.dockH}, workspace `
      + `${closed.workspaceH} -> ${open.workspaceH}`);
    check('the keypad no longer overlaps the terminal (it pushes, not covers)',
      open.wrapperBottom <= open.keypadTop,
      `wrapper bottom ${open.wrapperBottom} vs keypad top ${open.keypadTop}`);
    check('the shrink reaches xterm as fewer rows', open.rows < closed.rows,
      `rows ${closed.rows} -> ${open.rows}`);

    // The point of doing it via the height chain: round 9's observer and round
    // 10's single emit already carry it to the PTY. If they did not, tmux would
    // keep painting into the old taller box — the round-10 bug all over again.
    const openEmits = await page.evaluate(() => window.__probe.resizeEmits());
    check('opening the keypad forwards the new size to the PTY exactly once',
      openEmits.length === 1 && openEmits[0].payload.rows === open.rows,
      `emits=${JSON.stringify(openEmits.map((e) => e.payload))} rows=${open.rows}`);

    // RE-TARGETED from "does not change size when the padding is applied". There
    // is no padding to apply any more, but the underlying hazard is unchanged: a
    // feedback loop where the panel's own height reacts to the layout change it
    // caused would fire forever. Measured by re-reading the OPEN panel after the
    // observer and one more settle have run -- it must be stable.
    const settled = await (async () => {
      await page.waitForTimeout(400);
      return geom();
    })();
    check('the open keypad height is stable (no observer feedback loop)',
      settled.keypadH === open.keypadH && settled.dockH === open.dockH,
      `keypad ${open.keypadH} -> ${settled.keypadH}, `
      + `dock ${open.dockH} -> ${settled.dockH}`);

    await page.evaluate(() => window.__probe.clearEmitted());
    await page.evaluate(() => {
      document.body.classList.remove('keypad-open');
      document.getElementById('mobileKeypad').classList.remove('mobile-open');
    });
    await page.waitForTimeout(400);
    const reclosed = await geom();
    check('closing the keypad restores the full frame (no phantom padding left)',
      reclosed.wrapperH === closed.wrapperH && reclosed.rows === closed.rows,
      `${JSON.stringify(closed)} -> ${JSON.stringify(reclosed)}`);
    const closeEmits = await page.evaluate(() => window.__probe.resizeEmits());
    check('closing forwards the restored size to the PTY too',
      closeEmits.length === 1 && closeEmits[0].payload.rows === closed.rows,
      `emits=${JSON.stringify(closeEmits.map((e) => e.payload))} rows=${closed.rows}`);
  }

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} redesign checks passed.`);
  if (failed.length) {
    console.error(`\nFAILED: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
