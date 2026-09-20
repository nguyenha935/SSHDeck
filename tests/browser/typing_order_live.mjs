#!/usr/bin/env node
// Live gate for input order: type at full speed through xterm into a fresh
// tmux session and compare the line the shell echoes with what was typed.
import { launch, login, connectSSH, focusTerminal } from './harness_live.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LINE = (page, sid, needle) => page.evaluate(({ s, n }) => {
    const key = (TerminalManager.sessionTerminals[s] || [])[0];
    const t = TerminalManager.terminals[key]; const buf = t.buffer.active;
    for (let i = 0; i < t.rows; i++) { const l = buf.getLine(buf.viewportY + i); const txt = l ? l.translateToString(true) : ''; if (txt.includes(n)) return txt.replace(/\s+$/, ''); }
    return null;
}, { s: sid, n: needle });
const { browser, page } = await launch({ width: 1440, height: 900 });
let sid = null, pass = 0, fail = 0;
try {
    await login(page);
    sid = await connectSSH(page);
    await focusTerminal(page, sid);
    const texts = [
        'echo ORDER-1 for i in $(seq 1 200); do echo "HIST-$i"; done; python3 /tmp/tuiprobe.py',
        'echo ORDER-2 the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuvwxyz',
        'echo ORDER-3 xin chao Cau, em go rat nhanh de kiem tra thu tu phim',
    ];
    for (const [i, text] of texts.entries()) {
        await page.keyboard.type(text, { delay: i === 0 ? 0 : 5 });
        await sleep(1500);
        const echoed = await LINE(page, sid, `ORDER-${i + 1}`);
        const ok = echoed !== null && echoed.endsWith(text);
        console.log(`${ok ? 'PASS' : 'FAIL'}  full-speed line ${i + 1} (${text.length} keys, delay ${i === 0 ? 0 : 5}ms)`);
        if (!ok) { fail++; console.log(`        typed  ${JSON.stringify(text)}\n        echoed ${JSON.stringify(echoed)}`); } else pass++;
        await page.keyboard.press('Control+U');
        await sleep(300);
    }
} catch (e) { console.log(`PROBE ERROR: ${String(e).slice(0, 300)}`); fail++; }
finally {
    if (sid) { await page.evaluate((s) => window.socket.emit('ssh_disconnect', { session_id: s }), sid); await sleep(2000); }
    console.log(`typing_order_live: ${pass} pass / ${fail} fail`);
    await browser.close();
}
