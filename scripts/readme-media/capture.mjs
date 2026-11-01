/*
 * The README's live screenshots, captured from a throwaway world.
 *
 * Starts the same disposable SSHDeck + OpenSSH container the live gates use
 * (tests/browser/live_world.mjs), plays the hand-off -- a build started on a
 * desktop, the desktop browser closed, the session picked up on a phone, the
 * desktop back -- and the touch screens, and writes raw PNGs to $OUT
 * (default: <tmpdir>/sshdeck-readme-media).
 * scripts/readme-media/compose.py turns them into the files under assets/.
 *
 *   node scripts/readme-media/capture.mjs        (from source/, needs Docker)
 *
 * Not a gate: it asserts nothing, and run_gates.mjs does not look here.
 */
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { W, login, connectSSH, attachExisting, settle, focusTerminal, onTarget } from '../../tests/browser/harness_live.mjs';

const OUT = process.env.OUT || path.join(os.tmpdir(), 'sshdeck-readme-media');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function device({ engine, width, height, touch, scale }) {
    const browser = await (engine === 'webkit' ? webkit : chromium).launch();
    const ctx = await browser.newContext({
        viewport: { width, height }, deviceScaleFactor: scale,
        hasTouch: touch, isMobile: engine === 'chromium' && touch,
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log(`pageerror ${engine}: ${e}`));
    return { browser, ctx, page };
}
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
const typeDesk = async (page, sid, text, settleMs = 1500) => {
    await focusTerminal(page, sid);
    await page.keyboard.type(text, { delay: 20 });
    await page.keyboard.press('Enter');
    await sleep(settleMs);
};
const assignPanes = async (page) => {
    const modal = page.locator('#paneAssignmentModal.show');
    if (!(await modal.count())) return 'no modal';
    const picked = await page.evaluate(() => {
        const selects = [...document.querySelectorAll('#paneAssignmentModal select')];
        const used = new Set();
        return selects.map((sel) => {
            const real = v => v && v !== '__empty__';
            if (real(sel.value) && !used.has(sel.value)) { used.add(sel.value); return sel.value; }
            const opt = [...sel.options].find(o => real(o.value) && !used.has(o.value));
            if (opt) { sel.value = opt.value; used.add(opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }
            return sel.value;
        });
    });
    await page.locator('#paneAssignmentModal button', { hasText: 'Apply' }).click();
    return picked;
};
const phoneDevice = () => device({ engine: 'webkit', width: 390, height: 844, touch: true, scale: 3 });
const deskDevice = () => device({ engine: 'chromium', width: 1280, height: 800, touch: false, scale: 2 });

onTarget(W, [
    'mkdir -p ~/shop-api/src ~/shop-api/logs',
    'printf "# shop-api\\n" > ~/shop-api/README.md',
    'printf "from flask import Flask\\napp = Flask(__name__)\\n" > ~/shop-api/src/app.py',
    'printf "#!/bin/sh\\necho \\"deploying shop-api v2.4.1\\"\\nsleep 1\\necho \\"done: 3 instances healthy\\"\\n" > ~/shop-api/deploy.sh',
    'chmod +x ~/shop-api/deploy.sh',
    'seq 1 40 | sed "s/^/GET \\/api\\/orders 200 /" > ~/shop-api/logs/access.log',
].join(' && '));

// 1. at the desk
let desk = await deskDevice();
await login(desk.page);
const sid = await connectSSH(desk.page);
await settle(desk.page, sid);
await sleep(1200);
await typeDesk(desk.page, sid, 'cd ~/shop-api && ls -la');
await typeDesk(desk.page, sid, 'for i in $(seq 1 25); do echo "build step $i of 25"; sleep 1; done', 4000);
await shot(desk.page, 'd1-desk-build');
const info = await desk.page.evaluate(s => ({ host: SessionManager.sessions[s].host, user: SessionManager.sessions[s].username }), sid);
await desk.browser.close();
await sleep(9000);

// 2. on the phone
let phone = await phoneDevice();
await login(phone.page);
const { sid: psid } = await attachExisting(phone.page, info);
await settle(phone.page, psid);
await sleep(2500);
await shot(phone.page, 'p1-phone-continues');
await sleep(12000);   // the build ends
await phone.page.locator('#mobileInput').tap();
await phone.page.locator('#mobileInput').pressSequentially('./deploy.sh', { delay: 40 });
await sleep(800);
await shot(phone.page, 'p2-phone-composer');
await phone.page.locator('#mobileSendBtn').click();
await sleep(2500);
await shot(phone.page, 'p3-phone-sent');
await phone.page.click('#mobileKeypadBtn').catch(e => console.log('keypad', e.message));
await sleep(700);
await shot(phone.page, 'p4-phone-keypad');
await phone.page.click('#mobileKeypadBtn').catch(() => {});
await sleep(500);

// a link, tapped
await phone.page.locator('#mobileInput').tap();
await phone.page.locator('#mobileInput').pressSequentially('echo "Release notes: https://github.com/nguyenha935/SSHDeck/releases"', { delay: 10 });
await phone.page.locator('#mobileSendBtn').click();
await sleep(1500);
await phone.page.evaluate(() => document.activeElement && document.activeElement.blur());
const at = await phone.page.evaluate((s) => {
    const key = (TerminalManager.sessionTerminals[s] || [])[0];
    const t = TerminalManager.terminals[key];
    const buf = t.buffer.active;
    const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
    for (let r = t.rows - 1; r >= 0; r--) {
        const text = buf.getLine(buf.viewportY + r)?.translateToString(true) || '';
        const c = text.indexOf('https://');
        if (c >= 0 && !text.includes('echo')) {
            return { x: box.left + (c + 6) * box.width / t.cols, y: box.top + (r + 0.5) * box.height / t.rows };
        }
    }
    return null;
}, psid);
console.log('link at', JSON.stringify(at));
if (at) { await phone.page.touchscreen.tap(at.x, at.y); await sleep(900); await shot(phone.page, 'p5-phone-link'); }
await phone.page.mouse.click(5, 300).catch(() => {});
await phone.page.keyboard.press('Escape').catch(() => {});
await sleep(500);

// Files, from the More sheet
await phone.page.click('#mobileMoreBtn');
await sleep(700);
const items = await phone.page.evaluate(() => [...document.querySelectorAll('#mobileMoreSheet button, #mobileMoreSheet [role=menuitem]')]
    .filter(b => b.getBoundingClientRect().height > 0).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')));
console.log('more items', JSON.stringify(items));
const files = phone.page.locator('#mobileMoreSheet button', { hasText: 'Files' }).first();
if (await files.count()) {
    await files.click();
    await sleep(2500);
    await shot(phone.page, 'p7-phone-files');
    await phone.page.click('#sftpPanelExpand').catch(e => console.log('expand', e.message));
    await sleep(2500);
    await shot(phone.page, 'p8-phone-files-browser');
}
await phone.browser.close();
await sleep(3000);

// 3. back at the desk
desk = await deskDevice();
await login(desk.page);
const back = await attachExisting(desk.page, info);
await settle(desk.page, back.sid);
await sleep(2500);
await shot(desk.page, 'd2-desk-back');

// 4. two servers side by side, files beside them
{
    const sid2 = await connectSSH(desk.page);
    await settle(desk.page, sid2);
    await sleep(1000);
    await typeDesk(desk.page, sid2, 'tail -n 30 ~/shop-api/logs/access.log', 1200);
    await desk.page.evaluate(() => document.querySelector('.split-btn[data-layout="2"][data-variant="default"]').click());
    await sleep(800);
    console.log('desk assign', JSON.stringify(await assignPanes(desk.page)));
    await sleep(2500);
    const panes = await desk.page.evaluate(() => [...document.querySelectorAll('.terminal-pane')]
        .map(p => `${Math.round(p.getBoundingClientRect().width)}x${Math.round(p.getBoundingClientRect().height)}`));
    console.log('desk panes', JSON.stringify(panes));
    await desk.page.locator('button', { hasText: 'Files' }).first().click();
    await sleep(2500);
    await shot(desk.page, 'd4-desk-split-files');
    await desk.browser.close();
    await sleep(2000);
    // portrait phones show the active pane only (owner ruling 2026-09-09); landscape shows both
    phone = await device({ engine: 'webkit', width: 844, height: 390, touch: true, scale: 3 });
    await login(phone.page);
    await sleep(6000);
    await phone.page.evaluate(() => document.querySelector('.split-btn[data-layout="2"][data-variant="default"]').click());
    await sleep(800);
    console.log('phone assign', JSON.stringify(await assignPanes(phone.page)));
    await sleep(3500);
    const ppanes = await phone.page.evaluate(() => [...document.querySelectorAll('.terminal-pane')]
        .map(p => `${Math.round(p.getBoundingClientRect().width)}x${Math.round(p.getBoundingClientRect().height)}`));
    console.log('phone panes', JSON.stringify(ppanes));
    await shot(phone.page, 'p9-phone-landscape-split');
    await phone.browser.close();
}
console.log('done', OUT);
process.exit(0);
