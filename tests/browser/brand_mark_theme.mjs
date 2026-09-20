#!/usr/bin/env node
/*
 * THE MARK IS INK, AND THE THEME DECIDES WHICH INK.
 *
 * The owner delivered the mark twice, pearl black and pearl white, "cho 2 giao
 * diện sáng và tối". Shipping two images and swapping them in JavaScript would
 * mean ten themes deciding between two files at runtime; instead the artwork is
 * an inline symbol painted entirely with currentColor, and `color: var(--tw-text)`
 * hands it the theme's own ink. One asset, ten themes, no script.
 *
 * That is only true if it is MEASURED, because two things could quietly break
 * it. A `fill` or `stroke` reintroduced into the symbol would freeze the mark
 * to one colour. And the mark's cut-out routes are drawn with a <mask> whose
 * content is referenced by <use>: a browser resolves url(#id) inside externally
 * referenced content against the HOST document, so the same artwork moved into
 * icons.svg renders as a SOLID square -- no routes -- in WebKit. This suite
 * therefore reads real pixels, in both engines:
 *
 *   §1 the plate (the mark's own body) follows --tw-text: dark on the one light
 *      theme, light on the nine dark ones;
 *   §2 the cut-out routes are actually cut -- pixels inside the mark match the
 *      band behind it, which is what fails if the mask is not resolved;
 *   §3 both engines agree, so WebKit is not quietly rendering a blank square.
 *
 * Run: node tests/browser/brand_mark_theme.mjs   (from source/)
 */
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

function render(theme) {
    let html = fs.readFileSync(path.join(ROOT, 'templates/login.html'), 'utf8');
    html = html.replace(/\{%\s*include\s*'([^']+)'\s*%\}/g,
        (_, f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8'));
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'x');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const rel = decodeURIComponent(url.pathname);
        if (rel === '/') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(render(url.searchParams.get('theme') || 'glass'));
            return;
        }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

/* A minimal PNG reader: enough to walk the pixels of a Playwright screenshot
 * without adding a dependency. Screenshots are 8-bit and non-interlaced, but
 * NOT the same colour type in both engines --: WebKit
 * writes RGBA (type 6) and Chromium writes RGB (type 2). Assuming four bytes
 * per pixel read Chromium's image three-quarters shifted, which is why an
 * earlier version of this suite reported a black mark on every theme. */
function readPng(buffer) {
    let pos = 8, width = 0, height = 0, colourType = 6;
    const idat = [];
    while (pos < buffer.length) {
        const len = buffer.readUInt32BE(pos);
        const type = buffer.toString('ascii', pos + 4, pos + 8);
        const data = buffer.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            colourType = data[9];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (colourType !== 2 && colourType !== 6) {
        throw new Error(`unsupported PNG colour type ${colourType}`);
    }
    const bpp = colourType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i],
                c = i >= bpp ? prev[i - bpp] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 0xff;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { width, height, stride, bpp, data: out };
}
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/* The themes at both extremes: `paper` is the only light one, `glass` is the
 * default dark. If the ink follows for these two it follows for the rest,
 * which theme_bridge_tokens already walks token by token. */
const CASES = [
    { theme: 'paper', light: true },
    { theme: 'glass', light: false },
];

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    for (const { theme, light } of CASES) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'load' });
        await page.waitForTimeout(250);

        const shot = await page.locator('.a5-logo').screenshot();
        const png = readPng(shot);
        const at = (x, y) => {
            const i = y * png.stride + x * png.bpp;
            return [png.data[i], png.data[i + 1], png.data[i + 2]];
        };
        /*
         * The plate is the MAJORITY of the artwork, so it is measured as the
         * median over the whole box rather than at one point: a single sample
         * can land in a cut-out route, which is by construction the opposite
         * ink (measured -- an 8%-height sample read the route, not the plate).
         */
        const mid = Math.floor(png.width / 2);
        const all = [];
        for (let y = 1; y < png.height - 1; y++) {
            for (let x = 1; x < png.width - 1; x++) all.push(luma(...at(x, y)));
        }
        all.sort((a, b) => a - b);
        const plate = all[Math.floor(all.length / 2)];

        console.log(`      [${engineName}/${theme}] box=${png.width}x${png.height} `
            + `median=${plate.toFixed(3)} min=${all[0].toFixed(3)} `
            + `max=${all[all.length - 1].toFixed(3)} `
            + `light%=${(all.filter(v => v > 0.5).length / all.length * 100).toFixed(1)}`);
        check(`§1 ${engineName}/${theme}: the mark is painted in the theme's ink`,
            light ? plate < 0.5 : plate > 0.5, true);

        // §2 the routes: scan the middle band of the mark and demand BOTH inks.
        // A mask that failed to resolve paints one solid colour and fails here.
        let lightPx = 0, darkPx = 0;
        for (let x = 2; x < png.width - 2; x++) {
            const l = luma(...at(x, mid));
            if (l > 0.5) lightPx++; else darkPx++;
        }
        check(`§2 ${engineName}/${theme}: the cut-out routes are really cut`,
            lightPx > 2 && darkPx > 2, true);
        check(`§3 ${engineName}/${theme}: no page errors`, errors, []);
        await page.close();
    }
    await browser.close();
}

server.close();
console.log(`brand_mark_theme: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
