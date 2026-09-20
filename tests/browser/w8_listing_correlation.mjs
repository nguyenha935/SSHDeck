/*
 * Listing-correlation regression — the two stale-response clobbers measured on
 * the live deployment (Entry 44).
 *
 * BOTH defects are ORDER defects, so this suite is built around event ORDER and
 * nothing else. It never sleeps waiting for a race to happen: it drives the
 * production socket handlers directly, in a chosen order, so each assertion is
 * deterministic and fails for exactly one reason.
 *
 * The two guards under test, both in static/js/sftp-file-manager.js:
 *
 *   GUARD 1 (directory_listing correlation). A pane can have several listings
 *   in flight on ONE session, because onSourceChange emits a '/' listing while
 *   the caller immediately navigates elsewhere. The server echoes the requested
 *   path verbatim and answers each request independently, so the replies are
 *   unordered. Applying a reply on session id alone lets the LAST arrival win:
 *   measured live, the '/' reply landed 11 ms after the reply for the requested
 *   directory and overwrote it, stranding the pane at '/' forever.
 *
 *   GUARD 2 (home_directory auto-landing). get_home_directory is emitted next to
 *   that '/' listing, and its reply can arrive after the caller has navigated.
 *   `state.path === '/'` was read as "still at the default", but a pane whose
 *   navigation is only IN FLIGHT also still shows '/', so the auto-landing
 *   hijacked it: measured live, the left pane was pulled from a requested
 *   /tmp/... to /home/<user> 176 ms after the explicit navigation.
 *
 * Each guard has a section that is RED with that guard removed and GREEN with
 * both present (proven by tests/browser/w8_listing_mutation_proof.sh), plus
 * sections pinning the behaviour the guards must NOT break: the home
 * auto-landing itself, unsolicited server-pushed refreshes, and source
 * switching.
 *
 * Run: node tests/browser/w8_listing_correlation.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = process.cwd();
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

function renderTemplate(rel, theme = 'glass') {
    let html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    html = html.replace(
        /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, theme);
    html = html.replace(/\{\{\s*csrf_token\(\)\s*\}\}/g, 'test-csrf-token');
    html = html.replace(/\{\{\s*current_user\.username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*username\s*\}\}/g, 'nguyenha');
    html = html.replace(/\{\{\s*url_prefix\s*\}\}/g, '');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    return html.replace(/\{\{[^}]*\}\}/g, '');
}

/*
 * Socket fixture. Only the transport is fake: every emit is recorded so the
 * suite can assert WHICH listings the product asked for, and __fire delivers
 * server events on the real channel names in an order this suite chooses.
 */
const SOCKET_IO_FIXTURE = `
(() => {
    const handlers = {};
    const sock = {
        connected: true,
        io: { on() {}, off() {} },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
        off() { return sock; },
        once(evt, fn) { return sock.on(evt, fn); },
        emit(evt, payload, ack) {
            window.__emits.push({ evt, payload, hasAck: typeof ack === 'function' });
            if (evt === 'transfer_server_to_server' && typeof ack === 'function') {
                setTimeout(() => ack({ success: true, transfer_id: 'srv-1-x' }), 0);
            }
            return sock;
        },
        disconnect() { return sock; },
        __fire(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); },
    };
    window.__socketFixture = sock;
    window.io = () => sock;
})();
`;

const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(renderTemplate('templates/index.html'));
            return;
        }
        if (rel === '/static/vendor/socketio/socket.io.min.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end(SOCKET_IO_FIXTURE);
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
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok: !!ok, detail });
};
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({
        label, ok,
        detail: ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
    });
};

const browser = await chromium.launch();

/*
 * One shell per section, so no section can inherit another's pane state — the
 * defects under test ARE stale state, and a shared shell would make a pass
 * ambiguous.
 */
