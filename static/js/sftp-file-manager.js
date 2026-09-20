
class SFTPFileManager {
    constructor() {
        this.socket = window.socket;
        this.modal = null;
        this.isOpen = false;

        this.browserFS = new BrowserFileSystem();

        this.panes = {
            left: this.createEmptyPaneState(),
            right: this.createEmptyPaneState()
        };
        this.activePane = 'left';

        this.availableSessions = [];
        this.quickConnections = [];

        this.transferQueue = [];
        this.activeTransfers = new Map();
        this.isTransferring = false;
        // transfer_id -> { at, events: [{kind, data}] } for events that arrived
        // before their row existed. Bounded by per-id TTL and a global id cap.
        // See bufferEarlyS2SEvent.
        this.earlyS2SEvents = new Map();

        // Buffer bounds. Instance fields so tests can shrink
        // them without touching the product values.
        this.MAX_EARLY_IDS = 32;           // distinct transfer_ids held at once
        this.MAX_EARLY_EVENTS_PER_ID = 64; // events per id, terminal included

        /*
         * THE TTL IS DERIVED FROM THE ACK DEADLINE, and is declared exactly
         * once.
         *
         * An entry only exists while its row does not, and the row appears when the
         * server's ack returns. emitWithAck gives that ack a deadline
         * (EARLY_ACK_TIMEOUT_MS); once it passes, the ack is not coming and the
         * entry can never drain. So the buffer's lifetime is the ack deadline plus
         * one ack round-trip of margin — enough that a reply arriving right at the
         * deadline still finds its events, and no longer.
         *
         * A standalone `EARLY_TTL_MS = 60000` used to be assigned here first and
         * then overwritten by this derivation two lines later: dead code, and worse,
         * it left the two numbers free to drift (60s vs 15s meant a dead transfer's
         * events sat for another 45 seconds with nothing able to drain them). One
         * assignment, one source of truth.
         *
         * Tests shrink EARLY_ACK_TIMEOUT_MS or EARLY_TTL_MS on the instance rather
         * than faking time.
         */
        this.EARLY_ACK_TIMEOUT_MS = 15000;
        this.EARLY_TTL_MS = this.EARLY_ACK_TIMEOUT_MS + 5000;

        /*
         * BATCH EPOCH.
         *
         * executeTransfer is an async loop that captured `source` and `target`
         * pane OBJECTS and derived every path from them. resetTransferSurfaceState
         * replaces panes.left/right with FRESH objects, so a reopen mid-batch left
         * the still-running loop copying from the old host into the old
         * destination path while the visible surface showed neither, and its rows
         * had already been cleared — a hidden continuation the user could no
         * longer see or cancel.
         *
         * The epoch is the fence. Every batch captures the value at entry and
         * re-checks it before each item; a reset bumps it, so the old loop stops
         * at the next boundary instead of running against stale state.
         */
        this.batchEpoch = 0;
        this.activeBatch = null;

        this.conflictAction = null;
        this.applyToAll = false;

        this.contextMenu = null;

        this.draggedItems = [];
        this.dragSource = null;

        this.init();
    }

    createEmptyPaneState() {
        return {
            type: null,
            sessionId: null,
            connectionId: null,
            path: '/',
            files: [],
            selected: new Set(),
            lastSelected: -1,
            hostInfo: null,
            loading: false,
            loadingTimeout: null,
            refreshOnOpen: false,
            /*
             * THE PATH THIS PANE LAST ASKED FOR — the correlation key for
             * directory_listing, which is otherwise applied on session id alone.
             *
             * A pane routinely has two listings in flight: onSourceChange emits
             * one for '/' while the caller immediately navigates somewhere else.
             * The server answers each request independently and echoes the
             * requested path verbatim (socket_events.py:1345), so the two
             * replies can arrive in EITHER order. Measured on the live
             * deployment: the '/' reply landed 11 ms after the reply for the
             * requested directory, so the handler overwrote the correct listing
             * with the stale root one and the pane sat on '/' forever.
             *
             * This field is intent, not in-flight bookkeeping: it is NOT
             * cleared when a reply matches, because a reply that arrives late
             * must stay ignorable for as long as the pane wants a different
             * directory. It is also what tells the home_directory auto-landing
             * whether anyone has asked for a specific directory yet.
             */
            pendingPath: null,
            error: null
        };
    }

    /*
     * The single place a pane requests a listing. Recording the intent and
     * emitting in one call is what makes the correlation guard reliable: an
     * emit site that forgot to set pendingPath would leave its pane unable to
     * accept any reply at all.
     */
    requestPaneListing(pane, sessionId, path) {
        const state = this.panes[pane];
        if (state) state.pendingPath = path;
        this.socket.emit('list_directory',
            this.remoteFilesystemPayload(pane, sessionId, { remote_path: path }));
    }


    spriteIcon(name, classes = '') {
        const className = ['icon', classes].filter(Boolean).join(' ');
        return `<svg class="${className}" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-${name}"></use></svg>`;
    }

    init() {
        this.createModal();
        this.setupSocketListeners();
        this.setupKeyboardShortcuts();

        // Rebind inline SFTP pane when active SSH connection changes.
        document.addEventListener('sshdeck:active-session-changed', (e) => {
            this.handleActiveSessionChanged(e.detail?.sessionId);
        });

        /*
         * Every other manager re-renders on languageChanged (session-manager.js:52,
         * profile-manager.js:55, command-set-manager.js:29); this one did not, so
         * switching locale left all three SFTP surfaces in the old language until
         * A reload. The row bodies are built by renderPane from t calls rather
         * than data-i18n attributes, so the walk alone is not enough -- the
         * populated panes have to be re-rendered too.
         */
        window.addEventListener('languageChanged', () => {
            this.applyTranslations();
            Object.keys(this.panes).forEach(pane => {
                if (this.panes[pane].type) {
                    this.updatePaneBadge(pane);
                    this.renderPane(pane);
                }
            });
        });
    }

    createModal() {
        const modal = document.createElement('div');
        modal.id = 'sftpFileManager';
        modal.className = 'modal modal-xlarge modal-shell';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'fmModalTitle');
        modal.setAttribute('aria-hidden', 'true');
        modal.innerHTML = `
            <div class="modal-content fm-modal-fullwidth">
                <div class="modal-header">
                    <!-- The GLOBAL surface is "File Transfer" / "Truyền tệp".
                         It read "File Manager" — the name of the per-session
                         inline browser — so the two features shared one name and
                         neither said what it did. Owner ruling, Entry 40. -->
                    <h2 id="fmModalTitle"><svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-right-left"></use></svg> <span data-i18n="fm.title">File Transfer</span></h2>
                    <span class="close" id="fmClose" aria-label="Close" data-i18n-aria-label="common.close">&times;</span>
                </div>
                <div class="modal-body">
                    <!-- Toolbar -->
                    <div class="fm-toolbar">
                        <div class="fm-toolbar-left">
                            <button class="btn btn-secondary btn-sm" id="fmRefresh" data-i18n-title="fm.refresh">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-refresh-cw"></use></svg>
                            </button>
                            <button class="btn btn-secondary btn-sm" id="fmNewFolder" data-i18n-title="fm.newFolder">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-plus"></use></svg>
                                <span class="btn-text" data-i18n="fm.newFolder">New Folder</span>
                            </button>
                        </div>
                        <div class="fm-toolbar-center">
                            <button class="btn btn-primary btn-sm" id="fmTransfer" data-i18n-title="fm.transfer">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-right-left"></use></svg>
                                <span class="btn-text" data-i18n="fm.transfer">Transfer</span>
                            </button>
                        </div>
                        <div class="fm-toolbar-right">
                            <button class="btn btn-secondary btn-sm" id="fmDownload" data-i18n-title="fm.download">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-download"></use></svg>
                            </button>
                            <button class="btn btn-secondary btn-sm" id="fmRename" data-i18n-title="fm.rename">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-pencil"></use></svg>
                            </button>
                            <button class="btn btn-danger btn-sm" id="fmDelete" data-i18n-title="fm.delete">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-trash-2"></use></svg>
                            </button>
                        </div>
                    </div>

                    <!-- Pane switcher. In server-to-server transfer mode on a
                         phone these are the Source/Destination selector, so they
                         say which END of the transfer they select rather than
                         which SIDE of a layout the user cannot see (owner ruling
                         2026-08-10, Entry 40). Untranslated "Left"/"Right" was
                         also the only untranslated text on this surface. -->
                    <div class="fm-pane-tabs" id="fmPaneTabs" role="tablist"
                         data-i18n-aria-label="fm.paneSwitcher"
                         aria-label="Transfer ends">
                        <button class="fm-pane-tab active" data-pane="left" type="button"
                                role="tab" id="fmPaneTabLeft"
                                aria-selected="true" aria-controls="fmLeftPane"
                                tabindex="0">
                            <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder"></use></svg> <span data-i18n="fm.sourcePane">Source</span>
                        </button>
                        <button class="fm-pane-tab" data-pane="right" type="button"
                                role="tab" id="fmPaneTabRight"
                                aria-selected="false" aria-controls="fmRightPane"
                                tabindex="-1">
                            <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder"></use></svg> <span data-i18n="fm.destinationPane">Destination</span>
                        </button>
                    </div>

                    <!-- Dual Pane -->
                    <div class="fm-panes">
                        <!-- Left Pane -->
                        <div class="fm-pane active" id="fmLeftPane" data-pane="left">
                            <div class="fm-pane-header">
                                <select class="fm-source-select form-control" id="fmLeftSource">
                                    <option value="" data-i18n="fm.selectSource">-- Select Source --</option>
                                    <optgroup data-i18n-label="fm.sshSessions" label="SSH Sessions" id="fmLeftSessions"></optgroup>
                                    <option value="quick-connect" data-i18n="fm.newConnection">+ New Connection...</option>
                                </select>
                            </div>
                            <!-- P3 / mockup line 182: a file panel states
                                 WHICH host and WHICH directory before anything
                                 else ("Tệp · tiny" over "/opt/sshdeck"), and
                                 carries its own upload / new-folder actions
                                 (.tw5-file-actions, spec line 300). The app had
                                 the host in a badge at the pane FOOTER, below
                                 the file list -- so on a scrolled pane the one
                                 label saying which machine you are deleting from
                                 was off screen. The editable path input stays in
                                 the nav row below: the mockup's <small> is a
                                 read-out, and losing type-to-navigate would be a
                                 functional regression. -->
                            <div class="fm-panel-head">
                                <div>
                                    <strong class="fm-panel-title" id="fmLeftTitle" data-i18n="fm.filesTitle">Files</strong>
                                    <small class="fm-panel-path" id="fmLeftHeadPath"></small>
                                </div>
                            </div>
                            <div class="fm-file-actions">
                                <button class="btn btn-secondary fm-upload-btn" id="fmLeftUpload" data-i18n-title="fm.upload">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-upload"></use></svg>
                                    <span data-i18n="fm.upload">Upload</span>
                                </button>
                                <button class="btn btn-secondary fm-icon-action" id="fmLeftNewFolder" data-i18n-title="fm.newFolder" data-i18n-aria-label="fm.newFolder" aria-label="New Folder">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-plus"></use></svg>
                                </button>
                            </div>
                            <div class="fm-pane-nav">
                                <button class="fm-nav-btn" id="fmLeftUp" data-i18n-title="fm.goUp">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-up"></use></svg>
                                </button>
                                <button class="fm-nav-btn" id="fmLeftHome" data-i18n-title="fm.goHome">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-house"></use></svg>
                                </button>
                                <div class="fm-breadcrumb" id="fmLeftBreadcrumb">
                                    <input type="text" class="fm-path-input" id="fmLeftPath" value="/" placeholder="/path">
                                </div>
                                <button class="fm-nav-btn" id="fmLeftRefresh" data-i18n-title="fm.refresh">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-refresh-cw"></use></svg>
                                </button>
                            </div>
                            <div class="fm-file-list" id="fmLeftList">
                                <div class="fm-empty">
                                    <svg class="icon fm-empty-icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-open"></use></svg>
                                    <div class="fm-empty-text" data-i18n="fm.selectSourceAbove">Select a source above</div>
                                </div>
                            </div>
                            <div class="fm-pane-footer">
                                <span class="fm-host-badge" id="fmLeftBadge"></span>
                                <div class="fm-pane-status">
                                    <span id="fmLeftCount">0 items</span>
                                    <span id="fmLeftSelected"></span>
                                </div>
                            </div>
                        </div>

                        <!-- Right Pane -->
                        <div class="fm-pane" id="fmRightPane" data-pane="right">
                            <div class="fm-pane-header">
                                <select class="fm-source-select form-control" id="fmRightSource">
                                    <!-- DESTINATION, not "Source". Both selectors read
                                         "-- Select Source --", which made the two ends of a
                                         server-to-server transfer ambiguous: the pane that
                                         receives the files asked the user to pick a source.
                                         Visual review 2026-08-10. -->
                                    <option value="" data-i18n="fm.selectDestination">-- Select Destination --</option>
                                    <optgroup data-i18n-label="fm.sshSessions" label="SSH Sessions" id="fmRightSessions"></optgroup>
                                    <option value="quick-connect" data-i18n="fm.newConnection">+ New Connection...</option>
                                </select>
                            </div>
                            <!-- P3 / mockup line 182: a file panel states
                                 WHICH host and WHICH directory before anything
                                 else ("Tệp · tiny" over "/opt/sshdeck"), and
                                 carries its own upload / new-folder actions
                                 (.tw5-file-actions, spec line 300). The app had
                                 the host in a badge at the pane FOOTER, below
                                 the file list -- so on a scrolled pane the one
                                 label saying which machine you are deleting from
                                 was off screen. The editable path input stays in
                                 the nav row below: the mockup's <small> is a
                                 read-out, and losing type-to-navigate would be a
                                 functional regression. -->
                            <div class="fm-panel-head">
                                <div>
                                    <strong class="fm-panel-title" id="fmRightTitle" data-i18n="fm.filesTitle">Files</strong>
                                    <small class="fm-panel-path" id="fmRightHeadPath"></small>
                                </div>
                            </div>
                            <div class="fm-file-actions">
                                <button class="btn btn-secondary fm-upload-btn" id="fmRightUpload" data-i18n-title="fm.upload">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-upload"></use></svg>
                                    <span data-i18n="fm.upload">Upload</span>
                                </button>
                                <button class="btn btn-secondary fm-icon-action" id="fmRightNewFolder" data-i18n-title="fm.newFolder" data-i18n-aria-label="fm.newFolder" aria-label="New Folder">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-plus"></use></svg>
                                </button>
                            </div>
                            <div class="fm-pane-nav">
                                <button class="fm-nav-btn" id="fmRightUp" data-i18n-title="fm.goUp">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-up"></use></svg>
                                </button>
                                <button class="fm-nav-btn" id="fmRightHome" data-i18n-title="fm.goHome">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-house"></use></svg>
                                </button>
                                <div class="fm-breadcrumb" id="fmRightBreadcrumb">
                                    <input type="text" class="fm-path-input" id="fmRightPath" value="/" placeholder="/path">
                                </div>
                                <button class="fm-nav-btn" id="fmRightRefresh" data-i18n-title="fm.refresh">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-refresh-cw"></use></svg>
                                </button>
                            </div>
                            <div class="fm-file-list" id="fmRightList">
                                <div class="fm-empty">
                                    <svg class="icon fm-empty-icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-open"></use></svg>
                                    <!-- Destination end: the empty state must not tell the
                                         user to select a SOURCE here either. -->
                                    <div class="fm-empty-text" data-i18n="fm.selectDestinationAbove">Select a destination above</div>
                                </div>
                            </div>
                            <div class="fm-pane-footer">
                                <span class="fm-host-badge" id="fmRightBadge"></span>
                                <div class="fm-pane-status">
                                    <span id="fmRightCount">0 items</span>
                                    <span id="fmRightSelected"></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Transfer Queue -->
                    <div class="fm-queue" id="fmQueue">
                        <div class="fm-queue-header" id="fmQueueHeader">
                            <div class="fm-queue-title">
                                <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-refresh-cw"></use></svg>
                                <span data-i18n="fm.transfers">Transfers</span> <span class="fm-queue-badge" id="fmQueueBadge">0</span>
                            </div>
                            <svg class="icon fm-queue-toggle" id="fmQueueToggle" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-chevron-down"></use></svg>
                        </div>
                        <div class="fm-queue-list" id="fmQueueList"></div>
                    </div>

                    <!-- Mobile Upload Button -->
                    <div class="fm-mobile-upload" id="fmMobileUpload">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-cloud-upload"></use></svg>
                        <!-- data-i18n, not a literal: applyTranslations() re-walks
                             the DOM on every language change, so the key is what
                             makes this row follow a runtime locale switch. The
                             literal it replaced stayed English in all six locales. -->
                        <span data-i18n="fm.tapToUpload">Tap to upload files</span>
                        <input type="file" id="fmMobileUploadInput" multiple hidden>
                    </div>
                </div>

                <!-- Mobile Action Sheet. Every label is translated: these seven
                     rows were the only hard-coded English left on the phone
                     transfer surface, so a Vietnamese user reached an English
                     action sheet from a Vietnamese screen (Entry 40). -->
                <div class="fm-action-sheet" id="fmActionSheet">
                    <div class="fm-action-sheet-item" data-action="open">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-open"></use></svg>
                        <span data-i18n="fm.open">Open</span>
                    </div>
                    <div class="fm-action-sheet-item" data-action="download">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-download"></use></svg>
                        <span data-i18n="fm.download">Download</span>
                    </div>
                    <div class="fm-action-sheet-item" data-action="transfer">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-right-left"></use></svg>
                        <span data-i18n="fm.transfer">Transfer</span>
                    </div>
                    <div class="fm-action-sheet-item" data-action="rename">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-pencil"></use></svg>
                        <span data-i18n="fm.rename">Rename</span>
                    </div>
                    <div class="fm-action-sheet-item" data-action="newfolder">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-plus"></use></svg>
                        <span data-i18n="fm.newFolder">New Folder</span>
                    </div>
                    <div class="fm-action-sheet-item danger" data-action="delete">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-trash-2"></use></svg>
                        <span data-i18n="fm.delete">Delete</span>
                    </div>
                    <div class="fm-action-sheet-cancel fm-action-sheet-item" data-action="cancel">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-x"></use></svg>
                        <span data-i18n="common.cancel">Cancel</span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.modal = modal;

        this.createQuickConnectModal();

        this.setupEventListeners();
    }

    createQuickConnectModal() {
        const qcModal = document.createElement('div');
        qcModal.id = 'fmQuickConnectModal';
        qcModal.className = 'modal modal-small modal-shell';
        qcModal.setAttribute('role', 'dialog');
        qcModal.setAttribute('aria-modal', 'true');
        qcModal.setAttribute('aria-labelledby', 'fmQcModalTitle');
        qcModal.setAttribute('aria-hidden', 'true');
        qcModal.innerHTML = `
            <div class="modal-content fm-qc-modal">
                <div class="modal-header">
                    <h2 id="fmQcModalTitle" data-i18n="fm.qc.title">Connect to Server</h2>
                    <span class="close" id="fmQcClose" aria-label="Close" data-i18n-aria-label="common.close">&times;</span>
                </div>
                <div class="modal-body">
                    <form id="fmQcForm">
                        <!-- Profile Selector -->
                        <div class="form-group">
                            <label for="fmQcProfile" data-i18n="fm.qc.savedProfiles">Saved Profiles</label>
                            <select id="fmQcProfile" class="form-control">
                                <option value="" data-i18n="fm.qc.enterManually">-- Enter manually --</option>
                            </select>
                        </div>

