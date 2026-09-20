const TerminalManager = {
    terminals: {},
    fitAddons: {},
    searchAddons: {},
    // Latest {resultIndex, resultCount} per terminal key -- see createTerminal.
    searchResults: {},
    terminalReady: {},
    pendingOutput: {},
    sessionTerminals: {},


    // The DOM wrapper each session's terminal lives in (attachTerminal).
    // updatePanePannable toggles the pannable state class on it; auto-pan on
    // new output needs it to reach scrollLeft.
    terminalContainers: {},
    transcripts: {},
    transcriptSizes: {},
    // The last STREAM_TAIL_MAX chars the engine was given, per session
    // (recordStreamTail); shipped by sendScreenDiagnostic.
    streamTail: {},
    // Panes held on their last good frame while a shrink waits for tmux's
    // repaint, keyed by terminal key (freezePaneForShrink).
    frozenPanes: {},
    // The window size when the app's own chrome took space from the pane;
    // null when no chrome is holding the grid (holdChromeGrid).
    chromeHold: null,
    touchScrollControllers: {},
    resizeObservers: {},
    scrollbarCleanups: {},
    scrollStateBySession: {},
    maxTranscriptSize: 200000,
    /*
     * W3 replay state, per SESSION (not per terminal key: a session's replay is
     * one logical stream even when it is mirrored into two panes).
     *
     *   replayState[sessionId] = {
     *       open:      true while chunks are still expected,
     *       nextSeq:   the sequence number that may be written next,
     *       held:      out-of-order chunks parked by seq,
     *       liveQueue: live ssh_output that arrived mid-replay,
     *       truncated: the server dropped an older prefix,
     *   }
     *
     * The problem this replaces: restore used to hand the whole buffer over on a
     * setTimeout(200) and hope it landed before the first live frame. On a busy
     * session it did not -- replayed history appeared AFTER newer output, or
     * interleaved with it mid-escape-sequence, which corrupts the screen rather
     * than merely reordering it. Sequencing plus a live queue makes the ordering
     * a property of the code instead of a race.
     */
    replayState: {},
    /*
     * W5 disposable registry: each session accumulates cleanup functions
     * (timers, socket listeners, observers) that must be released when the
     * session is destroyed. destroyTerminal drains the whole list. This
     * replaces ad-hoc cleanup scattered across multiple destroy branches.
     */
    disposables: {},



    getCssVar(name, fallback = '') {
        return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
    },

    isMacPlatform() {
        const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
        return /mac|iphone|ipad|ipod/i.test(platform);
    },

    shouldProcessClipboardKeyEvent(event, terminal, isMac) {
        if (event.type !== 'keydown' || event.altKey || event.shiftKey) {
            return true;
        }

        const key = (event.key || '').toLowerCase();
        if (key !== 'c' && key !== 'v') {
            return true;
        }

        if (isMac) {
            return !(event.metaKey && !event.ctrlKey);
        }

        if (!event.ctrlKey || event.metaKey) {
            return true;
        }

        return key === 'c' ? !terminal.hasSelection() : false;
    },

    buildTheme() {
        return {
            background: this.getCssVar('--term-background', '#1c2128'),
            foreground: this.getCssVar('--term-foreground', '#e6edf3'),
            cursor: this.getCssVar('--accent-primary', '#58a6ff'),
            cursorAccent: this.getCssVar('--term-background', '#1c2128'),
            selectionBackground: this.getCssVar('--accent-primary-glow', 'rgba(88, 166, 255, 0.4)'),
            black: this.getCssVar('--term-black', '#484848'),
            red: this.getCssVar('--term-red', '#ff6b6b'),
            green: this.getCssVar('--term-green', '#4ec97a'),
            yellow: this.getCssVar('--term-yellow', '#e5c07b'),
            blue: this.getCssVar('--term-blue', '#61afef'),
            magenta: this.getCssVar('--term-magenta', '#c678dd'),
            cyan: this.getCssVar('--term-cyan', '#56b6c2'),
            white: this.getCssVar('--term-white', '#dcdfe4'),
            brightBlack: this.getCssVar('--term-bright-black', '#636363'),
            brightRed: this.getCssVar('--term-bright-red', '#ff8787'),
            brightGreen: this.getCssVar('--term-bright-green', '#7ee0a0'),
            brightYellow: this.getCssVar('--term-bright-yellow', '#ffd68a'),
            brightBlue: this.getCssVar('--term-bright-blue', '#82c8f5'),
            brightMagenta: this.getCssVar('--term-bright-magenta', '#d9a0e8'),
            brightCyan: this.getCssVar('--term-bright-cyan', '#7ccbd4'),
            brightWhite: this.getCssVar('--term-bright-white', '#ffffff')
        };
    },

    getMonoFont() {
        return this.getCssVar('--font-mono', 'monospace');
    },

    getResponsiveFontSize() {
        const width = window.innerWidth;
        if (width < 480) return 12;
        if (width < 768) return 13;
        return 14;
    },

    /*
     * The font every terminal is SET to: the responsive default until the
     * user picks one (updateFontSize). A terminal presenting a shared window
     * smaller than its own fit is drawn LARGER than this for as long as that
     * lasts (presentWindowGrid) and comes back to it the moment the window is
     * its own fit again -- so the base is remembered here, not read back from
     * a terminal that may be zoomed.
     */
    baseFontSize: null,

    getBaseFontSize() {
        return this.baseFontSize || this.getResponsiveFontSize();
    },

    isMobile() {
        return window.innerWidth < 768 || 'ontouchstart' in window;
    },

    /*
     * Shell capability model.
     *
     * One question — is this a touch shell? — has one answer, shared by CSS
     * and JS. The canonical query is the SAME string the CSS media blocks use:
     * PRIMARY touch capability as a CONJUNCTION, (pointer: coarse) AND
     * (hover: none), plus the approved narrow-viewport fallback
     * (max-width: 767px).
     *
     * The former model OR-ed in two standalone branches, (hover: none) and
     * (any-pointer: coarse). Both matched a mouse-driven desktop that merely
     * OWNS a touchscreen or touch monitor, so such a desktop lost the approved
     * desktop shell entirely — the regression the owner.
     * Neither branch was ever needed to detect a real phone or tablet: both
     * answer YES to the conjunction, because their primary pointer is coarse
     * and they do not hover. The branches only added false positives, and every
     * false positive was a desktop.
     *
     * IsDesktopShell is the strict complement: fine+hover and NOT touch.
     * Width plays no part in either beyond the narrow fallback — width
     * otherwise gates density only. These helpers must stay in lockstep with
     * the @media (pointer: coarse) and (hover: none) blocks in style.css and
     * deck.css, header-menus.js's mobileShellMedia, touch-action-row.js's
     * TOUCH_QUERY and SessionManager.layoutCap, all of which read this same
     * constant or spell it identically.
     */
    TOUCH_SHELL_QUERY: '(pointer: coarse) and (hover: none), (max-width: 767px)',

    isTouchShell() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia(this.TOUCH_SHELL_QUERY).matches;
    },

    isDesktopShell() {
        if (this.isTouchShell()) {
            return false;
        }
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: fine) and (hover: hover)').matches;
    },

    /*
     * Scrollback capacity is user data -- localStorage, written by the Settings
     * input -- and xterm 5.3.0 does not defend itself against it. A bare
     * parseInt is not a validation: 'abc' gives NaN and `new Terminal` then
     * throws RangeError: Invalid array length, which killed the whole session
     * restore; a numeric PREFIX ('12abc', '1e3', '1.5') is silently accepted as
     * a 1-to-12 line capacity; '0' builds a terminal with no scrollback at all;
     * '-5' makes the engine substitute an undocumented 1000; and '999999' is
     * taken as-is, leaving the buffer user-unbounded.
     *
     * Normalising here means the engine never sees a value it has to interpret.
     * Two rules, deliberately different:
     *
     *   - anything that is not a well-formed integer -- INCLUDING 0, which is
     *     xterm's "no scrollback" sentinel -- means "nothing usable is stored",
     *     so the default applies;
     *   - a well-formed integer outside the range is clamped, so a stale or
     *     hand-edited bound still yields a working terminal.
     *
     * The bounds are the ones the Settings input declares (templates/index.html
     * min=50 max=10000) and must stay in lockstep with it. The DEFAULT is not a
     * free choice -- see SCROLLBACK_DEFAULT below.
     */
    SCROLLBACK_MIN: 50,
    SCROLLBACK_MAX: 10000,

    /*
     * The default capacity is DERIVED from the server's replay line
     * cap, not chosen.
     *
     * The two numbers were set independently and disagreed by a factor of 33.
     * `build_replay_chunks` sends up to REPLAY_MAX_LINES = 5000 lines of history
     * on restore (tmux itself holds 50000), and the client then built its
     * terminal with `scrollback: 150` -- so 4850 lines the server had already
     * serialised, sent over the socket and written into the engine were
     * immediately evicted from the buffer. Measured: of 400
     * clean-replay lines, 195 were reachable. The user's report ("scrollback lost
     * on reload") was literally true, and no amount of server-side work could fix
     * it while the client threw the bytes away on arrival.
     *
     * So the default is `min(SCROLLBACK_MAX, serverReplayLines)`: never more than
     * the user-facing ceiling the Settings input declares, and never less than
     * what the server is prepared to deliver. `serverReplayLines` is learned from
     * the session snapshot (`replay_max_lines`, noteServerReplayLines below); the
     * COMPILE-TIME FALLBACK is the value that field currently carries, so an old
     * server that does not send it produces exactly today's derived number rather
     * than a silent regression to 150.
     *
     * A user's own stored value still wins in both directions -- this is only
     * what applies when nothing usable is stored (sanitizeScrollback).
     *
     * HEAP: the raise was gated on measurement, not assumed safe. The worst
     * realistic mobile case (4 panes, 200-column grid, every buffer filled to
     * capacity) costs 44.4 MB of additional retained line arrays -- deterministic
     * walk of the engine's own Uint32Array line data, cross-checked against CDP
     * Runtime.getHeapUsage -- against the 120 MB ceiling. The gate that produced
     * that number is tests/browser/s16_d4_scrollback_heap_gate.mjs and it must
     * keep passing: it re-derives the ceiling check from the CURRENT constants,
     * so raising SCROLLBACK_MAX or the server cap re-measures rather than
     * inherits this verdict.
     */
    SERVER_REPLAY_LINES_FALLBACK: 5000,
    serverReplayLines: null,

    get SCROLLBACK_DEFAULT() {
        const cap = Number.isInteger(this.serverReplayLines)
            && this.serverReplayLines > 0
            ? this.serverReplayLines
            : this.SERVER_REPLAY_LINES_FALLBACK;
        return Math.max(this.SCROLLBACK_MIN,
            Math.min(this.SCROLLBACK_MAX, cap));
    },

    /*
     * Learn the server's replay line cap from a session snapshot. Called from
     * SessionManager's restore/create paths before the terminal is built, so the
     * first terminal of a restored session already gets the derived capacity.
     * Ignored unless it is a positive integer: a malformed field must leave the
     * compile-time fallback in place rather than produce a nonsense buffer.
     */
    noteServerReplayLines(lines) {
        const n = typeof lines === 'number' ? Math.trunc(lines) : NaN;
        if (Number.isFinite(n) && n > 0) {
            this.serverReplayLines = n;
        }
    },

    sanitizeScrollback(raw) {
        let lines;
        if (typeof raw === 'number') {
            lines = Number.isFinite(raw) ? Math.trunc(raw) : NaN;
        } else {
            const text = String(raw ?? '').trim();
            lines = /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
        }
        if (!Number.isFinite(lines) || lines === 0) {
            return this.SCROLLBACK_DEFAULT;
        }
        return Math.min(this.SCROLLBACK_MAX, Math.max(this.SCROLLBACK_MIN, lines));
    },

    createTerminal(sessionId, terminalKey = null) {
        const key = terminalKey || sessionId;
        const monoFont = this.getMonoFont();
        const theme = this.buildTheme();
        const scrollbackLines = this.sanitizeScrollback(
            localStorage.getItem('terminalScrollback'));
        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: this.getBaseFontSize(),
            fontFamily: monoFont || 'monospace',
            theme: theme,
            scrollback: scrollbackLines,
            scrollOnOutput: true,
            scrollOnUserInput: true,
            tabStopWidth: 4,
            allowProposedApi: true
        });

        /*
         * WIDTH TABLES MUST MATCH tmux, OR ROWS DRIFT.
         *
         * Measured on the owner's omp session. Its prompt row is
         * 108 characters that tmux (glibc wcwidth, Unicode 15) draws in 109
         * cells, because U+1F648 is wide; xterm's built-in Unicode 6 table
         * draws the same row in 108, because that table predates the emoji.
         * One cell short on a full-width row leaves the engine's cursor a
         * column behind tmux's bookkeeping, so the next repaint lands on the
         * wrong row -- and a spinner redrawn several times a second copied
         * the prompt row over every transcript row above it: the host pane
         * held ONE prompt row, the browser showed fifty. The Unicode 11
         * addon measures that row at 109, the same as tmux. Gates:
         * unicode_width_tmux.mjs (the table), live_omp_prompt_width.mjs
         * (the drift, against the deployed build).
         */
        if (typeof Unicode11Addon !== 'undefined') {
            terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
            terminal.unicode.activeVersion = '11';
        }
        this.ensureScreenDiagnosticButton();

        /*
         * Register the ScrollOwner observers HERE — immediately after
         * construction and before any code path can write to this terminal.
         * Measured invariant, not a style choice: the first write lands ~747ms
         * Later (attachTerminal's terminal.clear inside double-rAF + 50ms),
         * a replay chunk can carry `\x1b[?1002h\x1b[?1006h` in that very first
         * write, and an observer attached after it reads sgr=false while the
         * engine is already emitting. createTerminal is the only
         * terminal-construction path, so this cannot be missed.
         */
        this.ScrollOwner.attach(terminal);
        /*
         * ' — subscribe to the buffer-type change HERE, for the same reason
         * ScrollOwner attaches here: this is the only terminal-construction path,
         * and the first write can arrive before anything else runs. A listener
         * registered later would miss a TUI that is already on screen when the
         * client joins.
         */

        const isMac = this.isMacPlatform();
        terminal.attachCustomKeyEventHandler(event => (
            this.shouldProcessClipboardKeyEvent(event, terminal, isMac)
        ));

        // OSC 52 clipboard: when tmux runs a mouse-drag copy (copy-pipe-and-cancel
        // with set-clipboard on) or an app copies to clipboard, it emits
        // \x1b]52;c;<base64>\x07. xterm 5.3.0 has no built-in OSC 52 handler, so
        // register one to write the decoded text to the system clipboard — this is
        // the single missing piece that makes desktop mouse-drag copy work like a
        // Real terminal, with no Shift/button/mode toggle. Registered before open
        // so it is live for the first byte. Note: the PUBLIC API is
        // terminal.parser.registerOscHandler — terminal.registerOscHandler does not
        // exist and throws. Writes silently (no toast); the mobile long-press path
        if (terminal.parser && typeof terminal.parser.registerOscHandler === 'function') {
            terminal.parser.registerOscHandler(52, (data) => {
                // data is "<clipboard>;<base64>" e.g. "c;SGVsbG8="; take the part
                // after the first ';'. "?" is a clipboard query — ignore it so we
                // never leak clipboard contents back to the terminal.
                const sep = data.indexOf(';');
                const b64 = sep >= 0 ? data.slice(sep + 1) : data;
                if (b64 === '?') return true;
                try {
                    const bin = atob(b64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const text = new TextDecoder('utf-8').decode(bytes);
                    if (text && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => {});
                    }
                } catch (e) {
                    // Malformed payload: swallow so a bad OSC 52 never breaks the parser.
                }
                return true;
            });
        }

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);

        let searchAddon = null;
        if (typeof SearchAddon !== 'undefined') {
            searchAddon = new SearchAddon.SearchAddon();
            terminal.loadAddon(searchAddon);
            /*
             * P4 / mockup line 185 renders a live "2 / 5" match counter beside
             * the search box. The addon only reports resultIndex/resultCount
             * through onDidChangeResults, and only fires it when decorations are
             * enabled -- so the counter cannot be derived from findNext's
             * boolean. The latest event per terminal is cached here rather than
             * pushed straight into the DOM: TerminalManager owns terminals, not
             * Chrome, and the search UI reads it via getSearchResults. One
             * subscription per terminal, disposed with the terminal below.
             */
            if (typeof searchAddon.onDidChangeResults === 'function') {
                this.searchResults[key] = { resultIndex: -1, resultCount: 0 };
                searchAddon.onDidChangeResults((event) => {
                    this.searchResults[key] = {
                        resultIndex: event?.resultIndex ?? -1,
                        resultCount: event?.resultCount ?? 0,
                    };
                    document.dispatchEvent(new CustomEvent(
                        'sshdeck:search-results', { detail: { key } }));
                });
            }
        }

        this.terminals[key] = terminal;
        this.fitAddons[key] = fitAddon;
        this.searchAddons[key] = searchAddon;

        if (!this.sessionTerminals[sessionId]) {
            this.sessionTerminals[sessionId] = [];
        }
        if (!this.sessionTerminals[sessionId].includes(key)) {
            this.sessionTerminals[sessionId].push(key);
        }

        // OnResize is no longer the ssh_resize emit site. Reporting this
        // client's fitted geometry is DECOUPLED from whatever the terminal
        // happens to render: under the latest-active authority a non-active
        // client keeps its xterm at the authoritative grid (a pannable
        // viewport shows it), while STILL reporting its real local fit so the
        // server's registry sees every live client -- including small ones,
        // which is what lets the PTY hand to the next-most-recently-active
        // survivor when the active client leaves. reportLocalFit (called by
        // fitTerminal and updateFontSize, the two paths that actually re-fit)
        // is the single proposal channel; the SERVER alone decides whether the
        // shared PTY changes and answers on pty_geometry.
        terminal.onResize(({ cols, rows }) => {
            document.dispatchEvent(new CustomEvent('sshdeck:terminal-resized', {
                detail: { sessionId, terminalKey: key, cols, rows },
            }));
        });

        return terminal;
    },

    /*
     * This client's size PROPOSAL for one session. Sent through the one
     * ssh_resize channel; the server records it in its per-socket registry and
     * applies it to the PTY only when the proposing client is or becomes the
     * Active client (latest-active semantics). Smaller fits are still
     * reported -- they must be, so a departure can hand the grid to the
     * next-most-recently-active survivor -- they are simply not always applied.
     *
     * Fit is deduped per session against the last proposal sent: a layout event
     * that produces the same local size sends nothing (the old "a no-op fit
     * sends nothing" property), while a genuinely new size -- larger OR smaller
     * is always transmitted.
     */
    reportedSizes: {},

    // Dedupe scoping for reportedSizes. The
    // server's client-size registry is keyed by socket sid, so after any
    // socket-cycle event (reconnect, bfcache restore) the recorded sizes no
    // longer match what the server holds for this client. Bumping the epoch
    // makes the next fit re-propose its current size once so the server's
    // registry sees this client again. Bumped by app.js on socket reconnect;
    // the persisted pageshow handler bumps it too.
    socketEpoch: 0,

    resetSocketEpoch() {
        this.socketEpoch += 1;
        /*
         * A socket cycle takes every tmux client with it: the views were opened
         * on the OLD socket's channels, so the server closed them when that
         * socket went away and nothing here is attached any more. Forget the
         * state and the recorded sizes, then re-attach whatever is displayed --
         * the epoch bump is what lets the next fit re-send its unchanged size.
         */
        Object.keys(this.views || {}).forEach(
            sessionId => this.noteViewDropped(sessionId));
        this.viewAttachRetried = {};
        this.syncViews();
    },





    /*
     * Injectable clock. performance.now where available, so the deadline is
     * immune to wall-clock adjustment, and a plain field a test can stub without
     * touching globals.
     */
    now() {
        return (typeof performance !== 'undefined'
            && typeof performance.now === 'function')
            ? performance.now() : Date.now();
    },







    getDisplayedSessionsMap() {
        const allSessions = Object.keys(this.sessionTerminals || {});
        const map = {};
        allSessions.forEach(sid => { map[sid] = false; });
        // Fallback when the pane engine holds no real assignment for these
        // sessions: SessionManager missing, paneAssignments empty/undefined, or
        // every slot null (present but nothing assigned yet -- the pre-assignment
        // window where a session already has a live terminal). In all these
        // cases the sessions render directly, so treat them all as visible
        // (legacy single-pane behavior). Safe here because this function is only
        // reached on the visible=true path; the hidden path emits all-false
        // without calling it, so a wrong all-visible can never strand the grid.
        // Solo: one unassigned session is shown
        // full screen; it is the only view that should be attached.
        const solo = SessionManager && SessionManager.soloSessionId;
        if (solo && map.hasOwnProperty(solo)) {
            map[solo] = true;
            return map;
        }
        const assignments = (SessionManager && SessionManager.paneAssignments) || [];
        const hasRealAssignment = assignments.some(sid => sid && map.hasOwnProperty(sid));
        if (!SessionManager || !hasRealAssignment) {
            allSessions.forEach(sid => { map[sid] = true; });
            return map;
        }
        const isPortrait = window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches;
        if (isPortrait) {
            const activeSession = SessionManager.activeSessionId;
            if (activeSession && map.hasOwnProperty(activeSession)) {
                map[activeSession] = true;
            }
        } else {
            SessionManager.paneAssignments.forEach(sid => {
                if (sid && map.hasOwnProperty(sid)) {
                    map[sid] = true;
                }
            });
        }
        return map;
    },

    initOrientationWatch() {
        if (this._orientationWatchBound) {
            return;
        }
        const query = window.matchMedia('(max-width: 767px) and (orientation: portrait)');
        const handler = () => {
            // Phone portrait displays only the ACTIVE pane, so a rotation
            // changes which sessions are displayed, not merely their size.
            this.syncViews();
            this.fitAllTerminals();
        };
        if (query.addEventListener) {
            query.addEventListener('change', handler);
        } else if (query.addListener) {
            query.addListener(handler);
        }
        this._orientationWatchBound = true;
    },





    /*
     * THE ONE ssh_resize EMIT SITE: tell the server what this socket's pane
     * fits for this session.
     *
     * Under views this is no longer a proposal to be arbitrated.
     * The size goes to THIS socket's own tmux client, so the pane gets exactly
     * what it asked for, and tmux's `window-size smallest` does the rest: the
     * window follows whichever attached client is smallest, so every device can
     * display the whole pane and a device that stops watching detaches and
     * stops constraining it. Nothing is mirrored, held or answered, which is
     * why the quantization guard that used to live here is gone with it: it
     * corrected a measurement taken while this pane RENDERED a foreign grid,
     * and a pane now only ever renders its own fit.
     *
     * A session this socket has not attached yet cannot be resized -- there is
     * no client to resize -- so the fit ATTACHES instead and carries the
     * measured size into the attach. Without that, the first fit of a pane
     * would be silently dropped and the view would open at the wrong size.
     *
     */
    reportLocalFit(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0 || !window.socket) {
            return false;
        }
        const key = terminalKeys[0];
        const fitAddon = this.fitAddons[key];
        if (!fitAddon || !this.isTerminalVisible(key)) {
            return false;
        }
        let proposal = null;
        try {
            // Always the pure proposal (paneCellBox): the addon's own reads
            // the rendered cell, which moves with the grid -- the loop. And
            // the REPORTED one, so our own panels never resize the remote
            // pane (proposeReportedFit).
            proposal = this.proposeReportedFit(this.terminals[key]);
        } catch (e) {
            console.error('Error proposing fit dimensions:', e);
        }
        if (!proposal || !proposal.cols || !proposal.rows) {
            return false;
        }
        const cols = proposal.cols;
        const rows = proposal.rows;
        // The dedupe is scoped to the socket epoch, not just the size. The
        // server's view is keyed by socket sid, so a reconnect (new sid) or a
        // bfcache restore leaves the server holding no client for this page
        // while reportedSizes still remembers the last size sent. An epoch bump
        // (resetSocketEpoch) makes the next fit re-send its unchanged size
        // exactly once, after which no-change suppression resumes.
        const last = this.reportedSizes[sessionId];
        if (last && last.cols === cols && last.rows === rows
                && last.epoch === this.socketEpoch) {
            return false;
        }
        if (this.views[sessionId] === 'attaching') {
            // An attach is in flight carrying an earlier size. Park this one;
            // the ack applies it as one resize instead of racing the attach.
            this.pendingViewSizes[sessionId] = { cols, rows };
            return false;
        }
        this.reportedSizes[sessionId] = { cols, rows, epoch: this.socketEpoch };
        if (this.views[sessionId] !== 'attached') {
            return this.attachView(sessionId, { cols, rows });
        }
        window.socket.emit('ssh_resize', {
            session_id: sessionId,
            rows: rows,
            cols: cols
        });
        return true;
    },

    /*
     * ══ VIEWS ════════════════════════════════════════════════════════════════
     *
     *   views[sessionId] = 'detached' | 'attaching' | 'attached'
     *
     * One tmux client per socket per DISPLAYED session. That is what gives each
     * device its own size: tmux draws every client clipped to that client's own
     * grid, and `window-size smallest` keeps the pane readable on the smallest
     * one attached (measured on tmux 3.7c: a 51-column client received no
     * cursor addressing past its own width, and mouse DECSETs reached both
     * clients).
     *
     * So a pane that stops being displayed must DETACH rather than merely
     * report itself hidden: detaching is what hands the pane back to the other
     * device's size, and it took 1ms on the same measurement. Everything that
     * Changes WHAT IS DISPLAYED therefore ends in syncViews -- page
     * visibility, pagehide, a persisted pageshow, socket connect, pane
     * activation and assignment, layout changes, orientation, and the session
     * lifecycle events.
     */
    views: {},
    /*
     * Sessions whose scrollback this PAGE has already pulled.
     *
     * History is one-shot per session per page: the first attach asks for it
     * (`history: true`), and the re-attaches that happen every time a pane is
     * hidden and shown must not replay it again -- a view's own attach repaints
     * the visible screen by itself, and the scrollback above it has not changed.
     */
    viewHistoryDone: {},
    // Per-session attach timeout (see attachView).
    viewAttachTimers: {},
    // A fit measured while an attach was in flight, applied on the ack.
    pendingViewSizes: {},
    // Sessions whose attach has already been retried once.
    viewAttachRetried: {},
    // How long to wait for `view_attached` before one retry. Measured against
    // the deploy host over Tailscale, ten attach round trips: 432-472ms. The
    // margin is for a phone on mobile data, not for the normal case.
    VIEW_ATTACH_TIMEOUT_MS: 6000,
    // Spacing of the retries that follow a reported failure (see noteViewError).
    VIEW_RETRY_BACKOFF_MS: [5000, 10000, 20000, 30000],
    viewRetryDelays: {},
    viewRetryTimers: {},
    /*
     * windowGeometry[sessionId] = { cols, rows }
     *
     * The size the session's window is DRAWN at: the server's minimum over
     * every attached view's true fit (`tmux_window_geometry`). tmux would put
     * a window smaller than this client in the top-left corner with filler
     * around it, so the engine is sized to the window instead and the grid is
     * centred in the pane (see fitTerminal). The pane's TRUE fit is still what
     * reportLocalFit sends, so the minimum grows back the moment the smallest
     * device leaves.
     */
    windowGeometry: {},

    noteWindowGeometry(sessionId, cols, rows) {
        if (!sessionId || !(cols > 0) || !(rows > 0)) {
            return;
        }
        const current = this.windowGeometry[sessionId];
        if (current && current.cols === cols && current.rows === rows) {
            return;
        }
        this.windowGeometry[sessionId] = { cols, rows };
        // The engine takes the new size SYNCHRONOUSLY: the repaint at this
        // size is already behind this frame on the same socket, and the
        // engine must hold it when it lands.
        this.applyWindowGeometry(sessionId);
        // A new window IS a change worth presenting, so the zoom and the
        // anchor are recomputed now rather than on the settle timer.
        this.cancelPendingPresent(sessionId);
        this.presentNow(sessionId);
        // The rest of the fit -- the next proposal, the live edge -- is queued
        // rather than run here. Running it inline used to CANCEL the coalesced
        // fit that a resize in progress had queued and replace it with an
        // immediate one, which is how a drag turned into a round trip per
        // frame. See PROPOSAL_SETTLE_MS.
        this.requestFit(sessionId);
    },

    /*
     * Put every visible terminal of this session at the session's window size,
     * whatever the local fit says and whatever the keyboard is doing. This is
     * the one place the ENGINE == WINDOW == PTY invariant is enforced; see
     * resizeTerminalPreservingAltRows for what a mismatch looks like on screen.
     */
    applyWindowGeometry(sessionId) {
        const win = this.windowGeometry[sessionId];
        if (!win) {
            return;
        }
        (this.sessionTerminals[sessionId] || []).forEach(key => {
            const terminal = this.terminals[key];
            if (!terminal || !this.isTerminalVisible(key)) {
                return;
            }
            try {
                // A shrink leaves the OLD frame on screen until tmux repaints
                // (see freezePaneForShrink); the pane is held on its last good
                // frame across that gap rather than showing the leftovers.
                const shrinking = win.cols < terminal.cols;
                if (shrinking) {
                    this.freezePaneForShrink(key, terminal);
                }
                this.resizeTerminalPreservingAltRows(
                    terminal, win.cols, win.rows, true);
                this.presentWindowGrid(terminal);
                this.recentreTerminalScreen(terminal);
                if (shrinking && this.staleWideRows(terminal) === 0) {
                    // Nothing was left behind (the frame was narrower than the
                    // new grid): there is nothing to hide.
                    this.releaseFrozenPane(key);
                }
            } catch (e) {
                console.error('Error applying the window geometry:', e);
            }
        });
    },

    /*
     * Ask the server for a tmux client for this socket, at this pane's size.
     *
     * The size travels WITH the request because the server opens the channel's
     * PTY at it: attaching first and resizing after would make tmux compute
     * `window-size smallest` over an 80x24 client that does not exist visually,
     * and every other device would flicker down to it and back.
     */
    attachView(sessionId, size) {
        if (!sessionId || !window.socket
            || typeof window.socket.emit !== 'function') {
            return false;
        }
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0 || !this.isTerminalVisible(terminalKeys[0])) {
            return false;
        }
        let dims = size;
        if (!dims) {
            try {
                dims = this.proposeReportedFit(this.terminals[terminalKeys[0]]);
            } catch (e) {
                dims = null;
            }
        }
        if (!dims || !dims.cols || !dims.rows) {
            return false;
        }
        this.views[sessionId] = 'attaching';
        window.socket.emit('view_attach', {
            session_id: sessionId,
            cols: dims.cols,
            rows: dims.rows,
            // One-shot per page. Set BEFORE the emit so two attaches racing
            // through the same turn cannot both ask for the scrollback.
            history: !this.viewHistoryDone[sessionId],
        });
        this.viewHistoryDone[sessionId] = true;
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
        }
        this.viewAttachTimers[sessionId] = setTimeout(
            () => this.noteViewError(sessionId, 'attach timed out'),
            this.VIEW_ATTACH_TIMEOUT_MS);
        return true;
    },

    /*
     * Give up this socket's tmux clients for these sessions.
     *
     * The recorded size goes with them: the next attach measures the pane
     * again, and keeping a stale entry would let the dedupe in reportLocalFit
     * suppress the size the re-attach needs to carry.
     */
    detachViews(sessionIds) {
        const ids = (sessionIds || []).filter(
            sessionId => this.views[sessionId] && this.views[sessionId] !== 'detached');
        if (ids.length === 0) {
            return;
        }
        ids.forEach(sessionId => {
            this.views[sessionId] = 'detached';
            delete this.reportedSizes[sessionId];
            delete this.pendingViewSizes[sessionId];
            delete this.viewAttachRetried[sessionId];
            delete this.windowGeometry[sessionId];
            if (this.viewAttachTimers[sessionId]) {
                clearTimeout(this.viewAttachTimers[sessionId]);
                delete this.viewAttachTimers[sessionId];
            }
        });
        if (window.socket && typeof window.socket.emit === 'function') {
            window.socket.emit('view_detach', { session_ids: ids });
        }
    },

    /*
     * Bring the attached set in line with what is DISPLAYED right now.
     *
     * The displayed set is getDisplayedSessionsMap's -- which already knows
     * that phone portrait shows only the active pane, that a parked session is
     * never displayed, and that a page with no pane assignments yet renders
     * everything. A hidden document displays nothing at all.
     *
     * Idempotent and cheap, so every caller can just call it rather than
     * reasoning about which edge it is on. Synchronous for the same reason
     * reportVisibility was: `pagehide` may be the last task this document ever
     * runs, and a deferred detach is a lost detach -- which is exactly the
     * stuck-size bug ("the phone went away and the desktop stayed narrow").
     */
    syncViews() {
        const sessionIds = Object.keys(this.sessionTerminals || {});
        if (sessionIds.length === 0) {
            return;
        }
        const pageHidden = document.visibilityState === 'hidden';
        const displayed = pageHidden ? {} : this.getDisplayedSessionsMap();
        const drop = [];
        sessionIds.forEach(sessionId => {
            const shouldShow = !pageHidden && displayed[sessionId] === true;
            const state = this.views[sessionId] || 'detached';
            if (shouldShow && state === 'detached') {
                this.attachView(sessionId);
            } else if (!shouldShow && state !== 'detached') {
                drop.push(sessionId);
            }
        });
        this.detachViews(drop);
    },

    /*
     * This socket's client for a session is GONE and nothing needs telling.
     *
     * Used where the channel died with its transport: a reconnect swap, and a
     * socket cycle. There is deliberately no `view_detach` emit -- the server
     * closed those views when the old socket or transport went away, so the
     * message would address a client that no longer exists. The recorded size
     * goes too, or the dedupe in reportLocalFit would suppress the size the
     * re-attach has to carry.
     */
    noteViewDropped(sessionId) {
        this.views[sessionId] = 'detached';
        delete this.reportedSizes[sessionId];
        delete this.pendingViewSizes[sessionId];
        delete this.windowGeometry[sessionId];
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
            delete this.viewAttachTimers[sessionId];
        }
    },

    // The server accepted the attach: this socket now holds a tmux client.
    noteViewAttached(sessionId) {
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
            delete this.viewAttachTimers[sessionId];
        }
        this.views[sessionId] = 'attached';
        delete this.viewAttachRetried[sessionId];
        delete this.viewRetryDelays[sessionId];
        if (this.viewRetryTimers[sessionId]) {
            clearTimeout(this.viewRetryTimers[sessionId]);
            delete this.viewRetryTimers[sessionId];
        }
        this.reportFirstAttach(sessionId);
        const pending = this.pendingViewSizes[sessionId];
        delete this.pendingViewSizes[sessionId];
        if (pending) {
            // A fit landed while the attach was in flight. Send it now, as one
            // resize on the client that just opened.
            this.reportedSizes[sessionId] = {
                cols: pending.cols, rows: pending.rows, epoch: this.socketEpoch };
            window.socket.emit('ssh_resize', {
                session_id: sessionId,
                rows: pending.rows,
                cols: pending.cols,
            });
        }
    },

    /*
     * The server closed this socket's client for a session (its attach exited,
     * or the tmux session ended) while the SSH session itself is still alive.
     *
     * Re-attach only if the pane is still displayed, and only once: a session
     * that has really gone would otherwise be re-attached in a loop.
     */
    noteViewClosed(sessionId, reason) {
        this.views[sessionId] = 'detached';
        delete this.reportedSizes[sessionId];
        delete this.windowGeometry[sessionId];
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
            delete this.viewAttachTimers[sessionId];
        }
        if (this.viewAttachRetried[sessionId]) {
            console.warn('view closed again, leaving it detached',
                sessionId, reason);
            return;
        }
        this.viewAttachRetried[sessionId] = true;
        this.syncViews();
    },

    // The attach was refused, or never answered. One retry, then say so.
    noteViewError(sessionId, error) {
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
            delete this.viewAttachTimers[sessionId];
        }
        this.views[sessionId] = 'detached';
        delete this.reportedSizes[sessionId];
        delete this.windowGeometry[sessionId];
        if (!this.viewAttachRetried[sessionId]) {
            this.viewAttachRetried[sessionId] = true;
            this.syncViews();
            return;
        }
        console.error('Could not attach the terminal view', sessionId, error);
        if (typeof window.showNotification === 'function') {
            window.showNotification(
                window.i18n
                    ? window.i18n.t('session.viewAttachFailed')
                    : 'This terminal could not be attached. Reload the page.',
                'error');
        }
        /*
         * AND THEN KEEP TRYING. Two failures used to end it: the view stayed
         * detached until something else happened to call syncViews, so a
         * dropped tab could leave a session dark until the page was reloaded
         * socket that has not finished reconnecting, a server still cleaning
         * up the previous view), so the retry is simply spaced out: 5s, 10s,
         * 20s, then every 30s, cleared the moment an attach succeeds.
         */
        const step = this.viewRetryDelays[sessionId] || 0;
        const delay = this.VIEW_RETRY_BACKOFF_MS[
            Math.min(step, this.VIEW_RETRY_BACKOFF_MS.length - 1)];
        this.viewRetryDelays[sessionId] = step + 1;
        if (this.viewRetryTimers[sessionId]) {
            clearTimeout(this.viewRetryTimers[sessionId]);
        }
        this.viewRetryTimers[sessionId] = setTimeout(() => {
            delete this.viewRetryTimers[sessionId];
            delete this.viewAttachRetried[sessionId];
            this.syncViews();
        }, delay);
    },

















    /*
     * ScrollOwner — the single answer to "which row owns this vertical
     * gesture?".
     *
     * It is a resolver, not a gesture handler: `resolve` is a pure function
     * of four inputs, and the only state it keeps is one `sgr` flag per
     * Terminal. The gesture path calls `resolve` ONCE at touchstart and
     * freezes the row for the whole gesture (D-2), because a `\x1b[?1002h`
     * written between move #3 and #4 changes the live value mid-gesture
     * and a per-move read would let a locally-scrolling gesture jump
     * onto the byte-emitting branch in flight.
     *
     *   tracking   terminal.modes.mouseTrackingMode   authoritative; RIS resets
     *                                                 it correctly
     *   buffer     terminal.buffer.active.type        read fresh, never inside
     *                                                 a parser handler
     *   capacity   terminal.options.scrollback > 0    S1 guarantees a sane
     *                                                 value
     *   sgr        owned here, maintained by observers
     *
     * WHY THE FLAG EXISTS AT ALL. `terminal.modes` has exactly nine fields and
     * none of them is the mouse encoding: `drag` and `drag`+1006 are
     * byte-identical on `modes` even though one emits and the other does not
     *. And SGR (1006) is the ONLY encoding this build reports a
     * wheel through — 1015 (urxvt) and 1005 (utf8) are logged no-ops in the
     * vendored bundle and emit nothing at all, not even a click, so
     * they land on D0/E0 by construction. 1016 (SGR_PIXELS) is deliberately
     * NOT counted as `sgr`: the predicate the plan froze is SGR-only, and an
     * unobserved encoding must fall to D0/E0 — the safe direction (no bytes),
     * never a synthesized wheel.
     *
     * THE OBSERVERS, AND WHY THEY LOOK LIKE THIS. Exactly three, all
     * registered in `createTerminal` immediately after construction:
     *
     *   CSI ?…h  — params containing 1006 set the flag
     *   CSI ?…l  — params containing 1006 (or 1016, which the engine also
     *              resets to DEFAULT) clear it
     *   ESC c    — RIS clears it: the engine clears tracking AND encoding
     *              there, measured twice
     *
     * DECSTR (`CSI !p`) gets NO handler on purpose. The engine does not clear
     * the encoding there — after `ESC[!p` the wheel still emits — so a
     * DECSTR-clears predicate mispredicts "no bytes" while bytes still flow,
     * wrong in the unsafe direction; that single mistake was the whole of
     * r36's three disagreements.
     *
     * Every handler returns false. Returning true SWALLOWS the DECSET and the
     * mode never changes — the observer would destroy the
     * state it exists to watch. `lastRegisteredReturnValues` records this at
     * registration time rather than trusting it.
     *
     * No handler reads `modes` or the active buffer inline: handlers run
     * BEFORE the engine's own state change, so an inline
     * read returns the OLD value. Params are the one legal input.
     *
     * Registration must precede any `write`. Measured: construction at
     * t=1134ms, first write at t=1881ms (a ~747ms window), and a
     * construction-time observer DID see a `?1006h` carried inside a replay
     * chunk; a late observer read `sgr` false while the engine was emitting
     *. DECRQM (`CSI ?1006$p`) would answer correctly on this
     * build but is banned from this path: the query writes bytes to
     * the PTY and its reply arrives on `terminal.onData`, the same channel as
     * user keystrokes.
     */
    ScrollOwner: {
        // Per-terminal state, keyed by the terminal itself so a disposed
        // terminal cannot keep an entry alive. Detached/unknown terminal =>
        // No entry => resolve fail-closes to G.
        _state: new WeakMap(),

        // Recorded at registration: the three observers' actual return values.
        // Anything other than three falses means an observer is swallowing
        // sequences it only meant to watch.
        lastRegisteredReturnValues: null,

        // The observers' own source text, exposed so the "no engine-state read
        // inside a handler" constraint is checkable rather than asserted.
        handlersSource: '',

        attach(terminal) {
            if (!terminal || !terminal.parser) {
                return { dispose() {} };
            }
            this.detach(terminal);

            const entry = { sgr: false, provenanceUntrusted: false, disposables: [] };
            this._state.set(terminal, entry);

            /*
             * The public API shape, verified in the vendored bundle: ParserApi
             * Wraps the core handler as `e => t(e.toArray)`, so a handler
             * registered through `terminal.parser.registerCsiHandler` receives
             * a plain ARRAY of numbers, not an IParams. Accept either shape —
             * an IParams arriving here (a direct core registration) must not
             * throw, because a throwing handler aborts the whole sequence and
             * the DECSET is lost exactly like a `true` return.
             */
            const paramList = (params) => {
                if (Array.isArray(params)) {
                    return params;
                }
                if (params && typeof params.toArray === 'function') {
                    return params.toArray();
                }
                return [];
            };
            const onPrivateSet = (params) => {
                if (paramList(params).indexOf(1006) !== -1) {
                    entry.sgr = true;
                }
                return false;
            };
            const onPrivateReset = (params) => {
                const list = paramList(params);
                if (list.indexOf(1006) !== -1 || list.indexOf(1016) !== -1) {
                    entry.sgr = false;
                }
                return false;
            };
            const onFullReset = () => {
                entry.sgr = false;
                return false;
            };

            this.handlersSource = [paramList, onPrivateSet, onPrivateReset, onFullReset]
                .map(fn => String(fn)).join('\n');

            // Self-check before the terminal ever sees a byte: run each
            // observer once with empty params. They are pure observers, and a
            // fresh entry already has sgr false, so this cannot alter state.
            this.lastRegisteredReturnValues = [
                onPrivateSet([]),
                onPrivateReset([]),
                onFullReset(),
            ];

            entry.disposables.push(
                terminal.parser.registerCsiHandler(
                    { prefix: '?', final: 'h' }, onPrivateSet),
                terminal.parser.registerCsiHandler(
                    { prefix: '?', final: 'l' }, onPrivateReset),
                terminal.parser.registerEscHandler({ final: 'c' }, onFullReset),
            );

            return { dispose: () => this.detach(terminal) };
        },

        detach(terminal) {
            if (!terminal) {
                return;
            }
            const entry = this._state.get(terminal);
            if (!entry) {
                return;
            }
            entry.disposables.forEach(d => {
                try {
                    d.dispose();
                } catch (e) {
                    // A terminal already disposed took its handlers with it;
                    // teardown must not throw on the way out.
                }
            });
            this._state.delete(terminal);
        },

        // Undefined for a terminal this module does not track — deliberately
        // distinguishable from a tracked terminal whose flag is false.
        sgrFlagFor(terminal) {
            const entry = terminal ? this._state.get(terminal) : undefined;
            return entry ? entry.sgr : undefined;
        },

        /*
         * The §6.1 row, fail-closed. Same shape as
         * isSafeToReconcileRemoteLine: anything unreadable is G, and G means
         * local scroll only — zero bytes.
         */
        resolve(terminal) {
            if (!terminal) {
                return 'G';
            }
            let tracking;
            let bufferType;
            let capacity;
            try {
                const modes = terminal.modes;
                tracking = modes ? modes.mouseTrackingMode : undefined;
                const active = terminal.buffer ? terminal.buffer.active : undefined;
                bufferType = active ? active.type : undefined;
                capacity = !!(terminal.options
                    && terminal.options.scrollback > 0);
            } catch (e) {
                return 'G';
            }
            if (typeof tracking !== 'string' || typeof bufferType !== 'string') {
                return 'G';
            }
            const entry = this._state.get(terminal);
            if (!entry) {
                // Detached or never registered: no observed encoding at all,
                // so there is no honest answer for the D/E rows.
                return 'G';
            }
            const alternate = bufferType === 'alternate';
            if (tracking === 'none') {
                if (alternate) {
                    return 'C';
                }
                return capacity ? 'A' : 'B';
            }
            if (tracking === 'x10') {
                return 'F';
            }
            /*
             * Provenance gate. The D/E/D0/E0 resolutions all trust
             * tracking+encoding state that a TRUNCATED replay may have
             * established from trim debris -- a preamble whose matching reset
             * was in the discarded prefix, with no repaint coming. A row that
             * can put bytes on the PTY (D/E) or strand the gesture as a no-op
             * (C/D0) must not be resolved from that state: fail closed to a
             * locally-scrolling row instead. The flag is cleared by the first
             * LIVE output frame, so a genuine attach that follows the restore
             * upgrades the row exactly when real bytes establish it.
             */
            if (entry.provenanceUntrusted) {
                return capacity ? 'A' : 'B';
            }
            if (entry.sgr === true) {
                return alternate ? 'D' : 'E';
            }
            return alternate ? 'D0' : 'E0';
        },

        /*
         * Mark a terminal's observed DECSET state as untrustworthy --
         * it may have been written by truncated-replay debris rather than by
         * the live application. Idempotent, and a no-op for a terminal this
         * module does not track (resolve already fail-closes those to G).
         */
        markProvenanceUntrusted(terminal) {
            if (!terminal) {
                return;
            }
            const entry = this._state.get(terminal);
            if (entry) {
                entry.provenanceUntrusted = true;
            }
        },

        /*
         * Clear the untrusted-provenance mark. Called when LIVE output
         * reaches the engine: live bytes are the real application speaking, so
         * the tracking/encoding state they establish is genuine.
         */
        clearProvenanceUntrusted(terminal) {
            if (!terminal) {
                return;
            }
            const entry = this._state.get(terminal);
            if (entry) {
                entry.provenanceUntrusted = false;
            }
        },

        /*
         * The READER the two mutators above lacked.
         *
         * Resolve consults `entry.provenanceUntrusted` inline at:937 to
         * fail-close the byte-emitting rows. isSafeToReconcileRemoteLine needs
         * the same answer for the same reason -- a control byte must not be
         * authorised by DECSET state that truncated replay debris established
         * so it is exposed here rather than by reaching into the private
         * WeakMap from outside.
         *
         * A terminal with NO entry answers false. That cannot happen for a
         * terminal that reached the caller's gates (1) and (2), both of which
         * require a live attached terminal that ScrollOwner.attach registered
         * At createTerminal; and it is the same answer resolve effectively
         * gives such a terminal today, which fail-closes to 'G' at :914 before
         * the flag is ever read.
         */
        isProvenanceUntrusted(terminal) {
            const entry = this._state.get(terminal);
            return !!(entry && entry.provenanceUntrusted);
        },
    },








    /*
     * COMPOSER INPUT OWNERSHIP.
     *
     * While the shared composer is visible it is the sole logical keyboard owner,
     * anywhere in the workspace. A click inside the terminal used to land on
     * xterm's hidden textarea, so the user watched a visible, focused-looking
     * text box while their keystrokes went somewhere else entirely -- and
     * Vietnamese composition lost the editing surface it needs.
     *
     * Implementation notes that matter:
     *
     *  - `click`, so ONE handler covers a mouse click and a touch tap (a single
     *    tap ends in a synthetic click). It runs after xterm's own mousedown, so
     *    a click-drag to select text completes before focus can move.
     *  - A real text SELECTION is left alone. Refocusing the composer collapses
     *    the terminal's selection, so a user selecting output to copy keeps it.
     *  - Only when the composer is visible. When it is hidden (ordinary wide
     *    desktop) this does nothing at all, so native xterm input stays direct
     *    and fast -- that is the second half of the same ruling.
     *  - TOUCH IS INCLUDED. An intentional tap on the
     *    terminal may focus the visible composer, keyboard and all: the user just
     *    aimed at the typing surface. The v3 strict-focus rule that forbids
     *    summoning the keyboard governs CONNECTION-CHIP taps (focusActivePane
     *    stays a no-op on touch for exactly that reason), not a deliberate tap
     *    into the terminal.
     *  - A DOUBLE tap is unaffected: its touchend calls preventDefault, which
     *    suppresses the synthetic click, so raw xterm focus still wins there.
     */
    /*
     * S16 defect 1 — does the NOTES surface currently own the keyboard?
     *
     * The composer-first redirectors below are unconditional by design: while
     * the composer is visible it is the sole logical keyboard owner. The Notes
     * sheet is the one OTHER text surface the shell puts in front of the user,
     * and it is a genuine exception: a user typing a note has aimed at that
     * textarea, so a redirector that moves focus to #mobileInput mid-note takes
     * The rest of the note into the composer -- the user's "note text leaks
     * INTO the composer input box" (measured:
     * tests/browser/s16_d1_notepad_focus_leak.mjs §F1/§F2/§F4).
     *
     * Read from the LIVE focus state, never from a flag: `body.notepad-focused`
     * is written by two different places (app.js focus/blur and the keyboard
     * transition edge in this file) and the whole defect exists because those
     * two can disagree for a frame. `document.activeElement` cannot.
     */
    notepadOwnsKeyboard() {
        const active = document.activeElement;
        if (!active) {
            return false;
        }
        if (active.id === 'sessionNotepad') {
            return true;
        }
        const panel = document.getElementById('notepadPanel');
        return !!(panel && panel.contains(active));
    },

    setupComposerInputOwnership(container) {
        if (!container || container.dataset.composerOwnershipBound === 'true') {
            return;
        }
        container.dataset.composerOwnershipBound = 'true';
        container.addEventListener('click', () => {
            // Desurgery: desktop clicks belong to xterm (keystrokes
            // go straight into the terminal). Only a touch shell redirects a
            // terminal-area tap to the composer.
            if (!this.isTouchShell()) {
                return;
            }
            if (typeof SessionManager === 'undefined'
                || !SessionManager.composerOwnsInput()) {
                return;
            }
            // S16 defect 1: the Notes textarea keeps the keyboard it owns.
            if (this.notepadOwnsKeyboard()) {
                return;
            }
            const selection = window.getSelection?.();
            const hasTerminalSelection = !!(selection && !selection.isCollapsed)
                || !!container.querySelector('.xterm-selection div');
            if (hasTerminalSelection) {
                return;
            }
            const input = document.getElementById('mobileInput');
            if (input && document.activeElement !== input) {
                input.focus();
            }
        });

        // P1-3 (B): Composer-first touch authority. On a touch shell, xterm's
        // synthetic mousedown or internal helper focus must NEVER steal focus
        // from #mobileInput (the single authoritative composer). When the
        // xterm helper textarea receives focus on touch, immediately redirect
        // it to #mobileInput.
        container.addEventListener('focusin', (e) => {
            if (!this.isTouchShell()) {
                return;
            }
            /*
             * S16 defect 1: the Notes textarea keeps the keyboard it owns.
             *
             * Both directions have to be read here. When the helper has already
             * taken focus, `document.activeElement` IS the helper, so the
             * question "was Notes typing a moment ago?" is answered by
             * `relatedTarget` -- the element focus is moving AWAY from, which
             * focusin carries. When the panel is hidden out from under the
             * caret (style.css:5018) focus collapses to <body> and
             * relatedTarget is the notepad; when a synthetic focusin arrives
             * with the caret still in the note, activeElement is the notepad.
             * Either signal means: do not redirect.
             */
            const from = e.relatedTarget;
            const panel = document.getElementById('notepadPanel');
            const cameFromNotes = !!(from && (from.id === 'sessionNotepad'
                || (panel && panel.contains(from))));
            if (cameFromNotes || this.notepadOwnsKeyboard()) {
                return;
            }
            const target = e.target;
            if (target && target.classList && target.classList.contains('xterm-helper-textarea')) {
                const input = document.getElementById('mobileInput');
                if (input && document.activeElement !== input) {
                    input.focus();
                }
            }
        }, true);
    },

    attachTerminal(sessionId, containerId, terminalKey = null) {
        const key = terminalKey || sessionId;
        const terminal = this.terminals[key];
        if (!terminal) {
            console.error('Terminal not found:', sessionId);
            return false;
        }

        const container = document.getElementById(containerId);
        if (!container) {
            console.error('Container not found:', containerId);
            return false;
        }

        // Remember the session's wrapper so the pannable-viewport state
        // and the auto-pan on new output can reach the scroll container.
        this.terminalContainers[sessionId] = container;

        this.pendingOutput[key] = [];
        this.terminalReady[key] = false;
        if (!this.transcripts[sessionId]) {
            this.transcripts[sessionId] = [];
            this.transcriptSizes[sessionId] = 0;
        }

        terminal.open(container);

        // Keep the scroll-state observation (Exit-Scroll depends on it).
        // The custom scrollbar overlay it used to build was retired -- see
        // observeScrollState for the measurements.
        this.observeScrollState(terminal, key);

        // Unified touch gestures: swipe -> tmux history scroll, long-press ->
        // select + drag-extend + auto-copy. Bound on the wrapper (container) in
        // capture phase so it can gate xterm's own touch handling. See
        // setupTouchGestures for the full rationale.
        this.setupTouchGestures(key, container);

        this.setupComposerInputOwnership(container);

        // Safari + a Vietnamese IME: deliver the composed text ourselves when
        // the engine's own composition path delivers nothing. See
        // setupCompositionRescue.
        this.setupCompositionRescue(terminal, sessionId, key);

        // Maintain the live-edge flag from xterm's own scroll events, so a
        // resize has a trustworthy answer to "was the user at the live edge"
        // BEFORE the browser clamps anything. See liveEdgeIntent.
        this.observeLiveEdge(key);

        // Re-fit whenever the wrapper's real rendered size changes. On mobile the
        // initial fit runs before the dvh/visualViewport layout settles, so the
        // terminal starts as a short box until the keyboard opens. Observing the
        // actual container size covers startup, dvh settle, rotation, and
        // keyboard show/hide uniformly — no single CSS min-height tweak can,
        // because there are three different min-height floors across three media
        // Contexts. fit only changes rows/cols and the inner.xterm (the
        // wrapper is height:100%/overflow:hidden, sized by the pane), so
        // observing the wrapper cannot self-trigger; the debounce absorbs noise.
        this.setupResizeObserver(key, sessionId, container);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.fitTerminal(sessionId);

                setTimeout(() => {
                    terminal.clear();
                    // DRAIN, not discard. The restore replay is pushed
                    // by the server at connect time (socket_events.py:
                    // restore_user_sessions), and on a slow desktop paint it
                    // lands entirely inside this readiness window (double-rAF
                    // + 50ms). Discarding it lost the whole restored history
                    // the blank desktop terminal that only "unblocked"
                    // when a phone happened to trigger live bytes.
                    //
                    // Everything buffered since THIS attach began belongs to
                    // this terminal: pendingOutput[key] is reset at attach
                    // start above and deleted by destroyTerminalKey, and
                    // writeOutputNow drops frames for sessions whose terminal
                    // list is empty, so no stale-session frame can enter the
                    // buffer after the reset. Write it back in order; the
                    // replay sequencer above already guarantees arrival order.
                    const buffered = this.pendingOutput[key] || [];
                    this.pendingOutput[key] = [];
                    this.terminalReady[key] = true;
                    buffered.forEach(chunk => {
                        // The drain is a FUNNEL WRITE and must carry
                        // the sessionId like every other one -- without it the
                        // mouse-policy observer (and reconcile evidence) never
                        // sees bytes that landed inside the readiness window,
                        // which on a restore is exactly when the replay lands.
                        this.writeToTerminalWithScroll(terminal, chunk, sessionId);
                    });
                }, 50);
            });
        });

        return true;
    },

    // Map a viewport pixel coordinate to an absolute buffer cell {col, row}.
    // Row is ABSOLUTE (viewportY added) because terminal.select addresses the
    // buffer, not the viewport. Geometry comes from .xterm-screen's rect (public
    // DOM), so it holds on the alt-screen tmux always attaches to.
    clientToCell(terminal, clientX, clientY) {
        if (!terminal || !terminal.element) {
            return null;
        }
        const screen = terminal.element.querySelector('.xterm-screen') || terminal.element;
        const rect = screen.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        const cellW = rect.width / terminal.cols;
        const cellH = rect.height / terminal.rows;
        let col = Math.floor((clientX - rect.left) / cellW);
        let viewportRow = Math.floor((clientY - rect.top) / cellH);
        col = Math.max(0, Math.min(terminal.cols - 1, col));
        viewportRow = Math.max(0, Math.min(terminal.rows - 1, viewportRow));
        const bufferRow = terminal.buffer.active.viewportY + viewportRow;
        return { col, row: bufferRow };
    },

    // Route focus after a touch gesture that suppressed its synthetic click.
    // A long-press copy calls preventDefault on touchend, so the click that
    // normally reaches .terminal-pane -> setActivePane -> focusActivePane never
    // fires. Without this the page is left focused on xterm's hidden textarea
    // and mobile loses the Vietnamese IME.
    //
    // Uses the bare lexical `SessionManager` binding: these are classic scripts,
    // so the top-level `const SessionManager` is NOT a property of window
    // (window.SessionManager is undefined — checking it would silently skip).
    routeFocusAfterTouch(wrapper) {
        if (typeof SessionManager === 'undefined' || !SessionManager) {
            return;
        }
        const pane = wrapper && wrapper.closest ? wrapper.closest('.terminal-pane') : null;
        const paneIndex = pane ? Number(pane.dataset.paneIndex) : NaN;
        if (Number.isInteger(paneIndex) && paneIndex !== SessionManager.activePaneIndex) {
            // Activate the pane that was actually touched first, otherwise the
            // input that follows would be sent to the previously active session.
            SessionManager.setActivePane(paneIndex);   // also focuses
            return;
        }
        SessionManager.focusActivePane();
    },

    // Toast the real clipboard outcome. navigator.clipboard.writeText rejects on
    // iOS when the write is not tied to a user gesture (or permission is denied),
    // so an unconditional "copied" toast was reporting success for an empty
    // clipboard.
    reportCopyResult(text) {
        const notify = (key, fallback, type) => {
            const msg = (window.i18n ? window.i18n.t(key) : fallback);
            if (window.showNotification) {
                window.showNotification(msg, type);
            }
        };
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            notify('clipboard.copyFailed', 'Không copy được', 'error');
            return;
        }
        navigator.clipboard.writeText(text).then(() => {
            notify('clipboard.copied', 'Đã copy', 'success');
        }).catch(() => {
            notify('clipboard.copyFailed', 'Không copy được', 'error');
        });
    },

    // Unified touch handling. Two gestures share one set of listeners:
    //   * swipe (finger moves before the long-press timer fires) -> the vertical
    //     gesture. S5 / D-1: the OWNER of that gesture is always JS, and what JS
    //     does is decided by ONE row resolved from ScrollOwner at touchstart:
    //       D, E            -> synthesize N discrete LINE-MODE wheels so xterm
    //                          encodes them as SGR mouse reports for the app.
    //                          xterm emits at most one report per wheel event
    //                          regardless of pixel delta and drops sub-cell
    //                          pixel wheels entirely, so N = round(accumulated
    //                          px / cellHeight) gives exactly N reports,
    //                          proportional to travel, with no dead-zone.
    //       A, B, F, G, E0  -> terminal.scrollLines(n), zero bytes.
    //       C, D0           -> an explicit no-op, zero bytes.
    //     The row, not a yes/no question about mouse tracking, is the authority:
    //     the previous guard synthesized a wheel whenever tracking was on OR the
    //     session ran tmux, which is wrong in both directions. It fired on rows
    //     D0/E0 where a wheel produces NO bytes at all so the finger
    //     moved and nothing happened, and it fired on row C where xterm turns a
    //     wheel into CURSOR KEYS, i.e. ESC[A straight into the shell. It also
    //     declined rows A/B/F/G entirely, leaving the native scroller and this
    //     handler fighting over one finger. See plan section 4.5 (as corrected
    //     by 4.5.2(e)) for the row table and section 6.1 for the resolver.
    //   * long-press (timer fires before the finger moves) -> selection. We
    //     select the cell under the finger, extend on drag, and copy on lift.
    //     This is pure JS on top of terminal.select/getSelection, independent
    //     of tmux, so it works whether mouse mode is on or off. Selection wins
    //     over the vertical gesture: while selecting, no row action runs.
    //
    // Bound on the wrapper (container) in CAPTURE phase, not on terminal.element:
    // xterm binds its own touch listener to .xterm (a child of the wrapper) to
    // scroll the viewport when mouse tracking is off. A capture-phase listener on
    // the parent runs first, which is what lets S6 exclude that native scroll
    // Entirely: the touchmove handler calls stopPropagation for EVERY gesture,
    // so the event never reaches .xterm and JS is the only owner of one finger
    // (D-3b, §4.6.2). Multi-touch is stopPropagation-only, so the browser keeps
    // its pinch-zoom. Before S6 the stopPropagation lived inside the `selecting`
    // branch alone, which left every other row with two competing owners.
    setupTouchGestures(terminalKey, container) {
        const terminal = this.terminals[terminalKey];
        const element = terminal?.element;
        if (!terminal || !element) {
            return;
        }
        const wrapper = container
            || (element.closest ? element.closest('.terminal-wrapper') : null)
            || element;

        const controller = new AbortController();
        const { signal } = controller;

        const cellHeight = () => {
            const screen = element.querySelector('.xterm-screen') || element;
            const rect = screen.getBoundingClientRect();
            return rect.height / terminal.rows || 1;
        };

        const MOVE_THRESHOLD = 10;   // px before a touch counts as a swipe
        /*
         * The long-press must be abandoned the instant the finger starts to
         * travel, well BEFORE the 10px swipe threshold. A slow or short pan
         * that had not yet crossed MOVE_THRESHOLD within 500ms used to let the
         * long-press timer fire and flip the gesture into selection mid-swipe --
         * the "pan janky" report. A smaller cancel radius means a pan reads as a
         * pan from its first few pixels; the 10px axis threshold is unchanged so
         * a real still-finger long-press (zero travel) still selects.
         */
        const LONG_PRESS_CANCEL_PX = 6;
        /*
         * S7 / D-4' (§4.7, §6.2): the axis ratio. A gesture is horizontal only
         * when it is decisively horizontal -- abs(dx) > abs(dy) * 1.2 -- so a
         * slightly-slanted vertical swipe still scrolls rows. The constant is
         * the approved one; it is what makes (8,6) lock to x (8 > 7.2) while
         * (7,6) locks to y (7 < 7.2).
         */
        const AXIS_RATIO = 1.2;
        const LONG_PRESS_MS = 500;
        const DOUBLE_TAP_MS = 300;   // two taps within this window => raw terminal focus
        const DOUBLE_TAP_PX = 24;    // ...and no further apart than this

        // Per-terminal gesture state, kept in closure (no this.interaction).
        let startX = null, startY = null, lastY = null;
        /*
         * S7 / D-4': the horizontal origin, updated EVERY frame. The pan is a
         * delta applied to the live container.scrollLeft, so the origin has to
         * advance with the finger; keeping it at touchstart would make each move
         * recompute from the same point and the whole gesture would move by the
         * LAST step instead of the sum. Per-gesture only -- cleared by
         * ResetGesture -- and the horizontal POSITION itself lives in
         * container.scrollLeft, which already exists (§4.7: no second
         * persistent pan state, no `panX`, no transform).
         */
        let lastX = null;
        let longPressTimer = null;
        let selecting = false;
        let moved = false;
        let selAnchor = null;
        let scrollAccum = 0;
        /*
         * The row THIS gesture last decided through the app's
         * own scroll path (scrollLines), plus the bounded watch that keeps that
         * Decision authoritative. See armGestureAuthority.
         */
        let gestureAuthRow = null;
        let gestureWatchFrames = 0;
        /*
         * The reconciler itself, installed once per terminal on the viewport
         * element. It reads `gestureAuthRow` from this closure: null means no
         * local-scroll gesture currently owns vertical movement and every
         * scroll -- scrollbar drags, xterm's own writes, scrollToBottom --
         * passes untouched.
         */
        let scrollReconciler = null;
        const clearGestureAuthority = () => {
            gestureAuthRow = null;
            gestureWatchFrames = 0;
        };
        /*
         * THE AUTHORITY WATCH. A browser pan produced by an un-cancelled move
         * does not contaminate the buffer in one hop. Measured ordering
         * (viewport_scroll_authority.mjs): the raw scrollTop write fires
         * scroll#1 while viewportY is STILL the app-decided row; xterm's
         * _handleScroll translates it into a core scrollLines afterwards, and
         * the contamination becomes visible as buffer movement on a SECOND
         * scroll event, one rendering update after the pan -- later than any
         * single-frame window stays open.
         *
         * So the authority stays open for THREE animation frames past a
         * local-scroll move: each frame, if the buffer no longer matches the
         * app-decided row, the difference is undone through public
         * scrollLines(authRow - viewportY); after the third frame the watch
         * closes and normal scroll sovereignty resumes. Three frames cover the
         * measured two-update echo chain with slack, while staying far shorter
         * than any legitimate non-gesture viewport change (scrollbar drag,
         * follow-on output scrolling), which is exactly why those behaviours
         * remain untouched.
         *
         * touchend/touchcancel/resetGesture close the watch immediately when
         * they fire (real devices); under drivers that never deliver touchend
         * (CDP), the next local-scroll move ABSORBS any drift first, so the
         * correction rides the following move instead.
         *
         * A permanently-armed reconciler was MEASURED to be wrong: with no
         * bounded window it fights a later programmatic scrollToBottom forever
         * and re-breaks the T2 at-bottom no-op contract.
         */
        const armGestureAuthority = () => {
            gestureAuthRow = terminal.buffer.active.viewportY;
            if (!gestureWatchFrames) {
                const step = () => {
                    if (gestureAuthRow === null || !gestureWatchFrames) {
                        return;   // watch closed elsewhere
                    }
                    gestureWatchFrames -= 1;
                    const drifted = terminal.buffer.active.viewportY;
                    if (drifted !== gestureAuthRow) {
                        terminal.scrollLines(gestureAuthRow - drifted);
                    }
                    if (gestureWatchFrames) {
                        requestAnimationFrame(step);
                    } else {
                        gestureAuthRow = null;
                    }
                };
                requestAnimationFrame(step);
            }
            gestureWatchFrames = 3;
        };
        /*
         * THE VIEWPORT SCROLL RECONCILER. Installed lazily, once per terminal,
         * the first time a LOCAL-SCROLL gesture locks to the Y axis (i.e. after
         * the gesture's ownership is decided); it no-ops while gestureAuthRow is
         * null, so it never touches a scroll the app did not decide.
         *
         * WHY A SCROLL LISTENER: measured ordering (fail-first run of
         * tests/browser/viewport_scroll_authority.mjs) is that a browser pan
         * produced by an un-cancelled touchmove executes AFTER every listener
         * of that move, so anything written during the move handler loses the
         * frame. The pan surfaces as a 'scroll' event on .xterm-viewport;
         * xterm's own Viewport._handleScroll is bound FIRST (Terminal
         * construction), so by the time this listener runs it has already
         * translated the stray scrollTop into scrollLines and moved
         * `buffer.viewportY` -- the buffer itself is contaminated. Restoring
         * must therefore happen in BUFFER space, through the app's own public
         * scrollLines(authRow - viewportY): the pixels then follow via xterm's
         * own scrollTop mapping, which is exact by construction. No pixel
         * Arithmetic lives here on purpose: cellHeight (screen-box height /
         * rows) measured 14.4px/row while xterm's internal mapping uses its
         * real row height (14.0px in the same session) -- a formula built on
         * the box geometry drifts 4+ rows per gesture and was measured
         * re-breaking the T2 no-op contract.
         *
         * ORDERING/REENTRANCY: registration order makes xterm's handler run
         * before ours for every event, so each of our corrections sees the
         * fully-contaminated viewportY and corrects once. Our own
         * ScrollLines call fires another 'scroll' only after xterm's rAF
         * refresh; by then viewportY === gestureAuthRow and the listener
         * returns without acting.
         */
        const armScrollReconciler = () => {
            if (scrollReconciler) {
                return;   // already installed for this terminal
            }
            /*
             * ONLY WHERE A BROWSER-OWNED PAN IS POSSIBLE.
             *
             * This reconciler exists for one thing: a DOM scroller the browser
             * pans out from under the gesture (xterm 5.3.0, measured
             * `scrollTop -= 200` => `viewportY -14`). xterm 6 renders no scroll
             * area, so nothing outside the app can move the viewport -- and
             * hanging the reconciler off the ENGINE's scroll event there makes
             * it fight the gesture's own scrollLines, which is a feedback loop,
             * not a correction (measured on xterm 6: a swipe the app asked
             * -23 lines for moved -27, with +3 and +1 correction calls of the
             * reconciler's own making).
             */
            const vpEl = element.querySelector('.xterm-viewport');
            const scrollArea = element.querySelector('.xterm-scroll-area');
            if (!vpEl || !scrollArea) {
                return;
            }
            scrollReconciler = () => {
                if (gestureAuthRow === null) {
                    return;
                }
                const drifted = terminal.buffer.active.viewportY;
                if (drifted !== gestureAuthRow) {
                    terminal.scrollLines(gestureAuthRow - drifted);
                }
            };
            vpEl.addEventListener('scroll', scrollReconciler, {
                capture: true,
                passive: true,
            });
        };
        /*
         * The row that owns THIS gesture, resolved once at touchstart
         * and frozen until the fingers lift. Measured justification, not a
         * preference: writing \x1b[?1002h between move #3 and #4 changes the
         * live value mid-gesture, so a per-move read would let a
         * gesture that started as a local scroll jump onto the byte-emitting
         * branch in flight. null between gestures.
         */
        let gestureRow = null;
        /*
         * S7 / D-4' (§6.2): the axis this gesture is LOCKED to -- 'x', 'y', or
         * null while still PENDING. Decided exactly once, at the first move past
         * MOVE_THRESHOLD, and never re-decided: a gesture that opens sideways and
         * then turns must keep panning, because re-deciding mid-gesture is what
         * makes a diagonal drag jitter between two owners. Per-gesture state in
         * The existing closure, cleared by resetGesture.
         */
        let axis = null;
        let lastTap = -Infinity;   // -Infinity (NOT 0) so the first tap after load is never mis-read as a double-tap
        let lastTapX = null, lastTapY = null;
        // Set as soon as a second finger appears. A multi-touch gesture (pinch
        // zoom) must never turn into a tap/double-tap/copy when the fingers
        // lift, and the state has to stay poisoned until every finger is off.
        let multiTouch = false;

        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };
        const endSelection = () => {
            selecting = false;
            selAnchor = null;
            if (wrapper && wrapper.classList) {
                wrapper.classList.remove('touch-selecting');
            }
        };
        // Full reset of everything a gesture accumulates. Called when all
        // fingers are up and on touchcancel, so no state leaks into the next
        // gesture (a stale `selecting`/`lastTap` is what made touch erratic).
        const resetGesture = () => {
            clearGestureAuthority();
            cancelLongPress();
            if (selecting) {
                try { terminal.clearSelection(); } catch (e) { /* detached */ }
            }
            endSelection();
            startX = startY = lastY = null;
            lastX = null;
            moved = false;
            scrollAccum = 0;
            gestureRow = null;
            axis = null;
            multiTouch = false;
        };
        const clearTapCandidate = () => {
            lastTap = -Infinity;
            lastTapX = null;
            lastTapY = null;
        };

        wrapper.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1) {
                // Second finger down: abandon this gesture entirely but do NOT
                // preventDefault/stopPropagation — Safari needs the raw touches
                // to run pinch zoom.
                multiTouch = true;
                cancelLongPress();
                if (selecting) {
                    try { terminal.clearSelection(); } catch (e) { /* detached */ }
                    endSelection();
                }
                clearTapCandidate();
                return;
            }
            const touch = event.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            lastY = touch.pageY;
            // The horizontal origin starts where the finger did; the axis is
            // not decided yet (PENDING) and stays undecided until a move crosses
            // MOVE_THRESHOLD.
            lastX = touch.clientX;
            axis = null;
            moved = false;
            selecting = false;
            selAnchor = null;
            scrollAccum = 0;
            // D-2: snapshot the gesture owner HERE, once. Everything the
            // vertical branch does for the rest of this gesture is decided by
            // this one value.
            gestureRow = this.ScrollOwner.resolve(terminal);
            cancelLongPress();
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                if (moved) {
                    return;
                }
                // Enter selection mode: anchor at the cell under the finger.
                const cell = this.clientToCell(terminal, startX, startY);
                if (!cell) {
                    return;
                }
                selecting = true;
                selAnchor = cell;
                terminal.select(cell.col, cell.row, 1);
                if (navigator.vibrate) {
                    try { navigator.vibrate(10); } catch (e) { /* unsupported */ }
                }
                if (wrapper && wrapper.classList) {
                    wrapper.classList.add('touch-selecting');
                }
            }, LONG_PRESS_MS);
        }, { passive: true, capture: true, signal });

        wrapper.addEventListener('touchmove', (event) => {
            /*
             * The single-owner contract, and it runs FIRST -- before
             * the selecting branch, before the movement threshold, before any
             * row logic. Both halves are measured, not stylistic:
             *
             * StopPropagation is the ONLY thing that excludes xterm. The app's
             * handler is capture-phase on an ancestor so it runs first, but
             * without stopPropagation the event still reaches `.xterm`, where
             * xterm's own touchmove listener calls viewport.handleTouchMove and
             * scrolls the viewport underneath us -- two owners for one finger.
             * preventDefault does NOT help there: it cancels the browser's
             * default action, not the propagation. Measured: a marker listener
             * on `.xterm` received 10/10 moves with preventDefault alone and
             * 0/10 once stopPropagation was added.
             *
             * PreventDefault must land on the FIRST move. Deferring it even
             * one move costs the rest of the gesture: pdFrom=1 kept 27/27 moves
             * cancelable, pdFrom>=2 kept 1/27, and no
             * `touch-action` value buys that back on Chromium. That is
             * why the call sits above the MOVE_THRESHOLD test rather than after
             * it -- the old code only reached preventDefault once `moved` turned
             * true, i.e. from the 4th move of a slow swipe, which is exactly the
             * pdFrom>=2 starvation shape (P3).
             *
             * MULTI-TOUCH is the deliberate asymmetry: stopPropagation but
             * NEVER preventDefault. Without stopPropagation a pinch lets xterm
             * pan the viewport (measured scrollTop 2478 -> 2432, viewportY
             * 177 -> 174); with preventDefault the browser's own
             * pinch-zoom would die. Leaving the default action intact keeps
             * `defaultPrevented === false` on every multi-touch move, which is
             * what the three §4.6.2 measurements recorded as pinch surviving.
             *
             * SCOPE is touchmove only. Blocking `touchstart` was measured safe
             * but unnecessary: after a fully stopPropagation-ed gesture xterm's
             * `_lastTouchY` is stale, and the next gesture still ran normally
             * with zero errors. No CSS declaration changes
             * anywhere -- D-3 option (iv).
             */
            event.stopPropagation();
            if (event.touches.length !== 1) {
                return;
            }
            if (event.cancelable) {
                event.preventDefault();
            }
            const touch = event.touches[0];

            if (selecting) {
                // Extend the selection to the cell under the finger. The
                // exclusion and the cancel already happened above -- this branch
                // used to own them, and losing them here is what would let the
                // viewport scroll out from under a selection anchor.
                const cell = this.clientToCell(terminal, touch.clientX, touch.clientY);
                if (cell && selAnchor) {
                    const cols = terminal.cols;
                    const anchorAbs = selAnchor.row * cols + selAnchor.col;
                    const curAbs = cell.row * cols + cell.col;
                    let startRow, startCol, length;
                    if (curAbs >= anchorAbs) {
                        startRow = selAnchor.row;
                        startCol = selAnchor.col;
                        length = curAbs - anchorAbs + 1;
                    } else {
                        startRow = cell.row;
                        startCol = cell.col;
                        length = anchorAbs - curAbs + 1;
                    }
                    terminal.select(startCol, startRow, length);
                }
                return;
            }

            // Not selecting yet — decide swipe vs still-holding.
            const dx = Math.abs(touch.clientX - startX);
            const dy = Math.abs(touch.clientY - startY);
            // Abandon the pending long-press as soon as the finger travels a few
            // pixels, before the 10px swipe threshold, so a slow/short pan never
            // flips into selection mid-gesture. A dead-still long-press (no
            // travel) is untouched and still selects at 500ms.
            if (longPressTimer !== null
                && (dx > LONG_PRESS_CANCEL_PX || dy > LONG_PRESS_CANCEL_PX)) {
                cancelLongPress();
            }
            if (!moved && (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD)) {
                moved = true;
                cancelLongPress();
                /*
                 * S7 / D-4' (§4.7, §6.2): the axis decision, made HERE and only
                 * here -- at the same instant the gesture becomes a swipe, from
                 * the cumulative distance since touchstart, and held until the
                 * fingers lift. PENDING -> LOCKED_X | LOCKED_Y is a one-way
                 * transition; nothing below re-reads it.
                 */
                axis = dx > dy * AXIS_RATIO ? 'x' : 'y';
                /*
                 * The moment this gesture locks to Y, decide
                 * whether it is a LOCAL-SCROLL gesture (rows A/B/F/G/E0 -- the
                 * same set that will call scrollLines below). Only those arm
                 * the viewport scroll reconciler; byte-emitting rows D/E are
                 * the application's to scroll, and C/D0 decline entirely.
                 */
                const rowAtLock = gestureRow || 'G';
                if (axis === 'y'
                    && (rowAtLock === 'A' || rowAtLock === 'B'
                        || rowAtLock === 'F' || rowAtLock === 'G'
                        || rowAtLock === 'E0')) {
                    armScrollReconciler();
                    // Absorb whatever drifted since the previous move BEFORE
                    // this move applies its own delta: a pan the browser slid
                    // in after move k must not be misread as part of move k+1.
                    if (gestureAuthRow !== null) {
                        const driftedNow = terminal.buffer.active.viewportY;
                        if (driftedNow !== gestureAuthRow) {
                            terminal.scrollLines(gestureAuthRow - driftedNow);
                        }
                    }
                }
            }
            if (!moved) {
                return;
            }

            if (axis === 'x') {
                /*
                 * LOCKED_X: pan the pane horizontally by writing the scroll
                 * container's own scrollLeft. Three properties are load-bearing
                 * and all three are measured, not stylistic:
                 *
                 *  - The STATE is container.scrollLeft, which already exists.
                 *    `overflow-x: hidden` leaves the element a scroll container
                 *    whose scrollLeft JS can still write (measured: write 240
                 *    reads back 240, write 99999 clamps to the maximum)
                 *. So there is no second pan variable and no
                 *    transform -- O1 and O2' were both rejected on evidence
                 *    (§4.7, Part 9).
                 *
                 * under views a pane renders its OWN fit, so
                 *    there is normally nothing to pan and every write clamps to
                 *    0. The axis lock itself is still load-bearing -- it is what
                 *    stops a horizontal drag being read as a history swipe --
                 *    and this branch self-neutralises when the grid fits, so it
                 *    stays rather than being special-cased.
                 *  - The GEOMETRY is read at USE TIME, never cached: scrollWidth
                 *    changed 882 -> 1029 after one rotation with cols unchanged
                 *so a bound computed at touchstart would be
                 *    wrong by the end of the same session.
                 *  - The ORIGIN advances every frame (lastX), so the pan
                 *    accumulates over the gesture instead of tracking only the
                 *    last step.
                 *
                 * The browser clamps an out-of-range write by itself; the clamp
                 * here is explicit anyway so the value this code intends is the
                 * value it computes, and the pan never depends on that fallback.
                 */
                const frameDx = touch.clientX - lastX;
                lastX = touch.clientX;
                const maxScrollLeft = Math.max(
                    0, wrapper.scrollWidth - wrapper.clientWidth);
                const target = wrapper.scrollLeft - frameDx;
                wrapper.scrollLeft = Math.max(0, Math.min(maxScrollLeft, target));
                // Vertical bookkeeping must not drift while the finger travels:
                // keeping lastY current means a later gesture starts from a fresh
                // origin rather than inheriting this one's distance.
                lastY = touch.pageY;
                return;
            }

            /*
             * The row snapshotted at touchstart is the sole authority
             * over what this gesture does. A missing row means touchstart never
             * ran for this stream (a move without its start), which is exactly
             * the unreadable-state case -- fail closed to G, i.e. local scroll
             * only, never bytes.
             *
             * Everything from here down is the LOCKED_Y branch. LOCKED_X
             * returned above, which is why a horizontal pan costs zero bytes on
             * every row including C/D0 (whose no-op returns early) and D/E (whose
             * synthesized wheel would otherwise turn a sideways flick into SGR
             * reports).
             */
            const row = gestureRow || 'G';
            const emitsWheel = row === 'D' || row === 'E';
            const scrollsLocally = row === 'A' || row === 'B' || row === 'F'
                || row === 'G' || row === 'E0';

            if (!emitsWheel && !scrollsLocally) {
                /*
                 * Rows C and D0: an EXPLICIT no-op, and the explicitness is the
                 * point. On C (tracking none + alternate) xterm's wheel path
                 * becomes CURSOR KEYS, so synthesizing one puts ESC[A into the
                 * shell; on D0 (tracking on, no SGR encoding) the wheel produces
                 * no bytes at all and the alternate buffer has no
                 * scrollback to move, so there is nothing honest left to do.
                 * JS still owns the gesture -- it just declines to act.
                 */
                lastY = touch.pageY;
                return;
            }

            // gestureDy: finger UP makes pageY decrease, so the accumulator is
            // POSITIVE for an upward drag.
            scrollAccum += lastY - touch.pageY;
            lastY = touch.pageY;
            const ch = cellHeight();
            const n = Math.round(scrollAccum / ch);
            if (n !== 0) {
                if (scrollsLocally) {
                    /*
                     * Rows A/B/F/G/E0: move this terminal's own viewport and
                     * emit nothing. The sign passes straight through --
                     * section 4.9 is one convention everywhere: n > 0 (finger
                     * up) means scrollLines(n) toward NEWER content, and
                     * scrollLines(-n) is written nowhere for this gesture.
                     * On B there is no history so the call is a harmless no-op;
                     * that is still the right call, because the alternative
                     * (letting a wheel through) becomes cursor keys.
                     */
                    terminal.scrollLines(n);
                } else {
                    // Rows D/E: synthesize N discrete LINE-MODE wheels so xterm
                    // encodes them as SGR reports for the application.
                    //
                    // n > 0 = finger dragged UP = show NEWER content, i.e. a
                    // wheel-DOWN (deltaY +1), which xterm encodes as SGR button
                    // 65 -- the glyphs follow the finger. P2: this sent -1 for
                    // n > 0, so an upward swipe went BACK into history and the
                    // text moved against the finger.
                    //
                    // P1-LAND fix: the wheel dispatch MUST be deferred out of
                    // this touchmove frame. Dispatching a synthetic WheelEvent
                    // synchronously while a touch gesture is in flight makes the
                    // compositor claim the gesture on short (landscape)
                    // viewports: every touchmove after the first is silently
                    // dropped and the swipe scrolls exactly one cell. Deferring
                    // with a task keeps the gesture stream intact on every
                    // viewport size.
                    const step = n > 0 ? 1 : -1;
                    const count = Math.abs(n);
                    const clientX = touch.clientX;
                    const clientY = touch.clientY;
                    setTimeout(() => {
                        for (let i = 0; i < count; i++) {
                            element.dispatchEvent(new WheelEvent('wheel', {
                                deltaY: step,
                                deltaMode: 1,   // LINE mode: 1 report per event, no dead-zone
                                clientX,
                                clientY,
                                bubbles: true,
                                cancelable: true
                            }));
                        }
                    }, 0);
                }
                scrollAccum -= n * ch;
            }

            /*
             * Remember the row THIS gesture just decided.
             * When the preventDefault did not land (`event.cancelable ===
             * false`, which a phone delivers routinely on a first move after a
             * fling), the browser keeps the default action and pans
             * `.xterm-viewport` natively after this handler returns -- measured
             * (/tmp/s14work/native_summary.txt): a raw scrollTop write,
             * rendered text slides, zero bytes. xterm translates that stray
             * position into buffer movement; the bounded authority watch (and
             * the reconciler armed at axis lock above) then restores the
             * app-decided row through scrollLines. See the full rationale at
             * the armGestureAuthority definition.
             *
             * Recorded for EVERY local-scroll move, including ones where
             * scrollLines made no net change (n=0 or clamped at a boundary):
             * the authoritative answer to "where did the app put the viewport"
             * is whatever the buffer says NOW, and recording it per move keeps
             * a mid-gesture drift correction exact.
             */
            if (scrollsLocally) {
                armGestureAuthority();
            }
            // No trailing preventDefault: S6 moved it to the top of this handler
            // so it lands on the FIRST move, and calling it twice per event would
            // only obscure where the cancel actually happens.
        }, { passive: false, capture: true, signal });

        wrapper.addEventListener('touchend', (event) => {
            cancelLongPress();
            if (event.touches.length > 0) {
                // A finger is still down (e.g. one of two lifted during a pinch).
                // Nothing completed here: lifting two fingers one after the other
                // must not read as two taps, i.e. as a double-tap.
                return;
            }
            const wasMultiTouch = multiTouch;
            const wasSelecting = selecting;
            const tapX = startX, tapY = startY;
            const tapMoved = moved;

            if (wasSelecting) {
                const sel = terminal.hasSelection() ? terminal.getSelection() : '';
                // Suppress the synthetic click the browser fires after touchend:
                // under mouse tracking it would forward a stray click to the app
                // (cursor jump / pane switch) at the lifted position.
                if (event.cancelable) {
                    event.preventDefault();
                }
                resetGesture();
                clearTapCandidate();
                if (!wasMultiTouch) {
                    // Because the click is suppressed, nothing else routes focus
                    // after a long-press copy. Do it here, synchronously in the
                    // trusted touchend, so mobile lands back on #mobileInput (with
                    // the Vietnamese IME) instead of being stranded on xterm's
                    // hidden textarea. Activate the touched pane first when it is
                    // not the active one, otherwise the following input would go
                    // to a different session.
                    this.routeFocusAfterTouch(wrapper);
                    if (sel) {
                        this.reportCopyResult(sel);
                    }
                }
                return;
            }

            if (wasMultiTouch) {
                // Pinch/multi-finger gesture ended: no tap, no raw focus.
                resetGesture();
                clearTapCandidate();
                return;
            }

            // Plain tap (no move, no select).
            // SINGLE tap: do NOT focus or preventDefault here. The synthetic
            // click that follows this touchend bubbles to the pane ->
            // setActivePane -> focusActivePane, which routes mobile focus to
            // #mobileInput (Vietnamese IME) and runs AFTER xterm's mousedown, so
            // it wins. Focusing here would only flicker then get overridden.
            // DOUBLE tap (two taps within DOUBLE_TAP_MS *and* within
            // DOUBLE_TAP_PX of each other): the user wants to type raw keys into
            // the terminal (vim/claude), AND on iOS a double-tap is the zoom
            // Gesture. preventDefault on this second touchend blocks the
            // double-tap-zoom AND suppresses the synthetic click sequence
            // (verified: no click fires), so nothing else would focus anything --
            // we focus the terminal directly here. The distance check matters:
            // time alone turned two quick taps in different places (e.g. two
            // different spots of the output) into an unwanted raw-focus switch.
            if (!tapMoved) {
                const now = performance.now();
                const near = lastTapX !== null
                    && Math.abs(tapX - lastTapX) <= DOUBLE_TAP_PX
                    && Math.abs(tapY - lastTapY) <= DOUBLE_TAP_PX;
                if (now - lastTap < DOUBLE_TAP_MS && near) {
                    clearTapCandidate();   // reset so a 3rd tap isn't also a "double"
                    if (event.cancelable) {
                        event.preventDefault();   // block iOS double-tap-zoom
                    }
                    /*
                     * The missing notepadOwnsKeyboard guard.
                     *
                     * This redirect had NO Notes exception, unlike its two
                     * siblings in this file (:1381 the container click and
                     * 1422 the focusin redirect), so a double-tap that landed
                     * while the Notes sheet owned the keyboard moved focus into
                     * #mobileInput and the rest of the note was typed into the
                     * Composer -- the requirement "composer contaminated with
                     * NOTE text". Measured in probe4: A3 STEALS to mobileInput
                     * on touch. The enabling condition is style.css:5018, which
                     * can hide the panel out from under the caret.
                     *
                     * Placed here rather than inside the isTouchShell branch
                     * alone because BOTH branches steal the keyboard from a
                     * focused note -- the touch branch into the composer, the
                     * desktop branch into xterm's helper textarea -- and one
                     * Predicate covers both. preventDefault above has already
                     * run, so the iOS double-tap-zoom is still blocked and the
                     * gesture is still consumed; only the focus move is
                     * declined. No scroll or gesture state is touched, so the
                     * mobile touch-scroll baseline is unaffected.
                     */
                    if (this.notepadOwnsKeyboard()) {
                        resetGesture();
                        return;
                    }
                    // Composer-first input authority: a double-tap on the terminal
                    // must route keystrokes back to #mobileInput (the single
                    // authoritative composer), not to xterm's hidden textarea. On a touch
                    // shell the composer element is the sole input; the raw-focus
                    // path is gone because there is no separate raw-typing mode.
                    if (this.isTouchShell()) {
                        const mobileInput = document.getElementById('mobileInput');
                        if (mobileInput) {
                            mobileInput.focus();
                            // xterm's synthesized mousedown fires AFTER touchend and
                            // re-focuses its hidden textarea, which would override the
                            // composer. Re-assert focus once that sequence finishes so
                            // the composer is the final owner on a double-tap.
                            setTimeout(() => mobileInput.focus(), 0);
                        }
                    } else {
                        terminal.focus();
                    }
                    // No raw-terminal-focus dispatch remains: the composer mirror
                    // stays authoritative in every tap/double-tap path.
                } else {
                    lastTap = now;
                    lastTapX = tapX;
                    lastTapY = tapY;
                }
            }
            resetGesture();
        }, { passive: false, capture: true, signal });

        wrapper.addEventListener('touchcancel', () => {
            // iOS fires touchcancel liberally (system gestures, callout). Always
            // return to a clean slate, including the double-tap candidate: a
            // cancelled touch must not pair with the next one.
            resetGesture();
            clearTapCandidate();
        }, { passive: true, capture: true, signal });

        this.touchScrollControllers[terminalKey] = controller;
    },

    // Re-fit the terminal whenever its wrapper's rendered size actually changes.
    // Routed through the ONE coalesced fit owner (requestFit) so a resize burst
    // (dvh settle, keyboard slide) and any programmatic fit request sharing that
    // window collapse into a single fitTerminal per session — fit ≤1 per
    // terminal per layout event. Stored per key and disconnected in
    // destroyTerminalKey.
    setupResizeObserver(terminalKey, sessionId, container) {
        if (typeof ResizeObserver === 'undefined' || !container) {
            return;
        }
        const observer = new ResizeObserver(() => {
            /*
             * OWNER RULING: the soft keyboard fits like anything
             * else that takes room.
             *
             * From to today this branch HELD the grid whenever the
             * keyboard was open on the alternate buffer, so a phone keyboard
             * never SIGWINCHed a TUI. The cost was that the pane kept its old
             * row count in half the height, and presentWindowGrid shrank the
             * text to fit -- down to a 6px floor. The owner read that as the
             * defect: "khi mo ban phim chuc nang thi man hinh khong he bi co
             * lai ... con mo ban phim cua iOS len thi lai bi thu nho khung
             * terminal". The app's own key bar takes real layout height and
             * simply refits, which is what looked right.
             *
             * So both keyboards now behave the same way: a height change is a
             * resize, the grid follows the pane, and the text keeps its size.
             * The known price and accepted today: another
             * device watching the same tmux window follows the smaller row
             * count while the keyboard is up.
             */
            this.noteLiveEdgeResize(terminalKey);
            this.requestFit(sessionId);
        });
        observer.observe(container);
        this.resizeObservers[terminalKey] = observer;
    },

    writeOutput(sessionId, data) {
        // While a replay is open, live output waits. Writing it now would
        // put newer bytes ahead of the history they follow, and can cut a
        // replayed escape sequence in half -- which corrupts the screen rather
        // than merely reordering lines. The queue drains in arrival order the
        // moment the final chunk lands.
        const replay = this.replayState[sessionId];
        if (replay && replay.open) {
            replay.liveQueue.push(data);
            return;
        }
        /*
         * A LIVE frame is the real application speaking, so whatever
         * DECSET state it establishes is genuine and the truncated-replay
         * provenance mark is released. This is the ONLY clear path: the flag is
         * set by finishReplay for a truncated replay and cleared here, so the
         * untrusted window is exactly "after a truncated restore, before the
         * remote next says anything".
         */
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        terminalKeys.forEach(key => {
            this.ScrollOwner.clearProvenanceUntrusted(this.terminals[key]);
        });
        this.writeOutputNow(sessionId, data);
    },

    /*
     * A control sequence the CLIENT originates, written to the engine only.
     *
     * The D4-R head-normalisation belt below writes one
     * `\x1b[?1049l` of its own invention so the replay lands on the normal
     * buffer from a known state. It used to go through writeOutputNow, which
     * calls appendTranscript unconditionally (:2446) -- so 8 bytes the SERVER
     * Never sent were recorded in the user-facing transcript the user
     * downloads. Measured: a 10-byte replay produced an 18-byte transcript
     * beginning "\x1b[?1049l", and every transcript-size assertion in
     * tests/browser/w5_partG_transcript_ownership.mjs was off by exactly 8.
     *
     * The transcript is a record of what the SESSION said. A client-side screen
     * declaration is not part of that record, so it must not be appended -- and
     * it equally must not be dropped, because putting the engine on a known
     * buffer is what makes the replay visible at all.
     *
     * Everything else about the write is deliberately identical to
     * writeOutputNow: the same ownership gate first, the same fan-out to EVERY
     * mirrored terminal, and the same writeOutputToTerminal call, so a terminal
     * that is not READY yet still buffers this byte-string in pendingOutput and
     * replays it in order. The only difference is the missing appendTranscript.
     *
     * No console.error here, unlike writeOutputNow. A missing terminal there
     * means real session output was lost and has always been reported; here it
     * means a screen declaration had nothing to declare to, which is the normal
     * consequence of a teardown racing a restore and is not an error.
     */
    writeControlNow(sessionId, data) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0) {
            return;
        }
        // Engine-only, but the engine saw it: the tail records it too.
        this.recordStreamTail(sessionId, data);
        terminalKeys.forEach(key => {
            this.writeOutputToTerminal(key, data, sessionId);
        });
    },

    // The unconditional write path. Replay chunks and drained live frames both
    // land here, so transcript bookkeeping and fan-out to mirrored panes stay in
    // exactly one place.
    writeOutputNow(sessionId, data) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        /*
         * Ownership gate, and it must come BEFORE appendTranscript.
         *
         * destroyTerminal deletes transcripts[sessionId] / transcriptSizes[sessionId],
         * but a straggler ssh_output frame for that dead session can still arrive
         * afterwards (the server learns about the close on its own schedule).
         * appendTranscript creates its state unconditionally, so a frame landing
         * here after teardown used to RESURRECT the key -- and nothing deletes it
         * a second time, so it stayed for the document's lifetime and could grow
         * to maxTranscriptSize per closed session.
         *
         * Skipping the bookkeeping cannot lose legitimate output: ownership is
         * registered by createTerminal (:247-252) inside createSession, strictly
         * before restoreSession opens the replay window, so every replay chunk,
         * held-chunk flush, truncation notice and drained live frame reaches this
         * function with sessionTerminals[sessionId] already populated. Output that
         * arrives before the terminal is READY is a different case and is still
         * buffered, in pendingOutput, by writeOutputToTerminal.
         *
         * The console.error is unchanged: a write for a session with no terminal
         * has always been reported, and it stays reported.
         */
        if (terminalKeys.length === 0) {
            console.error('Terminal not found for writeOutput:', sessionId);
            return;
        }

        this.recordStreamTail(sessionId, data);
        this.appendTranscript(sessionId, data);

        terminalKeys.forEach(key => {
            this.writeOutputToTerminal(key, data, sessionId);
        });
    },

    /*
     * Open a replay window for a session, before any chunk arrives.
     *
     * Called from restoreSession the moment the snapshot lands, so the gate is
     * up before the first live frame can be delivered. `expectedChunks` comes
     * from the snapshot; zero is legitimate (nothing to replay) and is closed by
     * the server's explicit empty terminator.
     */
    beginReplay(sessionId, expectedChunks) {
        this.replayState[sessionId] = {
            open: true,
            nextSeq: 1,
            held: {},
            liveQueue: [],
            truncated: false,
            expected: Number.isInteger(expectedChunks) ? expectedChunks : null,
            /*
             * The sanitizer state. The cleaner now runs for EVERY
             * replay (see writeReplayChunk), so this state is live on every
             * restore; the parts of it that are meaningful only for a trimmed
             * stream are gated on `truncated` at their use site.
             *
             *   sanitizeStarted  whether the first byte of the replay has been
             *                    written yet (the leading-partial-escape rule and
             *                    the prologue-clear rule apply to that boundary
             *                    and nowhere else)
             *   sanitizeCarry    a trailing incomplete escape held back so the
             *                    next chunk can complete it; a control sequence
             *                    split across two chunks must be examined whole
             */
            sanitizeStarted: false,
            sanitizeCarry: '',
            /*
             * Whether the one-time `\x1b[?1049l` that gives the replay
             * ownership of the screen has been written yet. Written by
             * writeReplayChunk, immediately before the first chunk that survives
             * the cleaner -- not here, because a replay with nothing to write must
             * not disturb the screen at all.
             */
            headNormalised: false,
        };
    },

    /*
     * Make a replay safe to paint.
     *
     * `build_replay_chunks` keeps the most recent output and trims from the
     * FRONT, so a truncated replay is a byte stream cut at an arbitrary offset.
     * Two things can survive that cut which must never reach the engine, and
     * both were measured on the deployed build:
     *
     *   1. AN UNPAIRED ALTERNATE-SCREEN ENTER. `\x1b[?1049h` (or 47/1047) puts
     *      xterm on the alternate buffer, which by definition has NO scrollback.
     *      Its matching `?1049l` was in the discarded prefix, so nothing ever
     *      brings the terminal back. Everything the replay writes after it is
     *      painted where the user can never scroll to it -- measured as buffer
     *      `alternate`, `baseY 0`, and either 0 or 44 of 120 history lines
     *      reachable. On RESTORE there is no reattach and therefore no repaint
     *      to recover from it (socket_events.py: "nothing reattaches, so tmux
     *      emits no repaint"). Dropping the switch is the only option that keeps
     *      the bytes: the history then lands on the normal buffer, where the
     *      scrollback holds it.
     *
     *   2. A LEADING PARTIAL CONTROL SEQUENCE. The cut can land inside a CSI, so
     *      the stream opens on that sequence's tail (`?1002h`, `31;1m`). The
     *      pattern is deliberately narrow -- a private/parameter introducer
     *      followed by parameter bytes and a final letter, at offset zero only --
     *      because ordinary output must never be mistaken for it. `HISTORY-001`
     *      does not match: the rule requires the first character to be one of
     *      `?<>=` or a digit followed by `;`/`:`.
     *
     * WHY THIS IS NO LONGER TRUNCATED-ONLY, and why the S16/S4 belt
     * was the wrong place.
     *
     * The S14 text above reasoned only about trim debris, so `writeReplayChunk`
     * called this ONLY when the server had declared the replay truncated. A real
     * tmux attach replay is not truncated and does not need to be: it ENTERS the
     * alternate screen at BYTE 0. The verbatim first 180 bytes of a live restore
     * chunk, captured off the websocket (7336 B / 462 lines, truncated: false --
     * /tmp/s16work/live_replay_chunk.txt):
     *
     *     \x1b[?1049h \x1b[22;0;0t \x1b[?1h \x1b= \x1b[H \x1b[2J
     *     \x1b[?12l \x1b[?25h \x1b[?1000l … \x1b[1;1H
     *
     * so tmux paints EVERY line of history inside the alternate buffer. The
     * S16/S4 belt then emitted `\x1b[?1049l` after the replay and handed the user
     * back the NORMAL buffer, which nothing had written to. Measured on the
     * deployed build: before a reload 48 non-empty rows, after it 0, stable for
     *
     * A belt at the END can only choose which empty screen to show. The decision
     * belongs at the BOUNDARY, because a replay is a HISTORY TRANSCRIPT being
     * reinjected, not a live terminal feed: a control sequence whose only job is
     * to switch screens has no meaning for a transcript, and obeying it destroys
     * the transcript. So the switch strip now applies to EVERY replay chunk.
     *
     * WHAT IS AND IS NOT REMOVED, measured (replay_neutralise_experiment.out, on
     * the real captured bytes):
     *   V0 verbatim                        normal, 0 reachable      <- the defect
     *   V1 alt switches stripped           normal, 58 reachable, baseY 15
     *   V2 V1 + head clear pair stripped   IDENTICAL to V1
     *   V4 V1 + every ED stripped          IDENTICAL to V1
     * Stripping the switches is necessary AND sufficient. The head clear pair is
     * still removed (see PROLOGUE_CLEAR_RE below) because it cannot help and it
     * can erase what a live frame delivered before the window opened; every ED
     * elsewhere is KEPT, because inside a transcript an erase is part of how the
     * remote drew that line and removing it corrupts the rendering.
     *
     * Everything cosmetic passes through byte-for-byte: SGR, cursor addressing,
     * and the mouse-tracking DECSETs the ScrollOwner observers read.
     */
    /*
     * The switch regex matches the COMBINED form too: xterm's DECSET loop
     * iterates every parameter, so `?1000;1006;1049h` activates the alternate
     * buffer exactly as `?1049h` does (probe_combined_decset.mjs: the vendored
     * engine reports `alternate` + SGR mouse for that byte string). A regex
     * pinned to 1049 as the sole parameter would miss it. The lookarounds are
     * the digit boundary -- `\b` cannot be used because the leading `[0-9;:]*`
     * can consume `1049` itself before the boundary test runs (measured:
     * `\b` variant matched 11049 and missed plain 1049).
     */
    ALT_SCREEN_SWITCH_RE: /(?<![0-9])\x1b\[\?(?:[0-9;:]+;)?(?:1049|1047|47)(?![0-9])[0-9;:]*[hl]/g,
    LEADING_CSI_TAIL_RE: /^(?:[?<>=][0-9;:]*|[0-9]+[;:][0-9;:]*)[A-Za-z]/,
    /*
     * The transcript-erasing prologue.
     *
     * A cursor-home + erase-display pair (`\x1b[H\x1b[2J`, any parameters) or a
     * RIS (`\x1bc`) at the very head of a replay -- reachable only across other
     * complete control sequences, never across printable text -- erases the
     * screen before the transcript is written, so it can only destroy what was
     * already there. Anchored, and it stops at the first printable byte: an
     * identical pair occurring later is part of how the remote drew that row and
     * is kept. Measured to be a no-op on the live capture; it is here for the
     * ordering case, where a live frame painted the screen before the replay
     * window opened.
     */
    PROLOGUE_CLEAR_RE: /^((?:\x1b\[[0-9;:?<>=]*[A-Za-z]|\x1b[()#][0-9A-Za-z]|\x1b[=>]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*?)(?:\x1b\[[0-9;]*H\x1b\[[0-3]?J|\x1bc)/,

    sanitizeReplayChunk(replay, chunk) {
        let text = replay.sanitizeCarry + String(chunk);
        replay.sanitizeCarry = '';

        /*
         * Hold back a trailing incomplete escape. A sequence split across a
         * chunk boundary has to be judged whole, and writing half of it would
         * make the engine swallow the bytes that follow. The carry is bounded:
         * a control sequence longer than this is not one, so the text is passed
         * through rather than accumulated without limit.
         */
        const lastEsc = text.lastIndexOf('\x1b');
        if (lastEsc !== -1) {
            const tail = text.slice(lastEsc);
            const complete = /^\x1b(?:\[[0-9;:?<>=!]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[0-9A-Za-z=><])/;
            if (!complete.test(tail) && tail.length <= 32) {
                replay.sanitizeCarry = tail;
                text = text.slice(0, lastEsc);
            }
        }

        /*
         * The leading-partial-escape cut stays TRUNCATED-ONLY. It exists because
         * the server's front trim can land inside a CSI, so it is meaningful
         * exactly when the server says it trimmed; applying it to a clean replay
         * would be guessing at bytes the server sent whole.
         */
        if (replay.truncated && !replay.sanitizeStarted) {
            const cut = this.LEADING_CSI_TAIL_RE.exec(text);
            if (cut) {
                text = text.slice(cut[0].length);
            }
        }
        if (!replay.sanitizeStarted) {
            // Strip a transcript-erasing prologue at the head of the
            // replay, and only there. Runs before sanitizeStarted flips, so a
            // later identical pair -- part of how the remote drew that row -- is
            // kept.
            text = text.replace(this.PROLOGUE_CLEAR_RE, '$1');
            if (text.length > 0 || replay.sanitizeCarry.length > 0) {
                replay.sanitizeStarted = true;
            }
        }

        // A fresh lastIndex every call: the regex is shared state on the object
        // and /g would otherwise resume mid-string on the next chunk.
        this.ALT_SCREEN_SWITCH_RE.lastIndex = 0;
        return text.replace(this.ALT_SCREEN_SWITCH_RE, '');
    },

    /*
     * One write of a replay chunk.
     *
     * EVERY chunk goes through the boundary cleaner, truncated or not.
     * It used to be `replay.truncated ? sanitize(chunk) : chunk`, which left the
     * one path that strips `?1049h` unreachable for a normal tmux restore -- and
     * a normal tmux restore is precisely the case that enters the alternate
     * screen at byte 0 and loses the whole transcript. The cleaner itself keeps
     * its truncated-only parts truncated-only (the leading-partial-escape cut);
     * what is now unconditional is the screen-switch strip and the head clear,
     * neither of which has any meaning for a transcript being reinjected.
     *
     * THE OWNERSHIP CONTRACT, and why the rmcup is written HERE rather than
     * checked afterwards. The cleaner strips alternate-screen switches in BOTH
     * directions, so a replay can no longer enter the alternate screen -- but it
     * can no longer LEAVE one either, and it does not choose where it starts.
     * The engine can already be on the alternate buffer when the window opens: on
     * the live box `ssh_output` arrives BEFORE `ssh_session_restored`
     * (measured +0ms / +0ms / +5ms, /tmp/s16work/b_c_diag6.out), so a live frame
     * that entered a TUI is written straight to the engine and the transcript
     * then paints inside it and is lost -- measured, cleaner and all:
     * belt_necessity_probe.out row B-b, 0 reachable lines.
     *
     * So the client declares the contract instead of inferring it: THE REPLAY
     * OWNS THE SCREEN FOR THE DURATION OF THE RESTORE. Exactly one `\x1b[?1049l`
     * is written ahead of the first chunk, OUTSIDE the payload where the cleaner
     * cannot eat it, which puts the transcript on the normal buffer from a known
     * state rather than a raced one. It writes ZERO bytes to the remote -- a
     * write INTO the local engine, the same direction as every replay byte -- and
     * it is idempotent on a terminal already there. Measured: belt_head_probe.out
     * H-a/H-b, 400 reachable lines whether the engine started on normal or on
     * alternate, and H-f shows it holds with no tail belt at all.
     *
     * After the replay, a live frame is a genuine application statement and owns
     * the screen again; writeOutput's queue guarantees it is written after the
     * transcript, so nothing here can outrank it.
     */
    writeReplayChunk(sessionId, replay, chunk) {
        const text = this.sanitizeReplayChunk(replay, chunk);
        if (!text) {
            return;
        }
        if (!replay.headNormalised) {
            replay.headNormalised = true;
            /*
             * WriteControlNow, not writeOutputNow. This escape is the
             * CLIENT's own screen declaration -- the server never sent it -- so
             * it reaches every mirrored engine and honours pendingOutput exactly
             * As before, but it is no longer recorded in the transcript the user
             * downloads. See writeControlNow for the measured numbers.
             */
            this.writeControlNow(sessionId, '\x1b[?1049l');
        }
        this.writeOutputNow(sessionId, text);
    },

    /*
     * Accept one sequenced replay chunk.
     *
     * Chunks are written strictly in seq order. A chunk that arrives early is
     * parked in `held` rather than written, because Socket.IO ordering is not
     * something to bet a corrupted screen on. `final` closes the window and
     * drains whatever live output accumulated behind it.
     */
    acceptReplayChunk(sessionId, payload) {
        if (!payload) return;
        let replay = this.replayState[sessionId];
        if (!replay) {
            // A chunk for a session whose window was never opened (or already
            // closed). Open one implicitly rather than dropping history: the
            // ordering guarantee still holds, and losing scrollback is worse
            // than a late window.
            this.beginReplay(sessionId, payload.total);
            replay = this.replayState[sessionId];
        }
        if (payload.truncated) {
            replay.truncated = true;
        }

        // seq 0 with final is the empty terminator (nothing was buffered).
        if (payload.seq > 0) {
            replay.held[payload.seq] = payload.data || '';
            while (Object.prototype.hasOwnProperty.call(replay.held, replay.nextSeq)) {
                const chunk = replay.held[replay.nextSeq];
                delete replay.held[replay.nextSeq];
                replay.nextSeq += 1;
                if (chunk) {
                    this.writeReplayChunk(sessionId, replay, chunk);
                }
            }
        }

        if (payload.final) {
            this.finishReplay(sessionId, payload.dropped_bytes);
        }
    },

    /*
     * Close the replay window: write any still-held chunks, announce a
     * truncation, then release the live queue.
     *
     * Held chunks are flushed in ascending seq even if a gap remains -- a
     * missing chunk must not swallow the ones after it, and the truncation
     * notice covers the fact that history is incomplete.
     */
    finishReplay(sessionId, droppedBytes) {
        const replay = this.replayState[sessionId];
        if (!replay) return;

        const remaining = Object.keys(replay.held)
            .map(Number)
            .sort((a, b) => a - b);
        remaining.forEach(seq => {
            const chunk = replay.held[seq];
            delete replay.held[seq];
            if (chunk) {
                this.writeReplayChunk(sessionId, replay, chunk);
            }
        });

        /*
         * Flush whatever the sanitizer was holding back.
         *
         * The carry is written UNFILTERED on purpose: it was held only because
         * it looked like the start of a sequence the next chunk would complete,
         * and there is no next chunk. Dropping it would lose real bytes, which
         * is a worse failure than writing an incomplete escape the engine will
         * discard by itself.
         *
         * S14's second half -- an explicit `?1049l` written HERE as a belt to the
         * sanitizer's braces -- is gone. It was needed because the sanitizer ran
         * only on a truncated replay, so a switch it could not see (one that
         * arrived before the window opened, or on an earlier frame) had to be
         * corrected after the fact. The cleaner now runs on every chunk and
         * writeReplayChunk establishes the screen BEFORE the first byte, so there
         * is nothing left to correct afterwards -- and correcting afterwards was
         * measurably harmful, because by this point the live queue has been
         * drained and a live frame's own full-screen entry would be undone.
         *
         * The carry is held on every replay now, so it must be flushed
         * on every replay -- gating this on `truncated` would silently drop the
         * last few bytes of a clean restore whose final chunk ended mid-escape.
         */
        if (replay.sanitizeCarry) {
            this.writeOutputNow(sessionId, replay.sanitizeCarry);
            replay.sanitizeCarry = '';
        }

        /*
         * The provenance mark below stays TRUNCATED-ONLY, deliberately.
         * It distrusts the engine state a trimmed stream established, and a clean
         * replay's bytes are exactly what the server sent. What is no longer
         * truncated-only is the boundary cleaner (see writeReplayChunk): stripping
         * a screen switch out of a transcript is not distrust, it is refusing to
         * obey a sequence that has no meaning for a transcript.
         */

        // One explicit notice, never a silent drop: the user must be able to
        // tell "my session started here" from "SSHDeck threw away the top".
        if (replay.truncated) {
            const dropped = Number.isFinite(droppedBytes) && droppedBytes > 0
                ? ` (${Math.round(droppedBytes / 1024)} KB)`
                : '';
            const text = window.i18n
                ? window.i18n.t('terminal.replayTruncated')
                : 'Earlier output was trimmed to restore this session faster.';
            this.writeOutputNow(sessionId,
                `\r\n\x1b[2m--- ${text}${dropped} ---\x1b[0m\r\n`);
        }

        /*
         * Record that this session's gesture-relevant engine state
         * (mouse tracking, SGR encoding, buffer choice) was last established by
         * bytes a TRUNCATED replay carried. The DECSETs inside those bytes are
         * trim debris, not a live attach handshake: tmux's preamble may have had
         * its matching reset in the discarded prefix, and no repaint is coming
         * (RESTORE reattaches nothing). A row resolved from such state must not
         * put bytes on the PTY -- ScrollOwner.resolve reads this flag and fails
         * any byte-emitting resolution back to local scroll.
         *
         * Cleared on LIVE output only: the first ssh_output frame after the
         * replay proves a real application is driving the terminal again, so
         * its rows become trustworthy exactly when real bytes establish them.
         */
        if (replay.truncated) {
            const provenanceKeys = this.sessionTerminals[sessionId] || [];
            provenanceKeys.forEach(key => {
                this.ScrollOwner.markProvenanceUntrusted(this.terminals[key]);
            });
        }

        replay.open = false;
        const queued = replay.liveQueue;
        replay.liveQueue = [];
        delete this.replayState[sessionId];

        queued.forEach(data => this.writeOutputNow(sessionId, data));

        /*
         * The queued live frames are written LAST and nothing follows
         * them. The S16/S4 alt-screen belt used to run here, after this drain,
         * and it has been REMOVED deliberately -- see the note above
         * writeReplayChunk. Two measurements decided it:
         *
         *   * It is no longer needed. The boundary cleaner strips every
         *     alternate-screen switch out of the payload, and writeReplayChunk
         *     writes one `\x1b[?1049l` of its own ahead of the first chunk, so the
         *     transcript reaches the normal buffer from a known state. Measured
         *     with the belt disabled at runtime: 400 of 400 lines reachable,
         *     baseY 353, whether the engine started on the normal or the
         *     alternate buffer (/tmp/s16work/belt_head_probe.out rows H-a, H-b,
         *     H-f).
         *
         *   * It was actively harmful. A live frame that arrives DURING the
         *     replay is queued here and drained above; when that frame is a real
         *     application entering a full-screen mode, the belt fired afterwards
         *     and threw the user straight back out of it. Measured on the same
         *     probe: with the belt, `bufType normal` and the live TUI's text
         *     absent (row H-d); with it gone, `bufType alternate` and the text
         *     present (row H-e). A live frame is a genuine application statement
         *     and must outrank replay housekeeping, which is exactly the ordering
         *     this drain establishes.
         */

        /*
         * Fix7: scroll the replay to the live edge on restore.
         *
         * The owner's workflow is: codex running on the alternate buffer (at the
         * live edge by definition -- alt has no scrollback), navigate to admin
         * (full page reload), then back (another reload or bfcache restore). The
         * reload triggers ssh_session_restored + ssh_replay_chunk, and the
         * sanitizer strips the unpaired ?1049h out of the transcript (S14/S16
         * design: an alt-screen enter whose matching exit was in the discarded
         * prefix is trim debris), so the replay writes to the NORMAL buffer.
         * After finishReplay the viewport is wherever the write sequence left it
         * (scrollTop 0 = top of history), and with no scrollToBottom the user
         * sees the top of a now-scrollable buffer instead of the live edge they
         *
         * The snapshot carries no viewport intent, so the only heuristic is: a
         * user reloading the page expects to see the LIVE terminal, not a frozen
         * historical view. Scroll every terminal of this session to the bottom
         * after the replay finishes, exactly as a fresh attach would. A user who
         * deliberately scrolls up after the restore keeps their position (the
         * scroll observer updates the intent), and a drained live frame that put
         * the terminal on the alternate buffer (where scrollToBottom is a no-op)
         * is unaffected.
         */
        (this.sessionTerminals[sessionId] || []).forEach(key => {
            const terminal = this.terminals[key];
            if (terminal) {
                terminal.scrollToBottom();
            }
        });
    },

    /*
     * Whole-buffer replay for callers that hold the bytes already.
     *
     * restoreSession calls this when a snapshot still carries an inline
     * buffered_output (older server, or a payload small enough not to be
     * chunked). It is expressed in terms of the same sequenced path so there is
     * ONE replay implementation, not a second one that drifts.
     */
    queueReplay(sessionId, data) {
        if (!this.replayState[sessionId]) {
            this.beginReplay(sessionId, 1);
        }
        const replay = this.replayState[sessionId];
        this.acceptReplayChunk(sessionId, {
            seq: replay.nextSeq,
            total: replay.nextSeq,
            data: data || '',
            final: true,
            truncated: false,
            dropped_bytes: 0,
        });
    },

    /*
     * RESTORED, deliberately. The views rewrite removed this group
     * with the shared-geometry machinery, and a test caught it: the live-edge
     * intent is NOT about a foreign grid. It is about THIS pane's box changing
     * the soft keyboard opening, a rotation, a pane switch -- where the
     * browser clamps the scroller before the refit lands and leaves the user
     * above the prompt. That happens exactly as much with one tmux client per
     * socket as it did with a shared PTY.
     */
    /*
     * THE VERTICAL TWIN OF panIntent: was this terminal sitting at the
     * LIVE EDGE before its box started changing? Per TERMINAL KEY, because a
     * session mirrored into two panes can be at the edge in one and scrolled up
     * in the other, and each pane's box changes on its own.
     *
     * THE DEFECT THIS CLOSES, measured end to end.
     *
     * The user reported "resize/repaint can go blank" and "the viewport
     * position breaks". On the live box (/tmp/s26reg/diag3_s27.out) a row SHRINK
     * held the live edge, but a row GROW left the viewport exactly 2x the row
     * delta above it, permanently:
     *     before  grid 51x48  baseY 114  viewportY 114  gap  0  painted 51
     *     shrink  grid 51x34  baseY 114  viewportY 114  gap  0  painted 51
     *     grow    grid 51x48  baseY 114  viewportY  86  gap 28  painted  8
     * and it survived 4s of settling, a live write, and a return to the original
     * size. `painted 8` is the blank: the last visible row is nearly empty
     * because the viewport is showing history instead of the prompt.
     *
     * The stacks named only two writers around the grow -- xterm's own onScroll
     * X14, then `resize` from fitTerminal -- so the app never scrolled away.
     * Vendored-engine fixtures then localised the mechanism:
     *
     *   Diag4 bare bundle, resize and FitAddon.fit: gap 0, no strand
     *   Diag5 bare bundle, fit a turn LATE (our debounce): gap 0, no strand
     *   diag6  + the app's own `.xterm{height:100%}`
     *          (style.css:5729):  BEFORE the fit  gap 12, AFTER the fit gap 12
     *   diag7  Q3 (no re-glue) gap 12  vs  Q2 (re-glue) gap 0
     *
     * So the cause is not xterm and not the debounce -- it is the two together
     * with our CSS. `.xterm-viewport` is absolutely positioned inside a
     * `height:100%` `.xterm`, so the SCROLLER's clientHeight grows in the same
     * layout pass as the pane while xterm still believes the old row count.
     * maxScrollTop = scrollHeight - clientHeight drops by the row delta, the
     * browser CLAMPS scrollTop (measured 2924 -> 2728), and xterm's Viewport
     * translates that clamp into a real buffer scroll. The debounced fit then
     * carries the gap into the new grid -- which is why the strand is 2x the
     * delta rather than 1x. Once away from the edge nothing re-glues, because
     * writeToTerminalWithScroll captures `shouldScroll` from isTerminalAtBottom
     * and it is false forever after.
     *
     * WHY THE STATE IS MAINTAINED CONTINUOUSLY AND NOT SAMPLED AT THE RESIZE.
     * The first version of this sampled the flag inside the ResizeObserver
     * callback, on the strength of diag7 Q1 -- where that callback really did
     * still see gap 0 with the new clientHeight. That measurement did not
     * generalise, and the production probe said so plainly (diag9_s27.out): on
     * a real viewport resize the first sample at +55ms already read
     *     baseY 114  viewportY 105  gap 9  intent=false/true
     * i.e. the callback had captured atLiveEdge FALSE -- the clamp beat it. The
     * fixture only won that race because it changed the height from JS, which
     * delivers the RO callback in the same rendering update; a browser-driven
     * resize dispatches the scroll first. So no sampling point at resize time is
     * trustworthy, and the flag has to be maintained BEFORE the resize instead.
     *
     * PROVENANCE IS WHAT SEPARATES A DECISION FROM A CLAMP -- exactly the
     * [INF-S8-1] argument panIntent records for the horizontal axis, one axis
     * over. The flag is updated from xterm's own scroll event, but ONLY while
     * the scroller's clientHeight equals the height the flag was recorded
     * against. A scroll that arrives with a DIFFERENT clientHeight is by
     * construction geometry-induced -- the box changed and the browser clamped
     * so it does not update the flag; it marks it PENDING, and the fit that
     * follows re-glues the live edge if that is where the user was.
     *
     * A user who deliberately scrolled up to read is recorded atLiveEdge:false
     * by that same scroll path (their clientHeight is unchanged), so they are
     * never yanked to the bottom -- the rule the write funnel already follows.
     *
     * AND WHY `pending` GATES THE SCROLL PATH (S27, second correction).
     * Provenance by height alone is not sufficient, because the two writers race
     * in BOTH orders and the height is a single value they share. Measured on the
     * live box with two resizes ~100ms apart -- the real §R4 journey, since the
     * probe advances as soon as a row paints (diag14_s27.out):
     *
     *   +203ms noteLiveEdgeResize  gap  9  h=691 | true/false/h567 -> true/true/h691
     *   +206ms noteLiveEdgeScroll  vpY 105 baseY 115  h=691 | true/true/h691 -> FALSE/false
     *
     * The resize callback had already adopted 691, so the clamp-scroll 3ms later
     * arrived with EQUAL heights, was classified as a decision, and overwrote the
     * flag with false. restoreLiveEdgeIntent then correctly declined to move a
     * user who had apparently chosen to scroll up, and the strand became permanent
     * gap 20 held to +9s. The earlier diagnostics missed it because they waited
     * 2.5s between resizes, so the scroll landed while the buffer was still at
     * gap 0 and recorded `true` by luck (diag10/diag11: gap 0 throughout).
     *
     * So `pending` -- "a geometry change is in flight" -- now suppresses flag
     * UPDATES until the fit consumes it. Both orderings are then covered: a scroll
     * that beats the callback still differs in height (the clamp branch), and a
     * scroll that follows the callback is suppressed by the mark. requestFit's
     * debounce is 50ms and restoreLiveEdgeIntent runs on every fitTerminal, so the
     * suppression window is that fit, not an open-ended freeze.
     */
    liveEdgeIntent: {},       // terminalKey -> { atLiveEdge, clientHeight, pending }

    liveEdgeDisposables: {},  // terminalKey -> dispose fn for the scroll observer

    /*
     * The scroller box the flag's provenance is recorded against. Read
     * from the DOM rather than derived from rows, because the whole point is
     * to notice the moment the BOX changes while the engine's row count has
     * not caught up yet. Returns null when there is no scroller to read; every
     * caller treats that as "no provenance", which is the fail-quiet direction.
     */
    liveEdgeViewportHeight(terminal) {
        const el = terminal?.element?.querySelector('.xterm-viewport');
        return el ? el.clientHeight : null;
    },

    /*
     * S27 capture — install the continuous live-edge observer for one terminal.
     *
     * Called once per terminal from attachTerminal, alongside the other
     * per-terminal observers. Two entry points write the flag, and they are not
     * equal -- the same shape notePanIntent uses for the horizontal axis:
     *
     *   a scroll with UNCHANGED scroller height  = the user (or a write) moved
     *       the viewport deliberately, so the flag is refreshed and the intent
     *       is realised;
     *   a scroll with a DIFFERENT scroller height = the box changed and the
     *       browser clamped scrollTop, which xterm has just translated into a
     *       buffer scroll. That is not a decision, so the flag KEEPS its old
     *       value and is marked PENDING for the fit that follows.
     *
     * Measured justification for the split, not a preference: diag9_s27.out,
     * first sample +55ms after a real viewport grow, read gap 9 with the
     * ResizeObserver's own capture already showing atLiveEdge false. The clamp
     * beats every resize-time sampling point on a browser-driven resize, so the
     * only reliable source is the state maintained BEFORE the box moved.
     *
     * The initial flag is seeded here: a fresh terminal is at its live edge by
     * construction (empty buffer, viewportY === baseY === 0).
     */
    observeLiveEdge(terminalKey) {
        const terminal = this.terminals[terminalKey];
        if (!terminal) {
            return;
        }
        this.liveEdgeDisposables[terminalKey]?.();
        const buffer = terminal.buffer?.active;
        this.liveEdgeIntent[terminalKey] = {
            atLiveEdge: buffer ? buffer.viewportY >= buffer.baseY : true,
            clientHeight: this.liveEdgeViewportHeight(terminal),
            pending: false,
        };
        const disposable = terminal.onScroll(() => {
            this.noteLiveEdgeScroll(terminalKey);
        });
        this.liveEdgeDisposables[terminalKey] = () => disposable?.dispose();
    },

    /*
     * One scroll observation, classified by provenance (see observeLiveEdge
     * and the liveEdgeIntent note). Also called for a scroller height change
     * with no scroll at all, which is how a resize that does NOT clamp anything
     * keeps its provenance current.
     */
    noteLiveEdgeScroll(terminalKey) {
        const terminal = this.terminals[terminalKey];
        const buffer = terminal?.buffer?.active;
        if (!buffer) {
            return;
        }
        const height = this.liveEdgeViewportHeight(terminal);
        const entry = this.liveEdgeIntent[terminalKey];
        if (!entry) {
            this.liveEdgeIntent[terminalKey] = {
                atLiveEdge: buffer.viewportY >= buffer.baseY,
                clientHeight: height,
                pending: false,
            };
            return;
        }
        if (entry.clientHeight !== height) {
            // The box moved under this scroll: it is a clamp, not a decision.
            // Keep the recorded intent, note the new geometry so a following
            // deliberate scroll is trusted again, and let the fit re-glue.
            entry.clientHeight = height;
            entry.pending = true;
            return;
        }
        if (entry.pending) {
            // A geometry change is already in flight and this scroll arrives with
            // the height the resize callback just adopted, so it cannot be
            // distinguished from a clamp by height -- and measured on the live box
            // it IS the clamp (diag14_s27.out: resize +203ms adopts h=691, the
            // clamp-scroll lands +206ms with the same height and used to overwrite
            // the flag with false). The intent stands until the fit consumes it.
            return;
        }
        entry.atLiveEdge = buffer.viewportY >= buffer.baseY;
        entry.pending = false;
    },

    /*
     * The geometry observation itself, from the ResizeObserver callback.
     *
     * A resize that changes the scroller height marks the intent pending even
     * when no scroll event follows (a shrink at the live edge is the common
     * case: xterm holds the edge and nothing is clamped), so the fit below can
     * assert the invariant instead of relying on a scroll having fired. It never
     * READS the at-edge state here -- by this point the clamp may already have
     * moved the buffer, which is precisely the mis-read diag9 measured.
     */
    noteLiveEdgeResize(terminalKey) {
        const terminal = this.terminals[terminalKey];
        const entry = this.liveEdgeIntent[terminalKey];
        if (!terminal || !entry) {
            return;
        }
        const height = this.liveEdgeViewportHeight(terminal);
        if (entry.clientHeight !== height) {
            entry.clientHeight = height;
            entry.pending = true;
        }
    },

    /*
     * S27 apply — the bottom of fitTerminal, once the grid change has landed.
     *
     * Only a terminal that WAS at the live edge is re-glued, and only when it is
     * no longer there: a user who scrolled up to read keeps their position
     * (atLiveEdge false), and a terminal still at the edge needs no write, which
     * keeps the T2 at-bottom no-op contract (`armGestureAuthority`'s note at
     * 1786 records what a permanently-armed correction breaks).
     *
     * The pending mark is consumed either way -- applied or declined -- so the
     * next resize starts from a fresh observation. The FLAG itself survives,
     * because it is the standing answer to "where does this user want to be",
     * maintained by the scroll path rather than sampled here.
     *
     * The scrollToBottom below fires xterm's own onScroll, which re-enters
     * noteLiveEdgeScroll. That is harmless and self-consistent: the heights
     * agree by then, the buffer is at the edge, so it records atLiveEdge true --
     * the state this call just established.
     */
    restoreLiveEdgeIntent(terminalKey) {
        const entry = this.liveEdgeIntent[terminalKey];
        if (!entry || !entry.pending) {
            return;
        }
        entry.pending = false;
        const terminal = this.terminals[terminalKey];
        if (!terminal) {
            return;
        }
        entry.clientHeight = this.liveEdgeViewportHeight(terminal);
        if (!entry.atLiveEdge || this.isTerminalAtBottom(terminal)) {
            return;
        }
        terminal.scrollToBottom();
    },

    /*
     * RESTORED, deliberately: this is a LOCAL xterm defect, not a
     * shared-geometry one, and the views rewrite removed it by association.
     * Every fit still goes through it.
     */
    /*
     * Reported on a desktop over Tailscale with the codex CLI open:
     * them tried to restore a VIEWPORT. Measured on the real engine, there is
     * no viewport to restore -- the shrink DESTROYS rows.
     *
     * Probe, alternate screen, 30 rows of a self-naming ruler, cursor near the
     * bottom, shrunk to 22 rows:
     *
     *     before  ROW01..ROW30   viewportY=0 baseY=0
     *     after   ROW07..ROW28   viewportY=0 baseY=0    lost 01-06 and 29-30
     *
     * viewportY and baseY never move -- an alternate buffer has no scrollback,
     * so both are structurally 0 (see :1718). What moves the picture is xterm's
     * own Buffer.resize: on a no-scrollback buffer a row shrink runs
     * lines.trimStart(delta), dropping rows off the TOP for good. Content
     * slides up by exactly that delta. That IS the "jump to the top", and no
     * scroll restore can undo a line that no longer exists.
     *
     * The full round trip does repair it -- ssh_resize -> SIGWINCH -> the TUI
     * repaints -> correct again (measured: ROW01..ROW47 -> ROW16..ROW45 ->
     * NEW01..NEW30). But over tailscale that repair is a round trip away, and a
     * window DRAG emits one of these per debounce tick, so the pane spends the
     * whole drag showing shredded frames.
     *
     * So while a full-screen program holds the pane, the engine is never
     * shrunk vertically. Growth passes through untouched -- adding rows
     * destroys nothing, and refusing it would strand content off-box. Three
     * things make holding correct rather than merely safe:
     *   - the proposal is unaffected: reportLocalFit measures the CONTAINER
     *     through proposeDimensions and never reads the engine grid, so the
     *     server still learns this pane's true size and the MIN source moves;
     *   - the extra rows cannot be seen: `.terminal-wrapper` is
     *     `overflow: hidden` (style.css:3600) and the repaint that follows the
     *     SIGWINCH paints from row 1, so what overhangs the box is stale bottom;
     *   - it self-clears: leaving the alternate screen puts the pane back on
     *     the normal buffer, whose next fit shrinks into scrollback losing
     *     nothing.
     * The normal buffer is deliberately excluded: it HAS scrollback, its shrink
     * reflows into it, and the prompt must keep following the box.
     */
    resizeTerminalPreservingAltRows(terminal, cols, rows, authoritative = false) {
        const onAlternate = terminal.buffer?.active?.type === 'alternate';
        /*
         * The refusal to shrink an alternate grid is a guard against a LOCAL
         * guess: xterm's own Buffer.resize trims rows off the top of a
         * no-scrollback buffer, so shrinking on a hunch destroys what the
         * program painted and nothing repaints it.
         *
         * `authoritative` is the case where it is not a guess: the size came
         * from the server as the tmux WINDOW's size, tmux has already resized
         * the pane and repainted the program at it, and every row the engine
         * keeps beyond it is a row tmux never paints again. Those leftover
         * with U+00B7 middle dots (measured on tmux 3.7c: a 100x40 client on a
         * 50x19 window receives `│` plus runs of `·` from column 51), and an
         * engine that refuses to shrink keeps painting them.
         */
        const safeRows = (onAlternate && !authoritative)
            ? Math.max(rows, terminal.rows) : rows;
        if (terminal.cols === cols && terminal.rows === safeRows) {
            return;
        }
        terminal.resize(cols, safeRows);
    },

    /*
     * W5 disposable registry. Resources (timers, socket listeners, observers)
     * whose lifetime is tied to a session rather than the page are registered
     * here so destroyTerminal can release them all without ad-hoc tracking.
     */
    registerDisposable(sessionId, cleanup) {
        if (!this.disposables[sessionId]) {
            this.disposables[sessionId] = [];
        }
        this.disposables[sessionId].push(cleanup);
    },

    cleanupSessionDisposables(sessionId) {
        const cleanups = this.disposables[sessionId] || [];
        cleanups.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('Disposable cleanup error:', e);
            }
        });
        delete this.disposables[sessionId];
    },

    writeOutputToTerminal(terminalKey, data, sessionId) {
        const terminal = this.terminals[terminalKey];
        if (!terminal) {
            return;
        }

        // Filter out Device Attributes responses (ESC[c sequences only).
        // Bare-pattern regexes were removed because they corrupt legitimate
        // output like "padding:0;color:red" or "cat file".
        data = data.replace(/\x1b\[[?>]?[0-9;]*c/g, '');

        if (this.terminalReady[terminalKey]) {
            this.writeToTerminalWithScroll(terminal, data, sessionId);
            if (this.frozenPanes[terminalKey]) {
                this.noteFrozenPaneWrite(terminalKey, data);
            }
        } else {
            if (!this.pendingOutput[terminalKey]) {
                this.pendingOutput[terminalKey] = [];
            }
            this.pendingOutput[terminalKey].push(data);
            console.log(`Buffering output for ${sessionId} (terminal not ready yet)`);
        }
    },


    isTerminalAtBottom(terminal) {
        const buffer = terminal.buffer?.active;
        if (!buffer) {
            return true;
        }
        return buffer.viewportY >= buffer.baseY;
    },






    setScrollState(sessionId, active) {
        if (!sessionId) {
            return;
        }
        const next = active === true;
        if (this.scrollStateBySession[sessionId] === next) {
            return;
        }
        this.scrollStateBySession[sessionId] = next;
        document.dispatchEvent(new CustomEvent('sshdeck:terminal-scroll-state', {
            detail: { sessionId, active: next },
        }));
    },

    isSessionScrolled(sessionId) {
        return this.scrollStateBySession[sessionId] === true;
    },

    sessionIdForTerminalKey(terminalKey) {
        return Object.keys(this.sessionTerminals).find(sessionId =>
            (this.sessionTerminals[sessionId] || []).includes(terminalKey)) || null;
    },










    syncTerminalScrollState(sessionId, terminal) {
        if (!sessionId || !terminal) {
            return;
        }
        // Scroll state is the xterm
        // scrollback position, not who owns the mouse. The old OR with
        // appOwnsMouse made a claude/vim/htop session (mouse tracking on)
        // ALWAYS show Exit Scroll though tmux never entered copy-mode: the
        // click sent tmux_exit_copy_mode, the server answered a truthful
        // was_in_mode:0, and the 500ms resync below re-showed the button --
        // a control that could never exit anything, exactly what the owner
        // reported. isTerminalAtBottom is the sole actionable state: away
        // from the bottom means there is something to go back to, and
        // exitScrollAction knows how (tmux copy-mode via the server, xterm
        // scrollback client-side). appOwnsMouse is still read by app.js for
        // the honest toast wording -- it is a wording input, not a state.
        // xterm 6 scrolls nothing for a tmux copy mode (tmux scrolls ITS
        // copy and the viewport stays at the bottom), so the indicator tmux
        // paints is the second driver -- without it the button never
        // appeared on xterm 6.
        if (!this.appOwnsMouse(sessionId)) {
            // The application let go of the wheel (it exited, or the pane
            // left the alternate screen); what it owed is no longer owed.
            this.appScrollDepth[sessionId] = 0;
        }
        this.setScrollState(sessionId, !this.settledAtBottom(terminal)
            || this.tmuxPaneInCopyModeIndicator(terminal)
            || (this.appScrollDepth[sessionId] || 0) > 0);
    },

    /*
     * against the resize transient that makes the buffer lie.
     *
     * THE TRANSIENT, measured frame by frame on the real client (390x844,
     * keyboard close, user sitting AT the bottom):
     *
     *     +0ms   rows=27  vY=174 bY=174  scrollTop=2436 scrollH=2841 cH=405
     *     +25ms  rows=27  vY=174 bY=174  scrollTop=2150 scrollH=2841 cH=691
     *     +46ms  rows=27  vY=154 bY=174  scrollTop=2150 scrollH=2841 cH=691
     *     +103ms rows=48  vY=153 bY=153  scrollTop=1862 scrollH=2833 cH=691
     *
     * The box grows at +25ms; the engine does not follow until the debounced
     * fit lands at +103ms. In between, xterm translates the browser's clamp of
     * a scroller that is now taller than its content into a BUFFER scroll, and
     * `viewportY >= baseY` answers false for a viewport nobody moved. Whichever
     * driver samples inside that window publishes "scrolled", the button
     * appears, and 60ms later it is corrected -- 150ms with a real iOS keyboard
     * animation, which is the flash the owner sees. It is intermittent because
     * observeScrollState's 500ms sweep only sometimes lands inside the window.
     *
     * This is the same provenance problem S27 already names for the live edge
     * ("a scroll with a DIFFERENT scroller height ... is not a decision", see
     * noteLiveEdgeScroll), but the scroll-state publisher never participated in
     * it. It cannot reuse liveEdgeIntent's `pending` flag: fitTerminal returns
     * early for a terminal that is not visible, which can leave the mark
     * unconsumed, and a stuck flag would freeze the button in
     * whatever state it held -- trading a flash for a stuck control.
     *
     * So the corroborating source is the DOM scroller itself, which is
     * self-correcting by construction: during the transient the browser has
     * ALREADY clamped scrollTop to the true bottom (2150 >= 2841-691), so it
     * reads at-bottom exactly when the buffer is lying. The two are OR-ed
     * because they disagree in opposite directions across the gesture and only
     * ever transiently; when the user genuinely scrolls up BOTH report away
     * from the bottom (measured, all six frames of a -40 line scroll), so a
     * button that must be visible is untouched.
     */
    settledAtBottom(terminal) {
        if (this.isTerminalAtBottom(terminal)) {
            return true;
        }
        const viewport = terminal?.element?.querySelector('.xterm-viewport');
        /*
         * THE CROSS-CHECK ONLY EXISTS WHERE THERE IS A DOM SCROLLER.
         *
         * It guards one thing: the resize transient measured on xterm 5.3.0,
         * where the browser clamps a scroller that is briefly taller than its
         * content and the engine turns that clamp into a buffer scroll, so the
         * buffer says "scrolled up" for ~80ms while nothing moved. That can
         * only happen on an engine that scrolls by DOM height. xterm 6 renders
         * no scroll area at all (`.xterm-scroll-area` is gone and the viewport
         * never gains a range), so consulting it there would answer "at the
         * bottom" for every genuinely scrolled-up terminal -- which is the
         * exit-scroll button never appearing.
         */
        const scrollArea = terminal?.element?.querySelector('.xterm-scroll-area');
        if (!viewport || !scrollArea) {
            return false;
        }
        // A scroller with nothing to scroll (the alternate buffer, an unfilled
        // screen) is at its bottom by definition.
        const range = viewport.scrollHeight - viewport.clientHeight;
        // One pixel of tolerance: scrollTop is fractional under a zoomed or
        // non-integer device pixel ratio and lands just short of the range.
        return range <= 0 || viewport.scrollTop >= range - 1;
    },

    /*
     * The actionable side of Exit Scroll.
     *
     * Returns 'tmux-copy-mode' when the click must go through the server
     * (the pane is not under app mouse ownership -- scrolling there means
     * tmux copy-mode), or 'app-owned' after performing the client-side exit:
     * a foreground app owns the mouse, tmux forwards wheel to it and never
     * enters copy-mode, so the server path is a guaranteed no-op -- the user
     * is scrolling xterm's own scrollback, and scrolling back to the bottom
     * IS the exit.
     */
    exitScrollAction(sessionId) {
        /*
         * ONE ROUTE PER OWNER OF THE POINTER, and `appOwnsMouse` is the whole
         * decision.
         *
         * A view is a real tmux client, so tmux sends it the mouse DECSETs and
         * `mouse on` means a swipe or a wheel puts the PANE into copy mode.
         * Exiting that is a tmux command, not a local scroll: the server answers
         * `tmux_copy_mode_exited`, and app.js scrolls this client to the bottom
         * on `was_in_mode` so the local viewport agrees with the repaint.
         *
         * When a foreground application has grabbed the mouse (DECSET
         * 1000/1002/1003 -- claude, vim, htop) tmux forwards the wheel to that
         * application and never enters copy mode, so asking tmux could only ever
         * answer was_in_mode:0 -- the "button that exits nothing" the
         * owner batch fixed. What the user scrolled there is xterm's own
         * scrollback, so returning to the bottom IS the exit.
         *
         * the control-transport branch that used to sit here is
         * gone. It existed because a control client never received the DECSETs,
         * which made `appOwnsMouse` false for the session's whole life and sent
         * every click down the tmux route to be answered was_in_mode:0 -- the
         * owner's "scroll-exit button does nothing".
         *
         * `appOwnsMouse` cannot be the whole decision either. tmux
         * with `mouse on` turns tracking on for EVERY client, in and out of
         * copy mode, so the test above was true for the session's whole life
         * that decides; the mouse mode only breaks the tie when nothing is
         * scrolled locally (the pre-existing contract: no tracking means the
         * server is asked, and a truthful was_in_mode:0 costs nothing).
         */
        const keys = this.sessionTerminals[sessionId] || [];
        const terminal = keys.length > 0 ? this.terminals[keys[0]] : null;
        if (terminal && this.tmuxPaneInCopyModeIndicator(terminal)) {
            return 'tmux-copy-mode';
        }
        if ((this.appScrollDepth[sessionId] || 0) > 0) {
            // A full-screen application holds the scroll: give it back the
            // wheels it was sent (see appScrollDepth).
            this.returnAppScroll(sessionId);
            this.setScrollState(sessionId, false);
            return 'app-owned';
        }
        if (!this.appOwnsMouse(sessionId)) {
            return 'tmux-copy-mode';
        }
        this.scrollSessionToBottom(sessionId);
        this.setScrollState(sessionId, false);
        return 'app-owned';
    },

    /*
     * The -- does a write to this session need tmux taken out of copy
     * mode first?
     *
     * Measured on a scratch tmux 3.4 server: while the pane is in copy mode tmux
     * DISCARDS every byte written to the attached client's channel -- 'echo
     * SENDTEST' + CR never reached the shell, nor did \x7f or \x15, and a
     * printable byte did not even move copy_cursor_y. Since tmux `mouse on` is
     * the product default, an ordinary upward swipe leaves the composer's whole
     * write path silently dead until something exits copy mode.
     *
     * The old conjunction
     * `isSessionScrolled && !appOwnsMouse` could not fire on the ONE pane that
     * actually reaches this state in production. A tmux pane with `mouse on`
     * turns on terminal mouse tracking for the outer terminal as well, so
     * AppOwnsMouse is TRUE for every tmux session at a bare prompt (measured:
     * trackingMode 'drag' with nothing running but bash,
     * /tmp/s16work/s22_product_copyexit.out) -- and a swipe then leaves xterm's
     * Own viewport at the bottom (tmux scrolls ITS copy), so isSessionScrolled
     * is FALSE too. Both conjuncts false; writeNeedsScrollExit never true; every
     * write after a swipe went into copy mode and was discarded until the user
     * Interacted -- the user's "after switching or reloading I have to touch
     * the terminal before it behaves".
     *
     * The new rule fires on the OBSERVABLE that survives both blind spots, the
     * one the harness measured directly on the live box: while the pane is in
     * copy mode tmux paints a COPY-MODE INDICATOR -- "[0/0]", "[N/NNN]" -- flush
     * against the right edge of the PANE row (/tmp/s16work/s22_i4_ordering.out;
     * tmux's own status line is the row below it, which is why the check scans a
     * small window of rows rather than one). A foreground app that owns the wheel
     * paints no such indicator and tmux never enters copy-mode behind it (its
     * WheelUpPane binding tests mouse_any_flag), so the exit is not asked for
     * there; and at a plain prompt there is nothing to ask for. The server side
     * stays cheap and safe: exit_tmux_copy_mode queries pane_in_mode first and is
     * a no-op when the pane is not in a mode, and it answers was_in_mode so the
     * client can log honestly rather than claim success for nothing.
     */
    writeNeedsScrollExit(sessionId) {
        if (!sessionId) {
            return false;
        }
        const keys = this.sessionTerminals[sessionId] || [];
        const terminal = keys.length > 0 ? this.terminals[keys[0]] : null;
        if (terminal && this.tmuxPaneInCopyModeIndicator(terminal)) {
            return true;
        }
        /*
         * On the CONTROL transport the indicator above is the ONLY
         * honest signal, and the disjunct below must not fire.
         *
         * `isSessionScrolled && !appOwnsMouse` was written for a transport where
         * tracking-off means tmux owns the wheel. On the control transport
         * `appOwnsMouse` is false ALWAYS -- tmux sends a control client no mouse
         * DECSETs (measured: /tmp/s35/r2_session_fields.json,
         * r5_tui_safety.json) -- so the disjunct reduced to `isSessionScrolled`
         * and armed on every deliberate write to a scrolled session.
         *
         * Two costs, both reported by the user. Each write paid a
         * control-channel round trip to exit_tmux_copy_mode that could not
         * exit anything; and app.js then ran `scrollSessionToBottom` +
         * `setScrollState(false)` (:1345-1350) as though a copy mode had been
         * left, yanking the user's own xterm scrollback to the bottom on every
         * keystroke -- the "caret/input can be stuck" shape.
         *
         * What is scrolled on this transport is xterm's own scrollback, and
         * xterm scrollback does NOT swallow writes: the premise the advisory
         * exists for ("tmux discards every byte written while the pane is in
         * copy mode") simply does not apply. The indicator check above still
         * runs first and unchanged, so a pane that really IS in copy mode --
         * put there by a server-side scroll rather than a gesture -- is still
         * caught on either transport.
         */
        return this.isSessionScrolled(sessionId) && !this.appOwnsMouse(sessionId);
    },

    /*
     * Is this payload the POINTER INTERACTION ITSELF, rather than
     * something the user wrote?
     *
     * `leave_scroll` rests on the premise recorded at the funnel (app.js): "a
     * byte the user deliberately sends is not a read -- in every terminal, typing
     * while scrolled back returns you to the prompt". A mouse tracking report
     * breaks that premise. It is not typing; it IS the scroll, encoded. The
     * gesture path produces them on purpose -- rows D/E synthesize LINE-mode
     * wheels which xterm encodes as SGR reports (:2524-2556) -- and a desktop
     * wheel over `.xterm` produces the identical bytes through xterm's own
     * listener. Both reach the funnel as ordinary `data`.
     *
     * MEASURED CONSEQUENCE of not telling them apart, on the live deployment
     * (/tmp/s26reg/s30_p8.log section I1: one swipe, no other write anywhere near
     * it). Mid-gesture the copy-mode indicator appears, writeNeedsScrollExit turns
     * true, and the funnel stamps `leave_scroll` on the REPORTS. The server then
     * honours it in its documented order -- exit_tmux_copy_mode INLINE, then the
     * write (socket_events.py:1188-1196) -- so tmux leaves copy mode and those
     * same report bytes are written to a pane that is no longer in a mode, where
     * readline prints them as text. Tape and shell line name each other exactly:
     * the reports carrying the flag were coordinates 33,34,36,38 and the line
     * Held "[<64;26;33M[<64;26;34M[<64;26;36M[<64;26;38M". That is the user's
     * raw-escape debris, and it also swallows the leading character of the next
     * real write (section I3: "...[<64;26;36Mcho SETTLED").
     *
     * SGR (DECSET 1006) is the only encoding this must cover, which is measured
     * rather than convenient: rows D/E are reached only when SGR is observed
     * (ScrollOwner.resolve :1163-1331 -- D0/E0 scroll locally and emit nothing),
     * and tmux requests 1006 from its client, which is why the live census reads
     * activeEncoding SGR with activeProtocol DRAG (/tmp/s26reg/s30_p9b.log
     * section J0). The older encodings cannot produce this leak: they appear when
     * a foreground app owns the mouse, and tmux never enters copy mode behind
     * such an app (its WheelUpPane binding tests mouse_any_flag), so there is no
     * mode to leave and no flag to set.
     *
     * Anchored to the WHOLE payload, one report or several: a composer line that
     * merely contains such text is still a deliberate write and keeps its exit.
     * Suppressing the advisory is the entire effect -- the bytes are untouched
     * and still reach tmux, which is what makes the gesture scroll at all.
     */
    dataIsMouseReport(data) {
        return typeof data === 'string'
            && data.length > 0
            && /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(data);
    },

    /*
     * Does this terminal's PAINTED screen carry tmux's copy-mode
     * indicator?
     *
     * The shape is measured, not guessed (/tmp/s16work/s22_i4_ordering.out, a
     * real swipe on the live box). At a bare prompt the last two painted rows are
     *     "sshdtest@the host:~$"
     *     "[sshdeck_s0:bash*     \"the host\" 13:09 27-Aug-26"
     * and after the swipe they are
     *     "sshdtest@the host:~$                       [0/0]"
     *     "[sshdeck_s0:[tmux]*   \"the host\" 13:09 27-Aug-26"
     * So the indicator is NOT on the last painted row -- tmux's own status line
     * is -- which is why this scans a small window rather than one row. Read
     * strictly: `[` digits `/` digits `]` flush against the right edge of a row.
     * Anchoring to the row END is what keeps ordinary output ("array[1/2] = x",
     * a vim ruler mid-row) from masquerading, and the row window is small so a
     * matching line sitting in scrollback cannot either.
     *
     * A CORRECTION TO THAT READING, and it is the important half: the
     * measurement was taken on a nearly-EMPTY pane, where the prompt happens to
     * BE the pane's top row. tmux draws the indicator at the pane's TOP-RIGHT,
     * so the two rows quoted above coincided only because the pane was empty.
     * The bottom window alone therefore missed it on every real session; the
     * top-row check below is what actually sees it. Both are kept: the bottom
     * window costs nothing and still covers the empty-pane shape the S23
     * evidence recorded.
     *
     * A foreground app that owns the wheel paints no such indicator and tmux
     * never enters copy-mode behind it, so this answers false there. Anything
     * unreadable answers false and the caller falls through to the pre-S23
     * predicate, so no existing behaviour depends on this being right.
     */
    tmuxPaneInCopyModeIndicator(terminal) {
        if (!terminal || !terminal.buffer || !terminal.buffer.active) {
            return false;
        }
        try {
            const buf = terminal.buffer.active;
            const last = buf.viewportY + terminal.rows - 1;
            // The pane row plus tmux's status line, with one row of slack for a
            // pane that paints a trailing blank.
            const first = Math.max(0, last - 3);
            for (let r = last; r >= first; r -= 1) {
                const line = buf.getLine(r);
                if (!line) {
                    continue;
                }
                const text = line.translateToString(true);
                if (/\[[0-9]+\/[0-9]+\]\s*$/.test(text)) {
                    return true;
                }
            }
            /*
             * A CORRECTION — THE ROW TMUX ACTUALLY DRAWS ON.
             *
             * The window above was measured on a nearly-EMPTY pane, where the
             * shell prompt IS the pane's top row -- which is why the S23
             * evidence showed the indicator next to the prompt and four rows
             * looked sufficient. tmux draws the copy-mode position indicator at
             * the TOP-RIGHT of the pane, so on any pane carrying real output
             * (i.e. every session the user ever scrolls) it is ~47 rows above
             * that window and this function answered FALSE while the pane was
             * in copy mode. writeNeedsScrollExit therefore stayed false,
             * `leave_scroll` never rode the ssh_input event (app.js:1334-1338),
             * handle_ssh_input never called exit_tmux_copy_mode
             * (socket_events.py:1188-1195), and tmux discarded the bytes exactly
             * As its own docstring says it does -- the whole the requirement fix was
             * Inert in production, and that is the user's "composer cannot send
             * deletion to the real terminal line".
             *
             * Measured on the live deployment, eight gestures across both
             * viewports (/tmp/s26reg/s30_p5_G.log arms A/B/C,
             * s30_p6_H.log §H2: phone 48 rows short/long up, short down, up
             * again; desktop 47 rows wheel up x2, wheel down): the indicator was
             * on pane row 0 EVERY time, never anywhere else. So this adds the ONE
             * row tmux uses rather than sweeping all 47-48 -- a whole-window scan
             * would match ordinary output that happens to end in "[3/60]" (the
             * anchored regex cannot tell the two apart) and the narrow window is
             * the only thing keeping that apart.
             *
             * A false positive here is cheap and cannot corrupt the pane:
             * exit_tmux_copy_mode queries pane_in_mode first and sends the ESC
             * only when it is exactly "1" (ssh_manager.py:3228-3234), so a
             * mistaken true costs one tmux query and leaks no Escape.
             */
            const topLine = buf.getLine(buf.viewportY);
            if (topLine
                    && /\[[0-9]+\/[0-9]+\]\s*$/.test(topLine.translateToString(true))) {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    },

    // Every mirrored terminal of a session back to the bottom. Also called by
    // the tmux_copy_mode_exited handler: tmux exits copy-mode by repainting
    // at the bottom, and the local viewport must agree with the remote one.
    scrollSessionToBottom(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        terminalKeys.forEach(key => {
            const terminal = this.terminals[key];
            if (terminal) {
                terminal.scrollToBottom();
            }
        });
    },

    writeToTerminalWithScroll(terminal, data, sessionId = null) {
        const shouldScroll = this.isTerminalAtBottom(terminal);
        terminal.write(data, () => {
            if (shouldScroll) {
                terminal.scrollToBottom();
            }
        });
    },


    appendTranscript(sessionId, data) {
        if (!this.transcripts[sessionId]) {
            this.transcripts[sessionId] = [];
            this.transcriptSizes[sessionId] = 0;
        }

        this.transcripts[sessionId].push(data);
        this.transcriptSizes[sessionId] += data.length;

        while (this.transcriptSizes[sessionId] > this.maxTranscriptSize && this.transcripts[sessionId].length > 0) {
            const removed = this.transcripts[sessionId].shift();
            this.transcriptSizes[sessionId] -= removed.length;
        }
    },

    /*
     * Move a transcript from one session id to another, keeping the history.
     *
     * A password reconnect cannot reuse its session id: the server has no stored
     * secret, so the reconnect goes back through ssh_connect and comes back as a
     * NEW session (the key/Tailscale route swaps the transport under the same id
     * and needs none of this). The tmux session itself is reattached by name, so
     * the remote side is genuinely continuous -- but the browser-side transcript
     * lived under the OLD id and would otherwise be dropped on the floor, which
     * is precisely the "reconnect behaves like a reset" complaint.
     *
     * PREPENDED, not replaced: the new session has usually already received its
     * first frames (tmux's redraw) by the time this runs, and those frames are
     * newer than everything being adopted. Appending would put the old history
     * after the new output and produce a transcript that reads backwards.
     *
     * Returns true when something was actually adopted, so a caller can tell a
     * real handoff from a no-op instead of assuming.
     */
    adoptTranscript(fromSessionId, toSessionId) {
        if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
            return false;
        }
        const inherited = this.transcripts[fromSessionId];
        if (!inherited || inherited.length === 0) return false;

        const existing = this.transcripts[toSessionId] || [];
        this.transcripts[toSessionId] = inherited.concat(existing);
        this.transcriptSizes[toSessionId] =
            (this.transcriptSizes[fromSessionId] || 0)
            + (this.transcriptSizes[toSessionId] || 0);

        // The old id keeps nothing: leaving a copy behind would double this
        // history in memory and survive as an orphan if the old session's own
        // teardown has already run.
        delete this.transcripts[fromSessionId];
        delete this.transcriptSizes[fromSessionId];

        // Trim with the SAME rule appendTranscript uses, so an adopted
        // transcript cannot exceed the cap that every other path respects.
        while (this.transcriptSizes[toSessionId] > this.maxTranscriptSize
                && this.transcripts[toSessionId].length > 0) {
            const removed = this.transcripts[toSessionId].shift();
            this.transcriptSizes[toSessionId] -= removed.length;
        }
        return true;
    },

    getTranscript(sessionId) {
        if (!this.transcripts[sessionId]) {
            return '';
        }
        return this.transcripts[sessionId].join('');
    },

    getCleanTranscript(sessionId) {
        const raw = this.getTranscript(sessionId);
        if (!raw) {
            return '';
        }
        const stripped = this.stripAnsiSequences(raw);
        return this.normalizeControlChars(stripped);
    },

    stripAnsiSequences(text) {
        return text
            .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\x1b[()][0-2]?/g, '')
            .replace(/\x1b[>=]/g, '')
            .replace(/\x1b[0-9A-Za-z]/g, '')
            .replace(/\x07/g, '');
    },

    normalizeControlChars(text) {
        const output = [];
        let lineStart = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '\n') {
                output.push('\n');
                lineStart = output.length;
                continue;
            }
            if (ch === '\r') {
                output.splice(lineStart);
                continue;
            }
            if (ch === '\b') {
                if (output.length > lineStart) {
                    output.pop();
                }
                continue;
            }
            if (ch === '\t') {
                output.push('\t');
                continue;
            }
            if (ch < ' ') {
                continue;
            }
            output.push(ch);
        }
        return output.join('');
    },

    // True when this terminal's wrapper is actually laid out. A wrapper that is
    // display:none (`.terminal-wrapper.unassigned`, i.e. a session not currently
    // shown in a pane) has no box, but fitAddon still measures it: it reads
    // GetComputedStyle(parent) and parseInts the height/width. On a display:none
    // element those do not resolve to pixels, so the *declared* value comes back
    // verbatim — and `.terminal-wrapper` is `height:100%; width:100%` (style.css),
    // so parseInt('100%') === 100 and the addon sees a 100x100 PIXEL box.
    // Measured on this build with the live topology: a wrapper that fits 95x32
    // While visible proposes 10x6 while hidden, and fit applies it.
    // Harmless while nothing acted on it; now that every resize is forwarded to
    // the PTY, that 10x6 would reach tmux and it would repaint its whole screen
    // into it. Fitting an invisible pane never meant anything, so skip it and
    // re-fit when it becomes visible (renderPane and the ResizeObserver both
    // fire then).
    isTerminalVisible(terminalKey) {
        const terminal = this.terminals[terminalKey];
        const element = terminal && terminal.element;
        if (!element) {
            return false;
        }
        const wrapper = element.closest ? element.closest('.terminal-wrapper') : null;
        const target = wrapper || element;
        return target.offsetParent !== null
            && target.getBoundingClientRect().height > 0;
    },

    /*
     * S20 item 5 — RE-MEASURE THE CHAR CELL when it was never measurable.
     *
     * The user's blocking regression, "all mobile fixes work only on the first
     * SSH connection after page load", is this one fact:
     *
     *   the FIRST session is attached into the pane it will occupy, so it is
     *   VISIBLE at terminal.open time; every later one is created while an
     *   earlier session still owns the pane, so its wrapper still carries
     *   `.unassigned`, which is `display: none`.
     *
     * Xterm.js 5.3.0 measures the character cell ONCE, inside `open`, through
     * CharSizeService: it inserts a measurement element and reads its box. In a
     * display:none subtree that box is 0x0, `hasValidSize` stays false, and the
     * service does not retry -- there is no resize, font or DOM event that makes
     * it. Measured (/tmp/s16work/s20_item5_probe.out, rounds 5-6): for such a
     * session `_charSizeService.width/height` are 0, `renderService.dimensions
     * .css.cell` is 0x0, and the vendored fit addon's
     *     if (cell.width === 0 || cell.height === 0) return;
     * Makes `proposeDimensions` return UNDEFINED -- forever, even once the
     * wrapper is 390x691 and visible.
     *
     * Everything the user listed follows from that single zero:
     *   - the terminal stays at its constructed 80x24 (geometry wrong);
     *   - `reportLocalFit` returns early on the undefined proposal, so the
     *     server never learns this client's size (sync wrong -- and with no
     *     proposal the shared-grid authority cannot see the client at all);
     *   - `.xterm-screen` has no box, so the gesture path's `cellHeight`
     *     divides by zero and `clientToCell` cannot resolve a cell: swipes,
     *     long-press selection and the pannable measurement are all dead
     *     (measured: zero wheel frames on such a session, 11 on a healthy one).
     *
     * The repair is to re-measure at the first moment a measurement can
     * succeed. That instant is a fit on a VISIBLE terminal, which is exactly
     * where this is called from: `renderPane` -> `requestFit` on every switch,
     * the ResizeObserver, and `attachTerminal`'s own initial fit. So a session
     * switch now runs the same effective init path the first connection got,
     * without a second attach and without a timer.
     *
     * Idempotent and cheap: it does nothing when the size is already valid, so
     * the healthy first-connection path is untouched. Guarded on the internals
     * it uses -- a vendor bump that renames them must degrade to today's
     * behaviour rather than throw inside the fit.
     *
     * Returns true when a measurement was (re)taken.
     */
    ensureCharCellMeasured(terminal) {
        const core = terminal?._core;
        const charSize = core?._charSizeService;
        if (!charSize || typeof charSize.measure !== 'function') {
            return false;
        }
        const cell = core._renderService?.dimensions?.css?.cell;
        const cellIsMeasured = !!(cell && cell.width > 0 && cell.height > 0);
        if (charSize.hasValidSize === true && cellIsMeasured) {
            return false;
        }
        try {
            charSize.measure();
        } catch (e) {
            console.error('Error re-measuring terminal char size:', e);
            return false;
        }
        return true;
    },

    /*
     * S15 defect 1, part 2 — split the column floor slack instead of piling it
     * on the right.
     *
     * `.xterm-screen` is an explicitly-sized, left-aligned block child of
     * `.xterm`'s padding box (the vendored xterm.css gives it `position:
     * relative` and nothing else), so whatever `floor(avail / cellWidth)` cannot
     * Use is dead space on the RIGHT and nowhere else -- the user's "the frame
     * sits slightly left of centre and the right edge looks thicker". Half of it
     * moves to the left as a margin, leaving the two bands equal apart from a
     * real scrollbar, which legitimately paints over the right padding because
     * `.xterm-viewport` spans the full `.xterm` width (left:0; right:0).
     *
     * Cleared, never negative: when the grid is WIDER than the pane the pane is
     * pannable and there is no slack to split, so an inline margin left behind
     * would push the panned content and create overflow the wrapper would have to
     * scroll. This runs from fitTerminal for BOTH geometry branches, before
     * updatePanePannable measures anything.
     *
     * Two measurement corrections. Both address the
     * same class of error: measuring a box while a previous decision about that
     * box is still written on it.
     *
     *   CLEAR BEFORE MEASURING. The margin this function writes is an inline
     *   style on `.xterm-screen`. The old code measured while the PREVIOUS
     *   margin was still applied -- harmless for `offsetWidth`/`clientWidth`,
     *   which ignore margins, but not for the rect read below, and not for any
     *   future reader. Clearing first makes the slack a function of the current
     *   grid alone, so a sequence of fits converges instead of drifting.
     *
     *   FRACTIONAL WIDTHS. `offsetWidth` and `clientWidth` are rounded to whole
     *   pixels. At the phone's measured cell width the grid box is routinely
     *   fractional (e.g. 353.6px), so the rounded pair could disagree by a pixel
     *   in either direction and the split slack inherited that error -- visible
     *   as the frame sitting a pixel off centre and, worse, as the left band
     *   changing by a pixel across refits at an unchanged grid (part of the
     *   the "text jumps sideways" report). getBoundingClientRect reports the real
     *   fractional box; the final margin is still floored to a whole pixel, so
     *   nothing downstream sees a fractional margin.
     *
     * The S15 slack FORMULA is untouched -- same terms, same halving, same
     * "cleared, never negative" rule. Only the numbers going into it got exact.
     */
    recentreTerminalScreen(terminal) {
        const xterm = terminal?.element;
        const screen = xterm?.querySelector('.xterm-screen');
        if (!screen) {
            return;
        }
        // Clear first: the slack must be measured against the UNSHIFTED box.
        screen.style.marginLeft = '';
        screen.style.marginTop = '';
        const style = getComputedStyle(xterm);
        const pads = (parseFloat(style.paddingLeft) || 0)
            + (parseFloat(style.paddingRight) || 0);
        const sbw = terminal._core?.viewport?.scrollBarWidth || 0;
        const borders = (parseFloat(style.borderLeftWidth) || 0)
            + (parseFloat(style.borderRightWidth) || 0);
        // getBoundingClientRect spans the BORDER box, so the border comes off
        // alongside the padding to reach the same content width clientWidth
        // reported -- only unrounded.
        const xtermRect = xterm.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        const xtermWidth = xtermRect.width - borders;
        const slack = xtermWidth - pads - sbw - screenRect.width;
        screen.style.marginLeft = slack > 0 ? `${Math.floor(slack / 2)}px` : '';
        /*
         * A grid TALLER than the pane shows its LAST rows. That is the soft
         * keyboard on a full-screen program: the grid is held (a SIGWINCH
         * would repaint the program from row one) while the pane above the
         * keyboard is half as tall, and the rows the user is working in --
         * the prompt, the newest output -- are the bottom ones. Clipping from
         * the top showed them the program's header and hid what they typed
         *
         * A grid shorter than the pane stays at the top, where the owner
         */
        const vpads = (parseFloat(style.paddingTop) || 0)
            + (parseFloat(style.paddingBottom) || 0);
        const vborders = (parseFloat(style.borderTopWidth) || 0)
            + (parseFloat(style.borderBottomWidth) || 0);
        /*
         * THE GRID IS ALWAYS ANCHORED TO THE BOTTOM, in both directions.
         *
         * OWNER REPORT: "van loi giat man hinh nhay len xuong lien
         * tuc khi thay doi kich thuoc tren desktop", on an oh-my-posh prompt.
         *
         * This used to anchor the bottom when the grid was TALLER than the box
         * and centre the remainder when it was SHORTER. Those are two different
         * offsets, and a drag crosses between them many times a second: at the
         * crossing the content jumps by half the slack and back. A prompt on
         * the normal buffer makes it worse than a TUI does, because its own
         * repaint arrives between the frames.
         *
         * `-overflow` IS the bottom anchor in both directions -- negative when
         * the grid overflows, positive when it falls short -- so the offset is
         * now one continuous function of the box height that passes through
         * zero instead of stepping. And the bottom is the right edge to hold
         * for a terminal: the last line is the one being read.
         */
        const overflow = screenRect.height - (xtermRect.height - vborders - vpads);
        screen.style.marginTop = overflow === 0
            ? '' : `${overflow > 0 ? -Math.ceil(overflow) : Math.floor(-overflow)}px`;
        // A focus-driven scroll of an overflow:hidden box would add its own
        // offset on top of these margins and stay; the box is pinned instead.
        xterm.scrollTop = 0;
        if (xterm.parentElement) {
            xterm.parentElement.scrollTop = 0;
        }
    },

    /*
     * The pane's own capacity at the BASE font, in cells -- what fitAddon
     * proposes, computed so that it does not change when the terminal is
     * zoomed. Same measurements as @xterm/addon-fit 0.11 (the parent's box,
     * the terminal's padding, the overview-ruler reservation), with the cell
     * scaled back to the base font.
     */
    /*
     * The glyph advance at the BASE font, whatever font is on screen now.
     *
     * A fit must describe the pane at the base font: it is what every device
     * reports, and the minimum over those reports is the window. Deriving it
     * by scaling the presented character (`char * base / font`) is wrong --
     * glyph metrics are not linear in the font size (measured: a 12px font is
     * 7.22x14, an 8px font is 4.82x9, not 4.81x9.33). While a pane was zoomed
     * for a phone's window the desktop therefore REPORTED a fit that did not
     * exist; when the phone left, the window became that wrong size and the
     *
     * So it is measured, at the base font, once per terminal: the char size
     * service re-measures synchronously when fontSize changes, so the
     * presented font can be put back in the same turn. The cache is keyed by
     * the base size and the family, which is what a font or theme change
     * moves.
     */
    baseCharMetrics(terminal) {
        const base = this.getBaseFontSize();
        const family = terminal.options.fontFamily;
        const cached = terminal.__sshdeckBaseChar;
        if (cached && cached.font === base && cached.family === family) {
            return cached;
        }
        const charSize = terminal._core._charSizeService;
        const presented = terminal.options.fontSize;
        if (presented !== base) {
            terminal.options.fontSize = base;
            charSize.measure();
        }
        const metrics = {
            width: charSize.width, height: charSize.height, font: base, family,
        };
        if (presented !== base) {
            terminal.options.fontSize = presented;
            charSize.measure();
        }
        terminal.__sshdeckBaseChar = metrics;
        return metrics;
    },

    proposeBaseFit(terminal) {
        const box = this.paneCellBox(terminal);
        if (!box) {
            return null;
        }
        return {
            cols: Math.max(2, Math.floor(box.width / box.baseCell.width)),
            rows: Math.max(1, Math.floor(box.height / box.baseCell.height)),
        };
    },

    /*
     * What the SERVER is told, which is not always what the pane measures.
     *
     * While the app's own chrome is holding space (holdChromeGrid), the pane
     * is reported as it would be WITHOUT that chrome, so a panel of ours never
     * moves the shared tmux window. Everything that decides how this pane is
     * DRAWN -- presentWindowGrid above all -- keeps using proposeBaseFit, the
     * box as it really is: the text has to fit the room there is, and a grid
     * presented against a box it does not have is a clipped pane.
     */
    proposeReportedFit(terminal) {
        const box = this.paneCellBox(terminal);
        if (!box) {
            return null;
        }
        const held = this.chromeHeldOffset(terminal, box);
        if (!held || (!held.width && !held.height)) {
            return this.proposeBaseFit(terminal);
        }
        return {
            cols: Math.max(2, Math.floor(
                (box.width + held.width) / box.baseCell.width)),
            rows: Math.max(1, Math.floor(
                (box.height + held.height) / box.baseCell.height)),
        };
    },

    paneCellBox(terminal) {
        const xterm = terminal?.element;
        const parent = xterm?.parentElement;
        const charSize = terminal?._core?._charSizeService;
        if (!parent || !charSize || !(charSize.width > 0) || !(charSize.height > 0)) {
            return null;
        }
        const baseCell = this.baseCharMetrics(terminal);
        /*
         * MEASURE THE GUTTER, DO NOT GUESS IT. This reserved a flat 14px for
         * an overview ruler xterm only draws when `overviewRuler.width` is
         * set -- it is `{}` by default, so nothing was drawn there and the
         * grid stopped 14px short of the right edge (owner: * the scrollbar gutter: 8px where the page styles a scrollbar,
         * nothing on an overlay-scrollbar platform. The viewport reports it
         * exactly.
         */
        const viewportEl = xterm.querySelector('.xterm-viewport');
        const gutter = viewportEl
            ? Math.max(0, viewportEl.offsetWidth - viewportEl.clientWidth) : 0;
        const rulerWidth = terminal.options.overviewRuler?.width || 0;
        const ruler = terminal.options.scrollback === 0 ? 0 : gutter + rulerWidth;
        const outer = getComputedStyle(parent);
        const inner = getComputedStyle(xterm);
        const height = parseInt(outer.getPropertyValue('height'))
            - (parseInt(inner.paddingTop) + parseInt(inner.paddingBottom));
        const width = Math.max(0, parseInt(outer.getPropertyValue('width')))
            - (parseInt(inner.paddingRight) + parseInt(inner.paddingLeft)) - ruler;
        return { width, height, baseCell };
    },

    /*
     * The largest font at which a window SMALLER than this pane's fit still
     * fits the pane, capped at ZOOM_MAX times the base. tmux draws one window
     * at one size (: grouped sessions, every `window-size`
     * mode and `aggressive-resize` leave two clients of a window at the same
     * size), so when a phone shares the session the desktop's grid is the
     * phone's, and at the base font it stood as a narrow strip in a dark pane
     * mirrored at a size the desktop can read.
     *
     * Only UP: a window larger than the pane is transient (the minimum never
     * exceeds a fit) or the keyboard hold, and recentreTerminalScreen anchors
     * that one. Never on a window that is this pane's own fit -- the slack
     * inside one cell is under one font pixel, so the floor leaves the base.
     *
     * The cap is a guard against a transient one-row window, not a look: at
     * 3x the owner's 83-row desktop could not fill its height from a phone
     * window of 20-27 rows (the keyboard up on a shell prompt needs 3.1-4.2x)
     * and the frame stood short again with the band below it.
     *
     * the text. The font follows the tighter axis, and the other axis is
     * filled with letter spacing (width) or line height (height), so a
     * phone-shaped window fills a desktop pane with no band on either side.
     * A window LARGER than the pane -- the keyboard up on a phone holding a
     * full-screen program's grid -- shrinks the text the same way instead of
     * anchoring the grid and painting slack: nothing moves, nothing is
     * black. ZOOM_MIN_FONT is the floor below which text is not text.
     */
    ZOOM_MAX: 6,
    ZOOM_MIN_FONT: 6,
    LINE_HEIGHT_MAX: 3,

    presentWindowGrid(terminal) {
        const box = this.paneCellBox(terminal);
        if (!box) {
            return;
        }
        const base = this.getBaseFontSize();
        const own = this.proposeBaseFit(terminal);
        let font = base;
        let letterSpacing = 0;
        let lineHeight = 1;
        if (!own || terminal.cols !== own.cols || terminal.rows !== own.rows) {
            const zoomW = box.width / (terminal.cols * box.baseCell.width);
            const zoomH = box.height / (terminal.rows * box.baseCell.height);
            const zoom = Math.min(zoomW, zoomH, this.ZOOM_MAX);
            font = Math.max(this.ZOOM_MIN_FONT, Math.floor(base * zoom));
            // Glyph metrics are not linear in the font size (an 8px font
            // measures 9px tall, not 14*8/12): set the font first and read
            // the character it actually produced before filling the rest.
            if (font !== terminal.options.fontSize) {
                terminal.options.fontSize = font;
            }
            const charSize = terminal._core._charSizeService;
            // Fractional: a whole-pixel floor threw away up to a pixel per
            // column, which at 55 columns is a 50px band down each side.
            letterSpacing = Math.max(0, Math.floor(
                (box.width / terminal.cols - charSize.width) * 100) / 100);
            lineHeight = Math.max(1, Math.min(this.LINE_HEIGHT_MAX,
                (box.height / terminal.rows) / charSize.height));
            lineHeight = Math.floor(lineHeight * 100) / 100;
        }
        this.applyTextMetrics(terminal, font, letterSpacing, lineHeight);
    },

    applyTextMetrics(terminal, font, letterSpacing, lineHeight) {
        if (font !== terminal.options.fontSize) {
            terminal.options.fontSize = font;
        }
        if (letterSpacing !== terminal.options.letterSpacing) {
            terminal.options.letterSpacing = letterSpacing;
        }
        if (lineHeight !== terminal.options.lineHeight) {
            terminal.options.lineHeight = lineHeight;
        }
    },


    /*
     * Fit every visible terminal of a session to its pane, then tell the
     * server.
     *
     * There is one grid decision left: the pane's own. A view is drawn by tmux
     * clipped to this client's size, so the local fit IS the truth -- no
     * authority to adopt, no mirrored grid to hold, and nothing to pan
     * horizontally, which is why the pannable viewport and the settled-proposal
     * watch went with the arbitration they existed for.
     *
     * The four calls before the fit are each a measured DOM correction and the
     * order matters: the scrollbar reservation (a vendored xterm 5.3.0 computes
     * it once at construction, so an overlay-scrollbar platform stands at a
     * phantom 15px), the char cell (a terminal opened inside a
     * `display: none` wrapper measured 0x0 and never retried), and the DOM
     * scroller (a terminal laid out again after a spell hidden is still
     * recorded against its zero-height box, which puts the whole history out of
     * reach). All three are read by the fit that follows.
     */
    fitTerminal(sessionId) {
        (this.sessionTerminals[sessionId] || []).forEach(key => {
            const terminal = this.terminals[key];
            const fitAddon = this.fitAddons[key];
            if (!terminal || !fitAddon || !this.isTerminalVisible(key)) {
                return;
            }
            try {
                /*
                 * Nothing to sync with the scroller: xterm 6 renders no
                 * `.xterm-scroll-area` and keeps `.xterm-viewport` at scrollTop 0
                 * The two xterm 5
                 * repairs that used to run here -- syncScrollBarWidth, which
                 * corrected the engine's phantom 15px scrollbar reservation, and
                 * resyncViewportScroller, which re-glued the DOM scroller to the
                 * buffer -- both depended on `_core.viewport`, which no longer
                 * exists, and were removed as dead code rather than left to read
                 * as live machinery.
                 */
                this.ensureCharCellMeasured(terminal);
                /*
                 * FitAddon.fit is proposeDimensions + terminal.resize in
                 * ONE call, so it cannot be told to hold the alternate rows.
                 * Split into its two halves so every resize goes through the
                 * guard: on a no-scrollback buffer xterm's own Buffer.resize
                 * runs lines.trimStart(delta) and DESTROYS rows off the top,
                 * which is the owner's "codex jumps to the top when the window
                 * changes size" (see resizeTerminalPreservingAltRows).
                 */
                const win = this.windowGeometry[sessionId];
                if (!win) {
                    // No shared window to present: the pane's own fit is
                    // rendered at the base metrics.
                    this.applyTextMetrics(terminal, this.getBaseFontSize(), 0, 1);
                }
                const fitted = this.proposeBaseFit(terminal);
                if (win) {
                    // Presentation is deferred while the box is still moving:
                    // see schedulePresent. The engine still takes the window's
                    // size on every pass, because that is the size the remote
                    // pane really is.
                    /*
                     * ENGINE == WINDOW == PTY. The server set this view's PTY
                     * to the window size, so that is exactly how many rows and
                     * columns tmux paints for this client: fewer and tmux
                     * addresses rows the engine does not have (which scrolls
                     * the content up), more and the surplus keeps tmux's
                     * `·` filler. The local fit is still what gets REPORTED --
                     * it is what moves the minimum -- but it is not what is
                     * rendered.
                     */
                    this.resizeTerminalPreservingAltRows(
                        terminal, win.cols, win.rows, true);
                } else if (fitted && fitted.cols > 0 && fitted.rows > 0) {
                    this.resizeTerminalPreservingAltRows(
                        terminal, fitted.cols, fitted.rows);
                }
            } catch (e) {
                console.error('Error fitting terminal:', e);
            }
        });
        // The grid change has landed, so re-assert the live edge for any
        // terminal of this session that was sitting on it when its box started
        // changing. Per terminal key: a pane that did not resize has no pending
        // capture and this declines for it.
        (this.sessionTerminals[sessionId] || []).forEach(key => {
            this.restoreLiveEdgeIntent(key);
        });
        this.schedulePresent(sessionId);
        this.scheduleProposal(sessionId);
    },

    /*
     * THE TEXT IS RE-ZOOMED WHEN THE BOX SETTLES, NOT ON EVERY FRAME.
     * ========================================================================
     * OWNER REPORT, desktop, on an oh-my-posh prompt: "van loi giat
     * man hinh nhay len xuong lien tuc khi thay doi kich thuoc".
     *
     * MEASURED (tests/browser/resize_burst_normal_buffer.mjs, before this):
     * shrinking a pane 8px at a time with the window geometry held produced
     * screen offsets 8, 0, 24, 16, 8, 0, 24, 16, 8, 0, -8 ... -- a sawtooth
     * with a 24px tooth. The cause is quantisation, not the anchor:
     * presentWindowGrid picks `font = floor(base * zoom)`, so every few pixels
     * of box the font steps by a whole pixel, the grid's height jumps by
     * roughly one pixel PER ROW, and the anchored content is yanked by that
     * whole amount. Twenty times a second, that is the jumping.
     *
     * Between two window geometries there is nothing to re-present: the grid
     * has the same rows and columns, and only the box around it is moving. So
     * the zoom and the anchor are recomputed once the box stops (or as soon as
     * a new geometry lands, via noteWindowGeometry), and in between the pane
     * shows a steady picture with a little slack instead of a dance. The
     * engine is still resized immediately whenever the window changes, so
     * nothing here delays what the remote pane actually is.
     */
    PRESENT_SETTLE_MS: 120,

    presentRequests: {},

    schedulePresent(sessionId) {
        if (this.presentRequests[sessionId]) {
            clearTimeout(this.presentRequests[sessionId]);
        }
        this.presentRequests[sessionId] = setTimeout(() => {
            delete this.presentRequests[sessionId];
            this.presentNow(sessionId);
        }, this.PRESENT_SETTLE_MS);
    },

    presentNow(sessionId) {
        (this.sessionTerminals[sessionId] || []).forEach(key => {
            const terminal = this.terminals[key];
            if (!terminal || !this.isTerminalVisible(key)) {
                return;
            }
            try {
                if (this.windowGeometry[sessionId]) {
                    this.presentWindowGrid(terminal);
                }
                // Re-split whatever the column floor (or the window) left
                // over, so the grid sits centred horizontally instead of hard
                // against the left edge, and anchored at the bottom.
                this.recentreTerminalScreen(terminal);
            } catch (e) {
                console.error('Error presenting terminal:', e);
            }
        });
    },

    cancelPendingPresent(sessionId) {
        if (this.presentRequests[sessionId]) {
            clearTimeout(this.presentRequests[sessionId]);
            delete this.presentRequests[sessionId];
        }
    },

    /*
     * ONE PROPOSAL PER GESTURE, NOT ONE PER FRAME.
     * ========================================================================
     * OWNER REPORT: "khi thay doi kich thuoc man hinh, mot so
     * connect dang chay nhu codex hoac omp bi nhay len xuong lien tuc mot luc
     * moi nhay ve dung vi tri ben duoi cung."
     *
     * Read from this file: the wrapper's ResizeObserver coalesces at 50ms, so
     * a drag produces about twenty fits a second. Each fit whose proposal
     * differs emits `ssh_resize`; the server answers every attached view with
     * `tmux_window_geometry`; noteWindowGeometry applies it and fits again.
     * Every one of those round trips is a real SIGWINCH, and a full-screen
     * TUI repaints its whole screen on each one -- that repaint IS the
     * bouncing. The end state was always right, which is why it "settles at
     * the bottom" the moment the drag stops.
     *
     * Presentation stays immediate: the engine is resized, the grid
     * re-presented and the screen re-centred on every frame, so the pane
     * never shows a stale box. Only the PROPOSAL waits for the gesture to
     * stop. A drag now costs one resize instead of twenty; a single resize
     * (a pane opening, a rotation settling) is delayed by this much and no
     * more.
     */
    PROPOSAL_SETTLE_MS: 150,

    proposalRequests: {},

    scheduleProposal(sessionId) {
        /*
         * LEADING AND TRAILING, not trailing alone.
         *
         * A trailing-only debounce made every size change wait the full settle
         * window before the server heard about it, and until the server
         * answers, the engine is still painting the OLD window -- including
         * whatever padding tmux last drew for it. Opening and closing the
         * browser's devtools is one big change in each direction, and the
         * owner saw exactly that: "terminal bi ve nhieu hang ........ phai 1
         * luc sau moi tu ve lai man hinh chuan".
         *
         * So the FIRST change of a burst goes out at once and the burst itself
         * is still collapsed into one more proposal at the end. A devtools
         * toggle costs one immediate round trip per direction; a drag costs two
         * in total rather than one per frame.
         */
        if (this.proposalRequests[sessionId]) {
            clearTimeout(this.proposalRequests[sessionId]);
        } else {
            this.reportLocalFit(sessionId);
        }
        this.proposalRequests[sessionId] = setTimeout(() => {
            delete this.proposalRequests[sessionId];
            this.reportLocalFit(sessionId);
        }, this.PROPOSAL_SETTLE_MS);
    },

    cancelPendingProposal(sessionId) {
        if (this.proposalRequests[sessionId]) {
            clearTimeout(this.proposalRequests[sessionId]);
            delete this.proposalRequests[sessionId];
        }
    },

    /*
     * The one coalesced fit OWNER. Programmatic "something changed, fit
     * this session" requests (pane activation, pane attach, layout reset) all
     * funnel here instead of each scheduling its own setTimeout(fit). Multiple
     * requests for the same session within the debounce window collapse into a
     * single fitTerminal, so a terminal is fit at most once per layout event
     * rather than once per caller. The ResizeObserver keeps its own per-key
     * debounce because it is a genuine resize observation, not a request; this
     * owns the request path.
     */
    fitRequests: {},

    requestFit(sessionId, delay = 50) {
        if (this.fitRequests[sessionId]) {
            clearTimeout(this.fitRequests[sessionId]);
        }
        this.fitRequests[sessionId] = setTimeout(() => {
            delete this.fitRequests[sessionId];
            this.fitTerminal(sessionId);
        }, delay);
    },

    cancelPendingFit(sessionId) {
        if (this.fitRequests[sessionId]) {
            clearTimeout(this.fitRequests[sessionId]);
            delete this.fitRequests[sessionId];
        }
    },

    getTerminalSize(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        const terminal = terminalKeys.length > 0 ? this.terminals[terminalKeys[0]] : null;
        if (terminal) {
            return {
                rows: terminal.rows,
                cols: terminal.cols
            };
        }
        return null;
    },

    // True when a foreground application (claude, vim, htop...) has taken over
    // the mouse with DECSET 1000/1002/1003, so a swipe belongs to that app rather
    // than to tmux.
    //
    // This is the browser-side twin of tmux's `mouse_any_flag`. tmux's default
    // wheel binding is
    //   if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" {send-keys -M} {copy-mode -e}
    // so when an app owns the mouse tmux forwards the wheel to it and NEVER
    // enters copy-mode. exit_tmux_copy_mode then correctly answers
    // pane_in_mode=0, and reporting that as the bare "not in scroll mode" read as
    // a broken button to the user, who was plainly scrolling — inside the app.
    // Measured on this xterm build: mouseTrackingMode is 'none' with no app,
    // 'vt200' after 1000h, 'drag' after 1002h (what claude sets) and 'any' after
    // 1003h, going back to 'none' when the app exits — exactly when tmux's flag
    // flips. So no server round-trip is needed to tell the two cases apart.
    //
    // terminal.modes needs xterm >= 4.x; guarded so a build without it simply
    // reports false and the caller keeps the old wording instead of throwing.
    /*
     * How many wheel-ups THIS client has sent into a full-screen application
     * that owns the mouse, and has not taken back.
     *
     * Claude Code, less and vim take the wheel themselves (DECSET 1000/1002/
     * 1003): tmux forwards it, never enters copy mode, and xterm's own
     * viewport does not move either -- on the alternate buffer there is no
     * scrollback to move. Both facts the Exit-scroll button reads were
     * therefore false for the whole life of such a pane, so the button never
     * appeared and, when it did, had nothing to act on (owner: * claude code"). What this client DOES know is what it sent. Every wheel
     * that reaches the terminal element -- a desktop wheel, or the discrete
     * wheels the touch gesture synthesises -- moves this counter, and the
     * button sends exactly that many wheel-downs back.
     */
    appScrollDepth: {},
    APP_SCROLL_MAX: 120,
    // How many MOUSE REPORTS the engine has emitted for a session. A count,
    // not a timestamp: the wheel listener compares the value it captured
    // before the event with the value after, which is exact whatever order
    // the two listeners were registered in.
    mouseReports: {},

    /*
     * ONLY A WHEEL THE ENGINE ENCODED AS A MOUSE REPORT IS COUNTED.
     *
     * With mouse tracking off on the alternate buffer xterm turns a wheel into
     * CURSOR KEYS, and a burst of those drives whatever the application has on
     * screen -- menus, selections, history. The first version of this counted
     * every wheel and replayed them blind, which is what froze the owner's
     * caller decides that by counting mouse reports across the event; see the
     * wheel listener in observeScrollState.
     */
    noteAppWheel(sessionId, deltaY) {
        if (!sessionId || !deltaY || !this.appOwnsMouse(sessionId)) {
            return false;
        }
        const depth = this.appScrollDepth[sessionId] || 0;
        this.appScrollDepth[sessionId] = deltaY < 0
            ? Math.min(depth + 1, this.APP_SCROLL_MAX)
            : Math.max(0, depth - 1);
        return this.appScrollDepth[sessionId] !== depth;
    },

    /*
     * Give the application back exactly the wheels it was sent.
     *
     * Every dispatch carries the CENTRE of the rendered screen: a WheelEvent
     * with no coordinates lands at (0, 0), which is outside the screen box, and
     * an engine that cannot place the pointer does not emit a mouse report --
     * it falls back to cursor keys. The burst stops the moment the engine stops
     * answering with mouse reports, or the application gives up the mouse.
     */
    returnAppScroll(sessionId) {
        const depth = this.appScrollDepth[sessionId] || 0;
        this.appScrollDepth[sessionId] = 0;
        const keys = this.sessionTerminals[sessionId] || [];
        const terminal = keys.length > 0 ? this.terminals[keys[0]] : null;
        const element = terminal && terminal.element;
        const screen = element && element.querySelector('.xterm-screen');
        if (!element || !screen || depth <= 0 || !this.appOwnsMouse(sessionId)) {
            return 0;
        }
        const box = screen.getBoundingClientRect();
        if (!(box.width > 0) || !(box.height > 0)) {
            return 0;
        }
        const clientX = Math.round(box.left + box.width / 2);
        const clientY = Math.round(box.top + box.height / 2);
        let sent = 0;
        for (let i = 0; i < Math.min(depth, this.APP_SCROLL_MAX); i += 1) {
            if (!this.appOwnsMouse(sessionId)) {
                break;
            }
            const before = this.mouseReports[sessionId] || 0;
            element.dispatchEvent(new WheelEvent('wheel', {
                deltaY: 1, deltaMode: 1, clientX, clientY,
                bubbles: true, cancelable: true,
            }));
            if ((this.mouseReports[sessionId] || 0) === before) {
                // The engine answered with something that is not a mouse
                // report: stop rather than drive the application's keys.
                break;
            }
            sent += 1;
        }
        return sent;
    },

    appOwnsMouse(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        const terminal = terminalKeys.length > 0 ? this.terminals[terminalKeys[0]] : null;
        const modes = terminal && terminal.modes;
        if (!modes || typeof modes.mouseTrackingMode !== 'string') {
            return false;
        }
        return modes.mouseTrackingMode !== 'none';
    },





    destroyTerminal(sessionId) {
        // A pending coalesced fit for a session being torn down must not
        // fire against a dead terminal, and neither must the proposal it
        // would otherwise have scheduled.
        this.cancelPendingFit(sessionId);
        this.cancelPendingProposal(sessionId);
        this.cancelPendingPresent(sessionId);
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        terminalKeys.forEach(key => {
            this.releaseFrozenPane(key);
            this.destroyTerminalKey(key, sessionId);
        });
        delete this.sessionTerminals[sessionId];
        delete this.transcripts[sessionId];
        delete this.transcriptSizes[sessionId];
        delete this.streamTail[sessionId];
        // A session destroyed mid-replay (user closed it while chunks were
        // still arriving) must not leave its replay window open forever.
        delete this.replayState[sessionId];
        /*
         * Drain session-scoped disposables unconditionally. Doing it only
         * inside destroyTerminalKey would leak them for sessions that
         * registered resources but never owned a terminal key (a restore
         * candidate, or a session whose terminal was already detached).
         * destroyTerminal is the one place every session teardown funnels
         * through, so this is where the drain belongs.
         */
        this.cleanupSessionDisposables(sessionId);
        delete this.terminalContainers[sessionId];
        delete this.reportedSizes[sessionId];
        /*
         * The view state goes WITHOUT a detach emit. The session is being torn
         * down, so the server is closing this socket's client for it anyway
         * (close_session closes every view first), and a detach for a session
         * that no longer exists would be answered with nothing. A new session
         * under the same id must start detached, with no history credit and no
         * retry already spent.
         */
        delete this.views[sessionId];
        delete this.viewHistoryDone[sessionId];
        delete this.viewAttachRetried[sessionId];
        delete this.pendingViewSizes[sessionId];
        delete this.windowGeometry[sessionId];
        if (this.viewAttachTimers[sessionId]) {
            clearTimeout(this.viewAttachTimers[sessionId]);
            delete this.viewAttachTimers[sessionId];
        }
    },

    /*
     * THE SCROLL-STATE OBSERVER. Formerly `setupScrollbar`, which
     * built a `.terminal-scrollbar` overlay with its own drag. That control was
     * RETIRED, and the measurements are why (owner defect KB1, "after a desktop
     * reload I cannot drag the history"; s35_p5_reload_lifecycle.mjs §5, log
     * /tmp/s35/p36_red4.log):
     *
     *   `.terminal-scrollbar` and `.terminal-scrollbar-thumb` had NO CSS
     *   anywhere in the project -- 0 matches across all six stylesheets -- yet
     *   this function built them on every attach and hung a drag on them. So
     *   every piece of geometry the drag arithmetic assumed was absent, and the
     *   control was broken three ways at once, measured on a real reloaded pane:
     *
     *     barRect {x:7, y:751, w:1412, h:30}   wrapper box y 91..751
     *     barPosition/thumbPosition "static"   thumbStyleTop "0px"
     *     barClientHeight 30 == thumbHeight 30 -> divisor 0 -> -Infinity
     *
     *   1. it laid out as a full-width 30px block BELOW the pane's visible box
     *      and was clipped away by `.terminal-wrapper { overflow: hidden }`, so
     *      the user could never see or grab it;
     *   2. the thumb was `position: static`, so `thumb.style.top` -- the only
     *      thing that positioned it -- was inert;
     *   3. its track measured the same 30px as its own thumb, so the divisor
     *      `trackHeight - thumbHeight` was exactly 0 and EVERY drag resolved to
     *      +/-Infinity and clamped to an endpoint. Not slow, not imprecise:
     *      impossible to position.
     *
     * Retiring it changes nothing the user can see, because the element was
     * already invisible; the scrollbar they do see and can grab is the engine's
     * own, styled at style.css:5773-5825 (measured gutter 10px). What this
     * function keeps is the ONE live effect the retired control carried:
     * `syncTerminalScrollState` had exactly one caller, inside the old
     * `updateScrollbar`, and it is the only path that ever turns the Exit-Scroll
     * control ON (`setScrollState(sid, true)` via !isTerminalAtBottom -- every
     * other caller only sets false). Dropping the interval with the DOM would
     * have taken that button with it.
     *
     * NOT renamed: `scrollbarCleanups`. It is the per-render cleanup identity
     * that destroyTerminalKey and a re-attach both key on, and its contents --
     * an interval plus two xterm disposables whose lifetime outlives this call
     * are exactly what it always held. Only the DOM and the drag are gone.
     */
    observeScrollState(terminal, terminalKey) {
        // A re-attach replaces the old lifecycle before installing a new one;
        // this also protects callers that reuse a terminal key directly.
        this.scrollbarCleanups[terminalKey]?.();
        delete this.scrollbarCleanups[terminalKey];

        const syncState = () => {
            this.syncTerminalScrollState(
                this.sessionIdForTerminalKey(terminalKey), terminal);
        };

        // Same three drivers the retired control used: xterm's own scroll and
        // resize events, plus a periodic sweep for output-driven changes that
        // raise neither (the old comment's "update periodically for
        // output-driven changes").
        const scrollDisposable = terminal.onScroll(() => syncState());
        const resizeDisposable = terminal.onResize(() => syncState());
        const intervalId = setInterval(syncState, 500);
        // Every wheel the application is given, real or synthesised by the
        // touch gesture, is dispatched on terminal.element (setupTouchGestures)
        // one listener sees both.
        /*
         * The engine's own wheel handler may be registered before or after
         * this one, so the count is compared across a task boundary rather
         * than read inline: one task later the bytes for THIS wheel are out,
         * and a wheel that produced no mouse report is not counted.
         */
        const onWheel = (event) => {
            const sessionId = this.sessionIdForTerminalKey(terminalKey);
            const deltaY = event.deltaY;
            if (!sessionId || !deltaY) {
                return;
            }
            const before = this.mouseReports[sessionId] || 0;
            setTimeout(() => {
                if ((this.mouseReports[sessionId] || 0) === before) {
                    return;
                }
                if (this.noteAppWheel(sessionId, deltaY)) {
                    syncState();
                }
            }, 0);
        };
        const element = terminal.element;
        element?.addEventListener('wheel', onWheel, { passive: true });

        this.scrollbarCleanups[terminalKey] = () => {
            clearInterval(intervalId);
            scrollDisposable?.dispose();
            resizeDisposable?.dispose();
            element?.removeEventListener('wheel', onWheel);
        };

        syncState();
    },

    destroyTerminalKey(terminalKey, sessionId) {
        const scrollbarCleanup = this.scrollbarCleanups[terminalKey];
        if (scrollbarCleanup) {
            scrollbarCleanup();
        }
        const touchController = this.touchScrollControllers[terminalKey];
        if (touchController) {
            touchController.abort();
        }
        const resizeObserver = this.resizeObservers[terminalKey];
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
        const terminal = this.terminals[terminalKey];
        if (terminal) {
            // Drop the ScrollOwner observers and this terminal's sgr flag
            // BEFORE dispose, so the handlers are released through their own
            // disposables rather than left to the terminal's teardown.
            this.ScrollOwner.detach(terminal);
            terminal.dispose();
        }
        delete this.terminals[terminalKey];
        delete this.fitAddons[terminalKey];
        delete this.searchAddons[terminalKey];
        delete this.searchResults[terminalKey];
        delete this.terminalReady[terminalKey];
        delete this.pendingOutput[terminalKey];
        delete this.touchScrollControllers[terminalKey];
        delete this.resizeObservers[terminalKey];
        delete this.scrollbarCleanups[terminalKey];
        // The live-edge capture is per terminal key too, and a key can be
        // reused by a re-attach -- a stale `pending` capture would then re-glue
        // a brand-new terminal on its first fit. The scroll observer that
        // maintains it is released here as well; it is bound to this terminal.
        this.liveEdgeDisposables[terminalKey]?.();
        delete this.liveEdgeDisposables[terminalKey];
        delete this.liveEdgeIntent[terminalKey];

        if (sessionId && this.sessionTerminals[sessionId]) {
            this.sessionTerminals[sessionId] = this.sessionTerminals[sessionId].filter(key => key !== terminalKey);
            if (this.sessionTerminals[sessionId].length === 0) {
                this.setScrollState(sessionId, false);
                delete this.scrollStateBySession[sessionId];
                delete this.appScrollDepth[sessionId];
                delete this.mouseReports[sessionId];
                // Session-scoped disposables are drained by destroyTerminal,
                // the single funnel every teardown passes through; draining here
                // as well would either double-run (if keys exist) or be skipped
                // entirely (if a session never owned a key). One owner.
            }
        }
    },

    clear(sessionId) {
        const terminal = this.terminals[sessionId];
        if (terminal) {
            terminal.clear();
        }
    },

    setupInputHandler(sessionId, callback) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        terminalKeys.forEach(key => {
            this.setupInputHandlerForTerminal(key, callback);
        });
    },

    setupInputHandlerForTerminal(terminalKey, callback) {
        const terminal = this.terminals[terminalKey];
        if (!terminal) {
            return;
        }
        // Kept so the composition rescue can send through the SAME route a
        // keystroke takes (the DA filter and the leave_scroll funnel), and so
        // it can tell what the engine has already delivered.
        this.inputCallbacks[terminalKey] = callback;
        // One wrapper per terminal: a second onData subscription would both
        // double-count what the engine delivered and write every byte twice.
        this.inputHandlerDisposables[terminalKey]?.dispose();
        this.inputHandlerDisposables[terminalKey] = terminal.onData((data) => {
            const rescue = this.compositionRescue[terminalKey];
            if (rescue) {
                rescue.delivered += data;
            }
            // An SGR (`\x1b[<`) or X10 (`\x1b[M`) mouse report: the engine
            // placed the pointer and encoded it. returnAppScroll replays only
            // what this proves the engine can encode -- see noteAppWheel.
            if (data.charCodeAt(0) === 0x1b && data.charCodeAt(1) === 0x5b
                    && (data.charCodeAt(2) === 0x3c || data.charCodeAt(2) === 0x4d)) {
                const owner = this.sessionIdForTerminalKey(terminalKey);
                if (owner) {
                    this.mouseReports[owner] = (this.mouseReports[owner] || 0) + 1;
                }
            }
            this.noteKeyboardDebug('onData', { data });
            callback(data);
        });
    },

    // terminalKey -> the onData subscription installed by setupInputHandler.
    inputHandlerDisposables: {},

    // terminalKey -> the session's input callback, set by setupInputHandler.
    inputCallbacks: {},
    // terminalKey -> { composing, delivered, lastValue, timer } for the input
    // rescue below, and the cleanup that makes installing it idempotent.
    compositionRescue: {},
    compositionRescueCleanups: {},
    /*
     * How long to wait after `compositionend` before deciding the engine is not
     * going to deliver. xterm finalises a composition on a `setTimeout(…, 0)`,
     * so one macrotask is already enough; 40 ms leaves room for a slow frame
     * without being perceptible.
     */
    COMPOSITION_RESCUE_MS: 40,

    /*
     * True on Safari (and any other WebKit that is not Chromium), where the
     * engine's own input delivery cannot be relied on.
     *
     * WHY THIS EXISTS. A standing report, still open after the views
     * rewrite: on Safari for macOS with Vietnamese Telex/VNI
     * class of key a Vietnamese IME does not compose, which locates the defect
     * exactly: the COMPOSITION path, not the key path.
     *
     * Measured headless (WebKit 26.5 and Chromium 149, probe): a
     * plain keystroke and a non-composed `insertText` both reach the wire on
     * both engines, so nothing in this app's own input path is at fault -- the
     * failure needs a real IME, which is why it only ever shows on the owner's
     * machine.
     *
     * What the vendored xterm 5.3.0 does with a composition (read from the
     * build): `compositionstart` records `textarea.value.length`;
     * `compositionend` schedules a `setTimeout(…, 0)` that slices
     * `textarea.value` from that mark and triggers the data event. Every step
     * therefore depends on the textarea still HOLDING the composed text one
     * macrotask after the composition ended, and on the start mark still being
     * right. That is the fragile part, and it is where engines differ.
     *
     * MEASURED ON THE OWNER'S SAFARI, (`?kbdebug=1`, Safari
     * 26.6.2 on macOS, Vietnamese input method, 42 events):
     *
     *   xterm.keydown            13   every letter: keyCode 229, isComposing false
     *   xterm.input insertReplacementText 10  -> onData  0
     *   xterm.input insertText             3  -> onData  3   (two spaces, one `a`)
     *   composition events                 0
     *
     * So there is NO COMPOSITION AT ALL. This input method rewrites the word
     * in the textarea with `insertReplacementText`, and xterm 5.3.0's input
     * handler acts on `insertText` only -- every other inputType is dropped on
     * the floor. That is the whole defect, exactly as the owner described it:
     * space and digits (real keys, and `insertText`) arrive, letters never do.
     * The textarea also grows without bound, because xterm clears it only on
     * the path it handles.
     *
     * So this does not try to repair xterm's arithmetic: it observes what the
     * engine ACTUALLY delivered and sends what is missing -- for a composition
     * (kept, since other engines do compose) and for an input event the engine
     * ignored. If the engine delivered, this does nothing at all.
     */
    engineNeedsCompositionRescue() {
        const ua = navigator.userAgent || '';
        return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    },

    setupCompositionRescue(terminal, sessionId, terminalKey) {
        const textarea = terminal && terminal.textarea;
        if (!textarea || !this.engineNeedsCompositionRescue()) {
            return;
        }
        /*
         * IDEMPOTENT, and that is load-bearing. attachTerminal runs again for
         * the same terminal on a re-attach, and each run used to install a
         * SECOND set of listeners with its own state -- two rescues for one
         * edit, so every character the engine did not deliver was sent twice.
         * (The map held only the newest state, which is why it looked like a
         * comparison bug.)
         */
        this.compositionRescueCleanups[terminalKey]?.();
        delete this.compositionRescueCleanups[terminalKey];
        const state = {
            composing: false,
            delivered: '',
            // What the textarea held the last time this agreed with the
            // terminal. Every later edit is sent as the difference.
            lastValue: textarea.value || '',
            timer: null,
        };
        this.compositionRescue[terminalKey] = state;

        const onStart = () => {
            state.composing = true;
            state.delivered = '';
            this.noteKeyboardDebug('compositionstart', {});
        };
        /*
         * What the ENGINE delivered counts only when it is TEXT. A terminal's
         * own replies -- the focus report tmux turns on (`\x1b[I`), an SGR
         * mouse report for the click that focused the terminal
         * (`\x1b[<0;12;40M`), a device-attributes answer (`\x1b[>0;276;0c`)
         * travel on the same channel and are not the user typing, and so
         * does the OSC colour answer (`\x1b]10;rgb:e6e6/eded/f3f3\x1b\\`)
         * Claude Code asks for every time the terminal gains focus. The CSI
         * parameter bytes are the whole 0x30-0x3F range and an OSC runs to
         * BEL or ST: the first version of this filter allowed only digits,
         * `;` and `?` and knew no OSC, so a mouse report or a colour answer
         * survived it, sat in `delivered`, and the first edit after a click
         * was judged "already handled" and dropped -- the owner's lost first
         * letter, once more (?kbdebug=1 log).
         */
        const typedOnly = (data) => data
            .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
            .replace(/\x1b[\]PX^_][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
            .replace(/\x1b./g, '');
        const onEnd = (event) => {
            state.composing = false;
            // `data` is the composed result; the textarea is the fallback for
            // engines that leave it there and report nothing.
            const text = (event && event.data) || textarea.value || '';
            this.noteKeyboardDebug('compositionend', { data: text });
            if (!text) {
                return;
            }
            setTimeout(() => {
                const delivered = typedOnly(state.delivered);
                state.delivered = '';
                let missing = null;
                if (delivered === '') {
                    missing = text;
                } else if (text.startsWith(delivered)) {
                    missing = text.slice(delivered.length);
                }
                if (missing === null) {
                    // The engine sent something this cannot account for.
                    // Sending anything now would duplicate or corrupt the
                    // line, so it is left alone and recorded instead.
                    console.warn('composition delivered unexpected data',
                        { text, delivered });
                    return;
                }
                if (missing === '') {
                    return;
                }
                const callback = this.inputCallbacks[terminalKey];
                if (typeof callback !== 'function') {
                    return;
                }
                this.noteKeyboardDebug('rescue', { data: missing });
                callback(missing);
                state.lastValue = '';
                // The engine's own deferred read has already happened by now;
                // clearing stops a late one from repeating what was just sent.
                textarea.value = '';
            }, this.COMPOSITION_RESCUE_MS);
        };

        /*
         * AN INPUT THE ENGINE IGNORED IS STILL THE USER TYPING.
         *
         * The textarea's value is the only honest record of what the input
         * method did, so the missing bytes are its DIFFERENCE since the last
         * time the two agreed: one DEL per character the edit removed from the
         * end, then whatever it added. That covers a plain append, the
         * whole-word rewrite this IME performs on every letter, and a
         * backspace, without needing to know which inputType produced it.
         *
         * Only an edit at the END is acted on. A change further back cannot be
         * expressed against a terminal line whose cursor is at the end, and a
         * wholesale replacement (xterm clearing the textarea on the path it
         * DOES handle) must not become a burst of DELs -- both cases resync
         * quietly instead.
         */
        const MAX_ERASE = 64;
        const reconcile = () => {
            state.timer = null;
            const value = textarea.value || '';
            const previous = state.lastValue;
            const delivered = state.delivered;
            state.delivered = '';
            state.lastValue = value;
            if (value === previous || state.composing) {
                return;
            }
            let prefix = 0;
            while (prefix < previous.length && prefix < value.length
                    && previous[prefix] === value[prefix]) {
                prefix += 1;
            }
            const removed = previous.length - prefix;
            const added = value.slice(prefix);
            if (removed > MAX_ERASE || (removed > 0 && value === '')) {
                // A reset, not an edit.
                return;
            }
            const bytes = '\x7f'.repeat(removed) + added;
            if (!bytes) {
                return;
            }
            /*
             * WHAT THE ENGINE ALREADY SENT FOR THIS EDIT.
             *
             * Only text counts: a terminal's own replies -- the focus report
             * tmux turns on (`\x1b[I`), a mouse report, a device-attributes
             * answer -- travel on the same channel and are not the user
             * typing. Before that filter the focus report emitted when the
             * terminal was clicked made the NEXT edit look already handled:
             *
             * And the comparison is against THIS edit's bytes, not merely
             * "did anything arrive": a real key (space, Enter, a digit) is
             * delivered by the engine on KEYDOWN, before `input` fires at all,
             * so a window that merely asks "was the record empty?" sends it a
             * second time -- the owner's doubled space,.
             */
            const engine = typedOnly(delivered);
            if (engine === bytes) {
                return;
            }
            if (engine !== '' && !bytes.startsWith(engine)) {
                // The engine sent something this cannot account for; sending
                // anything now would duplicate or corrupt the line.
                this.noteKeyboardDebug('rescue.skip', { data: bytes, engine });
                return;
            }
            const missing = engine === '' ? bytes : bytes.slice(engine.length);
            if (!missing) {
                return;
            }
            const callback = this.inputCallbacks[terminalKey];
            if (typeof callback !== 'function') {
                return;
            }
            this.noteKeyboardDebug('rescue.input', { data: missing, engine });
            callback(missing);
        };
        const onInput = (event) => {
            if (event && event.isComposing) {
                return;
            }
            /*
             * EVERY edit is reconciled, `insertText` included. The
             * doubled-space fix skipped `insertText` on the theory that it is
             * the engine's own path; it is not, reliably. xterm 6 handles an
             * `insertText` in its input listener only when the event is not
             * `composed` or no keydown was seen -- a real Safari keystroke is
             * both -- so the letter reaches the wire only if the IME wrote the
             * textarea before the keydown's setTimeout(0) read it. The first
             * letter of a word lands late (the same timing as the measured
             * in reconcile, which is exact: an edit the engine delivered
             * matches its own bytes and is not sent twice, an edit it did not
             * deliver is.
             */
            if (state.timer) {
                clearTimeout(state.timer);
            }
            // One tick after the burst: long enough for the engine's own
            // delivery to show up in `delivered`, short enough to feel typed.
            state.timer = setTimeout(reconcile, this.COMPOSITION_RESCUE_MS);
        };
        /*
         * xterm empties the textarea itself on blur and after Enter and
         * Ctrl+C, with no `input` event. A record left holding the old word
         * would turn the NEXT letter into "erase the old word, then the
         * letter" -- a burst of DELs into a line the user did not ask to
         * erase. The record follows the textarea on those edges; a pending
         * reconcile is dropped with it, since its baseline is gone.
         */
        const resync = () => {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.lastValue = textarea.value || '';
            state.delivered = '';
        };
        const onBlur = () => resync();
        /*
         * A key the ENGINE handles at keydown (keyCode is not 229: Backspace,
         * Enter, Tab, the arrows, a Ctrl chord) sends its bytes right there
         * and leaves the textarea alone -- no `input` event follows, so no
         * reconcile consumes those bytes from `delivered`. They sat there
         * until the next edit, which then looked "already handled" and was
         * dropped: in the owner's log a run of Backspaces put seven DELs in
         * engine has had its turn (one tick), a key that did not change the
         * textarea is consumed here. A printable key with a real keyCode (a
         * space, a digit) DOES change the textarea, and its `input` event's
         * reconcile finds the engine's byte equal to the edit -- those are
         * left alone.
         *
         * Backspace also shrinks the textarea by the character the engine
         * just erased from the line, so the text the IME sees as context
         * stays the text on the line. Only when the browser itself did not
         * edit the field (an IME mid-word Backspace does, and the reconcile
         * handles that one) and the engine really sent a DEL.
         */
        const onKeydown = (event) => {
            if (!event || event.keyCode === 229 || state.composing) {
                return;
            }
            const key = event.key || '';
            const printable = key.length === 1
                && !event.ctrlKey && !event.metaKey && !event.altKey;
            if (printable) {
                return;
            }
            setTimeout(() => {
                const value = textarea.value || '';
                if (key === 'Backspace' && value === state.lastValue
                        && value !== '' && state.delivered.includes('\x7f')) {
                    textarea.value = Array.from(value).slice(0, -1).join('');
                }
                resync();
            }, 0);
        };

        textarea.addEventListener('compositionstart', onStart, true);
        textarea.addEventListener('compositionend', onEnd, true);
        textarea.addEventListener('input', onInput, true);
        textarea.addEventListener('blur', onBlur, true);
        textarea.addEventListener('keydown', onKeydown, true);
        const cleanup = () => {
            textarea.removeEventListener('compositionstart', onStart, true);
            textarea.removeEventListener('compositionend', onEnd, true);
            textarea.removeEventListener('input', onInput, true);
            textarea.removeEventListener('blur', onBlur, true);
            textarea.removeEventListener('keydown', onKeydown, true);
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
        };
        this.compositionRescueCleanups[terminalKey] = cleanup;
        this.registerDisposable(sessionId, () => {
            cleanup();
            delete this.compositionRescueCleanups[terminalKey];
            delete this.compositionRescue[terminalKey];
            delete this.inputCallbacks[terminalKey];
        });
    },

    /*
     * `?kbdebug=1` — an on-screen keyboard log, for the one defect that cannot
     * be reproduced without the owner's own machine and IME.
     *
     * It paints nothing and costs nothing unless the query is present, and it
     * records only event SHAPES plus the bytes that were sent, which is what a
     * screenshot has to carry for the composition path to be diagnosable from
     * here.
     */
    /*
     * ONE LINE PER PAGE PER SESSION, to the server log.
     *
     * The owner reports a Claude Code pane that comes back BLANK after a
     * reload and paints only once they type. It has not reproduced here: a
     * live reload against their own session showed the alternate buffer with
     * 28 painted rows within 1.5s, and the trace had the history's
     * `\x1b[?1049l` landing BEFORE tmux's attach repaint, which is the order
     * that works. Rather than ask for another round of manual reporting, the
     * app now says what it ended up with two and a half seconds after its
     * FIRST attach of a page: the buffer it is showing, how many rows carry
     * text, and the grid. A blank pane will say `painted: 0`, and which
     * buffer it is on says whether the repaint was lost or hidden.
     */
    firstAttachReported: {},

    reportFirstAttach(sessionId) {
        if (this.firstAttachReported[sessionId]) {
            return;
        }
        this.firstAttachReported[sessionId] = true;
        setTimeout(() => {
            const key = (this.sessionTerminals[sessionId] || [])[0];
            const terminal = this.terminals[key];
            if (!terminal || !window.socket
                    || typeof window.socket.emit !== 'function') {
                return;
            }
            const buffer = terminal.buffer.active;
            let painted = 0;
            for (let y = 0; y < terminal.rows; y += 1) {
                const line = buffer.getLine(buffer.viewportY + y);
                if (line && line.translateToString(true).trim()) {
                    painted += 1;
                }
            }
            const win = this.windowGeometry[sessionId];
            window.socket.emit('kbdebug_log', {
                agent: navigator.userAgent.slice(0, 120),
                lines: [`attach-report session=${String(sessionId).slice(0, 8)}`
                    + ` buf=${buffer.type} painted=${painted}`
                    + ` grid=${terminal.cols}x${terminal.rows}`
                    + ` win=${win ? win.cols + 'x' + win.rows : 'none'}`
                    + ` baseY=${buffer.baseY} viewportY=${buffer.viewportY}`],
            });
        }, 2500);
    },

    /*
     * THE LAST 64 KB THE ENGINE WAS GIVEN, so a wrong screen can be replayed.
     *
     * Reported: the omp pane showed its prompt row fifty times while
     * `tmux capture-pane` on the host held it once. The host was clean, the
     * raw tmux client stream replayed clean into a bare engine, and the app's
     * own write path was clean when driven synchronously -- so whatever this
     * browser was handed at the moment it went wrong had never been seen. This
     * tail is that record: every string written to the engine (session output,
     * replayed history and the client's own screen declarations alike, in the
     * order they were written), bounded per session and released with the
     * terminal. sendScreenDiagnostic ships it with the engine's state, and the
     * server files both beside the pane as tmux holds it at that moment
     * (socket_events.handle_screen_diagnostic). Replaying the tail into a bare
     * engine against that pane is the whole reproduction.
     */
    STREAM_TAIL_MAX: 65536,

    /*
     * HOLD THE LAST GOOD FRAME WHILE A SHRINK WAITS FOR tmux.
     *
     * right, for a reason that is mechanical.
     *
     * Measured today, from three screen diagnostics and a bare engine:
     *   - every attached tmux client draws on the ALTERNATE buffer (tmux's own
     *     smcup at attach); all three dumps report buffer="alternate" while the
     *     pane's program was on the normal screen;
     *   - xterm's resize does NOT trim the alternate buffer's lines: lines 118
     *     cells wide were still 118 after resize(59, 20), where the same
     *     content on the normal buffer became 59. So after a shrink the pane
     *     renders the LEFT 59 COLUMNS OF THE OLD 118-COLUMN FRAME -- words cut
     *     mid-way, box drawing broken;
     *   - nothing overwrites those cells until something repaints. A
     *     full-screen TUI repaints itself on SIGWINCH within a frame or two,
     *     which is exactly why claude code looks clean; an idle shell prompt
     *     writes nothing, so the only repaint is this module's own
     *     `refresh-client`, ~700 ms away (250 ms coalesce + a 432-472 ms exec
     *     channel). That gap IS the jitter.
     *
     * So the pane is covered with a snapshot of its last good frame for the
     * length of the gap. The engine underneath resizes and is written to
     * exactly as before -- only the picture is held -- and the cover comes off
     * the moment tmux's repaint lands, which is detected for what it IS: no
     * row on screen is wider than the grid any more (staleWideRows). The
     * timeout is a belt, not the mechanism.
     *
     * The snapshot is a DOM clone (the renderer is the DOM one: measured, zero
     * canvases). The renderer's generated CSS is scoped by an owner class on
     * the terminal root, so the clone's copy of it is re-scoped to a class of
     * its own -- otherwise those stale rules would also match the live
     * terminal, which is the one thing a snapshot must not touch.
     */
    FREEZE_MAX_MS: 1200,
    _freezeSeq: 0,

    /*
     * THE APP'S OWN CHROME MUST NOT RESIZE THE REMOTE PANE.
     *
     * Measured: turning Broadcast on puts #sessionBar into the desktop flex
     * flow (style.css, the fine-pointer block) -- 52 px of real height, so the
     * terminal area goes 780 -> 728 and the fit proposes 45 rows where it
     * proposed 48. That proposal is the SHARED window: the server takes the
     * minimum over the views, tmux resizes the window, every attached device
     * repaints, and a prompt like omp redraws itself in front of the owner.
     * Turning Broadcast off does it all again in reverse. Two full redraws,
     * for a panel that belongs to one browser.
     *
     * So while our own chrome is holding space, the pane KEEPS its grid and
     * the text scales into the smaller box instead -- which is the app's rule
     * for every other size disagreement (presentWindowGrid: the tmux frame
     * fills the pane, the text is what gives). Nothing is proposed, so nothing
     * resizes, so nothing repaints -- and because `reportedSizes` is left
     * alone, closing the panel proposes the size the server already has and is
     * deduped there. The whole toggle costs zero frames on the wire.
     *
     * A GENUINE window resize while the panel is open is not chrome and must
     * still be reported: the held window size is the baseline, and a change to
     * it releases this pass and re-baselines.
     */
    holdChromeGrid(active) {
        if (!active) {
            this.chromeHold = null;
            return;
        }
        // Measured BEFORE the panel is in the flow -- the caller sets this in
        // the same synchronous block as the class change, and nothing can fit
        // in between, so these are the boxes without it.
        const boxes = new Map();
        Object.keys(this.terminals).forEach(key => {
            const terminal = this.terminals[key];
            if (!terminal || !this.isTerminalVisible(key)) {
                return;
            }
            const box = this.paneCellBox(terminal);
            if (box) {
                boxes.set(terminal, { width: box.width, height: box.height });
            }
        });
        this.chromeHold = { boxes, deltas: new Map() };
    },

    /*
     * How much of this pane our own chrome is holding, in pixels.
     *
     * Measured once per pane, the first time it is fitted after the hold: the
     * box it had before the panel, less the box it has now. From then on every
     * proposal is computed on the box PLUS that offset, so what the server is
     * told is the pane as it would be without our panel -- and since the size
     * is then unchanged, reportLocalFit's own dedupe drops it. A genuine
     * window resize moves the box underneath the same offset, so it is
     * reported at once, and closing the panel proposes the size the server
     * already has. There is nothing to un-hold.
     */
    chromeHeldOffset(terminal, box) {
        const held = this.chromeHold;
        if (!held) {
            return null;
        }
        if (!held.deltas.has(terminal)) {
            const before = held.boxes.get(terminal);
            if (!before) {
                return null;
            }
            held.deltas.set(terminal, {
                width: Math.max(0, before.width - box.width),
                height: Math.max(0, before.height - box.height),
            });
        }
        return held.deltas.get(terminal);
    },

    staleWideRows(terminal) {
        const buffer = terminal.buffer?.active;
        if (!buffer) {
            return 0;
        }
        let stale = 0;
        for (let y = 0; y < terminal.rows; y += 1) {
            const line = buffer.getLine(buffer.viewportY + y);
            if (line && line.translateToString(true).length > terminal.cols) {
                stale += 1;
            }
        }
        return stale;
    },

    freezePaneForShrink(terminalKey, terminal) {
        const screen = terminal.element
            && terminal.element.querySelector('.xterm-screen');
        if (!screen || this.frozenPanes[terminalKey]) {
            return;
        }
        const rect = screen.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
            return;
        }
        const owner = (terminal.element.className.match(
            /xterm-dom-renderer-owner-\d+/) || [])[0];
        const mine = `sshdeck-frozen-${this._freezeSeq += 1}`;
        const cover = document.createElement('div');
        cover.className = `xterm sshdeck-frozen-pane ${mine}`;
        cover.setAttribute('aria-hidden', 'true');
        cover.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none;'
            + `z-index:5;left:${rect.left}px;top:${rect.top}px;`
            + `width:${rect.width}px;height:${rect.height}px;`
            + `background:${getComputedStyle(terminal.element).backgroundColor}`;
        const copy = screen.cloneNode(true);
        copy.style.marginTop = '0px';
        if (owner) {
            copy.querySelectorAll('style').forEach(style => {
                style.textContent = style.textContent.split(owner).join(mine);
            });
        }
        cover.appendChild(copy);
        document.body.appendChild(cover);
        this.frozenPanes[terminalKey] = {
            cover,
            timer: setTimeout(
                () => this.releaseFrozenPane(terminalKey), this.FREEZE_MAX_MS),
        };
    },

    /*
     * What ends a freeze is a REPAINT, and it has to be recognised by its
     * size, not by the screen going clean.
     *
     * Measured while building this: the stale cells are never trimmed. A line
     * that is 118 cells wide under a 59-column grid stays 118 -- `\x1b[2K`
     * erases to the grid, writing touches the first 59 -- so "no row is wider
     * than the grid" is true only before the shrink and after the buffer is
     * replaced wholesale. As a release signal it never fires, and every freeze
     * would run to its timeout.
     *
     * A row's worth of bytes is the line: tmux's answer to a resize is a full
     * redraw, thousands of bytes; the only traffic smaller than one row is a
     * cursor move or a spinner tick, which repaints nothing and must not lift
     * the cover. The rAF puts the release AFTER the frame that drew those
     * bytes, so the fresh picture is on screen before the old one goes.
     */
    noteFrozenPaneWrite(terminalKey, data) {
        const terminal = this.terminals[terminalKey];
        if (!terminal || !data || data.length < terminal.cols) {
            return;
        }
        requestAnimationFrame(() => this.releaseFrozenPane(terminalKey));
    },

    releaseFrozenPane(terminalKey) {
        const frozen = this.frozenPanes[terminalKey];
        if (!frozen) {
            return;
        }
        delete this.frozenPanes[terminalKey];
        clearTimeout(frozen.timer);
        frozen.cover.remove();
    },

    recordStreamTail(sessionId, data) {
        if (typeof data !== 'string' || !data) {
            return;
        }
        const tail = (this.streamTail[sessionId] || '') + data;
        this.streamTail[sessionId] = tail.length > this.STREAM_TAIL_MAX
            ? tail.slice(-this.STREAM_TAIL_MAX) : tail;
    },

    // The engine's own account of the session: grid, buffer offsets, the
    // sizes it announced and was given, and the rows a person is looking at.
    screenDiagnosticReport(sessionId) {
        const tail = this.streamTail[sessionId] || '';
        const report = {
            tailChars: tail.length,
            view: String(this.views[sessionId] || ''),
            agent: navigator.userAgent.slice(0, 200),
        };
        const key = (this.sessionTerminals[sessionId] || [])[0];
        const terminal = this.terminals[key];
        if (!terminal) {
            return report;
        }
        const buffer = terminal.buffer.active;
        const screen = [];
        for (let y = 0; y < terminal.rows; y += 1) {
            const line = buffer.getLine(buffer.viewportY + y);
            screen.push(line ? line.translateToString(true) : '');
        }
        const win = this.windowGeometry[sessionId];
        const reported = this.reportedSizes[sessionId];
        return Object.assign(report, {
            cols: terminal.cols,
            rows: terminal.rows,
            buffer: buffer.type,
            baseY: buffer.baseY,
            viewportY: buffer.viewportY,
            cursorX: buffer.cursorX,
            cursorY: buffer.cursorY,
            fontSize: terminal.options.fontSize,
            letterSpacing: terminal.options.letterSpacing,
            lineHeight: terminal.options.lineHeight,
            unicode: terminal.unicode ? String(terminal.unicode.activeVersion) : '',
            window: win ? { cols: win.cols, rows: win.rows } : null,
            reported: reported ? { cols: reported.cols, rows: reported.rows } : null,
            screen,
        });
    },

    sendScreenDiagnostic(sessionId) {
        if (!sessionId || !window.socket || typeof window.socket.emit !== 'function') {
            return false;
        }
        window.socket.emit('screen_diagnostic', {
            session_id: sessionId,
            tail: this.streamTail[sessionId] || '',
            engine: this.screenDiagnosticReport(sessionId),
        });
        return true;
    },

    /*
     * The button that sends it, present only with `?kbdebug=1` -- the same
     * switch as the keyboard log, because both exist for a person reproducing
     * a defect on their own device and neither is a product control. It is its
     * own element: #kbdebugPanel is pointer-events:none by design (it must
     * never catch a tap meant for the terminal), so nothing in it can be
     * pressed. Created once, from createTerminal, so it exists exactly when
     * there is a session to report on.
     */
    ensureScreenDiagnosticButton() {
        if (!this.keyboardDebugEnabled()
                || document.getElementById('screenDiagnosticBtn')) {
            return;
        }
        const button = document.createElement('button');
        button.id = 'screenDiagnosticBtn';
        button.type = 'button';
        button.textContent = window.i18n
            ? i18n.t('diag.sendScreen') : 'Send screen diagnostic';
        button.style.cssText = 'position:fixed;right:8px;top:8px;z-index:100000;'
            + 'padding:6px 10px;font:12px/1.2 monospace;border:1px solid #7CFC9B;'
            + 'border-radius:6px;background:rgba(0,0,0,.82);color:#7CFC9B;'
            + 'cursor:pointer';
        button.addEventListener('click', () => {
            const sessionId = typeof SessionManager !== 'undefined'
                ? SessionManager.activeSessionId : null;
            const sent = this.sendScreenDiagnostic(sessionId);
            this.noteKeyboardDebug('diagnostic', {
                session: String(sessionId || '').slice(0, 8), sent,
            });
        });
        document.body.appendChild(button);
    },

    keyboardDebugEnabled() {
        if (this._kbdebug === undefined) {
            try {
                this._kbdebug = new URLSearchParams(location.search)
                    .get('kbdebug') === '1';
            } catch (e) {
                this._kbdebug = false;
            }
        }
        return this._kbdebug;
    },

    noteKeyboardDebug(type, detail) {
        if (!this.keyboardDebugEnabled()) {
            return;
        }
        let panel = document.getElementById('kbdebugPanel');
        if (!panel) {
            panel = document.createElement('pre');
            panel.id = 'kbdebugPanel';
            panel.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;'
                + 'max-height:22vh;width:100%;margin:0;overflow:auto;'
                + 'background:rgba(0,0,0,.82);color:#7CFC9B;font:11px/1.35 monospace;'
                + 'padding:6px;white-space:pre-wrap;pointer-events:none';
            document.body.appendChild(panel);
            this._kbdebugBind();
        }
        const hex = (detail && typeof detail.data === 'string')
            ? [...detail.data].map(c => c.codePointAt(0).toString(16)).join(' ')
            : '';
        const line = `${type} ${JSON.stringify(detail || {})}${hex ? ' | ' + hex : ''}`;
        panel.textContent = `${line}\n${panel.textContent}`.slice(0, 6000);
        /*
         * And to the SERVER's log. The defect this exists for lives on one
         * machine with one input method, so the round trip that matters is the
         * owner typing three letters and someone reading what the browser
         * actually reported -- without asking them to photograph a screen.
         * Batched, capped, and only while the query is present.
         */
        this._kbdebugQueue = this._kbdebugQueue || [];
        if (this._kbdebugQueue.length < 200) {
            this._kbdebugQueue.push(line);
        }
        if (!this._kbdebugFlush) {
            this._kbdebugFlush = setTimeout(() => {
                this._kbdebugFlush = null;
                const lines = this._kbdebugQueue.splice(0);
                if (!window.socket || typeof window.socket.emit !== 'function') {
                    return;
                }
                // The server takes 40 lines per message; a burst is sent whole.
                for (let at = 0; at < lines.length; at += 40) {
                    window.socket.emit('kbdebug_log', {
                        agent: navigator.userAgent.slice(0, 200),
                        lines: lines.slice(at, at + 40),
                    });
                }
            }, 800);
        }
    },

    _kbdebugBind() {
        if (this._kbdebugBound) {
            return;
        }
        this._kbdebugBound = true;
        const watch = (el, label) => {
            if (!el || el.dataset.kbdebugBound === '1') return;
            el.dataset.kbdebugBound = '1';
            ['keydown', 'beforeinput', 'input', 'compositionstart',
                'compositionupdate', 'compositionend'].forEach(type => {
                el.addEventListener(type, (e) => this.noteKeyboardDebug(
                    `${label}.${type}`, {
                        key: e.key, code: e.code, keyCode: e.keyCode,
                        isComposing: e.isComposing, inputType: e.inputType,
                        data: e.data, value: el.value,
                    }), true);
            });
        };
        watch(document.getElementById('mobileInput'), 'composer');
        document.querySelectorAll('.xterm-helper-textarea')
            .forEach(ta => watch(ta, 'xterm'));
        /*
         * The phone's keyboard, as the page sees it: the visual viewport, the
         * pinned --app-height, every scroll offset that could shift the shell,
         * and where the composer bar and the terminal area actually sit. The
         * reproduced headlessly; this is what will say which box moved.
         */
        const rect = (el) => {
            if (!el) return null;
            const q = el.getBoundingClientRect();
            return [Math.round(q.top), Math.round(q.bottom)];
        };
        const grid = () => {
            const sid = typeof SessionManager !== 'undefined' ? SessionManager.activeSessionId : null;
            const key = (this.sessionTerminals[sid] || [])[0];
            const t = this.terminals[key];
            if (!t || !t.element) return null;
            const screen = t.element.querySelector('.xterm-screen');
            const buffer = t.buffer.active;
            let painted = 0;
            for (let y = 0; y < t.rows; y++) {
                const line = buffer.getLine(buffer.viewportY + y);
                if (line && line.translateToString(true).trim()) painted += 1;
            }
            return {
                cols: t.cols, rows: t.rows, font: t.options.fontSize, painted,
                ls: t.options.letterSpacing, lh: t.options.lineHeight,
                baseY: buffer.baseY, viewportY: buffer.viewportY,
                buf: buffer.type, win: this.windowGeometry[sid] || null,
                pane: rect(t.element.parentElement), xterm: rect(t.element),
                screen: rect(screen), mt: screen ? screen.style.marginTop : '',
            };
        };
        const viewport = () => {
            const vv = window.visualViewport;
            const active = document.activeElement;
            return {
                grid: grid(),
                vvH: vv ? Math.round(vv.height) : null,
                vvTop: vv ? Math.round(vv.offsetTop) : null,
                pageTop: vv ? Math.round(vv.pageTop) : null,
                innerH: window.innerHeight,
                scrollY: Math.round(window.scrollY),
                htmlST: document.documentElement.scrollTop,
                bodyST: document.body.scrollTop,
                appH: document.documentElement.style.getPropertyValue('--app-height') || '',
                kb: document.body.classList.contains('keyboard-open'),
                bodyH: Math.round(document.body.getBoundingClientRect().height),
                bar: rect(document.getElementById('mobileInputBar')),
                term: rect(document.querySelector('.terminal-area')),
                active: active ? String(active.id || active.className).slice(0, 30) : '',
            };
        };
        const timers = {};
        const watchViewport = (target, type, label) => {
            if (!target) return;
            target.addEventListener(type, () => {
                clearTimeout(timers[label]);
                timers[label] = setTimeout(
                    () => this.noteKeyboardDebug(label, viewport()), 250);
            }, { passive: true });
        };
        watchViewport(window.visualViewport, 'resize', 'vv.resize');
        watchViewport(window.visualViewport, 'scroll', 'vv.scroll');
        watchViewport(window, 'scroll', 'window.scroll');
        watchViewport(document, 'focusin', 'focusin');
        watchViewport(document, 'sshdeck:terminal-resized', 'grid');
        this.noteKeyboardDebug('viewport', viewport());
        // Terminals built later get the same watchers.
        document.addEventListener('sshdeck:terminal-resized', () => {
            document.querySelectorAll('.xterm-helper-textarea')
                .forEach(ta => watch(ta, 'xterm'));
        });
    },

    fitAllTerminals() {
        Object.keys(this.sessionTerminals).forEach(sessionId => {
            this.fitTerminal(sessionId);
        });
    },

    applyThemeToTerminal(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        const theme = this.buildTheme();
        const font = this.getMonoFont();
        terminalKeys.forEach(key => {
            const terminal = this.terminals[key];
            if (!terminal) {
                return;
            }
            terminal.options.theme = theme;
            terminal.options.fontFamily = font;
            terminal.refresh(0, terminal.rows - 1);
        });
    },

    applyThemeToAll() {
        requestAnimationFrame(() => {
            Object.keys(this.sessionTerminals).forEach(sessionId => {
                this.applyThemeToTerminal(sessionId);
            });
        });
    },

    findNext(sessionId, searchTerm, options = {}) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0) return false;

        const searchAddon = this.searchAddons[terminalKeys[0]];
        if (!searchAddon) return false;

        return searchAddon.findNext(searchTerm, {
            caseSensitive: options.caseSensitive || false,
            wholeWord: options.wholeWord || false,
            regex: options.regex || false,
            incremental: options.incremental !== false,
            decorations: this.buildSearchDecorations()
        });
    },

    findPrevious(sessionId, searchTerm, options = {}) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0) return false;

        const searchAddon = this.searchAddons[terminalKeys[0]];
        if (!searchAddon) return false;

        return searchAddon.findPrevious(searchTerm, {
            caseSensitive: options.caseSensitive || false,
            wholeWord: options.wholeWord || false,
            regex: options.regex || false,
            decorations: this.buildSearchDecorations()
        });
    },

    /*
     * The addon fires onDidChangeResults ONLY when decorations are enabled, so
     * P4's match counter depends on passing this on every search call. The
     * Colours come from the same theme tokens buildTheme already reads, so the
     * highlights follow all 10 themes and no hex is introduced here; the
     * fallbacks match buildTheme's own.
     */
    buildSearchDecorations() {
        return {
            matchBackground: this.getCssVar('--term-yellow', '#e5c07b'),
            matchBorder: this.getCssVar('--term-yellow', '#e5c07b'),
            matchOverviewRuler: this.getCssVar('--term-yellow', '#e5c07b'),
            activeMatchBackground: this.getCssVar('--accent-primary', '#58a6ff'),
            activeMatchBorder: this.getCssVar('--accent-primary', '#58a6ff'),
            activeMatchColorOverviewRuler:
                this.getCssVar('--accent-primary', '#58a6ff'),
        };
    },

    clearSearch(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0) return;

        const searchAddon = this.searchAddons[terminalKeys[0]];
        if (searchAddon) {
            searchAddon.clearDecorations();
        }
        // The addon does not fire a final event on clear, so the cached count
        // would otherwise survive the close and reappear on the next open.
        if (this.searchResults[terminalKeys[0]]) {
            this.searchResults[terminalKeys[0]] = { resultIndex: -1, resultCount: 0 };
        }
    },

    hasSearchSupport() {
        return typeof SearchAddon !== 'undefined';
    },

    /*
     * The live match position for a session's terminal, as the addon last
     * reported it. resultIndex is 0-based and -1 when the addon's match
     * threshold is exceeded (its own documented sentinel), so the caller -- not
     * this method -- decides how to render an unknown position. Returns null
     * when the session has no terminal or the addon predates the event, which
     * is a different state from "zero matches" and must not collapse into it.
     */
    getSearchResults(sessionId) {
        const terminalKeys = this.sessionTerminals[sessionId] || [];
        if (terminalKeys.length === 0) return null;
        return this.searchResults[terminalKeys[0]] || null;
    },

    updateFontSize(newSize) {
        this.baseFontSize = newSize;
        Object.keys(this.terminals).forEach(key => {
            const terminal = this.terminals[key];
            if (terminal) {
                terminal.options.fontSize = newSize;
            }
        });
        // A font change alters each pane's local capacity, so it must
        // both re-render the authoritative grid (fitTerminal adopts authority)
        // and re-report the new proposal. fitTerminal owns both; drive it once
        // Per session rather than calling fitAddon.fit directly, which would
        // collapse an authoritative grid to the local fit and skip the report.
        const touchedSessions = new Set();
        Object.keys(this.sessionTerminals).forEach(sessionId => {
            const keys = this.sessionTerminals[sessionId] || [];
            if (keys.length > 0) {
                touchedSessions.add(sessionId);
            }
        });
        touchedSessions.forEach(sessionId => {
            this.fitTerminal(sessionId);
        });
    },

    handleOrientationChange() {
        const newFontSize = this.getResponsiveFontSize();
        this.updateFontSize(newFontSize);
        setTimeout(() => {
            this.fitAllTerminals();
        }, 100);
    }
};

