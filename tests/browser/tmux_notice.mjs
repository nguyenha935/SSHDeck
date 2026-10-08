/*
 * A host without tmux is said once, on connect (OWNER RULING 2026-10-08: the
 * server provides tmux without asking, so this is where the owner hears it).
 *
 *   §1 tmux_provisioned -> one notice naming the version and where it went;
 *   §2 tmux_unavailable unsupported -> one warning naming the host's system;
 *   §3 tmux_unavailable failed -> one warning saying the copy did not work;
 *   §4 a host that had tmux -> no tmux notice at all;
 *   §Z no page errors.
 *
 * Run: node tests/browser/tmux_notice.mjs   (from source/)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/<script src="\/static\/vendor\/socketio\/[^"]*"><\/script>/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const html = renderTemplate();
const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
            return;
        }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const STUBS = `
    const noop = () => {};
    window.__socketHandlers = {};
    window.socket = {
        connected: false,
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, emit: noop, io: { on: noop },
    };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.ModalManager = { open: noop, close: noop };
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop, jumpHosts: [] };
`;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(STUBS);
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(150);

// app.js installs its own showNotification while loading; record over it.
const connect = (id, extra) => page.evaluate(({ id, extra }) => {
    window.__notices = [];
    window.showNotification = (message, type) => window.__notices.push({ message, type });
    (window.__socketHandlers.ssh_connected || []).forEach(handler => handler({
        session_id: id, host: 'quiet.example', port: 22, username: 'alice',
        use_tmux: true, ...extra,
    }));
    return window.__notices.filter(n => /tmux/.test(n.message));
}, { id, extra });

let notices = await connect('tn-1', { tmux_provisioned: '3.8' });
check('§1 one notice', notices.length, 1);
check('§1 it is information, not a warning', notices[0]?.type, 'info');
check('§1 it names the version', /tmux 3\.8/.test(notices[0]?.message), true);
check('§1 it names where it went', notices[0]?.message.includes('~/.local/share/sshdeck/bin'), true);

notices = await connect('tn-2', { use_tmux: false,
    tmux_unavailable: { code: 'unsupported', platform: 'Darwin arm64' } });
check('§2 one warning', notices.map(n => n.type), ['warning']);
check('§2 it names the host system', notices[0]?.message.includes('(Darwin arm64)'), true);
check('§2 it says SSHDeck has no build for it', /has none for it/.test(notices[0]?.message), true);

notices = await connect('tn-3', { use_tmux: false,
    tmux_unavailable: { code: 'failed', platform: 'Linux x86_64' } });
check('§3 one warning', notices.map(n => n.type), ['warning']);
check('§3 it says the copy did not work', /could not put its own there/.test(notices[0]?.message), true);

notices = await connect('tn-4', {});
check('§4 a host that had tmux says nothing about it', notices.length, 0);

check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`\ntmux_notice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
