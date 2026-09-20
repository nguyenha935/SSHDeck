/*
 * W14 item 8 — save-as-profile from the connection modal.
 *
 * The connection modal gains a #saveProfileCheck checkbox (default OFF) plus a
 * profile-name input. Only a SUCCESSFUL connect submitted with the box checked
 * turns the form into a profile, through ProfileManager.saveProfile — app.js
 * never emits save_profile itself. This suite pins:
 *
 *   §A the controls exist, the box defaults UNCHECKED and the name field is
 *      hidden until the box is checked;
 *   §B checking + a successful connect emits EXACTLY ONE save_profile carrying
 *      host/port/user/auth (+ post-connect mode) — and nothing before success;
 *   §C the save payload NEVER carries the password (the secret stays in the
 *      connect frame alone and dies there);
 *   §D an unchecked submit saves nothing even on success;
 *   §E a FAILED connect saves nothing — and the pending save is consumed by the
 *      failure, so a late success frame cannot resurrect it;
 *   §F the auto-launch path (launchProfileForPane -> requestSubmit) emits zero
 *      save_profile frames: a launch is never coupled to a save;
 *   §Z no page errors.
 *
 * Run: node tests/browser/save_profile_on_connect.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
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
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.json': 'application/json',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    // The real socket.io client would overwrite the stub's io factory.
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
        off: noop, once: noop,
        emit: (name, payload) => window.__emits.push({ name, payload }),
        io: { on: noop },
    };
    Object.defineProperty(window, 'io', {
        get: () => () => window.socket,
        configurable: false,
    });
    window.showNotification = noop;
    window.ModalManager = { open: (m) => m && m.classList.add('show'), close: (m) => m && m.classList.remove('show') };
    window.JumpHostManager = { getById: () => null, updatePasswordVisibility: noop, jumpHosts: [] };
`;

async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(STUBS);
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(150);
    return { ctx, page, errors };
}

const saveProfileEmits = (page) => page.evaluate(() =>
    window.__emits.filter(e => e.name === 'save_profile').map(e => e.payload));

const connectRequestIds = (page) => page.evaluate(() =>
    window.__emits.filter(e => e.name === 'ssh_connect')
        .map(e => e.payload.client_request_id));

const driveConnected = (page, extra = {}) => page.evaluate((extra) => {
    const id = window.__emits.filter(e => e.name === 'ssh_connect')
        .map(e => e.payload.client_request_id).pop();
    const handlers = window.__socketHandlers['ssh_connected'] || [];
    handlers.forEach(h => h({
        session_id: 'sp-session-1', host: 'save.example', port: 22,
        username: 'root', client_request_id: id, ...extra,
    }));
    return id;
}, extra);

const fillForm = async (page, { check } = {}) => {
    await page.evaluate(() => {
        document.getElementById('newConnectionBtn').click();
    });
    await page.waitForTimeout(80);
    await page.fill('#hostInput', 'save.example');
    await page.fill('#portInput', '22');
    await page.fill('#usernameInput', 'root');
    await page.selectOption('#authTypeSelect', 'password');
    await page.fill('#passwordInput', 'hunter2-secret');
    if (check) {
        await page.check('#saveProfileCheck');
    } else {
        await page.uncheck('#saveProfileCheck');
    }
};

// ── §A default state ────────────────────────────────────────────────────────
{
    const { ctx, page, errors } = await newPage();
    const state = await page.evaluate(() => ({
        checkExists: !!document.getElementById('saveProfileCheck'),
        checkDefault: document.getElementById('saveProfileCheck').checked,
        nameExists: !!document.getElementById('profileNameInput'),
        nameHidden: document.getElementById('profileNameGroup')
            .classList.contains('hidden'),
    }));
    check('§A the save-as-profile controls exist',
        [state.checkExists, state.nameExists], [true, true]);
    check('§A the checkbox defaults UNCHECKED', state.checkDefault, false);
    check('§A the name field starts hidden', state.nameHidden, true);

    await page.evaluate(() => document.getElementById('newConnectionBtn').click());
    await page.waitForTimeout(80);
    await page.check('#saveProfileCheck');
    check('§A checking the box reveals the name field',
        await page.evaluate(() => document.getElementById('profileNameGroup')
            .classList.contains('hidden')), false);

    // Re-open the modal: the box must be back to OFF (no stale state).
    await page.evaluate(() => {
        document.getElementById('closeConnectionModal').click();
    });
    await page.waitForTimeout(60);
    await page.evaluate(() => document.getElementById('newConnectionBtn').click());
    await page.waitForTimeout(80);
    check('§A re-opening the modal resets the box to OFF',
        await page.evaluate(() => document.getElementById('saveProfileCheck')
            .checked), false);
    check('§A no page errors (§A)', errors, []);
    await ctx.close();
}

// ── §B/§C one successful save, no secret ────────────────────────────────────
{
    const { ctx, page, errors } = await newPage();
    await fillForm(page, { check: true });
    await page.fill('#profileNameInput', 'My Saved Box');
    await page.evaluate(() => window.__emits.length = 0);
    await page.click('#connectBtn');
    await page.waitForTimeout(100);

    const savesBefore = await saveProfileEmits(page);
    check('§B connect emits ssh_connect but nothing is saved before success',
        [(await connectRequestIds(page)).length > 0 ? 'sent' : 'missing', savesBefore.length],
        ['sent', 0]);

    await driveConnected(page);
    await page.waitForTimeout(120);
    const saves = await saveProfileEmits(page);
    check('§B exactly one save_profile after success', saves.length, 1);
    check('§B the save carries the form fields + name',
        saves[0] ? {
            name: saves[0].name, host: saves[0].host, port: saves[0].port,
            username: saves[0].username, auth_type: saves[0].auth_type,
        } : null,
        { name: 'My Saved Box', host: 'save.example', port: 22,
            username: 'root', auth_type: 'password' });
    check('§C the password NEVER enters the save payload',
        saves[0] ? Object.prototype.hasOwnProperty.call(saves[0], 'password')
            : 'no-save', false);
    check('§C no proxy/jump credentials ride along either',
        saves[0] ? Object.prototype.hasOwnProperty.call(saves[0], 'proxy_jump')
            : 'no-save', false);
    check('§Z no page errors (§B/§C)', errors, []);
    await ctx.close();
}

// ── §D unchecked submit saves nothing ───────────────────────────────────────
{
    const { ctx, page, errors } = await newPage();
    await fillForm(page, { check: false });
    await page.evaluate(() => window.__emits.length = 0);
    await page.click('#connectBtn');
    await page.waitForTimeout(100);
    await driveConnected(page);
    await page.waitForTimeout(120);
    check('§D an unchecked connect saves nothing on success',
        await saveProfileEmits(page), []);
    check('§Z no page errors (§D)', errors, []);
    await ctx.close();
}

// ── §E a failed connect saves nothing, ever ─────────────────────────────────
{
    const { ctx, page, errors } = await newPage();
    await fillForm(page, { check: true });
    await page.fill('#profileNameInput', 'Never Saved');
    await page.evaluate(() => window.__emits.length = 0);
    await page.click('#connectBtn');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const id = window.__emits.filter(e => e.name === 'ssh_connect')
            .map(e => e.payload.client_request_id).pop();
        (window.__socketHandlers['ssh_error'] || []).forEach(h =>
            h({ error: 'auth failed', client_request_id: id }));
    });
    await page.waitForTimeout(100);
    check('§E a failed connect saves nothing', await saveProfileEmits(page), []);
    // A LATE success frame for the same request cannot resurrect the save:
    // the failure already consumed the pending record.
    await driveConnected(page);
    await page.waitForTimeout(120);
    check('§E a late success frame cannot resurrect a failed request\'s save',
        await saveProfileEmits(page), []);
    check('§Z no page errors (§E)', errors, []);
    await ctx.close();
}

// ── §F auto-launch is decoupled from save ───────────────────────────────────
{
    const { ctx, page, errors } = await newPage();
    await page.evaluate(() => {
        ProfileManager.setProfiles([{
            id: 'p-launch', name: 'Launch Only', host: 'launch.example',
            port: 22, username: 'root', auth_type: 'key', key_id: 'k-launch',
            jump_host_id: null,
        }]);
        // hasKey() (profile-launcher-utils.js) only accepts keys marked
        // usable:true -- without it the launch resolves to 'review' mode and
        // never submits, which is not what this arm measures.
        ProfileManager.setKeys([{ id: 'k-launch', name: 'Launch Key', usable: true }]);
        document.getElementById('keySelect').innerHTML +=
            '<option value="k-launch">Launch Key</option>';
        window.__emits.length = 0;
        window.launchProfileForPane('p-launch', 0);
    });
    await page.waitForTimeout(150);
    check('§F auto-launch submits the connection',
        (await connectRequestIds(page)).length, 1);
    await driveConnected(page, { host: 'launch.example' });
    await page.waitForTimeout(120);
    check('§F auto-launch emits ZERO save_profile frames',
        await saveProfileEmits(page), []);
    check('§Z no page errors (§F)', errors, []);
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
