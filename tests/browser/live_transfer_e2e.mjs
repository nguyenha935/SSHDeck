/*
 * LIVE File Transfer end-to-end against the RUNNING deployment.
 *
 * Real login, two real SSH sessions, a real server-to-server copy of a real file
 * through the real SSH EXEC-CHANNEL transport, verified by hash on the
 * destination side. Nothing about the transfer is stubbed.
 *
 * NO SKIP PATH EXISTS IN THIS HARNESS. The previous
 * version reported SKIP when directory listing failed, because listing went
 * through SFTP and this host's sshd has no `Subsystem sftp`. Production no
 * longer requests that subsystem for File Transfer: listing, home resolution and
 * the copy itself all run over exec channels on the two authenticated sessions.
 * A listing or transfer failure is therefore a REAL product failure and must
 * turn this gate red.
 *
 * SCOPE LIMITATION, stated up front because it bounds what this proves.
 * The environment has exactly ONE reachable configured SSH target (the host's
 * own sshd, via the live credentials file). A server-to-server transfer needs two
 * DISTINCT sessions, which this harness creates -- two independent SSH sessions,
 * two independent exec channel sets, two independent session ids -- but both land
 * on the same machine. So this exercises the whole protocol and the whole exec
 * transport (two sessions, source cat stream, destination receiver, sha256+size
 * verification, temp file, atomic rename, progress, terminal state, registry
 * ownership) while NOT proving cross-machine reachability.
 *
 * The server's own same-host guard compares SESSION ids, not hostnames, so two
 * sessions to one host are a legitimate transfer and are not refused. That is a
 * real property of the contract, not a workaround.
 *
 * SAFETY: the only file written is a uniquely named artifact under /tmp, created
 * by this harness, and it is the only thing removed at the end. No secret is
 * printed; credentials are read from a file outside the repo.
 *
 * Run: node tests/browser/live_transfer_e2e.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

const BASE = liveConfig().LIVE_BASE;
const NOTES = 'the live credentials file';

const creds = liveCreds();
const SSH_HOST = creds.ssh_target || creds.tailnet_host;
const SSH_USER = creds.host_ssh_user;
const SSH_PASS = creds.host_ssh_password;
const SSHDECK_PASS = creds.sshdeck_password;
const RUN = Date.now().toString(36);
const SSHDECK_USER = `${creds.sshdeck_user}t${RUN}`;
if (!SSH_HOST || !SSH_USER || !SSH_PASS || !SSHDECK_PASS) {
    throw new Error(`incomplete credentials in ${CREDS_FILE}`);
}

/* The single artifact this run creates, named so it cannot collide with
 * anything and can be identified unambiguously for cleanup. */
const STAMP = `sshdeck-ft-e2e-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
const SRC_DIR = `/tmp/${STAMP}-src`;
const DST_DIR = `/tmp/${STAMP}-dst`;
const FILE = `${STAMP}.txt`;
const SRC_PATH = `${SRC_DIR}/${FILE}`;
const DST_PATH = `${DST_DIR}/${FILE}`;

const results = [];
const check = (label, ok, detail = '') => {
    results.push({ label, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
};
const eq = (label, got, want) => check(label,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false,
});
const page = await ctx.newPage();
const pageErrors = [];
const failedRequests = [];
const httpErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('requestfailed', r => failedRequests.push(r.url()));
page.on('response', r => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`); });

let cleanupSession = null;

async function shellExec(sessionId, command, expect = null) {
    /* Runs a command in a real terminal and returns the buffer text. Used for
     * fixture setup and hash verification -- i.e. for OBSERVING the filesystem,
     * never for performing the transfer itself.
     *
     * S25 R4 -- WAIT FOR THE MARKER, NOT FOR A FIXED 1200ms.
     *
     * A flat sleep is a bet on how fast the remote answers, and it lost in the
     * 101-gate sweep: the cleanup row reported red with the tmux status line as
     * its only evidence (`eck_s0:bash* "tiny-server" 20:53`), i.e. the buffer
     * had simply not been painted with the command's own output yet. The same
     * gate scored 34/34 run alone on an idle box. That makes the red a harness
     * timing artefact, and a gate must measure the product, not the load on the
     * box.
     *
     * The ASSERTION IS UNCHANGED: callers still regex the same marker out of the
     * same buffer text. Only the wait becomes a bounded poll for that marker,
     * with the original 1200ms as the floor so a caller passing no marker
     * behaves exactly as before. If the marker never arrives, the buffer is
     * returned anyway and the caller's own assertion fails -- the row can still
     * go red for a real reason.
     */
    await page.evaluate(({ sid, cmd }) => {
        window.socket.emit('ssh_input', { session_id: sid, data: `${cmd}\n` });
    }, { sid: sessionId, cmd: command });
    const readBuffer = () => page.evaluate(sid => {
        const buf = window.TerminalManager?.terminals?.[sid]?.buffer?.active;
        if (!buf) return '';
        const out = [];
        for (let i = 0; i < buf.length; i += 1) {
            out.push(buf.getLine(i)?.translateToString(true) || '');
        }
        return out.join('\n');
    }, sessionId);
    await page.waitForTimeout(1200);
    let text = await readBuffer();
    if (expect) {
        for (let i = 0; i < 24 && !expect.test(text); i += 1) {
            await page.waitForTimeout(500);
            text = await readBuffer();
        }
    }
    return text;
}

