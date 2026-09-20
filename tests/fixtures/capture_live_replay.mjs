#!/usr/bin/env node
/*
 * Re-capture `live_replay_chunk.txt`: the verbatim bytes ONE real live restore
 * delivers, read off the websocket.
 *
 * `tests/browser/s16_d4_replay_boundary.mjs` §R1 replays these bytes into the
 * engine -- the owner's own case, which must never be a synthetic stand-in.
 * The original capture lived in /tmp and was lost with a reboot, so the gate
 * had been red on a missing file; it is a repo fixture now and this is how it
 * is made again.
 *
 * Run it where the live gates run: it needs `tests/live.env` (see
 * `tests/live.env.example`) and the host named there must be reachable.
 *     node tests/fixtures/capture_live_replay.mjs
 */
import { launch, login, connectSSH, focusTerminal } from '../browser/harness_live.mjs';
import fs from 'node:fs';
const OUT = new URL('live_replay_chunk.txt', import.meta.url).pathname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { browser, page } = await launch({ width: 1440, height: 900 });
let sid = null, name = null;
try {
    await login(page);
    // The target is SSH_HOST from tests/live.env; nothing is pinned here.
    sid = await connectSSH(page);
    name = await page.evaluate((s) => SessionManager.sessions[s].tmuxSessionName, sid);
    await page.evaluate((s) => window.socket.emit('ssh_input', { session_id: s,
        // The replay is the history ABOVE the screen (`-E -1`), so the tail
        // must be padded or CAPLINE-400 never leaves the visible rows.
        data: 'clear; for i in $(seq 1 400); do echo "CAPLINE-$i"; done; for i in $(seq 1 80); do echo "PAD-$i"; done\r' }), sid);
    await sleep(6000);
    // Off the websocket, exactly as the original capture was taken.
    const chunks = [];
    page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        const at = text.indexOf('["ssh_replay_chunk",');
        if (at === -1) return;
        try {
            const [, body] = JSON.parse(text.slice(at));
            if (body && body.session_id === sid && typeof body.data === 'string') {
                chunks.push({ seq: body.seq, data: body.data, total: body.total, truncated: body.truncated });
            }
        } catch { /* a frame that is not this event */ }
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof SessionManager !== 'undefined' && SessionManager.initialized, null, { timeout: 30000 });
    await page.waitForFunction((s) => !!(SessionManager.sessions[s] && SessionManager.sessions[s].connected), sid, { timeout: 30000 });
    await sleep(6000);
    chunks.sort((a, b) => a.seq - b.seq);
    const data = chunks.map(c => c.data).join('');
    const lines = data.split('\r\n').filter(Boolean);
    console.log(`chunks=${chunks.length} truncated=${chunks.some(c => c.truncated)} bytes=${Buffer.byteLength(data)} lines=${lines.length}`);
    console.log(`has CAPLINE-356=${data.includes('CAPLINE-356')} CAPLINE-400=${data.includes('CAPLINE-400')} escapes=${data.includes('\x1b')}`);
    if (!data.includes('CAPLINE-356') || !data.includes('CAPLINE-400')) throw new Error('capture lacks the marker lines');
    fs.writeFileSync(OUT, data);
    console.log(`written ${OUT}`);
} catch (e) { console.log('ERR ' + String(e).slice(0, 300)); }
finally {
    try { if (sid) { await focusTerminal(page, sid); await page.evaluate((s) => window.socket.emit('ssh_disconnect', { session_id: s }), sid); await sleep(3000); } } catch {}
    if (name) { const { execSync } = await import('node:child_process'); try { execSync(`tmux kill-session -t '=${name}' 2>/dev/null || true`); } catch {} }
    await browser.close();
}
