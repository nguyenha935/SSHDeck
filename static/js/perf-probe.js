/*
 * THE PERFORMANCE PROBE (`?perf=1`) -- audit 2026-10-04.
 *
 * Owner: typing and scrolling stutter on a Windows PC whatever the browser,
 * less on a Mac, not at all on a phone. Measured on the server first
 * (headless Chromium, no GPU): a scroll is one mouse report per wheel notch
 * and ~1 KB from tmux; the app's own work per output frame is a few regexes;
 * a frame costs ~7 ms scrolling at any grid and 16.6 ms on heavy omp output
 * at 197x84 against 8.1 ms at the phone's 59x45. None of that tells Windows
 * from a Mac. What can -- the connection, the GPU, the fonts the browser
 * actually found, how long frames take while typing and scrolling -- is only
 * visible on that machine, so this counts it there.
 *
 * Off unless the page is opened with `?perf=1` (remembered on the device;
 * `?perf=0` turns it off). It only listens: the socket's onAny/onAnyOutgoing,
 * a wheel listener, the browser's frame observers. Once a minute with
 * activity it sends one flat record of numbers to the server log
 * (handle_perf_report). No keystroke or output content leaves the page.
 *
 * v2 (the first readings): Windows frames ran at ~600 ms with almost no
 * script or layout inside them, which says where the time is NOT, not where
 * it is. So a record now also says whether the main thread was blocked or
 * waiting (`lb`, and `lag`: how late a 100 ms timer fires), how much of the
 * minute the window had focus, and which renderer drew (`rend`, the WebGL
 * trial in terminal-manager.js).
 */
