import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
    }
}
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const admin = read('templates/admin.html');
const index = read('templates/index.html');
const command = read('static/js/command-library.js');
const trusted = read('tests/browser/mobile_shell_trusted.mjs');
const manifest = JSON.parse(read('static/icons/manifest.json'));
/*
 * The P6b drag manager was retired (its upload paths were unreachable -- gated
 * on a transferClient that could never be constructed -- so all it added was a
 * second overlay stacked on the canonical one). Its zero-Material-refs contract
 * moves to the canonical overlay's owner, app.js, which is what now renders the
 * drag affordance, plus the sftp manager that renders the upload sprites.
 */
check('P6b canonical drag/upload owners have zero Material refs',
    read('static/js/app.js').includes('material-icons')
        || read('static/js/sftp-file-manager.js').includes('material-icons'), false);
check('P6b admin template has zero Material refs', admin.includes('material-icons'), false);
check('admin title uses the verified settings sprite',
    admin.includes('#icon-settings') && manifest.symbols.includes('icon-settings'), true);
const rendererStart = command.indexOf('    renderNextChunk() {');
const rendererEnd = command.indexOf('    attachCommandListeners(container) {', rendererStart);
const commandRenderer = command.slice(rendererStart, rendererEnd);
check('P5 action renderer boundaries found', rendererStart >= 0 && rendererEnd > rendererStart, true);
check('P5 action renderer has no legacy action emoji',
    ['\ud83d\udccb', '\u270f\ufe0f', '\ud83d\uddd1\ufe0f', '\u25b6\ufe0f', '\u2935']
        .some(glyph => commandRenderer.includes(glyph)), false);
// The sprite migrated from Ant Design outlined to Lucide, so these are the
// Lucide names for the same four actions. The assertion is unchanged in
// strength -- all four must still be emitted by the renderer through
// spriteIcon(), and each must exist in the sprite manifest.
//
// The first action's glyph changed name only: bucket P2 rebuilt a library entry
// as ONE 46px tappable row per mockup v5 line 181, whose trailing glyph states
// what tapping does. That line specifies corner-down-left ("insert into the
// composer, edit before running"), replacing arrow-down-to-line ("download").
// The action itself is unchanged and still rendered via spriteIcon(); only the
// symbol name moved, so pinning the old name pinned a glyph the approved design
// no longer uses. icon-arrow-down-to-line is still in the sprite and still used
// by other surfaces, so this is a rename in this renderer, not a removal.
const P5_ACTION_SYMBOLS = ['corner-down-left', 'copy', 'pencil', 'trash-2'];
check('P5 action renderer uses the four approved sprite symbols',
    P5_ACTION_SYMBOLS
        .every(name => commandRenderer.includes(`spriteIcon('${name}')`)), true);
check('the four P5 action symbols all exist in the sprite',
    P5_ACTION_SYMBOLS
        .every(name => manifest.symbols.includes(`icon-${name}`)), true);
check('P6d index Material link remains',
    (index.match(/vendor\/material-icons\/material-icons\.css/g) || []).length, 1);
check('P6d vendor stylesheet remains',
    fs.existsSync(path.join(ROOT, 'static/vendor/material-icons/material-icons.css')), true);
check('P6d package dependency remains', read('package.json').includes('"material-icons"'), true);
check('P6d vendor script copy remains', read('scripts/vendor.js').includes('material-icons'), true);
check('allowlisted injected Material probe remains',
    trusted.includes('<span class="material-icons">refresh</span>'), true);

let html = index
    .replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, '/static/$1')
    .replace(/\{\{\s*url_for\('([a-z_.]+)'\)\s*\}\}/g, '/$1')
    .replace(/\{%[^%]*%\}/g, '')
    .replace(/\{\{[^{}]*\|\s*tojson\s*\}\}/g, '[]')
    .replace(/\{\{\s*theme\|default\('glass'\)\s*\}\}/g, 'glass')
    .replace(/\{\{[^}]*\}\}/g, '');
const server = await new Promise(resolve => {
    const instance = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        if (rel === '/' || rel === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html); return;
        }
        const file = path.join(ROOT, rel.replace(/^\/+/, ''));
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        const type = path.extname(file) === '.css' ? 'text/css' :
            path.extname(file) === '.svg' ? 'image/svg+xml' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': type });
        res.end(fs.readFileSync(file));
    });
    instance.listen(0, '127.0.0.1', () => resolve(instance));
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
await page.addInitScript(() => {
    const noop = () => {};
    window.socket = { on: noop, off: noop, once: noop, emit: noop, io: { on: noop } };
});
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
/*
 * The drag overlay assertions below used to target .drag-drop-overlay, built at
 * runtime by the retired drag-drop-manager.js. The canonical overlay is
 * #dropOverlay, declared in index.html and revealed by app.js from a
 * document-level dragover. Retargeted rather than dropped, and strengthened with
 * the count: the defect this module caused was TWO overlays on one drag, so the
 * number of full-window drag overlays present is now itself a contract.
 */
await page.waitForTimeout(100);
const overlay = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'icon-test.txt', { type: 'text/plain' }));
    // app.js reveals the overlay from dragover, and dragenter is dispatched too
    // so that any handler keyed on either event has had its chance to add one.
    document.dispatchEvent(new DragEvent('dragenter', {
        dataTransfer: dt, bubbles: true, cancelable: true,
    }));
    document.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: dt, bubbles: true, cancelable: true,
    }));
    const canonical = document.getElementById('dropOverlay');
    const rect = canonical.getBoundingClientRect();
    const container = canonical.parentElement.getBoundingClientRect();
    // Every element that presents itself as a drag overlay, by any class name.
    const allOverlays = [...document.querySelectorAll(
        '.drop-overlay, .drag-drop-overlay, [id*="ropOverlay"], [id*="ragDrop"]')];
    return {
        overlayCount: allOverlays.length,
        allAreCanonical: allOverlays.every(el => el.id === 'dropOverlay'),
        hiddenAfterReveal: canonical.classList.contains('hidden'),
        display: getComputedStyle(canonical).display,
        coversContainer: Math.round(rect.width) === Math.round(container.width)
            && Math.round(rect.height) === Math.round(container.height),
        title: canonical.querySelector('.drop-title')?.textContent.trim(),
    };
});
check('exactly one drag overlay exists in the document', overlay.overlayCount, 1);
check('the one overlay is the canonical #dropOverlay', overlay.allAreCanonical, true);
check('real dragover reveals the canonical overlay', overlay.hiddenAfterReveal, false);
check('the revealed canonical overlay is laid out', overlay.display, 'flex');
check('the canonical overlay covers its terminal container', overlay.coversContainer, true);
check('the canonical overlay states its purpose', overlay.title, 'Drop file to upload');
/*
 * The cloud-upload sprite the retired overlay used is still a verified symbol and
 * still rendered by the SFTP upload UI, so the migration contract for that glyph
 * is kept rather than lost with the module that also happened to use it.
 */
check('cloud-upload remains a verified sprite symbol',
    manifest.symbols.includes('icon-cloud-upload'), true);
check('the SFTP upload UI still renders the cloud-upload sprite',
    read('static/js/sftp-file-manager.js').includes('#icon-cloud-upload'), true);
check('page has no errors', errors, []);
await browser.close();
await new Promise(resolve => server.close(resolve));
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
