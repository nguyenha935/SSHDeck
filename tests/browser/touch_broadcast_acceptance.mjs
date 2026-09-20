/*
 * Blocker 11: touch Broadcast-on acceptance shots must be real production
 * states, not merely extra filenames in the screenshot matrix.
 *
 * The Broadcast composer behavior remains owned by p1_workflow_acceptance.mjs
 * (Contract 3) and mobile_realtime_input.mjs. This focused bridge covers only
 * the two acceptance viewports and the visual harness integration that was
 * missing from the approved matrix.
 *
 * Run: node tests/browser/touch_broadcast_acceptance.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ACCEPTANCE = path.join(ROOT, 'tests/browser/visual_acceptance_v5.mjs');
const acceptanceSource = fs.readFileSync(ACCEPTANCE, 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed += 1;
        console.log(`PASS  ${label}`);
        return;
    }
    failed += 1;
    failures.push(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}`
        + `\n      actual   ${JSON.stringify(actual)}`);
}

// Acceptance ownership: two named touch shots, driven through one guarded real
// toggle helper. A duplicate composer injected only for a shot would fail the
// runtime guard requirement rather than becoming reviewable evidence.
check('B11 source: iPad Broadcast-on acceptance shot exists',
    /shell\(['"]\d+[a-z]?-ipad-[^'"]*broadcast-on['"],\s*['"]ipadPortrait['"],\s*openTouchBroadcast(?:,\s*\{[^}]*\})?\)/.test(acceptanceSource),
    true);
check('B11 source: phone390 Broadcast-on acceptance shot exists',
    /shell\(['"]\d+[a-z]?-phone390-broadcast-on['"],\s*['"]phone390['"],\s*openTouchBroadcast\)/.test(acceptanceSource),
    true);
check('B11 source: touch shot helper uses trusted tap and named guard',
    /const openTouchBroadcast\s*=\s*async \(page,\s*shotName\) => \{[\s\S]*?page\.locator\(['"]#broadcastToggleBtn['"]\)\.tap\(\)[\s\S]*?expectTouchBroadcastState\(page,\s*shotName\)[\s\S]*?\};/.test(acceptanceSource),
    true);
check('B11 source: visual guard compares focus identity inside the page',
    /sameActive:\s*document\.activeElement\s*===\s*window\.__acceptanceTouchBroadcast\?\.active/.test(acceptanceSource),
    true);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
};

function renderIndex() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g,
        '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const SOCKET_IO_FIXTURE = `
(() => {
    window.__b11Emits = [];
    const manager = { on() { return manager; }, off() { return manager; } };
    window.io = () => {
        const listeners = new Map();
        const socket = {
            connected: true,
            io: manager,
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
                return socket;
            },
            off(event, handler) {
                if (!handler) listeners.delete(event);
                else listeners.get(event)?.delete(handler);
                return socket;
            },
            once(event, handler) {
                const wrapped = (...args) => {
                    socket.off(event, wrapped);
                    handler(...args);
                };
                return socket.on(event, wrapped);
            },
            emit(event, payload, acknowledgement) {
                window.__b11Emits.push({ event, payload });
                if (typeof acknowledgement === 'function') {
                    acknowledgement({ success: true });
                }
                return socket;
            },
            connect() { socket.connected = true; return socket; },
            disconnect() { socket.connected = false; return socket; },
        };
        return socket;
    };
})();
`;

const server = await new Promise(resolve => {
    const instance = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        const rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderIndex());
            return;
        }
        if (req.method === 'GET'
            && rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
            return;
        }
        const fp = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(fp)] || 'text/plain; charset=utf-8',
        });
        res.end(fs.readFileSync(fp));
    });
    instance.listen(0, '127.0.0.1', () => resolve(instance));
});

const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const VIEWPORTS = [
    { label: 'ipad-portrait', width: 834, height: 1194 },
    { label: 'phone390', width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: true,
        isMobile: true,
    });
    const page = await context.newPage();
    const pageErrors = [];
    const requestFailures = [];
    const httpErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('requestfailed', request =>
        requestFailures.push(`${request.method()} ${request.url()}`));
    page.on('response', response => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.request().method()}`
                + ` ${response.url()}`);
        }
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(120);

    const before = await page.evaluate(() => {
        document.getElementById('sessionBar')?.classList.remove('hidden');
        const seeds = [
            ['s1', true, false],
            ['s2', true, false],
            ['s3', false, false],
            ['s4', true, true],
        ];
        seeds.forEach(([id, connected, candidate]) => {
            SessionManager.sessions[id] = {
                id, session_id: id, host: id, username: 'root', port: 22,
                connected, isPersistentCandidate: candidate,
                terminalId: `terminal-${id}`,
            };
        });
        SessionManager.activeSessionId = 's1';

        const input = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');
        const toggleRect = toggle?.getBoundingClientRect();
        const toggleStyle = toggle ? getComputedStyle(toggle) : null;
        window.__b11Input = input;
        input.value = 'uptime';
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        window.__b11Emits = [];
        const pointerDown = new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerType: 'touch',
        });
        const mouseDown = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true,
        });
        if (toggle) {
            toggle.dispatchEvent(pointerDown);
            toggle.dispatchEvent(mouseDown);
        }
        return {
            inputCount: document.querySelectorAll('#mobileInput').length,
            composerCount: document.querySelectorAll('.mobile-composer').length,
            toggleCount: document.querySelectorAll('#broadcastToggleBtn').length,
            toggleVisible: !!toggle && toggleStyle?.display !== 'none'
                && toggleStyle?.visibility !== 'hidden'
                && toggleRect.width > 0 && toggleRect.height > 0,
            toggleEnabled: !!toggle && !toggle.disabled,
            toggleAria: toggle?.getAttribute('aria-pressed') || '',
            toggleWidth: toggleRect ? Math.round(toggleRect.width) : 0,
            toggleHeight: toggleRect ? Math.round(toggleRect.height) : 0,
            pointerDownPrevented: pointerDown.defaultPrevented,
            mouseDownPrevented: mouseDown.defaultPrevented,
            draft: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            active: document.activeElement?.id || '',
        };
    });

    const at = `B11 ${viewport.label}`;
    check(`${at}: exactly one actual Broadcast button`, before.toggleCount, 1);
    check(`${at}: actual Broadcast button is visible`, before.toggleVisible, true);
    check(`${at}: actual Broadcast button is enabled`, before.toggleEnabled, true);
    check(`${at}: actual Broadcast button initially states off`,
        before.toggleAria, 'false');
    check(`${at}: actual Broadcast button width is at least 44px`,
        before.toggleWidth >= 44, true);
    check(`${at}: actual Broadcast button height is at least 44px`,
        before.toggleHeight >= 44, true);
    check(`${at}: touch pointerdown preserves the active element`,
        before.pointerDownPrevented, true);
    check(`${at}: touch mousedown preserves the active element`,
        before.mouseDownPrevented, true);

    const toggleLocator = page.locator('#broadcastToggleBtn');
    if (before.toggleCount === 1 && before.toggleVisible && before.toggleEnabled) {
        await toggleLocator.tap();
    }
    await page.waitForTimeout(80);

    const on = await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');
        const target = document.getElementById('composerTarget');
        const targetStyle = getComputedStyle(target);
        const sendLabel = document.querySelector('#mobileSendBtn .btn-label');
        return {
            sameInput: input === window.__b11Input,
            inputCount: document.querySelectorAll('#mobileInput').length,
            composerCount: document.querySelectorAll('.mobile-composer').length,
            draft: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            active: document.activeElement?.id || '',
            keyboardOpen: document.body.classList.contains('keyboard-open'),
            broadcastOpen: BroadcastInput.open,
            toggleAria: toggle?.getAttribute('aria-pressed') || '',
            targetCount: BroadcastInput.targetCount(),
            targetHidden: target.hidden,
            targetVisible: targetStyle.display !== 'none'
                && target.getBoundingClientRect().width > 0
                && target.getBoundingClientRect().height > 0,
            targetText: target.querySelector('.composer-target-label')
                ?.textContent.trim() || '',
            sendLabelDisplay: sendLabel ? getComputedStyle(sendLabel).display : 'absent',
            sends: window.__b11Emits.filter(item => item.event === 'ssh_input'),
        };
    });

    check(`${at}: precondition has one input`, before.inputCount, 1);
    check(`${at}: precondition has one composer`, before.composerCount, 1);
    check(`${at}: the same input DOM node survives toggle`, on.sameInput, true);
    check(`${at}: still exactly one input`, on.inputCount, 1);
    check(`${at}: still exactly one composer`, on.composerCount, 1);
    check(`${at}: Broadcast is on`, on.broadcastOpen, true);
    check(`${at}: actual Broadcast button states on`, on.toggleAria, 'true');
    check(`${at}: N counts only two connected sendable sessions`, on.targetCount, 2);
    check(`${at}: target chip is not hidden`, on.targetHidden, false);
    check(`${at}: target chip has a painted box`, on.targetVisible, true);
    check(`${at}: target states the honest blast radius`, on.targetText, 'All 2');
    check(`${at}: draft survives toggle`, on.draft, before.draft);
    check(`${at}: caret start survives toggle`, on.selectionStart, before.selectionStart);
    check(`${at}: caret end survives toggle`, on.selectionEnd, before.selectionEnd);
    check(`${at}: focus does not move`, on.active, before.active);
    check(`${at}: toggle does not open the keyboard state`, on.keyboardOpen, false);
    check(`${at}: touch Send remains icon-only`, on.sendLabelDisplay, 'none');
    /*
     * REVISED (Phase 2). The composer MIRRORS the active session's
     * input line, so the seeded draft is already on s1's line when Broadcast
     * opens. Opening it RETRACTS exactly that -- one DEL per grapheme cluster
     * of 'uptime' -- so the text is not delivered twice (once as the mirror,
     * once in the fan-out) and the box keeps it as the all-local broadcast
     * draft. The old expectation (zero bytes) belonged to the local-draft
     * composer the owner retired; what still must hold, and is asserted above,
     * is that the draft, the caret and the focus do not move.
     */
    check(`${at}: the toggle retracts the mirrored line, nothing else`,
        on.sends.map(item => [item.payload.session_id, item.payload.data]),
        [['s1', '\x7f'.repeat(6)]]);

    const canToggleOff = await page.evaluate(() => {
        const toggle = document.getElementById('broadcastToggleBtn');
        if (!toggle || document.querySelectorAll('#broadcastToggleBtn').length !== 1) {
            return false;
        }
        const style = getComputedStyle(toggle);
        const rect = toggle.getBoundingClientRect();
        return !toggle.disabled && style.display !== 'none'
            && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    if (canToggleOff) await toggleLocator.tap();
    await page.waitForTimeout(50);
    const off = await page.evaluate(() => {
        const input = document.getElementById('mobileInput');
        const toggle = document.getElementById('broadcastToggleBtn');
        return {
            open: BroadcastInput.open,
            toggleAria: toggle?.getAttribute('aria-pressed') || '',
            inputCount: document.querySelectorAll('#mobileInput').length,
            composerCount: document.querySelectorAll('.mobile-composer').length,
            draft: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            active: document.activeElement?.id || '',
            keyboardOpen: document.body.classList.contains('keyboard-open'),
            sameInput: input === window.__b11Input,
            sends: window.__b11Emits.filter(item => item.event === 'ssh_input'),
        };
    });
    check(`${at}: second button click turns Broadcast off`, off.open, false);
    check(`${at}: actual Broadcast button states off`, off.toggleAria, 'false');
    check(`${at}: toggle off keeps exactly one input`, off.inputCount, 1);
    check(`${at}: toggle off keeps exactly one composer`, off.composerCount, 1);
    check(`${at}: same input survives toggle off`, off.sameInput, true);
    check(`${at}: draft survives toggle off`, off.draft, before.draft);
    check(`${at}: caret start survives toggle off`,
        off.selectionStart, before.selectionStart);
    check(`${at}: caret end survives toggle off`,
        off.selectionEnd, before.selectionEnd);
    check(`${at}: focus survives toggle off`, off.active, before.active);
    check(`${at}: toggle off keeps keyboard state closed`, off.keyboardOpen, false);
    // Cumulative: the mirror is empty from the retraction above, so closing
    // Broadcast adds nothing of its own.
    check(`${at}: toggle off adds no bytes of its own`,
        off.sends.map(item => [item.payload.session_id, item.payload.data]),
        [['s1', '\x7f'.repeat(6)]]);
    check(`${at}: no page errors`, pageErrors, []);
    check(`${at}: no request failures`, requestFailures, []);
    check(`${at}: no HTTP errors`, httpErrors, []);

    await context.close();
}

// Fine-pointer complement: target-preserving pointer cancellation belongs only
// to the touch shell. Desktop keeps native button focus, and keyboard activation
// remains available through both standard button keys.
{
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        hasTouch: false,
        isMobile: false,
    });
    const page = await context.newPage();
    const pageErrors = [];
    const requestFailures = [];
    const httpErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('requestfailed', request =>
        requestFailures.push(`${request.method()} ${request.url()}`));
    page.on('response', response => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.request().method()}`
                + ` ${response.url()}`);
        }
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.waitForTimeout(120);

    const pre = await page.evaluate(() => {
        const toggle = document.getElementById('broadcastToggleBtn');
        const pointerDown = new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerType: 'mouse',
        });
        const mouseDown = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true,
        });
        if (toggle) {
            toggle.dispatchEvent(pointerDown);
            toggle.dispatchEvent(mouseDown);
        }
        window.__b11Emits = [];
        const emit = window.socket.emit.bind(window.socket);
        window.socket.emit = (event, payload, acknowledgement) => {
            if (event === 'ssh_input') window.__b11Emits.push({ event, payload });
            return emit(event, payload, acknowledgement);
        };
        return {
            toggleCount: document.querySelectorAll('#broadcastToggleBtn').length,
            isTouchShell: TerminalManager.isTouchShell(),
            pointerDownPrevented: pointerDown.defaultPrevented,
            mouseDownPrevented: mouseDown.defaultPrevented,
            aria: toggle?.getAttribute('aria-pressed') || '',
        };
    });
    const at = 'B11 desktop-fine';
    check(`${at}: exactly one actual Broadcast button`, pre.toggleCount, 1);
    check(`${at}: product predicate reports a non-touch shell`, pre.isTouchShell, false);
    check(`${at}: pointerdown keeps native desktop behavior`,
        pre.pointerDownPrevented, false);
    check(`${at}: mousedown keeps native desktop behavior`,
        pre.mouseDownPrevented, false);
    check(`${at}: actual Broadcast button initially states off`, pre.aria, 'false');

    const toggleLocator = page.locator('#broadcastToggleBtn');
    if (pre.toggleCount === 1) await toggleLocator.focus();
    if (pre.toggleCount === 1) await toggleLocator.press('Enter');
    const enter = await page.evaluate(() => ({
        open: window.BroadcastInput?.open === true,
        aria: document.getElementById('broadcastToggleBtn')
            ?.getAttribute('aria-pressed') || '',
        active: document.activeElement?.id || '',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        sends: window.__b11Emits || [],
    }));
    check(`${at}: Enter activates Broadcast`, enter.open, true);
    check(`${at}: Enter updates aria-pressed`, enter.aria, 'true');
    check(`${at}: Enter keeps native button focus`, enter.active, 'broadcastToggleBtn');
    check(`${at}: Enter does not open the soft keyboard`, enter.keyboardOpen, false);
    check(`${at}: Enter emits zero ssh_input`, enter.sends, []);

    if (pre.toggleCount === 1) await toggleLocator.press('Space');
    const space = await page.evaluate(() => ({
        open: window.BroadcastInput?.open === true,
        aria: document.getElementById('broadcastToggleBtn')
            ?.getAttribute('aria-pressed') || '',
        active: document.activeElement?.id || '',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        sends: window.__b11Emits || [],
    }));
    check(`${at}: Space deactivates Broadcast`, space.open, false);
    check(`${at}: Space updates aria-pressed`, space.aria, 'false');
    check(`${at}: Space keeps native button focus`, space.active, 'broadcastToggleBtn');
    check(`${at}: Space does not open the soft keyboard`, space.keyboardOpen, false);
    check(`${at}: Space emits zero ssh_input`, space.sends, []);

    await page.evaluate(() => document.activeElement?.blur());
    if (pre.toggleCount === 1) await toggleLocator.click();
    const click = await page.evaluate(() => ({
        open: window.BroadcastInput?.open === true,
        aria: document.getElementById('broadcastToggleBtn')
            ?.getAttribute('aria-pressed') || '',
        active: document.activeElement?.id || '',
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        sends: window.__b11Emits || [],
    }));
    check(`${at}: trusted click activates Broadcast`, click.open, true);
    check(`${at}: trusted click updates aria-pressed`, click.aria, 'true');
    check(`${at}: trusted click retains native desktop focus behavior`,
        click.active, 'broadcastToggleBtn');
    check(`${at}: trusted click does not open the soft keyboard`,
        click.keyboardOpen, false);
    check(`${at}: trusted click emits zero ssh_input`, click.sends, []);
    check(`${at}: no page errors`, pageErrors, []);
    check(`${at}: no request failures`, requestFailures, []);
    check(`${at}: no HTTP errors`, httpErrors, []);
    await context.close();
}

await browser.close();
server.close();

if (failures.length) console.error(`\n${failures.join('\n')}`);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
