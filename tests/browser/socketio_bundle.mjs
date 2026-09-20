#!/usr/bin/env node
/*
 * THE SHIPPED SOCKET.IO BUNDLE, RUN AND ATTACKED.
 *
 * static/vendor/socketio/socket.io.min.js is the file every browser executes,
 * and it is the ONE vendored asset this project builds rather than copies.
 * The reason is CVE-2026-69185 (GHSA-2m8v-j782-fhvr, high): socket.io-parser
 * below 4.2.7 lets a BINARY_EVENT packet declare an attachment count it never
 * has to deliver, so the decoder builds a BinaryReconstructor that never
 * completes and every such packet leaves one behind.
 *
 * Upstream's prebuilt `socket.io-client/dist/socket.io.min.js` inlines a
 * parser older than 4.2.6 -- older than the advisory's own floor, with no
 * `maxAttachments` bound at all -- and `npm audit fix` cannot change a file
 * that ships already built: measured, the parser went to 4.2.7 and that
 * file's sha256 did not move. So scripts/vendor.js builds the bundle from the
 * resolved sources instead.
 *
 * Reading the minified source is not proof that the product is safe. This
 * suite loads the real file in a real browser and drives the decoder the
 * bundle actually carries:
 *
 *   §1 the bundle still works at all -- `io` is callable and carries the
 *      constructors the page uses;
 *   §2 the zero-attachment packet, the attack itself, is REJECTED;
 *   §3 the count is bounded, so a huge declared count is refused too;
 *   §4 an ordinary packet still decodes -- the fix did not break the product.
 *
 * Run: node tests/browser/socketio_bundle.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(ROOT, 'static/vendor/socketio/socket.io.min.js');
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        ${detail}`); }
};

const bundle = fs.readFileSync(BUNDLE);
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        if (req.url.startsWith('/socket.io.min.js')) {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            res.end(bundle);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<body><script src="/socket.io.min.js"></script></body>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(base, { waitUntil: 'load' });

/* --------------------------------------------------- §1 it still works */
const shape = await page.evaluate(() => ({
    io: typeof window.io,
    manager: typeof window.io?.Manager,
    socket: typeof window.io?.Socket,
    connect: typeof window.io?.connect,
    protocol: window.io?.protocol,
}));
check('§1 the page gets a callable `io` global', shape.io === 'function',
    JSON.stringify(shape));
check('§1 it carries Manager, Socket and connect',
    shape.manager === 'function' && shape.socket === 'function'
    && shape.connect === 'function', JSON.stringify(shape));

/*
 * The decoder the bundle actually carries. A Manager owns one; constructing it
 * with autoConnect off opens no socket and touches no network.
 */
const decode = await page.evaluate(() => {
    const manager = new window.io.Manager('http://127.0.0.1:1', { autoConnect: false });
    const decoder = manager.decoder;
    const feed = (packet) => {
        const seen = [];
        const onDecoded = (p) => seen.push(p);
        decoder.on('decoded', onDecoded);
        let threw = null;
        try { decoder.add(packet); } catch (e) { threw = String(e.message || e); }
        decoder.off('decoded', onDecoded);
        try { decoder.destroy(); } catch { /* older shapes have no destroy */ }
        return { threw, decoded: seen.length };
    };
    return {
        hasDecoder: !!decoder,
        // 5 = BINARY_EVENT, "0-" = zero attachments. THE ATTACK.
        zero: feed('50-["hack"]'),
        // A count nothing could ever deliver.
        huge: feed('5999999999-["hack"]'),
        // An ordinary EVENT, which must still work.
        normal: feed('2["hello",{"a":1}]'),
    };
});

check('§1 the Manager exposes the decoder under test', decode.hasDecoder === true,
    JSON.stringify(decode));

/* ------------------------------------------- §2 the attack is rejected */
check('§2 a BINARY_EVENT declaring ZERO attachments is refused',
    decode.zero.threw !== null && decode.zero.decoded === 0,
    JSON.stringify(decode.zero));
check('§2 and it is refused as "Illegal attachments", not some later error',
    /Illegal attachments/.test(decode.zero.threw || ''),
    JSON.stringify(decode.zero));

/* ---------------------------------------------- §3 the count is bounded */
check('§3 an absurd attachment count is refused as well',
    decode.huge.threw !== null && decode.huge.decoded === 0,
    JSON.stringify(decode.huge));

/* --------------------------------------- §4 the product still functions */
check('§4 an ordinary event still decodes',
    decode.normal.threw === null && decode.normal.decoded === 1,
    JSON.stringify(decode.normal));

/* ------------------------------- §5 the build, not the copy, is shipped */
const text = bundle.toString('utf8');
check('§5 the shipped bundle carries the bounded-attachment guard',
    text.includes('maxAttachments') && /c<1|<1\)/.test(text),
    'no maxAttachments in the bundle: the prebuilt copy came back');
check('§5 and it installs the global the page loads it for',
    text.includes('window.io'), 'window.io is not assigned');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('§5 package.json holds socket.io-parser at or above the fixed version',
    (pkg.overrides || {})['socket.io-parser'] === '>=4.2.7',
    JSON.stringify(pkg.overrides));

check('§6 no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(`socketio_bundle: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