async function shell() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.addInitScript(() => { window.__emits = []; });
    await page.goto(BASE, { waitUntil: 'load' });
    /*
     * window.sftpFileManager is created LAZILY by ensureFileManager() when a
     * transfer surface first opens, so waiting for it before clicking the
     * opener would always time out. Wait for the shell only.
     */
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 15000 });
    await page.evaluate(() => {
        SessionManager.setSplitLayout(1, 'default');
        SessionManager.createSession({
            session_id: 's1', host: 'tiny', port: 22, username: 'sshdtest',
            auth_type: 'password', display_name: 'tiny',
            use_tmux: true, tmux_session_name: 'lc-s1', via_jump: null,
        });
        SessionManager.createSession({
            session_id: 's2', host: 'tiny', port: 22, username: 'sshdtest',
            auth_type: 'password', display_name: 'tiny-2',
            use_tmux: true, tmux_session_name: 'lc-s2', via_jump: null,
        });
        SessionManager.assignSessionToPane('s1', 0);
        SessionManager.setActivePane(0);
    });
    // Open the dual-pane surface through the production controls, so the
    // directory_listing handler's open-state gate is satisfied the real way.
    await page.click('#accountBtnHeader');
    await page.waitForTimeout(120);
    await page.click('#fileTransferOpenBtn');
    await page.waitForFunction(() => !!window.sftpFileManager
        && document.getElementById('sftpFileManager')?.classList.contains('show'),
    null, { timeout: 10000 });
    await page.waitForTimeout(200);
    // The opener seeds the DESTINATION pane with the active session; clear both
    // panes so each section starts from a known-empty state, and give the
    // manager its session list (normally filled by a get_sessions reply).
    await page.evaluate(() => {
        const fm = window.sftpFileManager;
        fm.availableSessions = [
            { session_id: 's1', id: 's1', host: 'tiny', username: 'sshdtest', port: 22 },
            { session_id: 's2', id: 's2', host: 'tiny', username: 'sshdtest', port: 22 },
        ];
        fm.updateSessionLists();
        fm.resetPane('left');
        fm.resetPane('right');
        window.__emits.length = 0;
    });
    return { ctx, page, pageErrors };
}

const listingEmits = page => page.evaluate(() => window.__emits
    .filter(e => e.evt === 'list_directory')
    .map(e => ({ path: e.payload.remote_path, session: e.payload.session_id })));

