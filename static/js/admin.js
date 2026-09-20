(function () {
    'use strict';

    const APP_ROOT = (document.querySelector('meta[name="app-root"]')?.content || '').replace(/\/$/, '');
    const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const CURRENT_USER = document.querySelector('meta[name="current-user"]')?.content || '';

    const t = (key, fallback) => (window.i18n && i18n.t ? i18n.t(key) : null) || fallback || key;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(message, type) {
        const container = document.getElementById('notificationContainer');
        if (!container) { return; }
        const el = document.createElement('div');
        el.className = 'notification notification-' + (type || 'info');
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => el.remove(), type === 'error' ? 4000 : 2500);
    }

    async function api(path, options) {
        const opts = Object.assign({ headers: {} }, options || {});
        opts.headers = Object.assign({
            'Accept': 'application/json',
            'X-CSRFToken': CSRF
        }, opts.headers);
        if (opts.body && typeof opts.body === 'object') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        const res = await fetch(APP_ROOT + path, opts);
        let data = null;
        try { data = await res.json(); } catch (e) { /* ignore */ }
        if (!res.ok) {
            const msg = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
            throw new Error(msg);
        }
        return data;
    }

    function fmtDate(iso) {
        if (!iso) { return '—'; }
        const d = new Date(iso);
        if (isNaN(d.getTime())) { return iso; }
        return d.toLocaleString();
    }

    // ---- Tabs ----
    function initTabs() {
        document.querySelectorAll('.admin-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.admin-tab').forEach(x => x.classList.remove('active'));
                tab.classList.add('active');
                const name = tab.dataset.tab;
                ['users', 'audit', 'settings'].forEach(n => {
                    document.getElementById('tab-' + n)?.classList.toggle('hidden', n !== name);
                });
                if (name === 'audit') { loadAudit(); }
                if (name === 'settings') { loadSettings(); }
            });
        });
    }

    // ---- Users ----
    function userActionsHtml(u) {
        const isSelf = u.username === CURRENT_USER;
        const parts = [];
        // A5-btn carries the 44px floor --(b): every row action stays a
        // real touch target, including in the stacked-card form on a phone.
        // The btn/btn-secondary classes and the data-act hooks are unchanged.
        if (u.is_admin) {
            parts.push(`<button class="a5-btn btn btn-secondary" data-act="demote" ${isSelf ? 'disabled' : ''}>${escapeHtml(t('admin.demote', 'Demote'))}</button>`);
        } else {
            parts.push(`<button class="a5-btn btn btn-secondary" data-act="promote">${escapeHtml(t('admin.promote', 'Promote'))}</button>`);
        }
        if (u.is_locked) {
            parts.push(`<button class="a5-btn btn btn-secondary" data-act="unlock">${escapeHtml(t('admin.unlock', 'Unlock'))}</button>`);
        } else {
            parts.push(`<button class="a5-btn btn btn-secondary" data-act="lock" ${isSelf ? 'disabled' : ''}>${escapeHtml(t('admin.lock', 'Lock'))}</button>`);
        }
        parts.push(`<button class="a5-btn a5-btn-danger btn btn-danger" data-act="delete" ${isSelf ? 'disabled' : ''}>${escapeHtml(t('admin.delete', 'Delete'))}</button>`);
        return `<div class="a5-row-actions admin-actions">${parts.join('')}</div>`;
    }

    /*
     * Mirror each column's header text onto its cells as data-label.
     *
     * Below 700px the admin tables stop
     * being tables and reflow to stacked cards, because a 460px-wide user table
     * would otherwise force a sideways drag on every row. A stacked card needs
     * the column name next to each value, and auth-v5.css renders it from
     * `td::before { content: attr(data-label) }`.
     *
     * Read from the live <th> rather than hardcoded per cell, so a column
     * rename or reorder cannot leave a stale label behind, and so the label
     * follows the i18n translation that has already been applied to the header.
     *
     * The actions column is deliberately left with an empty label: its buttons
     * are self-describing and a "Actions" prefix would just steal width from
     * them on the narrowest phone.
     */
    function applyColumnLabels(table, opts) {
        if (!table) {
            return;
        }
        const headers = Array.from(table.querySelectorAll('thead th'))
            .map(th => th.textContent.trim());
        const blankLast = !opts || opts.blankLastColumn !== false;
        table.querySelectorAll('tbody tr').forEach(tr => {
            Array.from(tr.children).forEach((td, i) => {
                // A colspan cell (the "no entries" row) spans every column, so
                // no single header names it.
                if (td.hasAttribute('colspan')) {
                    td.setAttribute('data-label', '');
                    return;
                }
                const isLast = i === headers.length - 1;
                td.setAttribute('data-label',
                    (blankLast && isLast) ? '' : (headers[i] || ''));
            });
        });
    }

    function renderUsers(users) {
        const body = document.getElementById('adminUsersBody');
        body.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.dataset.userId = u.id;
            const role = u.is_admin
                ? `<span class="admin-badge admin">${escapeHtml(t('admin.roleAdmin', 'Admin'))}</span>`
                : `<span class="admin-badge">${escapeHtml(t('admin.roleUser', 'User'))}</span>`;
            const status = u.is_locked
                ? `<span class="admin-badge locked">${escapeHtml(t('admin.statusLocked', 'Locked'))}</span>`
                : `<span class="admin-badge">${escapeHtml(t('admin.statusActive', 'Active'))}</span>`;
            tr.innerHTML =
                `<td>${u.id}</td>` +
                `<td>${escapeHtml(u.username)}${u.username === CURRENT_USER ? ' <span class="admin-muted">(' + escapeHtml(t('admin.you', 'you')) + ')</span>' : ''}</td>` +
                `<td>${role}</td>` +
                `<td>${status}</td>` +
                `<td>${escapeHtml(fmtDate(u.created_at))}</td>` +
                `<td>${escapeHtml(fmtDate(u.last_login))}</td>` +
                `<td>${userActionsHtml(u)}</td>`;
            body.appendChild(tr);
        });
        applyColumnLabels(document.getElementById('adminUsersTable'));
    }

    async function loadUsers() {
        try {
            const data = await api('/admin/api/users');
            renderUsers(data.users || []);
        } catch (e) {
            notify(e.message, 'error');
        }
    }

    async function doUserAction(userId, action) {
        try {
            await api(`/admin/api/users/${userId}/${action}`, { method: 'POST' });
            await loadUsers();
            notify(t('admin.actionDone', 'Done'), 'success');
        } catch (e) {
            notify(e.message, 'error');
        }
    }

    function initUsers() {
        document.getElementById('adminRefreshUsers')?.addEventListener('click', loadUsers);
        document.getElementById('adminUsersBody')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn || btn.disabled) { return; }
            const tr = btn.closest('tr');
            const userId = tr?.dataset.userId;
            const action = btn.dataset.act;
            if (!userId) { return; }
            if (action === 'delete' && !window.confirm(t('admin.confirmDelete', 'Delete this user permanently?'))) { return; }
            doUserAction(userId, action);
        });

        // Add-user modal
        const modal = document.getElementById('addUserModal');
        const open = () => {
            if (!modal) { return; }
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
            document.getElementById('newUsername')?.focus();
        };
        const close = () => {
            if (!modal) { return; }
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
            document.getElementById('adminAddUserBtn')?.focus();
        };
        document.getElementById('adminAddUserBtn')?.addEventListener('click', open);
        document.getElementById('closeAddUser')?.addEventListener('click', close);
        modal?.addEventListener('click', (e) => { if (e.target === modal) { close(); } });
        document.getElementById('submitNewUser')?.addEventListener('click', async () => {
            const username = document.getElementById('newUsername').value.trim();
            const password = document.getElementById('newPassword').value;
            const isAdmin = document.getElementById('newIsAdmin').checked;
            try {
                await api('/admin/api/users', { method: 'POST', body: { username, password, is_admin: isAdmin } });
                close();
                document.getElementById('newUsername').value = '';
                document.getElementById('newPassword').value = '';
                document.getElementById('newIsAdmin').checked = false;
                /*
                 * Setting .value does not fire `input`, so the a5 hints and the
                 * is-valid/is-invalid classes auth.js wrote would survive the
                 * clear -- the next open would show an empty Username field
                 * still reading "Valid username" in green. Dispatch the event
                 * the clear is equivalent to, and let whatever validation is
                 * attached recompute. admin.js stays unaware of hint ids.
                 */
                ['newUsername', 'newPassword'].forEach(id => {
                    document.getElementById(id)
                        ?.dispatchEvent(new Event('input', { bubbles: true }));
                });
                await loadUsers();
                notify(t('admin.userCreated', 'User created'), 'success');
            } catch (e) {
                notify(e.message, 'error');
            }
        });
    }

    // ---- Audit logs ----
    const audit = { offset: 0, limit: 100, total: 0 };

    function renderAudit(items) {
        const body = document.getElementById('adminAuditBody');
        body.innerHTML = '';
        if (!items.length) {
            body.innerHTML = `<tr><td colspan="4" class="admin-muted">${escapeHtml(t('admin.noLogs', 'No log entries'))}</td></tr>`;
            applyColumnLabels(document.getElementById('adminAuditTable'),
                { blankLastColumn: false });
            return;
        }
        items.forEach(e => {
            const tr = document.createElement('tr');
            const level = e.level || '';
            tr.innerHTML =
                `<td>${escapeHtml(fmtDate(e.timestamp))}</td>` +
                `<td><span class="admin-badge level-${escapeHtml(level)}">${escapeHtml(level)}</span></td>` +
                `<td>${escapeHtml(e.logger || '')}</td>` +
                `<td class="admin-message a5-message">${escapeHtml(e.message || '')}</td>`;
            body.appendChild(tr);
        });
        // The audit table's last column is the message itself, not an action
        // row, so it keeps its label when stacked.
        applyColumnLabels(document.getElementById('adminAuditTable'),
            { blankLastColumn: false });
    }

    function updateAuditPageInfo() {
        const info = document.getElementById('auditPageInfo');
        const from = audit.total === 0 ? 0 : audit.offset + 1;
        const to = Math.min(audit.offset + audit.limit, audit.total);
        info.textContent = `${from}–${to} / ${audit.total}`;
        document.getElementById('auditPrev').disabled = audit.offset <= 0;
        document.getElementById('auditNext').disabled = audit.offset + audit.limit >= audit.total;
    }

    async function loadAudit() {
        const level = document.getElementById('auditLevel').value;
        const q = document.getElementById('auditSearch').value.trim();
        const params = new URLSearchParams({ offset: audit.offset, limit: audit.limit });
        if (level) { params.set('level', level); }
        if (q) { params.set('q', q); }
        try {
            const data = await api('/admin/api/audit?' + params.toString());
            audit.total = data.total || 0;
            audit.offset = data.offset || 0;
            renderAudit(data.items || []);
            updateAuditPageInfo();
        } catch (e) {
            notify(e.message, 'error');
        }
    }

    function initAudit() {
        document.getElementById('auditRefresh')?.addEventListener('click', () => { audit.offset = 0; loadAudit(); });
        document.getElementById('auditLevel')?.addEventListener('change', () => { audit.offset = 0; loadAudit(); });
        let searchTimer = null;
        document.getElementById('auditSearch')?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { audit.offset = 0; loadAudit(); }, 300);
        });
        document.getElementById('auditPrev')?.addEventListener('click', () => {
            audit.offset = Math.max(0, audit.offset - audit.limit);
            loadAudit();
        });
        document.getElementById('auditNext')?.addEventListener('click', () => {
            audit.offset = audit.offset + audit.limit;
            loadAudit();
        });
    }

    // ---- Settings ----
    // The limits table comes from the server (key, type, value, default,
    // bounds); labels and hints are i18n keys named after the setting.
    const RATE_UNITS = ['second', 'minute', 'hour'];

    function limitLabel(key) {
        return t('admin.set.' + key, key.replace(/_/g, ' '));
    }

    function formatDefault(row) {
        if (row.type === 'bool') return row.default ? t('admin.on', 'on') : t('admin.off', 'off');
        if (row.type === 'rate') return String(row.default);
        return row.unit ? `${row.default} ${row.unit}` : String(row.default);
    }

    function renderLimits(rows) {
        const box = document.getElementById('settingsLimitsFields');
        if (!box) { return; }
        box.innerHTML = '';
        rows.filter(row => row.key !== 'registration_enabled').forEach(row => {
            const line = document.createElement('div');
            line.className = 'admin-limit-row' + (row.overridden ? ' overridden' : '');
            line.dataset.key = row.key;
            const label = document.createElement('strong');
            label.textContent = limitLabel(row.key);
            const control = document.createElement('div');
            control.className = 'admin-limit-control';
            if (row.type === 'bool') {
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.name = row.key;
                input.checked = !!row.value;
                control.appendChild(input);
            } else if (row.type === 'rate') {
                const parts = /^(\d+) per (\w+)$/.exec(String(row.value)) || [null, '1', 'minute'];
                const count = document.createElement('input');
                count.type = 'number';
                count.className = 'a5-input';
                count.name = row.key + ':count';
                count.min = '1';
                count.value = parts[1];
                const unit = document.createElement('select');
                unit.className = 'a5-select';
                unit.name = row.key + ':unit';
                RATE_UNITS.forEach(u => {
                    const option = document.createElement('option');
                    option.value = u;
                    option.textContent = t('admin.per_' + u, 'per ' + u);
                    unit.appendChild(option);
                });
                unit.value = parts[2];
                control.append(count, unit);
            } else {
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'a5-input';
                input.name = row.key;
                input.min = String(row.min);
                input.max = String(row.max);
                input.value = String(row.value);
                control.appendChild(input);
                if (row.unit) {
                    const unit = document.createElement('span');
                    unit.className = 'admin-muted';
                    unit.textContent = t('admin.unit_' + row.unit, row.unit);
                    control.appendChild(unit);
                }
            }
            const hint = document.createElement('p');
            hint.className = 'a5-muted admin-muted';
            hint.textContent = t('admin.set.' + row.key + 'Hint', '') + ' '
                + t('admin.defaultValue', 'Default: {value}').replace('{value}', formatDefault(row));
            line.append(label, control, hint);
            box.appendChild(line);
        });
    }

    function readLimits() {
        const form = document.getElementById('settingsLimitsForm');
        const changes = {};
        form.querySelectorAll('.admin-limit-row').forEach(line => {
            const key = line.dataset.key;
            const checkbox = line.querySelector('input[type="checkbox"]');
            const count = line.querySelector(`[name="${key}:count"]`);
            if (checkbox) {
                changes[key] = checkbox.checked;
            } else if (count) {
                const unit = line.querySelector(`[name="${key}:unit"]`).value;
                changes[key] = `${count.value} per ${unit}`;
            } else {
                changes[key] = line.querySelector(`[name="${key}"]`).value;
            }
        });
        return changes;
    }

    async function loadSettings() {
        try {
            const data = await api('/admin/api/settings');
            document.getElementById('settingRegistration').checked = !!data.registration_enabled;
            renderLimits(data.settings || []);
        } catch (e) {
            notify(e.message, 'error');
        }
    }

    function initSettings() {
        document.getElementById('settingRegistration')?.addEventListener('change', async (e) => {
            const target = e.target;
            try {
                const data = await api('/admin/api/settings', {
                    method: 'POST',
                    body: { registration_enabled: target.checked }
                });
                target.checked = !!data.registration_enabled;
                notify(t('admin.settingsSaved', 'Settings saved'), 'success');
            } catch (err) {
                target.checked = !target.checked; // revert on failure
                notify(err.message, 'error');
            }
        });
        document.getElementById('settingsLimitsForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const data = await api('/admin/api/settings', { method: 'POST', body: readLimits() });
                renderLimits(data.settings || []);
                notify(t('admin.settingsSaved', 'Settings saved'), 'success');
            } catch (err) {
                notify(err.message, 'error');
            }
        });
        document.getElementById('settingsResetBtn')?.addEventListener('click', async () => {
            if (!window.confirm(t('admin.resetConfirm', 'Return every limit to the deployment default?'))) { return; }
            try {
                const data = await api('/admin/api/settings', { method: 'POST', body: { reset: 'all' } });
                document.getElementById('settingRegistration').checked = !!data.registration_enabled;
                renderLimits(data.settings || []);
                notify(t('admin.settingsSaved', 'Settings saved'), 'success');
            } catch (err) {
                notify(err.message, 'error');
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (window.i18n && i18n.updatePageText) { i18n.updatePageText(); }
        initTabs();
        initUsers();
        initAudit();
        initSettings();
        loadUsers();
    });
})();