                        <div class="fm-qc-divider">
                            <span data-i18n="fm.qc.orEnterDetails">or enter connection details</span>
                        </div>

                        <div class="form-row">
                            <div class="form-group flex-2">
                                <label for="fmQcHost" data-i18n="fm.qc.host">Host</label>
                                <input type="text" id="fmQcHost" class="form-control" placeholder="hostname or IP" required>
                            </div>
                            <div class="form-group flex-1">
                                <label for="fmQcPort" data-i18n="fm.qc.port">Port</label>
                                <input type="number" id="fmQcPort" class="form-control" value="22" min="1" max="65535">
                            </div>
                        </div>

                        <div class="form-group">
                            <label for="fmQcUsername" data-i18n="fm.qc.username">Username</label>
                            <input type="text" id="fmQcUsername" class="form-control" required>
                        </div>

                        <div class="form-group">
                            <label data-i18n="fm.qc.authentication">Authentication</label>
                            <div class="auth-type-selector">
                                <label class="radio-label">
                                    <input type="radio" name="fmQcAuth" value="password" checked>
                                    <span data-i18n="fm.qc.password">Password</span>
                                </label>
                                <label class="radio-label">
                                    <input type="radio" name="fmQcAuth" value="key">
                                    <span data-i18n="fm.qc.sshKey">SSH Key</span>
                                </label>
                            </div>
                        </div>

                        <div class="form-group" id="fmQcPasswordGroup">
                            <label for="fmQcPassword" data-i18n="fm.qc.password">Password</label>
                            <div class="input-wrapper with-toggle">
                                <input type="password" id="fmQcPassword" class="form-control" placeholder="Enter password">
                                <button type="button" class="password-toggle" id="fmQcPwToggle" aria-label="Toggle password visibility">
                                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-eye"></use></svg>
                                </button>
                            </div>
                        </div>

                        <div class="form-group hidden" id="fmQcKeyGroup">
                            <label for="fmQcKeySelect" data-i18n="fm.qc.sshKey">SSH Key</label>
                            <select id="fmQcKeySelect" class="form-control">
                                <option value="" data-i18n="fm.qc.selectKey">-- Select Key --</option>
                            </select>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="fmQcCancel" data-i18n="common.cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="fmQcConnectBtn">
                                <span class="btn-label" data-i18n="fm.qc.connect">Connect</span>
                                <span class="btn-spinner hidden"></span>
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        document.body.appendChild(qcModal);
        this.qcModal = qcModal;
        this.pendingQuickConnectPane = null;

        document.getElementById('fmQcClose').addEventListener('click', () => this.closeQuickConnect());
        document.getElementById('fmQcCancel').addEventListener('click', () => this.closeQuickConnect());
        qcModal.addEventListener('click', (e) => {
            if (e.target === qcModal) this.closeQuickConnect();
        });

        document.getElementById('fmQcProfile').addEventListener('change', (e) => {
            this.onProfileSelect(e.target.value);
        });

        document.getElementById('fmQcPwToggle').addEventListener('click', () => {
            const pwInput = document.getElementById('fmQcPassword');
            const icon = document.querySelector('#fmQcPwToggle use');
            if (pwInput.type === 'password') {
                pwInput.type = 'text';
                icon?.setAttribute('href', '/static/icons/icons.svg?v=2#icon-eye-off');
            } else {
                pwInput.type = 'password';
                icon?.setAttribute('href', '/static/icons/icons.svg?v=2#icon-eye');
            }
        });

