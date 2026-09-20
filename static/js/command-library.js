const CommandLibrary = {
    commands: [],
    filteredCommands: [],
    currentOs: 'all',
    editingCommandId: null,
    detectingOsForSession: null,
    renderCursor: 0,
    chunkSize: 40,
    pendingSaveCallback: null,
    returnToModalId: null,

    init() {
        this.loadCommands();

        if (window.socket) {
            window.socket.on('commands_list', (data) => {
                this.setCommands(data.commands);
            });

            window.socket.on('command_added', (data) => {
                window.showNotification('Command added successfully', 'success');
            });

            window.socket.on('command_updated', (data) => {
                window.showNotification('Command updated successfully', 'success');
            });

            window.socket.on('command_deleted', (data) => {
                window.showNotification('Command deleted successfully', 'success');
            });

            window.socket.on('os_detection_started', (data) => {
                console.log('OS detection started for session:', data.session_id);
                this.detectingOsForSession = data.session_id;
            });
        }

        this.setupEventListeners();
    },

    setupEventListeners() {
        /*
         * #commandLibraryBtn is the ONE Command entry point: the header control
         * on desktop, relocated into the canonical account tree on touch (moved,
         * so this listener travels with it). Command Sets is reachable only from
         * the in-rail button.
         *
         * The former second id in this list, #commandRailOpenBtn, had no
         * production node -- no such id in templates/index.html and no
         * createElement for it in static/js -- so the loop bound nothing on that
         * pass. Removed rather than left as dead config.
         */
        const libraryBtn = document.getElementById('commandLibraryBtn');
        libraryBtn?.addEventListener('click', () => this.toggleLibrary(libraryBtn));

        document.getElementById('commandRailCloseBtn')
            ?.addEventListener('click', () => this.closeLibrary());

        document.getElementById('commandRailSetsBtn')
            ?.addEventListener('click', () => window.CommandSetManager?.openManagement());

        // Plan v5 section 5: the rail has no draft of its own. Its former textarea,
        // send button, Ctrl/Cmd+Enter commit and its own
        // sshdeck:active-session-changed clear were a second composer state flow.
        // The single shared composer in app.js keeps the only clear-on-session-change.

        // Bound on the rail, so it can only fire when focus is already inside
        // it -- xterm's Escape is structurally unreachable from here.
        document.getElementById('commandRail')?.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.closeLibrary();
        });

        // The notepad and this rail share one auxiliary cell. Focus is NOT
        // restored here: the user is opening the other panel, and pulling focus
        // back to this rail's invoker would fight it.
        document.addEventListener('sshdeck:aux-panel-opening', (event) => {
            if (event.detail?.panel !== 'command' && this.isOpen()) {
                this.closeLibrary({ restoreFocus: false });
            }
        });

        const commandSearchInput = document.getElementById('commandSearchInput');
        if (commandSearchInput) {
            commandSearchInput.addEventListener('input', (e) => this.searchCommands(e.target.value));
        }

        const addCommandBtn = document.getElementById('addCommandBtn');
        if (addCommandBtn) {
            addCommandBtn.addEventListener('click', () => this.showAddCommandForm());
        }

        const closeCommandFormModal = document.getElementById('closeCommandFormModal');
        if (closeCommandFormModal) {
            closeCommandFormModal.addEventListener('click', () => this.closeCommandForm());
        }

        const cancelCommandFormBtn = document.getElementById('cancelCommandFormBtn');
        if (cancelCommandFormBtn) {
            cancelCommandFormBtn.addEventListener('click', () => this.closeCommandForm());
        }

        const commandForm = document.getElementById('commandForm');
        if (commandForm) {
            commandForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveCommand();
            });
        }

        window.addEventListener('click', (e) => {
            const commandFormModal = document.getElementById('commandFormModal');

            if (e.target === commandFormModal) {
                this.closeCommandForm();
            }
        });

        document.querySelectorAll('#commandLibraryPanel .os-filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#commandLibraryPanel .os-filter-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                this.currentOs = e.currentTarget.dataset.os;
                this.loadCommands();
            });
        });
    },

    loadCommands() {
        if (window.socket) {
            window.socket.emit('list_commands', {
                os_filter: this.currentOs === 'all' ? null : this.currentOs
            });
        }
    },

    setCommands(commands) {
        this.commands = commands;
        this.filteredCommands = commands;
        this.renderCommandsList();
        window.CommandSetManager?.onCommandsChanged();
        window.ConnectionCommandManager?.onDataChanged();
        const osDisplay = document.getElementById('currentOsDisplay');
        if (osDisplay) {
            osDisplay.textContent = this.currentOs.charAt(0).toUpperCase() + this.currentOs.slice(1);
        }
    },

    // ---- rail lifecycle -------------------------------------------------
    // A non-blocking rail, not a modal: no ModalManager, no aria-modal, no
    // backdrop, so the terminal stays visible and usable while it is open.
    //
    // .aux-open is the ONE state class, so JS and CSS cannot disagree and the
    // sheet still animates (a hidden attribute would kill the transition).
    // Because the closed rail is only moved off-screen, focus exclusion is not
    // automatic: inert + aria-hidden are synchronized with it exactly as
    // Header-menus.js setInactive does for the More sheet, and CSS pairs the
    // closed state with visibility:hidden/pointer-events:none.
    railFitTimer: 0,
    railFocusTimer: 0,
    lastRailInvoker: null,

    isOpen() {
        return Boolean(document.getElementById('commandRail')?.classList.contains('aux-open'));
    },

    // One shared timer: repeated toggles reschedule instead of stacking fits.
    scheduleRailFit() {
        clearTimeout(this.railFitTimer);
        this.railFitTimer = setTimeout(() => {
            window.TerminalManager?.fitAllTerminals();
        }, 300);
    },

    /*
     * focusSearch is opt-in and honoured only on a fine pointer: focusing search
     * on a touch shell would summon the soft keyboard merely for opening the
     * list. openEditor passes false, because it opens a command form immediately
     * afterwards and a stale 100ms focus would steal focus back out of it.
     */
    openLibrary({ invoker = null, focusSearch = false } = {}) {
        const rail = document.getElementById('commandRail');
        if (!rail) return;
        if (invoker) this.lastRailInvoker = invoker;

        // Unchanged no-active-session semantics: reset the filter and reload.
        if (!SessionManager.getActiveSession()) {
            this.currentOs = 'all';
            this.loadCommands();
        }

        // Idempotent: an already-open rail must not redispatch the exclusion
        // event or reschedule a fit. Focus may still be requested.
        if (!this.isOpen()) {
            document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening', {
                detail: { panel: 'command' },
            }));
            rail.classList.add('aux-open');
            rail.removeAttribute('inert');
            rail.setAttribute('aria-hidden', 'false');
            this.scheduleRailFit();

            /*
             * On a touch shell the sheet slides up from the bottom, exactly
             * where an open soft keyboard sits. Retract it by blurring the
             * composer; blur alone never clears #mobileInput, so the local
             * draft survives (same idiom as the keypad toggle in app.js).
             */
            if (window.TerminalManager && TerminalManager.isTouchShell()) {
                document.getElementById('mobileInput')?.blur();
            }
        }

        clearTimeout(this.railFocusTimer);
        if (focusSearch && window.TerminalManager && !TerminalManager.isTouchShell()) {
            this.railFocusTimer = setTimeout(() => {
                document.getElementById('commandSearchInput')?.focus();
            }, 100);
        }
    },

    /*
     * restoreFocus is suppressed when another auxiliary panel is taking the
     * shared cell: returning focus to the control that opened this rail would
     * fight the panel the user just asked for.
     */
    closeLibrary({ restoreFocus = true } = {}) {
        const returnModalId = this.returnToModalId;
        const rail = document.getElementById('commandRail');

        // Cancel a pending search focus, or it would fire into a closed rail.
        clearTimeout(this.railFocusTimer);

        if (rail) {
            rail.classList.remove('aux-open');
            rail.setAttribute('inert', '');
            rail.setAttribute('aria-hidden', 'true');
        }
        this.scheduleRailFit();

        const search = document.getElementById('commandSearchInput');
        if (search) search.value = '';
        this.filteredCommands = this.commands;
        this.renderCommandsList();

        // Nested-editor return path unchanged, and takes precedence.
        if (returnModalId && window.ModalManager) {
            const returnModal = document.getElementById(returnModalId);
            if (returnModal?.classList.contains('show')) {
                window.ModalManager.activeModal = returnModal;
                document.getElementById('editSelectedCommandBtn')?.focus();
            }
        } else if (restoreFocus && window.TerminalManager && !TerminalManager.isTouchShell()) {
            // Never focus a hidden element, never summon a mobile keyboard.
            const invoker = this.lastRailInvoker;
            if (invoker?.isConnected && invoker.offsetParent !== null) invoker.focus();
        }
        this.lastRailInvoker = null;
        this.returnToModalId = null;
    },

    toggleLibrary(invoker = null) {
        if (this.isOpen()) this.closeLibrary();
        else this.openLibrary({ invoker, focusSearch: true });
    },

    openEditor(commandId, returnToModalId = null) {
        const command = this.commands.find(item => item.id === commandId);
        if (!command) return;
        // Assigned after the open call, which is where the rail becomes visible;
        // closeLibrary is the only thing that clears it.
        this.openLibrary({ focusSearch: false });
        this.returnToModalId = returnToModalId;
        if (command.isSystem) this.copyCommand(commandId);
        else this.editCommand(commandId);
    },

    detectOs() {
    },

    searchCommands(query) {
        if (!query) {
            this.filteredCommands = this.commands;
        } else {
            const lowerQuery = query.toLowerCase();
            this.filteredCommands = this.commands.filter(cmd => {
                const matchesEnglish = (
                    cmd.name.toLowerCase().includes(lowerQuery) ||
                    cmd.command.toLowerCase().includes(lowerQuery) ||
                    cmd.parameters.toLowerCase().includes(lowerQuery) ||
                    cmd.description.toLowerCase().includes(lowerQuery)
                );

                if (matchesEnglish) {
                    return true;
                }

                if (window.i18n) {
                    const categoryKey = 'commands.category' + cmd.category.charAt(0).toUpperCase() + cmd.category.slice(1);
                    const translatedCategory = window.i18n.t(categoryKey);
                    if (translatedCategory !== categoryKey
                        && translatedCategory.toLowerCase().includes(lowerQuery)) {
                        return true;
                    }
                }

                return false;
            });
        }
        this.renderCommandsList();
    },

    renderCommandsList() {
        const container = document.getElementById('commandsList');

        if (this.filteredCommands.length === 0) {
            // Was a hardcoded English literal on a Vietnamese shell.
            const empty = (window.i18n && typeof i18n.t === 'function')
                ? i18n.t('commands.noResults') : 'No commands found';
            container.textContent = '';
            const p = document.createElement('p');
            p.className = 'no-items';
            p.textContent = empty;
            container.appendChild(p);
            return;
        }

        container.innerHTML = '';
        this.renderCursor = 0;
        container.scrollTop = 0;
        this.attachCommandListeners(container);
        this.renderNextChunk();

        container.onscroll = () => {
            if (container.scrollTop + container.clientHeight >= container.scrollHeight - 40) {
                this.renderNextChunk();
            }
        };
    },

    renderNextChunk() {
        const container = document.getElementById('commandsList');
        if (!container) {
            return;
        }
        const start = this.renderCursor;
        const end = Math.min(start + this.chunkSize, this.filteredCommands.length);
        if (start >= end) {
            return;
        }
        this.renderCursor = end;

        this.filteredCommands.slice(start, end).forEach(cmd => {
            /*
             * P2 / mockup line 181 draws a library entry as ONE tappable row:
             *   <button class="tw5-list-row">
             *     <span><strong>name</strong><code>command</code></span>
             *     <i corner-down-left>
             *   </button>
             * a 46px row whose whole surface is the insert affordance and
             * whose trailing glyph states what tapping does. The app had a
             * five-cell stacked card in which insert was one of three or four
             * equal icon buttons; on a 255px rail that made the primary action
             * the smallest target in the row.
             *
             * The row is a <button>, so edit/delete/copy CANNOT nest inside it
             * a button inside a button is invalid and the inner one is not
             * reliably clickable. They sit in a sibling actions box, which is
             * why the row and its actions share a wrapper.
             *
             * "Run on tap" is deliberately NOT what tapping does: the mockup's
             * own behaviour note (spec line 415) reads "chen de sua truoc khi
             * chay" -- insert to edit BEFORE running. insertCommand is unchanged
             * and still emits nothing on touch; only Send / Ctrl+Enter reach the
             * remote.
             */
            const row = document.createElement('div');
            row.className = 'command-row';
            if (cmd.isSystem) {
                row.classList.add('system-command');
            }

            const osBadges = cmd.os.map(os =>
                `<span class="os-badge">${this.escapeHtml(os)}</span>`).join('');
            const meta = [cmd.parameters, cmd.description]
                .filter(Boolean).join(' · ');

            row.innerHTML = `
                <button type="button" class="command-rail-item cmd-insert"
                        data-cmd-id="${this.escapeHtml(cmd.id)}"
                        title="${this.escapeHtml(meta ? cmd.command + ' · ' + meta : cmd.command)}"
                        aria-label="Insert into composer (not sent)">
                    <span>
                        <strong>${this.escapeHtml(cmd.name)}</strong>
                        <code>${this.escapeHtml(cmd.command)}</code>
                    </span>
                    ${this.spriteIcon('corner-down-left')}
                </button>
                <div class="command-actions">
                    <div class="command-os-badges">${osBadges}</div>
                    ${cmd.isSystem ? `
                        <button class="btn-icon cmd-copy" data-cmd-id="${this.escapeHtml(cmd.id)}" title="Copy to My Commands" aria-label="Copy to My Commands">${this.spriteIcon('copy')}</button>
                    ` : `
                        <button class="btn-icon cmd-edit" data-cmd-id="${this.escapeHtml(cmd.id)}" title="Edit" aria-label="Edit">${this.spriteIcon('pencil')}</button>
                        <button class="btn-icon cmd-delete" data-cmd-id="${this.escapeHtml(cmd.id)}" title="Delete" aria-label="Delete">${this.spriteIcon('trash-2')}</button>
                    `}
                </div>
            `;

            container.appendChild(row);
        });
    },

    attachCommandListeners(container) {
        // Single delegated listener bound once per render. Attaching per-chunk
        // over the whole container (as before) stacked duplicate listeners on
        // already-rendered rows during infinite scroll, firing actions 2x/3x.
        container.onclick = (event) => {
            const btn = event.target.closest('button[data-cmd-id]');
            if (!btn || !container.contains(btn)) {
                return;
            }
            const cmdId = btn.dataset.cmdId;
            if (btn.classList.contains('cmd-insert')) {
                this.insertCommand(cmdId);
            } else if (btn.classList.contains('cmd-copy')) {
                this.copyCommand(cmdId);
            } else if (btn.classList.contains('cmd-edit')) {
                this.editCommand(cmdId);
            } else if (btn.classList.contains('cmd-delete')) {
                this.deleteCommand(cmdId);
            }
        };
    },

    /*
     * Clicking a saved command INSERTS it; it never executes it and never submits
     * the connection form. This replaces executeCommand, which emitted
     * ssh_input WITH a carriage return -- it ran the command on click while
     * telling the user it had merely been "inserted".
     *
     * Where the text lands depends on whether a composer is on screen, because
     * plan v5 allows only one composer instance and shows none on fine-pointer
     * desktop in its normal state:
     *
     *   - touch, or desktop with Broadcast active: spliced into the one shared
     *     composer at the caret, emitting nothing. Only the explicit commit path
     *     (Send, or Ctrl/Cmd+Enter -> app.js commitTerminalDraft) reaches the
     *     remote. Per-session draft isolation is inherited rather than
     *     reimplemented: that composer is cleared on
     *     sshdeck:active-session-changed, so text staged for one session can never
     *     be committed into another.
     *   - desktop normal: emitted as raw ssh_input with NO trailing '\r', so it
     *     sits on the shell's editable command line awaiting the user's Enter.
     *
     * Either way the rail deliberately stays open, so several commands can be
     * composed in sequence.
     */
    insertCommand(commandId) {
        const cmd = this.commands.find(c => c.id === commandId);
        if (!cmd) return;

        const activeSessionId = SessionManager.getActiveSession();
        if (!activeSessionId) {
            window.showNotification('No active session', 'warning');
            return;
        }

        let text = cmd.command;
        if (cmd.parameters) {
            text += ' ' + cmd.parameters;
        }

        // Two insert destinations, ONE composer. Plan v5 section 5 permits a single
        // composer DOM instance, and invariant 5 forbids any visible composer on
        // fine-pointer desktop in its normal state -- so desktop cannot be given a
        // composer to insert into, not even a relocated or rail-hosted one.
        //
        // Touch, and desktop while Broadcast is active, both already have the one
        // shared composer on screen: insert splices into it and sends nothing.
        //
        // Desktop normal has no composer, so the text goes to the terminal's own
        // prompt via the existing raw ssh_input primitive (the same verbatim,
        // no-CR emit the function keypad uses at app.js sendKeypadKey). Without a
        // trailing '\r' the shell leaves it on the editable command line, so the
        // user can amend it and decide when to press Enter. This is the project's
        // existing input path -- no second editor and no hidden composer.
        const useSharedComposer = window.TerminalManager?.isTouchShell() === true
            || window.BroadcastInput?.open === true;

        if (!useSharedComposer) {
            if (!window.socket) return;
            // The completion: one funnel for every byte-writing client
            // path, so an insert-at-prompt into a scrolled tmux pane is not
            // silently discarded by copy mode. Guarded rather than reordered:
            // this file loads at index.html:1698, app.js at :1704.
            if (typeof window.emitTerminalInput === 'function') {
                window.emitTerminalInput(activeSessionId, text);
            } else {
                window.socket.emit('ssh_input',
                                   { session_id: activeSessionId, data: text });
            }
            window.showNotification(`Inserted at prompt, not sent: ${cmd.name}`, 'success');
            return;
        }

        const composer = document.getElementById('mobileInput');
        if (!composer) {
            return;
        }

        // Caret-aware splice, the same idiom the composer's own Enter handler
        // uses, so an insertion lands where the user is typing instead of
        // replacing the draft.
        const start = composer.selectionStart ?? composer.value.length;
        const end = composer.selectionEnd ?? start;
        composer.value = composer.value.slice(0, start) + text + composer.value.slice(end);
        const caret = start + text.length;
        composer.selectionStart = composer.selectionEnd = caret;

        // Let the composer's own input handler auto-grow the box and republish
        // its height, rather than duplicating that measurement here.
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        // Selection must not summon the soft keyboard, so focus is NOT taken here.

        window.showNotification(`Inserted, not sent: ${cmd.name}`, 'success');
    },

    showAddCommandForm(options = {}) {
        this.editingCommandId = null;
        this.pendingSaveCallback = typeof options.onSaved === 'function' ? options.onSaved : null;
        document.getElementById('commandFormTitle').textContent = 'Add New Command';
        document.getElementById('commandFormName').value = options.name || '';
        document.getElementById('commandFormCommand').value = options.command || '';
        document.getElementById('commandFormParams').value = '';
        document.getElementById('commandFormDescription').value = options.description || '';
        document.getElementById('commandFormCategory').value = 'custom';

        document.querySelectorAll('input[name="commandOs"]').forEach(cb => cb.checked = false);
        document.getElementById('osAll').checked = true;

        if (window.ModalManager) {
            window.ModalManager.open(document.getElementById('commandFormModal'));
        } else {
            document.getElementById('commandFormModal').classList.add('show');
        }
    },

    copyCommand(commandId) {
        const cmd = this.commands.find(c => c.id === commandId);
        if (!cmd) return;

        this.editingCommandId = null;
        document.getElementById('commandFormTitle').textContent = 'Copy Command to My Library';
        document.getElementById('commandFormName').value = cmd.name;
        document.getElementById('commandFormCommand').value = cmd.command;
        document.getElementById('commandFormParams').value = cmd.parameters;
        document.getElementById('commandFormDescription').value = cmd.description;
        document.getElementById('commandFormCategory').value = cmd.category || 'custom';

        document.querySelectorAll('input[name="commandOs"]').forEach(cb => {
            cb.checked = cmd.os.includes(cb.value);
        });

        if (window.ModalManager) {
            window.ModalManager.open(document.getElementById('commandFormModal'));
        } else {
            document.getElementById('commandFormModal').classList.add('show');
        }
    },

    editCommand(commandId) {
        const cmd = this.commands.find(c => c.id === commandId);
        if (!cmd || cmd.isSystem) return;

        this.editingCommandId = commandId;
        document.getElementById('commandFormTitle').textContent = 'Edit Command';
        document.getElementById('commandFormName').value = cmd.name;
        document.getElementById('commandFormCommand').value = cmd.command;
        document.getElementById('commandFormParams').value = cmd.parameters;
        document.getElementById('commandFormDescription').value = cmd.description;
        document.getElementById('commandFormCategory').value = cmd.category || 'custom';

        document.querySelectorAll('input[name="commandOs"]').forEach(cb => {
            cb.checked = cmd.os.includes(cb.value);
        });

        if (window.ModalManager) {
            window.ModalManager.open(document.getElementById('commandFormModal'));
        } else {
            document.getElementById('commandFormModal').classList.add('show');
        }
    },

    saveCommand() {
        const name = document.getElementById('commandFormName').value.trim();
        const command = document.getElementById('commandFormCommand').value.trim();
        const parameters = document.getElementById('commandFormParams').value.trim();
        const description = document.getElementById('commandFormDescription').value.trim();
        const category = document.getElementById('commandFormCategory').value;

        const osList = [];
        document.querySelectorAll('input[name="commandOs"]:checked').forEach(cb => {
            osList.push(cb.value);
        });

        if (!name || !command || !description) {
            window.showNotification('Name, command, and description are required', 'error');
            return;
        }

        if (osList.length === 0) {
            window.showNotification('Select at least one OS', 'error');
            return;
        }

        const data = {
            name,
            command,
            parameters,
            description,
            os: osList,
            category
        };

        if (this.editingCommandId) {
            data.command_id = this.editingCommandId;
            window.socket.emit('update_command', data);
            this.closeCommandForm();
        } else {
            window.socket.emit('add_command', data, acknowledgement => {
                if (!acknowledgement?.success) {
                    window.showNotification(
                        acknowledgement?.error || 'Failed to add command', 'error'
                    );
                    return;
                }
                const callback = this.pendingSaveCallback;
                this.closeCommandForm();
                callback?.(acknowledgement.command);
            });
        }
    },

    deleteCommand(commandId) {
        const cmd = this.commands.find(c => c.id === commandId);
        if (!cmd || cmd.isSystem) return;

        if (confirm(`Delete command "${cmd.name}"?`)) {
            window.socket.emit('delete_command', { command_id: commandId });
        }
    },

    closeCommandForm() {
        if (window.ModalManager) {
            window.ModalManager.close(document.getElementById('commandFormModal'));
        } else {
            document.getElementById('commandFormModal').classList.remove('show');
        }
        this.editingCommandId = null;
        this.pendingSaveCallback = null;
        const workspace = document.getElementById('commandSetsModal');
        if (workspace?.classList.contains('show') && window.ModalManager) {
            window.ModalManager.activeModal = workspace;
        }
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    spriteIcon(name) {
        return `<svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-${name}"></use></svg>`;
    }
};

window.CommandLibrary = CommandLibrary;
