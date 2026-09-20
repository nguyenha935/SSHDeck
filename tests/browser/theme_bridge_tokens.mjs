/*
 * Bucket T -- the --tw-* bridge, measured per theme.
 *
 * deck.css owns the v5 shell and paints exclusively from a --tw-* palette. The
 * mockup declares that palette as literal colours (mockup lines 209-213) and
 * spells out only three of the app's ten themes, so those literals cannot ship.
 * Each --tw-* token is instead declared once, as a var() reference onto the
 * theme token that already carries the same role, and the themes keep driving
 * every colour.
 *
 * That indirection is exactly what can fail silently:
 *
 *   1. A bridge token pointing at a token that does not exist computes to
 *      nothing. The element paints transparent or falls back to an inherited
 *      colour, and nothing goes red -- the stylesheet is still valid CSS.
 *   2. A bridge token declared in the WRONG SCOPE resolves against that scope
 *      and hands a finished colour down, so all ten themes collapse onto one
 *      palette. This is the same substitution trap theme_derived_tokens.mjs
 *      documents for --success-glow and friends: a custom property resolves
 *      against the element it is DECLARED on, not the one it is used on. Every
 *      theme is a `body[data-theme=...]` block, so the bridge must be declared
 *      on `body`, never on `:root`.
 *   3. A literal colour written straight into deck.css bypasses the bridge
 *      entirely and stays that colour in all ten themes.
 *
 * None of the three is visible in the declaration text. `--tw-shell:
 * var(--bg-primary)` reads correctly whether or not --bg-primary exists and
 * whether or not the block is in the right scope. Only a COMPUTED read after
 * switching data-theme can tell them apart, which is why this suite loads both
 * stylesheets in a real browser and measures.
 *
 * The bridge is PARSED out of deck.css rather than listed here. A hardcoded
 * list stops covering a token the moment one is added, and adding --tw-* tokens
 * is the normal way this layer grows.
 *
 * Sections:
 *   §1  every bridge token resolves to a real colour in all ten themes
 *   §2  role tokens actually follow the theme (distinct count tracks the source)
 *   §3  declaration scope: on body, not in :root
 *   §4  no literal colour anywhere in a deck.css declaration
 *   §5  the v5 SFTP inspector block paints from tokens only
 *
 * Run: node tests/browser/theme_bridge_tokens.mjs   (from source/)
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

const style = fs.readFileSync(path.join(ROOT, 'static/css/style.css'), 'utf8');
/*
 * The bridge moved out of deck.css (deck-tokens.css), because
 * every page needs it to read the ten themes and only the shell needs deck.css
 * itself. It is DECLARED in one file and PAINTED FROM in four, so the two are
 * read separately here.
 */
const tokens = fs.readFileSync(path.join(ROOT, 'static/css/deck-tokens.css'), 'utf8');
const deck = fs.readFileSync(path.join(ROOT, 'static/css/deck.css'), 'utf8');
const sftp = fs.readFileSync(path.join(ROOT, 'static/css/sftp-file-manager.css'), 'utf8');
const auth = fs.readFileSync(path.join(ROOT, 'static/css/auth-v5.css'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'static/css/admin.css'), 'utf8');

/*
 * Themes are read out of style.css, the same way theme_derived_tokens.mjs does
 * it: glass is the :root default and the other nine are body[data-theme] blocks.
 */
const THEMES = ['glass', ...[...style.matchAll(/body\[data-theme="([a-z-]+)"\]\s*\{/g)]
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)];

/*
 * Strip comments before parsing. deck.css's bridge comment quotes token names
 * in prose ("--tw-accent-text is the ink painted ON the accent fill"), and a
 * naive regex over the raw text would collect those as declarations.
 */
