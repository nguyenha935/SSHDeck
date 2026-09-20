/*
 * W13-A4 — legacy tmux locale UI indication, offline regression.
 *
 * Drives the REAL static/js/session-manager.js through the same socket payloads
 * the server sends (ssh_connected snapshot, ssh_session_restored,
 * ssh_reconnected) and reads the resulting DOM. The three tri-state legs of the
 * measurement each get their own leg:
 *
 *   1. snapshot propagation — createSession stores legacy_tmux_locale onto the
 *      session record verbatim (true / false / null / absent), and restoreSession
 *      carries it through sessionData.
 *   2. visible warning — an explicit `true` paints .legacy-locale on the chip
 *      and shows the .chip-locale-warning badge; the lifecycle detail line names
 *      the limitation.
 *   3. normal-session absence — `false`, `null`, and an absent key all keep the
 *      chip at its mockup shape: no .legacy-locale class, badge hidden, no
 *      annotation in the lifecycle detail. A measured-fine tmux session must not
 *      gain noise.
 *   4. reconnect swap — onReconnected absorbs a changed measurement and repaints
 *      the chip without creating a second badge (state-driven, not append-only).
 *
 * Geometry and responsive behaviour are judged by measuring the painted badge,
 * not by asserting on a class alone: a display:none badge reports zero width and
 * a visible one reports a real box, so a regression that forgot the CSS (or
 * applied it to the wrong scope) goes red.
 *
 * Run: node tests/browser/legacy_locale_warning.mjs   (from source/)
 * Exit 0 = all passed, 1 = a failure.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function startServer() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const fp = path.join(sourceRoot, rel);
        if (!fp.startsWith(sourceRoot) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

let passed = 0;
let failed = 0;

function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) {
        passed += 1;
        console.log(`PASS  ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}`
            + `\n      want ${JSON.stringify(want)}`);
    }
}

function atLeast(name, got, floor) {
    const ok = typeof got === 'number' && got >= floor;
    if (ok) {
        passed += 1;
        console.log(`PASS  ${name} (${got} >= ${floor})`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want >= ${floor}`);
    }
}

function equalTo(name, got, want) {
    if (got === want) {
        passed += 1;
        console.log(`PASS  ${name} (${JSON.stringify(got)})`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
    }
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

// Desktop viewport: style.css alone owns the chip paint here, and it is the
// stylesheet that owns .chip-locale-warning + .legacy-locale. deck.css is also
// loaded so the two files' cascade is exercised exactly as shipped.
await page.setContent(`<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="${base}/static/css/style.css">
    <link rel="stylesheet" href="${base}/static/css/deck.css">
</head><body>
    <div id="sessionBar"><div class="session-tabs-row">
        <div id="sessionTabs" class="session-tabs"></div>
    </div></div>
    <div id="terminalsContainer"></div>
    <div id="sessionActionsHeadingName"></div>
    <div id="sessionActionsHeadingDetail"></div>
    <span id="sessionActionsHeadingDot"></span>
</body></html>`, { waitUntil: 'load' });

await page.evaluate(() => {
    const noop = () => {};
    window.socket = {
        on: noop,
        emit: noop,
        connected: false,
    };
    window.TerminalManager = {
        isMobile: () => false,
        isTouchShell: () => false,
        terminals: {},
        createTerminal: noop,
        attachTerminal: noop,
        setupInputHandler: noop,
        destroyTerminal: noop,
        fitTerminal: noop, requestFit: noop, cancelPendingFit: noop,
        writeOutput: noop,
        focusTerminal: noop,
        /*
         * Same incomplete-stub defect already fixed in
         * tests/browser/mobile_reconnect_list.mjs: S16/S5 taught restoreSession to
         * learn the server's replay line cap BEFORE createSession builds the
         * terminal, and S17 FIX 6 added the interaction declaration to the
         * pane-activation path. Both are called unconditionally on the restore
         * route Leg 3 of this suite drives, so a stub missing either throws a
         * TypeError inside page.evaluate and the whole FILE dies part-way — this
         * suite reported 11 passes and then aborted with
         * "TerminalManager.noteServerReplayLines is not a function", losing every
         * later assertion silently rather than as a FAIL row.
         *
         * Stubs only. This suite is about the legacy-locale badge; the two
         * behaviours are pinned where they belong
         * (tests/browser/s16_d4_scrollback_restore.mjs and
         * tests/browser/s16_d3_visible_authority.mjs §I).
         */
        noteServerReplayLines: noop,
        // S16 F1-c added the same kind of unconditional pre-createSession
        // ingestion for the snapshot's DECLARED tmux mouse policy, and it
        // fails the same way when unstubbed. Behaviour pinned in
        // tests/browser/f1c_mouse_policy_reassert.mjs.
        noteTmuxMousePolicy: noop,
        reportInteraction: noop,
        reportVisibility: noop,
    };
    // i18n stub: returns the key so the DOM is inspectable without loading the
    // full translations file. Content parity of the six locales is pinned by
    // tests/test_i18n_parity.py instead.
    window.i18n = { t: key => key };
    window.showNotification = noop;
});

