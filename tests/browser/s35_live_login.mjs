/*
 * S35 P90 -- THE LIVE LOGIN HARNESS the owner asked for.
 *
 * Every existing "live" suite registers a NEW account through /register and then
 * waits for a readiness predicate; on the deployed build that wait times out and
 * the suite dies before it measures anything. Classifying that as harmless was
 * wrong: it is the reason there is no live evidence for any of the six defects.
 *
 * This module logs in to an EXISTING account instead. Credentials come from the
 * environment (never printed), so no registration loop and no secrets in output.
 *
 *     LIVE_USER=... LIVE_PASS=... node <suite>.mjs
 */
import { chromium } from 'playwright';
import { liveConfig } from './live_creds.mjs';

export const BASE = liveConfig().LIVE_BASE;

export async function launch({ width, height, touch }) {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
        viewport: { width, height }, hasTouch: !!touch, isMobile: !!touch,
        deviceScaleFactor: 1, ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    return { browser, ctx, page, pageErrors };
}

/* Log in and land on the terminal shell. Returns nothing; throws on failure so a
 * suite can never silently measure a login page. */
export async function login(page) {
    const user = process.env.LIVE_USER;
    const pass = process.env.LIVE_PASS;
    if (!user || !pass) {
        throw new Error('LIVE_USER / LIVE_PASS must be set in the environment');
    }
    await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 45000 });
    await page.fill('#username', user);
    await page.fill('#password', pass);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }),
        page.click('button[type="submit"]'),
    ]);
    const url = page.url();
    if (/\/login/.test(url)) {
        // Read the visible flash so a failure names itself -- without echoing
        // anything that could carry a credential.
        const flash = await page.evaluate(() => {
            const el = document.querySelector('.flash, .alert, [role="alert"]');
            return el ? el.textContent.trim().slice(0, 120) : '(no flash shown)';
        });
        throw new Error(`login did not leave /login -- page says: ${flash}`);
    }
    await page.waitForFunction(() => typeof SessionManager !== 'undefined'
        && typeof TerminalManager !== 'undefined', null, { timeout: 30000 });
    await page.waitForFunction(() => document.readyState === 'complete',
        null, { timeout: 30000 });
}

/* The sessions this account already has open, by id. Never creates one. */
export async function existingSessions(page) {
    return await page.evaluate(() => {
        const out = [];
        const s = SessionManager.sessions || {};
        for (const id of Object.keys(s)) {
            out.push({
                id,
                connected: !!s[id].connected,
                candidate: !!s[id].isPersistentCandidate,
                name: s[id].display_name || null,
            });
        }
        return out;
    });
}

export const check = (state) => (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { state.pass++; console.log(`PASS  ${label}`); }
    else {
        state.fail++; state.failures.push(label);
        console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
};
export const num = (l, v) => console.log(`      ${l} = ${JSON.stringify(v)}`);
