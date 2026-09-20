/*
 * The header account menu: theme picker, language picker, and the account
 * dropdown that holds them.
 *
 * This was 146 lines of inline <script> in templates/index.html, driven by five
 * inline onclick= attributes. It moved out for three reasons, none cosmetic:
 *
 *   - Inline script cannot be cache-busted. Every other asset carries a ?v= pin
 *     (see tests/test_profile_launcher_ui.py); an inline block ships with the
 *     HTML, so a browser holding a cached page holds the old handlers too.
 *   - Inline onclick= requires the function to be a window global, which is why
 *     these six were. Delegated listeners let them be file-local instead.
 *   - The desktop shell work restructures the header markup around these
 *     controls. Handlers written into the markup have to be edited in lockstep
 *     with it; handlers bound by id or by delegation survive the move.
 *
 * Behaviour is deliberately unchanged. The open/close semantics below are the
 * ones that shipped, including the part that is easy to "tidy" wrongly: a click
 * inside the account dropdown closes it only when it lands on .account-action
 * (Admin / Change Password / Logout). The Theme and Language rows are
 * .account-expander and toggle a sub-section in place, so closing on those would
 * shut the menu the moment you tried to pick a theme.
 */
(function () {
    'use strict';

    // Module-scoped MutationObserver for sessionBar visibility tracking.
    // Disconnected before creating a new one (re-init guard) and on page unload.
    let sessionBarObserver = null;

    // Theme ids must match the [data-theme] blocks in static/css/style.css.
    // `glass` has no block of its own -- it IS :root, which is why it is also
    // the default below. The colour is the swatch dot, not a token: it only has
    // to identify the theme in the list.
    const THEMES = [
        { id: 'glass', name: 'Glass Ops', color: '#58a6ff' },
        { id: 'retro', name: 'Retro Future', color: '#ffb454' },
        { id: 'solar', name: 'Solar Drift', color: '#6ea8ff' },
        { id: 'paper', name: 'Paper Ops', color: '#c77d48', light: true },
        { id: 'noir', name: 'Noir Terminal', color: '#7f91ff' },
        { id: 'arctic-ice', name: 'Arctic Ice', color: '#06b6d4' },
        { id: 'rose-gold', name: 'Rose Gold', color: '#f43f5e' },
        { id: 'cyberpunk-neon', name: 'Cyberpunk Neon', color: '#d946ef' },
        { id: 'emerald-matrix', name: 'Emerald Matrix', color: '#10b981' },
        { id: 'obsidian', name: 'Obsidian', color: '#ffffff' }
    ];

    const byId = id => document.getElementById(id);
    let initialized = false;

    // Canonical touch-shell capability query (dated amendment,
    // This string MUST match
    // TerminalManager.TOUCH_SHELL_QUERY and the
    // @media (pointer: coarse) and (hover: none) blocks in style.css/deck.css.
    // It answers one question with PRIMARY capability as a conjunction: is this
    // a touch shell? A standalone (hover: none) or (any-pointer: coarse) branch
    // also matched a mouse desktop carrying a touchscreen, which cost that
    // desktop the approved desktop shell. Width appears only as the approved
    // narrow fallback. TerminalManager loads before this file, so we reuse its
    // constant to guarantee the two stay in lockstep.
    const mobileShellMedia = window.matchMedia(
        (typeof TerminalManager !== 'undefined' && TerminalManager.TOUCH_SHELL_QUERY)
            || '(pointer: coarse) and (hover: none), (max-width: 767px)'
    );

    function focusIfVisible(element) {
        if (!element
            || !element.isConnected
            || element.disabled
            || element.getClientRects().length === 0) {
            return false;
        }
        element.focus();
        return document.activeElement === element;
    }

    function setExpanded(id, expanded) {
        byId(id)?.setAttribute('aria-expanded', String(expanded));
    }

    function setInactive(element, inactive) {
        if (!element) {
            return;
        }
        element.hidden = inactive;
        element.toggleAttribute('inert', inactive);
        element.setAttribute('aria-hidden', String(inactive));
    }

    function setThemeDropdownOpen(open) {
        const dropdown = byId('themeDropdownHeader');
        dropdown?.classList.toggle('show', open);
        dropdown?.setAttribute('aria-hidden', String(!open));
        setExpanded('themeExpanderHeader', open);
    }

    function setLangDropdownOpen(open) {
        const dropdown = byId('langDropdownHeader');
        dropdown?.classList.toggle('show', open);
        dropdown?.setAttribute('aria-hidden', String(!open));
        setExpanded('langExpanderHeader', open);
    }

    function setAccountDropdownOpen(open) {
        const dropdown = byId('accountDropdownHeader');
        dropdown?.classList.toggle('show', open);
        dropdown?.setAttribute('aria-hidden', String(!open));
        setExpanded('accountBtnHeader', open);
    }

    /*
     * The bottom edge a FINGER reaches on this control, which is not always the
     * bottom edge it paints.
     *
     * A control may carry an invisible ::after hit target larger than its
     * painted box (the session chips do; the six action buttons did while
     * phone landscape drew a 40px band, retired
     *). Anything that must not overlap the control has to clear
     * the reachable box; the painted box is the wrong premise and silently
     * steals hit rows.
     *
     * Read from computed style rather than assumed: ::after has no node, so
     * there is no rect to measure. `top` resolves against the padding box, so
     * the border width is added back, and the transform matrix's vertical
     * component (`f`) carries both the -50% centring and the +2px nudge that
     * keeps the band inside the viewport. A tier with no ::after (content:
     * 'none') falls through to the painted bottom unchanged.
     */
    function triggerReachableBottom(trigger, rect) {
        const after = getComputedStyle(trigger, '::after');
        if (!after || after.content === 'none' || after.content === 'normal') {
            return rect.bottom;
        }
        const height = parseFloat(after.height);
        if (!Number.isFinite(height) || height <= 0) {
            return rect.bottom;
        }
        const borderTop = parseFloat(getComputedStyle(trigger).borderTopWidth) || 0;
        const offsetTop = parseFloat(after.top);
        const anchor = Number.isFinite(offsetTop)
            ? rect.top + borderTop + offsetTop
            : rect.top + rect.height / 2;
        let shift = 0;
        if (after.transform && after.transform !== 'none'
            && typeof DOMMatrixReadOnly === 'function') {
            try {
                shift = new DOMMatrixReadOnly(after.transform).f || 0;
            } catch {
                shift = 0;
            }
        }
        return Math.max(rect.bottom, anchor + shift + height);
    }

    function positionMobileMore() {
        const sheet = byId('mobileMoreSheet');
        const trigger = byId('mobileMoreBtn');
        if (!sheet || !trigger || sheet.hidden) {
            return;
        }
        // Entry 27 R4: hang exactly 1px below the live trigger. #mobileMoreBtn
        // is relocated into #touchActionRow on every touch tier, so the dock
        // bottom-anchor is a stale premise — measure the trigger itself.
        const rect = trigger.getBoundingClientRect();
        // S17 step B: 1px below the trigger's REACHABLE bottom, not its painted
        // bottom. Where the two differ (a control with a ::after hit box taller
        // than its paint) anchoring on the painted edge lets this card --
        // #mobileMoreSheet (z 1200, inside #sessionBar z 1200) out-stacks
        // #mobileMoreBtn (z 1, trapped inside .header z 1000) -- take the
        // bottom rows back off the hit box; a z-index on the ::after cannot
        // fix that, a stacking context is not escapable from inside. Measured
        // on the 40px phone-landscape band this shell had until.
        const reachableBottom = triggerReachableBottom(trigger, rect);
        const right = Math.max(6, window.innerWidth - rect.right);
        const dock = byId('sessionBar');
        const vpHeight = window.visualViewport
            ? window.visualViewport.height : window.innerHeight;
        let floorY = vpHeight;
        if (dock) {
            const dockRect = dock.getBoundingClientRect();
            if (dockRect.height > 0 && dockRect.top > 0) {
                floorY = dockRect.top;
            }
        }
        const top = reachableBottom + 1;
        sheet.style.top = `${top}px`;
        sheet.style.bottom = 'auto';
        sheet.style.right = `${Math.round(right)}px`;
        sheet.style.left = 'auto';
        const maxHeight = Math.max(120, Math.floor(floorY - top - 1));
        sheet.style.maxHeight = `${maxHeight}px`;
    }

    function setMobileMoreOpen(open) {
        setInactive(byId('mobileMoreSheet'), !open);
        setExpanded('mobileMoreBtn', open);
        if (open) {
            /*
             * Position twice, and the second time is the load-bearing one.
             *
             * Revealing the sheet changes layout in the bar that owns the
             * trigger, so a rect read in the same task is pre-settle: measured at
             * phone390 the trigger's bottom read 44.06 here while its settled
             * value is 43.5, which put the card 1.55px from the trigger instead
             * of the 1px mockup 265-268 specifies. The synchronous call keeps the
             * card correct for any caller that measures immediately; the
             * post-layout frame then corrects it to the settled geometry.
             */
            positionMobileMore();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    if (mobileMoreIsOpen()) positionMobileMore();
                });
            }
        }
    }

    /*
     * SetMobileSettingsOpen is GONE.
     *
     * It switched the sheet between two views -- an intermediate
     * #mobileMoreActions proxy list and a #mobileSettingsView that hosted the
     * real account tree -- which is precisely the "two menu entry points" the
     * owner reported. There is no view to switch any more: the sheet is a bare
     * host and the canonical tree is moved straight into it, so the open path is
     * HostAccountDropdown and the close path is restoreAccountDropdown.
     */

    function closeThemeDropdown() {
        setThemeDropdownOpen(false);
    }

    function closeLangDropdown() {
        setLangDropdownOpen(false);
    }

    function toggleThemeDropdown(event) {
        if (event) {
            event.stopPropagation();
        }
        closeLangDropdown();
        const dropdown = byId('themeDropdownHeader');
        setThemeDropdownOpen(!dropdown?.classList.contains('show'));
    }

    function toggleLangDropdown(event) {
        if (event) {
            event.stopPropagation();
        }
        closeThemeDropdown();
        const dropdown = byId('langDropdownHeader');
        setLangDropdownOpen(!dropdown?.classList.contains('show'));
    }

    function toggleAccountDropdown(event) {
        if (event) {
            event.stopPropagation();
        }
        closeThemeDropdown();
        closeLangDropdown();
        const dropdown = byId('accountDropdownHeader');
        setAccountDropdownOpen(!dropdown?.classList.contains('show'));
    }

    function accountDropdownIsHosted() {
        return byId('accountDropdownHeader')?.parentElement
            === byId('mobileSettingsHost');
    }

    function restoreAccountDropdown() {
        const dropdown = byId('accountDropdownHeader');
        const marker = byId('accountDropdownRestoreMarker');
        closeThemeDropdown();
        closeLangDropdown();
        setAccountDropdownOpen(false);
        if (dropdown && marker && marker.nextElementSibling !== dropdown) {
            marker.after(dropdown);
        }
    }

    /*
     * Move the ONE canonical account tree into the touch sheet and open it.
     *
     * This is a MOVE, not a clone: appendChild reparents the live
     * #accountDropdownHeader, so every control inside it -- Profiles, File
     * Transfer, theme, language, scrollback, keys, jump hosts, admin, change
     * password, logout -- exists exactly once in the document and keeps the
     * Listener that was bound to it at startup. restoreAccountDropdown puts it
     * back after its marker in .account-selector on close, which is why the
     * desktop account button keeps working after any number of touch opens.
     *
     * It replaces openMobileSettings: there is no Settings step to open.
     */
    function hostAccountDropdown() {
        const dropdown = byId('accountDropdownHeader');
        const host = byId('mobileSettingsHost');
        if (!dropdown || !host) {
            return;
        }
        if (dropdown.parentElement !== host) {
            host.appendChild(dropdown);
        }
        setAccountDropdownOpen(true);
    }

    function mobileMoreIsOpen() {
        const sheet = byId('mobileMoreSheet');
        return Boolean(sheet && !sheet.hidden);
    }

    function closeMobileMore({ restoreFocus = true } = {}) {
        const sheet = byId('mobileMoreSheet');
        if (!sheet) {
            return;
        }
        const wasOpen = !sheet.hidden;

        // Leave focus before restoring or hiding any subtree that may contain
        // the currently focused action.
        if (wasOpen && restoreFocus && mobileShellMedia.matches) {
            focusIfVisible(byId('mobileMoreBtn'));
        }

        restoreAccountDropdown();
        setMobileMoreOpen(false);
    }

    function openMobileMore() {
        const sheet = byId('mobileMoreSheet');
        if (!sheet || !mobileShellMedia.matches) {
            return;
        }
        // Host the canonical tree BEFORE the sheet is exposed, so the sheet is
        // never painted empty and its scroll height is measured with real
        // content in it.
        hostAccountDropdown();
        setMobileMoreOpen(true);
        // First focusable inside the canonical tree, whatever it happens to be.
        // Not a hardcoded id: the tree's first row is the identity block (not
        // focusable, by design -- it carries no control), and the first control
        // after it is New Connection once TouchActionRow has relocated the
        // globals, or Profiles before that. Querying the host rather than naming
        // an id is what keeps this correct across both.
        const firstAction = byId('mobileSettingsHost')
            ?.querySelector('button:not(:disabled), a[href], select, input:not([type="hidden"])');
        focusIfVisible(firstAction);
    }

    function toggleMobileMore(event) {
        event.stopPropagation();
        if (mobileMoreIsOpen()) {
            closeMobileMore();
        } else {
            openMobileMore();
        }
    }

    function updateCurrentThemeLabel(name, color) {
        const label = byId('currentThemeLabel');
        if (!label) {
            return;
        }
        if (color) {
            label.innerHTML =
                `<span class="theme-color-dot" style="background:${color}"></span>${name}`;
        } else {
            label.textContent = name;
        }
    }

    /*
     * Exported as a window global on purpose: it is the one function here with
     * callers outside this file's own markup, and the terminal colour contract
     * runs through it. TerminalManager reads --term-* and --accent-* out of CSS
     * With getCssVar (terminal-manager.js), so a theme change only reaches the
     * Xterm instances via applyThemeToAll below -- dropping that call leaves
     * the page themed and every terminal on the old palette.
     */
    function applyTheme(themeId) {
        document.body.setAttribute('data-theme', themeId);
        if (window.socket) {
            window.socket.emit('set_theme', { theme: themeId });
        }
        /*
         * And a cookie, because the socket cannot set one and /login renders
         * before there is a user to look up. Without this the sign-in page is
         * the one surface that ignores the reader's theme, which is what made
         * it look like a different product (app/__init__.py, reader_theme).
         */
        try {
            document.cookie = `theme=${themeId}; path=/; max-age=31536000; SameSite=Lax`;
        } catch (e) {
            console.error('[SSHDeck] Could not remember the theme:', e);
        }
        const dropdown = byId('themeDropdownHeader');
        if (dropdown) {
            dropdown.querySelectorAll('.theme-option').forEach(option => {
                option.classList.toggle('active', option.dataset.themeId === themeId);
            });
        }
        if (window.TerminalManager
            && typeof TerminalManager.applyThemeToAll === 'function') {
            TerminalManager.applyThemeToAll();
        }
    }

    function initThemeSelector() {
        const dropdown = byId('themeDropdownHeader');
        if (!dropdown) {
            return;
        }
        const currentTheme = document.body.getAttribute('data-theme') || 'glass';

        dropdown.innerHTML = '';
        THEMES.forEach(theme => {
            const option = document.createElement('div');
            option.className =
                'theme-option' + (theme.id === currentTheme ? ' active' : '');
            // A class rather than an inline border. The swatch for a light theme
            // needs an outline or it vanishes against a light dropdown; which
            // colour that outline is belongs to the stylesheet, not here. Only
            // the swatch colour stays inline, because it is data from THEMES.
            const dot = 'theme-color-dot' + (theme.light ? ' is-light' : '');
            option.innerHTML = `<span class="${dot}" `
                + `style="background:${theme.color}"></span>${theme.name}`;
            option.dataset.themeId = theme.id;
            dropdown.appendChild(option);
        });

        const current = THEMES.find(t => t.id === currentTheme);
        if (current) {
            updateCurrentThemeLabel(current.name, current.color);
        }
    }

    function updateCurrentLangHeader(lang) {
        const flag = byId('currentLangFlagHeader');
        if (flag) {
            flag.textContent = lang.flag;
        }
    }

    function initLanguageSelector() {
        const dropdown = byId('langDropdownHeader');
        if (!dropdown || !window.i18n) {
            return;
        }
        const languages = i18n.getLanguages();
        const currentLang = i18n.getLanguage();

        dropdown.innerHTML = '';
        languages.forEach(lang => {
            const option = document.createElement('div');
            option.className = 'lang-option' + (lang.code === currentLang ? ' active' : '');
            option.innerHTML = `${lang.flag} ${lang.name}`;
            option.dataset.langCode = lang.code;
            dropdown.appendChild(option);
        });

        const current = languages.find(l => l.code === currentLang);
        if (current) {
            updateCurrentLangHeader(current);
        }
    }

    /*
     * Delegated on the two dropdowns rather than bound per option. Both lists
     * are rebuilt with innerHTML on every init, so a per-option listener would
     * have to be re-attached after each rebuild -- the classic way to end up
     * with either dead options or handlers stacked two deep.
     */
    function bindDelegatedOptionClicks() {
        byId('themeDropdownHeader')?.addEventListener('click', event => {
            const option = event.target.closest('.theme-option');
            if (!option) {
                return;
            }
            const theme = THEMES.find(t => t.id === option.dataset.themeId);
            if (!theme) {
                return;
            }
            applyTheme(theme.id);
            updateCurrentThemeLabel(theme.name, theme.color);
            toggleThemeDropdown();
        });

        byId('langDropdownHeader')?.addEventListener('click', event => {
            const option = event.target.closest('.lang-option');
            if (!option || !window.i18n) {
                return;
            }
            const lang = i18n.getLanguages().find(l => l.code === option.dataset.langCode);
            if (!lang) {
                return;
            }
            i18n.setLanguage(lang.code);
            updateCurrentLangHeader(lang);
            toggleLangDropdown();
        });
    }

    function bindTriggers() {
        setThemeDropdownOpen(
            byId('themeDropdownHeader')?.classList.contains('show') || false);
        setLangDropdownOpen(
            byId('langDropdownHeader')?.classList.contains('show') || false);
        setAccountDropdownOpen(
            byId('accountDropdownHeader')?.classList.contains('show') || false);

        byId('accountBtnHeader')?.addEventListener('click', toggleAccountDropdown);
        byId('themeExpanderHeader')?.addEventListener('click', toggleThemeDropdown);
        byId('langExpanderHeader')?.addEventListener('click', toggleLangDropdown);
        // ONE trigger for the one canonical menu on touch. The former
        // #mobileSettingsBtn (open the Settings view) and #mobileSettingsBackBtn
        // (go back to the proxy list) bindings are gone with the views they
        // navigated between.
        byId('mobileMoreBtn')?.addEventListener('click', toggleMobileMore);

        byId('accountDropdownHeader')?.addEventListener('click', event => {
            // Close on a real action only. .account-expander rows (Theme,
            // Language) open a sub-section in place; closing on those would shut
            // the menu the instant you reached for a theme.
            if (event.target.closest('.account-action')) {
                if (accountDropdownIsHosted()) {
                    closeMobileMore({ restoreFocus: false });
                } else {
                    setAccountDropdownOpen(false);
                }
            }
        });

        /*
         * There is no sheet-level click handler any more (owner correction
         *second pass).
         *
         * It matched `.mobile-more-action`, the class the three relocated globals
         * carried while they were DIRECT children of #mobileSettingsHost -- i.e.
         * siblings of the account tree, painted as separate cards. Those three are
         * now inserted INSIDE the tree as `.account-item .account-action` rows, so
         * the .account-action branch of the tree listener above is the one path
         * that dismisses the menu for every row in it, including them. Keeping
         * both would have closed the menu through two listeners on one click.
         *
         * The two other branches it carried are gone with their nodes:
         * `data-mobile-action-target` forwarding (no proxy has existed since the
         * intermediate list was deleted -- zero such attributes in the markup) and
         * a special case for #mobileExitCopyModeBtn, an id with no production node
         * anywhere in templates/ or static/js.
         */
    }

    function bindOutsideClick() {
        window.addEventListener('click', event => {
            // Handle a genuine outside-sheet dismissal first. closeMobileMore
            // owns all nested account/submenu restoration, so do not perform a
            // second account close in this event.
            if (mobileMoreIsOpen()
                && !event.target.closest('#mobileMoreSheet')
                && !event.target.closest('#mobileMoreBtn')) {
                closeMobileMore({ restoreFocus: false });
                return;
            }

            if (!event.target.closest('.language-selector')) {
                closeLangDropdown();
            }
            if (!event.target.closest('.theme-selector')) {
                closeThemeDropdown();
            }
            const insideAccount = event.target.closest('.account-selector')
                || event.target.closest('.mobile-settings-host')
                // While hosted, the complete Settings surface is account-menu
                // containment. This covers its heading and Back transition as
                // well as the account tree itself.
                || (accountDropdownIsHosted()
                    && event.target.closest('#mobileMoreSheet'));
            if (!insideAccount) {
                setAccountDropdownOpen(false);
            }
        });
    }

    /*
     * The sessionBar class observer, owned by THIS instance. Split out of
     * bindMobileLifecycle so a bfcache restore can re-anchor it after
     * Cleanup disconnected it: pagehide
     * tears the observer down, persisted pageshow brings the whole document
     * back with no script re-evaluation, and nothing used to rebuild it --
     * after which hiding the dock no longer closed an open More sheet.
     * Idempotent: a live observer is never doubled.
     */
    function bindSessionBarObserver() {
        const sessionBar = byId('sessionBar');
        if (!sessionBar || sessionBarObserver) {
            return;
        }
        const previous = sessionBar.__sshdeckClassObserver;
        if (previous) {
            previous.disconnect();
        }
        const observer = new MutationObserver(() => {
            if (sessionBar.classList.contains('hidden')
                && (mobileMoreIsOpen() || accountDropdownIsHosted())) {
                closeMobileMore({ restoreFocus: false });
            }
        });
        observer.observe(sessionBar, {
            attributes: true,
            attributeFilter: ['class']
        });
        sessionBar.__sshdeckClassObserver = observer;
        sessionBarObserver = observer;
    }

    function bindMobileLifecycle() {
        const handleMediaChange = event => {
            if (!event.matches
                && (mobileMoreIsOpen() || accountDropdownIsHosted())) {
                closeMobileMore({ restoreFocus: false });
            }
        };
        if (typeof mobileShellMedia.addEventListener === 'function') {
            mobileShellMedia.addEventListener('change', handleMediaChange);
        } else {
            mobileShellMedia.addListener(handleMediaChange);
        }

        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !mobileMoreIsOpen()) {
                return;
            }
            event.preventDefault();
            closeMobileMore();
        });

        window.addEventListener('resize', () => {
            if (mobileMoreIsOpen()) positionMobileMore();
        });
        window.addEventListener('orientationchange', () => {
            if (mobileMoreIsOpen()) requestAnimationFrame(positionMobileMore);
        });

        bindSessionBarObserver();
    }

    function init() {
        if (initialized) {
            return;
        }
        initialized = true;
        initThemeSelector();
        initLanguageSelector();
        bindDelegatedOptionClicks();
        bindTriggers();
        bindOutsideClick();
        bindMobileLifecycle();
    }

    // Kept global: called from terminal-manager's theme path and by any later
    // caller that needs to set a theme without going through the menu.
    window.applyTheme = applyTheme;

    /*
     * Teardown entry point; app.js registers it on `pagehide`. It owns
     * THIS instance's observer: disconnect it, then clear the element anchor
     * ONLY if it still references that same observer. A re-initialization
     * that ran after this instance anchored a newer observer, and that newer
     * one must survive this cleanup; clearing it unconditionally would leave
     * the live observer invisible to the NEXT teardown. Nulled module
     * Variable makes repeated cleanup calls a no-op (idempotent).
     */
    window.HeaderMenus = {
        cleanup() {
            const sessionBar = byId('sessionBar');
            if (sessionBarObserver) {
                sessionBarObserver.disconnect();
                if (sessionBar
                    && sessionBar.__sshdeckClassObserver === sessionBarObserver) {
                    delete sessionBar.__sshdeckClassObserver;
                }
                sessionBarObserver = null;
            }
        },
        // BFCache counterpart of cleanup: pagehide disconnects the observer,
        // a persisted pageshow must re-anchor it or the dock-hide -> close
        // contract is dead until the next full load. Safe to call any time:
        // with a live observer it is a no-op.
        restoreObserver() {
            bindSessionBarObserver();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
