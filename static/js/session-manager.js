const SessionManager = {
    sessions: {},
    activeSessionId: null,
    // Lifecycle target for the connections-bar Rename/Reconnect/Reset controls.
    // Written ONLY through setLifecycleActionTarget, the sole writer of this
    // id, the chip's .lifecycle-target class, and control enablement, so those
    // states can never drift. Valid values: a key of this.sessions, or null.
    // Set only by explicit selection — chip tap (switchSession) or pane
    // activation (setActivePane); never by chip creation, so an asynchronously
    // arriving persistent candidate cannot steal it.
    lifecycleActionTargetId: null,
    // a connecting request is not a session, but it uses the same
    // selected-chip lifecycle surface. Kept separate so pending metadata can
    // never masquerade as a sendable SSH session record.
    lifecyclePendingTargetId: null,
    pendingConnections: {},
    layout: 1,
    /*
     * The second half of the layout identity (v5 lines 102-110). Two mockup
     * choices share a pane count -- 2 columns vs 2 rows, and 4 grid vs 4+primary
     * so `layout` alone cannot say which grid template is active. Valid
     * values: 'default' for every count, plus 'rows' (layout 2) and 'main'
     * (layout 4). Written only through setSplitLayout/applyPaneAssignments,
     * which are also the only writers of `layout`, so the pair cannot drift.
     */
    layoutVariant: 'default',
    paneAssignments: [],
    activePaneIndex: 0,
    /*
     * A pane keeps the session it was
     * given, and selecting a session that is in NO pane shows it full screen
     * WITHOUT touching the assignments. `soloSessionId` is that full-screen
     * session; while set, the grid is drawn as one pane holding it and the
     * split state underneath (layout, paneAssignments, activePaneIndex) is
     * untouched. Any pane activation or layout change clears it.
     */
    soloSessionId: null,
    // Session ids in the order the user arranged the chips (server-held,
    // item C). Ids not listed keep arrival order after the listed.
    tabOrder: [],
    tabDragging: false,
    // pane_index values already sent to the server, so a restore or a
    // no-op re-render never re-emits what the row already says.
    sentPaneIndex: {},
    // One-shot guard so a load applies the remembered session
    // selection at most once. Reset never needed within a document -- the
    // marker it gates is itself read-once per load.
    restoreSelectionApplied: false,

    init() {
        // ssh_session_restored / ssh_replay_chunk are owned solely by app.js
        // early listeners. Registering them here a second time double-dispatched
        // every post-init frame. Keep the other session-lifecycle sockets here.
        if (window.socket) {
            window.socket.on('persistent_session_available', (data) => {
                this.showPersistentSessionTab(data);
            });
            // Close could not kill the remote tmux: the row was kept and the
            // server re-offers it (persistent_session_available follows), so
            // only the reason needs saying here.
            window.socket.on('ssh_session_kept', (data) => {
                this.onSessionKept(data);
            });
            window.socket.on('tab_order', (data) => {
                this.tabOrder = Array.isArray(data && data.order) ? data.order.slice() : [];
                this.applyTabOrder();
            });
            window.socket.on('tmux_orphans', (data) => this.renderTmuxOrphans(data));
            window.socket.on('tmux_orphan_killed', (data) => this.onTmuxOrphanKilled(data));
            window.socket.on('tmux_orphans_error', (data) => this.onTmuxOrphansError(data));
            // W2 prepare-and-swap: the transport under a LIVE session was
            // replaced. Same logical session_id, same xterm, same pane — so
            // these listeners never create or destroy a session.
            window.socket.on('ssh_reconnected', (data) => {
                this.onReconnected(data);
            });
            window.socket.on('ssh_reconnect_failed', (data) => {
                this.onReconnectFailed(data);
            });
            /*
             * VIEWS. This socket asked for its own tmux client
             * (TerminalManager.attachView); these are the three answers.
             *
             * There is no geometry channel any more. `pty_geometry` and
             * `pty_source_changed` existed because one PTY was shared by every
             * device, so a size had to be negotiated and announced; a view is
             * this socket's OWN client, drawn by tmux clipped to this socket's
             * own size, so the only thing to know is whether the attach
             * succeeded.
             */
            window.socket.on('view_attached', (data) => {
                if (!data || !data.session_id) return;
                TerminalManager.noteViewAttached(data.session_id);
            });
            window.socket.on('view_closed', (data) => {
                if (!data || !data.session_id) return;
                TerminalManager.noteViewClosed(data.session_id, data.reason);
            });
            window.socket.on('view_error', (data) => {
                if (!data || !data.session_id) return;
                TerminalManager.noteViewError(data.session_id, data.error);
            });
            // The size the window is drawn at -- the minimum over every
            // device displaying the session. Arrives before the repaint.
            window.socket.on('tmux_window_geometry', (data) => {
                if (!data || !data.session_id) return;
                TerminalManager.noteWindowGeometry(
                    data.session_id, data.cols, data.rows);
            });
            // The answer to TerminalManager.sendScreenDiagnostic: the file's
            // name on the server, or the reason there is none.
            window.socket.on('screen_diagnostic_saved', (data) => {
                const info = data || {};
                const message = info.name
                    ? (window.i18n ? i18n.t('diag.saved')
                        : 'Screen diagnostic saved: {name}').replace('{name}', info.name)
                    : (window.i18n ? i18n.t('diag.failed')
                        : 'Screen diagnostic not saved ({error})')
                        .replace('{error}', info.error || 'unknown');
                window.showNotification(message, info.name ? 'success' : 'error');
            });
        }

        // Grid/layout MUST complete before initialized flips and before any
        // buffered restore/replay drains. Early app.js listeners keep buffering
        // until this.initialized is true, so a frame cannot race the grid.
        this.ensureTerminalGrid();
        // Restore the saved layout (clamped to this device's cap by
        // readLayoutPreference) rather than always starting at 1 pane. Falls
        // back to the single pane when nothing is stored or storage is blocked.
        const saved = this.readLayoutPreference();
        if (saved) {
            this.setSplitLayout(saved.layout, saved.variant);
        } else {
            this.setSplitLayout(1);
        }
        this.bindTabStripSwipe();
        this.bindLifecycleToolbar();
        window.addEventListener('languageChanged', () => {
            this.refreshEmptyPanes();
            // The chip's <small> is translated copy ("Đã ngắt" / "Disconnected"),
            // but it is written once at render time, so a language switch left every
            // disconnected chip in the previous language until its status next
            // changed. data-i18n cannot cover it -- the string is composed with the
            // username and latency -- so the chips are repainted explicitly.
            Object.keys(this.sessions).forEach(id => this.updateSessionLabel(id));
            Object.entries(this.pendingConnections).forEach(([id]) => {
                const state = document.querySelector(`#pending-${id} .tab-user-name`);
                if (state) {
                    state.textContent = window.i18n
                        ? i18n.t('status.connecting') : 'Connecting';
                }
            });
            // The lifecycle detail is composed too (endpoint + translated "via" +
            // tmux metadata), so rebuild it after i18n.updatePageText rather than
            // letting a stale data-i18n owner overwrite selected-target detail.
            this.renderLifecycleTarget();
        });
        const sessionBar = document.getElementById('sessionBar');
        if (sessionBar) {
            sessionBar.classList.remove('hidden');
        }

        // Atomically publish readiness, then drain each buffered frame once.
        this.initialized = true;
        if (Array.isArray(window.__earlyRestoreFrames) && window.__earlyRestoreFrames.length > 0) {
            const earlyRestores = window.__earlyRestoreFrames.splice(0);
            earlyRestores.forEach(data => this.restoreSession(data));
        }
        if (Array.isArray(window.__earlyReplayChunks) && window.__earlyReplayChunks.length > 0) {
            const earlyReplays = window.__earlyReplayChunks.splice(0);
            earlyReplays.forEach(data => {
                if (data && data.session_id) {
                    TerminalManager.acceptReplayChunk(data.session_id, data);
                }
            });
        }
        this.updateSessionMeta(null);
    },

    restoreSession(data) {
        const sessionId = data.session_id;

        console.log(`[RESTORE] Restoring SSH session: ${sessionId}`, data);

        if (this.sessions[sessionId]) {
            console.log(`[RESTORE] Session ${sessionId} already exists, skipping restore`);
            return;
        }

        /*
         * Learn the server's replay line cap BEFORE createSession
         * builds the terminal. The client's scrollback default is derived from
         * this number (TerminalManager.SCROLLBACK_DEFAULT), and the terminal that
         * is about to be created is the one that has to hold the replay the same
         * snapshot is announcing -- so learning it afterwards would be too late
         * for exactly the session that needs it.
         */
        TerminalManager.noteServerReplayLines(data.replay_max_lines);

        /*
         * W1 SessionSnapshot v1: every field the server sends is carried into
         * sessionData. The previous version dropped use_tmux, tmux_session_name
         * and key_id, so a restored tmux session forgot it was tmux and a
         * restored key session could only reconnect through the password
         * modal. createSession reads exactly these names, so nothing is lost
         * from here on.
         */
        const sessionData = {
            session_id: sessionId,
            host: data.host,
            port: data.port,
            username: data.username,
            auth_type: data.auth_type,
            via_jump: data.via_jump,
            display_name: data.display_name,
            use_tmux: data.use_tmux || false,
            tmux_session_name: data.tmux_session_name || null,
            key_id: data.key_id || null,
            // A restored snapshot carries the last measured locale
            // state; null on rows measured before this field existed.
            legacy_tmux_locale: data.legacy_tmux_locale ?? null
        };

        const restoredId = this.createSession(sessionData);
        console.log(`[RESTORE] Session UI created for ${sessionId}`);

        /*
         * A LIVE snapshot is another device's news, not this page's restore:
         * the session was just opened on one of the user's other sockets.
         * It joins the session list and nothing else -- no pane, no
         * activation, no replay -- so the device that is being worked on
         * keeps its screen. The one exception is a reconnect claim that
         * retired a saved row THIS page still offers: that stale chip is
         * replaced in place, transcript and pane included, because the offer
         * it made can no longer be honoured (the row is gone) and the live
         * session is what it turned into.
         */
        if (data.live === true) {
            const replaced = data.replaces_session_id;
            if (replaced && replaced !== sessionId && this.sessions[replaced]) {
                const paneIndex = this.paneAssignments.indexOf(replaced);
                if (typeof TerminalManager.adoptTranscript === 'function') {
                    TerminalManager.adoptTranscript(replaced, restoredId);
                }
                this.removeSessionUI(replaced);
                if (paneIndex !== -1) {
                    this.assignSessionToPane(restoredId, paneIndex, {
                        declareInteraction: false,
                        displaceOccupant: false,
                    });
                }
            }
            this.startLatencyPolling();
            return;
        }

        /*
         * Pane placement: honour the persisted pane_index when it is free,
         * otherwise fall back to the first empty pane, otherwise the active
         * one. The persisted index keeps a reload from reshuffling the user's
         * split layout; it is a preference, never a hard constraint.
         */
        /*
         * Pane placement: a restored session goes
         * back to the pane its row remembers when that pane is free, and
         * NOWHERE otherwise. It stays a tab; selecting it shows it solo. The
         * old "first empty pane, else the active pane" fallback is what made
         * assignments drift on every reload.
         */
        const persistedPane = data.pane_index;
        this.sentPaneIndex[restoredId] = Number.isInteger(persistedPane) ? persistedPane : null;
        if (Number.isInteger(persistedPane) && persistedPane >= 0
            && persistedPane < this.paneAssignments.length
            && !this.paneAssignments[persistedPane]) {
            this.assignSessionToPane(restoredId, persistedPane, {
                // A restore is not interaction. See assignSessionToPane.
                declareInteraction: false,
                displaceOccupant: false,
            });
        } else if (!this.soloSessionId && !this.paneAssignments.some(Boolean)
            && this.sessions[restoredId] && this.sessions[restoredId].connected
            && this.getFirstEmptyPaneIndex() !== -1) {
            // Nothing on screen yet (a first load after the upgrade, or no
            // remembered panes at all): the first live session takes the
            // first pane so the workspace is never blank, and that becomes
            // its remembered pane from here on. Exactly one session per load
            // can land this way; every later one waits for an explicit act.
            this.assignSessionToPane(restoredId, this.getFirstEmptyPaneIndex(), {
                declareInteraction: false,
                displaceOccupant: false,
            });
        }

        /*
         * Remember WHICH session this device was working in, and
         * make the restore END there rather than on the last row the server
         * sent.
         *
         * The remembered id is read from the same localStorage key a
         * deliberate selection wrote before the page went away. It is applied
         * only when the marker's OWN snapshot has arrived -- earlier frames
         * cannot select it yet, because the session does not exist client-side
         * and D1 above left every earlier restore politely parked.
         *
         * The apply is assignSessionToPane + setActivePane with
         * declareInteraction:false, NOT switchSession. Two reasons, both
         * rulings that already exist:
         *
         *   - the (see assignSessionToPane above): a page rebuilding
         *     itself from a snapshot has NOT been worked in, and must not take
         *     the shared PTY grid from the device somebody is actually using.
         *     switchSession's activation declares interaction; a reload's
         *     remembered selection is the same "not the user turning to a
         *     pane" case a restore already is, so it takes the pane WITHOUT
         *     the grid claim. The first real tap/keystroke on this device
         *     claims the grid exactly as it always did.
         *
         *   - W4 ownership: assignSessionToPane/setActivePane are the sole
         *     writers of pane assignment and displayed selection. Calling them
         *     directly is the same route switchSession itself takes for an
         *     unassigned session, minus the gesture-only extras (sheet opening
         *     for dead chips, focus juggling) that a load should not perform.
         *
         * The eviction this apply performs IS legitimate -- unlike D1's, the
         * occupant it displaces is the session the SERVER's order happened to
         * park there, not one the user chose -- and it is what puts the
         * remembered session back in front of the user.
         *
         * setTimeout(0) keeps the move OUT of this synchronous restore pass:
         * assignSessionToPane reads pane state this function is still writing,
         * and the marker's replay window has just been opened below -- moving
         * inside the same tick would re-enter renderPane before the snapshot's
         * own assignment finished.
         */
        const remembered = this.readActiveSessionPreference();
        if (remembered && remembered === sessionId
            && !this.restoreSelectionApplied) {
            this.restoreSelectionApplied = true;
            setTimeout(() => {
                if (this.sessions[sessionId]
                    && this.sessions[sessionId].connected) {
                    const paneIndex = this.paneAssignments.indexOf(sessionId);
                    if (paneIndex !== -1) {
                        this.setActivePane(paneIndex, { declareInteraction: false });
                    } else {
                        this.setSolo(sessionId, { declareInteraction: false });
                    }
                }
            }, 0);
        }

        /*
         * W3 ordering contract: the buffered output is a GAP-FILLER for the
         * bytes emitted between the last client frame and this restore, NOT the
         * terminal history (tmux owns that and repaints it on reattach).
         *
         * The window is opened here, synchronously with the snapshot, so live
         * ssh_output for this session is queued from this instant rather than
         * racing the replay. The previous code passed the whole buffer on a
         * setTimeout and hoped it won that race; when it lost, replayed history
         * landed after newer output or interleaved mid-escape-sequence.
         *
         * Two shapes are accepted so the client does not depend on which server
         * it is talking to: sequenced ssh_replay_chunk events (current), or an
         * inline buffered_output blob (older payloads). Both route through the
         * same sequenced writer in TerminalManager.
         */
        /*
         * ZERO chunks opens nothing, exactly as app.js:1067-1068 states
         * for the connect path -- "Zero chunks (a plain SSH session, or a fresh
         * tmux pane with nothing above its screen) opens nothing at all."
         *
         * This call used to run for `replay_total_chunks === 0` too, and a window
         * opened with nothing to replay can only be closed from the far end. The
         * server does send the explicit empty terminator that closes it
         * (socket_events.py:587-599), so the shipped behaviour was correct -- but
         * only for as long as that frame is never lost, raced or dropped by a
         * future caller of `ssh_session_restored`. While the window is open,
         * writeOutput queues EVERY live frame (terminal-manager.js:3132-3136), so
         * the cost of losing that one terminator is a permanently blank terminal
         * rather than a missing scrollback.
         *
         * Opening no window when there is nothing to replay removes the
         * dependency entirely: the terminator still arrives and still closes a
         * window if one exists, and a zero-chunk restore now paints live output
         * with no remote frame needed. Measured both ways in
         * /tmp/s35/p30_zero_chunk_replay_gate.mjs.
         */
        if (Number.isInteger(data.replay_total_chunks)
            && data.replay_total_chunks > 0) {
            TerminalManager.beginReplay(sessionId, data.replay_total_chunks);
        } else if (data.buffered_output) {
            TerminalManager.queueReplay(sessionId, data.buffered_output);
        }

        /*
         * A RESTORED session needs the latency poll exactly as much as a
         * freshly connected one — its chip renders "user · NN ms" on a fine
         * pointer from the same `latencyMs` field.
         *
         * The poll used to have ONE caller: app.js's `ssh_connected` handler.
         * A reload delivers `ssh_session_restored` and no `ssh_connected` at
         * all, so every restored session sat at `latencyMs === null` and its
         * chip showed a bare username indefinitely — while an otherwise
         * identical fresh session next to it showed a figure. Worse, the poll
         * probes ALL connected sessions once started, so a restored session
         * only began being measured if the user happened to open a NEW
         * connection later, which made the bug look intermittent.
         *
         * startLatencyPolling is idempotent (it returns early when the timer
         * exists), so calling it per restored session is safe: eight restored
         * sessions still produce one 15 s timer. stopLatencyPolling in
         * removeSessionUI remains the sole owner of teardown.
         */
        this.startLatencyPolling();

        console.log(`[RESTORE] Session ${sessionId} fully restored - waiting for output`);
    },

    showPersistentSessionTab(data) {
        const {
            session_id, host, port, username, key_id, auth_type,
            tmux_session_name, display_name
        } = data;

        /*
         * AN OFFER ABOUT A SESSION WE ALREADY HOLD IS NEWS, NOT A NO-OP.
         *
         * `persistent_session_available` is the server saying "the tmux session
         * on the remote host survived, but THIS server process has no channel to
         * it -- reconnect if you want it". restore_user_sessions only reaches
         * that emit through its else branch, which has just set
         * `db_session.connected = False` (socket_events.py:617-627): an app or
         * container restart empties the in-memory ssh_manager while the sqlite
         * rows still read connected, so every surviving row is re-offered this
         * way and NO ssh_session_restored and NO ssh_replay_chunk is emitted for
         * it at all.
         *
         * Returning here whenever a record exists dropped exactly the case that
         * matters. On a socket reconnect under a PRESERVED document the record
         * from before the restart is still present and still `connected: true`,
         * so the tab kept its connected paint over a channel that no longer
         * exists -- measured on production 05:30:31, where two
         * `Persistent tmux session available for reconnect` events were the only
         * frames sent and the owner's screenshot shows both tabs green with empty
         * buffers and the caret at the origin.
         *
         * So an existing record is TRANSITIONED to the candidate state the branch
         * below would have built, using the same three statements it uses, rather
         * than rebuilt: the terminal and its pane are deliberately left in place
         * so the user-driven Reconnect path still has something to reattach to.
         * A record that already describes a candidate is genuinely nothing new.
         */
        const existing = this.sessions[session_id];
        if (existing) {
            if (existing.connected || !existing.isPersistentCandidate) {
                existing.connected = false;
                existing.isPersistentCandidate = true;
                existing.useTmux = !!tmux_session_name;
                existing.tmuxSessionName = tmux_session_name || null;
                this.updateSessionStatus(session_id, 'disconnected');
                this.renderReconnectList();
            }
            // Auto-restore, narrowed. See maybeAutoRestore for why this may not
            // fire for every candidate: the blanket version armed an intent per
            // arriving offer and starved the user's own Reconnect.
            if (existing.isPersistentCandidate) {
                this.maybeAutoRestore(session_id, auth_type);
            }
            return;
        }

        const terminalId = `terminal-${session_id}`;
        const terminalContainer = document.createElement('div');
        terminalContainer.id = terminalId;
        terminalContainer.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(terminalContainer);

        const sessionBar = document.getElementById('sessionBar');
        if (sessionBar) {
            sessionBar.classList.remove('hidden');
        }

        this.sessions[session_id] = {
            id: session_id,
            host,
            port,
            username,
            connected: false,
            terminalId,
            os: 'all',
            displayName: display_name || null,
            viaJump: null,
            /*
             * useTmux mirrors the tmux IDENTITY the row actually carries, not the
             * fact that a candidate was offered.
             *
             * It was hardcoded true, and a persisted row can legitimately arrive
             * with `is_persistent = 1` and `tmux_session_name = NULL`. That
             * combination produced a candidate claiming tmux with no name to
             * reattach, and its Reconnect emitted `use_tmux: true,
             * reconnect_tmux_name: null` -- which the server reads as "create a
             * NEW tmux session". The action labelled Reconnect silently did what
             * Reset does.
             *
             * The reconnect routes refuse such a candidate outright
             * (refuseReconnectWithoutTmuxIdentity); this makes the record itself
             * honest so nothing downstream infers tmux from a bare flag.
             */
            useTmux: !!tmux_session_name,
            tmuxSessionName: tmux_session_name || null,
            isPersistentCandidate: true,
            keyId: key_id,
            authType: auth_type || 'password'
        };

        // The server supplied all credentials needed for key/Tailscale
        // candidates, so the exact tmux transport CAN be restored without asking.
        // Whether it SHOULD be is maybeAutoRestore's decision, not this one.
        this.maybeAutoRestore(session_id, auth_type);

        // Save display name to localStorage by host:port:user key
        if (display_name) {
            try {
                const stored = JSON.parse(localStorage.getItem('sessionDisplayNames') || '{}');
                const hostKey = `${host}:${port}:${username}`;
                stored[hostKey] = display_name;
                localStorage.setItem('sessionDisplayNames', JSON.stringify(stored));
            } catch (e) {}
        }

        this.createSessionTab(session_id, host, username);
        this.updateSessionStatus(session_id, 'disconnected');

        // Deliberately NOT assigned to a pane. A candidate is an offer, not a
        // session: putting it in a pane made every arrival evict the previous
        // one (assignSessionToPane parks the current holder and takes over), and
        // on a phone -- layout 1, so one pane -- that meant only the last of N
        // candidates stayed visible. The list below holds all of them instead.
        this.renderReconnectList();

        console.log(`[PERSISTENT] Offering tmux session: ${host}:${port} (${session_id})`);
    },

    // Every reconnectable candidate, as one vertical list in the empty pane.
    // Rebuilt from this.sessions on each change rather than appended to, so the
    // list cannot drift out of step with the sessions it describes.
    /*
     * REMOVED SURFACE.
     *
     * This used to inject a heavy "Persistent session" overview -- a titled list
     * of reconnect candidates with their own Reconnect buttons -- into the first
     * empty pane after a server restart or whenever no session was active. The
     * owner rejected it: the session bar ALREADY is the connection list, so this
     * was a second competing list of the same connections that appeared on
     * startup and then mostly vanished after any chip click. Connection discovery
     * and actions now come from the chips and their one-click action menus
     * (defect 5), which is one consistent route instead of two.
     *
     * Kept as a no-op that only tears down a previously rendered list, because:
     *  - callers (session restore at :176, pane refresh at :914) legitimately
     *    fire on candidate changes and should not each learn this surface is gone;
     *  - candidates themselves are NOT touched. They stay in this.sessions, keep
     *    their chips, and stay reconnectable -- no saved connection is deleted.
     * The pane falls back to its ordinary neutral empty state via
     * RefreshEmptyPanes.
     */
    renderReconnectList() {
        const existing = document.querySelector('[data-reconnect-list]');
        if (existing) {
            existing.remove();
            this.refreshEmptyPanes();
        }
    },

    createSession(sessionData, pending) {
        const { session_id, host, port, username, display_name } = sessionData;

        const terminalId = `terminal-${session_id}`;
        const terminalContainer = document.createElement('div');
        terminalContainer.id = terminalId;
        terminalContainer.className = 'terminal-wrapper unassigned';
        document.getElementById('terminalsContainer').appendChild(terminalContainer);

        TerminalManager.createTerminal(session_id);
        TerminalManager.attachTerminal(session_id, terminalId);
        TerminalManager.setupInputHandler(session_id, (data) => {
            if (window.socket) {
                // Filter out Device Attributes responses (ESC[c sequences only).
                // Bare-pattern regexes were removed because they corrupt legitimate input.
                data = data.replace(/\x1b\[[?>]?[0-9;]*c/g, '');
                if (data) {
                    /*
                     * The completion: xterm's own onData is the MOST used
                     * write path -- every character typed directly into the
                     * terminal -- and it was bypassing the funnel. A desktop
                     * wheel scroll with tmux `mouse on` enters copy mode exactly
                     * as a touch swipe does, and tmux then DISCARDS every byte
                     * written to the attached client's channel (measured), so
                     * typing into the terminal after scrolling back was silently
                     * eaten. The funnel carries the leave_scroll advisory and
                     * reconciles the local viewport afterwards.
                     *
                     * GUARDED, not reordered: this file loads at index.html:1694
                     * and app.js (which defines window.emitTerminalInput) at
                     * 1704, so the function does not exist while this file is
                     * parsed. It always exists by the time this CALLBACK runs, but
                     * the fallback keeps a keystroke from being lost if that ever
                     * stops being true -- losing bytes is the defect being fixed.
                     */
                    if (typeof window.emitTerminalInput === 'function') {
                        window.emitTerminalInput(session_id, data);
                    } else {
                        window.socket.emit('ssh_input', {
                            session_id: session_id,
                            data: data
                        });
                    }
                }
            }
        });

        const sessionBar = document.getElementById('sessionBar');
        if (sessionBar) {
            sessionBar.classList.remove('hidden');
        }

        /*
         * The display name, request-correlated.
         *
         * `pending` is the record the ssh_connected handler consumed by
         * client_request_id (takePendingConnection), so a name that travelled
         * with THIS request is used for THIS session. The globals this used to
         * consult (`pendingDisplayName`, `pendingDisplayNames`) were shared
         * mutable state: with two connections in flight the second consumed the
         * first's name, and a cancelled reconnect left a name behind that the
         * next unrelated connect adopted. The per-host localStorage fallback
         * stays -- it is keyed by endpoint, not by whoever connected last.
         */
        const storedName = display_name || (pending && pending.displayName)
            || this.getStoredDisplayName(session_id, host, port, username);
        this.sessions[session_id] = {
            id: session_id,
            host,
            port,
            username,
            connected: true,
            terminalId,
            os: 'all',
            displayName: storedName || null,
            viaJump: sessionData.via_jump || null,
            useTmux: sessionData.use_tmux || false,
            tmuxSessionName: sessionData.tmux_session_name || null,
            keyId: sessionData.key_id || (pending && pending.keyId) || null,
            authType: sessionData.auth_type || (pending && pending.authType) || 'password',
            jumpHostId: (pending && pending.jumpHostId) || null,
            /*
             * Tri-state locale measurement from the backend probe.
             * `true`  = the attached tmux pane predates the UTF-8 locale fix;
             *           its running shell cannot be retrofitted, so the chip
             *           and the lifecycle detail surface a visible warning.
             * `false` = measured fine (no warning).
             * `null`  = not measured (a non-tmux session, or a restored row
             *           nobody has reattached yet) — no warning.
             * The key is always present in every snapshot v1 payload
             * (ssh_connected / ssh_session_restored / ssh_reconnected /
             * sessions_list), so ?? collapses absent + null identically.
             */
            legacyTmuxLocale: sessionData.legacy_tmux_locale ?? null
        };

        this.createSessionTab(session_id, host, username);
        this.updateSessionStatus(session_id, 'connected');

        // A sendable session just arrived. Announced here rather than through
        // updateSessionStatus: this object is inserted as connected:true, so the
        // status call sees no change of sendability and stays silent. Candidate
        // creation is deliberately not announced -- a candidate is not sendable.
        this.notifySendableSessionsChanged();

        this.hideReconnectOverlay(session_id);

        return session_id;
    },

    createSessionTab(sessionId, host, username) {
        const tab = document.createElement('div');
        tab.className = 'session-tab';
        tab.id = `tab-${sessionId}`;
        // Plan v5 section 3 keyboard parity: the chip is the lifecycle entry
        // point on touch, so it must be focusable and announce its selected
        // state. role=tab + aria-selected is the semantic that matches a strip
        // of session chips; aria-selected is maintained by the one selection
        // update path (setActivePane), never here.
        //
        // A desktop chip is selection-only. Lifecycle actions remain available
        // from the shared selected-target sheet; keeping them out of the chip
        // preserves the mockup's dot + two-line label shape and makes the chip
        // centre an unambiguous selection target on fine pointers.
        tab.setAttribute('role', 'tab');
        tab.setAttribute('tabindex', '0');
        tab.setAttribute('aria-selected', 'false');

        // The dot must report the session's REAL state. It was hardcoded
        // to 'connected', so a chip created for an already-disconnected session
        // a restored session, or one whose ssh_connected never arrived --
        // carried no .disconnected class so it also lost its outline. Only a
        // Later updateSessionStatus call ever corrected it. Nothing here
        // fabricates a state: an unknown session falls back to the previous
        // behaviour.
        const known = this.sessions[sessionId];
        const isDown = known ? known.connected === false : false;
        const statusDot = document.createElement('span');
        statusDot.className = `status-dot ${isDown ? 'disconnected' : 'connected'}`;
        if (isDown) {
            tab.classList.add('disconnected');
        }

        const tabLabel = document.createElement('span');
        tabLabel.className = 'tab-label';
        this.renderTabLabelContent(tabLabel, sessionId);

        // Mockup lines 87-89 / 150-152: a chip has exactly the state dot and
        // two-line label. Jump/tmux remain on the session record and are exposed
        // in the selected target's lifecycle detail, never as strip badges.
        //
        // Is the single documented exception to that rule: a pane created
        // before the UTF-8 locale fix can never be retrofitted, and the chip is
        // the one surface that can say so before the user types a first
        // Vietnamese keystroke. The badge renders ONLY for the explicit `true`
        // measurement; measured-fine (false) and unmeasured (null) sessions keep
        // the original dot + label shape, exactly.
        tab.appendChild(statusDot);
        tab.appendChild(tabLabel);

        const legacyBadge = document.createElement('span');
        legacyBadge.className = 'chip-locale-warning';
        legacyBadge.setAttribute('role', 'img');
        legacyBadge.dataset.i18nTitle = 'session.legacyTmuxLocale';
        legacyBadge.dataset.i18nAriaLabel = 'session.legacyTmuxLocale';
        legacyBadge.title = window.i18n
            ? i18n.t('session.legacyTmuxLocale')
            : 'tmux locale predates the UTF-8 fix';
        legacyBadge.setAttribute('aria-label', legacyBadge.title);
        legacyBadge.textContent = '!';
        tab.appendChild(legacyBadge);

        /*
         * The badge is inert markup until the chip carries the warning class;
         * that keeps createSessionTab state-driven (no conditional DOM shape
         * to reconcile later) and updateLegacyLocaleWarning the one writer.
         * The class is toggled AFTER the tab is appended to the strip (below):
         * updateLegacyLocaleWarning finds the chip through document.getElementById,
         * which only sees nodes already in the document, so toggling while the
         * tab is still detached would silently no-op.
         */
        /*
         * Plan v5 section 3 tab interaction contract.
         *
         * The session row carries no ellipsis on touch, so the tab itself is the
         * lifecycle entry point:
         *   - first activation of an inactive tab ONLY selects (connected,
         *     ordinary disconnected, or persistent candidate). It never focuses
         *     the composer or raises the keyboard -- switchSession owns that and
         *     Its focusActivePane is already guarded by isTouchShell.
         *   - a LATER, DISTINCT activation of the already-selected tab opens the
         *     sheet.
         *   - a long press opens it directly, selecting the pressed tab first.
         *   - Enter/Space follows the same two-step rule as tap.
         *
         * Fine-pointer desktop uses the same target model: the first click
         * selects; re-activation opens the one shared lifecycle sheet.
         */

        // The one capability source: TerminalManager.isTouchShell (canonical
        // helper, terminal-manager.js L104, backed by TOUCH_SHELL_QUERY L102).
        // This local alias only guards the module being absent in a fixture; it
        // introduces no second media query.
        const isTouch = () => !!window.TerminalManager
            && typeof TerminalManager.isTouchShell === 'function'
            && TerminalManager.isTouchShell();

        // A rename input, if present, owns its event. The chip otherwise has no
        // nested lifecycle controls; all four actions live in the shared sheet.
        const NESTED_CONTROL = '[data-lifecycle-action], button, input, a';
        const fromNestedControl = (e) => e.target !== tab
            && !!e.target.closest
            && !!e.target.closest(NESTED_CONTROL);

        const LONG_PRESS_MS = 500;
        const MOVE_TOLERANCE_PX = 10;   // finger jitter, not a strip pan
        let pressPointerId = null;
        let pressX = 0;
        let pressY = 0;
        let longPressTimer = null;
        // Set ONLY by a completed long press, consumed by the single synthetic
        // click that follows it. The keyboard path must never set this: role=tab
        // on a div does not synthesize a click, so a flag set there would have
        // nothing to consume it and would silently swallow a later assistive
        // click that arrives with no pointerdown to reset it.
        let suppressNextClick = false;

        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            pressPointerId = null;
        };

        tab.addEventListener('pointerdown', (e) => {
            // A stale suppression flag must never outlive its gesture, or the
            // next genuine tap would be swallowed.
            suppressNextClick = false;
            if (!isTouch() || !e.isPrimary || e.button !== 0) return;
            if (fromNestedControl(e)) return;
            cancelLongPress();
            pressPointerId = e.pointerId;
            pressX = e.clientX;
            pressY = e.clientY;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                pressPointerId = null;
                // Select first when this tab is not the current target, so the
                // sheet always acts on the tab actually pressed.
                if (this.lifecycleActionTargetId !== sessionId) {
                    this.switchSession(sessionId);
                }
                if (this.lifecycleActionTargetId === sessionId) {
                    suppressNextClick = true;
                    this.toggleLifecycleSheet();
                }
            }, LONG_PRESS_MS);
        });

        // Movement cancels only past finger jitter; cancelling on every
        // pointermove would make a long press impossible to perform.
        tab.addEventListener('pointermove', (e) => {
            if (pressPointerId === null || e.pointerId !== pressPointerId) return;
            if (Math.abs(e.clientX - pressX) > MOVE_TOLERANCE_PX
                    || Math.abs(e.clientY - pressY) > MOVE_TOLERANCE_PX) {
                cancelLongPress();
            }
        });

        for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
            tab.addEventListener(evt, (e) => {
                if (pressPointerId !== null && e.pointerId !== pressPointerId) return;
                cancelLongPress();
            });
        }

        tab.addEventListener('click', (e) => {
            cancelLongPress();
            // Exactly one synthetic click follows a completed long press.
            if (suppressNextClick) {
                suppressNextClick = false;
                // The long press already opened the sheet. Letting this click
                // reach the document-level outside-click closer would shut it
                // again, because a tab is not inside #sessionActionsControl.
                e.stopPropagation();
                return;
            }
            if (fromNestedControl(e)) return;
            // A hybrid device (mouse + any-pointer:coarse) delivers
            // click(detail:1), click(detail:2), dblclick for a double-click.
            // Only the first click of a burst is an activation.
            if (e.detail > 1) return;
            if (this.lifecycleActionTargetId === sessionId) {
                // Stop before the document outside-click closer sees the chip.
                e.stopPropagation();
                this.toggleLifecycleSheet();
                return;
            }
            /*
             * A chip is not inside #sessionActionsControl, so the document-level
             * outside-click closer would shut any sheet this click opens. The
             * long-press branch above already had to guard against that; the
             * one-tap select-and-open path (defect 5, switchSession) needs the
             * same protection, otherwise the sheet opens and closes within the
             * same gesture and the user sees nothing. Traced as
             * "switch -> open -> close" before this stopPropagation was added.
             *
             * Scoped to the chip's own click. The closer itself is untouched, so
             * every other surface still dismisses the sheet normally.
             */
            e.stopPropagation();
            this.switchSession(sessionId);
        });

        tab.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            // Only the tab's own activation; nested controls keep their own
            // keyboard behaviour.
            if (e.target !== tab) return;
            // preventDefault alone is the right guard here: it stops Space
            // scrolling the page, and a div with role=tab produces no synthetic
            // click, so there is no second activation to suppress.
            e.preventDefault();
            if (this.lifecycleActionTargetId === sessionId) {
                this.toggleLifecycleSheet();
                return;
            }
            this.switchSession(sessionId);
        });

        this.insertTabInOrder(tab, sessionId);
        /*
         * ONE hold, TWO outcomes -- and only one timer decides.
         *
         * OWNER REPORT: "khi giu vao cac chip connect tren dien
         * thoai de thay doi vi tri thi van bi mo dropdown menu cua connect do".
         * Both machines used to run: this chip armed a 500ms timer that opens
         * the actions sheet, and bindTabDrag armed a 300ms one that arms the
         * drag. Holding to drag passes through 300ms and then keeps going to
         * 500ms, so the sheet opened on top of the drag. The gate never caught
         * it because it moves the finger at 380ms, inside the one window where
         * the old code worked.
         *
         * Now the drag's hold is the only timer that decides: when it arms it
         * cancels this one, and it reports back which gesture the finger
         * actually performed -- released in place means the sheet (what a hold
         * has always meant), moved means a reorder and no sheet.
         */
        this.bindTabDrag(tab, sessionId, {
            suppressClick: () => { suppressNextClick = true; },
            cancelLongPress,
            openSheetOnHold: () => {
                if (this.lifecycleActionTargetId !== sessionId) {
                    this.switchSession(sessionId);
                }
                if (this.lifecycleActionTargetId === sessionId) {
                    suppressNextClick = true;
                    this.toggleLifecycleSheet();
                }
            },
        });

        // The chip exists in the strip now, so the locale warning
        // class can be applied. Toggled here, after append, because
        // updateLegacyLocaleWarning resolves the chip through
        // document.getElementById and a detached node would no-op silently.
        // Later repaints (onReconnected) reuse the same single writer.
        this.updateLegacyLocaleWarning(sessionId);
    },

    /*
     * Live sessions in the order their tabs are painted.
     *
     * Reads the DOM rather than Object.keys(this.sessions): the tab strip is
     * what the user is swiping across, so "next" has to mean the next tab they
     * can see, not the next insertion into an object. Candidates are excluded --
     * They have no terminal to switch to, and switchSession sends them to the
     * reconnect list instead, which would be a strange thing for a swipe to do.
     */
    /*
     * Chip order. The strip's DOM order IS
     * the order everything else reads (switchableSessionIds, the swipe), so
     * arranging is moving nodes; the server keeps `tab_order` per account and
     * hands it out before the restore, so every device shows the same strip.
     */
    orderIndex(sessionId) {
        const index = this.tabOrder.indexOf(sessionId);
        return index === -1 ? Infinity : index;
    },

    insertTabInOrder(tab, sessionId) {
        const strip = document.getElementById('sessionTabs');
        if (!strip) return;
        const mine = this.orderIndex(sessionId);
        const after = [...strip.querySelectorAll('.session-tab')].find(other => {
            const otherId = other.id.replace(/^tab-/, '');
            return other.id.startsWith('tab-') && this.orderIndex(otherId) > mine;
        });
        if (after && mine !== Infinity) {
            strip.insertBefore(tab, after);
        } else {
            strip.appendChild(tab);
        }
    },

    applyTabOrder() {
        const strip = document.getElementById('sessionTabs');
        if (!strip) return;
        const tabs = [...strip.querySelectorAll('.session-tab')].filter(t => t.id.startsWith('tab-'));
        const sorted = tabs.map((tab, i) => ({ tab, i, key: this.orderIndex(tab.id.replace(/^tab-/, '')) }))
            .sort((a, b) => (a.key - b.key) || (a.i - b.i));
        sorted.forEach(({ tab }) => strip.appendChild(tab));
    },

    persistTabOrder() {
        const strip = document.getElementById('sessionTabs');
        if (!strip) return;
        const order = [...strip.querySelectorAll('.session-tab')]
            .map(tab => tab.id).filter(id => id.startsWith('tab-')).map(id => id.slice(4));
        this.tabOrder = order;
        if (window.socket && typeof window.socket.emit === 'function') {
            window.socket.emit('save_tab_order', { order });
        }
    },

    placeDraggedTab(tab, clientX) {
        const strip = document.getElementById('sessionTabs');
        if (!strip) return;
        const siblings = [...strip.querySelectorAll('.session-tab')].filter(t => t !== tab);
        const after = siblings.find(other => {
            const rect = other.getBoundingClientRect();
            return clientX < rect.left + rect.width / 2;
        });
        const before = new Map(siblings.map(t => [t, t.getBoundingClientRect().left]));
        if (after) {
            if (after.previousElementSibling === tab) return;
            strip.insertBefore(tab, after);
        } else if (strip.lastElementChild !== tab) {
            strip.appendChild(tab);
        } else {
            return;
        }
        this.slideDisplacedTabs(siblings, before);
    },

    /*
     * touched twice:
     *
     *   - the chip in hand FOLLOWS the pointer (liftDraggedTab): the slot it
     *     occupies is measured without its own lift, and the difference to
     *     where it was grabbed becomes its translate, with a small tilt in
     *     the direction of travel;
     *   - a chip whose slot just moved SLIDES there (slideDisplacedTabs): its
     *     old and new positions are measured around the DOM move and the
     *     difference is played back from the old one to zero (FLIP).
     *
     * `prefers-reduced-motion` keeps the follow (the chip must still be where
     * the finger is) and drops the slides and the tilt (deck.css).
     */
    DRAG_SETTLE_MS: 220,

    slideDisplacedTabs(chips, before) {
        chips.forEach(chip => {
            const delta = before.get(chip) - chip.getBoundingClientRect().left;
            if (!delta) return;
            chip.classList.remove('drag-shift');
            chip.style.transform = `translateX(${delta}px)`;
            // Commit the start position before the transition is switched on.
            void chip.offsetWidth;
            chip.classList.add('drag-shift');
            chip.style.transform = '';
            clearTimeout(chip._dragShiftTimer);
            chip._dragShiftTimer = setTimeout(
                () => chip.classList.remove('drag-shift'), this.DRAG_SETTLE_MS);
        });
    },

    liftDraggedTab(tab, active, clientX) {
        const slotLeft = tab.getBoundingClientRect().left - active.lift;
        active.lift = clientX - active.grabDx - slotLeft;
        const step = clientX - active.lastX;
        active.lastX = clientX;
        active.tilt = Math.max(-4, Math.min(4, active.tilt * 0.6 + step * 0.35));
        const tilt = this.reducedMotion() ? 0 : active.tilt;
        tab.style.transform = `translateX(${active.lift}px) scale(1.06) rotate(${tilt}deg)`;
    },

    settleDraggedTab(tab) {
        if (!tab.style.transform) return;
        tab.classList.add('drag-settle');
        tab.style.transform = '';
        clearTimeout(tab._dragShiftTimer);
        tab._dragShiftTimer = setTimeout(
            () => tab.classList.remove('drag-settle'), this.DRAG_SETTLE_MS);
    },

    reducedMotion() {
        return !!(window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    },

    /*
     * Drag to arrange. Desktop: press and move. Touch: HOLD 300 ms, then
     * move -- a quick swipe stays a strip pan / session swipe, and a hold
     * released WITHOUT moving opens the actions sheet through
     * `openSheetOnHold`, because this hold is now the only one running
     * (see createSessionTab).
     * The sequence is followed on `document`, not on the chip: the chip is
     * moved in the DOM while it is dragged, and a moved node loses its
     * pointer sequence (no capture for a mouse, a cancel for a touch) --
     * which is what made dragging stop after one slot. While armed, the
     * touchmove is cancelled so the strip cannot pan under the finger.
     */
    bindTabDrag(tab, sessionId, { suppressClick, cancelLongPress, openSheetOnHold } = {}) {
        const HOLD_MS = 300;
        const START_PX = 6;
        const NESTED = '[data-lifecycle-action], button, input, a';
        const snapshot = () => [...document.querySelectorAll('#sessionTabs .session-tab')].map(t => t.id).join(',');
        let active = null;
        const listeners = [];
        const listen = (type, fn, options) => {
            document.addEventListener(type, fn, options);
            listeners.push([type, fn, options]);
        };
        const cleanup = () => {
            listeners.splice(0).forEach(([type, fn, options]) => document.removeEventListener(type, fn, options));
            if (active && active.holdTimer !== null) clearTimeout(active.holdTimer);
            active = null;
            tab.classList.remove('drag-armed', 'dragging');
            this.settleDraggedTab(tab);
            this.tabDragging = false;
        };
        const onMove = (clientX, clientY, event) => {
            if (!active) return;
            const distance = Math.hypot(clientX - active.startX, clientY - active.startY);
            if (!active.dragging) {
                if (!active.armed) {
                    // Moved before the hold: a pan or a swipe, not a drag.
                    if (active.touch && distance > START_PX) cleanup();
                    return;
                }
                if (distance <= START_PX) return;
                active.dragging = true;
                active.before = snapshot();
                active.grabDx = active.startX - tab.getBoundingClientRect().left;
                active.lift = 0;
                active.lastX = clientX;
                active.tilt = 0;
                this.tabDragging = true;
                tab.classList.add('dragging');
            }
            if (event && active.touch && event.cancelable) event.preventDefault();
            this.placeDraggedTab(tab, clientX);
            this.liftDraggedTab(tab, active, clientX);
        };
        const onEnd = () => {
            if (!active) return;
            const wasDragging = active.dragging;
            const wasArmed = active.armed && active.touch;
            const before = active.before;
            cleanup();
            if (!wasDragging) {
                // Held long enough to arm, then let go without moving: that is
                // the "hold to open the menu" gesture, and this recogniser is
                // the only one still able to answer it.
                if (wasArmed && typeof openSheetOnHold === 'function') {
                    if (typeof suppressClick === 'function') suppressClick();
                    openSheetOnHold();
                }
                return;
            }
            if (typeof suppressClick === 'function') suppressClick();
            if (snapshot() !== before) this.persistTabOrder();
        };
        const begin = (touch, clientX, clientY) => {
            cleanup();
            active = { touch, startX: clientX, startY: clientY, armed: !touch,
                       dragging: false, before: null, holdTimer: null };
            if (touch) {
                active.holdTimer = setTimeout(() => {
                    if (!active) return;
                    active.holdTimer = null;
                    active.armed = true;
                    // From here the finger belongs to this gesture: the chip's
                    // own 500ms sheet timer must not also fire.
                    if (typeof cancelLongPress === 'function') cancelLongPress();
                    tab.classList.add('drag-armed');
                    if (navigator.vibrate) navigator.vibrate(10);
                }, HOLD_MS);
                listen('touchmove', (e) => {
                    if (e.touches.length !== 1) { cleanup(); return; }
                    onMove(e.touches[0].clientX, e.touches[0].clientY, e);
                }, { passive: false });
                listen('touchend', onEnd);
                listen('touchcancel', onEnd);
            } else {
                listen('pointermove', (e) => onMove(e.clientX, e.clientY, e));
                listen('pointerup', onEnd);
                listen('pointercancel', onEnd);
            }
        };
        const nested = (e) => e.target !== tab && !!e.target.closest && !!e.target.closest(NESTED);
        tab.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || !e.isPrimary || e.button !== 0 || nested(e)) return;
            begin(false, e.clientX, e.clientY);
        });
        tab.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || nested(e)) return;
            begin(true, e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
    },

    switchableSessionIds() {
        const strip = document.getElementById('sessionTabs');
        if (!strip) {
            return [];
        }
        return [...strip.querySelectorAll('.session-tab')]
            .map(tab => tab.id.replace(/^tab-/, ''))
            .filter(id => this.sessions[id]
                && !this.sessions[id].isPersistentCandidate);
    },

    /*
     * Swipe left/right across the tab strip to move one session.
     *
     * Bound on #sessionTabs only, never on the terminal. The terminal's own
     * horizontal and vertical gestures (tmux scrollback, long-press select,
     * double-tap) are established behaviour that took fifteen rounds on real
     * hardware to settle, and a swipe handler over the terminal would have to
     * guess which of them the user meant. The tab strip has no competing
     * gesture except its own horizontal scroll, which is handled below.
     *
     * Deliberately not wrapping around at the ends: on a strip you can see, a
     * swipe that jumps from the last tab back to the first reads as a glitch
     * rather than a feature.
     */
    bindTabStripSwipe() {
        const strip = document.getElementById('sessionTabs');
        if (!strip) {
            return;
        }
        /*
         * Bind once, even if init runs twice. Two handlers on the same strip
         * means one swipe advances two sessions, which is exactly what happened
         * the first time this was measured. A dataset flag rather than a
         * module-level boolean: the guard then belongs to the element, so it
         * survives the element being the same one across a re-init and does not
         * wrongly suppress binding if the strip is ever replaced.
         */
        if (strip.dataset.swipeBound === 'true') {
            return;
        }
        strip.dataset.swipeBound = 'true';

        // 44px: one touch target. Below that the gesture competes with a tap,
        // and a tap on a tab already means "switch to this one".
        const MIN_DISTANCE = 44;
        // A swipe has to be clearly more horizontal than vertical, or a diagonal
        // scroll of the page would switch sessions on the way past.
        const DIRECTION_RATIO = 1.5;

        let startX = null;
        let startY = null;
        let multiTouch = false;

        strip.addEventListener('touchstart', event => {
            if (event.touches.length !== 1) {
                // Second finger: abandon the gesture but do not preventDefault,
                // so pinch zoom still reaches the browser.
                multiTouch = true;
                startX = null;
                return;
            }
            multiTouch = false;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true });

        strip.addEventListener('touchend', event => {
            if (this.tabDragging || multiTouch || startX === null
                    || event.changedTouches.length !== 1) {
                startX = null;
                return;
            }
            const dx = event.changedTouches[0].clientX - startX;
            const dy = event.changedTouches[0].clientY - startY;
            startX = null;

            if (Math.abs(dx) < MIN_DISTANCE
                || Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) {
                return;
            }

            /*
             * A horizontal drag over an overflowing strip belongs to the strip,
             * never to session selection. Scrollability -- not whether this
             * particular gesture managed to move scrollLeft -- is the real
             * condition: at either extreme (scrollLeft 0, or scrollWidth -
             * clientWidth) a further drag cannot move it, so a position-delta
             * test wrongly reads "not a scroll" and switches the session out
             * from under the user. Swipe-to-switch therefore survives only on a
             * strip that genuinely fits, where dragging it has no other meaning.
             */
            if (strip.scrollWidth > strip.clientWidth) {
                return;
            }

            const ids = this.switchableSessionIds();
            const current = ids.indexOf(this.activeSessionId);
            if (ids.length < 2 || current === -1) {
                return;
            }
            // Swipe left (negative dx) moves forward, the way a stack of cards
            // does: the content follows the finger.
            const next = current + (dx < 0 ? 1 : -1);
            if (next < 0 || next >= ids.length) {
                return;
            }
            this.switchSession(ids[next]);
            const tab = document.getElementById(`tab-${ids[next]}`);
            if (tab && tab.scrollIntoView) {
                tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        }, { passive: true });
    },

    switchSession(sessionId) {
        if (!this.sessions[sessionId]) {
            console.error('Session not found:', sessionId);
            return;
        }

        /*
         * Disconnected / candidate chip: ONE gesture both selects it as the
         * lifecycle target and opens that connection's action menu (owner ruling
         *defect 5). Before this, the first click only set the target
         * and the user had to click a second time to see any action -- there is
         * no reason to make selecting a dead connection a two-step ritual when
         * the only useful next step is choosing one of its actions.
         *
         * Everything the previous behaviour deliberately did NOT do still does
         * not happen: no auto-connect, no pane eviction, no change to the active
         * connected terminal, no text-input focus and no soft keyboard. This
         * returns before the assignedIndex/assignSessionToPane paths exactly as
         * it did, and openLifecycleSheet only paints a surface -- acceptance
         * remains the explicit Reconnect action inside it.
         */
        const session = this.sessions[sessionId];
        if (!session.connected || session.isPersistentCandidate) {
            this.setLifecycleActionTarget(sessionId);
            this.openLifecycleSheet();
            return;
        }

        // Connected non-candidate chips keep the original pane path untouched:
        // its setActivePane writes the target through J3 — no pre-set here.
        const assignedIndex = this.paneAssignments.findIndex(id => id === sessionId);
        if (assignedIndex !== -1) {
            this.setActivePane(assignedIndex);
            return;
        }

        // Not in any pane: full screen, assignments untouched (owner ruling
        //). Assigning is an explicit action, never a side effect
        // of looking at a session.
        this.setSolo(sessionId);
    },

    closeSession(sessionId) {
        if (!this.sessions[sessionId]) {
            return;
        }

        if (window.socket) {
            window.socket.emit('ssh_disconnect', { session_id: sessionId });
        }

        this.removeSessionUI(sessionId);
    },

    removeSessionUI(sessionId) {
        if (!this.sessions[sessionId]) {
            return;
        }

        // Lifecycle target is deliberate user selection state, so removal
        // decides it here and the pane-activation tail below must not silently
        // redecide it. Removing the target clears it; removing anything else
        // preserves it. Captured before the delete, re-applied after the tail's
        // setActivePane (which writes the target for its own pane via J3 --
        // correct for every other caller, wrong as a selection override here).
        const targetWasRemoved = this.lifecycleActionTargetId === sessionId;
        const intendedTargetId = targetWasRemoved ? null : this.lifecycleActionTargetId;
        if (targetWasRemoved) {
            this.setLifecycleActionTarget(null);
        }

        const terminalContainer = document.getElementById(this.sessions[sessionId].terminalId);
        if (terminalContainer) {
            terminalContainer.remove();
        }

        TerminalManager.destroyTerminal(sessionId);

        const tab = document.getElementById(`tab-${sessionId}`);
        if (tab) {
            tab.remove();
        }

        const paneIndex = this.paneAssignments.findIndex(id => id === sessionId);
        if (paneIndex !== -1) {
            this.paneAssignments[paneIndex] = null;
            this.renderPane(paneIndex);
        }
        if (this.soloSessionId === sessionId) {
            this.soloSessionId = null;
        }
        delete this.sentPaneIndex[sessionId];
        const wasCandidate = this.sessions[sessionId].isPersistentCandidate;
        const wasSendable = this.isSendableSession(this.sessions[sessionId]);
        delete this.sessions[sessionId];
        if (wasCandidate) {
            // Rebuild rather than remove one row: the list is derived from
            // this.sessions, and dropping the last candidate has to give the
            // empty pane back to its normal content.
            this.renderReconnectList();
        }

        const remainingSessions = Object.keys(this.sessions);
        if (remainingSessions.length > 0) {
            const assignedIndex = this.paneAssignments.findIndex(id => id);
            if (assignedIndex !== -1) {
                this.setActivePane(assignedIndex, { preserveLifecycleTarget: true });
            } else {
                this.setActivePane(this.activePaneIndex, { preserveLifecycleTarget: true });
            }
            // Pane state has been synchronized without re-deciding deliberate
            // lifecycle selection. The target removed above therefore stays null;
            // an unrelated real or pending target, including its open sheet,
            // remains untouched. This also avoids clearing pending state merely
            // because a surviving real session occupies the active pane.
            if (this.lifecycleActionTargetId !== intendedTargetId) {
                this.setLifecycleActionTarget(intendedTargetId);
            }
        } else {
            // Last session gone. Go through setActivePane so the displayed
            // selection pair (activePaneIndex + activeSessionId) is written by
            // the same sole owner that every other transition uses -- an inline
            // activeSessionId = null here was the only remaining raw write, and
            // it left activePaneIndex pointing at a now-empty slot with no
            // matching activeSessionId until the next activation.
            // preserveLifecycleTarget: the deliberate target (if any) was already
            // decided above; this must not re-decide it.
            this.setActivePane(this.activePaneIndex, { preserveLifecycleTarget: true });
            // Nothing left to probe. A single 15 s timer that keeps firing
            // after the last session is gone would keep the socket hot for no
            // purpose; it restarts when a session connects.
            this.stopLatencyPolling();
        }

        // Only a sendable session leaving shrinks the set; removing a candidate or
        // an already-disconnected session changes nothing for Broadcast.
        if (wasSendable) {
            this.notifySendableSessionsChanged();
        }
    },

    // Fire sshdeck:active-session-changed only when the active session id really
    // changed. Tapping the same pane again must NOT fire it: the listener resets
    // the mobile input, and doing that mid-composition would eat the Vietnamese
    // syllable being typed.
    notifyActiveSessionChanged(previousSessionId, currentSessionId) {
        if ((previousSessionId || null) === (currentSessionId || null)) {
            return;
        }
        document.dispatchEvent(new CustomEvent('sshdeck:active-session-changed', {
            detail: {
                previousSessionId: previousSessionId || null,
                currentSessionId: currentSessionId || null
            }
        }));
    },

    /*
     * True when a session object can actually receive input: it has a live
     * channel and is not still an unaccepted reconnect offer. This is the same
     * test switchSession and switchableSessionIds apply, kept in one place so
     * consumers cannot drift from it.
     */
    isSendableSession(session) {
        return !!session && session.connected === true && !session.isPersistentCandidate;
    },

    /*
     * Announce that the set of SENDABLE sessions changed.
     *
     * The active-session event is not enough: a BACKGROUND session connecting,
     * dropping, or being closed changes the sendable set without changing which
     * session is active. Callers fire this only on a real change of that set, so
     * one state transition never publishes twice.
     *
     * This stays a neutral notification: session state is owned here, and
     * feature modules subscribe to it rather than being called by it.
     */
    notifySendableSessionsChanged() {
        document.dispatchEvent(new CustomEvent('sshdeck:sendable-sessions-changed'));
    },

    /*
     * ── RECONNECT INTENT REGISTRY ───────────────────────────────────────────
     *
     * Request-keyed, exactly like `pendingConnections`, and for the same reason:
     * a single `pendingReconnectMeta` slot could hold ONE intent, so two
     * reconnects in flight overwrote each other and every consumer then acted on
     * the wrong one. Concretely, with candidates A and B both reconnecting:
     *
     *   * B's intent overwrote A's, so A's chip was never retired and its
     *     transcript was dropped, while B's success retired B twice;
     *   * responses arriving out of order (B before A) retired the wrong chip;
     *   * an ORDINARY connect completing in between consumed the reconnect
     *     intent and adopted a candidate's transcript into an unrelated session.
     *
     * So the key is the `client_request_id` that travels on the wire, and every
     * consumer -- success, error, cancel -- looks up its own exact request. An
     * id we did not mint, or one already consumed, resolves to null and the
     * consumer does nothing.
     *
     * Records are non-secret only, the same allowlist discipline
     * pendingResetMeta and pendingConnections follow: no password ever enters
     * one.
     */
    reconnectIntents: {},

    /*
     * Which request currently owns the CREDENTIAL MODAL. There is one modal, so
     * only one request can be waiting for typing at a time -- but any number can
     * be in flight on the wire, which is why this is a pointer INTO the registry
     * rather than a second copy of the record.
     *
     * Written ONLY by beginReconnectIntent (claim) and releaseReconnectModal
     * (exact-equality release). A raw `= null` anywhere else was a real hazard:
     * it could release a modal owned by a DIFFERENT request, after which that
     * request's submit built an ordinary connect payload with no
     * reconnect_tmux_name -- a silent Reset.
     */
    activeReconnectRequestId: null,

    activeReconnectIntent() {
        const id = this.activeReconnectRequestId;
        return (id && this.reconnectIntents[id]) ? this.reconnectIntents[id] : null;
    },

    getReconnectIntent(requestId) {
        return (requestId && this.reconnectIntents[requestId])
            ? this.reconnectIntents[requestId] : null;
    },

    /*
     * Does this session have a tmux identity a RECONNECT can actually use?
     *
     * THE BOUNDARY GUARD, and it exists because of a real shape in the data. A
     * persisted row may carry `is_persistent = 1` with `tmux_session_name = NULL`
     * (a non-tmux session that was still marked persistent, or a row written
     * before the name was recorded), and restore offers it back as a candidate.
     * Reconnecting it would emit `use_tmux: true, reconnect_tmux_name: null`,
     * which the server reads as "make me a NEW tmux session" -- so the action
     * labelled Reconnect would silently do what Reset does, which is exactly the
     * defect class being fixed.
     *
     * The name is checked against the SAME whitelist the server enforces
     * (socket_events.handle_ssh_connect: ^[A-Za-z0-9_]{1,190}$), so the client
     * refuses locally what the server would reject anyway rather than sending a
     * doomed frame. This does not weaken the server-side check; it mirrors it.
     */
    hasValidTmuxIdentity(session) {
        const name = session && session.tmuxSessionName;
        if (typeof name !== 'string' || name === '') return false;
        return /^[A-Za-z0-9_]{1,190}$/.test(name);
    },

    /*
     * Register one reconnect intent and claim its session.
     *
     * Returns the record (so the caller can put its requestId on the payload), or
     * null when the reconnect must not start. Three refusals, each a real defect
     * if allowed:
     *
     *   * no such session;
     *   * this session already has a reconnect in flight -- the one lifecycle
     *     owner rule, which is what stops a double tap emitting two ssh_connects
     *     for the same tmux session;
     *   * `ownsModal` was asked for while ANOTHER request already owns the
     *     credential modal. Blindly overwriting the owner orphaned the first
     *     request: it stayed claimed forever (so its session became permanently
     *     un-reconnectable) while the modal's submit consumed the SECOND
     *     record's tmux name. The policy is REFUSE, not steal -- the first
     *     reconnect is the one the user is already typing into, and the user
     *     can cancel it explicitly.
     */
    beginReconnectIntent(sessionId, { ownsModal = false,
        retireOnSuccess = true } = {}) {
        const session = this.sessions[sessionId];
        if (!session) return null;
        if (this.reconnectingSessions && this.reconnectingSessions[sessionId]) {
            return null;
        }
        if (ownsModal && this.activeReconnectIntent()) {
            return null;
        }
        const tmuxSessionName = session.tmuxSessionName || null;
        const authType = session.authType || (session.keyId ? 'key' : 'password');
        const requestId = `reconnect_${Date.now().toString(36)}`
            + `_${Math.random().toString(36).slice(2, 6)}`;
        const intent = {
            sessionId,
            requestId,
            tmuxSessionName,
            displayName: session.displayName || null,
            authType,
            keyId: session.keyId || null,
            jumpHostId: session.jumpHostId || null,
            fromCandidate: session.isPersistentCandidate === true,
            // Whether SUCCESS should retire the old session and carry its
            // transcript to the new one. True for the routes that replace a
            // known session in place (a candidate accepting its own offer, a
            // live session reconnecting through the credential form). False for
            // the ordinary-disconnected route, whose behaviour is deliberately
            // left exactly as it shipped: it has never retired its old chip, and
            // changing that is an owner decision, not a side effect of this fix.
            retireOnSuccess: retireOnSuccess === true,
        };
        this.reconnectIntents[requestId] = intent;
        this.reconnectingSessions = this.reconnectingSessions || {};
        this.reconnectingSessions[sessionId] = requestId;
        if (ownsModal) this.activeReconnectRequestId = requestId;
        return intent;
    },

    /*
     * Consume ONE intent by its exact request id: it is removed from the
     * registry and its session's claim is released. Returns the record, or null
     * if this request never had an intent (an ordinary connect) or it was
     * already consumed.
     *
     * The claim is released only when it still points at THIS request, so a
     * later reconnect of the same session -- armed after this one finished --
     * cannot be disarmed by a straggler.
     *
     * Deliberately does NOT touch the modal owner or the banner. Those belong to
     * releaseReconnectModal, because "this request is finished" and "the modal
     * is no longer serving this request" are different facts: a request that
     * never owned the modal (directReconnect) must not be able to close someone
     * else's banner by finishing.
     */
    takeReconnectIntent(requestId) {
        const intent = this.getReconnectIntent(requestId);
        if (!intent) return null;
        delete this.reconnectIntents[requestId];
        if (this.reconnectingSessions
                && this.reconnectingSessions[intent.sessionId] === requestId) {
            delete this.reconnectingSessions[intent.sessionId];
        }
        return intent;
    },

    /*
     * Abandon one reconnect that will never complete, by its EXACT request id.
     *
     * Nothing is destroyed -- the session (live transport, or candidate chip and
     * its offer) was deliberately left intact while the request was in flight,
     * which is the whole point of the route. All this does is drop that record
     * and release that session's claim, so the next press is a fresh attempt
     * rather than a silent no-op against the one-owner guard.
     *
     * Strictly scoped: it touches no modal state and no OTHER request. An error
     * for request A cannot disarm request B, hide B's banner, or cancel a Reset
     * the user is still typing into.
     */
    cancelReconnectIntent(requestId) {
        if (!requestId) return null;
        return this.takeReconnectIntent(requestId);
    },

    /*
     * Release the credential modal, and ONLY if this exact request owns it.
     *
     * The equality check is the whole point. A raw `activeReconnectRequestId =
     * null` could release a modal belonging to a different request, and that
     * request's submit would then find no intent and build an ordinary connect
     * payload -- use_tmux with no name, i.e. a new tmux session where the user
     * asked to reattach one. A silent Reset.
     *
     * Returns true when it really was this request's modal.
     */
    releaseReconnectModal(requestId) {
        if (!requestId || this.activeReconnectRequestId !== requestId) {
            return false;
        }
        this.activeReconnectRequestId = null;
        this.setConnectionFormIntent(null);
        return true;
    },

    /*
     * A PERSISTENT CANDIDATE whose credential the server does not hold.
     *
     * WHAT THIS REPLACED, and why it is its own function. This branch used to
     * call prefillConnectionForm, which for a candidate did three things a
     * Reconnect must never do:
     *
     *   1. removeSessionUI(sessionId) BEFORE the form opened -- the chip, the
     *      offer, the lifecycle selection and the transcript were destroyed while
     *      the user was still typing, and cancelling left them with nothing. That
     *      is literally Reset's shape: retire first, connect later.
     *   2. it carried the tmux name in the loose `pendingReconnectTmux` global
     *      only, which the submit path may consume for an unrelated reason -- and
     *      then the emit was use_tmux with NO name, i.e. a FRESH tmux session. A
     *      silent Reset.
     *   3. it opened the connect modal with no statement of intent, so it was
     *      indistinguishable from the modal Reset opens.
     *
     * Now the intent is registered under its own request id, the form states
     * which action it is serving, and the chip is retired by
     * completePendingReconnect only once THAT request's replacement session
     * exists -- with its transcript carried across first.
     */
    requestCandidateReconnect(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return;
        // THE BOUNDARY. A candidate whose tmux identity is missing or malformed
        // cannot be reconnected: the emit would be use_tmux:true with
        // reconnect_tmux_name:null, which the server reads as "create a NEW tmux
        // session" -- Reset's outcome under Reconnect's label. Refuse with an
        // honest message and leave the offer exactly where it is; nothing is
        // removed, so the row survives for a later restore or an explicit Reset.
        if (!this.refuseReconnectWithoutTmuxIdentity(sessionId)) return;
        const intent = this.beginReconnectIntent(sessionId, { ownsModal: true });
        if (!intent) return;

        const label = this.getDisplayLabel(sessionId, session.username,
            session.host);

        this.prefillConnectionForm(sessionId);
        // A candidate ALWAYS has tmux intent: it exists only because a tmux
        // session is still running on the host. The name travels in the intent
        // record, keyed by this request -- never in a shared global the submit
        // path may already have consumed for something else.
        const tmuxCheck = document.getElementById('useTmuxCheck');
        if (tmuxCheck) tmuxCheck.checked = true;
        this.setConnectionFormIntent('reconnect', {
            label, tmuxSessionName: intent.tmuxSessionName,
        });
        const prompt = window.i18n
            ? i18n.t('session.reconnectPasswordPrompt').replace('{label}', label)
            : `Enter the password for ${label} to reconnect. Your tmux `
              + 'session, history and notes are kept.';
        window.showNotification(prompt, 'info');
    },

    /*
     * Gate every CANDIDATE reconnect on a usable tmux identity.
     *
     * Returns true when the reconnect may proceed. On refusal it reports why and
     * returns false, having changed nothing: the chip, the offer and the DB row
     * all survive. A candidate exists precisely because a tmux session is
     * supposed to be running on the host, so a candidate with no valid name is a
     * data problem, not a user error -- and the only safe answer is to refuse
     * rather than silently create a new tmux session under the Reconnect label.
     */
    refuseReconnectWithoutTmuxIdentity(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return false;
        if (this.hasValidTmuxIdentity(session)) return true;
        const label = this.getDisplayLabel(sessionId, session.username,
            session.host);
        const message = window.i18n
            ? i18n.t('session.reconnectNoTmuxIdentity').replace('{label}', label)
            : `Cannot reconnect ${label}: this saved session has no valid tmux `
              + 'name, so reattaching is impossible. Use Reset to start a fresh '
              + 'session.';
        window.showNotification(message, 'error');
        return false;
    },

    requestCloseSession(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }

        const label = this.getDisplayLabel(sessionId, session.username, session.host);
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        const message = window.i18n
            ? i18n.t('session.closeConfirm').replace('{label}', label)
            : `Close session "${label}"?`;
        // Routed through the in-app dialog for the same reason Reset is --
        // on a touch shell the tap that opens the sheet dismisses a native
        // Confirm, so this gate did not exist on the surface it guards.
        //
        // Close ends the session AND kills its tmux (ssh_disconnect ->
        // close_session(kill_tmux=True), socket_events.py:1007), so it is
        // destructive and says so. What it does NOT do is start anything: the
        // old shared copy promised a fresh session, which Close never creates.
        this.openSessionConfirm({
            title: message,
            body: t('session.closeBody',
                'The connection ends and its tmux session is closed on the '
                + 'remote host. Profiles and notes are kept.'),
            acceptLabel: t('session.closeAccept', 'Close session'),
            icon: 'x',
            danger: true,
            onAccept: () => this.closeSession(sessionId),
        });
    },

    requestReconnect(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }

        const label = this.getDisplayLabel(sessionId, session.username, session.host);

        /*
         * A PERSISTENT CANDIDATE: a saved tmux session offered back after a
         * restart or a dropped socket. There is nothing live to lose, so the
         * key/Tailscale route runs straight away -- but it is still a RECONNECT,
         * and the two things that made it feel like a Reset are fixed here:
         *
         *   * the chip is NOT destroyed before a replacement exists (see
         *     directReconnect / requestCandidateReconnect). Cancelling the form
         *     now leaves the user exactly where they were.
         *   * the password route carries RECONNECT INTENT into the form and says
         *     so, instead of opening the same bare connect modal Reset opens.
         */
        if (session.isPersistentCandidate) {
            const authType = session.authType || (session.keyId ? 'key' : 'password');
            if (session.keyId || authType === 'tailscale') {
                this.directReconnect(sessionId);
            } else {
                this.requestCandidateReconnect(sessionId);
            }
            return;
        }

        // Active session — disconnect first, then reconnect
        if (session.connected) {
            const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
            const message = window.i18n
                ? i18n.t('session.reconnectConfirm').replace('{label}', label)
                : `Reconnect session "${label}"?`;
            /*
             * Same in-app dialog; the live-reconnect body moved verbatim
             * into performLiveReconnect so the accept button is now the gate.
             *
             * Reconnect is NOT destructive, and the copy now says what it
             * actually does. The transport is rebuilt underneath the same
             * logical session (handle_ssh_reconnect prepares the replacement
             * BEFORE retiring the old one), so the terminal, its scrollback and
             * the tmux session are all preserved -- and a failure changes
             * nothing at all. It gets the plug-zap icon of the Reconnect action
             * itself and NO danger class; the old shared dialog told the user
             * this button would start a fresh session without tmux, which is the
             * opposite of what it does.
             *
             * When the credential form is needed (a password session, whose
             * secret the server does not store) the reconnect INTENT is carried
             * through it -- same session, same tmux name, ssh_connect with
             * reconnect_tmux_name -- so the extra step is a password prompt, not
             * a reset. That routing is stated in the body up front rather than
             * appearing as a surprise modal after the user has accepted.
             */
            const needsPassword = this.reconnectNeedsCredentials(sessionId);
            this.openSessionConfirm({
                title: message,
                body: needsPassword
                    ? t('session.reconnectBodyPassword',
                        'The connection is rebuilt and your tmux session is '
                        + 'reattached, with the terminal and its history kept. '
                        + 'Your password is asked for again because it is never '
                        + 'stored on the server.')
                    : t('session.reconnectBody',
                        'The connection is rebuilt and your tmux session is '
                        + 'reattached. The terminal, its history and everything '
                        + 'running stay as they are.'),
                acceptLabel: needsPassword
                    ? t('session.reconnectAcceptPassword', 'Enter password')
                    : t('session.reconnectAccept', 'Reconnect'),
                icon: needsPassword ? 'key-round' : 'plug-zap',
                danger: false,
                onAccept: () => this.performLiveReconnect(sessionId),
            });
            return;
        }

        /*
         * The ORDINARY DISCONNECTED route, made truthful.
         *
         * WHAT THIS WAS. This branch fell through to prefillConnectionForm with
         * NOTHING said about what "Reconnect" was doing. For a session that owns
         * no valid tmux identity the form opens bare: no confirm gate, no intent
         * banner, no copy — a user pressing Reconnect saw the same modal Reset
         * opens, and the button label promised a reattach that the payload then
         * never performed (use_tmux:false, no name — a raw fresh connection).
         *
         * THE TRUTHFUL CONTRACT, per shape:
         *
         *   * owns a VALID tmux identity — a retained tmux session may still be
         *     running on the host. This is a real RECONNECT: a confirm gate says
         *     it reattaches the retained tmux session, then the credential form
         *     opens with the reconnect intent armed (name rides on the intent
         *     record, submit emits use_tmux:true + reconnect_tmux_name,
         *     completePendingReconnect retires the dead chip on success). This
         *     state is rarer since D2a's transport-loss promotion sends such
         *     sessions through the candidate branch above, but a disconnected
         *     record can still own a name (a flag loss across restore, a future
         *     caller), and the route must stay a reattach, never a fresh
         *     connection under a Reconnect label.
         *   * NO valid identity — nothing can be reattached, so the honest
         *     action is to say exactly that: the session cannot be restored as
         *     it was; Reset is the explicit fresh-session action. This route
         *     REFUSES with that message and changes nothing — the chip survives,
         *     the form never opens under a false promise, and Reset remains the
         *     user's explicit choice.
         */
        if (this.hasValidTmuxIdentity(session)) {
            /*
             * CASE 1 — valid tmux identity: a retained tmux session may still be
             * running on the host. This is a real RECONNECT: confirm, then the
             * credential form opens with the reattach intent armed (name rides on
             * the intent record; submit emits use_tmux:true + reconnect_tmux_name;
             * completePendingReconnect retires the dead chip on success).
             */
            const tt = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
            this.openSessionConfirm({
                title: (window.i18n
                    ? i18n.t('session.reconnectConfirm').replace('{label}', label)
                    : `Reconnect session "${label}"?`),
                body: tt('session.reconnectRetainBody',
                    'The connection is rebuilt and reattaches the retained '
                    + 'tmux session, keeping the terminal and its history. '
                    + 'Enter your credential to continue.'),
                acceptLabel: tt('session.reconnectAccept', 'Reconnect'),
                icon: 'plug-zap',
                danger: false,
                onAccept: () => {
                    this.prefillConnectionForm(sessionId);
                    // prefillConnectionForm arms the intent but does not paint
                    // the banner itself (only the candidate and live-reconnect
                    // routes do). The modal must still state that this is a
                    // Reconnect — not leave the bare connect form Reset opens.
                    this.setConnectionFormIntent('reconnect', {
                        label,
                        tmuxSessionName: session.tmuxSessionName || null,
                    });
                },
            });
            return;
        }

        if (session.useTmux || session.isPersistentCandidate) {
            /*
             * CASE 2 — had tmux intent but the identity is lost or invalid.
             * Reconnecting would emit use_tmux with no name (a NEW tmux session)
             * or a raw shell — Reset's outcome under Reconnect's label. Refuse
             * honestly; the chip survives and Reset remains the explicit route.
             */
            this.refuseReconnectWithoutTmuxIdentity(sessionId);
            return;
        }

        /*
         * CASE 3 — never had tmux. Reconnecting restores the logical session
         * (same endpoint, new transport, transcript carried across). The form
         * opens with the D2a intent armed (no name → bare ssh_connect) and the
         * intent banner makes the modal truthful: no tmux preservation promise.
         */
        this.prefillConnectionForm(sessionId);
        this.setConnectionFormIntent('reconnect', { label, tmuxSessionName: null });
    },

    /*
     * Will a live reconnect of this session have to ask for a credential?
     *
     * Mirrors handle_ssh_reconnect's own refusals (socket_events.py:687-720)
     * rather than guessing: the server can only rebuild a transport from
     * material it still holds, which is a stored key or a tailnet identity. A
     * password session, a key session with no key_id, and any jump-host session
     * (whose bastion secret is never persisted) all come back
     * 'password_required'.
     *
     * This is used ONLY to describe the action honestly in the dialog. The
     * server remains the authority: performLiveReconnect always asks it, and
     * onReconnectFailed handles the real answer. So a wrong guess here can never
     * route the user anywhere -- it can only mislabel a button, which is exactly
     * the class of defect being fixed.
     */
    reconnectNeedsCredentials(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return false;
        if (session.viaJump || session.jumpHostId) return true;
        const authType = session.authType || (session.keyId ? 'key' : 'password');
        if (authType === 'tailscale') return false;
        if (authType === 'key') return !session.keyId;
        return true;
    },

    /*
     * W2 prepare-and-swap Reconnect of a LIVE session.
     *
     * What this replaced, and why: the old body closed the session first
     * (closeSession -> ssh_disconnect, which kills the tmux session), waited
     * 500 ms, then issued a brand new ssh_connect. That produced a NEW
     * session_id, so createSession built a NEW xterm: the terminal, its
     * scrollback, its pane placement and its chip identity were all destroyed,
     * and if the new connection then failed the user was left with nothing --
     * the session they asked to *reconnect* was already gone.
     *
     * Now the server builds the replacement transport while the old one is
     * still serving the session, and swaps it in under the SAME logical
     * session_id (see handle_ssh_reconnect). So there is nothing to tear down
     * here: no closeSession, no setTimeout, no new id. The xterm instance,
     * scrollback, pane and draft stay exactly as they are, and a failure is a
     * notification -- the session keeps running on its old transport.
     *
     * The password / jump-host routes still need the form (the server cannot
     * re-supply those secrets on its own). The server says so explicitly with
     * code 'password_required', which is handled in onReconnectFailed, so the
     * decision lives in ONE place instead of being guessed twice.
     */
    performLiveReconnect(sessionId) {
        const session = this.sessions[sessionId];
        if (!session || !session.connected) return;
        if (!window.socket) return;
        if (this.reconnectingSessions && this.reconnectingSessions[sessionId]) {
            // One lifecycle owner: a second request while the first is in
            // flight would race two replacement transports.
            return;
        }

        /*
         * A session whose credential the server does not hold goes STRAIGHT to
         * the credential form, carrying the reconnect intent with it.
         *
         * Emitting ssh_reconnect first would be a guaranteed refusal
         * ('password_required', socket_events.py:687) that still spends a slot
         * in the shared ssh_connect rate-limit bucket -- Part-G row 2a measured
         * exactly that round trip, three times, and got the refusal every time.
         * Worse, the user experienced it as "Reconnect did something odd and
         * then a connection form appeared".
         *
         * The server stays the authority for every case this predicate calls
         * reconnectable: if it disagrees, onReconnectFailed lands on the very
         * same form. So this shortcut can only ever remove a doomed round trip,
         * never take a decision away from the server.
         */
        if (this.reconnectNeedsCredentials(sessionId)) {
            this.prefillLiveReconnectForm(sessionId);
            return;
        }

        const label = this.getDisplayLabel(sessionId, session.username, session.host);

        this.reconnectingSessions = this.reconnectingSessions || {};
        this.reconnectingSessions[sessionId] = true;

        window.socket.emit('ssh_reconnect', { session_id: sessionId });

        const message = window.i18n
            ? i18n.t('session.reconnecting').replace('{label}', label)
            : `Reconnecting to ${label}...`;
        window.showNotification(message, 'info');
    },

    // Live session whose transport was swapped underneath it. The logical
    // session, its xterm and its pane are unchanged, so this only refreshes the
    // identity fields the swap can legitimately move (tmux name / persistence)
    // and repaints the chip.
    onReconnected(data) {
        const sessionId = data && data.session_id;
        if (!sessionId) return;
        if (this.reconnectingSessions) {
            delete this.reconnectingSessions[sessionId];
        }
        const session = this.sessions[sessionId];
        if (!session) return;

        if (data.tmux_session_name !== undefined) {
            session.tmuxSessionName = data.tmux_session_name || null;
        }
        if (data.use_tmux !== undefined) {
            session.useTmux = !!data.use_tmux;
        }
        if (data.auth_type) {
            session.authType = data.auth_type;
        }
        if (data.key_id !== undefined && data.key_id !== null) {
            session.keyId = data.key_id;
        }
        // The swap reattaches the same tmux session, so its pane's
        // locale state is RE-MEASURED by the replacement transport's probe.
        // The snapshot is authoritative for the new generation; absorb it and
        // repaint the chip warning if the measurement changed.
        if (data.legacy_tmux_locale !== undefined) {
            session.legacyTmuxLocale = data.legacy_tmux_locale ?? null;
        }
        /*
         * VIEWS: the swap replaced the transport, so the tmux client this
         * socket held died with the old one. requestFit re-attaches it --
         * reportLocalFit sees the view as detached and attaches instead of
         * resizing -- and the new attach repaints the visible screen for this
         * client at this client's own size, which is why the ack carries no
         * geometry to adopt any more.
         */
        TerminalManager.noteViewDropped?.(sessionId);
        TerminalManager.requestFit(sessionId);
        this.updateSessionStatus(sessionId, 'connected');
        this.renderLifecycleTarget();
        this.updateLegacyLocaleWarning(sessionId);

        const label = this.getDisplayLabel(sessionId, session.username, session.host);
        const message = window.i18n
            ? i18n.t('session.reconnected').replace('{label}', label)
            : `Reconnected to ${label}`;
        window.showNotification(message, 'success');
    },

    // A failed swap changed NOTHING server-side: the session is still live on
    // its old transport. So this never destroys UI -- it either routes to the
    // credential form (the one case the server cannot resolve alone) or just
    // reports the failure.
    onReconnectFailed(data) {
        const sessionId = data && data.session_id;
        if (!sessionId) return;
        if (this.reconnectingSessions) {
            delete this.reconnectingSessions[sessionId];
        }
        const session = this.sessions[sessionId];

        if (data.code === 'password_required' && session) {
            this.prefillLiveReconnectForm(sessionId);
            return;
        }

        const label = session
            ? this.getDisplayLabel(sessionId, session.username, session.host)
            : sessionId;
        const message = window.i18n
            ? i18n.t('session.reconnectFailed').replace('{label}', label)
            : `Reconnect failed for ${label}`;
        window.showNotification(`${message}: ${data.error || ''}`.trim(), 'error');
    },

    /*
     * Credential route for a LIVE session's reconnect: password auth, or a
     * jump-host session whose bastion secret the server never stores.
     *
     * Deliberately does NOT close the session first. The modal submit path is
     * the ordinary connect route, so it produces a new session; the old one is
     * still alive until then, which is the point -- cancelling the modal leaves
     * the user exactly where they were instead of having destroyed their shell
     * to open a form.
     *
     * RECONNECT INTENT, not a fresh connect. Reset and this route both end up in
     * the same modal, and before the fix that was the whole of the "Reconnect
     * behaves like Reset" defect: whatever the user had typed, the submit built
     * an ordinary connect payload and the old session's tmux name, transcript
     * and identity were whatever happened to be left in globals. The intent is
     * now registered under its own request id -- session id, exact tmux name,
     * display name, key and jump identity -- and the form-submit gate consumes
     * that exact request to emit ssh_connect WITH reconnect_tmux_name, adopt the
     * transcript and retire the old session exactly once.
     */
    prefillLiveReconnectForm(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return;

        const host = session.host;
        const port = session.port;
        const username = session.username;
        const displayName = session.displayName;
        const useTmux = session.useTmux;
        const tmuxSessionName = session.tmuxSessionName;
        const authType = session.authType || (session.keyId ? 'key' : 'password');

        const intent = this.beginReconnectIntent(sessionId, { ownsModal: true });
        if (!intent) return;

        window.clearConnectionProfileState();
        const hostInput = document.getElementById('hostInput');
        const portInput = document.getElementById('portInput');
        const userInput = document.getElementById('usernameInput');
        if (hostInput) hostInput.value = host;
        if (portInput) portInput.value = port;
        if (userInput) userInput.value = username;

        const authTypeSelect = document.getElementById('authTypeSelect');
        if (authTypeSelect) {
            authTypeSelect.value = authType;
            authTypeSelect.dispatchEvent(new Event('change'));
        }

        // Same rule as prefillConnectionForm (defect 6): owning a tmux session
        // name is tmux intent, so a live reconnect of an attached session
        // reattaches instead of downgrading to a raw shell when the useTmux
        // flag alone is falsy. The NAME itself travels in the intent record, not
        // in a global the submit path may already have consumed.
        if (useTmux || tmuxSessionName) {
            const tmuxCheck = document.getElementById('useTmuxCheck');
            if (tmuxCheck) tmuxCheck.checked = true;
        }

        const modal = document.getElementById('connectionModal');
        if (window.ModalManager && modal) {
            window.ModalManager.open(modal);
        } else if (modal) {
            modal.classList.add('show');
        }

        /*
         * Say WHY a password is being asked for, and that nothing is being
         * thrown away. Without this the modal is indistinguishable from the one
         * Reset opens, which is how the two actions felt identical.
         *
         * The form itself carries the same statement (setConnectionFormIntent),
         * because a toast is transient and the modal is not: a user who reads
         * the form ten seconds later must still be able to tell a Reconnect from
         * a Reset.
         */
        const label = this.getDisplayLabel(sessionId, username, host);
        this.setConnectionFormIntent('reconnect', {
            label,
            tmuxSessionName: tmuxSessionName || null,
        });
        const prompt = window.i18n
            ? i18n.t('session.reconnectPasswordPrompt').replace('{label}', label)
            : `Enter the password for ${label} to reconnect. Your tmux session, `
              + 'history and notes are kept.';
        window.showNotification(prompt, 'info');
    },

    /*
     * MODAL DISMISSAL cleanup: the X button, Cancel, the outside-click dismiss,
     * and immediately before an ordinary New Connection opens the form. It means
     * "the user closed this form", so it clears everything the form was serving.
     *
     * Three things must happen together, and doing any one alone was a real
     * defect:
     *
     *   * pendingResetMeta cleared, or a later ordinary Connect inherits Reset's
     *     forced use_tmux:false and reconnect_tmux_name:null;
     *   * the reconnect intent that OWNS this modal cancelled, or a later
     *     ordinary Connect inherits its reconnect_tmux_name and reattaches a
     *     tmux session the user never asked for -- and its session stays
     *     permanently un-reconnectable behind the one-owner guard;
     *   * the banner hidden, or the form keeps claiming to serve an action it is
     *     not.
     *
     * THE OWNER ID IS CAPTURED FIRST, then that exact id is cancelled and
     * released. It used to end with a raw `activeReconnectRequestId = null`,
     * which is the one write this class must never make outside
     * releaseReconnectModal: between capture and clear the owner can change (a
     * cancel handler, a reply landing), and a blind null would then free a modal
     * belonging to a DIFFERENT request -- whose submit would find no intent and
     * build an ordinary connect payload with no reconnect_tmux_name. A silent
     * Reset. releaseReconnectModal only acts when the id still matches, so a
     * changed owner is left alone.
     *
     * An in-flight reconnect that does NOT own the modal is untouched: it is on
     * the wire, and closing a form cannot un-send it.
     *
     * NOT for a server error. An error names ONE request, and
     * abandonReconnectRequest is that scope -- using this instead would let an
     * unrelated failure wipe a Reset the user is still typing into.
     *
     * Deliberately NOT called while intentionally opening a reconnect or reset
     * form: those set the state this clears.
     */
    resetConnectionModalIntent() {
        // A dismissed Reset form must also drop its candidate-retirement record,
        // or a later unrelated ssh_connected could retire a candidate the user
        // decided not to reset.
        const reset = this.pendingResetMeta;
        if (reset && reset.requestId) this.abandonResetRequest(reset.requestId);
        // A dismissed credential form ends the attempt BEFORE any
        // reset intent exists (the form sits between confirm and emit), so
        // abandonResetRequest alone cannot release the double-trigger guard --
        // release it by the session this form was serving.
        if (reset && reset.sessionId) {
            this.releaseInFlightCandidateReset(reset.sessionId);
        }
        this.pendingResetMeta = null;
        const owner = this.activeReconnectRequestId;
        if (owner) {
            this.cancelReconnectIntent(owner);
            this.releaseReconnectModal(owner);
        }
        this.setConnectionFormIntent(null);
    },

    /*
     * A failed connect, named by its exact client_request_id.
     *
     * SCOPE IS THE POINT. It drops only that request's intent, and releases the
     * credential modal only if that same request owns it. It never touches
     * pendingResetMeta and never hides a banner belonging to something else, so
     * a background reconnect failing while the user is typing into a Reset form
     * leaves that form exactly as it was.
     *
     * Nothing is destroyed either way: the session or candidate chip was
     * deliberately kept while the request was in flight, so a failure means the
     * user is still where they started and can press again.
     */
    abandonReconnectRequest(requestId) {
        if (!requestId) return false;
        const cancelled = this.cancelReconnectIntent(requestId);
        this.releaseReconnectModal(requestId);
        return !!cancelled;
    },

    /*
     * State the ACTION the connection form is serving, for as long as it is open.
     *
     * Reconnect (credential route) and Reset share this one modal, which is what
     * made them indistinguishable: the confirm dialog states the difference once
     * and vanishes, and the form that follows looked identical for both. This
     * writes the difference into the form itself.
     *
     * `kind` is 'reconnect' | 'reset' | null. null clears -- an ordinary New
     * Connection must show nothing at all, so the banner is hidden rather than
     * left holding the last action's words.
     *
     * The sprite path is taken from the icon already in the document, so this
     * needs no knowledge of the static URL or its cache-bust pin.
     */
    setConnectionFormIntent(kind, { label = '', tmuxSessionName = null, fromCandidate = false } = {}) {
        const box = document.getElementById('connectionFormIntent');
        const titleEl = document.getElementById('connectionFormIntentTitle');
        const detailEl = document.getElementById('connectionFormIntentDetail');
        const iconEl = document.getElementById('connectionFormIntentIcon');
        if (!box) return;
        if (!kind) {
            box.hidden = true;
            if (titleEl) titleEl.textContent = '';
            if (detailEl) detailEl.textContent = '';
            return;
        }
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        const isReset = kind === 'reset';
        const title = isReset
            ? t('session.formIntentReset', 'Reset: a fresh session')
            : t('session.formIntentReconnect', 'Reconnect: your session is kept');
        const detail = isReset
            // The credential-form banner states WHICH Reset this is.
            // A live Reset kills what it replaces (tmux included); a candidate
            // Reset affects nothing on the remote host -- the same split the
            // confirmation copy makes, pinned to the same facts.
            ? (fromCandidate
                ? t('session.formIntentResetDetailCandidate',
                    'A fresh connection starts. Nothing running on the remote '
                    + 'host is affected.')
                : t('session.formIntentResetDetailLive',
                    'The active connection is terminated and its remote tmux '
                    + 'session is killed. A fresh session starts.'))
            : (tmuxSessionName
                ? t('session.formIntentReconnectTmux',
                    'Reattaching tmux: {tmux}').replace('{tmux}', tmuxSessionName)
                : t('session.formIntentReconnectDetail',
                    'The same session continues; its history is kept.'));
        if (titleEl) titleEl.textContent = label ? `${title} — ${label}` : title;
        if (detailEl) detailEl.textContent = detail;
        if (iconEl) {
            const base = (iconEl.getAttribute('href') || '').split('#')[0];
            iconEl.setAttribute('href',
                `${base}#icon-${isReset ? 'rotate-ccw' : 'plug-zap'}`);
        }
        box.hidden = false;
    },

    updateSessionStatus(sessionId, status) {
        // Sendability BEFORE the write, read from session state only, so a real
        // transition can be distinguished from a repeated status of the same
        // value. The connected creation path announces its own arrival, so this
        // comparison deliberately stays silent there (the object is already
        // connected:true when it calls in, hence not a change).
        const wasSendable = this.isSendableSession(this.sessions[sessionId]);

        const tab = document.getElementById(`tab-${sessionId}`);
        if (tab) {
            if (status === 'connected') {
                tab.classList.add('connected');
                tab.classList.remove('disconnected');
            } else if (status === 'disconnected') {
                tab.classList.remove('connected');
                tab.classList.add('disconnected');
            }

            const dot = tab.querySelector('.status-dot');
            if (dot) {
                dot.classList.remove('connected', 'disconnected', 'connecting');
                dot.classList.add(status);
            }
        }

        if (this.sessions[sessionId]) {
            this.sessions[sessionId].connected = (status === 'connected');
            // A dead transport has no latency; clearing it stops the last
            // measured figure from outliving the connection it described.
            if (status !== 'connected') {
                this.sessions[sessionId].latencyMs = null;
            }

            /*
             * D2a — the transport-loss promotion (Phase 0 live diagnostic, run
             * msruuq45, owner-approved fix).
             *
             * A LIVE session that loses its transport while still owning a valid
             * tmux identity IS a persistent candidate from that instant on: the
             * tmux session keeps running on the remote host exactly as it does
             * for a candidate restored from the database after a restart. But
             * the flag was only ever set by the DB-restore path (createSession),
             * so a killed-live session read "Session disconnected / Retry",
             * armed its reconnect intent with retireOnSuccess:false, and on a
             * successful retry the new session was created next to the dead
             * one — two chips for one logical session, and none of the honest
             * Reconnect copy.
             *
             * The promotion makes the WHOLE candidate machinery apply: the
             * overlay says "Persistent session / Reconnect", requestReconnect
             * takes the candidate branch (key/Tailscale direct, password
             * through requestCandidateReconnect with the reconnect intent), the
             * intent is armed with retireOnSuccess:true, and on success
             * completePendingReconnect carries the transcript across and
             * retires exactly the old chip. On failure nothing is removed —
             * the chip, its offer and its scrollback all survive to retry from.
             *
             * Guard conditions, each load-bearing:
             *   * only on the 'disconnected' write — a repeat or a 'connected'
             *     status must not re-touch the flag;
             *   * only when it is NOT already true, so a DB-restored candidate's
             *     record is never rewritten mid-reconnect;
             *   * only with a VALID tmux identity (same whitelist the server
             *     enforces). A session without one keeps the ordinary Retry
             *     copy, which is the honest surface for it.
             *
             * The overlay is read AFTER this promotion (see the status ===
             * 'disconnected' branch below), so the surface shown is already the
             * candidate one. A page reload is unaffected either way: the DB row
             * for a tmux session is is_persistent, and restore rebuilds the
             * candidate record from it.
             */
            if (status === 'disconnected'
                    && !this.sessions[sessionId].isPersistentCandidate
                    && this.hasValidTmuxIdentity(this.sessions[sessionId])) {
                this.sessions[sessionId].isPersistentCandidate = true;
            }
            // down, "user · NN ms" when up), so a status change must repaint it.
            this.updateSessionLabel(sessionId);
            if (this.lifecycleActionTargetId === sessionId) {
                const headingDot = document.getElementById('sessionActionsHeadingDot');
                if (headingDot) {
                    headingDot.className = 'status-dot'
                        + (status === 'connected' ? ' connected' : ' disconnected');
                }
            }
        }
        document.dispatchEvent(new CustomEvent('sshdeck:session-status-changed', {
            detail: { sessionId, status },
        }));

        if (status === 'disconnected') {
            this.showReconnectOverlay(sessionId);
        } else if (status === 'connected') {
            this.hideReconnectOverlay(sessionId);
        }

        // Announce only a real change of sendability, so repeating a status does
        // not republish. Arrival is announced by the creation path instead.
        if (this.isSendableSession(this.sessions[sessionId]) !== wasSendable) {
            this.notifySendableSessionsChanged();
        }
    },

    /*
     * S5 confirm dialog (mockup line 186), replacing window.confirm.
     *
     * The native dialog was wrong on three counts measured here: it ignores all
     * ten themes, it is invisible to the browser suites except as a stub, and on
     * a touch shell the tap that opens the sheet also dismisses it -- so Reset
     * was effectively unconfirmable on the exact surface the sheet exists for.
     *
     * onAccept is invoked ONLY from the accept button, so the caller's
     * destructive work stays gated exactly as `if (!confirm(...)) return;` gated
     * it. Cancel, Escape, and a backdrop tap all close without calling it.
     * Focus lands on Cancel, never on the danger button.
     *
     * FULLY PARAMETERIZED, and that is the defect-2 fix.
     *
     * Reconnect, Reset and Close share this one dialog. It used to write only
     * the TITLE; body, accept label, icon and danger class were static markup
     * fixed to Reset's copy. Measured on the deployed build
     * (tests/browser/defect2_action_semantics_probe.mjs): every one of the three
     * actions said "The current connection closes and a fresh session starts
     * without reattaching tmux", offered "Start fresh" in danger red under a
     * rotate-ccw icon. Reconnect therefore promised to DESTROY the tmux session
     * it exists to preserve, and Close promised to start a new one.
     *
     * Every field is now written on EVERY open -- including back to a default
     * when a caller omits it -- so nothing from a previous action can survive
     * into the next dialog. `danger` is explicit rather than inferred: Reconnect
     * is not destructive and must not be dressed as though it were.
     *
     * ONE PENDING CONFIRMATION AT A TIME, and that is the D3 duplicate-action
     * fix. Each open used to addEventListener a fresh onOk/onCancel pair without
     * detaching the previous one, and the markup fields it rewrites are shared,
     * so a second open produced a dialog showing ONE action while TWO were
     * armed. Measured before this: requestReconnect then requestResetSession on
     * the same session, then a single click on Accept, emitted ssh_reconnect
     * AND ssh_disconnect + ssh_connect -- the user read "Start a fresh session?"
     * and got a reconnect as well; Reset then Close ran closeSession twice.
     * Rapid repeated presses of one action stacked in the same way (two
     * performLiveReconnect runs from one click, saved from a second transport
     * only by the in-flight guard inside it).
     *
     * So a new open now dismisses whatever was pending first: exactly one
     * handler pair is attached, and the armed action is always the one whose
     * copy is on screen.
     */
    openSessionConfirm({ title, body, acceptLabel, icon, danger, onAccept, onDismiss }) {
        const dialog = document.getElementById('sessionConfirm');
        const backdrop = document.getElementById('sessionConfirmBackdrop');
        const titleEl = document.getElementById('sessionConfirmTitle');
        const bodyEl = document.getElementById('sessionConfirmBody');
        const iconEl = document.getElementById('sessionConfirmIcon');
        const cancelBtn = document.getElementById('sessionConfirmCancel');
        const acceptBtn = document.getElementById('sessionConfirmAccept');
        if (!dialog || !backdrop || !cancelBtn || !acceptBtn) {
            // No dialog in this document: run nothing rather than silently
            // performing a destructive action that was never confirmed.
            return false;
        }

        // Retire a still-pending confirmation before arming this one, so the
        // action on screen is the only action armed.
        if (typeof this.closeSessionConfirm === 'function') {
            this.closeSessionConfirm();
        }
        if (titleEl) titleEl.textContent = title || '';
        if (bodyEl) bodyEl.textContent = body || '';
        // The accept label is written as text, not as a data-i18n key: the
        // caller has already resolved it, and leaving a stale key on the element
        // Would let i18n.updatePageText silently retranslate this button back
        // to a DIFFERENT action's word on the next language change.
        acceptBtn.textContent = acceptLabel || '';
        acceptBtn.removeAttribute('data-i18n');
        if (bodyEl) bodyEl.removeAttribute('data-i18n');
        acceptBtn.classList.toggle('session-confirm-danger', danger === true);
        if (iconEl) {
            // The sprite path is taken from the icon already in the document, so
            // this needs no knowledge of the static URL or the cache-bust pin.
            const current = iconEl.getAttribute('href') || '';
            const base = current.split('#')[0];
            iconEl.setAttribute('href', `${base}#icon-${icon || 'circle-alert'}`);
        }

        const close = () => {
            dialog.hidden = true;
            dialog.setAttribute('inert', '');
            backdrop.hidden = true;
            cancelBtn.removeEventListener('click', onCancel);
            acceptBtn.removeEventListener('click', onOk);
            backdrop.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            // Only clear the registry if it still points at THIS dialog: a new
            // open has already replaced it and must not be disarmed by the
            // teardown of the one it replaced. The registry holds the DISMISS
            // closure (that is what fires the onDismiss hook), not close.
            if (this.pendingSessionConfirmClose === dismiss) {
                this.pendingSessionConfirmClose = null;
            }
        };
        // Dismiss = any close that is NOT an accept: cancel, Escape, backdrop,
        // Or a newer confirmation replacing this one (its close runs during
        // That open). hooks the guard release in here. onAccept runs
        // After close, so a dismissed dialog can never fire both paths.
        const dismiss = () => {
            close();
            if (typeof onDismiss === 'function') onDismiss();
        };
        const onCancel = () => dismiss();
        // Accept is one-shot: the handler is detached before the action runs, so
        // a second click landing while the action is still executing (a rapid
        // double press on a touch shell) cannot invoke it twice.
        const onOk = () => { close(); if (typeof onAccept === 'function') onAccept(); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
        };
        this.pendingSessionConfirmClose = dismiss;

        cancelBtn.addEventListener('click', onCancel);
        acceptBtn.addEventListener('click', onOk);
        backdrop.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);

        backdrop.hidden = false;
        dialog.hidden = false;
        dialog.removeAttribute('inert');
        cancelBtn.focus({ preventScroll: true });
        return true;
    },

    /*
     * Dismiss a pending session confirmation without running its action.
     *
     * The close routine lives inside openSessionConfirm's closure (it is what
     * detaches that dialog's own listeners), so it is published here on open and
     * called through this method. A no-op when nothing is pending, which is why
     * openSessionConfirm can call it unconditionally.
     */
    closeSessionConfirm() {
        const close = this.pendingSessionConfirmClose;
        if (typeof close !== 'function') return;
        this.pendingSessionConfirmClose = null;
        close();
    },

    // §12.6 Reset = a FRESH session WITHOUT tmux reattach. Destructive ⇒
    // confirm first. Preserves exactly seven non-secret fields: host, port,
    // username, authType, keyId, jumpHostId, displayName. Never a password.
    // Direct path (non-secret auth fully resolvable): one ssh_connect. Modal
    // path (any missing secret): opens prefilled modal, no autofocus, user
    // enters secrets, the form-submit gate consumes pendingResetMeta. A LIVE
    // session is closed exactly once before the emit; a CANDIDATE is retired only
    // by the matching ssh_connected (completePendingReset).
    requestResetSession(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return;

        /*
         * ONE candidate Reset in flight per candidate.
         *
         * A candidate Reset that has already been triggered and has not yet
         * reached its ack (confirmation open, credential form open, connect in
         * flight, retirement requested) must not be triggerable a second time:
         * one user action gets exactly ONE backend request and ONE replacement
         * lifecycle. A second trigger from any surface -- action sheet,
         * dropdown, a re-opened confirmation -- is refused here with a named
         * notification. A TRUE no-op: the armed attempt is not re-confirmed,
         * no dialog is opened, nothing is emitted, and -- deliberately -- the
         * mutual-exclusion block below does NOT run for the refused press, so
         * an in-flight reconnect the user had started is not cancelled by a
         * press that does nothing.
         *
         * Candidates only. A live Reset closes its session AT THE MOMENT OF
         * ITS EMIT (the old session ceases to exist), so a second trigger
         * finds nothing to re-reset; this guard must not block it. The guard
         * for live sessions remains the single-confirmation invariant.
         */
        if (session.isPersistentCandidate === true
                && this.hasInFlightCandidateReset(sessionId)) {
            const label = this.getDisplayLabel(sessionId, session.username,
                session.host);
            const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
            window.showNotification(t('session.resetAlreadyInFlight',
                'A Reset of "{label}" is already in progress.')
                .replace('{label}', label), 'info');
            return;
        }

        /*
         * MUTUAL EXCLUSION with a reconnect that owns the credential modal.
         *
         * Both actions end in the same form, and `pendingResetMeta` and an active
         * reconnect intent must never coexist: the submit gate reads both, and
         * Reset's branch wins, so a reconnect the user had already started would
         * be silently converted into a Reset -- its session left claimed forever
         * behind the one-owner guard, and its tmux name dropped from the payload.
         *
         * POLICY: CANCEL, explicitly. Reset is a deliberate, confirmed act on a
         * named session, and the reconnect it displaces is abandoned rather than
         * half-kept -- its intent is dropped and its claim released, so that
         * session stays reconnectable. Refusing instead would leave the user
         * pressing Reset with nothing happening and no way to see why.
         *
         * Done BEFORE the confirmation opens, so the state the dialog is armed
         * against is the state the submit will find.
         */
        const modalOwner = this.activeReconnectRequestId;
        if (modalOwner) {
            this.cancelReconnectIntent(modalOwner);
            this.releaseReconnectModal(modalOwner);
        }

        const label = this.getDisplayLabel(sessionId, session.username,
            session.host);
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        /*
         * A CANDIDATE is not a live connection, so Reset's ordinary copy would
         * be wrong on both halves: there is no "current connection" to close,
         * and what happens to the saved tmux session is NOT what the live copy
         * claims.
         *
         * Made the two halves EXPLICIT instead of merely not-wrong.
         * The live copy now states the destructive act precisely -- the active
         * connection is terminated and its remote tmux session is killed on
         * the target server -- because that is exactly what ssh_disconnect ->
         * close_session(kill_tmux=True) does for a session with a live
         * transport. The candidate copy states the opposite precisely -- a
         * fresh connection is started and NOTHING on the remote host is
         * affected -- because a candidate has no transport at all (that is
         * what makes it a candidate), and killing a tmux session needs one:
         * close_session finds no in-RAM entry and kills nothing. The two
         * wordings are the B8 requirement, and each is pinned to the fact it
         * states (tests/test_candidate_reset_lifecycle.py for the no-kill).
         *
         * WHEN that retirement happens is the other half, and it is not visible
         * in the copy: the correlated candidate_reset runs only after the
         * replacement session has arrived (completePendingReset). A cancelled
         * or failed Reset leaves the offer exactly where it was.
         *
         * Reset stays AVAILABLE on a candidate (it is the explicit route to a
         * clean session), stays confirmed, stays danger-styled, and is never
         * silently executed.
         */
        const isCandidate = session.isPersistentCandidate === true;
        const title = isCandidate
            ? t('session.resetCandidateConfirm',
                'Start a fresh "{label}" session and drop the saved one?')
                .replace('{label}', label)
            : t('session.resetConfirm',
                'End "{label}" and start a fresh session?')
                .replace('{label}', label);
        // Reset is the ONE destructive action of the three, and the only one
        // that discards tmux intent -- so it is the only one that gets the
        // danger button, and its body says exactly what is lost.
        const opened = this.openSessionConfirm({
            title,
            body: isCandidate
                ? t('session.resetCandidateBody',
                    'SSHDeck starts a fresh connection and stops offering this '
                    + 'saved candidate session. Nothing running on the remote '
                    + 'host is affected: its tmux session and every background '
                    + 'process keep running exactly as they are. Reconnect is '
                    + 'the action that returns to it. Profiles and notes are '
                    + 'kept.')
                : t('session.resetBody',
                    'The active connection is terminated and the remote tmux '
                    + 'session it runs is killed on the target server. A fresh '
                    + 'session starts without reattaching tmux. Profiles and '
                    + 'notes are kept.'),
            acceptLabel: isCandidate
                ? t('session.resetCandidateAccept', 'Drop and start fresh')
                : t('session.resetAccept', 'End session and start fresh'),
            icon: 'rotate-ccw',
            danger: true,
            onAccept: () => this.performResetSession(sessionId),
            /*
             * The guard is released on EVERY dismissal that is not an
             * accept -- cancel, Escape, backdrop, or this dialog being
             * replaced by a newer confirmation. The armed attempt ended
             * without an emit, so the candidate becomes resettable again
             * immediately. An ACCEPTED dialog keeps the guard armed across the
             * credential form, the ssh_connect and the retirement; only its
             * ack, its error, or a socket death releases it then.
             */
            onDismiss: () => this.releaseInFlightCandidateReset(sessionId),
        });
        /*
         * Arm the guard only when the confirmation actually opened.
         * A document without the dialog arms nothing and must block nothing.
         */
        if (opened && isCandidate) {
            this.beginInFlightCandidateReset(sessionId);
        }
    },

    /*
     * ── CANDIDATE-RESET RETIREMENT REGISTRY ─────────────────────────────────
     *
     * Request-keyed, exactly like `reconnectIntents`, and for the same reason: a
     * candidate Reset must not destroy anything until its replacement exists.
     *
     * WHY A LIVE RESET AND A CANDIDATE RESET CANNOT SHARE ONE LIFECYCLE. A live
     * Reset is deliberately destructive AT THE MOMENT OF THE EMIT: the user has
     * a running connection, they asked for a fresh one, and `closeSession` ->
     * `ssh_disconnect` closes it and kills its tmux. That is correct and stays.
     *
     * A candidate has no connection to close. Running the same code on it meant
     * `closeSession` -> `ssh_disconnect` -> the server DELETED the persistent DB
     * Row, and then `close_session` returned False because a candidate has no
     * entry in the in-RAM registry -- so the tmux was not killed either. The net
     * effect was: the saved offer was destroyed BEFORE the replacement connect
     * had succeeded, with nothing killed to show for it. A failed or cancelled
     * Reset therefore lost the offer permanently while leaving an orphan tmux
     * session on the host. That is strictly worse than doing nothing.
     *
     * So a candidate Reset now emits its fresh `use_tmux:false,
     * reconnect_tmux_name:null` payload and retires NOTHING. The chip, the DB
     * row, the lifecycle selection, the transcript, the notes and the label all
     * survive the modal, the submit and any failure. Only the `ssh_connected`
     * carrying THIS request's id retires that exact candidate, and it does so
     * with `removeSessionUI` -- never `closeSession`, so no `ssh_disconnect` is
     * emitted and no remote tmux is killed by a Reset that never had a transport.
     */
    resetIntents: {},

    getResetIntent(requestId) {
        return (requestId && this.resetIntents[requestId])
            ? this.resetIntents[requestId] : null;
    },

    /*
     * Record that ONE reset request, if it succeeds, retires ONE candidate.
     *
     * Only ever called for a candidate: a live Reset has already closed its
     * session by the time the frame goes out, so it has nothing left to retire.
     */
    beginCandidateResetIntent(sessionId, requestId) {
        if (!sessionId || !requestId) return null;
        const intent = { sessionId, requestId, fromCandidate: true };
        this.resetIntents[requestId] = intent;
        return intent;
    },

    takeResetIntent(requestId) {
        const intent = this.getResetIntent(requestId);
        if (!intent) return null;
        delete this.resetIntents[requestId];
        return intent;
    },

    /*
     * A reset request that will never complete: cancelled modal, or a server
     * error naming this exact request.
     *
     * Drops only the retirement record. The candidate itself is untouched -- its
     * chip, its persisted row, its selection, its notes and its label all
     * survive, which is the point: nothing was destroyed on the way out, so a
     * failure leaves the user able to try again.
     */
    abandonResetRequest(requestId) {
        const intent = this.takeResetIntent(requestId);
        if (!intent) return false;
        // A reset that will never complete releases its candidate's
        // double-trigger guard -- the candidate stays fully resettable. This
        // is the release for both the ssh_error arm (app.js's ssh_error
        // handler) and the dismissed-credential-form arm
        // (resetConnectionModalIntent), because both funnel through here.
        this.releaseInFlightCandidateReset(intent.sessionId);
        return true;
    },

    /*
     * ── ONE in-flight candidate Reset PER CANDIDATE ───────────────
     *
     * A candidate Reset is a multi-frame lifecycle, not a single emit:
     * confirmation dialog -> (credential form) -> ssh_connect -> ssh_connected
     * -> candidate_reset -> candidate_reset_ack. Every step before the ack is
     * "in flight", and during ALL of it a second trigger on the SAME candidate
     * must be a safe no-op: one user action, one backend request, one
     * replacement lifecycle. Without this guard a rapid second press -- a
     * double tap on a touch shell, a second menu pick, the same action
     * re-armed from another surface -- emitted a second ssh_connect for the
     * same saved offer and grew two replacement sessions out of one Reset.
     *
     * GRANULARITY IS THE POINT: the map is keyed by session id, so candidate
     * A mid-Reset blocks nothing on candidate B. An entry is armed by
     * requestResetSession (only when the confirmation dialog actually opens)
     * and released by exactly one terminal event --
     *
     *   * the success ack (completeCandidateRetirement),
     *   * the correlated retirement error (failCandidateRetirement),
     *   * a server error on the replacement connect, or a dismissed credential
     *     form (abandonResetRequest, above),
     *   * the socket dying (abortInFlightCandidateResets, called from app.js's
     *     disconnect handler), or
     *   * the confirmation dialog being cancelled, dismissed, or replaced by a
     *     newer one (its onCancel hook).
     *
     * A blocked re-trigger is a true no-op: it notifies the user, and emits
     * nothing, opens nothing, retires no dialog and cancels nothing.
     */
    candidateResetsInFlight: {},

    hasInFlightCandidateReset(sessionId) {
        return !!(sessionId && this.candidateResetsInFlight[sessionId]);
    },

    beginInFlightCandidateReset(sessionId) {
        if (sessionId) this.candidateResetsInFlight[sessionId] = true;
    },

    releaseInFlightCandidateReset(sessionId) {
        if (sessionId) delete this.candidateResetsInFlight[sessionId];
    },

    /*
     * The socket died with candidate Resets in flight. A reset whose frames
     * can no longer complete is no longer in flight: drop every guard so each
     * candidate becomes resettable again the moment the connection returns.
     * The candidate chips themselves survive -- that is
     * abortPendingCandidateRetirements' job, called one line away in app.js.
     */
    abortInFlightCandidateResets() {
        this.candidateResetsInFlight = {};
    },

    /*
     * The candidate retirement's FIRST half, correlated by `client_request_id`,
     * POST-SUCCESS ONLY.
     *
     * Called from the ssh_connected handler. An ordinary connect, a reconnect, or
     * a DIFFERENT reset finds no intent under its id and changes nothing -- so
     * replies arriving in any order cannot retire the wrong candidate.
     *
     * WHY THIS NO LONGER REMOVES ANYTHING, and what it does instead.
     * Two separate facts:
     *
     *   * WHEN. The pre-B5 bug was retiring the candidate BEFORE the replacement
     *     existed. B5 moved the retirement here, after the matching ssh_connected
     * correct, and kept. But it still retired through `closeSession`,
     *     whose `ssh_disconnect` answered NOTHING about the deletion: the chip
     *     came off the screen the instant the frame went out, and a failed or
     *     unauthorized deletion then left no row AND no offer, with the saved
     *     offer reappearing on the next reload. This is the atomicity B6 adds:
     *     this function only ASKS (candidate_reset), and the UI is purged only by
     *     The correlated ack -- see the registry below.
     *   * WHAT. `removeSessionUI` alone is still not enough: it drops the chip but
     *     leaves the PERSISTED row, so the discarded offer reappears as a
     *     candidate on the next reload. The saved row is server-side state; the
     *     correlated `candidate_reset` is now the path that owns it, deletes it
     *     in one transaction, and answers.
     *
     * NON-KILLING SEMANTICS, unchanged. `handle_candidate_reset` deletes the
     * row and calls `close_session(kill_tmux=False)`, which finds no in-RAM
     * entry for a candidate and kills nothing on the host -- the offer is
     * dropped, anything running there keeps running unattached, exactly what
     * the confirmation copy promises.
     *
     * The transcript is deliberately NOT adopted. Reset means a fresh session:
     * carrying the old history into it would make Reset indistinguishable from
     * Reconnect in the one place the user can actually see the difference.
     */
    completePendingReset(newSessionId, requestId) {
        const intent = this.takeResetIntent(requestId);
        if (!intent) return false;
        const oldId = intent.sessionId;
        if (!oldId || oldId === newSessionId) return false;
        if (!this.sessions[oldId]) return false;
        return this.requestCandidateRetirement(oldId);
    },

    /*
     * ── CANDIDATE RETIREMENT, CORRELATED ────────────────────────────
     *
     * The retirement of a candidate is a DATABASE act -- there is no transport
     * to close -- and B6's requirement is that the DB and the UI move together.
     * They did not before: `closeSession` emitted `ssh_disconnect` and removed
     * the chip in the same breath, so the UI asserted a deletion it had no
     * answer for. A failed or unauthorized deletion left the row on the server
     * and no chip on screen, and the offer came back on the next reload.
     *
     * So the chip now outlives the emit. `candidate_reset` carries a retirement
     * request id; the UI is purged ONLY by the `candidate_reset_ack` naming that
     * exact id, and a `candidate_reset_error` (or a socket that never answers)
     * leaves the candidate exactly as it was, with an error the user can see.
     *
     * Keyed by request id, like `reconnectIntents` and `resetIntents`, and for
     * the same reason: several retirements can be in flight, replies can arrive
     * in any order, and each must be able to find its own.
     */
    candidateRetirements: {},

    getCandidateRetirement(requestId) {
        return (requestId && this.candidateRetirements[requestId])
            ? this.candidateRetirements[requestId] : null;
    },

    /*
     * Ask the server to delete ONE candidate's saved row. Emits and records;
     * destroys nothing. Returns false when there is no socket to ask -- the
     * candidate is then left intact rather than removed on an assumption.
     */
    requestCandidateRetirement(sessionId) {
        if (!sessionId || !this.sessions[sessionId]) return false;
        if (!window.socket) return false;
        const requestId = `retire_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        this.candidateRetirements[requestId] = { sessionId, requestId };
        window.socket.emit('candidate_reset', {
            session_id: sessionId, request_id: requestId,
        });
        return true;
    },

    takeCandidateRetirement(requestId) {
        const record = this.getCandidateRetirement(requestId);
        if (!record) return null;
        delete this.candidateRetirements[requestId];
        return record;
    },

    /*
     * The ack: the row is provably gone, so the UI may now be purged.
     *
     * `removeSessionUI`, never `closeSession`: the server has already deleted
     * the row, and an `ssh_disconnect` on top of it would be a second
     * destructive request for a session that no longer exists server-side.
     * removeSessionUI is the sole owner of teardown -- it destroys the terminal
     * and its listeners, removes the chip, frees the pane, re-renders the
     * reconnect list, and re-decides selection safely (preserving an unrelated
     * lifecycle target).
     *
     * The session_id is verified against the record: an ack whose id does not
     * match the request's own session retires NOTHING, so a malformed or
     * crossed reply cannot purge the wrong chip.
     */
    completeCandidateRetirement(sessionId, requestId) {
        // Peek, validate, THEN consume: a crossed or malformed ack (right id
        // family, wrong session) must retire nothing AND must not destroy the
        // in-flight record, or a later honest ack for this session would find
        // nothing and the chip would never retire.
        const record = this.getCandidateRetirement(requestId);
        if (!record) return false;
        if (sessionId && sessionId !== record.sessionId) return false;
        if (!this.sessions[record.sessionId]) return false;
        delete this.candidateRetirements[requestId];
        // The ack is the Reset's terminal success event -- the
        // candidate's double-trigger guard is released here, never earlier.
        // beginCandidateResetIntent fires at EMIT time, where the connect is
        // still in flight; only the ack proves the replacement exists.
        this.releaseInFlightCandidateReset(record.sessionId);
        this.removeSessionUI(record.sessionId);
        return true;
    },

    /*
     * The error (or any correlated failure): keep everything.
     *
     * The row is still on the server, so the honest UI is the one that still
     * shows the offer. Only the retirement record is dropped, which leaves the
     * candidate resettable again. Returns the session id so the caller can name
     * it in the notification.
     */
    failCandidateRetirement(requestId) {
        const record = this.takeCandidateRetirement(requestId);
        if (!record) return null;
        // The correlated error is a terminal event -- the guard is
        // released so the kept candidate is resettable again at once.
        this.releaseInFlightCandidateReset(record.sessionId);
        return record.sessionId;
    },

    /*
     * The socket died with retirements in flight (B6's network-failure arm).
     *
     * An emit whose ack never arrives can have succeeded server-side or not --
     * there is no honest answer -- so the records are dropped and the
     * candidates are kept exactly as they are. Keeping is the truthful state in
     * every case: if the row is still there nothing was lost, and if the row is
     * gone the next restore/reload will simply stop offering it -- the one case
     * where the UI catches up by itself, with no orphan chip left behind. The
     * caller names the interruption to the user; the candidate is resettable
     * again at any time. Returns how many requests were abandoned.
     */
    abortPendingCandidateRetirements() {
        const ids = Object.keys(this.candidateRetirements);
        for (const id of ids) {
            delete this.candidateRetirements[id];
        }
        return ids.length;
    },

    performResetSession(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return;

        // Re-resolved here: the split moved the notification below out of the
        // scope that used to declare it.
        const label = this.getDisplayLabel(sessionId, session.username,
            session.host);

        const host = session.host;
        const port = session.port;
        const username = session.username;
        const keyId = session.keyId || null;
        const authType = session.authType || (keyId ? 'key' : 'password');
        const jumpHostId = session.jumpHostId || null;
        const displayName = session.displayName || null;
        /*
         * A CANDIDATE Reset retires NOTHING up front.
         *
         * The live path closes the old session immediately before its emit --
         * correct, because there IS a connection and the user asked to replace
         * it. A candidate has none, and running that same code deleted the
         * persisted offer (ssh_disconnect -> the server deletes the row) while
         * failing to kill the tmux (close_session returns False with no in-RAM
         * entry). So a cancelled or failed Reset destroyed the offer and left an
         * orphan pane. The candidate is now preserved through the whole attempt
         * and retired only by the reply carrying this request's id.
         */
        const isCandidate = session.isPersistentCandidate === true;

        // Constraint C: if a jump was recorded but the saved record is gone,
        // abort Reset — leave the session intact and emit nothing.
        const jh = (jumpHostId && window.JumpHostManager)
            ? window.JumpHostManager.getById(jumpHostId) : null;
        if (jumpHostId && !jh) {
            const notFound = window.i18n ? i18n.t('session.resetJumpNotFound')
                : 'Saved jump host not found; Reset cancelled.';
            window.showNotification(notFound, 'error');
            // The attempt ends here with nothing emitted -- release the
            // guard so the candidate stays resettable.
            if (isCandidate) this.releaseInFlightCandidateReset(sessionId);
            return;
        }

        // Collision-resistant fresh id (timestamp + random suffix).
        const requestId = `reset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

        // Modal credential path: target password; target key with no keyId;
        // jump password; jump key with no jh.key_id. Never direct-emit an
        // invalid key payload — defer to the modal so the user supplies it.
        const targetNeedsModal = authType === 'password'
            || (authType === 'key' && !keyId);
        const jumpNeedsModal = jh
            ? (jh.auth_type === 'password'
                || (jh.auth_type === 'key' && !jh.key_id))
            : false;
        if (targetNeedsModal || jumpNeedsModal) {
            // Never focus any input — the user chooses where to type.
            this.pendingResetMeta = {
                sessionId, requestId, displayName, jumpHostId,
                // The submit path needs to know which retirement rule applies:
                // a live session is closed at emit time, a candidate is retired
                // only by its own successful reply.
                fromCandidate: isCandidate,
            };
            window.clearConnectionProfileState();
            const hostInput = document.getElementById('hostInput');
            const portInput = document.getElementById('portInput');
            const userInput = document.getElementById('usernameInput');
            if (hostInput) hostInput.value = host;
            if (portInput) portInput.value = port;
            if (userInput) userInput.value = username;
            const authTypeSelect = document.getElementById('authTypeSelect');
            if (authTypeSelect) {
                authTypeSelect.value = authType;
                authTypeSelect.dispatchEvent(new Event('change'));
            }
            if (keyId) {
                setTimeout(() => {
                    const keySelect = document.getElementById('keySelect');
                    if (keySelect) {
                        for (const opt of keySelect.options) {
                            if (opt.value === keyId) { opt.selected = true; break; }
                        }
                    }
                }, 200);
            }
            if (jumpHostId) {
                const jhSel = document.getElementById('jumpHostSelect');
                if (jhSel) {
                    jhSel.value = jumpHostId;
                    // Constraint D: fire the existing change handler so the
                    // jump password/key UI shows. No focus.
                    jhSel.dispatchEvent(new Event('change'));
                }
            }
            const tmuxCheck = document.getElementById('useTmuxCheck');
            if (tmuxCheck) tmuxCheck.checked = false;
            // Reset and the credential reconnect share this modal, so the form
            // states which of the two it is serving for as long as it is open.
            // Without this the two are indistinguishable once the confirm dialog
            // Has closed -- which is exactly the reported defect. the
            // banner also states WHICH Reset this is -- live (terminates and
            // kills) or candidate (fresh connection, host untouched).
            this.setConnectionFormIntent('reset', { label, fromCandidate: isCandidate });
            const modal = document.getElementById('connectionModal');
            if (window.ModalManager && modal) {
                window.ModalManager.open(modal);
            } else if (modal) {
                modal.classList.add('show');
            }
            return;
        }

        // Direct path. Validate socket BEFORE closing anything: if no socket,
        // leave the old session intact and emit nothing.
        if (!window.socket) {
            // Same as above -- no emit means the attempt is over.
            if (isCandidate) this.releaseInFlightCandidateReset(sessionId);
            return;
        }

        const connectionData = {
            host: host,
            port: parseInt(port),
            username: username,
            client_request_id: requestId,
            auth_type: authType,
            use_tmux: false,
            reconnect_tmux_name: null,
            display_name: displayName
        };
        if (authType === 'key') connectionData.key_id = keyId;
        if (jh) {
            connectionData.proxy_jump = {
                host: jh.host, port: jh.port, username: jh.username,
                auth_type: jh.auth_type, key_id: jh.key_id
            };
        }
        // Register the request-keyed pending record BEFORE closing so the
        // ssh_connected handler can consume the non-secret metadata via
        // takePendingConnection (same path as ordinary connect).
        this.createPendingConnection(requestId, host, username, port, {
            authType, keyId, jumpHostId, displayName
        });
        if (isCandidate) {
            // ATOMIC for a candidate: emit first, retire on success only. The
            // offer, its chip, its selection and its label all survive a failure,
            // and no ssh_disconnect is sent for a session that has no transport.
            this.beginCandidateResetIntent(sessionId, requestId);
        } else {
            // A LIVE session is closed AFTER confirm, immediately before the
            // single emit. This is the destructive half of Reset and stays
            // exactly as it was: there is a real connection, and the user asked
            // for it to be replaced.
            this.closeSession(sessionId);
        }
        window.socket.emit('ssh_connect', connectionData);
        const note = window.i18n
            ? i18n.t('session.resetting').replace('{label}', label)
            : `Resetting ${label}...`;
        window.showNotification(note, 'info');
    },

    // Connections-bar lifecycle action sheet. The one 44px trigger and its
    // actions are the same DOM nodes at every viewport and orientation, so
    // one binding serves all of them without duplicating controls.
    // Opening/closing never routes focus to the composer, password fields or
    // xterm.
    lifecycleToolbarBound: false,
    // Three 44px rows plus the card's own padding: below this much room the
    // card flips above its chip rather than scrolling (positionLifecycleSheet).
    LIFECYCLE_SHEET_MIN_ROOM: 140,

    lifecycleTargetChip() {
        if (this.lifecyclePendingTargetId) {
            return document.getElementById(`pending-${this.lifecyclePendingTargetId}`);
        }
        return this.lifecycleActionTargetId
            ? document.getElementById(`tab-${this.lifecycleActionTargetId}`) : null;
    },

    positionLifecycleSheet() {
        const sheet = document.getElementById('sessionActionsSheet');
        const chip = this.lifecycleTargetChip();
        if (!sheet || !chip || sheet.hidden) return;
        const chipRect = chip.getBoundingClientRect();
        const gap = 7;
        const margin = 8;
        // Measure natural content first. If neither chip edge can anchor that
        // width inside the viewport, constrain the card on the roomier side;
        // the heading detail already ellipsizes and the mockup's 235px min-width
        // remains the CSS floor. This preserves a real chip edge instead of
        // detaching the card through a viewport-only clamp.
        sheet.style.maxWidth = '';
        sheet.style.maxHeight = '';
        const naturalRect = sheet.getBoundingClientRect();
        const roomForLeftEdge = window.innerWidth - margin - chipRect.left;
        const roomForRightEdge = chipRect.right - margin;
        const alignLeft = roomForLeftEdge >= roomForRightEdge;
        const available = alignLeft ? roomForLeftEdge : roomForRightEdge;
        if (naturalRect.width > available) {
            sheet.style.maxWidth = `${Math.floor(available)}px`;
        }
        const sheetRect = sheet.getBoundingClientRect();
        let left = alignLeft ? chipRect.left : chipRect.right - sheetRect.width;
        let top = chipRect.bottom + gap;
        if (left < margin) left = margin;
        if (left + sheetRect.width > window.innerWidth - margin) {
            left = window.innerWidth - margin - sheetRect.width;
        }
        if (top + sheetRect.height > window.innerHeight - margin) {
            /*
             * Not enough room below the chip. Flipping above it is right
             * when the chip sits low on the screen; for a chip in the top
             * strip of a SHORT viewport it is wrong, because "above" does
             * not exist either and the clamp to `margin` then lays the card
             * over the strip -- measured at 844x390 (phone landscape): a
             * 293px card under a chip ending at y=89 landed at y=8..301 and
             * took the neighbouring chips' centres (mobile_shell_layout.mjs
             * t8). So when at least three rows fit below, the card stays
             * below the chip and scrolls inside that room instead; the
             * sheet already carries overflow-y: auto for exactly this.
             */
            const roomBelow = window.innerHeight - margin - top;
            if (roomBelow >= this.LIFECYCLE_SHEET_MIN_ROOM) {
                sheet.style.maxHeight = `${Math.floor(roomBelow)}px`;
            } else {
                top = chipRect.top - gap - sheetRect.height;
            }
        }
        if (top < margin) top = margin;
        sheet.style.left = `${Math.round(left)}px`;
        sheet.style.top = `${Math.round(top)}px`;
        sheet.style.right = 'auto';
        sheet.style.bottom = 'auto';
    },

    closeLifecycleSheet({ restoreFocus = false } = {}) {
        const trigger = document.getElementById('sessionActionsBtn');
        const sheet = document.getElementById('sessionActionsSheet');
        if (!sheet) return;
        sheet.hidden = true;
        sheet.setAttribute('inert', '');
        sheet.setAttribute('aria-hidden', 'true');
        trigger?.setAttribute('aria-expanded', 'false');
        sheet.style.left = '';
        sheet.style.top = '';
        sheet.style.right = '';
        sheet.style.bottom = '';
        sheet.style.maxWidth = '';
        sheet.style.maxHeight = '';
        if (restoreFocus) {
            const chip = this.lifecycleTargetChip();
            if (chip) chip.focus({ preventScroll: true });
        }
    },

    toggleLifecycleSheet() {
        const trigger = document.getElementById('sessionActionsBtn');
        const sheet = document.getElementById('sessionActionsSheet');
        const hasSession = this.lifecycleActionTargetId
            && this.sessions[this.lifecycleActionTargetId];
        const hasPending = this.lifecyclePendingTargetId
            && this.pendingConnections[this.lifecyclePendingTargetId];
        if (!sheet || (!hasSession && !hasPending)) return;
        if (!sheet.hidden) {
            this.closeLifecycleSheet({ restoreFocus: true });
            return;
        }
        sheet.hidden = false;
        sheet.removeAttribute('inert');
        sheet.setAttribute('aria-hidden', 'false');
        trigger?.setAttribute('aria-expanded', 'true');
        this.positionLifecycleSheet();
    },

    /*
     * Open the action sheet, idempotently.
     *
     * Needed by the one-gesture select-and-open path (owner ruling,
     * defect 5). toggleLifecycleSheet cannot serve that: if the sheet is already
     * open for another chip, toggling would CLOSE it, so clicking a second
     * disconnected chip would select it and then hide the very menu the user
     * asked for. This opens unconditionally and repositions to the new target.
     */
    openLifecycleSheet() {
        const trigger = document.getElementById('sessionActionsBtn');
        const sheet = document.getElementById('sessionActionsSheet');
        const hasSession = this.lifecycleActionTargetId
            && this.sessions[this.lifecycleActionTargetId];
        const hasPending = this.lifecyclePendingTargetId
            && this.pendingConnections[this.lifecyclePendingTargetId];
        if (!sheet || (!hasSession && !hasPending)) return;
        sheet.hidden = false;
        sheet.removeAttribute('inert');
        sheet.setAttribute('aria-hidden', 'false');
        trigger?.setAttribute('aria-expanded', 'true');
        this.positionLifecycleSheet();
    },

    bindLifecycleToolbar() {
        if (this.lifecycleToolbarBound) return;
        const control = document.getElementById('sessionActionsControl');
        if (!control) return;
        document.getElementById('sessionActionsBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLifecycleSheet();
        });
        control.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-lifecycle-action]');
            if (!btn || btn.disabled) return;
            e.stopPropagation();
            this.closeLifecycleSheet();
            this.dispatchLifecycleAction(btn.dataset.lifecycleAction);
        });
        document.addEventListener('click', (e) => {
            if (!control.contains(e.target)) this.closeLifecycleSheet();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape'
                    && !document.getElementById('sessionActionsSheet')?.hidden) {
                e.preventDefault();
                this.closeLifecycleSheet({ restoreFocus: true });
            }
        });
        window.addEventListener('resize', () => this.positionLifecycleSheet());
        window.addEventListener('orientationchange', () =>
            requestAnimationFrame(() => this.positionLifecycleSheet()));
        this.lifecycleToolbarBound = true;
    },

    createPendingConnection(requestId, host, username, port, meta) {
        const tab = document.createElement('div');
        tab.className = 'session-tab';
        tab.id = `pending-${requestId}`;
        tab.dataset.pendingId = requestId;

        const statusDot = document.createElement('span');
        statusDot.className = 'status-dot connecting';

        // match the real chip's dot + two-line label inventory. The
        // pending request has no inline X; Cancel is the shared lifecycle row.
        const tabLabel = document.createElement('span');
        tabLabel.className = 'tab-label';
        const name = document.createElement('strong');
        name.className = meta?.displayName ? 'tab-display-name' : 'tab-host-name';
        name.textContent = meta?.displayName || host;
        const state = document.createElement('small');
        state.className = 'tab-user-name';
        state.textContent = window.i18n ? i18n.t('status.connecting') : 'Connecting';
        tabLabel.append(name, state);
        tab.append(statusDot, tabLabel);

        // Strict non-secret allowlist per request — no password can enter here.
        this.pendingConnections[requestId] = {
            host, username, port,
            authType: meta?.authType ?? null,
            keyId: meta?.keyId ?? null,
            jumpHostId: meta?.jumpHostId ?? null,
            displayName: meta?.displayName ?? null,
        };

        tab.setAttribute('role', 'tab');
        tab.setAttribute('tabindex', '0');
        tab.setAttribute('aria-selected', 'false');

        const LONG_PRESS_MS = 500;
        const MOVE_TOLERANCE_PX = 10;
        let pressPointerId = null;
        let pressX = 0;
        let pressY = 0;
        let longPressTimer = null;
        let suppressNextClick = false;
        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            pressPointerId = null;
        };
        const selectPending = () => {
            if (this.lifecyclePendingTargetId !== requestId) {
                this.setPendingLifecycleTarget(requestId);
            }
        };

        tab.addEventListener('pointerdown', (e) => {
            suppressNextClick = false;
            if (!TerminalManager.isTouchShell() || !e.isPrimary || e.button !== 0) return;
            cancelLongPress();
            pressPointerId = e.pointerId;
            pressX = e.clientX;
            pressY = e.clientY;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                pressPointerId = null;
                selectPending();
                suppressNextClick = true;
                this.toggleLifecycleSheet();
            }, LONG_PRESS_MS);
        });
        tab.addEventListener('pointermove', (e) => {
            if (pressPointerId === null || e.pointerId !== pressPointerId) return;
            if (Math.abs(e.clientX - pressX) > MOVE_TOLERANCE_PX
                    || Math.abs(e.clientY - pressY) > MOVE_TOLERANCE_PX) {
                cancelLongPress();
            }
        });
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
            tab.addEventListener(eventName, (e) => {
                if (pressPointerId !== null && e.pointerId !== pressPointerId) return;
                cancelLongPress();
            });
        }
        tab.addEventListener('click', (e) => {
            cancelLongPress();
            if (suppressNextClick) {
                suppressNextClick = false;
                e.stopPropagation();
                return;
            }
            if (e.target !== tab && !tab.contains(e.target)) return;
            if (e.detail > 1) return;
            if (this.lifecyclePendingTargetId === requestId) {
                e.stopPropagation();
                this.toggleLifecycleSheet();
                return;
            }
            selectPending();
        });
        tab.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            if (e.target !== tab) return;
            e.preventDefault();
            if (this.lifecyclePendingTargetId === requestId) {
                this.toggleLifecycleSheet();
                return;
            }
            selectPending();
        });

        document.getElementById('sessionTabs').appendChild(tab);
    },

    clearPendingConnection(requestId) {
        const wasTarget = this.lifecyclePendingTargetId === requestId;
        const tab = document.getElementById(`pending-${requestId}`);
        if (tab) {
            tab.remove();
        }
        delete this.pendingConnections[requestId];
        if (wasTarget) {
            this.setPendingLifecycleTarget(null);
        }
    },

    // Atomic consume-then-clear: returns the pending record for one requestId
    // and removes only its tab/record. Used by the ssh_connected handler so the
    // request-keyed metadata (jumpHostId etc.) is captured before the record is
    // cleared. Normal clear/cancel behavior (clearPendingConnection) is unused
    // on the success path.
    takePendingConnection(requestId) {
        const rec = this.pendingConnections[requestId] || null;
        this.clearPendingConnection(requestId);
        return rec;
    },

    getDisplayLabel(sessionId, username, host) {
        const session = this.sessions[sessionId];
        if (session && session.displayName) {
            return session.displayName;
        }
        return `${username}@${host}`;
    },

    /*
     * Mockup lines 87-89: every chip is
     *   <span class="tw5-dot"></span><span><strong>NAME</strong><small>…</small></span>
     * The <small> is the SECONDARY line and differs by surface:
     *   desktop (fine pointer) -- "root · 34 ms": the user AND this session's
     *     own SSH round-trip time.
     *   touch                  -- "root": just the user. A phone chip is 92px
     *     wide (spec 243) and cannot carry a latency figure legibly.
     *     dead transport has no user context worth showing and no latency.
     *
     * Latency is per session, measured on that session's own transport by
     * ssh_manager.measure_session_latency; it is absent until the first probe
     * answers, and the line degrades to the bare user rather than showing a
     * placeholder number.
     */
    chipSecondaryText(session) {
        if (!session) return '';
        if (!session.connected) {
            return window.i18n ? i18n.t('session.disconnectedShort') : 'Đã ngắt';
        }
        const user = session.username || '';
        const fine = !(window.TerminalManager
            && typeof TerminalManager.isTouchShell === 'function'
            && TerminalManager.isTouchShell());
        if (fine && typeof session.latencyMs === 'number') {
            return `${user} · ${session.latencyMs} ms`;
        }
        return user;
    },

    /*
     * The ONE strip indicator (mockup exception, documented at
     * createSessionTab).
     *
     * Visible ONLY when the backend's pane probe explicitly reports `true`:
     * the attached tmux pane was created before the UTF-8 locale fix and its
     * running shell cannot be retrofitted. `false` (measured fine) and `null`
     * (non-tmux, or a restored row nobody has reattached yet) keep the chip
     * at its mockup shape — dot + two-line label, nothing added — so a
     * healthy session gains no noise.
     *
     * The badge node is created unconditionally in createSessionTab and shown
     * by the `.legacy-locale` class here, so this one method is the sole
     * writer of the warning state across createSession, reconnect swap
     * (onReconnected) and restore. The lifecycle sheet's own annotation is
     * text inside headingDetail (renderLifecycleTarget), driven from the same
     * session field — the two surfaces share state, never DOM or class
     * ownership.
     */
    updateLegacyLocaleWarning(sessionId) {
        const session = this.sessions[sessionId];
        const tab = document.getElementById(`tab-${sessionId}`);
        if (!session || !tab) return;
        tab.classList.toggle('legacy-locale', session.legacyTmuxLocale === true);
    },

    renderTabLabelContent(labelEl, sessionId) {
        const session = this.sessions[sessionId];
        labelEl.innerHTML = '';
        if (!session) return;
        // <strong> + <small>, exactly the mockup's two-line chip body. The
        // display name wins over host when the user has set one; otherwise the
        // host is the name and the user moves to the secondary line, which is
        // what the mockup shows ("tiny" over "root · 34 ms").
        const nameEl = document.createElement('strong');
        nameEl.className = session.displayName
            ? 'tab-display-name' : 'tab-host-name';
        nameEl.textContent = session.displayName || session.host;
        labelEl.appendChild(nameEl);

        const smallEl = document.createElement('small');
        smallEl.className = 'tab-user-name';
        smallEl.textContent = this.chipSecondaryText(session);
        labelEl.appendChild(smallEl);
    },

    /*
     * Poll each connected session's own latency.
     *
     * One emit per connected session every 15s: the figure is a comfort
     * indicator, not telemetry, and each probe costs one SSH global request
     * whose reply is a REQUEST_FAILURE. Disconnected sessions are skipped --
     *
     * THE PROBES ARE SPREAD ACROSS THE INTERVAL, not fired together. Measured
     * before this: eight restored sessions emitted eight session_latency frames
     * with a wall-clock spread of 0 ms, and each reply then costs a server-side
     * SSH global request plus a chip repaint. A burst puts all of that on one
     * frame, and it lands on whatever the UI happens to be doing -- exactly the
     *
     * The stagger is the interval divided by the number of sessions, capped so a
     * large set still finishes well inside one cycle and a small set does not
     * drift far from its own schedule. Each cycle re-reads the session list, so
     * sessions appearing or leaving simply change the next cycle's spacing.
     */
    LATENCY_POLL_INTERVAL_MS: 15000,
    LATENCY_PROBE_MAX_STAGGER_MS: 1200,

    startLatencyPolling() {
        if (this.latencyPollTimer) return;
        this.latencyProbeTimers = this.latencyProbeTimers || [];
        const probe = () => {
            if (!window.socket || !window.socket.connected) return;
            // Any stagger still pending from the previous cycle is void: its
            // sessions are re-derived below, and letting both cycles run would
            // double-probe whatever survived.
            this.clearPendingLatencyProbes();
            const ids = Object.entries(this.sessions)
                .filter(([, s]) => s && s.connected && !s.isPersistentCandidate)
                .map(([id]) => id);
            if (!ids.length) return;
            const step = Math.min(
                this.LATENCY_PROBE_MAX_STAGGER_MS,
                Math.floor(this.LATENCY_POLL_INTERVAL_MS / 2) / Math.max(ids.length, 1));
            ids.forEach((id, i) => {
                if (i === 0) {
                    window.socket.emit('session_latency', { session_id: id });
                    return;
                }
                const t = setTimeout(() => {
                    // The session may have gone while this probe waited its turn.
                    const s = this.sessions[id];
                    if (!s || !s.connected || s.isPersistentCandidate) return;
                    if (!window.socket || !window.socket.connected) return;
                    window.socket.emit('session_latency', { session_id: id });
                }, Math.round(step * i));
                this.latencyProbeTimers.push(t);
            });
        };
        probe();
        this.latencyPollTimer = setInterval(probe, this.LATENCY_POLL_INTERVAL_MS);
    },

    clearPendingLatencyProbes() {
        if (!this.latencyProbeTimers) return;
        this.latencyProbeTimers.forEach(t => clearTimeout(t));
        this.latencyProbeTimers.length = 0;
    },

    stopLatencyPolling() {
        // The staggered probes are part of the poll: leaving them armed would
        // emit for sessions after the poll that owns them was stopped.
        this.clearPendingLatencyProbes();
        if (this.latencyPollTimer) {
            clearInterval(this.latencyPollTimer);
            this.latencyPollTimer = null;
        }
    },

    applySessionLatency(sessionId, latencyMs) {
        const session = this.sessions[sessionId];
        if (!session) return;
        session.latencyMs = session.connected && typeof latencyMs === 'number'
            ? latencyMs : null;
        this.updateSessionLabel(sessionId);
        document.dispatchEvent(new CustomEvent('sshdeck:session-latency-changed', {
            detail: { sessionId, latencyMs: session.latencyMs },
        }));
    },

    updateSessionLabel(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }
        const tab = document.getElementById(`tab-${sessionId}`);
        if (!tab) {
            return;
        }
        const label = tab.querySelector('.tab-label');
        if (label) {
            this.renderTabLabelContent(label, sessionId);
        }
    },

    startRenameSession(sessionId, labelElement) {
        const session = this.sessions[sessionId];
        if (!session) return;

        const currentName = session.displayName || `${session.username}@${session.host}`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-rename-input';
        input.value = currentName;
        input.placeholder = `${session.username}@${session.host}`;

        labelElement.innerHTML = '';
        labelElement.appendChild(input);
        input.focus();
        input.select();

        // First invocation wins. Removing a focused input fires blur, whose
        // handler calls this again: the second call would throw NotFoundError on
        // the already-detached node and -- worse -- run with save=true, turning
        // an Escape cancel into a save. The guard is set BEFORE any removal so
        // the blur that removal triggers is already a no-op.
        let renameFinished = false;
        const finishRename = (save) => {
            if (renameFinished) return;
            renameFinished = true;
            const newName = input.value.trim();
            input.remove();

            if (save && newName && newName !== `${session.username}@${session.host}`) {
                session.displayName = newName;
                this.saveSessionDisplayName(sessionId, newName);
            } else if (save && !newName) {
                session.displayName = null;
                this.saveSessionDisplayName(sessionId, null);
            }
            this.renderTabLabelContent(labelElement, sessionId);
            this.updateSessionMeta(sessionId);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishRename(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishRename(false);
            }
        });

        input.addEventListener('blur', () => {
            finishRename(true);
        });

        input.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    },

    saveSessionDisplayName(sessionId, displayName) {
        const session = this.sessions[sessionId];
        // Save to localStorage by session ID
        try {
            const stored = JSON.parse(localStorage.getItem('sessionDisplayNames') || '{}');
            if (displayName) {
                stored[sessionId] = displayName;
            } else {
                delete stored[sessionId];
            }
            // Also save by host:port:user key so it survives session ID changes
            if (session) {
                const hostKey = `${session.host}:${session.port}:${session.username}`;
                if (displayName) {
                    stored[hostKey] = displayName;
                } else {
                    delete stored[hostKey];
                }
            }
            localStorage.setItem('sessionDisplayNames', JSON.stringify(stored));
        } catch (e) {
            console.error('Failed to save session display name:', e);
        }
        // Save to server DB
        if (window.socket) {
            window.socket.emit('save_session_name', {
                session_id: sessionId,
                display_name: displayName
            });
        }
    },

    getStoredDisplayName(sessionId, host, port, username) {
        try {
            const stored = JSON.parse(localStorage.getItem('sessionDisplayNames') || '{}');
            // Check by session ID first
            if (stored[sessionId]) return stored[sessionId];
            // Check by host:port:user key (persists across session ID changes)
            if (host && port && username) {
                const hostKey = `${host}:${port}:${username}`;
                if (stored[hostKey]) return stored[hostKey];
            }
            return null;
        } catch (e) {
            return null;
        }
    },

    updateSessionMeta(sessionId) {
        const meta = document.getElementById('sessionMeta');
        const titleEl = document.getElementById('sessionMetaTitle');
        const notesEl = document.getElementById('sessionMetaNotes');
        if (!meta || !titleEl || !notesEl) {
            return;
        }
        const session = this.sessions[sessionId];
        if (!session) {
            titleEl.textContent = window.i18n ? window.i18n.t('panes.emptyPane') : 'Empty pane';
            notesEl.textContent = window.i18n ? window.i18n.t('panes.selectSession') : 'Select a session or open a connection';
            notesEl.classList.add('empty');
            return;
        }

        titleEl.textContent = this.getDisplayLabel(sessionId, session.username, session.host);

        notesEl.textContent = `${session.username}@${session.host}:${session.port}`;
        if (session.viaJump) {
            const via = window.i18n ? i18n.t('connection.via') : 'via';
            notesEl.appendChild(document.createTextNode('  ·  '));
            const viaSpan = document.createElement('span');
            viaSpan.className = 'session-via';
            viaSpan.textContent = `${via} ${session.viaJump}`;
            notesEl.appendChild(viaSpan);
        }
        notesEl.classList.remove('empty');
    },

    ensureTerminalGrid() {
        return document.getElementById('terminalGrid');
    },

    /*
     * Pane cap for THIS device (amendment line 91: desktop 1-6, iPad 1-4, phone
     * 1-2). This is the engine's own copy of the policy and it is deliberately
     * authoritative, not advisory.
     *
     * Touch-action-row.js has an allowedLayouts that decides which options the
     * dropdown OFFERS. That is a rendering concern and it cannot be the only
     * enforcement, because two paths reach a layout without passing through a
     * menu option at all: the canonical .split-btn elements are hidden but still
     * Respond to Element.click, and a layout restored from localStorage on a
     * different device never goes through a button in the first place. Someone
     * who saves a 6-pane layout on a desktop and reopens the app on a phone must
     * not get six panes on a 390px screen.
     *
     * The two copies use the SAME queries in the same order, so they agree by
     * construction. If they ever disagree, this one wins -- the menu can only
     * ever offer a subset of what the engine permits.
     */
    layoutCap() {
        // Same canonical touch predicate every other consumer uses, read from
        // TerminalManager so the shell cannot disagree with itself about which
        // device it is (owner correction: primary capability as a
        // conjunction, so a hybrid desktop keeps the desktop 1-6 cap).
        const coarse = window.matchMedia(
            (typeof TerminalManager !== 'undefined' && TerminalManager.TOUCH_SHELL_QUERY)
            || '(pointer: coarse) and (hover: none), (max-width: 767px)').matches;
        if (!coarse) {
            return 6;
        }
        // A phone in landscape is WIDER than 767px, so width alone reads it as a
        // tablet. This is the shell's own phone-landscape test, so the phone cap
        // follows the device rather than the orientation.
        if (window.matchMedia(
            '(pointer: coarse) and (min-width: 768px) and (max-height: 500px)').matches) {
            return 2;
        }
        return window.matchMedia('(min-width: 768px)').matches ? 4 : 2;
    },

    /*
     * Clamp a requested layout to what this device allows. Returns the largest
     * permitted count rather than refusing outright: a restored 6-pane layout on
     * a phone should degrade to the phone's 2, not silently fail and leave the
     * user on whatever was there before.
     */
    clampLayout(layout) {
        const cap = this.layoutCap();
        const n = parseInt(layout, 10);
        if (!Number.isFinite(n) || n < 1) {
            return 1;
        }
        return Math.min(n, cap);
    },

    /*
     * A variant is only meaningful for the count it was defined against (v5
     * lines 103-108): 'rows' belongs to 2 panes and 'main' to 4. After a clamp
     * the count may no longer match, so the variant has to be re-validated or
     * the grid would get e.g. split-2 with the four-pane 'main' template.
     */
    normalizeVariant(layout, variant) {
        if (layout === 2 && variant === 'rows') {
            return 'rows';
        }
        if (layout === 4 && variant === 'main') {
            return 'main';
        }
        return 'default';
    },

    /*
     * Layout choice survives a reload (v5: the chosen layout is a workspace
     * preference, not a per-session one). Stored as a single key holding both
     * halves of the identity, because storing them separately would allow a
     * half-written pair to be read back.
     *
     * Never throws into the caller: localStorage is unavailable in private-mode
     * Safari and inside sandboxed iframes, and a layout preference is not worth
     * Breaking init over. Same defensive shape the display-name storage above
     * already uses.
     */
    saveLayoutPreference() {
        try {
            localStorage.setItem('terminalLayout', JSON.stringify({
                layout: this.layout,
                variant: this.layoutVariant,
            }));
        } catch (e) {
            /* storage unavailable -- the layout simply will not persist */
        }
    },

    readLayoutPreference() {
        try {
            const raw = localStorage.getItem('terminalLayout');
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            const layout = this.clampLayout(parsed.layout);
            return {
                layout,
                variant: this.normalizeVariant(layout, parsed.variant),
            };
        } catch (e) {
            return null;
        }
    },

    /*
     * WHICH SESSION THE USER WAS WORKING IN survives a reload.
     *
     * The same reasoning the layout preference above is built on: which pane
     * split the user chose is workspace state, and so is which connection they
     * were in. Nothing persisted it, so a cross-document return had no way to
     * answer "where was I" and simply selected whichever snapshot the server
     * happened to send -- on production, with no ORDER BY in
     * restore_user_sessions (socket_events.py:535), that is the LAST connected
     * row (measured six of six arrivals, /tmp/s35d/j1_run2.log: the user had
     * been in connect #1 and came back in connect #3).
     *
     * Written ONLY on a deliberate selection, never on a restore: see the call
     * site in setActivePane. So the value always names a session the user
     * really turned to, and a reload cannot record its own guess as if it were
     * an intention.
     *
     * Same defensive shape as the layout pair -- localStorage throws in
     * private-mode Safari and sandboxed iframes, and a selection memory is not
     * worth breaking a pane activation over.
     */
    saveActiveSessionPreference(sessionId) {
        try {
            if (sessionId) {
                localStorage.setItem('activeSessionId', String(sessionId));
            } else {
                localStorage.removeItem('activeSessionId');
            }
        } catch (e) {
            /* storage unavailable -- the selection simply will not persist */
        }
    },

    readActiveSessionPreference() {
        try {
            const raw = localStorage.getItem('activeSessionId');
            return raw || null;
        } catch (e) {
            return null;
        }
    },

    setSplitLayout(layout, variant) {
        const grid = this.ensureTerminalGrid();
        if (!grid) {
            return;
        }
        layout = this.clampLayout(layout);
        variant = this.normalizeVariant(layout, variant);
        if (this.layout === layout
            && this.layoutVariant === variant
            && this.paneAssignments.length === layout
            && !this.soloSessionId) {
            this.updateSplitControls();
            return;
        }
        const previousAssignments = this.paneAssignments.slice();
        this.layout = layout;
        this.layoutVariant = variant;
        this.paneAssignments = new Array(layout).fill(null);
        for (let i = 0; i < layout; i++) {
            this.paneAssignments[i] = previousAssignments[i] || null;
        }
        this.soloSessionId = null;
        this.renderWorkspace();
        if (this.activePaneIndex >= layout) {
            this.activePaneIndex = 0;
        }
        this.setActivePane(this.activePaneIndex);
        this.saveLayoutPreference();
        this.persistPaneIndexes();
    },

    /*
     * The ONE place the grid DOM is built from state. Solo: a single pane
     * holding soloSessionId, the split state left as it is. Otherwise one
     * pane per slot, each rendered from paneAssignments. Every wrapper that
     * is not shown is parked in #terminalsContainer with .unassigned.
     */
    renderWorkspace() {
        const grid = this.ensureTerminalGrid();
        if (!grid) {
            return;
        }
        const container = document.getElementById('terminalsContainer');
        if (container) {
            Object.values(this.sessions).forEach(session => {
                const wrapper = document.getElementById(session.terminalId);
                if (wrapper && wrapper.parentElement !== container) {
                    wrapper.classList.add('unassigned');
                    container.appendChild(wrapper);
                }
            });
        }
        grid.innerHTML = '';
        const solo = this.soloSessionId ? this.sessions[this.soloSessionId] : null;
        if (solo) {
            grid.className = 'terminal-grid split-1 solo';
            const pane = document.createElement('div');
            pane.className = 'terminal-pane active';
            pane.dataset.paneIndex = 'solo';
            const wrapper = document.getElementById(solo.terminalId);
            if (wrapper) {
                wrapper.classList.remove('unassigned');
                pane.appendChild(wrapper);
            }
            grid.appendChild(pane);
            this.updateSplitControls();
            return;
        }
        grid.className = this.gridClassName();
        for (let i = 0; i < this.layout; i++) {
            const pane = document.createElement('div');
            pane.className = 'terminal-pane';
            pane.dataset.paneIndex = String(i);
            pane.addEventListener('click', () => {
                this.setActivePane(i);
            });
            grid.appendChild(pane);
            this.renderPane(i);
        }
        grid.querySelectorAll('.terminal-pane').forEach(pane => {
            pane.classList.toggle('active', pane.dataset.paneIndex === String(this.activePaneIndex));
        });
        this.updateSplitControls();
    },

    // The row remembers its pane (owner ruling: pane_index lives on
    // the server so every device restores the same split). Only changes are
    // sent; a restore seeds sentPaneIndex from the row it came from.
    persistPaneIndexes() {
        if (!window.socket || typeof window.socket.emit !== 'function') {
            return;
        }
        Object.keys(this.sessions).forEach(sessionId => {
            const index = this.paneAssignments.indexOf(sessionId);
            const value = index === -1 ? null : index;
            // A session never reported is "no pane" on the server already.
            const previous = Object.prototype.hasOwnProperty.call(this.sentPaneIndex, sessionId)
                ? this.sentPaneIndex[sessionId] : null;
            if (previous === value) {
                return;
            }
            this.sentPaneIndex[sessionId] = value;
            window.socket.emit('session_pane_index', {
                session_id: sessionId, pane_index: value,
            });
        });
    },
    gridClassName() {
        const base = `terminal-grid split-${this.layout}`;
        return this.layoutVariant === 'default'
            ? base
            : `${base} split-${this.layout}-${this.layoutVariant}`;
    },

    refreshEmptyPanes() {
        this.paneAssignments.forEach((sessionId, index) => {
            if (!this.paneAssignments[index]) {
                this.renderPane(index);
            }
        });
    },

    renderPane(paneIndex) {
        const grid = this.ensureTerminalGrid();
        if (!grid) {
            return;
        }
        const pane = grid.querySelector(`.terminal-pane[data-pane-index="${paneIndex}"]`);
        if (!pane) {
            return;
        }
        /*
         * Relocate any terminal wrapper this pane holds BEFORE the
         * wipe below.
         *
         * `pane.innerHTML = ''` detaches EVERY child of this pane, and this
         * session's `.terminal-wrapper` is one of them whenever the pane
         * already holds it (assignSessionToPane at :3810 with an unchanged
         * pane is the reachable path). The `document.getElementById` a few
         * lines down then cannot find a node the wipe just removed from the
         * document, so its `if (wrapper)` is false and the wrapper is NEVER
         * re-appended: a 0x0 orphan whose AbortController-bound gesture
         * listeners (terminal-manager.js:1446) can no longer receive a touch,
         * and whose `.xterm-screen` has no box -- so xterm's
         * getMouseReportCoords cannot resolve and the row-E synthetic wheel is
         * dropped as well. Measured: s17_dom_probe.out Q1/Q6 BREAK while
         * Q2-Q5 and Q7-Q9 survive, and live T4 read wrapperInDoc=false with
         * paneW/paneH 0.
         *
         * Relocating first is exactly what the two SAFE clearing call sites
         * already do -- setSplitLayout (:3634) and applyPaneAssignments
         * (:4799) both move every wrapper to #terminalsContainer before
         * clearing -- so this is the guard renderPane was missing, not a new
         * mechanism. appendChild MOVES a node that is already in the document,
         * so nothing is ever removed and the listeners, focus and xterm
         * instance survive untouched.
         *
         * The `unassigned` class those two add is deliberately NOT added here:
         * they rebuild the whole grid, where a wrapper may end up genuinely
         * unassigned, whereas this function re-appends it into this same pane
         * a few lines below and removes the class again -- adding it would set
         * and clear it inside one frame.
         */
        const parkingContainer = document.getElementById('terminalsContainer');
        if (parkingContainer) {
            pane.querySelectorAll('.terminal-wrapper').forEach(held => {
                if (held.parentElement !== parkingContainer) {
                    parkingContainer.appendChild(held);
                }
            });
        }
        pane.innerHTML = '';
        // L8 / mockup line 161: every pane carries a label naming its session
        // and a number badge. Added FIRST and unconditionally, because
        // pane.innerHTML='' above wipes it on every re-render -- attaching it
        // after the branch below would skip it on the early return an assigned
        // session takes.
        pane.appendChild(this.buildPaneLabel(paneIndex));

        const sessionId = this.paneAssignments[paneIndex];
        if (sessionId) {
            const session = this.sessions[sessionId];
            if (!session) {
                return;
            }
            const wrapper = document.getElementById(session.terminalId);
            if (wrapper) {
                wrapper.classList.remove('unassigned');
                pane.appendChild(wrapper);
            }
            // One attach is one layout event, and this pane move triggers
            // both this call and the setActivePane/ResizeObserver requests that
            // follow. Routing through the coalesced fit OWNER folds them into a
            // single fitTerminal instead of one per source.
            TerminalManager.requestFit(sessionId);
            return;
        }

        const empty = typeof ProfileManager !== 'undefined'
            ? ProfileManager.createEmptyPaneContent(paneIndex)
            : document.createElement('div');
        if (!empty.className) {
            empty.className = 'pane-empty';
            empty.textContent = window.i18n ? i18n.t('panes.emptyPane') : 'Empty pane';
        }
        pane.appendChild(empty);
    },

    /*
     * The pane label (L8, mockup line 161): the session name plus a numbered
     * badge, up to 6 panes.
     *
     * aria-hidden, and deliberately so. The number is a VISUAL aid for telling
     * split panes apart; the pane's real accessible name comes from the
     * terminal wrapper inside it, and announcing "tiny 1" before every terminal
     * would be noise on a screen reader that already reads the session name.
     *
     * The name follows the same display-label resolution the session chips use,
     * so a renamed session shows its new name here too rather than reverting to
     * the host.
     */
    buildPaneLabel(paneIndex) {
        const label = document.createElement('div');
        label.className = 'pane-label';
        label.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        // The class carries the ellipsis
        // contract (deck.css) -- a bare span had no width cap and long host
        // names ran the label across the terminal content.
        name.className = 'pane-name';
        const sessionId = this.paneAssignments[paneIndex];
        const session = sessionId ? this.sessions[sessionId] : null;
        name.textContent = session
            ? this.getDisplayLabel(session.id, session.username, session.host)
            : '';
        label.appendChild(name);

        const badge = document.createElement('span');
        badge.className = 'pane-number-badge';
        badge.textContent = String(paneIndex + 1);
        label.appendChild(badge);

        return label;
    },

    assignSessionToPane(sessionId, paneIndex,
        { declareInteraction = true, displaceOccupant = true } = {}) {
        if (paneIndex === null || paneIndex === undefined) {
            return;
        }
        if (paneIndex < 0 || paneIndex >= this.paneAssignments.length) {
            return;
        }
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }

        const clearedIndices = [];
        this.paneAssignments = this.paneAssignments.map((existing, index) => {
            if (existing === sessionId) {
                clearedIndices.push(index);
                return null;
            }
            return existing;
        });

        if (this.paneAssignments[paneIndex] && this.paneAssignments[paneIndex] !== sessionId) {
            if (!displaceOccupant) {
                /*
                 * A RESTORE must not evict. Everything else this
                 * function does for a restore is passive bookkeeping, but the
                 * branch below performs the strongest act there is -- it takes
                 * a pane away from a session that is holding it. On the reload
                 * path restore_user_sessions (socket_events.py:535) delivers
                 * one snapshot per connected row with no ORDER BY, each falls
                 * back to the active pane once the empty ones are gone, and
                 * the LAST row evicts everything before it: measured on
                 * production (/tmp/s35d/j1_run2.log, six of six arrivals), the
                 * session the user was working in came back
                 * `terminal-wrapper unassigned`, display:none, rect 0x0, char
                 * Cell 0x0 (xterm 5.3.0 measures the cell once inside open,
                 * and in a display:none subtree that measurement is 0 with no
                 * retry) and still at its constructed 80x24 (fitTerminal skips
                 * an invisible terminal). A wheel over a display:none element
                 * Scrolls nothing -- that is the user's bullet 1. Rebuilding
                 * panes from a snapshot justifies placing THIS session
                 * somewhere; it never justifies un-placing ANOTHER one.
                 *
                 * Degrade to "stay parked": the wrapper keeps its `unassigned`
                 * state from createSession, the occupant keeps its pane, and
                 * the restored session is still selectable through its chip
                 * exactly as a disconnected one is. Callers that gate on this
                 * (restoreSession) also still run setActivePane, so the
                 * SELECTION question is answered separately from placement.
                 */
                this.paneAssignments = this.paneAssignments.map((existing, index) => {
                    if (clearedIndices.includes(index)) {
                        return sessionId;
                    }
                    return existing;
                });
                return;
            }
            const oldSessionId = this.paneAssignments[paneIndex];
            const oldSession = this.sessions[oldSessionId];
            if (oldSession) {
                const wrapper = document.getElementById(oldSession.terminalId);
                if (wrapper) {
                    wrapper.classList.add('unassigned');
                    const container = document.getElementById('terminalsContainer');
                    if (container && wrapper.parentElement !== container) {
                        container.appendChild(wrapper);
                    }
                }
            }
        }

        this.paneAssignments[paneIndex] = sessionId;
        this.renderPane(paneIndex);
        clearedIndices.forEach(index => {
            if (index !== paneIndex) {
                this.renderPane(index);
            }
        });
        this.persistPaneIndexes();
        /*
         * A RESTORE is not the user turning to a pane.
         *
         * Every other route into this function is a deliberate act (a chip tap
         * through switchSession, a completed connect the user asked for, the pane
         * assignment modal), and its setActivePane rightly declares interaction
         * so the shared grid follows the pane the user moved to. restoreSession
         * is the exception: it runs while the page is loading, before the user
         * has touched anything, for every session the snapshot carries. Declaring
         * interaction there would hand the grid to whichever device merely
         * reloaded last -- a phone waking in a pocket taking the grid from a
         * desktop somebody is working in, which is the R5 defect this fix exists
         * to remove.
         *
         * preserveLifecycleTarget is deliberately NOT reused for this: that flag
         * also suppresses the lifecycle-target write, which a restore DOES want.
         * Two different questions, two flags.
         */
        this.setActivePane(paneIndex, { declareInteraction });
    },

    /*
     * W4 sole writer of the DISPLAYED selection (activePaneIndex +
     * activeSessionId), the counterpart to setLifecycleActionTarget's ownership
     * of the ACTION target.
     *
     * The two are different questions and must be answered independently:
     * "which terminal am I looking at" versus "which connection do the
     * Rename/Reconnect/Reset/Close controls address". Selecting a dead chip must
     * not evict a live pane, and activating a pane must not silently retarget a
     * deliberately chosen dead connection.
     *
     * Writing both fields here (never at a call site) is what makes the pair
     * atomic: no caller can leave activePaneIndex pointing at one pane while
     * activeSessionId names another pane's session, which is what made the
     * toolbar and the modals disagree about their subject.
     */
    setActivePane(paneIndex, {
        preserveLifecycleTarget = false, declareInteraction = true,
    } = {}) {
        const grid = this.ensureTerminalGrid();
        if (!grid) {
            return;
        }
        if (paneIndex < 0 || paneIndex >= this.paneAssignments.length) {
            return;
        }
        // Activating a pane always returns to the split: solo is a way of
        // LOOKING at an unassigned session, never a pane of its own.
        if (this.soloSessionId || grid.classList.contains('solo')) {
            this.soloSessionId = null;
            this.renderWorkspace();
        }
        this.activePaneIndex = paneIndex;
        grid.querySelectorAll('.terminal-pane').forEach(pane => {
            pane.classList.toggle('active', pane.dataset.paneIndex === String(paneIndex));
        });
        this.applyActiveSession(this.paneAssignments[paneIndex] || null,
            { preserveLifecycleTarget, declareInteraction });
    },

    setSolo(sessionId, { preserveLifecycleTarget = false, declareInteraction = true } = {}) {
        if (!this.sessions[sessionId]) {
            return;
        }
        this.soloSessionId = sessionId;
        this.renderWorkspace();
        this.applyActiveSession(sessionId, { preserveLifecycleTarget, declareInteraction });
    },

    /*
     * W4 sole writer of the DISPLAYED selection (activeSessionId): shared by
     * setActivePane (a pane's session) and setSolo (a session without a
     * pane), so every consumer of "the active session" -- meta, tabs, views,
     * focus, the remembered preference -- sees one path.
     */
    applyActiveSession(sessionId, { preserveLifecycleTarget = false, declareInteraction = true } = {}) {
        const previousSessionId = this.activeSessionId || null;
        this.activeSessionId = sessionId;
        if (!preserveLifecycleTarget) {
            this.setLifecycleActionTarget(sessionId);
        }
        this.updateSessionMeta(sessionId);
        document.querySelectorAll('.session-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.getAttribute('role') === 'tab') {
                tab.setAttribute('aria-selected', 'false');
            }
        });
        if (sessionId) {
            const tab = document.getElementById(`tab-${sessionId}`);
            if (tab) {
                tab.classList.add('active');
                if (tab.getAttribute('role') === 'tab') {
                    tab.setAttribute('aria-selected', 'true');
                }
            }
        }
        this.notifyActiveSessionChanged(previousSessionId, sessionId);
        this.focusActivePane();
        if (typeof TerminalManager !== "undefined" && TerminalManager.syncViews) {
            TerminalManager.syncViews();
        }
        if (sessionId) {
            if (!preserveLifecycleTarget && declareInteraction) {
                this.saveActiveSessionPreference(sessionId);
            }
            TerminalManager.requestFit(sessionId);
        }
    },
    composerOwnsInput() {
        const bar = document.getElementById('sessionBar');
        const input = document.getElementById('mobileInput');
        if (!bar || !input) {
            return false;
        }
        return bar.offsetParent !== null && input.offsetParent !== null;
    },

    focusActivePane() {
        const sessionId = this.activeSessionId;
        if (!sessionId) {
            return;
        }
        const terminal = TerminalManager.terminals[sessionId];
        if (!terminal) {
            return;
        }
        /*
         * The Notes exception, at the TOP of the function.
         *
         * Every focus route in the shell funnels through here (tab click, tab
         * swipe, setActivePane, connect completion, restore/reconnect, pane tap,
         * gesture recovery, search close, exit-scroll), and NONE of them may
         * take the keyboard away from a focused Notes textarea: the rest of the
         * note would then be typed into whatever this function focused -- the
         * the reported defect: the composer was contaminated with NOTE text.
         * A4/A5/A6 steal to xterm-helper-textarea on desktop.
         *
         * Placed here, immediately after the terminal lookup, because BOTH exits
         * below steal: the desktop composer-first return focuses #mobileInput,
         * And the fallthrough calls terminal.focus. One predicate covers both.
         * Same live-focus predicate the two terminal-manager.js siblings use
         * (:1381, :1422) -- read from document.activeElement, never from
         * body.notepad-focused, because the whole defect is those two writers
         * disagreeing for a frame.
         *
         * Returning early costs nothing else: the active session/pane and the
         * layout have already been updated by the caller before it reached this
         * function, and the fit is requested by setActivePane after it returns.
         */
        if (TerminalManager.notepadOwnsKeyboard()) {
            return;
        }
        /*
         * Desurgery: DESKTOP keystrokes go straight into xterm
         * (xterm.onData → emitTerminalInput → ssh_input). The composer-first
         * desktop branch that used to steal focus to #mobileInput is removed --
         * it routed desktop typing through the per-char streaming path, which
         * broke on WebKit (Safari could not type into tmux at all). Desktop now
         * Falls through to terminal.focus below.
         *
         * Touch is unchanged: it must not summon the soft keyboard from a
         * tab/pane tap, so it neither focuses the composer nor the terminal.
         */
        // v3 strict focus rule: on mobile/touch, only direct
        // intentional interaction with the composer may open the keyboard --
        // the user tapping/focusing #mobileInput itself, or the visible Send
        // button refocusing it when it was already active at press time (gated
        // in app.js). Every other caller funnels through this function: tab
        // click, tab swipe, assignment via setActivePane, new-connect
        // completion, restore/reconnect, pane tap, gesture recovery, search
        // close, exit-scroll. On mobile all of them must update the active
        // session/pane and layout ONLY -- never focus the composer and never
        // xterm's hidden textarea -- so here this function is a no-op. The
        // branch removed by this rule routed mobile focus to #mobileInput for
        // the Vietnamese Telex IME; that is the behaviour the owner rejected
        // (a tap on a connection tab must not summon the keyboard). Desktop is
        // Unchanged: the same callers keep terminal.focus.
        //
        // There is no raw-focus exception here: a double-tap wants raw terminal
        // focus, but its touchend suppresses the synthetic click, so this
        // Function never runs for it — it calls terminal.focus itself. That
        // isolated xterm interaction never routes to the composer either
        //
        // Capability, not width: a
        // touch tablet is a touch shell and must keep the no-focus contract,
        // while a hybrid that reports a fine primary pointer but any-pointer:
        // Coarse is still touch. isTouchShell mirrors the canonical CSS
        // query, so JS and CSS agree on which shells are touch.
        if (TerminalManager.isTouchShell()) {
            return;
        }
        terminal.focus();
    },

    getActiveTerminal() {
        const sessionId = this.activeSessionId;
        if (!sessionId) {
            return null;
        }
        return TerminalManager.terminals[sessionId] || null;
    },

    getActivePaneIndex() {
        return this.activePaneIndex;
    },

    getFirstEmptyPaneIndex() {
        return this.paneAssignments.findIndex(sessionId => !sessionId);
    },

    getEmptyPaneIndices() {
        return this.paneAssignments
            .map((sessionId, index) => (sessionId ? null : index))
            .filter(index => index !== null);
    },

    updateSplitControls() {
        document.querySelectorAll('.split-btn').forEach(btn => {
            const layout = parseInt(btn.dataset.layout, 10);
            // "2 ngang") would both read as selected.
            const variant = btn.dataset.variant || 'default';
            const selected = layout === this.layout && variant === this.layoutVariant;
            btn.classList.toggle('active', selected);
            // The class is styling only; assistive tech reads aria-pressed, so
            // the two have to move together or the announced state goes stale.
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
    },

    showReconnectOverlay(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }
        const container = document.getElementById(session.terminalId);
        if (!container) {
            return;
        }
        let overlay = container.querySelector('.session-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'session-overlay';
            const isPersistent = session.isPersistentCandidate;

            const card = document.createElement('div');
            card.className = 'session-overlay-card';

            const heading = document.createElement('h3');
            heading.dataset.i18n = isPersistent ? 'session.persistent' : 'session.disconnected';
            heading.textContent = isPersistent
                ? (window.i18n ? i18n.t('session.persistent') : 'Persistent session')
                : (window.i18n ? i18n.t('session.disconnected') : 'Session disconnected');
            card.appendChild(heading);

            const desc = document.createElement('p');
            desc.dataset.i18n = isPersistent
                ? 'session.persistentDescription'
                : 'session.disconnectedDescription';
            desc.textContent = isPersistent
                ? (window.i18n ? i18n.t('session.persistentDescription') : 'tmux session running on remote host. Reconnect to resume.')
                : (window.i18n ? i18n.t('session.disconnectedDescription') : 'Reconnect to resume your work.');
            card.appendChild(desc);

            const tmuxName = session.tmuxSessionName || '';
            if (tmuxName) {
                const tmuxInfo = document.createElement('p');
                // A class, not an inline font-size and opacity. The two values
                // said "smaller and dimmer than the text above" -- which is what
                // --text-secondary at the 12px meta step already means, and it
                // follows the theme where a fixed opacity does not.
                tmuxInfo.className = 'session-overlay-tmux';
                tmuxInfo.textContent = 'tmux: ' + tmuxName;
                card.appendChild(tmuxInfo);
            }

            const button = document.createElement('button');
            button.className = 'btn btn-primary';
            button.dataset.sessionId = sessionId;
            button.dataset.i18n = isPersistent ? 'session.reconnect' : 'session.retry';
            button.textContent = isPersistent
                ? (window.i18n ? i18n.t('session.reconnect') : 'Reconnect')
                : (window.i18n ? i18n.t('session.retry') : 'Retry');
            /*
             * THE FIFTH SURFACE, now routed through the ONE lifecycle owner.
             *
             * This button used to call prefillConnectionForm directly, which
             * skipped requestReconnect entirely -- so it showed none of the
             * separated Reconnect copy, took none of the candidate decisions
             * (key/Tailscale can reconnect with no form at all), and was the
             * surface a user actually meets on a dead terminal. From the outside
             * that read as "every reconnect/reset control opens the same
             * lose-tmux modal", because this one opened the connect form
             * unconditionally.
             *
             * requestReconnect is the lifecycle owner for all four entry points
             * (sheet, toolbar proxy, chip gesture, this overlay), so the action
             * is decided in one place and cannot drift per surface.
             */
            button.addEventListener('click', () => {
                this.requestReconnect(sessionId);
            });
            card.appendChild(button);

            overlay.appendChild(card);
            container.appendChild(overlay);
        }
        overlay.classList.remove('hidden');
    },

    hideReconnectOverlay(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }
        const container = document.getElementById(session.terminalId);
        if (!container) {
            return;
        }
        const overlay = container.querySelector('.session-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    },

    /*
     * Fill the connection form from an existing session record. FIELD FILLING
     * ONLY -- it decides no action and destroys nothing.
     *
     * It used to do both, and that was the defect. For a persistent candidate it
     * called removeSessionUI(sessionId) before the form opened, so the chip, the
     * offer, the lifecycle selection and the transcript were gone while the user
     * was still typing a password; cancelling left nothing to retry from, and a
     * failed connect left nothing at all. Retire-first-connect-later is Reset's
     * shape, not Reconnect's.
     *
     * The lifecycle decisions now live in requestReconnect (which branch) and
     * requestCandidateReconnect (register the intent, keep the chip, state the
     * intent in the form). The candidate's chip is retired by
     * completePendingReconnect once its replacement exists.
     */
    prefillConnectionForm(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }

        const authType = session.authType || (session.keyId ? 'key' : 'password');

        window.clearConnectionProfileState();
        const hostInput = document.getElementById('hostInput');
        const portInput = document.getElementById('portInput');
        const userInput = document.getElementById('usernameInput');
        if (hostInput) {
            hostInput.value = session.host;
        }
        if (portInput) {
            portInput.value = session.port;
        }
        if (userInput) {
            userInput.value = session.username;
        }

        const authTypeSelect = document.getElementById('authTypeSelect');
        if (authTypeSelect) {
            authTypeSelect.value = authType;
            authTypeSelect.dispatchEvent(new Event('change'));
        }

        // If persistent session with key_id, auto-select the key
        if (session.keyId) {
            setTimeout(() => {
                const keySelect = document.getElementById('keySelect');
                if (keySelect) {
                    for (let opt of keySelect.options) {
                        if (opt.value === session.keyId) {
                            opt.selected = true;
                            break;
                        }
                    }
                }
            }, 200);
        }

        /*
         * Pre-check tmux for any session that HAS a tmux identity, not only for
         * ones whose useTmux flag survived (owner ruling, defect 6:
         * Reconnect must preserve/reattach tmux by default and must never
         * silently hand back a raw shell).
         *
         * `useTmux` alone was not a safe test. A persistent candidate rebuilt
         * from the database, or a record whose flag was lost across a restore,
         * can carry a real tmuxSessionName with useTmux falsy -- and then this
         * left the checkbox clear, so the reconnect emitted use_tmux:false and
         * replaced the user's attached tmux session with a raw shell. Owning a
         * tmux session name IS tmux intent, so either signal now counts.
         *
         * Reset is the only intentional raw-shell route and is unaffected: it
         * emits use_tmux:false explicitly from performResetSession.
         *
         * WHERE THE NAME GOES. It used to go into the shared
         * `pendingReconnectTmux` global, which any other connection in flight
         * could blank or steal -- and then this form's submit emitted use_tmux
         * with NO name, i.e. a new tmux session where the user asked to reattach
         * one. It now goes into a request-keyed intent, exactly like the
         * candidate and live-reconnect routes.
         *
         * D2a (Phase 0 live diagnostic, run msruuq45; owner-approved fix
         *): the intent this route arms is now retireOnSuccess:true.
         *
         * WHY THIS CHANGED. The old code armed retireOnSuccess:false here, and
         * completePendingReconnect bailed on that flag -- so when an ordinary
         * DISCONNECTED session's Retry succeeded, the server created the new
         * session id NEXT TO the dead one: two chips for one logical session
         * (captured live: old chip kept, new chip added, same endpoint). The
         * tmux-loss variant of this surface also showed "Session disconnected /
         * Retry" copy where the session still owned a running tmux -- fixed by
         * the transport-loss promotion in updateSessionStatus, which sends that
         * route through the candidate branch before it can reach here.
         *
         * WHAT THE NEW CONTRACT IS. Every reconnect that reaches the credential
         * form through this path replaces a KNOWN disconnected logical session,
         * so success must retire exactly that session's UI record -- after the
         * replacement exists -- and carry its transcript across first. That is
         * completePendingReconnect's job, keyed by this request's id; nothing is
         * removed at arm time or at submit time. A FAILED attempt is untouched:
         * the ssh_error path abandons THIS request's intent (no retirement, no
         * transcript move) and the old chip, its scrollback and its offer all
         * survive to retry from. Cancelling the form is unchanged: it disarms
         * the intent and leaves the session exactly as it was.
         *
         * An ordinary CONNECT (never disconnected, never this function) arms no
         * intent at all, so this cannot ever retire a chip for a fresh
         * connection -- the retirement rule applies only to sessions this
         * function was asked to restore.
         */
        const hasTmuxIdentity = !!(session.useTmux || session.tmuxSessionName
            || session.isPersistentCandidate);
        const alreadyClaimed = !!(this.reconnectingSessions
            && this.reconnectingSessions[sessionId]);
        if (hasTmuxIdentity && !alreadyClaimed) {
            const tmuxCheck = document.getElementById('useTmuxCheck');
            if (tmuxCheck) {
                tmuxCheck.checked = true;
            }
            this.beginReconnectIntent(sessionId, {
                ownsModal: true, retireOnSuccess: true,
            });
        } else if (!alreadyClaimed) {
            /*
             * D2a second half: a DISCONNECTED session with no tmux identity
             * (the ordinary Retry surface) used to arm NO intent at all, which
             * is what left its dead chip in place on success -- the reply found
             * no intent and did nothing. It now arms the same request-keyed
             * intent, so success retires its chip and adopts its transcript via
             * the exact completePendingReconnect path. It carries no tmux name,
             * so the submit gate adds none: the payload stays a plain
             * ssh_connect that restores the logical session, unchanged.
             *
             * The one-owner guards all still hold: a session already mid-
             * reconnect refuses a second arm, and ownsModal refuses while
             * another request holds the credential form.
             */
            this.beginReconnectIntent(sessionId, {
                ownsModal: true, retireOnSuccess: true,
            });
        } else if (hasTmuxIdentity) {
            const tmuxCheck = document.getElementById('useTmuxCheck');
            if (tmuxCheck) {
                tmuxCheck.checked = true;
            }
        }

        const modal = document.getElementById('connectionModal');
        if (window.ModalManager && modal) {
            window.ModalManager.open(modal);
        } else if (modal) {
            modal.classList.add('show');
        }
    },

    /*
     * A candidate whose credential the SERVER can supply on its own: a stored
     * key, or a tailnet identity. No form, no password prompt -- one ssh_connect
     * that reattaches the exact tmux session by name.
     *
     * IT NO LONGER REMOVES THE CHIP FIRST. removeSessionUI(sessionId) used to run
     * before the emit, which is Reset's shape, not Reconnect's: the offer, its
     * chip, its lifecycle selection and its transcript were destroyed while the
     * connection was still being attempted, so a failure left the user with
     * nothing to retry from and the transcript handoff with no source. The chip
     * is now retired by completePendingReconnect, once the replacement session
     * actually exists, with its transcript carried across first -- the same rule
     * the password route follows, so both candidate routes preserve the same
     * things.
     */
    /*
     * AUTO-RESTORE, NARROWED TO ONE SESSION AND TO A FREE LIFECYCLE.
     *
     * THE DEFECT THIS REPLACES, and the seven checks that proved it. Both
     * `persistent_session_available` branches used to fire
     * `directReconnect(session_id)` for EVERY arriving key/Tailscale candidate.
     * `directReconnect` arms a reconnect INTENT, and `beginReconnectIntent`
     * deliberately refuses to arm a second intent for a claimed session -- that
     * refusal is what stops a double press emitting two `ssh_connect` for one
     * tmux session. So the automatic path did not merely reconnect too much: it
     * CONSUMED THE INTENT THE USER'S OWN ACTION NEEDED, and the user's Reconnect
     * then emitted nothing at all.
     *
     * Measured in tests/browser/mobile_reconnect_list.mjs, 7 failures, all one
     * cause:
     *   candidate arrival                    got [ssh_connect]      want []
     *   no reconnect without the user choosing
     *                                        got [ssh_connect x2]   want []
     *   the direct Reconnect control accepts a key offer
     *                                        got emits []           want 1 emit
     *   one tap on a candidate chip          got emitted=2          want 0
     *   Reconnect that session and no other  got [alpha, beta]      want [beta]
     *   the offer is retired by its own ssh_connected
     *                                        got hasRequestId=false want true
     * The pair "arrival emitted" + "the user's own control emitted nothing" is
     * the signature of the stolen intent, not of two separate bugs.
     *
     * THREE CONDITIONS, each closing one of those rows:
     *
     *  1. CREDENTIALLESS ONLY. A password candidate has no stored secret, so it
     *     was always user-driven and stays so.
     *
     *  2. ONLY THE SESSION THE USER WAS ACTUALLY ON. `activeSessionId` in
     *     localStorage is the app's own record of the last active pane
     *     (saveActiveSessionPreference / readActiveSessionPreference). Restoring
     *     Exactly that one keeps the feature the user asked for -- come back and
     *     the session you were using is live -- while the rest stay OFFERS the
     *     user can accept. With no stored preference nothing is restored
     *     automatically, which is the honest default: the app does not know which
     *     session the user meant.
     *
     *  3. NEVER WHILE A USER-DRIVEN RECONNECT IS IN FLIGHT. If an intent is
     *     already active, the user is mid-action and the automatic path must not
     *     compete for the lifecycle it would win by arriving first.
     *
     * Deferred with setTimeout exactly as before, so the caller finishes building
     * the candidate record before any emit reads it.
     */
    maybeAutoRestore(sessionId, authType) {
        if (authType !== 'key' && authType !== 'tailscale') return false;
        const session = this.sessions[sessionId];
        if (!session || !session.isPersistentCandidate) return false;
        // (3) the user owns the lifecycle whenever they are already using it
        if (this.activeReconnectIntent()) return false;
        // (2) exactly the session the user was on, never the whole list
        const preferred = this.readActiveSessionPreference();
        if (!preferred || preferred !== sessionId) return false;
        setTimeout(() => {
            // Re-check on the deferred turn: an offer can be accepted by hand, or
            // another reconnect can start, between scheduling and running.
            const still = this.sessions[sessionId];
            if (!still || !still.isPersistentCandidate) return;
            if (this.activeReconnectIntent()) return;
            this.directReconnect(sessionId);
        }, 0);
        return true;
    },

    directReconnect(sessionId) {
        const session = this.sessions[sessionId];
        if (!session || !session.isPersistentCandidate) {
            return;
        }
        if (!window.socket) return;
        // Same boundary as the credential route: no valid tmux name, no
        // reconnect. Emitting use_tmux:true with a null name would create a NEW
        // tmux session -- Reset's outcome under Reconnect's label.
        if (!this.refuseReconnectWithoutTmuxIdentity(sessionId)) return;
        // One lifecycle owner: a second press while this reconnect is in flight
        // must not emit a second ssh_connect for the same tmux session. The
        // registry refuses to arm a second intent for a claimed session.
        const intent = this.beginReconnectIntent(sessionId);
        if (!intent) return;

        const host = session.host;
        const port = session.port;
        const username = session.username;
        const keyId = session.keyId;
        const authType = intent.authType;
        const tmuxSessionName = intent.tmuxSessionName;
        const displayName = intent.displayName;

        const connectionData = {
            host: host,
            port: parseInt(port),
            username: username,
            client_request_id: intent.requestId,
            auth_type: authType,
            use_tmux: true,
            // From the INTENT record, which is keyed by this request. The old
            // code read a shared global here, so a second connection in flight
            // could blank it and this emit became use_tmux with no name -- a new
            // tmux session where the user asked to reattach one.
            reconnect_tmux_name: tmuxSessionName,
            // A reattach CLAIM names its source. The server binds the
            // name to exactly this persistent row (same user, host, port and
            // username) and refuses it otherwise (socket_events.py's
            // handle_ssh_connect, pinned by test_b5_reconnect_validation.py) --
            // a claim WITHOUT the id is refused as "Reconnect requires the
            // source session id", so the direct route must carry it exactly as
            // the credential-form route does (app.js).
            session_id: sessionId,
            display_name: displayName
        };
        if (authType === 'key') {
            connectionData.key_id = keyId;
        }
        // The request-keyed pending record carries the display name across the
        // round trip, so no global handoff is needed: ssh_connected consumes it
        // by client_request_id (takePendingConnection), which is the same
        // correlation the intent registry uses.
        this.createPendingConnection(intent.requestId, host, username, port, {
            authType, keyId: keyId || null,
            jumpHostId: session.jumpHostId || null, displayName,
        });
        window.socket.emit('ssh_connect', connectionData);
        const label = this.getDisplayLabel(sessionId, username, host);
        const message = window.i18n
            ? i18n.t('session.reconnecting').replace('{label}', label)
            : `Reconnecting to ${label}...`;
        window.showNotification(message, 'info');
    },

    // Set ONLY by requestResetSession's modal path; { sessionId, requestId,
    // displayName, jumpHostId }. Non-secret. Consumed before the reset emit;
    // cancelled by connection-modal close/Cancel. Never a password field.
    pendingResetMeta: null,

    /*
     * The transcript handoff, kept out of app.js so both the reconnect and the
     * reload-restore paths can use one implementation.
     *
     * Called from the ssh_connected handler with the id the server has just
     * created AND the client_request_id it came back with. The request id is what
     * makes this exact: the intent is looked up by it, so
     *
     *   * an ORDINARY connect completing between two reconnects finds no intent
     *     and does nothing -- it cannot adopt a candidate's transcript or retire
     *     its chip;
     *   * two reconnects in flight cannot retire each other's session, in either
     *     response order;
     *   * a reply for a request already consumed is a no-op.
     *
     * It moves the previous session's transcript across and then retires the old
     * session with removeSessionUI -- NOT closeSession, because closeSession
     * emits ssh_disconnect, which kills the very tmux session the new connection
     * has just reattached to (socket_events.py -> close_session(kill_tmux=True)).
     * That single distinction is the difference between a reconnect and a reset.
     */
    completePendingReconnect(newSessionId, requestId) {
        // No id, no match: an ordinary connect must never consume an intent.
        const meta = this.takeReconnectIntent(requestId);
        if (!meta) return false;
        // This request's modal (if it held one) is done with. Exact equality, so
        // a request that never owned the modal cannot close someone else's.
        this.releaseReconnectModal(requestId);
        const oldId = meta.sessionId;
        if (!oldId || oldId === newSessionId) return false;
        // D2a: every route that arms an intent now
        // arms it with retireOnSuccess:true -- including the ordinary
        // disconnected Retry, which used to arm none/false and so left its dead
        // chip next to the new session. The check stays as the boundary for any
        // future intent that must NOT retire: retirement happens ONLY here,
        // ONLY for this request, ONLY after the replacement session exists.
        if (meta.retireOnSuccess !== true) return false;

        if (window.TerminalManager
                && typeof TerminalManager.adoptTranscript === 'function') {
            TerminalManager.adoptTranscript(oldId, newSessionId);
        }
        if (this.sessions[oldId]) {
            this.removeSessionUI(oldId);
        }
        return true;
    },

    getActiveSession() {
        return this.activeSessionId;
    },

    getLifecycleActionTarget() {
        return this.lifecycleActionTargetId;
    },

    lifecycleEndpoint(session) {
        if (!session) return '';
        const port = session.port === undefined || session.port === null
            || session.port === '' ? '' : `:${session.port}`;
        return `${session.username}@${session.host}${port}`;
    },

    renderLifecycleTarget() {
        const pendingId = this.lifecyclePendingTargetId;
        const pending = pendingId ? this.pendingConnections[pendingId] : null;
        const id = this.lifecycleActionTargetId;
        const session = id ? this.sessions[id] : null;
        const headingName = document.getElementById('sessionActionsHeadingName');
        const headingDetail = document.getElementById('sessionActionsHeadingDetail');
        const headingDot = document.getElementById('sessionActionsHeadingDot');
        const closeLabel = document.querySelector('#sessionActionClose span');

        if (headingDetail) {
            if (session || pending) {
                // Dynamic metadata owns this node while a target exists. Removing
                // the declarative owner prevents i18n.updatePageText from replacing
                // it before languageChanged rebuilds translated fragments.
                headingDetail.removeAttribute('data-i18n');
            } else {
                headingDetail.dataset.i18n = 'session.selectedHint';
                headingDetail.textContent = window.i18n
                    ? i18n.t('session.selectedHint')
                    : 'Selected · tap again or long-press';
            }
        }

        if (pending) {
            const cancel = window.i18n
                ? i18n.t('session.cancelConnection') : 'Cancel connection';
            if (headingName) headingName.textContent = pending.displayName
                || `${pending.username}@${pending.host}`;
            if (headingDetail) {
                headingDetail.textContent = `${this.lifecycleEndpoint(pending)} · ${cancel}`;
            }
            if (headingDot) headingDot.className = 'status-dot connecting';
            if (closeLabel) {
                closeLabel.dataset.i18n = 'session.cancelConnection';
                closeLabel.textContent = cancel;
            }
            return;
        }

        if (headingName) {
            headingName.textContent = session
                ? this.getDisplayLabel(id, session.username, session.host) : '';
        }
        if (headingDetail && session) {
            const details = [this.lifecycleEndpoint(session)];
            if (session.viaJump) {
                const via = window.i18n ? i18n.t('connection.via') : 'via';
                details.push(`${via} ${session.viaJump}`);
            }
            if (session.useTmux) {
                const persistent = window.i18n
                    ? i18n.t('session.persistent') : 'Persistent session';
                details.push(session.tmuxSessionName
                    ? `${persistent} · tmux: ${session.tmuxSessionName}`
                    : `${persistent} · tmux`);
            }
            // State the pane's locale limitation next to the tmux
            // identity the user is already told about. Same tri-state field
            // the chip badge reads; neither surface owns the state, and
            // neither adds anything unless the measurement is explicitly
            // `true`.
            if (session.legacyTmuxLocale === true) {
                details.push(window.i18n
                    ? i18n.t('session.legacyTmuxLocaleShort')
                    : 'tmux locale pre-UTF-8 fix');
            }
            headingDetail.textContent = details.join(' · ');
        }
        if (headingDot) {
            headingDot.className = 'status-dot'
                + (session && session.connected ? ' connected' : ' disconnected');
        }
        if (closeLabel) {
            closeLabel.dataset.i18n = 'session.close';
            closeLabel.textContent = window.i18n
                ? i18n.t('session.close') : 'Close session';
        }
    },

    // Sole writer of the lifecycle ACTION target. Id, chip .lifecycle-target
    // class, aria-current, and the action controls' enabled state are synced as
    // one unit here, so they can never drift. Callers: switchSession,
    // setActivePane (user-driven), removeSessionUI, setPendingLifecycleTarget.
    //
    // Distinct from the DISPLAYED selection (activeSessionId / .active /
    // aria-selected), which setActivePane owns. A chip can be active without
    // being the target, the target without being active, both, or neither --
    // and each combination has its own paint and its own ARIA so assistive
    // tech and CSS both see the same answer.
    setLifecycleActionTarget(sessionId) {
        const id = (sessionId && this.sessions[sessionId]) ? sessionId : null;
        // A real selection supersedes any pending target through the pending
        // setter, so the old decoration/sheet/action state is cleared as one unit.
        if (this.lifecyclePendingTargetId !== null) {
            this.setPendingLifecycleTarget(null);
        }
        this.lifecycleActionTargetId = id;
        document.querySelectorAll('.session-tab.lifecycle-target').forEach(tab => {
            tab.classList.remove('lifecycle-target');
            // Only clear the value WE set. A chip that is also the displayed
            // selection keeps its aria-selected; aria-current is the action-
            // target marker and must not be confused with it.
            if (tab.getAttribute('aria-current') === 'true') {
                tab.removeAttribute('aria-current');
            }
        });
        if (id) {
            const tab = document.getElementById(`tab-${id}`);
            if (tab) {
                tab.classList.add('lifecycle-target');
                // "true" rather than "true"/"page"/"location": a session chip is
                // not a page of a set, it is the current subject of the actions.
                tab.setAttribute('aria-current', 'true');
            }
        }
        this.renderLifecycleTarget();
        // One gate for the trigger and all four actions: a valid selected target.
        // Session state (live / ordinary-disconnected / persistent-candidate) never
        // disables a control — the action methods support all three states.
        for (const btnId of ['sessionActionsBtn', 'sessionActionRename',
            'sessionActionReconnect', 'sessionActionReset', 'sessionActionClose',
            'sessionActionOrphans', 'sessionActionAssign']) {
            const btn = document.getElementById(btnId);
            if (btn) btn.disabled = !id;
        }
        // The orphan sweep is the one exception: it lists and kills over the
        // target's own transport, so it needs a LIVE tmux session.
        const orphansBtn = document.getElementById('sessionActionOrphans');
        if (orphansBtn) {
            const target = id ? this.sessions[id] : null;
            orphansBtn.disabled = !(target && target.connected && target.useTmux);
        }
        if (!id) this.closeLifecycleSheet();
    },

    setPendingLifecycleTarget(requestId) {
        const id = requestId && this.pendingConnections[requestId]
            ? requestId : null;
        const changed = id !== this.lifecyclePendingTargetId;
        // setLifecycleActionTarget remains the sole writer of the real-session
        // target. Clear it through that owner before selecting pending metadata.
        if (this.lifecycleActionTargetId !== null) {
            this.setLifecycleActionTarget(null);
        }
        // First activation of a NEW pending target is selection-only even if a
        // sheet from another target was open.
        if (changed) this.closeLifecycleSheet();
        this.lifecyclePendingTargetId = id;
        document.querySelectorAll('.session-tab.lifecycle-target').forEach(tab => {
            tab.classList.remove('lifecycle-target');
            if (tab.getAttribute('aria-current') === 'true') {
                tab.removeAttribute('aria-current');
            }
        });
        if (id) {
            const pending = document.getElementById(`pending-${id}`);
            if (pending) {
                pending.classList.add('lifecycle-target');
                pending.setAttribute('aria-current', 'true');
            }
        }
        this.renderLifecycleTarget();
        const trigger = document.getElementById('sessionActionsBtn');
        if (trigger) trigger.disabled = !id;
        for (const btnId of ['sessionActionRename', 'sessionActionReconnect',
            'sessionActionReset', 'sessionActionOrphans', 'sessionActionAssign']) {
            const btn = document.getElementById(btnId);
            if (btn) btn.disabled = true;
        }
        const cancel = document.getElementById('sessionActionClose');
        if (cancel) cancel.disabled = !id;
        if (!id) this.closeLifecycleSheet();
    },

    dispatchLifecycleAction(action) {
        if (this.lifecyclePendingTargetId) {
            if (action === 'close') {
                this.clearPendingConnection(this.lifecyclePendingTargetId);
            }
            return;
        }
        const id = this.lifecycleActionTargetId;
        if (!id || !this.sessions[id]) return;
        if (action === 'rename') {
            const label = document.querySelector(`#tab-${id} .tab-label`);
            if (label) this.startRenameSession(id, label);
        } else if (action === 'reconnect') {
            this.requestReconnect(id);
        } else if (action === 'reset') {
            this.requestResetSession(id);
        } else if (action === 'close') {
            this.requestCloseSession(id);
        } else if (action === 'orphans') {
            this.openTmuxOrphans(id);
        } else if (action === 'assign') {
            this.showPaneAssignmentModal(this.layout, this.layoutVariant);
        }
    },

    /*
     * Orphaned tmux sessions. An orphan is a JOIN
     * the server computes -- an `sshdeck_*` session on the host that no saved
     * session of any user points at -- never a count of sessions per host:
     * the owner keeps several saved sessions per host on purpose. Nothing is
     * killed without a click on that exact row.
     */
    tmuxOrphansSessionId: null,
    tmuxOrphansBound: false,

    openTmuxOrphans(sessionId) {
        const session = this.sessions[sessionId];
        const modal = document.getElementById('tmuxOrphansModal');
        if (!session || !modal || !window.socket) return;
        this.tmuxOrphansSessionId = sessionId;
        this.bindTmuxOrphansModal();
        this.renderTmuxOrphans({ session_id: sessionId, host: session.host, orphans: null });
        if (window.ModalManager) window.ModalManager.open(modal);
        window.socket.emit('tmux_orphans_list', { session_id: sessionId });
    },

    bindTmuxOrphansModal() {
        if (this.tmuxOrphansBound) return;
        this.tmuxOrphansBound = true;
        const modal = document.getElementById('tmuxOrphansModal');
        document.getElementById('closeTmuxOrphansModal')?.addEventListener('click', () => {
            if (window.ModalManager && modal) window.ModalManager.close(modal);
        });
        document.getElementById('tmuxOrphansList')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-orphan]');
            if (!btn || btn.disabled || !window.socket) return;
            btn.disabled = true;
            window.socket.emit('tmux_orphan_kill', {
                session_id: this.tmuxOrphansSessionId, name: btn.dataset.orphan,
            });
        });
    },

    formatOrphanAge(createdEpoch) {
        const seconds = Math.max(0, Math.floor(Date.now() / 1000) - (createdEpoch || 0));
        if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
        return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
    },

    renderTmuxOrphans(data) {
        if (!data || data.session_id !== this.tmuxOrphansSessionId) return;
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        const status = document.getElementById('tmuxOrphansStatus');
        const list = document.getElementById('tmuxOrphansList');
        if (!status || !list) return;
        list.innerHTML = '';
        const host = data.host || '';
        if (data.orphans === null) {
            status.textContent = t('orphans.loading', 'Checking {host}…').replace('{host}', host);
            return;
        }
        if (data.orphans.length === 0) {
            status.textContent = t('orphans.empty',
                'No orphaned SSHDeck tmux sessions on {host}.').replace('{host}', host);
            return;
        }
        status.textContent = t('orphans.found',
            '{n} tmux session(s) on {host} that no saved session points at:')
            .replace('{n}', String(data.orphans.length)).replace('{host}', host);
        data.orphans.forEach(orphan => {
            const row = document.createElement('div');
            row.className = 'shortcut-row';
            row.dataset.orphanRow = orphan.name;
            const label = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = orphan.name;
            const meta = document.createElement('div');
            meta.textContent = t('orphans.age', '{age} old').replace('{age}', this.formatOrphanAge(orphan.created))
                + ' · ' + (orphan.attached > 0
                    ? t('orphans.attached', 'attached elsewhere')
                    : t('orphans.detached', 'detached'));
            label.append(name, meta);
            const kill = document.createElement('button');
            kill.type = 'button';
            kill.className = 'btn btn-danger btn-sm';
            kill.dataset.orphan = orphan.name;
            kill.textContent = t('orphans.kill', 'Close');
            row.append(label, kill);
            list.appendChild(row);
        });
    },

    onTmuxOrphanKilled(data) {
        if (!data || data.session_id !== this.tmuxOrphansSessionId) return;
        const list = document.getElementById('tmuxOrphansList');
        const status = document.getElementById('tmuxOrphansStatus');
        list?.querySelector(`[data-orphan-row="${CSS.escape(data.name)}"]`)?.remove();
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        if (list && status && list.children.length === 0) {
            status.textContent = t('orphans.allClosed', 'All orphaned sessions are closed.');
        }
        window.showNotification(t('orphans.killed', 'Closed {name}').replace('{name}', data.name), 'success');
    },

    onTmuxOrphansError(data) {
        if (!data || data.session_id !== this.tmuxOrphansSessionId) return;
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        if (data.name) {
            const btn = document.querySelector(`#tmuxOrphansList button[data-orphan="${CSS.escape(data.name)}"]`);
            if (btn) btn.disabled = false;
        } else {
            const status = document.getElementById('tmuxOrphansStatus');
            if (status) status.textContent = data.error || '';
        }
        window.showNotification(t('orphans.error', 'Could not clean up: {error}')
            .replace('{error}', data.error || ''), 'error');
    },

    onSessionKept(data) {
        if (!data || !data.session_id) return;
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        window.showNotification(t('session.keptNotice',
            'The tmux session on the remote host could not be closed ({error}). '
            + 'It is kept as a saved session so you can reconnect to it.')
            .replace('{error}', data.error || ''), 'warning', 6000);
    },

    getSession(sessionId) {
        return this.sessions[sessionId];
    },

    getAllSessions() {
        return Object.values(this.sessions);
    },

    hasAnySessions() {
        return Object.keys(this.sessions).length > 0;
    },

    /*
     * Assignment modal: a preview of the target grid
     * on top, then ONE native <select> per pane. The old wall of radio rows
     * (panes x sessions) could not be used on a phone; a select opens the
     * platform picker. Applying goes through applyPaneAssignments as before.
     */
    showPaneAssignmentModal(targetLayout, targetVariant) {
        const modal = document.getElementById('paneAssignmentModal');
        const list = document.getElementById('paneAssignmentList');
        const preview = document.getElementById('panePreview');
        if (!modal || !list) {
            return;
        }
        targetLayout = this.clampLayout(targetLayout);
        targetVariant = this.normalizeVariant(targetLayout, targetVariant);
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        const current = this.paneAssignments.slice(0, targetLayout);
        const sessions = Object.values(this.sessions);
        const labelOf = (sessionId) => {
            const session = this.sessions[sessionId];
            return session ? this.getDisplayLabel(session.id, session.username, session.host) : '';
        };
        list.innerHTML = '';
        const cells = [];
        if (preview) {
            preview.innerHTML = '';
            preview.className = `pane-preview split-${targetLayout}`
                + (targetVariant === 'default' ? '' : ` split-${targetLayout}-${targetVariant}`);
            for (let i = 0; i < targetLayout; i++) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'pane-preview-cell';
                cell.dataset.pane = String(i);
                const number = document.createElement('strong');
                number.textContent = String(i + 1);
                const name = document.createElement('span');
                name.textContent = current[i] ? labelOf(current[i]) : t('panes.empty', 'Empty');
                cell.append(number, name);
                cell.addEventListener('click', () => {
                    cells.forEach(c => c.classList.toggle('active', c === cell));
                    list.querySelector(`select[name="pane-${i}"]`)?.focus();
                });
                preview.appendChild(cell);
                cells.push(cell);
            }
        }
        for (let i = 0; i < targetLayout; i++) {
            const row = document.createElement('label');
            row.className = 'pane-assign-row';
            const caption = document.createElement('span');
            caption.className = 'pane-assign-caption';
            caption.textContent = `${t('panes.pane', 'Pane')} ${i + 1}`;
            const select = document.createElement('select');
            select.className = 'form-control';
            select.name = `pane-${i}`;
            const addOption = (value, text) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = text;
                select.appendChild(option);
            };
            addOption('__empty__', t('panes.empty', 'Empty'));
            sessions.forEach(session => {
                const state = session.connected
                    ? t('panes.connected', 'Connected') : t('panes.disconnected', 'Disconnected');
                addOption(session.id, `${labelOf(session.id)} · ${state}`);
            });
            addOption('__new__', t('panes.newConnection', '+ New Connection'));
            select.value = current[i] && this.sessions[current[i]] ? current[i] : '__empty__';
            select.addEventListener('change', () => {
                const cell = cells[i];
                if (!cell) return;
                const value = select.value;
                cell.querySelector('span').textContent = value === '__empty__'
                    ? t('panes.empty', 'Empty')
                    : value === '__new__' ? t('panes.newConnection', '+ New Connection') : labelOf(value);
            });
            row.append(caption, select);
            list.appendChild(row);
        }
        const closeBtn = document.getElementById('closePaneAssignmentModal');
        const cancelBtn = document.getElementById('cancelPaneAssignment');
        const applyBtn = document.getElementById('applyPaneAssignment');
        const closeHandler = () => {
            if (window.ModalManager) {
                window.ModalManager.close(modal);
            } else {
                modal.classList.remove('show');
            }
        };
        const applyHandler = () => {
            const chosen = [];
            const newPanes = [];
            for (let i = 0; i < targetLayout; i++) {
                const value = list.querySelector(`select[name="pane-${i}"]`)?.value || '__empty__';
                if (value === '__new__') {
                    newPanes.push(i);
                }
                chosen.push(value === '__empty__' || value === '__new__' ? null : value);
            }
            this.applyPaneAssignments(targetLayout, chosen, targetVariant);
            newPanes.forEach(i => {
                if (window.openConnectionModalForPane) {
                    setTimeout(() => window.openConnectionModalForPane(i), 100);
                }
            });
            closeHandler();
        };
        closeBtn.onclick = closeHandler;
        cancelBtn.onclick = closeHandler;
        applyBtn.onclick = applyHandler;
        if (window.ModalManager) {
            window.ModalManager.open(modal);
        } else {
            modal.classList.add('show');
        }
    },

    /*
     * Replace the whole split in one step: layout, variant and every slot.
     * A session named twice keeps its first slot; a name that is not a
     * session is treated as empty. Restores nothing by itself and displaces
     * nothing silently -- the caller chose every slot.
     */
    applyPaneAssignments(layout, assignments, variant) {
        const grid = this.ensureTerminalGrid();
        if (!grid) {
            return;
        }
        layout = this.clampLayout(layout);
        this.layout = layout;
        this.layoutVariant = this.normalizeVariant(
            layout,
            variant === undefined ? this.layoutVariant : variant
        );
        const next = new Array(layout).fill(null);
        (assignments || []).slice(0, layout).forEach((sessionId, index) => {
            if (sessionId && this.sessions[sessionId] && !next.includes(sessionId)) {
                next[index] = sessionId;
            }
        });
        this.paneAssignments = next;
        this.soloSessionId = null;
        this.renderWorkspace();
        if (this.activePaneIndex >= layout) {
            this.activePaneIndex = 0;
        }
        this.setActivePane(this.activePaneIndex);
        this.saveLayoutPreference();
        this.persistPaneIndexes();
    }
};
