/*
 * Broadcast — a TARGET STATE module. When active, the single shared composer's
 * explicit Send fans its text out to the selected target sessions at once
 * (cluster-SSH style), independent of which terminal is focused. Pure
 * client-side: each target still goes through the existing, ownership-checked
 * `ssh_input` handler.
 *
 * W14 item 6: the target is no longer all-or-nothing. The #composerTarget chip
 * is a button that opens an anchored checklist (the broadcast-target-menu).
 * Selection semantics, pinned by tests:
 *   * default = Select All: while allMode stays true, every sendable session
 *     is selected, and a newly connected session joins automatically -- the
 *     user asked for "all".
 *   * custom subset freezes auto-include: the first row the user unchecks
 *     leaves allMode; from then on newcomers appear in the list UNSELECTED,
 *     so the blast radius never expands silently past the chosen subset.
 *   * Select All re-arms all-mode and selects every CURRENT session.
 *   * disconnected sessions leave the selection; a reconnecting one re-enters
 *     under whichever mode is active (it never remembers a stale check).
 *   * empty selection blocks Send (sendAll returns 0; the composer's
 *     noTargets notification path handles it).
 *
 * Broadcast has no input of its own. Plan v5 section 5 permits exactly one
 * composer DOM instance and one draft state flow, so this module owns only the
 * target state; the composer reads it via sshdeck:broadcast-changed.
 */
