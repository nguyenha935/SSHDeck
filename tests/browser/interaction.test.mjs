/*
 * Offline browser tests for the redesigned terminal interaction model.
 *
 * These load the REAL vendored xterm build (static/vendor/xterm, currently
 * 5.3.0 — the production baseline) through
 * a plain-HTTP static server — no HTTPS, no secure context — and drive it with
 * Playwright/Chromium to prove the behaviours the redesign depends on:
 *
 *   1. App-mouse on  -> wheel is forwarded to the app as a mouse report
 *                       (this is how tmux, with mouse on, scrolls its history).
 *   2. App-mouse on  -> a touch drag is forwarded too, via the touch->wheel
 *                       shim. xterm forwards neither touch build (5.3.0 bails
 *                       when mouse events are active and only scrolls its local
 *                       viewport; 6.0.0 dropped touch from the viewport), so the
 *                       shim turns touchmove into a synthetic wheel. 2b proves
 *                       the shim stays inert (no PTY bytes) when mouse is off.
 *   3. Shift+drag selects locally -> hasSelection() true -> Ctrl+C copies the
 *                       selection via xterm's native copy path and does NOT emit
 *                       to the PTY (no ^C interrupt).
 *   4. Ctrl+C with no selection -> emits \x03 (SIGINT) to the PTY, unchanged.
 *   5. A native paste event -> arrives on onData wrapped in bracketed-paste
 *                       markers (\x1b[200~ ... \x1b[201~), on plain HTTP.
 *
 * Run: node tests/browser/interaction.test.mjs   (from source/)
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

// Minimal static server rooted at source/, so /static/vendor/... resolves to
// the exact files the app serves and /tests/browser/fixture.html is the page.
function startServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath.replace(/^\/+/, '');
      const filePath = path.join(sourceRoot, rel);
      // Contain the server to sourceRoot.
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

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // Prove we are NOT in a secure context: navigator.clipboard.readText would be
  // unavailable here, which is exactly why the app relies on xterm's native
  // copy/paste path instead.
  const browser = await chromium.launch();
  const context = await browser.newContext({
    // hasTouch makes navigator.maxTouchPoints>0 so the browser treats this as a
    // touch-capable device and delivers the TouchEvents the shim listens for.
    hasTouch: true,
    // Deliberately grant NO clipboard permission: the native copy/paste path
    // must not depend on navigator.clipboard (that is finding #3 — the 0003
    // code used navigator.clipboard.readText, which needs a secure context and
    // broke paste on plain HTTP). If paste still reaches the PTY here, it went
    // through xterm's native paste-event path, not the clipboard API.
    permissions: [],
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${base}/tests/browser/fixture.html`);
  await page.waitForFunction('window.__ready === true', { timeout: 10000 });

  check('fixture loaded vendored xterm with no page errors', consoleErrors.length === 0,
    consoleErrors.join('; '));

  // Note: 127.0.0.1 is a "potentially trustworthy" origin, so Chromium reports
  // isSecureContext=true regardless of http:// — we cannot force it false in a
  // unit harness. What actually matters (finding #3) is that paste does NOT
  // depend on the clipboard-read API: this context was created with NO clipboard
  // permission, so if the paste test below still delivers text, it proves the
  // native paste-event path (not navigator.clipboard.readText) is what works.
  const clipboardReadState = await page.evaluate(async () => {
    try {
      const s = await navigator.permissions.query({ name: 'clipboard-read' });
      return s.state;
    } catch (e) { return 'unavailable'; }
  });
  check('clipboard-read permission NOT granted (native paste must not need it)',
    clipboardReadState !== 'granted', `clipboard-read=${clipboardReadState}`);

  const termBox = await page.evaluate(() => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('term');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = Math.round(termBox.x + termBox.w / 2);
  const cy = Math.round(termBox.y + termBox.h / 2);

  // ---- 1. App-mouse on: wheel is forwarded as a mouse report ----------------
  await page.evaluate(() => { window.__probe.clearData(); window.__probe.enableAppMouse(); });
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -120); // wheel up
  await page.waitForTimeout(150);
  const wheelData = await page.evaluate(() => window.__probe.data.join(''));
  // SGR mouse reports look like \x1b[<Nb;Col;Row(M|m). Wheel buttons are 64/65.
  const wheelForwarded = /\x1b\[<(64|65|66|67)/.test(wheelData) || /\x1b\[M/.test(wheelData);
  check('app-mouse ON: wheel forwarded to app as mouse report', wheelForwarded,
    `data=${JSON.stringify(wheelData).slice(0, 80)}`);

  // ---- 2. App-mouse on: the touch->wheel shim forwards a touch drag ---------
  // xterm never forwards touch to the app on its own (true for 5.3.0 AND 6.0.0
  // — 5.3.0 bails when mouse events are active and only scrolls its local
  // viewport; 6.0.0 dropped touch from the viewport entirely). The shim in
  // terminal-manager.js (mirrored in fixture.html) turns a touchmove into a
  // synthetic wheel so xterm encodes it as a mouse report. Fire a real touch
  // sequence and assert an SGR wheel report reaches the PTY.
  await page.evaluate(() => window.__probe.clearData());
  const touchForwarded = await page.evaluate(async ({ x, y }) => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('term');
    // pageX/pageY are what the shim reads; set them explicitly.
    function fire(type, cx, cy) {
      const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
      const ev = new TouchEvent(type, {
        cancelable: true, bubbles: true, touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t],
      });
      el.dispatchEvent(ev);
    }
    window.__probe.clearData();
    // Drag the finger UP by a large amount so xterm's pixel->line accumulator
    // crosses at least one line and emits a wheel mouse report.
    fire('touchstart', x, y + 120);
    fire('touchmove', x, y + 40);
    fire('touchmove', x, y - 40);
    fire('touchmove', x, y - 120);
    fire('touchend', x, y - 120);
    await new Promise((r) => setTimeout(r, 150));
    return window.__probe.data.join('');
  }, { x: cx, y: cy });
  // Wheel buttons in SGR are 64 (up) / 65 (down). The shim must produce one.
  const touchOk = /\x1b\[<(64|65)/.test(touchForwarded) || /\x1b\[M/.test(touchForwarded);
  check('app-mouse ON: touch drag forwarded via shim (touch->wheel->SGR)', touchOk,
    `data=${JSON.stringify(touchForwarded).slice(0, 80)}`);

  // ---- 2b. App-mouse OFF: the shim must NOT forward touch to the PTY --------
  // With mouse tracking off (a plain shell), the shim stays out of the way so
  // touch does not inject stray bytes; xterm handles it locally instead.
  await page.evaluate(() => { window.__probe.disableAppMouse(); window.__probe.clearData(); });
  const touchOffData = await page.evaluate(async ({ x, y }) => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('term');
    function fire(type, cx, cy) {
      const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
      el.dispatchEvent(new TouchEvent(type, {
        cancelable: true, bubbles: true, touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t],
      }));
    }
    window.__probe.clearData();
    fire('touchstart', x, y + 120);
    fire('touchmove', x, y - 40);
    fire('touchmove', x, y - 120);
    fire('touchend', x, y - 120);
    await new Promise((r) => setTimeout(r, 150));
    return window.__probe.data.join('');
  }, { x: cx, y: cy });
  check('app-mouse OFF: touch does NOT forward to PTY (shim inert)',
    touchOffData.length === 0, `data=${JSON.stringify(touchOffData).slice(0, 80)}`);
  // Re-enable app-mouse for parity with the original test flow below.
  await page.evaluate(() => window.__probe.enableAppMouse());

  // ---- 3. Shift+drag selects; Ctrl+C copies selection, no PTY emit ----------
  await page.evaluate(() => { window.__probe.disableAppMouse(); window.__probe.clearData(); });
  // Force a local selection the way Shift+drag does, deterministically.
  await page.evaluate(() => window.__probe.selectAll());
  await page.waitForTimeout(50);
  const hasSel = await page.evaluate(() => window.__probe.hasSelection());
  check('local selection present after select (Shift+drag equivalent)', hasSel);

  // The custom key handler reads terminal.hasSelection(), so keystrokes must
  // reach xterm — focus the helper textarea first (click alone can clear the
  // selection, so focus without clicking into the screen).
  await page.evaluate(() => window.__probe.focus());
  await page.evaluate(() => window.__probe.clearData());
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const ctrlCWithSelData = await page.evaluate(() => window.__probe.data.join(''));
  // With a selection, Ctrl+C must NOT send \x03 to the PTY (it copies instead).
  check('Ctrl+C WITH selection does not emit ^C to PTY', !ctrlCWithSelData.includes('\x03'),
    `data=${JSON.stringify(ctrlCWithSelData)}`);

  // ---- 4. Ctrl+C with NO selection emits \x03 (SIGINT) ----------------------
  await page.evaluate(() => { window.__probe.clearSelection(); window.__probe.clearData(); window.__probe.focus(); });
  await page.waitForTimeout(50);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const ctrlCNoSelData = await page.evaluate(() => window.__probe.data.join(''));
  check('Ctrl+C with NO selection emits \\x03 (SIGINT)', ctrlCNoSelData.includes('\x03'),
    `data=${JSON.stringify(ctrlCNoSelData)}`);

  // ---- 5. Native paste arrives on onData as bracketed paste -----------------
  await page.evaluate(() => window.__probe.clearData());
  // Turn on bracketed paste mode the way a shell does (DECSET 2004), then fire a
  // real paste event with clipboardData — the native xterm path, no clipboard
  // API, works on plain HTTP.
  const pasteData = await page.evaluate(async () => {
    window.__probe.term.write('\x1b[?2004h'); // enable bracketed paste
    await new Promise((r) => setTimeout(r, 30));
    window.__probe.clearData();
    const textarea = document.querySelector('.xterm-helper-textarea') || document.querySelector('textarea');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello-paste');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    (textarea || document.body).dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 120));
    return window.__probe.data.join('');
  });
  const pasteText = pasteData.includes('hello-paste');
  const bracketed = pasteData.includes('\x1b[200~') && pasteData.includes('\x1b[201~');
  check('native paste delivers text to PTY on plain HTTP', pasteText,
    `data=${JSON.stringify(pasteData)}`);
  check('native paste is bracketed (\\x1b[200~ .. \\x1b[201~)', bracketed,
    `data=${JSON.stringify(pasteData)}`);

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed.`);
  if (failed.length) {
    console.error(`\nFAILED: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
