/*
 * Defect 1 + Defect 7 evidence: real screenshots of the DEPLOYED app at the two
 * viewports the owner named, plus the measured numbers behind them.
 *
 * For each viewport it prints: viewport width, the shell (.deck-window) width,
 * and the four gutters (left / top / right / bottom) measured from the live
 * layout -- so "the gutters are too big" can be checked against numbers rather
 * than an impression. Page errors and failed requests are counted for the same
 * run, because a screenshot of a broken page is not evidence of a fixed one.
 *
 * Credentials come from the live credentials file (never in git). A fresh account
 * is registered per run so restored sessions cannot change the layout.
 * Run: node tests/browser/live_shell_metrics.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { liveCreds, CREDS_FILE } from './live_creds.mjs';
import { liveConfig } from './live_creds.mjs';

const BASE = liveConfig().LIVE_BASE;
const OUT = process.env.LIVE_SHOT_DIR || '/tmp/live-shots';
const creds = liveCreds();
const RUN = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });

const rows = [];
const browser = await chromium.launch();

for (const vp of [
    { name: 'desktop1440', width: 1440, height: 900, touch: false },
    { name: 'phone390', width: 390, height: 844, touch: true },
]) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.touch, isMobile: vp.touch, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    const requestFailures = [];
    const httpErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('requestfailed', r => requestFailures.push(
        `${r.method()} ${r.url()}: ${r.failure()?.errorText}`));
    page.on('response', r => {
        if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
    });

    const user = `${creds.sshdeck_user}m${vp.name.slice(0, 3)}${RUN}`;
    await page.goto(`${BASE}/register`, { waitUntil: 'load' });
    await page.locator('#username').fill(user);
    await page.locator('#password').fill(creds.sshdeck_password);
    await page.locator('#confirm_password').fill(creds.sshdeck_password);
    await page.locator('#submitBtn').click();
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 15000 });
    await page.waitForTimeout(900);

    const metrics = await page.evaluate(() => {
        const deck = document.getElementById('deckWindow')
            || document.querySelector('.deck-window');
        const r = deck.getBoundingClientRect();
        const cs = getComputedStyle(deck);
        const header = document.querySelector('.header');
        const composer = document.getElementById('sessionBar');
        return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            shellWidth: Math.round(r.width * 100) / 100,
            shellHeight: Math.round(r.height * 100) / 100,
            gutterLeft: Math.round(r.left * 100) / 100,
            gutterTop: Math.round(r.top * 100) / 100,
            gutterRight: Math.round((window.innerWidth - r.right) * 100) / 100,
            gutterBottom: Math.round((window.innerHeight - r.bottom) * 100) / 100,
            border: [cs.borderTopWidth, cs.borderRightWidth,
                cs.borderBottomWidth, cs.borderLeftWidth].join('/'),
            radius: cs.borderTopLeftRadius,
            headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
            composerVisible: !!(composer && composer.offsetParent !== null),
        };
    });

    const file = `${OUT}/${vp.name}-shell.png`;
    await page.screenshot({ path: file });
    const bytes = fs.statSync(file).size;
    rows.push({
        name: vp.name, ...metrics, file, bytes,
        pageErrors: pageErrors.length,
        requestFailures: requestFailures.length,
        httpErrors: httpErrors.length,
        errorDetail: [...pageErrors.slice(0, 2), ...requestFailures.slice(0, 2),
            ...httpErrors.slice(0, 2)].join(' | '),
    });
    await ctx.close();
}

await browser.close();

console.log('\nLIVE SHELL METRICS (deployed app)');
for (const r of rows) {
    console.log(`${r.name}: viewport=${r.viewportWidth}x${r.viewportHeight} `
        + `shellWidth=${r.shellWidth} gutters L/T/R/B=`
        + `${r.gutterLeft}/${r.gutterTop}/${r.gutterRight}/${r.gutterBottom} `
        + `border=${r.border} radius=${r.radius} header=${r.headerHeight} `
        + `composer=${r.composerVisible} shot=${r.file} (${r.bytes}B) `
        + `pageErrors=${r.pageErrors} failedRequests=${r.requestFailures} `
        + `http>=400=${r.httpErrors}${r.errorDetail ? ` [${r.errorDetail}]` : ''}`);
}
const bad = rows.filter(r => r.pageErrors || r.requestFailures || r.httpErrors);
console.log(`\nshots=${rows.length} clean=${rows.length - bad.length} dirty=${bad.length}`);
if (bad.length) process.exitCode = 1;