(function () {
    'use strict';

    /*
     * Broadcast targets. Plan v5 section 5: N counts only sessions that are
     * connected AND sendable, so persistent reconnect candidates are excluded --
     * they have no live channel, and counting them would overstate the blast
     * radius shown to the user before they press Send. The sendability test
     * itself belongs to SessionManager, so it is not restated here.
     */
    function connectedSessions() {
        if (typeof SessionManager === 'undefined' || !SessionManager.getAllSessions) {
            return [];
        }
        return SessionManager.getAllSessions()
            .filter(s => SessionManager.isSendableSession(s));
    }

    function sessionLabel(s) {
        return s.displayName || (s.username && s.host
            ? `${s.username}@${s.host}` : (s.host || s.id));
    }

    const BroadcastInput = {
        open: false,

        /*
         * W14 item 6 — selection state. `selected` holds the ids the next Send
         * fans out to; `allMode` records whether that set was chosen by the
         * user (false) or is "everything, including newcomers" (true). The two
         * together ARE the blast-radius contract: reading either alone would
         * not tell a newcomer what to expect.
         */
        allMode: true,
        selected: new Set(),
        menuOpen: false,

        toggle() {
            this.open ? this.close() : this.show();
        },

        targetCount() {
            return connectedSessions().length;
        },

        selectedCount() {
            // A stale id can never survive a sendable-set change (syncSelection
            // runs on every such change), but count defensively anyway: only
            // ids that are sendable RIGHT NOW count toward the blast radius.
            const live = new Set(connectedSessions().map(s => s.id));
            return [...this.selected].filter(id => live.has(id)).length;
        },

        /*
         * Announce the target change so the shared composer can relabel itself.
         * Plan v5 section 5: toggling the target must NOT focus the composer,
         * open the soft keyboard, send, or clear the draft -- so this only
         * publishes state, and the composer wiring consumes it. The detail
         * carries enough for the x/y label: allMode decides "All N" vs the
         * custom-subset format.
         */
        publish() {
            document.dispatchEvent(new CustomEvent('sshdeck:broadcast-changed', {
                detail: {
                    active: this.open,
                    count: this.selectedCount(),
                    total: this.targetCount(),
                    allMode: this.allMode,
                }
            }));
        },

        syncToggle() {
            const btn = document.getElementById('broadcastToggleBtn');
            if (!btn) return;
            btn.classList.toggle('active', this.open);
            btn.setAttribute('aria-pressed', this.open ? 'true' : 'false');
        },

        /*
         * The composer MIRRORS the active session's input line, so opening
         * Broadcast with text in the box means that text is already on one
         * session's line. It is not refused -- under a full mirror any typed
         * character would refuse, which is the frozen-box failure the owner
         * rejected. The composer RETRACTS what it put there (app.js listens
         * for `sshdeck:broadcast-changed` and erases its mirror) and the box
         * becomes the all-local broadcast draft: nothing is sent twice, and
         * the text the user typed is still in front of them.
         */
        show() {
            this.open = true;
            // Contract default: every broadcast session starts from Select All.
            // A subset the user chose belongs to THAT broadcast session; the
            // next open must not silently re-arm an old blast radius.
            this.allMode = true;
            this.selected.clear();
            document.body.classList.add('broadcast-active');
            this.syncToggle();
            // Populates the selection from the live sendable set and publishes.
            this.syncSelection();
        },

        close() {
            this.open = false;
            this.closeMenu();
            document.body.classList.remove('broadcast-active');
            this.syncToggle();
            this.publish();
        },

        // ── target picker ────────────────────────────────────────────────────

        /*
         * Reconcile the selection with the live sendable set, then repaint.
         *
         * Dropped sessions leave the selection unconditionally (a dead channel
         * must never stay armed). Newcomers join automatically ONLY in
         * all-mode; in a user-chosen subset they appear UNSELECTED, so the
         * blast radius never expands past the subset the user chose. This is
         * the single function every membership change funnels through.
         */
        syncSelection() {
            const live = connectedSessions();
            const liveIds = new Set(live.map(s => s.id));
            // Drop ids that are no longer sendable.
            for (const id of [...this.selected]) {
                if (!liveIds.has(id)) this.selected.delete(id);
            }
            if (this.allMode) {
                for (const s of live) this.selected.add(s.id);
            }
            if (this.menuOpen) this.renderMenu();
            if (this.open) this.publish();
        },

        toggleSession(id) {
            if (this.selected.has(id)) {
                // The first uncheck leaves all-mode: from now on the blast
                // radius is exactly the subset the user maintains.
                this.allMode = false;
                this.selected.delete(id);
            } else {
                this.selected.add(id);
            }
            this.renderMenu();
            this.publish();
        },

        selectAll() {
            this.allMode = true;
            for (const s of connectedSessions()) this.selected.add(s.id);
            this.renderMenu();
            this.publish();
        },

        menu() {
            return document.getElementById('broadcastTargetMenu');
        },

        /*
         * Build (or rebuild) the checklist rows. The Select All row is always
         * first and mirrors allMode; every sendable session gets one row below
         * it. Rows are plain buttons with aria-checked state; the check glyph
         * is drawn by CSS from the state attribute, so the list stays
         * theme-token styling with no extra nodes.
         */
        renderMenu() {
            const menu = this.menu();
            if (!menu) return;
            menu.textContent = '';

            const heading = document.createElement('div');
            heading.className = 'broadcast-target-menu-heading';
            heading.setAttribute('data-i18n', 'broadcast.targetMenu');
            heading.textContent = window.i18n
                ? i18n.t('broadcast.targetMenu') : 'Broadcast targets';
            menu.appendChild(heading);

            const allRow = document.createElement('button');
            allRow.type = 'button';
            allRow.className = 'broadcast-target-option';
            allRow.setAttribute('role', 'menuitemcheckbox');
            allRow.setAttribute('aria-checked', this.allMode ? 'true' : 'false');
            const allLabel = document.createElement('span');
            allLabel.className = 'broadcast-target-option-label';
            allLabel.setAttribute('data-i18n', 'broadcast.selectAll');
            allLabel.textContent = window.i18n
                ? i18n.t('broadcast.selectAll') : 'Select all';
            allRow.appendChild(allLabel);
            allRow.addEventListener('click', () => this.selectAll());
            menu.appendChild(allRow);

            for (const s of connectedSessions()) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'broadcast-target-option';
                row.dataset.broadcastTarget = s.id;
                row.setAttribute('role', 'menuitemcheckbox');
                row.setAttribute('aria-checked',
                    this.selected.has(s.id) ? 'true' : 'false');
                const label = document.createElement('span');
                label.className = 'broadcast-target-option-label';
                label.textContent = sessionLabel(s);
                row.appendChild(label);
                row.addEventListener('click', () => this.toggleSession(s.id));
                menu.appendChild(row);
            }
            this.syncChipExpanded();
        },

        syncChipExpanded() {
            const chip = document.getElementById('composerTarget');
            if (chip && chip.hasAttribute('aria-expanded')) {
                chip.setAttribute('aria-expanded', this.menuOpen ? 'true' : 'false');
            }
        },

        openMenu() {
            const menu = this.menu();
            if (!menu || !this.open) return;
            this.menuOpen = true;
            menu.hidden = false;
            this.renderMenu();
        },

        closeMenu() {
            const menu = this.menu();
            this.menuOpen = false;
            if (menu) menu.hidden = true;
            this.syncChipExpanded();
        },

        toggleMenu() {
            this.menuOpen ? this.closeMenu() : this.openMenu();
        },

        // The explicit-send primitive: CR is appended HERE and nowhere else, and
        // only the SELECTED sendable sessions receive it. Returns the count the
        // composer reports; 0 (nothing selected, nothing sendable) blocks the
        // send through the composer's existing notification path.
        sendAll(text) {
            if (!window.socket) return 0;
            const sessions = connectedSessions()
                .filter(s => this.selected.has(s.id));
            sessions.forEach(s => {
                /*
                 * The completion: PER SESSION through the one funnel, so a
                 * scrolled session in the broadcast set is not the one that
                 * silently drops the command -- tmux discards every byte written
                 * to a pane in copy mode, and the set can mix scrolled and
                 * unscrolled panes. The funnel decides per session, which is why
                 * this stays inside the forEach.
                 *
                 * Guarded rather than reordered: this file loads at
                 * index.html:1695, app.js (which defines the funnel) at :1704.
                 */
                if (typeof window.emitTerminalInput === 'function') {
                    window.emitTerminalInput(s.id, text + '\r');
                } else {
                    window.socket.emit('ssh_input',
                                       { session_id: s.id, data: text + '\r' });
                }
            });
            return sessions.length;
        }
    };

    window.BroadcastInput = BroadcastInput;

    document.addEventListener('DOMContentLoaded', () => {
        const toggle = document.getElementById('broadcastToggleBtn');

        /*
         * Plan v5 section 5: changing the shared composer's target on a touch shell
         * must preserve focus and must not open the soft keyboard. Prevent the
         * pointer/mouse default focus transfer only under the canonical product
         * capability predicate; a fine-pointer desktop keeps native button focus,
         * and keyboard activation never enters these handlers. Do not prevent
         * touchstart: WebKit can treat that as "no click" and make the control inert.
         */
        const holdFocus = event => {
            if (typeof TerminalManager !== 'undefined'
                && TerminalManager.isTouchShell()) {
                event.preventDefault();
            }
        };
        if (toggle) {
            toggle.addEventListener('pointerdown', holdFocus);
            toggle.addEventListener('mousedown', holdFocus);
            toggle.addEventListener('click', () => BroadcastInput.toggle());
        }

        // The picker surface. It lives inside #mobileInputBar (positioned by
        // CSS, anchored to the chip, opening upward) and is a sibling of the
        // chip so the outside-click test below can keep it open.
        const chip = document.getElementById('composerTarget');
        const bar = document.getElementById('mobileInputBar');
        if (chip && bar) {
            const menu = document.createElement('div');
            menu.id = 'broadcastTargetMenu';
            menu.className = 'broadcast-target-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('data-i18n-aria-label', 'broadcast.targetMenu');
            menu.setAttribute('aria-label', 'Broadcast targets');
            menu.hidden = true;
            bar.appendChild(menu);

            chip.setAttribute('aria-haspopup', 'menu');
            chip.setAttribute('aria-controls', 'broadcastTargetMenu');
            chip.setAttribute('aria-expanded', 'false');
            chip.addEventListener('pointerdown', holdFocus);
            chip.addEventListener('mousedown', holdFocus);
            chip.addEventListener('click', () => BroadcastInput.toggleMenu());

            // Outside click dismisses the picker (never Broadcast itself).
            window.addEventListener('click', event => {
                if (!BroadcastInput.menuOpen) return;
                if (event.target.closest('#broadcastTargetMenu')
                    || event.target.closest('#composerTarget')) {
                    return;
                }
                BroadcastInput.closeMenu();
            });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && BroadcastInput.menuOpen) {
                    BroadcastInput.closeMenu();
                    chip.focus({ preventScroll: true });
                }
            });
        }
    });

    // The sendable set changed (a session arrived, connected, dropped or was
    // closed): reconcile the selection under the current mode (auto-include in
    // all-mode, default-unselected in a custom subset) and republish so the
    // chip's count label stays honest. While Broadcast is off this keeps the
    // Bookkeeping cheap (syncSelection publishes only when open); show
    // always restarts from the Select All default anyway.
    document.addEventListener('sshdeck:sendable-sessions-changed', () => {
        BroadcastInput.syncSelection();
    });
})();
