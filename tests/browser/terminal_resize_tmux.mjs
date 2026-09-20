// End-to-end proof that the browser terminal and the remote tmux stay the same
// size — the round-10 fix — against a REAL tmux 3.4 on a REAL PTY.
//
// Why this file exists rather than another mock: the reported bugs were "entering
// scroll mode shrinks the terminal to the top" and "the exit-scroll button lands
// on the orange status line". Neither is visible in a mocked terminal, because
// both are just tmux painting its whole screen into a box of the wrong height.
// Only a real tmux, whose PTY size changes exactly when the app says so, shows
// the difference.
//
// Topology (tmux_pty_bridge.py is the server stand-in):
//
//   tmux 3.4 on a PTY <-- TIOCSWINSZ ---.
//        |  PTY bytes                    \  SIZE rows cols     (== ssh_resize)
//        v                                \
//   bridge  <--- TCP ---> this test  ---> xterm 5.3.0 (the vendored build,
//                                          driven through the real
//                                          terminal-manager.js in fixture.html)
//
// The test relays in both directions: PTY output -> terminal.write, and the
// app's own ssh_resize emits -> TIOCSWINSZ. Nothing about the sizing is faked;
// window.socket.emit in the fixture is the only stub, and it is what production
// calls too.
//
// The four assertions mirror the user's report:
//   1. after the pane grows and the app re-fits, tmux's window follows;
//   2. tmux's status line is painted on the LAST row, with no dead band below it;
//   3. that still holds after entering copy-mode (scroll mode) — the "frame
//      shrank to the top" symptom;
//   4. after the exit-scroll button's `copy-mode -q`, the bottom row is the
//      status line and the shell prompt is back in the pane body — not the
//      "jumped onto the orange line" symptom.
//
// Run: node tests/browser/terminal_resize_tmux.mjs   (needs tmux on PATH)
// Exit 0 = all passed.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..', '..');
const SOCK = `sshdeck_r10_${process.pid}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const fp = path.join(sourceRoot, rel);
    if (!fp.startsWith(sourceRoot) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ' -- ' + (detail || '')}`);
}

const tmux = (...args) => {
  try {
    return execFileSync('tmux', ['-L', SOCK, ...args], { encoding: 'utf8' });
  } catch (e) {
    return `ERR:${e.stderr || e.message}`;
  }
};