const deckCode = deck.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCode = tokens.replace(/\/\*[\s\S]*?\*\//g, '');

/*
 * Parse the bridge: `--tw-x: var(--y)` and `--tw-x: color-mix(... var(--y) ...)`.
 * The captured source is the FIRST var() reference, which for the one color-mix
 * token (--tw-accent-soft) is the themed colour it is derived from.
 */
const BRIDGE = [...tokensCode.matchAll(/(--tw-[a-z-]+)\s*:\s*([^;]+);/g)].map(m => {
    const source = /var\(\s*(--[a-z-]+)/.exec(m[2]);
    return { token: m[1], source: source ? source[1] : null, decl: m[2].trim() };
});

console.log(`--- ${BRIDGE.length} bridge tokens across ${THEMES.length} themes ---`);

check('all ten themes are covered', THEMES.length, 10);
check('the bridge was parsed, not silently empty', BRIDGE.length > 0, true);

/*
 * Every bridge token must map onto a theme token rather than a literal. A
 * literal here would be the mockup's own palette leaking through, which is the
 * single thing this layer exists to prevent.
 */
for (const { token, source, decl } of BRIDGE) {
    check(`§0 ${token} maps onto a theme token, not a literal`,
        source !== null, true, );
    void decl;
}

const browser = await chromium.launch();
const page = await browser.newPage();

/*
 * Load order matters and is part of the contract: deck.css ships AFTER
 * style.css so it owns the v5 shell. Loading them in the other order here would
 * measure a cascade the app never serves.
 */
await page.setContent(
    '<!doctype html><html><head>'
    + `<style>${style}</style><style>${tokens}</style><style>${deck}</style>`
    + '</head><body><div id="probe"></div></body></html>');

// ---------------------------------------------------------------------------
// §1  every bridge token resolves to a real colour in every theme
// ---------------------------------------------------------------------------
console.log('\n== §1 resolves in every theme ==');

/* Measured once and reused by §2 so the themes are only walked a single time. */
const measured = new Map();      // token -> { values[], sources[] }

for (const { token, source } of BRIDGE) {
    const values = [];
    const sources = [];
    for (const theme of THEMES) {
        await page.evaluate(t => document.body.setAttribute('data-theme', t), theme);
        const m = await page.evaluate(([tok, src]) => {
            const el = document.getElementById('probe');
            el.style.background = `var(${tok})`;
            const cs = getComputedStyle(el);
            return {
                value: cs.backgroundColor,
                source: src ? getComputedStyle(document.body)
                    .getPropertyValue(src).trim() : '',
            };
        }, [token, source]);
        values.push(m.value);
        sources.push(m.source);
    }
    measured.set(token, { values, sources });

    /*
     * An unresolvable var() computes to nothing, and `background` then falls
     * back to the initial transparent -- which is indistinguishable from a
     * correctly-painted transparent surface unless you know the token's role.
     * No bridge token is meant to be transparent, so rgba(0, 0, 0, 0) is the
     * failure signature for all of them.
     */
    check(`§1 ${token} resolves in all ten themes`,
        values.every(v => v && v !== 'rgba(0, 0, 0, 0)'), true);
}

/*
 * Each source token must itself be declared in every theme context. A source
 * that resolves in only some themes would leave the bridge token painting an
 * inherited colour in the rest -- visible only as a subtly wrong surface.
 */
for (const { token, source } of BRIDGE) {
    if (!source) continue;
    const { sources } = measured.get(token);
    check(`§1 ${source} (behind ${token}) is declared in all ten themes`,
        sources.every(Boolean), true);
}

// ---------------------------------------------------------------------------
// §2  the bridge really follows the theme
// ---------------------------------------------------------------------------
console.log('\n== §2 follows the theme ==');
/*
 * The scope bug does not make colours disappear -- it makes them IDENTICAL
 * across themes. So the check is on distinct-value counts, compared against the
 * source token's own count rather than against 10: themes legitimately share
 * colours (noir and arctic-ice share an accent), and two themes sharing a
 * source must be allowed to share the bridged value.
 */
for (const { token, source } of BRIDGE) {
    if (!source) continue;
    const { values, sources } = measured.get(token);
    const distinctSources = new Set(sources).size;

    /*
     * Guards the guard. If a source is the same colour in all ten themes then
     * one distinct bridged value is CORRECT, and asserting variety would be
     * asserting a bug. Only tokens whose source actually varies can carry the
     * "follows the theme" claim, so the rest are reported as skipped rather
     * than silently counted as passes.
     */
    if (distinctSources < 2) {
        console.log(`SKIP  §2 ${token}: ${source} is uniform across themes`
            + ` (${distinctSources} distinct) -- nothing to follow`);
        continue;
    }

    check(`§2 ${token} has as many distinct values as ${source}`,
        new Set(values).size, distinctSources);
}

// ---------------------------------------------------------------------------
// §3  declaration scope
// ---------------------------------------------------------------------------
console.log('\n== §3 declaration scope ==');
/*
 * The whole bridge must sit on `body`. In :root it would resolve against
 * :root's own palette and hand finished colours down, and the nine
 * body[data-theme] blocks would never participate -- §2 would catch the
 * symptom, this catches the cause and names it.
 */
{
    const rootStart = tokensCode.indexOf(':root');
    const rootBlock = rootStart === -1
        ? ''
        : tokensCode.slice(rootStart, tokensCode.indexOf('}', rootStart));

    const bodyBlocks = [];
    for (let i = tokensCode.indexOf('\nbody {'); i !== -1;
        i = tokensCode.indexOf('\nbody {', i + 1)) {
        bodyBlocks.push(tokensCode.slice(i, tokensCode.indexOf('\n}', i)));
    }
    check('§3 deck-tokens.css declares at least one top-level body block',
        bodyBlocks.length > 0, true);

    for (const { token } of BRIDGE) {
        check(`§3 ${token} is declared on body`,
            bodyBlocks.some(b => b.includes(`${token}:`)), true);
        check(`§3 ${token} is NOT declared in :root`,
            rootBlock.includes(`${token}:`), false);
    }
}

// ---------------------------------------------------------------------------
// §4  no literal colour in any deck.css declaration
// ---------------------------------------------------------------------------
console.log('\n== §4 no literal colours ==');
/*
 * Comments are excluded on purpose: deck.css's bridge comment cites #000000 and
 * #ffffff to explain WHY --tw-accent-text maps to --btn-primary-text instead of
 * a literal white. Deleting that reasoning to satisfy a grep would lose the one
 * note that stops the mistake being remade. What must not exist is a literal in
 * a DECLARATION, so the scan runs on comment-stripped source.
 *
 * Property names are stripped of their value-side only; a bare `#` in a
 * selector (an id) is not a colour, so the scan looks for `: ... #hex`.
 */
{
    const literalHex = [...deckCode.matchAll(/:[^;{}]*#[0-9a-fA-F]{3,8}\b/g)]
        .map(m => m[0].trim());
    check('§4 deck.css has no hex literal in any declaration',
        literalHex.join(' | '), '');

    const literalFn = [...deckCode.matchAll(/:[^;{}]*\b(?:rgba?|hsla?)\(/g)]
        .map(m => m[0].trim());
    check('§4 deck.css has no rgb()/hsl() literal in any declaration',
        literalFn.join(' | '), '');

    /*
     * Bare colour keywords are the third way a literal sneaks in, and the
     * easiest to write by accident. `transparent` and `currentColor` are NOT
     * literals in this sense -- neither pins a theme-independent colour -- so
     * they stay allowed.
     */
    const keywords = ['white', 'black', 'red', 'green', 'blue', 'yellow',
        'orange', 'purple', 'gray', 'grey', 'silver', 'navy', 'teal'];
    const literalKw = [...deckCode.matchAll(/(?:color|background|background-color|border-color|fill|stroke|outline-color)\s*:\s*([a-z]+)\s*(?:;|!)/g)]
        .filter(m => keywords.includes(m[1]))
        .map(m => m[0].trim());
    check('§4 deck.css has no bare colour keyword in a colour declaration',
        literalKw.join(' | '), '');
}

// ---------------------------------------------------------------------------
// §5  the v5 SFTP inspector paints from tokens only
// ---------------------------------------------------------------------------
console.log('\n== §5 SFTP inspector block ==');
/*
 * The inspector is the newest presentation surface (P3) and it lives in
 * sftp-file-manager.css rather than deck.css, because that file loads last and
 * owns every SFTP selector. It is therefore outside §4's scan, and a literal
 * written there would be just as theme-deaf. Only the panel's own block is
 * scanned: the rest of the file is upstream's dual-pane modal, which carries
 * pre-existing var() fallbacks that are not this bucket's to change.
 */
{
    const sftpCode = sftp.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = sftpCode.indexOf('.sftp-panel {');
    check('§5 the inspector block was found', start !== -1, true);
    const block = start === -1 ? '' : sftpCode.slice(start);

    const hex = [...block.matchAll(/:[^;{}]*#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].trim());
    check('§5 the inspector block has no hex literal', hex.join(' | '), '');

    const fn = [...block.matchAll(/:[^;{}]*\b(?:rgba?|hsla?)\(/g)].map(m => m[0].trim());
    check('§5 the inspector block has no rgb()/hsl() literal', fn.join(' | '), '');

    /*
     * Every colour the panel paints must come through a token. The panel's own
     * rules use the --tw-* bridge with an upstream token as the var() fallback
     * (`var(--tw-surface, var(--bg-secondary))`), so both names appear -- what
     * matters is that no colour is written literally, proven above, and that
     * the bridge is actually used here at all, proven below.
     */
    check('§5 the inspector paints through the --tw-* bridge',
        /--tw-(?:surface|border|muted|text|accent|hover)/.test(block), true);
}

// ---------------------------------------------------------------------------
// §6  the bridge is complete and has no dead entries
// ---------------------------------------------------------------------------
console.log('\n== §6 bridge completeness ==');
/*
 * Two failure modes that no per-token check above can see:
 *   - a token USED in deck.css but never declared: it computes to nothing, and
 *     §1 cannot catch it because §1 only walks tokens it found declarations for.
 *   - a token DECLARED but never used: dead weight that reads like live API and
 *     invites someone to paint from it, at which point its correctness has
 *     never been measured.
 */
{
    /* Four stylesheets paint from the bridge since the auth pages joined it:
       the shell, the file manager, the auth/admin sheet and admin's own. A
       token is live if ANY of them uses it, and declared if the bridge file
       declares it. */
    const painters = [deckCode, sftp, auth, admin]
        .map(src => src.replace(/\/\*[\s\S]*?\*\//g, ''));
    const used = new Set(painters.flatMap(src =>
        [...src.matchAll(/var\(\s*(--tw-[a-z-]+)/g)].map(m => m[1])));
    const declared = new Set(BRIDGE.map(b => b.token));

    const undeclared = [...used].filter(t => !declared.has(t)).sort();
    check('§6 every --tw-* token the stylesheets paint from is declared',
        undeclared.join(', '), '');

    const unused = [...declared].filter(t => !used.has(t)).sort();
    check('§6 no declared --tw-* token is dead', unused.join(', '), '');
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
