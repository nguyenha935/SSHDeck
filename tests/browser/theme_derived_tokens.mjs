/*
 * Tokens derived from a themed token must follow the theme.
 *
 * The stylesheet has four tokens whose value is computed from another token
 * rather than written literally:
 *
 *   --success-glow  from --success-color
 *   --warning-glow  from --warning-color
 *   --error-glow    from --error-color
 *   --shadow-glow   from --accent-primary-glow
 *
 * All four sources are themed -- each has ten declarations, one per theme -- so
 * all four derived tokens should have ten distinct values. Measured before the
 * fix, each had exactly ONE, always the :root value, in all ten themes.
 *
 * The cause is where a custom property is substituted. It resolves against the
 * element it is DECLARED on, not the element it is used on. Every theme here is
 * a `body[data-theme=...]` block, so a derived token declared in :root reads the
 * :root source, finishes the colour there, and hands the finished value down --
 * the theme override on body is never consulted. Moving the four declarations to
 * `body` puts them at the same level the themes compete at, and the theme's
 * higher specificity wins.
 *
 * This is why the test reads the COMPUTED value after switching data-theme, and
 * not the declaration text. Grepping for `color-mix(...)` in the file passes
 * identically before and after the fix -- the derivation was always written
 * correctly; it was resolving in the wrong scope. Only a computed read can tell
 * those apart, which is the same trap DESIGN.md section 14 names for contrast.
 *
 * Run: node tests/browser/theme_derived_tokens.mjs   (from source/)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
    if (Array.isArray(actual)) actual = actual.join(', ');
    if (Array.isArray(expected)) expected = expected.join(', ');
    if (actual === expected) {
        pass++;
        console.log(`PASS  ${label}`);
    } else {
        fail++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}`
            + `\n        actual   ${JSON.stringify(actual)}`);
    }
}

const css = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');

/*
 * Themes are read out of the stylesheet rather than listed here. A hardcoded
 * list silently stops covering a theme the moment one is added -- and
 * "additional themes" is on the project's own wanted list, so that will happen.
 */
const THEMES = ['glass', ...[...css.matchAll(/body\[data-theme="([a-z-]+)"\]\s*\{/g)]
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)];

/* Derived token -> the themed token it is computed from. */
const DERIVED = [
    { token: '--success-glow', from: '--success-color', prop: 'background' },
    { token: '--warning-glow', from: '--warning-color', prop: 'background' },
    { token: '--error-glow', from: '--error-color', prop: 'background' },
    // box-shadow, not background: --shadow-glow carries an offset and blur, so
    // it is not a colour and will not compute as one.
    { token: '--shadow-glow', from: '--accent-primary-glow', prop: 'box-shadow' },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head>`
    + '<body><div id="probe"></div></body></html>');

console.log(`--- ${DERIVED.length} derived tokens across ${THEMES.length} themes ---`);

check('every theme in the stylesheet is covered', THEMES.length >= 10, true);

for (const { token, from, prop } of DERIVED) {
    const sources = [];
    const values = [];

    for (const theme of THEMES) {
        await page.evaluate(t => document.body.setAttribute('data-theme', t), theme);
        const measured = await page.evaluate(([token, from, prop]) => {
            const el = document.getElementById('probe');
            el.style.removeProperty('background');
            el.style.removeProperty('box-shadow');
            el.style.setProperty(prop, `var(${token})`);
            const style = getComputedStyle(el);
            return {
                source: style.getPropertyValue(from).trim(),
                value: prop === 'box-shadow' ? style.boxShadow : style.backgroundColor,
            };
        }, [token, from, prop]);
        sources.push(measured.source);
        values.push(measured.value);
    }

    // Guards the guard: if the source token were not themed, every value being
    // the same would be correct and this test would be asserting nothing.
    check(`${from} really is themed`,
        new Set(sources).size >= 8, true);

    // Not > 1: one distinct value is exactly the bug. Two themes sharing a
    // source colour legitimately share the derived one (noir and arctic-ice
    // both use #4de6c4), so the count is compared against the source's.
    check(`${token} has as many values as ${from}`,
        new Set(values).size, new Set(sources).size);

    // The derived value must be empty in no theme -- an unresolvable
    // color-mix() computes to nothing and the glow silently disappears.
    check(`${token} resolves in every theme`,
        values.every(v => v && v !== 'none' && v !== 'rgba(0, 0, 0, 0)'), true);
}

/*
 * Where the four are declared is the fix, so pin it. Without this, someone
 * tidying the token block back into :root would reintroduce the bug, and the
 * computed checks above would catch it only if this file is run -- which is the
 * point, but the message would say "has one value" rather than naming the cause.
 */
{
    console.log('\n--- declaration scope ---');
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
    for (const { token } of DERIVED) {
        check(`${token} is not declared in :root`, rootBlock.includes(`${token}:`), false);
    }

    /* Collect EVERY top-level `body {` block, not just the first.
     *
     * This used to read only css.indexOf('\nbody {'), which was correct while
     * exactly one such block existed. A second one (the --chrome-* alias block)
     * now sits ahead of the derived-token block, so the single-index lookup
     * landed on a block that legitimately does not declare the glows and
     * reported four failures against a stylesheet that was correct.
     *
     * Scanning all blocks is also the stricter reading of what this section is
     * for: the requirement is "declared on body, not in :root", and which of
     * several body blocks carries it was never the point. Splitting the tokens
     * across two body blocks would still be correct CSS and still pass.
     */
    const bodyBlocks = [];
    for (let i = css.indexOf('\nbody {'); i !== -1; i = css.indexOf('\nbody {', i + 1)) {
        bodyBlocks.push(css.slice(i, css.indexOf('\n}', i)));
    }
    check('at least one top-level body block exists', bodyBlocks.length > 0, true);
    for (const { token } of DERIVED) {
        check(`${token} is declared on body`,
            bodyBlocks.some(b => b.includes(`${token}:`)), true);
    }
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
