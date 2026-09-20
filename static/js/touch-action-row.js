/*
 * Touch global/action row -- plan v5 section 3.
 * ============================================
 *
 * Row one of the touch header carries exactly six global actions, and row two
 * carries the session strip alone. This module owns the two things markup and
 * CSS cannot express on their own:
 *
 *   1. RELOCATION. Four of the six actions already exist as canonical elements
 *      with their own listeners and aria state -- Broadcast, Save transcript
 *      and Notes in .tab-row-actions, and the global Menu trigger in the dock.
 *      On touch they MOVE into this row and move back on desktop. They are
 *      never cloned: a clone would duplicate #broadcastToggleBtn's aria-pressed
 *      state, give the app two menu triggers (forbidden by v5 section 3), and
 *      split listeners across two nodes. Moving a node preserves everything
 *      attached to it -- the same technique session-manager.js already uses for
 *      the landscape session strip.
 *
 *   2. The Layout menu. The canonical control is the 3-button .split-controls
 *      cluster, which costs ~132px and is what made six actions overflow a
 *      359px row. On touch it collapses to ONE button plus an anchored menu
 *      whose options are rendered FROM those same buttons, so the device cap
 *      (desktop 1-6, iPad 1-4, phone 1-2) stays defined in exactly one place
 *      and a click here is delegated to the real .split-btn.
 *
 * Nothing here is hidden with display:none: every required action is either in
 * this row or inside the anchored menu surface, both reachable by touch.
 */
