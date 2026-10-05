#!/usr/bin/env node
/*
 * CHECKBOX ROWS AND TEXT FIELDS IN THE APP'S DIALOGS, ON TOUCH AND DESKTOP.
 *
 * Two defects in style.css, measured 2026-10-05 before the fix:
 *
 *   1. `.form-group label` (0,1,1) is the rule for a field's caption --
 *      display:block, a bottom margin -- and it outranked `.checkbox-label`'s
 *      flex (0,1,0). Box and text were laid out as inline text, so where the
 *      box is 44 px tall (touch, and any window under 768 px) the text sat at
 *      the bottom of it: #useTmuxCheck's row 63 px, the text's centre 17.5 px
 *      below the box's. The same for every .checkbox-label and .radio-label in
 *      a form group: connection, profile editor, jump host, SFTP quick connect.
 *      Settings had its own copy of the fix in deck.css; it now has none.
 *   2. Fields reached 44 px and 16 px only below 768 px. A phone held
 *      landscape (844x390) and a tablet are touch but wider: 38 px at 14 px.
 *      16 px matters because iOS zooms the page in on focusing a smaller
 *      field -- documented iOS behaviour, not measured on a device here.
 *
 *   §1 every checkbox and radio in the dialogs has its text beside it and
 *      centred on it, and the text is inside the label's hit box
 *   §2 on touch a checkbox or radio row is the 44 px box itself
 *   §3 the rows start on the column's edge, under the captions and hints,
 *      and the row's press background stays inside the dialog body
 *   §4 every field: 44 px at 16 px on touch and under 768 px; desktop keeps
 *      its 14 px field
 *   §Z no page errors
 *
 * Conditional groups (profile name, saved-command parameters, key pickers)
 * are revealed so that every field is measured.
 *
 * Run: node tests/browser/form_controls.mjs [--shots DIR]   (from source/)
 *      --shots writes a PNG of the measured rows per engine and viewport.
 */
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
};

function renderTemplate() {
    let html = fs.readFileSync(path.join(ROOT, 'templates/index.html'), 'utf8');
    html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1');
    html = html.replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1');
    html = html.replace(/\{%[^%]*%\}/g, '');
    html = html.replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]');
    html = html.replace(/\{\{\s*theme(\s*\|\s*default\([^)]*\))?\s*\}\}/g, 'glass');
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
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
        res.end(fs.readFileSync(fp));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const VIEWPORTS = [
    { name: '390x844 touch', width: 390, height: 844, touch: true },
    { name: '844x390 touch', width: 844, height: 390, touch: true },
    { name: '820x1180 touch', width: 820, height: 1180, touch: true },
    { name: '700x900 mouse', width: 700, height: 900, touch: false },
    { name: '1440x900 mouse', width: 1440, height: 900, touch: false },
];

// Every dialog with a checkbox, a radio or a .form-control. The SFTP quick
// connect dialog is built by SFTPFileManager, so the page builds one; Settings
// keeps its administrator's section, as Jinja renders it for one.
const DIALOGS = ['connectionModal', 'profileManagementModal', 'keyManagementModal',
    'commandSetsModal', 'jumpHostManagementModal', 'fileTransferModal', 'commandFormModal',
    'commandPaletteModal', 'dropUploadModal', 'fmQuickConnectModal', 'settingsModal'];

// The first row of each group: its box belongs on the column's left edge.
const FIRST_IN_ROW = ['useTmuxCheck', 'saveProfileCheck', 'profileEditorUseDefaultParameters',
    'jhAuthType=password', 'fmQcAuth=password', 'osAll', 'commandSetUseSudoInput',
    'perfProbeToggle'];

const pageErrors = [];