/*
 * §1 — GUARD 1. The exact live sequence: select a source (which emits the '/'
 * listing), navigate somewhere explicitly, then deliver the replies in the
 * order the deployment actually produced them — the WANTED directory first, the
 * stale '/' second. Without guard 1 the '/' reply overwrites the wanted one and
 * the pane ends at '/' with the root's files.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        document.getElementById('fmLeftSource').value = 'ssh:s1';
        fm.onSourceChange('left', 'ssh:s1');
        fm.navigatePaneTo('left', '/tmp/wanted');
        const askedFor = fm.panes.left.pendingPath;

        // Reply order as measured live: wanted first, stale root 11 ms later.
        fire('directory_listing', { session_id: 's1', path: '/tmp/wanted',
            files: [{ name: 'artifact.txt', is_dir: false, size: 10 }] });
        const afterWanted = { path: fm.panes.left.path,
            files: fm.panes.left.files.map(f => f.name) };
        fire('directory_listing', { session_id: 's1', path: '/',
            files: [{ name: 'etc', is_dir: true, size: 0 },
                    { name: 'usr', is_dir: true, size: 0 }] });
        const afterStale = { path: fm.panes.left.path,
            files: fm.panes.left.files.map(f => f.name),
            loading: fm.panes.left.loading };
        return { askedFor, afterWanted, afterStale,
            pathInput: document.getElementById('fmLeftPath').value };
    });
    eq('§1 the pane records the directory it asked for', out.askedFor, '/tmp/wanted');
    eq('§1 the wanted listing is applied when it arrives',
        out.afterWanted, { path: '/tmp/wanted', files: ['artifact.txt'] });
    eq('§1 a later stale "/" reply does not move the pane',
        out.afterStale.path, '/tmp/wanted');
    eq('§1 a later stale "/" reply does not replace the files',
        out.afterStale.files, ['artifact.txt']);
    check('§1 the pane is not left loading', out.afterStale.loading === false,
        JSON.stringify(out.afterStale));
    eq('§1 the visible path input shows the wanted directory',
        out.pathInput, '/tmp/wanted');
    check('§1 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §2 — GUARD 2. Same opening, but this time the home_directory reply is the one
 * that arrives late. Without guard 2 it calls navigatePaneTo($HOME) because the
 * pane is still displaying '/', discarding the navigation that is in flight.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        document.getElementById('fmLeftSource').value = 'ssh:s1';
        fm.onSourceChange('left', 'ssh:s1');
        fm.navigatePaneTo('left', '/tmp/wanted');
        const pathWhileInFlight = fm.panes.left.path;
        window.__emits.length = 0;

        // The home reply lands AFTER the explicit navigation, as measured live.
        fire('home_directory', { session_id: 's1', path: '/home/sshdtest' });
        const emittedAfterHome = window.__emits
            .filter(e => e.evt === 'list_directory')
            .map(e => e.payload.remote_path);
        const stillWants = fm.panes.left.pendingPath;

        // And the wanted reply still lands correctly afterwards.
        fire('directory_listing', { session_id: 's1', path: '/tmp/wanted',
            files: [{ name: 'artifact.txt', is_dir: false, size: 10 }] });
        return { pathWhileInFlight, emittedAfterHome, stillWants,
            finalPath: fm.panes.left.path,
            finalFiles: fm.panes.left.files.map(f => f.name),
            homeRecorded: fm.panes.left.homePath };
    });
    eq('§2 the pane still shows "/" while its navigation is in flight',
        out.pathWhileInFlight, '/');
    eq('§2 a late home reply triggers no listing of its own',
        out.emittedAfterHome, []);
    eq('§2 the pane still wants the directory it asked for',
        out.stillWants, '/tmp/wanted');
    eq('§2 home is still recorded for the Home button',
        out.homeRecorded, '/home/sshdtest');
    eq('§2 the explicit navigation survives and completes',
        [out.finalPath, out.finalFiles], ['/tmp/wanted', ['artifact.txt']]);
    check('§2 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §3 — the behaviour guard 2 must NOT break. With no explicit navigation, a
 * newly selected source must still land on $HOME automatically. This is why
 * onSourceChange's own '/' listing deliberately does not record pendingPath:
 * if it did, this section would be red and every new source would strand at '/'.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        document.getElementById('fmLeftSource').value = 'ssh:s1';
        fm.onSourceChange('left', 'ssh:s1');
        const pendingAfterSelect = fm.panes.left.pendingPath;
        window.__emits.length = 0;

        // Nobody navigated. The home reply must pull the pane to $HOME.
        fire('home_directory', { session_id: 's1', path: '/home/sshdtest' });
        const emitted = window.__emits.filter(e => e.evt === 'list_directory')
            .map(e => e.payload.remote_path);
        fire('directory_listing', { session_id: 's1', path: '/home/sshdtest',
            files: [{ name: '.bashrc', is_dir: false, size: 220 }] });
        return { pendingAfterSelect, emitted, path: fm.panes.left.path,
            files: fm.panes.left.files.map(f => f.name),
            pathInput: document.getElementById('fmLeftPath').value };
    });
    eq('§3 selecting a source records no navigation intent',
        out.pendingAfterSelect, null);
    eq('§3 the home reply auto-navigates the pane', out.emitted, ['/home/sshdtest']);
    eq('§3 the pane lands on $HOME with its files',
        [out.path, out.files], ['/home/sshdtest', ['.bashrc']]);
    eq('§3 the visible path input shows $HOME', out.pathInput, '/home/sshdtest');
    check('§3 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §4 — the behaviour guard 1 must NOT break. Server-pushed refreshes (a
 * directory_created broadcast, another client's change) arrive without this pane
 * having asked for anything. A pane with no recorded intent accepts them; a pane
 * that has already settled on the directory it asked for still accepts an
 * unsolicited refresh OF THAT directory, because the path matches.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        // (a) a pane that never asked: seeded state, no pendingPath.
        fm.panes.left.type = 'ssh';
        fm.panes.left.sessionId = 's1';
        fm.panes.left.path = '/srv/data';
        fm.panes.left.pendingPath = null;
        fire('directory_listing', { session_id: 's1', path: '/srv/data',
            files: [{ name: 'a.bin', is_dir: false, size: 1 }] });
        const unsolicited = { path: fm.panes.left.path,
            files: fm.panes.left.files.map(f => f.name) };

        // (b) a pane that asked and settled: a later refresh of the SAME
        // directory must be applied, because it is not stale.
        fm.navigatePaneTo('left', '/srv/data');
        fire('directory_listing', { session_id: 's1', path: '/srv/data',
            files: [{ name: 'a.bin', is_dir: false, size: 1 },
                    { name: 'b.bin', is_dir: false, size: 2 }] });
        const refreshed = fm.panes.left.files.map(f => f.name);

        // (c) another session's reply is still ignored, unchanged behaviour.
        fire('directory_listing', { session_id: 's2', path: '/srv/data',
            files: [{ name: 'wrong.bin', is_dir: false, size: 9 }] });
        const afterOtherSession = fm.panes.left.files.map(f => f.name);
        return { unsolicited, refreshed, afterOtherSession };
    });
    eq('§4 an unsolicited listing is applied when nothing was requested',
        out.unsolicited, { path: '/srv/data', files: ['a.bin'] });
    eq('§4 a refresh of the requested directory is applied',
        out.refreshed, ['a.bin', 'b.bin']);
    eq('§4 a reply for a different session is still ignored',
        out.afterOtherSession, ['a.bin', 'b.bin']);
    check('§4 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §5 — switching source clears the intent. Guard 1 rejects replies whose path
 * differs from pendingPath, so a pendingPath carried over from the PREVIOUS
 * source would make the new source's first listing unacceptable and the pane
 * would never paint. This is the one way these guards could have introduced a
 * new permanent-blank defect, so it is asserted explicitly.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        document.getElementById('fmLeftSource').value = 'ssh:s1';
        fm.onSourceChange('left', 'ssh:s1');
        fm.navigatePaneTo('left', '/tmp/first');
        const beforeSwitch = fm.panes.left.pendingPath;

        // Switch to the other session before the first reply ever arrives.
        document.getElementById('fmLeftSource').value = 'ssh:s2';
        fm.onSourceChange('left', 'ssh:s2');
        const afterSwitch = fm.panes.left.pendingPath;

        // The new source's own listing must be accepted.
        fire('directory_listing', { session_id: 's2', path: '/',
            files: [{ name: 'etc', is_dir: true, size: 0 }] });
        const applied = { path: fm.panes.left.path,
            files: fm.panes.left.files.map(f => f.name),
            session: fm.panes.left.sessionId };

        // And the OLD source's late reply must not resurrect itself.
        fire('directory_listing', { session_id: 's1', path: '/tmp/first',
            files: [{ name: 'stale.txt', is_dir: false, size: 1 }] });
        return { beforeSwitch, afterSwitch, applied,
            afterStale: fm.panes.left.files.map(f => f.name) };
    });
    eq('§5 the first source recorded its intent', out.beforeSwitch, '/tmp/first');
    eq('§5 switching source clears the stale intent', out.afterSwitch, null);
    eq('§5 the new source\'s listing is accepted',
        out.applied, { path: '/', files: ['etc'], session: 's2' });
    eq('§5 the old source\'s late reply is ignored', out.afterStale, ['etc']);
    check('§5 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §6 — the whole live sequence, both panes, end to end. This is the shape
 * live_transfer_e2e drives: two sessions, both ends navigated immediately, all
 * four replies interleaved in the order the deployment produced them. Both panes
 * must end on their requested directories with their own files.
 */
{
    const { ctx, page, pageErrors } = await shell();
    const out = await page.evaluate(async () => {
        const fm = window.sftpFileManager;
        const fire = (evt, payload) => window.__socketFixture.__fire(evt, payload);

        document.getElementById('fmLeftSource').value = 'ssh:s1';
        fm.onSourceChange('left', 'ssh:s1');
        document.getElementById('fmRightSource').value = 'ssh:s2';
        fm.onSourceChange('right', 'ssh:s2');
        fm.navigatePaneTo('left', '/tmp/run-src');
        fm.navigatePaneTo('right', '/tmp/run-dst');

        // Interleaved exactly as the live log showed: a home reply, a stale
        // root, the wanted dirs, another home, another stale root.
        fire('home_directory', { session_id: 's2', path: '/home/sshdtest' });
        fire('directory_listing', { session_id: 's2', path: '/',
            files: [{ name: 'etc', is_dir: true, size: 0 }] });
        fire('directory_listing', { session_id: 's2', path: '/tmp/run-dst',
            files: [] });
        fire('home_directory', { session_id: 's1', path: '/home/sshdtest' });
        fire('directory_listing', { session_id: 's1', path: '/',
            files: [{ name: 'usr', is_dir: true, size: 0 }] });
        fire('directory_listing', { session_id: 's1', path: '/tmp/run-src',
            files: [{ name: 'artifact.txt', is_dir: false, size: 200000 }] });

        return {
            leftPath: fm.panes.left.path,
            rightPath: fm.panes.right.path,
            leftSession: fm.panes.left.sessionId,
            rightSession: fm.panes.right.sessionId,
            leftFiles: fm.panes.left.files.map(f => f.name),
            rightFiles: fm.panes.right.files.map(f => f.name),
            leftLoading: fm.panes.left.loading,
            rightLoading: fm.panes.right.loading,
        };
    });
    eq('§6 both panes end on their requested directories',
        [out.leftPath, out.rightPath], ['/tmp/run-src', '/tmp/run-dst']);
    eq('§6 each pane still holds its own session',
        [out.leftSession, out.rightSession], ['s1', 's2']);
    eq('§6 the source listing shows the real artifact',
        out.leftFiles, ['artifact.txt']);
    eq('§6 the destination listing is empty, not the root',
        out.rightFiles, []);
    check('§6 neither pane is left loading',
        out.leftLoading === false && out.rightLoading === false, JSON.stringify(out));
    check('§6 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
}

/*
 * §7 — static contracts. The guards are two conditions in two handlers; a
 * refactor that dropped either one while keeping the field would leave the
 * behavioural sections passing only by luck of timing in a fixture. These pin
 * the mechanism itself.
 */
{
    const src = fs.readFileSync(path.join(ROOT, 'static/js/sftp-file-manager.js'), 'utf8');
    check('§7 pane state carries pendingPath',
        /pendingPath:\s*null/.test(src), true);
    check('§7 guard 1 is in the directory_listing handler',
        src.includes('if (state.pendingPath !== null && data.path !== state.pendingPath)'),
        true);
    check('§7 guard 2 gates the home auto-landing on pendingPath',
        src.includes("if (state.path === '/' && state.pendingPath === null)"), true);
    check('§7 listings are requested through the one helper that records intent',
        src.includes('requestPaneListing(pane, sessionId, path)'), true);
    // onSourceChange must clear it, or §5 is only accidentally green.
    check('§7 onSourceChange voids the previous intent',
        /state\.pendingPath = null;/.test(src), true);
}

await browser.close();
server.close();

console.log('LISTING CORRELATION');
for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : `  (${r.detail})`}`);
}
const failed = results.filter(r => !r.ok);
console.log(`\ntotal=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length) {
    console.log('\nFAILURES');
    failed.forEach(r => console.log(`  ${r.label}${r.detail ? `: ${r.detail}` : ''}`));
}
process.exit(failed.length ? 1 : 0);