(() => {
    const STORE = 'sshdeck.perf';
    const REPORT_MS = 60000;
    const ECHO_TIMEOUT_MS = 3000;
    const ACTIVE_MS = 1500;
    const LAG_MS = 100;
    // Short codes: the server keeps 60 characters of a string.
    const FONT_CODES = {
        'IBM Plex Mono': 'plex', 'JetBrains Mono': 'jb', 'Source Code Pro': 'scp',
        Consolas: 'cons', 'Cascadia Mono': 'casc', Menlo: 'menlo', 'SF Mono': 'sfm',
        Monaco: 'mon', 'Courier New': 'cour', 'DejaVu Sans Mono': 'djv',
        'Segoe UI Emoji': 'sgemo', 'Segoe UI Symbol': 'sgsym', 'Apple Color Emoji': 'aemo',
        'Symbols Nerd Font': 'nerd',
    };

    function enabled() {
        const asked = new URLSearchParams(location.search).get('perf');
        try {
            if (asked === '1') localStorage.setItem(STORE, '1');
            if (asked === '0') localStorage.removeItem(STORE);
            return localStorage.getItem(STORE) === '1';
        } catch {
            return asked === '1';
        }
    }

    const socket = window.socket;
    if (!enabled() || !socket || typeof socket.onAny !== 'function'
            || typeof socket.onAnyOutgoing !== 'function') {
        return;
    }

    const now = () => performance.now();
    const fresh = () => ({
        keys: 0, echo: [], paint: [], outBytes: 0, outMsgs: 0, wheels: 0, frames: [],
        loaf: [0, 0, 0, 0], lb: [0, 0, 0, 0], lag: [], glyph: [0, 0, 0, 0],
        focusMs: 0, start: now(), active: false,
    });
    let win = fresh();
    let rtt = null;
    let focusedAt = document.hasFocus() ? now() : null;
    let mouseReportsSeen = mouseReports();
    let env = null;
    const pending = new Map();

    function mouseReports() {
        const counts = window.TerminalManager?.mouseReports || {};
        return Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    }

    // ── frames: sampled only while something is happening ──────────────
    let activeUntil = 0;
    let lastFrame = 0;
    let sampling = false;
    function tick(t) {
        if (lastFrame) win.frames.push(t - lastFrame);
        lastFrame = t;
        if (now() < activeUntil) {
            requestAnimationFrame(tick);
        } else {
            sampling = false;
            lastFrame = 0;
        }
    }
    function markActive() {
        win.active = true;
        activeUntil = now() + ACTIVE_MS;
        if (!sampling) {
            sampling = true;
            requestAnimationFrame(tick);
        }
    }

    /*
     * Long animation frames (Chromium 123+): how long, and in what. `loaf` is
     * [count, total, script, style+layout]; `lb` is [blocking, rendering,
     * frames that never rendered, longest]. A long frame whose blocking time
     * is small was WAITING (for the next frame to be granted), not working.
     */
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
        new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
            const end = entry.startTime + entry.duration;
            win.loaf[0] += 1;
            win.loaf[1] += entry.duration;
            win.loaf[2] += (entry.scripts || []).reduce((sum, s) => sum + s.duration, 0);
            if (entry.styleAndLayoutStart) win.loaf[3] += end - entry.styleAndLayoutStart;
            win.lb[0] += entry.blockingDuration || 0;
            if (entry.renderStart) {
                win.lb[1] += end - entry.renderStart;
            } else {
                win.lb[2] += 1;
            }
            win.lb[3] = Math.max(win.lb[3], entry.duration);
        })).observe({ type: 'long-animation-frame' });
    }

    // How late a 100 ms timer fires: the main thread's own answer to "was I
    // busy". Not counted while hidden, where the browser throttles timers.
    let lagDue = now() + LAG_MS;
    const lagTick = () => {
        const t = now();
        if (!document.hidden) win.lag.push(Math.max(0, t - lagDue));
        lagDue = t + LAG_MS;
        setTimeout(lagTick, LAG_MS);
    };
    setTimeout(lagTick, LAG_MS);

    window.addEventListener('focus', () => {
        if (focusedAt === null) focusedAt = now();
    });
    window.addEventListener('blur', () => {
        if (focusedAt !== null) {
            win.focusMs += now() - focusedAt;
            focusedAt = null;
        }
    });

    // ── input to echo ──────────────────────────────────────────────────
    socket.onAnyOutgoing((event, payload) => {
        if (event !== 'ssh_input' || !payload) return;
        win.keys += 1;
        markActive();
        const id = payload.session_id;
        if (id && !pending.has(id)) pending.set(id, now());
    });

    // Characters a monospace font may not carry: Nerd Font icons (private
    // use), braille spinners, emoji, box drawing.
    const GLYPHS = [/[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, /[⠀-⣿]/g,
        /\p{Extended_Pictographic}/gu, /[─-▟]/g];
    socket.onAny((event, payload) => {
        if (event !== 'ssh_output' || !payload || typeof payload.data !== 'string') return;
        const data = payload.data;
        win.outBytes += data.length;
        win.outMsgs += 1;
        markActive();
        GLYPHS.forEach((re, k) => { win.glyph[k] += (data.match(re) || []).length; });
        const sent = pending.get(payload.session_id);
        if (sent === undefined) return;
        pending.delete(payload.session_id);
        const arrived = now() - sent;
        if (arrived > ECHO_TIMEOUT_MS) return;
        win.echo.push(arrived);
        // Painted by the frame after the one the engine renders it in.
        requestAnimationFrame(() => requestAnimationFrame(() => win.paint.push(now() - sent)));
    });

    document.addEventListener('wheel', (event) => {
        if (event.target?.closest?.('.xterm')) {
            win.wheels += 1;
            markActive();
        }
    }, { capture: true, passive: true });

    // ── the machine ────────────────────────────────────────────────────
    function hasFont(family) {
        const ctx = document.createElement('canvas').getContext('2d');
        const sample = 'mmmmmmmmmmlli10OoWW@#█';
        return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
            ctx.font = `40px ${fallback}`;
            const plain = ctx.measureText(sample).width;
            ctx.font = `40px "${family}", ${fallback}`;
            return ctx.measureText(sample).width !== plain;
        });
    }

    function gpu() {
        try {
            const fast = document.createElement('canvas')
                .getContext('webgl', { failIfMajorPerformanceCaveat: true });
            const gl = fast || document.createElement('canvas').getContext('webgl');
            if (!gl) return { gpu: 'none', swgl: true };
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const name = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            // 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11
            // vs_5_0 ps_5_0, D3D11)' -> the vendor, the chip and the API, in
            // the 60 characters the server keeps.
            const label = String(name).replace(/^ANGLE \(|\)$/g, '')
                .replace(/\s*\(0x[0-9a-f]+\)|\s*[vp]s_\d_\d/gi, '').slice(0, 60);
            return { gpu: label, swgl: !fast };
        } catch {
            return { gpu: 'error', swgl: true };
        }
    }

    function environment() {
        const stack = getComputedStyle(document.body).getPropertyValue('--font-mono')
            .split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        const present = Object.keys(FONT_CODES).filter(hasFont);
        return Object.assign({
            dpr: window.devicePixelRatio,
            view: [innerWidth, innerHeight, screen.width, screen.height],
            cores: navigator.hardwareConcurrency || 0,
            mem: navigator.deviceMemory || 0,
            font: stack.find(f => present.includes(f)) || 'fallback',
            fonts: present.map(f => FONT_CODES[f]).join(','),
        }, gpu());
    }

    // The largest terminal on screen: its grid, the size it is drawn at.
    function grid() {
        const shown = Object.values(window.TerminalManager?.terminals || {})
            .filter(t => t?.element?.isConnected && t.element.getBoundingClientRect().width > 0);
        const big = shown.sort((a, b) => b.cols * b.rows - a.cols * a.rows)[0];
        return big ? [big.cols, big.rows, Number(big.options.fontSize) || 0, shown.length] : [0, 0, 0, 0];
    }

    // ── the report ─────────────────────────────────────────────────────
    function spread(list) {
        if (!list.length) return [0, 0, 0, 0];
        const sorted = list.slice().sort((a, b) => a - b);
        const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
        return [at(0.5), at(0.9), Math.round(sorted[sorted.length - 1]), sorted.length];
    }

    function frameSummary(frames) {
        const over = ms => frames.filter(d => d > ms).length;
        return [frames.length, spread(frames)[1], over(50), over(100)];
    }

    function report() {
        const at = now();
        pending.forEach((sent, id) => { if (at - sent > ECHO_TIMEOUT_MS) pending.delete(id); });
        const reports = mouseReports();
        const focused = win.focusMs + (focusedAt === null ? 0 : at - focusedAt);
        const record = {
            v: 2,
            rend: window.TerminalManager?.rendererInUse?.() || 'dom',
            tr: socket.io?.engine?.transport?.name || 'unknown',
            rtt: rtt === null ? -1 : rtt,
            keys: win.keys,
            echo: spread(win.echo),
            paint: spread(win.paint),
            outKB: Math.round(win.outBytes / 1024),
            outMsgs: win.outMsgs,
            wheels: win.wheels,
            mreports: Math.max(0, reports - mouseReportsSeen),
            frames: frameSummary(win.frames),
            loaf: win.loaf.map(Math.round),
            lb: win.lb.map(Math.round),
            lag: spread(win.lag),
            glyph: win.glyph,
            grid: grid(),
            focus: Math.round((100 * focused) / Math.max(1, at - win.start)),
            hidden: document.hidden,
        };
        mouseReportsSeen = reports;
        if (!env) {
            env = environment();
            Object.assign(record, env);
        }
        return record;
    }

    // A record covers one minute: an idle minute is dropped, not carried into
    // the next one's frames, timer samples and focus.
    function restart() {
        win = fresh();
        if (focusedAt !== null) focusedAt = now();
    }

    function send() {
        const record = report();
        restart();
        const sentAt = now();
        socket.emit('perf_report', { agent: navigator.userAgent.slice(0, 200), report: record }, () => {
            rtt = Math.round(now() - sentAt);
        });
        return record;
    }

    setInterval(() => {
        if (win.active) {
            send();
        } else {
            restart();
        }
    }, REPORT_MS);
    // From the console: SSHDeckPerf.flush() sends the minute so far.
    window.SSHDeckPerf = { flush: send };
})();