        qcModal.querySelectorAll('input[name="fmQcAuth"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.getElementById('fmQcPasswordGroup').classList.toggle('hidden', e.target.value !== 'password');
                document.getElementById('fmQcKeyGroup').classList.toggle('hidden', e.target.value !== 'key');
            });
        });

        document.getElementById('fmQcForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitQuickConnect();
        });
    }

    setupEventListeners() {
        document.getElementById('fmClose').addEventListener('click', () => this.close());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });

        document.getElementById('fmRefresh').addEventListener('click', () => this.refreshBothPanes());
        document.getElementById('fmNewFolder').addEventListener('click', () => this.createNewFolder());
        document.getElementById('fmTransfer').addEventListener('click', () => this.executeTransfer());
        document.getElementById('fmDownload').addEventListener('click', () => this.downloadSelected());
        document.getElementById('fmRename').addEventListener('click', () => this.renameSelected());
        document.getElementById('fmDelete').addEventListener('click', () => this.deleteSelected());

        document.getElementById('fmLeftSource').addEventListener('change', (e) => this.onSourceChange('left', e.target.value));
        document.getElementById('fmLeftUp').addEventListener('click', () => this.navigatePaneUp('left'));
        document.getElementById('fmLeftHome').addEventListener('click', () => this.navigatePaneHome('left'));
        document.getElementById('fmLeftRefresh').addEventListener('click', () => this.refreshPane('left'));
        document.getElementById('fmLeftPath').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.navigatePaneTo('left', e.target.value);
        });
        document.getElementById('fmLeftPane').addEventListener('click', (e) => {
            if (!e.target.closest('.fm-file-item') && !e.target.closest('.fm-pane-header') && !e.target.closest('.fm-pane-nav')) {
                this.setActivePane('left');
            }
        });

        document.getElementById('fmRightSource').addEventListener('change', (e) => this.onSourceChange('right', e.target.value));
        document.getElementById('fmRightUp').addEventListener('click', () => this.navigatePaneUp('right'));
        document.getElementById('fmRightHome').addEventListener('click', () => this.navigatePaneHome('right'));
        document.getElementById('fmRightRefresh').addEventListener('click', () => this.refreshPane('right'));
        document.getElementById('fmRightPath').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.navigatePaneTo('right', e.target.value);
        });
        document.getElementById('fmRightPane').addEventListener('click', (e) => {
            if (!e.target.closest('.fm-file-item') && !e.target.closest('.fm-pane-header') && !e.target.closest('.fm-pane-nav')) {
                this.setActivePane('right');
            }
        });

        this.setupDropZones();

        document.getElementById('fmQueueHeader').addEventListener('click', () => this.toggleQueue());

        /*
         * The cancel control lives inside rows that renderTransferQueue
         * rebuilds on every progress tick, so it is delegated from the stable
         * list container rather than bound per row (upstream does the same).
         */
        document.getElementById('fmQueueList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-transfer-cancel]');
            if (!button) return;
            this.cancelQueuedTransfer(button.dataset.transferCancel);
        });

        document.addEventListener('click', () => this.closeContextMenu());

        /*
         * Pane tabs = a real ARIA tablist.
         * Click selects; ArrowLeft/Right, Home and End move selection the way a
         * tablist is expected to, and move focus with it so a keyboard user can
         * see where they are. Space/Enter arrive as click on a <button>, so they
         * need no special case.
         */
        const paneTabs = Array.from(document.querySelectorAll('.fm-pane-tab'));
        paneTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.setActivePane(e.currentTarget.dataset.pane);
            });
            tab.addEventListener('keydown', (e) => {
                const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
                if (!keys.includes(e.key)) {
                    return;
                }
                e.preventDefault();
                const current = paneTabs.indexOf(e.currentTarget);
                let next = current;
                if (e.key === 'ArrowLeft') {
                    next = (current - 1 + paneTabs.length) % paneTabs.length;
                } else if (e.key === 'ArrowRight') {
                    next = (current + 1) % paneTabs.length;
                } else if (e.key === 'Home') {
                    next = 0;
                } else {
                    next = paneTabs.length - 1;
                }
                const target = paneTabs[next];
                this.setActivePane(target.dataset.pane);
                target.focus();
            });
        });

        const mobileUpload = document.getElementById('fmMobileUpload');
        const mobileUploadInput = document.getElementById('fmMobileUploadInput');
        if (mobileUpload && mobileUploadInput) {
            mobileUpload.addEventListener('click', () => mobileUploadInput.click());
            mobileUploadInput.addEventListener('change', (e) => this.handleMobileUpload(e));
        }

        /*
         * P3 / mockup line 182: the panel's own Upload and New-folder controls.
         * Both delegate to the handlers that already exist -- the file input the
         * mobile upload tile uses, and createNewFolder -- so this adds an
         * affordance, not a second upload path. Clicking a pane's button makes
         * that pane active first, because both handlers operate on
         * this.activePane and the mockup's button belongs to the panel it is
         * drawn in.
         */
        ['left', 'right'].forEach((pane) => {
            const cap = this.capitalize(pane);
            document.getElementById(`fm${cap}Upload`)?.addEventListener('click', () => {
                this.setActivePane(pane);
                document.getElementById('fmMobileUploadInput')?.click();
            });
            document.getElementById(`fm${cap}NewFolder`)?.addEventListener('click', () => {
                this.setActivePane(pane);
                this.createNewFolder();
            });
        });

        document.querySelectorAll('.fm-action-sheet-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = e.currentTarget.dataset.action;
                this.handleActionSheetAction(action);
            });
        });

        this.setupLongPress();
    }

    /*
     * The SFTP panes own their own drop affordance (.drop-target on the pane),
     * so the window-wide upload overlay must not sit on top of it. app.js
     * reveals #dropOverlay from a document-level dragover; the pane's own
     * dragover calls stopPropagation, so it never re-reveals while the pointer
     * is inside a pane -- but it may already be up from the pointer's path
     * across the rest of the window, which is what this dismisses.
     *
     * This replaces three calls into the retired drag-drop-manager (its
     * dragCounter reset plus hideOverlay). The canonical overlay is stateless:
     * app.js re-derives visibility from the next dragover, so hiding it is the
     * whole of what those calls achieved.
     */
    hideWindowDropOverlay() {
        document.getElementById('dropOverlay')?.classList.add('hidden');
    }

    /*
     * isForwardPaneDrag — is an in-surface drag onto `targetPane` a transfer?
     *
     * The one true direction: left is Source, right is
     * Destination, and transfer_server_to_server only ever copies left -> right.
     * A drag therefore qualifies only when it STARTED in the left pane and is
     * over the right pane. Everything else — right -> left, left -> left,
     * right -> right, or no in-surface drag at all — is not a transfer gesture
     * and must neither highlight a drop target nor reach executeTransfer.
     */
    isForwardPaneDrag(targetPane) {
        return this.dragSource === 'left' && targetPane === 'right';
    }

    setupDropZones() {
        ['left', 'right'].forEach(pane => {
            const paneEl = document.getElementById(`fm${this.capitalize(pane)}Pane`);

            paneEl.addEventListener('dragenter', (e) => {
                if (e.dataTransfer?.types?.includes('Files')) {
                    this.hideWindowDropOverlay();
                }
            });

            paneEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                /*
                 * DIRECTION IS FIXED, SO THE AFFORDANCE MUST BE TOO.
                 * `dragSource !== pane` highlighted BOTH directions,
                 * which advertised a right-to-left drop the product refuses:
                 * executeTransfer always copies left Source -> right Destination,
                 * so a Destination-to-Source gesture that lit up a drop target
                 * either did nothing or, worse, ran the FORWARD copy using a
                 * stale left selection the user was not pointing at.
                 *
                 * Only left -> right is a transfer gesture. A browser file drag
                 * ('Files') is upload tooling and may still target either pane.
                 */
                if (this.isForwardPaneDrag(pane)) {
                    paneEl.classList.add('drop-target');
                }
                if (e.dataTransfer?.types?.includes('Files')) {
                    paneEl.classList.add('drop-target');
                }
            });

            paneEl.addEventListener('dragleave', (e) => {
                if (!paneEl.contains(e.relatedTarget)) {
                    paneEl.classList.remove('drop-target');
                }
            });

            paneEl.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                paneEl.classList.remove('drop-target');
                this.handleDrop(e, pane);

                this.hideWindowDropOverlay();
            });
        });
    }

    setupSocketListeners() {
        if (!this.socket) return;

        this.socket.on('directory_listing', (data) => {
            // Gate: either the legacy modal is open OR the inline panel is visible.
            const inlinePanel = document.getElementById('sftpPanel');
            const inlineOpen = inlinePanel && inlinePanel.classList.contains('sftp-panel-open');
            if (!this.isOpen && !inlineOpen) return;

            ['left', 'right', 'inline'].forEach(pane => {
                const state = this.panes[pane];
                if (!state) return;
                const visible = pane === 'inline' ? inlineOpen : this.isOpen;
                if (state.type === 'ssh' &&
                    (state.sessionId === data.session_id || state.connectionId === data.session_id)) {
                    /*
                     * GUARD 1 — correlate the reply with what this pane asked
                     * for. Session id alone does not identify a request: a pane
                     * can have several listings in flight on ONE session (see
                     * pendingPath in createEmptyPaneState), and the replies are
                     * not ordered. Without this, the last reply to arrive wins
                     * regardless of which one the pane actually wants.
                     *
                     * A pane with no recorded intent (pendingPath === null)
                     * accepts anything, which keeps unsolicited server-pushed
                     * refreshes working exactly as before.
                     */
                    if (state.pendingPath !== null && data.path !== state.pendingPath) {
                        return;
                    }
                    if (state.loadingTimeout) {
                        clearTimeout(state.loadingTimeout);
                        state.loadingTimeout = null;
                    }
                    state.files = data.files || [];
                    state.path = data.path;
                    state.loading = false;
                    state.error = null;
                    state.refreshOnOpen = !visible;
                    if (visible) {
                        this.updatePathInput(pane, data.path);
                        this.renderPane(pane);
                    }
                }
            });
        });

        this.socket.on('home_directory', (data) => {
            ['left', 'right', 'inline'].forEach(pane => {
                const state = this.panes[pane];
                if (!state) return;
                if (state.type === 'ssh' &&
                    (state.sessionId === data.session_id || state.connectionId === data.session_id)) {
                    if (!state.homePath) {
                        state.homePath = data.path;
                        /*
                         * GUARD 2 — auto-land on $HOME only if nobody has asked
                         * for a directory. get_home_directory is emitted by
                         * onSourceChange together with the '/' listing, and its
                         * reply can arrive AFTER a caller has already navigated
                         * the pane elsewhere. `state.path === '/'` was meant to
                         * mean "still at the default", but a pane whose
                         * navigation is merely IN FLIGHT is also still showing
                         * '/', so this auto-landing hijacked it — measured live:
                         * the left pane was pulled from a requested /tmp/... to
                         * /home/<user> 176 ms after the explicit navigation.
                         *
                         * pendingPath distinguishes the two states that
                         * state.path cannot: "at the default, nothing
                         * requested" vs "at the default, waiting for the
                         * directory I asked for".
                         */
                        if (state.path === '/' && state.pendingPath === null) {
                            this.navigatePaneTo(pane, data.path);
                        }
                    }
                }
            });
        });

        this.socket.on('directory_created', (data) => {
            if (!this.currentUploadBatch) {
                this.showNotification(`${this.t('fm.folderCreated', 'Folder created')}: ${data.path}`, 'success');
            }
            this.refreshBothPanes();
        });

        this.socket.on('file_renamed', (data) => {
            this.showNotification(this.t('fm.renamedSuccess', 'Renamed successfully'), 'success');
            this.refreshBothPanes();
        });

        this.socket.on('item_deleted', (data) => {
            this.showNotification(`${this.t('fm.deleted', 'Deleted')}: ${data.path}`, 'success');
            this.refreshBothPanes();
        });

        this.socket.on('file_progress', (data) => {
            this.updateTransferProgress(data);
        });

        this.socket.on('file_complete', (data) => {
            this.completeTransfer(data, 'upload');

            if (this.currentUploadBatch && data.type === 'upload') {
                this.currentUploadBatch.completed++;
                this.showUploadProgress();

                if (this.currentUploadBatch.completed >= this.currentUploadBatch.total) {
                    this.showUploadComplete();
                    window._currentUploadBatchId = null;
                    this.currentUploadBatch = null;
                }
            }
        });

        this.socket.on('file_download_ready_binary', (data) => {
            this.handleDownloadReady(data);
        });

        this.socket.on('s2s_transfer_started', (data) => {
            this.showNotification(this.t('fm.transferStarted', 'Server-to-server transfer started'), 'info');
        });

        this.socket.on('s2s_transfer_progress', (data) => {
            if (this.bufferEarlyS2SEvent('progress', data)) return;
            this.updateTransferProgress(data);
        });

        this.socket.on('s2s_transfer_complete', (data) => {
            if (this.bufferEarlyS2SEvent('complete', data)) return;
            this.applyS2SComplete(data);
        });

        this.socket.on('s2s_transfer_error', (data) => {
            if (this.bufferEarlyS2SEvent('error', data)) return;
            this.applyS2SError(data);
        });

        /*
         * Cancellation.
         * The server broadcasts to the whole user room, so a transfer cancelled
         * in one tab shows as cancelled in the others too. The ack path in
         * cancelQueuedTransfer covers the tab that pressed the button; this
         * listener covers the rest, and both are idempotent.
         */
        this.socket.on('s2s_transfer_cancelled', (data) => {
            if (this.bufferEarlyS2SEvent('cancelled', data)) return;
            this.cancelS2STransfer(data);
        });

        this.socket.on('quick_connect_success', (data) => {
            this.handleQuickConnectSuccess(data);
        });

        this.socket.on('quick_connect_error', (data) => {
            this.showNotification(`${this.t('fm.qc.connectionFailed', 'Connection failed')}: ${data.error}`, 'error');
            const btn = document.getElementById('fmQcConnectBtn');
            if (btn) {
                btn.disabled = false;
                btn.querySelector('.btn-label').textContent = this.t('fm.qc.connect', 'Connect');
                btn.querySelector('.btn-spinner')?.classList.add('hidden');
            }
        });

        this.socket.on('error', (data) => {
            const errorMsg = data.error || data.message || 'Unknown error';
            console.error('[FM] SFTP Error received:', errorMsg, data);

            ['left', 'right'].forEach(pane => {
                const state = this.panes[pane];
                if (state.loading && state.type === 'ssh') {
                    if (state.loadingTimeout) {
                        clearTimeout(state.loadingTimeout);
                        state.loadingTimeout = null;
                    }
                    state.loading = false;
                    state.error = errorMsg;
                    this.renderPane(pane);
                }
            });

            this.showNotification(errorMsg, 'error');
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;

            if (e.key === 'Escape') {
                this.closeContextMenu();
                if (!this.hasOpenDialogs()) {
                    this.close();
                }
            }

            if (e.key === 'Tab' && !e.target.matches('input, textarea, select')) {
                e.preventDefault();
                this.setActivePane(this.activePane === 'left' ? 'right' : 'left');
            }

            if (e.ctrlKey && e.key === 'a' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                this.selectAll();
            }

            if (e.key === 'Delete' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                this.deleteSelected();
            }

            if (e.key === 'F5') {
                e.preventDefault();
                this.executeTransfer();
            }

            if (e.key === 'F7') {
                e.preventDefault();
                this.createNewFolder();
            }

            if (e.key === 'F2') {
                e.preventDefault();
                this.renameSelected();
            }

            if (e.key === 'Enter' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                const state = this.panes[this.activePane];
                if (state.selected.size === 1) {
                    const index = Array.from(state.selected)[0];
                    this.handleItemDblClick(this.activePane, index);
                }
            }
        });
    }

    /*
     * Open — the SERVER-TO-SERVER File Transfer surface.
     *
     * This surface exists to
     * move a file from one SSH host to ANOTHER SSH host, so BOTH panes must be
     * reachable and the Transfer action must be operable on every tier,
     * including a 390px phone. It previously collapsed on phones to the right
     * pane alone with #fmTransfer hidden by CSS -- i.e. exactly the one thing
     * the surface is for was unavailable on the tier most likely to use it.
     *
     * The fix is `fm-transfer-mode`, which keeps the phone's single-pane SIZING
     * (two side-by-side panes are unusable at 390px) while restoring the pane
     * tabs as the host switcher and the Transfer button as the action. Tab to
     * Source, pick host + path; tab to Destination, pick host + path; Transfer.
     * That is the same one surface, not a mobile intermediary screen.
     *
     * No inline display styles are set here any more: they outranked the
     * stylesheet and were what pinned the phone to one pane.
     */
    /*
     * resetTransferSurfaceState — put both panes back to safe defaults.
     *
     * Called on every global open. Without
     * it, reopening the surface showed the PREVIOUS session's host, path and
     * selection: pressing Transfer then copied files the user could not see, from
     * or to a session that may no longer exist. Rebuilding the pane objects is
     * deliberate — clearing individual fields leaves whatever a future field
     * addition forgets to clear.
     */
    resetTransferSurfaceState() {
        /*
         * FENCE FIRST. Bumping the epoch before anything else
         * is what stops an in-flight executeTransfer loop from starting its NEXT
         * item: that loop still holds the OLD pane objects, so any further copy it
         * began would use a source host, destination host and path that are about
         * to disappear from the screen. The bump makes the loop exit at its next
         * item boundary instead.
         */
        this.batchEpoch += 1;
        this.activeBatch = null;

        this.panes.left = this.createEmptyPaneState();
        this.panes.right = this.createEmptyPaneState();
        this.activePane = 'left';

        this.draggedItems = [];
        this.dragSource = null;
        this.conflictAction = null;
        this.applyToAll = false;

        /*
         * IN-FLIGHT ROWS SURVIVE; terminal rows do not.
         *
         * Clearing the whole queue here was the defect: a transfer that is still
         * running server-side lost its row, so it became invisible AND
         * uncancellable from the UI while it kept writing to the destination —
         * a hidden continuation. Completed / failed / cancelled rows are history
         * from a previous open and are dropped, as before.
         *
         * The surviving rows keep their entries in activeTransfers so
         * cancelQueuedTransfer can still address them, and renderTransferQueue
         * re-adds `has-transfers`, so the in-flight status stays visible.
         */
        // The only non-terminal statuses a row can hold: queueTransfer seeds
        // 'pending' and processTransferQueue promotes to 'active'. Terminal is
        // 'complete' / 'error' / 'cancelled' (see findTerminalizableTransfer).
        const liveStates = new Set(['pending', 'active']);
        const live = this.transferQueue.filter(t => liveStates.has(t.status));
        const liveIds = new Set(live.map(t => String(t.id)));
        this.transferQueue = live;
        for (const id of Array.from(this.activeTransfers.keys())) {
            if (!liveIds.has(String(id))) this.activeTransfers.delete(id);
        }
        this.isTransferring = live.length > 0;
        // Buffered events for rows that will never be created now. Anything still
        // live above already HAS a row, so nothing addressable is discarded.
        this.earlyS2SEvents?.clear();

        ['fmLeftSource', 'fmRightSource'].forEach(id => {
            const select = document.getElementById(id);
            if (select) {
                select.value = '';
            }
        });
        ['left', 'right'].forEach(pane => {
            this.updatePathInput(pane, '/');
            this.updatePaneBadge(pane);
            this.renderPane(pane);
        });
        this.renderTransferQueue();
    }

    open() {
        this.isOpen = true;
        if (window.ModalManager) {
            window.ModalManager.open(this.modal);
        } else {
            this.modal.classList.add('show');
            this.modal.setAttribute('aria-hidden', 'false');
        }
        this.modal.classList.add('fm-transfer-mode');
        this.applyTranslations();
        this.updateSessionLists();

        // Before anything is seeded: no pane, path, selection or queue row may
        // survive a close/reopen cycle.
        this.resetTransferSurfaceState();

        const currentSession = typeof SessionManager !== 'undefined'
            ? SessionManager.getActiveSession() : null;

        // Clear any inline display left by an older build of this method.
        document.getElementById('fmLeftPane').style.display = '';
        document.getElementById('fmRightPane').style.display = '';

        this.modal.classList.toggle('fm-mobile-mode', this.isMobile());

        /*
         * Seed the DESTINATION pane with the active session and leave the
         * SOURCE pane empty and focused. The user's next decision is "where am
         * I copying FROM", and pre-filling both would invite an accidental
         * same-host transfer, which transferSSHtoSSH rejects anyway.
         */
        if (currentSession) {
            document.getElementById('fmRightSource').value = `ssh:${currentSession}`;
            this.onSourceChange('right', `ssh:${currentSession}`);
        }

        this.setActivePane('left');
    }

    handleActiveSessionChanged(newSessionId) {
        const targetSessionId = newSessionId || (typeof SessionManager !== 'undefined' ? SessionManager.getActiveSession() : null);
        const state = this.panes['inline'];
        if (!state || !targetSessionId || state.sessionId === targetSessionId) {
            return;
        }

        state.type = 'ssh';
        state.sessionId = targetSessionId;
        state.path = '/';
        state.pendingPath = null;
        state.files = [];

        if (typeof SessionManager !== 'undefined') {
            const sess = SessionManager.sessions[targetSessionId];
            if (sess) {
                state.hostInfo = {
                    host: sess.displayName || sess.host,
                    username: sess.username,
                    port: sess.port,
                };
            }
        }

        const inlinePanel = document.getElementById('sftpPanel');
        const inlineOpen = inlinePanel && inlinePanel.classList.contains('sftp-panel-open');
        if (inlineOpen) {
            state.loading = true;
            this.updatePaneBadge('inline');
            this.renderPane('inline');
            // The rebind's own opening listing is a DEFAULT too -- see
            // the note in openInline. Recording intent here would make the
            // rebound pane refuse every later unsolicited refresh.
            this.socket.emit('list_directory',
                this.remoteFilesystemPayload('inline', targetSessionId,
                    { remote_path: state.path }));
            this.setLoadingTimeout('inline');
        } else {
            state.refreshOnOpen = true;
        }
    }

    // ─── openInline ────────────────────────────────────────────────────────
    // P3 / mockup v5 line 182.  Opens the compact inspector panel (#sftpPanel)
    // Instead of the full-screen dual-pane modal. Falls back to open if the
    // panel host is missing (e.g. old cached HTML served before this deploy).
    //
    // The panel uses pane key 'inline' so every existing fm${capitalize(pane)}
    // helper (updatePaneHead, renderPane, updatePaneBadge …) resolves its IDs
    // automatically: fmInlinePane, fmInlineTitle, fmInlineHeadPath,
    // fmInlineList, fmInlineUpload, fmInlineNewFolder, fmInlineBadge,
    // fmInlineCount, fmInlineSelected.
    //
    // Mutual exclusion is achieved by dispatching the same
    // sshdeck:aux-panel-opening event that Notes and Command Library use, so
    // opening SFTP closes whichever of the other two is open and vice-versa.
    openInline() {
        /*
         * NEVER falls back to open.
         *
         * This used to `return this.open` when #sftpPanel was missing — e.g.
         * cached markup from before the panel shipped. That turned the
         * per-session Files button into the GLOBAL dual-pane server-to-server
         * surface: a different feature, seeded with a different host, reached by
         * pressing a control that says "Files". The panel host is created here
         * instead, so the contextual route stays a one-session Files surface
         * whatever markup the browser happens to be holding.
         */
        let panel = document.getElementById('sftpPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'sftpPanel';
            panel.className = 'sftp-panel';
            panel.setAttribute('aria-hidden', 'true');
            panel.setAttribute('inert', '');
            const host = document.querySelector('.terminal-area')
                || document.querySelector('.main-content')
                || document.body;
            host.appendChild(panel);
        }

        // Ensure the 'inline' pane state exists.
        if (!this.panes['inline']) {
            this.panes['inline'] = this.createEmptyPaneState();
        }

        // Seed the panel with the compact v5 markup if it has not been rendered.
        if (!panel.querySelector('#fmInlinePane')) {
            const iconBase = '/static/icons/icons.svg?v=2';
            panel.innerHTML = `
                <!-- sftpPanel compact inline surface, v5 spec line 182 -->
                <div class="fm-pane" id="fmInlinePane" data-pane="inline">
                    <!-- P3: panel head — "Tệp · host" over path, spec 292/293 -->
                    <div class="fm-panel-head">
                        <div>
                            <strong class="fm-panel-title" id="fmInlineTitle"
                                    data-i18n="fm.filesTitle">Files</strong>
                            <small class="fm-panel-path" id="fmInlineHeadPath"></small>
                        </div>
                        <button type="button" class="sftp-inline-close btn-icon"
                                id="sftpPanelClose"
                                aria-label="Close"
                                data-i18n-aria-label="common.close">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-x"></use>
                            </svg>
                        </button>
                    </div>
                    <!-- Navigation. The dual-pane surface has had Up / Home /
                         path / Refresh since it was built; this panel, which is
                         the ONLY file manager on a phone, had none of it: no way
                         back to the parent, no reload, no way to type a path
                         (owner, 2026-09-14). Same ids by the same rule the rest
                         of the class uses (fm<Pane>Up/Home/Path/Refresh), so
                         navigatePaneUp, navigatePaneHome, refreshPane and
                         updatePathInput work here with no special case. -->
                    <div class="fm-pane-nav">
                        <button class="fm-nav-btn" id="fmInlineUp" type="button"
                                data-i18n-title="fm.goUp" data-i18n-aria-label="fm.goUp"
                                aria-label="Up">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-arrow-up"></use>
                            </svg>
                        </button>
                        <button class="fm-nav-btn" id="fmInlineHome" type="button"
                                data-i18n-title="fm.goHome" data-i18n-aria-label="fm.goHome"
                                aria-label="Home">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-house"></use>
                            </svg>
                        </button>
                        <div class="fm-breadcrumb" id="fmInlineBreadcrumb">
                            <input type="text" class="fm-path-input" id="fmInlinePath"
                                   value="/" placeholder="/path"
                                   autocapitalize="off" autocorrect="off" spellcheck="false">
                        </div>
                        <button class="fm-nav-btn" id="fmInlineRefresh" type="button"
                                data-i18n-title="fm.refresh" data-i18n-aria-label="fm.refresh"
                                aria-label="Refresh">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-refresh-cw"></use>
                            </svg>
                        </button>
                    </div>
                    <!-- P3 / spec 300: file actions — upload + new folder -->
                    <div class="fm-file-actions">
                        <button class="btn btn-secondary fm-upload-btn"
                                id="fmInlineUpload"
                                data-i18n-title="fm.upload" type="button">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-upload"></use>
                            </svg>
                            <span data-i18n="fm.upload">Upload</span>
                        </button>
                        <button class="btn btn-secondary fm-icon-action"
                                id="fmInlineNewFolder"
                                data-i18n-title="fm.newFolder"
                                data-i18n-aria-label="fm.newFolder"
                                aria-label="New Folder" type="button">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-folder-plus"></use>
                            </svg>
                        </button>
                        <!-- Upload / Download (owner ruling 2026-08-10, Entry 40).
                             The browser<->server form modal lives HERE, inside the
                             per-session file tooling, because that is what it does:
                             one host, this browser, a file up or a path down. It is
                             NOT a second global "File Transfer" item -- that name
                             belongs exclusively to the server-to-server surface.
                             The click is handled by file-transfer.js, which owns
                             the modal; delegated, since this panel renders late. -->
                        <button class="btn btn-secondary fm-icon-action"
                                id="fmUploadDownloadBtn"
                                data-i18n-title="files.uploadDownload"
                                data-i18n-aria-label="files.uploadDownload"
                                aria-label="Upload / Download" type="button">
                            <svg class="icon" aria-hidden="true">
                                <use href="${iconBase}#icon-cloud-upload"></use>
                            </svg>
                        </button>
                    </div>
                    <!-- File list, rendered by renderPane('inline') -->
                    <div class="fm-file-list" id="fmInlineList">
                        <div class="fm-empty">
                            <svg class="icon fm-empty-icon" aria-hidden="true">
                                <use href="${iconBase}#icon-folder-open"></use>
                            </svg>
                            <div class="fm-empty-text"
                                 data-i18n="fm.selectSourceAbove">
                                Select a source above
                            </div>
                        </div>
                    </div>
                    <!-- Status footer (hidden at narrow widths via CSS) -->
                    <div class="fm-pane-footer">
                        <span class="fm-host-badge" id="fmInlineBadge"></span>
                        <div class="fm-pane-status">
                            <span id="fmInlineCount">0 items</span>
                            <span id="fmInlineSelected"></span>
                        </div>
                    </div>
                </div>
                <!-- Hidden file input: inline upload delegates here exactly
                     like the panel's left/right counterparts do. -->
                <input type="file" id="fmInlineUploadInput" multiple hidden>
            `;

            // Translate the freshly injected markup. Neither of the two
            // obvious calls works here: the global i18n object (app.js:2931)
            // has no applyTranslations, and this class's own
            // ApplyTranslations walks `this.modal` only -- the panel is not
            // inside the modal, so both would leave the panel in English
            // regardless of the stored locale. Walk the panel subtree with the
            // same attribute set updatePageText handles.
            this.translateSubtree(panel);

            // Bind close button.
            document.getElementById('sftpPanelClose')
                ?.addEventListener('click', () => this.closeInline());

            // Navigation: the same four routes the dual-pane surface binds,
            // against the same generic methods.
            document.getElementById('fmInlineUp')
                ?.addEventListener('click', () => this.navigatePaneUp('inline'));
            document.getElementById('fmInlineHome')
                ?.addEventListener('click', () => this.navigatePaneHome('inline'));
            document.getElementById('fmInlineRefresh')
                ?.addEventListener('click', () => this.refreshPane('inline'));
            document.getElementById('fmInlinePath')
                ?.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.navigatePaneTo('inline', e.target.value);
                        e.target.blur();
                    }
                });

            // The other half of the exclusion. Dispatching
            // sshdeck:aux-panel-opening closes Notes and the Command rail, but
            // without this listener the reverse never happened: opening either
            // of those left the SFTP panel in the shared auxiliary cell, so two
            // panels competed for one slot. Registered here rather than in the
            // constructor because it is the panel -- not the manager -- that
            // needs closing, and the panel does not exist until now.
            document.addEventListener('sshdeck:aux-panel-opening', (event) => {
                if (event.detail?.panel !== 'sftp') {
                    this.closeInline();
                }
            });

            // Upload button: make the inline pane active then trigger the file
            // picker.  The existing uploadFileToBrowser path handles the rest.
            document.getElementById('fmInlineUpload')
                ?.addEventListener('click', () => {
                    this.activePane = 'inline';
                    document.getElementById('fmInlineUploadInput')?.click();
                });

            // File input change: reuse the same handler logic as left/right.
            document.getElementById('fmInlineUploadInput')
                ?.addEventListener('change', (e) => {
                    const state = this.panes['inline'];
                    const sessionId = state.sessionId || state.connectionId;
                    if (!sessionId) return;
                    [...e.target.files].forEach(file => {
                        this.uploadFileToBrowser(file, state.path || '/', sessionId);
                    });
                    e.target.value = '';
                });

            // New-folder button.
            document.getElementById('fmInlineNewFolder')
                ?.addEventListener('click', () => {
                    this.activePane = 'inline';
                    this.createNewFolder();
                });

            // Clicking a file row delegates via the pane listener pattern.
            document.getElementById('fmInlinePane')
                ?.addEventListener('click', (e) => {
                    const item = e.target.closest('.fm-file-item');
                    if (!item) return;
                    const index = parseInt(item.dataset.index);
                    if (e.detail === 2) {          // double-click
                        this.handleItemDblClick('inline', index);
                    } else {
                        this.handleItemClick(e, 'inline', index);
                    }
                });
        }

        // Show the panel and hide it from AT while closed.
        panel.classList.add('sftp-panel-open');
        panel.removeAttribute('aria-hidden');
        panel.removeAttribute('inert');

        // Announce to close Notes / Command Library.
        document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening', {
            detail: { panel: 'sftp' },
        }));

        // Apply i18n translations to any newly-present data-i18n attributes.
        this.applyTranslations();

        // Connect the inline pane to the active SSH session, mirroring what
        // Open does for the right pane of the modal.
        const currentSessionId = (typeof SessionManager !== 'undefined')
            ? SessionManager.getActiveSession()
            : null;

        if (currentSessionId && (!this.panes['inline'].type || this.panes['inline'].sessionId !== currentSessionId)) {
            const state = this.panes['inline'];
            state.type = 'ssh';
            state.sessionId = currentSessionId;

            // hostInfo lookup: clone from an already-resolved left/right pane
            // if available; otherwise build from SessionManager.
            const existing = this.panes['left'].sessionId === currentSessionId
                ? this.panes['left'].hostInfo
                : this.panes['right'].sessionId === currentSessionId
                    ? this.panes['right'].hostInfo
                    : null;

            if (existing) {
                state.hostInfo = existing;
            } else if (typeof SessionManager !== 'undefined') {
                const sess = SessionManager.sessions[currentSessionId];
                if (sess) {
                    state.hostInfo = {
                        host: sess.displayName || sess.host,
                        username: sess.username,
                        port: sess.port,
                    };
                }
            }

            state.loading = true;
            this.updatePaneBadge('inline');
            this.renderPane('inline');

            /*
             * This '/' listing is a DEFAULT, not a navigation request,
             * so it must NOT record pendingPath -- exactly the distinction
             * onSourceChange documents for its own opening listing.
             *
             * It briefly went through requestPaneListing, which records intent.
             * Nothing ever clears the inline pane's intent (onSourceChange only
             * touches left/right), so guard 1 in the directory_listing handler
             * `pendingPath !== null && data.path !== pendingPath` -- then
             * rejected every reply for any other path: an unsolicited refresh, a
             * server push, another client's change. The pane sat on whatever it
             * had opened with, and guard 2's home auto-landing (which requires
             * pendingPath === null) could never fire either.
             *
             * An explicit navigation still records intent, through
             * navigatePaneTo/refreshPane -> requestPaneListing, which is what
             * makes the correlation guard work where correlation is meaningful.
             */
            this.socket.emit('list_directory',
                this.remoteFilesystemPayload('inline', currentSessionId,
                    { remote_path: state.path || '/' }));
            this.setLoadingTimeout('inline');
        } else {
            // Pane already has state: refresh the head and list. If a listing
            // arrived while this panel was hidden, paint its cached state once
            // now rather than rebuilding hidden DOM at response time.
            const state = this.panes.inline;
            state.refreshOnOpen = false;
            this.updatePathInput('inline', state.path);
            this.updatePaneBadge('inline');
            this.renderPane('inline');
        }

        this.activePane = 'inline';
    }

    // Closes the inline inspector panel opened by openInline.
    closeInline() {
        const panel = document.getElementById('sftpPanel');
        if (!panel) return;
        const state = this.panes.inline;
        if (state?.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
            state.loadingTimeout = null;
        }
        if (state) {
            state.loading = false;
        }
        panel.classList.remove('sftp-panel-open');
        panel.setAttribute('aria-hidden', 'true');
        panel.setAttribute('inert', '');
    }

    close() {
        this.isOpen = false;
        if (window.ModalManager) {
            window.ModalManager.close(this.modal);
        } else {
            this.modal.classList.remove('show');
            this.modal.setAttribute('aria-hidden', 'true');
        }
        this.modal.classList.remove('fm-transfer-mode');
        this.closeContextMenu();
        this.hideActionSheet();

        // Closing the panel while a drag was in flight left the window overlay
        // Up; the retired manager's reset was counter-zero plus hide, and the
        // canonical overlay needs only the hide.
        this.hideWindowDropOverlay();

        ['left', 'right'].forEach(pane => {
            const paneEl = document.getElementById(`fm${this.capitalize(pane)}Pane`);
            if (paneEl) {
                paneEl.classList.remove('drop-target');
            }
        });

        if (this.uploadProgressNotification) {
            this.uploadProgressNotification.remove();
            this.uploadProgressNotification = null;
        }
    }

    handleSessionDisconnected(sessionId) {
        ['left', 'right'].forEach(pane => {
            const state = this.panes[pane];
            if (state.type === 'ssh' &&
                (state.sessionId === sessionId || state.connectionId === sessionId)) {
                this.resetPane(pane);
            }
        });
        this.updateSessionLists();
    }

    hasOpenDialogs() {
        return document.querySelector('.fm-conflict-dialog') !== null ||
               this.qcModal.classList.contains('show');
    }

    updateSessionLists() {
        const sessions = typeof SessionManager !== 'undefined' ? SessionManager.getAllSessions() : [];
        this.availableSessions = sessions.filter(s => s.connected);

        ['Left', 'Right'].forEach(side => {
            const group = document.getElementById(`fm${side}Sessions`);
            group.innerHTML = '';

            this.availableSessions.forEach(session => {
                const option = document.createElement('option');
                option.value = `ssh:${session.id}`;
                option.textContent = `${session.username}@${session.host}`;
                group.appendChild(option);
            });

            this.quickConnections.forEach(qc => {
                const option = document.createElement('option');
                option.value = `qc:${qc.connectionId}`;
                option.textContent = `${qc.username}@${qc.host} (quick)`;
                group.appendChild(option);
            });
        });
    }

    remoteFilesystemPayload(pane, sessionId, fields = {}) {
        /*
         * The global left/right File Transfer panes are the S2S route and must
         * never request SFTP. They explicitly select the machine-readable SSH
         * exec protocol. The inline single-session Files pane deliberately
         * sends no transport flag, so its established SFTP behavior is kept
         * separate and unchanged.
         */
        const payload = { session_id: sessionId, ...fields };
        if (pane !== 'inline') payload.transport = 'exec';
        return payload;
    }

    async onSourceChange(pane, value) {
        const state = this.panes[pane];

        if (state.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
            state.loadingTimeout = null;
        }

        state.files = [];
        state.selected.clear();
        state.loading = true;
        state.error = null;
        /*
         * A new source means every earlier request is void. Carrying the old
         * pane's pendingPath over would make guard 1 reject the new source's
         * own first listing, so the pane would never show anything.
         */
        state.pendingPath = null;
        this.renderPane(pane);

        if (!value) {
            state.type = null;
            state.sessionId = null;
            state.connectionId = null;
            state.loading = false;
            this.renderPane(pane);
            this.updatePaneBadge(pane);
            return;
        }

        if (value === 'browser-local') {
            if (!this.browserFS.isSupported) {
                this.showNotification(this.t('fm.fsaNotSupported', 'File System Access API not supported. Use drag & drop instead.'), 'warning');
                state.loading = false;
                this.renderPane(pane);
                return;
            }

            const granted = await this.browserFS.requestAccess();
            if (granted) {
                state.type = 'browser-local';
                state.sessionId = null;
                state.connectionId = null;
                state.path = this.browserFS.getCurrentPath();
                state.hostInfo = { host: this.t('fm.yourComputer', 'Your Computer'), username: '', port: '' };
                await this.refreshBrowserPane(pane);
            } else {
                state.loading = false;
                this.renderPane(pane);
            }
            this.updatePaneBadge(pane);

        } else if (value === 'quick-connect') {
            this.pendingQuickConnectPane = pane;
            this.openQuickConnect();
            const select = document.getElementById(`fm${this.capitalize(pane)}Source`);
            select.value = state.type === 'ssh' ? `ssh:${state.sessionId || state.connectionId}` : '';
            state.loading = false;

        } else if (value.startsWith('ssh:')) {
            const sessionId = value.substring(4);
            state.type = 'ssh';
            state.sessionId = sessionId;
            state.connectionId = null;

            const session = this.availableSessions.find(s => s.id === sessionId);
            if (session) {
                state.hostInfo = { host: session.host, username: session.username, port: session.port };
            }

            this.socket.emit('get_home_directory',
                this.remoteFilesystemPayload(pane, sessionId));
            /*
             * The '/' listing here is a DEFAULT, not a request: it exists so the
             * pane shows something while get_home_directory resolves, and the
             * home reply is expected to take over. So it deliberately does NOT
             * record pendingPath — recording it would make this pane refuse the
             * home auto-landing (guard 2) and permanently strand every newly
             * selected source at '/'.
             */
            this.socket.emit('list_directory',
                this.remoteFilesystemPayload(pane, sessionId,
                    { remote_path: '/' }));
            this.updatePaneBadge(pane);

            this.setLoadingTimeout(pane);

        } else if (value.startsWith('qc:')) {
            const connectionId = value.substring(3);
            const qc = this.quickConnections.find(c => c.connectionId === connectionId);

            state.type = 'ssh';
            state.sessionId = null;
            state.connectionId = connectionId;

            if (qc) {
                state.hostInfo = { host: qc.host, username: qc.username, port: qc.port };
            }

            this.socket.emit('get_home_directory',
                this.remoteFilesystemPayload(pane, connectionId));
            this.socket.emit('list_directory',
                this.remoteFilesystemPayload(pane, connectionId,
                    { remote_path: '/' }));
            this.updatePaneBadge(pane);

            this.setLoadingTimeout(pane);
        }
    }

    setLoadingTimeout(pane, timeout = 10000) {
        const state = this.panes[pane];

        if (state.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
        }

        state.loadingTimeout = setTimeout(() => {
            if (state.loading) {
                state.loading = false;
                state.error = this.t('fm.connectionTimeout', 'Connection timeout - could not load directory');
                this.renderPane(pane);
                this.showNotification(this.t('fm.loadTimeout', 'Failed to load directory: timeout'), 'error');
            }
        }, timeout);
    }

    /*
     * one place that names the host AND the directory, and it is written from
     * the same state the badge already reads -- no new source of truth, and the
     * footer badge is left in place because it also carries the connection-type
     * class the drop-target styling keys on.
     */
    updatePaneHead(pane) {
        const state = this.panes[pane];
        const title = document.getElementById(`fm${this.capitalize(pane)}Title`);
        const path = document.getElementById(`fm${this.capitalize(pane)}HeadPath`);
        const base = this.t('fm.filesTitle', 'Files');
        if (title) {
            let host = '';
            if (state.type === 'browser-local') {
                host = this.t('fm.yourComputer', 'Your Computer');
            } else if (state.hostInfo) {
                host = state.hostInfo.host;
            }
            title.textContent = host ? `${base} · ${host}` : base;
        }
        // The inline panel's path is an INPUT (fm<Pane>Path); keeping it in
        // step here means every route that lands a new path -- navigation,
        // refresh, a server push -- shows it without its own call.
        if (state.type) {
            this.updatePathInput(pane, state.path || '/');
        }
        if (path) {
            path.textContent = state.type ? (state.path || '/') : '';
        }
    }

    updatePaneBadge(pane) {
        this.updatePaneHead(pane);
        const state = this.panes[pane];
        const badge = document.getElementById(`fm${this.capitalize(pane)}Badge`);

        if (!state.type) {
            badge.textContent = '';
            badge.className = 'fm-host-badge';
            return;
        }

        if (state.type === 'browser-local') {
            badge.textContent = this.t('fm.yourComputer', 'Your Computer');
            badge.className = 'fm-host-badge browser';
        } else if (state.hostInfo) {
            badge.textContent = `${state.hostInfo.username}@${state.hostInfo.host}`;
            badge.className = 'fm-host-badge ssh';
        }
    }

    openQuickConnect() {
        if (this.socket) {
            this.socket.emit('list_profiles');
            this.socket.once('profiles_list', (data) => {
                const select = document.getElementById('fmQcProfile');
                select.innerHTML =
                    `<option value="">${this.escapeHtml(this.t('fm.enterManually', '-- Enter manually --'))}</option>`;
                this.qcProfiles = data.profiles || [];
                this.qcProfiles.forEach(profile => {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = `${profile.name} (${profile.username}@${profile.host})`;
                    select.appendChild(option);
                });
            });

            this.socket.emit('list_keys');
            this.socket.once('keys_list', (data) => {
                const select = document.getElementById('fmQcKeySelect');
                select.innerHTML =
                    `<option value="">${this.escapeHtml(this.t('fm.selectKey', '-- Select Key --'))}</option>`;
                this.qcKeys = data.keys || [];
                this.qcKeys.forEach(key => {
                    const option = document.createElement('option');
                    option.value = key.id;
                    option.textContent = `${key.name} (${key.type || 'unknown'})`;
                    select.appendChild(option);
                });
            });
        }

        if (window.ModalManager) {
            window.ModalManager.open(this.qcModal);
        } else {
            this.qcModal.classList.add('show');
            this.qcModal.setAttribute('aria-hidden', 'false');
        }
        document.getElementById('fmQcHost').focus();
    }

    onProfileSelect(profileId) {
        if (!profileId) {
            document.getElementById('fmQcHost').value = '';
            document.getElementById('fmQcPort').value = '22';
            document.getElementById('fmQcUsername').value = '';
            document.getElementById('fmQcPassword').value = '';
            return;
        }

        const profile = (this.qcProfiles || []).find(p => p.id == profileId);
        if (!profile) return;

        document.getElementById('fmQcHost').value = profile.host || '';
        document.getElementById('fmQcPort').value = profile.port || 22;
        document.getElementById('fmQcUsername').value = profile.username || '';

        const authType = profile.key_id ? 'key' : 'password';
        document.querySelector(`input[name="fmQcAuth"][value="${authType}"]`).checked = true;
        document.getElementById('fmQcPasswordGroup').classList.toggle('hidden', authType !== 'password');
        document.getElementById('fmQcKeyGroup').classList.toggle('hidden', authType !== 'key');

        if (profile.key_id) {
            document.getElementById('fmQcKeySelect').value = profile.key_id;
        }

        if (authType === 'password') {
            document.getElementById('fmQcPassword').focus();
        }
    }

    closeQuickConnect() {
        if (window.ModalManager) {
            window.ModalManager.close(this.qcModal);
            if (this.modal.classList.contains('show')) {
                window.ModalManager.activeModal = this.modal;
            }
        } else {
            this.qcModal.classList.remove('show');
            this.qcModal.setAttribute('aria-hidden', 'true');
        }
        this.pendingQuickConnectPane = null;
        document.getElementById('fmQcForm').reset();
        document.getElementById('fmQcProfile').value = '';
        document.getElementById('fmQcPasswordGroup').classList.remove('hidden');
        document.getElementById('fmQcKeyGroup').classList.add('hidden');
    }

    submitQuickConnect() {
        const host = document.getElementById('fmQcHost').value.trim();
        const port = parseInt(document.getElementById('fmQcPort').value) || 22;
        const username = document.getElementById('fmQcUsername').value.trim();
        const authType = document.querySelector('input[name="fmQcAuth"]:checked').value;
        const password = document.getElementById('fmQcPassword').value;
        const keyId = document.getElementById('fmQcKeySelect').value;

        if (!host || !username) {
            this.showNotification(this.t('fm.qc.hostRequired', 'Host and username are required'), 'warning');
            return;
        }

        if (authType === 'password' && !password) {
            this.showNotification(this.t('fm.qc.passwordRequired', 'Password is required'), 'warning');
            return;
        }

        if (authType === 'key' && !keyId) {
            this.showNotification(this.t('fm.qc.selectSshKey', 'Please select an SSH key'), 'warning');
            return;
        }

        const data = { host, port, username };
        if (authType === 'password') {
            data.password = password;
        } else {
            data.key_id = keyId;
        }

        this.socket.emit('quick_connect', data);
        this.showNotification(this.t('fm.connecting', 'Connecting...'), 'info');
    }

    handleQuickConnectSuccess(data) {
        this.showNotification(`${this.t('fm.connected', 'Connected')}: ${data.host}`, 'success');

        const qc = {
            connectionId: data.connection_id,
            host: data.host,
            port: data.port,
            username: data.username
        };
        this.quickConnections.push(qc);

        this.updateSessionLists();

        if (this.pendingQuickConnectPane) {
            const pane = this.pendingQuickConnectPane;
            const state = this.panes[pane];

            state.type = 'ssh';
            state.sessionId = null;
            state.connectionId = data.connection_id;
            state.hostInfo = { host: data.host, username: data.username, port: data.port };

            const select = document.getElementById(`fm${this.capitalize(pane)}Source`);
            select.value = `qc:${data.connection_id}`;

            state.loading = true;
            this.renderPane(pane);
            this.socket.emit('get_home_directory',
                this.remoteFilesystemPayload(pane, data.connection_id));
            this.socket.emit('list_directory',
                this.remoteFilesystemPayload(pane, data.connection_id,
                    { remote_path: '/' }));
            this.setLoadingTimeout(pane);

            this.updatePaneBadge(pane);
        }

        this.closeQuickConnect();
    }

    async navigatePaneTo(pane, path) {
        const state = this.panes[pane];

        if (!state.type) {
            this.showNotification(this.t('fm.selectSourceFirst', 'Please select a source first'), 'warning');
            return;
        }

        state.selected.clear();
        state.loading = true;
        this.renderPane(pane);

        if (state.type === 'browser-local') {
            try {
                await this.browserFS.navigateTo(path);
                state.path = this.browserFS.getCurrentPath();
                state.files = await this.browserFS.listDirectory();
                state.loading = false;
                this.updatePathInput(pane, state.path);
                this.renderPane(pane);
            } catch (e) {
                this.showNotification(`${this.t('fm.cannotNavigate', 'Cannot navigate to')} ${path}`, 'error');
                state.loading = false;
                this.renderPane(pane);
            }
        } else if (state.type === 'ssh') {
            const sessionId = state.sessionId || state.connectionId;
            this.requestPaneListing(pane, sessionId, path);
            this.setLoadingTimeout(pane);
        }
    }

    async navigatePaneUp(pane) {
        const state = this.panes[pane];

        if (!state.type) return;

        if (state.type === 'browser-local') {
            const navigated = await this.browserFS.navigateUp();
            if (navigated) {
                await this.refreshBrowserPane(pane);
            }
        } else if (state.type === 'ssh') {
            if (state.path === '/') return;
            const parentPath = state.path.split('/').slice(0, -1).join('/') || '/';
            this.navigatePaneTo(pane, parentPath);
        }
    }

    navigatePaneHome(pane) {
        const state = this.panes[pane];

        if (!state.type) return;

        if (state.type === 'browser-local') {
            this.browserFS.currentHandle = this.browserFS.rootHandle;
            this.browserFS.pathStack = [this.browserFS.rootHandle.name];
            this.refreshBrowserPane(pane);
        } else if (state.type === 'ssh') {
            const homePath = state.homePath || '/';
            this.navigatePaneTo(pane, homePath);
        }
    }

    async navigateIntoDir(pane, dirName) {
        const state = this.panes[pane];

        if (state.type === 'browser-local') {
            try {
                await this.browserFS.navigateInto(dirName);
                await this.refreshBrowserPane(pane);
            } catch (e) {
                this.showNotification(`${this.t('fm.cannotOpen', 'Cannot open')} ${dirName}`, 'error');
            }
        } else if (state.type === 'ssh') {
            const newPath = state.path === '/' ? '/' + dirName : state.path + '/' + dirName;
            this.navigatePaneTo(pane, newPath);
        }
    }

    async refreshPane(pane) {
        const state = this.panes[pane];

        if (!state.type) return;

        if (state.type === 'browser-local') {
            state.loading = true;
            this.renderPane(pane);
            await this.refreshBrowserPane(pane);
        } else if (state.type === 'ssh') {
            const sessionId = state.sessionId || state.connectionId;
            if (!sessionId) return;

            if (state.sessionId && typeof SessionManager !== 'undefined') {
                const sessions = SessionManager.getAllSessions();
                const sessionExists = sessions.some(s => s.id === state.sessionId && s.connected);
                if (!sessionExists) {
                    this.resetPane(pane);
                    return;
                }
            }

            state.loading = true;
            this.renderPane(pane);
            this.requestPaneListing(pane, sessionId, state.path);
            this.setLoadingTimeout(pane);
        }
    }

    async refreshBrowserPane(pane) {
        const state = this.panes[pane];
        try {
            state.files = await this.browserFS.listDirectory();
            state.path = this.browserFS.getCurrentPath();
            state.loading = false;
            this.updatePathInput(pane, state.path);
            this.renderPane(pane);
        } catch (e) {
            this.showNotification(this.t('fm.errorReadingDir', 'Error reading directory'), 'error');
            state.loading = false;
            this.renderPane(pane);
        }
    }

    refreshBothPanes() {
        this.refreshPane('left');
        this.refreshPane('right');
    }

    resetPane(pane) {
        const state = this.panes[pane];
        if (state.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
        }
        Object.assign(state, this.createEmptyPaneState());
        const select = document.getElementById(`fm${this.capitalize(pane)}Source`);
        if (select) select.value = '';
        this.updatePathInput(pane, '/');
        this.updatePaneBadge(pane);
        this.renderPane(pane);
    }

    updatePathInput(pane, path) {
        // The inline pane has no editable path input (the path is a read-only
        // head element); the existing panes have fm${cap}Path text inputs.
        const el = document.getElementById(`fm${this.capitalize(pane)}Path`);
        if (el) el.value = path;
    }

    renderPane(pane) {
        const state = this.panes[pane];
        const container = document.getElementById(`fm${this.capitalize(pane)}List`);

        if (state.loading) {
            container.innerHTML = `
                <div class="fm-loading">
                    <div class="fm-loading-spinner"></div>
                    ${this.t('fm.loading', 'Loading...')}
                </div>
            `;
            this.updatePaneStatus(pane);
            return;
        }

        if (state.error) {
            container.innerHTML = `
                <div class="fm-error">
                    <svg class="icon fm-error-icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-circle-alert"></use></svg>
                    <div class="fm-error-text">${this.escapeHtml(state.error)}</div>
                    <button class="btn btn-secondary btn-sm fm-error-retry" data-pane="${pane}">
                        <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-refresh-cw"></use></svg>
                        ${this.t('fm.retry', 'Retry')}
                    </button>
                </div>
            `;
            container.querySelector('.fm-error-retry')?.addEventListener('click', () => {
                state.error = null;
                this.refreshPane(pane);
            });
            this.updatePaneStatus(pane);
            return;
        }

        if (!state.type) {
            // Per-END wording: the right pane is the DESTINATION, so its empty
            // state must not ask for a source.
            const prompt = pane === 'right'
                ? this.t('fm.selectDestinationAbove', 'Select a destination above')
                : this.t('fm.selectSourceAbove', 'Select a source above');
            container.innerHTML = `
                <div class="fm-empty">
                    <svg class="icon fm-empty-icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-open"></use></svg>
                    <div class="fm-empty-text">${this.escapeHtml(prompt)}</div>
                </div>
            `;
            this.updatePaneStatus(pane);
            return;
        }

        if (state.files.length === 0) {
            container.innerHTML = `
                <div class="fm-empty">
                    <svg class="icon fm-empty-icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-folder-open"></use></svg>
                    <div class="fm-empty-text">${this.t('fm.emptyDirectory', 'Empty directory')}</div>
                </div>
            `;
            this.updatePaneStatus(pane);
            return;
        }

        const sortedFiles = [...state.files].sort((a, b) => {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
            return a.name.localeCompare(b.name);
        });

        const indexMap = new Map();
        sortedFiles.forEach((file, sortedIndex) => {
            const originalIndex = state.files.indexOf(file);
            indexMap.set(sortedIndex, originalIndex);
        });

        let html = '';

        if (state.path !== '/' && !(state.type === 'browser-local' && this.browserFS.pathStack.length <= 1)) {
            html += `
                <div class="fm-file-item directory" data-index="-1" data-type="parent">
                    <svg class="icon fm-file-icon parent" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-arrow-up"></use></svg>
                    <div class="fm-file-info">
                        <strong class="fm-file-name">..</strong>
                        <small class="fm-file-meta">${this.t('fm.parentDirectory', 'Parent directory')}</small>
                    </div>
                    ${this.spriteIcon('chevron-right', 'fm-file-chevron')}
                </div>
            `;
        }

        html += sortedFiles.map((file, sortedIndex) => {
            const originalIndex = indexMap.get(sortedIndex);
            const icon = file.is_dir ? 'folder' : this.getFileIcon(file.name);
            return `
                <div class="fm-file-item ${file.is_dir ? 'directory' : ''} ${state.selected.has(originalIndex) ? 'selected' : ''}"
                     data-index="${originalIndex}"
                     data-type="${file.is_dir ? 'directory' : 'file'}"
                     draggable="true">
                    ${this.spriteIcon(icon, `fm-file-icon ${file.is_dir ? 'folder' : 'file'}`)}
                    <div class="fm-file-info">
                        <strong class="fm-file-name">${this.escapeHtml(file.name)}</strong>
                        <small class="fm-file-meta">${file.is_dir
                            ? this.t('fm.folder', 'Folder')
                            : this.formatSize(file.size || 0)}${file.permissions
                                ? ' · ' + this.escapeHtml(file.permissions) : ''}</small>
                    </div>
                    ${file.is_dir
                        ? this.spriteIcon('chevron-right', 'fm-file-chevron')
                        : '<span class="fm-file-chevron-spacer" aria-hidden="true"></span>'}
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        container.querySelectorAll('.fm-file-item').forEach(item => {
            const index = parseInt(item.dataset.index);
            item.addEventListener('click', (e) => this.handleItemClick(e, pane, index));
            item.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleItemDblClick(pane, index);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, pane, index));
            item.addEventListener('dragstart', (e) => this.handleDragStart(e, pane, index));
        });

        this.updatePaneStatus(pane);
    }

    handleItemClick(e, pane, index) {
        e.stopPropagation();
        this.setActivePane(pane);

        if (index === -1) return;

        const state = this.panes[pane];

        if (e.ctrlKey || e.metaKey) {
            if (state.selected.has(index)) {
                state.selected.delete(index);
            } else {
                state.selected.add(index);
            }
        } else if (e.shiftKey && state.lastSelected !== -1) {
            const start = Math.min(state.lastSelected, index);
            const end = Math.max(state.lastSelected, index);
            for (let i = start; i <= end; i++) {
                state.selected.add(i);
            }
        } else {
            state.selected.clear();
            state.selected.add(index);
        }

        state.lastSelected = index;
        this.updateSelectionVisual(pane);
    }

    handleItemDblClick(pane, index) {
        const state = this.panes[pane];
        console.log('[SFTP] handleItemDblClick called:', { pane, index, type: state.type, sessionId: state.sessionId, connectionId: state.connectionId });

        if (index === -1) {
            this.navigatePaneUp(pane);
            return;
        }

        const file = state.files[index];
        if (!file) {
            console.log('[SFTP] No file at index:', index);
            return;
        }

        console.log('[SFTP] File info:', { name: file.name, is_dir: file.is_dir });

        if (file.is_dir) {
            this.navigateIntoDir(pane, file.name);
        } else {
            if (state.type === 'ssh') {
                const sessionId = state.sessionId || state.connectionId;
                const filePath = this.joinPath(state.path, file.name);
                console.log('[SFTP] Opening preview:', { sessionId, filePath, hasFilePreview: !!window.FilePreview });
                if (window.FilePreview) {
                    window.FilePreview.open(sessionId, filePath, file.name);
                } else {
                    console.error('[SFTP] FilePreview not available');
                }
            } else if (state.type === 'browser-local') {
                this.showNotification(this.t('fm.localPreviewUnsupported',
                    'Local file preview is not supported yet'), 'info');
            } else {
                console.log('[SFTP] Unknown state type for preview:', state.type);
            }
        }
    }

    updateSelectionVisual(pane) {
        const state = this.panes[pane];
        const container = document.getElementById(`fm${this.capitalize(pane)}List`);

        container.querySelectorAll('.fm-file-item').forEach(item => {
            const idx = parseInt(item.dataset.index);
            if (idx >= 0) {
                item.classList.toggle('selected', state.selected.has(idx));
            }
        });

        this.updatePaneStatus(pane);
    }

    setActivePane(pane) {
        /*
         * On a phone the modal shows one pane at a time. That is a SIZING
         * decision, not a capability one: in server-to-server transfer mode the
         * user must still be able to reach the source pane, so the pane tabs
         * choose which of the two is showing. Only outside transfer mode does
         * the phone pin itself to the single right-hand pane.
         */
        if (this.isMobile() && !this.isTransferMode()) {
            pane = 'right';
        }

        this.activePane = pane;
        document.getElementById('fmLeftPane').classList.toggle('active', pane === 'left');
        document.getElementById('fmRightPane').classList.toggle('active', pane === 'right');
        this.updateMobilePaneTabs(pane);
    }

    isTransferMode() {
        return !!this.modal?.classList.contains('fm-transfer-mode');
    }

    /*
     * isMobile — "this surface must show ONE pane at a time".
     *
     * Width alone was wrong for a landscape phone. At 844x390 the width test
     * passed (844 >= 768) so the surface used the wide two-pane layout, while the
     * CSS's `max-width: 900px` rule stacked those two panes vertically inside
     * 390px of height. Each pane ended up ~34px tall and eight path controls sat
     * outside the viewport: the surface was unusable in that orientation.
     *
     * A viewport too SHORT for two stacked panes is as single-pane as one too
     * narrow for two side-by-side ones, so the height is part of the test. The
     * 620px floor matches the CSS media query that owns the stacked layout, so
     * the JS tier and the CSS tier cannot disagree.
     */
    isMobile() {
        return window.innerWidth < 768 || window.innerHeight < 620;
    }

    updateMobilePaneTabs(pane) {
        // aria-selected and the roving tabindex move with the visual .active
        // state; a tablist whose selection is only a CSS class tells assistive
        // technology nothing about which end of the transfer is showing.
        document.querySelectorAll('.fm-pane-tab').forEach(tab => {
            const selected = tab.dataset.pane === pane;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.setAttribute('tabindex', selected ? '0' : '-1');
        });
    }

    setupLongPress() {
        let longPressTimer = null;
        const longPressDuration = 500;

        ['left', 'right'].forEach(pane => {
            const listEl = document.getElementById(`fm${this.capitalize(pane)}List`);

            listEl.addEventListener('touchstart', (e) => {
                const item = e.target.closest('.fm-file-item');
                if (!item) return;

                longPressTimer = setTimeout(() => {
                    e.preventDefault();
                    const index = parseInt(item.dataset.index);
                    this.setActivePane(pane);
                    this.panes[pane].selected.clear();
                    this.panes[pane].selected.add(index);
                    this.updateSelectionVisual(pane);
                    this.showActionSheet();
                }, longPressDuration);
            }, { passive: false });

            listEl.addEventListener('touchend', () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            });

            listEl.addEventListener('touchmove', () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            });
        });
    }

    showActionSheet() {
        const sheet = document.getElementById('fmActionSheet');
        if (sheet) {
            sheet.classList.add('visible');
        }
    }

    hideActionSheet() {
        const sheet = document.getElementById('fmActionSheet');
        if (sheet) {
            sheet.classList.remove('visible');
        }
    }

    handleActionSheetAction(action) {
        this.hideActionSheet();

        switch (action) {
            case 'open':
                const state = this.panes[this.activePane];
                if (state.selected.size === 1) {
                    const index = Array.from(state.selected)[0];
                    const file = state.files[index];
                    if (file && file.is_dir) {
                        this.navigateToFile(this.activePane, file);
                    }
                }
                break;
            case 'download':
                this.downloadSelected();
                break;
            case 'transfer':
                this.executeTransfer();
                break;
            case 'rename':
                this.renameSelected();
                break;
            case 'newfolder':
                this.createNewFolder();
                break;
            case 'delete':
                this.deleteSelected();
                break;
            case 'cancel':
                break;
        }
    }

    handleMobileUpload(e) {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        const state = this.panes[this.activePane];
        console.log('[FM] Mobile upload - activePane:', this.activePane, 'state:', {
            type: state.type,
            sessionId: state.sessionId,
            connectionId: state.connectionId,
            path: state.path
        });

        if (!state.type) {
            this.showNotification(this.t('fm.selectConnectionFirst', 'Please select a connection first'), 'warning');
            return;
        }

        if (state.type === 'ssh') {
            const sessionId = state.sessionId || state.connectionId;
            if (!sessionId) {
                this.showNotification(this.t('fm.noActiveConnection', 'No active connection'), 'error');
                return;
            }

            console.log('[FM] Starting upload of', files.length, 'files to', state.path, 'via session', sessionId);
            this.showNotification(`${this.t('fm.uploading', 'Uploading')} ${files.length} ${this.t('fm.files', 'file(s)')}...`, 'info');

            Array.from(files).forEach(file => {
                this.uploadFileToBrowser(file, state.path, sessionId);
            });
        } else {
            this.showNotification(this.t('fm.uploadSSHOnly', 'Upload only available for SSH connections'), 'warning');
        }

        e.target.value = '';
    }

    uploadFileToBrowser(file, remotePath, sessionId) {
        const self = this;

        const fullRemotePath = remotePath.endsWith('/')
            ? remotePath + file.name
            : remotePath + '/' + file.name;

        console.log('[FM] Starting HTTP upload:', file.name, 'size:', file.size, 'to:', fullRemotePath);

        const transferId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        self.queueTransfer({
            id: transferId,
            type: 'upload',
            filename: file.name,
            size: file.size,
            source: 'local',
            destination: remotePath
        });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('session_id', sessionId);
        formData.append('remote_path', fullRemotePath);

        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
            || document.querySelector('input[name="csrf_token"]')?.value;
        const headers = {};
        if (csrfToken) {
            headers['X-CSRFToken'] = csrfToken;
        }

        fetch((window.APP_ROOT || '') + '/api/upload', {
            method: 'POST',
            body: formData,
            headers: headers,
            credentials: 'same-origin'
        })
        .then(response => response.json().then(data => ({ status: response.status, data })))
        .then(({ status, data }) => {
            if (status === 200 && data.success) {
                self.completeTransferById(transferId);
                self.refreshPane(self.activePane);
                self.showNotification(`${file.name} ${self.t('fm.uploaded', 'uploaded')}`, 'success');
            } else {
                self.failTransferById(transferId, data.error || 'Upload failed');
                self.showNotification(`${self.t('fm.uploadError', 'Upload error')}: ${data.error || self.t('fm.unknown', 'Unknown')}`, 'error');
            }
        })
        .catch(err => {
            console.error('[FM] Upload error:', err);
            self.failTransferById(transferId, err.message);
            self.showNotification(`${self.t('fm.uploadError', 'Upload error')}: ${err.message}`, 'error');
        });
    }

    selectAll() {
        const state = this.panes[this.activePane];
        state.files.forEach((_, index) => state.selected.add(index));
        this.updateSelectionVisual(this.activePane);
    }

    createNewFolder() {
        const state = this.panes[this.activePane];

        if (!state.type) {
            this.showNotification(this.t('fm.selectSourceFirst', 'Please select a source first'), 'warning');
            return;
        }

        const name = prompt(this.t('fm.enterFolderName', 'Enter folder name:'));
        if (!name) return;

        if (name.includes('/') || name.includes('\\')) {
            this.showNotification(this.t('fm.invalidFolderName', 'Invalid folder name'), 'error');
            return;
        }

        if (state.type === 'browser-local') {
            this.browserFS.createDirectory(name)
                .then(() => {
                    this.showNotification(`${this.t('fm.folderCreated', 'Folder created')}: ${name}`, 'success');
                    this.refreshBrowserPane(this.activePane);
                })
                .catch(e => this.showNotification(`${this.t('common.error', 'Error')}: ${e.message}`, 'error'));
        } else if (state.type === 'ssh') {
            const path = state.path === '/' ? '/' + name : state.path + '/' + name;
            const sessionId = state.sessionId || state.connectionId;
            this.socket.emit('create_directory', { session_id: sessionId, remote_path: path });
        }
    }

    deleteSelected() {
        const state = this.panes[this.activePane];

        if (state.selected.size === 0) {
            this.showNotification(this.t('fm.noItemsSelected', 'No items selected'), 'warning');
            return;
        }

        const items = Array.from(state.selected).map(i => state.files[i]).filter(f => f);
        const names = items.map(f => f.name).join(', ');

        if (!confirm(`${this.t('fm.confirmDelete', 'Delete')} ${items.length} ${this.t('fm.items', 'item(s)')}?\n\n${names}\n\n${this.t('fm.cannotBeUndone', 'This cannot be undone!')}`)) {
            return;
        }

        if (state.type === 'browser-local') {
            Promise.all(items.map(item => this.browserFS.deleteEntry(item.name)))
                .then(() => {
                    this.showNotification(this.t('fm.itemsDeleted', 'Items deleted'), 'success');
                    state.selected.clear();
                    this.refreshBrowserPane(this.activePane);
                })
                .catch(e => this.showNotification(`${this.t('common.error', 'Error')}: ${e.message}`, 'error'));
        } else if (state.type === 'ssh') {
            const sessionId = state.sessionId || state.connectionId;
            items.forEach(item => {
                const path = state.path === '/' ? '/' + item.name : state.path + '/' + item.name;
                this.socket.emit('delete_item', { session_id: sessionId, path: path });
            });
            state.selected.clear();
        }
    }

    renameSelected() {
        const state = this.panes[this.activePane];

        if (state.selected.size !== 1) {
            this.showNotification(this.t('fm.selectOneToRename', 'Select exactly one item to rename'), 'warning');
            return;
        }

        const index = Array.from(state.selected)[0];
        const file = state.files[index];
        if (!file) return;

        const newName = prompt(this.t('fm.enterNewName', 'Enter new name:'), file.name);
        if (!newName || newName === file.name) return;

        if (newName.includes('/') || newName.includes('\\')) {
            this.showNotification(this.t('fm.invalidName', 'Invalid name'), 'error');
            return;
        }

        if (state.type === 'browser-local') {
            this.browserFS.rename(file.name, newName)
                .then(() => {
                    this.showNotification(this.t('fm.renamedSuccess', 'Renamed successfully'), 'success');
                    this.refreshBrowserPane(this.activePane);
                })
                .catch(e => this.showNotification(`${this.t('common.error', 'Error')}: ${e.message}`, 'error'));
        } else if (state.type === 'ssh') {
            const sessionId = state.sessionId || state.connectionId;
            const oldPath = state.path === '/' ? '/' + file.name : state.path + '/' + file.name;
            const newPath = state.path === '/' ? '/' + newName : state.path + '/' + newName;
            this.socket.emit('rename_file', { session_id: sessionId, old_path: oldPath, new_path: newPath });
        }
    }

    /*
     * executeTransfer — copy the SOURCE pane's selection to the DESTINATION pane.
     *
     * DIRECTION IS FIXED: left pane is always
     * Source, right pane is always Destination. It used to read
     * `this.activePane` as the source, which is a real data-loss defect on a
     * phone: the tabs switch which pane is *visible*, so a user who selected
     * files under "Source", tabbed to "Destination" to check the target folder,
     * and pressed Transfer copied right-to-left — the opposite direction, with
     * the destination's contents overwriting the source's. On the desktop the
     * same bug fired whenever the last-clicked pane was the right one.
     *
     * The selection is sent SERIALLY: one item, await its ack, await its terminal
     * state, then the next. Firing them together made concurrent progress events
     * overwrite each other's rows.
     */
    async executeTransfer() {
        const sourcePane = 'left';
        const targetPane = 'right';

        const source = this.panes[sourcePane];
        const target = this.panes[targetPane];

        if (!source.type || !target.type) {
            this.showNotification(this.t('fm.bothPanesRequired', 'Both panes must have a source selected'), 'warning');
            return;
        }

        if (source.selected.size === 0) {
            this.showNotification(this.t('fm.noItemsForTransfer', 'No items selected for transfer'), 'warning');
            return;
        }

        const selectedItems = Array.from(source.selected)
            .map(i => source.files[i])
            .filter(f => f);

        if (selectedItems.length === 0) {
            this.showNotification(this.t('fm.noValidItems', 'No valid items selected'), 'warning');
            return;
        }

        const transferType = `${source.type}-to-${target.type}`;
        this.showNotification(`${this.t('fm.startingTransfer', 'Starting transfer of')} ${selectedItems.length} ${this.t('fm.items', 'item(s)')}...`, 'info');

        /*
         * Fence this batch to the surface state it was started against. `source`
         * and `target` above are the pane objects as they are RIGHT NOW; a reopen
         * swaps in fresh ones (resetTransferSurfaceState). Re-checking the epoch
         * before every item is what stops this loop from continuing to copy
         * against hosts and paths that are no longer on screen.
         */
        const epoch = this.batchEpoch;
        // Identity, not just the epoch: two batches can legitimately run in the
        // same epoch (a drop, then a Transfer press), and epoch equality alone let
        // the first one to finish clear the marker belonging to the second.
        const batch = {
            epoch,
            total: selectedItems.length,
            transferType,
            sourceSessionId: source.sessionId || source.connectionId || null,
            destSessionId: target.sessionId || target.connectionId || null,
        };
        this.activeBatch = batch;

        for (const item of selectedItems) {
            if (this.batchEpoch !== epoch) {
                // The surface was reset (reopened) under this batch. Stop rather
                // than start another copy from state the user can no longer see.
                break;
            }
            const sourcePath = source.path === '/' ? '/' + item.name : source.path + '/' + item.name;
            const targetPath = target.path === '/' ? '/' + item.name : target.path + '/' + item.name;

            switch (transferType) {
                case 'browser-local-to-ssh':
                    await this.transferBrowserToSSH(item, targetPath, target);
                    break;

                case 'ssh-to-browser-local':
                    await this.transferSSHToBrowser(sourcePath, source, item.name);
                    break;

                case 'ssh-to-ssh': {
                    const transferId = await this.transferSSHtoSSH(
                        sourcePath, source, targetPath, target, item);
                    if (!transferId) {
                        // This item never started. Earlier items keep whatever
                        // state they reached; later items are still attempted,
                        // because one rejected file (a name clash, a size limit)
                        // is not a reason to silently drop the rest of the
                        // selection.
                        break;
                    }
                    const outcome = await this.waitForS2STerminal(transferId);
                    if (outcome === 'cancelled') {
                        // A cancel is a deliberate stop of THIS batch: continuing
                        // would start the very copies the user just stopped.
                        this.showNotification(
                            this.t('fm.transferBatchCancelled',
                                   'Transfer cancelled'), 'info');
                        if (this.activeBatch === batch) this.activeBatch = null;
                        return;
                    }
                    break;
                }

                default:
                    this.showNotification(`${this.t('fm.transferNotSupported', 'Transfer type not supported')}: ${transferType}`, 'error');
            }
        }

        // Only the CURRENT batch may clear the marker. A superseded loop reaching
        // here must not erase the state of the batch that replaced it.
        if (this.activeBatch === batch) this.activeBatch = null;
    }

    async transferBrowserToSSH(item, targetPath, targetPane) {
        const sessionId = targetPane.sessionId || targetPane.connectionId;

        if (item.is_dir) {
            await this.uploadBrowserFolderToSSH(item.handle, targetPath, sessionId);
        } else {
            try {
                const data = await this.browserFS.readFile(item.handle);
                this.socket.emit('upload_file_binary', {
                    session_id: sessionId,
                    filename: item.name,
                    file_data: data,
                    remote_path: targetPath
                });
                this.queueTransfer({
                    type: 'upload',
                    filename: item.name,
                    targetPath: targetPath,
                    size: data.byteLength
                });
            } catch (e) {
                this.showNotification(`${this.t('fm.failedToRead', 'Failed to read')} ${item.name}: ${e.message}`, 'error');
            }
        }
    }

    async uploadBrowserFolderToSSH(dirHandle, remotePath, sessionId) {
        this.socket.emit('create_directory', { session_id: sessionId, remote_path: remotePath });
        await new Promise(r => setTimeout(r, 100));

        for await (const entry of dirHandle.values()) {
            const entryPath = remotePath + '/' + entry.name;

            if (entry.kind === 'directory') {
                await this.uploadBrowserFolderToSSH(entry, entryPath, sessionId);
            } else {
                try {
                    const file = await entry.getFile();
                    const data = await file.arrayBuffer();
                    this.socket.emit('upload_file_binary', {
                        session_id: sessionId,
                        filename: entry.name,
                        file_data: data,
                        remote_path: entryPath
                    });
                    this.queueTransfer({
                        type: 'upload',
                        filename: entry.name,
                        targetPath: entryPath,
                        size: data.byteLength
                    });
                } catch (e) {
                    console.error('Failed to upload:', entry.name, e);
                }
            }
        }
    }

    async transferSSHToBrowser(sourcePath, sourcePane, filename) {
        const sessionId = sourcePane.sessionId || sourcePane.connectionId;

        this.pendingBrowserDownload = {
            filename: filename,
            callback: async (data) => {
                try {
                    await this.browserFS.writeFile(filename, data);
                    this.showNotification(`${this.t('fm.saved', 'Saved')}: ${filename}`, 'success');
                    await this.refreshBrowserPane(this.activePane === 'left' ? 'right' : 'left');
                } catch (e) {
                    this.showNotification(`${this.t('fm.failedToSave', 'Failed to save')} ${filename}: ${e.message}`, 'error');
                }
            }
        };

        this.socket.emit('download_file_binary', {
            session_id: sessionId,
            remote_path: sourcePath
        });

        this.queueTransfer({
            type: 'download',
            filename: filename,
            sourcePath: sourcePath
        });
    }

    /*
     * transferSSHtoSSH — start ONE server-to-server transfer and bind it to the
     * Id the SERVER issued.
     *
     * The client no longer invents the transfer_id. It used to send
     * `s2s_${Date.now}_${random}`, which let any tab name a transfer, and
     * therefore cancel one it did not own, and let two tabs collide on one id.
     * The payload carries no id at all now: the server creates the record, and
     * the ack returns {success, transfer_id}. Only then does a queue row exist,
     * so every row on screen corresponds to a transfer the server really owns.
     *
     * Resolves to the server transfer id, or null when the transfer never
     * started (same host, refused ack, missing ack, dead socket).
     */
    async transferSSHtoSSH(sourcePath, sourcePane, targetPath, targetPane, item) {
        const sourceSessionId = sourcePane.sessionId || sourcePane.connectionId;
        const targetSessionId = targetPane.sessionId || targetPane.connectionId;

        if (sourceSessionId === targetSessionId) {
            this.showNotification(this.t('fm.cannotTransferSameHost', 'Cannot transfer to same host. Use rename instead.'), 'warning');
            return null;
        }

        const acknowledgement = await this.emitWithAck('transfer_server_to_server', {
            source_session_id: sourceSessionId,
            source_path: sourcePath,
            dest_session_id: targetSessionId,
            dest_path: targetPath,
            is_dir: item.is_dir
        }, this.EARLY_ACK_TIMEOUT_MS);

        // A refused or absent ack means no record exists server-side. Queueing a
        // row anyway would leave it stuck at "Waiting..." forever, with a Cancel
        // button for an id no server knows.
        if (!acknowledgement || !acknowledgement.success || !acknowledgement.transfer_id) {
            const reason = acknowledgement?.error
                || this.t('fm.transferRejected', 'Transfer was not accepted');
            this.showNotification(`${this.escapeHtml(item.name)}: ${reason}`, 'error');
            return null;
        }

        this.queueTransfer({
            id: acknowledgement.transfer_id,
            type: 's2s',
            filename: item.name,
            sourcePath: sourcePath,
            targetPath: targetPath,
            size: item.size || 0
        });

        return acknowledgement.transfer_id;
    }

    /*
     * EARLY-EVENT BUFFER.
     *
     * The server starts the worker BEFORE its ack callback returns to this
     * client, so started / progress / complete / error can all arrive for a
     * transfer whose queue row does not exist yet. A small file finishes in
     * microseconds, so this is the common case, not a rare race. Without a
     * buffer those events hit `findTerminalizableTransfer`, find no row, and are
     * dropped: the row then appears afterwards and sits at "Waiting..." forever,
     * with waitForS2STerminal never resolving, which stalls the whole serial
     * queue.
     *
     * bufferEarlyS2SEvent returns true when it took ownership of the event, so
     * the listener returns without applying it. queueTransfer drains the buffer
     * for its id immediately after the row exists, preserving arrival order, so
     * the monotonic terminal guard still decides exactly one winner.
     *
     * BOUNDED AND EXPIRING. The old shape keyed
     * `transfer_id -> [events]` and capped only the EVENTS PER ID (50, with
     * terminal events unlimited). That left three gaps:
     *   * a hostile or buggy peer could create arbitrarily many DISTINCT ids and
     *     each would grow a new map entry — unbounded in the id dimension;
     *   * nothing ever expired, so an entry for an id whose ack never arrives
     *     (network split, a refused ack) lived until the page unloaded;
     *   * the per-id cap counted events but kept every TERMINAL event forever.
     *
     * The new shape is `transfer_id -> { at, events }`:
     *   * a global cap on DISTINCT ids (MAX_EARLY_IDS) — once hit, the oldest
     *     entry is evicted before the newest is admitted;
     *   * a per-id TTL (EARLY_TTL_MS) measured from the id's first event — entries
     *     older than the TTL are dropped during a lazy sweep;
     *   * the per-id event cap (MAX_EARLY_EVENTS_PER_ID) now applies to ALL
     *     events, terminal included; terminal events are still admitted up to the
     *     cap and still win on drain.
     * Delivery is already owner-scoped server-side (the emitting socket's sid is
     * the room), so this buffer only accumulates events for transfers this tab
     * actually initiated; the bounds are the belt-and-braces guarantee.
     */
    bufferEarlyS2SEvent(kind, data) {
        const transferId = data?.transfer_id;
        if (transferId === undefined || transferId === null || transferId === '') {
            return false;
        }
        const known = this.transferQueue.some(
            t => String(t.id) === String(transferId));
        if (known) {
            return false;
        }
        if (!this.earlyS2SEvents) {
            this.earlyS2SEvents = new Map();
        }
        const key = String(transferId);
        const now = Date.now();

        // Expire entries whose TTL has elapsed. Map iteration order is insertion
        // order, so this walks oldest-first and stops at the first live entry.
        for (const [id, entry] of this.earlyS2SEvents) {
            if (now - entry.at > this.EARLY_TTL_MS) {
                this.earlyS2SEvents.delete(id);
            } else {
                break;
            }
        }

        // Global cap on DISTINCT ids: evict the oldest before admitting the newest,
        // so a flood of never-queued ids cannot grow the map without limit.
        if (!this.earlyS2SEvents.has(key) &&
                this.earlyS2SEvents.size >= this.MAX_EARLY_IDS) {
            const oldest = this.earlyS2SEvents.keys().next().value;
            this.earlyS2SEvents.delete(oldest);
        }

        let entry = this.earlyS2SEvents.get(key);
        if (!entry) {
            entry = { at: now, events: [] };
            this.earlyS2SEvents.set(key, entry);
        }
        // Per-id cap applies to every event, terminal included.
        if (entry.events.length < this.MAX_EARLY_EVENTS_PER_ID) {
            entry.events.push({ kind, data });
        }
        return true;
    }

    /*
     * drainEarlyS2SEvents — replay buffered events for one id, in arrival order.
     *
     * Called from queueTransfer once the row exists. Progress before a terminal
     * is applied first so the row's final percentage is not left behind a
     * completion, and the terminal guard makes any later duplicate a no-op.
     */
    drainEarlyS2SEvents(transferId) {
        if (!this.earlyS2SEvents) {
            return 0;
        }
        const key = String(transferId);
        const entry = this.earlyS2SEvents.get(key);
        if (!entry || !entry.events || entry.events.length === 0) {
            this.earlyS2SEvents.delete(key);
            return 0;
        }
        this.earlyS2SEvents.delete(key);
        const pending = entry.events;
        pending.forEach(({ kind, data }) => {
            if (kind === 'progress') {
                this.updateTransferProgress(data);
            } else if (kind === 'complete') {
                this.applyS2SComplete(data);
            } else if (kind === 'error') {
                this.applyS2SError(data);
            } else if (kind === 'cancelled') {
                this.cancelS2STransfer(data);
            }
        });
        return pending.length;
    }

    // The completion and error effects, split out of the socket listeners so the
    // buffer drain runs exactly the same code an on-time event would.
    applyS2SComplete(data) {
        this.showNotification(`${this.t('fm.transferComplete', 'Transfer complete')}: ${data.filename}`, 'success');
        this.refreshBothPanes();
        this.completeS2STransfer(data);
    }

    applyS2SError(data) {
        this.showNotification(`${this.t('fm.transferFailed', 'Transfer failed')}: ${data.error}`, 'error');
        this.failS2STransfer(data);
    }

    /*
     * emitWithAck — emit and resolve with the server's acknowledgement.
     *
     * Timed out rather than awaited forever: a socket that drops between the
     * emit and the ack would otherwise leave executeTransfer's serial loop
     * suspended, with the remaining selection never sent and no error shown.
     * Resolves null on timeout or when there is no usable socket.
     */
    emitWithAck(event, payload, timeoutMs = 15000) {
        if (!this.socket || typeof this.socket.emit !== 'function') {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            try {
                this.socket.emit(event, payload, (acknowledgement) => {
                    clearTimeout(timer);
                    finish(acknowledgement);
                });
            } catch (error) {
                clearTimeout(timer);
                finish(null);
            }
        });
    }

    /*
     * waitForS2STerminal — resolve when one transfer reaches a terminal state.
     *
     * The queue is serial (see executeTransfer), and "serial" has to mean
     * awaiting the SERVER's outcome, not just the ack: firing every selected
     * item at once made progress events from different files overwrite each
     * other's rows and let a directory copy start before the previous one had
     * released its SFTP channels.
     *
     * Terminal states are set by the socket listeners (complete/error/cancelled)
     * and by cancelS2STransfer, so this waits on the queue row rather than on a
     * particular event, and cannot miss an outcome that landed first.
     */
    waitForS2STerminal(transferId, pollMs = 100) {
        const terminal = ['complete', 'error', 'cancelled'];
        return new Promise((resolve) => {
            const check = () => {
                const transfer = this.transferQueue.find(
                    t => String(t.id) === String(transferId));
                // A row that vanished (queue cleared, surface reopened) is not
                // something to keep waiting on.
                if (!transfer) {
                    resolve(null);
                    return;
                }
                if (terminal.includes(transfer.status)) {
                    resolve(transfer.status);
                    return;
                }
                setTimeout(check, pollMs);
            };
            check();
        });
    }

    handleDrop(e, targetPane) {
        const files = e.dataTransfer.files;
        const items = e.dataTransfer.items;
        const target = this.panes[targetPane];

        /*
         * REVERSE DRAG IS REFUSED.
         *
         * This used to fire on `dragSource !== targetPane`, i.e. on a right-to-left
         * gesture too. executeTransfer always copies the LEFT pane's selection to
         * the RIGHT pane, so dropping Destination onto Source did not reverse
         * anything: it ran the FORWARD copy, using whatever stale selection the
         * left pane still held — files the user never dragged. Only left -> right
         * may execute; and the drag's own selection must be non-empty.
         */
        if (this.isForwardPaneDrag(targetPane) && this.draggedItems.length > 0) {
            this.activePane = 'left';
            this.executeTransfer();
            this.draggedItems = [];
            this.dragSource = null;
            return;
        }

        if (this.dragSource && !this.isForwardPaneDrag(targetPane)) {
            // A refused in-surface gesture: say so, and drop the drag state so no
            // later drop can reuse this selection.
            if (this.dragSource !== targetPane) {
                this.showNotification(
                    this.t('fm.transferDirectionFixed',
                           'Transfers go from Source to Destination only'),
                    'warning');
            }
            this.draggedItems = [];
            this.dragSource = null;
            return;
        }

        if (target.type === 'ssh') {
            const sessionId = target.sessionId || target.connectionId;
            if (!sessionId) {
                this.showNotification(this.t('fm.noActiveSession', 'No active SSH session'), 'error');
                return;
            }

            if (items && items.length > 0) {
                const entries = Array.from(items)
                    .filter(item => item.kind === 'file')
                    .map(item => item.webkitGetAsEntry())
                    .filter(entry => entry !== null);

                if (entries.length > 0) {
                    this.uploadDesktopItemsToSSH(entries, target);
                } else if (files && files.length > 0) {
                    this.uploadDesktopFilesToSSH(Array.from(files), target);
                }
            } else if (files && files.length > 0) {
                this.uploadDesktopFilesToSSH(Array.from(files), target);
            }
        } else if (target.type === 'browser-local') {
            this.showNotification(this.t('fm.useFilesystemForLocal', 'Use your file system to add files to your local folder'), 'info');
        } else {
            this.showNotification(this.t('fm.selectSourceFirst', 'Please select a source first'), 'warning');
        }

        this.draggedItems = [];
        this.dragSource = null;
    }

    async uploadDesktopItemsToSSH(entries, targetPane) {
        const sessionId = targetPane.sessionId || targetPane.connectionId;
        const basePath = targetPane.path;

        const countFiles = async (entry) => {
            if (entry.isFile) {
                return 1;
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const subEntries = await new Promise((resolve, reject) => {
                    reader.readEntries(resolve, reject);
                });
                let count = 0;
                for (const subEntry of subEntries) {
                    count += await countFiles(subEntry);
                }
                return count;
            }
            return 0;
        };

        let totalFiles = 0;
        for (const entry of entries) {
            totalFiles += await countFiles(entry);
        }

        const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.currentUploadBatch = {
            id: batchId,
            total: totalFiles,
            completed: 0,
            sessionId: sessionId
        };

        window._currentUploadBatchId = batchId;

        this.showUploadProgress();

        for (const entry of entries) {
            if (entry.isFile) {
                entry.file(file => {
                    this.uploadSingleFileToSSH(file, basePath, sessionId, true);
                });
            } else if (entry.isDirectory) {
                await this.uploadDirectoryToSSH(entry, basePath, sessionId, true);
            }
        }

        if (this.uploadRefreshTimer) {
            clearTimeout(this.uploadRefreshTimer);
        }
        this.uploadRefreshTimer = setTimeout(() => {
            this.refreshPane(this.getPaneForSession(sessionId));
            this.uploadRefreshTimer = null;
        }, 2000);
    }

    uploadSingleFileToSSH(file, basePath, sessionId, isBatchUpload = false) {
        const remotePath = this.joinPath(basePath, file.name);

        const reader = new FileReader();
        reader.onload = () => {
            this.socket.emit('upload_file_binary', {
                session_id: sessionId,
                filename: file.name,
                file_data: reader.result,
                remote_path: remotePath
            });

            if (!isBatchUpload) {
                this.queueTransfer({
                    type: 'upload',
                    filename: file.name,
                    targetPath: remotePath,
                    size: file.size
                });
            }
        };
        reader.readAsArrayBuffer(file);
    }

    async uploadDirectoryToSSH(directoryEntry, basePath, sessionId, isBatchUpload = false) {
        const dirPath = this.joinPath(basePath, directoryEntry.name);

        this.socket.emit('create_directory', {
            session_id: sessionId,
            remote_path: dirPath
        });

        const reader = directoryEntry.createReader();
        const entries = await new Promise((resolve, reject) => {
            reader.readEntries(resolve, reject);
        });

        const promises = [];
        for (const entry of entries) {
            if (entry.isFile) {
                entry.file(file => {
                    this.uploadSingleFileToSSH(file, dirPath, sessionId, isBatchUpload);
                });
            } else if (entry.isDirectory) {
                promises.push(this.uploadDirectoryToSSH(entry, dirPath, sessionId, isBatchUpload));
            }
        }

        await Promise.all(promises);
    }

    async uploadDesktopFilesToSSH(files, targetPane) {
        const sessionId = targetPane.sessionId || targetPane.connectionId;

        for (const file of files) {
            this.uploadSingleFileToSSH(file, targetPane.path, sessionId);
        }

        if (this.uploadRefreshTimer) {
            clearTimeout(this.uploadRefreshTimer);
        }
        this.uploadRefreshTimer = setTimeout(() => {
            this.refreshPane(this.getPaneForSession(sessionId));
            this.uploadRefreshTimer = null;
        }, 2000);
    }

    getPaneForSession(sessionId) {
        if (this.panes.left.sessionId === sessionId || this.panes.left.connectionId === sessionId) {
            return 'left';
        }
        if (this.panes.right.sessionId === sessionId || this.panes.right.connectionId === sessionId) {
            return 'right';
        }
        return 'left';
    }

    handleDragStart(e, pane, index) {
        this.dragSource = pane;
        const state = this.panes[pane];

        if (!state.selected.has(index)) {
            state.selected.clear();
            state.selected.add(index);
            this.updateSelectionVisual(pane);
        }

        this.draggedItems = Array.from(state.selected).map(i => state.files[i]).filter(f => f);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', this.draggedItems.map(f => f.name).join(', '));
    }

    queueTransfer(transfer) {
        if (!transfer.id) {
            transfer.id = Date.now() + Math.random();
        }
        transfer.status = 'pending';
        transfer.progress = 0;
        this.transferQueue.push(transfer);
        this.renderTransferQueue();
        this.processTransferQueue();
        /*
         * Events that arrived before this row existed are applied now. The
         * server starts its worker before the ack reaches us, so a fast transfer
         * can be complete by the time we get here; dropping those events left the
         * row stuck at "Waiting..." and stalled the serial queue forever.
         */
        if (this.drainEarlyS2SEvents(transfer.id) > 0) {
            this.renderTransferQueue();
        }
    }

    async processTransferQueue() {
        if (this.isTransferring) return;

        const pending = this.transferQueue.find(t => t.status === 'pending');
        if (!pending) return;

        this.isTransferring = true;
        pending.status = 'active';
        this.renderTransferQueue();

        if (pending.type === 's2s') {
            this.activeTransfers.set(pending.id, pending);
            return;
        }

        this.activeTransfers.set(pending.id, pending);
    }

    updateTransferProgress(data) {
        const transfer = this.transferQueue.find(t =>
            t.status === 'active' &&
            (t.filename === data.filename || t.id === data.transfer_id)
        );

        if (transfer) {
            transfer.progress = data.percent || 0;
            this.renderTransferQueue();
        }
    }

    completeTransfer(data, type) {
        const transfer = this.transferQueue.find(t =>
            t.status === 'active' && t.type === type
        );

        if (transfer) {
            transfer.status = 'complete';
            transfer.progress = 100;
            this.activeTransfers.delete(transfer.id);
            this.isTransferring = false;
            this.renderTransferQueue();
            this.refreshBothPanes();
            setTimeout(() => this.processTransferQueue(), 100);
        }
    }

    /*
     * S2S_TERMINAL_STATUSES — the row states no event may overwrite.
     *
     * The server now guarantees exactly one terminal event per transfer, but the
     * client can still learn an outcome twice: the tab that pressed Cancel gets
     * BOTH the ack callback and the s2s_transfer_cancelled event, since that event
     * is addressed to the owning socket -- which is this tab. Whichever landed
     * first is the truth the user saw, so it stands.
     */
    static get S2S_TERMINAL_STATUSES() {
        return ['complete', 'error', 'cancelled'];
    }

    isTerminalStatus(status) {
        return SFTPFileManager.S2S_TERMINAL_STATUSES.includes(status);
    }

    /*
     * findTerminalizableTransfer — the row for this id, if it can still change.
     *
     * Returns null for an unknown id and for a row that already reached a
     * terminal state, which is what makes complete/error/cancelled mutually
     * exclusive on screen rather than last-write-wins.
     */
    findTerminalizableTransfer(transferId) {
        if (transferId === undefined || transferId === null || transferId === '') {
            return null;
        }
        const transfer = this.transferQueue.find(
            t => String(t.id) === String(transferId));
        if (!transfer || this.isTerminalStatus(transfer.status)) {
            return null;
        }
        return transfer;
    }

    completeS2STransfer(data) {
        const transfer = this.findTerminalizableTransfer(data?.transfer_id);
        if (!transfer) {
            return;
        }
        transfer.status = 'complete';
        transfer.progress = 100;
        this.activeTransfers.delete(transfer.id);
        this.isTransferring = false;
        this.renderTransferQueue();
        setTimeout(() => this.processTransferQueue(), 100);
    }

    failS2STransfer(data) {
        // A transfer the user already cancelled (or that already completed) must
        // not flip to error if a late event arrives for it.
        const transfer = this.findTerminalizableTransfer(data?.transfer_id);
        if (!transfer) {
            return;
        }
        transfer.status = 'error';
        transfer.error = data.error;
        this.activeTransfers.delete(transfer.id);
        this.isTransferring = false;
        this.renderTransferQueue();
        setTimeout(() => this.processTransferQueue(), 100);
    }

    /*
     * cancelS2STransfer — terminalize one server-to-server transfer as
     * 'cancelled'.
     *
     * Idempotent, and it refuses to overwrite a transfer that already reached a
     * terminal state: cancel and completion can race on the wire (the copy can
     * finish in the moment between the click and the server reading the event),
     * and whichever landed first is the truth the user saw.
     */
    cancelS2STransfer(data) {
        const transfer = this.findTerminalizableTransfer(data?.transfer_id);
        if (!transfer) {
            return;
        }
        transfer.status = 'cancelled';
        this.activeTransfers.delete(transfer.id);
        this.isTransferring = false;
        this.renderTransferQueue();
        setTimeout(() => this.processTransferQueue(), 100);
    }

    /*
     * cancelQueuedTransfer — the visible cancel control's handler.
     *
     * Upstream shape: emit `cancel_transfer` and terminalize only when the
     * server ACKNOWLEDGES success. Painting 'cancelled' optimistically would lie
     * whenever the server had already finished the copy or the id was not ours.
     */
    cancelQueuedTransfer(transferId) {
        const transfer = this.transferQueue.find(t => String(t.id) === String(transferId));
        if (!transfer || !['pending', 'active'].includes(transfer.status)) {
            return;
        }
        if (transfer.type !== 's2s') {
            // Browser<->server transfers are owned by FileTransferManager and
            // have no server-side cancel event in this build; nothing to emit.
            return;
        }
        this.socket.emit('cancel_transfer', {
            transfer_id: transfer.id
        }, (acknowledgement) => {
            if (acknowledgement?.success) {
                this.cancelS2STransfer({ transfer_id: transfer.id });
            }
        });
    }

    // Same monotonic guard as the s2s terminals: these are reached by upload and
    // download completion paths, which can also fire after a row already ended.
    completeTransferById(transferId) {
        const transfer = this.findTerminalizableTransfer(transferId);
        if (!transfer) {
            return;
        }
        transfer.status = 'complete';
        transfer.progress = 100;
        this.activeTransfers.delete(transfer.id);
        this.isTransferring = false;
        this.renderTransferQueue();
        setTimeout(() => this.processTransferQueue(), 100);
    }

    failTransferById(transferId, error) {
        const transfer = this.findTerminalizableTransfer(transferId);
        if (!transfer) {
            return;
        }
        transfer.status = 'error';
        transfer.error = error;
        this.activeTransfers.delete(transfer.id);
        this.isTransferring = false;
        this.renderTransferQueue();
        setTimeout(() => this.processTransferQueue(), 100);
    }

    downloadSelected() {
        const state = this.panes[this.activePane];

        if (state.selected.size === 0) {
            this.showNotification(this.t('fm.noItemsSelected', 'No items selected'), 'warning');
            return;
        }

        if (state.type !== 'ssh') {
            this.showNotification(this.t('fm.downloadOnlySSH', 'Download only works for SSH sources'), 'warning');
            return;
        }

        const sessionId = state.sessionId || state.connectionId;
        const items = Array.from(state.selected).map(i => state.files[i]).filter(f => f);

        this.showNotification(`${this.t('fm.downloading', 'Downloading')} ${items.length} ${this.t('fm.items', 'item(s)')}...`, 'info');

        for (const item of items) {
            const filePath = this.joinPath(state.path, item.name);
            if (item.is_dir) {
                this.downloadFolderToBrowser(sessionId, filePath, item.name);
            } else {
                this.downloadFileToBrowser(sessionId, filePath, item.name);
            }
        }
    }

    downloadFileToBrowser(sessionId, remotePath, filename) {
        this.showNotification(`${this.t('fm.downloading', 'Downloading')}: ${filename}...`, 'info');

        this.queueTransfer({
            type: 'download',
            filename: filename,
            sourcePath: remotePath,
            size: 0
        });

        this.socket.emit('download_file_binary', {
            session_id: sessionId,
            remote_path: remotePath
        });
    }

    downloadFolderToBrowser(sessionId, remotePath, folderName) {
        this.showNotification(`${this.t('fm.downloadingFolder', 'Downloading folder')}: ${folderName}...`, 'info');

        this.queueTransfer({
            type: 'download',
            filename: `${folderName}.zip`,
            sourcePath: remotePath,
            size: 0
        });

        this.socket.emit('download_folder_binary', {
            session_id: sessionId,
            remote_path: remotePath
        });
    }

    async handleDownloadReady(data) {
        if (data.for_preview) {
            return;
        }

        if (this.pendingBrowserDownload && this.pendingBrowserDownload.filename === data.filename) {
            await this.pendingBrowserDownload.callback(data.file_data);
            this.pendingBrowserDownload = null;
            this.completeTransfer(data, 'download');
            return;
        }

        const blob = new Blob([data.file_data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename;
        a.click();
        URL.revokeObjectURL(url);

        this.showNotification(`${this.t('fm.downloaded', 'Downloaded')}: ${data.filename}`, 'success');
        this.completeTransfer(data, 'download');
    }

    renderTransferQueue() {
        const container = document.getElementById('fmQueueList');
        const badge = document.getElementById('fmQueueBadge');

        const activeCount = this.transferQueue.filter(t =>
            t.status === 'pending' || t.status === 'active'
        ).length;

        badge.textContent = activeCount;
        badge.style.display = activeCount > 0 ? 'inline' : 'none';

        /*
         * `has-transfers` lets CSS distinguish an empty queue from a populated
         * one. Short-landscape phones collapse the empty queue to zero height --
         * it was taking 54px of a 390px viewport, the difference between one
         * usable file row and two -- and restore it in full as soon as a transfer
         * exists, so progress and Cancel are never hidden from a user who started
         * something. Set here, on the one code path that knows the queue changed.
         */
        const queuePanel = document.getElementById('fmQueue');
        if (queuePanel) {
            queuePanel.classList.toggle('has-transfers',
                this.transferQueue.length > 0);
        }

        if (this.transferQueue.length === 0) {
            container.innerHTML = `<div class="fm-empty" style="padding: 20px;">${this.t('fm.noTransfers', 'No transfers')}</div>`;
            return;
        }

        /*
         * The Cancel control renders for s2s rows ONLY (owner ruling,
         * Entry 40). Browser upload/download rows are owned by
         * FileTransferManager and have no server-side cancel event in this build,
         * so a Cancel button on them was a control that did nothing when pressed.
         */
        container.innerHTML = this.transferQueue.slice(-20).map(t => `
            <div class="fm-transfer-item ${t.status}" data-transfer-type="${this.escapeHtml(String(t.type || ''))}">
                <div class="fm-transfer-icon ${t.type}">
                    ${this.spriteIcon(t.type === 'upload' ? 'cloud-upload' : t.type === 'download' ? 'download' : 'swap')}
                </div>
                <div class="fm-transfer-info">
                    <div class="fm-transfer-name">${this.escapeHtml(t.filename)}</div>
                    ${t.status === 'active' ? `
                        <div class="fm-transfer-progress-bar">
                            <div class="fm-transfer-progress-fill" style="width: ${t.progress}%"></div>
                        </div>
                    ` : ''}
                </div>
                <div class="fm-transfer-status ${t.status}">${this.getStatusText(t)}</div>
                ${t.type === 's2s' && (t.status === 'pending' || t.status === 'active') ? `
                    <div class="fm-transfer-actions">
                        <button type="button" class="fm-transfer-btn cancel"
                                data-transfer-cancel="${this.escapeHtml(String(t.id))}"
                                title="${this.escapeHtml(this.t('common.cancel', 'Cancel'))}"
                                aria-label="${this.escapeHtml(this.t('common.cancel', 'Cancel'))}">
                            ${this.spriteIcon('x')}
                        </button>
                    </div>
                ` : ''}
            </div>
        `).join('');
    }

    getStatusText(transfer) {
        switch (transfer.status) {
            case 'pending': return this.t('fm.waiting', 'Waiting...');
            case 'active': return `${transfer.progress}%`;
            case 'complete': return `✓ ${this.t('fm.done', 'Done')}`;
            case 'error': return `✗ ${this.t('fm.failed', 'Failed')}`;
            case 'cancelled': return `✗ ${this.t('fm.cancelled', 'Cancelled')}`;
            default: return '';
        }
    }

    toggleQueue() {
        const collapsed = document.getElementById('fmQueue').classList.toggle('collapsed');
        const toggle = document.getElementById('fmQueueToggle');
        toggle.querySelector('use')?.setAttribute(
            'href', `/static/icons/icons.svg?v=2#icon-chevron-${collapsed ? 'up' : 'down'}`);
    }

    showContextMenu(e, pane, index) {
        e.preventDefault();
        e.stopPropagation();
        this.closeContextMenu();

        const state = this.panes[pane];
        const file = index >= 0 ? state.files[index] : null;

        const menu = document.createElement('div');
        menu.className = 'fm-context-menu';

        let items = [];

        if (file) {
            if (file.is_dir) {
                items.push({ action: 'open', icon: 'folder-open', text: this.t('fm.ctx.open', 'Open') });
                if (state.type === 'ssh' || state.type === 'quick-connect') {
                    items.push({ action: 'download', icon: 'download', text: this.t('fm.ctx.download', 'Download') });
                }
            } else {
                if (state.type === 'ssh' || state.type === 'quick-connect') {
                    items.push({ action: 'preview', icon: 'eye', text: this.t('fm.ctx.preview', 'Preview') });
                    items.push({ action: 'download', icon: 'download', text: this.t('fm.ctx.download', 'Download') });
                }
            }
            if (!this.isMobile()) {
                items.push({ action: 'transfer', icon: 'swap', text: this.t('fm.ctx.transferToOther', 'Transfer to other pane') });
            }
            items.push({ divider: true });
            items.push({ action: 'rename', icon: 'edit', text: this.t('fm.rename', 'Rename') });
        }

        items.push({ action: 'newfolder', icon: 'folder-add', text: this.t('fm.newFolder', 'New Folder') });
        items.push({ action: 'refresh', icon: 'reload', text: this.t('fm.refresh', 'Refresh') });

        if (file) {
            items.push({ divider: true });
            items.push({ action: 'delete', icon: 'delete', text: this.t('fm.delete', 'Delete'), danger: true });
        }

        menu.innerHTML = items.map(item => {
            if (item.divider) {
                return '<div class="fm-context-divider"></div>';
            }
            return `
                <div class="fm-context-item ${item.danger ? 'danger' : ''}" data-action="${item.action}">
                    ${this.spriteIcon(item.icon, 'fm-context-icon')} ${item.text}
                </div>
            `;
        }).join('');

        document.body.appendChild(menu);
        this.contextMenu = menu;

        menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
        menu.style.top = `${Math.min(e.clientY, window.innerHeight - 200)}px`;

        menu.querySelectorAll('.fm-context-item').forEach(item => {
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.handleContextAction(item.dataset.action, pane, index);
                this.closeContextMenu();
            });
        });
    }

    handleContextAction(action, pane, index) {
        const state = this.panes[pane];
        this.activePane = pane;

        const ensureSelection = () => {
            if (index >= 0 && !state.selected.has(index)) {
                state.selected.clear();
                state.selected.add(index);
                this.updateSelectionVisual(pane);
            }
        };

        switch (action) {
            case 'open':
                this.handleItemDblClick(pane, index);
                break;
            case 'preview':
                if (index >= 0) {
                    const file = state.files[index];
                    if (file && !file.is_dir) {
                        const sessionId = state.sessionId || state.connectionId;
                        const filePath = this.joinPath(state.path, file.name);
                        if (window.FilePreview) {
                            window.FilePreview.open(sessionId, filePath, file.name);
                        }
                    }
                }
                break;
            case 'download':
                ensureSelection();
                this.downloadSelected();
                break;
            case 'transfer':
                ensureSelection();
                this.executeTransfer();
                break;
            case 'rename':
                if (index >= 0) {
                    state.selected.clear();
                    state.selected.add(index);
                    this.renameSelected();
                }
                break;
            case 'newfolder':
                this.createNewFolder();
                break;
            case 'refresh':
                this.refreshPane(pane);
                break;
            case 'delete':
                ensureSelection();
                this.deleteSelected();
                break;
        }
    }

    closeContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
    }

    updatePaneStatus(pane) {
        const state = this.panes[pane];
        const count = state.files.length;
        const selected = state.selected.size;
        const totalSize = Array.from(state.selected)
            .reduce((sum, i) => sum + (state.files[i]?.size || 0), 0);

        document.getElementById(`fm${this.capitalize(pane)}Count`).textContent =
            `${count} ${this.t('fm.items', 'items')}`;

        document.getElementById(`fm${this.capitalize(pane)}Selected`).textContent = selected > 0
            ? `${selected} ${this.t('fm.selected', 'selected')} (${this.formatSize(totalSize)})`
            : '';
    }

    t(key, fallback = '') {
        if (window.i18n && typeof window.i18n.t === 'function') {
            return window.i18n.t(key) || fallback;
        }
        return fallback;
    }

    /*
     * One translation walk, used by every surface this class owns: the legacy
     * modal, the quick-connect modal, and the v5 inline panel. It replaced four
     * near-identical copies that had drifted -- the modal handled
     * data-i18n-label, the quick-connect modal did not -- so a key added to one
     * surface silently did nothing on the other.
     */
    translateSubtree(root) {
        if (!root) return;
        if (!window.i18n || typeof window.i18n.t !== 'function') return;

        root.querySelectorAll('[data-i18n]').forEach(el => {
            const translation = window.i18n.t(el.getAttribute('data-i18n'));
            if (translation) el.textContent = translation;
        });

        root.querySelectorAll('[data-i18n-title]').forEach(el => {
            const translation = window.i18n.t(el.getAttribute('data-i18n-title'));
            if (translation) el.title = translation;
        });

        root.querySelectorAll('[data-i18n-label]').forEach(el => {
            const translation = window.i18n.t(el.getAttribute('data-i18n-label'));
            if (translation) el.label = translation;
        });

        root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
            const translation = window.i18n.t(el.getAttribute('data-i18n-aria-label'));
            if (translation) el.setAttribute('aria-label', translation);
        });

        root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const translation = window.i18n.t(el.getAttribute('data-i18n-placeholder'));
            if (translation) el.placeholder = translation;
        });
    }

    applyTranslations() {
        this.translateSubtree(this.modal);
        this.translateSubtree(this.qcModal);
        // The v5 inline panel lives in the workspace, not inside either modal,
        // so it needs its own walk or a language change would leave it stale.
        this.translateSubtree(document.getElementById('sftpPanel'));
    }

    capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    joinPath(basePath, filename) {
        if (!basePath || basePath === '/') {
            return '/' + filename;
        }
        const cleanBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
        return cleanBase + '/' + filename;
    }

    getFileIcon(filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const source = new Set([
            'c', 'cpp', 'css', 'go', 'h', 'htm', 'html', 'java', 'js', 'jsx',
            'json', 'kt', 'less', 'php', 'py', 'rb', 'rs', 'sass', 'scss', 'sh',
            'sql', 'swift', 'ts', 'tsx', 'xml', 'yaml', 'yml', 'zsh',
        ]);
        const images = new Set(['bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
        const keys = new Set(['key', 'pem', 'pub']);
        if (source.has(ext)) return 'code';
        if (images.has(ext)) return 'picture';
        if (keys.has(ext)) return 'key';
        if (ext === 'lock') return 'lock';
        if (['doc', 'docx', 'log', 'md', 'pdf', 'rtf', 'txt'].includes(ext)) return 'file-text';
        return 'file';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showUploadProgress() {
        if (!this.currentUploadBatch) return;

        const { completed, total } = this.currentUploadBatch;
        const percent = Math.round((completed / total) * 100);

        if (!this.uploadProgressNotification) {
            this.uploadProgressNotification = document.createElement('div');
            this.uploadProgressNotification.className = 'upload-progress-notification';
            this.uploadProgressNotification.innerHTML = `
                <div class="upload-progress-content">
                    <div class="upload-progress-icon">
                        <svg class="icon spinning" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-cloud-upload"></use></svg>
                    </div>
                    <div class="upload-progress-info">
                        <div class="upload-progress-text">${this.t('fm.uploadingFiles', 'Uploading files')}...</div>
                        <div class="upload-progress-stats">
                            <span class="upload-progress-count">${completed} / ${total}</span>
                            <span class="upload-progress-percent">${percent}%</span>
                        </div>
                        <div class="upload-progress-bar">
                            <div class="upload-progress-fill" style="width: ${percent}%"></div>
                        </div>
                    </div>
                </div>
            `;

            // The 82 lines of CSS that used to be built here on the first upload
            // now live in static/css/style.css. A <style> created inside this
            // function had no URL, so it was the one stylesheet in the project
            // that index.html's hand-written ?v=N could not cache-bust -- edits
            // to it shipped invisibly.
            document.body.appendChild(this.uploadProgressNotification);
        } else {
            const countEl = this.uploadProgressNotification.querySelector('.upload-progress-count');
            const percentEl = this.uploadProgressNotification.querySelector('.upload-progress-percent');
            const fillEl = this.uploadProgressNotification.querySelector('.upload-progress-fill');

            if (countEl) countEl.textContent = `${completed} / ${total}`;
            if (percentEl) percentEl.textContent = `${percent}%`;
            if (fillEl) fillEl.style.width = `${percent}%`;
        }
    }

    showUploadComplete() {
        if (!this.uploadProgressNotification) return;

        this.uploadProgressNotification.classList.add('success');
        this.uploadProgressNotification.innerHTML = `
            <div class="upload-progress-content">
                <div class="upload-progress-icon success">
                    <svg class="icon" aria-hidden="true"><use href="/static/icons/icons.svg?v=2#icon-circle-check"></use></svg>
                </div>
                <div class="upload-progress-info">
                    <div class="upload-progress-text">${this.t('fm.uploadComplete', 'Upload complete')}!</div>
                    <div class="upload-progress-stats">
                        <span>${this.currentUploadBatch ? this.currentUploadBatch.total : 0} ${this.t('fm.filesUploaded', 'files uploaded')}</span>
                    </div>
                </div>
            </div>
        `;

        setTimeout(() => {
            if (this.uploadProgressNotification) {
                // The shared keyframes in style.css, not the private pair this
                // file used to inject. They were byte-identical to the toast
                // ones, and a duplicate @keyframes name replaces the earlier
                // definition document-wide -- so both toast systems were already
                // animating off whichever block happened to load last.
                this.uploadProgressNotification.style.animation =
                    'notificationSlideOut 0.3s ease';
                setTimeout(() => {
                    if (this.uploadProgressNotification) {
                        this.uploadProgressNotification.remove();
                        this.uploadProgressNotification = null;
                    }
                }, 300);
            }
        }, 3000);
    }

    showNotification(message, type = 'info') {
        if (window.showNotification) {
            window.showNotification(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }
}

let sftpFileManager = null;

// ─── openInline: v5 compact inspector ────────────────────────────────────────
//
// P3 / mockup v5 line 182: the per-SESSION SFTP surface is a compact inspector
// panel (side rail on desktop, right overlay on iPad, bottom sheet on phone)
// integrated with the terminal.  #fileTransferBtn opens the inspector.
//
// The dual-pane modal is NOT legacy: it is the server-to-server File Transfer
// Surface, opened by the global menu item via openTransferSurface. The two
// Surfaces are distinct features and both ship.
//
// The panel is the `<aside id="sftpPanel">` permanent workspace child added
// to index.html.  This function renders into it using IDs that are prefixed
// `sftp-inline-` to avoid any collision with the lazily-created modal's own
// IDs (`fmLeft*`, `fmRight*`).  All file operations still flow through the
// existing manager methods; the only difference is the DOM host.
//
// Mutual exclusion: the same `sshdeck:aux-panel-opening` event that closes
// Notes and the Command Library is dispatched here, so no two panels can be
// open at once.

function ensureFileManager() {
    if (!sftpFileManager) {
        sftpFileManager = new SFTPFileManager();
        window.sftpFileManager = sftpFileManager;
    }
    return sftpFileManager;
}

function openFileManager() {
    // v5: the per-SESSION entry point is the inline inspector (one host).
    ensureFileManager().openInline();
}

/*
 * openTransferSurface — the SERVER-TO-SERVER entry point.
 *
 * This is the dual-pane
 * surface: two independent source selectors, two paths, pane-to-pane drag and
 * drop, and the Transfer action that emits `transfer_server_to_server`. It is
 * Separate named function from openFileManager so the two routes can never be
 * confused again by a caller reading only the name.
 */
function openTransferSurface() {
    ensureFileManager().open();
}

window.SFTPFileManager = SFTPFileManager;
window.openFileManager = openFileManager;
window.openTransferSurface = openTransferSurface;

// The header button that opens this manager, bound here rather than in the
// Markup. It was an inline onclick="openFileManager", which is why this file
// had to keep a window global for its own entry point; the global stays because
// the command palette also calls it, but the button no longer depends on it.
// Bound in the owning module, matching commandLibraryBtn (command-library.js)
// and manageProfilesBtn (profile-manager.js).
document.addEventListener('DOMContentLoaded', () => {
    /*
     * #fileTransferBtn is the SESSION tool: the per-connection SFTP browser for
     * The active session, and it is a TOGGLE
     * pressing the same opener again closes the panel it opened. One host,
     * the active one; no destination selector.
     */
    document.getElementById('fileTransferBtn')
        ?.addEventListener('click', () => {
            const panel = document.getElementById('sftpPanel');
            if (panel?.classList.contains('sftp-panel-open')) {
                sftpFileManager?.closeInline();
                return;
            }
            openFileManager();
        });

    /*
     *
     * File Transfer means
     * moving a file from one SSH server to ANOTHER SSH server. Only the
     * dual-pane surface can express that -- it has two independent source
     * selectors (#fmLeftSource / #fmRightSource), two paths, and the Transfer
     * action that emits `transfer_server_to_server`. So this item opens
     * OpenTransferSurface (which is `.open`), NOT the inline single-host
     * inspector and NOT the browser<->server Upload/Download modal.
     *
     * It is a toggle, matching every other opener (defect 9).
     */
    document.getElementById('fileTransferOpenBtn')
        ?.addEventListener('click', () => {
            if (sftpFileManager?.isOpen) {
                sftpFileManager.close();
                return;
            }
            openTransferSurface();
        });
});
