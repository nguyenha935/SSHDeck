#!/usr/bin/env node
/*
 * Rasterise the accent glyph for the .ico fallback.
 *
 * Pillow cannot read SVG and the project has no other rasteriser, so the one
 * browser already installed for the gates does it: 512px, transparent, written
 * to static/icons/brand-glyph-512.png, which scripts/build_brand_icons.py then
 * turns into favicon.ico. Run it only when the mark itself changes.
 *
 *   node scripts/rasterise_glyph.mjs     (from source/)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'static/icons/brand-glyph-accent.svg'), 'utf8');
const out = path.join(ROOT, 'static/icons/brand-glyph-512.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(
    '<style>html,body{margin:0;padding:0;background:transparent}'
    + 'svg{display:block;width:512px;height:512px}</style>' + svg);
await page.waitForTimeout(150);
fs.writeFileSync(out, await page.screenshot({ omitBackground: true }));
await browser.close();
console.log(`${path.relative(ROOT, out)}  ${fs.statSync(out).size} bytes`);
