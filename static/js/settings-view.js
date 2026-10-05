/*
 * SETTINGS -- every setting in one place (owner ruling 2026-10-05).
 *
 * Settings used to live in six places: a Settings dialog, theme and language
 * pickers expanded inside the account menu, three management dialogs, the
 * change-password page, the admin page and the session menu. This view takes
 * the dialog, the two pickers and the password page; the admin page follows.
 * The markup is templates/index.html #settingsView, the look settings.css.
 *
 * Geometry is the expanded Files browser's: over the workspace on a desktop
 * and an iPad, the whole screen on a phone, nothing underneath hidden or
 * resized, so opening it costs no device on any session a resize.
 *
 * Back -- a phone's, or the browser's own -- takes the same step as Escape:
 * from a section to the list on a phone, otherwise closed. While open the
 * view holds one history entry whose address names the section
 * (#settings/terminal), so a reload opens the same place.
 */
(() => {
    const FULL_SCREEN_QUERY = '(max-width: 767px), (pointer: coarse) and (hover: none) and (max-height: 500px)';
    const STORE_SECTION = 'sshdeck.settings.section';
    const HASH = /^#settings(?:\/([a-z-]+))?$/;

    // Theme ids match the [data-theme] blocks in style.css; `glass` is :root.
    // The colour only has to identify the theme in the list.
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
        { id: 'obsidian', name: 'Obsidian', color: '#ffffff' },
    ];

    const t = (key, fallback) => (window.i18n ? i18n.t(key) : null) || fallback;
    const byId = id => document.getElementById(id);

    function readStore(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Storage blocked: the choice lasts this page.
        }
    }

    /*
     * The theme reaches the page, the server (so the account's other devices
     * take it), a cookie (the sign-in page renders before there is a user to
     * look it up) and every terminal: TerminalManager reads --term-* out of
     * CSS, so without applyThemeToAll the page would theme and the terminals
     * keep the old palette. Global, as it was in header-menus.js.
     */
    function applyTheme(themeId) {
        document.body.setAttribute('data-theme', themeId);
        window.socket?.emit('set_theme', { theme: themeId });
        try {
            document.cookie = `theme=${themeId}; path=/; max-age=31536000; SameSite=Lax`;
        } catch (e) {
            console.error('[SSHDeck] Could not remember the theme:', e);
        }
        window.TerminalManager?.applyThemeToAll?.();
    }
    window.applyTheme = applyTheme;

    const view = {
        root: null,
        section: null,
        inerted: [],
        backArmed: false,
        skipPop: false,
        opener: null,
        fullScreen: window.matchMedia(FULL_SCREEN_QUERY),

        get isOpen() {
            return Boolean(this.root && !this.root.hidden);
        },

        sections() {
            return [...this.root.querySelectorAll('.sv-nav-item[data-section]')]
                .map(item => item.dataset.section);
        },

        // ── open, select, close ────────────────────────────────────────────
        open(section) {
            if (!this.root) return;
            const known = this.sections();
            const wanted = known.includes(section) ? section : null;
            if (!this.isOpen) {
                this.opener = document.activeElement;
                this.root.hidden = false;
                document.body.classList.add('settings-open');
                this.setBackgroundInert(true);
                this.refresh();
            }
            const remembered = readStore(STORE_SECTION);
            const fallback = known.includes(remembered) ? remembered : known[0];
            if (wanted || !this.fullScreen.matches) {
                this.select(wanted || fallback);
            } else {
                this.showList();
            }
            this.armBack();
            const focus = this.fullScreen.matches && this.section
                ? this.root.querySelector('.sv-main .sv-back')
                : this.root.querySelector('.sv-nav-item[aria-current="page"]')
                    || this.root.querySelector('.sv-nav-item');
            focus?.focus();
        },

        select(section) {
            this.section = section;
            this.root.querySelectorAll('.sv-nav-item[data-section]').forEach(item => {
                if (item.dataset.section === section) {
                    item.setAttribute('aria-current', 'page');
                } else {
                    item.removeAttribute('aria-current');
                }
            });
            this.root.querySelectorAll('.sv-section').forEach(panel => {
                panel.hidden = panel.dataset.section !== section;
            });
            this.showTitle();
            this.root.classList.add('sv-in-section');
            this.root.querySelector('.sv-scroll').scrollTop = 0;
            writeStore(STORE_SECTION, section);
            this.writeAddress();
        },

        showTitle() {
            const label = this.section
                && this.root.querySelector(`.sv-nav-item[data-section="${this.section}"] .sv-nav-label`);
            byId('settingsSectionTitle').textContent = label ? label.textContent : '';
        },

        showList() {
            this.section = null;
            this.root.classList.remove('sv-in-section');
            this.writeAddress();
        },

        // A phone's section goes back to the list; anything else closes.
        escapeStep() {
            if (this.fullScreen.matches && this.section) {
                const from = this.section;
                this.showList();
                this.root.querySelector(`.sv-nav-item[data-section="${from}"]`)?.focus();
            } else {
                this.close();
            }
        },

        close() {
            if (!this.isOpen) return;
            this.root.hidden = true;
            document.body.classList.remove('settings-open');
            this.setBackgroundInert(false);
            this.releaseBack();
            // Back to what opened it -- or, when that was a row of a menu
            // that has closed since, to the menu's own button.
            const visible = element => element?.isConnected && element.getClientRects().length > 0;
            const target = [this.opener, byId('accountBtnHeader'), byId('mobileMoreBtn')].find(visible);
            this.opener = null;
            target?.focus();
        },

        /*
         * What the view covers takes neither focus nor clicks: on a desktop
         * the workspace under it, on a full screen everything else in the
         * deck window too. Only what this view made inert is released.
         */
        setBackgroundInert(on) {
            if (!on) {
                this.inerted.forEach(element => element.removeAttribute('inert'));
                this.inerted = [];
                return;
            }
            const stop = this.fullScreen.matches
                ? byId('deckWindow') || document.body
                : this.root.parentElement;
            const targets = [];
            for (let node = this.root; node && node !== stop && node.parentElement; node = node.parentElement) {
                for (const sibling of node.parentElement.children) {
                    if (sibling !== node && !sibling.hasAttribute('inert')
                            && !['SCRIPT', 'TEMPLATE'].includes(sibling.tagName)) {
                        targets.push(sibling);
                    }
                }
                if (node.parentElement === stop) break;
            }
            targets.forEach(element => element.setAttribute('inert', ''));
            this.inerted = targets;
        },

        // ── the address and Back ───────────────────────────────────────────
        address() {
            const base = location.pathname + location.search;
            return `${base}#settings${this.section ? `/${this.section}` : ''}`;
        },

        writeAddress() {
            if (this.backArmed) {
                history.replaceState({ sshdeckSettings: true }, '', this.address());
            }
        },

        armBack() {
            if (this.backArmed) return;
            history.pushState({ sshdeckSettings: true }, '', this.address());
            this.backArmed = true;
        },

        releaseBack() {
            if (!this.backArmed) return;
            this.backArmed = false;
            if (history.state?.sshdeckSettings) {
                this.skipPop = true;
                history.back();
            }
        },

        onPopState() {
            if (this.skipPop) {
                this.skipPop = false;
                return;
            }
            if (!this.backArmed) return;
            this.backArmed = false;           // Back spent the entry
            if (!this.isOpen) return;
            this.escapeStep();
            if (this.isOpen) this.armBack();
        },

        // ── what the sections show ─────────────────────────────────────────
        refresh() {
            this.renderThemes();
            this.renderLanguages();
            this.showDeviceSettings();
            this.renderValues();
        },

        renderThemes() {
            const box = byId('themeOptions');
            if (!box) return;
            const current = document.body.getAttribute('data-theme') || 'glass';
            box.replaceChildren(...THEMES.map(theme => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'sv-theme';
                option.setAttribute('role', 'radio');
                option.setAttribute('aria-checked', String(theme.id === current));
                option.tabIndex = theme.id === current ? 0 : -1;
                option.dataset.themeId = theme.id;
                const swatch = document.createElement('span');
                swatch.className = 'sv-swatch' + (theme.light ? ' is-light' : '');
                swatch.style.background = theme.color;
                option.append(swatch, document.createTextNode(theme.name));
                return option;
            }));
        },

        renderLanguages() {
            const select = byId('languageSelect');
            if (!select || !window.i18n) return;
            select.replaceChildren(...i18n.getLanguages().map(lang => {
                const option = document.createElement('option');
                option.value = lang.code;
                option.textContent = `${lang.flag} ${lang.name}`;
                return option;
            }));
            select.value = i18n.getLanguage();
        },

        showDeviceSettings() {
            const ds = window.DeviceSettings;
            if (!ds) return;
            const set = (id, prop, value) => {
                const el = byId(id);
                if (el) el[prop] = value;
            };
            set('rendererSelect', 'value', ds.renderer());
            set('perfProbeToggle', 'checked', ds.perf());
            set('attachReportToggle', 'checked', ds.attachReport());
            set('keyboardLogToggle', 'checked', ds.keyboardLog());
            const state = byId('keyboardLogState');
            if (state) {
                const until = ds.keyboardLogUntil();
                state.textContent = until
                    ? t('settings.keyboardLogUntil', 'Turns itself off at {time}.').replace('{time}',
                        new Date(until).toLocaleTimeString(window.i18n?.currentLang,
                            { hour: '2-digit', minute: '2-digit' }))
                    : '';
            }
        },

        // The phone's list says what each section is set to.
        renderValues() {
            const put = (section, text) => {
                const slot = this.root.querySelector(`.sv-nav-value[data-value="${section}"]`);
                if (slot) slot.textContent = text;
            };
            const themeId = document.body.getAttribute('data-theme') || 'glass';
            const theme = THEMES.find(entry => entry.id === themeId);
            const lang = window.i18n?.getLanguages().find(entry => entry.code === i18n.getLanguage());
            put('appearance', [theme?.name, lang?.name].filter(Boolean).join(' · '));
            const scrollback = byId('scrollbackInput')?.value;
            const renderer = byId('rendererSelect');
            const rendererName = renderer?.selectedOptions[0]?.textContent || '';
            put('terminal', [scrollback ? `${scrollback} ${t('settings.lines', 'lines')}` : '', rendererName]
                .filter(Boolean).join(' · '));
            put('account', byId('accountUsername')?.textContent.trim() || '');
            const ds = window.DeviceSettings;
            if (ds && ds.isAdmin()) {
                const on = [ds.perf(), ds.attachReport(), ds.keyboardLog()].filter(Boolean).length;
                put('diagnostics', on
                    ? t('settings.diagnosticsOn', '{n} on').replace('{n}', on)
                    : t('settings.off', 'Off'));
            }
        },

        // ── the password form ─────────────────────────────────────────────
        passwordMessages: {
            required: ['settings.pwRequired', 'Required'],
            incorrect: ['settings.pwIncorrect', 'The current password is not right'],
            mismatch: ['settings.pwMismatch', 'The two new passwords are not the same'],
            too_short: ['settings.pwTooShort', 'At least {n} characters'],
            too_long: ['settings.pwTooLong', 'At most {n} bytes'],
            unchanged: ['settings.pwUnchanged', 'Choose a password you are not using now'],
            rate_limited: ['settings.pwRateLimited', 'Too many attempts. Wait a minute and try again.'],
            failed: ['settings.pwFailed', 'The password was not changed. Try again.'],
        },

        passwordMessage(code, n) {
            const [key, fallback] = this.passwordMessages[code] || this.passwordMessages.failed;
            return t(key, fallback).replace('{n}', n);
        },

        showPasswordErrors(errors, status) {
            ['currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput'].forEach(id => {
                const input = byId(id);
                const message = errors[id] || '';
                input.setAttribute('aria-invalid', String(Boolean(message)));
                byId(`${id}Error`).textContent = message;
            });
            const line = byId('changePasswordStatus');
            line.textContent = status ? status.text : '';
            line.className = 'sv-status' + (status ? ` ${status.ok ? 'is-ok' : 'is-error'}` : '');
        },

        async submitPassword(event) {
            event.preventDefault();
            const current = byId('currentPasswordInput');
            const next = byId('newPasswordInput');
            const confirm = byId('confirmPasswordInput');
            const errors = {};
            if (!current.value) errors.currentPasswordInput = this.passwordMessage('required');
            if (next.value.length < 8) errors.newPasswordInput = this.passwordMessage('too_short', 8);
            if (!errors.newPasswordInput && confirm.value !== next.value) {
                errors.confirmPasswordInput = this.passwordMessage('mismatch');
            }
            if (Object.keys(errors).length) {
                this.showPasswordErrors(errors);
                byId(Object.keys(errors)[0]).focus();
                return;
            }
            const button = byId('changePasswordSubmit');
            button.disabled = true;
            let reply = null;
            let status = 0;
            try {
                const root = (document.querySelector('meta[name="app-root"]')?.content || '').replace(/\/$/, '');
                const response = await fetch(`${root}/api/account/password`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-CSRFToken': document.querySelector('meta[name="csrf-token"]')?.content || '',
                    },
                    body: JSON.stringify({
                        current_password: current.value,
                        new_password: next.value,
                        confirm_password: confirm.value,
                    }),
                });
                status = response.status;
                reply = await response.json().catch(() => null);
            } catch {
                reply = null;
            } finally {
                button.disabled = false;
            }
            if (reply?.ok) {
                [current, next, confirm].forEach(input => { input.value = ''; });
                const done = t('settings.pwChanged', 'Password changed.');
                this.showPasswordErrors({}, { ok: true, text: done });
                window.showNotification?.(done, 'success');
                return;
            }
            const field = {
                current_password: 'currentPasswordInput',
                new_password: 'newPasswordInput',
                confirm_password: 'confirmPasswordInput',
            }[reply?.field];
            const message = this.passwordMessage(status === 429 ? 'rate_limited' : reply?.error,
                reply?.min ?? reply?.max);
            if (field) {
                this.showPasswordErrors({ [field]: message });
                byId(field).focus();
            } else {
                this.showPasswordErrors({}, { ok: false, text: message });
            }
        },

        // ── wiring ─────────────────────────────────────────────────────────
        bind() {
            this.root.addEventListener('click', event => {
                const nav = event.target.closest('.sv-nav-item[data-section]');
                if (nav) {
                    this.select(nav.dataset.section);
                    if (this.fullScreen.matches) {
                        this.root.querySelector('.sv-main .sv-back')?.focus();
                    }
                    return;
                }
                const act = event.target.closest('[data-act]')?.dataset.act;
                if (act === 'close') this.close();
                if (act === 'back') this.escapeStep();
                const theme = event.target.closest('.sv-theme');
                if (theme) {
                    applyTheme(theme.dataset.themeId);
                    this.renderThemes();
                    this.root.querySelector('.sv-theme[aria-checked="true"]')?.focus();
                    this.renderValues();
                }
                const reveal = event.target.closest('.sv-reveal');
                if (reveal) {
                    const input = byId(reveal.dataset.reveal);
                    const show = input.type === 'password';
                    input.type = show ? 'text' : 'password';
                    reveal.setAttribute('aria-pressed', String(show));
                }
            });

            // Arrow keys move through the theme radio group.
            byId('themeOptions')?.addEventListener('keydown', event => {
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                if (!step) return;
                event.preventDefault();
                const options = [...event.currentTarget.querySelectorAll('.sv-theme')];
                const at = options.indexOf(document.activeElement);
                options[(at + step + options.length) % options.length]?.click();
            });

            byId('languageSelect')?.addEventListener('change', event => {
                window.i18n?.setLanguage(event.target.value);
            });
            byId('rendererSelect')?.addEventListener('change', event => {
                window.DeviceSettings?.setRenderer(event.target.value);
            });
            byId('perfProbeToggle')?.addEventListener('change', event => {
                window.DeviceSettings?.setPerf(event.target.checked);
            });
            byId('attachReportToggle')?.addEventListener('change', event => {
                window.DeviceSettings?.setAttachReport(event.target.checked);
            });
            byId('keyboardLogToggle')?.addEventListener('change', event => {
                window.DeviceSettings?.setKeyboardLog(event.target.checked);
            });
            byId('scrollbackInput')?.addEventListener('change', () => this.renderValues());
            byId('changePasswordForm')?.addEventListener('submit', event => this.submitPassword(event));

            // A switch made elsewhere -- another tab, the keyboard log's own
            // deadline -- and a new language both show here at once.
            document.addEventListener('sshdeck:device-setting', () => {
                this.showDeviceSettings();
                this.renderValues();
            });
            window.addEventListener('languageChanged', () => {
                if (!this.isOpen) return;
                this.renderLanguages();
                this.showDeviceSettings();
                this.renderValues();
                this.showTitle();
            });

            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || !this.isOpen || event.defaultPrevented) return;
                event.preventDefault();
                this.escapeStep();
            });
            window.addEventListener('popstate', () => this.onPopState());
            this.fullScreen.addEventListener?.('change', () => {
                if (!this.isOpen) return;
                this.setBackgroundInert(false);
                this.setBackgroundInert(true);
                if (!this.fullScreen.matches && !this.section) {
                    this.select(this.sections()[0]);
                }
            });

            byId('settingsBtn')?.addEventListener('click', () => this.open());
        },

        init() {
            this.root = byId('settingsView');
            if (!this.root) return;
            this.bind();
            this.refresh();
            // Arrived at #settings/<section> (a reload, a bookmark, /admin or
            // /change-password redirected here): open there. The address is
            // taken back first so the entry the view pushes is its own.
            const match = HASH.exec(location.hash);
            if (match) {
                history.replaceState(history.state, '', location.pathname + location.search);
                this.open(match[1]);
            }
        },
    };

    window.SettingsView = {
        open: section => view.open(section),
        close: () => view.close(),
        get isOpen() {
            return view.isOpen;
        },
        get section() {
            return view.section;
        },
        THEMES,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => view.init());
    } else {
        view.init();
    }
})();
