/*
 * THE LIVE WORLD -- the only thing a live gate ever runs against.
 *
 * A live gate drives a real SSHDeck server against a real SSH target. Both
 * are built here, for one run, and removed with it:
 *
 *   - an OpenSSH container from tests/live (account `deck`, password made for
 *     this run), published on a free 127.0.0.1 port;
 *   - an SSHDeck server from this checkout -- gunicorn + eventlet, one worker,
 *     as production runs it -- on another free 127.0.0.1 port, with its own
 *     DATA_DIR and SECRET_KEY in a temp directory;
 *   - two accounts in that server's empty database, also made here: the first
 *     one registered is an admin, so the gates log in as the second, which is
 *     not.
 *
 * OWNER RULING 2026-10-16: a live gate is never linked to any real account,
 * deployment or host. Nothing is read from a file or from the caller's
 * environment; the only configuration a gate can get is a world's, and
 * liveWorld() refuses one whose container this module did not label.
 * tests/live.env, which used to name a deployment and real credentials, is
 * retired, and its presence stops the run.
 *
 * `node scripts/run_gates.mjs --live` starts ONE world for all the live gates
 * and hands it to each through SSHDECK_LIVE_WORLD; a gate run on its own
 * starts its own. Whoever started a world removes it -- the server, the
 * container, its image and the temp directory -- on exit, on Ctrl-C and after
 * a crash. A world left behind by a killed run is swept by the next start.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const ENV_KEY = 'SSHDECK_LIVE_WORLD';
const LABEL = 'io.sshdeck.live-world';
const OWNER_LABEL = `${LABEL}.owner-pid`;
const TMP_PREFIX = 'sshdeck-live-';
const RETIRED = path.join(ROOT, 'tests/live.env');
const BOOT_TIMEOUT_MS = 90000;
const PYTHON = fs.existsSync(path.join(ROOT, '.venv/bin/python'))
    ? path.join(ROOT, '.venv/bin/python') : 'python3';

const token = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const docker = (args, env) => execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env,
}).toString().trim();
const tail = (file) => {
    try { return fs.readFileSync(file, 'utf8').split('\n').slice(-25).join('\n'); }
    catch { return '(no log)'; }
};

/* A zombie still answers kill(pid, 0); /proc tells the truth on Linux. */
function alive(pid) {
    if (!pid) return false;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch {
        try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function waitFor(what, attempt, timeout = BOOT_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await attempt()) return;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`${what} within ${timeout / 1000} s`);
}

function sshBanner(port) {
    return new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1');
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(2000, () => done(false));
        sock.on('data', d => done(d.toString().startsWith('SSH-')));
        // docker-proxy accepts at once and hangs up while sshd is not up yet.
        sock.on('close', () => done(false));
        sock.on('error', () => done(false));
    });
}

/* The server's whole environment. Nothing is inherited but PATH. */
function serverEnv(w) {
    return {
        PATH: process.env.PATH, HOME: w.tmp, LANG: 'C.UTF-8',
        DATA_DIR: path.join(w.tmp, 'data'), SECRET_KEY: w.secretKey,
        TMUX_ENABLED: 'true', TMUX_DEFAULT: 'true',
        SESSION_COOKIE_SECURE: 'false', CORS_ORIGINS: w.base,
        // The gates log in and register many times from one address.
        RATELIMIT_LOGIN_LIMIT: '600 per minute',
        REGISTRATION_ENABLED: 'True', TAILSCALE_SSH_ENABLED: 'false',
    };
}

const CREATE_ACCOUNTS = `
import os, sys
from app import create_app
from app.auth import register_user
app = create_app()
with app.app_context():
    for name, password in ((os.environ['W_ADMIN'], os.environ['W_ADMIN_PASS']),
                           (os.environ['W_USER'], os.environ['W_USER_PASS'])):
        _, error = register_user(name, password)
        if error:
            print(f'could not create {name}: {error}', flush=True)
            os._exit(1)
print('accounts ready', flush=True)
os._exit(0)
`;

