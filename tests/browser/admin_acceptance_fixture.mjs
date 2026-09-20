/*
 * Blocker 10: the visual-acceptance admin fixture must exercise production
 * admin.js, not photograph an empty tbody after a swallowed API 404.
 *
 * Run: node tests/browser/admin_acceptance_fixture.mjs
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

// These bind the focused proof to the acceptance harness that owns blocker 10.
// The runtime companion below separately proves the production JS behavior.
check('B10 source: exact GET-only admin users fixture exists',
    /req\.method\s*===\s*['"]GET['"]\s*&&\s*rel\s*===\s*['"]\/admin\/api\/users['"]/.test(acceptanceSource),
    true);
check('B10 source: fixture seeds exactly three representative users',
    /const ADMIN_USERS\s*=\s*\[[\s\S]*?username:\s*['"]nguyenha['"][\s\S]*?username:\s*['"]operator['"][\s\S]*?username:\s*['"]locked-user['"][\s\S]*?\];/.test(acceptanceSource),
    true);
check('B10 source: admin shots wait for three production-rendered rows',
    /waitForFunction\([\s\S]*?#adminUsersBody\s*>\s*tr[\s\S]*?length\s*===\s*expected[\s\S]*?,\s*ADMIN_USERS\.length(?:\s*,\s*\{[\s\S]*?\})?\s*\)/.test(acceptanceSource),
    true);
check('B10 source: acceptance tracks request failures',
    /page\.on\(['"]requestfailed['"]/.test(acceptanceSource), true);
check('B10 source: acceptance rejects HTTP error responses',
    /page\.on\(['"]response['"][\s\S]*?status\(\)\s*>=\s*400/.test(acceptanceSource), true);
check('B10 source: every HTTP error remains globally diagnosed',
    /page\.on\(['"]response['"], response => \{\s*if \(response\.status\(\) >= 400\)/.test(acceptanceSource),
    true);
check('B10 source: exact Socket.IO client asset uses an in-memory fixture',
    /req\.method\s*===\s*['"]GET['"]\s*&&\s*rel\s*===\s*['"]\/static\/vendor\/socketio\/socket\.io\.min\.js['"]/.test(acceptanceSource),
    true);
const delayMatch = acceptanceSource.match(
    /const ADMIN_USERS_DELAY_MS\s*=\s*(\d+)\s*;/);
check('B10 source: admin users response is delayed beyond the old 350ms sleep',
    Number(delayMatch?.[1]) > 350, true);
check('B10 source: readiness proves rows were absent before waiting',
    /if\s*\(rowsBeforeReadiness\s*!==\s*0\)[\s\S]*?expectAdminUsersReady\(page,\s*name\)/.test(acceptanceSource),
    true);
check('B10 source: acceptance rejects admin error toasts',
    /\.notification-error/.test(acceptanceSource), true);

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

function renderAdmin() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/admin.html'), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g,
        '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

const USERS = [
    {
        id: 1, username: 'nguyenha', is_admin: true, is_locked: false,
        created_at: '2026-06-01T08:00:00Z', last_login: '2026-08-09T09:30:00Z',
    },
    {
        id: 2, username: 'operator', is_admin: false, is_locked: false,
        created_at: '2026-07-11T10:15:00Z', last_login: '2026-08-08T13:45:00Z',
    },
    {
        id: 3, username: 'locked-user', is_admin: false, is_locked: true,
        created_at: '2026-07-20T14:00:00Z', last_login: null,
    },
];

const FOCUSED_USERS_DELAY_MS = 500;
let fixtureMode = 'success';
let usersRequests = [];
const server = await new Promise(resolve => {
    const instance = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        const rel = decodeURIComponent(url.pathname);
        if (rel === '/admin') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderAdmin());
            return;
        }
        if (rel === '/admin/api/users') {
            usersRequests.push({ method: req.method, path: rel });
            const respond = () => {
                res.writeHead(fixtureMode === 'success' ? 200 : 503, {
                    'Content-Type': 'application/json; charset=utf-8',
                });
                res.end(JSON.stringify(fixtureMode === 'success'
                    ? { users: USERS } : { error: 'Focused fixture failure' }));
            };
            if (fixtureMode === 'success') {
                setTimeout(respond, FOCUSED_USERS_DELAY_MS);
            } else {
                respond();
            }
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

async function openAdmin() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const requestFailures = [];
    const responses = [];
    page.on('requestfailed', request => requestFailures.push(request.url()));
    page.on('response', response => {
        if (response.url().includes('/admin/api/')) {
            responses.push({
                url: response.url(), status: response.status(),
                contentType: response.headers()['content-type'] || '',
            });
        }
    });
    await page.goto(`${base}/admin`, { waitUntil: 'load' });
    return { context, page, requestFailures, responses };
}

// Success: production admin.js fetches once and creates every row itself.
fixtureMode = 'success';
usersRequests = [];
{
    const { context, page, requestFailures, responses } = await openAdmin();
    const rowsBeforeWait = await page.locator('#adminUsersBody > tr').count();
    check('B10 readiness: zero rows before delayed response', rowsBeforeWait, 0);
    await page.waitForFunction(expected =>
        document.querySelectorAll('#adminUsersBody > tr').length === expected,
    USERS.length);

    const rendered = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#adminUsersBody > tr')].map(row => ({
            id: row.dataset.userId,
            text: row.textContent.replace(/\s+/g, ' ').trim(),
            actions: [...row.querySelectorAll('button[data-act]')].map(button => ({
                action: button.dataset.act,
                disabled: button.disabled,
            })),
        })),
        errorToasts: document.querySelectorAll('.notification-error').length,
    }));
    const apiResponse = responses.find(item => item.url.endsWith('/admin/api/users'));
    check('B10 success: exact users route requested once', usersRequests.length, 1);
    check('B10 success: request method is GET', usersRequests[0]?.method, 'GET');
    check('B10 success: response status is 200', apiResponse?.status, 200);
    check('B10 success: response is JSON',
        apiResponse?.contentType.startsWith('application/json'), true);
    check('B10 readiness: delayed production render reached three rows',
        rendered.rows.length, 3);
    check('B10 success: current admin is marked as you',
        rendered.rows[0].text.includes('nguyenha') && rendered.rows[0].text.includes('(you)'),
        true);
    check('B10 success: active user has Promote Lock Delete',
        rendered.rows[1].actions.map(item => item.action), ['promote', 'lock', 'delete']);
    check('B10 success: locked user has Promote Unlock Delete',
        rendered.rows[2].actions.map(item => item.action), ['promote', 'unlock', 'delete']);
    check('B10 success: current-user destructive actions are disabled',
        rendered.rows[0].actions.map(item => item.disabled), [true, true, true]);
    check('B10 success: no request failed', requestFailures, []);
    check('B10 success: no error toast rendered', rendered.errorToasts, 0);

    const unknown = await page.evaluate(async () => {
        const response = await fetch('/admin/api/not-a-fixture');
        return response.status;
    });
    check('B10 success: unknown API routes remain 404', unknown, 404);
    await context.close();
}

// Failure companion: production error handling must remain visible and truthful.
fixtureMode = 'failure';
usersRequests = [];
{
    const { context, page, requestFailures, responses } = await openAdmin();
    await page.waitForFunction(() => !!document.querySelector('.notification-error'));
    const failure = await page.evaluate(() => ({
        rows: document.querySelectorAll('#adminUsersBody > tr').length,
        toast: document.querySelector('.notification-error')?.textContent || '',
    }));
    const apiResponse = responses.find(item => item.url.endsWith('/admin/api/users'));
    check('B10 failure: exact users route requested once', usersRequests.length, 1);
    check('B10 failure: response status remains 503', apiResponse?.status, 503);
    check('B10 failure: failed response does not fabricate rows', failure.rows, 0);
    check('B10 failure: production renders the server error toast',
        failure.toast, 'Focused fixture failure');
    check('B10 failure: HTTP failure is not a network request failure',
        requestFailures, []);
    await context.close();
}

await browser.close();
server.close();

if (failures.length) console.error(`\n${failures.join('\n')}`);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
