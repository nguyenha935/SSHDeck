#!/usr/bin/env node
/*
 * SSHDeck INSTALLS AS AN APP: Chromium's own verdict.
 *
 * tests/test_web_app_manifest.py checks the file; this asks the browser that
 * decides. Chromium's DevTools protocol reports the manifest it parsed
 * (Page.getAppManifest) and every reason it would refuse to install the page
 * (Page.getInstallabilityErrors). Both must come back clean on the workspace
 * and on the login page, mounted at "/" and under "/deck/", because the
 * manifest's URLs are relative to where it is served.
 *
 *   §1 the manifest is found and parses without errors
 *   §2 start_url and scope are the mount point
 *   §3 no installability errors
 *
 * Measured with mutations: Chromium still installs a manifest with no name
 * and with only the maskable icon, so this gate cannot see those;
 * tests/test_web_app_manifest.py pins them.
 *
 * Run: node tests/browser/web_app_install.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${b}\n        actual   ${a}`); }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.json': 'application/json',
};
function render(template, prefix) {
    let html = fs.readFileSync(path.join(ROOT, 'templates', template), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, `${prefix}static/$1`);
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, `${prefix}$1`);
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const prefix = url.startsWith('/deck/') ? '/deck/' : '/';
        const rel = url.slice(prefix.length);
        const page = { '': 'index.html', login: 'login.html' }[rel];
        if (page) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(render(page, prefix));
            return;
        }
        const fp = path.join(ROOT, rel);
        if (!rel.startsWith('static/') || !fp.startsWith(ROOT) || !fs.existsSync(fp)
                || !fs.statSync(fp).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
for (const prefix of ['/', '/deck/']) {
    for (const page of ['', 'login']) {
        const where = `${prefix}${page}`;
        const tab = await (await browser.newContext()).newPage();
        await tab.route('**/socket.io.min.js*', r =>
            r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
        await tab.goto(`${origin}${where}`, { waitUntil: 'load' });
        const cdp = await tab.context().newCDPSession(tab);
        const manifest = await cdp.send('Page.getAppManifest');
        check(`§1 [${where}] the manifest is found`,
            manifest.url.startsWith(`${origin}${prefix}static/app.webmanifest`), true);
        check(`§1 [${where}] and parses without errors`, manifest.errors, []);
        const parsed = JSON.parse(manifest.data || '{}');
        const resolve = (u) => {
            try { return new URL(u, manifest.url).href; } catch { return null; }
        };
        check(`§2 [${where}] start_url is the mount point`,
            resolve(parsed.start_url), `${origin}${prefix}`);
        check(`§2 [${where}] scope is the mount point`,
            resolve(parsed.scope), `${origin}${prefix}`);
        const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
        check(`§3 [${where}] Chromium has no reason to refuse installing it`,
            installabilityErrors.map(e => e.errorId), []);
        await tab.context().close();
    }
}
await browser.close();
server.close();
console.log(`\nweb_app_install: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
