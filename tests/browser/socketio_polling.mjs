/* Real browser bundle, real HTTP polling. Python Engine.IO drops an entire
 * POST above 16 packets and still returns 200. A slow first POST must not
 * lose startup requests (including get_notepad and view_attach).
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const bundle = fs.readFileSync(path.join(root, 'static/vendor/socketio/socket.io.min.js'));
let pass = 0, fail = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${detail}`);
    ok ? pass++ : fail++;
}
let pending, queue = [], received = [], batches = [];
let inflight = 0, maxInflight = 0;
function send(packet) {
    queue.push(packet);
    if (pending) {
        pending.end(queue.join('\x1e'));
        pending = null;
        queue = [];
    }
}
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/socket.io.min.js')) {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle);
        return;
    }
    if (!req.url.startsWith('/socket.io/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<script src="/socket.io.min.js"></script>');
        return;
    }
    res.setHeader('Content-Type', 'text/plain');
    if (req.method === 'POST') {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const packets = body.split('\x1e');
            batches.push(packets.length);
            // Match python-engineio's rejection semantics: none delivered,
            // HTTP 200 nonetheless. Do not make the fixture silently accept it.
            if (packets.length <= 16) {
                for (const packet of packets) {
                    if (packet === '40') send('40{"sid":"fixture"}');
                    else received.push(packet);
                }
            }
            setTimeout(() => { inflight--; res.end('ok'); }, 100);
        });
        return;
    }
    if (!new URL(req.url, 'http://fixture').searchParams.has('sid')) {
        res.end('0' + JSON.stringify({sid: 'fixture', upgrades: [],
            pingInterval: 25000, pingTimeout: 20000, maxPayload: 115343360}));
    } else if (queue.length) {
        res.end(queue.join('\x1e'));
        queue = [];
    } else pending = res;
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
        window.testSocket = io({ transports: ['polling'], upgrade: false });
        testSocket.on('connect', () => {
            // A restored workspace queues these while the handshake POST is
            // still outstanding. This is the startup burst seen with 3 panes.
            for (let i = 0; i < 40; i++) testSocket.emit('probe', i);
            testSocket.emit('get_notepad');
            testSocket.emit('view_attach', {session_id: 'test'});
            testSocket.emit('binary', new Uint8Array([0, 30, 255]).buffer);
        });
    });
    const deadline = Date.now() + 2500;
    while (received.length < 44 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    check('no POST exceeds Python Engine.IO packet limit',
        batches.every(n => n <= 16), JSON.stringify(batches));
    const expected = [
        ...Array.from({length: 40}, (_, i) => '42' + JSON.stringify(['probe', i])),
        '42["get_notepad"]',
        '42["view_attach",{"session_id":"test"}]',
        '451-["binary",{"_placeholder":true,"num":0}]',
        'bAB7/',
    ];
    check('all startup and binary packets arrive exactly once and in order',
        JSON.stringify(received) === JSON.stringify(expected),
        `received=${received.length}`);
    check('POSTs never overlap', maxInflight === 1, String(maxInflight));
    check('no browser errors', errors.length === 0, errors.join('; '));
    await page.evaluate(() => testSocket.disconnect());
} finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
}
console.log(`socketio_polling: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
