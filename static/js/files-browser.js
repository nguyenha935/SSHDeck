/*
 * THE FILES BROWSER -- the Files panel, expanded (owner ruling 2026-10-02).
 *
 * The expand control in the Files panel's head opens this view of the SAME
 * pane: SFTPFileManager's 'inline' pane, with its session, directory and
 * listing. This module owns the view -- table, toolbar, selection, keyboard,
 * in-place rename and create, the delete dialog -- and asks the manager to
 * list, navigate, preview and transfer, so the panel and the browser can never
 * disagree about where they are.
 *
 * Geometry. Over the workspace on a desktop and an iPad, with the header,
 * session chips and status bar still usable [INF-FILES-2]; the whole screen on
 * a phone and in short landscape [INF-FILES-3]. Neither moves a pixel of the
 * terminal underneath -- no grid track changes, nothing is hidden -- so
 * expanding or collapsing sends no ssh_resize to any device on the session.
 *
 * Selection is kept by NAME, so a re-list cannot move it onto another file.
 * Operations carry a request_id and are answered by one fm_result frame for
 * the whole batch (app/socket_events.py).
 */
(() => {
    // The panel's compact tier (sftp-file-manager.css [INF-FILES-1]): here the
    // browser takes the whole screen.
    const FULL_SCREEN_QUERY = '(max-width: 767px), (pointer: coarse) and (hover: none) and (max-height: 500px)';
    const STORE_SORT = 'sshdeck.files.sort';
    const STORE_HIDDEN = 'sshdeck.files.hidden';
    const HISTORY_LIMIT = 50;
    const LONG_PRESS_MS = 300;        // the session chip's hold [INF-FILES-8]
    const MOVE_TOLERANCE_PX = 10;
    const OVERSCAN_ROWS = 8;
    const REQUEST_TIMEOUT_MS = 30000;
    const TYPEAHEAD_MS = 700;
    const DELETE_LISTED = 5;
    const CRUMBS_SHOWN = 5;
    const SORT_KEYS = ['name', 'size', 'modified', 'perm', 'owner'];

    function readStore(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Private mode or blocked storage: the choice lasts this page.
        }
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    class FilesBrowser {
        constructor(fm) {
            this.fm = fm;
            this.root = null;
            this.expanded = false;
            this.view = [];
            this.rowEls = new Map();
            this.selected = new Set();
            this.anchor = null;
            this.focusIndex = 0;
            this.filter = '';
            const sort = readStore(STORE_SORT, null);
            this.sort = sort && SORT_KEYS.includes(sort.key) && Math.abs(sort.dir) === 1
                ? sort : { key: 'name', dir: 1 };
            this.showHidden = readStore(STORE_HIDDEN, true) !== false;
            this.history = { session: null, back: [], forward: [] };
            this.listed = { session: null, path: null };
            this.shown = { session: null, path: null };
            this.navigating = false;
            this.selecting = false;
            this.editing = null;
            this.rebuilding = false;
            this.menu = null;
            this.dialog = null;
            this.pending = new Map();
            this.inerted = [];
            this.typeahead = { text: '', at: 0 };
            this.pointer = 'mouse';
            this.press = null;
            this.pendingFocusName = null;
            this.returnFocus = null;
            this.backArmed = false;
            this.skipPop = false;
            this.rowMenuAnchor = null;
            // A rotation can cross into or out of the full-screen tier.
            this.onResize = () => {
                this.setBackgroundInert(false);
                this.setBackgroundInert(true);
                this.renderRows(true);
            };
            fm.socket?.on('fm_result', (data) => this.settle(data));
        }

        get state() {
            return this.fm.panes.inline;
        }

        isExpanded() {
            return this.expanded;
        }

        // ── helpers ─────────────────────────────────────────────────────────
        t(key, fallback = '') {
            return this.fm.t(key, fallback);
        }

        fmt(key, fallback, vars) {
            return Object.entries(vars).reduce(
                (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
                this.t(key, fallback));
        }

        esc(text) {
            return this.fm.escapeHtml(String(text ?? ''));
        }

        icon(name, classes = '') {
            return this.fm.spriteIcon(name, classes);
        }

        el(id) {
            return this.root?.querySelector(`#${id}`) || null;
        }

        sessionId() {
            return this.state.sessionId || this.state.connectionId;
        }

        isFullScreen() {
            return window.matchMedia(FULL_SCREEN_QUERY).matches;
        }

        isTouch() {
            return this.pointer === 'touch' || this.pointer === 'pen';
        }

        isDir(file) {
            return !!(file.is_dir || (file.is_symlink && file.target_is_dir));
        }

        pathOf(name) {
            return this.fm.joinPath(this.state.path || '/', name);
        }

        rowHeight() {
            const value = parseFloat(getComputedStyle(this.root).getPropertyValue('--fb-row-h'));
            return value > 0 ? value : 36;
        }

        permString(mode) {
            if (mode === null || mode === undefined) return '';
            const kind = mode & 0o170000;
            const type = kind === 0o040000 ? 'd' : kind === 0o120000 ? 'l' : '-';
            return type + 'rwxrwxrwx'.split('')
                .map((bit, k) => (mode & (0o400 >> k)) ? bit : '-').join('');
        }

        formatDate(seconds) {
            if (seconds === null || seconds === undefined) return { short: '—', full: '' };
            const date = new Date(seconds * 1000);
            const now = new Date();
            const lang = window.i18n?.currentLang || undefined;
            // Today: the time. This year: day and month. Older: the full date.
            // [INF-FILES-14]
            const options = date.toDateString() === now.toDateString()
                ? { hour: '2-digit', minute: '2-digit' }
                : date.getFullYear() === now.getFullYear()
                    ? { day: 'numeric', month: 'short' }
                    : { day: '2-digit', month: '2-digit', year: 'numeric' };
            try {
                return {
                    short: new Intl.DateTimeFormat(lang, options).format(date),
                    full: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date),
                };
            } catch {
                return { short: date.toLocaleDateString(), full: date.toLocaleString() };
            }
        }

        // ── requests ────────────────────────────────────────────────────────
        request(event, payload) {
            const requestId = `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.pending.delete(requestId);
                    resolve({ results: [{ ok: false, error: this.t('fb.noReply', 'No reply from the server') }] });
                }, REQUEST_TIMEOUT_MS);
                this.pending.set(requestId, { resolve, timer });
                this.fm.socket.emit(event, { ...payload, request_id: requestId });
            });
        }

        settle(data) {
            const entry = this.pending.get(data?.request_id);
            if (!entry) return;
            clearTimeout(entry.timer);
            this.pending.delete(data.request_id);
            entry.resolve(data);
        }

        // ── lifecycle ───────────────────────────────────────────────────────
        build() {
            const host = document.getElementById('workspace') || document.querySelector('.workspace');
            if (!host) return false;
            const root = document.createElement('section');
            root.className = 'files-browser';
            root.id = 'filesBrowser';
            root.hidden = true;
            root.setAttribute('aria-labelledby', 'fbTitle');
            root.innerHTML = this.markup();
            host.appendChild(root);
            this.root = root;
            this.fm.translateSubtree(root);
            this.bind();
            window.addEventListener('popstate', () => this.onPopState());
            return true;
        }

        markup() {
            const i = (name, cls) => this.icon(name, cls);
            const iconButton = (act, name, key, fallback, extra = '') => `
                <button type="button" class="fb-icon ${extra}" data-act="${act}"
                        aria-label="${fallback}" title="${fallback}"
                        data-i18n-aria-label="${key}" data-i18n-title="${key}">${i(name)}</button>`;
            const labelButton = (act, name, key, fallback, extra = '', need = '') => `
                <button type="button" class="fb-btn ${extra}" data-act="${act}" ${need ? `data-need="${need}"` : ''}
                        aria-label="${fallback}" title="${fallback}" data-i18n-aria-label="${key}"
                        data-i18n-title="${key}">${i(name)}<span data-i18n="${key}">${fallback}</span></button>`;
            const sortButton = (key, i18n, fallback, cls) => `
                <button type="button" class="fb-sort ${cls}" data-act="sort" data-key="${key}" role="columnheader">
                    <span data-i18n="${i18n}">${fallback}</span>${i('chevron-up', 'fb-sort-arrow')}</button>`;
            return `
                <div class="fb-top">
                    <header class="fb-head">
                        <button type="button" class="fb-btn fb-collapse" data-act="collapse"
                                aria-label="Collapse" data-i18n-aria-label="fb.collapse">${i('minimize-2')}<span data-i18n="fb.collapse">Collapse</span></button>
                        <div class="fb-title-block">
                            <h2 class="fb-title" id="fbTitle">Files</h2>
                            <span class="fb-badge" id="fbBadge"></span>
                        </div>
                        <div class="fb-selhead">
                            ${iconButton('end-select', 'x', 'common.cancel', 'Cancel')}
                            <strong id="fbSelTitle"></strong>
                            <button type="button" class="fb-link" data-act="select-all" data-i18n="fb.selectAll">Select all</button>
                        </div>
                        ${iconButton('toggle-filter', 'search', 'fb.filter', 'Filter', 'fb-phone-only')}
                        ${iconButton('menu', 'ellipsis-vertical', 'fm.moreActions', 'More actions', 'fb-phone-only')}
                        ${iconButton('close', 'x', 'common.close', 'Close', 'fb-close')}
                    </header>
                    <div class="fb-nav">
                        ${iconButton('back', 'arrow-left', 'fb.back', 'Back', 'fb-hist')}
                        ${iconButton('forward', 'arrow-right', 'fb.forward', 'Forward', 'fb-hist')}
                        ${iconButton('up', 'arrow-up', 'fm.goUp', 'Up')}
                        ${iconButton('home', 'house', 'fm.goHome', 'Home')}
                        <nav class="fb-crumbs" id="fbCrumbs" aria-label="Path" data-i18n-aria-label="fb.path"></nav>
                        <form class="fb-pathform" id="fbPathForm" hidden>
                            <input type="text" id="fbPath" class="fb-path" autocapitalize="off"
                                   autocorrect="off" spellcheck="false" aria-label="Path"
                                   data-i18n-aria-label="fb.path">
                        </form>
                        ${iconButton('refresh', 'refresh-cw', 'fm.refresh', 'Refresh', 'fb-refresh')}
                        <label class="fb-filter" id="fbFilterBox">${i('search')}
                            <input type="search" id="fbFilter" autocapitalize="off" autocorrect="off"
                                   spellcheck="false" placeholder="Filter this folder"
                                   data-i18n-placeholder="fb.filterPlaceholder"
                                   aria-label="Filter this folder" data-i18n-aria-label="fb.filterPlaceholder">
                        </label>
                        <button type="button" class="fb-toggle" id="fbHidden" data-act="hidden" aria-pressed="true"
                                aria-label="Hidden files" title="Hidden files" data-i18n-aria-label="fb.hiddenFiles"
                                data-i18n-title="fb.hiddenFiles">${i('eye')}<span data-i18n="fb.hiddenFiles">Hidden files</span></button>
                    </div>
                    <div class="fb-toolbar" role="toolbar" aria-label="File actions" data-i18n-aria-label="fb.actions">
                        ${labelButton('upload', 'upload', 'fm.upload', 'Upload', 'fb-primary')}
                        ${labelButton('new-dir', 'folder-plus', 'fm.newFolder', 'New Folder')}
                        ${labelButton('new-file', 'file-plus', 'fb.newFile', 'New file')}
                        <span class="fb-sep" aria-hidden="true"></span>
                        ${labelButton('download', 'download', 'fm.download', 'Download', '', 'any')}
                        ${labelButton('rename', 'pencil', 'fm.rename', 'Rename', '', 'one')}
                        ${labelButton('delete', 'trash-2', 'fm.delete', 'Delete', 'fb-danger', 'any')}
                        <span class="fb-fill"></span>
                        <span class="fb-selsum" id="fbSelSum" aria-live="polite"></span>
                    </div>
                </div>
                <div class="fb-table">
                    <div class="fb-cols" role="row">
                        <span class="fb-c-check"><input type="checkbox" class="fb-check" id="fbAll"
                              aria-label="Select all" data-i18n-aria-label="fb.selectAll"></span>
                        ${sortButton('name', 'fb.colName', 'Name', 'fb-c-name')}
                        ${sortButton('size', 'fb.colSize', 'Size', 'fb-c-size')}
                        ${sortButton('modified', 'fb.colModified', 'Modified', 'fb-c-mod')}
                        ${sortButton('perm', 'fb.colPermissions', 'Permissions', 'fb-c-perm')}
                        ${sortButton('owner', 'fb.colOwner', 'Owner', 'fb-c-owner')}
                        <span class="fb-c-more"></span>
                    </div>
                    <div class="fb-list" id="fbList" role="grid" tabindex="0" aria-multiselectable="true"
                         aria-labelledby="fbTitle"><div class="fb-sizer" id="fbSizer"></div></div>
                    <div class="fb-state" id="fbState" hidden></div>
                </div>
                <footer class="fb-foot"><span id="fbCount"></span></footer>
                <nav class="fb-bar" aria-label="File actions" data-i18n-aria-label="fb.actions">
                    <div class="fb-bar-group fb-bar-normal">
                        ${labelButton('upload', 'upload', 'fm.upload', 'Upload')}
                        ${labelButton('new-dir', 'folder-plus', 'fb.folderShort', 'Folder')}
                        ${labelButton('new-file', 'file-plus', 'fb.newFile', 'New file')}
                    </div>
                    <div class="fb-bar-group fb-bar-select">
                        ${labelButton('download', 'download', 'fm.download', 'Download', '', 'any')}
                        ${labelButton('rename', 'pencil', 'fm.rename', 'Rename', '', 'one')}
                        ${labelButton('delete', 'trash-2', 'fm.delete', 'Delete', 'fb-danger', 'any')}
                    </div>
                </nav>
                <input type="file" id="fbUploadInput" multiple hidden>
                <div class="fb-live" id="fbLive" aria-live="polite"></div>`;
        }

        bind() {
            const root = this.root;
            const list = this.el('fbList');

            root.addEventListener('click', (e) => {
                const button = e.target.closest('[data-act]');
                if (button && root.contains(button) && !button.disabled) {
                    this.act(button.dataset.act, button);
                }
            });
            root.addEventListener('keydown', (e) => this.onKey(e));
            root.addEventListener('pointerdown', (e) => {
                // A press on the control that opened the menu is left to its
                // click, which closes it (toggleMenu).
                if (this.menu && !this.menu.contains(e.target) && !this.menuAnchor?.contains(e.target)) {
                    this.closeMenu();
                }
            });

            list.addEventListener('scroll', () => this.renderRows());
            list.addEventListener('pointerdown', (e) => this.onPointerDown(e));
            list.addEventListener('pointermove', (e) => this.onPointerMove(e));
            ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) =>
                list.addEventListener(type, () => this.clearPress()));
            list.addEventListener('click', (e) => this.onRowClick(e));
            list.addEventListener('dblclick', (e) => this.onRowDblClick(e));
            list.addEventListener('contextmenu', (e) => this.onRowContextMenu(e));
            list.addEventListener('input', (e) => {
                if (e.target.matches('.fb-edit') && this.editing) {
                    this.editing.value = e.target.value;
                    this.editing.error = null;
                    this.showEditError();
                }
            });
            list.addEventListener('focusout', (e) => {
                // Clicking away from the name being edited cancels it [INF-FILES-10].
                if (e.target.matches('.fb-edit') && this.editing && !this.editing.busy && !this.rebuilding) {
                    this.cancelEdit();
                }
            });

            this.el('fbAll').addEventListener('change', () => {
                const names = this.selectableNames();
                const all = names.length > 0 && names.every(name => this.selected.has(name));
                this.selected = all ? new Set() : new Set(names);
                this.syncSelection();
            });

            const filter = this.el('fbFilter');
            filter.addEventListener('input', () => {
                this.filter = filter.value;
                this.focusIndex = 0;
                this.el('fbList').scrollTop = 0;
                this.rebuildView();
            });

            this.el('fbPathForm').addEventListener('submit', (e) => {
                e.preventDefault();
                const value = this.el('fbPath').value.trim();
                this.closePathEdit();
                if (value) this.go(value);
            });
            this.el('fbPath').addEventListener('blur', () => this.closePathEdit());

            this.el('fbUploadInput').addEventListener('change', (e) => {
                const sessionId = this.sessionId();
                if (sessionId) {
                    [...e.target.files].forEach(file =>
                        this.fm.uploadFileToBrowser(file, this.state.path || '/', sessionId, 'inline'));
                }
                e.target.value = '';
            });
        }

        expand() {
            if (this.expanded) return;
            if (!this.root && !this.build()) return;
            const s = this.state;
            // Same pane, same selection: the panel's indexes, as names.
            this.selected = new Set([...s.selected].map(index => s.files[index]?.name).filter(Boolean));
            this.listed = { session: s.sessionId, path: s.path };
            this.focusIndex = 0;
            this.returnFocus = document.activeElement;
            this.expanded = true;
            this.root.hidden = false;
            document.body.classList.add('files-browser-open');
            this.setBackgroundInert(true);
            window.addEventListener('resize', this.onResize);
            this.armBack();
            this.render();
            this.el('fbList').focus({ preventScroll: true });
        }

        // Back to the panel at the same directory, with the same selection.
        collapse() {
            if (!this.expanded) return;
            const names = this.selected;
            this.hide();
            const s = this.state;
            s.selected = new Set(s.files.flatMap((file, index) => names.has(file.name) ? [index] : []));
            this.fm.renderPane('inline');
            const expandButton = document.getElementById('sftpPanelExpand');
            (expandButton || this.returnFocus)?.focus?.({ preventScroll: true });
        }

        // Closing the panel closes the browser over it (closeInline calls this).
        hide() {
            if (!this.expanded) return;
            this.expanded = false;
            this.editing = null;
            this.selecting = false;
            this.closeMenu();
            this.closeDialog(null);
            this.clearRows();
            this.root.hidden = true;
            this.root.classList.remove('fb-selecting', 'fb-filter-open', 'fb-has-selection');
            document.body.classList.remove('files-browser-open');
            this.setBackgroundInert(false);
            window.removeEventListener('resize', this.onResize);
            this.releaseBack();
        }

        close() {
            this.hide();
            this.fm.closeInline();
        }

        /*
         * What the browser covers cannot take focus or clicks: the terminal and
         * the panel under it, and on a full screen the header and dock as well.
         * Only elements this browser made inert are released again.
         */
        setBackgroundInert(on) {
            if (!on) {
                this.inerted.forEach(element => element.removeAttribute('inert'));
                this.inerted = [];
                return;
            }
            const stop = this.isFullScreen()
                ? document.getElementById('deckWindow') || document.body
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
        }

        // ── rendering ───────────────────────────────────────────────────────
        render() {
            if (!this.expanded) return;
            const s = this.state;
            if (s.sessionId !== this.history.session) {
                this.history = { session: s.sessionId, back: [], forward: [] };
            }
            if (s.sessionId !== this.listed.session || s.path !== this.listed.path) {
                // A new directory: nothing is selected, filtered or being edited.
                this.listed = { session: s.sessionId, path: s.path };
                this.selected.clear();
                this.anchor = null;
                this.focusIndex = 0;
                this.filter = '';
                this.el('fbFilter').value = '';
                this.editing = null;
                this.el('fbList').scrollTop = 0;
            } else if (!s.loading) {
                // The same directory re-listed: keep the names that are still
                // there. Not while a refresh is in flight -- the files are the
                // old list then, without the name a rename just made.
                const present = new Set(s.files.map(file => file.name));
                this.selected = new Set([...this.selected].filter(name => present.has(name)));
            }
            if (!s.loading) this.navigating = false;
            if (!s.loading && !s.error) this.shown = { session: s.sessionId, path: s.path };
            this.renderHead();
            this.renderCrumbs();
            this.rebuildView();
        }

        renderHead() {
            const s = this.state;
            const host = s.hostInfo?.host || '';
            const base = this.t('fm.filesTitle', 'Files');
            this.el('fbTitle').textContent = host ? `${base} · ${host}` : base;
            this.el('fbBadge').textContent = s.hostInfo ? `${s.hostInfo.username}@${s.hostInfo.host}` : '';
            this.root.querySelector('[data-act="back"]').disabled = this.history.back.length === 0;
            this.root.querySelector('[data-act="forward"]').disabled = this.history.forward.length === 0;
            this.root.querySelector('[data-act="up"]').disabled = !s.type || (s.path || '/') === '/';
            const hidden = this.el('fbHidden');
            hidden.setAttribute('aria-pressed', String(this.showHidden));
            hidden.querySelector('use')?.setAttribute('href', `${this.fm.sprite}#icon-${this.showHidden ? 'eye' : 'eye-off'}`);
            this.root.querySelectorAll('.fb-sort').forEach(button => {
                const active = button.dataset.key === this.sort.key;
                button.classList.toggle('is-sorted', active);
                button.classList.toggle('is-desc', active && this.sort.dir < 0);
                button.setAttribute('aria-sort', active ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
            });
        }

        crumbSegments() {
            const parts = (this.state.path || '/').split('/').filter(Boolean);
            return [{ label: '/', path: '/' },
                ...parts.map((part, k) => ({ label: part, path: '/' + parts.slice(0, k + 1).join('/') }))];
        }

        renderCrumbs() {
            const segments = this.crumbSegments();
            this.hiddenCrumbs = segments.length > CRUMBS_SHOWN ? segments.slice(1, segments.length - 3) : [];
            const shown = this.hiddenCrumbs.length
                ? [segments[0], { more: true }, ...segments.slice(-3)] : segments;
            const separator = this.icon('chevron-right', 'fb-crumb-sep');
            this.el('fbCrumbs').innerHTML = shown.map((segment, k) => {
                const sep = k > 0 && !(segment.more) && !(shown[k - 1].more) ? separator : '';
                if (segment.more) {
                    return `${separator}<button type="button" class="fb-crumb" data-act="crumbs-more"
                            aria-label="${this.esc(this.t('fb.fullPath', 'Show the full path'))}">…</button>${separator}`;
                }
                const current = k === shown.length - 1;
                return `${sep}<button type="button" class="fb-crumb" data-act="crumb"
                        data-path="${this.esc(segment.path)}" ${current ? 'aria-current="page"' : ''}
                        dir="ltr">${this.esc(segment.label)}</button>`;
            }).join('') + `<button type="button" class="fb-icon fb-crumb-edit" data-act="edit-path"
                    aria-label="${this.esc(this.t('fb.editPath', 'Edit path'))}"
                    title="${this.esc(this.t('fb.editPath', 'Edit path'))}">${this.icon('pencil')}</button>`;
        }

        files() {
            const s = this.state;
            const query = this.filter.trim().toLowerCase();
            return s.files.filter(file => (this.showHidden || !file.name.startsWith('.'))
                && (!query || file.name.toLowerCase().includes(query)));
        }

        sorted(files) {
            const { key, dir } = this.sort;
            const value = {
                name: f => f.name,
                size: f => (this.isDir(f) ? -1 : (f.size ?? -1)),
                modified: f => f.modified ?? 0,
                perm: f => (f.mode ?? 0) & 0o7777,
                owner: f => f.owner || '',
            }[key];
            return files.slice().sort((a, b) => {
                // Folders first, whichever way the column runs. [INF-FILES-6]
                const folders = Number(this.isDir(b)) - Number(this.isDir(a));
                if (folders) return folders;
                const va = value(a);
                const vb = value(b);
                const order = typeof va === 'string' ? collator.compare(va, vb) : va - vb;
                return (order || collator.compare(a.name, b.name)) * dir;
            });
        }

        /*
         * A refresh of the directory on screen keeps its rows while the listing
         * is in flight. Blanking them collapses the list's height, which drops
         * the scroll position to the top after every delete in a long folder.
         * A navigation still clears them: this browser's own (the flag -- the
         * manager renders before it records pendingPath) and any other (its
         * pendingPath is another path).
         */
        isRefreshing() {
            const s = this.state;
            return !!s.loading && !this.navigating && s.pendingPath === s.path
                && this.shown.session === s.sessionId && this.shown.path === s.path;
        }

        rebuildView() {
            const s = this.state;
            const blank = s.error || (s.loading && !this.isRefreshing());
            const rows = [];
            if ((s.path || '/') !== '/' && !this.filter.trim() && s.type && !s.error) {
                rows.push({ parent: true, name: '..' });
            }
            if (this.editing && this.editing.kind !== 'rename') rows.push({ draft: true, name: '' });
            rows.push(...this.sorted(blank ? [] : this.files()));
            this.view = rows;
            // What a create, a rename or Up lands on is focused and scrolled to.
            let reveal = -1;
            if (this.pendingFocusName) {
                reveal = rows.findIndex(row => !row.parent && !row.draft && row.name === this.pendingFocusName);
                if (reveal >= 0) {
                    this.focusIndex = reveal;
                    this.pendingFocusName = null;
                }
            }
            this.focusIndex = Math.max(0, Math.min(this.focusIndex, rows.length - 1));
            this.renderState();
            this.renderRows(true);
            if (this.editing) this.ensureVisible(this.editIndex());
            else if (reveal >= 0) this.ensureVisible(reveal);
            this.syncSelection();
        }

        renderState() {
            const s = this.state;
            const box = this.el('fbState');
            const refreshing = this.isRefreshing();
            this.el('fbList').setAttribute('aria-busy', String(!!s.loading));
            let html = '';
            if (s.loading && !refreshing) {
                html = `<div class="fm-loading-spinner"></div><span>${this.esc(this.t('fm.loading', 'Loading...'))}</span>`;
            } else if (s.error) {
                html = `${this.icon('circle-alert', 'fb-state-icon')}
                    <span class="fb-state-text">${this.esc(s.error)}</span>
                    <button type="button" class="fb-btn" data-act="refresh">${this.icon('refresh-cw')}<span>${this.esc(this.t('fm.retry', 'Retry'))}</span></button>`;
            } else if (!s.type) {
                html = `<span class="fb-state-text">${this.esc(this.t('fm.noActiveConnection', 'No active connection'))}</span>`;
            } else if (!this.view.some(row => !row.parent && !row.draft)) {
                html = this.filter.trim()
                    ? `<span class="fb-state-text">${this.esc(this.fmt('fb.noMatch', 'Nothing matches “{query}”', { query: this.filter.trim() }))}</span>`
                    : `${this.icon('folder-open', 'fb-state-icon')}<span class="fb-state-text">${this.esc(this.t('fm.emptyDirectory', 'Empty directory'))}</span>`;
            }
            box.hidden = !html || this.view.some(row => row.draft);
            box.innerHTML = html;
        }

        editIndex() {
            if (!this.editing) return -1;
            return this.editing.kind === 'rename'
                ? this.view.findIndex(row => !row.parent && !row.draft && row.name === this.editing.name)
                : this.view.findIndex(row => row.draft);
        }

        clearRows() {
            this.rowEls.forEach(element => element.remove());
            this.rowEls.clear();
        }

        /*
         * Only the rows near the scroll position exist [INF-FILES-15]: a
         * directory of a few thousand entries is a few dozen rows of DOM. Rows
         * are keyed by index and kept while in range, so the row being edited
         * keeps its input -- and its focus -- while the list scrolls.
         */
        renderRows(rebuild = false) {
            if (!this.expanded) return;
            const list = this.el('fbList');
            const sizer = this.el('fbSizer');
            const height = this.rowHeight();
            const editIndex = this.editIndex();
            list.style.setProperty('--fb-n', this.view.length);
            const first = Math.max(0, Math.floor(list.scrollTop / height) - OVERSCAN_ROWS);
            const last = Math.min(this.view.length,
                Math.ceil((list.scrollTop + (list.clientHeight || 800)) / height) + OVERSCAN_ROWS);
            const wanted = new Set();
            for (let k = first; k < last; k++) wanted.add(k);
            if (editIndex >= 0) wanted.add(editIndex);

            const editing = list.querySelector('.fb-edit') === document.activeElement;
            this.rebuilding = true;
            for (const [index, element] of this.rowEls) {
                if (rebuild || !wanted.has(index)) {
                    element.remove();
                    this.rowEls.delete(index);
                }
            }
            const template = document.createElement('template');
            for (const index of wanted) {
                if (this.rowEls.has(index)) continue;
                template.innerHTML = this.rowHtml(this.view[index], index).trim();
                const element = template.content.firstElementChild;
                sizer.appendChild(element);
                this.rowEls.set(index, element);
            }
            this.rebuilding = false;
            this.rowEls.forEach((element, index) => this.paintRow(element, index));
            if (editIndex >= 0 && (editing || rebuild)) this.focusEditor();
        }

        rowHtml(row, index) {
            const cells = (check, name, size = '', modified = '', perm = '', owner = '', more = '') => `
                <div class="fb-row${row.parent ? ' fb-parent' : ''}${row.draft ? ' fb-draft' : ''}"
                     role="row" id="fb-r-${index}" data-i="${index}" style="--i:${index}"
                     aria-rowindex="${index + 1}">
                    <span class="fb-c-check" role="gridcell">${check}</span>
                    <span class="fb-c-name" role="gridcell">${name}</span>
                    <span class="fb-c-size" role="gridcell">${size}</span>
                    <span class="fb-c-mod" role="gridcell">${modified}</span>
                    <span class="fb-c-perm" role="gridcell">${perm}</span>
                    <span class="fb-c-owner" role="gridcell">${owner}</span>
                    <span class="fb-c-more" role="gridcell">${more}</span>
                </div>`;
            const nameBlock = (glyph, line, meta) => `${glyph}<span class="fb-name-wrap">
                    <span class="fb-name-line">${line}</span><span class="fb-meta">${meta}</span></span>`;

            if (row.parent) {
                return cells('', nameBlock(this.icon('arrow-up', 'fb-glyph fb-up'),
                    '<span class="fb-name">..</span>',
                    this.esc(this.t('fm.parentDirectory', 'Parent directory'))));
            }
            if (row.draft) {
                const dir = this.editing?.kind === 'dir';
                return cells('', nameBlock(this.icon(dir ? 'folder' : 'file', `fb-glyph${dir ? ' fb-dir' : ''}`),
                    this.editorHtml(dir ? this.t('fb.newFolderName', 'Folder name') : this.t('fb.newFileName', 'File name')), ''));
            }

            const dir = this.isDir(row);
            const glyph = dir ? 'folder' : this.fm.getFileIcon(row.name);
            const date = this.formatDate(row.modified);
            const perm = this.permString(row.mode);
            const size = dir ? '—' : (row.size === null || row.size === undefined ? '—' : this.fm.formatSize(row.size));
            const link = row.is_symlink ? `<span class="fb-symlink${row.broken ? ' is-broken' : ''}"
                    title="${this.esc(row.broken ? this.t('fb.linkBroken', 'Broken link') : this.fmt('fb.linksTo', 'Links to {target}', { target: row.link_target ?? '?' }))}">${this.icon('link')}<span dir="ltr">${this.esc(row.link_target ?? '')}</span></span>` : '';
            const renaming = this.editing?.kind === 'rename' && this.editing.name === row.name;
            const line = renaming
                ? this.editorHtml(this.t('fm.rename', 'Rename'))
                : `<span class="fb-name">${this.esc(row.name)}</span>${link}`;
            const meta = [dir ? this.t('fm.folder', 'Folder') : size, date.short, perm.slice(1)].filter(Boolean).join(' · ');
            const label = this.esc(this.fmt('fb.selectItem', 'Select {name}', { name: row.name }));
            return cells(
                `<input type="checkbox" class="fb-check" tabindex="-1" aria-label="${label}">`,
                nameBlock(this.icon(glyph, `fb-glyph${dir ? ' fb-dir' : ''}`), line, this.esc(meta)),
                this.esc(size),
                `<span title="${this.esc(date.full)}">${this.esc(date.short)}</span>`,
                `<span title="${this.esc(((row.mode ?? 0) & 0o7777).toString(8).padStart(4, '0'))}">${this.esc(perm)}</span>`,
                this.esc(row.owner || ''),
                `<button type="button" class="fb-more" tabindex="-1"
                         aria-label="${this.esc(this.t('fm.moreActions', 'More actions'))}">${this.icon('ellipsis-vertical')}</button>`);
        }

        editorHtml(label) {
            return `<input type="text" class="fb-edit" value="${this.esc(this.editing?.value ?? '')}"
                    aria-label="${this.esc(label)}" placeholder="${this.esc(label)}"
                    autocapitalize="off" autocorrect="off" spellcheck="false">
                <span class="fb-edit-error" role="alert"></span>`;
        }

        paintRow(element, index) {
            const row = this.view[index];
            const selected = !!row && !row.parent && !row.draft && this.selected.has(row.name);
            element.classList.toggle('is-sel', selected);
            element.classList.toggle('is-focus', index === this.focusIndex);
            element.classList.toggle('is-hidden', !!row && !row.parent && row.name.startsWith('.'));
            element.setAttribute('aria-selected', String(selected));
            const check = element.querySelector('.fb-check');
            if (check) check.checked = selected;
        }

        selectableNames() {
            return this.view.filter(row => !row.parent && !row.draft).map(row => row.name);
        }

        selectedFiles() {
            return this.state.files.filter(file => this.selected.has(file.name));
        }

        syncSelection() {
            if (!this.expanded) return;
            this.rowEls.forEach((element, index) => this.paintRow(element, index));
            const list = this.el('fbList');
            const focused = this.rowEls.get(this.focusIndex);
            if (focused) list.setAttribute('aria-activedescendant', focused.id);
            else list.removeAttribute('aria-activedescendant');

            const names = this.selectableNames();
            const count = names.filter(name => this.selected.has(name)).length;
            const all = this.el('fbAll');
            all.checked = names.length > 0 && count === names.length;
            all.indeterminate = count > 0 && count < names.length;

            const files = this.selectedFiles();
            this.root.classList.toggle('fb-has-selection', files.length > 0);
            this.root.querySelectorAll('[data-need]').forEach(button => {
                const need = button.dataset.need;
                button.disabled = need === 'one' ? files.length !== 1 : files.length === 0;
            });
            const bytes = files.reduce((sum, file) => sum + (this.isDir(file) ? 0 : (file.size || 0)), 0);
            const summary = files.length
                ? this.fmt('fb.selectedCount', '{n} selected', { n: files.length })
                    + (bytes ? ` · ${this.fm.formatSize(bytes)}` : '') : '';
            this.el('fbSelSum').textContent = summary;
            this.el('fbSelTitle').textContent = this.fmt('fb.selectedCount', '{n} selected', { n: files.length });

            const s = this.state;
            const total = s.files.length;
            const hiddenOut = this.showHidden ? 0 : s.files.filter(file => file.name.startsWith('.')).length;
            const parts = [this.fmt('fb.itemCount', '{n} items', { n: total })];
            if (hiddenOut) parts.push(this.fmt('fb.hiddenCount', '{n} hidden', { n: hiddenOut }));
            if (this.filter.trim()) parts.push(this.fmt('fb.matchCount', '{n} match', { n: names.length }));
            if (files.length) parts.push(summary);
            this.el('fbCount').textContent = s.type && !s.loading && !s.error ? parts.join(' · ') : '';
        }

        ensureVisible(index) {
            if (index < 0) return;
            const list = this.el('fbList');
            const height = this.rowHeight();
            const top = index * height;
            if (top < list.scrollTop) {
                list.scrollTop = top;
            } else if (top + height > list.scrollTop + list.clientHeight) {
                list.scrollTop = top + height - list.clientHeight;
            }
            this.renderRows();
        }

        // ── navigation ──────────────────────────────────────────────────────
        navigate(path) {
            this.navigating = true;
            this.fm.navigatePaneTo('inline', path);
        }

        go(path) {
            const current = this.state.path || '/';
            if (!path || !this.state.type) return;
            if (path !== current) {
                this.history.back.push(current);
                if (this.history.back.length > HISTORY_LIMIT) this.history.back.shift();
                this.history.forward = [];
            }
            this.navigate(path);
        }

        goBack() {
            const path = this.history.back.pop();
            if (path === undefined) return;
            this.history.forward.push(this.state.path || '/');
            this.navigate(path);
        }

        goForward() {
            const path = this.history.forward.pop();
            if (path === undefined) return;
            this.history.back.push(this.state.path || '/');
            this.navigate(path);
        }

        goUp() {
            const path = this.state.path || '/';
            if (path === '/') return;
            this.pendingFocusName = path.split('/').filter(Boolean).pop() || null;
            this.go(path.split('/').slice(0, -1).join('/') || '/');
        }

        goHome() {
            this.go(this.state.homePath || '/');
        }

        open(index) {
            const row = this.view[index];
            if (!row || row.draft) return;
            if (row.parent) {
                this.goUp();
            } else if (this.isDir(row)) {
                this.go(this.pathOf(row.name));
            } else if (window.FilePreview) {
                window.FilePreview.open(this.sessionId(), this.pathOf(row.name), row.name);
            }
        }

        openPathEdit() {
            const form = this.el('fbPathForm');
            const input = this.el('fbPath');
            input.value = this.state.path || '/';
            form.hidden = false;
            this.el('fbCrumbs').hidden = true;
            input.focus();
            input.select();
        }

        closePathEdit() {
            const form = this.el('fbPathForm');
            if (form.hidden) return;
            form.hidden = true;
            this.el('fbCrumbs').hidden = false;
        }

        // ── selection ───────────────────────────────────────────────────────
        selectOnly(index) {
            const row = this.view[index];
            if (!row || row.parent || row.draft) return;
            this.selected = new Set([row.name]);
            this.anchor = row.name;
        }

        toggle(index) {
            const row = this.view[index];
            if (!row || row.parent || row.draft) return;
            if (this.selected.has(row.name)) this.selected.delete(row.name);
            else this.selected.add(row.name);
            this.anchor = row.name;
        }

        selectRange(index) {
            const from = this.view.findIndex(row => row.name === this.anchor && !row.parent);
            const start = from < 0 ? index : from;
            const [a, b] = start < index ? [start, index] : [index, start];
            this.selected = new Set(this.view.slice(a, b + 1)
                .filter(row => !row.parent && !row.draft).map(row => row.name));
        }

        setFocus(index) {
            this.focusIndex = Math.max(0, Math.min(index, this.view.length - 1));
            this.ensureVisible(this.focusIndex);
        }

        startSelecting(index) {
            this.selecting = true;
            this.root.classList.add('fb-selecting');
            if (index !== undefined) {
                const row = this.view[index];
                if (row && !row.parent && !row.draft) this.selected.add(row.name);
            }
            this.syncSelection();
        }

        endSelecting() {
            this.selecting = false;
            this.root.classList.remove('fb-selecting');
            this.selected.clear();
            this.syncSelection();
        }

        // ── pointer ─────────────────────────────────────────────────────────
        rowIndexOf(target) {
            const row = target.closest('.fb-row');
            return row ? Number(row.dataset.i) : -1;
        }

        onPointerDown(e) {
            this.pointer = e.pointerType || 'mouse';
            if (this.press?.timer) clearTimeout(this.press.timer);
            this.press = null;
            const index = this.rowIndexOf(e.target);
            const row = this.view[index];
            if (!this.isTouch() || !row || row.parent || row.draft || e.target.closest('.fb-edit')) return;
            this.press = {
                x: e.clientX,
                y: e.clientY,
                fired: false,
                timer: setTimeout(() => {
                    this.press.fired = true;
                    this.startSelecting(index);
                }, LONG_PRESS_MS),
            };
        }

        onPointerMove(e) {
            if (this.press && !this.press.fired
                    && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > MOVE_TOLERANCE_PX) {
                this.clearPress();
            }
        }

        clearPress() {
            if (this.press?.timer) clearTimeout(this.press.timer);
            if (this.press && !this.press.fired) this.press = null;
        }

        onRowClick(e) {
            const index = this.rowIndexOf(e.target);
            if (index < 0 || e.target.closest('.fb-edit')) return;
            if (this.press?.fired) {           // the hold already acted
                this.press = null;
                e.preventDefault();
                return;
            }
            const row = this.view[index];
            if (e.target.closest('.fb-more')) {
                this.openRowMenu(e, index, e.target.closest('.fb-more'));
                return;
            }
            if (e.target.closest('.fb-c-check') && !row.parent && !row.draft) {
                this.toggle(index);
                this.focusIndex = index;
                this.syncSelection();
                return;
            }
            if (this.selecting) {
                if (!row.parent) this.toggle(index);
                this.focusIndex = index;
                this.syncSelection();
                return;
            }
            if (this.isTouch()) {
                this.open(index);
                return;
            }
            if (e.ctrlKey || e.metaKey) this.toggle(index);
            else if (e.shiftKey && this.anchor) this.selectRange(index);
            else this.selectOnly(index);
            this.focusIndex = index;
            this.syncSelection();
        }

        onRowDblClick(e) {
            const index = this.rowIndexOf(e.target);
            if (index < 0 || this.isTouch() || this.selecting
                    || e.target.closest('.fb-more, .fb-c-check, .fb-edit')) return;
            this.open(index);
        }

        onRowContextMenu(e) {
            const index = this.rowIndexOf(e.target);
            const row = this.view[index];
            if (!row || row.parent || row.draft || e.target.closest('.fb-edit')) return;
            if (this.press?.fired) {           // a long press is selection, not a menu
                e.preventDefault();
                return;
            }
            this.openRowMenu(e, index, null);
        }

        // The panel's row menu, for this row (and the selection it belongs to).
        openRowMenu(e, index, anchor) {
            const row = this.view[index];
            if (!row || row.parent || row.draft) return;
            // The ⋮ that opened this row's menu closes it again.
            if (anchor && this.fm.contextMenu && this.rowMenuAnchor === anchor) {
                this.fm.closeContextMenu();
                this.rowMenuAnchor = null;
                return;
            }
            this.rowMenuAnchor = anchor;
            if (!this.selected.has(row.name)) this.selectOnly(index);
            this.focusIndex = index;
            this.syncSelection();
            const s = this.state;
            s.selected = new Set(s.files.flatMap((file, i) => this.selected.has(file.name) ? [i] : []));
            this.fm.activePane = 'inline';
            this.fm.showContextMenu(e, 'inline', s.files.indexOf(row), anchor);
        }

        // Called by the manager's handleContextAction; true when handled here.
        handleMenuAction(action, file) {
            if (action === 'rename' && file) {
                this.startRename(file.name);
            } else if (action === 'delete') {
                this.confirmDelete(this.selectedFiles().length ? this.selectedFiles() : [file].filter(Boolean));
            } else if (action === 'newfolder') {
                this.startCreate('dir');
            } else if (action === 'open' && file) {
                this.open(this.view.indexOf(file));
            } else {
                return false;
            }
            return true;
        }

        // ── menus and actions ───────────────────────────────────────────────
        act(action, button) {
            const s = this.state;
            switch (action) {
                case 'collapse': return this.collapse();
                case 'close': return this.close();
                case 'back': return this.goBack();
                case 'forward': return this.goForward();
                case 'up': return this.goUp();
                case 'home': return this.goHome();
                case 'refresh':
                    if (s.error) s.error = null;
                    return this.fm.refreshPane('inline');
                case 'crumb': return this.go(button.dataset.path);
                case 'crumbs-more':
                    return this.toggleMenu(button, () => this.hiddenCrumbs.map(segment => ({
                        label: segment.path, act: () => this.go(segment.path),
                    })));
                case 'edit-path': return this.openPathEdit();
                case 'toggle-filter': {
                    const open = this.root.classList.toggle('fb-filter-open');
                    if (open) this.el('fbFilter').focus();
                    else this.clearFilter();
                    return undefined;
                }
                case 'menu': return this.toggleMenu(button, () => this.phoneMenuItems());
                case 'hidden': return this.setShowHidden(!this.showHidden);
                case 'sort': return this.setSort(button.dataset.key);
                case 'upload': return this.el('fbUploadInput').click();
                case 'new-dir': return this.startCreate('dir');
                case 'new-file': return this.startCreate('file');
                case 'download': return this.withSelection(() => this.fm.downloadSelected());
                case 'rename': {
                    const [file] = this.selectedFiles();
                    return file ? this.startRename(file.name) : undefined;
                }
                case 'delete': return this.confirmDelete(this.selectedFiles());
                case 'select-all':
                    this.selected = new Set(this.selectableNames());
                    return this.syncSelection();
                case 'end-select': return this.endSelecting();
                default: return undefined;
            }
        }

        phoneMenuItems() {
            const items = [{
                label: this.t('fb.select', 'Select'),
                act: () => this.startSelecting(),
            }, {
                // The toolbar's Refresh has no room on a phone.
                label: this.t('fm.refresh', 'Refresh'),
                act: () => this.act('refresh'),
            }, {
                // The panel's Upload / Download (cloud) control, under the
                // browser while it covers the screen.
                label: this.t('files.uploadDownload', 'Upload / Download'),
                act: () => FileTransferManager.openModal(),
            }, {
                label: this.t('fb.hiddenFiles', 'Hidden files'), checked: this.showHidden,
                act: () => this.setShowHidden(!this.showHidden),
            }];
            [['name', 'fb.colName', 'Name'], ['size', 'fb.colSize', 'Size'], ['modified', 'fb.colModified', 'Modified']]
                .forEach(([key, i18n, fallback]) => items.push({
                    label: `${this.t('fb.sortBy', 'Sort by')}: ${this.t(i18n, fallback)}`
                        + (this.sort.key === key ? (this.sort.dir > 0 ? ' ↑' : ' ↓') : ''),
                    checked: this.sort.key === key,
                    act: () => this.setSort(key),
                }));
            return items;
        }

        // The control that opened a menu closes it again.
        toggleMenu(anchor, items) {
            if (this.menu && this.menuAnchor === anchor) return this.closeMenu();
            return this.showMenu(anchor, items());
        }

        showMenu(anchor, items) {
            this.closeMenu();
            if (!items.length) return;
            const menu = document.createElement('div');
            menu.className = 'fb-menu';
            menu.setAttribute('role', 'menu');
            items.forEach(item => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'fb-menu-item';
                button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
                if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
                button.innerHTML = `<span dir="auto">${this.esc(item.label)}</span>`;
                button.addEventListener('click', () => {
                    this.closeMenu();
                    item.act();
                });
                menu.appendChild(button);
            });
            this.root.appendChild(menu);
            const at = anchor.getBoundingClientRect();
            const box = this.root.getBoundingClientRect();
            menu.style.top = `${Math.round(at.bottom - box.top + 4)}px`;
            menu.style.right = `${Math.max(8, Math.round(box.right - at.right))}px`;
            // As tall as the room under its control; past that the list scrolls.
            // A fixed 60vh cap hid two of the phone menu's seven items in
            // landscape, with nothing to say they were there.
            menu.style.maxHeight = `${Math.round(box.bottom - at.bottom - 12)}px`;
            this.menu = menu;
            this.menuAnchor = anchor;
            menu.querySelector('button')?.focus();
        }

        closeMenu() {
            if (!this.menu) return false;
            this.menu.remove();
            this.menu = null;
            this.menuAnchor?.focus?.({ preventScroll: true });
            this.menuAnchor = null;
            return true;
        }

        setShowHidden(show) {
            this.showHidden = show;
            writeStore(STORE_HIDDEN, show);
            const visible = new Set(this.files().map(file => file.name));
            this.selected = new Set([...this.selected].filter(name => visible.has(name)));
            this.renderHead();
            this.rebuildView();
        }

        setSort(key) {
            if (!SORT_KEYS.includes(key)) return;
            this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: 1 };
            writeStore(STORE_SORT, this.sort);
            this.renderHead();
            this.rebuildView();
        }

        clearFilter() {
            this.filter = '';
            this.el('fbFilter').value = '';
            this.rebuildView();
        }

        // Hand the selection to a manager method that reads the pane's own.
        withSelection(fn) {
            const s = this.state;
            s.selected = new Set(s.files.flatMap((file, index) => this.selected.has(file.name) ? [index] : []));
            if (!s.selected.size) return;
            this.fm.activePane = 'inline';
            fn();
        }

        // ── rename and create, in place ─────────────────────────────────────
        startRename(name) {
            this.closeMenu();
            this.editing = { kind: 'rename', name, value: name, error: null, busy: false };
            this.rebuildView();
        }

        startCreate(kind) {
            if (!this.state.type || this.state.loading) return;
            this.closeMenu();
            this.editing = { kind, value: '', error: null, busy: false };
            this.el('fbList').scrollTop = 0;
            this.rebuildView();
        }

        focusEditor() {
            const input = this.el('fbList').querySelector('.fb-edit');
            if (!input || !this.editing) return;
            input.value = this.editing.value;
            requestAnimationFrame(() => {
                if (!this.editing || !input.isConnected) return;
                input.focus({ preventScroll: true });
                // A rename starts with the name before its extension selected.
                const dot = this.editing.kind === 'rename' ? input.value.lastIndexOf('.') : -1;
                input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
            });
            this.showEditError();
        }

        showEditError() {
            const box = this.el('fbList').querySelector('.fb-edit-error');
            if (box) box.textContent = this.editing?.error || '';
            this.el('fbList').querySelector('.fb-edit')
                ?.setAttribute('aria-invalid', String(!!this.editing?.error));
        }

        validateName(name) {
            if (!name) return this.t('fb.nameRequired', 'Enter a name');
            if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
                return this.t('fb.nameInvalid', 'A name cannot contain “/” or be “.” or “..”');
            }
            const taken = this.state.files.some(file => file.name === name)
                && !(this.editing?.kind === 'rename' && this.editing.name === name);
            return taken ? this.fmt('fb.nameExists', '“{name}” already exists here', { name }) : null;
        }

        async commitEdit() {
            const edit = this.editing;
            if (!edit || edit.busy) return;
            const name = edit.value.trim();
            if (edit.kind === 'rename' && name === edit.name) {
                this.cancelEdit();
                return;
            }
            const error = this.validateName(name);
            if (error) {
                edit.error = error;
                this.showEditError();
                return;
            }
            edit.busy = true;
            const s = this.state;
            const sessionId = this.sessionId();
            const path = this.pathOf(name);
            const reply = edit.kind === 'rename'
                ? await this.request('rename_file', { session_id: sessionId, old_path: this.pathOf(edit.name), new_path: path })
                : await this.request(edit.kind === 'dir' ? 'create_directory' : 'create_file',
                    { session_id: sessionId, remote_path: path });
            const result = reply.results?.[0];
            if (this.editing !== edit) {
                // Cancelled or navigated meanwhile. The server still did it,
                // so a folder still on screen shows the result.
                if (result?.ok && s.path === this.listed.path) this.fm.refreshPane('inline');
                return;
            }
            if (!result?.ok) {
                edit.busy = false;
                edit.error = result?.error || this.t('fb.failed', 'Failed');
                this.showEditError();
                this.focusEditor();
                return;
            }
            this.editing = null;
            this.selected = new Set([name]);
            this.anchor = name;
            this.pendingFocusName = name;
            this.announce(edit.kind === 'rename'
                ? this.fmt('fb.renamed', 'Renamed to {name}', { name })
                : this.fmt('fb.created', 'Created {name}', { name }));
            if (s.path === this.listed.path) this.fm.refreshPane('inline');
            this.el('fbList').focus({ preventScroll: true });
        }

        cancelEdit() {
            if (!this.editing) return;
            this.editing = null;
            this.rebuildView();
            this.el('fbList').focus({ preventScroll: true });
        }

        // ── delete ──────────────────────────────────────────────────────────
        async confirmDelete(files) {
            if (!files.length || !this.state.type) return;
            this.closeMenu();
            const listed = files.slice(0, DELETE_LISTED).map(file => `<li>${this.icon(
                this.isDir(file) ? 'folder' : this.fm.getFileIcon(file.name),
                this.isDir(file) ? 'fb-dir' : '')}<span dir="auto">${this.esc(file.name)}</span></li>`).join('');
            const more = files.length > DELETE_LISTED
                ? `<li class="fb-dlg-more">${this.esc(this.fmt('fb.andMore', '… and {n} more', { n: files.length - DELETE_LISTED }))}</li>` : '';
            const folders = files.some(file => this.isDir(file) && !file.is_symlink);
            const warning = folders
                ? this.t('fb.deleteWarnFolders', 'Folders are deleted with everything inside. This cannot be undone.')
                : this.t('fb.deleteWarn', 'This cannot be undone.');
            const confirmed = await this.openDialog({
                title: files.length === 1
                    ? this.fmt('fb.deleteOne', 'Delete “{name}”?', { name: files[0].name })
                    : this.fmt('fb.deleteMany', 'Delete {n} items?', { n: files.length }),
                body: `<ul class="fb-dlg-list">${listed}${more}</ul>
                    <p class="fb-dlg-warn">${this.icon('circle-alert')}<span>${this.esc(warning)}</span></p>`,
                actions: [
                    { id: 'cancel', label: this.t('common.cancel', 'Cancel'), initial: true },
                    { id: 'delete', label: files.length === 1 ? this.t('fm.delete', 'Delete')
                        : this.fmt('fb.deleteCount', 'Delete {n} items', { n: files.length }), danger: true, icon: 'trash-2' },
                ],
            });
            if (confirmed !== 'delete') return;
            const reply = await this.request('delete_items', {
                session_id: this.sessionId(),
                paths: files.map(file => this.pathOf(file.name)),
            });
            const results = reply.results || [];
            const failed = results.filter(result => !result.ok);
            const done = results.length - failed.length;
            // What failed stays selected, so it can be tried again.
            const failedNames = new Set(failed.map(result => result.path?.split('/').pop()).filter(Boolean));
            this.selected = new Set(files.map(file => file.name).filter(name => failedNames.has(name)));
            const message = failed.length
                ? `${this.fmt('fb.deletedSome', 'Deleted {n}', { n: done })} · ${this.fmt('fb.failedCount', '{n} failed', { n: failed.length })}: ${failed[0].error}`
                : this.fmt('fb.deletedSome', 'Deleted {n}', { n: done });
            this.fm.showNotification(message, failed.length ? 'error' : 'success');
            this.announce(message);
            this.fm.refreshPane('inline');
        }

        // ── dialog ──────────────────────────────────────────────────────────
        openDialog({ title, body, actions }) {
            this.closeDialog(null);
            const backdrop = document.createElement('div');
            backdrop.className = 'fb-dialog-backdrop';
            backdrop.innerHTML = `
                <div class="fb-dialog" role="dialog" aria-modal="true" aria-labelledby="fbDialogTitle">
                    <h3 class="fb-dialog-title" id="fbDialogTitle" dir="auto">${this.esc(title)}</h3>
                    <div class="fb-dialog-body">${body}</div>
                    <div class="fb-dialog-actions">${actions.map(action => `
                        <button type="button" class="fb-btn${action.danger ? ' fb-danger-fill' : ''}"
                                data-dialog="${action.id}">${action.icon ? this.icon(action.icon) : ''}<span>${this.esc(action.label)}</span></button>`).join('')}
                    </div>
                </div>`;
            this.root.appendChild(backdrop);
            return new Promise((resolve) => {
                this.dialog = { element: backdrop, resolve, returnFocus: document.activeElement };
                backdrop.addEventListener('click', (e) => {
                    const button = e.target.closest('[data-dialog]');
                    if (button) this.closeDialog(button.dataset.dialog);
                    else if (e.target === backdrop) this.closeDialog(null);
                });
                backdrop.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        this.closeDialog(null);
                    } else if (e.key === 'Tab') {
                        const buttons = [...backdrop.querySelectorAll('button')];
                        const at = buttons.indexOf(document.activeElement);
                        const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
                        e.preventDefault();
                        buttons[next].focus();
                    }
                });
                const initial = actions.findIndex(action => action.initial);
                backdrop.querySelectorAll('[data-dialog]')[Math.max(0, initial)].focus();
            });
        }

        closeDialog(result) {
            const dialog = this.dialog;
            if (!dialog) return;
            this.dialog = null;
            dialog.element.remove();
            dialog.resolve(result);
            if (this.expanded) dialog.returnFocus?.focus?.({ preventScroll: true });
        }

        announce(message) {
            const live = this.el('fbLive');
            if (live) live.textContent = message;
        }

        // ── keyboard ────────────────────────────────────────────────────────
        onKey(e) {
            if (!this.expanded || this.dialog) return;
            const target = e.target;
            const mod = e.ctrlKey || e.metaKey;
            const handled = () => {
                e.preventDefault();
                e.stopPropagation();
            };

            if (target.matches('.fb-edit')) {
                if (e.key === 'Enter') { handled(); this.commitEdit(); }
                else if (e.key === 'Escape') { handled(); this.cancelEdit(); }
                return;
            }
            if (target.matches('#fbPath')) {
                if (e.key === 'Escape') {
                    handled();
                    this.closePathEdit();
                    this.el('fbList').focus({ preventScroll: true });
                }
                return;
            }
            if (target.matches('#fbFilter')) {
                if (e.key === 'Escape') {
                    handled();
                    if (this.filter) this.clearFilter();
                    else this.root.classList.remove('fb-filter-open');
                    this.el('fbList').focus({ preventScroll: true });
                } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                    handled();
                    this.el('fbList').focus({ preventScroll: true });
                }
                return;
            }

            if (e.key === 'Escape') {
                handled();
                this.escapeStep();
                return;
            }
            if (target.closest('.fb-menu')) return;
            if (mod && e.key.toLowerCase() === 'f' || (!mod && e.key === '/')) {
                handled();
                this.root.classList.add('fb-filter-open');
                this.el('fbFilter').focus();
                return;
            }
            if (mod && e.key.toLowerCase() === 'l') {
                handled();
                this.openPathEdit();
                return;
            }
            if (!target.closest('.fb-list')) return;

            const page = Math.max(1, Math.floor(this.el('fbList').clientHeight / this.rowHeight()) - 1);
            const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
            if (e.key in moves && !e.altKey) {
                handled();
                this.moveFocus(this.focusIndex + moves[e.key], e);
            } else if (e.key === 'Home' || e.key === 'End') {
                handled();
                this.moveFocus(e.key === 'Home' ? 0 : this.view.length - 1, e);
            } else if (e.key === ' ') {
                handled();
                this.toggle(this.focusIndex);
                this.syncSelection();
            } else if (e.key === 'Enter') {
                handled();
                this.open(this.focusIndex);
            } else if ((e.key === 'Backspace' && !mod) || (e.altKey && e.key === 'ArrowUp')) {
                handled();
                this.goUp();
            } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                handled();
                if (e.key === 'ArrowLeft') this.goBack();
                else this.goForward();
            } else if (mod && e.key.toLowerCase() === 'a') {
                handled();
                this.selected = new Set(this.selectableNames());
                this.syncSelection();
            } else if (e.key === 'F2') {
                handled();
                const row = this.view[this.focusIndex];
                const [only] = this.selectedFiles().length === 1 ? this.selectedFiles() : [];
                const name = only?.name || (row && !row.parent && !row.draft ? row.name : null);
                if (name) this.startRename(name);
            } else if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
                handled();
                const row = this.view[this.focusIndex];
                const files = this.selectedFiles();
                this.confirmDelete(files.length ? files
                    : (row && !row.parent && !row.draft ? [row] : []));
            } else if (e.key.length === 1 && !mod && !e.altKey) {
                handled();
                this.typeAhead(e.key);
            }
        }

        // One step back, in order: a dialog or menu, an edit, the filter, the
        // selection, then the browser itself [INF-FILES-4].
        escapeStep() {
            if (this.dialog) this.closeDialog(null);
            else if (this.fm.contextMenu) this.fm.closeContextMenu();
            else if (this.closeMenu()) { /* closed */ }
            else if (this.editing) this.cancelEdit();
            else if (this.filter) this.clearFilter();
            else if (this.isFullScreen() && this.root.classList.contains('fb-filter-open')) {
                this.root.classList.remove('fb-filter-open');    // the phone's filter bar
            }
            else if (this.selecting) this.endSelecting();
            else if (this.selected.size) { this.selected.clear(); this.syncSelection(); }
            else this.collapse();
        }

        /*
         * Back -- a phone's, or the browser's own -- takes the same steps as
         * Escape [INF-FILES-4]. While it is open the browser holds one history
         * entry; Back spends it on one step and takes another if still open.
         * Closed any other way, it gives the entry back, so the next Back is
         * the page's own again.
         */
        armBack() {
            if (this.backArmed) return;
            history.pushState({ filesBrowser: true }, '');
            this.backArmed = true;
        }

        releaseBack() {
            if (!this.backArmed) return;
            this.backArmed = false;
            if (history.state?.filesBrowser) {
                this.skipPop = true;
                history.back();
            }
        }

        onPopState() {
            if (this.skipPop) {
                this.skipPop = false;
                return;
            }
            if (!this.backArmed) return;
            this.backArmed = false;           // Back spent the entry
            if (!this.expanded) return;
            this.escapeStep();
            if (this.expanded) this.armBack();
        }

        moveFocus(index, e) {
            this.setFocus(index);
            const row = this.view[this.focusIndex];
            if (row && !row.parent && !row.draft) {
                if (e.shiftKey) this.selectRange(this.focusIndex);
                else if (!e.ctrlKey && !e.metaKey && !this.selecting) this.selectOnly(this.focusIndex);
            }
            this.syncSelection();
        }

        typeAhead(char) {
            const now = Date.now();
            this.typeahead.text = (now - this.typeahead.at > TYPEAHEAD_MS ? '' : this.typeahead.text) + char.toLowerCase();
            this.typeahead.at = now;
            const text = this.typeahead.text;
            const start = text.length === 1 ? this.focusIndex + 1 : this.focusIndex;
            const order = [...this.view.keys()].map(k => (start + k) % this.view.length);
            const found = order.find(k => !this.view[k].parent && !this.view[k].draft
                && this.view[k].name.toLowerCase().startsWith(text));
            if (found !== undefined) this.moveFocus(found, { shiftKey: false, ctrlKey: false, metaKey: false });
        }
    }

    window.FilesBrowser = FilesBrowser;
})();
