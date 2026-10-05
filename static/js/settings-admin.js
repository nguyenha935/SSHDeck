/*
 * SETTINGS → ADMINISTRATION: Users, Running sessions, Audit log, System
 * (owner ruling 2026-10-05: one Settings in the app; the /admin page is gone).
 *
 * Only an administrator's page loads this file (templates/index.html), and the
 * server refuses /admin/api/* to anyone else whatever a page does. It follows
 * settings-view.js through its events: when Settings opens, Users and Running
 * sessions are fetched (a phone's list shows their counts); when a section is
 * shown again, its own data is. Nothing polls.
 *
 * A row's actions sit behind one ⋮ in a fixed last column, so every row lines
 * up, and one's own row has none (the server refuses those actions too). On a
 * phone the ⋮ opens a sheet that names the row. Every confirmation is the
 * app's own dialog (SessionManager.openSessionConfirm) and names what it acts
 * on: deleting a user, ending a session, resetting the system settings.
 */
(() => {
    const AUDIT_PAGE = 50;
    const RATE_UNITS = ['second', 'minute', 'hour'];
    const LEVELS = { INFO: 'admin.levelInfo', WARNING: 'admin.levelWarning', ERROR: 'admin.levelError' };
    const AUDIT_OWN_FIELDS = ['timestamp', 'level', 'logger', 'message'];

    const byId = id => document.getElementById(id);
    const t = key => (window.i18n ? i18n.t(key) : key);
    const say = (key, values = {}) => t(key).replace(/\{(\w+)\}/g, (all, name) => (name in values ? values[name] : all));
    const locale = () => window.i18n?.getLanguage() || undefined;
    const fullScreen = () => window.matchMedia(window.SettingsView?.FULL_SCREEN_QUERY || '(max-width: 767px)').matches;
    const notify = (text, type) => window.showNotification?.(text, type);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'icon');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        const sprite = document.querySelector('meta[name="icon-sprite"]')?.content || '';
        use.setAttribute('href', `${sprite}#icon-${name}`);
        svg.append(use);
        return svg;
    }

    // What the phone's list shows beside a section.
    function showValue(section, text) {
        const slot = document.querySelector(`#settingsView .sv-nav-value[data-value="${section}"]`);
        if (slot) slot.textContent = text;
    }

    async function api(path, { method = 'GET', body } = {}) {
        const root = (document.querySelector('meta[name="app-root"]')?.content || '').replace(/\/$/, '');
        const headers = { Accept: 'application/json' };
        const init = { method, headers, credentials: 'same-origin' };
        if (method !== 'GET') {
            headers['X-CSRFToken'] = document.querySelector('meta[name="csrf-token"]')?.content || '';
        }
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(`${root}${path}`, init);
        } catch {
            throw Object.assign(new Error(t('admin.offline')), { status: 0 });
        }
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            throw Object.assign(new Error(data?.error || say('admin.refused', { status: response.status })),
                { status: response.status, data });
        }
        return data;
    }

    // ── dates and durations, in the reader's language ──────────────────────
    // Always with the year: a log reaches back months, and without it some
    // languages change separators (Vietnamese writes 05-10 but 05/10/2026).
    function when(iso, { time = true, seconds = false } = {}) {
        const date = iso ? new Date(iso) : null;
        if (!date || Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(locale(), {
            day: '2-digit', month: '2-digit', year: 'numeric',
            ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
            ...(seconds ? { second: '2-digit' } : {}),
        });
    }

    // `epoch` is in seconds, as the server's time.time() writes it.
    function ago(epoch) {
        const diff = Math.round(epoch - Date.now() / 1000);
        const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
        const size = Math.abs(diff);
        if (size < 60) return format.format(diff, 'second');
        if (size < 3600) return format.format(Math.round(diff / 60), 'minute');
        if (size < 86400) return format.format(Math.round(diff / 3600), 'hour');
        return format.format(Math.round(diff / 86400), 'day');
    }

    function duration(total) {
        const unit = (n, name) => new Intl.NumberFormat(locale(),
            { style: 'unit', unit: name, unitDisplay: 'long' }).format(n);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        return [hours && unit(hours, 'hour'), minutes && unit(minutes, 'minute'), secs && unit(secs, 'second')]
            .filter(Boolean).join(' ') || unit(0, 'second');
    }

    // ── the ⋮ menu: a popover by its button, a sheet on a phone ─────────────
    const menu = {
        node: null,
        backdrop: null,
        anchor: null,

        get isOpen() {
            return Boolean(this.node && !this.node.hidden);
        },

        build() {
            const view = byId('settingsView');
            this.backdrop = el('div', 'sv-menu-backdrop');
            this.backdrop.hidden = true;
            this.node = el('div', 'sv-menu');
            this.node.setAttribute('role', 'menu');
            this.node.hidden = true;
            view.append(this.backdrop, this.node);
            this.backdrop.addEventListener('click', () => this.close());
            this.node.addEventListener('keydown', event => {
                const items = [...this.node.querySelectorAll('.sv-menu-item')];
                const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
                if (step) {
                    event.preventDefault();
                    const at = items.indexOf(document.activeElement);
                    items[(at + step + items.length) % items.length]?.focus();
                } else if (event.key === 'Tab') {
                    this.close(false);
                }
            });
            // A press anywhere else closes it; the press on its own button is
            // left to that button, which closes it (open() below).
            document.addEventListener('pointerdown', event => {
                if (!this.isOpen || this.node.contains(event.target)
                        || this.anchor?.contains(event.target) || this.backdrop.contains(event.target)) return;
                this.close(false);
            }, true);
        },

        open(anchor, title, items) {
            if (this.isOpen && this.anchor === anchor) {
                this.close();
                return;
            }
            if (!this.node) this.build();
            this.close(false);
            this.anchor = anchor;
            const sheet = fullScreen();
            this.node.classList.toggle('is-sheet', sheet);
            this.node.setAttribute('aria-label', title);
            const children = sheet ? [el('div', 'sv-menu-title', title)] : [];
            items.forEach(item => {
                const button = el('button', `sv-menu-item${item.danger ? ' is-danger' : ''}`, item.label);
                button.type = 'button';
                button.setAttribute('role', 'menuitem');
                button.addEventListener('click', () => {
                    this.close();
                    item.run();
                });
                children.push(button);
            });
            this.node.replaceChildren(...children);
            this.node.hidden = false;
            this.backdrop.hidden = !sheet;
            anchor.setAttribute('aria-expanded', 'true');
            if (!sheet) this.place(anchor);
            this.node.querySelector('.sv-menu-item')?.focus();
        },

        // Under its button, right edges aligned; above it when the view ends.
        place(anchor) {
            const view = byId('settingsView').getBoundingClientRect();
            const button = anchor.getBoundingClientRect();
            const own = this.node.getBoundingClientRect();
            const below = button.bottom + 4 + own.height <= view.bottom - 8;
            const top = below ? button.bottom + 4 : button.top - 4 - own.height;
            this.node.style.top = `${Math.max(view.top + 8, top) - view.top}px`;
            this.node.style.left = `${Math.max(view.left + 8, button.right - own.width) - view.left}px`;
        },

        close(focusBack = true) {
            if (!this.isOpen) return;
            this.node.hidden = true;
            this.backdrop.hidden = true;
            this.node.style.top = '';
            this.node.style.left = '';
            const anchor = this.anchor;
            this.anchor = null;
            anchor?.setAttribute('aria-expanded', 'false');
            if (focusBack && anchor?.isConnected) anchor.focus();
        },
    };

    function menuButton(label, onOpen) {
        const button = el('button', 'sv-icon-btn sv-row-menu');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.append(icon('ellipsis-vertical'));
        button.addEventListener('click', () => onOpen(button));
        return button;
    }

    // The app's own dialog. Without it in the document nothing is done: a
    // destructive action never runs unconfirmed. SessionManager is a `const`
    // of a classic script: a global name, but not a property of window.
    function confirmAction({ title, body, accept, iconName = 'circle-alert', run }) {
        if (typeof SessionManager === 'undefined') return false;
        return SessionManager.openSessionConfirm({
            title, body, acceptLabel: accept, icon: iconName, danger: true, onAccept: run,
        }) === true;
    }

    function avatar(name) {
        const node = el('span', 'sv-avatar', String(name || '?').slice(0, 2).toUpperCase());
        node.setAttribute('aria-hidden', 'true');
        return node;
    }

    function listRow(className, cells) {
        const row = el('div', className);
        row.setAttribute('role', 'listitem');
        row.append(...cells);
        return row;
    }

    // ── Users ──────────────────────────────────────────────────────────────
    const users = {
        rows: null,

        me() {
            return byId('accountUsername')?.textContent.trim() || '';
        },

        async load() {
            try {
                this.rows = (await api('/admin/api/users')).users || [];
            } catch (error) {
                notify(error.message, 'error');
            }
            this.render();
        },

        render() {
            const list = byId('usersList');
            if (!list || !this.rows) return;
            const me = this.me();
            list.replaceChildren(...this.rows.map(user => this.row(user, user.username === me)));
            byId('usersSummary').textContent = say('admin.usersSummary', {
                n: this.rows.length, a: this.rows.filter(user => user.is_admin).length,
            });
            showValue('users', String(this.rows.length));
        },

        row(user, mine) {
            const name = el('div', 'sv-arow-name');
            name.append(el('span', 'sv-arow-title', user.username));
            if (mine) name.append(el('span', 'sv-chip is-you', t('admin.you')));
            const created = when(user.created_at, { time: false });
            const signedIn = user.last_login
                ? say('admin.signedIn', { when: when(user.last_login) })
                : t('admin.neverSignedIn');
            const main = el('div', 'sv-arow-main');
            main.append(name, el('div', 'sv-arow-meta',
                [created && say('admin.created', { when: created }), signedIn].filter(Boolean).join(' · ')));
            const chips = el('div', 'sv-arow-chips');
            chips.append(
                el('span', `sv-chip${user.is_admin ? ' is-accent' : ''}`,
                    t(user.is_admin ? 'admin.roleAdmin' : 'admin.roleUser')),
                el('span', `sv-chip ${user.is_locked ? 'is-danger' : 'is-ok'}`,
                    t(user.is_locked ? 'admin.statusLocked' : 'admin.statusActive')));
            const actions = mine
                ? el('span', 'sv-row-menu-slot')
                : menuButton(say('admin.actionsFor', { name: user.username }), anchor => this.actions(user, anchor));
            const row = listRow('sv-arow', [avatar(user.username), main, chips, actions]);
            row.dataset.userId = user.id;
            return row;
        },

        actions(user, anchor) {
            const act = action => () => this.act(user, action);
            menu.open(anchor, user.username, [
                user.is_admin
                    ? { label: t('admin.demote'), run: act('demote') }
                    : { label: t('admin.promote'), run: act('promote') },
                user.is_locked
                    ? { label: t('admin.unlock'), run: act('unlock') }
                    : { label: t('admin.lock'), run: act('lock') },
                {
                    label: t('admin.deleteUser'),
                    danger: true,
                    run: () => confirmAction({
                        title: say('admin.deleteTitle', { name: user.username }),
                        body: say('admin.deleteBody', { name: user.username }),
                        accept: t('admin.deleteAccept'),
                        iconName: 'trash-2',
                        run: act('delete'),
                    }),
                },
            ]);
        },

        async act(user, action) {
            try {
                await api(`/admin/api/users/${user.id}/${action}`, { method: 'POST' });
                notify(say(`admin.done_${action}`, { name: user.username }), 'success');
            } catch (error) {
                notify(error.message, 'error');
            }
            await this.load();
        },
    };

    const addUser = {
        toggle(open) {
            const form = byId('addUserForm');
            form.hidden = !open;
            byId('addUserBtn').setAttribute('aria-expanded', String(open));
            if (open) {
                byId('newUsername').focus();
                return;
            }
            form.reset();
            this.show({});
            byId('addUserBtn').focus();
        },

        show(errors, status = '') {
            ['newUsername', 'newPassword'].forEach(id => {
                byId(id).setAttribute('aria-invalid', String(Boolean(errors[id])));
            });
            // The rule under the name is its error too: it turns red rather
            // than being said a second time.
            byId('newUsernameHint').classList.toggle('is-error', Boolean(errors.newUsername));
            byId('newPasswordError').textContent = errors.newPassword || '';
            const line = byId('addUserStatus');
            line.textContent = status;
            line.className = `sv-status${status ? ' is-error' : ''}`;
        },

        async submit(event) {
            event.preventDefault();
            const username = byId('newUsername').value.trim();
            const password = byId('newPassword').value;
            // The rule register_user applies (app/auth.py), said before sending.
            const errors = {};
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) errors.newUsername = true;
            if (password.length < 8) errors.newPassword = say('settings.pwTooShort', { n: 8 });
            if (Object.keys(errors).length) {
                this.show(errors);
                byId(Object.keys(errors)[0]).focus();
                return;
            }
            const submit = byId('addUserSubmit');
            submit.disabled = true;
            try {
                await api('/admin/api/users', {
                    method: 'POST',
                    body: { username, password, is_admin: byId('newIsAdmin').checked },
                });
                notify(say('admin.userCreated', { name: username }), 'success');
                this.toggle(false);
                await users.load();
            } catch (error) {
                this.show({}, error.message);
            } finally {
                submit.disabled = false;
            }
        },
    };

    // ── Running sessions ───────────────────────────────────────────────────
    const sessions = {
        data: null,
        at: null,

        async load() {
            try {
                this.data = await api('/admin/api/capacity');
                this.at = new Date();
            } catch (error) {
                notify(error.message, 'error');
            }
            this.render();
        },

        name(session) {
            return session.display_name || session.host || '?';
        },

        render() {
            const data = this.data;
            if (!data) return;
            byId('sessionsUpdated').textContent = say('admin.updatedAt', {
                time: this.at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
            });
            const stat = (value, label) => {
                const node = el('div', 'sv-stat');
                node.append(el('strong', 'sv-stat-value', value), el('span', 'sv-stat-label', label));
                return node;
            };
            const top = data.by_user?.[0];
            byId('sessionsStats').replaceChildren(
                stat(`${data.total_live} / ${data.max_sessions}`, t('admin.statOpen')),
                stat(`${top ? top.live : 0} / ${data.max_sessions_per_user}`,
                    top ? say('admin.statTopUser', { name: top.username || '?' }) : t('admin.statPerUser')),
                stat(String(data.pending), t('admin.statPending')));
            const rows = [...(data.sessions || [])]
                .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
            byId('sessionsList').replaceChildren(...(rows.length
                ? rows.map(session => this.row(session))
                : [el('div', 'sv-empty', t('admin.noSessions'))]));
            showValue('sessions', `${data.total_live} / ${data.max_sessions}`);
        },

        row(session) {
            const owner = session.user_username || '?';
            const target = `${session.username}@${session.host}${session.port && session.port !== 22 ? `:${session.port}` : ''}`;
            const tmux = session.tmux_session_name ? `tmux …${session.tmux_session_name.slice(-8)}` : '';
            const active = session.last_activity ? say('admin.activeAgo', { when: ago(session.last_activity) }) : '';
            const main = el('div', 'sv-arow-main');
            main.append(el('div', 'sv-arow-name', `${owner} · ${this.name(session)}`),
                el('div', 'sv-arow-meta', [target, tmux, active].filter(Boolean).join(' · ')));
            const chips = el('div', 'sv-arow-chips');
            chips.append(el('span', `sv-chip${session.use_tmux ? ' is-ok' : ''}`,
                t(session.use_tmux ? 'admin.withTmux' : 'admin.withoutTmux')));
            const row = listRow('sv-arow', [avatar(owner), main, chips,
                menuButton(say('admin.actionsFor', { name: this.name(session) }), anchor => this.actions(session, anchor))]);
            row.dataset.sessionId = session.session_id;
            return row;
        },

        actions(session, anchor) {
            const name = this.name(session);
            const ending = (titleKey, bodyKey, acceptKey, killTmux) => () => confirmAction({
                title: say(titleKey, { name }),
                body: say(bodyKey, { host: session.host }),
                accept: t(acceptKey),
                iconName: 'plug-zap',
                run: () => this.close(session, killTmux),
            });
            // Without tmux there is nothing to keep: closing ends the shell.
            const items = session.use_tmux
                ? [
                    { label: t('admin.detachKeepTmux'), run: () => this.close(session, false) },
                    { label: t('admin.endTmux'), danger: true,
                        run: ending('admin.endTitle', 'admin.endBody', 'admin.endAccept', true) },
                ]
                : [
                    { label: t('admin.closeSession'), danger: true,
                        run: ending('admin.closeTitle', 'admin.closeBody', 'admin.closeAccept', false) },
                ];
            menu.open(anchor, `${session.user_username || '?'} · ${name}`, items);
        },

        async close(session, killTmux) {
            try {
                await api(`/admin/api/sessions/${encodeURIComponent(session.session_id)}/close`,
                    { method: 'POST', body: { kill_tmux: killTmux } });
                notify(say(killTmux || !session.use_tmux ? 'admin.sessionEnded' : 'admin.sessionDetached',
                    { name: this.name(session) }), 'success');
            } catch (error) {
                notify(error.message, 'error');
            }
            await this.load();
        },
    };

    // ── Audit log ──────────────────────────────────────────────────────────
    const audit = {
        offset: 0,
        total: 0,
        items: null,
        timer: null,

        async load() {
            const params = new URLSearchParams({ offset: this.offset, limit: AUDIT_PAGE });
            const level = byId('auditLevel').value;
            const query = byId('auditSearch').value.trim();
            if (level) params.set('level', level);
            if (query) params.set('q', query);
            try {
                const data = await api(`/admin/api/audit?${params}`);
                this.items = data.items || [];
                this.total = data.total || 0;
                this.offset = data.offset || 0;
            } catch (error) {
                notify(error.message, 'error');
            }
            this.render();
        },

        render() {
            if (!this.items) return;
            byId('auditList').replaceChildren(...(this.items.length
                ? this.items.map(entry => this.row(entry))
                : [el('div', 'sv-empty', t('admin.noLogs'))]));
            const from = this.total ? this.offset + 1 : 0;
            const to = Math.min(this.offset + AUDIT_PAGE, this.total);
            byId('auditPageInfo').textContent = `${from}–${to} / ${this.total}`;
            byId('auditPrev').disabled = this.offset <= 0;
            byId('auditNext').disabled = this.offset + AUDIT_PAGE >= this.total;
        },

        row(entry) {
            const level = String(entry.level || '').toUpperCase();
            const time = el('time', 'sv-lrow-time', when(entry.timestamp, { seconds: true }));
            time.dateTime = entry.timestamp || '';
            const chip = el('span', `sv-chip sv-level is-${level.toLowerCase()}`, LEVELS[level] ? t(LEVELS[level]) : level);
            const main = el('div', 'sv-lrow-main');
            main.append(el('div', 'sv-lrow-message', entry.message || ''));
            // The fields the line was logged with: who, what, which host.
            const details = Object.entries(entry)
                .filter(([key]) => !AUDIT_OWN_FIELDS.includes(key))
                .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
                .join(' · ');
            if (details) main.append(el('div', 'sv-lrow-details', details));
            return listRow('sv-lrow', [time, chip, main]);
        },
    };

    // ── System ─────────────────────────────────────────────────────────────
    const system = {
        rows: null,
        dirty: false,

        async load() {
            // Unsaved edits are kept when the section is shown again.
            if (this.dirty) return;
            try {
                this.rows = (await api('/admin/api/settings')).settings || [];
            } catch (error) {
                notify(error.message, 'error');
            }
            this.render();
        },

        label(key) {
            return t(key === 'registration_enabled' ? 'admin.allowRegistration' : `admin.set.${key}`);
        },

        hint(key) {
            return t(key === 'registration_enabled' ? 'admin.allowRegistrationHint' : `admin.set.${key}Hint`);
        },

        // A value as the reader reads it: "60 per minute", "86400 seconds".
        format(row, value) {
            if (row.type === 'bool') return t(value ? 'admin.on' : 'admin.off');
            if (row.type === 'rate') {
                const [count, unit] = String(value).split(' per ');
                return `${count} ${t(`admin.per_${unit}`)}`;
            }
            return row.unit === 'seconds' ? `${value} ${t('admin.unit_seconds')}` : String(value);
        },

        render() {
            if (!this.rows) return;
            byId('systemSwitches').replaceChildren(...this.rows.filter(row => row.type === 'bool').map(row => this.row(row)));
            byId('systemLimits').replaceChildren(...this.rows.filter(row => row.type !== 'bool').map(row => this.row(row)));
            this.status('');
            this.sync();
        },

        row(row) {
            const id = `sys-${row.key}`;
            const text = el('span', 'sv-text');
            const label = el(row.type === 'bool' ? 'span' : 'label', 'sv-label', this.label(row.key));
            if (row.type !== 'bool') label.htmlFor = id;
            text.append(label);
            if (row.overridden) text.append(el('span', 'sv-changed', t('admin.changed')));
            text.append(el('span', 'sv-hint',
                `${this.hint(row.key)} ${say('admin.defaultValue', { value: this.format(row, row.default) })}`));
            const error = el('span', 'sv-field-error');
            error.id = `${id}Error`;
            error.setAttribute('aria-live', 'polite');
            text.append(error);

            if (row.type === 'bool') {
                const line = el('label', 'sv-row');
                line.htmlFor = id;
                const input = el('input', 'sv-switch');
                input.type = 'checkbox';
                input.setAttribute('role', 'switch');
                input.id = id;
                input.checked = Boolean(row.value);
                line.append(text, input);
                line.dataset.key = row.key;
                return line;
            }

            const control = el('span', 'sv-control');
            if (row.type === 'rate') {
                const [count, unit] = String(row.value).split(' per ');
                const number = el('input', 'sv-input sv-number');
                Object.assign(number, { type: 'number', id, min: '1', step: '1', value: count });
                const select = el('select', 'sv-select sv-rate-unit');
                select.id = `${id}-unit`;
                select.setAttribute('aria-label', say('admin.rateUnit', { name: this.label(row.key) }));
                RATE_UNITS.forEach(name => {
                    const option = el('option', null, t(`admin.per_${name}`));
                    option.value = name;
                    select.append(option);
                });
                select.value = unit;
                control.append(number, select);
            } else {
                const number = el('input', 'sv-input sv-number');
                Object.assign(number, { type: 'number', id, min: String(row.min), max: String(row.max), step: '1',
                    value: String(row.value) });
                control.append(number);
                if (row.unit === 'seconds') {
                    control.append(el('span', 'sv-unit', t('admin.unit_seconds')), el('span', 'sv-equals'));
                }
            }
            const line = el('div', 'sv-row sv-row-wide');
            line.dataset.key = row.key;
            line.append(text, control);
            return line;
        },

        // What the form holds now, in the API's own shape.
        value(row) {
            const id = `sys-${row.key}`;
            if (row.type === 'bool') return byId(id).checked;
            if (row.type === 'rate') return `${byId(id).value.trim()} per ${byId(`${id}-unit`).value}`;
            return byId(id).value.trim();
        },

        changes() {
            const changes = {};
            this.rows.forEach(row => {
                const now = this.value(row);
                if (String(now) !== String(row.value)) changes[row.key] = now;
            });
            return changes;
        },

        // After every edit: Save follows whether anything changed, and the
        // timeout says what its seconds are.
        sync() {
            if (!this.rows) return;
            this.dirty = Object.keys(this.changes()).length > 0;
            byId('systemSave').disabled = !this.dirty;
            const timeout = byId('sys-session_timeout');
            const equals = timeout?.parentElement.querySelector('.sv-equals');
            if (equals) {
                const seconds = Number(timeout.value);
                equals.textContent = Number.isInteger(seconds) && seconds > 0 ? `= ${duration(seconds)}` : '';
            }
        },

        status(text, ok) {
            const line = byId('systemStatus');
            line.textContent = text;
            line.className = `sv-status${text ? (ok ? ' is-ok' : ' is-error') : ''}`;
        },

        showErrors(errors) {
            this.rows.forEach(row => {
                const id = `sys-${row.key}`;
                byId(`${id}Error`).textContent = errors[row.key] || '';
                byId(id).setAttribute('aria-invalid', String(Boolean(errors[row.key])));
            });
        },

        check(changes) {
            const errors = {};
            this.rows.forEach(row => {
                if (!(row.key in changes)) return;
                if (row.type === 'int') {
                    const number = Number(changes[row.key]);
                    if (!Number.isInteger(number) || number < row.min || number > row.max) {
                        errors[row.key] = say('admin.between', { min: row.min, max: row.max });
                    }
                } else if (row.type === 'rate') {
                    const count = Number(changes[row.key].split(' per ')[0]);
                    if (!Number.isInteger(count) || count < 1 || count > 999999) errors[row.key] = t('admin.rateCount');
                }
            });
            return errors;
        },

        async save(event) {
            event.preventDefault();
            const changes = this.changes();
            const errors = this.check(changes);
            this.showErrors(errors);
            if (Object.keys(errors).length) {
                this.status(t('admin.notSaved'));
                byId(`sys-${Object.keys(errors)[0]}`).focus();
                return;
            }
            const save = byId('systemSave');
            save.disabled = true;
            try {
                this.rows = (await api('/admin/api/settings', { method: 'POST', body: changes })).settings || this.rows;
                this.dirty = false;
                this.render();
                this.status(t('admin.settingsSaved'), true);
                notify(t('admin.settingsSaved'), 'success');
            } catch (error) {
                // The server names each refused key; nothing was saved.
                this.showErrors(error.data?.errors || {});
                this.status(error.data?.errors ? t('admin.notSaved') : error.message);
                this.sync();
            }
        },

        reset() {
            confirmAction({
                title: t('admin.resetTitle'),
                body: t('admin.resetBody'),
                accept: t('admin.resetAccept'),
                iconName: 'rotate-ccw',
                run: async () => {
                    try {
                        this.rows = (await api('/admin/api/settings', { method: 'POST', body: { reset: 'all' } }))
                            .settings || this.rows;
                        this.dirty = false;
                        this.render();
                        notify(t('admin.resetDone'), 'success');
                    } catch (error) {
                        notify(error.message, 'error');
                    }
                },
            });
        },
    };

    // ── following Settings ─────────────────────────────────────────────────
    // Opening shows the section it opens at in the same call; the counts just
    // fetched for the list serve that section too, rather than a second fetch.
    let justOpened = false;
    document.addEventListener('sshdeck:settings-open', () => {
        justOpened = true;
        queueMicrotask(() => { justOpened = false; });
        users.load();
        sessions.load();
    });
    document.addEventListener('sshdeck:settings-section', event => {
        menu.close(false);
        const section = event.detail?.section;
        if (section === 'users' && !justOpened) users.load();
        if (section === 'sessions' && !justOpened) sessions.load();
        if (section === 'audit') audit.load();
        if (section === 'system') system.load();
    });
    document.addEventListener('sshdeck:settings-close', () => menu.close(false));

    // Escape closes the menu before it closes Settings. Under the app's own
    // dialog Escape is the dialog's alone: it closes itself, Settings stays.
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !window.SettingsView?.isOpen) return;
        if (menu.isOpen) {
            event.preventDefault();
            menu.close();
        } else if (byId('sessionConfirm') && !byId('sessionConfirm').hidden) {
            event.preventDefault();
        }
    }, true);

    function bind() {
        byId('addUserBtn')?.addEventListener('click', () => addUser.toggle(byId('addUserForm').hidden));
        byId('addUserCancel')?.addEventListener('click', () => addUser.toggle(false));
        byId('addUserForm')?.addEventListener('submit', event => addUser.submit(event));
        byId('sessionsRefresh')?.addEventListener('click', () => sessions.load());
        byId('auditSearch')?.addEventListener('input', () => {
            clearTimeout(audit.timer);
            audit.timer = setTimeout(() => {
                audit.offset = 0;
                audit.load();
            }, 300);
        });
        byId('auditLevel')?.addEventListener('change', () => {
            audit.offset = 0;
            audit.load();
        });
        byId('auditPrev')?.addEventListener('click', () => {
            audit.offset = Math.max(0, audit.offset - AUDIT_PAGE);
            audit.load();
        });
        byId('auditNext')?.addEventListener('click', () => {
            audit.offset += AUDIT_PAGE;
            audit.load();
        });
        const form = byId('systemForm');
        form?.addEventListener('input', () => system.sync());
        form?.addEventListener('change', () => system.sync());
        form?.addEventListener('submit', event => system.save(event));
        byId('systemReset')?.addEventListener('click', () => system.reset());
        // A scrolled list leaves the popover behind its button.
        byId('settingsView')?.querySelector('.sv-scroll')
            ?.addEventListener('scroll', () => menu.close(false), { passive: true });
        window.addEventListener('resize', () => menu.close(false));
        window.addEventListener('languageChanged', () => {
            users.render();
            sessions.render();
            audit.render();
            if (!system.dirty) system.render();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