function measure(dialogs) {
    const box = (el) => el.getBoundingClientRect();
    const shown = (el) => {
        const r = box(el);
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    // The text's own rects, from its text nodes: a label's box would include
    // the input and the padding.
    const textBox = (label) => {
        const rects = [];
        const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            rects.push(...[...range.getClientRects()].filter(r => r.width > 0));
        }
        if (!rects.length) return null;
        return {
            top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)),
            left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)),
        };
    };
    try { window.__fm = window.__fm || new window.SFTPFileManager(); } catch (e) { /* missing below */ }
    const rows = [];
    const fields = [];
    const missing = [];
    for (const id of dialogs) {
        document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
        const dialog = document.getElementById(id);
        if (!dialog) { missing.push(id); continue; }
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
        dialog.querySelectorAll('.hidden').forEach(el => el.classList.remove('hidden'));
        for (const input of dialog.querySelectorAll('input[type=checkbox], input[type=radio]')) {
            if (!shown(input)) continue;
            const label = input.closest('label');
            const key = input.id || `${input.name}=${input.value}`;
            if (!label) { rows.push({ key, dialog: id, label: false }); continue; }
            input.scrollIntoView({ block: 'center' });
            const b = box(input);
            const l = box(label);
            const t = textBox(label);
            const column = input.closest('.form-group, .command-set-sudo-option');
            const body = input.closest('.modal-body');
            const hit = t && document.elementFromPoint((t.left + t.right) / 2, (t.top + t.bottom) / 2);
            rows.push({
                key, dialog: id, label: true,
                component: label.matches('.checkbox-label, .radio-label'),
                beside: !!t && t.left >= b.right - 0.5,
                offCentre: t ? Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2) : null,
                textHits: !!hit && hit.closest('label') === label,
                height: Math.round(l.height * 10) / 10,
                fromColumn: column ? Math.round(b.left - box(column).left) : null,
                inBody: !body || (l.left >= box(body).left - 0.5 && l.right <= box(body).right + 0.5),
            });
        }
        for (const el of dialog.querySelectorAll('.form-control')) {
            if (!shown(el)) continue;
            fields.push({
                key: `${id}#${el.id || el.className}`,
                height: Math.round(box(el).height * 10) / 10,
                fontSize: getComputedStyle(el).fontSize,
            });
        }
        dialog.classList.remove('show');
    }
    return { rows, fields, missing };
}

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    for (const vp of VIEWPORTS) {
        const label = `${engineName} ${vp.name}`;
        const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            ...(vp.touch ? { hasTouch: true, isMobile: true } : {}),
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(5000);
        page.on('pageerror', e => pageErrors.push(`${label}: ${e.message}`));
        await page.goto(`${base}/`, { waitUntil: 'load' });
        await page.addStyleTag({
            content: '*,*::before,*::after{transition:none!important;animation:none!important}',
        });
        const coarse = await page.evaluate(() =>
            matchMedia('(pointer: coarse) and (hover: none)').matches);
        check(`${label} is ${vp.touch ? 'a touch' : 'a mouse'} device`, coarse, vp.touch);
        const { rows, fields, missing } = await page.evaluate(measure, DIALOGS);
        check(`${label} every dialog is on the page`, missing, []);

        // §1
        check(`§1 ${label} every checkbox and radio sits in a label`,
            rows.filter(r => !r.label).map(r => r.key), []);
        const labelled = rows.filter(r => r.label);
        check(`§1 ${label} each one's text is beside its box`,
            labelled.filter(r => !r.beside).map(r => r.key), []);
        check(`§1 ${label} ...and centred on it (within 2 px)`,
            labelled.filter(r => !(r.offCentre <= 2)).map(r => `${r.key} ${r.offCentre}`), []);
        check(`§1 ${label} ...and a tap on the text lands on the label`,
            labelled.filter(r => !r.textHits).map(r => r.key), []);

        // §2
        const components = labelled.filter(r => r.component);
        if (vp.touch || vp.width < 768) {
            check(`§2 ${label} each checkbox and radio row is the 44 px box`,
                components.filter(r => r.height !== 44).map(r => `${r.key} ${r.height}`), []);
        }

        // §3
        check(`§3 ${label} the first row of each group starts on the column's edge`,
            FIRST_IN_ROW.map(key => {
                const r = labelled.find(row => row.key === key);
                return r ? Math.abs(r.fromColumn) <= 1 || `${key} ${r.fromColumn}` : `${key} missing`;
            }).filter(v => v !== true), []);
        check(`§3 ${label} each row's press background stays inside the dialog body`,
            components.filter(r => !r.inBody).map(r => r.key), []);

        // §4
        if (vp.touch || vp.width < 768) {
            check(`§4 ${label} every field is at least 44 px tall`,
                fields.filter(f => f.height < 44).map(f => `${f.key} ${f.height}`), []);
            check(`§4 ${label} ...at 16 px, so iOS does not zoom in on focus`,
                fields.filter(f => f.fontSize !== '16px').map(f => `${f.key} ${f.fontSize}`), []);
        } else {
            check(`§4 ${label} the desktop keeps its 14 px field`,
                fields.filter(f => f.fontSize !== '14px').map(f => `${f.key} ${f.fontSize}`), []);
        }
        check(`§4 ${label} fields were measured`, fields.length > 20, true);

        if (SHOTS) {
            for (const [dialog, sel] of [['connectionModal', '#useTmuxCheck'],
                ['connectionModal', '#saveProfileCheck'], ['connectionModal', '#hostInput'],
                ['jumpHostManagementModal', 'input[name=jhAuthType]'],
                ['profileManagementModal', '#profileEditorUseDefaultParameters'],
                ['settingsModal', '#perfProbeToggle']]) {
                await page.evaluate((id) => {
                    const m = document.getElementById(id);
                    m.classList.add('show');
                    m.querySelectorAll('.hidden').forEach(el => el.classList.remove('hidden'));
                }, dialog);
                const group = page.locator(`#${dialog} ${sel}`).first()
                    .locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " form-group ")][1]');
                const file = `${engineName}-${vp.width}x${vp.height}-${sel.replace(/[^a-z]/gi, '')}.png`;
                await group.screenshot({ path: path.join(SHOTS, file) });
                await page.evaluate((id) => document.getElementById(id).classList.remove('show'), dialog);
            }
        }
        await ctx.close();
    }
    await browser.close();
}

// §Z
check('§Z no page errors', pageErrors, []);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
