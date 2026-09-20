/*
 * Copies vendored frontend assets from node_modules into static/vendor/.
 *
 * Usage:  npm run vendor   (after npm ci / npm install)
 *
 * Node is only needed to (re)generate these assets, never at runtime. The
 * committed files under static/vendor/ are what the Flask app actually serves.
 * To update a library: bump its version in package.json, run `npm install`,
 * then `npm run vendor`, and commit the changed static/vendor/ files.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');
const outDir = path.join(root, 'static', 'vendor');

// [ source (relative to node_modules), destination (relative to static/vendor) ]
const files = [
  // The library moved to the @xterm scope; the destination names are kept so
  // the template's <script> tags (and their cache pins) do not churn.
  ['@xterm/xterm/css/xterm.css', 'xterm/xterm.css'],
  ['@xterm/xterm/lib/xterm.js', 'xterm/xterm.js'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm/xterm-addon-fit.js'],
  ['@xterm/addon-search/lib/addon-search.js', 'xterm/xterm-addon-search.js'],
  // Unicode 11 width tables: xterm's built-in Unicode 6 table draws emoji
  // such as U+1F648 one cell narrower than tmux does, and a full-width
  // row one cell short puts every later repaint on the wrong row
  // (measured 2026-09-19, see terminal-manager.js createTerminal).
  ['@xterm/addon-unicode11/lib/addon-unicode11.js', 'xterm/xterm-addon-unicode11.js'],
  ['@highlightjs/cdn-assets/highlight.min.js', 'highlight/highlight.min.js'],
  ['@highlightjs/cdn-assets/styles/github-dark.min.css', 'highlight/github-dark.min.css'],
  // Material Icons: only the "filled" variant is used by the UI. The CSS
  // references its fonts relatively, so CSS + woff2 + woff land side by side.
  ['material-icons/iconfont/material-icons.css', 'material-icons/material-icons.css'],
  ['material-icons/iconfont/material-icons.woff2', 'material-icons/material-icons.woff2'],
  ['material-icons/iconfont/material-icons.woff', 'material-icons/material-icons.woff'],
];

// A licence travels with the files it covers. MIT and BSD both require the
// notice to be kept in redistributions, and these files ARE a redistribution:
// they are committed to this repository and served to every browser. Leaving
// this to a human step is how the notices went missing in the first place.
//
// One file per DIRECTORY, carrying every package that put files there.
// static/vendor/xterm/ alone holds four packages and three distinct notices --
// copying just one of them would delete the other two on the next run.
const licences = {
  'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search',
            '@xterm/addon-unicode11'],
  'highlight': ['@highlightjs/cdn-assets'],
  'socketio': ['socket.io-client'],
  'material-icons': ['material-icons'],
};

let count = 0;
for (const [src, dest] of files) {
  const srcPath = path.join(nodeModules, src);
  const destPath = path.join(outDir, dest);
  if (!fs.existsSync(srcPath)) {
    console.error(`ERROR: missing source file: ${src}\nRun "npm install" first.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ${src}  ->  static/vendor/${dest}`);
  count++;
}
const rule = '='.repeat(78);
for (const [folder, packages] of Object.entries(licences)) {
  // Group by TEXT, so packages that share a notice are listed against one copy
  // of it rather than repeating it.
  const byText = new Map();
  for (const pkg of packages) {
    const srcPath = path.join(nodeModules, pkg, 'LICENSE');
    if (!fs.existsSync(srcPath)) {
      console.error(`ERROR: missing licence file: ${pkg}/LICENSE\nRun "npm install" first.`);
      process.exit(1);
    }
    const version = require(path.join(nodeModules, pkg, 'package.json')).version;
    const body = fs.readFileSync(srcPath, 'utf8');
    if (!byText.has(body)) byText.set(body, []);
    byText.get(body).push(`${pkg} ${version}`);
  }
  const parts = ['These files are third-party libraries, copied unmodified from the\n'
    + 'packages named below. Their licences follow, in full.\n'];
  for (const [body, names] of byText) {
    parts.push(rule, names.join('\n'), rule + '\n', body.trimEnd() + '\n');
  }
  const destPath = path.join(outDir, folder, 'LICENSE');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, parts.join('\n'));
  console.log(`  ${packages.length} licence(s)  ->  static/vendor/${folder}/LICENSE`);
  count++;
}

/*
 * SOCKET.IO IS BUILT, NOT COPIED.
 *
 * Every other entry above is a file upstream publishes as-is. This one is not:
 * `socket.io-client/dist/socket.io.min.js` arrives PREBUILT with
 * socket.io-parser already inlined, and the inlined copy is older than 4.2.6 --
 * it has no `maxAttachments` bound and predates the fix for CVE-2026-69185
 * (GHSA-2m8v-j782-fhvr, high: a BINARY_EVENT packet declaring an unbounded
 * attachment count leaves a BinaryReconstructor behind on every packet).
 *
 * Measured: `npm audit fix` raises the installed parser to 4.2.7 and npm then
 * reports zero vulnerabilities, while that prebuilt file's sha256 does not
 * change by one bit. A dependency bump cannot patch a file that ships already
 * built, so the bundle is built here from the resolved sources, with
 * package.json's `overrides` holding the parser at 4.2.7 or above.
 *
 * esbuild is pinned, so the output is byte-identical between runs -- which is
 * what lets CI re-vendor and require an empty diff.
 */
const sioEntry = path.join(root, 'scripts', 'socketio-entry.js');
const sioOut = path.join(outDir, 'socketio', 'socket.io.min.js');
fs.mkdirSync(path.dirname(sioOut), { recursive: true });
execFileSync(path.join(nodeModules, '.bin', 'esbuild'), [
    sioEntry, '--bundle', '--minify', '--format=iife', '--target=es2017',
    `--outfile=${sioOut}`, '--log-level=warning',
], { stdio: 'inherit' });
console.log(`  built socket.io-client  ->  static/vendor/socketio/socket.io.min.js`);
count++;

console.log(`\nVendored ${count} files into static/vendor/.`);