/*
 * Remove what a killed run left: containers and images carrying the label
 * whose owner is gone, and temp directories whose owner is gone, together
 * with the server they started.
 */
function sweepStale() {
    const owned = (pid) => alive(Number(pid));
    try {
        const rows = docker(['ps', '-a', '--filter', `label=${LABEL}`,
            '--format', `{{.Names}} {{.Label "${OWNER_LABEL}"}}`]);
        for (const [name, pid] of rows.split('\n').filter(Boolean).map(l => l.split(' '))) {
            if (!owned(pid)) docker(['rm', '-f', name]);
        }
        const images = docker(['images', '--filter', `label=${LABEL}`,
            '--format', `{{.Repository}}:{{.Tag}} {{.Label "${OWNER_LABEL}"}}`]);
        for (const [image, pid] of images.split('\n').filter(Boolean).map(l => l.split(' '))) {
            if (!owned(pid)) docker(['rmi', image]);
        }
    } catch { /* docker is checked by the caller */ }
    for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith(TMP_PREFIX)) continue;
        const dir = path.join(os.tmpdir(), entry);
        let owner = null;
        let server = null;
        try { owner = Number(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8')); } catch {}
        try { server = Number(fs.readFileSync(path.join(dir, 'server.pid'), 'utf8')); } catch {}
        if (owner && alive(owner)) continue;
        if (server && alive(server)) {
            try { process.kill(-server, 'SIGKILL'); } catch {}
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* Remove everything a world consists of. Synchronous, so it can run on exit. */
export function stopWorld(w) {
    if (!w || w.stopped) return;
    w.stopped = true;
    if (w.serverPid) {
        // gunicorn: SIGINT is a quick shutdown. The server leads its own
        // process group, so its worker goes with it.
        try { process.kill(-w.serverPid, 'SIGINT'); } catch {}
        for (let i = 0; i < 50 && alive(w.serverPid); i++) sleepSync(100);
        try { process.kill(-w.serverPid, 'SIGKILL'); } catch {}
    }
    try { docker(['rm', '-f', w.container]); } catch {}
    try { docker(['rmi', w.image]); } catch {}
    try { fs.rmSync(w.tmp, { recursive: true, force: true }); } catch {}
}

/*
 * The one who starts a world removes it, however the process ends -- from the
 * moment the first piece exists, so a start that fails halfway leaves nothing.
 */
function ownWorld(w) {
    process.on('exit', () => stopWorld(w));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
        process.on(signal, () => { stopWorld(w); process.exit(code); });
    }
}

export async function startWorld() {
    if (fs.existsSync(RETIRED)) {
        throw new Error(`${path.relative(ROOT, RETIRED)} is retired: the live gates run only`
            + ' against a world they build themselves, never a real account or host.'
            + ' Delete the file.');
    }
    try { docker(['info', '--format', '{{.ServerVersion}}']); }
    catch { throw new Error('the live gates need docker: their SSH target is a container'); }
    sweepStale();

    const runId = token(4);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    fs.writeFileSync(path.join(tmp, 'owner.pid'), String(process.pid));
    const w = {
        runId, tmp, container: `sshdeck-live-${runId}`, image: `sshdeck-live-target:${runId}`,
        serverPid: null, secretKey: token(32),
        admin: `wadmin${token(3)}`, adminPass: token(12),
        user: `live${token(3)}`, pass: token(12),
        sshHost: '127.0.0.1', sshPort: null, sshUser: 'deck', sshPass: token(12),
    };
    ownWorld(w);
    try {
        const labels = ['--label', `${LABEL}=${runId}`, '--label', `${OWNER_LABEL}=${process.pid}`];
        docker(['build', '--quiet', ...labels, '-t', w.image, path.join(ROOT, 'tests/live')]);
        // The password reaches docker through its environment, not its argv.
        docker(['run', '-d', '--name', w.container, ...labels, '-e', 'DECK_PASSWORD',
            '-p', '127.0.0.1::22', w.image], { ...process.env, DECK_PASSWORD: w.sshPass });
        w.sshPort = docker(['port', w.container, '22/tcp']).split('\n')[0].split(':').pop();
        await waitFor('the SSH target did not answer', () => sshBanner(Number(w.sshPort)));

        const port = await freePort();
        w.base = `http://127.0.0.1:${port}`;
        const env = serverEnv(w);
        execFileSync(PYTHON, ['-c', CREATE_ACCOUNTS], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
            env: { ...env, W_ADMIN: w.admin, W_ADMIN_PASS: w.adminPass,
                W_USER: w.user, W_USER_PASS: w.pass },
        });

        const logFile = path.join(tmp, 'server.log');
        const log = fs.openSync(logFile, 'a');
        const child = spawn(PYTHON, ['-m', 'gunicorn', '--worker-class', 'eventlet', '-w', '1',
            '--bind', `127.0.0.1:${port}`, 'start:app'],
        { cwd: ROOT, env, stdio: ['ignore', log, log], detached: true });
        // Tracked by pid; it must not keep this process alive once the gate ends.
        child.unref();
        w.serverPid = child.pid;
        fs.writeFileSync(path.join(tmp, 'server.pid'), String(child.pid));
        await waitFor('the throwaway SSHDeck did not answer /login', async () => {
            if (child.exitCode !== null) throw new Error('the throwaway SSHDeck exited during boot');
            try { return (await fetch(`${w.base}/login`)).status === 200; } catch { return false; }
        }).catch(e => { throw new Error(`${e.message}:\n${tail(logFile)}`); });
        return w;
    } catch (e) {
        stopWorld(w);
        throw e;
    }
}

/* What a gate process is handed: data only, nothing it could act on. */
export const worldData = (w) => ({
    runId: w.runId, base: w.base, user: w.user, pass: w.pass,
    sshHost: w.sshHost, sshPort: w.sshPort, sshUser: w.sshUser, sshPass: w.sshPass,
    container: w.container,
});

function adopt(w) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(w.base || '')) {
        throw new Error(`${ENV_KEY} does not name a world on this machine`);
    }
    let label = '';
    try {
        label = docker(['inspect', '-f', `{{index .Config.Labels "${LABEL}"}}`, w.container]);
    } catch { /* no such container */ }
    if (!w.runId || label !== w.runId) {
        throw new Error(`${ENV_KEY} names a container this module did not build`);
    }
    return w;
}