await page.addScriptTag({ url: `${base}/static/js/session-manager.js` });

check('harness loaded the real session-manager.js',
    await page.evaluate(() => typeof SessionManager === 'object'), true);

/* ── Leg 1: snapshot propagation — createSession stores the tri-state ────── */

function snapshot(over = {}) {
    return {
        session_id: 's1',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        use_tmux: true,
        tmux_session_name: 'sshdeck_prod',
        auth_type: 'key',
        key_id: 'k1',
        legacy_tmux_locale: true,
        ...over,
    };
}

// true
await page.evaluate(s => SessionManager.createSession(s), snapshot());
check('createSession(legacy:true) stores legacyTmuxLocale === true',
    await page.evaluate(() => SessionManager.sessions.s1.legacyTmuxLocale), true);

// false
await page.evaluate(s => SessionManager.createSession(s),
    snapshot({ session_id: 's2', legacy_tmux_locale: false }));
check('createSession(legacy:false) stores legacyTmuxLocale === false',
    await page.evaluate(() => SessionManager.sessions.s2.legacyTmuxLocale), false);

// null (non-tmux / unmeasured)
await page.evaluate(s => SessionManager.createSession(s),
    snapshot({ session_id: 's3', legacy_tmux_locale: null, use_tmux: false,
               tmux_session_name: null }));
check('createSession(legacy:null) stores legacyTmuxLocale === null',
    await page.evaluate(() => SessionManager.sessions.s3.legacyTmuxLocale), null);

// absent key (defensive: older payloads)
await page.evaluate(s => SessionManager.createSession(s),
    snapshot({ session_id: 's4', legacy_tmux_locale: undefined }));
check('createSession(legacy:absent) stores legacyTmuxLocale === null',
    await page.evaluate(() => SessionManager.sessions.s4.legacyTmuxLocale), null);

/* ── Leg 2: visible warning — explicit true paints the badge ─────────────── */

check('chip s1 carries .legacy-locale',
    await page.evaluate(() =>
        document.getElementById('tab-s1').classList.contains('legacy-locale')), true);
check('chip s1 has exactly ONE .chip-locale-warning badge',
    await page.evaluate(() =>
        document.querySelectorAll('#tab-s1 .chip-locale-warning').length), 1);
check('chip s1 badge has a translated aria-label',
    await page.evaluate(() =>
        document.querySelector('#tab-s1 .chip-locale-warning').getAttribute('aria-label')),
    'session.legacyTmuxLocale');
check('chip s1 badge has role=img (decorative, announced by label)',
    await page.evaluate(() =>
        document.querySelector('#tab-s1 .chip-locale-warning').getAttribute('role')), 'img');

const visibleBox = await page.evaluate(() => {
    const el = document.querySelector('#tab-s1 .chip-locale-warning');
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height,
             display: getComputedStyle(el).display };
});
atLeast('chip s1 badge is painted (width >= 12px)', visibleBox.width, 12);
atLeast('chip s1 badge is painted (height >= 12px)', visibleBox.height, 12);
equalTo('chip s1 badge computed display is flex', visibleBox.display, 'flex');

const badgeColour = await page.evaluate(() => {
    const el = document.querySelector('#tab-s1 .chip-locale-warning');
    return getComputedStyle(el).color;
});
check('chip s1 badge colour is not empty/transparent',
    badgeColour !== '' && badgeColour !== 'transparent', true);

// lifecycle detail annotation
await page.evaluate(() => {
    SessionManager.setLifecycleActionTarget('s1');
    SessionManager.renderLifecycleTarget();
});
check('lifecycle detail for s1 names the legacy limitation',
    await page.evaluate(() =>
        document.getElementById('sessionActionsHeadingDetail').textContent
            .includes('session.legacyTmuxLocaleShort')), true);

/* ── Leg 3: normal-session absence — no noise for false / null / absent ─── */

for (const sid of ['s2', 's3', 's4']) {
    check(`chip ${sid} has NO .legacy-locale class`,
        await page.evaluate(id =>
            !document.getElementById(`tab-${id}`).classList.contains('legacy-locale'),
            sid), true);
    const hiddenBox = await page.evaluate(id => {
        const el = document.querySelector(`#tab-${id} .chip-locale-warning`);
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        return { exists: true, width: r.width, height: r.height,
                 display: getComputedStyle(el).display };
    }, sid);
    check(`chip ${sid} badge exists in DOM but is hidden`,
        hiddenBox.exists && hiddenBox.display === 'none', true);
    equalTo(`chip ${sid} badge paints zero width`, hiddenBox.width, 0);
}