window.TerminalManager = TerminalManager;

let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        TerminalManager.fitAllTerminals();
    }, 250);
});

window.addEventListener('orientationchange', () => {
    TerminalManager.handleOrientationChange();
});

if (window.visualViewport) {
    let viewportBaselineHeight = window.visualViewport.height;
    let viewportBaselineWidth = window.visualViewport.width;
    // The width BEFORE the last rotation: the other orientation's short side,
    // which is this orientation's best estimate of a keyboard-free height.
    let viewportPreviousWidth = window.visualViewport.width;
    let viewportOrientation = window.visualViewport.width > window.visualViewport.height
        ? 'landscape' : 'portrait';
    // What applyViewportVars last READ from width > height, which can lag
    // `viewportOrientation` by one event on a phone (see the rotation note).
    let viewportReadOrientation = viewportOrientation;
    let keyboardVisible = false;
    let orientationRebaseFrame = 0;

    /*
     * THE VISUAL VIEWPORT, NOT `window.inner*`.
     *
     * A phone delivers the visualViewport resize for a rotation BEFORE
     * `window.innerWidth`/`innerHeight` swap, so every reader of those two
     * saw the OLD orientation at the one moment that mattered (measured with
     * a lagged-inner probe,). The visual viewport is the thing
     * that just changed, so it is the thing to ask.
     */
    const currentViewportOrientation = () => {
        const vv = window.visualViewport;
        return vv.width > vv.height ? 'landscape' : 'portrait';
    };

    // Pin --app-height to the visual viewport ONLY while the soft keyboard is open.
    // Otherwise remove it so the shell falls back to 100svh (the *small* viewport,
    // which does NOT change as the iOS URL bar expands/collapses during a swipe).
    // This is the fix for the "frame shrinks to half screen after a few swipes" bug:
    // previously every URL-bar-driven visualViewport resize rewrote --app-height and
    // Collapsed the whole height chain. Writes only this one CSS var (no fit call),
    // so the per-terminal ResizeObserver stays the single fit source. Inert on
    // desktop/admin/auth (no consumer rule). The notepad sheet needs no JS geometry:
    // it is position:absolute;bottom:0 inside .workspace, which the app-shell height
    // already keeps above the keyboard. Returns whether the keyboard is open.
    // Desurgery: a soft keyboard needs a touch input surface. On a
    // fine-pointer desktop every visualViewport shrink is the WINDOW being
    // resized, and the 0.75 ratio read a 900 -> 600 window as "keyboard open"
    // (measured, /tmp/ds/shrink_content_probe.mjs: kb=true, --app-height
    // 600px, header hidden, and the alt-screen guard in the ResizeObserver then
    // refused every fit -- the owner's "frame stuck top-left after shrinking").
    const softKeyboardPossible = () =>
        typeof window.matchMedia !== 'function'
        || window.matchMedia('(pointer: coarse)').matches;

    const applyViewportVars = () => {
        const vv = window.visualViewport;
        /*
         * A ROTATION IS A WIDTH CHANGE. A soft keyboard never changes the
         * viewport's WIDTH, so a width that moved is proof the viewport
         * itself changed and the height baseline taken in the other
         * orientation is meaningless. Without this the ratio below compared a
         * 390px landscape height against an 844px portrait baseline, read
         * 0.46 as "keyboard open", hid the header and pinned --app-height --
         * and `scheduleOrientationRebase` then refused to run because it
         * declines while the keyboard is open. The shell stayed that way for
         * (reproduced at 390x844 and 428x926).
         *
         * The new orientation's CLOSED height is not knowable while a
         * keyboard covers it, but the previous orientation's WIDTH is a good
         * estimate of it -- the screen's short side either way -- so the
         * baseline is the larger of the two. Rotating with the keyboard down
         * then reads 1.0 (closed), rotating with it up reads the keyboard
         * ratio (open), and the 0.75 threshold absorbs the difference the
         * browser chrome makes between the two orientations.
         */
        if (Math.abs(vv.width - viewportBaselineWidth) > 1) {
            viewportPreviousWidth = viewportBaselineWidth;
            viewportBaselineWidth = vv.width;
            viewportBaselineHeight = Math.max(vv.height, viewportPreviousWidth);
        }
        /*
         * A ROTATION CAN ARRIVE IN TWO EVENTS, and the height is the late one.
         *
         * Reported: rotating the phone to landscape showed no header
         * at all, and rotating back to portrait left the header hidden until
         * the keyboard was opened and closed. Traced to a visualViewport
         * resize that carries the NEW width with the OLD height. Portrait to
         * landscape: 926x926 first, then 926x428 -- the swap above ran on the
         * first event and took max(926, 428) = 926 as the baseline, so the
         * second event read 428/926 = 0.46 as "keyboard open" and nothing
         * ever revised it (a landscape keyboard can never grow the height
         * past 0.75 of a portrait baseline). The other direction ran into the
         * rotation-while-keyboard-open branch that used to sit in the resize
         * listener, which only released on a keyboard cycle.
         *
         * The read orientation (width > height) is what flips on that second
         * event, so it is the signal: the baseline is re-derived from the
         * height that just arrived and the width the device had BEFORE the
         * rotation -- the same estimate the swap uses, taken again once the
         * height is in. A keyboard that shrinks a small phone below its own
         * width also flips the reading (iPhone SE: 375x223), and lands here
         * on max(223, 375) = 375, which still reads as open; closing it flips
         * back to max(559, 375) = 559, closed. Neither path can pin a lagged
         * height as a baseline, because the previous width floors both.
         */
        const read = currentViewportOrientation();
        if (read !== viewportReadOrientation) {
            viewportReadOrientation = read;
            viewportBaselineHeight = Math.max(vv.height, viewportPreviousWidth);
        }
        const kv = softKeyboardPossible()
            && (vv.height / viewportBaselineHeight) < 0.75;
        if (kv) {
            document.documentElement.style.setProperty('--app-height', vv.height + 'px');
        } else {
            document.documentElement.style.removeProperty('--app-height');   // -> 100svh
            /*
             * While the keyboard is CLOSED,
             * the baseline tracks the LARGEST measured height. A keyboard-open
             * page load pins the initial baseline to the shrunk height and no
             * open->close transition follows to rebase it (setKeyboardVisible
             * owns that edge), so the first close must be allowed to raise the
             * baseline to the real closed height. URL-bar growth is a closed
             * state and raises it correctly; URL-bar collapse never raises it;
             * the keyboard-open branch never runs this, so a shrunk height can
             * never poison the baseline.
             */
            viewportBaselineHeight = Math.max(viewportBaselineHeight, vv.height);
        }
        return kv;
    };

    // Undo the document scroll iOS performs to reveal the focused input.
    //
    // Measured on an iPhone 12 Pro Max (?debug=1 overlay): focusing the bottom
    // #mobileInput at 621..751 shrinks the viewport to 469, and iOS scrolls the
    // document up by exactly 751-469 = 282px to bring the field into view. We then
    // pin --app-height to 469 so html/body are the right height (the overlay
    // confirms htm=469 bod=469) — but that 282px scroll offset stays, because
    // html/body are overflow:hidden and iOS never clamps it back. So the 469-tall
    // shell paints from y=-282 (overlay: ws=-282..65, bar=65..187) and the bottom
    // 282px of the screen has nothing in it: the black gap, with the input bar
    // pushed up toward the middle of the screen.
    //
    // Once the shell is resized to fit above the keyboard, the input is visible at
    // scroll 0, so the scroll is not merely unnecessary — it is what creates the
    // gap. Reset it on both visualViewport events: iOS applies the scroll around
    // the resize and can re-apply it on subsequent scrolls (e.g. caret moves).
    // Not done via transform on the shell: that would create a new containing
    // block and break the page's position:fixed modals and overlays.
    const resetShellScroll = () => {
        const el = document.scrollingElement || document.documentElement;
        if (el && el.scrollTop !== 0) el.scrollTop = 0;
        if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
        resetHiddenShellScrollers();
    };

    /*
     * S20 item 5 — the SAME defect one level in: an overflow-hidden shell
     * container that the browser scrolled to reveal a focused field.
     *
     * The reasoning above ("a document scroll offset is never correct here")
     * applies verbatim to the shell's inner boxes, and they were missed. Measured
     * (/tmp/s16work/s20_item5_probe.out, round 9): focusing #sessionNotepad
     * scrolls #workspace to scrollTop 440 -- the browser's own
     * scroll-into-view -- which puts the terminal pane at top -352, i.e. 352px
     * above the visible area. #workspace is `overflow-y: hidden`, so there is no
     * scrollbar, no wheel and no gesture that can bring it back: the offset
     * survived blurring the notepad, focusing the composer, and two session
     * Switches. That is the user's "geometry wrong after switching connection",
     * and it is why it looked session-related -- the terminal was simply
     * off-screen from the moment Notes had been touched.
     *
     * Deliberately narrow:
     *   - scrollTOP only. `.terminal-wrapper` is `overflow-x: hidden` while JS
     *     drives its `scrollLeft` as the horizontal pan (O3/D-4'), so zeroing
     *     ScrollLeft here would destroy the pan the user confirmed working.
     *   - only containers whose computed `overflow-y` IS `hidden`. A real
     *     scroller (`.xterm-viewport`, where tmux history scrolling lives) is
     *     left completely alone -- an offset there is the user's position.
     *   - no timer, no observer: called from the same events resetShellScroll
     *     already answers, plus one capture listener for the inner-scroll event
     *     window-level `scroll` cannot see.
     */
    const HIDDEN_SHELL_SCROLLERS =
        '#deckWindow, .main-content, #workspace, .terminal-area,'
        + ' #terminalsContainer, #terminalGrid, .terminal-pane';

    const resetHiddenShellScrollers = () => {
        document.querySelectorAll(HIDDEN_SHELL_SCROLLERS).forEach(box => {
            if (box.scrollTop === 0) {
                return;
            }
            if (getComputedStyle(box).overflowY !== 'hidden') {
                return;
            }
            box.scrollTop = 0;
        });
    };

    // iOS may apply its scroll a frame after the resize, so reset again on the
    // next frame rather than only synchronously.
    const resetShellScrollSoon = () => {
        resetShellScroll();
        requestAnimationFrame(resetShellScroll);
    };

    const setKeyboardVisible = (visible) => {
        if (visible !== keyboardVisible) {
            keyboardVisible = visible;
            /*
             * Rebase the baseline on the
             * open -> CLOSED edge.
             *
             * viewportBaselineHeight was captured once at load and rebased
             * only on rotation, which assumed the load-time measurement was a
             * trustworthy keyboard-closed height. It is not: a reload (Back
             * from Settings disqualifies bfcache via the beforeunload
             * listener) or a PWA relaunch while the keyboard is up pins the
             * baseline to the SHRUNK height. Every later open then reads
             * vv.height / baseline ~= 1.0, stays under the 0.75 threshold's
             * wrong side, and neither --app-height nor body.keyboard-open is
             * applied -- so the keyboard slides over the terminal. That is the
             * regression the owner reproduced.
             *
             * The close edge is the one moment the visual viewport is
             * definitionally keyboard-free, so it is the only safe rebase
             * point. This does NOT make the shell follow the live viewport
             * (the round-14 rollback): --app-height is still
             * pinned only while the keyboard is open, and the iOS URL bar
             * never crosses the 0.75 threshold, so it can never trigger a
             * close edge and therefore never rebases anything.
             */
            if (!keyboardVisible) {
                viewportBaselineHeight = window.visualViewport.height;
            }
            document.body.classList.toggle('keyboard-open', keyboardVisible);
        }
        syncNotepadFocusedClass();
    };

    /*
     * S16 defect 1 — `notepad-focused` must never lag `keyboard-open`.
     *
     * The two classes are one contract: style.css:5018 hides `.notepad-panel`
     * whenever `keyboard-open` is present WITHOUT `notepad-focused`, and
     * `display:none` on a focused textarea DROPS the caret -- after which the
     * composer-first redirectors hand the keyboard, and the rest of the user's
     * note, to #mobileInput (measured:
     * tests/browser/s16_d1_notepad_focus_leak.mjs).
     *
     * Before this, the companion class was computed ONLY inside the
     * `visible !== keyboardVisible` edge above, so any recompute that did not
     * cross the edge left whatever the last edge decided -- including
     * "keyboard open, notes NOT focused" while the notes textarea held the
     * Caret. Recomputing on every applyKeyboardState removes the window
     * rather than trying to order the two writers. Reading
     * `document.activeElement` live is the point: the flag cannot drift from
     * the focus it describes.
     */
    function syncNotepadFocusedClass() {
        const active = document.activeElement;
        const panel = document.getElementById('notepadPanel');
        const notepadFocused = !!(active && (active.id === 'sessionNotepad'
            || (panel && panel.contains(active))));
        document.body.classList.toggle(
            'notepad-focused', keyboardVisible && notepadFocused);
    }

    const applyKeyboardState = () => {
        const kv = applyViewportVars();
        setKeyboardVisible(kv);
        return kv;
    };

    // An orientation baseline is accepted only while the PREVIOUS settled
    // state says the keyboard is closed. Taking vv.height immediately in the
    // resize event can promote a keyboard-shrunk height to the new baseline;
    // one animation frame lets the orientation layout and visual viewport
    // settle first. After rebasing, re-run the normal variable/class update and
    // the existing orientation fit lifecycle against the settled geometry.
    const scheduleOrientationRebase = () => {
        if (orientationRebaseFrame) return false;
        const next = currentViewportOrientation();
        if (next === viewportOrientation) return false;
        orientationRebaseFrame = requestAnimationFrame(() => {
            orientationRebaseFrame = 0;
            const settled = currentViewportOrientation();
            if (settled === viewportOrientation) return;
            viewportOrientation = settled;
            // The baselines belong to applyViewportVars, which re-takes them
            // the moment the width moves or the read orientation flips;
            // taking the height here as well would capture a keyboard-shrunk
            // height when a rotation happens with the keyboard up.
            applyKeyboardState();
            resetShellScrollSoon();
            TerminalManager.handleOrientationChange();
        });
        return true;
    };

    applyKeyboardState();

    // Reset UNCONDITIONALLY, not only while the keyboard is open.
    //
    // A document scroll offset is never correct here: the shell is html/body with
    // overflow:hidden and exactly viewport-tall, so scrollTop can only ever paint the
    // shell off the top of the screen and leave an empty band at the bottom. There is
    // no state — keyboard open, keyboard closed, function keypad up — in which a
    // non-zero offset is wanted, so there is nothing for a condition to protect.
    //
    // The old `if (keyboardOpenNow)` guard is what let the band come back: iOS also
    // scrolls the document on a plain drag/swipe over the shell (and after the
    // keyboard has closed again, and while the round-12 function keypad is up — the
    // keypad uses body.keypad-open + padding and never touches visualViewport, so
    // KeyboardOpenNow is false the whole time it is open). In all of those the guard
    // was false and the 282px offset measured on the device (see above) simply stayed.
    //
    // Costs nothing to over-call: resetShellScroll already no-ops when the offset is
    // already 0, and it touches only scroll position — never --app-height, so it
    // cannot feed back into the height chain the way round 14 did.
    window.visualViewport.addEventListener('scroll', resetShellScroll);

    // Also listen on the DOCUMENT's own scroll event, not just visualViewport's.
    // visualViewport fires only when the visual viewport itself moves or resizes; a
    // plain drag that scrolls the document while the URL bar stays put produces a
    // document scroll event and NO visualViewport event, so the two listeners above
    // would never run and the shell would stay pushed up — the band the device shows
    // when swiping with no keyboard involved. This is the direct signal for it.
    // Bound on window only. A capture listener on `document` would also fire for
    // every inner scroller — above all .xterm-viewport, which is how tmux history
    // scrolling works — and resetShellScroll must never interfere with those. The
    // window-level scroll event fires for the document scroller alone.
    window.addEventListener('scroll', resetShellScroll, { passive: true });

    /*
     * S20 item 5: the inner boxes need their OWN signal. A scroll of #workspace
     * does not reach the window-level listener above (scroll does not bubble),
     * and it is not a visualViewport event either -- the browser scrolled a
     * descendant, not the viewport. A CAPTURE listener on document is the one
     * place that sees it.
     *
     * The comment above rules out a capture listener because it would fire for
     * `.xterm-viewport`, and that objection is respected rather than overruled:
     * `resetHiddenShellScrollers` only ever touches boxes whose computed
     * overflow-y is `hidden`, and `.xterm-viewport` is a real scroller, so tmux
     * history scrolling is untouched. The handler is a class check plus at most
     * seven `scrollTop` reads, and returns immediately when nothing is offset.
     */
    document.addEventListener('scroll', resetHiddenShellScrollers,
        { passive: true, capture: true });

    window.visualViewport.addEventListener('resize', () => {
        resetShellScrollSoon();
        /*
         * No special case for a rotation while the keyboard is up. There used
         * to be one here -- keep the pin, remember the smallest height in the
         * new orientation, release only on a later same-orientation resize
         * 25% taller than it -- and it had no exit a phone ever takes: after
         * a lagged rotation read as "keyboard open" (see applyViewportVars),
         * the height it remembered was the full portrait height, so only a
         * real keyboard opening and closing could release the shell. That is
         *. The width-swap baseline in applyViewportVars already
         * answers the case the branch was for: rotating with the keyboard up
         * reads the new height against the previous width and stays open;
         * closing the keyboard in the new orientation reads closed.
         */
        if (scheduleOrientationRebase()) return;
        applyKeyboardState();

        // Toggling these classes changes the terminal wrapper's rendered size;
        // the per-terminal ResizeObserver re-fits from the real size, so we no
        // longer fit here (two fit sources would fight over rows/cols).
    });

    /*
     * BUG 4+5 fix:
     * the bfcache resync the shell never had.
     *
     * Leaving the terminal for another page (admin, change-password, a new
     * tab from the More sheet) and coming back via Back regularly restores
     * this page FROM THE BACK-FORWARD CACHE: the document and this JS heap
     * come back as-is, but the state this shell keeps in variables and
     * inline styles was measured for the MOMENT the page was left:
     *
     *   * --app-height may still carry the keyboard-shrunk value, so the
     *   * the document scroll offset may be non-zero, which on this shell is
     *     always wrong (resetShellScroll's own contract above);
     *   * no ResizeObserver fires, because nothing changed layout size, so
     *     the terminals keep their stale fit and history scroll is dead
     *
     * None of the visualViewport listeners above run on a plain restore, and
     * the codebase had NO pageshow handler at all (grep, including vendor).
     * e.persisted is the exact signal: it fires only for bfcache restores, so
     * first loads and ordinary reloads keep their existing initialisation.
     * The forced fitAllTerminals is deliberate here even though the resize
     * handler above leaves fitting to the ResizeObserver: after a restore the
     * observer has no size change to observe, so the refit must be asked for.
     */
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) {
            return;
        }
        applyKeyboardState();
        resetShellScrollSoon();
        // The bfcache restore the shell needs.
        // pagehide disconnected the HeaderMenus sessionBar observer; nothing
        // re-anchored it, so after a restore the dock-hide -> close contract
        // was dead. restoreObserver is a no-op when it is still live.
        window.HeaderMenus?.restoreObserver();
        // The socket may have cycled while the page was away (a socket.io
        // reconnect runs its own transport under a preserved document), and
        // the SERVER'S client-size registry is keyed by socket sid: entries
        // recorded under the old sid are gone, while reportedSizes here still
        // holds the last proposals. The dedupe would then suppress the
        // re-propose of an unchanged size, leaving this session invisible to
        // the resize authority until the window happens to change. Bumping the
        // epoch forces every next fit to re-propose; the server answers with
        // the authoritative grid, which adoptPtyAuthority then applies, so a
        // real geometry change from another client can never be masked by a
        // stale local fit.
        TerminalManager.resetSocketEpoch();
        TerminalManager.fitAllTerminals();
    });
}
