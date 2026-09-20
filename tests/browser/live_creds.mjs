/*
 * Configuration for the live gates.
 *
 * A live gate drives a real SSHDeck against a real SSH target, so it needs
 * values that belong to whoever runs it: a base URL, an account, a host. They
 * live in one file, `tests/live.env`, which git ignores; `tests/live.env.example`
 * is the documented template. `LIVE_CREDS_FILE` points somewhere else when the
 * values are kept outside the checkout, and an environment variable of the
 * same name wins over the file, so CI can pass them without writing anything
 * to disk.
 *
 * Values are never printed. A missing one is reported by NAME only, as a
 * single line, and the gate exits 1.
 */
import fs from 'node:fs';
import path from 'node:path';

/*
 * A missing value is a SETUP problem, and the message below already says which
 * names are missing and which file was read. A Node stack trace under it only
 * buries the one line the reader needs, so the error is marked and printed on
 * its own. Anything else keeps Node's own behaviour -- the stack, exit 1 --
 * and a gate that catches the error itself (s35_p91_live_reconnect.mjs) never
 * reaches here.
 */
process.on('uncaughtException', (err) => {
    if (err && err.liveConfigMissing) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
    }
    console.error(err);
    process.exit(1);
});

const REPO = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FILE = path.join(REPO, 'tests/live.env');
const EXAMPLE = 'tests/live.env.example';

export const CREDS_FILE = process.env.LIVE_CREDS_FILE || DEFAULT_FILE;

const KEYS = ['LIVE_BASE', 'LIVE_USER', 'LIVE_PASS', 'SSH_HOST', 'SSH_PORT',
              'SSH_USER', 'SSH_PASS', 'SSH_AUTH_TYPE'];

function fromFile() {
    let raw;
    try {
        raw = fs.readFileSync(CREDS_FILE, 'utf8');
    } catch (e) {
        return null;
    }
    const values = {};
    for (const line of raw.split('\n')) {
        const m = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line.trim());
        if (m && !line.trim().startsWith('#')) values[m[1]] = m[2].trim();
    }
    return values;
}

/*
 * The whole configuration, environment first. Throws with the names that are
 * missing and with the path that was read, so a failing gate says what to fix
 * rather than failing somewhere inside a page.
 */
export function liveConfig({ require: required = KEYS } = {}) {
    const file = fromFile();
    const values = {};
    for (const key of KEYS) {
        values[key] = process.env[key] || (file ? file[key] : undefined) || '';
    }
    values.SSH_PORT = values.SSH_PORT || '22';
    values.SSH_AUTH_TYPE = values.SSH_AUTH_TYPE || 'password';
    const missing = required.filter(key => !values[key]);
    if (missing.length) {
        const where = file
            ? `${CREDS_FILE} does not supply`
            : `no configuration was found (${CREDS_FILE} is unreadable) for`;
        const err = new Error(
            `live gates: ${where}: ${missing.join(', ')}.\n`
            + `Copy ${EXAMPLE} to tests/live.env and fill it in, or set those`
            + ' names in the environment, or point LIVE_CREDS_FILE at the file'
            + ' that has them.');
        err.liveConfigMissing = true;
        throw err;
    }
    return values;
}

/*
 * The older spelling, kept because eight gates read it: the same values under
 * the names those gates use.
 */
export function liveCreds() {
    const c = liveConfig();
    return {
        sshdeck_user: c.LIVE_USER,
        sshdeck_password: c.LIVE_PASS,
        host_ssh_user: c.SSH_USER,
        host_ssh_password: c.SSH_PASS,
        ssh_target: c.SSH_HOST,
        tailnet_host: c.SSH_HOST,
        ssh_port: c.SSH_PORT,
        auth_type: c.SSH_AUTH_TYPE,
        base: c.LIVE_BASE,
    };
}
