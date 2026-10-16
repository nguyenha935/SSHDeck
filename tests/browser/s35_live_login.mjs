/*
 * S35 P90 -- log in to the account the throwaway world made (live_world.mjs),
 * rather than registering one per suite.
 */
import { chromium } from 'playwright';
import { liveWorld, liveConfig } from './live_world.mjs';

export const C = liveConfig(await liveWorld());
export const BASE = C.LIVE_BASE;

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
    const user = C.LIVE_USER;
    const pass = C.LIVE_PASS;
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