// lifecycle detail for a measured-fine session must NOT carry the annotation
await page.evaluate(() => {
    SessionManager.setLifecycleActionTarget('s2');
    SessionManager.renderLifecycleTarget();
});
check('lifecycle detail for s2 (measured fine) omits the legacy annotation',
    await page.evaluate(() =>
        !document.getElementById('sessionActionsHeadingDetail').textContent
            .includes('session.legacyTmuxLocaleShort')), true);

// lifecycle detail for an unmeasured non-tmux session must NOT carry it either
await page.evaluate(() => {
    SessionManager.setLifecycleActionTarget('s3');
    SessionManager.renderLifecycleTarget();
});
check('lifecycle detail for s3 (unmeasured) omits the legacy annotation',
    await page.evaluate(() =>
        !document.getElementById('sessionActionsHeadingDetail').textContent
            .includes('session.legacyTmuxLocaleShort')), true);

/* ── Leg 4: reconnect swap absorbs a changed measurement ─────────────────── */

// s2 measured fine, then a swap re-measures it as legacy: the badge appears.
await page.evaluate(() => {
    SessionManager.onReconnected({
        session_id: 's2',
        legacy_tmux_locale: true,
        tmux_session_name: 'sshdeck_prod',
    });
});
check('after reconnect swap s2.legacyTmuxLocale === true',
    await page.evaluate(() => SessionManager.sessions.s2.legacyTmuxLocale), true);
check('chip s2 gains .legacy-locale after the swap',
    await page.evaluate(() =>
        document.getElementById('tab-s2').classList.contains('legacy-locale')), true);
check('chip s2 still has exactly ONE badge after the swap',
    await page.evaluate(() =>
        document.querySelectorAll('#tab-s2 .chip-locale-warning').length), 1);

// swap back to false: the badge hides, class removed, still exactly one node.
await page.evaluate(() => {
    SessionManager.onReconnected({
        session_id: 's2',
        legacy_tmux_locale: false,
    });
});
check('after swap-back s2.legacyTmuxLocale === false',
    await page.evaluate(() => SessionManager.sessions.s2.legacyTmuxLocale), false);
check('chip s2 loses .legacy-locale after swap-back',
    await page.evaluate(() =>
        !document.getElementById('tab-s2').classList.contains('legacy-locale')), true);
check('chip s2 badge node count unchanged after swap-back (state-driven)',
    await page.evaluate(() =>
        document.querySelectorAll('#tab-s2 .chip-locale-warning').length), 1);

// a reconnect payload that omits the field leaves the prior measurement alone
await page.evaluate(() => {
    SessionManager.onReconnected({ session_id: 's2' });
});
check('onReconnected without the field preserves the prior measurement',
    await page.evaluate(() => SessionManager.sessions.s2.legacyTmuxLocale), false);

/* ── restoreSession carries the tri-state through sessionData ────────────── */

await page.evaluate(() => {
    SessionManager.restoreSession({
        session_id: 's5',
        host: 'restore.example.com',
        port: 22,
        username: 'deploy',
        auth_type: 'key',
        key_id: 'k9',
        use_tmux: true,
        tmux_session_name: 'sshdeck_restore',
        legacy_tmux_locale: true,
    });
});
check('restoreSession(legacy:true) stores legacyTmuxLocale === true',
    await page.evaluate(() => SessionManager.sessions.s5.legacyTmuxLocale), true);
check('restored chip s5 carries .legacy-locale',
    await page.evaluate(() =>
        document.getElementById('tab-s5').classList.contains('legacy-locale')), true);

await page.evaluate(() => {
    SessionManager.restoreSession({
        session_id: 's6',
        host: 'restore.example.com',
        port: 22,
        username: 'deploy',
        auth_type: 'key',
        key_id: 'k9',
        use_tmux: true,
        tmux_session_name: 'sshdeck_restore2',
        // no legacy_tmux_locale key at all (older snapshot)
    });
});
check('restoreSession with absent key stores legacyTmuxLocale === null',
    await page.evaluate(() => SessionManager.sessions.s6.legacyTmuxLocale), null);
check('restored chip s6 has NO .legacy-locale class',
    await page.evaluate(() =>
        !document.getElementById('tab-s6').classList.contains('legacy-locale')), true);

/* ── page-level sanity ───────────────────────────────────────────────────── */

check('no uncaught page errors', pageErrors.length, 0);

await browser.close();
await new Promise(r => server.close(r));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