// tmux's own view of the pane, straight from the server — the ground truth the
// browser side is being compared against.
function tmuxState() {
  const out = tmux('display-message', '-p', '-t', '=probe:',
    '#{window_width}x#{window_height} mode=#{pane_in_mode}').trim();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer();
  const { port: httpPort } = server.address();

  // Pick a free TCP port for the bridge.
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const bridgePort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const START_ROWS = 25, START_COLS = 44;
  const bridge = spawn('python3',
    [path.join(__dirname, 'tmux_pty_bridge.py'), SOCK, String(bridgePort), String(START_ROWS), String(START_COLS)],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    bridge.stdout.on('data', (b) => { if (b.toString().includes('READY')) resolve(); });
    bridge.on('exit', (c) => reject(new Error(`bridge exited early (${c})`)));
    setTimeout(() => reject(new Error('bridge did not become ready')), 10000);
  });

  const sock = net.connect(bridgePort, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));

  const browser = await chromium.launch();
  const context = await browser.newContext({ hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${httpPort}/tests/browser/fixture.html`);
  await page.waitForFunction('window.__ready === true', { timeout: 15000 });

  // The fixture writes 200 filler lines for the other suites; clear them so the
  // only thing on screen is what tmux paints.
  await page.evaluate(() => { window.__probe.term.reset(); window.__probe.clearEmitted(); });

  // Size the wrapper so the app's own fit lands on the PTY's starting geometry,
  // then let the real fit path (ResizeObserver -> fitTerminal -> onResize) run.
  // From here on nothing sets rows/cols by hand: every size change goes through
  // the shipped code.
  // Size the PANE, not the wrapper: the wrapper is width/height:100% exactly as
  // style.css declares it, so its box is percentage-derived from the pane just
  // like in the app. Setting inline pixels on the wrapper would replace that
  // topology with a fixed-size one and stop exercising the real fit maths.
  await page.evaluate(() => {
    const el = document.getElementById('pane');
    el.style.width = '520px';
    el.style.height = '430px';
  });
  await sleep(400);

  // PTY -> terminal, exactly like the ssh_output handler.
  let buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.startsWith('OUT ')) continue;
      const hex = line.slice(4);
      page.evaluate((h) => {
        const bytes = new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
        window.__probe.term.write(bytes);
      }, hex).catch(() => {});
    }
  });

  // The app's ssh_resize -> the PTY, exactly like ssh_manager.resize_terminal.
  // Polled rather than hooked so the emit path under test is the untouched one.
  let lastForwarded = '';
  const relayResizes = async () => {
    const emits = await page.evaluate(() => {
      const list = window.__probe.resizeEmits();
      window.__probe.clearEmitted();
      return list.map((e) => e.payload);
    }).catch(() => []);
    for (const p of emits) {
      lastForwarded = `${p.cols}x${p.rows}`;
      sock.write(`SIZE ${p.rows} ${p.cols}\n`);
    }
    return emits;
  };
  const relayTimer = setInterval(relayResizes, 60);

  // Align the PTY with whatever the first real fit produced, then give tmux a
  // moment to paint its first full screen.
  await relayResizes();
  await sleep(900);
  sock.write(`IN ${Buffer.from('clear\r').toString('hex')}\n`);
  await sleep(700);

  // Read the rendered screen out of the xterm buffer: the row index of tmux's
  // status line (it contains "[probe]") and the last row with any content.
  const screen = () => page.evaluate(() => {
    const t = window.__probe.term;
    const buf = t.buffer.active;
    const rows = [];
    for (let y = 0; y < t.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      rows.push(line ? line.translateToString(true) : '');
    }
    let statusRow = -1, lastPainted = -1;
    rows.forEach((text, i) => {
      if (text.includes('[probe]')) statusRow = i + 1;
      if (text.trim().length) lastPainted = i + 1;
    });
    return { rows: t.rows, cols: t.cols, statusRow, lastPainted, body: rows };
  });

  const before = await screen();
  check('baseline: tmux paints its status line on the terminal\'s last row',
    before.statusRow === before.rows,
    `status at ${before.statusRow} of ${before.rows}`);

  // ---- 1. the pane grows (soft keyboard closing) ----------------------------
  // The ONLY thing done here is changing the wrapper's height, i.e. what the
  // keyboard hiding does. Everything after that is the app's own code path.
  await page.evaluate(() => { document.getElementById('pane').style.height = '700px'; });
  await sleep(400);
  await relayResizes();
  await sleep(900);

  const grown = await screen();
  const tmuxAfterGrow = tmuxState();
  check('growing the pane forwards the new size to the remote PTY',
    tmuxAfterGrow.startsWith(`${grown.cols}x${grown.rows - 1}`),
    `xterm ${grown.cols}x${grown.rows} vs tmux ${tmuxAfterGrow} (window is 1 row short of the client: the status line)`);
  check('no dead band: tmux still paints down to the last row',
    grown.statusRow === grown.rows && grown.lastPainted === grown.rows,
    `status ${grown.statusRow}, last painted ${grown.lastPainted}, of ${grown.rows}`);

  // ---- 2. enter copy-mode (what a touch swipe does) ------------------------
  // A swipe's wheel event reaches tmux as WheelUpPane, which is `copy-mode -e`.
  // This is the state the user described as "the frame shrank to the top".
  tmux('copy-mode', '-e', '-t', '=probe:');
  await sleep(700);
  const inCopy = await screen();
  check('in scroll mode the frame still fills the pane (status on the last row)',
    inCopy.statusRow === inCopy.rows,
    `status at ${inCopy.statusRow} of ${inCopy.rows}; tmux ${tmuxState()}`);

  // ---- 3. the exit-scroll button -------------------------------------------
  // exit_tmux_copy_mode's second step, the part that clears the pane mode.
  tmux('copy-mode', '-q', '-t', '=probe:');
  await sleep(700);
  const exited = await screen();
  const tmuxAfterExit = tmuxState();
  check('the exit-scroll button leaves scroll mode', tmuxAfterExit.includes('mode=0'),
    `tmux ${tmuxAfterExit}`);
  check('after exiting, the bottom row is the status line and the prompt is in the body',
    exited.statusRow === exited.rows
      && exited.body.slice(0, exited.rows - 1).some((r) => r.includes('$') || r.includes('#')),
    `status at ${exited.statusRow} of ${exited.rows}`);

  check('no page errors throughout', pageErrors.length === 0, pageErrors.join('; '));
  check('the size actually travelled (a resize was forwarded at least once)',
    lastForwarded !== '', `last forwarded ${lastForwarded || '(none)'}`);

  clearInterval(relayTimer);
  sock.write('QUIT\n');
  sock.end();
  await browser.close();
  server.close();
  bridge.kill('SIGTERM');
  tmux('kill-server');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tmux resize checks passed.`);
  if (failed.length) {
    console.error(`\nFAILED: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  try { execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch {}
  process.exit(1);
});