(function () {
    'use strict';

    const byId = id => document.getElementById(id);

    // The canonical touch cascade used across the shell. PRIMARY capability as a
    // conjunction, not width: a touch iPad at 1024 is still touch, and a mouse
    // desktop that merely owns a touchscreen is still desktop (owner
    // correction -- the former standalone (any-pointer: coarse) and
    // (hover: none) branches took the approved desktop shell away from such a
    // machine). Reuses TerminalManager's constant so the two cannot drift; the
    // literal is the same string and exists only for load-order safety.
    const TOUCH_QUERY =
        (typeof TerminalManager !== 'undefined' && TerminalManager.TOUCH_SHELL_QUERY)
        || '(pointer: coarse) and (hover: none), (max-width: 767px)';

    // Phone landscape: the shell's own phone test, which width alone cannot
    // make (a 926px-wide phone reads as a tablet). Only the pane-count cap
    // and the layout menu's caption read it; the header and the strip are the
    // same there as in portrait.
    const LANDSCAPE_QUERY =
        '(pointer: coarse) and (min-width: 768px) and (max-height: 500px)';

    /*
     * Label key per layout choice, keyed on the full (count, variant) identity
     * because two counts appear twice (mockup lines 103-104 and 107-108). The
     * other five locales stay in parity.
     */
    const LAYOUT_LABEL_KEYS = {
        '1:default': 'layoutMenu.one',
        '2:default': 'layoutMenu.twoCols',
        '2:rows': 'layoutMenu.twoRows',
        '3:default': 'layoutMenu.three',
        '4:default': 'layoutMenu.four',
        '4:main': 'layoutMenu.fourMain',
        '5:default': 'layoutMenu.five',
        '6:default': 'layoutMenu.six',
    };

    /*
     * Each relocatable action. The desktop position is not declared here: init
     * records each element's real parent and next sibling once, before the first
     * move, so a restore cannot reorder the toolbar even if the markup changes.
     */
    const RELOCATED = [
        // v5 section 4 gives Layout its markup home in the DESKTOP contextual
        // toolbar, so on touch it must be moved into the action row like the
        // other canonical actions. It leads the row per v5 section 3.
        { id: 'touchLayoutControl' },
        { id: 'broadcastToggleBtn' },
        { id: 'saveTranscriptBtn' },
        // Reconnect's home is the desktop toolbar too, so it moves like the rest.
        { id: 'touchReconnectBtn' },
        { id: 'notepadOpenBtn' },
        // relocates into the row like the rest. It was once pinned to the
        // dock on the premise that phone landscape hid the header and a moved
        // Menu measured 0x0 there; the row is a real, measurable surface at
        // every touch tier now (phone landscape draws the same two-row header
        // as portrait since). Leaving it in the dock also put the
        // shell's only menu trigger in the composer, which v5 section 3
        { id: 'mobileMoreBtn' },
    ];

    /*
     * SECONDARY actions -- reachable, but not among the six.
     *
     * Files and Commands are v5 DESKTOP-HEADER controls (mockup
     * lines 68-70) with their own listeners. They are NOT part of v5 section 3's
     * six touch actions, so they must not sit in the action row; but they must
     * not disappear either -- losing them on iPad/mobile was a reported
     * regression. On touch they MOVE into the one canonical menu.
     *
     * Moving, not cloning or proxying: the node keeps the listener that already
     * works, so there is no second handler body to drift. They used to be
     * reachable only through three PROXY buttons in the deleted
     * #mobileMoreActions list, each firing.click at the real control through
     * data-mobile-action-target; that indirection is what made the touch shell
     * carry a second menu shape.
     *
     *   fileTransferBtn    <- was proxied by #mobileFilesBtn (contextual Files)
     *   commandLibraryBtn  <- was proxied by #mobileCommandsBtn
     *
     * W14 item 7: newConnectionBtn is NO
     * LONGER relocated. It lives permanently, icon-only, as the first child
     * of .session-tabs-row in EVERY viewport -- the strip is its one home and
     * it never enters #mobileMoreSheet. Listing it here again would move the
     * strip's own first child into the sheet on touch, which is exactly the
     * regression the instruction removes.
     *
     * OWNER CORRECTION (second pass): the destination is the TREE,
     * not the tree's parent. These three used to be appended to
     * #mobileSettingsHost as SIBLINGS of #accountDropdownHeader and given
     * `.mobile-more-action`, which painted each as its own bordered card ABOVE an
     * unbordered account tree -- two visual row systems in one sheet, leaving the
     * identity block stranded in the middle and the account actions reading as a
     * detached full-width block at the bottom. The owner reported exactly that.
     *
     * They are now inserted INSIDE the tree, immediately after the identity
     * block, so the sheet renders as ONE continuous menu in the order the
     * menu specifies:
     *
     *   identity, Files, Command Library, Profiles, ...rest
     *
     * (New Connection left this list in W14 item 7: the strip's '+' is its
     * own permanent home on every tier.)
     *
     * They also adopt the tree's single row shape (`.account-item`
     * `.account-action`, mockup line 274) instead of a card of their own.
     * `.account-action` is load-bearing, not cosmetic: it is what makes
     * header-menus.js's tree-level handler dismiss the menu after the control's
     * own listener has run, which is the one-shot behaviour the sheet-level
     * handler used to provide for these nodes.
     *
     * Reload is NOT listed, and #commandRailOpenBtn is gone from this list:
     *   - #reloadPageBtn already LIVES inside #accountDropdownHeader
     *     (templates/index.html:162), so the tree carries it into the sheet by
     *     itself. Listing it here moved it OUT of the tree and re-inserted it as
     *     one of those detached sibling cards -- it was creating the defect.
     *   - #commandRailOpenBtn has NO production node: no such id in
     *     templates/index.html and no createElement for it in static/js. The
     *     Entry was dead config -- byId returned null and the spec was skipped
     *     on every sync.
     * Profiles is not listed either: #manageProfilesBtn is the tree's own first
     * action (mockup line 76) and arrives with it exactly once. The deleted
     * #mobileProfilesBtn proxy was the duplicate.
     */
    const SECONDARY = [
        // W14 item 7: newConnectionBtn is NOT here -- the same node is the
        // permanent icon-only first child of .session-tabs-row on every tier.
        { id: 'fileTransferBtn' },
        { id: 'commandLibraryBtn' },
    ];

    /*
     * There is no PRIMARY-into-the-sheet list any more (owner correction
     *second pass).
     *
     * It existed on the premise that phone landscape hides .header, so the five
     * primary actions in #touchActionRow would measure 0x0 and had to be revealed
     * through the global Menu instead. That premise lapsed when phone landscape
     * Gained the approved 40px header band: the row is a real,
     * Measurable surface there, so `sync` keeps the six actions in it at every
     * touch tier and called `dockPrimary(false)` on BOTH branches -- the
     * into-the-sheet path was never once reached.
     *
     * The machinery it left behind was not inert: it declared a second row shape
     * (`.touch-primary-in-sheet`) and a second sheet-entry class for the same
     * surface, which is the ambiguity that let two visual row systems coexist in
     * One menu. The list, `dockPrimary`, its two dead call sites, its CSS and
     * its `#mobileSettingsHost > .touch-layout-control` overrides are all gone.
     * The five primaries' desktop homes are still recorded, by RELOCATED, which
     * already contains every one of them.
     */

    const TouchActionRow = {
        touchMedia: null,
        bound: false,
        homes: new Map(),

        init() {
            const row = byId('touchActionRow');
            if (!row) {
                return;
            }

            // Remember each element's desktop position ONCE, before the first
            // move, so restoring never depends on where it currently sits.
            // Init runs at DOMContentLoaded, when every element is still at its
            // MARKUP home -- so this records the true desktop position whatever
            // shell the page boots in (a phone included). Recording instead at
            // first RESTORE was tried and reverted: by that moment a
            // touch-boot has already moved the
            // element into the touch row, so the first exit would have recorded
            // the touch row as "home" and restored into it.
            RELOCATED.forEach(spec => {
                const el = byId(spec.id);
                if (el && !this.homes.has(spec.id)) {
                    this.homes.set(spec.id, {
                        parent: el.parentElement,
                        next: el.nextElementSibling,
                    });
                }
            });
            SECONDARY.forEach(spec => {
                const el = byId(spec.id);
                if (el && !this.homes.has(spec.id)) {
                    this.homes.set(spec.id, {
                        parent: el.parentElement,
                        next: el.nextElementSibling,
                    });
                }
            });
            if (!this.touchMedia) {
                this.touchMedia = window.matchMedia(TOUCH_QUERY);
            }
            this.sync(this.touchMedia.matches);

            // Init may run again (tests, re-integration): re-synchronize every
            // call, but install exactly one listener set.
            if (this.bound) {
                return;
            }
            this.bound = true;

            const onChange = event => this.sync(event.matches);
            if (typeof this.touchMedia.addEventListener === 'function') {
                this.touchMedia.addEventListener('change', onChange);
            } else {
                this.touchMedia.addListener(onChange);
            }

            this.bindLayoutMenu();
            this.bindReconnect();

            // The reconnect proxy mirrors the canonical control's enabled state,
            // which changes with the active session.
            document.addEventListener('sshdeck:active-session-changed',
                () => this.syncReconnect());
            this.syncReconnect();
        },

        /*
         * Move the four canonical actions into this row on touch, and back to
         * their recorded desktop homes otherwise. Order in the row is fixed by
         * RELOCATED and by Layout/Reconnect already being in the markup, giving
         * v5's sequence: Layout, Broadcast, Save transcript, Reconnect, Notes,
         * Menu.
         */
        sync(isTouch) {
            const row = byId('touchActionRow');
            if (!row) {
                return;
            }

            if (isTouch) {
                // Portrait phone, iPad, and phone landscape alike: the six
                // actions sit in the row in v5 section 3 order. RELOCATED is
                // already in that order and the row starts empty here, so
                // appending in sequence is the order -- no anchor element, and
                // no ordering rule stated twice.
                RELOCATED.forEach(spec => {
                    const el = byId(spec.id);
                    if (!el) {
                        return;
                    }
                    row.appendChild(el);
                    el.classList.add('touch-action-btn');
                });
                this.dockSecondary(true);
                this.renderLayoutMenu();
                return;
            }

            {
                RELOCATED.forEach(spec => {
                    const el = byId(spec.id);
                    if (!el) {
                        return;
                    }
                    el.classList.remove('touch-action-btn');
                    this.restoreHome(spec);
                });
                this.dockSecondary(false);
                this.closeLayoutMenu();
            }

            // Only the desktop path reaches here, so the brand belongs at its
            // recorded home. Both touch paths return early above.

            this.renderLayoutMenu();
        },

        // Put a relocatable action back at its recorded desktop position.
        restoreHome(spec) {
            const el = byId(spec.id);
            const home = this.homes.get(spec.id);
            if (!el || !home || !home.parent) {
                return;
            }
            if (home.next && home.next.parentElement === home.parent) {
                home.parent.insertBefore(el, home.next);
            } else {
                home.parent.appendChild(el);
            }
        },

        /*
         * Move Files and Command Library INTO the canonical
         * account tree on touch, and back to their recorded desktop homes
         * otherwise. (New Connection is not in SECONDARY since W14 item 7:
         * the strip's '+' never enters the sheet.)
         *
         * The insertion point is immediately after the tree's identity block, so
         * the rendered order is identity, Files, Command Library,
         * then the tree's own actions starting at Profiles. Inserting into the
         * tree rather than beside it is what makes the sheet ONE continuous menu:
         * these rows are then styled by the tree's own row rule
         * (`#accountDropdownHeader > .account-item`, deck.css:919) and there is no
         * second card system in the surface.
         *
         * Each control carries a visible label on the way in and loses it on the
         * way out. The BUTTON itself is untouched otherwise: same id, same
         * listeners, same aria attributes -- so its handler fires exactly once,
         * from the one node that has always owned it.
         */
        dockSecondary(isTouch) {
            const tree = byId('accountDropdownHeader');
            SECONDARY.forEach(spec => {
                const el = byId(spec.id);
                if (!el) {
                    return;
                }

                if (isTouch && tree) {
                    /*
                     * After the identity block, and after any sibling this loop
                     * has already placed, so SECONDARY order survives: each
                     * insertion anchors on the last placed node rather than on
                     * the identity block itself, which would reverse them.
                     */
                    const placed = SECONDARY
                        .map(s => byId(s.id))
                        .filter(node => node && node !== el
                            && node.parentElement === tree);
                    const anchor = placed.length
                        ? placed[placed.length - 1]
                        : tree.querySelector(':scope > .account-menu-identity');
                    if (anchor) {
                        anchor.after(el);
                    } else {
                        tree.prepend(el);
                    }
                    /*
                     * The tree's row shape, not a card of its own.
                     * `.account-action` also makes the tree-level handler in
                     * header-menus.js dismiss the menu after this control's own
                     * listener has run.
                     *
                     * No label is added: all three ship a visible
                     * `<span class="btn-label" data-i18n>` of their own, which is
                     * hidden only by `.touch-action-row .btn-label` while they sit
                     * in the action row -- not while they are here.
                     */
                    el.classList.add('account-item', 'account-action');
                    return;
                }

                el.classList.remove('account-item', 'account-action');
                this.restoreHome(spec);
            });
        },

        /*
         * ApplySecondaryLabel is GONE (second pass).
         *
         * It appended a `[data-touch-secondary-label]` span to icon-only controls
         * docked into the sheet, and it already carried a guard for the case where
         * the control paints its own text -- added after the owner reported
         * "Reload" rendering its title twice (defect 8).
         *
         * With SECONDARY reduced to New Connection, Files and Command Library,
         * that guard is now the only branch reachable: all three ship a visible
         * `<span class="btn-label" data-i18n>` in the markup
         * (templates/index.html:80, 96, 100), so the function returned without
         * doing anything on every call. The label those rows show in the menu is
         * their own .btn-label, which i18n.js already translates and which the
         * `.touch-action-row .btn-label { display: none }` rule hides only while
         * they are in the action row -- not here.
         *
         * Removing it also removes the last writer of a class of bug the guard
         * existed to contain: a second, separately-translated label leaf beside a
         * control's real one.
         */

        /*
         * Which layout choices this device may offer, as full (count, variant)
         * identities -- v5 section 7 for the counts (desktop 1-6, iPad 1-4,
         * phone 1-2) and v5 lines 138-142 for which variants survive on touch.
         *
         * The touch menu is FIVE entries, not six: the mockup's touch layout
         * count-only rule admits 4:main and produces a sixth entry the mockup
         * does not have. Measured before this was fixed: 6 entries on iPad.
         *
         * Derived from the capability breakpoint EXPLICITLY, never from the
         * source buttons' CSS visibility. Reading getComputedStyle(...).display
         * would make menu contents a side effect of the stylesheet: a hidden
         * canonical button would silently remove a legitimate layout option, and
         * the caps would be expressed in two places that could drift. The
         * buttons remain the canonical click targets; only the POLICY lives
         * here.
         *
         * This decides what the menu OFFERS. It is not the enforcement boundary:
         * SessionManager.layoutCap clamps every layout change, because the
         * Hidden canonical buttons still respond to Element.click and a
         * layout restored from localStorage never passes through a menu at all.
         * Both read the same queries in the same order, so they agree; the
         * engine is authoritative if they ever do not.
         */
        allowedChoices() {
            const coarse = window.matchMedia(TOUCH_QUERY).matches;
            if (!coarse) {
                return ['1:default', '2:default', '2:rows', '3:default',
                    '4:default', '4:main', '5:default', '6:default'];
            }
            // A phone in landscape is WIDER than 767px, so width alone reads it
            // as a tablet. LANDSCAPE_QUERY is the shell's own phone-landscape
            // test, so the phone cap follows the device, not the orientation.
            if (window.matchMedia(LANDSCAPE_QUERY).matches) {
                return ['1:default', '2:default', '2:rows'];
            }
            const tablet = window.matchMedia('(min-width: 768px)').matches;
            return tablet
                ? ['1:default', '2:default', '2:rows', '3:default', '4:default']
                : ['1:default', '2:default', '2:rows'];
        },

        /*
         * The pane-count cap, derived FROM the offered choices so the badge can
         * never advertise a number the menu does not honour.
         */
        allowedLayouts() {
            const counts = this.allowedChoices()
                .map(k => parseInt(k.split(':')[0], 10));
            return [...new Set(counts)].sort((a, b) => a - b);
        },

        /*
         * The policy caption and count badge the mockup puts in the dropdown
         * heading (lines 100 and 137, strings from mockup line 402).
         */
        layoutPolicy() {
            const allowed = this.allowedLayouts();
            const max = allowed[allowed.length - 1];
            const coarse = window.matchMedia(TOUCH_QUERY).matches;
            let key = 'layoutMenu.policyDesktop';
            if (coarse) {
                if (window.matchMedia(LANDSCAPE_QUERY).matches) {
                    key = 'layoutMenu.policyPhoneLandscape';
                } else if (window.matchMedia('(min-width: 768px)').matches) {
                    key = 'layoutMenu.policyTablet';
                } else {
                    key = 'layoutMenu.policyPhone';
                }
            }
            return { key, badge: `1–${max}`, max };
        },

        t(key, fallback) {
            return (window.i18n && typeof i18n.t === 'function')
                ? i18n.t(key)
                : fallback;
        },

        /*
         * Options are rendered from the canonical .split-btn elements so a click
         * here forwards to the real handler, but WHICH options appear is decided
         * By allowedLayouts above. A canonical button that the stylesheet
         * happens to hide is still a valid menu entry.
         *
         * Structure follows the mockup's layout menu (lines 99-111): a heading
         * carrying the title, the policy caption and the count badge, then a
         * 4-column grid of choices, each choice a miniature PREVIEW of the shape
         * it selects plus a label. The preview cells are real grid children, so
         * the miniature is a scale model of the actual template rather than an
         * icon that could drift from it.
         */
        renderLayoutMenu() {
            const menu = byId('layoutMenu');
            if (!menu) {
                return;
            }
            const allowed = this.allowedChoices();
            const buttons = Array.from(
                document.querySelectorAll('.tab-row-actions .split-controls .split-btn')
            ).filter(btn => allowed.includes(
                `${btn.dataset.layout}:${btn.dataset.variant || 'default'}`
            ));

            menu.textContent = '';

            const policy = this.layoutPolicy();
            const heading = document.createElement('div');
            heading.className = 'layout-menu-heading';
            const headingText = document.createElement('div');
            const title = document.createElement('strong');
            title.setAttribute('data-i18n', 'layoutMenu.title');
            title.textContent = this.t('layoutMenu.title', 'Terminal layout');
            const caption = document.createElement('small');
            caption.className = 'layout-menu-policy';
            caption.setAttribute('data-i18n', policy.key);
            caption.textContent = this.t(policy.key, '');
            headingText.appendChild(title);
            headingText.appendChild(caption);
            const badge = document.createElement('span');
            badge.className = 'layout-count-badge';
            badge.textContent = policy.badge;
            heading.appendChild(headingText);
            heading.appendChild(badge);
            menu.appendChild(heading);

            const grid = document.createElement('div');
            grid.className = 'layout-grid';
            menu.appendChild(grid);

            buttons.forEach(btn => {
                const layout = parseInt(btn.dataset.layout, 10);
                const variant = btn.dataset.variant || 'default';
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'touch-layout-option';
                item.setAttribute('role', 'menuitemradio');
                item.dataset.layout = btn.dataset.layout;
                item.dataset.variant = variant;
                // Both halves must match: two same-count choices exist, and
                // comparing the count alone would tick both of them.
                const selected = btn.getAttribute('aria-pressed') === 'true';
                item.setAttribute('aria-checked', selected ? 'true' : 'false');

                item.appendChild(this.buildPreview(layout, variant));

                const label = document.createElement('span');
                const key = LAYOUT_LABEL_KEYS[`${layout}:${variant}`];
                if (key) {
                    label.setAttribute('data-i18n', key);
                }
                // The canonical button's accessible name is the fallback, so a
                // missing translation still yields a named control rather than
                // an empty one.
                label.textContent = key
                    ? this.t(key, btn.getAttribute('aria-label'))
                    : (btn.getAttribute('aria-label') || btn.textContent);
                item.appendChild(label);

                grid.appendChild(item);
            });
        },

        /*
         * The miniature shape shown on a layout choice (mockup lines 285-289).
         * Cell COUNT and the tall-cell span are set here; the grid template
         * itself is CSS, keyed on the same variant class the real grid uses, so
         * preview and reality cannot diverge.
         */
        buildPreview(layout, variant) {
            const preview = document.createElement('span');
            preview.className = `layout-preview layout-preview-${layout}`;
            if (variant !== 'default') {
                preview.classList.add(`layout-preview-${layout}-${variant}`);
            }
            preview.setAttribute('aria-hidden', 'true');
            for (let i = 0; i < layout; i++) {
                preview.appendChild(document.createElement('i'));
            }
            return preview;
        },

        layoutMenuIsOpen() {
            const menu = byId('layoutMenu');
            return !!menu && !menu.hidden;
        },

        openLayoutMenu() {
            const menu = byId('layoutMenu');
            const trigger = byId('layoutMenuBtn');
            if (!menu || !trigger) {
                return;
            }
            this.renderLayoutMenu();
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        },

        closeLayoutMenu() {
            const menu = byId('layoutMenu');
            const trigger = byId('layoutMenuBtn');
            if (menu) {
                menu.hidden = true;
            }
            if (trigger) {
                trigger.setAttribute('aria-expanded', 'false');
            }
        },

        bindLayoutMenu() {
            const trigger = byId('layoutMenuBtn');
            const menu = byId('layoutMenu');
            if (!trigger || !menu) {
                return;
            }

            trigger.addEventListener('click', event => {
                event.preventDefault();
                // Never focus the composer or open the keyboard: this is a
                // header control, and the composer is not involved.
                this.layoutMenuIsOpen() ? this.closeLayoutMenu() : this.openLayoutMenu();
            });

            // Delegated to the real .split-btn so layout logic stays in exactly
            // one place (session-manager.js owns the pane work). Matched on BOTH
            // halves of the identity: two choices share a count, so a
            // button and silently apply the wrong shape.
            menu.addEventListener('click', event => {
                const option = event.target.closest('.touch-layout-option');
                if (!option) {
                    return;
                }
                const variant = option.dataset.variant || 'default';
                const real = document.querySelector(
                    '.tab-row-actions .split-controls .split-btn'
                    + `[data-layout="${option.dataset.layout}"]`
                    + `[data-variant="${variant}"]`
                );
                this.closeLayoutMenu();
                if (real) {
                    real.click();
                }
                this.renderLayoutMenu();
            });

            window.addEventListener('click', event => {
                if (!this.layoutMenuIsOpen()) {
                    return;
                }
                if (event.target.closest('#layoutMenu')
                    || event.target.closest('#layoutMenuBtn')) {
                    return;
                }
                this.closeLayoutMenu();
            });

            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && this.layoutMenuIsOpen()) {
                    this.closeLayoutMenu();
                    byId('layoutMenuBtn')?.focus();
                }
            });
        },

        // The canonical reconnect control lives in the session action sheet.
        // This is a proxy, not a second implementation: it forwards the click
        // and mirrors the disabled state.
        bindReconnect() {
            const proxy = byId('touchReconnectBtn');
            if (!proxy) {
                return;
            }
            proxy.addEventListener('click', () => {
                const real = byId('sessionActionReconnect');
                if (real && !real.disabled) {
                    real.click();
                }
            });
        },

        syncReconnect() {
            const proxy = byId('touchReconnectBtn');
            const real = byId('sessionActionReconnect');
            if (!proxy || !real) {
                return;
            }
            proxy.disabled = real.disabled;
        },
    };

    window.TouchActionRow = TouchActionRow;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TouchActionRow.init());
    } else {
        TouchActionRow.init();
    }
})();
