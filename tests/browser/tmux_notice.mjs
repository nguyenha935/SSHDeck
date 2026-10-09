/*
 * A host without tmux is said once, on connect (OWNER RULING 2026-10-08: the
 * server provides tmux without asking, so this is where the owner hears it).
 *
 *   §1 tmux_provisioned -> one notice naming the version and where it went;
 *   §2 tmux_unavailable unsupported -> one warning naming the host's system;
 *   §3 tmux_unavailable failed -> one warning saying the copy did not work;
 *   §4 a host that had tmux -> no tmux notice at all;
 *   §5 installed with the host's package manager -> the notice names it;
 *   §6 while it installs, the connect counter says so -- for its own
 *      request only;
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
    window.__emits = [];
    window.socket = {
        connected: false,
        on: (name, cb) => { (window.__socketHandlers[name] ||= []).push(cb); },
        off: noop, once: noop, io: { on: noop },
        emit: (name, payload) => window.__emits.push({ name, payload }),
    };
    Object.defineProperty(window, 'io', { get: () => () => window.socket, configurable: false });
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
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

notices = await connect('tn-5', { tmux_provisioned: '3.4', tmux_installed_with: 'apt' });
check('§5 one notice, information', notices.map(n => n.type), ['info']);
check('§5 it names the version and the package manager',
    /tmux 3\.4 with apt/.test(notices[0]?.message), true);

// §6: a real connect from the form, then the server's progress frames.
await page.evaluate(() => document.getElementById('newConnectionBtn').click());
await page.waitForTimeout(80);
await page.fill('#hostInput', 'quiet.example');
await page.fill('#usernameInput', 'alice');
await page.selectOption('#authTypeSelect', 'password');
await page.fill('#passwordInput', 'pw');
await page.click('#connectBtn');
const requestId = await page.evaluate(() =>
    window.__emits.filter(e => e.name === 'ssh_connect').pop()?.payload.client_request_id);
const progress = (id) => page.evaluate((id) => (window.__socketHandlers.ssh_connect_progress || [])
    .forEach(handler => handler({ client_request_id: id, stage: 'installing_tmux' })), id);
const counter = () => page.evaluate(() => document.getElementById('connectBtn').textContent);
await progress('someone-else');
await page.waitForTimeout(1100);
check('§6 another request\'s progress leaves the counter alone',
    /^Connecting\.\.\. \d+s$/.test(await counter()), true);
await progress(requestId);
await page.waitForTimeout(1100);
check('§6 its own progress names the step', /^Installing tmux\.\.\. \d+s$/.test(await counter()), true);

check('§Z no page errors', errors, []);
await browser.close();
server.close();
console.log(`\ntmux_notice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