let pending = null;
/*
 * The world this process runs against: the one it was handed, or one it
 * starts and owns.
 */
export function liveWorld() {
    if (!pending) {
        pending = (async () => {
            if (process.env[ENV_KEY]) return adopt(JSON.parse(process.env[ENV_KEY]));
            return worldData(await startWorld());
        })();
    }
    return pending;
}

/* The names the gates have always read. */
export const liveConfig = (w) => ({
    LIVE_BASE: w.base, LIVE_USER: w.user, LIVE_PASS: w.pass,
    SSH_HOST: w.sshHost, SSH_PORT: w.sshPort, SSH_USER: w.sshUser, SSH_PASS: w.sshPass,
    SSH_AUTH_TYPE: 'password',
});

/* Run a command ON THE SSH TARGET, out of band: what the host itself sees. */
export function onTarget(w, command, { root = false } = {}) {
    return execFileSync('docker', ['exec', '-u', root ? 'root' : w.sshUser, w.container,
        'sh', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/* Put a local file on the SSH target, owned by the account; returns its path. */
export function copyToTarget(w, localFile, remoteDir = `/home/${w.sshUser}`) {
    const dest = `${remoteDir}/${path.basename(localFile)}`;
    docker(['cp', localFile, `${w.container}:${dest}`]);
    onTarget(w, `chown ${w.sshUser}: '${dest}'`, { root: true });
    return dest;
}