async function connect(host, port, user, pass) {
    const before = await page.evaluate(() => Object.keys(SessionManager.sessions));
    await page.locator('#newConnectionBtn').click();
    await page.locator('#connectionModal').waitFor({ state: 'visible' });
    await page.locator('#hostInput').fill(host);
    await page.locator('#portInput').fill(String(port));
    await page.locator('#usernameInput').fill(user);
    await page.locator('#authTypeSelect').selectOption('password');
    await page.locator('#passwordInput').fill(pass);
    await page.locator('#connectBtn').click();
    await page.waitForFunction(prev => {
        const now = Object.keys(SessionManager.sessions);
        return now.some(id => !prev.includes(id));
    }, before, { timeout: 25000 });
    await page.waitForTimeout(1500);
    return page.evaluate(prev =>
        Object.keys(SessionManager.sessions).find(id => !prev.includes(id)), before);
}

try {
    // ── register a fresh account so no restored session pollutes the test ────
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#username').fill(SSHDECK_USER);
    await page.locator('#password').fill(SSHDECK_PASS);
    await page.locator('#confirm_password').fill(SSHDECK_PASS);
    await page.locator('#submitBtn').click();
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined' && !!window.socket,
    null, { timeout: 20000 });
    check('live: a fresh account reaches the app shell', true);

    // ── two DISTINCT real SSH sessions ───────────────────────────────────────
    const sessionA = await connect(SSH_HOST, 22, SSH_USER, SSH_PASS);
    const sessionB = await connect(SSH_HOST, 22, SSH_USER, SSH_PASS);
    cleanupSession = sessionA;
    check('live: two real SSH sessions exist', !!sessionA && !!sessionB,
        `A=${sessionA} B=${sessionB}`);
    check('live: the two sessions are distinct', sessionA !== sessionB,
        `A=${sessionA} B=${sessionB}`);

    // ── create the one artifact, and record its hash ─────────────────────────
    const setup = await shellExec(sessionA,
        `mkdir -p ${SRC_DIR} ${DST_DIR} && `
        + `head -c 200000 /dev/urandom | base64 > ${SRC_PATH} && `
        + `echo SRCSUM:$(sha256sum ${SRC_PATH} | cut -d' ' -f1) && `
        + `echo SRCSIZE:$(stat -c%s ${SRC_PATH})`,
        /SRCSIZE:\d+/);
    const srcSum = (setup.match(/SRCSUM:([0-9a-f]{64})/) || [])[1];
    const srcSize = (setup.match(/SRCSIZE:(\d+)/) || [])[1];
    check('live: the source artifact was created and hashed',
        !!srcSum && Number(srcSize) > 100000, `size=${srcSize}`);

    // Destination must not exist yet, so a pass cannot come from a stale file.
    const preState = await shellExec(sessionA,
        `test -e ${DST_PATH} && echo DST:EXISTS || echo DST:ABSENT`,
        /DST:(EXISTS|ABSENT)/);
    check('live: the destination does not exist before the transfer',
        /DST:ABSENT/.test(preState), preState.slice(-200));

    // ── open the GLOBAL dual-pane surface through the production control ─────
    await page.locator('#accountBtnHeader').click();
    await page.waitForTimeout(200);
    await page.locator('#fileTransferOpenBtn').click();
    await page.waitForFunction(() => !!window.sftpFileManager
        && document.getElementById('sftpFileManager')?.classList.contains('show'),
    null, { timeout: 10000 });
    await page.waitForTimeout(400);
    const surface = await page.evaluate(() => {
        const m = document.getElementById('sftpFileManager');
        return {
            transferMode: m.classList.contains('fm-transfer-mode'),
            title: document.querySelector('#fmModalTitle [data-i18n]')?.textContent.trim(),
            activePane: window.sftpFileManager.activePane,
        };
    });
    check('live: the global dual-pane surface opened', surface.transferMode,
        JSON.stringify(surface));
    eq('live: it is titled File Transfer', surface.title, 'File Transfer');
    eq('live: the Source end is selected on open', surface.activePane, 'left');

    // ── select Source = session A, Destination = session B, via production ───
    const selected = await page.evaluate(async ({ a, b, srcDir, dstDir }) => {
        const fm = window.sftpFileManager;
        document.getElementById('fmLeftSource').value = `ssh:${a}`;
        fm.onSourceChange('left', `ssh:${a}`);
        document.getElementById('fmRightSource').value = `ssh:${b}`;
        fm.onSourceChange('right', `ssh:${b}`);
        // Wait for BOTH panes to actually carry their session, not a fixed delay.
        for (let i = 0; i < 100; i += 1) {
            if (fm.panes.left.sessionId === a && fm.panes.right.sessionId === b) break;
            await new Promise(r => setTimeout(r, 200));
        }
        // Navigate each end to its directory through the production path input.
        /*
         * navigatePaneTo is the production navigation entry point, but for an SSH
         * pane it only EMITS list_directory -- the listing arrives later on a
         * socket event, so awaiting the call proves nothing. Wait on the pane's
         * actual state instead of a fixed delay, which was racing the response.
         */
        const settled = async (paneKey, wanted) => {
            for (let i = 0; i < 100; i += 1) {
                const st = fm.panes[paneKey];
                if (st.path === wanted && !st.loading) return true;
                await new Promise(r => setTimeout(r, 200));
            }
            return false;
        };
        fm.navigatePaneTo('left', srcDir);
        fm.navigatePaneTo('right', dstDir);
        const okLeft = await settled('left', srcDir);
        const okRight = await settled('right', dstDir);
        if (!okLeft || !okRight) {
            return { navTimeout: true, okLeft, okRight,
                     leftPath: fm.panes.left.path, rightPath: fm.panes.right.path };
        }
        return {
            leftSession: fm.panes.left.sessionId,
            rightSession: fm.panes.right.sessionId,
            leftPath: fm.panes.left.path,
            rightPath: fm.panes.right.path,
            leftFiles: fm.panes.left.files.map(f => f.name),
        };
    }, { a: sessionA, b: sessionB, srcDir: SRC_DIR, dstDir: DST_DIR });
    /*
     * NO PREFLIGHT ESCAPE. Listing runs over exec channels, which work on this
     * host with SFTP still disabled, so a navigation timeout is a real defect in
     * the exec listing protocol and is reported as a FAILURE. The old SKIP branch
     * was deleted deliberately; if this assertion is red, the product is broken.
     */
    check('live: both ends navigated to their directories',
        !selected.navTimeout, JSON.stringify(selected));
    eq('live: LEFT pane holds the Source session', selected.leftSession, sessionA);
    eq('live: RIGHT pane holds the Destination session', selected.rightSession, sessionB);
    check('live: the Source listing shows the real artifact',
        selected.leftFiles.includes(FILE),
        JSON.stringify(selected.leftFiles.slice(0, 8)));

    // ── the real transfer, driven by the production Transfer action ──────────
    const transfer = await page.evaluate(async (name) => {
        const fm = window.sftpFileManager;
        const index = fm.panes.left.files.findIndex(f => f.name === name);
        fm.panes.left.selected = new Set([index]);
        const emitted = [];
        const origEmit = window.socket.emit.bind(window.socket);
        window.socket.emit = function (evt, payload, ack) {
            if (evt === 'transfer_server_to_server') emitted.push(payload);
            return origEmit(evt, payload, ack);
        };
        const started = Date.now();
        await fm.executeTransfer();
        window.socket.emit = origEmit;
        const row = fm.transferQueue[fm.transferQueue.length - 1];
        return {
            emitted,
            elapsed: Date.now() - started,
            rowId: row?.id,
            rowStatus: row?.status,
            rowProgress: row?.progress,
            rowType: row?.type,
            queueLength: fm.transferQueue.length,
        };
    }, FILE);

    eq('live: exactly one transfer was requested', transfer.emitted.length, 1);
    check('live: the client sent NO transfer_id',
        !('transfer_id' in (transfer.emitted[0] || {})),
        JSON.stringify(transfer.emitted[0]));
    eq('live: the payload names the Source session',
        transfer.emitted[0]?.source_session_id, sessionA);
    eq('live: the payload names the Destination session',
        transfer.emitted[0]?.dest_session_id, sessionB);
    eq('live: the payload copies FROM the source path',
        transfer.emitted[0]?.source_path, SRC_PATH);
    eq('live: the payload copies TO the destination path',
        transfer.emitted[0]?.dest_path, DST_PATH);
    check('live: the row adopted a SERVER-issued id',
        typeof transfer.rowId === 'string' && transfer.rowId.length >= 20
        && !String(transfer.rowId).startsWith('s2s_'),
        `id=${transfer.rowId}`);
    eq('live: the row is an s2s row', transfer.rowType, 's2s');
    eq('live: the row reached complete', transfer.rowStatus, 'complete');
    eq('live: the row shows 100%', transfer.rowProgress, 100);

    // ── VERIFY THE BYTES ON THE DESTINATION ─────────────────────────────────
    const verify = await shellExec(sessionA,
        `echo DSTSUM:$(sha256sum ${DST_PATH} 2>/dev/null | cut -d' ' -f1) && `
        + `echo DSTSIZE:$(stat -c%s ${DST_PATH} 2>/dev/null) && `
        + `echo TMPLEFT:$(ls ${DST_DIR} | grep -c sshdeck-transfer || true)`,
        /TMPLEFT:\d+/);
    const dstSum = (verify.match(/DSTSUM:([0-9a-f]{64})/) || [])[1];
    const dstSize = (verify.match(/DSTSIZE:(\d+)/) || [])[1];
    const tmpLeft = (verify.match(/TMPLEFT:(\d+)/) || [])[1];
    check('live: the destination file exists', !!dstSum, verify.slice(-200));
    eq('live: the destination SIZE matches the source', dstSize, srcSize);
    check('live: the destination HASH matches the source byte for byte',
        !!dstSum && dstSum === srcSum, `src=${srcSum?.slice(0, 16)} dst=${dstSum?.slice(0, 16)}`);
    eq('live: no temporary transfer file was left behind', tmpLeft, '0');

    // ── same-host SESSION guard: transferring onto itself is refused ─────────
    const sameSession = await page.evaluate(async (srcPath) => {
        const fm = window.sftpFileManager;
        const before = fm.transferQueue.length;
        const returned = await fm.transferSSHtoSSH(srcPath,
            { sessionId: fm.panes.left.sessionId }, `${srcPath}.copy`,
            { sessionId: fm.panes.left.sessionId },
            { name: 'x', is_dir: false, size: 1 });
        return { returned, added: fm.transferQueue.length - before };
    }, SRC_PATH);
    eq('live: a same-session transfer is refused', sameSession.returned, null);
    eq('live: a refused transfer queues no row', sameSession.added, 0);

    // ── cancel path: a cancel for an already-finished transfer must be refused
    const staleCancel = await page.evaluate((id) => new Promise(resolve => {
        window.socket.emit('cancel_transfer', { transfer_id: id },
            ack => resolve(ack));
        setTimeout(() => resolve({ timeout: true }), 5000);
    }), transfer.rowId);
    check('live: cancelling a completed transfer is refused by the server',
        staleCancel && staleCancel.success === false, JSON.stringify(staleCancel));

    const foreignCancel = await page.evaluate(() => new Promise(resolve => {
        window.socket.emit('cancel_transfer',
            { transfer_id: 'definitely-not-a-real-transfer-id' },
            ack => resolve(ack));
        setTimeout(() => resolve({ timeout: true }), 5000);
    }));
    check('live: cancelling an unknown id gets the same refusal (no oracle)',
        foreignCancel && foreignCancel.success === false,
        JSON.stringify(foreignCancel));

    // ── the surface is clean ─────────────────────────────────────────────────
    eq('live: no page errors', pageErrors.slice(0, 3), []);
    eq('live: no failed requests', failedRequests.slice(0, 3), []);
    eq('live: no HTTP >= 400', httpErrors.slice(0, 3), []);
} catch (error) {
    // Every throw is a real failure: there is no environmental escape hatch.
    check('live: harness completed without throwing', false,
        String(error).slice(0, 300));
} finally {
    // ── clean up ONLY this run's artifacts ──────────────────────────────────
    if (cleanupSession) {
        try {
            const cleaned = await shellExec(cleanupSession,
                `rm -rf ${SRC_DIR} ${DST_DIR} && `
                + `test -e ${SRC_DIR} -o -e ${DST_DIR} && echo CLEAN:NO || echo CLEAN:YES`,
                /CLEAN:(YES|NO)/);
            check('live: only this run\'s temp artifacts were removed',
                /CLEAN:YES/.test(cleaned), cleaned.slice(-160));
        } catch (error) {
            check('live: cleanup ran', false, String(error).slice(0, 160));
        }
    }
    await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\nartifact prefix: ${STAMP} (removed)`);
/*
 * A run that reaches fewer assertions than the full lifecycle produces is not a
 * pass. The floor is asserted so an early `throw` cannot yield "0 failed" on a
 * handful of setup checks and read as green.
 */
const MIN_EXPECTED_CHECKS = 24;
if (results.length < MIN_EXPECTED_CHECKS) {
    console.log(`INCOMPLETE: only ${results.length} checks ran, expected at least `
        + `${MIN_EXPECTED_CHECKS} for the full live lifecycle`);
    process.exitCode = 1;
}
console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length) {
    console.log('FAILURES');
    failed.forEach(f => console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`));
    process.exitCode = 1;
}
